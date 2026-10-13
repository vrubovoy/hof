// Founding the court, signing in and out, the courtyard, my chambers, «Приближённые» and the
// gates (ARCHITECTURE.md §4.1–4.4, §4.6, §4.8), through the whole application: the common checks
// of main.ts, the first-run gate and the Core routes. Database: hof_test as hof_core; the first-run state is the real one, its
// key read from the log.

import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp, newDummyPasswordHash } from '../main.ts';
import { migrate } from '../migrate.ts';
import { startFirstRun } from './gate-key.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { createSession, hashSessionToken, newSessionToken, sessionCookie } from './sessions.ts';

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
const NEW_PASSWORD = 'a brand new password for the court';
const COOKIE =
  /^__Host-hof=([A-Za-z0-9_-]{43}); Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/;
// Copied from ARCHITECTURE.md §4.2 on purpose: the test must not share the value with the code.
const CLEARED_COOKIE = '__Host-hof=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0';

// Made once: every Argon2 takes tens of milliseconds.
const DUMMY_HASH = await newDummyPasswordHash();
const PASSWORD_HASH = await hashPassword(PASSWORD);

type App = ReturnType<typeof createApp>;

// A fresh process: first-run state from the database, the gate key read from the log line,
// every later log line collected in `lines`.
async function boot(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(line));
  const firstRun = await startFirstRun(pool);
  const key = /^info gate_key key=(\S+)$/.exec(lines[0] ?? '')?.[1] ?? '';
  return { app: createApp(pool, firstRun, DUMMY_HASH), key, lines };
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

async function hashOf(userId: number): Promise<string> {
  const { rows } = await pool.query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]!.password_hash;
}

function passwordFields(current: string, password: string) {
  return { current, password, password2: password };
}

function changePassword(app: App, cookie: string, fields: Record<string, string>, headers = {}) {
  return post(app, '/account/password', fields, { cookie, ...headers });
}

// A user written straight into the table, without «Принять ко двору»: quicker, and only the
// tests of that page depend on it.
async function addUser(username: string, passwordHash = PASSWORD_HASH, disabled = false) {
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO users (username, password_hash, is_disabled) VALUES ($1, $2, $3) RETURNING id',
    [username, passwordHash, disabled],
  );
  return rows[0]!.id;
}

// A session row written straight into the table; returns its cookie token.
async function addSession(userId: number, expired = false): Promise<string> {
  const token = newSessionToken();
  await pool.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + $3 * interval '1 day')",
    [hashSessionToken(token), userId, expired ? -1 : 30],
  );
  return token;
}

// The sessions as their cookie tokens, out of the given ones (rows of other tokens count too).
async function sessionTokens(...tokens: string[]): Promise<{ known: string[]; other: number }> {
  const { rows } = await pool.query<{ token_hash: Buffer }>('SELECT token_hash FROM sessions');
  const hashes = rows.map((row) => row.token_hash.toString('hex'));
  const known = tokens.filter((token) => hashes.includes(hashSessionToken(token).toString('hex')));
  return { known, other: hashes.length - known.length };
}

function signIn(app: App, username: string, typed: string, headers = {}, next = '') {
  return post(app, '/login', { username, password: typed, next }, headers);
}

// Resolves once `count` queries of hof_test wait for locks held by other transactions.
async function waitForLock(count = 1): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = 'hof_test' AND wait_event_type = 'Lock'",
    );
    if (rows[0]!.waiting >= count) return;
    await sleep(10);
  }
  assert.fail('no query started waiting for the lock');
}

// Counts the Argon2 computations started from now until stop(). node:crypto starts each one as
// an async resource of type ARGON2REQUEST; tests run one at a time, so every one of them belongs
// to the request under test. This shows which requests pay for Argon2, and when, without
// measuring time.
function argon2Counter() {
  let started = 0;
  const hook = createHook({
    init(_id, type) {
      if (type === 'ARGON2REQUEST') started += 1;
    },
  }).enable();
  return { started: () => started, stop: () => void hook.disable() };
}

// The Argon2 computations started while `action` runs.
async function countArgon2<T>(
  action: () => T | Promise<T>,
): Promise<{ result: T; argon2: number }> {
  const counter = argon2Counter();
  try {
    const result = await action();
    return { result, argon2: counter.started() };
  } finally {
    counter.stop();
  }
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

  test('a repeat typed in another Unicode form is the same password', async (t) => {
    const { app, key } = await boot(t);
    const nfc = 'пароль для двора ёлка и чай'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    assert.notEqual(nfc, nfd);
    const res = await post(app, '/setup', { ...setupFields(key), password: nfc, password2: nfd });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('set-cookie') ?? '', COOKIE);
    assert.equal(await count('users'), 1);
  });

  test('a failed transaction leaves no user, no session, and the key still works', async (t) => {
    const { app, key } = await boot(t);
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
      await waitForLock();
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

  test('the common 404 page: unknown paths with or without a session, GET /logout, GET /setup', async (t) => {
    const { app, cookie } = await found(t);
    for (const [name, res] of [
      ['GET /nope', await get(app, '/nope')],
      ['POST /nope', await post(app, '/nope', { a: '1' })],
      ['GET /nope with a session', await get(app, '/nope', { cookie })],
      ['GET /logout', await get(app, '/logout')],
      ['GET /logout with a session', await get(app, '/logout', { cookie })],
      ['GET /setup after founding', await get(app, '/setup')],
      ['GET /account/password with a session', await get(app, '/account/password', { cookie })],
    ] as const) {
      assert.equal(res.status, 404, name);
      assert.equal(res.headers.get('cache-control'), 'no-store', name);
      const page = await res.text();
      assert.ok(page.includes('<h1>Такой тропы во дворе нет</h1>'), name);
      assert.ok(page.includes('<a href="/">Во двор</a>'), name);
    }
  });
});

describe('sign-in page', () => {
  test('GET /login: the form, with next only if it is safe', async (t) => {
    const { app } = await found(t);
    const res = await get(app, `/login?next=${encodeURIComponent('/saeckel/history?page=2')}`);
    assert.equal(res.status, 200);
    const page = await res.text();
    for (const text of [
      'С возвращением во двор!',
      '<form method="post" action="/login">',
      '<input type="hidden" name="next" value="/saeckel/history?page=2" />',
      'name="username"',
      'name="password"',
      'Войти во двор',
      'Нет ключа или забыли пароль? Обратитесь к хозяину двора.',
    ]) {
      assert.ok(page.includes(text), text);
    }
    assert.ok(!page.includes('Неверный логин или пароль'));
    const unsafe = await get(app, `/login?next=${encodeURIComponent('//evil.example')}`);
    assert.ok((await unsafe.text()).includes('name="next" value="/"'));
  });

  // The one rule (§4.6), seen through GET /login with a live session, which goes straight on.
  const accepted = ['/', '/account', '/saeckel/history?page=2', '/%2F%2Fx', '/' + 'a'.repeat(511)];
  const rejected = [
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    'evil',
    '',
    '/a b',
    '/a\tb',
    '/a\x7fb',
    '/ä',
    '/a\\b',
    '/' + 'a'.repeat(512),
  ];
  test('next: a local path of printable ASCII up to 512 characters, anything else is /', async (t) => {
    const { app, cookie } = await found(t);
    const cases: [string, string][] = [
      ...accepted.map((next): [string, string] => [next, next]),
      ...rejected.map((next): [string, string] => [next, '/']),
    ];
    for (const [next, expected] of cases) {
      const res = await get(app, `/login?next=${encodeURIComponent(next)}`, { cookie });
      assert.equal(res.status, 303, JSON.stringify(next));
      assert.equal(res.headers.get('location'), expected, JSON.stringify(next));
    }
    const without = await get(app, '/login', { cookie });
    assert.equal(without.headers.get('location'), '/');
  });

  test('the way back from a protected page leads there after sign-in', async (t) => {
    const { app } = await found(t);
    const away = await get(app, '/?a=1');
    const location = away.headers.get('location') ?? '';
    assert.equal(location, '/login?next=%2F%3Fa%3D1');
    const page = await (await get(app, location)).text();
    assert.ok(page.includes('name="next" value="/?a=1"'));
    const res = await signIn(app, 'owner', PASSWORD, {}, '/?a=1');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/?a=1');
  });
});

