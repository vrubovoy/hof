// fx.js in a page made of only what it touches (ARCHITECTURE.md §6): fake <audio>, Web Audio and
// storage, the events of «Звуки и движение», links and forms. Music switched off and on again at
// once must not give a second piece; the ordinary off still stops and lets go of the player; a
// short sound lets go of its Web Audio nodes when it ends, fails or is refused. The way to the
// next page (M10.2): a slide waits, a second press goes at once, presses of the browser's own are
// left alone, a form is never held and leaves the flag of its act, the door opens with it; back
// from the back/forward cache the page is as before it left. The living courtyard (M10.3): the
// door of a place, the chains of the wind and the birds, the fountain.

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

type Listener = (event: { type: string; target?: unknown }) => void;

class FakeParam {
  value = 1;
  cancelScheduledValues() {}
  setValueAtTime(value: number) {
    this.value = value;
  }
  linearRampToValueAtTime(value: number) {
    this.value = value;
  }
}

class FakeNode {
  connected = true;
  connect<T>(next: T): T {
    return next;
  }
  disconnect() {
    this.connected = false;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeAudio {
  static made: FakeAudio[] = [];
  // Set by a test: play() is refused, as by the autoplay rules of a browser.
  static refuse = false;
  paused = true;
  loop = false;
  currentTime = 0;
  duration = 100;
  readyState = 1;
  volume = 1;
  listeners = new Map<string, Listener[]>();
  src: string;
  constructor(src: string) {
    this.src = src;
    FakeAudio.made.push(this);
  }
  play(): Promise<void> {
    if (FakeAudio.refuse) return Promise.reject(new Error('NotAllowedError'));
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }
}

// One AudioContext of the page; every <audio> it plays through, with its source and gain node.
class FakeContext {
  static last: FakeContext | null = null;
  state = 'running';
  currentTime = 0;
  destination = new FakeNode();
  wires: { audio: FakeAudio; source: FakeNode; gain: FakeGain }[] = [];
  private nextGain: FakeGain | null = null;
  constructor() {
    FakeContext.last = this;
  }
  createGain() {
    this.nextGain = new FakeGain();
    return this.nextGain;
  }
  createMediaElementSource(audio: FakeAudio) {
    const source = new FakeNode();
    this.wires.push({ audio, source, gain: this.nextGain! });
    return source;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeClassList {
  names = new Set<string>();
  add(...names: string[]) {
    for (const name of names) this.names.add(name);
  }
  remove(...names: string[]) {
    for (const name of names) this.names.delete(name);
  }
  toggle(name: string, on?: boolean) {
    if (on ?? !this.names.has(name)) this.names.add(name);
    else this.names.delete(name);
    return this.names.has(name);
  }
  contains(name: string) {
    return this.names.has(name);
  }
}

class FakeElement {
  classList = new FakeClassList();
  dataset: Record<string, string> = {};
}

// <a href> as fx.js reads it: its address in parts, data-fx and data-keep, target and download.
class FakeLink extends FakeElement {
  href: string;
  origin: string;
  pathname: string;
  search: string;
  target = '';
  attributes = new Set<string>();
  constructor(href: string, fx?: string, keep = false) {
    super();
    const url = new URL(href, ORIGIN);
    this.href = url.href;
    this.origin = url.origin;
    this.pathname = url.pathname;
    this.search = url.search;
    if (fx !== undefined) this.dataset.fx = fx;
    if (keep) this.dataset.keep = '';
  }
  closest() {
    return this;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
}

// <form method="post"> with the frames of a door in its button.
class FakeForm extends FakeElement {
  method = 'post';
  action: string;
  frames = new FakeElement();
  constructor(action: string, fx?: string) {
    super();
    this.action = new URL(action, ORIGIN).href;
    if (fx !== undefined) this.dataset.fx = fx;
  }
  querySelector(selector: string) {
    return selector === '.frames' ? this.frames : null;
  }
}

class FakeInput {
  checked = false;
  value = '';
  parentElement = null;
  dataset: { setting: string };
  type: 'checkbox' | 'range';
  constructor(setting: string, type: 'checkbox' | 'range') {
    this.dataset = { setting };
    this.type = type;
  }
}

const ORIGIN = 'https://hof.test';

// A box of the courtyard as fx.js measures it, in px of the window.
type Box = { left: number; top: number; right: number; bottom: number };
class FakeBox extends FakeElement {
  box: Box;
  // What closest() finds, by the selector.
  outer: Record<string, FakeBox> = {};
  style = {
    transformOrigin: '',
    removeProperty(name: string) {
      if (name === 'transform-origin') this.transformOrigin = '';
    },
  };
  offsetWidth = 0;
  constructor(box: Box, ...names: string[]) {
    super();
    this.box = box;
    this.classList.add(...names);
  }
  getBoundingClientRect() {
    const { left, top, right, bottom } = this.box;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  getClientRects() {
    return this.box.right > this.box.left ? [this.getBoundingClientRect()] : [];
  }
  closest(selector: string) {
    return this.outer[selector] ?? null;
  }
  addEventListener() {}
}

// The courtyard of a computer 1440×900: the map right of the banner (1152 px wide, its top 34 px
// cut off), the layers, and the door of the treasury twice — in its link and on the map of the
// phone, not drawn here. `door` moves the drawn door.
function courtyard(door: Box = { left: 722.25, top: 287.75, right: 776.25, bottom: 396.5 }) {
  const map = new FakeBox({ left: 288, top: 0, right: 1440, bottom: 610 }, 'court-map');
  const inner = new FakeBox({ left: 288, top: -34, right: 1440, bottom: 734 }, 'court-inner');
  const doors = [
    new FakeBox(door, 'door', 'door-treasury'),
    new FakeBox({ left: 0, top: 0, right: 0, bottom: 0 }, 'door', 'door-treasury'),
  ];
  for (const d of doors) d.outer = { '.court-inner': inner, '.court-map': map };
  const leaves = ['olive', 'bush-l', 'bush-r', 'tree'].map(
    (name) => new FakeBox(map.box, 'fx', 'fx-leaves', `fx-${name}`),
  );
  return {
    map,
    inner,
    doors,
    leaves,
    fountain: new FakeBox(map.box, 'fx', 'fx-fountain'),
    flock: new FakeBox(map.box, 'fx', 'fx-birds'),
  };
}
type Court = ReturnType<typeof courtyard>;

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

type Settings = Partial<Record<'anim' | 'sound' | 'music', boolean>>;

// A new page each time: its own storage, block and module instance of fx.js. `settings` are kept
// on this device before the page opens; `phone` — the window is as narrow as a phone; `arrived` —
// what fx-head.js left on <html>; `court` — the page is the courtyard; `reduced` — the system asks
// for less motion; `active` — whether the person has acted on the page yet (unknown if left out);
// `local` — the storage of this device, kept from an earlier page.
let pages = 0;
async function openChambers({
  settings = {},
  phone = false,
  arrived,
  court,
  reduced = false,
  active,
  local = memory(),
}: {
  settings?: Settings;
  phone?: boolean;
  arrived?: string;
  court?: Court;
  reduced?: boolean;
  active?: boolean;
  local?: ReturnType<typeof memory>;
} = {}) {
  FakeAudio.made = [];
  FakeAudio.refuse = false;
  FakeContext.last = null;
  const inputs = {
    anim: new FakeInput('anim', 'checkbox'),
    sound: new FakeInput('sound', 'checkbox'),
    soundVol: new FakeInput('soundVol', 'range'),
    music: new FakeInput('music', 'checkbox'),
    musicVol: new FakeInput('musicVol', 'range'),
  };
  const blockListeners = new Map<string, Listener[]>();
  const block = {
    hidden: true,
    querySelectorAll: () => Object.values(inputs),
    addEventListener(type: string, listener: Listener) {
      blockListeners.set(type, [...(blockListeners.get(type) ?? []), listener]);
    },
  };
  const session = memory();
  local.setItem('hof.fx', JSON.stringify(settings));
  const root = new FakeElement();
  if (arrived !== undefined) root.dataset.arrived = arrived;
  const forms: FakeForm[] = [];
  const assigned: string[] = [];
  // The listeners of the document and of the window, by the type of event.
  const on = { document: new Map<string, Listener[]>(), window: new Map<string, Listener[]>() };
  const listen = (where: Map<string, Listener[]>) => (type: string, listener: Listener) =>
    void where.set(type, [...(where.get(type) ?? []), listener]);
  const doc = {
    hidden: false,
    readyState: 'loading',
    documentElement: root,
    getElementById: (id: string) => (id === 'fx-settings' ? (court ? null : block) : null),
    addEventListener: listen(on.document),
    querySelector: (selector: string) =>
      ({ '.fx-fountain': court?.fountain, '.fx-birds': court?.flock })[selector] ?? null,
    querySelectorAll: (selector: string): unknown[] => {
      if (selector === '.fx-leaves') return court?.leaves ?? [];
      if (selector === '.court-inner') return court ? [court.inner] : [];
      if (selector !== '.frames.open, .door.open') return [];
      return [...forms.map((form) => form.frames), ...(court?.doors ?? [])].filter((element) =>
        element.classList.contains('open'),
      );
    },
    getElementsByClassName: (name: string) =>
      (court?.doors ?? []).filter((door) => door.classList.contains(name)),
  };
  const activation = active === undefined ? undefined : { hasBeenActive: active };
  Object.defineProperty(globalThis, 'navigator', {
    value: { userActivation: activation },
    configurable: true,
    writable: true,
  });
  Object.assign(globalThis, {
    window: { localStorage: local, sessionStorage: session },
    document: doc,
    innerWidth: 1440,
    innerHeight: 900,
    getComputedStyle: (element: FakeBox) => ({
      backgroundImage: element.classList.contains('wake')
        ? `url("${ORIGIN}/static/img/${[...element.classList.names].find((n) => n.startsWith('fx-') && n !== 'fx-leaves')}.webp")`
        : 'none',
    }),
    Image: class {
      src = '';
      decode() {
        return Promise.resolve();
      }
    },
    location: { assign: (address: string) => void assigned.push(address) },
    matchMedia: (query: string) => ({
      matches: query.includes('max-width') ? phone : query.includes('reduce') && reduced,
      addEventListener() {},
    }),
    addEventListener: listen(on.window),
    Audio: FakeAudio,
    AudioContext: FakeContext,
    Element: FakeElement,
    HTMLAnchorElement: FakeLink,
    HTMLElement: FakeBox,
    HTMLInputElement: FakeInput,
    HTMLFormElement: FakeForm,
    HTMLMediaElement: { HAVE_METADATA: 1 },
  });
  pages += 1;
  await import(`./static/fx.js?page=${pages}`);
  const fire = <E extends { type: string }>(where: Map<string, Listener[]>, event: E): E => {
    for (const listener of where.get(event.type) ?? []) listener(event);
    return event;
  };
  // A press on a link as a browser sends it: the main button and no key, unless said otherwise.
  const press = (link: FakeLink, keys: Partial<Record<string, number | boolean>> = {}) =>
    fire(on.document, {
      type: 'click',
      target: link,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...keys,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    });
  const send = (form: FakeForm) => {
    if (!forms.includes(form)) forms.push(form);
    return fire(on.document, {
      type: 'submit',
      target: form,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    });
  };
  const flag = (key: string) =>
    JSON.parse(session.getItem(key) ?? 'null') as Record<string, unknown> | null;
  const backFromCache = () => fire(on.window, { type: 'pageshow', persisted: true });
  const hide = () => fire(on.window, { type: 'pagehide', persisted: true });
  // A box changes by «change», a slider by «input» and, when let go, «change».
  const change = async (input: FakeInput, value: boolean | string) => {
    if (typeof value === 'boolean') input.checked = value;
    else input.value = value;
    const types = input.type === 'checkbox' ? ['change'] : ['input', 'change'];
    for (const type of types) {
      for (const listener of blockListeners.get(type) ?? []) listener({ type, target: input });
    }
    await settle();
  };
  // The tab hidden or seen again; the page loaded; an action of the person.
  const seen = (on_: boolean) => {
    doc.hidden = !on_;
    fire(on.document, { type: 'visibilitychange' });
  };
  const loaded = () => fire(on.window, { type: 'load' });
  const act = () => {
    if (activation) activation.hasBeenActive = true;
    fire(on.window, { type: 'pointerdown' });
  };
  return {
    inputs,
    change,
    root,
    press,
    send,
    flag,
    assigned,
    backFromCache,
    hide,
    seen,
    loaded,
    act,
    local,
  };
}

// Lets the promises of play() and resume() run.
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

const pieces = () => FakeAudio.made.filter((audio) => audio.src.includes('/music/'));
const playing = () => pieces().filter((audio) => !audio.paused);
const wiresOf = (audio: FakeAudio) => FakeContext.last!.wires.find((wire) => wire.audio === audio)!;

describe('fx.js in a page: music', () => {
  test('off and on at once: the same player comes back, never a second piece', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { inputs, change } = await openChambers();
    await change(inputs.music, true);
    assert.equal(pieces().length, 1);
    assert.equal(playing().length, 1);
    const [first] = pieces();

    await change(inputs.music, false);
    // Fading out: still heard.
    assert.equal(playing().length, 1);
    await change(inputs.music, true);
    assert.equal(pieces().length, 1, 'no second player');
    assert.deepEqual(playing(), [first]);
    assert.ok(wiresOf(first!).gain.gain.value > 0, 'faded in again');

    // The stop of the fade-out does not come later and silence the piece.
    t.mock.timers.tick(1000);
    await settle();
    assert.deepEqual(playing(), [first]);
    assert.ok(first!.src.includes('/music/'));
    assert.equal(wiresOf(first!).source.connected, true);
  });

  test('the ordinary off: faded out, stopped, its nodes let go; on again — one new piece', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { inputs, change } = await openChambers();
    await change(inputs.music, true);
    const [first] = pieces();
    await change(inputs.music, false);
    assert.equal(wiresOf(first!).gain.gain.value, 0);
    t.mock.timers.tick(450);
    await settle();
    assert.equal(first!.paused, true);
    assert.equal(first!.src, '');
    assert.equal(wiresOf(first!).source.connected, false);
    assert.equal(wiresOf(first!).gain.connected, false);

    await change(inputs.music, true);
    assert.equal(FakeAudio.made.length, 2, 'one new player');
    assert.equal(playing().length, 1);
    assert.notEqual(playing()[0], first);
  });
});

describe('fx.js in a page: a short sound lets go of its nodes', () => {
  for (const end of ['ended', 'error'] as const) {
    test(`after «${end}»`, async () => {
      const { inputs, change } = await openChambers();
      await change(inputs.sound, true);
      await change(inputs.soundVol, '70');
      const [coins] = FakeAudio.made;
      assert.match(coins!.src, /^\/static\/sounds\/coins-[12]\.m4a$/);
      assert.equal(wiresOf(coins!).source.connected, true);
      coins!.fire(end);
      assert.equal(wiresOf(coins!).source.connected, false);
      assert.equal(wiresOf(coins!).gain.connected, false);
    });
  }

  test('when the browser refuses to play it', async () => {
    const { inputs, change } = await openChambers();
    await change(inputs.sound, true);
    FakeAudio.refuse = true;
    await change(inputs.soundVol, '70');
    const [coins] = FakeAudio.made;
    assert.equal(wiresOf(coins!).source.connected, false);
    assert.equal(wiresOf(coins!).gain.connected, false);
  });
});

const sounds = (name: string) =>
  FakeAudio.made.filter((audio) => audio.src.startsWith(`/static/sounds/${name}-`));

describe('fx.js in a page: the way to the next page by a link', () => {
  test('a slide: the class at once, the flag, the link followed after 0,5 s', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const { press, root, flag, assigned } = await openChambers({ settings: { anim: true } });
    const users = new FakeLink('/admin/users', 'left', true);
    assert.equal(press(users).defaultPrevented, true);
    assert.deepEqual([...root.classList.names].sort(), ['fx-on', 'go-left', 'keep-banner']);
    assert.deepEqual(flag('hof.arrive'), {
      fx: 'left',
      to: `${ORIGIN}/admin/users`,
      at: 1_000_000,
      keep: true,
    });
    t.mock.timers.tick(499);
    assert.deepEqual(assigned, []);
    t.mock.timers.tick(1);
    assert.deepEqual(assigned, [`${ORIGIN}/admin/users`]);
  });

  test('a second press while it slides: the browser follows that link at once', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { press, flag, assigned } = await openChambers({ settings: { anim: true } });
    press(new FakeLink('/account', 'left', true));
    const again = press(new FakeLink('/', 'right', true));
    assert.equal(again.defaultPrevented, false, 'not held');
    assert.equal(flag('hof.arrive')?.to, `${ORIGIN}/`);
    t.mock.timers.tick(1000);
    assert.deepEqual(assigned, [], 'the first link is not followed after it');

    // The same link pressed again goes at once as well.
    const { press: press2, assigned: assigned2 } = await openChambers({ settings: { anim: true } });
    const link = new FakeLink('/account', 'left', true);
    press2(link);
    assert.equal(press2(link).defaultPrevented, false);
    t.mock.timers.tick(1000);
    assert.deepEqual(assigned2, []);
  });

  test('presses of the browser’s own: no effect, no flag, nothing held', async () => {
    const cases: [string, Partial<Record<string, number | boolean>>, (link: FakeLink) => void][] = [
      ['⌘', { metaKey: true }, () => {}],
      ['Ctrl', { ctrlKey: true }, () => {}],
      ['Shift', { shiftKey: true }, () => {}],
      ['Alt', { altKey: true }, () => {}],
      ['the middle button', { button: 1 }, () => {}],
      ['target', {}, (link) => void (link.target = '_blank')],
      ['download', {}, (link) => void link.attributes.add('download')],
    ];
    for (const [name, keys, mark] of cases) {
      const { press, root, flag } = await openChambers({ settings: { anim: true, sound: true } });
      const link = new FakeLink('/admin/users', 'left', true);
      mark(link);
      assert.equal(press(link, keys).defaultPrevented, false, name);
      assert.deepEqual([...root.classList.names], ['fx-on'], name);
      assert.equal(flag('hof.arrive'), null, name);
    }
  });

  test('without «Анимации» nothing waits; with «Звуки» a page turned still rustles on the next page', async () => {
    const off = await openChambers();
    assert.equal(off.press(new FakeLink('/admin/users', 'left', true)).defaultPrevented, false);
    assert.equal(off.press(new FakeLink('/saeckel/history', 'flip-fwd')).defaultPrevented, false);
    assert.equal(off.flag('hof.arrive'), null);
    assert.deepEqual([...off.root.classList.names], []);

    const sound = await openChambers({ settings: { sound: true } });
    assert.equal(sound.press(new FakeLink('/admin/users', 'left', true)).defaultPrevented, false);
    assert.equal(sound.flag('hof.arrive'), null, 'a slide has no sound');
    assert.equal(sound.press(new FakeLink('/saeckel/history', 'flip-fwd')).defaultPrevented, false);
    assert.equal(sound.flag('hof.arrive')?.fx, 'flip-fwd');
    assert.deepEqual([...sound.root.classList.names], []);
  });

  test('put away while it slides (Back at once): the link is not followed, the flag is gone', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { press, hide, flag, assigned } = await openChambers({ settings: { anim: true } });
    press(new FakeLink('/admin/users', 'left', true));
    hide();
    assert.equal(flag('hof.arrive'), null);
    t.mock.timers.tick(1000);
    assert.deepEqual(assigned, []);

    // The page that goes by its own slide keeps the flag for the next page.
    const done = await openChambers({ settings: { anim: true } });
    done.press(new FakeLink('/admin/users', 'left', true));
    t.mock.timers.tick(500);
    done.hide();
    assert.equal(done.flag('hof.arrive')?.fx, 'left');
  });

  test('a page of the book turned: a slide the same way', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { press, root, flag, assigned } = await openChambers({ settings: { anim: true } });
    assert.equal(press(new FakeLink('/saeckel/', 'flip-back')).defaultPrevented, true);
    assert.ok(root.classList.contains('go-right'));
    assert.ok(!root.classList.contains('keep-banner'));
    assert.equal(flag('hof.arrive')?.fx, 'flip-back');
    t.mock.timers.tick(500);
    assert.deepEqual(assigned, [`${ORIGIN}/saeckel/`]);
  });

  test('flip-fwd-phone: turned on the phone, an ordinary link on a computer', async () => {
    const computer = await openChambers({ settings: { anim: true, sound: true } });
    const pouch = new FakeLink('/saeckel/pouches/3', 'flip-fwd-phone');
    assert.equal(computer.press(pouch).defaultPrevented, false);
    assert.equal(computer.flag('hof.arrive'), null);
    assert.deepEqual([...computer.root.classList.names], ['fx-on']);

    const phone = await openChambers({ settings: { anim: true }, phone: true });
    assert.equal(phone.press(pouch).defaultPrevented, true);
    assert.equal(phone.flag('hof.arrive')?.fx, 'flip-fwd');
    assert.ok(phone.root.classList.contains('go-left'));
  });

  test('«Назад» and «Следующие 50»: only the flag of the sound, never held', async () => {
    const { press, root, flag } = await openChambers({ settings: { anim: true, sound: true } });
    assert.equal(press(new FakeLink('/saeckel/history?page=2', 'page')).defaultPrevented, false);
    assert.deepEqual(flag('hof.arrive'), {
      fx: 'page',
      to: `${ORIGIN}/saeckel/history?page=2`,
      at: flag('hof.arrive')?.at,
      keep: false,
    });
    assert.deepEqual([...root.classList.names], ['fx-on']);
  });

  test('a link without data-fx, or with an unknown one, is ordinary', async () => {
    const { press, flag } = await openChambers({ settings: { anim: true, sound: true } });
    assert.equal(press(new FakeLink('/saeckel/pouches/new')).defaultPrevented, false);
    assert.equal(press(new FakeLink('/x', 'spin')).defaultPrevented, false);
    assert.equal(flag('hof.arrive'), null);
  });
});

