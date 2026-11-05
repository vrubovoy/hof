// Page speed of Hof on a local server, to compare versions (docs/OPERATIONS.md, «Замер скорости
// страниц»). Run by hand, never by CI: the numbers depend on the computer.
//
//   node src/measure.ts --label <версия> [--gate-key <ключ>] [--runs 3] [--origin <адрес>]
//
// Headless Chrome is driven over the DevTools protocol with the WebSocket and fetch of Node, so
// nothing is installed. Two profiles, each with its screen, network and CPU, and «Анимации» off
// and on. Every page is opened with the cache of the browser emptied (cold) and once more (warm).
// Two transitions are measured from the press of the link to the first paint of the next page.
// The medians of all runs go to stdout as Markdown tables, the progress to stderr.
//
// Data: the script founds a court on an empty development database (the gate key comes from the
// server log) or signs in to the court it founded before, with its own test login. A server that
// is not on this computer is refused.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const USAGE =
  'Использование: node src/measure.ts --label <версия> [--gate-key <ключ>] [--runs 3] ' +
  '[--origin http://localhost:3000] [--chrome <путь к Chrome>]';

// The test court of the measurement. Local data only, so the password may be written here.
const LOGIN = 'measure';
const MEMBER = 'measure-member';
const PASSWORD = 'measure-local-only-password';
const POUCHES = ['Еда', 'Дом', 'Дети', 'Отпуск'];