describe('sign-in', () => {
  test('a new session, the cookie, the log line, then on to next', async (t) => {
    const { app, token, lines } = await found(t);
    const { result: res, argon2 } = await countArgon2(() =>
      signIn(app, ' Owner ', PASSWORD, { 'x-real-ip': '203.0.113.7' }, '/x?y=1'),
    );
    assert.equal(argon2, 1);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/x?y=1');
    const setCookie = res.headers.get('set-cookie') ?? '';
    const fresh = COOKIE.exec(setCookie)?.[1];
    assert.ok(fresh, setCookie);
    assert.notEqual(fresh, token);
    // The session from founding was in another "browser": it stays.
    assert.deepEqual(await sessionTokens(token, fresh), { known: [token, fresh], other: 0 });
    assert.equal(lines.at(-1), 'info login user_id=1 username=owner ip=203.0.113.7');
    assert.equal((await get(app, '/', { cookie: `__Host-hof=${fresh}` })).status, 200);
  });

  test('POST takes next through the same rule', async (t) => {
    const { app } = await found(t);
    for (const [next, expected] of [
      ['//evil.example', '/'],
      ['/\\evil.example', '/'],
      ['/account', '/account'],
    ]) {
      const res = await signIn(app, 'owner', PASSWORD, {}, next);
      assert.equal(res.headers.get('location'), expected, next);
    }
  });

  test('a password typed in another Unicode form is the same password', async (t) => {
    const { app } = await found(t);
    const nfc = 'пароль для двора ёлка и чай'.normalize('NFC');
    await addUser('anna', await hashPassword(nfc));
    const res = await signIn(app, 'anna', nfc.normalize('NFD'));
    assert.equal(res.status, 303);
    assert.match(res.headers.get('set-cookie') ?? '', COOKIE);
  });

  test('a successful sign-in deletes expired sessions and this browser’s old one only', async (t) => {
    const { app, token: ownerSession } = await found(t);
    const anna = await addUser('anna');
    const browser = await addSession(anna);
    const phone = await addSession(anna);
    const annaExpired = await addSession(anna, true);
    const ownerExpired = await addSession(1, true);
    const res = await signIn(app, 'anna', PASSWORD, { cookie: `__Host-hof=${browser}` });
    assert.equal(res.status, 303);
    const fresh = COOKIE.exec(res.headers.get('set-cookie') ?? '')?.[1];
    assert.ok(fresh);
    const all = [ownerSession, browser, phone, annaExpired, ownerExpired, fresh];
    assert.deepEqual(await sessionTokens(...all), {
      known: [ownerSession, phone, fresh],
      other: 0,
    });
  });

  test('a failed transaction: 500, no session, no cookie', async (t) => {
    const { app } = await found(t);
    try {
      await pool.query('ALTER TABLE sessions RENAME TO sessions_away');
      const res = await signIn(app, 'owner', PASSWORD);
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('set-cookie'), null);
    } finally {
      await pool.query('ALTER TABLE IF EXISTS sessions_away RENAME TO sessions');
    }
    assert.equal(await count('sessions'), 1);
  });
});

describe('refused sign-in', () => {
  // owner (1) from founding; anna (2) may enter; bors (3) is disabled; vera (4) has a stored
  // hash that cannot be read. All four-letter logins, so the pages differ in nothing else.
  async function court(t: TestContext) {
    const founded = await found(t);
    await addUser('anna');
    await addUser('bors', PASSWORD_HASH, true);
    await addUser('vera', 'not an argon2 hash');
    return founded;
  }

  const long = 'x'.repeat(257);
  const cases: [string, string, string, string, number][] = [
    // name, login, password, log line, Argon2 computations
    [
      'wrong password',
      'anna',
      'a wrong password, long enough',
      'warn login_failed user_id=2 username=anna ip=- reason=wrong_password',
      1,
    ],
    ['unknown login', 'nemo', PASSWORD, 'warn login_failed reason=unknown_user ip=-', 1],
    ['login of the wrong form', '-nemo', PASSWORD, 'warn login_failed reason=unknown_user ip=-', 0],
    [
      'password over 256, known login',
      'anna',
      long,
      'warn login_failed user_id=2 username=anna ip=- reason=wrong_password',
      0,
    ],
    [
      'password over 256, unknown login',
      'nemo',
      long,
      'warn login_failed reason=unknown_user ip=-',
      0,
    ],
    [
      'disabled user, right password',
      'bors',
      PASSWORD,
      'warn login_failed user_id=3 username=bors ip=- reason=disabled',
      1,
    ],
    ['unreadable stored hash', 'vera', PASSWORD, 'error password_hash_unreadable user_id=4', 1],
  ];
  for (const [name, username, typed, logLine, expectedArgon2] of cases) {
    test(`${name}: 400, the common error, nothing written, ${expectedArgon2} Argon2`, async (t) => {
      const { app, lines } = await court(t);
      const before = await pool.query('SELECT * FROM users ORDER BY id');
      const logged = lines.length;
      const { result: res, argon2 } = await countArgon2(() => signIn(app, username, typed));
      assert.equal(argon2, expectedArgon2);
      assert.equal(res.status, 400);
      assert.equal(res.headers.get('set-cookie'), null);
      const page = await res.text();
      assert.ok(page.includes('Неверный логин или пароль.'));
      assert.ok(page.includes(`value="${username}"`));
      assert.ok(!page.includes(typed));
      assert.deepEqual(lines.slice(logged), [logLine]);
      assert.equal(await count('sessions'), 1);
      assert.deepEqual((await pool.query('SELECT * FROM users ORDER BY id')).rows, before.rows);
    });
  }

  test('unknown login, wrong password, disabled, unreadable: one and the same answer', async (t) => {
    const { app } = await court(t);
    const answers = await Promise.all(
      [
        ['anna', 'a wrong password, long enough'],
        ['nemo', PASSWORD],
        ['bors', PASSWORD],
        ['vera', PASSWORD],
      ].map(async ([username, typed]) => {
        const res = await signIn(app, username!, typed!);
        return {
          status: res.status,
          headers: [...res.headers].sort(),
          page: (await res.text()).replace(`value="${username}"`, 'value="…"'),
        };
      }),
    );
    for (const answer of answers.slice(1)) assert.deepEqual(answer, answers[0]);
  });

  test('the unknown login is not written to the log', async (t) => {
    const { app, lines } = await court(t);
    const typed = 'my.secret.pass';
    await signIn(app, typed, PASSWORD);
    assert.ok(!lines.join('\n').includes(typed));
    assert.equal(lines.at(-1), 'warn login_failed reason=unknown_user ip=-');
  });
});

