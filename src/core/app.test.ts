// Founding the court, the courtyard and the gates (ARCHITECTURE.md §4.1, §4.4, §4.6), through the
// whole application: the common checks of main.ts, the first-run gate and the Core routes.
// Database: hof_test as hof_core; the first-run state is the real one, its key read from the log.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../main.ts';
import { migrate } from '../migrate.ts';
import { startFirstRun } from './gate-key.ts';
import { hashSessionToken, sessionCookie } from './sessions.ts';

const password = process.env.HOF_CORE_DB_PASSWORD;
assert.ok(password, 'HOF_CORE_DB_PASSWORD is not set: create .env from .env.example');
const pool = new Pool({ database: 'hof_test', user: 'hof_core', password });

before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
beforeEach(() => pool.query('TRUNCATE sessions, users RESTART IDENTITY'));
after(() => pool.end());

const HOST = 'localhost:3000';
const ORIGIN = 'http://localhost:3000';
const FORM = 'application/x-www-form-urlencoded';
const PASSWORD = 'correct horse battery staple';
const COOKIE =
  /^__Host-hof=([A-Za-z0-9_-]{43}); Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/;

type App = ReturnType<typeof createApp>;

// A fresh process: first-run state from the database, the gate key read from the log line,
// every later log line collected in `lines`.
async function boot(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(line));
  const firstRun = await startFirstRun(pool);
  const key = /^info gate_key key=(\S+)$/.exec(lines[0] ?? '')?.[1] ?? '';
  return { app: createApp(pool, firstRun), key, lines };
}

function get(app: App, path: string, headers: Record<string, string> = {}) {
  return app.request(path, { headers: { host: HOST, ...headers } });
}

function post(app: App, path: string, fields: Record<string, string>, headers = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { host: HOST, origin: ORIGIN, 'content-type': FORM, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

function setupFields(key: string, username = 'owner') {
  return { code: key, username, password: PASSWORD, password2: PASSWORD };
}

async function count(table: 'users' | 'sessions'): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]!.n;
}

// Founds the court and returns the app with the administrator's session cookie.
async function found(t: TestContext) {
  const booted = await boot(t);
  const res = await post(booted.app, '/setup', setupFields(booted.key));
  const token = COOKIE.exec(res.headers.get('set-cookie') ?? '')?.[1];
  assert.ok(token, 'founding gave no session cookie');
  return { ...booted, token, cookie: `__Host-hof=${token}` };
}