const PROFILES = [
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

const PAGES = [
  { path: '/login', signedIn: false },
  { path: '/', signedIn: true },
  { path: '/account', signedIn: true },
  { path: '/admin/users', signedIn: true },
  { path: '/saeckel/', signedIn: true },
  { path: '/saeckel/pouches/1', signedIn: true },
  { path: '/saeckel/history', signedIn: true },
  { path: '/measure-404', signedIn: true },
] as const;

// The link is the first visible element of the list: the phone and the computer show different
// ones (the signs under the map, the sign on the map).
const TRANSITIONS = [
  {
    name: 'Двор → Säckel',
    from: '/',
    to: '/saeckel/',
    links: ['nav.court-places a[href="/saeckel/"]', 'a.place[href="/saeckel/"] > .sign'],
  },
  {
    name: 'Мешки → Летопись',
    from: '/saeckel/',
    to: '/saeckel/history',
    links: ['a[href="/saeckel/history"]'],
  },
] as const;

// After the load event: late images and the last LCP entry.
const SETTLE_MS = 1000;
// Before a press: fx.js has set itself up. After the next page has loaded: its arrival animation.
const BEFORE_PRESS_MS = 1500;
const AFTER_ARRIVAL_MS = 1500;
const LONG_FRAME_MS = 50;

// Put into every page before its own scripts. It keeps the LCP entries and, only around a press
// of a link, the frames: on the page left from the press to pagehide, on the next page for its
// first 4 s. The click time and the frames of the page left go through sessionStorage. Frames are
// [start as epoch ms, length ms].
const PROBE = `(() => {
  const lcp = [];
  try {
    new PerformanceObserver((list) => lcp.push(...list.getEntries()))
      .observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  const frames = [];
  let running = false;
  let last = null;
  let until = 0;
  const tick = (t) => {
    if (last !== null) frames.push([performance.timeOrigin + last, t - last]);
    last = t;
    if (performance.now() < until) requestAnimationFrame(tick);
    else running = false;
  };
  const record = (ms) => {
    until = performance.now() + ms;
    if (running) return;
    running = true;
    last = null;
    requestAnimationFrame(tick);
  };
  if (sessionStorage.getItem('hof-measure.click') !== null) record(4000);
  addEventListener('click', () => {
    sessionStorage.setItem('hof-measure.click', String(performance.timeOrigin + performance.now()));
    record(10000);
  }, true);
  addEventListener('pagehide', () => {
    sessionStorage.setItem('hof-measure.frames', JSON.stringify(frames));
  });
  window.__hofMeasure = { lcp, frames };
})();`;

const READ_PAGE = `(() => {
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  const lcp = window.__hofMeasure.lcp.at(-1);
  const element = lcp?.element;
  const what = !lcp ? '' : lcp.url ? lcp.url.split('/').pop()
    : element ? element.tagName.toLowerCase() + (element.classList[0] ? '.' + element.classList[0] : '') : '';
  return { path: location.pathname, fcp: fcp?.startTime ?? null, lcp: lcp?.startTime ?? null, what };
})()`;

const READ_TRANSITION = `(() => {
  const click = Number(sessionStorage.getItem('hof-measure.click'));
  const left = JSON.parse(sessionStorage.getItem('hof-measure.frames') ?? '[]');
  sessionStorage.removeItem('hof-measure.click');
  sessionStorage.removeItem('hof-measure.frames');
  const t0 = performance.timeOrigin;
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = performance.getEntriesByName('first-paint')[0] ?? performance.getEntriesByName('first-contentful-paint')[0];
  const firstPaint = paint === undefined ? null : t0 + paint.startTime;
  const old = left.filter(([at]) => at >= click).map(([, length]) => length);
  const fresh = window.__hofMeasure.frames
    .filter(([at]) => firstPaint !== null && at >= firstPaint && at < firstPaint + ${AFTER_ARRIVAL_MS})
    .map(([, length]) => length);
  return {
    path: location.pathname,
    toRequest: t0 + nav.requestStart - click,
    toPaint: firstPaint === null ? null : firstPaint - click,
    oldLong: old.filter((length) => length > ${LONG_FRAME_MS}).length,
    oldMax: Math.max(0, ...old),
    newFrames: fresh.length,
    newLong: fresh.filter((length) => length > ${LONG_FRAME_MS}).length,
    newMax: Math.max(0, ...fresh),
  };
})()`;

interface PageRead {
  path: string;
  fcp: number | null;
  lcp: number | null;
  what: string;
}

interface TransitionRead {
  path: string;
  toRequest: number;
  toPaint: number | null;
  oldLong: number;
  oldMax: number;
  newFrames: number;
  newLong: number;
  newMax: number;
}

interface Load {
  fcp: number;
  lcp: number;
  what: string;
  kb: number;
  imageKb: number;
  requests: number;
  notModified: number;
}

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
    await expectRedirect(
      post(
        origin,
        '/saeckel/income',
        { amount: '1000', date: '2026-11-01', note: 'Жалованье' },
        cookie,
      ),
      'Доход',
    );
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

// --- Chrome over the DevTools protocol --------------------------------------------------------

type Params = Record<string, unknown>;

interface Message {
  id?: number;
  method?: string;
  params?: Params;
  result?: unknown;
  error?: { message: string };
}

async function startChrome(path: string) {
  const profile = mkdtempSync(join(tmpdir(), 'hof-measure-'));
  const chrome = spawn(
    path,
    [
      '--headless',
      `--user-data-dir=${profile}`,
      // Chrome takes a free port and writes it into the profile.
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--hide-scrollbars',
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
      port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    } catch {
      // Not written yet.
    }
  }
  if (port === undefined) {
    chrome.kill();
    rmSync(profile, { recursive: true, force: true });
    throw new Refusal(`Chrome не запустился: ${path} (--chrome).`);
  }
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const target = targets.find((t) => t.type === 'page');
  if (target === undefined) throw new Refusal('В Chrome нет вкладки.');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

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

  // The next event `method` from now on.
  function next(method: string, timeoutMs: number) {
    return new Promise<Params>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Refusal(`Страница не загрузилась за ${timeoutMs / 1000} с.`));
      }, timeoutMs);
      const listener = (name: string, params: Params) => {
        if (name !== method) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(params);
      };
      listeners.add(listener);
    });
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

  return { send, next, evaluate, listeners, close };
}

type Chrome = Awaited<ReturnType<typeof startChrome>>;

// --- One page, one transition -----------------------------------------------------------------

interface Request {
  type: string;
  status: number;
  bytes: number;
}

type Profile = (typeof PROFILES)[number];

// The requests of the page now being measured, by the id Chrome gives them.
let requests = new Map<string, Request>();

function track(method: string, params: Params) {
  const id = params.requestId as string;
  if (method === 'Network.requestWillBeSent') {
    const { request, type } = params as { request: { url: string }; type?: string };
    // Headless Chrome asks for /favicon.ico by itself; the page never does.
    if (!request.url.endsWith('/favicon.ico')) {
      requests.set(id, { type: type ?? 'Other', status: 0, bytes: 0 });
    }
  }
  const request = requests.get(id);
  if (request === undefined) return;
  if (method === 'Network.responseReceived') {
    request.status = (params as { response: { status: number } }).response.status;
  }
  if (method === 'Network.loadingFinished') {
    request.bytes = (params as { encodedDataLength: number }).encodedDataLength;
  }
}

