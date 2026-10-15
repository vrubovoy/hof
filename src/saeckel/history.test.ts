// M6.3: «Летопись», a record to read, the last movements of a pouch (ARCHITECTURE.md §4.1,
// §4.7, §5.5). Database: hof_test as hof_saeckel; who is signed in comes from the stand-in of
// test-helpers. Many records are written by one INSERT … generate_series.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { migrate } from '../migrate.ts';
import {
  addOperation,
  addPouch,
  appWithoutDatabase,
  deadPool,
  fold,
  get,
  pool,
  post,
  pouchLines,
} from './test-helpers.ts';

before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
beforeEach(() => pool.query('TRUNCATE operations, pouches RESTART IDENTITY'));
after(() => Promise.all([pool.end(), deadPool.end()]));

const EMPTY_TEXT =
  'Сюда ляжет каждый доход, трата и перекладывание — по порядку, с датой и заметкой.';
const EMPTY_POUCH = 'По этому мешку записей пока нет.';

// `count` incomes of user 1 on one day, of 0,01, 0,02 … in the order of their ids.
async function addIncomes(count: number): Promise<void> {
  await pool.query(
    `INSERT INTO operations (user_id, kind, amount, currency, date)
     SELECT 1, 'income', n, 'RUB', '2026-10-05' FROM generate_series(1, $1) n`,
    [count],
  );
}

function history(query = '', who = 'anna') {
  return get(`/saeckel/history${query}`, who);
}

// The rows of «Летопись»: date, pouches, kind, note, amount — and the address of the record.
function rows(page: string): string[][] {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(page)?.[1] ?? '';
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => {
    const cells = [...row[1]!.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => fold(m[1]!).trim());
    const href = /<a href="([^"]*)" aria-label="Открыть запись"/.exec(row[1]!)?.[1] ?? '';
    return [...cells.slice(0, 5), href];
  });
}

// The amounts of the rows, in hundredths written as «0,51 ₽» and so on: which incomes are shown.
const amounts = (page: string) => rows(page).map((row) => row[4]);

// The links of the pages: «Назад» and «Следующие 50», with their addresses as written.
function pageLinks(page: string): Record<string, string> {
  return Object.fromEntries(
    [...page.matchAll(/<a href="([^"]*)">(Назад|Следующие 50)<\/a>/g)].map((m) => [m[2]!, m[1]!]),
  );
}

// The options of the filter: value, text, chosen.
function filterOptions(page: string): [string, string, boolean][] {
  const list = /<select id="pouch" name="pouch">([\s\S]*?)<\/select>/.exec(page)?.[1] ?? '';
  return [...list.matchAll(/<option\s+value="([^"]*)"\s*(selected)?\s*>([\s\S]*?)<\/option>/g)].map(
    (m) => [m[1]!, fold(m[3]!).trim(), m[2] !== undefined],
  );
}

// The rows of the list on a pouch page, with whitespace folded.
function movementRows(page: string): string[] {
  const list = /<ul>([\s\S]*?)<\/ul>/.exec(page.split('Записать трату').at(-1) ?? '')?.[1] ?? '';
  return [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => fold(m[1]!).trim());
}

const cents = (n: number) => `+${(n / 100).toFixed(2).replace('.', ',')} ₽`;