describe('before founding', () => {
  test('the common checks come before the setup logic', async (t) => {
    const { app, key } = await boot(t);
    const fields = setupFields(key);
    const body = new URLSearchParams(fields).toString();
    const noOrigin = await app.request('/setup', {
      method: 'POST',
      headers: { host: HOST, 'content-type': FORM },
      body,
    });
    assert.equal(noOrigin.status, 403);
    assert.equal((await post(app, '/setup', fields, { 'content-type': 'text/plain' })).status, 415);
    const big = await post(app, '/setup', { ...fields, padding: 'x'.repeat(16 * 1024) });
    assert.equal(big.status, 413);
    assert.equal(await count('users'), 0);
  });

  test('every path but /setup leads to /setup', async (t) => {
    const { app } = await boot(t);
    for (const path of ['/', '/login', '/saeckel/x', '/nope']) {
      const res = await get(app, path);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get('location'), '/setup', path);
    }
    const res = await post(app, '/x', { a: '1' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/setup');
  });

  test('GET /setup shows the form', async (t) => {
    const { app } = await boot(t);
    const res = await get(app, '/setup');
    assert.equal(res.status, 200);
    const page = await res.text();
    for (const text of [
      'Основание двора',
      '<form method="post" action="/setup">',
      'Ключ от ворот',
      'name="code"',
      'name="username"',
      'name="password"',
      'name="password2"',
      'Не короче 15 символов.',
      'Основать двор',
    ]) {
      assert.ok(page.includes(text), text);
    }
  });

  test('a wrong key: 400, a warning without the typed value, nothing written', async (t) => {
    const { app, key, lines } = await boot(t);
    const wrongKey = 'ABCDE-FGHJK-MNPQR-STVWX';
    // The password is too short as well: the answer is about the key, so nothing after the key
    // check ran — Argon2 included.
    const res = await post(app, '/setup', { ...setupFields(wrongKey), password: 'short' });
    assert.equal(res.status, 400);
    const page = await res.text();
    assert.ok(page.includes('Ключ от ворот не подходит.'));
    assert.deepEqual(lines.slice(1), ['warn gate_key_rejected ip=-']);
    assert.ok(!page.includes(wrongKey) && !page.includes(key));
    assert.equal(await count('users'), 0);
  });

  test('the key may be typed in lower case, with spaces instead of hyphens', async (t) => {
    const { app, key } = await boot(t);
    const typed = ` ${key.toLowerCase().replaceAll('-', ' ')} `;
    const res = await post(app, '/setup', setupFields(typed));
    assert.equal(res.status, 303);
    assert.equal(await count('users'), 1);
  });

  const fieldErrors: [string, Partial<Record<string, string>>, string][] = [
    ['login of a wrong form', { username: '-anna' }, 'Логин: латиница'],
    ['login with a space', { username: 'an na' }, 'Логин: латиница'],
    ['password shorter than 15', { password: 'a'.repeat(14), password2: 'a'.repeat(14) }, 'от 15'],
    ['passwords that differ', { password2: PASSWORD + '!' }, 'Пароли не совпадают.'],
  ];
  for (const [name, change, message] of fieldErrors) {
    test(`${name}: 400, the login kept, key and passwords not shown, nothing written`, async (t) => {
      const { app, key } = await boot(t);
      const fields = { ...setupFields(key), ...change } as Record<string, string>;
      const res = await post(app, '/setup', fields);
      assert.equal(res.status, 400);
      const page = await res.text();
      assert.ok(page.includes(message), message);
      assert.ok(page.includes(`value="${fields.username}"`));
      for (const secret of [key, key.replaceAll('-', ''), fields.password!, fields.password2!]) {
        assert.ok(!page.includes(secret), `page shows ${secret}`);
      }
      assert.equal(await count('users'), 0);
      // Nothing was founded: the same key still works.
      assert.equal((await post(app, '/setup', setupFields(key))).status, 303);
      assert.equal(await count('users'), 1);
    });
  }
});

describe('founding', () => {
  test('one administrator, one session, the cookie, the courtyard', async (t) => {
    const { app, key, lines } = await boot(t);
    const res = await post(app, '/setup', setupFields(key, ' Owner '));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
    const setCookie = res.headers.get('set-cookie') ?? '';
    const token = COOKIE.exec(setCookie)?.[1];
    assert.ok(token, setCookie);
    assert.equal(setCookie, sessionCookie(token));

    const users = await pool.query('SELECT id, username, is_admin, is_disabled FROM users');
    assert.deepEqual(users.rows, [
      { id: 1, username: 'owner', is_admin: true, is_disabled: false },
    ]);
    const sessions = await pool.query<{ token_hash: Buffer; user_id: number }>(
      'SELECT token_hash, user_id FROM sessions',
    );
    assert.deepEqual(sessions.rows, [{ token_hash: hashSessionToken(token), user_id: 1 }]);
    assert.ok(lines.includes('info court_founded user_id=1 username=owner ip=-'));

    const courtyard = await get(app, '/', { cookie: `__Host-hof=${token}` });
    assert.equal(courtyard.status, 200);
    const page = await courtyard.text();
    for (const text of ['Двор', 'Службы двора', 'owner']) assert.ok(page.includes(text), text);
  });

  test('a failed transaction leaves no user, no session, and the key still works', async (t) => {
    const { app, key } = await boot(t);
    t.mock.method(console, 'error', () => undefined);
    try {
      await pool.query('ALTER TABLE sessions RENAME TO sessions_away');
      const res = await post(app, '/setup', setupFields(key));
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('set-cookie'), null);
    } finally {
      await pool.query('ALTER TABLE IF EXISTS sessions_away RENAME TO sessions');
    }
    assert.equal(await count('users'), 0);
    assert.equal(await count('sessions'), 0);
    const again = await post(app, '/setup', setupFields(key));
    assert.equal(again.status, 303);
    assert.match(again.headers.get('set-cookie') ?? '', COOKIE);
  });

  test('two submissions at once: one administrator, one session, one cookie', async (t) => {
    const { app, key } = await boot(t);
    const answers = await Promise.all([
      post(app, '/setup', setupFields(key, 'first')),
      post(app, '/setup', setupFields(key, 'second')),
    ]);
    assert.deepEqual(
      answers.map((res) => [res.status, res.headers.get('location')]),
      [
        [303, '/'],
        [303, '/'],
      ],
    );
    assert.equal(answers.filter((res) => res.headers.get('set-cookie') !== null).length, 1);
    assert.equal(await count('users'), 1);
    assert.equal(await count('sessions'), 1);
  });

  test('the loser of the race: unique index → ROLLBACK, 303 /, no cookie, no session', async (t) => {
    const { app, key } = await boot(t);
    // Another founding is in progress and holds the administrator row, not yet committed.
    const rival = await pool.connect();
    try {
      await rival.query('BEGIN');
      await rival.query(
        "INSERT INTO users (username, password_hash, is_admin) VALUES ('rival', 'hash', true)",
      );
      // This submission passes every check, then waits on the unique index.
      const pending = post(app, '/setup', setupFields(key));
      for (let i = 0; i < 200; i++) {
        const { rows } = await pool.query<{ waiting: number }>(
          "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = 'hof_test' AND wait_event_type = 'Lock'",
        );
        if (rows[0]!.waiting > 0) break;
        await sleep(10);
      }
      await rival.query('COMMIT');
      const res = await pending;
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/');
      assert.equal(res.headers.get('set-cookie'), null);
    } finally {
      rival.release();
    }
    const users = await pool.query<{ username: string }>('SELECT username FROM users');
    assert.deepEqual(users.rows, [{ username: 'rival' }]);
    assert.equal(await count('sessions'), 0);
  });
});

