// main.ts: common request checks — Origin (§4.6), POST body (§4.7), response headers (§4.9) —,
// the common 404 and 500 pages with the unexpected_error log line (§4.1, §4.10), Säckel in the
// court (§2), and the failures that stop the server before it opens the HTTP port.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { DatabaseError, Pool } from 'pg';
import type { FirstRun } from './core/gate-key.ts';
import { hashSessionToken, newSessionToken } from './core/sessions.ts';
import { applicationUser, createApp } from './main.ts';
import { migrate } from './migrate.ts';
import { otherRecordedCurrency } from './saeckel/app.ts';

const HOST = 'hof.example';
const FORM = 'application/x-www-form-urlencoded';

// Copied from ARCHITECTURE.md §4.9 on purpose: the test must not share the constant with the code.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; media-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// The common checks need no database: the court counts as founded, and /anything is not a Core
// route, so a request that passes every check ends in the common 404. The pool and the dummy
// password hash are never used.
const founded: FirstRun = {
  isFounded: () => Promise.resolve(true),
  keyMatches: () => false,
  markFounded: () => undefined,
};
const unusedPool = new Pool();
// The settings of the installation Säckel gets; checked by start(), not by createApp.
const SETTINGS = { currency: 'RUB', timeZone: 'Europe/Moscow' };

function request(method: string, headers: Record<string, string>, body?: string) {
  return createApp(unusedPool, unusedPool, SETTINGS, founded, 'unused').request('/anything', {
    method,
    headers,
    body,
  });
}

// Silences log lines during the test and returns what was written.
function captureLog(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(line));
  return lines;
}

describe('Origin', () => {
  const rejected: [string, Record<string, string>][] = [
    ['no Origin header', { host: HOST }],
    ['Origin: null', { host: HOST, origin: 'null' }],
    ['another host', { host: HOST, origin: 'https://evil.example' }],
    ['another port', { host: HOST, origin: `https://${HOST}:8443` }],
    ['http for a non-localhost host', { host: HOST, origin: `http://${HOST}` }],
    ['localhost with another port', { host: 'localhost:3000', origin: 'http://localhost:3001' }],
    ['no Host header', { origin: `https://${HOST}` }],
  ];
  for (const [name, headers] of rejected) {
    test(`rejects ${name} with 403`, async (t) => {
      const lines = captureLog(t);
      const res = await request('POST', { ...headers, 'content-type': FORM }, 'a=1');
      assert.equal(res.status, 403);
      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? '', /^warn origin_rejected method=POST path=\/anything /);
    });
  }

  test('checks methods other than POST too', async (t) => {
    captureLog(t);
    assert.equal((await request('PUT', { host: HOST })).status, 403);
    assert.equal((await request('DELETE', { host: HOST })).status, 403);
  });

  const accepted: [string, Record<string, string>][] = [
    ['https://<Host>', { host: HOST, origin: `https://${HOST}` }],
    ['http://localhost:<port>', { host: 'localhost:3000', origin: 'http://localhost:3000' }],
    ['http://localhost', { host: 'localhost', origin: 'http://localhost' }],
  ];
  for (const [name, headers] of accepted) {
    test(`accepts ${name}`, async () => {
      const res = await request('POST', { ...headers, 'content-type': FORM }, 'a=1');
      assert.equal(res.status, 404);
    });
  }

  test('does not require Origin for GET and HEAD', async () => {
    assert.equal((await request('GET', { host: HOST })).status, 404);
    assert.equal((await request('HEAD', { host: HOST })).status, 404);
  });

  test('writes a hostile Origin into the log as one quoted value', async (t) => {
    const lines = captureLog(t);
    await request('POST', { host: HOST, origin: 'https://evil.example "x" y=1' });
    assert.deepEqual(lines, [
      `warn origin_rejected method=POST path=/anything origin="https://evil.example \\"x\\" y=1" host=${HOST}`,
    ]);
  });
});

describe('POST body', () => {
  const origin = { host: HOST, origin: `https://${HOST}` };

  for (const type of ['text/plain', 'multipart/form-data; boundary=x', 'application/json']) {
    test(`rejects ${type} with 415`, async () => {
      const res = await request('POST', { ...origin, 'content-type': type }, 'a=1');
      assert.equal(res.status, 415);
    });
  }

  test('rejects a POST without Content-Type with 415', async () => {
    assert.equal((await request('POST', origin)).status, 415);
  });

  test('accepts the form type with parameters and in any case', async () => {
    const type = 'Application/X-WWW-Form-Urlencoded; charset=UTF-8';
    const res = await request('POST', { ...origin, 'content-type': type }, 'a=1');
    assert.equal(res.status, 404);
  });

  const atLimit = 'a=' + 'x'.repeat(16 * 1024 - 2);
  const overLimit = atLimit + 'x';

  test('accepts exactly 16 KiB', async () => {
    const res = await request('POST', { ...origin, 'content-type': FORM }, atLimit);
    assert.equal(res.status, 404);
  });

  test('rejects 16 KiB + 1 byte with 413 by Content-Length', async () => {
    const headers = { ...origin, 'content-type': FORM, 'content-length': String(overLimit.length) };
    assert.equal((await request('POST', headers, overLimit)).status, 413);
  });

  test('rejects 16 KiB + 1 byte with 413 without Content-Length', async () => {
    const res = await request('POST', { ...origin, 'content-type': FORM }, overLimit);
    assert.equal(res.status, 413);
  });

  test('checks Origin before the body', async (t) => {
    captureLog(t);
    const res = await request('POST', { host: HOST, 'content-type': 'text/plain' }, overLimit);
    assert.equal(res.status, 403);
  });
});