describe('Летопись: pages', () => {
  test('no record at all: the empty Летопись — no table, no filter', async () => {
    await addPouch(1, 'Продукты');
    const res = await history();
    assert.equal(res.status, 200);
    const page = fold(await res.text());
    for (const text of [
      '<title>Säckel — летопись</title>',
      '<a href="/saeckel/history" aria-current="page">Летопись</a>',
      '<a href="/saeckel/" >Мешки</a>',
      '<h2>Летопись пока пуста</h2>',
      `<p>${EMPTY_TEXT}</p>`,
      '<a href="/saeckel/income">Записать доход</a>',
      '<a href="/saeckel/">К мешкам</a>',
    ]) {
      assert.ok(page.includes(text), text);
    }
    assert.ok(!page.includes('<table'));
    assert.ok(!page.includes('<form'));
  });

  test('one record: one row, no links of pages', async () => {
    await addIncomes(1);
    const page = await (await history()).text();
    assert.deepEqual(amounts(page), ['+0,01 ₽']);
    assert.deepEqual(pageLinks(page), {});
  });

  for (const count of [50, 51, 100, 101]) {
    test(`${count} records: 50 a page, «Назад» and «Следующие 50» where there is more`, async () => {
      await addIncomes(count);
      const pages = Math.ceil(count / 50);
      for (let n = 1; n <= pages; n++) {
        const page = await (await history(`?page=${n}`)).text();
        // Newest first: on one day, the larger id first.
        const top = count - 50 * (n - 1);
        const expected = Array.from({ length: Math.min(50, top) }, (_, i) => cents(top - i));
        assert.deepEqual(amounts(page), expected, `page ${n}`);
        const links: Record<string, string> = {};
        if (n > 1) links['Назад'] = `/saeckel/history?page=${n - 1}`;
        if (n < pages) links['Следующие 50'] = `/saeckel/history?page=${n + 1}`;
        assert.deepEqual(pageLinks(page), links, `page ${n}`);
      }
    });
  }

  test('newest first: by date, then by id on one day', async () => {
    const first = await addOperation(1, 'income', 100, {}, '2026-10-05');
    const old = await addOperation(1, 'income', 200, {}, '2026-09-30');
    const second = await addOperation(1, 'income', 300, {}, '2026-10-05');
    const newest = await addOperation(1, 'income', 400, {}, '2026-10-07');
    const page = await (await history()).text();
    assert.deepEqual(
      rows(page).map((row) => row[5]),
      [newest, second, first, old].map((id) => `/saeckel/operations/${id}`),
    );
  });

  test('a page of the wrong form or outside 1–1000: 404', async () => {
    await addIncomes(1);
    for (const value of ['0', '01', '1001', '10000', 'abc', '-1', '1.5', '', '1e2', ' 1']) {
      const res = await history(`?page=${encodeURIComponent(value)}`);
      assert.equal(res.status, 404, value);
    }
    assert.equal((await history('?page=1000')).status, 200);
  });

  test('a page past the last one: 200, no rows, «Назад» — not the empty Летопись', async () => {
    await addIncomes(3);
    const res = await history('?page=2');
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.deepEqual(rows(page), []);
    assert.ok(!page.includes('<table'));
    assert.deepEqual(pageLinks(page), { Назад: '/saeckel/history?page=1' });
    assert.ok(!page.includes('Летопись пока пуста'));
    assert.ok(!page.includes(EMPTY_POUCH));
  });

  test('page 1000 with a record after it: its 50 rows and «Назад», no link to 1001', async () => {
    await addIncomes(50_001);
    const last = await (await history('?page=1000')).text();
    assert.equal(amounts(last).length, 50);
    assert.equal(amounts(last)[0], cents(51));
    assert.deepEqual(pageLinks(last), { Назад: '/saeckel/history?page=999' });
    assert.ok(!last.includes('page=1001'));
    const before = await (await history('?page=999')).text();
    assert.equal(pageLinks(before)['Следующие 50'], '/saeckel/history?page=1000');
  });

  test('the pouch of the filter stays in both links', async () => {
    const food = await addPouch(1, 'Продукты');
    await pool.query(
      `INSERT INTO operations (user_id, kind, amount, currency, to_pouch_id, date)
       SELECT 1, 'assign', n, 'RUB', $1, '2026-10-05' FROM generate_series(1, 101) n`,
      [food],
    );
    const page = await (await history(`?pouch=${food}&page=2`)).text();
    assert.deepEqual(pageLinks(page), {
      Назад: `/saeckel/history?pouch=${food}&amp;page=1`,
      'Следующие 50': `/saeckel/history?pouch=${food}&amp;page=3`,
    });
  });
});

