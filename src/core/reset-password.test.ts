// reset-password.ts: the shared transaction of the password reset (ARCHITECTURE.md §4.2, §4.8),
// against hof_test. Failures are made by the database itself, at one chosen statement; the order
// of concurrent transactions is decided by real row locks, watched in pg_stat_activity.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { migrate } from '../migrate.ts';
import { handleConnectionErrors } from '../postgres.ts';
import { resetPassword } from './reset-password.ts';
import { createSession, hashSessionToken, newSessionToken } from './sessions.ts';

const password = process.env.HOF_CORE_DB_PASSWORD;
assert.ok(password, 'HOF_CORE_DB_PASSWORD is not set: create .env from .env.example');
const config = { database: 'hof_test', user: 'hof_core', password };
const pool = new Pool(config);

before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
beforeEach(() => pool.query('TRUNCATE sessions, users RESTART IDENTITY'));
after(() => pool.end());

// The function writes the hash as given and never reads it, so plain distinct strings do.
const OLD_HASH = 'old hash of anna';
const NEW_HASH = 'new hash of anna';

async function addUser(username: string, passwordHash: string, disabled = false) {
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO users (username, password_hash, is_disabled) VALUES ($1, $2, $3) RETURNING id',
    [username, passwordHash, disabled],
  );
  return rows[0]!.id;
}

async function addSession(userId: number): Promise<string> {
  const token = newSessionToken();
  await pool.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
    [hashSessionToken(token), userId],
  );
  return token;
}

async function sessionsOf(userId: number): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1',
    [userId],
  );
  return rows[0]!.n;
}

async function userRow(userId: number) {
  const { rows } = await pool.query<{
    password_hash: string;
    is_admin: boolean;
    is_disabled: boolean;
  }>('SELECT password_hash, is_admin, is_disabled FROM users WHERE id = $1', [userId]);
  return rows[0]!;
}

// A pool of one connection, as the CLI makes it: if the reset left its client out, or gave it
// back inside an open or failed transaction, the next query through this pool shows it.
function onePool(t: TestContext): Pool {
  const own = new Pool({ ...config, max: 1 });
  handleConnectionErrors(own);
  t.after(() => own.end());
  return own;
}

// No client of the pool is still out.
function assertAllReturned(own: Pool): void {
  assert.equal(own.totalCount - own.idleCount, 0, 'a client was not released');
}

// Nobody holds the row lock of the user: another transaction takes it at once.
async function assertRowFree(userId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE NOWAIT', [userId]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// The queries of hof_test that wait for a lock, once there are `count` of them.
async function waitingQueries(count: number): Promise<{ pid: number; query: string }[]> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query<{ pid: number; query: string }>(
      "SELECT pid, query FROM pg_stat_activity WHERE datname = 'hof_test' AND wait_event_type = 'Lock' ORDER BY query_start",
    );
    if (rows.length >= count) return rows;
    await sleep(10);
  }
  assert.fail(`${count} queries never waited for a lock`);
}

// A sign-in in the middle of its transaction (core/app.ts, POST /login): the row of the user
// locked with FOR UPDATE, its new session written, no COMMIT yet. Returns the open client and
// the cookie token of that session.
async function signInHalfway(userId: number) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT password_hash, is_disabled FROM users WHERE id = $1 FOR UPDATE', [
    userId,
  ]);
  const token = await createSession(client, userId);
  return { client, token };
}