describe('response headers', () => {
  test('HTML response: security headers and no-store', async () => {
    const res = await request('GET', { host: HOST });
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(res.headers.get('content-security-policy'), CSP);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'same-origin');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('non-HTML rejection: security headers without no-store', async (t) => {
    captureLog(t);
    const res = await request('POST', { host: HOST });
    assert.equal(res.status, 403);
    assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(res.headers.get('content-security-policy'), CSP);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'same-origin');
    assert.equal(res.headers.get('cache-control'), null);
  });
});

describe('404 page', () => {
  test('an unknown path, GET or POST: the page and the way to the courtyard', async () => {
    for (const res of [
      await request('GET', { host: HOST }),
      await request('POST', { host: HOST, origin: `https://${HOST}`, 'content-type': FORM }, 'a=1'),
    ]) {
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const page = await res.text();
      assert.ok(page.includes('<h1>Такой тропы во дворе нет</h1>'));
      assert.ok(page.includes('Возможно, ссылка устарела или в адресе опечатка.'));
      assert.ok(page.includes('<a href="/">Во двор</a>'));
    }
  });
});

describe('500 page and the unexpected_error line', () => {
  // The first-run gate of main.ts fails: the error comes before any module.
  function failingGate(error: Error): FirstRun {
    return {
      isFounded: () => Promise.reject(error),
      keyMatches: () => false,
      markFounded: () => undefined,
    };
  }
  // Values the request carries that must not reach the page or the log.
  const COOKIE_TOKEN = 'C'.repeat(43);
  const secrets = [COOKIE_TOKEN, 'query-secret', 'body-secret'];

  function failing(method: string, error: Error) {
    return createApp(unusedPool, unusedPool, SETTINGS, failingGate(error), 'unused').request(
      '/x?token=query-secret',
      {
        method,
        headers: {
          host: HOST,
          origin: `https://${HOST}`,
          'content-type': FORM,
          cookie: `__Host-hof=${COOKIE_TOKEN}`,
        },
        body: method === 'POST' ? 'password=body-secret' : undefined,
      },
    );
  }

  test('GET: the page with «Попробовать ещё раз», no details; one log line', async (t) => {
    const lines = captureLog(t);
    const error = new Error('first line\nsecond "line"\rthird');
    const res = await failing('GET', error);
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('content-security-policy'), CSP);
    const page = await res.text();
    for (const text of [
      '<h1>Во дворе что-то стряслось</h1>',
      'Мы уже прибираемся. Попробуйте ещё раз через минуту — записанное раньше на месте.',
      '<a href="">Попробовать ещё раз</a>',
      '<a href="/">Во двор</a>',
    ]) {
      assert.ok(page.includes(text), text);
    }
    for (const detail of ['first line', 'third', 'Error', 'main.test.ts', '/x', ...secrets]) {
      assert.ok(!page.includes(detail), `page shows ${detail}`);
    }

    // One event, one physical line: the line breaks and quotes are escaped inside JSON strings.
    assert.equal(lines.length, 1);
    const line = lines[0] ?? '';
    assert.doesNotMatch(line, /[\n\r]/);
    const message = JSON.stringify(error.message);
    assert.ok(
      line.startsWith(`error unexpected_error method=GET path=/x error=${message} stack="Error: `),
      line,
    );
    assert.ok(line.endsWith(`stack=${JSON.stringify(error.stack)}`), line);
    assert.ok(line.includes('main.test.ts'), 'the stack has the frames');
    for (const secret of secrets) assert.ok(!line.includes(secret), `log contains ${secret}`);
  });

  test('HEAD: the same status and headers, no body', async (t) => {
    const lines = captureLog(t);
    const res = await failing('HEAD', new Error('boom'));
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('content-security-policy'), CSP);
    assert.equal(await res.text(), '');
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /^error unexpected_error method=HEAD path=\/x error=boom stack=/);
  });

  test('POST: no «Попробовать ещё раз», only the way to the courtyard', async (t) => {
    const lines = captureLog(t);
    const res = await failing('POST', new Error('boom'));
    assert.equal(res.status, 500);
    const page = await res.text();
    assert.ok(page.includes('<h1>Во дворе что-то стряслось</h1>'));
    assert.ok(!page.includes('Попробовать ещё раз'));
    assert.ok(page.includes('<a href="/">Во двор</a>'));
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /^error unexpected_error method=POST path=\/x error=boom stack=/);
    for (const secret of secrets) assert.ok(!lines[0]!.includes(secret), `log contains ${secret}`);
  });

  test('a DatabaseError: its message only, none of its extra fields', async (t) => {
    const lines = captureLog(t);
    const error = new DatabaseError('duplicate key value violates unique constraint', 100, 'error');
    error.detail = 'Key (username)=(detail-secret) already exists.';
    error.hint = 'hint-secret';
    error.where = 'where-secret';
    error.internalQuery = 'internal-query-secret';
    error.schema = 'core';
    error.table = 'table-secret';
    error.constraint = 'constraint-secret';
    assert.equal((await failing('GET', error)).status, 500);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /error="duplicate key value violates unique constraint"/);
    for (const extra of ['detail-secret', 'hint-secret', 'where-secret', 'internal-query-secret']) {
      assert.ok(!lines[0]!.includes(extra), `log contains ${extra}`);
    }
    assert.ok(!lines[0]!.includes('table-secret') && !lines[0]!.includes('constraint-secret'));
  });

  test('an error in a module route: the database is down when / looks for the session', async (t) => {
    const lines = captureLog(t);
    // Nothing listens on port 1: the session query of Core fails to connect.
    const deadPool = new Pool({ host: '127.0.0.1', port: 1 });
    after(() => deadPool.end());
    const res = await createApp(deadPool, unusedPool, SETTINGS, founded, 'unused').request('/', {
      headers: { host: HOST, cookie: `__Host-hof=${COOKIE_TOKEN}` },
    });
    assert.equal(res.status, 500);
    const page = await res.text();
    assert.ok(page.includes('<h1>Во дворе что-то стряслось</h1>'));
    assert.ok(!page.includes('ECONNREFUSED'));
    assert.equal(lines.length, 1);
    assert.match(
      lines[0] ?? '',
      /^error unexpected_error method=GET path=\/ error="connect ECONNREFUSED 127.0.0.1:1" stack=/,
    );
    assert.ok(!lines[0]!.includes(COOKIE_TOKEN));
  });
});

