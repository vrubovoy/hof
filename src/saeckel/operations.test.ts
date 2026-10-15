// M6.4: «Исправить запись» (ARCHITECTURE.md §4.1, §4.8, §5.4, §5.5). Database: hof_test as
// hof_saeckel; who is signed in comes from the stand-in of test-helpers. Races are put in order
// by real locks and pg_stat_activity, never by waiting a while.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import type { PoolClient } from 'pg';
import { migrate } from '../migrate.ts';
import { dateForField, today } from './dates.ts';
import {
  addOperation,
  addPouch,
  appWithoutDatabase,
  assertNothingHeld,
  deadPool,
  failingTrigger,
  fold,
  get,
  operations,
  pool,
  post,
  waitingQueries,
} from './test-helpers.ts';

before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
beforeEach(() => pool.query('TRUNCATE operations, pouches RESTART IDENTITY'));
after(() => Promise.all([pool.end(), deadPool.end()]));

const CHOOSE = 'Выберите мешок.';
const MISSING = 'Мешок не найден.';
const SAME = 'Нельзя переложить в тот же мешок.';
const stored = (name: string) =>
  `Мешок «${name}» в Кладовой: запись с ним не исправляется и не удаляется. Сначала верните мешок.`;

// The statements that wait: the lock of the record, the lock of its pouches, an archiving.
const RECORD_LOCK =
  /^SELECT from_pouch_id, to_pouch_id FROM operations WHERE id = \$1 AND user_id = \$2 FOR UPDATE/;
const POUCHES_LOCK =
  /^SELECT id, name, is_archived FROM pouches WHERE user_id = \$1 AND id = ANY\(\$2\) ORDER BY id FOR UPDATE/;
const ARCHIVE_LOCK = /^SELECT id, name, icon, is_archived FROM pouches WHERE id = \$1/;

const todayInCourt = () => today('Europe/Moscow', new Date());

function edit(id: number | string, fields: Record<string, string>, who = 'anna') {
  return post(`/saeckel/operations/${id}`, { date: '', note: '', ...fields }, who);
}

function archive(id: number, who = 'anna') {
  return post(`/saeckel/pouches/${id}/archive`, {}, who);
}

async function record(id: number) {
  return (await operations()).find((row) => row.id === id);
}

// The balance a pouch page shows, also for a pouch in the storeroom.
async function balance(pouchId: number): Promise<string | undefined> {
  const page = fold(await (await get(`/saeckel/pouches/${pouchId}`, 'anna')).text());
  return /<p>Остаток ([^<]*)<\/p>/.exec(page)?.[1];
}

// The sum the block «Казна» shows on Мешки.
async function treasury(): Promise<string | undefined> {
  const page = fold(await (await get('/saeckel/', 'anna')).text());
  return /<h2>Казна<\/h2> <p>([^<]*)<\/p>/.exec(page)?.[1];
}

// The lists of a form: for each, its options as [value, text, chosen].
function lists(page: string): Record<string, [string, string, boolean][]> {
  const found: Record<string, [string, string, boolean][]> = {};
  for (const m of page.matchAll(/<select id="(\w+)" name="\w+"[^>]*>([\s\S]*?)<\/select>/g)) {
    found[m[1]!] = [
      ...m[2]!.matchAll(/<option\s+value="([^"]*)"\s*(selected)?\s*>([\s\S]*?)<\/option>/g),
    ].map((o) => [o[1]!, fold(o[3]!).trim(), o[2] !== undefined]);
  }
  return found;
}

// What is in the fields amount, date and note.
function values(page: string): string[] {
  return ['amount', 'date', 'note'].map(
    (field) => new RegExp(`<input\\s+id="${field}"[\\s\\S]*?value="([^"]*)"`).exec(page)?.[1] ?? '',
  );
}

// Resolves once a query waiting for a lock matches `statement`.
async function waitingFor(statement: RegExp): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query<{ query: string }>(
      "SELECT query FROM pg_stat_activity WHERE datname = 'hof_test' AND wait_event_type = 'Lock'",
    );
    if (rows.some((row) => statement.test(row.query))) return;
    await sleep(10);
  }
  assert.fail(`no query ${statement} waited for a lock`);
}

