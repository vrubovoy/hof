// fx.js (ARCHITECTURE.md §6, §4.8): what the effects decide, without a page — the settings of the
// device, motion, variants of a sound, the place of the music, the guard against a form sent
// twice, what a press on a link does (M10.2), the fountain, the rare events of the courtyard and
// the way through a door (M10.3), what a press on decor pokes (M10.4, M10.5) — and that every
// sound it may ask for is in static and in the licence list. fx-head.js, a script of <head> without exports, runs here as it is against a page
// made of only what it reads: how a page arrives after a link or a form.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import {
  AFTER_KEY,
  ARRIVE_KEY,
  DARK_MS,
  DEFAULTS,
  DOOR_MS,
  FLOCK,
  FOUNTAIN_KEY,
  FOUNTAINS,
  GUST,
  LINK_FX,
  MONEY,
  MUSIC_KEY,
  PIECES,
  SESSION_EVERY,
  SETTINGS_KEY,
  SOUNDS,
  between,
  canMove,
  createChain,
  createGuard,
  createSessionWatch,
  doorWay,
  firstPiece,
  leaving,
  level,
  nextFountain,
  nextPiece,
  POKES,
  pickVariant,
  plainPress,
  poked,
  poseTime,
  readMusic,
  SNIFFS,
  readSettings,
  soundFiles,
  tryNextPiece,
  writeFlag,
  writeMusic,
  writeSettings,
} from './static/fx.js';

const STATIC = join(import.meta.dirname, 'static');