describe('startup', () => {
  // The server runs as a separate process with only the given environment. A listening server
  // would keep running, so exit code 1 also means the HTTP port was never opened.
  function start(env: Record<string, string>) {
    return spawnSync(process.execPath, [join(import.meta.dirname, 'main.ts')], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      timeout: 10_000,
    });
  }

  test('without HOF_CORE_DB_PASSWORD: exits with 1 and names the variable', () => {
    const result = start({});
    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      'error startup_failed error="HOF_CORE_DB_PASSWORD is not set (see .env.example)"\n',
    );
  });

  // Everything start() needs before it reaches the database.
  const CONFIGURED = {
    HOF_CORE_DB_PASSWORD: 'x',
    HOF_SAECKEL_DB_PASSWORD: 'x',
    CURRENCY: 'RUB',
    TZ: 'Europe/Moscow',
  };

  test('without HOF_SAECKEL_DB_PASSWORD: exits with 1 and names the variable', () => {
    const result = start({ HOF_CORE_DB_PASSWORD: 'x' });
    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      'error startup_failed error="HOF_SAECKEL_DB_PASSWORD is not set (see .env.example)"\n',
    );
  });

  const settingsRefused: [string, Record<string, string>, string][] = [
    ['without CURRENCY', { CURRENCY: '' }, 'CURRENCY is not set (see .env.example)'],
    ['an unknown CURRENCY', { CURRENCY: 'XXX' }, 'CURRENCY=XXX is not an ISO 4217 currency code'],
    [
      'a CURRENCY in lower case',
      { CURRENCY: 'rub' },
      'CURRENCY=rub is not an ISO 4217 currency code',
    ],
    [
      'a CURRENCY without two decimals',
      { CURRENCY: 'JPY' },
      'CURRENCY=JPY does not have two decimal places',
    ],
    ['without TZ', { TZ: '' }, 'TZ is not set (see .env.example)'],
    ['an unknown TZ', { TZ: 'Mars/Olympus' }, 'TZ=Mars/Olympus is not a time zone'],
  ];
  for (const [name, change, error] of settingsRefused) {
    test(`${name}: exits with 1 before the database and names the setting`, () => {
      // Nothing listens on port 1: a connection attempt would be a different error.
      const result = start({ ...CONFIGURED, ...change, PGHOST: '127.0.0.1', PGPORT: '1' });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, `error startup_failed error=${JSON.stringify(error)}\n`);
    });
  }

  test('database unavailable: exits with 1 before listening', () => {
    const result = start({ ...CONFIGURED, PGHOST: '127.0.0.1', PGPORT: '1' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'error startup_failed error="connect ECONNREFUSED 127.0.0.1:1"\n');
  });
});