describe('Летопись: the filter by pouch', () => {
  test('the records into or out of the pouch; a transfer under both pouches; no income', async () => {
    const a = await addPouch(1, 'А');
    const b = await addPouch(1, 'Б');
    await addOperation(1, 'income', 100_000, {}, '2026-10-01');
    const laid = await addOperation(1, 'assign', 50_000, { to: a }, '2026-10-02');
    const spent = await addOperation(1, 'expense', 1_000, { from: a }, '2026-10-03');
    const moved = await addOperation(1, 'transfer', 2_000, { from: a, to: b }, '2026-10-04');
    const fromB = await addOperation(1, 'expense', 500, { from: b }, '2026-10-05');
    const ids = async (pouch: number) =>
      rows(await (await history(`?pouch=${pouch}`)).text()).map((row) => row[5]);
    assert.deepEqual(
      await ids(a),
      [moved, spent, laid].map((id) => `/saeckel/operations/${id}`),
    );
    assert.deepEqual(
      await ids(b),
      [fromB, moved].map((id) => `/saeckel/operations/${id}`),
    );
  });

  test('a pouch in the storeroom keeps its history', async () => {
    const old = await addPouch(1, 'Старый');
    await addOperation(1, 'assign', 500, { to: old });
    await addOperation(1, 'expense', 500, { from: old });
    await pool.query('UPDATE pouches SET is_archived = true WHERE id = $1', [old]);
    const res = await history(`?pouch=${old}`);
    assert.equal(res.status, 200);
    assert.equal(rows(await res.text()).length, 2);
  });

  test('somebody else’s pouch, a missing one and a wrong id: the same 404', async () => {
    await addPouch(1, 'Продукты');
    const his = await addPouch(2, 'Тайный мешок Бориса');
    await addOperation(2, 'expense', 100, { from: his });
    const missing = await (await history('?pouch=99999')).text();
    for (const value of [String(his), '99999', 'abc', '01', '0', '-1', '2147483648', `${his}.0`]) {
      const res = await history(`?pouch=${value}`);
      assert.equal(res.status, 404, value);
      assert.equal(await res.text(), missing, value);
    }
    // And his own history is his.
    assert.equal(rows(await (await history(`?pouch=${his}`, 'boris')).text()).length, 1);
  });

  test('the list: «Все мешки», the active by id, then those in the storeroom; the chosen kept', async () => {
    const food = await addPouch(1, 'Продукты');
    const old = await addPouch(1, 'Старый', true);
    await addPouch(2, 'Мешок Бориса');
    const flat = await addPouch(1, 'Квартира');
    await addOperation(1, 'assign', 100, { to: food });
    const page = await (await history(`?pouch=${flat}`)).text();
    assert.ok(fold(page).includes('<form method="get" action="/saeckel/history">'));
    assert.ok(fold(page).includes('<label for="pouch">Мешок</label>'));
    assert.ok(page.includes('<button type="submit">Показать</button>'));
    assert.deepEqual(filterOptions(page), [
      ['', 'Все мешки', false],
      [String(food), 'Продукты', false],
      [String(flat), 'Квартира', true],
      [String(old), 'Старый (в Кладовой)', false],
    ]);
    assert.ok(!page.includes('Мешок Бориса'));
    // An empty `pouch`, as «Все мешки» sends it, is every record.
    const all = await history('?pouch=');
    assert.equal(all.status, 200);
    assert.deepEqual(
      filterOptions(await all.text()).filter(([, , chosen]) => chosen),
      [],
    );
  });

  test('a pouch with no record: the filter and «По этому мешку записей пока нет.»', async () => {
    const food = await addPouch(1, 'Продукты');
    const flat = await addPouch(1, 'Квартира');
    await addOperation(1, 'assign', 100, { to: food });
    const page = fold(await (await history(`?pouch=${flat}`)).text());
    assert.ok(page.includes(`<p>${EMPTY_POUCH}</p>`));
    assert.ok(page.includes('<select id="pouch" name="pouch">'));
    assert.ok(!page.includes('<table'));
    assert.ok(!page.includes('Летопись пока пуста'));
  });
});

describe('Летопись: the rows', () => {
  test('the four kinds: the words, the signs, the pouches, «Казна», the direction of a transfer', async () => {
    const food = await addPouch(1, 'Продукты');
    const trip = await addPouch(1, 'Отпуск');
    const cart = await addPouch(1, 'Транспорт');
    const income = await addOperation(1, 'income', 8_000_000, {}, '2026-09-30', 'зарплата');
    const laid = await addOperation(1, 'assign', 800_000, { to: food }, '2026-10-01');
    const moved = await addOperation(1, 'transfer', 76_000, { from: trip, to: cart }, '2026-10-04');
    const spent = await addOperation(
      1,
      'expense',
      124_000,
      { from: food },
      '2026-10-05',
      'овощи на рынке',
    );
    assert.deepEqual(rows(await (await history()).text()), [
      [
        '05.10.2026',
        'Продукты',
        'Трата',
        'овощи на рынке',
        '−1 240,00 ₽',
        `/saeckel/operations/${spent}`,
      ],
      [
        '04.10.2026',
        'Отпуск → Транспорт',
        'Из мешка в мешок',
        '',
        '760,00 ₽',
        `/saeckel/operations/${moved}`,
      ],
      ['01.10.2026', 'Продукты', 'Из казны', '', '+8 000,00 ₽', `/saeckel/operations/${laid}`],
      ['30.09.2026', 'Казна', 'Доход', 'зарплата', '+80 000,00 ₽', `/saeckel/operations/${income}`],
    ]);
  });

  test('names and notes are escaped', async () => {
    const feast = await addPouch(1, '<b>Пир</b> & Co');
    await addOperation(1, 'expense', 100, { from: feast }, '2026-10-05', '<i>"гости"</i>');
    const page = await (await history()).text();
    assert.ok(page.includes('&lt;b&gt;Пир&lt;/b&gt; &amp; Co'));
    assert.ok(page.includes('&lt;i&gt;&quot;гости&quot;&lt;/i&gt;'));
    assert.ok(!page.includes('<b>') && !page.includes('<i>'));
  });

  test('records of another user are not shown, nor his pouches', async () => {
    const his = await addPouch(2, 'Мешок Бориса');
    await addOperation(2, 'income', 100);
    await addOperation(2, 'assign', 100, { to: his });
    const page = await (await history()).text();
    assert.ok(page.includes('Летопись пока пуста'));
    assert.ok(!page.includes('Мешок Бориса'));
  });
});