describe('fx.js in a page: a form', () => {
  test('«Покинуть двор» goes at once: the flag of its act, the door opens, then creaks', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 2_000_000 });
    const { send, flag } = await openChambers({ settings: { anim: true, sound: true } });
    const logout = new FakeForm('/logout', 'logout');
    assert.equal(send(logout).defaultPrevented, false, 'never held');
    assert.deepEqual(flag('hof.after'), { act: 'logout', action: '/logout', at: 2_000_000 });
    assert.ok(logout.frames.classList.contains('open'));
    // The creak is not made while the form is being sent: after it, in the next task.
    assert.equal(sounds('door').length, 0);
    t.mock.timers.tick(0);
    assert.equal(sounds('door').length, 1);

    // Sent again in the same page: held by the guard, the flag stays the first one's.
    assert.equal(send(logout).defaultPrevented, true);
    t.mock.timers.tick(0);
    assert.equal(sounds('door').length, 1);

    // Any other form takes the flag away.
    assert.equal(send(new FakeForm('/account/password')).defaultPrevented, false);
    assert.equal(flag('hof.after'), null);
  });

  test('without «Анимации» the door stays closed; with «Звуки» it creaks; with neither no flag', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sound = await openChambers({ settings: { sound: true } });
    const logout = new FakeForm('/logout', 'logout');
    sound.send(logout);
    t.mock.timers.tick(0);
    assert.ok(!logout.frames.classList.contains('open'));
    assert.equal(sounds('door').length, 1);

    const none = await openChambers();
    const quiet = new FakeForm('/logout', 'logout');
    assert.equal(none.send(quiet).defaultPrevented, false);
    t.mock.timers.tick(0);
    assert.equal(none.flag('hof.after'), null);
    assert.ok(!quiet.frames.classList.contains('open'));
    assert.equal(sounds('door').length, 0);
  });

  test('a form sent while the page slides away: the link is not followed after it', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { press, send, assigned } = await openChambers({ settings: { anim: true } });
    press(new FakeLink('/account', 'left', true));
    assert.equal(send(new FakeForm('/logout', 'logout')).defaultPrevented, false);
    t.mock.timers.tick(1000);
    assert.deepEqual(assigned, []);
  });
});