describe('dummy password hash', () => {
  test('the Argon2 counter sees one computation per hash', async () => {
    assert.equal((await countArgon2(() => hashPassword(PASSWORD))).argon2, 1);
  });

  test('the profile of a real hash, and no password matches it', async () => {
    const phc = /^\$argon2id\$v=19\$(m=\d+,t=\d+,p=\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
    const dummy = phc.exec(await newDummyPasswordHash());
    const real = phc.exec(await hashPassword(PASSWORD));
    assert.ok(dummy && real);
    assert.equal(dummy[1], 'm=19456,t=2,p=1');
    assert.equal(dummy[1], real[1]);
    assert.equal(Buffer.from(dummy[2]!, 'base64').length, 16);
    assert.equal(Buffer.from(dummy[3]!, 'base64').length, 32);
    for (const typed of [PASSWORD, '', 'x'.repeat(256)]) {
      assert.equal(await verifyPassword(typed, DUMMY_HASH), 'wrong');
    }
    assert.notEqual(await newDummyPasswordHash(), DUMMY_HASH);
  });
});

describe('sign-in racing a password reset or a disable', () => {
  // The rival changes anna's row and holds the lock; sign-in has already checked the old
  // password with Argon2 and waits on FOR UPDATE until the rival commits.
  async function race(t: TestContext, change: string) {
    const { app, token: ownerSession, lines } = await found(t);
    const anna = await addUser('anna');
    const browser = await addSession(anna);
    const expired = await addSession(anna, true);
    const rival = await pool.connect();
    try {
      await rival.query('BEGIN');
      await rival.query(change, [anna]);
      const pending = signIn(app, 'anna', PASSWORD, { cookie: `__Host-hof=${browser}` });
      await waitForLock();
      await rival.query('COMMIT');
      const res = await pending;
      assert.equal(res.status, 400);
      assert.equal(res.headers.get('set-cookie'), null);
      assert.ok((await res.text()).includes('Неверный логин или пароль.'));
    } finally {
      rival.release();
    }
    // ROLLBACK: neither the expired session nor this browser's old one was deleted, and no new
    // session was made.
    assert.deepEqual(await sessionTokens(ownerSession, browser, expired), {
      known: [ownerSession, browser, expired],
      other: 0,
    });
    return lines;
  }

  test('the password changed: 400, nothing deleted, no session', async (t) => {
    const otherHash = await hashPassword('another password for anna');
    const lines = await race(t, `UPDATE users SET password_hash = '${otherHash}' WHERE id = $1`);
    assert.equal(
      lines.at(-1),
      'warn login_failed user_id=2 username=anna ip=- reason=password_changed',
    );
  });

  test('the user was disabled: 400, nothing deleted, no session', async (t) => {
    const lines = await race(t, 'UPDATE users SET is_disabled = true WHERE id = $1');
    assert.equal(lines.at(-1), 'warn login_failed user_id=2 username=anna ip=- reason=disabled');
  });
});

describe('sign-out', () => {
  test('the courtyard has the way out', async (t) => {
    const { app, cookie } = await found(t);
    const page = await (await get(app, '/', { cookie })).text();
    assert.ok(page.includes('<form method="post" action="/logout">'));
    assert.ok(page.includes('Покинуть двор'));
  });

  test('ends the session of this browser only and clears the cookie', async (t) => {
    const { app, token, cookie } = await found(t);
    const phone = await addSession(1);
    const res = await post(app, '/logout', {}, { cookie });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');
    assert.equal(res.headers.get('set-cookie'), CLEARED_COOKIE);
    assert.deepEqual(await sessionTokens(token, phone), { known: [phone], other: 0 });
    const after = await get(app, '/', { cookie });
    assert.equal(after.headers.get('location'), '/login?next=%2F');
    assert.equal((await get(app, '/', { cookie: `__Host-hof=${phone}` })).status, 200);
  });

  test('needs no session: the same answer without one, nothing deleted', async (t) => {
    const { app } = await found(t);
    for (const headers of [
      {},
      { cookie: '__Host-hof=not-a-token' },
      { cookie: `__Host-hof=${newSessionToken()}` },
    ]) {
      const res = await post(app, '/logout', {}, headers);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/login');
      assert.equal(res.headers.get('set-cookie'), CLEARED_COOKIE);
    }
    assert.equal(await count('sessions'), 1);
  });

  test('needs Origin like every POST', async (t) => {
    const { app, cookie } = await found(t);
    const res = await app.request('/logout', {
      method: 'POST',
      headers: { host: HOST, 'content-type': FORM, cookie },
    });
    assert.equal(res.status, 403);
    assert.equal(await count('sessions'), 1);
  });
});

describe('my chambers', () => {
  test('need a session: GET keeps the way back, POST goes to /login', async (t) => {
    const { app } = await found(t);
    const page = await get(app, '/account');
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/login?next=%2Faccount');
    const change = await post(app, '/account/password', passwordFields(PASSWORD, NEW_PASSWORD));
    assert.equal(change.status, 303);
    assert.equal(change.headers.get('location'), '/login');
    assert.equal(change.headers.get('set-cookie'), null);
    assert.equal(await verifyPassword(PASSWORD, await hashOf(1)), 'valid');
  });

  test('the administrator: login · хозяин двора, the form, the way out and back', async (t) => {
    const { app, cookie } = await found(t);
    const res = await get(app, '/account', { cookie });
    assert.equal(res.status, 200);
    const page = await res.text();
    for (const text of [
      '<a href="/">Двор</a>',
      'Мои покои',
      'owner · хозяин двора',
      'Сменить пароль',
      '<form method="post" action="/account/password">',
      'Текущий пароль',
      'name="current"',
      'Новый пароль',
      'name="password"',
      'Ещё раз',
      'name="password2"',
      'Не короче 15 символов. На других устройствах вы выйдете со двора.',
      '<form method="post" action="/logout">',
      'Покинуть двор',
      'на этом устройстве; всё во дворе останется на месте',
    ]) {
      assert.ok(page.includes(text), text);
    }
    assert.ok(!page.includes('Пароль сменён.'));
  });

  test('anyone else: only the login', async (t) => {
    const { app } = await found(t);
    const anna = await addSession(await addUser('anna'));
    const page = await (await get(app, '/account', { cookie: `__Host-hof=${anna}` })).text();
    assert.ok(page.includes('<p>anna</p>'));
    assert.ok(!page.includes('хозяин двора'));
  });

  test('done=password shows the message; any other done is ignored', async (t) => {
    const { app, cookie } = await found(t);
    const done = await (await get(app, '/account?done=password', { cookie })).text();
    assert.ok(done.includes('Пароль сменён.'));
    for (const path of ['/account?done=x', '/account?done=Password', '/account?created=1']) {
      const page = await (await get(app, path, { cookie })).text();
      assert.ok(!page.includes('Пароль сменён.'), path);
    }
  });

  test('the courtyard leads to my chambers', async (t) => {
    const { app, cookie } = await found(t);
    const page = await (await get(app, '/', { cookie })).text();
    assert.ok(page.includes('<a href="/account">Мои покои</a>'));
  });
});

describe('change of my password', () => {
  test('new hash, every old session ended, a new one for this browser', async (t) => {
    const { app, token, cookie, lines } = await found(t);
    const phone = await addSession(1);
    const anna = await addSession(await addUser('anna'));
    const { result: res, argon2 } = await countArgon2(() =>
      changePassword(app, cookie, passwordFields(PASSWORD, NEW_PASSWORD), {
        'x-real-ip': '203.0.113.7',
      }),
    );
    // One to check the current password, one to hash the new one.
    assert.equal(argon2, 2);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/account?done=password');
    const fresh = COOKIE.exec(res.headers.get('set-cookie') ?? '')?.[1];
    assert.ok(fresh);
    assert.notEqual(fresh, token);
    assert.deepEqual(await sessionTokens(token, phone, anna, fresh), {
      known: [anna, fresh],
      other: 0,
    });
    assert.equal(lines.at(-1), 'info password_changed user_id=1 username=owner ip=203.0.113.7');

    // This browser stays in with the new session; the old ones are gone.
    assert.equal((await get(app, '/account', { cookie: `__Host-hof=${fresh}` })).status, 200);
    for (const old of [token, phone]) {
      const res = await get(app, '/account', { cookie: `__Host-hof=${old}` });
      assert.equal(res.headers.get('location'), '/login?next=%2Faccount');
    }
    assert.equal((await get(app, '/', { cookie: `__Host-hof=${anna}` })).status, 200);

    // The old password no longer opens the gate, the new one does.
    assert.equal(await verifyPassword(PASSWORD, await hashOf(1)), 'wrong');
    assert.equal(await verifyPassword(NEW_PASSWORD, await hashOf(1)), 'valid');
    assert.equal((await signIn(app, 'owner', PASSWORD)).status, 400);
    assert.equal((await signIn(app, 'owner', NEW_PASSWORD)).status, 303);
  });

  test('a repeat typed in another Unicode form is the same password', async (t) => {
    const { app, cookie } = await found(t);
    const nfc = 'новый пароль: ёлка, йогурт и чай'.normalize('NFC');
    const res = await changePassword(app, cookie, {
      current: PASSWORD,
      password: nfc,
      password2: nfc.normalize('NFD'),
    });
    assert.equal(res.status, 303);
    assert.equal(await verifyPassword(nfc, await hashOf(1)), 'valid');
  });

  const refusals: [string, Record<string, string>, string, string, number][] = [
    // name, fields, field with the error, message, Argon2 computations
    [
      'wrong current password',
      passwordFields('a wrong password, long enough', NEW_PASSWORD),
      'current',
      'Текущий пароль не подходит.',
      1,
    ],
    [
      'current password over 256',
      passwordFields('x'.repeat(257), NEW_PASSWORD),
      'current',
      'Текущий пароль не подходит.',
      0,
    ],
    [
      'new password shorter than 15',
      passwordFields(PASSWORD, 'a'.repeat(14)),
      'password',
      'Пароль — от 15 до 256 символов.',
      0,
    ],
    [
      'new password over 256',
      passwordFields(PASSWORD, 'a'.repeat(257)),
      'password',
      'Пароль — от 15 до 256 символов.',
      0,
    ],
    [
      'repeat does not match',
      { current: PASSWORD, password: NEW_PASSWORD, password2: NEW_PASSWORD + '!' },
      'password2',
      'Пароли не совпадают.',
      0,
    ],
  ];
  for (const [name, fields, field, message, expectedArgon2] of refusals) {
    test(`${name}: 400 at «${field}», no password shown, nothing changed`, async (t) => {
      const { app, token, cookie } = await found(t);
      const phone = await addSession(1);
      const before = await hashOf(1);
      const { result: res, argon2 } = await countArgon2(() => changePassword(app, cookie, fields));
      assert.equal(argon2, expectedArgon2);
      assert.equal(res.status, 400);
      assert.equal(res.headers.get('set-cookie'), null);
      const page = await res.text();
      assert.ok(page.includes(`<p id="${field}-error">${message}</p>`), message);
      assert.match(page, new RegExp(`name="${field}"[^>]*aria-invalid="true"`));
      assert.equal((page.match(/aria-invalid/g) ?? []).length, 1);
      for (const typed of Object.values(fields)) {
        assert.ok(!page.includes(typed), `page shows ${typed}`);
      }
      assert.equal(await hashOf(1), before);
      assert.deepEqual(await sessionTokens(token, phone), { known: [token, phone], other: 0 });
    });
  }

  test('an unreadable current hash: the same 400, the event in the log without the hash', async (t) => {
    const { app, token, cookie, lines } = await found(t);
    await pool.query("UPDATE users SET password_hash = 'not an argon2 hash' WHERE id = 1");
    const logged = lines.length;
    const { result: res, argon2 } = await countArgon2(() =>
      changePassword(app, cookie, passwordFields(PASSWORD, NEW_PASSWORD)),
    );
    // The stored string is refused before Argon2, and no new hash is made.
    assert.equal(argon2, 0);
    assert.equal(res.status, 400);
    assert.ok((await res.text()).includes('<p id="current-error">Текущий пароль не подходит.</p>'));
    assert.deepEqual(lines.slice(logged), ['error password_hash_unreadable user_id=1']);
    assert.equal(await hashOf(1), 'not an argon2 hash');
    assert.deepEqual(await sessionTokens(token), { known: [token], other: 0 });
  });

  test('a failed transaction keeps the old hash and the old sessions', async (t) => {
    const { app, token, cookie } = await found(t);
    const phone = await addSession(1);
    // New sessions cannot be written: the transaction fails after the new hash is written and
    // the old sessions are deleted, before COMMIT.
    await pool.query('ALTER TABLE sessions ADD CONSTRAINT no_new_sessions CHECK (false) NOT VALID');
    try {
      const res = await changePassword(app, cookie, passwordFields(PASSWORD, NEW_PASSWORD));
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('set-cookie'), null);
    } finally {
      await pool.query('ALTER TABLE sessions DROP CONSTRAINT IF EXISTS no_new_sessions');
    }
    assert.equal(await verifyPassword(PASSWORD, await hashOf(1)), 'valid');
    assert.deepEqual(await sessionTokens(token, phone), { known: [token, phone], other: 0 });
    assert.equal((await get(app, '/account', { cookie })).status, 200);
  });
});

