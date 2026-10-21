// Säckel on its own (ARCHITECTURE.md §2, §4.1, §4.6): the session check of each route, the
// pouches of one user only, the new pouch. Database: hof_test as hof_saeckel. Who is signed in
// comes from a stand-in for the function main.ts passes; Säckel's tests do not import Core, and
// the wiring through main.ts is tested in src/main.test.ts.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { migrate } from '../migrate.ts';
import { createSaeckelApp } from './app.ts';
import { dateForField, today } from './dates.ts';
import {
  activeList,
  addOperation,
  addPouch,
  appWithoutDatabase,
  assertNothingHeld,
  deadPool,
  failingTrigger,
  fold,
  currentTab,
  get,
  mainPart,
  operations,
  pool,
  post,
  pouchLines,
  pouches,
  signedIn,
  waitingQueries,
  wayBack,
} from './test-helpers.ts';

before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
beforeEach(() => pool.query('TRUNCATE operations, pouches RESTART IDENTITY'));
after(() => Promise.all([pool.end(), deadPool.end()]));

const NAME_ERROR = 'Название — от 1 до 50 символов, одной строкой.';
const TAKEN = 'Мешок с таким названием уже есть.';

// The pouches of the list, as their links, in the order shown. pouchLines gives the whole lines.
function listItems(page: string): string[] {
  return pouchLines(page).map((line) => line.split(' · ')[0]!);
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
    for (const path of [
      '/saeckel/pouches/new',
      '/saeckel/pouches/1/edit',
      '/saeckel/pouches/1/archive',
      '/saeckel/pouches/1/restore',
      '/saeckel/pouches/abc/archive',
    ]) {
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
    for (const path of ['/saeckel/pouches/1/archive', '/saeckel/pouches/1/restore']) {
      assert.equal((await get(path, undefined, appWithoutDatabase)).status, 404, path);
      assert.equal((await get(path, 'anna')).status, 404, path);
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
      '<h1 class="ribbon ribbon-md"><span>Säckel</span></h1>',
      '<a class="tab" href="/saeckel/" aria-current="page">Мешки</a>',
      '<h2 class="title">Мешков пока нет</h2>',
      'Заведите первый мешок: «Продукты», «Квартира», «Транспорт». Траты берутся из мешка, а остаток переходит дальше сам.',
      '<form class="form-row new-pouch" method="post" action="/saeckel/pouches/new">',
      '<label for="name">Название</label>',
      '<button type="submit" class="btn btn-ochre">Завести мешок</button>',
    ]) {
      assert.ok(page.includes(text), text);
    }
    assert.match(page, /<a class="sk-gate sk-court" href="\/" ?><img [^>]*\/>Двор<\/a ?>/);
    assert.equal(wayBack(page), undefined);
    assert.ok(
      page.includes('<p class="hint text-full">Знак мешка можно выбрать потом, в «Изменить».</p>'),
    );
    // The first pouch is made from its name only.
    assert.equal((page.match(/<input/g) ?? []).length, 1);
    assert.ok(!page.includes('+ Новый мешок'));
    // Nothing of M6 is shown before it works; the treasury came with M6.1, «Летопись» with M6.3.
    for (const absent of ['Переложить', 'Покрыть']) {
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
    assert.ok(page.includes('<a class="link-plain" href="/saeckel/pouches/new">+ Новый мешок</a>'));
    assert.ok(!page.includes('Мешков пока нет'));
    assert.ok(!page.includes('Мешок Бориса'));
    // The one in the storeroom is not in the list: it is in «Кладовая».
    assert.ok(!activeList(page).includes('Старый'));
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
      '<p class="ribbon ribbon-md"><span>Säckel</span></p>',
      '<h1>Новый мешок</h1>',
      '<form class="form-row new-pouch" method="post" action="/saeckel/pouches/new">',
      '<label for="name">Название</label>',
      '<button type="submit" class="btn btn-ochre">Завести мешок</button>',
    ]) {
      assert.ok(page.includes(text), text);
    }
    assert.equal(wayBack(page), '/saeckel/ Мешки');
    assert.equal(currentTab(page), 'Мешки');
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
      assert.ok(page.includes(`<p id="name-error" class="err-text">${NAME_ERROR}</p>`));
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
      assert.ok(page.includes(`<p id="name-error" class="err-text">${TAKEN}</p>`), name);
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
    for (const text of ['<title>Säckel — Продукты</title>', '<h1>Продукты</h1>']) {
      assert.ok(page.includes(text), text);
    }
    assert.equal(wayBack(page), '/saeckel/ Мешки');
    assert.equal(currentTab(page), 'Мешки');
    // The pouch is the current one in the column beside the page.
    assert.match(
      page,
      new RegExp(`<a\\s+class="pouch"\\s+href="/saeckel/pouches/${id}"\\s+aria-current="page"`),
    );
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
      assert.ok(page.includes(`<p id="icon-error" class="err-text">${ICON_ERROR}</p>`));
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
    // The way back on the phone leads to the pouch itself.
    assert.equal(wayBack(page), `/saeckel/pouches/${id} Продукты`);
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
      assert.ok(page.includes(`<p id="name-error" class="err-text">${TAKEN}</p>`), name);
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
      assert.ok(page.includes(`<p id="name-error" class="err-text">${NAME_ERROR}</p>`));
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
      assert.ok(page.includes(`<p id="icon-error" class="err-text">${ICON_ERROR}</p>`));
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

