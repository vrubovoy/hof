// fx.js (ARCHITECTURE.md §6, §4.8): what the effects decide, without a page — the settings of the
// device, motion, variants of a sound, the place of the music, the guard against a form sent
// twice — and that every sound it may ask for is in static and in the licence list.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  DEFAULTS,
  MUSIC_KEY,
  PIECES,
  SETTINGS_KEY,
  SOUNDS,
  canMove,
  createGuard,
  firstPiece,
  level,
  nextPiece,
  pickVariant,
  readMusic,
  readSettings,
  soundFiles,
  tryNextPiece,
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
