// Säckel on its own (ARCHITECTURE.md §2, §4.1, §4.6): the session check of each route, the
// pouches of one user only, the new pouch. Database: hof_test as hof_saeckel. Who is signed in
// comes from a stand-in for the function main.ts passes; Säckel's tests do not import Core, and
// the wiring through main.ts is tested in src/main.test.ts.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { migrate } from '../migrate.ts';
import { createSaeckelApp, type CurrentUser, type SaeckelUser } from './app.ts';

const password = process.env.HOF_SAECKEL_DB_PASSWORD;
assert.ok(password, 'HOF_SAECKEL_DB_PASSWORD is not set: create .env from .env.example');
const pool = new Pool({ database: 'hof_test', user: 'hof_saeckel', password });

before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
beforeEach(() => pool.query('TRUNCATE pouches RESTART IDENTITY'));
after(() => pool.end());

const FORM = 'application/x-www-form-urlencoded';
const NAME_ERROR = 'Название — от 1 до 50 символов, одной строкой.';
const TAKEN = 'Мешок с таким названием уже есть.';

// The people of these tests. Who is signed in is told by a test header; there is no session.
const PEOPLE: Record<string, SaeckelUser> = {
  anna: { id: 1, username: 'anna' },
  boris: { id: 2, username: 'boris' },
};
const signedIn: CurrentUser = (request) =>
  Promise.resolve(PEOPLE[request.headers.get('x-test-user') ?? ''] ?? null);

const app = createSaeckelApp(pool, signedIn);

// Nothing listens on port 1: any query through this pool fails, and the request with it.
const deadPool = new Pool({ host: '127.0.0.1', port: 1 });
after(() => deadPool.end());
const appWithoutDatabase = createSaeckelApp(deadPool, signedIn);

function get(path: string, who?: string, target = app) {
  return target.request(path, { headers: who === undefined ? {} : { 'x-test-user': who } });
}

function post(path: string, fields: Record<string, string>, who?: string, target = app) {
  return target.request(path, {
    method: 'POST',
    headers: { 'content-type': FORM, ...(who === undefined ? {} : { 'x-test-user': who }) },
    body: new URLSearchParams(fields).toString(),
  });
}

async function addPouch(userId: number, name: string, archived = false): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO pouches (user_id, name, is_archived) VALUES ($1, $2, $3) RETURNING id',
    [userId, name, archived],
  );
  return rows[0]!.id;
}

async function pouches() {
  const { rows } = await pool.query<{
    id: number;
    user_id: number;
    name: string;
    icon: string;
    is_archived: boolean;
  }>('SELECT id, user_id, name, icon, is_archived FROM pouches ORDER BY id');
  return rows;
}

// The items of the list of pouches, as text.
function listItems(page: string): string[] {
  return [...page.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.replace(/\s+/g, ' ').trim());
}

// Resolves once a query of hof_test waits for a lock held by another transaction.
async function waitingQuery(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query<{ query: string }>(
      "SELECT query FROM pg_stat_activity WHERE datname = 'hof_test' AND wait_event_type = 'Lock'",
    );
    if (rows[0] !== undefined) return rows[0].query;
    await sleep(10);
  }
  assert.fail('no query started waiting for the lock');
}