function spend(id: number | string, fields: Record<string, string>, who = 'anna') {
  return post(`/saeckel/pouches/${id}/expense`, fields, who);
}

// The rows of the list of expenses on a pouch page, with whitespace folded.
function expenseRows(page: string): string[] {
  const list = /<\/form>([\s\S]*)$/.exec(mainPart(page))?.[1] ?? page;
  return [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.replace(/\s+/g, ' ').trim());
}

const ARCHIVED = 'Мешок в Кладовой: траты в нём не записываются.';

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

  test('the last 10 movements of this pouch, newest first, by date and then by id', async () => {
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
      .slice(0, 9)
      .map(({ date, n }) => `${date.slice(8)}.${date.slice(5, 7)} · трата ${n} · −${n},00 ₽`);
    // Since M6.3 the list holds every movement of the pouch: the laying out of 05.10 is the newest.
    assert.deepEqual(expenseRows(page), ['05.10 · из казны · +50,00 ₽', ...expected]);
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
    assert.ok(!page.includes('Записать трату'));
    assert.ok(!page.includes('/expense"'));
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
    assert.ok(page.includes(`<p id="refusal">${ARCHIVED}</p>`));
    assert.ok(!page.includes('/expense"'));
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

// M5.4: the storeroom.

function archive(id: number | string, who = 'anna') {
  return post(`/saeckel/pouches/${id}/archive`, {}, who);
}

function restore(id: number | string, who = 'anna') {
  return post(`/saeckel/pouches/${id}/restore`, {}, who);
}

async function isArchived(id: number): Promise<boolean> {
  return (await pouch(id))!.is_archived;
}

const notEmpty = (balance: string) =>
  `Убрать в кладовую можно только пустой мешок. Сейчас в нём ${balance}.`;
const restoreTaken = (name: string) =>
  `Среди мешков уже есть «${name}». Переименуйте его и верните этот снова.`;

// The statements that take the row of a pouch: archiving, an expense, bringing back.
const ARCHIVE_LOCK =
  /^SELECT id, name, icon, is_archived FROM pouches WHERE id = \$1 AND user_id = \$2 FOR UPDATE/;
const EXPENSE_LOCK = /^SELECT is_archived FROM pouches WHERE id = \$1 AND user_id = \$2 FOR UPDATE/;
const RESTORE_UPDATE = /^UPDATE pouches SET is_archived = false WHERE id = \$1 AND user_id = \$2/;

describe('Кладовая on Мешки', () => {
  test('«Кладовая (N)», folded, in the order the pouches were made, each with «Вернуть»', async () => {
    const active = await addPouch(1, 'Продукты');
    const apples = await addPouch(1, 'Яблоки', true);
    await addPouch(2, 'Старый Бориса', true);
    const oranges = await addPouch(1, 'Апельсины', true);
    const page = fold(await (await get('/saeckel/', 'anna')).text());
    assert.deepEqual(listItems(page), [`<a href="/saeckel/pouches/${active}">Продукты</a>`]);
    const storeroom = page.split('<details class="storeroom">')[1]!;
    assert.ok(storeroom.startsWith(' <summary>Кладовая (2)</summary>'));
    assert.deepEqual(
      [...storeroom.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.trim()),
      [apples, oranges].map(
        (id) =>
          `<a class="stored" href="/saeckel/pouches/${id}" ><img src="/saeckel/static/img/emblem-saeckel-small.webp" srcset="/saeckel/static/img/emblem-saeckel-small@2x.webp 2x" alt="" /><span>${id === apples ? 'Яблоки' : 'Апельсины'}</span></a > <form method="post" action="/saeckel/pouches/${id}/restore"> <button type="submit" class="btn">Вернуть</button> </form>`,
      ),
    );
    assert.ok(!page.includes('Старый Бориса'));
    // Boris has his own storeroom, of one.
    const his = fold(await (await get('/saeckel/', 'boris')).text());
    assert.ok(his.includes('<summary>Кладовая (1)</summary>'));
    assert.ok(!his.includes('Яблоки'));
  });

  test('nothing in the storeroom: no «Кладовая»', async () => {
    await addPouch(1, 'Продукты');
    await addPouch(2, 'Старый Бориса', true);
    const page = await (await get('/saeckel/', 'anna')).text();
    assert.ok(!page.includes('<details'));
    assert.ok(!page.includes('Кладовая'));
  });

  test('no active pouch: the empty state, and the storeroom beside it', async () => {
    const id = await addPouch(1, 'Отпуск', true);
    const page = fold(await (await get('/saeckel/', 'anna')).text());
    assert.ok(page.includes('<h2 class="title">Мешков пока нет</h2>'));
    assert.ok(
      page.includes(
        '<form class="form-row new-pouch" method="post" action="/saeckel/pouches/new">',
      ),
    );
    assert.ok(page.includes('<summary>Кладовая (1)</summary>'));
    assert.ok(page.includes(`<form method="post" action="/saeckel/pouches/${id}/restore">`));
  });

  test('a name is escaped in the storeroom', async () => {
    await addPouch(1, '<b>Пир</b> & Co', true);
    const page = await (await get('/saeckel/', 'anna')).text();
    assert.ok(page.includes('&lt;b&gt;Пир&lt;/b&gt; &amp; Co'));
    assert.ok(!page.includes('<b>'));
  });
});

describe('В кладовую', () => {
  test('«Изменить» of an empty pouch: the block «В кладовую», its button on', async () => {
    const id = await addPouch(1, 'Продукты');
    const page = fold(await (await get(`/saeckel/pouches/${id}/edit`, 'anna')).text());
    assert.ok(page.includes('<h2>В кладовую</h2>'));
    assert.ok(page.includes(`<form method="post" action="/saeckel/pouches/${id}/archive">`));
    assert.match(page, /<button type="submit" ?>В кладовую<\/button>/);
    assert.ok(!page.includes('Убрать в кладовую'));
  });

  test('«Изменить» of a pouch that is not empty: why, with the balance, and the button off', async () => {
    const id = await addPouch(1, 'Продукты');
    await addOperation(1, 'expense', 124050, { from: id });
    const page = fold(await (await get(`/saeckel/pouches/${id}/edit`, 'anna')).text());
    assert.ok(page.includes(`<p>${notEmpty('−1 240,50 ₽')}</p>`));
    assert.match(page, /<button type="submit" disabled>В кладовую<\/button>/);
    // A refused rename shows the block the same way.
    const refused = fold(await (await edit(id, { name: '', icon: 'pouch' })).text());
    assert.ok(refused.includes(`<p>${notEmpty('−1 240,50 ₽')}</p>`));
    // Money left over is no more empty than a debt.
    await addOperation(1, 'assign', 124550, { to: id });
    const over = fold(await (await get(`/saeckel/pouches/${id}/edit`, 'anna')).text());
    assert.ok(over.includes(`<p>${notEmpty('5,00 ₽')}</p>`));
  });

  test('an empty pouch: 303 to Мешки, then only in the storeroom', async () => {
    const id = await addPouch(1, 'Продукты');
    const res = await archive(id);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/saeckel/');
    assert.equal(await isArchived(id), true);
    const page = fold(await (await get('/saeckel/', 'anna')).text());
    assert.deepEqual(listItems(page), []);
    assert.ok(page.includes('<h2 class="title">Мешков пока нет</h2>'));
    assert.ok(page.includes('<summary>Кладовая (1)</summary>'));
    // Its page: the balance and «Вернуть», neither the form of an expense nor «Изменить».
    const own = fold(await (await get(`/saeckel/pouches/${id}`, 'anna')).text());
    assert.ok(own.includes('<h1>Продукты</h1>'));
    assert.ok(own.includes('<p>Остаток 0,00 ₽</p>'));
    assert.ok(own.includes(`<form method="post" action="/saeckel/pouches/${id}/restore">`));
    assert.ok(own.includes('<button type="submit">Вернуть</button>'));
    assert.ok(!own.includes('Записать трату'));
    assert.ok(!own.includes('Изменить'));
    assert.equal((await get(`/saeckel/pouches/${id}/edit`, 'anna')).status, 404);
    await assertNothingHeld(id);
  });

  test('a pouch whose records come to zero is empty: it goes, its history with it', async () => {
    const id = await addPouch(1, 'Продукты');
    await addOperation(1, 'assign', 10000, { to: id });
    await addOperation(1, 'expense', 9950, { from: id }, '2026-10-06', 'рынок');
    await addOperation(1, 'expense', 50, { from: id }, '2026-10-07');
    assert.equal((await archive(id)).status, 303);
    assert.equal(await isArchived(id), true);
    const page = await (await get(`/saeckel/pouches/${id}`, 'anna')).text();
    assert.deepEqual(expenseRows(page), [
      '07.10 · −0,50 ₽',
      '06.10 · рынок · −99,50 ₽',
      '05.10 · из казны · +100,00 ₽',
    ]);
    assert.equal((await operations()).length, 3);
  });

  for (const [label, cents, shown] of [
    ['in debt', -124050, '−1 240,50 ₽'],
    ['with money in it', 1, '0,01 ₽'],
  ] as const) {
    test(`a pouch ${label}: 400 on «Изменить» with the balance, nothing changes`, async () => {
      const id = await addPouch(1, 'Продукты');
      await pool.query("UPDATE pouches SET icon = 'cart' WHERE id = $1", [id]);
      await addOperation(1, cents < 0 ? 'expense' : 'assign', Math.abs(cents), {
        [cents < 0 ? 'from' : 'to']: id,
      });
      const res = await archive(id);
      assert.equal(res.status, 400);
      const page = fold(await res.text());
      for (const text of [
        '<h1>Мешок «Продукты»</h1>',
        `<form method="post" action="/saeckel/pouches/${id}/edit">`,
        'value="Продукты"',
        `<p>${notEmpty(shown)}</p>`,
      ]) {
        assert.ok(page.includes(text), text);
      }
      assert.deepEqual(signs(page).checked, ['cart']);
      assert.equal(await isArchived(id), false);
      assert.equal((await operations()).length, 1);
      await assertNothingHeld(id);
    });
  }

  test('a pouch already in the storeroom: 303 again, nothing changes', async () => {
    const id = await addPouch(1, 'Отпуск', true);
    const res = await archive(id);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/saeckel/');
    assert.equal(await isArchived(id), true);
    await assertNothingHeld(id);
  });

  test('somebody else’s, a missing or a wrong id: the same 404 here and in «Вернуть»', async () => {
    const his = await addPouch(2, 'Мешок Бориса');
    const hisStored = await addPouch(2, 'Старый Бориса', true);
    const missing = await (await archive(99)).text();
    for (const id of [String(his), String(hisStored), '99', '0', '01', '-1', 'abc', '2147483648']) {
      for (const res of [await archive(id), await restore(id)]) {
        assert.equal(res.status, 404, id);
        assert.equal(await res.text(), missing, id);
      }
    }
    // A user_id in the form is no way into his pouches either.
    for (const path of [
      `/saeckel/pouches/${his}/archive`,
      `/saeckel/pouches/${hisStored}/restore`,
    ]) {
      assert.equal((await post(path, { user_id: '2' }, 'anna')).status, 404, path);
    }
    assert.deepEqual(
      (await pouches()).map((row) => [row.user_id, row.is_archived]),
      [
        [2, false],
        [2, true],
      ],
    );
  });

  test('the INSERT of an expense waits; the archiving waits behind it, then counts it: 400', async () => {
    const id = await addPouch(1, 'Продукты');
    // An expense as its route writes it: the row of the pouch locked, the record inserted, no
    // COMMIT yet.
    const expense = await pool.connect();
    let res: Response;
    try {
      await expense.query('BEGIN');
      await expense.query(
        'SELECT is_archived FROM pouches WHERE id = $1 AND user_id = 1 FOR UPDATE',
        [id],
      );
      await expense.query(
        "INSERT INTO operations (user_id, kind, amount, currency, from_pouch_id, date) VALUES (1, 'expense', 100, 'RUB', $1, '2026-10-05')",
        [id],
      );
      const pending = archive(id);
      const [query] = await waitingQueries(1);
      assert.match(query!, ARCHIVE_LOCK);
      await expense.query('COMMIT');
      res = await pending;
    } finally {
      expense.release();
    }
    // The balance is a statement of its own, after the lock: it sees the committed expense.
    assert.equal(res.status, 400);
    assert.ok(fold(await res.text()).includes(notEmpty('−1,00 ₽')));
    assert.equal(await isArchived(id), false);
    assert.equal((await operations()).length, 1);
    await assertNothingHeld(id);
  });

  test('the archiving first: the expense waits behind it, then finds the storeroom, 400', async () => {
    const id = await addPouch(1, 'Продукты');
    // The rival holds the row so that both requests queue on it, the archiving first.
    const rival = await pool.connect();
    let archived: Response;
    let spent: Response;
    try {
      await rival.query('BEGIN');
      await rival.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE', [id]);
      const archiving = archive(id);
      assert.match((await waitingQueries(1))[0]!, ARCHIVE_LOCK);
      const spending = spend(id, { amount: '1', date: '', note: 'после' });
      const waiting = await waitingQueries(2);
      assert.ok(
        waiting.some((query) => EXPENSE_LOCK.test(query)),
        waiting.join('\n'),
      );
      await rival.query('COMMIT');
      archived = await archiving;
      spent = await spending;
    } finally {
      rival.release();
    }
    assert.equal(archived.status, 303);
    assert.equal(spent.status, 400);
    const page = await spent.text();
    assert.ok(page.includes(`<p id="refusal">${ARCHIVED}</p>`));
    assert.ok(!page.includes('/expense"'));
    assert.deepEqual(await operations(), []);
    assert.equal(await isArchived(id), true);
    await assertNothingHeld(id);
  });

  test('a failure inside the archiving: ROLLBACK, 500, still active, the client back', async (t: TestContext) => {
    t.mock.method(console, 'error', () => undefined);
    const id = await addPouch(1, 'Продукты');
    const drop = await failingTrigger('pouches', 'UPDATE');
    try {
      const res = await archive(id);
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('location'), null);
      await assertNothingHeld(id);
    } finally {
      await drop();
    }
    assert.equal(await isArchived(id), false);
    // It goes once the database lets it.
    assert.equal((await archive(id)).status, 303);
  });

  test('the COMMIT of the archiving fails: 500, no redirect, still active', async (t: TestContext) => {
    t.mock.method(console, 'error', () => undefined);
    const id = await addPouch(1, 'Продукты');
    const drop = await failingTrigger('pouches', 'UPDATE', { atCommit: true });
    try {
      const res = await archive(id);
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('location'), null);
      await assertNothingHeld(id);
    } finally {
      await drop();
    }
    assert.equal(await isArchived(id), false);
  });
});

