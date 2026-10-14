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
import { dateForField, today } from './dates.ts';

const password = process.env.HOF_SAECKEL_DB_PASSWORD;
assert.ok(password, 'HOF_SAECKEL_DB_PASSWORD is not set: create .env from .env.example');
const pool = new Pool({ database: 'hof_test', user: 'hof_saeckel', password });

before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
beforeEach(() => pool.query('TRUNCATE operations, pouches RESTART IDENTITY'));
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

// The settings main.ts checks at startup.
const SETTINGS = { currency: 'RUB', timeZone: 'Europe/Moscow' };
const app = createSaeckelApp(pool, signedIn, SETTINGS);

// Nothing listens on port 1: any query through this pool fails, and the request with it.
const deadPool = new Pool({ host: '127.0.0.1', port: 1 });
after(() => deadPool.end());
const appWithoutDatabase = createSaeckelApp(deadPool, signedIn, SETTINGS);

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

// The pouches of the list, as their links, in the order shown. pouchLines gives the whole lines.
function listItems(page: string): string[] {
  return [...page.matchAll(/<li>\s*(<a [^>]*>[^<]*<\/a>)/g)].map((m) => m[1]!);
}

// The lines of the list of pouches, with whitespace folded.
function pouchLines(page: string): string[] {
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
      '/saeckel/pouches/1/edit',
    ]) {
      const res = await get(path, undefined, appWithoutDatabase);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(path)}`);
      const head = await appWithoutDatabase.request(path, { method: 'HEAD' });
      assert.equal(head.status, 303, path);
    }
    for (const path of ['/saeckel/pouches/new', '/saeckel/pouches/1/edit']) {
      const fields = { name: 'Продукты', icon: 'cart' };
      const res = await post(path, fields, undefined, appWithoutDatabase);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get('location'), '/login', path);
    }
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
    assert.ok(page.includes('<p>Знак мешка можно выбрать потом, в «Изменить».</p>'));
    // The first pouch is made from its name only.
    assert.equal((page.match(/<input/g) ?? []).length, 1);
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
    // «й» typed as «и» and a combining mark; a user_id in the form is ignored.
    const typed = '  Мой мешок  '.normalize('NFD');
    assert.notEqual(typed.trim(), typed.trim().normalize('NFC'));
    const res = await post(
      '/saeckel/pouches/new',
      { name: typed, user_id: '2', is_archived: 'true' },
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
      assert.match(await waitingQuery(), /^INSERT INTO pouches \(user_id, name, icon\)/);
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

const ICON_ERROR = 'Выберите знак из списка.';
// Copied from design/preview/PouchEditMobile.html on purpose: the test must not share the set
// with the code.
const SIGNS: [string, string][] = [
  ['pouch', 'мешок'],
  ['cart', 'повозка'],
  ['basket', 'корзина'],
  ['hearth', 'очаг'],
  ['jug', 'кувшин'],
  ['mortar', 'ступка'],
  ['needle', 'игла'],
  ['lute', 'лютня'],
  ['bundle', 'свёрток'],
  ['scroll', 'свиток'],
  ['pot', 'кубышка'],
  ['toyhorse', 'лошадка'],
  ['bowl', 'миска'],
  ['hammer', 'молоток'],
  ['books', 'книги'],
  ['bag', 'котомка'],
  ['comb', 'гребень'],
];

function edit(id: number | string, fields: Record<string, string>, who = 'anna') {
  return post(`/saeckel/pouches/${id}/edit`, fields, who);
}

async function pouch(id: number) {
  return (await pouches()).find((row) => row.id === id);
}

// The signs a page offers, in order, and the ones chosen.
function signs(page: string) {
  const radios = [
    ...page.matchAll(/<input\s+type="radio"\s+name="icon"\s+value="([^"]*)"\s*(checked)?/g),
  ];
  return {
    offered: radios.map((m) => m[1]!),
    checked: radios.filter((m) => m[2] !== undefined).map((m) => m[1]!),
  };
}

describe('Новый мешок: a sign sent with the name', () => {
  test('a key of the set is kept', async () => {
    const res = await post('/saeckel/pouches/new', { name: 'Еда', icon: 'basket' }, 'anna');
    assert.equal(res.status, 303);
    assert.equal((await pouches())[0]!.icon, 'basket');
  });

  for (const icon of ['', 'dragon', 'Cart', 'toString', '__proto__', 'pouch ']) {
    test(`a sign ${JSON.stringify(icon)}: 400 «${ICON_ERROR}», nothing made`, async () => {
      const res = await post('/saeckel/pouches/new', { name: 'Еда', icon }, 'anna');
      assert.equal(res.status, 400);
      const page = await res.text();
      assert.ok(page.includes(`<p id="icon-error">${ICON_ERROR}</p>`));
      assert.ok(page.includes('value="Еда"'));
      assert.deepEqual(await pouches(), []);
    });
  }
});

describe('Изменить мешок', () => {
  test('the page: the stored name and sign, the 17 signs in order, «Сохранить»', async () => {
    const id = await addPouch(1, 'Продукты');
    await pool.query("UPDATE pouches SET icon = 'cart' WHERE id = $1", [id]);
    const res = await get(`/saeckel/pouches/${id}/edit`, 'anna');
    assert.equal(res.status, 200);
    const page = await res.text();
    const flat = page.replace(/\s+/g, ' ');
    for (const text of [
      '<title>Säckel — Продукты</title>',
      `<p><a href="/saeckel/pouches/${id}">Продукты</a></p>`,
      '<h1>Мешок «Продукты»</h1>',
      `<form method="post" action="/saeckel/pouches/${id}/edit">`,
      '<label for="name">Название</label>',
      'value="Продукты"',
      '<legend>Знак мешка</legend>',
      '<button type="submit">Сохранить</button>',
    ]) {
      assert.ok(flat.includes(text), text);
    }
    for (const [key, label] of SIGNS) {
      assert.match(flat, new RegExp(`value="${key}"( checked)? /> ${label} </label>`), key);
    }
    assert.deepEqual(signs(page), { offered: SIGNS.map(([key]) => key), checked: ['cart'] });
  });

  test('a stored sign the set does not know shows as the default one', async () => {
    const id = await addPouch(1, 'Продукты');
    await pool.query("UPDATE pouches SET icon = 'dragon' WHERE id = $1", [id]);
    const page = await (await get(`/saeckel/pouches/${id}/edit`, 'anna')).text();
    assert.deepEqual(signs(page).checked, ['pouch']);
  });

  test('the page of an active pouch leads to «Изменить»; one in the storeroom does not', async () => {
    const active = await addPouch(1, 'Продукты');
    const stored = await addPouch(1, 'Старый', true);
    const page = await (await get(`/saeckel/pouches/${active}`, 'anna')).text();
    assert.ok(page.includes(`<a href="/saeckel/pouches/${active}/edit">Изменить</a>`));
    const old = await (await get(`/saeckel/pouches/${stored}`, 'anna')).text();
    assert.ok(!old.includes('Изменить'));
  });

  test('saved: the new name and sign, 303 to the pouch, the order of the list kept', async () => {
    const first = await addPouch(1, 'Яблоки');
    const second = await addPouch(1, 'Груши');
    const third = await addPouch(1, 'Сливы');
    const res = await edit(second, { name: '  Абрикосы  ', icon: 'basket' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/saeckel/pouches/${second}`);
    assert.deepEqual(await pouch(second), {
      id: second,
      user_id: 1,
      name: 'Абрикосы',
      icon: 'basket',
      is_archived: false,
    });
    // «Абрикосы» would come first by name; the list keeps the order the pouches were made in.
    const list = await (await get('/saeckel/', 'anna')).text();
    assert.deepEqual(listItems(list), [
      `<a href="/saeckel/pouches/${first}">Яблоки</a>`,
      `<a href="/saeckel/pouches/${second}">Абрикосы</a>`,
      `<a href="/saeckel/pouches/${third}">Сливы</a>`,
    ]);
    const page = await (await get(`/saeckel/pouches/${second}`, 'anna')).text();
    assert.ok(page.includes('<h1>Абрикосы</h1>'));
    const again = await (await get(`/saeckel/pouches/${second}/edit`, 'anna')).text();
    assert.deepEqual(signs(again).checked, ['basket']);
  });

  test('its own name in another case is no conflict', async () => {
    const id = await addPouch(1, 'Продукты');
    assert.equal((await edit(id, { name: 'ПРОДУКТЫ', icon: 'pouch' })).status, 303);
    assert.equal((await pouch(id))!.name, 'ПРОДУКТЫ');
  });

  test('the name of another active pouch: 400, the typed name and the chosen sign kept', async () => {
    await addPouch(1, 'Продукты');
    const id = await addPouch(1, 'Квартира');
    for (const name of ['Продукты', ' ПРОДУКТЫ ', 'продукты']) {
      const res = await edit(id, { name, icon: 'jug' });
      assert.equal(res.status, 400, name);
      const page = await res.text();
      assert.ok(page.includes(`<p id="name-error">${TAKEN}</p>`), name);
      assert.ok(page.includes(`value="${name}"`), name);
      assert.deepEqual(signs(page).checked, ['jug'], name);
      // The heading keeps the stored name.
      assert.ok(page.includes('<h1>Мешок «Квартира»</h1>'), name);
    }
    assert.deepEqual(await pouch(id), {
      id,
      user_id: 1,
      name: 'Квартира',
      icon: 'pouch',
      is_archived: false,
    });
  });

  test('a pouch in the storeroom, or of another user, does not take the name', async () => {
    await addPouch(1, 'Квартира', true);
    await addPouch(2, 'Транспорт');
    const id = await addPouch(1, 'Продукты');
    assert.equal((await edit(id, { name: 'Квартира', icon: 'hearth' })).status, 303);
    assert.equal((await edit(id, { name: 'Транспорт', icon: 'cart' })).status, 303);
    assert.equal((await pouch(id))!.name, 'Транспорт');
  });

  for (const name of ['', '   ', 'я'.repeat(51), 'Про\nдукты']) {
    test(`a name ${JSON.stringify(name)}: 400, the chosen sign kept, nothing changed`, async () => {
      const id = await addPouch(1, 'Продукты');
      const res = await edit(id, { name, icon: 'jug' });
      assert.equal(res.status, 400);
      const page = await res.text();
      assert.ok(page.includes(`<p id="name-error">${NAME_ERROR}</p>`));
      assert.deepEqual(signs(page).checked, ['jug']);
      assert.equal((await pouch(id))!.name, 'Продукты');
    });
  }

  const wrongSigns: [string, Record<string, string>][] = [
    ['no sign', { name: 'Еда' }],
    ['an empty sign', { name: 'Еда', icon: '' }],
    ['an unknown sign', { name: 'Еда', icon: 'dragon' }],
    ['a key of every object', { name: 'Еда', icon: 'toString' }],
  ];
  for (const [label, fields] of wrongSigns) {
    test(`${label}: 400 «${ICON_ERROR}», the typed name kept, nothing changed`, async () => {
      const id = await addPouch(1, 'Продукты');
      const res = await edit(id, fields);
      assert.equal(res.status, 400);
      const page = await res.text();
      assert.ok(page.includes(`<p id="icon-error">${ICON_ERROR}</p>`));
      assert.ok(page.includes('value="Еда"'));
      assert.deepEqual(signs(page).checked, []);
      assert.deepEqual(await pouch(id), {
        id,
        user_id: 1,
        name: 'Продукты',
        icon: 'pouch',
        is_archived: false,
      });
    });
  }

  test('somebody else’s, a missing, a wrong id or a pouch in the storeroom: the same 404', async () => {
    const his = await addPouch(2, 'Мешок Бориса');
    const stored = await addPouch(1, 'Старый', true);
    const missing = await (await get('/saeckel/pouches/99/edit', 'anna')).text();
    for (const id of [String(his), String(stored), '99', '0', '01', 'abc', '2147483648']) {
      const page = await get(`/saeckel/pouches/${id}/edit`, 'anna');
      assert.equal(page.status, 404, id);
      assert.equal(await page.text(), missing, id);
      const save = await edit(id, { name: 'Новое', icon: 'cart' });
      assert.equal(save.status, 404, id);
    }
    assert.deepEqual(
      (await pouches()).map((row) => [row.name, row.icon]),
      [
        ['Мешок Бориса', 'pouch'],
        ['Старый', 'pouch'],
      ],
    );
  });

  test('a user_id in the form is ignored', async () => {
    const id = await addPouch(1, 'Продукты');
    assert.equal((await edit(id, { name: 'Еда', icon: 'pouch', user_id: '2' })).status, 303);
    assert.equal((await pouch(id))!.user_id, 1);
  });

  test('a rename and a new pouch of one name at once: the UPDATE waits, then «taken»', async () => {
    const id = await addPouch(1, 'Продукты');
    const rival = await pool.connect();
    try {
      await rival.query('BEGIN');
      await rival.query("INSERT INTO pouches (user_id, name) VALUES (1, 'Квартира')");
      const pending = edit(id, { name: 'квартира', icon: 'pouch' });
      // It is the UPDATE that waits: on the unique index, for the rival's transaction.
      assert.match(await waitingQuery(), /^UPDATE pouches SET name = \$1, icon = \$2/);
      await rival.query('COMMIT');
      const res = await pending;
      assert.equal(res.status, 400);
      assert.ok((await res.text()).includes(TAKEN));
    } finally {
      rival.release();
    }
    assert.deepEqual(
      (await pouches()).map((row) => row.name),
      ['Продукты', 'Квартира'],
    );
  });

  // The pouch changes after it was looked up and before the UPDATE writes. The first case is
  // the storeroom, opened in another tab; the second one cannot happen through Hof — the owner
  // of a pouch never changes — and shows that the UPDATE does not rely on the earlier look.
  for (const [label, change] of [
    ['goes into the storeroom', 'UPDATE pouches SET is_archived = true WHERE id = $1'],
    ['belongs to somebody else', 'UPDATE pouches SET user_id = 2 WHERE id = $1'],
  ] as const) {
    test(`the pouch ${label} meanwhile: the UPDATE checks again, 404, nothing written`, async () => {
      const id = await addPouch(1, 'Продукты');
      const rival = await pool.connect();
      try {
        await rival.query('BEGIN');
        await rival.query(change, [id]);
        const pending = edit(id, { name: 'Еда', icon: 'cart' });
        // The look-up saw the pouch as it was; the UPDATE waits for the rival's row.
        assert.match(await waitingQuery(), /^UPDATE pouches SET name = \$1, icon = \$2/);
        await rival.query('COMMIT');
        assert.equal((await pending).status, 404);
      } finally {
        rival.release();
      }
      const row = await pouch(id);
      assert.equal(row!.name, 'Продукты');
      assert.equal(row!.icon, 'pouch');
    });
  }

  test('any other refusal of the database is not «taken»: the error goes on', async (t: TestContext) => {
    t.mock.method(console, 'error', () => undefined);
    const id = await addPouch(1, 'Продукты');
    await pool.query('ALTER TABLE pouches ADD CONSTRAINT pouches_none CHECK (false) NOT VALID');
    try {
      const res = await edit(id, { name: 'Еда', icon: 'cart' });
      assert.equal(res.status, 500);
      assert.ok(!(await res.text()).includes(TAKEN));
    } finally {
      await pool.query('ALTER TABLE pouches DROP CONSTRAINT IF EXISTS pouches_none');
    }
    // Another unique index: also 23505, but not pouches_active_name.
    await pool.query("UPDATE pouches SET icon = 'jug' WHERE id = $1", [id]);
    await addPouch(1, 'Квартира');
    await pool.query('CREATE UNIQUE INDEX pouches_one_icon ON pouches (icon)');
    try {
      const res = await edit(id, { name: 'Продукты', icon: 'pouch' });
      assert.equal(res.status, 500);
      assert.ok(!(await res.text()).includes(TAKEN));
    } finally {
      await pool.query('DROP INDEX IF EXISTS pouches_one_icon');
    }
    assert.deepEqual(await pouch(id), {
      id,
      user_id: 1,
      name: 'Продукты',
      icon: 'jug',
      is_archived: false,
    });
  });
});

