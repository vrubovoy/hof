// Page speed of Hof on a local server, to compare versions (docs/OPERATIONS.md, «Замер скорости
// страниц»). Run by hand, never by CI: the numbers depend on the computer.
//
//   node src/measure.ts --label <версия> --out <файл.json> [--gate-key <ключ>] [--runs 10]
//                       [--parts loads,chain,music,memory] [--scenario full|navigation]
//                       [--origin <адрес>] [--gzip] [--chrome <путь>]
//   node src/measure.ts --report <база.json> [<серия.json> …]
//
// Headless Chrome is driven over the DevTools protocol with the WebSocket and fetch of Node, so
// nothing is installed. Two profiles, each with its screen, network and CPU. Four parts (M14.1):
// - loads — the load of a document, cold (empty cache) and warm (the same address again);
// - chain — the scenario of M14 in one tab: the sign-in, the way through Säckel with an expense,
//   and the sign-out, each step from the press to the new view and to the end of its animations;
// - music — the same way with the music on: when it was silent;
// - memory — the way repeated 50 times in one tab: nodes, listeners and the heap of JavaScript.
// Two scenarios: full — the way with its two expenses; navigation — the way without them, for a
// prototype whose forms still reload the page (M14.2, M14.4).
// --gzip (M14.2): Chrome talks to a proxy in front of the server that compresses the static files
// as nginx does in production (nginxGzips); the local server does not compress.
// Every series goes to a JSON file; --report turns files into Markdown tables, the first file
// being the base the others are compared with. Statistics and tables live in measure-stats.ts.
//
// Data: the script founds a court on an empty development database (the gate key comes from the
// server log) and fills it with a fixed budget, or signs in to the court it founded before. The
// one record a run writes is deleted after it, so every run sees the same data. A server that is
// not on this computer is refused.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createServer, request } from 'node:http';
import { createGzip, gzipSync } from 'node:zlib';
import {
  BACK_STEP,
  BACK_REFERENCE,
  documentFate,
  freshId,
  isTestCourt,
  layoutShift,
  nginxGzips,
  longFrames,
  markIds,
  normalizeText,
  arrivedAt,
  playingNow,
  powerShort,
  requestStats,
  seedExpenses,
  silence,
  slowestInput,
  type DocumentFate,
  type HistoryRow,
  type Mark,
  type NetRequest,
  type Probe,
  type Window,
} from './measure-stats.ts';
import { report } from './measure-report.ts';

const USAGE =
  'Использование: node src/measure.ts --label <версия> --out <файл.json> [--gate-key <ключ>] ' +
  '[--runs 10] [--parts loads,chain,music,memory] [--scenario full|navigation] ' +
  '[--origin http://localhost:3000] [--gzip] ' +
  '[--chrome <путь к Chrome>]\n       node src/measure.ts --report <база.json> [<серия.json> …]';

// The test court of the measurement. Local data only, so the password may be written here.
const LOGIN = 'measure';
const MEMBER = 'measure-member';
const PASSWORD = 'measure-local-only-password';
const POUCHES = ['Еда', 'Дом', 'Дети', 'Отпуск'];
// The fixed budget (M14.1): one income laid out evenly, 56 expenses on fixed dates. 61 records:
// Летопись has 50 on its first page and 11 on the second; a run adds one, its note is NOTE.
const INCOME = { amount: '100000', date: '2026-10-01', note: 'Жалованье' };
const LAID_OUT = '25000';
const EXPENSES = seedExpenses(56, POUCHES.length);
const SEEDED = 1 + POUCHES.length + EXPENSES.length;
const PAGE_SIZE = 50;
const NOTE = 'Замер';
// The record of a run as Летопись shows it; only rows of all four are the script's to delete.
const MARK: Mark = { pouch: POUCHES[0]!, kind: 'Трата', note: NOTE, amount: '123,45' };
// The notes every test court has once each: what tells it from other data.
const SEEDED_NOTES = [INCOME.note, ...EXPENSES.map((e) => e.note)];