let product = '';

// A new Chrome for every page and every transition: its cache is empty, and nothing a page before
// left loading takes the bandwidth of the next one. «Звуки и движение» live in localStorage of the
// site, so they are set on a plain file of it; then the session cookie, if any.
async function browser(
  path: string,
  profile: Profile,
  anim: boolean,
  origin: string,
  token: string | null,
) {
  const chrome = await startChrome(path);
  try {
    chrome.listeners.add(track);
    await chrome.send('Page.enable');
    await chrome.send('Network.enable');
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
    await open(chrome, `${origin}/static/fonts/OFL.txt`);
    const settings = { anim, sound: false, soundVol: 80, music: false, musicVol: 50 };
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
    return chrome;
  } catch (error) {
    await chrome.close();
    throw error;
  }
}

async function open(chrome: Chrome, url: string) {
  const loaded = chrome.next('Page.loadEventFired', 60_000);
  await chrome.send('Page.navigate', { url });
  await loaded;
}

// Without paint there is nothing to measure; a table of blanks would look like a result.
const NO_PAINT = 'Chrome не рисовал страницу (погас экран, сон Mac?) — замер остановлен.';

async function loadPage(chrome: Chrome, origin: string, path: string): Promise<Load> {
  requests = new Map();
  await open(chrome, origin + path);
  await sleep(SETTLE_MS);
  const page = await chrome.evaluate<PageRead>(READ_PAGE);
  if (page.path !== path) {
    throw new Refusal(`${path}: открылась ${page.path} — сессия или данные замера потеряны.`);
  }
  if (page.fcp === null || page.lcp === null) throw new Refusal(`${path}: ${NO_PAINT}`);
  const all = [...requests.values()];
  const kb = (list: Request[]) => list.reduce((sum, r) => sum + r.bytes, 0) / 1024;
  return {
    fcp: page.fcp,
    lcp: page.lcp,
    what: page.what,
    kb: kb(all),
    imageKb: kb(all.filter((r) => r.type === 'Image')),
    requests: all.length,
    notModified: all.filter((r) => r.status === 304).length,
  };
}

