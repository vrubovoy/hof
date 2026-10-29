// M6.1: income, the treasury and laying out into pouches (ARCHITECTURE.md §4.1, §4.8, §5.6).
// Database: hof_test as hof_saeckel; who is signed in comes from the stand-in of test-helpers.
// Races are put in order by real locks and pg_stat_activity, never by waiting a while.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { migrate } from '../migrate.ts';
import { dateForField, today } from './dates.ts';
import {
  addOperation,
  addPouch,
  appWithoutDatabase,
  assignRows,
  assertNothingHeld,
  deadPool,
  failingTrigger,
  fold,
  get,
  mainPart,
  operations,
  pool,
  post,
  pouchLines,
  pouches,
  textOf,
  treasurySum,
  waitingQueries,
  wayBack,
} from './test-helpers.ts';

before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
beforeEach(() => pool.query('TRUNCATE operations, pouches RESTART IDENTITY'));
after(() => Promise.all([pool.end(), deadPool.end()]));

const MISSING = 'Мешок не найден.';
const EMPTY = 'Впишите сумму хотя бы для одного мешка.';
const FORMAT = 'Сумма — число, например 1 240,50.';
const archivedRefusal = (name: string) => `Мешок «${name}» в Кладовой: записи с ним не создаются.`;

// The statements that wait for the row of a pouch: laying out and archiving.
const ASSIGN_LOCK =
  /^SELECT id, name, is_archived FROM pouches WHERE user_id = \$1 AND id = ANY\(\$2\) ORDER BY id FOR UPDATE/;
const ARCHIVE_LOCK = /^SELECT id, name, icon, is_archived FROM pouches WHERE id = \$1/;

const todayInCourt = () => today('Europe/Moscow', new Date());

function income(fields: Record<string, string>, who = 'anna') {
  return post('/saeckel/income', fields, who);
}

function assign(fields: Record<string, string> | [string, string][], who = 'anna') {
  return post('/saeckel/assign', fields, who);
}

function archive(id: number, who = 'anna') {
  return post(`/saeckel/pouches/${id}/archive`, {}, who);
}

// The sum the block «Казна» shows on a page, with whitespace folded.
function treasury(page: string): string | undefined {
  return treasurySum(page);
}

async function isArchived(id: number): Promise<boolean> {
  return (await pouches()).find((row) => row.id === id)!.is_archived;
}

describe('Казна on Мешки', () => {
  test('a new person: 0,00 ₽, «Разложить» and «+ Доход», above the empty state', async () => {
    const page = fold(await (await get('/saeckel/', 'anna')).text());
    assert.equal(treasury(page), '0,00 ₽');
    assert.ok(
      page.includes(
        '<a class="btn btn-ochre" href="/saeckel/assign" data-fx="flip-fwd-phone">Разложить</a>',
      ),
    );
    assert.ok(
      page.includes('<a class="btn" href="/saeckel/income" data-fx="flip-fwd-phone">+ Доход</a>'),
    );
    assert.ok(
      page.indexOf('<h2 class="title t-3">Казна</h2>') <
        page.indexOf('<h2 class="title">Мешков пока нет</h2>'),
    );
  });

  test('income adds, laying out takes away; expenses and records of others count for nothing', async () => {
    const food = await addPouch(1, 'Продукты');
    const his = await addPouch(2, 'Мешок Бориса');
    await addOperation(1, 'income', 8_000_000);
    await addOperation(1, 'assign', 800_000, { to: food });
    await addOperation(1, 'expense', 1_000, { from: food });
    await addOperation(2, 'income', 500_000);
    await addOperation(2, 'assign', 1_000, { to: his });
    assert.equal(treasury(await (await get('/saeckel/', 'anna')).text()), '72 000,00 ₽');
    assert.equal(treasury(await (await get('/saeckel/', 'boris')).text()), '4 990,00 ₽');
  });

  test('more laid out than came in: below zero, with «−»', async () => {
    const food = await addPouch(1, 'Продукты');
    await addOperation(1, 'income', 100);
    await addOperation(1, 'assign', 250, { to: food });
    assert.equal(treasury(await (await get('/saeckel/', 'anna')).text()), '−1,50 ₽');
  });

  test('a treasury beyond the exact range of numbers: 500, and no amount in the error', async (t: TestContext) => {
    const errors: unknown[] = [];
    t.mock.method(console, 'error', (error: unknown) => errors.push(error));
    // 90 072 incomes of 1 000 000 000,00: more hundredths than a number holds exactly.
    await pool.query(
      `INSERT INTO operations (user_id, kind, amount, currency, date)
       SELECT 1, 'income', 100000000000, 'RUB', '2026-10-05' FROM generate_series(1, 90072)`,
    );
    for (const path of ['/saeckel/', '/saeckel/assign']) {
      assert.equal((await get(path, 'anna')).status, 500, path);
    }
    assert.ok(errors.length > 0);
    for (const error of errors) {
      assert.equal((error as Error).message, 'a sum is outside the exact range of numbers');
    }
  });
});