export const PROFILES = [
  {
    name: 'Телефон',
    about: '390×844 @3, RTT 150 мс, 1,6 Мбит/с, CPU ×4',
    screen: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    cpu: 4,
    network: { latency: 150, megabits: 1.6, uploadMegabits: 0.75 },
  },
  {
    name: 'Компьютер',
    about: '1440×900 @2, RTT 40 мс, 10 Мбит/с, CPU ×1',
    screen: { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
    cpu: 1,
    network: { latency: 40, megabits: 10, uploadMegabits: 5 },
  },
] as const;
type Profile = (typeof PROFILES)[number];

// The documents of the scenario, loaded by their address.
export const PAGES = [
  { path: '/login', signedIn: false },
  { path: '/', signedIn: true },
  { path: '/saeckel/', signedIn: true },
  { path: '/saeckel/pouches/1', signedIn: true },
  { path: '/saeckel/history', signedIn: true },
  { path: '/measure-404', signedIn: true },
] as const;

// One step of the way. A press of the first visible element of `press` (the phone and the
// computer show different ones), or a form filled and sent, or Back of the browser. `to` — the
// addresses (path and query) the step may end on: a refused form of M13 stays on the address of
// its action, a page drawn without a reload may keep its own. `check` — what the view must show.
export interface Step {
  name: string;
  press?: readonly string[];
  fill?: Readonly<Record<string, string>>;
  back?: true;
  to: readonly string[];
  check?: 'fingerprint' | 'refused' | 'written' | 'first-page' | 'second-page' | 'blots';
}

const TO_SAECKEL = ['nav.court-places a[href="/saeckel/"]', 'a.place[href="/saeckel/"] > .sign'];
const AMOUNT = 'form.expense input[name="amount"]';
const SEND_EXPENSE = 'form.expense button[type="submit"]';

export const SIGN_IN: Step = {
  name: 'Вход → Двор (документ)',
  fill: {
    'form[action="/login"] input[name="username"]': LOGIN,
    'form[action="/login"] input[name="password"]': PASSWORD,
  },
  press: ['form[action="/login"] button[type="submit"]'],
  to: ['/'],
};

// The way inside the court, the same for every variant: what M14 compares.
export const WAY: readonly Step[] = [
  { name: 'Двор → Мешки', press: TO_SAECKEL, to: ['/saeckel/'], check: 'fingerprint' },
  {
    name: 'Мешки → мешок',
    press: ['.sk-list a.pouch[href="/saeckel/pouches/1"]'],
    to: ['/saeckel/pouches/1'],
  },
  {
    name: 'Трата с ошибкой (400)',
    fill: { [AMOUNT]: '12,345' },
    press: [SEND_EXPENSE],
    to: ['/saeckel/pouches/1/expense', '/saeckel/pouches/1'],
    check: 'refused',
  },
  {
    name: 'Трата (303)',
    fill: { [AMOUNT]: MARK.amount, 'form.expense input[name="note"]': NOTE },
    press: [SEND_EXPENSE],
    to: ['/saeckel/pouches/1'],
    check: 'written',
  },
  {
    name: 'Мешок → Мешки',
    press: ['a.sk-back', 'nav.tabs a[href="/saeckel/"]'],
    to: ['/saeckel/'],
    check: 'blots',
  },
  {
    name: BACK_REFERENCE,
    press: ['nav.tabs a[href="/saeckel/history"]'],
    to: ['/saeckel/history'],
    check: 'first-page',
  },
  {
    name: 'Летопись: следующие 50',
    press: ['nav.pages a[href$="page=2"]'],
    to: ['/saeckel/history?page=2'],
    check: 'second-page',
  },
  { name: BACK_STEP, back: true, to: ['/saeckel/history'], check: 'first-page' },
  {
    name: 'Летопись → Мешки',
    press: ['nav.tabs a[href="/saeckel/"]'],
    to: ['/saeckel/'],
    check: 'blots',
  },
  { name: 'Мешки → Двор', press: ['a.sk-court'], to: ['/'] },
];

// The scenarios: full — the whole way; navigation — the way without the steps that send a form.
export const SCENARIOS = ['full', 'navigation'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export function wayOf(scenario: Scenario): readonly Step[] {
  return scenario === 'full' ? WAY : WAY.filter((def) => def.fill === undefined);
}

export const SIGN_OUT: Step = {
  name: 'Выход → Вход (документ)',
  press: [
    'form.place-form[action="/logout"] .sign.at-gate',
    'nav.court-places form[action="/logout"] button',
  ],
  to: ['/login'],
};

// The views visited once after the sign-in, so that the measured way finds the files in the cache:
// the sign-in forgets them (/forget.css), the way is that of a person already in the court.
const WARM = [
  '/saeckel/',
  '/saeckel/pouches/1',
  '/saeckel/history',
  '/saeckel/history?page=2',
  '/',
];

// Before a press: fx.js has set itself up. After a step: late entries of LoAF, CLS and inputs.
const BEFORE_PRESS_MS = 1500;
const AFTER_STEP_MS = 1000;
const ARRIVAL_MS = 30_000;
const SETTLE_MS = 15_000;
// The music part waits for the music to play again after a step, at most so long.
const MUSIC_BACK_MS = 15_000;
const MEMORY_CYCLES = 50;
const MEMORY_AT = [0, 1, 10, 25, 50];
const FRAME_MS_MAX = 25;

export const CHROME_FLAGS = [
  '--headless',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  '--hide-scrollbars',
  // Music without a gesture of a person: the automatic run cannot give one (docs: limitations).
  '--autoplay-policy=no-user-gesture-required',
];

// The living decor of the court, which moves on its own and is not part of a step: the leaves in a
// gust, the birds, the fountain, the banners and smoke, the cats and the chest pressed.
export const DECOR = '.fx, .cat, .cat-frame, [data-poke]';

// Put into every document before its own scripts: it sends what the page measures through the
// binding hofMeasure as it happens, so nothing is lost when the document goes. Times are epoch
// milliseconds of the page clock. A view drawn without a new document (a prototype of M14) says
// so with performance.mark('hof:view'); a document says so with its load; a page back from the
// back/forward cache with pageshow. After each, «settled» is the moment no finite animation runs
// any more (the loops of the courtyard run for ever and are not counted, nor is DECOR), for 200 ms. The music:
// every media element that plays, and the gain ramps of fx.js (Web Audio).
const PROBE = `(() => {
  const doc = Math.random().toString(36).slice(2, 10);
  const now = () => performance.timeOrigin + performance.now();
  const send = (kind, fields = {}) => {
    try {
      window.hofMeasure(JSON.stringify({ kind, at: now(), doc, path: location.pathname + location.search, ...fields }));
    } catch {}
  };
  const t = (start) => performance.timeOrigin + start;
  const watch = (type, each, options = {}) => {
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) each(e); })
        .observe({ type, buffered: true, ...options });
    } catch {}
  };
  let settling = 0;
  const settle = (after) => {
    const token = ++settling;
    const start = performance.now();
    let quiet = null;
    const tick = (frame) => {
      if (token !== settling) return;
      const busy = document.getAnimations().some((a) => {
        const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        const target = a.effect && a.effect.target;
        if (target instanceof Element && target.closest(${JSON.stringify(DECOR)})) return false;
        return timing !== null && timing.iterations !== Infinity && (a.playState === 'running' || a.playState === 'pending');
      });
      if (busy) quiet = null;
      else if (quiet === null) quiet = frame;
      if (quiet !== null && frame - quiet >= 200) return send('settled', { at: Math.max(t(quiet), after), after });
      if (frame - start > ${SETTLE_MS - 1000}) return send('settled', { timeout: true, after });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const viewed = (fields) => {
    const at = fields.at ?? now();
    send('view', { ...fields, at });
    requestAnimationFrame(() => send('viewFrame'));
    settle(at);
  };
  watch('paint', (e) => send('paint', { at: t(e.startTime), start: e.startTime, name: e.name }));
  watch('largest-contentful-paint', (e) => {
    const what = e.url ? e.url.split('/').pop().split('?')[0]
      : e.element ? e.element.tagName.toLowerCase() + (e.element.classList[0] ? '.' + e.element.classList[0] : '') : '';
    send('lcp', { at: t(e.startTime), start: e.startTime, what });
  });
  watch('long-animation-frame', (e) => send('loaf', { at: t(e.startTime), dur: e.duration }));
  watch('event', (e) => send('input', { at: t(e.startTime), dur: e.duration, id: e.interactionId, name: e.name }), { durationThreshold: 16 });
  watch('layout-shift', (e) => send('shift', { at: t(e.startTime), value: e.value, input: e.hadRecentInput }));
  watch('mark', (e) => { if (e.name === 'hof:view') viewed({ at: t(e.startTime) }); });
  // The answer to a press: from the event to the next frame after its handlers. Event Timing
  // reports only answers of 16 ms or more, and a document that goes at once may report none.
  addEventListener('click', (e) => {
    send('press');
    const from = t(e.timeStamp);
    requestAnimationFrame(() => send('inputFrame', { dur: now() - from }));
  }, true);
  addEventListener('load', () => { const at = now(); send('load', { at }); settle(at); });
  addEventListener('pageshow', (e) => { if (e.persisted) viewed({ restored: true }); });
  addEventListener('pagehide', () => send('hide'));
  const media = new WeakSet();
  let count = 0;
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    if (!media.has(this)) {
      media.add(this);
      const el = doc + ':' + (count += 1);
      for (const type of ['playing', 'pause', 'waiting', 'ended', 'error', 'emptied']) {
        this.addEventListener(type, () => send('media', { type, el, t: this.currentTime, src: String(this.currentSrc || this.src).split('/').pop().split('?')[0] }));
      }
    }
    return play.apply(this, args);
  };
  if (typeof AudioParam !== 'undefined') {
    const from = new WeakMap();
    const set = AudioParam.prototype.setValueAtTime;
    const ramp = AudioParam.prototype.linearRampToValueAtTime;
    AudioParam.prototype.setValueAtTime = function (value, time) { from.set(this, time); return set.call(this, value, time); };
    AudioParam.prototype.linearRampToValueAtTime = function (value, end) {
      const start = from.get(this);
      send('gain', { target: value, seconds: start === undefined ? 0 : Math.max(0, end - start) });
      return ramp.call(this, value, end);
    };
  }
})();`;

// The frames of a page before the first press, 30 of them: the median length. On battery Chrome
// may draw at most 30 frames a second (its energy saver); then the run is refused.
const FRAME_RATE = `new Promise((done) => {
  const at = [];
  const tick = (now) => {
    at.push(now);
    if (at.length < 31) return requestAnimationFrame(tick);
    const lengths = at.slice(1).map((t, i) => t - at[i]).sort((a, b) => a - b);
    done(lengths[15]);
  };
  requestAnimationFrame(tick);
})`;

class Refusal extends Error {}

// --- The test court, over HTTP ----------------------------------------------------------------

async function post(origin: string, path: string, form: Record<string, string>, cookie = '') {
  return fetch(origin + path, {
    method: 'POST',
    redirect: 'manual',
    // The server accepts a POST only with the Origin of its own address.
    headers: { Origin: origin, Cookie: cookie },
    body: new URLSearchParams(form),
  });
}

function sessionCookie(response: Response) {
  for (const line of response.headers.getSetCookie()) {
    const match = /^(__Host-hof=[^;]+)/.exec(line);
    if (match !== null) return match[1]!;
  }
  return null;
}

async function expectRedirect(response: Promise<Response>, what: string) {
  const { status } = await response;
  if (status !== 303) throw new Refusal(`${what}: ответ ${status} вместо 303.`);
}

// The cookie of the test login: the court is founded and filled when it is not founded yet, or
// the script signs in to the court it founded before.
async function courtSession(origin: string, gateKey: string | undefined) {
  const first = await fetch(`${origin}/login`, { redirect: 'manual' });
  const founded = first.headers.get('location') !== '/setup';
  let cookie: string | null;
  if (!founded) {
    if (gateKey === undefined) {
      throw new Refusal('Двор не основан: передайте ключ от ворот из лога сервера (--gate-key).');
    }
    const setup = await post(origin, '/setup', {
      code: gateKey,
      username: LOGIN,
      password: PASSWORD,
      password2: PASSWORD,
    });
    cookie = setup.status === 303 ? sessionCookie(setup) : null;
    if (cookie === null) throw new Refusal(`Основание двора: ответ ${setup.status}.`);
    await expectRedirect(
      post(origin, '/admin/users', { username: MEMBER, password: PASSWORD }, cookie),
      'Приближённый',
    );
    for (const name of POUCHES) {
      await expectRedirect(post(origin, '/saeckel/pouches/new', { name }, cookie), 'Мешок');
    }
    await expectRedirect(post(origin, '/saeckel/income', INCOME, cookie), 'Доход');
    const laidOut = Object.fromEntries(POUCHES.map((_, i) => [`amount_${i + 1}`, LAID_OUT]));
    await expectRedirect(post(origin, '/saeckel/assign', laidOut, cookie), 'Раскладка');
    for (const { pouch, amount, date, note } of EXPENSES) {
      await expectRedirect(
        post(origin, `/saeckel/pouches/${pouch}/expense`, { amount, date, note }, cookie),
        'Трата',
      );
    }
  } else {
    const login = await post(origin, '/login', {
      username: LOGIN,
      password: PASSWORD,
      next: '/',
    });
    cookie = login.status === 303 ? sessionCookie(login) : null;
    if (cookie === null) {
      throw new Refusal(
        'Двор основан не этим скриптом: нужна пустая база разработки (docs/OPERATIONS.md).',
      );
    }
  }
  for (const path of ['/saeckel/pouches/1', '/admin/users/2']) {
    const { status } = await fetch(origin + path, { headers: { Cookie: cookie } });
    if (status !== 200) throw new Refusal(`Нет данных замера: ${path} отвечает ${status}.`);
  }
  return cookie.slice('__Host-hof='.length);
}

// The records a run wrote are deleted by the ordinary form of a record, so that the next run sees
// the same budget.
async function deleteRecords(origin: string, token: string, ids: readonly number[]) {
  for (const id of ids) {
    await expectRedirect(
      post(origin, `/saeckel/operations/${id}/delete`, {}, `__Host-hof=${token}`),
      `Удаление записи ${id}`,
    );
  }
}

// --- Chrome over the DevTools protocol --------------------------------------------------------

type Params = Record<string, unknown>;

interface Message {
  id?: number;
  method?: string;
  params?: Params;
  result?: unknown;
  error?: { message: string };
}

// The tab of a new Chrome. Its port file may be written before it answers on that port, so the
// list of tabs is asked again for a few seconds.
async function connect(port: string): Promise<WebSocket> {
  let targets: { type: string; webSocketDebuggerUrl: string }[] | undefined;
  for (let i = 0; targets === undefined; i += 1) {
    try {
      targets = (await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json()) as typeof targets;
    } catch (error) {
      if (i >= 50) throw error;
      await sleep(100);
    }
  }
  const target = targets.find((t) => t.type === 'page');
  if (target === undefined) throw new Refusal('В Chrome нет вкладки.');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return socket;
}

async function startChrome(path: string) {
  const profile = mkdtempSync(join(tmpdir(), 'hof-measure-'));
  // M12.9: the energy saver of Chrome off in the new profile (the setting of Local State). In a
  // new profile it turns on at 20 % of the battery and halves the frames; the frame rate is
  // checked before each way as well.
  writeFileSync(
    join(profile, 'Local State'),
    JSON.stringify({ performance_tuning: { battery_saver_mode: { state: 0 } } }),
  );
  const chrome = spawn(
    path,
    [
      ...CHROME_FLAGS,
      `--user-data-dir=${profile}`,
      // Chrome takes a free port and writes it into the profile.
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  chrome.once('error', () => {});

  let port: string | undefined;
  for (let i = 0; i < 100 && port === undefined; i += 1) {
    await sleep(100);
    try {
      // Read while Chrome writes it, the file may still be empty: no port yet, not port 80.
      const [first = ''] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
      if (/^[1-9]\d*$/.test(first)) port = first;
    } catch {
      // Not written yet.
    }
  }
  if (port === undefined) {
    chrome.kill();
    rmSync(profile, { recursive: true, force: true });
    throw new Refusal(`Chrome не запустился: ${path} (--chrome).`);
  }
  let socket: WebSocket;
  try {
    socket = await connect(port);
  } catch (error) {
    // A Chrome left running would keep this process alive after the error.
    chrome.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }

  let lastId = 0;
  const waiting = new Map<number, (message: Message) => void>();
  const listeners = new Set<(method: string, params: Params) => void>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.id !== undefined) waiting.get(message.id)?.(message);
    else if (message.method !== undefined) {
      for (const listener of listeners) listener(message.method, message.params ?? {});
    }
  });

  async function send<T>(method: string, params: Params = {}): Promise<T> {
    lastId += 1;
    const id = lastId;
    const message = await new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method}: no answer`)), 60_000);
      waiting.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    waiting.delete(id);
    if (message.error !== undefined) throw new Error(`${method}: ${message.error.message}`);
    return message.result as T;
  }

  async function evaluate<T>(expression: string): Promise<T> {
    const answer = await send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (answer.exceptionDetails !== undefined) {
      throw new Error(`evaluate: ${answer.exceptionDetails.text}`);
    }
    return answer.result.value;
  }

  async function close() {
    await send('Browser.close').catch(() => chrome.kill());
    await exited;
    rmSync(profile, { recursive: true, force: true });
  }

  return { send, evaluate, listeners, close };
}

type Chrome = Awaited<ReturnType<typeof startChrome>>;

// What one tab has sent and asked for since it was opened.
interface Tab {
  chrome: Chrome;
  events: Probe[];
  requests: NetRequest[];
  // The JS and CSS answered, by request id: their bodies are read for the weight with gzip.
  code: Map<string, { url: string; type: string }>;
}

function record(tab: Tab) {
  const open = new Map<string, NetRequest>();
  tab.chrome.listeners.add((method, params) => {
    if (method === 'Runtime.bindingCalled' && params.name === 'hofMeasure') {
      tab.events.push(JSON.parse(params.payload as string) as Probe);
      return;
    }
    // A new document committed in the tab: the one before is gone, its music with it. Its own
    // pagehide does not reach the binding any more, so the time is taken here (the clock of the
    // computer, as the page clock is).
    if (method === 'Page.frameNavigated') {
      const frame = (params as { frame: { parentId?: string } }).frame;
      if (frame.parentId === undefined) {
        tab.events.push({ kind: 'commit', at: Date.now(), doc: '', path: '' });
      }
      return;
    }
    const id = params.requestId as string;
    if (method === 'Network.requestWillBeSent') {
      const p = params as {
        request: { url: string; method: string };
        type?: string;
        wallTime: number;
        redirectResponse?: { status: number };
      };
      const before = open.get(id);
      if (before !== undefined && p.redirectResponse !== undefined) {
        before.status = p.redirectResponse.status;
      }
      // Headless Chrome asks for /favicon.ico by itself; the page never does.
      if (p.request.url.endsWith('/favicon.ico')) return;
      const request: NetRequest = {
        method: p.request.method,
        url: p.request.url,
        type: p.type ?? 'Other',
        at: p.wallTime * 1000,
        status: 0,
        bytes: 0,
        canceled: false,
        failed: false,
      };
      open.set(id, request);
      tab.requests.push(request);
      return;
    }
    const request = open.get(id);
    if (request === undefined) return;
    if (method === 'Network.responseReceived') {
      request.status = (params as { response: { status: number } }).response.status;
      if (request.status === 200 && (request.type === 'Script' || request.type === 'Stylesheet')) {
        tab.code.set(id, { url: request.url, type: request.type });
      }
    } else if (method === 'Network.loadingFinished') {
      request.bytes = (params as { encodedDataLength: number }).encodedDataLength;
    } else if (method === 'Network.loadingFailed') {
      request.failed = true;
      request.canceled = (params as { canceled?: boolean }).canceled === true;
    }
  });
}

let product = '';

interface FxSettings {
  anim: boolean;
  music: boolean;
}

// A new Chrome for every measurement: its cache is empty, and nothing a page before left loading
// takes the bandwidth of the next one. «Звуки и движение» live in localStorage of the site, so they
// are set on a plain file of it; then the session cookie, if any.
async function browser(
  path: string,
  profile: Profile,
  fx: FxSettings,
  origin: string,
  token: string | null,
): Promise<Tab> {
  const chrome = await startChrome(path);
  const tab: Tab = { chrome, events: [], requests: [], code: new Map() };
  try {
    record(tab);
    await chrome.send('Page.enable');
    await chrome.send('Network.enable');
    await chrome.send('Runtime.enable');
    await chrome.send('Runtime.addBinding', { name: 'hofMeasure' });
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    await chrome.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    await chrome.send('Emulation.setDeviceMetricsOverride', profile.screen);
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
    await chrome.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: profile.network.latency,
      downloadThroughput: (profile.network.megabits * 1e6) / 8,
      uploadThroughput: (profile.network.uploadMegabits * 1e6) / 8,
    });
    product ||= (await chrome.send<{ product: string }>('Browser.getVersion')).product;
    await open(tab, `${origin}/static/fonts/OFL.txt`, false);
    const settings = { anim: fx.anim, sound: false, soundVol: 80, music: fx.music, musicVol: 50 };
    await chrome.evaluate(`localStorage.setItem('hof.fx', '${JSON.stringify(settings)}')`);
    if (token !== null) {
      await chrome.send('Network.setCookie', {
        name: '__Host-hof',
        value: token,
        url: `${origin}/`,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      });
    }
    return tab;
  } catch (error) {
    await chrome.close();
    throw error;
  }
}

// The first event from index `since` on that `match` accepts, waited for.
async function waitEvent(
  tab: Tab,
  since: number,
  match: (e: Probe) => boolean,
  timeoutMs: number,
  what: string,
): Promise<Probe> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = tab.events.slice(since).find(match);
    if (found !== undefined) return found;
    if (Date.now() > until) throw new Refusal(`${what}: нет события за ${timeoutMs / 1000} с.`);
    await sleep(25);
  }
}

// Without paint there is nothing to measure; a table of blanks would look like a result.
const NO_PAINT = 'Chrome не рисовал страницу (погас экран, сон Mac?) — замер остановлен.';

// A document by its address: its load, then the end of its animations. The probe does not run in
// a plain file (OFL.txt), so there only the load of Chrome is waited for.
async function open(tab: Tab, url: string, probed = true) {
  const since = tab.events.length;
  if (!probed) {
    const loaded = new Promise<void>((resolve) => {
      const listener = (method: string) => {
        if (method !== 'Page.loadEventFired') return;
        tab.chrome.listeners.delete(listener);
        resolve();
      };
      tab.chrome.listeners.add(listener);
    });
    await tab.chrome.send('Page.navigate', { url });
    await loaded;
    return null;
  }
  await tab.chrome.send('Page.navigate', { url });
  const load = await waitEvent(tab, since, (e) => e.kind === 'load', ARRIVAL_MS, url);
  const settled = await waitEvent(
    tab,
    since,
    (e) => e.kind === 'settled' && e.doc === load.doc && e.after === load.at,
    SETTLE_MS,
    `${url}: анимации`,
  );
  return { load, settled };
}

// The centre of the first visible element of the list, scrolled into view, pressed by the mouse.
async function press(tab: Tab, selectors: readonly string[]) {
  const at = await tab.chrome.evaluate<[number, number] | null>(`(() => {
    for (const selector of ${JSON.stringify(selectors)}) {
      const element = [...document.querySelectorAll(selector)].find((e) => e.getClientRects().length > 0);
      if (!element) continue;
      element.scrollIntoView({ block: 'center' });
      const box = element.getBoundingClientRect();
      return [box.left + box.width / 2, box.top + box.height / 2];
    }
    return null;
  })()`);
  if (at === null) throw new Refusal(`Нет элемента ${selectors.join(' или ')}.`);
  const [x, y] = at;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await tab.chrome.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }
}

// A field: focused, its text selected and replaced by typing, as a person would.
async function fill(tab: Tab, selector: string, text: string) {
  const found = await tab.chrome.evaluate<boolean>(`(() => {
    const field = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getClientRects().length > 0);
    if (!field) return false;
    field.focus();
    field.select();
    return true;
  })()`);
  if (!found) throw new Refusal(`Нет поля ${selector}.`);
  await tab.chrome.send('Input.insertText', { text });
}

// What a view shows for the checks of a step.
interface ViewRead {
  rows: HistoryRow[];
  fingerprint: string | null;
  refused: boolean;
  blots: Blot[];
}

export interface Blot {
  file: string;
  place: string;
  // Document coordinates, CSS px: left, top, width, height.
  box: [number, number, number, number];
}

const READ_VIEW = `(() => ({
  rows: [...document.querySelectorAll('tr[id^="op-"]')].map((tr) => {
    const cell = (name) => tr.querySelector('.' + name)?.textContent ?? '';
    const pouch = tr.querySelector('.h-pouch')?.cloneNode(true);
    pouch?.querySelector('.h-kind-phone')?.remove();
    return {
      id: Number(tr.id.slice(3)),
      pouch: pouch?.textContent ?? '',
      kind: cell('h-kind'),
      note: cell('h-note'),
      sum: cell('h-sum'),
    };
  }),
  fingerprint: document.querySelector('.sk-list')?.textContent ?? null,
  refused: document.querySelector('.err-text') !== null,
  blots: [...document.querySelectorAll('img.blot')].filter((img) => img.getClientRects().length > 0).map((img) => {
    const box = img.getBoundingClientRect();
    return {
      file: img.getAttribute('src').split('/').pop().split('?')[0],
      place: [...img.classList].filter((name) => name !== 'blot').join(' '),
      box: [box.left + scrollX, box.top + scrollY, box.width, box.height].map((v) => Math.round(v)),
    };
  }),
}))()`;

// One step measured. The press is the click the page itself saw (or the moment Back was asked
// for); the step arrives with the first new document loaded or view drawn after it, on one of its
// addresses; it ends AFTER_STEP_MS after its animations have ended.
export interface StepRead {
  name: string;
  // From the press, ms: the request of the next view (a document, a fetch, a form), its first
  // frame, the end of its animations, and its LCP when it is a new document.
  toRequest: number | null;
  toView: number | null;
  toSettled: number | null;
  toLcp: number | null;
  // The document after the step: a new one, the same one, or one back from the back/forward cache.
  // Series of M14.1 before this field have `newDocument` (true for a new document).
  document: DocumentFate;
  loaf: { count: number; max: number; total: number };
  input: number | null;
  shift: number;
  requests: ReturnType<typeof requestStats>;
  silence?: ReturnType<typeof silence>;
  blots?: Blot[];
}

interface Context {
  origin: string;
  fingerprint: string;
  music: boolean;
  scenario: Scenario;
}

// The slowest answer to the press: Event Timing where the browser gave it, else the next frame.
function answer(events: readonly Probe[], window: Window, since: number) {
  const timing = slowestInput(events, window);
  const frame = events.slice(since).find((e) => e.kind === 'inputFrame');
  const values = [timing, frame === undefined ? null : (frame.dur as number)];
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : Math.max(...known);
}

// `wrote` — how many records of the mark the way has written so far: Летопись must show them.
async function step(
  tab: Tab,
  context: Context,
  def: Step,
  wrote: number,
): Promise<{ read: StepRead; ids: number[] }> {
  await sleep(BEFORE_PRESS_MS);
  for (const [selector, text] of Object.entries(def.fill ?? {})) await fill(tab, selector, text);
  const since = tab.events.length;
  // The document of the press and every document of the tab before it, by the ids of the probe.
  const earlier = tab.events.slice(0, since).filter((e) => e.doc !== '');
  const before = earlier.at(-1)?.doc ?? '';
  const seen = new Set(earlier.map((e) => e.doc));
  if (def.back === true) {
    await tab.chrome.evaluate(
      `window.hofMeasure(JSON.stringify({ kind: 'press', at: performance.timeOrigin + performance.now(), doc: '', path: location.pathname + location.search })), history.back(), true`,
    );
  } else {
    await press(tab, def.press!);
  }
  const pressed = await waitEvent(tab, since, (e) => e.kind === 'press', 5000, def.name);
  const arrival = await waitEvent(
    tab,
    since,
    (e) => (e.kind === 'load' || e.kind === 'view') && e.at >= pressed.at,
    ARRIVAL_MS,
    def.name,
  );
  if (!arrivedAt(arrival.path, def.to)) {
    throw new Refusal(
      `${def.name}: открылась ${arrival.path} — сессия или данные замера потеряны.`,
    );
  }
  const settled = await waitEvent(
    tab,
    since,
    (e) => e.kind === 'settled' && e.doc === arrival.doc && e.after === arrival.at,
    SETTLE_MS,
    `${def.name}: анимации`,
  );
  const settledAt = settled.timeout === true ? null : settled.at;
  let end = Math.max(settledAt ?? settled.at, arrival.at) + AFTER_STEP_MS;
  // With the music on, the step lasts until it plays again (a new document starts it anew).
  if (context.music) {
    const until = Date.now() + MUSIC_BACK_MS;
    while (!playingNow(tab.events) && Date.now() < until) await sleep(50);
    end = Math.max(end, Date.now());
  }
  while (Date.now() < end) await sleep(50);

  const window: Window = { from: pressed.at, to: end };
  const events = tab.events;
  const document = documentFate(arrival, before, seen);
  // A new document is seen first at its first contentful paint; a view drawn without one, or a
  // page back from the cache, at the frame after it said so.
  const viewAt =
    document === 'new'
      ? events.find(
          (e) => e.kind === 'paint' && e.name === 'first-contentful-paint' && e.doc === arrival.doc,
        )?.at
      : events.find((e, i) => i >= since && e.kind === 'viewFrame' && e.doc === arrival.doc)?.at;
  if (viewAt === undefined) throw new Refusal(`${def.name}: ${NO_PAINT}`);
  const lcp =
    document === 'new'
      ? events.filter((e) => e.kind === 'lcp' && e.doc === arrival.doc).at(-1)
      : undefined;
  const firstRequest = tab.requests.find(
    (r) =>
      r.at >= pressed.at - 5 &&
      (r.type === 'Document' || r.type === 'Fetch' || r.type === 'XHR' || r.method === 'POST'),
  );
  const read: StepRead = {
    name: def.name,
    toRequest: firstRequest === undefined ? null : firstRequest.at - pressed.at,
    toView: viewAt - pressed.at,
    // A document may fire its load before its first frame; the end is never before the view.
    toSettled: settledAt === null ? null : Math.max(settledAt, viewAt) - pressed.at,
    toLcp: lcp === undefined ? null : lcp.at - pressed.at,
    document,
    loaf: longFrames(events, window),
    input: def.back === true ? null : answer(events, window, since),
    shift: layoutShift(events, window),
    requests: requestStats(tab.requests, window),
  };
  if (context.music) {
    const music = events.filter((e) => e.kind !== 'media' || String(e.src).startsWith('music-'));
    read.silence = silence(music, window);
  }

  const view = await tab.chrome.evaluate<ViewRead>(READ_VIEW);
  let ids: number[] = [];
  const rows = view.rows.length;
  if (
    def.check === 'fingerprint' &&
    normalizeText(view.fingerprint ?? '') !== context.fingerprint
  ) {
    throw new Refusal(`${def.name}: данные замера изменились — мешки не те, что в начале серии.`);
  }
  if (def.check === 'refused' && !view.refused) {
    throw new Refusal(`${def.name}: форма не отказала.`);
  }
  if (def.check === 'written') {
    if (view.refused) throw new Refusal(`${def.name}: форма отказала.`);
    // The id of the record from the address the form led to; without it Летопись gives it later.
    const id = freshId(arrival.path);
    if (id !== null) ids = [id];
  }
  if (def.check === 'first-page') {
    ids = markIds(view.rows, MARK);
    if (rows !== PAGE_SIZE || ids.length !== wrote) {
      throw new Refusal(
        `${def.name}: ${rows} строк и ${ids.length} записей замера вместо ${wrote}.`,
      );
    }
  }
  if (def.check === 'second-page' && rows !== SEEDED + wrote - PAGE_SIZE) {
    throw new Refusal(`${def.name}: ${rows} строк на второй странице.`);
  }
  if (def.check === 'blots' || def.check === 'first-page' || def.check === 'fingerprint') {
    read.blots = view.blots;
  }
  return { read, ids };
}

// The way of a scenario in a tab already signed in: the records it wrote, by id, to be deleted.
// A record is the script's only when the form led to it (?fresh=<id>) or Летопись shows it with
// every cell of the mark; the ids found both ways must agree. They go into `written` as they are
// found, so that a way broken off still has its record deleted.
async function walk(
  tab: Tab,
  context: Context,
  written: Set<number>,
  each: (read: StepRead) => void,
) {
  let wrote = 0;
  for (const def of wayOf(context.scenario)) {
    if (def.check === 'written') wrote += 1;
    const { read, ids } = await step(tab, context, def, wrote);
    if (def.check === 'first-page' && written.size > 0) {
      if (ids.some((id) => !written.has(id))) {
        throw new Refusal(`${def.name}: в Летописи не та запись замера, что записала форма.`);
      }
    }
    for (const id of ids) written.add(id);
    each(read);
  }
}

// The data before the series and after it, in a browser without throttling: the pouches as Мешки
// show them, the number of records on both pages of Летопись. Records of the mark left by a run
// that was interrupted are deleted, but only after Летопись has proved to be that of the test
// court: its seeded records, every one in its place.
async function verify(chromePath: string, origin: string, token: string) {
  const tab = await browser(chromePath, PROFILES[1], { anim: false, music: false }, origin, token);
  try {
    const rows = async (path: string) => {
      await open(tab, origin + path);
      return (await tab.chrome.evaluate<ViewRead>(READ_VIEW)).rows;
    };
    const history = async () => {
      const first = await rows('/saeckel/history');
      const second = await rows('/saeckel/history?page=2');
      // A third page would hold rows this check does not see.
      if (second.length >= PAGE_SIZE) return null;
      return { first, second, all: [...first, ...second] };
    };
    const notTest = new Refusal(
      'Летопись не тестового двора замера M14 — ничего не удалено; пересоздайте базу разработки ' +
        '(README.md).',
    );
    const before = await history();
    if (before === null || !isTestCourt(before.all, MARK, SEEDED, SEEDED_NOTES)) throw notTest;
    const left = markIds(before.all, MARK);
    if (left.length > 0) {
      process.stderr.write(
        `удаляю ${left.length} записей замера, оставшихся от прерванного прогона\n`,
      );
      await deleteRecords(origin, token, left);
    }
    const after = await history();
    if (
      after === null ||
      after.first.length !== PAGE_SIZE ||
      after.second.length !== SEEDED - PAGE_SIZE ||
      !isTestCourt(after.all, MARK, SEEDED, SEEDED_NOTES) ||
      markIds(after.all, MARK).length > 0
    ) {
      throw notTest;
    }
    await open(tab, `${origin}/saeckel/`);
    const view = await tab.chrome.evaluate<ViewRead>(READ_VIEW);
    if (view.fingerprint === null) throw new Refusal('На странице Мешков нет колонки мешков.');
    return normalizeText(view.fingerprint);
  } finally {
    await tab.chrome.close();
  }
}

// --- The parts --------------------------------------------------------------------------------

export interface LoadRead {
  fcp: number | null;
  lcp: number | null;
  what: string;
  kb: number;
  imageKb: number;
  jsGzipKb: number;
  cssGzipKb: number;
  requests: number;
  notModified: number;
  loaf: { count: number; max: number; total: number };
  shift: number;
}

// One document by its address. The weight of JS and CSS is that of their bodies compressed as
// nginx does in production (gzip, level 1 — nginx's default); the local server does not compress.
async function loadPage(tab: Tab, origin: string, path: string, weigh: boolean): Promise<LoadRead> {
  const since = tab.events.length;
  const firstRequest = tab.requests.length;
  tab.code.clear();
  const opened = (await open(tab, origin + path))!;
  if (opened.load.path !== path) {
    throw new Refusal(
      `${path}: открылась ${opened.load.path} — сессия или данные замера потеряны.`,
    );
  }
  const end = Math.max(opened.settled.at, opened.load.at) + AFTER_STEP_MS;
  while (Date.now() < end) await sleep(50);
  const events = tab.events.slice(since).filter((e) => e.doc === opened.load.doc);
  const fcp = events.find((e) => e.kind === 'paint' && e.name === 'first-contentful-paint');
  const lcp = events.filter((e) => e.kind === 'lcp').at(-1);
  if (fcp === undefined || lcp === undefined) throw new Refusal(`${path}: ${NO_PAINT}`);
  // The page clock counts from the start of the navigation (timeOrigin): FCP and LCP as the
  // browser reports them.
  const navigationStart = fcp.at - (fcp.start as number);
  const all = tab.requests.slice(firstRequest);
  const kb = (list: NetRequest[]) => list.reduce((sum, r) => sum + r.bytes, 0) / 1024;
  let jsGzip = 0;
  let cssGzip = 0;
  if (weigh) {
    for (const [id, { type }] of tab.code) {
      const body = await tab.chrome
        .send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', {
          requestId: id,
        })
        .catch(() => null);
      if (body === null) continue;
      const bytes = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
      const size = gzipSync(bytes, { level: 1 }).length / 1024;
      if (type === 'Script') jsGzip += size;
      else cssGzip += size;
    }
  }
  const window: Window = { from: navigationStart, to: end };
  return {
    fcp: fcp.start as number,
    lcp: lcp.start as number,
    what: lcp.what as string,
    kb: kb(all),
    imageKb: kb(all.filter((r) => r.type === 'Image')),
    jsGzipKb: jsGzip,
    cssGzipKb: cssGzip,
    requests: all.length,
    notModified: all.filter((r) => r.status === 304).length,
    loaf: longFrames(events, window),
    shift: layoutShift(events, window),
  };
}

export interface LoadRecord {
  profile: string;
  anim: boolean;
  path: string;
  run: number;
  cold: LoadRead;
  warm: LoadRead;
}

export interface ChainRecord {
  profile: string;
  anim: boolean;
  run: number;
  steps: StepRead[];
}

export interface MemoryRead {
  cycle: number;
  documents: number;
  nodes: number;
  listeners: number;
  heapKb: number;
}

async function checkFrames(tab: Tab) {
  const frame = await tab.chrome.evaluate<number>(FRAME_RATE);
  if (frame > FRAME_MS_MAX) {
    throw new Refusal(
      `Chrome рисует кадр раз в ${Math.round(frame)} мс, а не раз в 16,7 мс (энергосбережение?) — ` +
        'замер остановлен.',
    );
  }
}

// The scenario in one new Chrome: the sign-in by its form, the views of WARM once, the way, the
// sign-out. The record the way wrote is deleted after it.
async function chain(
  chromePath: string,
  profile: Profile,
  fx: FxSettings,
  context: Context,
  token: string,
): Promise<StepRead[]> {
  const tab = await browser(chromePath, profile, fx, context.origin, null);
  const written = new Set<number>();
  try {
    await open(tab, `${context.origin}/login`);
    await checkFrames(tab);
    const quiet = { ...context, music: false };
    const reads = [(await step(tab, quiet, SIGN_IN, 0)).read];
    for (const path of WARM) await open(tab, context.origin + path);
    if (fx.music) {
      const until = Date.now() + 30_000;
      while (!playingNow(tab.events)) {
        if (Date.now() > until) throw new Refusal('Музыка не заиграла за 30 с.');
        await sleep(100);
      }
    }
    await walk(tab, context, written, (read) => reads.push(read));
    reads.push((await step(tab, quiet, SIGN_OUT, 0)).read);
    return reads;
  } finally {
    await tab.chrome.close();
    await deleteRecords(context.origin, token, [...written]);
  }
}

// The way repeated in one tab, signed in by the cookie: what stays in memory. Before each count
// the garbage is collected.
async function memory(chromePath: string, context: Context, token: string) {
  const fx = { anim: true, music: false };
  const tab = await browser(chromePath, PROFILES[1], fx, context.origin, token);
  const counts: MemoryRead[] = [];
  const count = async (cycle: number) => {
    await tab.chrome.send('HeapProfiler.collectGarbage');
    const dom = await tab.chrome.send<{
      documents: number;
      nodes: number;
      jsEventListeners: number;
    }>('Memory.getDOMCounters');
    const heap = await tab.chrome.send<{ usedSize: number }>('Runtime.getHeapUsage');
    counts.push({
      cycle,
      documents: dom.documents,
      nodes: dom.nodes,
      listeners: dom.jsEventListeners,
      heapKb: heap.usedSize / 1024,
    });
  };
  try {
    for (const path of WARM) await open(tab, context.origin + path);
    await checkFrames(tab);
    await count(0);
    for (let cycle = 1; cycle <= MEMORY_CYCLES; cycle += 1) {
      process.stderr.write(`память: круг ${cycle}/${MEMORY_CYCLES}\n`);
      const written = new Set<number>();
      try {
        await walk(tab, context, written, () => {});
      } finally {
        await deleteRecords(context.origin, token, [...written]);
      }
      if (MEMORY_AT.includes(cycle)) await count(cycle);
    }
    return counts;
  } finally {
    await tab.chrome.close();
  }
}

// --- The series -------------------------------------------------------------------------------

export interface Series {
  label: string;
  // The way measured; absent in the series of M14.1, which are full.
  scenario?: Scenario;
  date: string;
  product: string;
  flags: string[];
  node: string;
  power: { start: string; end: string };
  // The addresses of the versioned files of the sign-in page: which build was measured.
  build: string[];
  fingerprint: string;
  runs: number;
  // Static files compressed as nginx does (--gzip); absent in the series of M14.1, which are not.
  transport?: 'gzip';
  loads: LoadRecord[];
  chain: ChainRecord[];
  music: ChainRecord[];
  memory: MemoryRead[];
}

const PARTS = ['loads', 'chain', 'music', 'memory'] as const;

function power() {
  if (process.platform !== 'darwin') return '';
  const answer = spawnSync('pmset', ['-g', 'ps'], { encoding: 'utf8' });
  // The source and the charge only: the rest of pmset names the battery of this computer.
  return powerShort(normalizeText(answer.stdout ?? ''));
}

async function build(origin: string) {
  const page = await (await fetch(`${origin}/login`)).text();
  return [...new Set(page.match(/[\w./-]+\?v=[0-9a-f]{12}/g) ?? [])].sort();
}

async function measure(values: {
  label?: string;
  out?: string;
  'gate-key'?: string;
  runs: string;
  parts: string;
  scenario: string;
  origin: string;
  gzip: boolean;
  chrome: string;
}) {
  const runs = Number(values.runs);
  const parts = values.parts.split(',');
  const scenario = values.scenario as Scenario;
  if (
    !SCENARIOS.includes(scenario) ||
    values.label === undefined ||
    values.out === undefined ||
    !Number.isInteger(runs) ||
    runs < 1 ||
    runs > 20 ||
    parts.some((part) => !(PARTS as readonly string[]).includes(part))
  ) {
    throw new Refusal(USAGE);
  }
  const server = new URL(values.origin).origin;
  // Measuring signs in and writes test data: only a server on this computer.
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(server).hostname)) {
    throw new Refusal(`Только локальный сервер, не ${server}.`);
  }
  const proxy = values.gzip ? await gzipProxy(server) : null;
  const origin = proxy?.origin ?? server;
  // When the display of a Mac goes dark, Chrome without a window stops drawing frames. The
  // display stays on while this process lives.
  if (process.platform === 'darwin') {
    spawn('caffeinate', ['-d', '-i', '-w', String(process.pid)], { stdio: 'ignore' }).unref();
  }

  const token = await courtSession(origin, values['gate-key']);
  const fingerprint = await verify(values.chrome, origin, token);
  const context: Context = { origin, fingerprint, music: false, scenario };
  const series: Series = {
    label: values.label,
    scenario,
    date: new Date().toISOString(),
    product,
    flags: CHROME_FLAGS,
    node: process.version,
    power: { start: power(), end: '' },
    build: await build(origin),
    fingerprint,
    runs,
    ...(values.gzip ? { transport: 'gzip' as const } : {}),
    loads: [],
    chain: [],
    music: [],
    memory: [],
  };
  const save = () => {
    series.product = product;
    series.power.end = power();
    writeFileSync(values.out!, `${JSON.stringify(series, null, 1)}\n`);
  };

  // Run 0 warms the server and the computer up and is not kept. Inside a run every configuration
  // comes once, so a slow drift of the computer falls on all of them alike.
  if (parts.includes('loads')) {
    for (let run = 0; run <= runs; run += 1) {
      for (const profile of PROFILES) {
        for (const anim of [false, true]) {
          process.stderr.write(
            `документы, прогон ${run}/${runs}: ${profile.name}, анимации ${anim}\n`,
          );
          for (const { path, signedIn } of PAGES) {
            const tab = await browser(
              values.chrome,
              profile,
              { anim, music: false },
              origin,
              signedIn ? token : null,
            );
            try {
              const cold = await loadPage(tab, origin, path, true);
              const warm = await loadPage(tab, origin, path, false);
              if (run > 0)
                series.loads.push({ profile: profile.name, anim, path, run, cold, warm });
            } finally {
              await tab.chrome.close();
            }
          }
        }
      }
      save();
    }
  }
  if (parts.includes('chain')) {
    for (let run = 0; run <= runs; run += 1) {
      for (const profile of PROFILES) {
        for (const anim of [false, true]) {
          process.stderr.write(`путь, прогон ${run}/${runs}: ${profile.name}, анимации ${anim}\n`);
          const steps = await chain(values.chrome, profile, { anim, music: false }, context, token);
          if (run > 0) series.chain.push({ profile: profile.name, anim, run, steps });
        }
      }
      save();
    }
  }
  if (parts.includes('music')) {
    for (let run = 0; run <= runs; run += 1) {
      for (const profile of PROFILES) {
        process.stderr.write(`музыка, прогон ${run}/${runs}: ${profile.name}\n`);
        const steps = await chain(
          values.chrome,
          profile,
          { anim: true, music: true },
          { ...context, music: true },
          token,
        );
        if (run > 0) series.music.push({ profile: profile.name, anim: true, run, steps });
      }
      save();
    }
  }
  if (parts.includes('memory')) {
    series.memory = await memory(values.chrome, context, token);
    save();
  }
  // The data must be as they were before the series.
  if ((await verify(values.chrome, origin, token)) !== fingerprint) {
    throw new Refusal('После серии данные замера не те, что до неё.');
  }
  await post(origin, '/logout', {}, `__Host-hof=${token}`);
  save();
  proxy?.close();
}

// --gzip: a proxy on localhost in front of the server, which compresses as nginx does in
// production. The Host of the browser goes to the server as it is: the server checks the Origin of
// a POST against it, and a page names its addresses without the host.
async function gzipProxy(server: string): Promise<{ origin: string; close: () => void }> {
  const target = new URL(server);
  // Hop-by-hop: this proxy has its own connections.
  const HOP = ['connection', 'keep-alive', 'transfer-encoding'];
  const proxy = createServer((incoming, outgoing) => {
    const upstream = request(
      {
        hostname: target.hostname,
        port: target.port,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (answer) => {
        const headers = { ...answer.headers };
        for (const name of HOP) delete headers[name];
        const length = headers['content-length'];
        const status = answer.statusCode ?? 502;
        const gzip = nginxGzips({
          path: new URL(incoming.url ?? '/', 'http://localhost').pathname,
          status,
          type: String(headers['content-type'] ?? ''),
          length: length === undefined ? null : Number(length),
          encoding: headers['content-encoding'],
          accept: String(incoming.headers['accept-encoding'] ?? ''),
        });
        if (!gzip) {
          outgoing.writeHead(status, headers);
          answer.pipe(outgoing);
          return;
        }
        delete headers['content-length'];
        headers['content-encoding'] = 'gzip';
        headers.vary =
          headers.vary === undefined ? 'Accept-Encoding' : `${headers.vary}, Accept-Encoding`;
        // nginx weakens a strong ETag of what it compresses.
        if (typeof headers.etag === 'string' && !headers.etag.startsWith('W/')) {
          headers.etag = `W/${headers.etag}`;
        }
        outgoing.writeHead(status, headers);
        answer.pipe(createGzip({ level: 1 })).pipe(outgoing);
      },
    );
    upstream.on('error', () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  // Both localhost addresses, as the server listens: the browser may take either.
  await new Promise<void>((resolve) => proxy.listen(0, '::', resolve));
  const address = proxy.address();
  if (address === null || typeof address === 'string') throw new Refusal('Прокси без порта.');
  return {
    origin: `http://localhost:${address.port}`,
    close: () => {
      proxy.closeAllConnections();
      proxy.close();
    },
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      label: { type: 'string' },
      out: { type: 'string' },
      'gate-key': { type: 'string' },
      runs: { type: 'string', default: '10' },
      parts: { type: 'string', default: PARTS.join(',') },
      scenario: { type: 'string', default: 'full' },
      origin: { type: 'string', default: 'http://localhost:3000' },
      gzip: { type: 'boolean', default: false },
      chrome: {
        type: 'string',
        default: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
      report: { type: 'boolean', default: false },
    },
  });
  if (values.report) {
    if (positionals.length === 0) throw new Refusal(USAGE);
    const series = positionals.map((file) => JSON.parse(readFileSync(file, 'utf8')) as Series);
    process.stdout.write(report(series));
    return;
  }
  if (positionals.length > 0) throw new Refusal(USAGE);
  await measure(values);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Refusal ? error.message : error instanceof Error ? error.stack : String(error)}\n`,
    );
    // A failed fetch says why only in its cause (the refused address, the reset socket).
    if (error instanceof Error && error.cause !== undefined) {
      const { cause } = error;
      process.stderr.write(
        `cause: ${cause instanceof Error ? cause.stack : JSON.stringify(cause)}\n`,
      );
    }
    // A browser or a socket still open must not keep a failed series running for hours.
    process.exit(1);
  }
}