// A storage of the browser as fx.js uses it: one value per key, or one that refuses everything.
function memory(values: Record<string, string> = {}) {
  return {
    values,
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
  };
}
const refusing = {
  getItem: (): string | null => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('fx: settings of the device', () => {
  test('a new device: everything off, volumes 80 and 50', () => {
    assert.deepEqual(readSettings(memory()), {
      anim: false,
      sound: false,
      soundVol: 80,
      music: false,
      musicVol: 50,
    });
    assert.deepEqual(readSettings(null), DEFAULTS);
  });

  test('broken JSON, a storage that throws, a value of another shape: the defaults', () => {
    for (const stored of ['{', 'null', '[]', '"on"', '42', 'true']) {
      assert.deepEqual(readSettings(memory({ [SETTINGS_KEY]: stored })), DEFAULTS, stored);
    }
    assert.deepEqual(readSettings(refusing), DEFAULTS);
  });

  test('each field on its own: a wrong one is the default, the others stay', () => {
    const stored = JSON.stringify({
      anim: 'yes',
      sound: true,
      soundVol: 101,
      music: true,
      musicVol: 35,
      extra: 1,
    });
    assert.deepEqual(readSettings(memory({ [SETTINGS_KEY]: stored })), {
      anim: false,
      sound: true,
      soundVol: 80,
      music: true,
      musicVol: 35,
    });
    for (const volume of [-5, 12.5, '40', null]) {
      const read = readSettings(memory({ [SETTINGS_KEY]: JSON.stringify({ soundVol: volume }) }));
      assert.equal(read.soundVol, 80, String(volume));
    }
  });

  test('kept and read back; a storage that refuses does not throw', () => {
    const storage = memory();
    const settings = { ...DEFAULTS, anim: true, musicVol: 0 };
    writeSettings(storage, settings);
    assert.deepEqual(readSettings(storage), settings);
    assert.doesNotThrow(() => writeSettings(refusing, settings));
    assert.doesNotThrow(() => writeSettings(null, settings));
  });

  test('motion: only with «Анимации» on and no reduced motion', () => {
    assert.equal(canMove({ ...DEFAULTS, anim: true }, false), true);
    assert.equal(canMove({ ...DEFAULTS, anim: true }, true), false);
    assert.equal(canMove(DEFAULTS, false), false);
    assert.equal(canMove(DEFAULTS, true), false);
  });

  test('a volume is a gain from 0 to 1', () => {
    assert.equal(level(0), 0);
    assert.equal(level(50), 0.5);
    assert.equal(level(100), 1);
    assert.equal(level(-10), 0);
    assert.equal(level(150), 1);
  });
});

describe('fx: variants of a sound', () => {
  test('never the one played last, whatever the random number', () => {
    for (let last = 1; last <= 3; last += 1) {
      for (const random of [0, 0.34, 0.5, 0.67, 0.999]) {
        const variant = pickVariant(3, last, () => random);
        assert.notEqual(variant, last, `last ${last}, random ${random}`);
        assert.ok(variant >= 1 && variant <= 3);
      }
    }
  });

  test('every variant can come; one variant is always the one', () => {
    const seen = new Set(
      [0, 0.25, 0.5, 0.75, 0.999].map((r) => pickVariant(4, undefined, () => r)),
    );
    assert.deepEqual([...seen].sort(), [1, 2, 3, 4]);
    assert.equal(
      pickVariant(1, 1, () => 0.5),
      1,
    );
    // A last variant the set does not have does not narrow the choice.
    assert.equal(
      pickVariant(2, 7, () => 0.999),
      2,
    );
  });
});

describe('fx: the place of the music', () => {
  test('kept and read back', () => {
    const storage = memory();
    writeMusic(storage, { piece: 7, time: 83.25, at: 1_700_000_000_000 });
    assert.deepEqual(readMusic(storage), { piece: 7, time: 83.25, at: 1_700_000_000_000 });
  });

  test('nothing kept or something broken: null, and the visit starts a piece of its own', () => {
    const broken = [
      '{',
      'null',
      '[]',
      JSON.stringify({ piece: 0, time: 1, at: 1 }),
      JSON.stringify({ piece: PIECES + 1, time: 1, at: 1 }),
      JSON.stringify({ piece: 2.5, time: 1, at: 1 }),
      JSON.stringify({ piece: 2, time: -1, at: 1 }),
      JSON.stringify({ piece: 2, time: 'x', at: 1 }),
      JSON.stringify({ piece: 2, time: 1 }),
    ];
    for (const stored of broken) {
      assert.equal(readMusic(memory({ [MUSIC_KEY]: stored })), null, stored);
    }
    assert.equal(readMusic(memory()), null);
    assert.equal(readMusic(refusing), null);
    assert.doesNotThrow(() => writeMusic(refusing, { piece: 1, time: 0, at: 0 }));
    for (const random of [0, 0.5, 0.999]) {
      const piece = firstPiece(() => random);
      assert.ok(piece >= 1 && piece <= PIECES, String(piece));
    }
  });

  test('the next piece goes round the list', () => {
    assert.equal(nextPiece(1), 2);
    assert.equal(nextPiece(PIECES - 1), PIECES);
    assert.equal(nextPiece(PIECES), 1);
  });

  test('pieces that fail to load are skipped, at most once round the list', () => {
    assert.equal(tryNextPiece(1), true);
    assert.equal(tryNextPiece(PIECES - 1), true);
    assert.equal(tryNextPiece(PIECES), false);
  });
});

describe('fx: a form goes once (§4.8)', () => {
  test('the first sending goes, the next of the same form does not, another form does', () => {
    const guard = createGuard();
    const expense = { method: 'post' };
    const transfer = { method: 'post' };
    assert.equal(guard.allow(expense), true);
    assert.equal(guard.allow(expense), false);
    assert.equal(guard.allow(expense), false);
    assert.equal(guard.allow(transfer), true);
    assert.equal(guard.allow(transfer), false);
  });

  test('back from the back/forward cache: every form may go again, once', () => {
    const guard = createGuard();
    const form = { method: 'post' };
    guard.allow(form);
    guard.reset();
    assert.equal(guard.allow(form), true);
    assert.equal(guard.allow(form), false);
  });

  test('a GET form is never held', () => {
    const guard = createGuard();
    const filter = { method: 'get' };
    assert.equal(guard.allow(filter), true);
    assert.equal(guard.allow(filter), true);
  });
});

describe('fx: the sounds it may ask for', () => {
  const licence = readFileSync(join(STATIC, 'sounds', 'LICENSE.txt'), 'utf8');

  test('the door and the page: every variant in static, from the CC0 set of Kenney', () => {
    assert.equal(SOUNDS.door, 6);
    assert.equal(SOUNDS.page, 2);
    for (const [name, count] of [
      ['door', 6],
      ['page', 2],
    ] as const) {
      for (let variant = 1; variant <= count; variant += 1) {
        const file = `${name}-${variant}.m4a`;
        assert.ok(existsSync(join(STATIC, 'sounds', file)), file);
        const entry = licence.split(/\n(?=\S)/).find((part) => part.startsWith(`${file}\n`));
        assert.ok(entry?.includes('набор «RPG Audio», Kenney'), file);
        assert.ok(entry?.includes('License (Creative Commons Zero, CC0)'), file);
      }
    }
  });

  test('the wind and the fountain: every file in static, its record CC0 on freesound', () => {
    assert.equal(SOUNDS.wind, 6);
    assert.equal(FOUNTAINS, 3);
    const files = [
      ...Array.from({ length: 6 }, (_, i) => `wind-${i + 1}.m4a`),
      ...Array.from({ length: 3 }, (_, i) => `fountain-${i + 1}.m4a`),
    ];
    for (const file of files) {
      assert.ok(existsSync(join(STATIC, 'sounds', file)), file);
      const entry = licence.split(/\n(?=\S)/).find((part) => part.startsWith(`${file}\n`));
      assert.match(
        entry ?? '',
        /Страница: https:\/\/freesound\.org\/people\/[^/]+\/sounds\/\d+\/ — Creative Commons 0/,
        file,
      );
    }
  });

  test('every file fx.js may ask for is in static and in the licence list', () => {
    const files = soundFiles();
    const sets = Object.values(SOUNDS).reduce((sum, count) => sum + count, 0);
    assert.equal(files.length, sets + FOUNTAINS + PIECES);
    for (const address of files) {
      const name = address.replace('/static/sounds/', '');
      assert.ok(existsSync(join(STATIC, 'sounds', name)), address);
      assert.match(licence, new RegExp(`^${name.replaceAll('.', '\\.')}$`, 'm'), name);
    }
  });

  test('every file of sounds/ is named by fx.js and listed in the licence', () => {
    const named = new Set(soundFiles().map((address) => address.replace('/static/sounds/', '')));
    const files = readdirSync(join(STATIC, 'sounds'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(join(STATIC, 'sounds/').length));
    assert.ok(files.length > 0);
    for (const name of files) {
      if (name === 'LICENSE.txt') continue;
      assert.ok(named.has(name), `fx.js does not name ${name}`);
      assert.match(licence, new RegExp(`^${name.replaceAll('.', '\\.')}$`, 'm'), name);
    }
  });
});

describe('fx: a press on a link (M10.2)', () => {
  const press = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  const link = (target = '', download = false) => ({
    target,
    hasAttribute: (name: string) => name === 'download' && download,
  });

  test('only the main button without a key, in this window, not a download, is plain', () => {
    assert.equal(plainPress(press, link()), true);
    assert.equal(plainPress(press, link('_self')), true);
    for (const keys of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      { button: 2 },
    ]) {
      assert.equal(plainPress({ ...press, ...keys }, link()), false, JSON.stringify(keys));
    }
    assert.equal(plainPress(press, link('_blank')), false);
    assert.equal(plainPress(press, link('', true)), false);
  });

  test('what each data-fx does with «Анимации», «Звуки», on the phone', () => {
    const now = { move: true, sound: false, phone: false };
    const cases: [string | undefined, Partial<typeof now>, ReturnType<typeof leaving>][] = [
      ['left', {}, { fx: 'left', away: 'go-left' }],
      ['right', {}, { fx: 'right', away: 'go-right' }],
      // A page of the book turned slides the same way.
      ['flip-fwd', {}, { fx: 'flip-fwd', away: 'go-left' }],
      ['flip-back', {}, { fx: 'flip-back', away: 'go-right' }],
      ['flip-fwd-phone', {}, null],
      ['flip-fwd-phone', { phone: true }, { fx: 'flip-fwd', away: 'go-left' }],
      ['page', {}, { fx: 'page', away: null }],
      // Without «Анимации» nothing waits: a page turned or rustled still has its sound.
      ['left', { move: false, sound: true }, null],
      ['flip-fwd', { move: false, sound: true }, { fx: 'flip-fwd', away: null }],
      ['page', { move: false, sound: true }, { fx: 'page', away: null }],
      ['flip-back', { move: false }, null],
      ['page', { move: false }, null],
      [undefined, {}, null],
      ['logout', {}, null],
      // M10.3: through a door with «Анимации»; without them it creaks on the next page.
      ['door', {}, { fx: 'door', away: 'go-door' }],
      ['door', { phone: true }, { fx: 'door', away: 'go-door' }],
      ['door', { move: false, sound: true }, { fx: 'door', away: null }],
      ['door', { move: false }, null],
    ];
    for (const [fx, change, expected] of cases) {
      assert.deepEqual(
        leaving(fx, { ...now, ...change }),
        expected,
        `${fx} ${JSON.stringify(change)}`,
      );
    }
    assert.deepEqual(LINK_FX, [
      'left',
      'right',
      'flip-fwd',
      'flip-back',
      'flip-fwd-phone',
      'page',
      'door',
    ]);
  });

  test('a flag is left as JSON, taken away by null; a storage that refuses does not throw', () => {
    const storage = { ...memory(), removeItem: (key: string) => void delete storage.values[key] };
    writeFlag(storage, ARRIVE_KEY, { fx: 'left', to: 'https://hof.test/', at: 1 });
    assert.equal(storage.values[ARRIVE_KEY], '{"fx":"left","to":"https://hof.test/","at":1}');
    writeFlag(storage, ARRIVE_KEY, null);
    assert.equal(storage.values[ARRIVE_KEY], undefined);
    writeFlag({ ...refusing, removeItem: refusing.setItem }, AFTER_KEY, { act: 'logout' });
    writeFlag(null, AFTER_KEY, null);
  });
});

// fx-head.js as it is, run against a page made of only what it reads: the settings, the two flags,
// the entry of the navigation, the address and the document. It returns what the page then has.
const HEAD = readFileSync(join(STATIC, 'fx-head.js'), 'utf8');
const NOW = Date.now();

interface Visit {
  // The flags as fx.js of the last page left them (a string — as it is, not as JSON).
  arrive?: unknown;
  after?: unknown;
  // The address of this page, the type of its navigation and the redirects on the way.
  path?: string;
  type?: string;
  // null: the browser does not say.
  redirects?: number | null;
  // «Анимации», reduced motion, what the page shows.
  anim?: boolean;
  reduced?: boolean;
  marker?: boolean;
  // What the page shows, by selector (instead of `marker` showing everything), and whether the
  // banner is drawn (the phone has none).
  shows?: string[];
  drawn?: boolean;
  // The sessionStorage of the tab, shared by the visits of one test.
  session?: Map<string, string>;
  // M12.16: the big pictures of the page.
  scenes?: (FakeScene | FakeImage)[];
  // M12.7: the images of the unrolling the CSS names — the cloth and the roll ('' — none).
  cloth?: string;
  roll?: string;
}

// M12.7: an image fx-head.js asks for (new Image()): its address and its listeners; a test says
// when it comes (load) or fails (error).
class FakeLoad {
  src = '';
  listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: 'load' | 'error') {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}
// M12.7: what a focus comes into — inside the banner or not.
class FakeTarget {
  inBanner: boolean;
  constructor(inBanner: boolean) {
    this.inBanner = inBanner;
  }
  closest(selector: string) {
    return selector === '.banner' && this.inBanner ? this : null;
  }
}
const CLOTH = 'url("https://hof.test/static/img/menu-banner.webp?v=1")';
const ROLL = 'url("https://hof.test/static/img/banner-roll.webp?v=2")';

// M12.16: an image as fx-head.js sees it — whether it has come (complete) and the picture it
// belongs to: a scene around it, or itself (`self`). A scene and an image that is its own picture
// keep their classes.
class FakeImage {
  complete = false;
  naturalWidth = 0;
  names = new Set<string>();
  classList = {
    add: (name: string) => void this.names.add(name),
    contains: (name: string) => this.names.has(name),
  };
  picture: FakeScene | 'self' | null;
  constructor(picture: FakeScene | 'self' | null = null) {
    this.picture = picture;
  }
  closest(selector: string) {
    if (selector !== '[data-reveal]') return null;
    return this.picture === 'self' ? this : this.picture;
  }
}
class FakeScene {
  names = new Set<string>();
  classList = {
    add: (name: string) => void this.names.add(name),
    contains: (name: string) => this.names.has(name),
  };
  images: FakeImage[];
  // The first image is the picture; the others (a cat, a sign) are not.
  constructor(images = 1) {
    this.images = Array.from({ length: images }, () => new FakeImage(this));
  }
  querySelector(selector: string) {
    return selector === 'img' ? (this.images[0] ?? null) : null;
  }
}

function visit({
  arrive,
  after,
  path = '/login',
  type = 'navigate',
  redirects = 0,
  anim = true,
  reduced = false,
  marker = true,
  shows,
  drawn = true,
  session = new Map(),
  scenes = [],
  cloth = CLOTH,
  roll = ROLL,
}: Visit) {
  const raw = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));
  if (arrive !== undefined) session.set('hof.arrive', raw(arrive));
  if (after !== undefined) session.set('hof.after', raw(after));
  const classes = new Set<string>();
  const dataset: Record<string, string> = {};
  const listeners = new Map<string, ((event: object) => void)[]>();
  const listen = (type: string, listener: (event: object) => void) =>
    void listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  const frames: (() => void)[] = [];
  const timers: { go: () => void; ms: number; off: boolean }[] = [];
  const loads: FakeLoad[] = [];
  const url = new URL(path, 'https://hof.test');
  const shell = {};
  const page: Record<string, unknown> = {
    localStorage: { getItem: () => JSON.stringify({ anim }) },
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      removeItem: (key: string) => void session.delete(key),
    },
    matchMedia: () => ({ matches: reduced }),
    performance: { getEntriesByType: () => [{ type, redirectCount: redirects ?? undefined }] },
    location: { origin: url.origin, pathname: url.pathname, search: url.search },
    document: {
      documentElement: {
        dataset,
        classList: {
          add: (...names: string[]) => names.forEach((name) => classes.add(name)),
          remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
          contains: (name: string) => classes.has(name),
        },
      },
      addEventListener: listen,
      querySelector: (selector: string) =>
        (shows ? shows.includes(selector) : marker && selector !== '')
          ? { getClientRects: () => (drawn ? [{}] : []), parentElement: shell }
          : null,
      querySelectorAll: (selector: string) =>
        selector === '[data-reveal]:not(.shown)'
          ? scenes.filter((scene) => !scene.classList.contains('shown'))
          : [],
    },
    addEventListener: listen,
    requestAnimationFrame: (frame: () => void) => void frames.push(frame),
    setTimeout: (go: () => void, ms: number) => timers.push({ go, ms, off: false }) - 1,
    clearTimeout: (id: number) => {
      if (timers[id]) timers[id].off = true;
    },
    HTMLImageElement: FakeImage,
    Element: FakeTarget,
    Image: class extends FakeLoad {
      constructor() {
        super();
        loads.push(this);
      }
    },
    getComputedStyle: (element: object, pseudo?: string) =>
      element === shell && pseudo === '::after'
        ? { backgroundImage: roll || 'none' }
        : { borderImageSource: cloth || 'none' },
  };
  page.window = page;
  runInContext(HEAD, createContext(page));
  const fire = (type: string, event: object = {}) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    // The classes of the arrival; `reveal` (M12.16) is on every page and told by reveal().
    classes: () => [...classes].filter((name) => name !== 'reveal').sort(),
    reveal: () => classes.has('reveal'),
    arrived: () => dataset.arrived,
    session,
    fire,
    // The parser reaches the end of the page; or the first frame is drawn before it.
    parsed: () => fire('readystatechange'),
    frame: () => frames.splice(0).forEach((frame) => frame()),
    // How many frames are asked for now.
    asked: () => frames.length,
    // The timers set and not cleared, as their lengths; then all of them run.
    timers: () => timers.filter(({ off }) => !off).map(({ ms }) => ms),
    tick: () =>
      timers
        .filter(({ off }) => !off)
        .forEach((timer) => {
          timer.off = true;
          timer.go();
        }),
    // M12.7: the images asked for, by address; each comes or fails.
    asks: () => loads.map(({ src }) => src),
    load: (type: 'load' | 'error' = 'load', which?: number) =>
      loads.forEach((image, i) => (which === undefined || which === i ? image.fire(type) : null)),
    focus: (inBanner: boolean) => fire('focusin', { target: new FakeTarget(inBanner) }),
  };
}