describe('Доход', () => {
  test('the page: the fields, today in the time zone of the court, the hint', async () => {
    const res = await get('/saeckel/income', 'anna');
    assert.equal(res.status, 200);
    const page = fold(await res.text());
    for (const text of [
      '<title>Säckel — доход</title>',
      '<h1 class="title t-2">Доход</h1>',
      '<form class="entry" method="post" action="/saeckel/income" data-fx="income">',
      '<label for="amount">Сумма, ₽</label>',
      'inputmode="decimal"',
      `value="${dateForField(todayInCourt())}"`,
      '<p class="hint"> Деньги лягут в казну. После записи откроется раскладка по мешкам — её можно отложить. </p>',
      '<button type="submit" class="btn btn-ochre">Записать доход</button>',
    ]) {
      assert.ok(page.includes(text), text);
    }
    assert.equal(wayBack(page), '/saeckel/ Мешки');
    // The column beside the form: the treasury with both of its buttons.
    assert.equal(treasury(page), '0,00 ₽');
    assert.ok(
      page.includes(
        '<a class="btn btn-ochre" href="/saeckel/assign" data-fx="flip-fwd-phone">Разложить</a>',
      ),
    );
  });

  test('written for the one signed in: 303 to «Разложить» with its id; other fields ignored', async () => {
    const res = await income({
      amount: '80 000',
      date: '',
      note: '  зарплата ',
      user_id: '2',
      kind: 'expense',
      currency: 'EUR',
      from: '1',
      to: '1',
    });
    assert.equal(res.status, 303);
    const [row] = await operations();
    assert.equal(res.headers.get('location'), `/saeckel/assign?income=${row!.id}`);
    assert.deepEqual(row, {
      id: row!.id,
      user_id: 1,
      kind: 'income',
      amount: '8000000',
      currency: 'RUB',
      from_pouch_id: null,
      to_pouch_id: null,
      date: todayInCourt(),
      note: 'зарплата',
    });
  });

  test('exact hundredths, and a date in either form', async () => {
    assert.equal((await income({ amount: '0,29', date: '05.10.2026', note: '' })).status, 303);
    assert.equal((await income({ amount: '1 240,50', date: '2026-10-06', note: '' })).status, 303);
    assert.deepEqual(
      (await operations()).map((row) => [row.amount, row.date]),
      [
        ['29', '2026-10-05'],
        ['124050', '2026-10-06'],
      ],
    );
    assert.equal(treasury(await (await get('/saeckel/', 'anna')).text()), '1 240,79 ₽');
  });

  test('wrong fields: 400, each error under its field, what was typed kept, nothing written', async () => {
    const res = await income({ amount: '1,2,3', date: '31.02.2026', note: 'a\u0001b' });
    assert.equal(res.status, 400);
    const page = fold(await res.text());
    for (const text of [
      `<p id="amount-error" class="err-text">${FORMAT}</p>`,
      '<p id="date-error" class="err-text">Дата — ДД.ММ.ГГГГ, не раньше 01.01.2000 и не дальше года вперёд.</p>',
      '<p id="note-error" class="err-text">Заметка — до 200 символов, одной строкой.</p>',
      'value="1,2,3"',
      'value="31.02.2026"',
      '<form class="entry" method="post" action="/saeckel/income" data-fx="income">',
    ]) {
      assert.ok(page.includes(text), text);
    }
    assert.deepEqual(await operations(), []);
  });
});