describe('Вернуть', () => {
  test('303 to the pouch, active again: name, sign, history and balance as they were', async () => {
    const id = await addPouch(1, 'Отпуск');
    await pool.query("UPDATE pouches SET icon = 'lute' WHERE id = $1", [id]);
    await addOperation(1, 'assign', 500, { to: id });
    await addOperation(1, 'expense', 500, { from: id }, '2026-10-06', 'билеты');
    assert.equal((await archive(id)).status, 303);
    const res = await restore(id);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/saeckel/pouches/${id}`);
    assert.deepEqual(await pouch(id), {
      id,
      user_id: 1,
      name: 'Отпуск',
      icon: 'lute',
      is_archived: false,
    });
    assert.equal((await operations()).length, 2);
    const list = await (await get('/saeckel/', 'anna')).text();
    assert.deepEqual(listItems(list), [`<a href="/saeckel/pouches/${id}">Отпуск</a>`]);
    assert.ok(!list.includes('<details'));
    const page = fold(await (await get(`/saeckel/pouches/${id}`, 'anna')).text());
    assert.ok(page.includes('<p>Остаток 0,00 ₽</p>'));
    assert.ok(page.includes('Записать трату'));
    assert.deepEqual(expenseRows(page), ['06.10 · билеты · −5,00 ₽', '05.10 · из казны · +5,00 ₽']);
  });

  test('a pouch that is already active: 303 again, nothing changes', async () => {
    const id = await addPouch(1, 'Отпуск');
    const res = await restore(id);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/saeckel/pouches/${id}`);
    assert.equal(await isArchived(id), false);
  });

  test('the name is taken by an active pouch, in any case: 400 on its page, escaped, still stored', async () => {
    const stored = await addPouch(1, 'Отпуск & <Ко>', true);
    await addOperation(1, 'expense', 100, { from: stored });
    const active = await addPouch(1, 'ОТПУСК & <КО>');
    const res = await restore(stored);
    assert.equal(res.status, 400);
    const page = fold(await res.text());
    assert.ok(
      page.includes(`<p id="refusal">${restoreTaken('Отпуск &amp; &lt;Ко&gt;')}</p>`),
      page,
    );
    assert.ok(!page.includes('<Ко>'));
    // The page of the pouch in the storeroom: its balance, its expenses, «Вернуть» again.
    assert.ok(page.includes('<p>Остаток −1,00 ₽</p>'));
    assert.ok(page.includes(`<form method="post" action="/saeckel/pouches/${stored}/restore">`));
    assert.ok(!page.includes('Записать трату'));
    assert.deepEqual(expenseRows(page), ['05.10 · −1,00 ₽']);
    assert.equal(await isArchived(stored), true);
    // Once the other one is renamed, it comes back.
    assert.equal((await edit(active, { name: 'Отпуск-2027', icon: 'pouch' })).status, 303);
    assert.equal((await restore(stored)).status, 303);
    assert.equal(await isArchived(stored), false);
  });

  test('the name of a pouch in the storeroom, or of another user, is not taken', async () => {
    const first = await addPouch(1, 'Отпуск', true);
    const second = await addPouch(1, 'отпуск', true);
    await addPouch(2, 'Отпуск');
    assert.equal((await restore(first)).status, 303);
    // Now it is taken.
    assert.equal((await restore(second)).status, 400);
    assert.equal(await isArchived(second), true);
  });

  test('any other refusal of the database is not «taken»: the error goes on', async (t: TestContext) => {
    t.mock.method(console, 'error', () => undefined);
    const id = await addPouch(1, 'Отпуск', true);
    await addPouch(1, 'Продукты');
    // Another unique index: also 23505, but not pouches_active_name.
    await pool.query(
      'CREATE UNIQUE INDEX pouches_one_icon ON pouches (icon) WHERE NOT is_archived',
    );
    try {
      const res = await restore(id);
      assert.equal(res.status, 500);
      assert.ok(!(await res.text()).includes('Среди мешков'));
    } finally {
      await pool.query('DROP INDEX IF EXISTS pouches_one_icon');
    }
    assert.equal(await isArchived(id), true);
    await assertNothingHeld(id);
  });

  test('bringing back while a pouch of that name is made: the UPDATE waits, then «taken»', async () => {
    const id = await addPouch(1, 'Отпуск', true);
    const rival = await pool.connect();
    let res: Response;
    try {
      await rival.query('BEGIN');
      await rival.query("INSERT INTO pouches (user_id, name) VALUES (1, 'отпуск')");
      const pending = restore(id);
      // It is the UPDATE that waits: on the unique index, for the rival's transaction.
      assert.match((await waitingQueries(1))[0]!, RESTORE_UPDATE);
      await rival.query('COMMIT');
      res = await pending;
    } finally {
      rival.release();
    }
    assert.equal(res.status, 400);
    assert.ok((await res.text()).includes(restoreTaken('Отпуск')));
    assert.equal(await isArchived(id), true);
  });

  // Both change the one row: they queue on it, and the pouch ends as the last one left it.
  for (const [label, startsArchived, order] of [
    ['the archiving, then «Вернуть»: active', false, ['archive', 'restore']],
    ['«Вернуть», then the archiving: in the storeroom', true, ['restore', 'archive']],
  ] as const) {
    test(`at once, ${label}`, async () => {
      const id = await addPouch(1, 'Отпуск', startsArchived);
      const rival = await pool.connect();
      const answers: Response[] = [];
      try {
        await rival.query('BEGIN');
        await rival.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE', [id]);
        const pending: Promise<Response>[] = [];
        for (const [i, action] of order.entries()) {
          pending.push(Promise.resolve(action === 'archive' ? archive(id) : restore(id)));
          const waiting = await waitingQueries(i + 1);
          const statement = action === 'archive' ? ARCHIVE_LOCK : RESTORE_UPDATE;
          assert.ok(
            waiting.some((query) => statement.test(query)),
            waiting.join('\n'),
          );
        }
        await rival.query('COMMIT');
        answers.push(...(await Promise.all(pending)));
      } finally {
        rival.release();
      }
      for (const [i, action] of order.entries()) {
        assert.equal(answers[i]!.status, 303, action);
        assert.equal(
          answers[i]!.headers.get('location'),
          action === 'archive' ? '/saeckel/' : `/saeckel/pouches/${id}`,
        );
      }
      assert.equal(await isArchived(id), order.at(-1) === 'archive');
      await assertNothingHeld(id);
    });
  }
});