describe('change of my password racing a reset or a disable', () => {
  // The rival changes the row and holds the lock; the change has already checked the current
  // password and made the new hash, and waits on FOR UPDATE until the rival commits.
  async function race(t: TestContext, change: string) {
    const { app, token: ownerSession } = await found(t);
    const anna = await addUser('anna');
    const browser = await addSession(anna);
    const phone = await addSession(anna);
    const rival = await pool.connect();
    const counter = argon2Counter();
    try {
      await rival.query('BEGIN');
      await rival.query(change, [anna]);
      const pending = changePassword(
        app,
        `__Host-hof=${browser}`,
        passwordFields(PASSWORD, NEW_PASSWORD),
      );
      await waitForLock();
      // Both Argon2 computations are done before the transaction waits for the row.
      assert.equal(counter.started(), 2);
      await rival.query('COMMIT');
      const res = await pending;
      assert.equal(counter.started(), 2);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/login');
      assert.equal(res.headers.get('set-cookie'), null);
    } finally {
      counter.stop();
      rival.release();
    }
    // ROLLBACK: the sessions are not this request's to delete, and no new one was made.
    assert.deepEqual(await sessionTokens(ownerSession, browser, phone), {
      known: [ownerSession, browser, phone],
      other: 0,
    });
    return anna;
  }

  test('the hash changed: /login, the rival’s hash stays', async (t) => {
    const otherHash = await hashPassword('another password for anna');
    const anna = await race(t, `UPDATE users SET password_hash = '${otherHash}' WHERE id = $1`);
    assert.equal(await hashOf(anna), otherHash);
  });

  test('the user was disabled: /login, the password unchanged', async (t) => {
    const anna = await race(t, 'UPDATE users SET is_disabled = true WHERE id = $1');
    assert.equal(await hashOf(anna), PASSWORD_HASH);
  });
});

describe('log audit, M2–M3', () => {
  test('setup, sign-in, failed sign-in, password change, sign-out: no secret in any line', async (t) => {
    const { app, key, lines } = await boot(t);
    const secrets: string[] = [];
    const remember = (...values: string[]) => secrets.push(...values);
    const tokenOf = (res: Response) => {
      const token = COOKIE.exec(res.headers.get('set-cookie') ?? '')?.[1];
      assert.ok(token, 'no session cookie');
      remember(token, hashSessionToken(token).toString('hex'));
      return token;
    };
    // A stored hash and its parts: the whole PHC string, the salt, the hash.
    const rememberHash = async () => {
      const phc = await hashOf(1);
      remember(phc, ...phc.split('$').slice(-2));
    };

    // The gate key: the right one, a wrong one, both as typed and without hyphens.
    const wrongKey = 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ';
    remember(key, key.replaceAll('-', ''), wrongKey, wrongKey.replaceAll('-', ''));
    // Logins that look like secrets: people type passwords into the login field.
    const unknownLogins = ['s3cr3t.typed-as-login', 'My Secret Pass Phrase'];
    const typed = ['too short', 'any password at all', 'a wrong password, long enough'];
    remember(PASSWORD, NEW_PASSWORD, ...unknownLogins, ...typed);

    // Setup: a wrong key, a short password, then the founding.
    await post(app, '/setup', setupFields(wrongKey));
    await post(app, '/setup', { ...setupFields(key), password: typed[0]!, password2: typed[0]! });
    const founded = tokenOf(await post(app, '/setup', setupFields(key)));
    await rememberHash();
    // Sign-in: unknown logins, a wrong password, then a success replacing the founding session.
    for (const login of unknownLogins) await signIn(app, login, typed[1]!);
    await signIn(app, 'owner', typed[2]!);
    const signedIn = tokenOf(
      await signIn(app, 'owner', PASSWORD, { cookie: `__Host-hof=${founded}` }),
    );
    // Password change, then sign-out.
    const changed = tokenOf(
      await changePassword(app, `__Host-hof=${signedIn}`, passwordFields(PASSWORD, NEW_PASSWORD)),
    );
    await rememberHash();
    await post(app, '/logout', {}, { cookie: `__Host-hof=${changed}` });

    // The key appears in one place only: the line that announces it at startup.
    assert.equal(lines[0], `info gate_key key=${key}`);
    // Every other line, exactly: identifiers of the existing user are allowed, nothing else.
    assert.deepEqual(lines.slice(1), [
      'warn gate_key_rejected ip=-',
      'info court_founded user_id=1 username=owner ip=-',
      'warn login_failed reason=unknown_user ip=-',
      'warn login_failed reason=unknown_user ip=-',
      'warn login_failed user_id=1 username=owner ip=- reason=wrong_password',
      'info login user_id=1 username=owner ip=-',
      'info password_changed user_id=1 username=owner ip=-',
    ]);
    for (const line of lines.slice(1)) {
      for (const secret of secrets) {
        assert.ok(!line.includes(secret), `log line «${line}» contains ${secret}`);
      }
      assert.ok(!line.includes('$argon2id'), line);
    }
  });
});

// «Приближённые» (M4): what the administrator types for a new user.
function newUserFields(username: string, initial = NEW_PASSWORD) {
  return { username, password: initial };
}