describe('resetPassword', { timeout: 10_000 }, () => {
  test('the new hash, every session of the user ended and counted, nobody else touched', async (t) => {
    const own = onePool(t);
    const owner = await addUser('owner', 'hash of the owner');
    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [owner]);
    const anna = await addUser('anna', OLD_HASH, true);
    const boris = await addUser('boris', 'hash of boris');
    await addSession(anna);
    await addSession(anna);
    await addSession(owner);
    await addSession(boris);

    assert.equal(await resetPassword(own, anna, NEW_HASH), 2);
    // The hash only: is_disabled and is_admin stay as they were.
    assert.deepEqual(await userRow(anna), {
      password_hash: NEW_HASH,
      is_admin: false,
      is_disabled: true,
    });
    assert.equal(await sessionsOf(anna), 0);
    assert.equal(await sessionsOf(owner), 1);
    assert.equal(await sessionsOf(boris), 1);
    assert.equal((await userRow(boris)).password_hash, 'hash of boris');
    assertAllReturned(own);
    await assertRowFree(anna);
  });

  test('an id without a row: nothing written, 0 — finding the user is the caller’s work', async (t) => {
    const anna = await addUser('anna', OLD_HASH);
    await addSession(anna);
    assert.equal(await resetPassword(onePool(t), 99, NEW_HASH), 0);
    assert.equal((await userRow(anna)).password_hash, OLD_HASH);
    assert.equal(await sessionsOf(anna), 1);
  });

  // The database refuses one statement of the transaction; whatever came before it is rolled
  // back. Each case: [name, how to make it fail, how to undo that, the expected error].
  const failures: [string, string, string, RegExp][] = [
    [
      'at UPDATE',
      'ALTER TABLE users ADD CONSTRAINT users_no_update CHECK (false) NOT VALID',
      'ALTER TABLE users DROP CONSTRAINT IF EXISTS users_no_update',
      /violates check constraint "users_no_update"/,
    ],
    [
      'at DELETE, after UPDATE',
      'ALTER TABLE sessions RENAME TO sessions_away',
      'ALTER TABLE IF EXISTS sessions_away RENAME TO sessions',
      /relation "sessions" does not exist/,
    ],
    [
      // A deferred unique constraint is checked only at COMMIT, after UPDATE and DELETE went
      // through: the new hash is the one boris already has.
      'at COMMIT, after UPDATE and DELETE',
      'ALTER TABLE users ADD CONSTRAINT users_hash_once UNIQUE (password_hash) DEFERRABLE INITIALLY DEFERRED',
      'ALTER TABLE users DROP CONSTRAINT IF EXISTS users_hash_once',
      /violates unique constraint "users_hash_once"/,
    ],
  ];
  for (const [name, breakIt, repair, expected] of failures) {
    test(`a failure ${name}: the original error, ROLLBACK, the client back and clean`, async (t) => {
      const own = onePool(t);
      const anna = await addUser('anna', OLD_HASH);
      await addUser('boris', NEW_HASH);
      await addSession(anna);
      await addSession(anna);
      await pool.query(breakIt);
      try {
        await assert.rejects(resetPassword(own, anna, NEW_HASH), expected);
      } finally {
        await pool.query(repair);
      }
      // Nothing of the reset stayed: neither the hash nor the end of the sessions.
      assert.equal((await userRow(anna)).password_hash, OLD_HASH);
      assert.equal(await sessionsOf(anna), 2);
      // The client is back in the pool and holds no lock. It is outside any transaction: inside
      // a failed one this query would be refused, inside an open one with writes it would see
      // a transaction id.
      assertAllReturned(own);
      await assertRowFree(anna);
      const { rows } = await own.query<{ outside: boolean }>(
        'SELECT pg_current_xact_id_if_assigned() IS NULL AS outside',
      );
      assert.equal(rows[0]!.outside, true);
      // And the same pool resets the password afterwards.
      assert.equal(await resetPassword(own, anna, 'yet another hash'), 2);
    });
  }

  test('the connection breaks inside the transaction: the original error, not the ROLLBACK one', async (t) => {
    const own = onePool(t);
    const anna = await addUser('anna', OLD_HASH);
    await addSession(anna);
    // A sign-in holds the row, so the reset waits on its UPDATE, inside its transaction.
    const signIn = await signInHalfway(anna);
    try {
      const reset = assert.rejects(
        resetPassword(own, anna, NEW_HASH),
        /terminating connection due to administrator command/,
      );
      const [waiting] = await waitingQueries(1);
      assert.match(waiting!.query, /^UPDATE users SET password_hash/);
      // Its backend is ended: the UPDATE fails, and so would the ROLLBACK on the dead connection.
      await pool.query('SELECT pg_terminate_backend($1)', [waiting!.pid]);
      await reset;
      await signIn.client.query('ROLLBACK');
    } finally {
      signIn.client.release();
    }
    assert.equal((await userRow(anna)).password_hash, OLD_HASH);
    assert.equal(await sessionsOf(anna), 1);
    // The broken client is out of the pool, and the pool goes on with a new one.
    assert.equal(own.totalCount, 0);
    assert.equal(await resetPassword(own, anna, NEW_HASH), 1);
  });

  test('UPDATE first: a sign-in that has not committed yet loses its session', async (t) => {
    const anna = await addUser('anna', OLD_HASH);
    const signIn = await signInHalfway(anna);
    try {
      // The reset waits for the row on its UPDATE, before it deletes anything.
      const reset = resetPassword(onePool(t), anna, NEW_HASH);
      const [waiting] = await waitingQueries(1);
      assert.match(waiting!.query, /^UPDATE users SET password_hash/);
      // The sign-in commits; the reset goes on and deletes the session it now sees.
      await signIn.client.query('COMMIT');
      assert.equal(await reset, 1);
    } finally {
      signIn.client.release();
    }
    assert.equal(await sessionsOf(anna), 0);
    assert.equal((await userRow(anna)).password_hash, NEW_HASH);
  });

  test('two resets at once: one after the other on the row lock, the later hash stays', async () => {
    const anna = await addUser('anna', OLD_HASH);
    const signIn = await signInHalfway(anna);
    try {
      // The first reset waits for the sign-in, the second one for the first: PostgreSQL hands the
      // row over in this order.
      const first = resetPassword(pool, anna, 'hash of the first reset');
      await waitingQueries(1);
      const second = resetPassword(pool, anna, 'hash of the second reset');
      const waiting = await waitingQueries(2);
      for (const { query } of waiting) assert.match(query, /^UPDATE users SET password_hash/);
      await signIn.client.query('COMMIT');
      // The first one ends the session of the sign-in, the second finds none left.
      assert.equal(await first, 1);
      assert.equal(await second, 0);
    } finally {
      signIn.client.release();
    }
    assert.equal((await userRow(anna)).password_hash, 'hash of the second reset');
    assert.equal(await sessionsOf(anna), 0);
  });
});