describe('a record', () => {
  // Since M6.4 a record whose pouches are active opens as a form (operations.test.ts); the page
  // to read stays for a record of a pouch in the storeroom, and that is what is checked here.
  test('to read: each kind with a pouch — its kind and date, the amount, its pouches, the note; no form', async () => {
    const food = await addPouch(1, 'Продукты');
    const trip = await addPouch(1, 'Отпуск');
    const cases: [number, string[], string[]][] = [
      [
        await addOperation(1, 'assign', 800_000, { to: food }, '2026-10-01'),
        ['Из казны · 01.10.2026', '8 000,00 ₽', 'В мешок', 'Продукты'],
        ['Из мешка', 'Заметка'],
      ],
      [
        await addOperation(1, 'expense', 124_050, { from: food }, '2026-10-05', 'овощи'),
        ['Трата · 05.10.2026', '1 240,50 ₽', 'Из мешка', 'Продукты', 'овощи'],
        ['В мешок'],
      ],
      [
        await addOperation(1, 'transfer', 76_000, { from: trip, to: food }, '2026-10-04'),
        ['Из мешка в мешок · 04.10.2026', '760,00 ₽', 'Из мешка', 'Отпуск', 'В мешок', 'Продукты'],
        ['Заметка'],
      ],
    ];
    await pool.query('UPDATE pouches SET is_archived = true');
    for (const [id, present, absent] of cases) {
      const res = await get(`/saeckel/operations/${id}`, 'anna');
      assert.equal(res.status, 200, String(id));
      const page = fold(await res.text());
      assert.ok(page.includes('<p><a href="/saeckel/history">Летопись</a></p>'));
      assert.ok(page.includes(`<h1>${present[0]}</h1>`), present[0]);
      for (const text of present.slice(1)) assert.ok(page.includes(text), `${id}: ${text}`);
      for (const text of absent) assert.ok(!page.includes(`<dt>${text}</dt>`), `${id}: ${text}`);
      assert.ok(!page.includes('<form'), String(id));
      assert.ok(!page.includes(' +') && !page.includes('−'), `${id}: an amount with a sign`);
    }
  });

  test('a record of a pouch in the storeroom is shown', async () => {
    const old = await addPouch(1, 'Старый');
    const id = await addOperation(1, 'expense', 100, { from: old });
    await pool.query('UPDATE pouches SET is_archived = true WHERE id = $1', [old]);
    const res = await get(`/saeckel/operations/${id}`, 'anna');
    assert.equal(res.status, 200);
    assert.ok(fold(await res.text()).includes('<dt>Из мешка</dt> <dd>Старый</dd>'));
  });

  test('somebody else’s, a missing one and a wrong id: the same 404', async () => {
    const his = await addPouch(2, 'Тайный мешок Бориса');
    const hisRecord = await addOperation(
      2,
      'expense',
      777_777,
      { from: his },
      '2026-10-05',
      'тайна',
    );
    const missing = await (await get('/saeckel/operations/99999', 'anna')).text();
    for (const value of [String(hisRecord), '99999', 'abc', '01', '0', '-1', '2147483648']) {
      const res = await get(`/saeckel/operations/${value}`, 'anna');
      assert.equal(res.status, 404, value);
      assert.equal(await res.text(), missing, value);
    }
    assert.equal((await get(`/saeckel/operations/${hisRecord}`, 'boris')).status, 200);
  });
});

