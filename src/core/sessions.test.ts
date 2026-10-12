// Sessions (ARCHITECTURE.md §4.2, §5.3) against hof_test as hof_core.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../migrate.ts';
import {
  createSession,
  currentUser,
  hashSessionToken,
  newSessionToken,
  sessionCookie,
} from './sessions.ts';

const password = process.env.HOF_CORE_DB_PASSWORD;
assert.ok(password, 'HOF_CORE_DB_PASSWORD is not set: create .env from .env.example');
const config = { database: 'hof_test', user: 'hof_core', password };
const pool = new Pool(config);

// The real Core migrations; a no-op when another test file has already applied them.
before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
beforeEach(() => pool.query('TRUNCATE sessions, users RESTART IDENTITY'));
after(() => pool.end());

async function insertUser(username: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    "INSERT INTO users (username, password_hash) VALUES ($1, 'hash') RETURNING id",
    [username],
  );
  return rows[0]!.id;
}

// A session created and committed the way the application will do it.
async function signIn(userId: number): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const token = await createSession(client, userId);
    await client.query('COMMIT');
    return token;
  } finally {
    client.release();
  }
}

describe('token and cookie', () => {
  test('a token is 43 base64url characters from 32 random bytes', () => {
    const token = newSessionToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
  });

  test('two tokens differ', () => {
    assert.notEqual(newSessionToken(), newSessionToken());
  });

  test('the stored hash is SHA-256 of the cookie string, not of the random bytes', () => {
    const token = newSessionToken();
    const ofString = createHash('sha256').update(token, 'utf8').digest();
    const ofBytes = createHash('sha256').update(Buffer.from(token, 'base64url')).digest();
    assert.deepEqual(hashSessionToken(token), ofString);
    assert.notDeepEqual(hashSessionToken(token), ofBytes);
  });

  test('Set-Cookie follows §4.2 exactly', () => {
    assert.equal(
      sessionCookie('T'.repeat(43)),
      `__Host-hof=${'T'.repeat(43)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    );
  });
});

describe('cookie of the wrong form', () => {
  // A pool that has been ended fails on any query, so a null answer proves no query was made.
  const closed = new Pool(config);
  before(() => closed.end());

  const malformed: [string, string | undefined][] = [
    ['no cookie', undefined],
    ['empty', ''],
    ['42 characters', 'a'.repeat(42)],
    ['44 characters', 'a'.repeat(44)],
    ['with +', '+'.padEnd(43, 'a')],
    ['with /', '/'.padEnd(43, 'a')],
    ['with =', 'a'.repeat(42) + '='],
  ];
  for (const [name, value] of malformed) {
    test(`${name} → null without a database query`, async () => {
      assert.equal(await currentUser(closed, value), null);
    });
  }

  test('a well-formed token does go to the database (the closed pool fails)', async () => {
    await assert.rejects(currentUser(closed, newSessionToken()));
  });
});

describe('currentUser', () => {
  test('a valid session gives its user', async () => {
    const id = await insertUser('anna');
    const token = await signIn(id);
    assert.deepEqual(await currentUser(pool, token), { id, username: 'anna' });
  });

  test('only the hash is stored, not the token', async () => {
    const token = await signIn(await insertUser('anna'));
    const { rows } = await pool.query<{ token_hash: Buffer }>('SELECT token_hash FROM sessions');
    assert.deepEqual(rows, [{ token_hash: hashSessionToken(token) }]);
  });

  test('an unknown token gives null', async () => {
    await signIn(await insertUser('anna'));
    assert.equal(await currentUser(pool, newSessionToken()), null);
  });

  test('an expired session gives null', async () => {
    const token = await signIn(await insertUser('anna'));
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
    assert.equal(await currentUser(pool, token), null);
  });

  test('a disabled user gives null while the session row still exists', async () => {
    const id = await insertUser('anna');
    const token = await signIn(id);
    await pool.query('UPDATE users SET is_disabled = true WHERE id = $1', [id]);
    assert.equal(await currentUser(pool, token), null);
    await pool.query('UPDATE users SET is_disabled = false WHERE id = $1', [id]);
    assert.deepEqual(await currentUser(pool, token), { id, username: 'anna' });
  });
});

describe('createSession', () => {
  test('a new session expires in 30 days', async () => {
    await signIn(await insertUser('anna'));
    const { rows } = await pool.query<{ seconds: string }>(
      'SELECT extract(epoch FROM expires_at - now()) AS seconds FROM sessions',
    );
    const seconds = Number(rows[0]?.seconds);
    assert.ok(seconds > 2592000 - 60 && seconds <= 2592000, `${seconds} s`);
  });

  test("works inside the caller's transaction: a rollback leaves no session", async () => {
    const id = await insertUser('anna');
    const client = await pool.connect();
    let token = '';
    try {
      await client.query('BEGIN');
      token = await createSession(client, id);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    assert.equal(await currentUser(pool, token), null);
    const { rows } = await pool.query('SELECT 1 FROM sessions');
    assert.equal(rows.length, 0);
  });
});