describe('fx: the living courtyard (M10.3)', () => {
  test('the fountain: the loops go round from 1, a visit after another', () => {
    const storage = memory();
    const loops = Array.from({ length: 7 }, () => nextFountain(storage));
    assert.deepEqual(loops, [1, 2, 3, 1, 2, 3, 1]);
    assert.equal(storage.values[FOUNTAIN_KEY], '1');
  });

  test('the fountain: nothing kept, something broken or no storage — the first', () => {
    for (const kept of ['oops', '-1', '1.5', '"2"', 'null', '{}']) {
      const storage = memory();
      storage.values[FOUNTAIN_KEY] = kept;
      assert.equal(nextFountain(storage), 1, kept);
      assert.equal(nextFountain(storage), 2, kept);
    }
    const counted = memory();
    counted.values[FOUNTAIN_KEY] = '7';
    assert.equal(nextFountain(counted), 2, 'a count from before goes on round');
    assert.equal(nextFountain(null), 1);
    assert.equal(nextFountain(refusing), 1);
  });

  test('a gust every 14–40 s, a flock first in 4–10 s, then every 20–70 s', () => {
    assert.deepEqual(GUST, { first: [14_000, 40_000], every: [14_000, 40_000] });
    assert.deepEqual(FLOCK, { first: [4_000, 10_000], every: [20_000, 70_000] });
    for (const bounds of [GUST.first, GUST.every, FLOCK.first, FLOCK.every]) {
      for (const random of [0, 0.25, 0.5, 0.999_999]) {
        const ms = between(bounds, () => random);
        assert.ok(ms >= bounds[0] && ms < bounds[1], `${bounds.join('–')} ${random} → ${ms}`);
      }
    }
  });

  // A clock of the test: the timers pending, the time now.
  function testClock() {
    let now = 0;
    let next = 1;
    const timers = new Map<number, { at: number; go: () => void }>();
    return {
      timers,
      set: (go: () => void, ms: number) => {
        timers.set(next, { at: now + ms, go });
        return next++;
      },
      clear: (timer: unknown) => void timers.delete(timer as number),
      now: () => now,
      // Time goes on by `ms`; due timers fire in their order.
      run(ms: number) {
        const end = now + ms;
        for (;;) {
          const [id, due] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
          if (due === undefined || due.at > end) break;
          timers.delete(id!);
          now = due.at;
          due.go();
        }
        now = end;
      },
    };
  }

  test('a chain: the first after `first`, then every `every`, never more than one timer', () => {
    const clock = testClock();
    const fired: number[] = [];
    let random = 0.5;
    const chain = createChain(
      () => fired.push(clock.now()),
      FLOCK,
      clock,
      () => random,
    );
    assert.equal(clock.timers.size, 0, 'nothing before it is resumed');
    chain.resume();
    chain.resume();
    assert.equal(clock.timers.size, 1);
    clock.run(6_999);
    assert.deepEqual(fired, []);
    clock.run(1);
    assert.deepEqual(fired, [7_000]);
    random = 0;
    clock.run(45_000 + 20_000);
    assert.deepEqual(fired, [7_000, 52_000, 72_000]);
    assert.equal(clock.timers.size, 1);
  });

  test('a chain paused keeps the time left; hidden for long, nothing fires and nothing piles up', () => {
    const clock = testClock();
    const fired: number[] = [];
    const chain = createChain(
      () => fired.push(clock.now()),
      GUST,
      clock,
      () => 0,
    );
    chain.resume();
    clock.run(10_000);
    chain.pause();
    chain.pause();
    assert.equal(clock.timers.size, 0);
    clock.run(3_600_000);
    assert.deepEqual(fired, []);
    for (let i = 0; i < 50; i += 1) {
      chain.resume();
      chain.pause();
    }
    assert.equal(clock.timers.size, 0);
    chain.resume();
    assert.equal(clock.timers.size, 1);
    clock.run(3_999);
    assert.deepEqual(fired, []);
    clock.run(1);
    assert.deepEqual(fired, [3_610_000 + 4_000]);
  });

  test('through a door in 1,7 s while its middle is seen; into the dark in 0,5 s otherwise', () => {
    assert.equal(DOOR_MS, 1700);
    assert.equal(DARK_MS, 500);
    const view = { width: 1440, height: 900 };
    const map = { left: 288, top: 0, right: 1440, bottom: 610 };
    const door = { left: 722, top: 288, right: 776, bottom: 397 };
    const through = { away: 'go-door', ms: 1700 };
    const dark = { away: 'go-dark', ms: 500 };
    assert.deepEqual(doorWay(door, map, view), through);
    // The map scrolled half away: the middle of the door is still in the window.
    const up = (box: typeof door, by: number) => ({
      ...box,
      top: box.top - by,
      bottom: box.bottom - by,
    });
    assert.deepEqual(doorWay(up(door, 300), up(map, 300), view), through);
    // Scrolled further: the middle above the window.
    assert.deepEqual(doorWay(up(door, 360), up(map, 360), view), dark);
    // The phone held across: the door lies below the part of the map drawn (60 % of 390 px).
    const phone = { width: 844, height: 390 };
    assert.deepEqual(
      doorWay(
        { left: 733, top: 252, right: 779, bottom: 377 },
        { left: 0, top: 60, right: 844, bottom: 294 },
        phone,
      ),
      dark,
    );
    // Not drawn, or no door at all.
    assert.deepEqual(doorWay({ left: 0, top: 0, right: 0, bottom: 0 }, map, view), dark);
    assert.deepEqual(doorWay(null, map, view), dark);
    assert.deepEqual(doorWay(door, null, view), dark);
  });
});