describe('fx.js in a page: back from the back/forward cache and the arrival', () => {
  test('as before it left: light, the door closed, the slide not followed; a form goes again', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { press, send, root, assigned, backFromCache } = await openChambers({
      settings: { anim: true },
    });
    const logout = new FakeForm('/logout', 'logout');
    send(logout);
    press(new FakeLink('/admin/users', 'left', true));
    backFromCache();
    assert.deepEqual([...root.classList.names], ['fx-on']);
    assert.ok(!logout.frames.classList.contains('open'));
    t.mock.timers.tick(1000);
    assert.deepEqual(assigned, []);
    assert.equal(send(logout).defaultPrevented, false, 'the guard is reset');
  });

  test('a page turned or rustled: the sound of a page once; data-arrived is taken', async () => {
    for (const arrived of ['flip-fwd', 'flip-back', 'page']) {
      const { root } = await openChambers({ settings: { sound: true }, arrived });
      assert.equal(sounds('page').length, 1, arrived);
      assert.equal(root.dataset.arrived, undefined, arrived);
    }
    for (const arrived of ['left', 'right', 'logout']) {
      await openChambers({ settings: { sound: true }, arrived });
      assert.equal(sounds('page').length, 0, arrived);
    }
    await openChambers({ arrived: 'flip-fwd' });
    assert.equal(sounds('page').length, 0, 'without «Звуки»');
  });
});

