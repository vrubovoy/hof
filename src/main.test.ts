// main.ts: common request checks — Origin (§4.6), POST body (§4.7), response headers (§4.9) —,
// the common 404 and 500 pages with the unexpected_error log line (§4.1, §4.10), and the failures
// that stop the server before it opens the HTTP port.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, describe, test, type TestContext } from 'node:test';
import { DatabaseError, Pool } from 'pg';
import type { FirstRun } from './core/gate-key.ts';
import { createApp } from './main.ts';

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

function request(method: string, headers: Record<string, string>, body?: string) {
  return createApp(unusedPool, founded, 'unused').request('/anything', { method, headers, body });
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
    return createApp(unusedPool, failingGate(error), 'unused').request('/x?token=query-secret', {
      method,
      headers: {
        host: HOST,
        origin: `https://${HOST}`,
        'content-type': FORM,
        cookie: `__Host-hof=${COOKIE_TOKEN}`,
      },
      body: method === 'POST' ? 'password=body-secret' : undefined,
    });
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
    const res = await createApp(deadPool, founded, 'unused').request('/', {
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

  test('database unavailable: exits with 1 before listening', () => {
    const result = start({ HOF_CORE_DB_PASSWORD: 'x', PGHOST: '127.0.0.1', PGPORT: '1' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'error startup_failed error="connect ECONNREFUSED 127.0.0.1:1"\n');
  });
});