describe('who gets in', () => {
  test('no session: GET and HEAD keep the way back, POST goes to /login, nothing is queried', async () => {
    // Without a database: had a route queried anything before the session check, it would fail.
    for (const path of [
      '/saeckel/',
      '/saeckel/?a=1',
      '/saeckel/pouches/new',
      '/saeckel/pouches/1',
      '/saeckel/pouches/abc',
    ]) {
      const res = await get(path, undefined, appWithoutDatabase);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(path)}`);
      const head = await appWithoutDatabase.request(path, { method: 'HEAD' });
      assert.equal(head.status, 303, path);
    }
    const res = await post(
      '/saeckel/pouches/new',
      { name: 'Продукты' },
      undefined,
      appWithoutDatabase,
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');
    // And with the database: nothing was written.
    assert.equal((await post('/saeckel/pouches/new', { name: 'Продукты' })).status, 303);
    assert.deepEqual(await pouches(), []);
  });

  test('addresses that are not routes of Säckel: 404 with or without a session', async () => {
    for (const path of [
      '/saeckel',
      '/saeckel/x',
      '/saeckel/pouches',
      '/saeckel/pouches/',
      '/saeckel/pouches/1/x',
    ]) {
      // A guest gets the 404 without a query, the user gets the same.
      assert.equal((await get(path, undefined, appWithoutDatabase)).status, 404, path);
      assert.equal((await get(path, 'anna')).status, 404, path);
      assert.equal((await post(path, { name: 'x' }, undefined, appWithoutDatabase)).status, 404);
    }
    // A known address with a method it does not have.
    for (const path of ['/saeckel/', '/saeckel/pouches/1']) {
      assert.equal((await post(path, { name: 'x' }, undefined, appWithoutDatabase)).status, 404);
      assert.equal((await post(path, { name: 'x' }, 'anna')).status, 404);
    }
    assert.deepEqual(await pouches(), []);
  });
});

describe('Мешки', () => {
  test('no pouch yet: the empty state with the form of the first pouch', async () => {
    const res = await get('/saeckel/', 'anna');
    assert.equal(res.status, 200);
    // Text runs over lines in the template: compared with whitespace folded.
    const page = (await res.text()).replace(/\s+/g, ' ');
    for (const text of [
      '<title>Säckel — мешки</title>',
      '<a href="/">← Двор</a>',
      '<h1>Säckel</h1>',
      '<a href="/saeckel/" aria-current="page">Мешки</a>',
      '<h2>Мешков пока нет</h2>',
      'Заведите первый мешок: «Продукты», «Квартира», «Транспорт». Траты берутся из мешка, а остаток переходит дальше сам.',
      '<form method="post" action="/saeckel/pouches/new">',
      '<label for="name">Название</label>',
      '<button type="submit">Завести мешок</button>',
    ]) {
      assert.ok(page.includes(text), text);
    }
    assert.ok(!page.includes('+ Новый мешок'));
    // Nothing of M6 is shown before it works.
    for (const absent of ['Казна', 'Доход', 'Разложить', 'Переложить', 'Покрыть', 'Летопись']) {
      assert.ok(!page.includes(absent), absent);
    }
  });

  test('the active pouches of this user only, in the order they were made', async () => {
    const apples = await addPouch(1, 'Яблоки');
    await addPouch(2, 'Мешок Бориса');
    const oranges = await addPouch(1, 'Апельсины');
    await addPouch(1, 'Старый', true);
    const page = await (await get('/saeckel/', 'anna')).text();
    // By id, not by name: «Яблоки» was made first.
    assert.deepEqual(listItems(page), [
      `<a href="/saeckel/pouches/${apples}">Яблоки</a>`,
      `<a href="/saeckel/pouches/${oranges}">Апельсины</a>`,
    ]);
    assert.ok(page.includes('<a href="/saeckel/pouches/new">+ Новый мешок</a>'));
    assert.ok(!page.includes('Мешков пока нет'));
    assert.ok(!page.includes('Мешок Бориса'));
    assert.ok(!page.includes('Старый'));
    // Boris sees his own pouch and nothing of anna's.
    const his = await (await get('/saeckel/', 'boris')).text();
    assert.deepEqual(listItems(his), ['<a href="/saeckel/pouches/2">Мешок Бориса</a>']);
  });

  test('a name is escaped in the list', async () => {
    await addPouch(1, '<b>Пир</b> & Co');
    const page = await (await get('/saeckel/', 'anna')).text();
    assert.ok(page.includes('&lt;b&gt;Пир&lt;/b&gt; &amp; Co'));
    assert.ok(!page.includes('<b>'));
  });
});

describe('Новый мешок', () => {
  test('the page: the name only', async () => {
    const res = await get('/saeckel/pouches/new', 'anna');
    assert.equal(res.status, 200);
    const page = await res.text();
    for (const text of [
      '<title>Säckel — новый мешок</title>',
      '<p><a href="/saeckel/">Мешки</a></p>',
      '<h1>Новый мешок</h1>',
      '<form method="post" action="/saeckel/pouches/new">',
      '<label for="name">Название</label>',
      '<button type="submit">Завести мешок</button>',
    ]) {
      assert.ok(page.includes(text), text);
    }
    assert.equal((page.match(/<input/g) ?? []).length, 1);
  });

  test('made for the one signed in, NFC and trimmed, with the default sign', async () => {
    // «й» typed as «и» and a combining mark; a user_id and a sign in the form are ignored.
    const typed = '  Мой мешок  '.normalize('NFD');
    assert.notEqual(typed.trim(), typed.trim().normalize('NFC'));
    const res = await post(
      '/saeckel/pouches/new',
      { name: typed, user_id: '2', icon: 'cart', is_archived: 'true' },
      'anna',
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/saeckel/pouches/1');
    assert.deepEqual(await pouches(), [
      { id: 1, user_id: 1, name: 'Мой мешок'.normalize('NFC'), icon: 'pouch', is_archived: false },
    ]);
  });

  test('the edges of the name: 50 characters, emoji counted as one', async () => {
    for (const name of ['я', 'я'.repeat(50), '🪙'.repeat(50)]) {
      assert.equal((await post('/saeckel/pouches/new', { name }, 'anna')).status, 303, name);
    }
    assert.equal((await pouches()).length, 3);
  });

  const refused = [
    '',
    '   ',
    'я'.repeat(51),
    'Про\nдукты',
    'Про\tдукты',
    'Про\u007fдукты',
    'Про\u0000',
  ];
  for (const name of refused) {
    test(`a name ${JSON.stringify(name)}: 400, the typed value kept, nothing made`, async () => {
      const res = await post('/saeckel/pouches/new', { name }, 'anna');
      assert.equal(res.status, 400);
      const page = await res.text();
      assert.ok(page.includes(`<p id="name-error">${NAME_ERROR}</p>`));
      assert.match(page, /name="name"[^>]*aria-invalid="true"/);
      assert.deepEqual(await pouches(), []);
    });
  }

  test('no name field at all: the same 400', async () => {
    const res = await post('/saeckel/pouches/new', { title: 'Продукты' }, 'anna');
    assert.equal(res.status, 400);
    assert.ok((await res.text()).includes(NAME_ERROR));
  });

  test('a taken name, in any case: 400 with the typed name, escaped', async () => {
    await addPouch(1, 'Продукты');
    for (const name of ['Продукты', 'ПРОДУКТЫ', ' продукты ']) {
      const res = await post('/saeckel/pouches/new', { name }, 'anna');
      assert.equal(res.status, 400, name);
      const page = await res.text();
      assert.ok(page.includes(`<p id="name-error">${TAKEN}</p>`), name);
      assert.ok(page.includes(`value="${name}"`), name);
    }
    await addPouch(1, '<i>x</i>');
    const escaped = await (await post('/saeckel/pouches/new', { name: '<i>X</i>' }, 'anna')).text();
    assert.ok(escaped.includes('value="&lt;i&gt;X&lt;/i&gt;"'));
    assert.equal((await pouches()).length, 2);
  });

  test('the same name for another user, or beside a pouch in the storeroom: made', async () => {
    await addPouch(2, 'Продукты');
    await addPouch(1, 'Квартира', true);
    assert.equal((await post('/saeckel/pouches/new', { name: 'Продукты' }, 'anna')).status, 303);
    assert.equal((await post('/saeckel/pouches/new', { name: 'Квартира' }, 'anna')).status, 303);
  });

  test('any other refusal of the database is not «taken»: the error goes on', async (t: TestContext) => {
    // Without main.ts, Hono answers an unexpected error with its own 500.
    t.mock.method(console, 'error', () => undefined);
    await pool.query('ALTER TABLE pouches ADD CONSTRAINT pouches_none CHECK (false) NOT VALID');
    try {
      const res = await post('/saeckel/pouches/new', { name: 'Продукты' }, 'anna');
      assert.equal(res.status, 500);
      assert.ok(!(await res.text()).includes(TAKEN));
    } finally {
      await pool.query('ALTER TABLE pouches DROP CONSTRAINT IF EXISTS pouches_none');
    }
    // Another unique index: also 23505, but not pouches_active_name.
    await addPouch(1, 'Первый');
    await pool.query('CREATE UNIQUE INDEX pouches_one ON pouches ((true))');
    try {
      const res = await post('/saeckel/pouches/new', { name: 'Второй' }, 'anna');
      assert.equal(res.status, 500);
      assert.ok(!(await res.text()).includes(TAKEN));
    } finally {
      await pool.query('DROP INDEX IF EXISTS pouches_one');
    }
    assert.equal((await pouches()).length, 1);
  });

  test('one name from two places at once: the second INSERT waits, then «taken»', async () => {
    const rival = await pool.connect();
    try {
      await rival.query('BEGIN');
      await rival.query("INSERT INTO pouches (user_id, name) VALUES (1, 'Продукты')");
      const pending = post('/saeckel/pouches/new', { name: 'продукты' }, 'anna');
      // It is the INSERT that waits: on the unique index, for the rival's transaction.
      assert.match(await waitingQuery(), /^INSERT INTO pouches \(user_id, name\)/);
      await rival.query('COMMIT');
      const res = await pending;
      assert.equal(res.status, 400);
      assert.ok((await res.text()).includes(TAKEN));
    } finally {
      rival.release();
    }
    assert.deepEqual(
      (await pouches()).map((p) => p.name),
      ['Продукты'],
    );
  });
});

describe('the page of a pouch', () => {
  test('its name and the way back to the pouches', async () => {
    const id = await addPouch(1, 'Продукты');
    const res = await get(`/saeckel/pouches/${id}`, 'anna');
    assert.equal(res.status, 200);
    const page = await res.text();
    for (const text of [
      '<title>Säckel — Продукты</title>',
      '<p><a href="/saeckel/">Мешки</a></p>',
      '<h1>Продукты</h1>',
    ]) {
      assert.ok(page.includes(text), text);
    }
  });

  test('a pouch of somebody else is the same 404 as one that does not exist', async () => {
    const his = await addPouch(2, 'Мешок Бориса');
    const foreign = await get(`/saeckel/pouches/${his}`, 'anna');
    const missing = await get('/saeckel/pouches/99', 'anna');
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(await foreign.text(), await missing.text());
    // He opens it himself.
    assert.equal((await get(`/saeckel/pouches/${his}`, 'boris')).status, 200);
  });

  test('a wrong id is a 404', async () => {
    await addPouch(1, 'Продукты');
    for (const id of ['0', '01', '-1', '1.0', 'abc', '2147483648', '2147483647']) {
      assert.equal((await get(`/saeckel/pouches/${id}`, 'anna')).status, 404, id);
    }
  });
});