function acceptUser(app: App, cookie: string, fields: Record<string, string>, headers = {}) {
  return post(app, '/admin/users', fields, { cookie, ...headers });
}

async function userRow(username: string) {
  const { rows } = await pool.query<{
    id: number;
    password_hash: string;
    is_admin: boolean;
    is_disabled: boolean;
  }>('SELECT id, password_hash, is_admin, is_disabled FROM users WHERE username = $1', [username]);
  return rows;
}

const FORBIDDEN_H1 = '<h1>Сюда только хозяину</h1>';
const NOT_FOUND_H1 = '<h1>Такой тропы во дворе нет</h1>';

describe('the pages of the administrator: who gets in', () => {
  test('no session: GET and HEAD keep the way back, POST goes to /login, nobody is added', async (t) => {
    const { app, lines } = await found(t);
    const disabled = await addSession(await addUser('anna', PASSWORD_HASH, true));
    const logged = lines.length;
    for (const cookie of [
      undefined,
      '__Host-hof=not-a-token',
      `__Host-hof=${newSessionToken()}`,
      `__Host-hof=${disabled}`,
    ]) {
      const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
      const name = cookie ?? 'no cookie';
      const page = await get(app, '/admin/users?created=2', headers);
      assert.equal(page.status, 303, name);
      assert.equal(page.headers.get('location'), '/login?next=%2Fadmin%2Fusers%3Fcreated%3D2');
      const head = await app.request('/admin/users', {
        method: 'HEAD',
        headers: { host: HOST, ...headers },
      });
      assert.equal(head.status, 303, name);
      assert.equal(head.headers.get('location'), '/login?next=%2Fadmin%2Fusers');
      const { result: accept, argon2 } = await countArgon2(() =>
        post(app, '/admin/users', newUserFields('boris'), headers),
      );
      assert.equal(argon2, 0, name);
      assert.equal(accept.status, 303, name);
      assert.equal(accept.headers.get('location'), '/login', name);
    }
    assert.equal(await count('users'), 2);
    assert.deepEqual(lines.slice(logged), []);
  });

  test('a user who is not the administrator: 403 on GET, HEAD and POST, nothing written, no Argon2', async (t) => {
    const { app, lines } = await found(t);
    const anna = `__Host-hof=${await addSession(await addUser('anna'))}`;
    const logged = lines.length;
    const page = await get(app, '/admin/users', { cookie: anna });
    assert.equal(page.status, 403);
    const head = await app.request('/admin/users', {
      method: 'HEAD',
      headers: { host: HOST, cookie: anna },
    });
    assert.equal(head.status, 403);
    assert.equal(await head.text(), '');
    for (const fields of [newUserFields('boris'), newUserFields('', ''), { anything: 'else' }]) {
      const { result: res, argon2 } = await countArgon2(() => acceptUser(app, anna, fields));
      assert.equal(argon2, 0);
      assert.equal(res.status, 403);
      assert.ok((await res.text()).includes(FORBIDDEN_H1));
    }
    assert.equal(await count('users'), 2);
    assert.deepEqual(await userRow('boris'), []);
    // Neither the refusal nor the form is written to the log.
    assert.deepEqual(lines.slice(logged), []);
  });

  test('the 403 page: its texts, the common headers, nothing from the request', async (t) => {
    const { app } = await found(t);
    const anna = `__Host-hof=${await addSession(await addUser('anna'))}`;
    const plain = await get(app, '/admin/users', { cookie: anna });
    const loaded = await get(
      app,
      '/admin/users?created=2&next=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      {
        cookie: anna,
        'x-real-ip': '203.0.113.7',
      },
    );
    for (const res of [plain, loaded]) {
      assert.equal(res.status, 403);
      assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('content-security-policy') ?? '', /^default-src 'none'/);
    }
    const page = await plain.text();
    for (const text of [
      '<title>Сюда только хозяину</title>',
      FORBIDDEN_H1,
      '<p>Это место двора открыто только хозяину. Если нужно, попросите его.</p>',
      '<a href="/">Во двор</a>',
    ]) {
      assert.ok(page.includes(text), text);
    }
    // The same page whatever the request carried: no login, no query, no address.
    assert.equal(await loaded.text(), page);
    for (const absent of ['anna', 'script', 'created', '203.0.113.7', 'admin']) {
      assert.ok(!page.includes(absent), absent);
    }
  });

  test('the administrator gets in', async (t) => {
    const { app, cookie } = await found(t);
    assert.equal((await get(app, '/admin/users', { cookie })).status, 200);
    const head = await app.request('/admin/users', {
      method: 'HEAD',
      headers: { host: HOST, cookie },
    });
    assert.equal(head.status, 200);
  });

  test('any other /admin/… address: the common 404 for a guest, a user and the administrator', async (t) => {
    const { app, cookie } = await found(t);
    const anna = `__Host-hof=${await addSession(await addUser('anna'))}`;
    for (const [who, headers] of [
      ['guest', {}],
      ['user', { cookie: anna }],
      ['administrator', { cookie }],
    ] as const) {
      for (const path of ['/admin', '/admin/', '/admin/users/', '/admin/foo', '/admin/users/x/y']) {
        for (const res of [
          await get(app, path, headers),
          await post(app, path, newUserFields('boris'), headers),
        ]) {
          const name = `${who} ${path}`;
          assert.equal(res.status, 404, name);
          assert.ok((await res.text()).includes(NOT_FOUND_H1), name);
        }
      }
    }
    assert.equal(await count('users'), 2);
  });

  test('the way to Приближённые: from the courtyard and my chambers, for the administrator only', async (t) => {
    const { app, cookie } = await found(t);
    const anna = `__Host-hof=${await addSession(await addUser('anna'))}`;
    for (const path of ['/', '/account']) {
      const own = await (await get(app, path, { cookie })).text();
      assert.ok(own.includes('<a href="/admin/users">Приближённые</a>'), path);
      const other = await (await get(app, path, { cookie: anna })).text();
      assert.ok(!other.includes('Приближённые'), path);
    }
  });
});

describe('Приближённые', () => {
  test('only the administrator: the empty state and the form', async (t) => {
    const { app, cookie } = await found(t);
    const res = await get(app, '/admin/users', { cookie });
    assert.equal(res.status, 200);
    const page = await res.text();
    for (const text of [
      '<title>Hof — приближённые</title>',
      '<a href="/">Двор</a>',
      '<a href="/account">Мои покои</a>',
      '<h1>Приближённые</h1>',
      '<h2>Пока у двора только хозяин</h2>',
      'На ключнице один ключ — ваш. Примите ко двору семью или друзей: у каждого будет свой',
      'ключ и свои мешки.',
      '<h2>Принять ко двору</h2>',
      '<form method="post" action="/admin/users">',
      '<label for="username">Логин</label>',
      '<label for="password">Начальный пароль</label>',
      'Пароль виден, чтобы его можно было передать. Человек сменит его в своих покоях.',
      '<button type="submit">Принять</button>',
    ]) {
      assert.ok(page.includes(text), text);
    }
    // Both fields are plain text without autofill; the password is shown while it is typed.
    assert.match(page, /name="username"\s+type="text"\s+autocomplete="off"/);
    assert.match(page, /name="password"\s+type="text"\s+autocomplete="off"/);
    assert.ok(!page.includes('<a href="/admin/users">'), 'no link to the page itself');
    assert.ok(!page.includes('<li>'));
    assert.ok(!page.includes('хозяин, это вы'));
  });

  test('everyone: the administrator first and without a link, the others by login', async (t) => {
    const { app, cookie } = await found(t);
    await addUser('zoe');
    await addUser('anna', PASSWORD_HASH, true);
    await addUser('boris');
    const page = await (await get(app, '/admin/users', { cookie })).text();
    const items = [...page.matchAll(/<li>\s*([\s\S]*?)\s*<\/li>/g)].map((m) =>
      m[1]!.replace(/\s+/g, ' '),
    );
    // Each person has a way to their card; the administrator has none.
    assert.deepEqual(items, [
      'owner · хозяин, это вы',
      'anna · Ключ взят <a href="/admin/users/3">Открыть ›</a>',
      'boris · С ключом <a href="/admin/users/4">Открыть ›</a>',
      'zoe · С ключом <a href="/admin/users/2">Открыть ›</a>',
    ]);
    assert.ok(!page.includes('href="/admin/users/1"'));
    assert.ok(!page.includes('Пока у двора только хозяин'));
  });
});