describe('a form of an expense opened before the storeroom', () => {
  test('wrong fields in a pouch now in the storeroom: the refusal of the storeroom, nothing written', async () => {
    const id = await addPouch(1, 'Продукты');
    await addOperation(1, 'expense', 100, { from: id });
    await pool.query('UPDATE pouches SET is_archived = true WHERE id = $1', [id]);
    for (const fields of [
      { amount: '1,2,3', date: '05.10.2026', note: 'тайная заметка' },
      { amount: '10', date: '31.02.2026', note: '' },
      { amount: '0', date: 'вчера', note: 'a\u0000b' },
    ]) {
      const res = await spend(id, fields);
      assert.equal(res.status, 400);
      const page = fold(await res.text());
      assert.ok(page.includes(`<p id="refusal">${ARCHIVED}</p>`), fields.amount);
      // Its page as a pouch in the storeroom: the balance, the expenses, «Вернуть».
      assert.ok(page.includes('<p>Остаток −1,00 ₽</p>'));
      assert.deepEqual(expenseRows(page), ['05.10 · −1,00 ₽']);
      assert.ok(page.includes(`<form method="post" action="/saeckel/pouches/${id}/restore">`));
      // No form, so no fields, no errors of fields and nothing of what was typed.
      assert.ok(!page.includes('/expense"'));
      assert.ok(!page.includes('<input'));
      assert.ok(!page.includes('-error"'));
      assert.ok(!page.includes('1,2,3'));
      assert.ok(!page.includes('тайная'));
    }
    assert.equal((await operations()).length, 1);
    await assertNothingHeld(id);
  });

  test('an active pouch keeps the errors under its fields', async () => {
    const id = await addPouch(1, 'Продукты');
    const page = await (await spend(id, { amount: '1,2,3', date: '', note: '' })).text();
    assert.ok(page.includes('<p id="amount-error">'));
    assert.ok(page.includes('value="1,2,3"'));
    assert.ok(!page.includes('id="refusal"'));
  });
});