// A connection of the test inside a transaction, rolled back and released whatever happens.
async function holder<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await work(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('the page of a record', () => {
  test('each kind: its lists, the values of the record, the active pouches by name', async () => {
    const food = await addPouch(1, 'Продукты');
    const trip = await addPouch(1, 'Отпуск');
    await addPouch(1, 'Старый', true);
    await addPouch(2, 'Мешок Бориса');
    const active = (chosen: number): [string, string, boolean][] => [
      [String(food), 'Продукты', chosen === food],
      [String(trip), 'Отпуск', chosen === trip],
    ];
    const cases: [number, string, Record<string, [string, string, boolean][]>, string[]][] = [
      [
        await addOperation(1, 'income', 8_000_000, {}, '2026-09-30', 'зарплата'),
        'Доход · 30.09.2026',
        {},
        ['80 000,00', '30.09.2026', 'зарплата'],
      ],
      [
        await addOperation(1, 'assign', 800_000, { to: trip }, '2026-10-01'),
        'Из казны · 01.10.2026',
        { to: active(trip) },
        ['8 000,00', '01.10.2026', ''],
      ],
      [
        await addOperation(1, 'expense', 124_050, { from: food }, '2026-10-05', 'овощи'),
        'Трата · 05.10.2026',
        { from: active(food) },
        ['1 240,50', '05.10.2026', 'овощи'],
      ],
      [
        await addOperation(1, 'transfer', 76_000, { from: trip, to: food }, '2026-10-04'),
        'Из мешка в мешок · 04.10.2026',
        { from: active(trip), to: active(food) },
        ['760,00', '04.10.2026', ''],
      ],
    ];
    for (const [id, heading, expectedLists, expectedValues] of cases) {
      const res = await get(`/saeckel/operations/${id}`, 'anna');
      assert.equal(res.status, 200, heading);
      const page = await res.text();
      const folded = fold(page);
      for (const text of [
        '<p><a href="/saeckel/history">Летопись</a></p>',
        `<h1>${heading}</h1>`,
        `<form method="post" action="/saeckel/operations/${id}">`,
        '<label for="amount">Сумма, ₽</label>',
        '<p>Вид записи не меняется.</p>',
        '<button type="submit">Сохранить</button>',
      ]) {
        assert.ok(folded.includes(text), `${heading}: ${text}`);
      }
      assert.deepEqual(lists(page), expectedLists, heading);
      assert.deepEqual(values(page), expectedValues, heading);
      assert.ok(!page.includes('Старый') && !page.includes('Мешок Бориса'), heading);
    }
  });

  test('a pouch of the record in the storeroom: to read, why, the way to it; an income is a form', async () => {
    const food = await addPouch(1, 'Продукты');
    const old = await addPouch(1, 'Старый');
    const older = await addPouch(1, 'Совсем старый');
    const spent = await addOperation(1, 'expense', 100, { from: old });
    const moved = await addOperation(1, 'transfer', 100, { from: old, to: older });
    const kept = await addOperation(1, 'expense', 100, { from: food });
    const income = await addOperation(1, 'income', 100);
    await pool.query('UPDATE pouches SET is_archived = true WHERE id = ANY($1)', [[old, older]]);
    const one = fold(await (await get(`/saeckel/operations/${spent}`, 'anna')).text());
    assert.ok(!one.includes('<form'));
    assert.ok(one.includes(`<p> Мешок «<a href="/saeckel/pouches/${old}">Старый</a>» в Кладовой:`));
    assert.ok(one.includes('исправляется и не удаляется. Сначала верните мешок. </p>'));
    const two = await (await get(`/saeckel/operations/${moved}`, 'anna')).text();
    assert.equal((two.match(/в Кладовой: запись с ним не/g) ?? []).length, 2);
    for (const id of [kept, income]) {
      const page = await (await get(`/saeckel/operations/${id}`, 'anna')).text();
      assert.ok(
        page.includes(`<form method="post" action="/saeckel/operations/${id}">`),
        String(id),
      );
    }
  });

  test('somebody else’s, a missing one and a wrong id: the same 404, to read or to change', async () => {
    const his = await addPouch(2, 'Тайный мешок Бориса');
    const hisRecord = await addOperation(2, 'expense', 100, { from: his });
    const missing = await (await get('/saeckel/operations/99999', 'anna')).text();
    for (const value of [String(hisRecord), '99999', 'abc', '01', '0', '2147483648']) {
      for (const res of [
        await get(`/saeckel/operations/${value}`, 'anna'),
        await edit(value, { amount: '1' }),
      ]) {
        assert.equal(res.status, 404, value);
        assert.equal(await res.text(), missing, value);
      }
    }
    assert.equal((await record(hisRecord))!.amount, '100');
  });
});

describe('Исправить', () => {
  test('each kind: amount, date and note; the treasury and the balances follow exactly', async () => {
    const food = await addPouch(1, 'Продукты');
    const trip = await addPouch(1, 'Отпуск');
    const cart = await addPouch(1, 'Транспорт');
    const income = await addOperation(1, 'income', 8_000_000, {}, '2026-09-30', 'зарплата');
    const laid = await addOperation(1, 'assign', 800_000, { to: food }, '2026-10-01');
    const spent = await addOperation(1, 'expense', 124_000, { from: food }, '2026-10-05');
    const moved = await addOperation(1, 'transfer', 76_000, { from: trip, to: cart }, '2026-10-04');
    assert.equal(await treasury(), '72 000,00 ₽');

    const change = async (id: number, fields: Record<string, string>) => {
      const res = await edit(id, fields);
      assert.equal(res.status, 303, String(id));
      assert.equal(res.headers.get('location'), '/saeckel/history');
    };
    await change(income, { amount: '75 000', date: '01.10.2026', note: 'аванс' });
    assert.equal(await treasury(), '67 000,00 ₽');
    await change(laid, { to: String(food), amount: '7 000', date: '01.10.2026' });
    assert.equal(await treasury(), '68 000,00 ₽');
    assert.equal(await balance(food), '5 760,00 ₽');
    await change(spent, { from: String(food), amount: '1 204', date: '05.10.2026', note: 'овощи' });
    assert.equal(await balance(food), '5 796,00 ₽');
    await change(moved, {
      from: String(trip),
      to: String(cart),
      amount: '800',
      date: '04.10.2026',
    });
    assert.deepEqual([await balance(trip), await balance(cart)], ['−800,00 ₽', '800,00 ₽']);
    assert.equal(await treasury(), '68 000,00 ₽');

    assert.deepEqual(
      (await operations()).map((row) => [row.kind, row.amount, row.date, row.note, row.currency]),
      [
        ['income', '7500000', '2026-10-01', 'аванс', 'RUB'],
        ['assign', '700000', '2026-10-01', '', 'RUB'],
        ['expense', '120400', '2026-10-05', 'овощи', 'RUB'],
        ['transfer', '80000', '2026-10-04', '', 'RUB'],
      ],
    );
  });

  test('the pouches move: an assign and an expense into another one, a transfer every way', async () => {
    const a = await addPouch(1, 'А');
    const b = await addPouch(1, 'Б');
    const c = await addPouch(1, 'В');
    const laid = await addOperation(1, 'assign', 1_000, { to: a });
    const spent = await addOperation(1, 'expense', 300, { from: a });
    const moved = await addOperation(1, 'transfer', 200, { from: a, to: b });
    assert.equal((await edit(laid, { to: String(b), amount: '10' })).status, 303);
    assert.equal((await edit(spent, { from: String(c), amount: '3' })).status, 303);
    assert.deepEqual(
      [await balance(a), await balance(b), await balance(c)],
      ['−2,00 ₽', '12,00 ₽', '−3,00 ₽'],
    );
    // Another source, another target, then the two swapped.
    assert.equal((await edit(moved, { from: String(c), to: String(b), amount: '2' })).status, 303);
    assert.deepEqual(
      [await balance(a), await balance(b), await balance(c)],
      ['0,00 ₽', '12,00 ₽', '−5,00 ₽'],
    );
    assert.equal((await edit(moved, { from: String(c), to: String(a), amount: '2' })).status, 303);
    assert.equal((await edit(moved, { from: String(a), to: String(c), amount: '2' })).status, 303);
    assert.deepEqual(
      [await balance(a), await balance(b), await balance(c)],
      ['−2,00 ₽', '10,00 ₽', '−1,00 ₽'],
    );
    const rows = await operations();
    assert.deepEqual(
      rows.map((row) => [row.id, row.kind, row.from_pouch_id, row.to_pouch_id]),
      [
        [laid, 'assign', null, b],
        [spent, 'expense', c, null],
        [moved, 'transfer', a, c],
      ],
    );
  });

  test('exact hundredths, and no date means today', async () => {
    const food = await addPouch(1, 'Продукты');
    const spent = await addOperation(1, 'expense', 100, { from: food }, '2026-10-05');
    assert.equal((await edit(spent, { from: String(food), amount: '0,29', date: '' })).status, 303);
    const row = await record(spent);
    assert.deepEqual([row!.amount, row!.date], ['29', todayInCourt()]);
  });

  test('wrong fields: 400, each error under its field, what was typed kept, nothing changed', async () => {
    const food = await addPouch(1, 'Продукты');
    const spent = await addOperation(1, 'expense', 100, { from: food }, '2026-10-05', 'было');
    const res = await edit(spent, {
      from: String(food),
      amount: '1,2,3',
      date: '31.02.2026',
      note: 'a\u0001b',
    });
    assert.equal(res.status, 400);
    const page = await res.text();
    for (const id of ['amount-error', 'date-error', 'note-error']) {
      assert.ok(page.includes(`<p id="${id}">`), id);
    }
    assert.deepEqual(values(page).slice(0, 2), ['1,2,3', '31.02.2026']);
    assert.ok(fold(page).includes('<h1>Трата · 05.10.2026</h1>'));
    assert.deepEqual(lists(page).from!.filter(([, , chosen]) => chosen).length, 1);
    const row = await record(spent);
    assert.deepEqual([row!.amount, row!.date, row!.note], ['100', '2026-10-05', 'было']);
  });

  test('the lists: nothing chosen, a wrong id, one pouch in both lists of a transfer', async () => {
    const a = await addPouch(1, 'А');
    const b = await addPouch(1, 'Б');
    const spent = await addOperation(1, 'expense', 100, { from: a });
    const moved = await addOperation(1, 'transfer', 100, { from: a, to: b });
    const cases: [number, Record<string, string>, string, string][] = [
      [spent, { from: '' }, 'from', CHOOSE],
      [spent, { from: 'abc' }, 'from', MISSING],
      [spent, { from: '01' }, 'from', MISSING],
      [moved, { from: String(a), to: '' }, 'to', CHOOSE],
      [moved, { from: String(b), to: String(b) }, 'to', SAME],
    ];
    for (const [id, fields, field, text] of cases) {
      const res = await edit(id, { amount: '5', ...fields });
      assert.equal(res.status, 400, JSON.stringify(fields));
      assert.ok(
        (await res.text()).includes(`<p id="${field}-error">${text}</p>`),
        JSON.stringify(fields),
      );
    }
    assert.deepEqual(
      (await operations()).map((row) => [row.amount, row.from_pouch_id, row.to_pouch_id]),
      [
        ['100', a, null],
        ['100', a, b],
      ],
    );
    await assertNothingHeld(a);
    await assertNothingHeld(b);
  });

  test('somebody else’s pouch and a missing one: «Мешок не найден.», no name, nothing changed', async () => {
    const a = await addPouch(1, 'А');
    const b = await addPouch(1, 'Б');
    const his = await addPouch(2, 'Тайный мешок Бориса');
    const spent = await addOperation(1, 'expense', 100, { from: a });
    const moved = await addOperation(1, 'transfer', 100, { from: a, to: b });
    const pages: string[] = [];
    for (const id of [his, 99_999]) {
      const res = await edit(spent, { from: String(id), amount: '5' });
      assert.equal(res.status, 400);
      const page = await res.text();
      assert.ok(page.includes(`<p id="from-error">${MISSING}</p>`));
      assert.ok(!page.includes('Тайный'));
      pages.push(page);
    }
    assert.equal(pages[0], pages[1]);
    // The same somebody else's pouch in both lists of a transfer is not found, not «the same».
    const both = await edit(moved, { from: String(his), to: String(his), amount: '5' });
    assert.equal(both.status, 400);
    const page = await both.text();
    assert.ok(page.includes(`<p id="from-error">${MISSING}</p>`));
    assert.ok(!page.includes(SAME));
    assert.deepEqual(
      (await operations()).map((row) => [row.amount, row.from_pouch_id, row.to_pouch_id]),
      [
        ['100', a, null],
        ['100', a, b],
      ],
    );
    await assertNothingHeld(a);
  });

  test('a new pouch in the storeroom: 400 under its list, nothing changed', async () => {
    const food = await addPouch(1, 'Продукты');
    const old = await addPouch(1, 'Старый', true);
    const spent = await addOperation(1, 'expense', 100, { from: food });
    const res = await edit(spent, { from: String(old), amount: '5' });
    assert.equal(res.status, 400);
    assert.ok((await res.text()).includes(`<p id="from-error">${stored('Старый')}</p>`));
    const row = await record(spent);
    assert.deepEqual([row!.amount, row!.from_pouch_id], ['100', food]);
    await assertNothingHeld(food);
    await assertNothingHeld(old);
  });

  test('a record already of a pouch in the storeroom: the form sent anyway is 400, to read', async () => {
    const food = await addPouch(1, 'Продукты');
    const other = await addPouch(1, 'Другой');
    const spent = await addOperation(1, 'expense', 100, { from: food });
    await pool.query('UPDATE pouches SET is_archived = true WHERE id = $1', [food]);
    const res = await edit(spent, { from: String(other), amount: '5' });
    assert.equal(res.status, 400);
    const page = await res.text();
    assert.ok(!page.includes('<form'));
    assert.ok(page.includes('в Кладовой: запись с ним не'));
    const row = await record(spent);
    assert.deepEqual([row!.amount, row!.from_pouch_id], ['100', food]);
  });

  test('the kind, the user, the currency and lists the kind has not change nothing', async () => {
    const a = await addPouch(1, 'А');
    const b = await addPouch(1, 'Б');
    const spent = await addOperation(1, 'expense', 100, { from: a });
    const income = await addOperation(1, 'income', 100);
    const forged = { kind: 'income', user_id: '2', currency: 'EUR' };
    assert.equal(
      (await edit(spent, { ...forged, from: String(a), to: String(b), amount: '2' })).status,
      303,
    );
    assert.equal(
      (
        await edit(income, {
          ...forged,
          kind: 'transfer',
          from: String(a),
          to: String(b),
          amount: '3',
        })
      ).status,
      303,
    );
    assert.deepEqual(
      (await operations()).map((row) => [
        row.kind,
        row.user_id,
        row.currency,
        row.from_pouch_id,
        row.to_pouch_id,
        row.amount,
      ]),
      [
        ['expense', 1, 'RUB', a, null, '200'],
        ['income', 1, 'RUB', null, null, '300'],
      ],
    );
  });

  test('without a session: POST goes to /login, nothing is queried', async () => {
    const res = await post('/saeckel/operations/1', { amount: '1' }, undefined, appWithoutDatabase);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');
    const page = await get('/saeckel/operations/1', undefined, appWithoutDatabase);
    assert.equal(
      page.headers.get('location'),
      `/login?next=${encodeURIComponent('/saeckel/operations/1')}`,
    );
  });
});

describe('Исправить: failures', () => {
  for (const atCommit of [false, true]) {
    test(`the ${atCommit ? 'COMMIT' : 'UPDATE'} fails: 500, no Location, the record as it was`, async (t: TestContext) => {
      t.mock.method(console, 'error', () => undefined);
      const a = await addPouch(1, 'А');
      const b = await addPouch(1, 'Б');
      const spent = await addOperation(1, 'expense', 100, { from: a }, '2026-10-05', 'было');
      const drop = await failingTrigger('operations', 'UPDATE', { atCommit });
      try {
        const res = await edit(spent, { from: String(b), amount: '5', note: 'стало' });
        assert.equal(res.status, 500);
        assert.equal(res.headers.get('location'), null);
        await assertNothingHeld(a);
        await assertNothingHeld(b);
      } finally {
        await drop();
      }
      const row = await record(spent);
      assert.deepEqual([row!.amount, row!.from_pouch_id, row!.note], ['100', a, 'было']);
      // The same change goes through once the database lets it.
      assert.equal((await edit(spent, { from: String(b), amount: '5' })).status, 303);
    });
  }
});

describe('Исправить and others at once', () => {
  test('the old pouches come from the locked row: a record moved meanwhile is locked where it is now', async () => {
    const a = await addPouch(1, 'А');
    const b = await addPouch(1, 'Б');
    const c = await addPouch(1, 'В');
    const spent = await addOperation(1, 'expense', 100, { from: a });
    let res: Response | undefined;
    await holder(async (onC) => {
      // The holder of C lets a foreign key take KEY SHARE on C, but not FOR UPDATE.
      await onC.query('SELECT 1 FROM pouches WHERE id = $1 FOR NO KEY UPDATE', [c]);
      await holder(async (mover) => {
        // Another tab moves the expense to C and has not committed yet: it does not wait.
        await mover.query('UPDATE operations SET from_pouch_id = $1 WHERE id = $2', [c, spent]);
        // The page said A; the form says B. The edit waits for the row of the record.
        const pending = edit(spent, { from: String(b), amount: '1' });
        await waitingFor(RECORD_LOCK);
        await mover.query('COMMIT');
        // Locked, the row says C: the edit now waits for C, held by the holder, and not for A.
        await waitingFor(POUCHES_LOCK);
        await holder(async (probe) => {
          await probe.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE NOWAIT', [a]);
        });
        await onC.query('COMMIT');
        res = await pending;
      });
    });
    assert.equal(res!.status, 303);
    assert.equal((await record(spent))!.from_pouch_id, b);
    assert.deepEqual(
      [await balance(a), await balance(b), await balance(c)],
      ['0,00 ₽', '−1,00 ₽', '0,00 ₽'],
    );
    for (const id of [a, b, c]) await assertNothingHeld(id);
  });

  test('two edits of one record at once: both written in turn, the last one wins', async () => {
    const a = await addPouch(1, 'А');
    const spent = await addOperation(1, 'expense', 100, { from: a });
    const answers = await holder(async (rival) => {
      await rival.query('SELECT 1 FROM operations WHERE id = $1 FOR UPDATE', [spent]);
      const first = edit(spent, { from: String(a), amount: '1', note: 'первая' });
      await waitingQueries(1);
      const second = edit(spent, { from: String(a), amount: '2', note: 'вторая' });
      const waiting = await waitingQueries(2);
      for (const query of waiting) assert.match(query, RECORD_LOCK);
      await rival.query('COMMIT');
      return Promise.all([first, second]);
    });
    assert.deepEqual(
      answers.map((res) => res.status),
      [303, 303],
    );
    const row = await record(spent);
    assert.deepEqual([row!.amount, row!.note], ['200', 'вторая']);
  });

  // The old pouch: it holds an assign and an expense that come to zero; the edit makes the
  // expense smaller, so the pouch would hold money afterwards.
  for (const first of ['edit', 'archive'] as const) {
    test(`the old pouch archived at once, ${first} first: no money in the storeroom`, async () => {
      const food = await addPouch(1, 'Продукты');
      await addOperation(1, 'assign', 100, { to: food });
      const spent = await addOperation(1, 'expense', 100, { from: food });
      const answers = await holder(async (rival) => {
        await rival.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE', [food]);
        const order =
          first === 'edit' ? (['edit', 'archive'] as const) : (['archive', 'edit'] as const);
        const pending: Record<string, Promise<Response>> = {};
        for (const [i, action] of order.entries()) {
          pending[action] = Promise.resolve(
            action === 'edit' ? edit(spent, { from: String(food), amount: '0,50' }) : archive(food),
          );
          const waiting = await waitingQueries(i + 1);
          const statement = action === 'edit' ? POUCHES_LOCK : ARCHIVE_LOCK;
          assert.ok(
            waiting.some((query) => statement.test(query)),
            waiting.join('\n'),
          );
        }
        await rival.query('COMMIT');
        return { edit: await pending.edit!, archive: await pending.archive! };
      });
      if (first === 'edit') {
        assert.equal(answers.edit.status, 303);
        assert.equal(answers.archive.status, 400);
        assert.equal((await record(spent))!.amount, '50');
        assert.equal(await balance(food), '0,50 ₽');
      } else {
        assert.equal(answers.archive.status, 303);
        assert.equal(answers.edit.status, 400);
        const page = await answers.edit.text();
        assert.ok(!page.includes('<form') && page.includes('в Кладовой: запись с ним не'));
        assert.equal((await record(spent))!.amount, '100');
        assert.equal(await balance(food), '0,00 ₽');
      }
      await assertNothingHeld(food);
    });
  }

  // The new pouch: empty, so it may go into the storeroom; the edit moves an expense into it.
  for (const first of ['edit', 'archive'] as const) {
    test(`the new pouch archived at once, ${first} first: no money into the storeroom`, async () => {
      const food = await addPouch(1, 'Продукты');
      const trip = await addPouch(1, 'Отпуск');
      const spent = await addOperation(1, 'expense', 100, { from: food });
      const answers = await holder(async (rival) => {
        await rival.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE', [trip]);
        const order =
          first === 'edit' ? (['edit', 'archive'] as const) : (['archive', 'edit'] as const);
        const pending: Record<string, Promise<Response>> = {};
        for (const [i, action] of order.entries()) {
          pending[action] = Promise.resolve(
            action === 'edit' ? edit(spent, { from: String(trip), amount: '1' }) : archive(trip),
          );
          const waiting = await waitingQueries(i + 1);
          const statement = action === 'edit' ? POUCHES_LOCK : ARCHIVE_LOCK;
          assert.ok(
            waiting.some((query) => statement.test(query)),
            waiting.join('\n'),
          );
        }
        await rival.query('COMMIT');
        return { edit: await pending.edit!, archive: await pending.archive! };
      });
      if (first === 'edit') {
        assert.equal(answers.edit.status, 303);
        assert.equal(answers.archive.status, 400);
        assert.equal((await record(spent))!.from_pouch_id, trip);
        assert.equal(await balance(trip), '−1,00 ₽');
      } else {
        assert.equal(answers.archive.status, 303);
        assert.equal(answers.edit.status, 400);
        assert.ok(
          (await answers.edit.text()).includes(`<p id="from-error">${stored('Отпуск')}</p>`),
        );
        assert.equal((await record(spent))!.from_pouch_id, food);
        assert.equal(await balance(trip), '0,00 ₽');
      }
      await assertNothingHeld(food);
      await assertNothingHeld(trip);
    });
  }

  test('the record deleted meanwhile: the edit waits for its row, then 404', async () => {
    const food = await addPouch(1, 'Продукты');
    const spent = await addOperation(1, 'expense', 100, { from: food });
    const res = await holder(async (rival) => {
      await rival.query('DELETE FROM operations WHERE id = $1', [spent]);
      const pending = edit(spent, { from: String(food), amount: '1' });
      await waitingFor(RECORD_LOCK);
      await rival.query('COMMIT');
      return pending;
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await operations(), []);
    await assertNothingHeld(food);
  });
});

describe('the date of a record in its form', () => {
  test('ДД.ММ.ГГГГ as dates.ts writes it', async () => {
    const food = await addPouch(1, 'Продукты');
    const spent = await addOperation(1, 'expense', 100, { from: food }, '2024-02-29');
    const page = await (await get(`/saeckel/operations/${spent}`, 'anna')).text();
    assert.equal(values(page)[1], dateForField('2024-02-29'));
  });
});