describe('Принять ко двору', () => {
  test('a new user: 303 with created, an enabled ordinary row, the password works, the log line', async (t) => {
    const { app, token, cookie, lines } = await found(t);
    const { result: res, argon2 } = await countArgon2(() =>
      acceptUser(app, cookie, newUserFields(' Anna '), { 'x-real-ip': '203.0.113.7' }),
    );
    assert.equal(argon2, 1);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin/users?created=2');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(
      lines.at(-1),
      'info user_created user_id=2 username=anna admin_id=1 ip=203.0.113.7',
    );

    const [row] = await userRow('anna');
    assert.ok(row);
    assert.equal(row.id, 2);
    assert.equal(row.is_admin, false);
    assert.equal(row.is_disabled, false);
    assert.equal(await verifyPassword(NEW_PASSWORD, row.password_hash), 'valid');
    assert.ok(!lines.at(-1)!.includes(NEW_PASSWORD));
    assert.ok(!lines.at(-1)!.includes(row.password_hash.split('$').at(-1)!));
    // The administrator stays signed in with the same session.
    assert.deepEqual(await sessionTokens(token), { known: [token], other: 0 });

    const page = await (await get(app, '/admin/users?created=2', { cookie })).text();
    assert.ok(
      page.includes('<p>Ключ для anna готов. Передайте логин и начальный пароль лично.</p>'),
    );
    assert.ok(page.replace(/\s+/g, ' ').includes('anna · С ключом'));
    assert.ok(!page.includes(NEW_PASSWORD));

    // The new person signs in with the initial password.
    const signedIn = await signIn(app, 'anna', NEW_PASSWORD);
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.get('location'), '/');
  });

  test('created: only the plain id of an ordinary user in the list, anything else is ignored', async (t) => {
    const { app, cookie } = await found(t);
    await addUser('anna');
    const message = 'готов. Передайте логин и начальный пароль лично.';
    const shown = await (await get(app, '/admin/users?created=2', { cookie })).text();
    assert.ok(shown.includes(`Ключ для anna ${message}`));
    for (const created of ['1', '3', '02', '2.0', ' 2', '2 ', '-2', 'abc', '', '2147483648']) {
      const path = `/admin/users?created=${encodeURIComponent(created)}`;
      const page = await (await get(app, path, { cookie })).text();
      assert.ok(!page.includes(message), JSON.stringify(created));
    }
    const other = await (await get(app, '/admin/users?done=password', { cookie })).text();
    assert.ok(!other.includes(message));
  });

  const refusals: [string, Record<string, string>, 'username' | 'password', string, number][] = [
    // name, fields, field with the error, message, Argon2 computations
    [
      'a login of the wrong form',
      newUserFields('<b>anna</b>'),
      'username',
      'Логин: латиница, цифры, точка, дефис и подчёркивание, до 32 символов, первый символ — буква или цифра.',
      0,
    ],
    [
      'no login',
      newUserFields(''),
      'username',
      'Логин: латиница, цифры, точка, дефис и подчёркивание, до 32 символов, первый символ — буква или цифра.',
      0,
    ],
    [
      'a password shorter than 15',
      newUserFields('boris', 'a'.repeat(14)),
      'password',
      'Пароль — от 15 до 256 символов.',
      0,
    ],
    [
      'a password over 256',
      newUserFields('boris', 'a'.repeat(257)),
      'password',
      'Пароль — от 15 до 256 символов.',
      0,
    ],
    ['a taken login', newUserFields('anna'), 'username', 'Логин занят.', 1],
    ['a taken login in capitals', newUserFields(' ANNA '), 'username', 'Логин занят.', 1],
    ['the login of the administrator', newUserFields('owner'), 'username', 'Логин занят.', 1],
  ];
  for (const [name, fields, field, message, expectedArgon2] of refusals) {
    test(`${name}: 400 at «${field}», the login kept, no password shown, nobody added`, async (t) => {
      const { app, cookie, lines } = await found(t);
      await addUser('anna');
      const logged = lines.length;
      const { result: res, argon2 } = await countArgon2(() => acceptUser(app, cookie, fields));
      assert.equal(argon2, expectedArgon2);
      assert.equal(res.status, 400);
      const page = await res.text();
      assert.ok(page.includes(`<p id="${field}-error">${message}</p>`), message);
      assert.match(page, new RegExp(`name="${field}"[^>]*aria-invalid="true"`));
      assert.equal((page.match(/aria-invalid/g) ?? []).length, 1);
      // The login as typed, escaped; the password never.
      const escaped = fields.username!.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      assert.ok(page.includes(`value="${escaped}"`), escaped);
      assert.ok(!page.includes('<b>anna</b>'));
      assert.ok(!page.includes(fields.password!), 'page shows the password');
      // The same page: the list is there.
      assert.ok(page.replace(/\s+/g, ' ').includes('anna · С ключом'));
      assert.equal(await count('users'), 2);
      assert.deepEqual(lines.slice(logged), []);
    });
  }

  test('one login from two places at once: the second INSERT waits, then «Логин занят.»', async (t) => {
    const { app, cookie } = await found(t);
    const rival = await pool.connect();
    try {
      await rival.query('BEGIN');
      await rival.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [
        'anna',
        PASSWORD_HASH,
      ]);
      const pending = acceptUser(app, cookie, newUserFields('anna'));
      await waitForLock();
      // It is the INSERT that waits: on the unique index, for the rival's transaction.
      const { rows } = await pool.query<{ query: string }>(
        "SELECT query FROM pg_stat_activity WHERE datname = 'hof_test' AND wait_event_type = 'Lock'",
      );
      assert.equal(rows.length, 1);
      assert.match(rows[0]!.query, /^INSERT INTO users \(username, password_hash\)/);
      await rival.query('COMMIT');
      const res = await pending;
      assert.equal(res.status, 400);
      assert.ok((await res.text()).includes('<p id="username-error">Логин занят.</p>'));
    } finally {
      rival.release();
    }
    const rows = await userRow('anna');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.password_hash, PASSWORD_HASH);
  });

  test('any other refusal of the database is unexpected: 500, not «Логин занят.»', async (t) => {
    const { app, cookie, lines } = await found(t);
    for (const [name, add, drop] of [
      [
        'another unique index',
        'CREATE UNIQUE INDEX users_one_row ON users ((true))',
        'DROP INDEX IF EXISTS users_one_row',
      ],
      [
        'a check',
        'ALTER TABLE users ADD CONSTRAINT no_new_users CHECK (false) NOT VALID',
        'ALTER TABLE users DROP CONSTRAINT IF EXISTS no_new_users',
      ],
    ] as const) {
      await pool.query(add);
      try {
        const logged = lines.length;
        const res = await acceptUser(app, cookie, newUserFields('anna'));
        assert.equal(res.status, 500, name);
        const page = await res.text();
        assert.ok(page.includes('Во дворе что-то стряслось'), name);
        assert.ok(!page.includes('Логин занят.'), name);
        assert.equal(lines.length, logged + 1, name);
        assert.match(
          lines.at(-1)!,
          /^error unexpected_error method=POST path=\/admin\/users /,
          name,
        );
      } finally {
        await pool.query(drop);
      }
    }
    assert.equal(await count('users'), 1);
  });
});

// The card of a person (M4.2): the reset form, sent as the administrator types it.
function resetFor(
  app: App,
  cookie: string,
  id: number | string,
  typed: string,
  headers: Record<string, string> = {},
) {
  return post(app, `/admin/users/${id}/password`, { password: typed }, { cookie, ...headers });
}

// The query of hof_test that waits for a lock, once there is one.
async function waitingQuery(): Promise<string> {
  await waitForLock();
  const { rows } = await pool.query<{ query: string }>(
    "SELECT query FROM pg_stat_activity WHERE datname = 'hof_test' AND wait_event_type = 'Lock'",
  );
  assert.equal(rows.length, 1);
  return rows[0]!.query;
}

const RESET_MESSAGE = '<p>Пароль для anna сброшен. Передайте новый пароль лично.</p>';