async function press(chrome: Chrome, links: readonly string[]) {
  const at = await chrome.evaluate<[number, number] | null>(`(() => {
    for (const selector of ${JSON.stringify(links)}) {
      const link = [...document.querySelectorAll(selector)].find((e) => e.getClientRects().length > 0);
      if (!link) continue;
      link.scrollIntoView({ block: 'center' });
      const box = link.getBoundingClientRect();
      return [box.left + box.width / 2, box.top + box.height / 2];
    }
    return null;
  })()`);
  if (at === null) throw new Refusal(`Нет ссылки ${links.join(' или ')}.`);
  const [x, y] = at;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await chrome.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

async function transition(
  chrome: Chrome,
  origin: string,
  { from, to, links }: (typeof TRANSITIONS)[number],
) {
  // Both pages once before: the press comes with their files in the cache, as on a second visit.
  await open(chrome, origin + to);
  await open(chrome, origin + from);
  await sleep(BEFORE_PRESS_MS);
  const arrived = chrome.next('Page.loadEventFired', 60_000);
  await press(chrome, links);
  await arrived;
  await sleep(AFTER_ARRIVAL_MS);
  const read = await chrome.evaluate<TransitionRead>(READ_TRANSITION);
  if (read.path !== to) throw new Refusal(`Переход в ${to}: открылась ${read.path}.`);
  // The page left may go before its next frame; the page that came must have drawn some.
  if (read.toPaint === null || read.newFrames === 0) throw new Refusal(`${to}: ${NO_PAINT}`);
  return read;
}

// --- Runs and the table -----------------------------------------------------------------------

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const ms = (value: number) => String(Math.round(value));

function spread(values: number[]) {
  if (values.length < 2) return ms(median(values));
  return `${ms(median(values))} (${ms(Math.min(...values))}–${ms(Math.max(...values))})`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      label: { type: 'string' },
      'gate-key': { type: 'string' },
      runs: { type: 'string', default: '3' },
      origin: { type: 'string', default: 'http://localhost:3000' },
      chrome: {
        type: 'string',
        default: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
    },
  });
  const runs = Number(values.runs);
  if (values.label === undefined || !Number.isInteger(runs) || runs < 1 || runs > 10) {
    throw new Refusal(USAGE);
  }
  const origin = new URL(values.origin).origin;
  // Measuring signs in and writes test data: only a server on this computer.
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) {
    throw new Refusal(`Только локальный сервер, не ${origin}.`);
  }
  // When the display of a Mac goes dark, Chrome without a window stops drawing frames. The
  // display stays on while this process lives.
  if (process.platform === 'darwin') {
    spawn('caffeinate', ['-d', '-i', '-w', String(process.pid)], { stdio: 'ignore' }).unref();
  }

  const token = await courtSession(origin, values['gate-key']);
  const loads = new Map<string, { cold: Load[]; warm: Load[] }>();
  const moves = new Map<string, TransitionRead[]>();
  for (let run = 1; run <= runs; run += 1) {
    for (const profile of PROFILES) {
      for (const anim of [false, true]) {
        process.stderr.write(`прогон ${run}/${runs}: ${profile.name}, анимации ${anim}\n`);
        for (const { path, signedIn } of PAGES) {
          const chrome = await browser(
            values.chrome,
            profile,
            anim,
            origin,
            signedIn ? token : null,
          );
          try {
            const key = `${profile.name}|${anim}|${path}`;
            const entry = loads.get(key) ?? { cold: [], warm: [] };
            entry.cold.push(await loadPage(chrome, origin, path));
            entry.warm.push(await loadPage(chrome, origin, path));
            loads.set(key, entry);
          } finally {
            await chrome.close();
          }
        }
        for (const move of TRANSITIONS) {
          const chrome = await browser(values.chrome, profile, anim, origin, token);
          try {
            const key = `${profile.name}|${anim}|${move.name}`;
            moves.set(key, [...(moves.get(key) ?? []), await transition(chrome, origin, move)]);
          } finally {
            await chrome.close();
          }
        }
      }
    }
  }

  const out = [
    `## Замер: ${values.label}, ${new Date().toISOString().slice(0, 10)}, ${product}, прогонов ${runs}`,
    '',
    'Медианы, мс; в скобках — разброс прогонов. Вес — по сети до load + 1 с.',
  ];
  for (const profile of PROFILES) {
    out.push(
      '',
      `### ${profile.name}: ${profile.about}`,
      '',
      '| Страница | Анимации | FCP | LCP | Элемент LCP | КБ (картинки) | Запросов | Повторно: LCP | Повторно: 304 из |',
      '|---|---|---|---|---|---|---|---|---|',
    );
    for (const anim of [false, true]) {
      for (const { path } of PAGES) {
        const { cold, warm } = loads.get(`${profile.name}|${anim}|${path}`)!;
        const pick = (list: Load[], field: keyof Omit<Load, 'what'>) =>
          list.map((load) => load[field]);
        out.push(
          `| ${path} | ${anim ? 'вкл' : 'выкл'} | ${ms(median(pick(cold, 'fcp')))} | ` +
            `${spread(pick(cold, 'lcp'))} | ${cold.at(-1)!.what} | ` +
            `${ms(median(pick(cold, 'kb')))} (${ms(median(pick(cold, 'imageKb')))}) | ` +
            `${ms(median(pick(cold, 'requests')))} | ${ms(median(pick(warm, 'lcp')))} | ` +
            `${ms(median(pick(warm, 'notModified')))} из ${ms(median(pick(warm, 'requests')))} |`,
        );
      }
    }
    out.push(
      '',
      `Переходы (${profile.name.toLowerCase()}), кадры дольше ${LONG_FRAME_MS} мс: число / самый длинный.`,
      '',
      '| Переход | Анимации | Нажатие → запрос | Нажатие → первая отрисовка | Кадры старой страницы | Кадры новой страницы |',
      '|---|---|---|---|---|---|',
    );
    for (const anim of [false, true]) {
      for (const { name } of TRANSITIONS) {
        const list = moves.get(`${profile.name}|${anim}|${name}`)!;
        const pick = (
          field: 'toRequest' | 'toPaint' | 'oldLong' | 'oldMax' | 'newLong' | 'newMax',
        ) => list.map((read) => read[field] ?? NaN);
        out.push(
          `| ${name} | ${anim ? 'вкл' : 'выкл'} | ${spread(pick('toRequest'))} | ` +
            `${spread(pick('toPaint'))} | ${ms(median(pick('oldLong')))} / ${ms(median(pick('oldMax')))} | ` +
            `${ms(median(pick('newLong')))} / ${ms(median(pick('newMax')))} |`,
        );
      }
    }
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Refusal ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