describe('without a session', () => {
  test('GET goes to /login with the way back, POST to /login; nothing is queried', async () => {
    for (const path of ['/saeckel/income', '/saeckel/assign', '/saeckel/assign?income=1']) {
      const res = await get(path, undefined, appWithoutDatabase);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(path)}`);
    }
    for (const path of ['/saeckel/income', '/saeckel/assign']) {
      const res = await post(path, { amount: '1', amount_1: '1' }, undefined, appWithoutDatabase);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get('location'), '/login', path);
    }
  });
});

describe('the page «Разложить»', () => {
  test('the treasury, the active pouches of this user by id, a field for each', async () => {
    const food = await addPouch(1, 'Продукты');
    await addPouch(1, 'Старый', true);
    await addPouch(2, 'Мешок Бориса');
    const flat = await addPouch(1, 'Квартира');
    await addOperation(1, 'income', 100_000);
    await addOperation(1, 'expense', 124_050, { from: flat });
    const res = await get('/saeckel/assign', 'anna');
    assert.equal(res.status, 200);
    const page = await res.text();
    const folded = fold(page);
    for (const text of [
      '<title>Säckel — разложить</title>',
      '<h1 class="title t-2">Разложить по мешкам</h1>',
      '<form class="assign" method="post" action="/saeckel/assign" data-fx="assign">',
      '<th>Мешок</th> <th class="num">Сейчас в мешке</th> <th class="put-head">Положить, ₽</th>',
      `name="amount_${food}"`,
      'aria-label="Положить в мешок Продукты"',
      '<button type="submit" class="btn btn-ochre">Разложить</button>',
      '<a class="link" href="/saeckel/">Позже — вернуться к мешкам</a>',
    ]) {
      assert.ok(folded.includes(text), text);
    }
    assert.ok(textOf(mainPart(page)).includes('В казне: 1 000,00 ₽. Пустые поля пропускаются.'));
    assert.deepEqual(assignRows(page), [
      ['Продукты', '0,00 ₽', ''],
      ['Квартира', '−1 240,50 ₽', ''],
    ]);
    // The pouch in the storeroom has no row: it is only in «Кладовая» of the column.
    assert.ok(!mainPart(page).includes('Старый'));
    assert.ok(page.split('<details class="storeroom">')[1]!.includes('Старый'));
    assert.ok(!page.includes('Мешок Бориса'));
    assert.ok(!page.includes('лёг в казну'));
    // The column beside it: the same treasury, no buttons — they lead here (SaeckelAssign).
    assert.equal(treasury(page), '1 000,00 ₽');
    assert.ok(!page.includes('href="/saeckel/assign" data-fx="flip-fwd-phone">Разложить</a>'));
    assert.ok(!page.includes('href="/saeckel/income" data-fx="flip-fwd-phone">+ Доход</a>'));
    assert.ok(!page.includes('class="treasury-actions"'));
  });

  test('no active pouch: «Мешков пока нет» and «+ Новый мешок» instead of the rows', async () => {
    await addPouch(1, 'Старый', true);
    await addOperation(1, 'income', 500);
    const page = fold(await (await get('/saeckel/assign', 'anna')).text());
    assert.ok(textOf(mainPart(page)).includes('В казне: 5,00 ₽.'));
    assert.ok(!page.includes('Пустые поля пропускаются'));
    assert.ok(page.includes('<h2 class="title t-3">Мешков пока нет</h2>'));
    assert.ok(page.includes('<a class="link" href="/saeckel/pouches/new">+ Новый мешок</a>'));
    // No form of laying out; the only forms are «Вернуть» of the storeroom in the column.
    assert.ok(!mainPart(page).includes('<form'));
  });

  test('an income of this user is named above the rows', async () => {
    await addPouch(1, 'Продукты');
    const id = await addOperation(1, 'income', 8_000_000);
    const page = await (await get(`/saeckel/assign?income=${id}`, 'anna')).text();
    const note = /<p class="note note-income">([\s\S]*?)<\/p>/.exec(page)?.[1] ?? '';
    assert.equal(
      textOf(note),
      'Доход 80 000,00 ₽ лёг в казну. Разложите его по мешкам или оставьте в казне на потом.',
    );
  });

  test('anything else in `income` is ignored: 200, no line, nothing of others shown', async () => {
    const food = await addPouch(1, 'Продукты');
    const his = await addOperation(2, 'income', 7_777_700);
    const laidOut = await addOperation(1, 'assign', 100, { to: food });
    for (const value of [String(his), String(laidOut), '999', 'abc', '01', '0', '']) {
      const res = await get(`/saeckel/assign?income=${value}`, 'anna');
      assert.equal(res.status, 200, value);
      const page = await res.text();
      assert.ok(!page.includes('лёг в казну'), value);
      assert.ok(!fold(page).includes('77 777'), value);
    }
  });
});

describe('Разложить', () => {
  test('income 80 000, then 8 000 and 2 000 into two pouches: the treasury is 70 000', async () => {
    const food = await addPouch(1, 'Продукты');
    const flat = await addPouch(1, 'Квартира');
    const transport = await addPouch(1, 'Транспорт');
    const written = await income({ amount: '80 000', date: '', note: 'зарплата' });
    const next = await get(written.headers.get('location')!, 'anna');
    assert.ok((await next.text()).includes('лёг в казну'));
    const res = await assign({
      [`amount_${food}`]: '8 000',
      [`amount_${flat}`]: '',
      [`amount_${transport}`]: '2 000',
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/saeckel/');
    const laidOut = (await operations()).filter((row) => row.kind === 'assign');
    assert.deepEqual(
      laidOut.map((row) => [row.user_id, row.to_pouch_id, row.amount, row.date, row.note]),
      [
        [1, food, '800000', todayInCourt(), ''],
        [1, transport, '200000', todayInCourt(), ''],
      ],
    );
    const page = await (await get('/saeckel/', 'anna')).text();
    assert.equal(treasury(page), '70 000,00 ₽');
    assert.deepEqual(pouchLines(page), [
      `<a href="/saeckel/pouches/${food}">Продукты</a> · 8 000,00 ₽ · трат пока не было`,
      `<a href="/saeckel/pouches/${flat}">Квартира</a> · 0,00 ₽ · трат пока не было`,
      `<a href="/saeckel/pouches/${transport}">Транспорт</a> · 2 000,00 ₽ · трат пока не было`,
    ]);
  });

  test('more than the treasury holds: written, the treasury goes below zero', async () => {
    const food = await addPouch(1, 'Продукты');
    await addOperation(1, 'income', 10_000);
    assert.equal((await assign({ [`amount_${food}`]: '150' })).status, 303);
    assert.equal(treasury(await (await get('/saeckel/', 'anna')).text()), '−50,00 ₽');
  });

  test('every field empty, or none at all: 400 «Впишите сумму…», nothing written', async () => {
    const food = await addPouch(1, 'Продукты');
    const flat = await addPouch(1, 'Квартира');
    for (const fields of [{ [`amount_${food}`]: '', [`amount_${flat}`]: '   ' }, {}]) {
      const res = await assign(fields);
      assert.equal(res.status, 400);
      assert.ok(
        (await res.text()).includes(`<p id="refusal" class="note note-error">${EMPTY}</p>`),
      );
    }
    assert.deepEqual(await operations(), []);
  });

  // M10.5: 303 to Мешки is what rings with coins after laying out — only after records written.
  test('every amount 0: 400 and nothing written; one right row among empty ones: 303, one record', async () => {
    const food = await addPouch(1, 'Продукты');
    const flat = await addPouch(1, 'Квартира');
    const zero = await assign({ [`amount_${food}`]: '0', [`amount_${flat}`]: '0,00' });
    assert.equal(zero.status, 400);
    assert.equal(zero.headers.get('location'), null);
    assert.deepEqual(await operations(), []);
    const done = await assign({ [`amount_${food}`]: '', [`amount_${flat}`]: '0,01' });
    assert.equal(done.status, 303);
    assert.equal(done.headers.get('location'), '/saeckel/');
    assert.deepEqual(
      (await operations()).map((row) => [row.kind, row.to_pouch_id, row.amount]),
      [['assign', flat, '1']],
    );
  });

  test('a wrong amount in one row: 400 under that row, every row as typed, nothing written', async () => {
    const food = await addPouch(1, 'Продукты');
    const flat = await addPouch(1, 'Квартира');
    const res = await assign({ [`amount_${food}`]: '100', [`amount_${flat}`]: '1,2,3' });
    assert.equal(res.status, 400);
    const page = await res.text();
    assert.ok(page.includes(`<p id="amount_${flat}-error" class="err-text">${FORMAT}</p>`));
    assert.ok(fold(page).includes(`aria-describedby="amount_${flat}-error"`));
    assert.deepEqual(assignRows(page), [
      ['Продукты', '0,00 ₽', '100'],
      ['Квартира', '0,00 ₽', '1,2,3'],
    ]);
    assert.deepEqual(await operations(), []);
  });

  test('a field sent twice: 400 under its row, nothing written, nothing counted twice', async () => {
    const food = await addPouch(1, 'Продукты');
    for (const twice of [
      ['100', '100'],
      ['100', ''],
    ]) {
      const res = await assign([
        [`amount_${food}`, twice[0]!],
        [`amount_${food}`, twice[1]!],
      ]);
      assert.equal(res.status, 400, twice.join('|'));
      assert.ok(
        (await res.text()).includes(`<p id="amount_${food}-error" class="err-text">${FORMAT}</p>`),
      );
    }
    assert.deepEqual(await operations(), []);
  });

  test('a field of an id of the wrong form: with an amount 400 «Мешок не найден.», empty skipped', async () => {
    const food = await addPouch(1, 'Продукты');
    for (const name of ['amount_abc', 'amount_01', 'amount_0', 'amount_', 'amount_2147483648']) {
      const res = await assign({ [name]: '1', [`amount_${food}`]: '5' });
      assert.equal(res.status, 400, name);
      assert.ok(
        (await res.text()).includes(`<p id="refusal" class="note note-error">${MISSING}</p>`),
        name,
      );
    }
    assert.deepEqual(await operations(), []);
    // Left empty, it is a row skipped like any other.
    assert.equal((await assign({ amount_abc: '', [`amount_${food}`]: '5' })).status, 303);
    assert.equal((await operations()).length, 1);
  });

  test('somebody else’s pouch and a missing one: the same 400, no name, nothing written', async () => {
    const food = await addPouch(1, 'Продукты');
    const his = await addPouch(2, 'Тайный мешок Бориса');
    const pages: string[] = [];
    for (const id of [his, 99_999]) {
      const res = await assign({ [`amount_${food}`]: '1', [`amount_${id}`]: '1' });
      assert.equal(res.status, 400, String(id));
      const page = await res.text();
      assert.ok(
        page.includes(`<p id="refusal" class="note note-error">${MISSING}</p>`),
        String(id),
      );
      assert.ok(!page.includes('Тайный'));
      pages.push(page);
    }
    assert.equal(pages[0], pages[1]);
    // A wrong amount in a row the page does not show: the same refusal, not a silent page.
    const wrong = await assign({ [`amount_${food}`]: '1', [`amount_${his}`]: 'abc' });
    assert.equal(wrong.status, 400);
    const page = await wrong.text();
    assert.ok(page.includes(`<p id="refusal" class="note note-error">${MISSING}</p>`));
    assert.ok(!page.includes(`amount_${his}`));
    assert.deepEqual(await operations(), []);
    await assertNothingHeld(food);
  });

  test('a pouch in the storeroom: 400 with its name, nothing written into any pouch', async () => {
    const food = await addPouch(1, 'Продукты');
    const old = await addPouch(1, 'Старый', true);
    const res = await assign({ [`amount_${food}`]: '1', [`amount_${old}`]: '1' });
    assert.equal(res.status, 400);
    assert.ok(
      (await res.text()).includes(
        `<p id="refusal" class="note note-error">${archivedRefusal('Старый')}</p>`,
      ),
    );
    assert.deepEqual(await operations(), []);
    await assertNothingHeld(food);
  });

  test('other fields change nothing: the user, the kind, the date, the note, the currency', async () => {
    const food = await addPouch(1, 'Продукты');
    const res = await assign({
      [`amount_${food}`]: '1',
      user_id: '2',
      kind: 'income',
      date: '01.01.2020',
      note: 'заметка',
      currency: 'EUR',
      to: '5',
    });
    assert.equal(res.status, 303);
    const [row] = await operations();
    assert.deepEqual(
      [row!.user_id, row!.kind, row!.to_pouch_id, row!.date, row!.note, row!.currency],
      [1, 'assign', food, todayInCourt(), '', 'RUB'],
    );
  });
});

describe('Разложить: all or nothing', () => {
  test('the second INSERT fails: 500, not one row, the client back, the pouches free', async (t: TestContext) => {
    t.mock.method(console, 'error', () => undefined);
    const food = await addPouch(1, 'Продукты');
    const flat = await addPouch(1, 'Квартира');
    // The rows go in the order of the pouches: the one into «Квартира» is the second.
    const drop = await failingTrigger('operations', 'INSERT', {
      when: `NEW.to_pouch_id = ${flat}`,
    });
    try {
      const res = await assign({ [`amount_${food}`]: '1', [`amount_${flat}`]: '2' });
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('location'), null);
      await assertNothingHeld(food);
      await assertNothingHeld(flat);
    } finally {
      await drop();
    }
    assert.deepEqual(await operations(), []);
    // The same rows go through once the database lets them.
    assert.equal((await assign({ [`amount_${food}`]: '1', [`amount_${flat}`]: '2' })).status, 303);
    assert.equal((await operations()).length, 2);
  });

  test('the COMMIT fails: 500, no redirect, nothing written', async (t: TestContext) => {
    t.mock.method(console, 'error', () => undefined);
    const food = await addPouch(1, 'Продукты');
    const drop = await failingTrigger('operations', 'INSERT', { atCommit: true });
    try {
      const res = await assign({ [`amount_${food}`]: '1' });
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('location'), null);
      await assertNothingHeld(food);
    } finally {
      await drop();
    }
    assert.deepEqual(await operations(), []);
  });

  test('an income: its INSERT fails, or it fails at COMMIT: 500, no redirect, nothing', async (t: TestContext) => {
    t.mock.method(console, 'error', () => undefined);
    for (const atCommit of [false, true]) {
      const drop = await failingTrigger('operations', 'INSERT', { atCommit });
      try {
        const res = await income({ amount: '1', date: '', note: '' });
        assert.equal(res.status, 500, String(atCommit));
        assert.equal(res.headers.get('location'), null);
      } finally {
        await drop();
      }
    }
    assert.deepEqual(await operations(), []);
  });
});

describe('Разложить and others at once', () => {
  test('laying out first: the archiving waits, then sees it in the balance, 400', async () => {
    const food = await addPouch(1, 'Продукты');
    const rival = await pool.connect();
    let laidOut: Response;
    let archived: Response;
    try {
      await rival.query('BEGIN');
      await rival.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE', [food]);
      const laying = assign({ [`amount_${food}`]: '1' });
      assert.match((await waitingQueries(1))[0]!, ASSIGN_LOCK);
      const archiving = archive(food);
      const waiting = await waitingQueries(2);
      assert.ok(
        waiting.some((query) => ARCHIVE_LOCK.test(query)),
        waiting.join('\n'),
      );
      await rival.query('COMMIT');
      laidOut = await laying;
      archived = await archiving;
    } finally {
      rival.release();
    }
    assert.equal(laidOut.status, 303);
    assert.equal(archived.status, 400);
    assert.equal(await isArchived(food), false);
    assert.equal((await operations()).length, 1);
    await assertNothingHeld(food);
  });

  test('the archiving first: laying out waits, finds the storeroom, writes into no pouch', async () => {
    const food = await addPouch(1, 'Продукты');
    const old = await addPouch(1, 'Отпуск');
    const rival = await pool.connect();
    let archived: Response;
    let laidOut: Response;
    try {
      await rival.query('BEGIN');
      await rival.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE', [old]);
      const archiving = archive(old);
      assert.match((await waitingQueries(1))[0]!, ARCHIVE_LOCK);
      // Laying out locks «Продукты», then waits for «Отпуск» behind the archiving.
      const laying = assign({ [`amount_${food}`]: '1', [`amount_${old}`]: '1' });
      const waiting = await waitingQueries(2);
      assert.ok(
        waiting.some((query) => ASSIGN_LOCK.test(query)),
        waiting.join('\n'),
      );
      await rival.query('COMMIT');
      archived = await archiving;
      laidOut = await laying;
    } finally {
      rival.release();
    }
    assert.equal(archived.status, 303);
    assert.equal(laidOut.status, 400);
    assert.ok((await laidOut.text()).includes(archivedRefusal('Отпуск')));
    assert.deepEqual(await operations(), []);
    await assertNothingHeld(food);
    await assertNothingHeld(old);
  });

  test('two layings out with their fields in opposite orders: no deadlock, both written', async () => {
    const food = await addPouch(1, 'Продукты');
    const flat = await addPouch(1, 'Квартира');
    // The rival holds the pouch of the larger id. The first laying out names it first.
    const rival = await pool.connect();
    let first: Response;
    let second: Response;
    try {
      await rival.query('BEGIN');
      await rival.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE', [flat]);
      const one = assign([
        [`amount_${flat}`, '1'],
        [`amount_${food}`, '2'],
      ]);
      await waitingQueries(1);
      const two = assign([
        [`amount_${food}`, '3'],
        [`amount_${flat}`, '4'],
      ]);
      const waiting = await waitingQueries(2);
      for (const query of waiting) assert.match(query, ASSIGN_LOCK);
      await rival.query('COMMIT');
      first = await one;
      second = await two;
    } finally {
      rival.release();
    }
    assert.equal(first.status, 303);
    assert.equal(second.status, 303);
    const page = await (await get('/saeckel/', 'anna')).text();
    assert.deepEqual(pouchLines(page), [
      `<a href="/saeckel/pouches/${food}">Продукты</a> · 5,00 ₽ · трат пока не было`,
      `<a href="/saeckel/pouches/${flat}">Квартира</a> · 5,00 ₽ · трат пока не было`,
    ]);
    assert.equal((await operations()).length, 4);
    await assertNothingHeld(food);
    await assertNothingHeld(flat);
  });
});