describe('the card of a person: who gets in', () => {
  test('no session: GET keeps the way back, POST goes to /login, nothing changed, no Argon2', async (t) => {
    const { app } = await found(t);
    const anna = await addUser('anna');
    const annaSession = await addSession(anna);
    // A wrong :id is still the address of a known route: the session is asked for first.
    for (const path of [
      '/admin/users/2',
      '/admin/users/1',
      '/admin/users/abc',
      '/admin/users/99',
    ]) {
      const res = await get(app, path);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(path)}`);
    }
    for (const id of ['2', 'abc']) {
      const { result: res, argon2 } = await countArgon2(() =>
        post(app, `/admin/users/${id}/password`, { password: NEW_PASSWORD }),
      );
      assert.equal(argon2, 0, id);
      assert.equal(res.status, 303, id);
      assert.equal(res.headers.get('location'), '/login', id);
    }
    assert.equal(await hashOf(anna), PASSWORD_HASH);
    // anna's session and the administrator's from the founding.
    assert.deepEqual(await sessionTokens(annaSession), { known: [annaSession], other: 1 });
  });

  test('a user who is not the administrator: one and the same 403 for any id, no Argon2', async (t) => {
    const { app } = await found(t);
    const anna = await addUser('anna');
    const annaSession = await addSession(anna);
    const boris = `__Host-hof=${await addSession(await addUser('boris'))}`;
    const forbidden = await (await get(app, '/admin/users', { cookie: boris })).text();
    assert.ok(forbidden.includes(FORBIDDEN_H1));
    // anna, boris himself, the administrator, nobody, and ids of the wrong form: the answer does
    // not tell which of them exists.
    for (const id of ['2', '3', '1', '99', '0', '01', 'abc', '2147483648']) {
      const page = await get(app, `/admin/users/${id}`, { cookie: boris });
      assert.equal(page.status, 403, id);
      assert.equal(await page.text(), forbidden, id);
      const { result: reset, argon2 } = await countArgon2(() =>
        resetFor(app, boris, id, NEW_PASSWORD),
      );
      assert.equal(argon2, 0, id);
      assert.equal(reset.status, 403, id);
      assert.equal(await reset.text(), forbidden, id);
    }
    assert.equal(await hashOf(anna), PASSWORD_HASH);
    assert.deepEqual(await sessionTokens(annaSession), { known: [annaSession], other: 2 });
  });

  test('other addresses around a card: the common 404 for a guest, a user and the administrator', async (t) => {
    const { app, cookie } = await found(t);
    await addUser('anna');
    const boris = `__Host-hof=${await addSession(await addUser('boris'))}`;
    for (const [who, headers] of [
      ['guest', {}],
      ['user', { cookie: boris }],
      ['administrator', { cookie }],
    ] as const) {
      for (const path of ['/admin/users/2/', '/admin/users/2/foo', '/admin/users/2/password/x']) {
        for (const res of [
          await get(app, path, headers),
          await post(app, path, { password: NEW_PASSWORD }, headers),
        ]) {
          assert.equal(res.status, 404, `${who} ${path}`);
          assert.ok((await res.text()).includes(NOT_FOUND_H1), `${who} ${path}`);
        }
      }
    }
    // The administrator on a known address with a method it does not have.
    for (const res of [
      await get(app, '/admin/users/2/password', { cookie }),
      await post(app, '/admin/users/2', { password: NEW_PASSWORD }, { cookie }),
    ]) {
      assert.equal(res.status, 404);
    }
    assert.equal(await hashOf(2), PASSWORD_HASH);
  });
});

describe('the card of a person', () => {
  test('the person, their key, the reset form, the way back', async (t) => {
    const { app, cookie } = await found(t);
    await addUser('anna');
    const res = await get(app, '/admin/users/2', { cookie });
    assert.equal(res.status, 200);
    const page = await res.text();
    for (const text of [
      '<title>Hof — anna</title>',
      '<a href="/">Двор</a>',
      '<a href="/account">Мои покои</a>',
      '<p><a href="/admin/users">Приближённые</a></p>',
      '<h1>anna</h1>',
      '<p>С ключом</p>',
      '<h2>Сбросить пароль</h2>',
      '<form method="post" action="/admin/users/2/password">',
      '<label for="password">Новый начальный пароль</label>',
      'anna выйдет со двора на всех устройствах. Передайте новый пароль лично.',
      '<button type="submit">Сбросить пароль</button>',
    ]) {
      assert.ok(page.includes(text), text);
    }
    // Plain text without autofill: the administrator sees what is typed. No repeat field.
    assert.match(page, /name="password"\s+type="text"\s+autocomplete="off"/);
    assert.equal((page.match(/<input/g) ?? []).length, 1);
    assert.ok(!page.includes('сброшен'));
    // Only the reset for now: the key block comes with M4.3.
    assert.ok(!page.includes('Забрать ключ'));
  });

  test('a disabled person: «Ключ взят»', async (t) => {
    const { app, cookie } = await found(t);
    await addUser('anna', PASSWORD_HASH, true);
    const page = await (await get(app, '/admin/users/2', { cookie })).text();
    assert.ok(page.includes('<p>Ключ взят</p>'));
    assert.ok(!page.includes('С ключом'));
  });

  test('done=password shows the message; any other done is ignored', async (t) => {
    const { app, cookie } = await found(t);
    await addUser('anna');
    const done = await (await get(app, '/admin/users/2?done=password', { cookie })).text();
    assert.ok(done.includes(RESET_MESSAGE));
    for (const query of ['?done=x', '?done=Password', '?created=2', '']) {
      const page = await (await get(app, `/admin/users/2${query}`, { cookie })).text();
      assert.ok(!page.includes('сброшен'), query);
    }
  });

  test('a wrong id, nobody, or the administrator: the common 404, no Argon2, nothing changed', async (t) => {
    const { app, cookie } = await found(t);
    const anna = await addUser('anna');
    const annaSession = await addSession(anna);
    const owner = await hashOf(1);
    for (const id of [
      '0',
      '-1',
      '01',
      '02',
      '2.0',
      '+2',
      '0x2',
      'abc',
      '%20',
      '2147483648',
      '9999999999',
      '99999999999',
      '2147483647',
      '99',
      '1',
    ]) {
      const page = await get(app, `/admin/users/${id}`, { cookie });
      assert.equal(page.status, 404, id);
      assert.ok((await page.text()).includes(NOT_FOUND_H1), id);
      const { result: reset, argon2 } = await countArgon2(() =>
        resetFor(app, cookie, id, NEW_PASSWORD),
      );
      assert.equal(reset.status, 404, id);
      assert.equal(argon2, 0, id);
    }
    assert.equal(await hashOf(anna), PASSWORD_HASH);
    assert.equal(await hashOf(1), owner);
    assert.deepEqual(await sessionTokens(annaSession), { known: [annaSession], other: 1 });
  });

  test('a login is escaped wherever it is shown', async (t) => {
    const { app, cookie } = await found(t);
    const login = '<i>x</i>&amp;';
    // The CHECK on users.username lets no markup in; it is dropped for this test only.
    await pool.query('ALTER TABLE users DROP CONSTRAINT users_username_format');
    try {
      const id = await addUser(login);
      for (const res of [
        await get(app, `/admin/users/${id}`, { cookie }),
        await get(app, `/admin/users/${id}?done=password`, { cookie }),
        await resetFor(app, cookie, id, 'too short'),
        await get(app, '/admin/users', { cookie }),
      ]) {
        const page = await res.text();
        assert.ok(page.includes('&lt;i&gt;x&lt;/i&gt;&amp;amp;'), page);
        assert.ok(!page.includes('<i>'), page);
      }
    } finally {
      await pool.query("DELETE FROM users WHERE username !~ '^[a-z0-9][a-z0-9._-]{0,31}$'");
      await pool.query(
        "ALTER TABLE users ADD CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9][a-z0-9._-]{0,31}$')",
      );
    }
  });
});

describe('reset of a password by the administrator', () => {
  test('a new hash, every session of the person ended and no new one, the others stay', async (t) => {
    const { app, token: ownerSession, cookie, lines } = await found(t);
    const anna = await addUser('anna');
    const boris = await addUser('boris');
    const annaBrowser = await addSession(anna);
    const annaPhone = await addSession(anna);
    const borisSession = await addSession(boris);
    const logged = lines.length;

    const { result: res, argon2 } = await countArgon2(() =>
      resetFor(app, cookie, anna, NEW_PASSWORD, { 'x-real-ip': '203.0.113.7' }),
    );
    assert.equal(argon2, 1);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin/users/2?done=password');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.deepEqual(lines.slice(logged), [
      'info password_reset user_id=2 username=anna by=admin admin_id=1 ip=203.0.113.7',
    ]);

    // Both sessions of anna are gone and none was made for her; the administrator and boris
    // keep theirs.
    assert.deepEqual(await sessionTokens(ownerSession, annaBrowser, annaPhone, borisSession), {
      known: [ownerSession, borisSession],
      other: 0,
    });
    for (const old of [annaBrowser, annaPhone]) {
      const away = await get(app, '/', { cookie: `__Host-hof=${old}` });
      assert.equal(away.headers.get('location'), '/login?next=%2F');
    }
    assert.equal((await get(app, '/', { cookie: `__Host-hof=${borisSession}` })).status, 200);
    assert.equal((await get(app, '/admin/users', { cookie })).status, 200);

    // The new password opens the gate, the old one does not; nothing else of anna changed.
    const [row] = await userRow('anna');
    assert.ok(row);
    assert.equal(row.is_disabled, false);
    assert.equal(row.is_admin, false);
    assert.equal(await verifyPassword(NEW_PASSWORD, row.password_hash), 'valid');
    assert.equal(await verifyPassword(PASSWORD, row.password_hash), 'wrong');
    assert.equal(await hashOf(boris), PASSWORD_HASH);

    // After the redirect: the message, once more only as a page.
    const page = await (await get(app, res.headers.get('location')!, { cookie })).text();
    assert.ok(page.includes(RESET_MESSAGE));
    assert.equal(await hashOf(anna), row.password_hash);

    assert.equal((await signIn(app, 'anna', PASSWORD)).status, 400);
    assert.equal((await signIn(app, 'anna', NEW_PASSWORD)).status, 303);

    // No password and no hash in the answers or in any log line.
    const secrets = [NEW_PASSWORD, row.password_hash, ...row.password_hash.split('$').slice(-2)];
    for (const text of [await res.text(), res.headers.get('location')!, page, ...lines]) {
      for (const secret of secrets) assert.ok(!text.includes(secret), `«${text}» has ${secret}`);
    }
  });

  test('a disabled person gets the new password, stays disabled, has no session', async (t) => {
    const { app, cookie, lines } = await found(t);
    const anna = await addUser('anna', PASSWORD_HASH, true);
    // A row a disabled user should not have; the reset ends it all the same.
    const stale = await addSession(anna);
    const res = await resetFor(app, cookie, anna, NEW_PASSWORD);
    assert.equal(res.status, 303);
    const [row] = await userRow('anna');
    assert.ok(row);
    assert.equal(row.is_disabled, true);
    assert.equal(await verifyPassword(NEW_PASSWORD, row.password_hash), 'valid');
    assert.deepEqual(await sessionTokens(stale), { known: [], other: 1 });
    // The new password alone does not let a disabled person in.
    assert.equal((await signIn(app, 'anna', NEW_PASSWORD)).status, 400);
    assert.equal(lines.at(-1), 'warn login_failed user_id=2 username=anna ip=- reason=disabled');
  });

  const refusals: [string, Record<string, string>][] = [
    ['a password shorter than 15', { password: 'a'.repeat(14) }],
    ['a password over 256', { password: 'b'.repeat(257) }],
    ['no password field', {}],
  ];
  for (const [name, fields] of refusals) {
    test(`${name}: 400 on the card, no password shown, nothing changed, no Argon2`, async (t) => {
      const { app, cookie, lines } = await found(t);
      const anna = await addUser('anna');
      const annaSession = await addSession(anna);
      const logged = lines.length;
      const { result: res, argon2 } = await countArgon2(() =>
        post(app, '/admin/users/2/password', fields, { cookie }),
      );
      assert.equal(argon2, 0);
      assert.equal(res.status, 400);
      const page = await res.text();
      assert.ok(page.includes('<h1>anna</h1>'));
      assert.ok(page.includes('<p id="password-error">Пароль — от 15 до 256 символов.</p>'));
      assert.match(page, /name="password"[^>]*aria-invalid="true"/);
      if (fields.password !== undefined) assert.ok(!page.includes(fields.password));
      assert.ok(!page.includes('сброшен'));
      assert.equal(await hashOf(anna), PASSWORD_HASH);
      assert.deepEqual(await sessionTokens(annaSession), { known: [annaSession], other: 1 });
      assert.deepEqual(lines.slice(logged), []);
    });
  }

  test('the transaction fails after UPDATE: 500, the old hash and sessions stay, no log line', async (t) => {
    const { app, cookie, lines } = await found(t);
    const anna = await addUser('anna');
    const annaSession = await addSession(anna);
    // DELETE FROM sessions is refused by the database, after UPDATE users went through. Sessions
    // are still read, so the session of the administrator works.
    await pool.query(
      "CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$",
    );
    await pool.query(
      'CREATE TRIGGER sessions_no_delete BEFORE DELETE ON sessions FOR EACH STATEMENT EXECUTE FUNCTION refuse_for_test()',
    );
    try {
      const res = await resetFor(app, cookie, anna, NEW_PASSWORD);
      assert.equal(res.status, 500);
      const page = await res.text();
      assert.ok(page.includes('Во дворе что-то стряслось'));
      assert.ok(!page.includes(NEW_PASSWORD));
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS sessions_no_delete ON sessions');
      await pool.query('DROP FUNCTION IF EXISTS refuse_for_test()');
    }
    assert.equal(await hashOf(anna), PASSWORD_HASH);
    assert.deepEqual(await sessionTokens(annaSession), { known: [annaSession], other: 1 });
    assert.match(
      lines.at(-1)!,
      /^error unexpected_error method=POST path=\/admin\/users\/2\/password error="refused for the test" /,
    );
    assert.ok(!lines.some((line) => line.includes('password_reset')));
    assert.ok(!lines.some((line) => line.includes(NEW_PASSWORD)));
  });
});

describe('reset by the administrator racing a sign-in', () => {
  test('the sign-in is halfway: the reset waits on UPDATE, then ends the new session', async (t) => {
    const { app, token: ownerSession, cookie } = await found(t);
    const anna = await addUser('anna');
    // POST /login in the middle of its transaction: the row locked with FOR UPDATE, its new
    // session written, no COMMIT yet.
    const signingIn = await pool.connect();
    let annaToken: string;
    try {
      await signingIn.query('BEGIN');
      await signingIn.query(
        'SELECT password_hash, is_disabled FROM users WHERE id = $1 FOR UPDATE',
        [anna],
      );
      annaToken = await createSession(signingIn, anna);
      const pending = resetFor(app, cookie, anna, NEW_PASSWORD);
      // The reset waits for the row before it deletes anything.
      assert.match(await waitingQuery(), /^UPDATE users SET password_hash/);
      await signingIn.query('COMMIT');
      const res = await pending;
      assert.equal(res.status, 303);
    } finally {
      signingIn.release();
    }
    // The session of that sign-in did not outlive the reset.
    assert.deepEqual(await sessionTokens(ownerSession, annaToken), {
      known: [ownerSession],
      other: 0,
    });
    const away = await get(app, '/', { cookie: `__Host-hof=${annaToken}` });
    assert.equal(away.headers.get('location'), '/login?next=%2F');
    assert.equal(await verifyPassword(NEW_PASSWORD, await hashOf(anna)), 'valid');
  });

  test('the reset goes first: a sign-in with the old password waits behind it, then fails', async (t) => {
    const { app, token: ownerSession, cookie, lines } = await found(t);
    const anna = await addUser('anna');
    // Something holds the row, so both line up for it: the reset first, then the sign-in, which
    // has already checked the old password with Argon2.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [anna]);
      const reset = resetFor(app, cookie, anna, NEW_PASSWORD);
      await waitForLock(1);
      const login = signIn(app, 'anna', PASSWORD);
      await waitForLock(2);
      await holder.query('COMMIT');
      assert.equal((await reset).status, 303);
      const refused = await login;
      assert.equal(refused.status, 400);
      assert.equal(refused.headers.get('set-cookie'), null);
    } finally {
      holder.release();
    }
    assert.ok(
      lines.includes('warn login_failed user_id=2 username=anna ip=- reason=password_changed'),
    );
    assert.deepEqual(await sessionTokens(ownerSession), { known: [ownerSession], other: 0 });
    assert.equal((await signIn(app, 'anna', NEW_PASSWORD)).status, 303);
  });
});