describe('after founding', () => {
  test('GET /setup is 404; POST /setup goes to / without checks or writes', async (t) => {
    const { app, key } = await found(t);
    assert.equal((await get(app, '/setup')).status, 404);
    for (const fields of [{ code: 'garbage' }, setupFields(key, 'second')]) {
      const res = await post(app, '/setup', fields);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/');
      assert.equal(res.headers.get('set-cookie'), null);
    }
    assert.equal(await count('users'), 1);
    assert.equal(await count('sessions'), 1);
  });

  test('/login is public: a plain 404, no redirect loop', async (t) => {
    const { app } = await found(t);
    for (const path of ['/login', '/login?next=%2F']) {
      const res = await get(app, path);
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get('location'), null, path);
    }
  });

  test('/ needs a session: GET keeps the address in next, POST goes to /login', async (t) => {
    const { app, cookie } = await found(t);
    const getRes = await get(app, '/?a=1');
    assert.equal(getRes.status, 303);
    assert.equal(getRes.headers.get('location'), '/login?next=%2F%3Fa%3D1');
    const headRes = await app.request('/', { method: 'HEAD', headers: { host: HOST } });
    assert.equal(headRes.headers.get('location'), '/login?next=%2F');
    const postRes = await post(app, '/', { a: '1' });
    assert.equal(postRes.status, 303);
    assert.equal(postRes.headers.get('location'), '/login');
    assert.equal((await get(app, '/', { cookie })).status, 200);
    const malformed = await get(app, '/', { cookie: '__Host-hof=not-a-token' });
    assert.equal(malformed.headers.get('location'), '/login?next=%2F');
  });

  test('an expired session is no session', async (t) => {
    const { app, cookie } = await found(t);
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
    const res = await get(app, '/', { cookie });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login?next=%2F');
  });

  test('an unknown path is 404 with or without a session', async (t) => {
    const { app, cookie } = await found(t);
    assert.equal((await get(app, '/nope')).status, 404);
    assert.equal((await post(app, '/nope', { a: '1' })).status, 404);
    assert.equal((await get(app, '/nope', { cookie })).status, 404);
  });
});

test('no password, session token or typed gate key in the log', async (t) => {
  const { app, key, lines } = await boot(t);
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args.map(String).join(' ')));
  const wrongKey = 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ';
  await post(app, '/setup', setupFields(wrongKey));
  await post(app, '/setup', { ...setupFields(key), password: 'too short' });
  const res = await post(app, '/setup', setupFields(key));
  const token = COOKIE.exec(res.headers.get('set-cookie') ?? '')?.[1];
  assert.ok(token);
  await get(app, '/', { cookie: `__Host-hof=${token}` });
  await get(app, '/');

  // lines[0] is the startup line that announces the key; that is its only place.
  const written = [...lines.slice(1), ...errors].join('\n');
  for (const secret of [
    PASSWORD,
    'too short',
    token,
    key,
    key.replaceAll('-', ''),
    wrongKey,
    wrongKey.replaceAll('-', ''),
  ]) {
    assert.ok(!written.includes(secret), `log contains ${secret}`);
  }
  assert.ok(written.includes('court_founded'));
});
