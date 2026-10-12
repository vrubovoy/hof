// postgres.ts: a broken PostgreSQL connection — idle in the pool, handed out between the queries
// of a transaction, or handed out during a query — does not end the process, and the pool goes
// on with a new connection. Against hof_test: the backend of a pool connection is ended with
// pg_terminate_backend from another connection.
//
// The tests add no `error` listener of their own: had postgres.ts none, the event would throw and
// the test run would fail. They wait for `end` with a plain once(), which listens to nothing else.

import assert from 'node:assert/strict';
import { after, before, describe, test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, Pool, type PoolClient } from 'pg';
import { handleConnectionErrors } from './postgres.ts';

const password = process.env.HOF_CORE_DB_PASSWORD;
assert.ok(password, 'HOF_CORE_DB_PASSWORD is not set: create .env from .env.example');
const config = { database: 'hof_test', user: 'hof_core', password };

// Ends backends and watches pg_stat_activity. PostgreSQL lets a role end the backends of the
// same role, so no superuser is needed.
const control = new Client(config);
before(() => control.connect());
after(() => control.end());

// A pool as the server and the CLI make it: the listeners before the first connection.
function newPool(t: TestContext): Pool {
  const pool = new Pool(config);
  handleConnectionErrors(pool);
  t.after(() => pool.end());
  return pool;
}

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return rows[0]!.pid;
}

async function terminate(pid: number): Promise<void> {
  const { rows } = await control.query<{ done: boolean }>(
    'SELECT pg_terminate_backend($1) AS done',
    [pid],
  );
  assert.equal(rows[0]!.done, true);
}

// Resolves when the client has seen its connection end; by then it has emitted its error.
function connectionEnd(client: PoolClient): Promise<void> {
  return new Promise((resolve) => client.once('end', () => resolve()));
}

// Log lines written during the test; nextLine() resolves when the next one arrives.
function captureLog(t: TestContext) {
  const lines: string[] = [];
  let arrived: (() => void) | undefined;
  t.mock.method(console, 'log', (line: string) => {
    lines.push(line);
    arrived?.();
  });
  const nextLine = () => new Promise<void>((resolve) => (arrived = resolve));
  return { lines, nextLine };
}

// The pool still works: the query goes through a new connection, not the broken one.
async function assertNewConnection(pool: Pool, brokenPid: number): Promise<void> {
  const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  assert.notEqual(rows[0]!.pid, brokenPid);
}

describe('handleConnectionErrors', () => {
  test('one pool listener, and one on each client from its first connection', async (t) => {
    const pool = new Pool(config);
    t.after(() => pool.end());
    handleConnectionErrors(pool);
    assert.equal(pool.totalCount, 0);
    assert.equal(pool.listenerCount('error'), 1);
    assert.equal(pool.listenerCount('connect'), 1);
    // The same client handed out three times: while it is out, the pool keeps no listener on it,
    // so the one there is ours, added once at its connection, not at every hand-out.
    for (let i = 0; i < 3; i++) {
      const client = await pool.connect();
      assert.equal(client.listenerCount('error'), 1);
      client.release();
    }
    assert.equal(pool.totalCount, 1);
  });
});

// Without the listeners of postgres.ts the error event throws inside `pg`, `end` never comes and
// the awaited event would wait forever: the timeout turns that into a failure. It only guards
// against a hang; the order of events is decided by the database, not by time.
describe('a broken connection', { timeout: 10_000 }, () => {
  test('idle in the pool: one db_pool_error line, the pool opens a new connection', async (t) => {
    const log = captureLog(t);
    const pool = newPool(t);
    const client = await pool.connect();
    const pid = await backendPid(client);
    client.release();
    assert.equal(pool.idleCount, 1);

    const logged = log.nextLine();
    await terminate(pid);
    await logged;
    assert.deepEqual(log.lines, [
      'error db_pool_error error="terminating connection due to administrator command"',
    ]);
    // The pool has already dropped the broken client.
    assert.equal(pool.totalCount, 0);
    await assertNewConnection(pool, pid);
    assert.equal(log.lines.length, 1);
    assert.ok(!log.lines[0]!.includes(password));
  });

  test('handed out, between the queries of a transaction: the next query fails', async (t) => {
    const log = captureLog(t);
    const pool = newPool(t);
    const client = await pool.connect();
    await client.query('BEGIN');
    const pid = await backendPid(client);

    const end = connectionEnd(client);
    await terminate(pid);
    // No query is in flight: the client's error event has only the listener of postgres.ts.
    await end;
    await assert.rejects(client.query('SELECT 1'), /not queryable/);
    client.release();
    assert.equal(pool.totalCount, 0);
    await assertNewConnection(pool, pid);
    // The caller has the error; nothing is logged twice.
    assert.deepEqual(log.lines, []);
  });

  test('handed out, during a query: the query fails', async (t) => {
    const log = captureLog(t);
    const pool = newPool(t);
    const client = await pool.connect();
    const pid = await backendPid(client);

    const end = connectionEnd(client);
    // The rejection is awaited from the start, so it never counts as unhandled.
    const sleeping = assert.rejects(
      client.query('SELECT pg_sleep(30)'),
      /terminating connection due to administrator command/,
    );
    await waitUntilRunning(pid, 'SELECT pg_sleep(30)');
    await terminate(pid);
    await sleeping;
    // After the failed query the client still reports the closed connection as an error event.
    await end;
    client.release();
    assert.equal(pool.totalCount, 0);
    await assertNewConnection(pool, pid);
    assert.deepEqual(log.lines, []);
  });
});

// Resolves once the backend runs the query, as pg_stat_activity shows it.
async function waitUntilRunning(pid: number, query: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await control.query<{ state: string; query: string }>(
      'SELECT state, query FROM pg_stat_activity WHERE pid = $1',
      [pid],
    );
    if (rows[0]?.state === 'active' && rows[0].query === query) return;
    await sleep(10);
  }
  assert.fail(`backend ${pid} never ran ${query}`);
}