describe('the page of a pouch: its last movements', () => {
  test('from the treasury, in, out and spent, as seen from the pouch', async () => {
    const a = await addPouch(1, 'А');
    const b = await addPouch(1, '<b>Б</b>');
    const c = await addPouch(1, 'В');
    await addOperation(1, 'income', 100_000, {}, '2026-10-01', 'не отсюда');
    await addOperation(1, 'assign', 10_000, { to: a }, '2026-10-02', 'зарплата');
    await addOperation(1, 'transfer', 2_000, { from: b, to: a }, '2026-10-03');
    await addOperation(1, 'transfer', 500, { from: a, to: c }, '2026-10-04', 'на такси');
    await addOperation(1, 'expense', 300, { from: a }, '2026-10-05');
    await addOperation(1, 'expense', 900, { from: b }, '2026-10-06', 'не отсюда');
    const page = await (await get(`/saeckel/pouches/${a}`, 'anna')).text();
    assert.deepEqual(movementRows(page), [
      '05.10 · −3,00 ₽',
      '04.10 · в мешок «В» · на такси · −5,00 ₽',
      '03.10 · из мешка «&lt;b&gt;Б&lt;/b&gt;» · +20,00 ₽',
      '02.10 · из казны · зарплата · +100,00 ₽',
    ]);
    assert.ok(!page.includes('не отсюда'));
    assert.ok(fold(page).includes('<p>Остаток 112,00 ₽</p>'));
  });

  test('the last 10; the 11th, records of others and an income are not shown', async () => {
    const a = await addPouch(1, 'А');
    const his = await addPouch(2, 'Чужой');
    for (let day = 1; day <= 11; day++) {
      await addOperation(
        1,
        'assign',
        day * 100,
        { to: a },
        `2026-10-${String(day).padStart(2, '0')}`,
      );
    }
    await addOperation(1, 'income', 999, {}, '2026-10-20');
    await addOperation(2, 'assign', 999, { to: his }, '2026-10-20');
    const page = await (await get(`/saeckel/pouches/${a}`, 'anna')).text();
    const shown = movementRows(page);
    assert.equal(shown.length, 10);
    assert.equal(shown[0], '11.10 · из казны · +11,00 ₽');
    assert.equal(shown[9], '02.10 · из казны · +2,00 ₽');
    assert.ok(!page.includes('9,99'));
  });

  test('fresh marks a movement that is shown, and nothing else', async () => {
    const a = await addPouch(1, 'А');
    const b = await addPouch(1, 'Б');
    const old = await addOperation(1, 'assign', 100, { to: a }, '2026-09-01');
    for (let day = 1; day <= 10; day++) {
      await addOperation(1, 'expense', day, { from: a }, `2026-10-${String(day).padStart(2, '0')}`);
    }
    const moved = await addOperation(1, 'transfer', 500, { from: b, to: a }, '2026-10-20');
    const income = await addOperation(1, 'income', 700, {}, '2026-10-21');
    const marked = await (await get(`/saeckel/pouches/${a}?fresh=${moved}`, 'anna')).text();
    assert.deepEqual(
      movementRows(marked).filter((row) => row.startsWith('<mark>')),
      ['<mark>20.10 · из мешка «Б» · +5,00 ₽</mark>'],
    );
    for (const value of [old, income, 'abc']) {
      const page = await (await get(`/saeckel/pouches/${a}?fresh=${value}`, 'anna')).text();
      assert.ok(!page.includes('<mark>'), String(value));
    }
  });

  test('«последняя трата» on Мешки is still the last expense, not a later movement', async () => {
    const a = await addPouch(1, 'А');
    const b = await addPouch(1, 'Б');
    await addOperation(1, 'assign', 10_000, { to: a }, '2026-10-01');
    await addOperation(1, 'expense', 300, { from: a }, '2026-10-02');
    await addOperation(1, 'assign', 5_000, { to: a }, '2026-10-03');
    await addOperation(1, 'transfer', 100, { from: a, to: b }, '2026-10-04');
    const lines = pouchLines(await (await get('/saeckel/', 'anna')).text());
    assert.equal(
      lines[0],
      `<a href="/saeckel/pouches/${a}">А</a> · 146,00 ₽ · последняя трата −3,00 ₽`,
    );
  });
});

describe('who gets in, and what is no route', () => {
  test('without a session: GET goes to /login with the way back, nothing is queried', async () => {
    for (const path of [
      '/saeckel/history',
      '/saeckel/history?pouch=1&page=2',
      '/saeckel/operations/1',
    ]) {
      const res = await get(path, undefined, appWithoutDatabase);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(path)}`);
    }
  });

  test('other addresses and methods: the common 404, with or without a session', async () => {
    for (const path of ['/saeckel/operations', '/saeckel/operations/', '/saeckel/operations/1/x']) {
      assert.equal((await get(path, undefined, appWithoutDatabase)).status, 404, path);
      assert.equal((await get(path, 'anna')).status, 404, path);
    }
    assert.equal((await post('/saeckel/history', {}, undefined, appWithoutDatabase)).status, 404);
    assert.equal((await post('/saeckel/history', {}, 'anna')).status, 404);
  });
});