describe('Säckel in the court', () => {
  // Both modules against hof_test, each under its own role, as main.ts assembles them.
  const corePool = new Pool({
    database: 'hof_test',
    user: 'hof_core',
    password: process.env.HOF_CORE_DB_PASSWORD,
  });
  const saeckelPool = new Pool({
    database: 'hof_test',
    user: 'hof_saeckel',
    password: process.env.HOF_SAECKEL_DB_PASSWORD,
  });
  const app = createApp(corePool, saeckelPool, SETTINGS, founded, 'unused');
  const ORIGIN = `https://${HOST}`;

  before(async () => {
    await migrate(corePool, join(import.meta.dirname, 'core', 'migrations'));
    await migrate(saeckelPool, join(import.meta.dirname, 'saeckel', 'migrations'));
  });
  beforeEach(async () => {
    await corePool.query('TRUNCATE sessions, users RESTART IDENTITY');
    await saeckelPool.query('TRUNCATE operations, pouches RESTART IDENTITY');
  });
  after(() => Promise.all([corePool.end(), saeckelPool.end()]));

  // A person of Core with a live session; returns the cookie. Nobody signs in here, so the
  // password hash is never read.
  async function person(username: string, { admin = false, disabled = false } = {}) {
    const { rows } = await corePool.query<{ id: number }>(
      "INSERT INTO users (username, password_hash, is_admin, is_disabled) VALUES ($1, 'x', $2, $3) RETURNING id",
      [username, admin, disabled],
    );
    const token = newSessionToken();
    await corePool.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
      [hashSessionToken(token), rows[0]!.id],
    );
    return { id: rows[0]!.id, token, cookie: `__Host-hof=${token}` };
  }

  function get(path: string, cookie?: string) {
    return app.request(path, { headers: { host: HOST, ...(cookie ? { cookie } : {}) } });
  }

  function post(path: string, fields: Record<string, string>, cookie?: string) {
    return app.request(path, {
      method: 'POST',
      headers: { host: HOST, origin: ORIGIN, 'content-type': FORM, ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(fields).toString(),
    });
  }

  async function makePouch(name: string, cookie: string): Promise<string> {
    const res = await post('/saeckel/pouches/new', { name }, cookie);
    assert.equal(res.status, 303);
    return res.headers.get('location')!;
  }

  test('the courtyard leads to Säckel', async () => {
    const { cookie } = await person('anna');
    const page = await (await get('/', cookie)).text();
    assert.ok(page.includes('<a href="/saeckel/">Säckel</a>'));
  });

  test('Säckel gets id and login only, not the role', async () => {
    const owner = await person('owner', { admin: true });
    const user = applicationUser(corePool);
    const request = (headers: Record<string, string>) =>
      new Request('https://hof.example/saeckel/', { headers });
    assert.deepEqual(await user(request({ cookie: owner.cookie })), {
      id: owner.id,
      username: 'owner',
    });
    assert.equal(await user(request({})), null);
    assert.equal(await user(request({ cookie: '__Host-hof=not-a-token' })), null);
  });

  test('a session of Core opens Säckel; without one, the way to /login', async () => {
    const { cookie } = await person('anna');
    assert.equal((await get('/saeckel/', cookie)).status, 200);
    const away = await get('/saeckel/?a=1');
    assert.equal(away.status, 303);
    assert.equal(away.headers.get('location'), '/login?next=%2Fsaeckel%2F%3Fa%3D1');
    // A POST with the right Origin and form type passes the common checks and meets the session
    // check of Säckel.
    const write = await post('/saeckel/pouches/new', { name: 'Продукты' });
    assert.equal(write.status, 303);
    assert.equal(write.headers.get('location'), '/login');
    const { rows } = await saeckelPool.query('SELECT 1 FROM pouches');
    assert.equal(rows.length, 0);
  });

  test('a disabled person loses Säckel as well', async () => {
    const anna = await person('anna');
    const pouch = await makePouch('Продукты', anna.cookie);
    await corePool.query('UPDATE users SET is_disabled = true WHERE id = $1', [anna.id]);
    for (const path of ['/saeckel/', pouch]) {
      const res = await get(path, anna.cookie);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(path)}`);
    }
    assert.equal((await post('/saeckel/pouches/new', { name: 'Ещё' }, anna.cookie)).status, 303);
    const { rows } = await saeckelPool.query('SELECT name FROM pouches');
    assert.deepEqual(rows, [{ name: 'Продукты' }]);
  });

  test('the administrator has his own pouches and no way into anybody else’s', async () => {
    const owner = await person('owner', { admin: true });
    const anna = await person('anna');
    const hers = await makePouch('Анины деньги', anna.cookie);
    await makePouch('Хозяйство', owner.cookie);
    const list = await (await get('/saeckel/', owner.cookie)).text();
    assert.ok(list.includes('Хозяйство'));
    assert.ok(!list.includes('Анины деньги'));
    // Her pouch is the same common 404 as one that does not exist.
    const foreign = await get(hers, owner.cookie);
    const missing = await get('/saeckel/pouches/99', owner.cookie);
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    const page = await foreign.text();
    assert.ok(page.includes('<h1>Такой тропы во дворе нет</h1>'));
    assert.equal(page, await missing.text());
    assert.ok(!page.includes('Анины деньги'));
    // And she does not see his.
    const hersList = await (await get('/saeckel/', anna.cookie)).text();
    assert.ok(!hersList.includes('Хозяйство'));
  });

  test('the administrator cannot change a pouch of anybody else', async () => {
    const owner = await person('owner', { admin: true });
    const anna = await person('anna');
    const hers = await makePouch('Анины деньги', anna.cookie);
    const missing = await (await get('/saeckel/pouches/99/edit', owner.cookie)).text();
    const page = await get(`${hers}/edit`, owner.cookie);
    assert.equal(page.status, 404);
    const text = await page.text();
    assert.ok(text.includes('<h1>Такой тропы во дворе нет</h1>'));
    assert.equal(text, missing);
    const save = await post(`${hers}/edit`, { name: 'Чужое', icon: 'cart' }, owner.cookie);
    assert.equal(save.status, 404);
    const { rows } = await saeckelPool.query('SELECT name, icon FROM pouches');
    assert.deepEqual(rows, [{ name: 'Анины деньги', icon: 'pouch' }]);
  });

  test('addresses that are not routes of Säckel: the common 404, with or without a session', async () => {
    const { cookie } = await person('anna');
    for (const path of ['/saeckel', '/saeckel/x', '/saeckel/pouches/', '/saeckel/pouches/1/x']) {
      for (const res of [
        await get(path),
        await get(path, cookie),
        await post(path, { name: 'x' }),
        await post(path, { name: 'x' }, cookie),
      ]) {
        assert.equal(res.status, 404, path);
        assert.ok((await res.text()).includes('<h1>Такой тропы во дворе нет</h1>'), path);
      }
    }
  });

  test('an unexpected error in Säckel: the common 500, no name or session in the log', async (t) => {
    const lines = captureLog(t);
    const { token, cookie } = await person('anna');
    await saeckelPool.query(
      'ALTER TABLE pouches ADD CONSTRAINT pouches_none CHECK (false) NOT VALID',
    );
    try {
      const res = await post('/saeckel/pouches/new', { name: 'Тайный мешок' }, cookie);
      assert.equal(res.status, 500);
      const page = await res.text();
      assert.ok(page.includes('<h1>Во дворе что-то стряслось</h1>'));
      assert.ok(!page.includes('Тайный мешок'));
    } finally {
      await saeckelPool.query('ALTER TABLE pouches DROP CONSTRAINT IF EXISTS pouches_none');
    }
    assert.equal(lines.length, 1);
    assert.match(
      lines[0]!,
      /^error unexpected_error method=POST path=\/saeckel\/pouches\/new error="new row for relation \\"pouches\\" violates check constraint \\"pouches_none\\"" stack=/,
    );
    for (const secret of ['Тайный', encodeURIComponent('Тайный'), token, 'name=']) {
      assert.ok(!lines[0]!.includes(secret), secret);
    }
  });

  test('an unexpected error in «Изменить»: the common 500, no name or session in the log', async (t) => {
    const lines = captureLog(t);
    const { token, cookie } = await person('anna');
    const pouch = await makePouch('Продукты', cookie);
    await saeckelPool.query(
      'ALTER TABLE pouches ADD CONSTRAINT pouches_none CHECK (false) NOT VALID',
    );
    try {
      const res = await post(`${pouch}/edit`, { name: 'Тайное имя', icon: 'cart' }, cookie);
      assert.equal(res.status, 500);
      assert.ok(!(await res.text()).includes('Тайное имя'));
    } finally {
      await saeckelPool.query('ALTER TABLE pouches DROP CONSTRAINT IF EXISTS pouches_none');
    }
    const errors = lines.filter((line) => line.startsWith('error '));
    assert.equal(errors.length, 1);
    assert.match(
      errors[0]!,
      /^error unexpected_error method=POST path=\/saeckel\/pouches\/\d+\/edit /,
    );
    for (const secret of ['Тайное', encodeURIComponent('Тайное'), token, 'name=', 'icon=']) {
      assert.ok(!errors[0]!.includes(secret), secret);
    }
  });

  test('the administrator cannot spend from a pouch of anybody else', async () => {
    const owner = await person('owner', { admin: true });
    const anna = await person('anna');
    const hers = await makePouch('Анины деньги', anna.cookie);
    const res = await post(`${hers}/expense`, { amount: '100', date: '', note: '' }, owner.cookie);
    assert.equal(res.status, 404);
    assert.ok((await res.text()).includes('<h1>Такой тропы во дворе нет</h1>'));
    const { rows } = await saeckelPool.query('SELECT 1 FROM operations');
    assert.equal(rows.length, 0);
  });

  test('an unexpected error in an expense: the common 500, no amount or note in the log', async (t) => {
    const lines = captureLog(t);
    const { token, cookie } = await person('anna');
    const pouch = await makePouch('Продукты', cookie);
    await saeckelPool.query(
      "CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$",
    );
    await saeckelPool.query(
      'CREATE TRIGGER operations_no_insert BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION refuse_for_test()',
    );
    try {
      const res = await post(
        `${pouch}/expense`,
        { amount: '7 777,77', date: '05.10.2026', note: 'тайная заметка' },
        cookie,
      );
      assert.equal(res.status, 500);
      const page = await res.text();
      assert.ok(page.includes('<h1>Во дворе что-то стряслось</h1>'));
      assert.ok(!page.includes('тайная'));
    } finally {
      await saeckelPool.query('DROP TRIGGER IF EXISTS operations_no_insert ON operations');
      await saeckelPool.query('DROP FUNCTION IF EXISTS refuse_for_test()');
    }
    const errors = lines.filter((line) => line.startsWith('error '));
    assert.equal(errors.length, 1);
    assert.match(
      errors[0]!,
      /^error unexpected_error method=POST path=\/saeckel\/pouches\/\d+\/expense error="refused for the test" /,
    );
    for (const secret of [
      '7 777',
      '7777',
      '777777',
      'тайная',
      encodeURIComponent('тайная'),
      '05.10.2026',
      '2026-10-05',
      token,
      'amount=',
      'note=',
    ]) {
      assert.ok(!errors[0]!.includes(secret), secret);
    }
    const { rows } = await saeckelPool.query('SELECT 1 FROM operations');
    assert.equal(rows.length, 0);
  });

  test('the administrator cannot put a pouch of anybody else into the storeroom or bring it back', async () => {
    const owner = await person('owner', { admin: true });
    const anna = await person('anna');
    const hers = await makePouch('Анины деньги', anna.cookie);
    const stored = await makePouch('Анин отпуск', anna.cookie);
    assert.equal((await post(`${stored}/archive`, {}, anna.cookie)).status, 303);
    const missing = await (await post('/saeckel/pouches/99/archive', {}, owner.cookie)).text();
    for (const path of [`${hers}/archive`, `${stored}/restore`]) {
      const res = await post(path, {}, owner.cookie);
      assert.equal(res.status, 404, path);
      const page = await res.text();
      assert.ok(page.includes('<h1>Такой тропы во дворе нет</h1>'), path);
      assert.equal(page, missing, path);
    }
    const { rows } = await saeckelPool.query('SELECT name, is_archived FROM pouches ORDER BY id');
    assert.deepEqual(rows, [
      { name: 'Анины деньги', is_archived: false },
      { name: 'Анин отпуск', is_archived: true },
    ]);
  });

  test('an unexpected error in «В кладовую» or «Вернуть»: the common 500, no name in the log', async (t) => {
    const lines = captureLog(t);
    const { token, cookie } = await person('anna');
    const active = await makePouch('Тайный мешок', cookie);
    const stored = await makePouch('Тайный отпуск', cookie);
    assert.equal((await post(`${stored}/archive`, {}, cookie)).status, 303);
    await saeckelPool.query(
      "CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$",
    );
    await saeckelPool.query(
      'CREATE TRIGGER pouches_no_update BEFORE UPDATE ON pouches FOR EACH ROW EXECUTE FUNCTION refuse_for_test()',
    );
    try {
      for (const path of [`${active}/archive`, `${stored}/restore`]) {
        const res = await post(path, {}, cookie);
        assert.equal(res.status, 500, path);
        const page = await res.text();
        assert.ok(page.includes('<h1>Во дворе что-то стряслось</h1>'), path);
        assert.ok(!page.includes('Тайный'), path);
      }
    } finally {
      await saeckelPool.query('DROP TRIGGER IF EXISTS pouches_no_update ON pouches');
      await saeckelPool.query('DROP FUNCTION IF EXISTS refuse_for_test()');
    }
    const errors = lines.filter((line) => line.startsWith('error '));
    assert.equal(errors.length, 2);
    assert.match(
      errors[0]!,
      /^error unexpected_error method=POST path=\/saeckel\/pouches\/\d+\/archive error="refused for the test" /,
    );
    assert.match(
      errors[1]!,
      /^error unexpected_error method=POST path=\/saeckel\/pouches\/\d+\/restore error="refused for the test" /,
    );
    for (const error of errors) {
      for (const secret of ['Тайный', encodeURIComponent('Тайный'), token]) {
        assert.ok(!error.includes(secret), secret);
      }
    }
    const { rows } = await saeckelPool.query('SELECT is_archived FROM pouches ORDER BY id');
    assert.deepEqual(rows, [{ is_archived: false }, { is_archived: true }]);
  });

  test('the administrator lays out into no pouch of anybody else and sees no income of anybody else', async () => {
    const owner = await person('owner', { admin: true });
    const anna = await person('anna');
    const hers = Number((await makePouch('Анины деньги', anna.cookie)).split('/').at(-1));
    const written = await post(
      '/saeckel/income',
      { amount: '7 777,77', date: '', note: 'зарплата Анны' },
      anna.cookie,
    );
    assert.equal(written.status, 303);
    const assignPath = written.headers.get('location')!;
    // His laying out into her pouch: the same refusal as for a pouch that does not exist.
    const res = await post('/saeckel/assign', { [`amount_${hers}`]: '1' }, owner.cookie);
    assert.equal(res.status, 400);
    const page = await res.text();
    assert.ok(page.includes('<p id="refusal">Мешок не найден.</p>'));
    assert.ok(!page.includes('Анины деньги'));
    // Her income in his address names nothing.
    const his = await get(assignPath, owner.cookie);
    assert.equal(his.status, 200);
    const hisPage = (await his.text()).replace(/\s+/g, ' ');
    assert.ok(!hisPage.includes('лёг в казну'));
    assert.ok(!hisPage.includes('7 777'));
    assert.ok(hisPage.includes('В казне: 0,00 ₽.'));
    const { rows } = await saeckelPool.query("SELECT 1 FROM operations WHERE kind = 'assign'");
    assert.equal(rows.length, 0);
  });

  test('an unexpected error in an income or a laying out: the common 500, no amount, note or name in the log', async (t) => {
    const lines = captureLog(t);
    const { token, cookie } = await person('anna');
    const pouch = Number((await makePouch('Тайный мешок', cookie)).split('/').at(-1));
    await saeckelPool.query(
      "CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$",
    );
    await saeckelPool.query(
      'CREATE TRIGGER operations_no_insert BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION refuse_for_test()',
    );
    try {
      for (const [path, fields] of [
        ['/saeckel/income', { amount: '7 777,77', date: '05.10.2026', note: 'тайная заметка' }],
        ['/saeckel/assign', { [`amount_${pouch}`]: '7 777,77' }],
      ] as const) {
        const res = await post(path, fields, cookie);
        assert.equal(res.status, 500, path);
        const page = await res.text();
        assert.ok(page.includes('<h1>Во дворе что-то стряслось</h1>'), path);
        assert.ok(!page.includes('тайная') && !page.includes('Тайный'), path);
      }
    } finally {
      await saeckelPool.query('DROP TRIGGER IF EXISTS operations_no_insert ON operations');
      await saeckelPool.query('DROP FUNCTION IF EXISTS refuse_for_test()');
    }
    const errors = lines.filter((line) => line.startsWith('error '));
    assert.equal(errors.length, 2);
    assert.match(
      errors[0]!,
      /^error unexpected_error method=POST path=\/saeckel\/income error="refused for the test" /,
    );
    assert.match(
      errors[1]!,
      /^error unexpected_error method=POST path=\/saeckel\/assign error="refused for the test" /,
    );
    for (const error of errors) {
      for (const secret of [
        '7 777',
        '7777',
        '777777',
        'тайная',
        encodeURIComponent('тайная'),
        'Тайный',
        encodeURIComponent('Тайный'),
        '05.10.2026',
        '2026-10-05',
        token,
        'amount=',
        'amount_',
        'note=',
      ]) {
        assert.ok(!error.includes(secret), secret);
      }
    }
    const { rows } = await saeckelPool.query('SELECT 1 FROM operations');
    assert.equal(rows.length, 0);
  });

  test('the administrator transfers neither out of nor into a pouch of anybody else', async () => {
    const owner = await person('owner', { admin: true });
    const anna = await person('anna');
    const hers = Number((await makePouch('Анины деньги', anna.cookie)).split('/').at(-1));
    const his = Number((await makePouch('Хозяйство', owner.cookie)).split('/').at(-1));
    for (const [from, to, field] of [
      [hers, his, 'from'],
      [his, hers, 'to'],
    ] as const) {
      const res = await post(
        '/saeckel/transfer',
        { from: String(from), to: String(to), amount: '1', date: '', note: '' },
        owner.cookie,
      );
      assert.equal(res.status, 400);
      const page = await res.text();
      assert.ok(page.includes(`<p id="${field}-error">Мешок не найден.</p>`), field);
      assert.ok(!page.includes('Анины деньги'));
    }
    // Her pouch in his address chooses nothing and names nothing; the page keeps the headers.
    const form = await get(`/saeckel/transfer?from=${hers}&to=${hers}&amount=5`, owner.cookie);
    assert.equal(form.status, 200);
    assert.equal(form.headers.get('content-security-policy'), CSP);
    assert.equal(form.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(form.headers.get('cache-control'), 'no-store');
    const page = await form.text();
    assert.ok(!page.includes('Анины деньги'));
    assert.ok(!page.includes('selected'));
    const { rows } = await saeckelPool.query('SELECT 1 FROM operations');
    assert.equal(rows.length, 0);
  });

  test('an unexpected error in a transfer: the common 500, no amount, note or name in the log', async (t) => {
    const lines = captureLog(t);
    const { token, cookie } = await person('anna');
    const from = Number((await makePouch('Тайный мешок', cookie)).split('/').at(-1));
    const to = Number((await makePouch('Тайная цель', cookie)).split('/').at(-1));
    await saeckelPool.query(
      "CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$",
    );
    await saeckelPool.query(
      'CREATE TRIGGER operations_no_insert BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION refuse_for_test()',
    );
    try {
      const res = await post(
        '/saeckel/transfer',
        {
          from: String(from),
          to: String(to),
          amount: '7 777,77',
          date: '05.10.2026',
          note: 'тайная заметка',
        },
        cookie,
      );
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('location'), null);
      const page = await res.text();
      assert.ok(page.includes('<h1>Во дворе что-то стряслось</h1>'));
      assert.ok(!page.includes('тайная') && !page.includes('Тайн'));
    } finally {
      await saeckelPool.query('DROP TRIGGER IF EXISTS operations_no_insert ON operations');
      await saeckelPool.query('DROP FUNCTION IF EXISTS refuse_for_test()');
    }
    const errors = lines.filter((line) => line.startsWith('error '));
    assert.equal(errors.length, 1);
    assert.match(
      errors[0]!,
      /^error unexpected_error method=POST path=\/saeckel\/transfer error="refused for the test" /,
    );
    for (const secret of [
      '7 777',
      '7777',
      '777777',
      'тайная',
      encodeURIComponent('тайная'),
      'Тайн',
      encodeURIComponent('Тайн'),
      '05.10.2026',
      '2026-10-05',
      token,
      'amount=',
      'note=',
      'from=',
      'to=',
    ]) {
      assert.ok(!errors[0]!.includes(secret), secret);
    }
    const { rows } = await saeckelPool.query('SELECT 1 FROM operations');
    assert.equal(rows.length, 0);
  });

  test('the administrator sees no history and opens no record of anybody else', async () => {
    const owner = await person('owner', { admin: true });
    const anna = await person('anna');
    const hers = await makePouch('Анины деньги', anna.cookie);
    const spent = await post(
      `${hers}/expense`,
      { amount: '7 777,77', date: '', note: 'тайная трата' },
      anna.cookie,
    );
    const record = Number(
      new URL(spent.headers.get('location')!, ORIGIN).searchParams.get('fresh'),
    );
    const pouch = Number(hers.split('/').at(-1));
    const missing = await (await get('/saeckel/operations/99999', owner.cookie)).text();
    for (const path of [`/saeckel/history?pouch=${pouch}`, `/saeckel/operations/${record}`]) {
      const res = await get(path, owner.cookie);
      assert.equal(res.status, 404, path);
      const page = await res.text();
      assert.ok(page.includes('<h1>Такой тропы во дворе нет</h1>'), path);
      assert.equal(page, missing, path);
    }
    // His own Летопись is his: empty, with the usual headers.
    const own = await get('/saeckel/history', owner.cookie);
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('content-security-policy'), CSP);
    assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(own.headers.get('cache-control'), 'no-store');
    const page = await own.text();
    assert.ok(page.includes('Летопись пока пуста'));
    assert.ok(!page.includes('тайная') && !page.includes('Анины'));
    // She sees hers.
    const her = await get(`/saeckel/operations/${record}`, anna.cookie);
    assert.equal(her.status, 200);
  });

  test('Летопись without a session: /login with the way back, query and all', async () => {
    const path = '/saeckel/history?pouch=1&page=2';
    const res = await get(path);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(path)}`);
  });

  test('the administrator neither opens nor changes a record of anybody else', async () => {
    const owner = await person('owner', { admin: true });
    const anna = await person('anna');
    const hers = await makePouch('Анины деньги', anna.cookie);
    const spent = await post(
      `${hers}/expense`,
      { amount: '100', date: '', note: 'её' },
      anna.cookie,
    );
    const record = Number(
      new URL(spent.headers.get('location')!, ORIGIN).searchParams.get('fresh'),
    );
    const pouch = hers.split('/').at(-1)!;
    const missing = await (await get('/saeckel/operations/99999', owner.cookie)).text();
    for (const res of [
      await get(`/saeckel/operations/${record}`, owner.cookie),
      await post(
        `/saeckel/operations/${record}`,
        { from: pouch, amount: '1', date: '', note: 'чужое' },
        owner.cookie,
      ),
    ]) {
      assert.equal(res.status, 404);
      const page = await res.text();
      assert.ok(page.includes('<h1>Такой тропы во дворе нет</h1>'));
      assert.equal(page, missing);
    }
    const { rows } = await saeckelPool.query('SELECT amount::text, note FROM operations');
    assert.deepEqual(rows, [{ amount: '10000', note: 'её' }]);
  });

  test('an unexpected error in a change of a record: the common 500, no amount, note or name in the log', async (t) => {
    const lines = captureLog(t);
    const { token, cookie } = await person('anna');
    const pouch = await makePouch('Тайный мешок', cookie);
    const spent = await post(`${pouch}/expense`, { amount: '1', date: '', note: '' }, cookie);
    const record = Number(
      new URL(spent.headers.get('location')!, ORIGIN).searchParams.get('fresh'),
    );
    await saeckelPool.query(
      "CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$",
    );
    await saeckelPool.query(
      'CREATE TRIGGER operations_no_update BEFORE UPDATE ON operations FOR EACH ROW EXECUTE FUNCTION refuse_for_test()',
    );
    try {
      const res = await post(
        `/saeckel/operations/${record}`,
        {
          from: pouch.split('/').at(-1)!,
          amount: '7 777,77',
          date: '05.10.2026',
          note: 'тайная заметка',
        },
        cookie,
      );
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('location'), null);
      const page = await res.text();
      assert.ok(page.includes('<h1>Во дворе что-то стряслось</h1>'));
      assert.ok(!page.includes('тайная') && !page.includes('Тайный'));
    } finally {
      await saeckelPool.query('DROP TRIGGER IF EXISTS operations_no_update ON operations');
      await saeckelPool.query('DROP FUNCTION IF EXISTS refuse_for_test()');
    }
    const errors = lines.filter((line) => line.startsWith('error '));
    assert.equal(errors.length, 1);
    assert.match(
      errors[0]!,
      /^error unexpected_error method=POST path=\/saeckel\/operations\/\d+ error="refused for the test" /,
    );
    for (const secret of [
      '7 777',
      '7777',
      '777777',
      'тайная',
      encodeURIComponent('тайная'),
      'Тайный',
      encodeURIComponent('Тайный'),
      '05.10.2026',
      '2026-10-05',
      token,
      'amount=',
      'note=',
      'from=',
    ]) {
      assert.ok(!errors[0]!.includes(secret), secret);
    }
    const { rows } = await saeckelPool.query('SELECT amount::text, note FROM operations');
    assert.deepEqual(rows, [{ amount: '100', note: '' }]);
  });

  test('the administrator deletes no record of anybody else', async () => {
    const owner = await person('owner', { admin: true });
    const anna = await person('anna');
    const hers = await makePouch('Анины деньги', anna.cookie);
    const spent = await post(
      `${hers}/expense`,
      { amount: '100', date: '', note: 'её' },
      anna.cookie,
    );
    const record = Number(
      new URL(spent.headers.get('location')!, ORIGIN).searchParams.get('fresh'),
    );
    const missing = await (await post('/saeckel/operations/99999/delete', {}, owner.cookie)).text();
    const res = await post(`/saeckel/operations/${record}/delete`, {}, owner.cookie);
    assert.equal(res.status, 404);
    const page = await res.text();
    assert.ok(page.includes('<h1>Такой тропы во дворе нет</h1>'));
    assert.equal(page, missing);
    const { rows } = await saeckelPool.query('SELECT amount::text, note FROM operations');
    assert.deepEqual(rows, [{ amount: '10000', note: 'её' }]);
  });

  test('an unexpected error in a deletion: the common 500, no amount, note or name in the log', async (t) => {
    const lines = captureLog(t);
    const { token, cookie } = await person('anna');
    const pouch = await makePouch('Тайный мешок', cookie);
    const spent = await post(
      `${pouch}/expense`,
      { amount: '7 777,77', date: '05.10.2026', note: 'тайная заметка' },
      cookie,
    );
    const record = Number(
      new URL(spent.headers.get('location')!, ORIGIN).searchParams.get('fresh'),
    );
    await saeckelPool.query(
      "CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$",
    );
    await saeckelPool.query(
      'CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations FOR EACH ROW EXECUTE FUNCTION refuse_for_test()',
    );
    try {
      const res = await post(`/saeckel/operations/${record}/delete`, { note: 'тайная' }, cookie);
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('location'), null);
      const page = await res.text();
      assert.ok(page.includes('<h1>Во дворе что-то стряслось</h1>'));
      assert.ok(!page.includes('тайная') && !page.includes('Тайный'));
    } finally {
      await saeckelPool.query('DROP TRIGGER IF EXISTS operations_no_delete ON operations');
      await saeckelPool.query('DROP FUNCTION IF EXISTS refuse_for_test()');
    }
    const errors = lines.filter((line) => line.startsWith('error '));
    assert.equal(errors.length, 1);
    assert.match(
      errors[0]!,
      /^error unexpected_error method=POST path=\/saeckel\/operations\/\d+\/delete error="refused for the test" /,
    );
    for (const secret of [
      '7 777',
      '7777',
      '777777',
      'тайная',
      encodeURIComponent('тайная'),
      'Тайный',
      encodeURIComponent('Тайный'),
      '05.10.2026',
      '2026-10-05',
      token,
      'note=',
    ]) {
      assert.ok(!errors[0]!.includes(secret), secret);
    }
    const { rows } = await saeckelPool.query('SELECT amount::text FROM operations');
    assert.deepEqual(rows, [{ amount: '777777' }]);
  });

  test('the currency of the records: another one than CURRENCY is found', async () => {
    assert.equal(await otherRecordedCurrency(saeckelPool, 'RUB'), null);
    const { cookie } = await person('anna');
    const pouch = await makePouch('Продукты', cookie);
    assert.equal(
      (await post(`${pouch}/expense`, { amount: '1', date: '', note: '' }, cookie)).status,
      303,
    );
    // The court writes in RUB: RUB is the currency, EUR would change what every amount means.
    assert.equal(await otherRecordedCurrency(saeckelPool, 'RUB'), null);
    assert.equal(await otherRecordedCurrency(saeckelPool, 'EUR'), 'RUB');
  });
});
