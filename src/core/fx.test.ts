// fx.js (ARCHITECTURE.md §6, §4.8): what the effects decide, without a page — the settings of the
// device, motion, variants of a sound, the place of the music, the guard against a form sent
// twice, what a press on a link does (M10.2) — and that every sound it may ask for is in static
// and in the licence list. fx-head.js, a script of <head> without exports, runs here as it is
// against a page made of only what it reads: how a page arrives after a link or a form.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import {
  AFTER_KEY,
  ARRIVE_KEY,
  DEFAULTS,
  LINK_FX,
  MUSIC_KEY,
  PIECES,
  SETTINGS_KEY,
  SOUNDS,
  canMove,
  createGuard,
  firstPiece,
  leaving,
  level,
  nextPiece,
  pickVariant,
  plainPress,
  readMusic,
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

  test('every file fx.js may ask for is in static and in the licence list', () => {
    const files = soundFiles();
    const sets = Object.values(SOUNDS).reduce((sum, count) => sum + count, 0);
    assert.equal(files.length, sets + PIECES);
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
      ['door', {}, null],
      ['logout', {}, null],
    ];
    for (const [fx, change, expected] of cases) {
      assert.deepEqual(
        leaving(fx, { ...now, ...change }),
        expected,
        `${fx} ${JSON.stringify(change)}`,
      );
    }
    assert.deepEqual(LINK_FX, ['left', 'right', 'flip-fwd', 'flip-back', 'flip-fwd-phone', 'page']);
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
  // The sessionStorage of the tab, shared by the visits of one test.
  session?: Map<string, string>;
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
  session = new Map(),
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
  const url = new URL(path, 'https://hof.test');
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
      querySelector: (selector: string) => (marker && selector !== '' ? {} : null),
    },
    addEventListener: listen,
    requestAnimationFrame: (frame: () => void) => void frames.push(frame),
  };
  page.window = page;
  runInContext(HEAD, createContext(page));
  const fire = (type: string, event: object = {}) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    classes: () => [...classes].sort(),
    arrived: () => dataset.arrived,
    session,
    fire,
    // The parser reaches the end of the page; or the first frame is drawn before it.
    parsed: () => fire('readystatechange'),
    frame: () => frames.splice(0).forEach((frame) => frame()),
  };
}

describe('fx-head.js: the page after a form (hof.after)', () => {
  const LOGOUT = { act: 'logout', action: '/logout', at: NOW - 1000 };
  // POST /logout → 303 → /login, a fresh flag, the form of the sign-in on the page.
  const RIGHT = { after: LOGOUT, path: '/login', redirects: 1 };

  test('the right case: /login slides in from the left, the flag is gone', () => {
    const page = visit(RIGHT);
    assert.deepEqual(page.classes(), ['from-left', 'fx-on']);
    assert.equal(page.arrived(), 'logout');
    assert.equal(page.session.size, 0);
    page.parsed();
    assert.deepEqual(page.classes(), ['from-left', 'fx-on']);
    // The slide in ends with its veil: the classes of the arrival go.
    page.fire('animationend', { animationName: 'out-left' });
    assert.deepEqual(page.classes(), ['from-left', 'fx-on']);
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
    assert.deepEqual(visit({ ...RIGHT, session }).classes(), ['from-left', 'fx-on']);
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

describe('fx-head.js: the page after a link (hof.arrive)', () => {
  const link = (fx: string, path: string, keep = false) => ({
    fx,
    to: `https://hof.test${path}`,
    at: NOW - 500,
    keep,
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

  test('read once', () => {
    const session = new Map<string, string>();
    assert.deepEqual(visit({ arrive: link('left', '/'), path: '/', session }).classes(), [
      'from-right',
      'fx-on',
    ]);
    assert.deepEqual(visit({ path: '/', session }).classes(), ['fx-on']);
  });
});