describe('fx.js in a page: the living courtyard (M10.3)', () => {
  const doorLink = (place = 'treasury', href = '/saeckel/') => {
    const link = new FakeLink(href, 'door');
    link.dataset.door = place;
    return link;
  };

  test('a door: open at once with its creak, the zoom into its middle, the page at 1,7 s', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const court = courtyard();
    const { press, root, flag, assigned } = await openChambers({
      settings: { anim: true, sound: true },
      court,
    });
    assert.equal(press(doorLink()).defaultPrevented, true);
    assert.ok(root.classList.contains('go-door'));
    assert.deepEqual(
      court.doors.map((door) => door.classList.contains('open')),
      [true, false],
      'the door drawn, not the one of the phone',
    );
    // The middle of the door in per cent of the map: 615 and 501,5 px of 1536×1024.
    const [x, y] = court.inner.style.transformOrigin.split(' ').map((v) => parseFloat(v));
    assert.ok(Math.abs(x! - (615 / 1536) * 100) < 0.01, String(x));
    assert.ok(Math.abs(y! - (501.5 / 1024) * 100) < 0.01, String(y));
    assert.equal(flag('hof.arrive')?.fx, 'door');
    t.mock.timers.tick(0);
    assert.equal(sounds('door').length, 1, 'the creak in the frame of the press');
    t.mock.timers.tick(1699);
    assert.deepEqual(assigned, []);
    t.mock.timers.tick(1);
    assert.deepEqual(assigned, [`${ORIGIN}/saeckel/`]);
  });

  test('a door not seen: into the dark at once, 0,5 s, the door stays closed', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // Below the part of the map that is drawn (as on a phone held across).
    const court = courtyard({ left: 722, top: 640, right: 776, bottom: 750 });
    const { press, root, assigned } = await openChambers({ settings: { anim: true }, court });
    assert.equal(press(doorLink()).defaultPrevented, true);
    assert.ok(root.classList.contains('go-dark'));
    assert.ok(!root.classList.contains('go-door'));
    assert.ok(court.doors.every((door) => !door.classList.contains('open')));
    assert.equal(court.inner.style.transformOrigin, '');
    t.mock.timers.tick(499);
    assert.deepEqual(assigned, []);
    t.mock.timers.tick(1);
    assert.deepEqual(assigned, [`${ORIGIN}/saeckel/`]);
  });

  test('a second press on the door: the browser follows the link at once', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { press, assigned } = await openChambers({
      settings: { anim: true },
      court: courtyard(),
    });
    const link = doorLink();
    press(link);
    t.mock.timers.tick(300);
    assert.equal(press(link).defaultPrevented, false);
    t.mock.timers.tick(2000);
    assert.deepEqual(assigned, [], 'nothing follows the link after the browser');
  });

  test('without «Анимации» the door goes at once; with «Звуки» it creaks on the next page', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const reduced of [false, true]) {
      const court = courtyard();
      const page = await openChambers({
        settings: { anim: reduced, sound: true },
        court,
        reduced,
      });
      assert.equal(page.press(doorLink()).defaultPrevented, false, `reduced ${reduced}`);
      assert.deepEqual([...page.root.classList.names], [], `reduced ${reduced}`);
      assert.ok(court.doors.every((door) => !door.classList.contains('open')));
      assert.equal(page.flag('hof.arrive')?.fx, 'door');
      t.mock.timers.tick(0);
      assert.equal(sounds('door').length, 0, 'not here');
    }
    await openChambers({ settings: { sound: true }, arrived: 'door' });
    assert.equal(sounds('door').length, 1, 'on the next page');
    await openChambers({ settings: { anim: true, sound: true }, arrived: 'door' });
    assert.equal(sounds('door').length, 0, 'with «Анимации» it creaked at the press');
    const none = await openChambers({ court: courtyard() });
    assert.equal(none.press(doorLink()).defaultPrevented, false);
    assert.equal(none.flag('hof.arrive'), null);
  });

  test('back from the back/forward cache: the door closed, no zoom point, nothing followed', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const court = courtyard();
    const { press, root, assigned, backFromCache } = await openChambers({
      settings: { anim: true },
      court,
    });
    press(doorLink());
    backFromCache();
    assert.deepEqual([...root.classList.names], ['fx-on']);
    assert.ok(court.doors.every((door) => !door.classList.contains('open')));
    assert.equal(court.inner.style.transformOrigin, '');
    t.mock.timers.tick(5000);
    assert.deepEqual(assigned, []);
  });

  test('the wind and the birds: one chain each, only while the tab is seen', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    // The shortest waits: the first flock at 4 s, a gust at 14 s, the next flock 20 s later.
    t.mock.method(Math, 'random', () => 0);
    const court = courtyard();
    const { loaded, seen } = await openChambers({ settings: { anim: true, sound: true }, court });
    assert.ok(
      court.leaves.every((leaf) => !leaf.classList.contains('wake')),
      'not before load',
    );
    loaded();
    await settle();
    assert.ok(court.leaves.every((leaf) => leaf.classList.contains('wake')));
    t.mock.timers.tick(3999);
    assert.ok(!court.flock.classList.contains('fly'));
    t.mock.timers.tick(1);
    assert.ok(court.flock.classList.contains('fly'));
    court.flock.classList.remove('fly');
    t.mock.timers.tick(10_000);
    assert.equal(sounds('wind').length, 1);
    assert.equal(court.leaves.filter((leaf) => leaf.classList.contains('gust')).length, 1);

    seen(false);
    t.mock.timers.tick(600_000);
    assert.equal(sounds('wind').length, 1, 'nothing while hidden');
    assert.ok(!court.flock.classList.contains('fly'));
    seen(true);
    t.mock.timers.tick(10_000);
    assert.ok(court.flock.classList.contains('fly'), 'the flock 20 s after the last one');
    t.mock.timers.tick(4_000);
    assert.equal(sounds('wind').length, 2, 'the gust 14 s after the last one');
  });

  test('without «Анимации» or with less motion: no frames, no birds; the wind still sounds with «Звуки»', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(Math, 'random', () => 0);
    for (const reduced of [false, true]) {
      const court = courtyard();
      const { loaded, root, hide } = await openChambers({
        settings: { anim: reduced, sound: true },
        court,
        reduced,
      });
      loaded();
      await settle();
      t.mock.timers.tick(14_000);
      hide();
      assert.ok(!root.classList.contains('fx-on'));
      assert.ok(
        court.leaves.every((leaf) => leaf.classList.names.size === 3),
        'not woken',
      );
      assert.ok(!court.flock.classList.contains('fly'));
      assert.equal(sounds('wind').length, 1, `reduced ${reduced}`);
    }
    const silent = await openChambers({ court: courtyard() });
    silent.loaded();
    t.mock.timers.tick(600_000);
    assert.equal(sounds('wind').length, 0);
  });

  test('the fountain: the next loop on each visit, 2 s to come up, after an action of the person', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const local = memory();
    const loops = [];
    for (let visit = 0; visit < 4; visit += 1) {
      await openChambers({ settings: { sound: true }, court: courtyard(), local });
      const [water] = sounds('fountain');
      assert.equal(water?.paused, false);
      assert.equal(water?.loop, true);
      assert.equal(wiresOf(water).gain.gain.value, 0.8);
      loops.push(water.src);
    }
    assert.deepEqual(
      loops,
      [1, 2, 3, 1].map((n) => `/static/sounds/fountain-${n}.m4a`),
    );

    // Before the person has acted on the page: nothing yet, then the next loop.
    const waiting = await openChambers({
      settings: { sound: true },
      court: courtyard(),
      local,
      active: false,
    });
    assert.equal(sounds('fountain').length, 0);
    waiting.act();
    await settle();
    assert.deepEqual(
      sounds('fountain').map((audio) => audio.src),
      ['/static/sounds/fountain-2.m4a'],
    );

    await openChambers({ court: courtyard() });
    assert.equal(sounds('fountain').length, 0, 'without «Звуки»');
    await openChambers({ settings: { sound: true } });
    assert.equal(sounds('fountain').length, 0, 'not on another page');
  });
});
