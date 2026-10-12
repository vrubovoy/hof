// Gate key and first-run state (ARCHITECTURE.md §4.4, §4.7). The startup step runs against
// hof_test as hof_core: the test passes its own pool, no database setting is involved.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../migrate.ts';
import { formatGateKey, newGateKey, normalizeGateKey, startFirstRun } from './gate-key.ts';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

describe('key', () => {
  test('20 symbols of Crockford base32, shown as XXXXX-XXXXX-XXXXX-XXXXX', () => {
    for (let i = 0; i < 200; i++) {
      const key = newGateKey();
      assert.match(key, /^[0-9A-HJKMNP-TV-Z]{20}$/);
      assert.doesNotMatch(key, /[ILOU]/);
      assert.match(formatGateKey(key), /^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    }
  });

  test('two keys differ', () => {
    assert.notEqual(newGateKey(), newGateKey());
  });

  test('all zero bits and all one bits give the first and the last symbol', () => {
    assert.equal(newGateKey(Buffer.alloc(13, 0x00)), '0'.repeat(20));
    assert.equal(newGateKey(Buffer.alloc(13, 0xff)), 'Z'.repeat(20));
  });

  // Each of the first 100 bits moves exactly one symbol by exactly its own weight, and the last
  // 4 bits move nothing. So the 2^100 possible inputs map one-to-one onto 32^20 keys: uniform
  // random bits give uniform keys, with no symbol more likely than another.
  test('each of the first 100 bits sets one bit of one symbol; bits 100–103 are unused', () => {
    for (let bit = 0; bit < 104; bit++) {
      const bytes = Buffer.alloc(13);
      bytes[bit >> 3] = 0x80 >> (bit & 7);
      const expected =
        bit < 100
          ? [...'0'.repeat(20)].map((c, i) =>
              i === Math.floor(bit / 5) ? ALPHABET[1 << (4 - (bit % 5))] : c,
            )
          : [...'0'.repeat(20)];
      assert.equal(newGateKey(bytes), expected.join(''), `bit ${bit}`);
    }
  });

  test('needs exactly 13 random bytes', () => {
    assert.throws(() => newGateKey(Buffer.alloc(12)));
  });
});

describe('typed input', () => {
  const key = 'ABCDE0123456789FGHJK';

  test('lower case, spaces and hyphens are accepted', () => {
    for (const input of [
      key,
      'abcde0123456789fghjk',
      'ABCDE-01234-56789-FGHJK',
      ' abcde 01234-56789 fghjk\t',
    ]) {
      assert.equal(normalizeGateKey(input), key, input);
    }
  });

  const rejected: [string, string][] = [
    ['19 symbols', key.slice(1)],
    ['21 symbols', key + 'M'],
    ['empty', ''],
    ['letter I', 'I' + key.slice(1)],
    ['letter L', 'L' + key.slice(1)],
    ['letter O', 'O' + key.slice(1)],
    ['letter U', 'U' + key.slice(1)],
    ['Cyrillic А', 'А' + key.slice(1)],
    ['Cyrillic lower case', 'абвгд' + key.slice(5)],
    ['punctuation', '!' + key.slice(1)],
  ];
  for (const [name, input] of rejected) {
    test(`${name} → not a key`, () => {
      assert.equal(normalizeGateKey(input), null);
    });
  }
});

describe('first run state', () => {
  const password = process.env.HOF_CORE_DB_PASSWORD;
  assert.ok(password, 'HOF_CORE_DB_PASSWORD is not set: create .env from .env.example');
  const pool = new Pool({ database: 'hof_test', user: 'hof_core', password });

  before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
  beforeEach(() => pool.query('TRUNCATE sessions, users RESTART IDENTITY'));
  after(() => pool.end());

  async function insertAdministrator(): Promise<void> {
    await pool.query(
      "INSERT INTO users (username, password_hash, is_admin) VALUES ('owner', 'hash', true)",
    );
  }

  // Runs the startup step with the log captured; returns the state and every log line.
  async function start(t: TestContext) {
    const lines: string[] = [];
    t.mock.method(console, 'log', (line: string) => lines.push(line));
    const state = await startFirstRun(pool);
    return { state, lines };
  }

  function keyFrom(lines: string[]): string {
    const match = /^info gate_key key=([0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5})$/.exec(
      lines[0] ?? '',
    );
    assert.ok(match, `no gate key line in ${JSON.stringify(lines)}`);
    return match[1]!;
  }

  test('without an administrator: exactly one log line, with the key', async (t) => {
    const { state, lines } = await start(t);
    assert.equal(lines.length, 1);
    const key = keyFrom(lines);
    assert.equal(await state.isFounded(), false);
    assert.equal(state.keyMatches(key), true);
    // The key is not written anywhere else: checking keys and the state log nothing.
    state.keyMatches('0'.repeat(20));
    await state.isFounded();
    state.markFounded();
    assert.equal(lines.length, 1);
  });

  test('a new start makes a new key; the old one does not open the new process', async (t) => {
    const first = await start(t);
    const second = await start(t);
    const oldKey = keyFrom(first.lines);
    const newKey = keyFrom(second.lines);
    assert.notEqual(oldKey, newKey);
    assert.equal(second.state.keyMatches(oldKey), false);
    assert.equal(second.state.keyMatches(newKey), true);
  });

  test('the key matches in any typed form; another key does not', async (t) => {
    const { state, lines } = await start(t);
    const key = keyFrom(lines);
    assert.equal(state.keyMatches(key.toLowerCase().replaceAll('-', ' ')), true);
    assert.equal(state.keyMatches(key.replaceAll('-', '')), true);
    assert.equal(state.keyMatches(formatGateKey(newGateKey())), false);
    assert.equal(state.keyMatches('not a key'), false);
  });

  test('after "founded" the right key is refused and the state stays founded', async (t) => {
    const { state, lines } = await start(t);
    const key = keyFrom(lines);
    state.markFounded();
    assert.equal(state.keyMatches(key), false);
    assert.equal(await state.isFounded(), true);
  });

  test('"not founded" is read again: an administrator who appears is seen', async (t) => {
    const { state, lines } = await start(t);
    const key = keyFrom(lines);
    assert.equal(await state.isFounded(), false);
    await insertAdministrator();
    assert.equal(await state.isFounded(), true);
    // Founded means the key is gone, whoever founded the court.
    assert.equal(state.keyMatches(key), false);
  });

  test('"founded" is remembered even if the row disappears', async (t) => {
    const { state } = await start(t);
    await insertAdministrator();
    assert.equal(await state.isFounded(), true);
    await pool.query('TRUNCATE sessions, users');
    assert.equal(await state.isFounded(), true);
  });

  test('with an administrator: no key is made or written', async (t) => {
    await insertAdministrator();
    const { state, lines } = await start(t);
    assert.deepEqual(lines, []);
    assert.equal(await state.isFounded(), true);
    assert.equal(state.keyMatches(formatGateKey(newGateKey())), false);
  });
});