describe('fx: decor and the cats (M10.4)', () => {
  // An element as poked() reads it: what closest() finds for a selector, from the element out.
  const element = (chain: { matches: string; poke?: string }[]) => ({
    closest(selector: string) {
      const found = chain.find((link) =>
        selector.split(', ').some((one) => link.matches.split(' ').includes(one)),
      );
      return found ? { dataset: found.poke === undefined ? {} : { poke: found.poke } } : null;
    },
  });

  test('a press on the cat itself pokes it; on a control inside, or an unknown thing, nothing', () => {
    assert.deepEqual(POKES, { meow: 'meow', purr: 'purr', chest: 'chest', sniff: 'sniff' });
    const cat = [{ matches: '[data-poke]', poke: 'meow' }];
    assert.notEqual(poked(element(cat)), null);
    for (const control of [
      'a[href]',
      'button',
      'input',
      'select',
      'textarea',
      'label',
      '[tabindex]',
    ]) {
      const inside = [{ matches: control }, ...cat];
      assert.equal(poked(element(inside)), null, control);
    }
    assert.equal(poked(element([{ matches: '[data-poke]', poke: 'dragon' }])), null);
    assert.equal(poked(element([{ matches: 'p' }])), null);
  });

  test('the pose lasts as long as the sound, at least 0,9 s; 1,2 s without one', () => {
    assert.equal(poseTime(1.632), 1.632);
    assert.equal(poseTime(3.296), 3.296);
    assert.equal(poseTime(0.47), 0.9);
    for (const none of [null, Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      assert.equal(poseTime(none), 1.2, String(none));
    }
  });

  test('meow, purr and the banner: every file in static, from freesound or Kenney, CC0', () => {
    const licence = readFileSync(join(STATIC, 'sounds', 'LICENSE.txt'), 'utf8');
    assert.equal(SOUNDS.meow, 9);
    assert.equal(SOUNDS.purr, 1);
    assert.equal(SOUNDS.banner, 4);
    for (const [name, count, source] of [
      ['meow', 9, /freesound\.org\/people\/[^/]+\/sounds\/\d+\/ — Creative Commons 0/],
      ['purr', 1, /freesound\.org\/people\/[^/]+\/sounds\/\d+\/ — Creative Commons 0/],
      ['banner', 4, /License \(Creative Commons Zero, CC0\)/],
    ] as const) {
      for (let variant = 1; variant <= count; variant += 1) {
        const file = `${name}-${variant}.m4a`;
        assert.ok(existsSync(join(STATIC, 'sounds', file)), file);
        const entry = licence.split(/\n(?=\S)/).find((part) => part.startsWith(`${file}\n`));
        assert.match(entry ?? '', source, file);
      }
    }
  });
});

describe('fx: Säckel (M10.5)', () => {
  // The frame of the treasury as poked() reads it, from the element pressed out: the chest is
  // the thing; «Разложить» and «+ Доход» are links beside it, in the frame but not in the chest.
  const element = (chain: { matches: string; poke?: string }[]) => ({
    closest(selector: string) {
      const found = chain.find((link) =>
        selector.split(', ').some((one) => link.matches.split(' ').includes(one)),
      );
      return found ? { dataset: found.poke === undefined ? {} : { poke: found.poke } } : null;
    },
  });
  const frame = { matches: 'div' };

  test('the chest and the cat at the empty pouches are pokes; a link in the frame of the treasury is not', () => {
    const chest = { matches: '[data-poke]', poke: 'chest' };
    assert.notEqual(poked(element([{ matches: 'img' }, chest, frame])), null);
    assert.equal(poked(element([{ matches: 'a[href]' }, frame])), null, '«Разложить», «+ Доход»');
    assert.equal(poked(element([{ matches: 'p' }, frame])), null, 'the sum');
    assert.notEqual(poked(element([{ matches: '[data-poke]', poke: 'sniff' }])), null);
    assert.deepEqual(SNIFFS, [0, 1500]);
    assert.deepEqual(MONEY, ['expense', 'income', 'assign', 'transfer']);
  });

  test('the chest and the sniffs: every file in static, from Kenney or freesound, CC0', () => {
    const licence = readFileSync(join(STATIC, 'sounds', 'LICENSE.txt'), 'utf8');
    assert.equal(SOUNDS.chest, 3);
    assert.equal(SOUNDS.sniff, 3);
    for (const [name, source] of [
      ['chest', /набор «RPG Audio», Kenney[^]*License \(Creative Commons Zero, CC0\)/],
      ['sniff', /freesound\.org\/people\/[^/]+\/sounds\/\d+\/ — Creative Commons 0/],
    ] as const) {
      for (let variant = 1; variant <= 3; variant += 1) {
        const file = `${name}-${variant}.m4a`;
        assert.ok(existsSync(join(STATIC, 'sounds', file)), file);
        const entry = licence.split(/\n(?=\S)/).find((part) => part.startsWith(`${file}\n`));
        assert.match(entry ?? '', source, file);
      }
    }
  });
});

describe('fx: the session of an open page (M11.6)', () => {
  // A clock of the test with the timers pending, and a server whose answers the test gives one by
  // one: a status, or `null` for no answer at all.
  function setup() {
    let now = 0;
    let next = 1;
    const timers = new Map<number, { at: number; go: () => void }>();
    const clock = {
      set: (go: () => void, ms: number) => {
        timers.set(next, { at: now + ms, go });
        return next++;
      },
      clear: (timer: unknown) => void timers.delete(timer as number),
    };
    const asked: number[] = [];
    const answers: (number | null)[] = [];
    let left = 0;
    const watch = createSessionWatch(
      () => {
        asked.push(now);
        // 204 only once the answers run out: a `null` given by the test is no answer at all.
        const answer = answers.length === 0 ? 204 : (answers.shift() as number | null);
        return answer === null
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve(answer);
      },
      () => left++,
      clock,
    );
    return {
      watch,
      timers,
      asked,
      answers,
      left: () => left,
      // Time goes on by `ms`; due timers fire in their order, and each question gets its answer.
      run: async (ms: number) => {
        const end = now + ms;
        for (;;) {
          const [id, due] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
          if (due === undefined || due.at > end) break;
          timers.delete(id!);
          now = due.at;
          due.go();
          await settle();
        }
        now = end;
      },
    };
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  test('a page just come: the first question in a minute, then every minute', async () => {
    const { watch, timers, asked, run } = setup();
    assert.equal(SESSION_EVERY, 60_000);
    watch.seen(false);
    await settle();
    assert.deepEqual(asked, []);
    await run(3 * 60_000);
    assert.deepEqual(asked, [60_000, 120_000, 180_000]);
    assert.equal(timers.size, 1, 'never more than one timer');
  });

  test('a hidden tab asks nothing; back to it: one question at once, then every minute', async () => {
    const { watch, timers, asked, run } = setup();
    watch.seen(false);
    await run(30_000);
    watch.hidden();
    assert.equal(timers.size, 0);
    await run(10 * 60_000);
    assert.deepEqual(asked, []);
    watch.seen(true);
    await settle();
    await run(60_000);
    assert.deepEqual(asked, [630_000, 690_000]);
  });

  test('back from the back/forward cache, the tab seen twice at once: one question', async () => {
    const { watch, timers, asked } = setup();
    watch.seen(true);
    watch.seen(true);
    await settle();
    assert.deepEqual(asked, [0]);
    assert.equal(timers.size, 1);
  });

  test('only an exact 401 leaves, and once', async () => {
    const { watch, timers, asked, answers, left, run } = setup();
    answers.push(500, 502, 503, 0, 403, 303, null);
    watch.seen(false);
    await run(7 * 60_000);
    assert.equal(asked.length, 7);
    assert.equal(left(), 0, 'no answer, 5xx and the rest leave the page where it is');
    answers.push(401, 401);
    await run(60_000);
    assert.equal(left(), 1);
    assert.equal(timers.size, 0);
    watch.seen(true);
    await run(10 * 60_000);
    assert.equal(asked.length, 8, 'nothing more is asked');
    assert.equal(left(), 1);
  });

  test('no answer at all: the page stays, and a 401 after it still leaves once', async () => {
    const { watch, timers, asked, answers, left, run } = setup();
    answers.push(null, null, 401, 401);
    watch.seen(false);
    await run(2 * 60_000);
    assert.equal(asked.length, 2);
    assert.equal(left(), 0);
    assert.equal(timers.size, 1, 'still asking');
    await run(2 * 60_000);
    assert.equal(asked.length, 3);
    assert.equal(left(), 1);
    assert.equal(timers.size, 0);
  });
});

describe('fx-head.js: the page after a form (hof.after)', () => {
  const LOGOUT = { act: 'logout', action: '/logout', at: NOW - 1000 };
  // POST /logout → 303 → /login, a fresh flag, the form of the sign-in on the page.
  const RIGHT = { after: LOGOUT, path: '/login', redirects: 1 };

  // M12.15: out through the gate, the sign-in comes out of the dark (it slid in from the left).
  test('the right case: /login comes out of the dark, the flag is gone', () => {
    const page = visit(RIGHT);
    assert.deepEqual(page.classes(), ['from-door', 'fx-on']);
    assert.equal(page.arrived(), 'logout');
    assert.equal(page.session.size, 0);
    page.parsed();
    assert.deepEqual(page.classes(), ['from-door', 'fx-on']);
    // The way out of the dark ends with its veil: the classes of the arrival go.
    page.fire('animationend', { animationName: 'out-left' });
    assert.deepEqual(page.classes(), ['from-door', 'fx-on']);
    page.fire('animationend', { animationName: 'veil-out' });
    assert.deepEqual(page.classes(), ['fx-on']);
  });

  test('no effect in each other case, and the flag is gone all the same', () => {
    const cases: [string, Visit][] = [
      ['no flag', { ...RIGHT, after: undefined }],
      ['broken JSON', { ...RIGHT, after: '{"act":"logout",' }],
      ['not an object', { ...RIGHT, after: 7 }],
      ['older than 30 s', { ...RIGHT, after: { ...LOGOUT, at: NOW - 31_000 } }],
      ['from the future', { ...RIGHT, after: { ...LOGOUT, at: NOW + 60_000 } }],
      ['no time', { ...RIGHT, after: { act: 'logout', action: '/logout' } }],
      ['another act', { ...RIGHT, after: { ...LOGOUT, act: 'assign' } }],
      ['an act of another form', { ...RIGHT, after: { ...LOGOUT, action: '/account/password' } }],
      ['the address of the form: its 403, 500', { ...RIGHT, path: '/logout' }],
      ['an address the act does not lead to', { ...RIGHT, path: '/account' }],
      ['the courtyard', { ...RIGHT, path: '/' }],
      ['a reload', { ...RIGHT, type: 'reload' }],
      ['Back or Forward', { ...RIGHT, type: 'back_forward' }],
      ['no redirect: /login opened by itself', { ...RIGHT, redirects: 0 }],
      ['the browser does not say', { ...RIGHT, redirects: null }],
    ];
    for (const [name, change] of cases) {
      const page = visit(change);
      page.parsed();
      assert.deepEqual(page.classes(), ['fx-on'], name);
      assert.equal(page.arrived(), undefined, name);
      assert.equal(page.session.size, 0, name);
    }
  });

  test('what the act shows is not on the page: no effect, also when the first frame comes first', () => {
    const parsed = visit({ ...RIGHT, marker: false });
    parsed.parsed();
    assert.deepEqual(parsed.classes(), ['fx-on']);
    assert.equal(parsed.arrived(), undefined);

    const drawn = visit({ ...RIGHT, marker: false });
    drawn.frame();
    assert.deepEqual(drawn.classes(), ['fx-on']);
    drawn.parsed();
    assert.deepEqual(drawn.classes(), ['fx-on']);
  });

  test('read once: the next page has no effect; a flag the next form took away neither', () => {
    const session = new Map<string, string>();
    assert.deepEqual(visit({ ...RIGHT, session }).classes(), ['from-door', 'fx-on']);
    assert.deepEqual(visit({ path: '/login', redirects: 1, session }).classes(), ['fx-on']);

    // «Покинуть двор» sent, then another form: that one overwrote or took the flag away.
    const storage = {
      setItem: (key: string, value: string) => void session.set(key, value),
      removeItem: (key: string) => void session.delete(key),
    };
    writeFlag(storage, AFTER_KEY, LOGOUT);
    writeFlag(storage, AFTER_KEY, null);
    assert.deepEqual(visit({ path: '/login', redirects: 1, session }).classes(), ['fx-on']);
    writeFlag(storage, AFTER_KEY, LOGOUT);
    writeFlag(storage, AFTER_KEY, { act: 'transfer', action: '/saeckel/transfer', at: NOW });
    assert.deepEqual(visit({ path: '/login', redirects: 1, session }).classes(), ['fx-on']);
  });

  test('without «Анимации» or with reduced motion: no classes, the arrival is still told', () => {
    for (const change of [{ anim: false }, { reduced: true }]) {
      const page = visit({ ...RIGHT, ...change });
      assert.deepEqual(page.classes(), [], JSON.stringify(change));
      assert.equal(page.arrived(), 'logout');
    }
  });
});

describe('fx-head.js: the sign-in, the founding and the key (M10.4)', () => {
  const LOGIN = { act: 'login', action: '/login', at: NOW - 1000 };
  const SETUP = { act: 'setup', action: '/setup', at: NOW - 1000 };
  const KEY = { act: 'key', action: '/admin/users/7/disable', at: NOW - 1000 };
  const RETURN = (id: number) => `form[action="/admin/users/${id}/enable"]`;
  const IN = { redirects: 1, shows: ['.banner'] };
  const SIGNED_IN = { ...IN, after: LOGIN, path: '/' };
  const FOUNDED = { ...IN, after: SETUP, path: '/' };
  const KEY_TAKEN = { after: KEY, path: '/admin/users/7', redirects: 1, shows: [RETURN(7)] };

  test('signed in or founded: out of the dark, the banner unrolls; the classes go with their animations', () => {
    for (const [name, right] of [
      ['the sign-in', SIGNED_IN],
      ['the sign-in, next of the shell', { ...SIGNED_IN, path: '/admin/users/7?done=password' }],
      ['the founding', FOUNDED],
    ] as const) {
      const page = visit(right);
      page.parsed();
      // M12.7: the banner waits for its cloth and the roll, then unrolls.
      assert.deepEqual(page.classes(), ['from-door', 'fx-on', 'unroll', 'unroll-wait'], name);
      page.load();
      assert.deepEqual(page.classes(), ['from-door', 'fx-on', 'unroll'], name);
      assert.equal(page.arrived(), right.after.act, name);
      page.fire('animationend', { animationName: 'veil-out' });
      assert.deepEqual(page.classes(), ['fx-on', 'unroll'], `${name}: the banner still unrolls`);
      page.fire('animationend', { animationName: 'fx-unroll' });
      page.fire('animationend', { animationName: 'fx-settle' });
      assert.deepEqual(page.classes(), ['fx-on'], name);
    }
    // The phone has no banner drawn: everything goes with the veil.
    const phone = visit({ ...SIGNED_IN, drawn: false });
    phone.parsed();
    assert.deepEqual(phone.asks(), [], 'the phone asks for no image');
    assert.deepEqual(phone.classes(), ['from-door', 'fx-on', 'unroll']);
    phone.fire('animationend', { animationName: 'veil-out' });
    assert.deepEqual(phone.classes(), ['fx-on']);
  });

  test('«Забрать ключ»: the key fades on the card of the same person', () => {
    const page = visit(KEY_TAKEN);
    page.parsed();
    assert.deepEqual(page.classes(), ['fx-on', 'key-off']);
    assert.equal(page.arrived(), 'key');
    page.fire('animationend', { animationName: 'key-off' });
    assert.deepEqual(page.classes(), ['fx-on']);
  });

  test('no effect in each other case, and the flag is gone all the same', () => {
    const cases: [string, Visit][] = [
      // the sign-in
      ['a wrong password: 400 on /login', { ...SIGNED_IN, path: '/login', redirects: 0 }],
      ['the address of the form after a redirect', { ...SIGNED_IN, path: '/login' }],
      ['on to /setup', { ...SIGNED_IN, path: '/setup' }],
      ['next to a page without the banner', { ...SIGNED_IN, path: '/saeckel/', shows: [] }],
      ['no redirect', { ...SIGNED_IN, redirects: 0 }],
      ['the browser does not say', { ...SIGNED_IN, redirects: null }],
      ['a reload', { ...SIGNED_IN, type: 'reload' }],
      ['Back or Forward', { ...SIGNED_IN, type: 'back_forward' }],
      ['older than 30 s', { ...SIGNED_IN, after: { ...LOGIN, at: NOW - 31_000 } }],
      ['another act', { ...SIGNED_IN, after: { ...LOGIN, act: 'assign' } }],
      ['the act of another form', { ...SIGNED_IN, after: { ...LOGIN, action: '/setup' } }],
      // the founding
      ['a wrong key: 400 on /setup', { ...FOUNDED, path: '/setup', redirects: 0 }],
      ['founded, then elsewhere', { ...FOUNDED, path: '/account' }],
      ['founded without the banner', { ...FOUNDED, shows: [] }],
      ['a reload of the courtyard', { ...FOUNDED, type: 'reload' }],
      // the key
      ['the card of another person', { ...KEY_TAKEN, path: '/admin/users/8', shows: [RETURN(8)] }],
      ['«Вернуть ключ» of another person', { ...KEY_TAKEN, shows: [RETURN(8)] }],
      ['the key still there', { ...KEY_TAKEN, shows: [] }],
      ['the address of the form: its 404, 500', { ...KEY_TAKEN, path: '/admin/users/7/disable' }],
      [
        'another form of the card',
        { ...KEY_TAKEN, after: { ...KEY, action: '/admin/users/7/password' } },
      ],
      ['«Вернуть ключ» sent', { ...KEY_TAKEN, after: { ...KEY, action: '/admin/users/7/enable' } }],
      ['a reload of the card', { ...KEY_TAKEN, type: 'reload' }],
      ['no redirect', { ...KEY_TAKEN, redirects: 0 }],
    ];
    for (const [name, change] of cases) {
      const page = visit(change);
      page.parsed();
      assert.deepEqual(page.classes(), ['fx-on'], name);
      assert.equal(page.arrived(), undefined, name);
      assert.equal(page.session.size, 0, name);
    }
  });

  test('read once; without «Анимации» or with less motion only told, for the sound', () => {
    const session = new Map<string, string>();
    assert.deepEqual(visit({ ...SIGNED_IN, session }).classes(), [
      'from-door',
      'fx-on',
      'unroll',
      'unroll-wait',
    ]);
    assert.deepEqual(visit({ ...IN, path: '/', session }).classes(), ['fx-on']);
    for (const change of [{ anim: false }, { reduced: true }]) {
      const page = visit({ ...SIGNED_IN, ...change });
      page.parsed();
      assert.deepEqual(page.classes(), [], JSON.stringify(change));
      assert.equal(page.arrived(), 'login', JSON.stringify(change));
      const key = visit({ ...KEY_TAKEN, ...change });
      assert.deepEqual(key.classes(), [], JSON.stringify(change));
    }
  });
});

// M12.7: after the sign-in the banner unrolls whole, from its bar: it waits for its cloth and the
// roll (the images its CSS names; after the sign-in the browser has forgotten them), at most 3 s.
// What fails or is late, and a focus that comes into the banner, show it at once, not unrolled.
describe('fx-head.js: the banner waits for its cloth (M12.7)', () => {
  const SIGNED_IN = {
    after: { act: 'login', action: '/login', at: NOW - 1000 },
    path: '/',
    redirects: 1,
    shows: ['.banner'],
  };
  const UNROLLS = ['from-door', 'fx-on', 'unroll'];
  const WAITS = [...UNROLLS, 'unroll-wait'];

  test('the cloth and the roll, asked for as the CSS names them: it unrolls once both have come', () => {
    const page = visit(SIGNED_IN);
    assert.deepEqual(page.classes(), WAITS, 'from the start, before the page is drawn');
    assert.deepEqual(page.asks(), [], 'nothing asked before the page is parsed');
    page.parsed();
    assert.deepEqual(page.asks(), [
      'https://hof.test/static/img/menu-banner.webp?v=1',
      'https://hof.test/static/img/banner-roll.webp?v=2',
    ]);
    // Two of 3 s: the check of the pictures (M12.16) and the wait of the banner.
    const of3s = () => page.timers().filter((ms) => ms === 3000).length;
    assert.equal(of3s(), 2);
    page.load('load', 1);
    assert.deepEqual(page.classes(), WAITS, 'the roll alone is not enough');
    page.load('load', 0);
    assert.deepEqual(page.classes(), UNROLLS);
    assert.equal(of3s(), 1, 'the 3 s of the wait are off');
    // A focus into the banner while it unrolls: shown at once.
    page.focus(true);
    assert.deepEqual(page.classes(), ['from-door', 'fx-on']);
  });

  test('an image that fails: the banner is shown at once, not unrolled', () => {
    for (const which of [0, 1]) {
      const page = visit(SIGNED_IN);
      page.parsed();
      page.load('error', which);
      assert.deepEqual(page.classes(), ['from-door', 'fx-on'], String(which));
      page.load('load');
      assert.deepEqual(
        page.classes(),
        ['from-door', 'fx-on'],
        `${which}: a late load changes nothing`,
      );
    }
  });

  test('not come in 3 s: shown as it is; what comes later does not unroll it', () => {
    const page = visit(SIGNED_IN);
    page.parsed();
    page.tick();
    assert.deepEqual(page.classes(), ['from-door', 'fx-on']);
    page.load();
    assert.deepEqual(page.classes(), ['from-door', 'fx-on']);
  });

  test('a focus into the banner while it waits shows it; a focus elsewhere does not', () => {
    const page = visit(SIGNED_IN);
    page.parsed();
    page.focus(false);
    assert.deepEqual(page.classes(), WAITS);
    page.focus(true);
    assert.deepEqual(page.classes(), ['from-door', 'fx-on']);
    page.load();
    assert.deepEqual(page.classes(), ['from-door', 'fx-on']);
  });

  test('no image named (no CSS), or no banner drawn: nothing waits', () => {
    const bare = visit({ ...SIGNED_IN, cloth: '', roll: '' });
    bare.parsed();
    assert.deepEqual(bare.asks(), []);
    assert.deepEqual(bare.classes(), UNROLLS);
    const one = visit({ ...SIGNED_IN, roll: '' });
    one.parsed();
    assert.equal(one.asks().length, 1);
    one.load();
    assert.deepEqual(one.classes(), UNROLLS);
  });

  test('the banner of the act not there: no wait, no unrolling, nothing asked', () => {
    const page = visit({ ...SIGNED_IN, shows: [] });
    page.parsed();
    assert.deepEqual(page.classes(), ['fx-on']);
    assert.deepEqual(page.asks(), []);
  });

  test('without «Анимации», with less motion, after another act: nothing waits or is asked for', () => {
    for (const change of [{ anim: false }, { reduced: true }]) {
      const page = visit({ ...SIGNED_IN, ...change });
      page.parsed();
      assert.deepEqual(page.classes(), [], JSON.stringify(change));
      assert.deepEqual(page.asks(), [], JSON.stringify(change));
    }
    const key = visit({
      after: { act: 'key', action: '/admin/users/7/disable', at: NOW - 1000 },
      path: '/admin/users/7',
      redirects: 1,
      shows: ['form[action="/admin/users/7/enable"]', '.banner'],
    });
    key.parsed();
    assert.deepEqual(key.classes(), ['fx-on', 'key-off']);
    assert.deepEqual(key.asks(), []);
  });
});

describe('fx-head.js: money of Säckel (M10.5)', () => {
  const EXPENSE = { act: 'expense', action: '/saeckel/pouches/7/expense', at: NOW - 1000 };
  const INCOME = { act: 'income', action: '/saeckel/income', at: NOW - 1000 };
  const ASSIGN = { act: 'assign', action: '/saeckel/assign', at: NOW - 1000 };
  const TRANSFER = { act: 'transfer', action: '/saeckel/transfer', at: NOW - 1000 };
  // POST → 303 → the page the act leads to, with what the act shows: the record just written
  // marked, the note of the income; Мешки shows nothing of its own.
  const SPENT = {
    after: EXPENSE,
    path: '/saeckel/pouches/7?fresh=31',
    redirects: 1,
    shows: ['mark.move'],
  };
  const EARNED = {
    after: INCOME,
    path: '/saeckel/assign?income=32',
    redirects: 1,
    shows: ['.note-income'],
  };
  const LAID = { after: ASSIGN, path: '/saeckel/', redirects: 1, shows: [] };
  const MOVED = { after: TRANSFER, path: '/saeckel/', redirects: 1, shows: [] };

  test('an expense: the record written in, the sign squeezed; the class goes with the pen mark', () => {
    const page = visit(SPENT);
    page.parsed();
    assert.deepEqual(page.classes(), ['fx-on', 'spent']);
    assert.equal(page.arrived(), 'expense');
    assert.equal(page.session.size, 0);
    // The cells and the sign end first; the pen mark comes when the last cell is written.
    for (const name of ['squeeze', 'fx-fresh']) {
      page.fire('animationend', { animationName: name });
      assert.deepEqual(page.classes(), ['fx-on', 'spent'], name);
    }
    page.fire('animationend', { animationName: 'fx-mark' });
    assert.deepEqual(page.classes(), ['fx-on']);
  });

  test('an income, laying out and a transfer: only told, for the coins', () => {
    for (const [name, right] of [
      ['income', EARNED],
      ['assign', LAID],
      ['transfer', MOVED],
    ] as const) {
      const page = visit(right);
      page.parsed();
      page.frame();
      assert.deepEqual(page.classes(), ['fx-on'], name);
      assert.equal(page.arrived(), name);
      assert.equal(page.session.size, 0, name);
    }
  });

  test('no effect in each other case, and the flag is gone all the same', () => {
    // The cases of M10.2 for each of the four acts, then those of money.
    const cases: [string, Visit][] = [];
    for (const right of [SPENT, EARNED, LAID, MOVED]) {
      const flag = right.after;
      for (const [name, change] of [
        ['no flag', { after: undefined }],
        ['broken JSON', { after: `{"act":"${flag.act}",` }],
        ['not an object', { after: 7 }],
        ['older than 30 s', { after: { ...flag, at: NOW - 31_000 } }],
        ['from the future', { after: { ...flag, at: NOW + 60_000 } }],
        ['no time', { after: { act: flag.act, action: flag.action } }],
        ['the address of the form: its 400, 403, 429, 500', { path: flag.action, redirects: 0 }],
        ['the address of the form after a redirect', { path: flag.action }],
        ['a reload', { type: 'reload' }],
        ['Back or Forward', { type: 'back_forward' }],
        ['no redirect: opened by itself', { redirects: 0 }],
        ['the browser does not say', { redirects: null }],
        ['to the sign-in: the session is over', { path: '/login', shows: ['.banner'] as string[] }],
        ['an act of Core', { after: { ...flag, act: 'logout' } }],
      ] as const) {
        cases.push([`${flag.act}: ${name}`, { ...right, ...change }]);
      }
    }
    cases.push(
      // an expense
      ['the page of another pouch', { ...SPENT, path: '/saeckel/pouches/8?fresh=31' }],
      [
        'an expense of another pouch',
        { ...SPENT, after: { ...EXPENSE, action: '/saeckel/pouches/8/expense' } },
      ],
      ['no record marked: a strange or old fresh', { ...SPENT, shows: [] }],
      ['Мешки', { ...SPENT, path: '/saeckel/' }],
      ['«Изменить» sent', { ...SPENT, after: { ...EXPENSE, action: '/saeckel/pouches/7/edit' } }],
      // an income
      ['no note of the income: a strange income', { ...EARNED, shows: [] }],
      ['Мешки after an income', { ...EARNED, path: '/saeckel/' }],
      // laying out and a transfer
      ['Летопись', { ...LAID, path: '/saeckel/history' }],
      ['a pouch after laying out', { ...LAID, path: '/saeckel/pouches/7' }],
      ['a record changed', { ...MOVED, after: { ...TRANSFER, action: '/saeckel/operations/5' } }],
      [
        'a record deleted',
        { ...LAID, after: { ...ASSIGN, action: '/saeckel/operations/5/delete' } },
      ],
      [
        '«В кладовую» by the flag of laying out',
        { ...LAID, after: { ...ASSIGN, action: '/saeckel/pouches/7/archive' } },
      ],
      ['an expense flag on Мешки', { ...LAID, after: EXPENSE }],
      ['an income flag on Мешки', { ...LAID, after: INCOME }],
      ['a flag of laying out on «Разложить»', { ...EARNED, after: ASSIGN }],
    );
    for (const [name, change] of cases) {
      const page = visit(change);
      page.parsed();
      assert.deepEqual(page.classes(), ['fx-on'], name);
      assert.equal(page.arrived(), undefined, name);
      assert.equal(page.session.size, 0, name);
    }
  });

  test('«В кладовую» after laying out: its form takes the flag away, Мешки rings not', () => {
    const session = new Map<string, string>();
    const storage = {
      setItem: (key: string, value: string) => void session.set(key, value),
      removeItem: (key: string) => void session.delete(key),
    };
    writeFlag(storage, AFTER_KEY, ASSIGN);
    // The archiving is a form without data-fx: fx.js writes null for it.
    writeFlag(storage, AFTER_KEY, null);
    const page = visit({ path: '/saeckel/', redirects: 1, session });
    assert.equal(page.arrived(), undefined);
    // And a transfer sent after an expense rings as a transfer, once.
    writeFlag(storage, AFTER_KEY, EXPENSE);
    writeFlag(storage, AFTER_KEY, TRANSFER);
    assert.equal(visit({ ...MOVED, after: undefined, session }).arrived(), 'transfer');
    assert.equal(visit({ ...MOVED, after: undefined, session }).arrived(), undefined);
  });

  test('without «Анимации» or with less motion: no record written in, no squeeze; still told', () => {
    for (const change of [{ anim: false }, { reduced: true }]) {
      const page = visit({ ...SPENT, ...change });
      page.parsed();
      assert.deepEqual(page.classes(), [], JSON.stringify(change));
      assert.equal(page.arrived(), 'expense', JSON.stringify(change));
    }
  });
});

// M12.16: a big picture of the first screen is not seen half drawn. Its scene waits hidden (the
// CSS, under .reveal) until the image of the picture has come or failed, and then is shown whole,
// with no fade; at 3 s a scene whose image has come is shown even if its event was lost, and one
// still coming waits.
describe('fx-head.js: the big pictures of the first screen (M12.16)', () => {
  const shown = (picture: FakeScene | FakeImage) => picture.classList.contains('shown');

  test('every page waits for its pictures: with «Анимации» or without, with less motion', () => {
    for (const change of [{}, { anim: false }, { reduced: true }]) {
      assert.equal(visit(change).reveal(), true, JSON.stringify(change));
    }
  });

  test('a scene is shown when its picture has come; another image, in it or not, does nothing', () => {
    const scene = new FakeScene(2);
    const page = visit({ scenes: [scene] });
    assert.ok(!shown(scene));
    page.fire('load', { target: new FakeImage() });
    page.fire('load', { target: scene.images[1] });
    page.fire('load', { target: { tagName: 'SCRIPT' } });
    page.fire('error', { target: null });
    assert.ok(!shown(scene), 'a blot, a cat, a script: not the picture');
    page.fire('load', { target: scene.images[0] });
    assert.ok(shown(scene));
    assert.deepEqual([...scene.names], ['shown'], 'at once: no class of a fade');
  });

  test('the picture that is an image itself (Säckel); an image that fails is shown at once', () => {
    const band = new FakeImage('self');
    const failed = new FakeScene();
    const page = visit({ scenes: [band, failed] });
    page.fire('load', { target: band });
    assert.ok(shown(band));
    page.fire('error', { target: failed.images[0] });
    assert.ok(shown(failed), 'what a broken image shows, not the paper for ever');
  });

  test('an image the browser has already is shown before the first frame, before its load event', () => {
    const cached = new FakeScene();
    cached.images[0]!.complete = true;
    cached.images[0]!.naturalWidth = 1536;
    const broken = new FakeScene();
    broken.images[0]!.complete = true;
    const coming = new FakeScene();
    const page = visit({ scenes: [cached, broken, coming] });
    page.frame();
    assert.ok(shown(cached), 'in the first frame, as without this');
    assert.ok(!shown(broken), 'a broken one waits for its error');
    assert.ok(!shown(coming));
    // Each frame looks again while a scene waits; it is shown in the frame after it has come.
    coming.images[0]!.complete = true;
    coming.images[0]!.naturalWidth = 683;
    page.frame();
    assert.ok(shown(coming));
    page.fire('error', { target: broken.images[0] });
    page.frame();
    assert.ok(shown(broken));
  });

  test('an image that hangs past 3 s: the check of each frame ends then; its late load still shows it', () => {
    const scene = new FakeScene();
    const page = visit({ scenes: [scene] });
    page.frame();
    page.frame();
    assert.equal(page.asked(), 1, 'each frame looks again while it waits');
    page.tick();
    page.frame();
    assert.equal(page.asked(), 0, 'no frame asked for after the check of 3 s');
    assert.ok(!shown(scene), 'not half drawn');
    scene.images[0]!.complete = true;
    scene.images[0]!.naturalWidth = 1536;
    page.fire('load', { target: scene.images[0] });
    assert.ok(shown(scene), 'shown whole when it comes at last');
    const failing = new FakeScene();
    const other = visit({ scenes: [failing] });
    other.tick();
    other.fire('error', { target: failing.images[0] });
    assert.ok(shown(failing), 'and a late error too');
  });

  test('at 3 s: a picture that has come is shown though its event was lost; one still coming waits', () => {
    const lost = new FakeScene();
    lost.images[0]!.complete = true;
    const coming = new FakeScene();
    const page = visit({ scenes: [lost, coming] });
    assert.deepEqual(page.timers(), [3000]);
    page.tick();
    assert.ok(shown(lost));
    assert.ok(!shown(coming), 'shown now, it would be half drawn');
    page.fire('load', { target: coming.images[0] });
    assert.ok(shown(coming), 'whole, when it has come');
  });
});

describe('fx-head.js: the page after a link (hof.arrive)', () => {
  const link = (fx: string, path: string, keep = false) => ({
    fx,
    to: `https://hof.test${path}`,
    at: NOW - 500,
    keep,
  });

  // M12.15: the way out by fetch opens /login itself, without a redirect: the flag of a door.
  test('the sign-in after the way out through the gate: out of the dark, as through a door', () => {
    const page = visit({ arrive: link('door', '/login'), path: '/login' });
    assert.deepEqual(page.classes(), ['from-door', 'fx-on']);
    assert.equal(page.arrived(), 'door');
    page.fire('animationend', { animationName: 'veil-out' });
    assert.deepEqual(page.classes(), ['fx-on']);
  });

  test('a slide: from the other side; the banner stays where the link said so', () => {
    const users = visit({ arrive: link('left', '/admin/users', true), path: '/admin/users' });
    assert.deepEqual(users.classes(), ['from-right', 'fx-on', 'keep-banner']);
    assert.equal(users.arrived(), 'left');
    const court = visit({ arrive: link('right', '/'), path: '/' });
    assert.deepEqual(court.classes(), ['from-left', 'fx-on']);
  });

  test('a page of the book turned: a slide the same way, the banner kept if the link said so; a rustle has no class', () => {
    const turned = visit({
      arrive: link('flip-fwd', '/saeckel/history'),
      path: '/saeckel/history',
    });
    assert.deepEqual(turned.classes(), ['from-right', 'fx-on']);
    assert.equal(turned.arrived(), 'flip-fwd');
    const back = visit({ arrive: link('flip-back', '/admin/users', true), path: '/admin/users' });
    assert.deepEqual(back.classes(), ['from-left', 'fx-on', 'keep-banner']);
    assert.equal(back.arrived(), 'flip-back');
    const rustle = visit({
      arrive: link('page', '/saeckel/history?page=2'),
      path: '/saeckel/history?page=2',
    });
    assert.deepEqual(rustle.classes(), ['fx-on']);
    assert.equal(rustle.arrived(), 'page');
  });

  test('no effect: another address, an old flag, a reload, Back, the sign-in on the way, an unknown fx', () => {
    const cases: [string, Visit][] = [
      ['another address', { arrive: link('left', '/account'), path: '/admin/users' }],
      [
        'another query',
        { arrive: link('page', '/saeckel/history?page=2'), path: '/saeckel/history' },
      ],
      ['older than 30 s', { arrive: { ...link('left', '/'), at: NOW - 31_000 }, path: '/' }],
      ['a reload', { arrive: link('left', '/'), path: '/', type: 'reload' }],
      ['Back or Forward', { arrive: link('left', '/'), path: '/', type: 'back_forward' }],
      [
        'sent to the sign-in',
        { arrive: link('right', '/'), path: '/login?next=%2F', redirects: 1 },
      ],
      ['an unknown fx', { arrive: link('spin', '/'), path: '/' }],
      ['a fx of the phone only', { arrive: link('flip-fwd-phone', '/'), path: '/' }],
      ['broken JSON', { arrive: '{"fx":', path: '/' }],
    ];
    for (const [name, change] of cases) {
      const page = visit(change);
      assert.deepEqual(page.classes(), ['fx-on'], name);
      assert.equal(page.arrived(), undefined, name);
      assert.equal(page.session.size, 0, name);
    }
  });

  test('through a door of the courtyard (M10.3): out of the dark; without «Анимации» only told', () => {
    for (const [path, to] of [
      ['/saeckel/', '/saeckel/'],
      ['/admin/users', '/admin/users'],
      ['/account', '/account'],
    ]) {
      const page = visit({ arrive: link('door', to!), path: path! });
      assert.deepEqual(page.classes(), ['from-door', 'fx-on'], path);
      assert.equal(page.arrived(), 'door', path);
    }
    for (const change of [{ anim: false }, { reduced: true }]) {
      const page = visit({ arrive: link('door', '/saeckel/'), path: '/saeckel/', ...change });
      assert.deepEqual(page.classes(), [], JSON.stringify(change));
      assert.equal(page.arrived(), 'door', JSON.stringify(change));
    }
  });

  test('read once', () => {
    const session = new Map<string, string>();
    assert.deepEqual(visit({ arrive: link('left', '/'), path: '/', session }).classes(), [
      'from-right',
      'fx-on',
    ]);
    assert.deepEqual(visit({ path: '/', session }).classes(), ['fx-on']);
  });
});