// M5.3: records, balances and expenses.

// A record written straight into the table, as M6 will write the kinds M5 has no form for.
async function addOperation(
  userId: number,
  kind: 'income' | 'assign' | 'expense' | 'transfer',
  cents: number,
  pouches: { from?: number; to?: number } = {},
  date = '2026-10-05',
  note = '',
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO operations (user_id, kind, amount, currency, from_pouch_id, to_pouch_id, date, note)
     VALUES ($1, $2, $3, 'RUB', $4, $5, $6, $7) RETURNING id`,
    [userId, kind, cents, pouches.from ?? null, pouches.to ?? null, date, note],
  );
  return rows[0]!.id;
}

async function operations() {
  const { rows } = await pool.query<{
    id: number;
    user_id: number;
    kind: string;
    amount: string;
    currency: string;
    from_pouch_id: number | null;
    to_pouch_id: number | null;
    date: string;
    note: string;
  }>(
    `SELECT id, user_id, kind, amount::text AS amount, currency, from_pouch_id, to_pouch_id,
            to_char(date, 'YYYY-MM-DD') AS date, note
       FROM operations ORDER BY id`,
  );
  return rows;
}

function spend(id: number | string, fields: Record<string, string>, who = 'anna') {
  return post(`/saeckel/pouches/${id}/expense`, fields, who);
}

// The rows of the list of expenses on a pouch page, with whitespace folded.
function expenseRows(page: string): string[] {
  const list = /<\/form>([\s\S]*)$/.exec(page)?.[1] ?? page;
  return [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.replace(/\s+/g, ' ').trim());
}

// Resolves once `count` queries of hof_test wait for locks; returns them.
async function waitingQueries(count: number): Promise<string[]> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query<{ query: string }>(
      "SELECT query FROM pg_stat_activity WHERE datname = 'hof_test' AND wait_event_type = 'Lock'",
    );
    if (rows.length >= count) return rows.map((row) => row.query);
    await sleep(10);
  }
  assert.fail(`${count} queries never waited for a lock`);
}

// After a request: every client is back in the pool, no connection was left inside a
// transaction, and nobody holds the row of the pouch.
async function assertNothingHeld(pouchId: number): Promise<void> {
  assert.equal(pool.totalCount - pool.idleCount, 0, 'a client was not released');
  const { rows } = await pool.query<{ open: number }>(
    "SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = 'hof_test' AND state LIKE 'idle in transaction%'",
  );
  assert.equal(rows[0]!.open, 0, 'a transaction was left open');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE NOWAIT', [pouchId]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const ARCHIVED = 'Мешок в Кладовой: траты в нём не записываются.';

// A page with whitespace folded: money on the page is spaced with U+00A0.
const fold = (page: string) => page.replace(/\s+/g, ' ');

describe('balances on Мешки', () => {
  test('a pouch without records: 0,00 ₽ and no expenses yet', async () => {
    const id = await addPouch(1, 'Продукты');
    const page = await (await get('/saeckel/', 'anna')).text();
    assert.deepEqual(pouchLines(page), [
      `<a href="/saeckel/pouches/${id}">Продукты</a> · 0,00 ₽ · трат пока не было`,
    ]);
  });

  test('expenses alone put a pouch in debt', async () => {
    const id = await addPouch(1, 'Продукты');
    await addOperation(1, 'expense', 124050, { from: id });
    const page = await (await get('/saeckel/', 'anna')).text();
    assert.deepEqual(pouchLines(page), [
      `<a href="/saeckel/pouches/${id}">Продукты</a> · −1 240,50 ₽ · в долгу`,
    ]);
  });

  test('the balance over every kind of record: in minus out', async () => {
    const food = await addPouch(1, 'Продукты');
    const flat = await addPouch(1, 'Квартира');
    await addOperation(1, 'income', 50000);
    await addOperation(1, 'assign', 10000, { to: food });
    await addOperation(1, 'transfer', 3000, { from: food, to: flat });
    await addOperation(1, 'expense', 2000, { from: food });
    await addOperation(1, 'transfer', 500, { from: flat, to: food });
    // Продукты: 100,00 − 30,00 − 20,00 + 5,00; Квартира: 30,00 − 5,00. Income is in no pouch.
    const page = await (await get('/saeckel/', 'anna')).text();
    assert.deepEqual(pouchLines(page), [
      `<a href="/saeckel/pouches/${food}">Продукты</a> · 55,00 ₽ · последняя трата −20,00 ₽`,
      `<a href="/saeckel/pouches/${flat}">Квартира</a> · 25,00 ₽ · трат пока не было`,
    ]);
    const own = await (await get(`/saeckel/pouches/${food}`, 'anna')).text();
    assert.ok(fold(own).includes('<p>Остаток 55,00 ₽</p>'));
  });

  test('the last expense is the latest by date, then by id', async () => {
    const id = await addPouch(1, 'Продукты');
    await addOperation(1, 'assign', 100000, { to: id });
    await addOperation(1, 'expense', 100, { from: id }, '2026-10-05');
    await addOperation(1, 'expense', 200, { from: id }, '2026-10-07');
    await addOperation(1, 'expense', 300, { from: id }, '2026-10-07');
    await addOperation(1, 'expense', 400, { from: id }, '2026-10-06');
    const page = await (await get('/saeckel/', 'anna')).text();
    assert.deepEqual(pouchLines(page), [
      `<a href="/saeckel/pouches/${id}">Продукты</a> · 990,00 ₽ · последняя трата −3,00 ₽`,
    ]);
  });

  test('records of another user count for nothing here', async () => {
    const hers = await addPouch(1, 'Продукты');
    const his = await addPouch(2, 'Продукты');
    await addOperation(2, 'assign', 70000, { to: his });
    await addOperation(2, 'expense', 1000, { from: his });
    const page = await (await get('/saeckel/', 'anna')).text();
    assert.deepEqual(pouchLines(page), [
      `<a href="/saeckel/pouches/${hers}">Продукты</a> · 0,00 ₽ · трат пока не было`,
    ]);
    const own = await (await get(`/saeckel/pouches/${hers}`, 'anna')).text();
    assert.ok(fold(own).includes('<p>Остаток 0,00 ₽</p>'));
    assert.deepEqual(expenseRows(own), []);
  });

  test('a balance beyond the exact range of numbers: 500, and no amount in the error', async (t: TestContext) => {
    const errors: unknown[] = [];
    t.mock.method(console, 'error', (error: unknown) => errors.push(error));
    const id = await addPouch(1, 'Продукты');
    // 90 072 records of 1 000 000 000,00: more hundredths than a number holds exactly.
    await pool.query(
      `INSERT INTO operations (user_id, kind, amount, currency, to_pouch_id, date)
       SELECT 1, 'assign', 100000000000, 'RUB', $1, '2026-10-05' FROM generate_series(1, 90072)`,
      [id],
    );
    for (const path of ['/saeckel/', `/saeckel/pouches/${id}`]) {
      const res = await get(path, 'anna');
      assert.equal(res.status, 500, path);
    }
    const messages = errors.map((error) =>
      error instanceof Error ? error.message : String(error),
    );
    assert.ok(messages.length > 0);
    for (const message of messages) {
      assert.equal(message, 'a sum is outside the exact range of numbers');
      assert.doesNotMatch(message, /\d{4}/);
    }
  });
});

describe('the page of a pouch: balance, form, expenses', () => {
  test('the balance, and the form with today and the sign of the currency', async () => {
    const id = await addPouch(1, 'Продукты');
    const page = await (await get(`/saeckel/pouches/${id}`, 'anna')).text();
    const flat = page.replace(/\s+/g, ' ');
    for (const text of [
      '<p>Остаток 0,00 ₽</p>',
      '<h2>Записать трату</h2>',
      `<form method="post" action="/saeckel/pouches/${id}/expense">`,
      '<label for="amount">Сумма, ₽</label>',
      'inputmode="decimal"',
      '<label for="date">Дата</label>',
      `value="${dateForField(today('Europe/Moscow', new Date()))}"`,
      '<label for="note">Заметка</label>',
      '<button type="submit">Записать трату</button>',
    ]) {
      assert.ok(flat.includes(text), text);
    }
    assert.equal((page.match(/<input/g) ?? []).length, 3);
  });

  test('another currency of the installation', async () => {
    const euro = createSaeckelApp(pool, signedIn, { currency: 'EUR', timeZone: 'Europe/Berlin' });
    const id = await addPouch(1, 'Lebensmittel');
    await addOperation(1, 'expense', 124050, { from: id });
    const page = await (await get(`/saeckel/pouches/${id}`, 'anna', euro)).text();
    assert.ok(page.includes('<label for="amount">Сумма, €</label>'));
    assert.ok(fold(page).includes('<p>Остаток −1 240,50 €</p>'));
  });

  test('the last 10 expenses of this pouch, newest first, by date and then by id', async () => {
    const id = await addPouch(1, 'Продукты');
    const other = await addPouch(1, 'Квартира');
    // Twelve expenses over three days, written out of order; the oldest two are not shown.
    const written: [string, number][] = [];
    for (let n = 1; n <= 12; n++) {
      const date = `2026-10-0${(n % 3) + 1}`;
      written.push([
        date,
        await addOperation(1, 'expense', n * 100, { from: id }, date, `трата ${n}`),
      ]);
    }
    await addOperation(1, 'assign', 5000, { to: id });
    await addOperation(1, 'expense', 999, { from: other }, '2026-10-09', 'не отсюда');
    const page = await (await get(`/saeckel/pouches/${id}`, 'anna')).text();
    const expected = written
      .map(([date, opId], index) => ({ date, opId, n: index + 1 }))
      .sort((a, b) => (a.date === b.date ? b.opId - a.opId : a.date < b.date ? 1 : -1))
      .slice(0, 10)
      .map(({ date, n }) => `${date.slice(8)}.${date.slice(5, 7)} · трата ${n} · −${n},00 ₽`);
    assert.deepEqual(expenseRows(page), expected);
    assert.ok(!page.includes('не отсюда'));
  });

  test('a row without a note, and a note escaped', async () => {
    const id = await addPouch(1, 'Продукты');
    await addOperation(1, 'expense', 100, { from: id }, '2026-10-05', '');
    await addOperation(1, 'expense', 200, { from: id }, '2026-10-06', '<b>пир</b> & co');
    const page = await (await get(`/saeckel/pouches/${id}`, 'anna')).text();
    assert.deepEqual(expenseRows(page), [
      '06.10 · &lt;b&gt;пир&lt;/b&gt; &amp; co · −2,00 ₽',
      '05.10 · −1,00 ₽',
    ]);
  });

  test('fresh marks the record just written, if it is one of those shown', async () => {
    const id = await addPouch(1, 'Продукты');
    const his = await addPouch(2, 'Продукты');
    const shown = await addOperation(1, 'expense', 100, { from: id }, '2026-10-05', 'новая');
    const foreign = await addOperation(2, 'expense', 100, { from: his });
    const old = await addOperation(1, 'expense', 100, { from: id }, '2001-01-01', 'старая');
    for (let n = 0; n < 10; n++) await addOperation(1, 'expense', 100, { from: id }, '2026-09-01');
    const marked = await (await get(`/saeckel/pouches/${id}?fresh=${shown}`, 'anna')).text();
    assert.equal((marked.match(/<mark>/g) ?? []).length, 1);
    assert.match(marked.replace(/\s+/g, ' '), /<mark>05\.10 · новая · −1,00 ₽<\/mark>/);
    // Somebody else's, one not among the ten shown, and ids of the wrong form mark nothing.
    for (const fresh of [String(foreign), String(old), `0${shown}`, `${shown}.0`, 'abc', '']) {
      const page = await (await get(`/saeckel/pouches/${id}?fresh=${fresh}`, 'anna')).text();
      assert.ok(!page.includes('<mark>'), fresh);
    }
  });

  test('a pouch in the storeroom shows its balance and expenses, without the form', async () => {
    const id = await addPouch(1, 'Старый', true);
    await addOperation(1, 'expense', 100, { from: id });
    const page = await (await get(`/saeckel/pouches/${id}`, 'anna')).text();
    assert.ok(fold(page).includes('<p>Остаток −1,00 ₽</p>'));
    assert.ok(!page.includes('<form'));
    assert.deepEqual(expenseRows(page), ['05.10 · −1,00 ₽']);
  });
});

describe('Записать трату', () => {
  test('written for the one signed in: 303 with fresh, then the new balance and the row', async () => {
    const id = await addPouch(1, 'Продукты');
    const res = await spend(id, { amount: '1 240,50', date: '05.10.2026', note: '  овощи  ' });
    assert.equal(res.status, 303);
    const [record] = await operations();
    assert.ok(record);
    assert.equal(res.headers.get('location'), `/saeckel/pouches/${id}?fresh=${record.id}`);
    assert.deepEqual(record, {
      id: record.id,
      user_id: 1,
      kind: 'expense',
      amount: '124050',
      currency: 'RUB',
      from_pouch_id: id,
      to_pouch_id: null,
      date: '2026-10-05',
      note: 'овощи',
    });
    const page = await (await get(res.headers.get('location')!, 'anna')).text();
    assert.ok(fold(page).includes('<p>Остаток −1 240,50 ₽</p>'));
    assert.match(page.replace(/\s+/g, ' '), /<mark>05\.10 · овощи · −1 240,50 ₽<\/mark>/);
    const list = await (await get('/saeckel/', 'anna')).text();
    assert.deepEqual(pouchLines(list), [
      `<a href="/saeckel/pouches/${id}">Продукты</a> · −1 240,50 ₽ · в долгу`,
    ]);
  });

  test('amounts are stored as exact hundredths, even where a float would not be exact', async () => {
    const id = await addPouch(1, 'Продукты');
    for (const amount of ['0,29', '1,15', '0,57']) {
      assert.equal((await spend(id, { amount, date: '', note: '' })).status, 303, amount);
    }
    assert.deepEqual(
      (await operations()).map((row) => row.amount),
      ['29', '115', '57'],
    );
    const page = await (await get(`/saeckel/pouches/${id}`, 'anna')).text();
    assert.ok(fold(page).includes('<p>Остаток −2,01 ₽</p>'));
  });

  test('no date means today in the time zone of the court; ISO is accepted too', async () => {
    const id = await addPouch(1, 'Продукты');
    assert.equal((await spend(id, { amount: '1', date: '', note: '' })).status, 303);
    assert.equal((await spend(id, { amount: '1', date: '2026-01-31', note: '' })).status, 303);
    assert.deepEqual(
      (await operations()).map((row) => row.date),
      [today('Europe/Moscow', new Date()), '2026-01-31'],
    );
  });

  test('other fields of the form change nothing: the user, the kind, the currency, the pouches', async () => {
    const id = await addPouch(1, 'Продукты');
    const other = await addPouch(1, 'Квартира');
    const his = await addPouch(2, 'Продукты');
    const res = await spend(id, {
      amount: '5',
      date: '05.10.2026',
      note: '',
      user_id: '2',
      kind: 'income',
      currency: 'EUR',
      from_pouch_id: String(his),
      to_pouch_id: String(other),
    });
    assert.equal(res.status, 303);
    const [record] = await operations();
    assert.equal(record!.user_id, 1);
    assert.equal(record!.kind, 'expense');
    assert.equal(record!.currency, 'RUB');
    assert.equal(record!.from_pouch_id, id);
    assert.equal(record!.to_pouch_id, null);
  });

  const refusals: [string, Record<string, string>, Record<string, string>][] = [
    [
      'an amount of the wrong form',
      { amount: '1,2,3' },
      { amount: 'Сумма — число, например 1 240,50.' },
    ],
    ['no amount', { amount: '' }, { amount: 'Сумма — число, например 1 240,50.' }],
    ['a zero amount', { amount: '0,00' }, { amount: 'Сумма должна быть больше нуля.' }],
    [
      'a too big amount',
      { amount: '1 000 000 000,01' },
      { amount: 'Сумма — не больше 1 000 000 000,00.' },
    ],
    [
      'a day that does not exist',
      { date: '31.02.2026' },
      { date: 'Дата — ДД.ММ.ГГГГ, не раньше 01.01.2000 и не дальше года вперёд.' },
    ],
    [
      'a date too far back',
      { date: '31.12.1999' },
      { date: 'Дата — ДД.ММ.ГГГГ, не раньше 01.01.2000 и не дальше года вперёд.' },
    ],
    [
      'a note too long',
      { note: 'я'.repeat(201) },
      { note: 'Заметка — до 200 символов, одной строкой.' },
    ],
    [
      'a note of two lines',
      { note: 'раз\nдва' },
      { note: 'Заметка — до 200 символов, одной строкой.' },
    ],
    [
      'every field wrong',
      { amount: '-5', date: 'вчера', note: 'a\u0000' },
      {
        amount: 'Сумма — число, например 1 240,50.',
        date: 'Дата — ДД.ММ.ГГГГ, не раньше 01.01.2000 и не дальше года вперёд.',
        note: 'Заметка — до 200 символов, одной строкой.',
      },
    ],
  ];
  for (const [name, wrong, errors] of refusals) {
    test(`${name}: 400, the error under its field, what was typed kept, nothing written`, async () => {
      const id = await addPouch(1, 'Продукты');
      const fields = { amount: '1 240,50', date: '05.10.2026', note: 'овощи', ...wrong };
      const res = await spend(id, fields);
      assert.equal(res.status, 400);
      const page = await res.text();
      for (const field of ['amount', 'date', 'note']) {
        const error = errors[field];
        if (error === undefined) {
          assert.ok(!page.includes(`id="${field}-error"`), field);
        } else {
          assert.ok(page.includes(`<p id="${field}-error">${error}</p>`), field);
          assert.match(page, new RegExp(`name="${field}"[^>]*aria-invalid="true"`), field);
        }
        const typed = fields[field as keyof typeof fields];
        assert.ok(page.includes(`value="${typed}"`), `${field} kept`);
      }
      assert.ok(fold(page).includes('<p>Остаток 0,00 ₽</p>'));
      assert.deepEqual(await operations(), []);
    });
  }

  test('somebody else’s, a missing or a wrong pouch: the same 404, nothing written', async () => {
    const his = await addPouch(2, 'Продукты');
    const missing = await (await spend(99, { amount: '1' })).text();
    for (const id of [String(his), '99', '0', '01', 'abc', '2147483648']) {
      const res = await spend(id, { amount: '1', date: '', note: '' });
      assert.equal(res.status, 404, id);
      assert.equal(await res.text(), missing, id);
    }
    assert.deepEqual(await operations(), []);
  });

  test('a pouch in the storeroom takes no expense: 400, nothing written', async () => {
    const id = await addPouch(1, 'Старый', true);
    const res = await spend(id, { amount: '1', date: '', note: '' });
    assert.equal(res.status, 400);
    const page = await res.text();
    assert.ok(page.includes(`<p id="expense-error">${ARCHIVED}</p>`));
    assert.ok(!page.includes('<form'));
    assert.deepEqual(await operations(), []);
    await assertNothingHeld(id);
  });

  test('without a session: /login, nothing written', async () => {
    const id = await addPouch(1, 'Продукты');
    const res = await post(
      `/saeckel/pouches/${id}/expense`,
      { amount: '1' },
      undefined,
      appWithoutDatabase,
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');
    assert.deepEqual(await operations(), []);
  });

  test('two expenses at once: both wait for the row of the pouch, both are written', async () => {
    const id = await addPouch(1, 'Продукты');
    const rival = await pool.connect();
    try {
      await rival.query('BEGIN');
      await rival.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE', [id]);
      const first = spend(id, { amount: '100', date: '05.10.2026', note: 'раз' });
      const second = spend(id, { amount: '0,50', date: '05.10.2026', note: 'два' });
      // Both lock the row of the pouch before they write, so both wait for the rival.
      const waiting = await waitingQueries(2);
      for (const query of waiting) {
        assert.match(
          query,
          /^SELECT is_archived FROM pouches WHERE id = \$1 AND user_id = \$2 FOR UPDATE/,
        );
      }
      await rival.query('COMMIT');
      assert.equal((await first).status, 303);
      assert.equal((await second).status, 303);
    } finally {
      rival.release();
    }
    assert.deepEqual((await operations()).map((row) => row.amount).sort(), ['10000', '50']);
    const page = await (await get(`/saeckel/pouches/${id}`, 'anna')).text();
    assert.ok(fold(page).includes('<p>Остаток −100,50 ₽</p>'));
  });

  test('the pouch goes into the storeroom while the expense waits: the lock sees it, 400', async () => {
    const id = await addPouch(1, 'Продукты');
    const rival = await pool.connect();
    try {
      await rival.query('BEGIN');
      await rival.query('UPDATE pouches SET is_archived = true WHERE id = $1', [id]);
      // The page was open: the look-up still sees the pouch as it was; the lock waits.
      const pending = spend(id, { amount: '1', date: '', note: '' });
      const [query] = await waitingQueries(1);
      assert.match(query!, /FOR UPDATE/);
      await rival.query('COMMIT');
      const res = await pending;
      assert.equal(res.status, 400);
      assert.ok((await res.text()).includes(ARCHIVED));
    } finally {
      rival.release();
    }
    assert.deepEqual(await operations(), []);
  });

  test('the INSERT fails: ROLLBACK, nothing written, the client back, the row free', async (t: TestContext) => {
    t.mock.method(console, 'error', () => undefined);
    const id = await addPouch(1, 'Продукты');
    await pool.query(
      "CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$",
    );
    await pool.query(
      'CREATE TRIGGER operations_no_insert BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION refuse_for_test()',
    );
    try {
      const res = await spend(id, { amount: '7 777,77', date: '', note: 'тайная заметка' });
      assert.equal(res.status, 500);
      await assertNothingHeld(id);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS operations_no_insert ON operations');
      await pool.query('DROP FUNCTION IF EXISTS refuse_for_test()');
    }
    assert.deepEqual(await operations(), []);
    // The same expense goes through once the database lets it.
    assert.equal((await spend(id, { amount: '7 777,77', date: '', note: '' })).status, 303);
  });

  test('the COMMIT fails: 500, no redirect to a record that does not exist', async (t: TestContext) => {
    t.mock.method(console, 'error', () => undefined);
    const id = await addPouch(1, 'Продукты');
    // A deferred trigger runs at COMMIT, after the INSERT went through.
    await pool.query(
      "CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$",
    );
    await pool.query(
      'CREATE CONSTRAINT TRIGGER operations_refuse_at_commit AFTER INSERT ON operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_for_test()',
    );
    try {
      const res = await spend(id, { amount: '1', date: '', note: '' });
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('location'), null);
      await assertNothingHeld(id);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS operations_refuse_at_commit ON operations');
      await pool.query('DROP FUNCTION IF EXISTS refuse_for_test()');
    }
    assert.deepEqual(await operations(), []);
  });
});
