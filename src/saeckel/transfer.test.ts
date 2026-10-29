// M6.2: «Переложить из мешка в мешок» and «Покрыть из другого мешка» (ARCHITECTURE.md §4.1,
// §4.8, §5.6). Database: hof_test as hof_saeckel; who is signed in comes from the stand-in of
// test-helpers. Races are put in order by real locks and pg_stat_activity, never by waiting.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
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
  mainPart,
  operations,
  pool,
  post,
  pouchLines,
  pouches,
  treasurySum,
  waitingQueries,
  wayBack,
} from './test-helpers.ts';

before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
beforeEach(() => pool.query('TRUNCATE operations, pouches RESTART IDENTITY'));
after(() => Promise.all([pool.end(), deadPool.end()]));

const CHOOSE = 'Выберите мешок.';
const MISSING = 'Мешок не найден.';
const SAME = 'Нельзя переложить в тот же мешок.';
const archivedRefusal = (name: string) => `Мешок «${name}» в Кладовой: записи с ним не создаются.`;

// The statements that wait for the row of a pouch: the lock of a transfer, and of an archiving.
const TRANSFER_LOCK =
  /^SELECT id, name, is_archived FROM pouches WHERE user_id = \$1 AND id = ANY\(\$2\) ORDER BY id FOR UPDATE/;
const ARCHIVE_LOCK = /^SELECT id, name, icon, is_archived FROM pouches WHERE id = \$1/;

const todayInCourt = () => today('Europe/Moscow', new Date());

function transfer(fields: Record<string, string>, who = 'anna') {
  return post('/saeckel/transfer', { date: '', note: '', ...fields }, who);
}

function archive(id: number, who = 'anna') {
  return post(`/saeckel/pouches/${id}/archive`, {}, who);
}

async function isArchived(id: number): Promise<boolean> {
  return (await pouches()).find((row) => row.id === id)!.is_archived;
}

// The options of one list of «Переложить»: value, text and whether it is chosen.
function options(page: string, field: 'from' | 'to'): [string, string, boolean][] {
  const list = new RegExp(`<select id="${field}" name="${field}"[^>]*>([\\s\\S]*?)</select>`).exec(
    page,
  )?.[1];
  assert.ok(list !== undefined, `no list ${field}`);
  return [...list.matchAll(/<option\s+value="([^"]*)"\s*(selected)?\s*>([\s\S]*?)<\/option>/g)].map(
    (m) => [m[1]!, fold(m[3]!).trim(), m[2] !== undefined],
  );
}

const chosen = (page: string, field: 'from' | 'to') =>
  options(page, field)
    .filter(([, , selected]) => selected)
    .map(([value]) => value);

// The sum the block «Казна» shows on Мешки.
async function treasury(who = 'anna'): Promise<string | undefined> {
  return treasurySum(await (await get('/saeckel/', who)).text());
}

// The balance of each active pouch on Мешки, by name.
async function balances(who = 'anna'): Promise<Record<string, string>> {
  const lines = pouchLines(await (await get('/saeckel/', who)).text());
  return Object.fromEntries(
    lines.map((line) => {
      const [, name, balance] = /^<a [^>]*>([^<]*)<\/a> · ([^·]*) ·/.exec(line)!;
      return [name!, balance!.trim()];
    }),
  );
}

describe('the page «Переложить»', () => {
  test('the form: both lists of the active pouches of this user by id, «— выберите —» first', async () => {
    const food = await addPouch(1, 'Продукты');
    await addPouch(1, 'Старый', true);
    await addPouch(2, 'Мешок Бориса');
    const flat = await addPouch(1, 'Квартира');
    await addOperation(1, 'expense', 124_050, { from: flat });
    const res = await get('/saeckel/transfer', 'anna');
    assert.equal(res.status, 200);
    const page = await res.text();
    const folded = fold(page);
    for (const text of [
      '<title>Säckel — переложить</title>',
      '<h1 class="title t-2">Переложить из мешка в мешок</h1>',
      '<form class="entry" method="post" action="/saeckel/transfer" data-fx="transfer">',
      '<label for="from">Из мешка</label>',
      '<label for="to">В мешок</label>',
      '<label for="amount">Сумма, ₽</label>',
      `value="${dateForField(todayInCourt())}"`,
      '<button type="submit" class="btn btn-ochre">Переложить</button>',
    ]) {
      assert.ok(folded.includes(text), text);
    }
    for (const field of ['from', 'to'] as const) {
      assert.deepEqual(options(page, field), [
        ['', '— выберите —', false],
        [String(food), 'Продукты — 0,00 ₽', false],
        [String(flat), 'Квартира — −1 240,50 ₽', false],
      ]);
    }
    // The pouch in the storeroom is in no list: only in «Кладовая» of the column.
    assert.ok(!mainPart(page).includes('Старый'));
    assert.ok(!page.includes('Мешок Бориса'));
    assert.equal(wayBack(page), '/saeckel/ Мешки');
  });

  test('`from` and `to` choose an active pouch of this user, and nothing else', async () => {
    const food = await addPouch(1, 'Продукты');
    const flat = await addPouch(1, 'Квартира');
    const old = await addPouch(1, 'Старый', true);
    const his = await addPouch(2, 'Тайный мешок Бориса');
    const page = await (await get(`/saeckel/transfer?from=${food}&to=${flat}`, 'anna')).text();
    assert.deepEqual(chosen(page, 'from'), [String(food)]);
    assert.deepEqual(chosen(page, 'to'), [String(flat)]);
    for (const value of [his, old, '0', '01', 'abc', '99999', '2147483648', '', `${food}.0`]) {
      const other = await (await get(`/saeckel/transfer?from=${value}&to=${value}`, 'anna')).text();
      assert.deepEqual(chosen(other, 'from'), [], String(value));
      assert.deepEqual(chosen(other, 'to'), [], String(value));
      assert.ok(!other.includes('Тайный'), String(value));
      assert.ok(!mainPart(other).includes('Старый'), String(value));
    }
  });

  test('`amount` fills the field only as Hof writes it, and only when it parses', async () => {
    const field = async (amount: string) => {
      const page = await (
        await get(`/saeckel/transfer?amount=${encodeURIComponent(amount)}`, 'anna')
      ).text();
      return /<input\s+id="amount"[\s\S]*?value="([^"]*)"/.exec(page)![1];
    };
    assert.equal(await field('760,00'), '760,00');
    assert.equal(await field('760.5'), '760,50');
    assert.equal(await field('1240,5'), '1 240,50');
    assert.equal(await field('1 000 000 000'), '1 000 000 000,00');
    for (const amount of [
      '0',
      '-5',
      '−5',
      'abc',
      '1e3',
      '1000000000,01',
      '<script>alert(1)</script>',
    ]) {
      assert.equal(await field(amount), '', amount);
    }
    const page = await (
      await get(
        `/saeckel/transfer?amount=${encodeURIComponent('<script>alert(1)</script>')}`,
        'anna',
      )
    ).text();
    assert.ok(!page.includes('<script>'));
    assert.ok(!page.includes('alert'));
  });
});

describe('Переложить', () => {
  test('written for the one signed in: 303 to Мешки; both balances move, the treasury stays', async () => {
    const food = await addPouch(1, 'Продукты');
    const cart = await addPouch(1, 'Транспорт');
    await addOperation(1, 'income', 100_000);
    await addOperation(1, 'assign', 50_000, { to: food });
    const res = await transfer({
      from: String(food),
      to: String(cart),
      amount: '200',
      note: ' на бензин ',
      user_id: '2',
      kind: 'expense',
      currency: 'EUR',
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/saeckel/');
    const row = (await operations()).at(-1)!;
    assert.deepEqual(row, {
      id: row.id,
      user_id: 1,
      kind: 'transfer',
      amount: '20000',
      currency: 'RUB',
      from_pouch_id: food,
      to_pouch_id: cart,
      date: todayInCourt(),
      note: 'на бензин',
    });
    assert.deepEqual(await balances(), { Продукты: '300,00 ₽', Транспорт: '200,00 ₽' });
    assert.equal(await treasury(), '500,00 ₽');
  });

  test('the source may go below zero; exact hundredths; the sum of the two stays', async () => {
    const food = await addPouch(1, 'Продукты');
    const cart = await addPouch(1, 'Транспорт');
    assert.equal(
      (await transfer({ from: String(food), to: String(cart), amount: '0,29' })).status,
      303,
    );
    assert.equal(
      (
        await transfer({
          from: String(food),
          to: String(cart),
          amount: '1 240,50',
          date: '05.10.2026',
        })
      ).status,
      303,
    );
    assert.deepEqual(
      (await operations()).map((row) => [row.amount, row.date]),
      [
        ['29', todayInCourt()],
        ['124050', '2026-10-05'],
      ],
    );
    assert.deepEqual(await balances(), { Продукты: '−1 240,79 ₽', Транспорт: '1 240,79 ₽' });
    assert.equal(await treasury(), '0,00 ₽');
  });

  // M10.5: 303 to Мешки is what rings with coins after a transfer — only after its record.
  test('an amount of 0: 400 and nothing written; 0,01: 303 and one record', async () => {
    const food = await addPouch(1, 'Продукты');
    const flat = await addPouch(1, 'Квартира');
    for (const amount of ['0', '0,00']) {
      const res = await transfer({ from: String(food), to: String(flat), amount, note: '' });
      assert.equal(res.status, 400, amount);
      assert.equal(res.headers.get('location'), null, amount);
    }
    assert.deepEqual(await operations(), []);
    const done = await transfer({ from: String(food), to: String(flat), amount: '0,01', note: '' });
    assert.equal(done.status, 303);
    assert.equal(done.headers.get('location'), '/saeckel/');
    assert.deepEqual(
      (await operations()).map((row) => [row.kind, row.from_pouch_id, row.to_pouch_id, row.amount]),
      [['transfer', food, flat, '1']],
    );
  });

  test('no choice: «Выберите мешок.» under each list, what was typed kept, nothing written', async () => {
    await addPouch(1, 'Продукты');
    const res = await transfer({ from: '', to: '', amount: '760', note: 'заметка' });
    assert.equal(res.status, 400);
    const page = fold(await res.text());
    assert.ok(page.includes(`<p id="from-error" class="err-text">${CHOOSE}</p>`));
    assert.ok(page.includes(`<p id="to-error" class="err-text">${CHOOSE}</p>`));
    assert.ok(page.includes('aria-describedby="from-error"'));
    assert.ok(page.includes('value="760"'));
    assert.ok(page.includes('value="заметка"'));
    assert.deepEqual(await operations(), []);
  });

  test('one pouch of this user in both lists: «Нельзя переложить в тот же мешок.» under «В мешок»', async () => {
    const food = await addPouch(1, 'Продукты');
    const res = await transfer({ from: String(food), to: String(food), amount: '1' });
    assert.equal(res.status, 400);
    const page = await res.text();
    assert.ok(page.includes(`<p id="to-error" class="err-text">${SAME}</p>`));
    assert.ok(!page.includes('from-error'));
    assert.deepEqual(chosen(page, 'from'), [String(food)]);
    assert.deepEqual(await operations(), []);
    await assertNothingHeld(food);
  });

  test('one pouch of somebody else, or a missing one, in both lists: «Мешок не найден.»', async () => {
    const food = await addPouch(1, 'Продукты');
    const his = await addPouch(2, 'Тайный мешок Бориса');
    const pages: string[] = [];
    for (const id of [his, 99_999]) {
      const res = await transfer({ from: String(id), to: String(id), amount: '1' });
      assert.equal(res.status, 400, String(id));
      const page = await res.text();
      assert.ok(page.includes(`<p id="from-error" class="err-text">${MISSING}</p>`), String(id));
      assert.ok(!page.includes(SAME), String(id));
      assert.ok(!page.includes('Тайный'), String(id));
      pages.push(page);
    }
    assert.equal(pages[0], pages[1]);
    assert.deepEqual(await operations(), []);
    await assertNothingHeld(food);
    await assertNothingHeld(his);
  });

  test('an id of the wrong form: «Мешок не найден.» under its list', async () => {
    const food = await addPouch(1, 'Продукты');
    for (const wrong of ['abc', '01', '0', '-1', '2147483648', ' ']) {
      const res = await transfer({ from: wrong, to: String(food), amount: '1' });
      assert.equal(res.status, 400, wrong);
      assert.ok(
        (await res.text()).includes(`<p id="from-error" class="err-text">${MISSING}</p>`),
        wrong,
      );
    }
    assert.deepEqual(await operations(), []);
  });

  test('somebody else’s pouch and a missing one: the same 400, no name, nothing written', async () => {
    const food = await addPouch(1, 'Продукты');
    const his = await addPouch(2, 'Тайный мешок Бориса');
    const pages: string[] = [];
    for (const [from, to] of [
      [his, food],
      [99_999, food],
    ]) {
      const res = await transfer({ from: String(from), to: String(to), amount: '1' });
      assert.equal(res.status, 400);
      const page = await res.text();
      assert.ok(page.includes(`<p id="from-error" class="err-text">${MISSING}</p>`));
      assert.ok(!page.includes('Тайный'));
      pages.push(page);
    }
    assert.equal(pages[0], pages[1]);
    const into = await transfer({ from: String(food), to: String(his), amount: '1' });
    assert.equal(into.status, 400);
    assert.ok((await into.text()).includes(`<p id="to-error" class="err-text">${MISSING}</p>`));
    assert.deepEqual(await operations(), []);
    await assertNothingHeld(food);
  });

  for (const role of ['from', 'to'] as const) {
    test(`a pouch in the storeroom as the ${role === 'from' ? 'source' : 'target'}: 400 with its name, nothing`, async () => {
      const food = await addPouch(1, 'Продукты');
      const old = await addPouch(1, 'Старый', true);
      const fields = role === 'from' ? { from: old, to: food } : { from: food, to: old };
      const res = await transfer({ from: String(fields.from), to: String(fields.to), amount: '1' });
      assert.equal(res.status, 400);
      assert.ok(
        (await res.text()).includes(
          `<p id="${role}-error" class="err-text">${archivedRefusal('Старый')}</p>`,
        ),
      );
      assert.deepEqual(await operations(), []);
      await assertNothingHeld(food);
      await assertNothingHeld(old);
    });
  }

  test('wrong amount, date and note: 400 under each field, the choice and the typed kept', async () => {
    const food = await addPouch(1, 'Продукты');
    const cart = await addPouch(1, 'Транспорт');
    const res = await transfer({
      from: String(food),
      to: String(cart),
      amount: '1,2,3',
      date: '31.02.2026',
      note: 'a\u0001b',
    });
    assert.equal(res.status, 400);
    const page = await res.text();
    for (const id of ['amount-error', 'date-error', 'note-error']) {
      assert.ok(page.includes(`<p id="${id}" class="err-text">`), id);
    }
    assert.ok(page.includes('value="1,2,3"'));
    assert.ok(page.includes('value="31.02.2026"'));
    assert.deepEqual(chosen(page, 'from'), [String(food)]);
    assert.deepEqual(chosen(page, 'to'), [String(cart)]);
    assert.deepEqual(await operations(), []);
  });

  test('without a session: GET to /login with the way back, POST to /login, nothing queried', async () => {
    const path = '/saeckel/transfer?to=1&amount=5';
    const page = await get(path, undefined, appWithoutDatabase);
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), `/login?next=${encodeURIComponent(path)}`);
    const res = await post(
      '/saeckel/transfer',
      { from: '1', to: '2', amount: '1' },
      undefined,
      appWithoutDatabase,
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');
  });
});

describe('«Переложить» and «Покрыть из другого мешка» on a pouch', () => {
  test('«Переложить» on an active pouch; neither link on a pouch in the storeroom', async () => {
    const food = await addPouch(1, 'Продукты');
    const page = await (await get(`/saeckel/pouches/${food}`, 'anna')).text();
    assert.ok(
      page.includes(`<a class="link" href="/saeckel/transfer?from=${food}">Переложить</a>`),
    );
    const old = await addPouch(1, 'Старый');
    await addOperation(1, 'expense', 100, { from: old });
    await pool.query('UPDATE pouches SET is_archived = true WHERE id = $1', [old]);
    const stored = await (await get(`/saeckel/pouches/${old}`, 'anna')).text();
    assert.ok(!stored.includes('Переложить'));
    assert.ok(!stored.includes('Покрыть'));
  });

  test('«Покрыть…» only below zero, with the debt as the amount; it fills the form in', async () => {
    const cart = await addPouch(1, 'Транспорт');
    const empty = await (await get(`/saeckel/pouches/${cart}`, 'anna')).text();
    assert.ok(!empty.includes('Покрыть'));
    await addOperation(1, 'assign', 100, { to: cart });
    const above = await (await get(`/saeckel/pouches/${cart}`, 'anna')).text();
    assert.ok(!above.includes('Покрыть'));
    await addOperation(1, 'expense', 124_150, { from: cart });
    const href = `/saeckel/transfer?to=${cart}&amp;amount=1%C2%A0240%2C50`;
    for (const path of [`/saeckel/pouches/${cart}`, `/saeckel/pouches/${cart}/edit`]) {
      const page = fold(await (await get(path, 'anna')).text());
      assert.ok(page.includes(`<a class="link" href="${href}">Покрыть из другого мешка</a>`), path);
    }
    const form = await (await get(href.replace('&amp;', '&'), 'anna')).text();
    assert.deepEqual(chosen(form, 'to'), [String(cart)]);
    assert.deepEqual(chosen(form, 'from'), []);
    assert.ok(form.includes('value="1 240,50"'));
  });

  test('a debt larger than one record can hold: only the target', async () => {
    const cart = await addPouch(1, 'Транспорт');
    await addOperation(1, 'expense', 100_000_000_000, { from: cart });
    await addOperation(1, 'expense', 1, { from: cart });
    const page = await (await get(`/saeckel/pouches/${cart}`, 'anna')).text();
    assert.ok(
      page.includes(
        `<a class="link" href="/saeckel/transfer?to=${cart}">Покрыть из другого мешка</a>`,
      ),
    );
  });
});

describe('Переложить: failures', () => {
  for (const atCommit of [false, true]) {
    test(`the ${atCommit ? 'COMMIT' : 'INSERT'} fails: 500, no Location, nothing written, both pouches free`, async (t: TestContext) => {
      t.mock.method(console, 'error', () => undefined);
      const food = await addPouch(1, 'Продукты');
      const cart = await addPouch(1, 'Транспорт');
      const drop = await failingTrigger('operations', 'INSERT', { atCommit });
      try {
        const res = await transfer({ from: String(food), to: String(cart), amount: '1' });
        assert.equal(res.status, 500);
        assert.equal(res.headers.get('location'), null);
        await assertNothingHeld(food);
        await assertNothingHeld(cart);
      } finally {
        await drop();
      }
      assert.deepEqual(await operations(), []);
      // The same transfer goes through once the database lets it.
      assert.equal(
        (await transfer({ from: String(food), to: String(cart), amount: '1' })).status,
        303,
      );
    });
  }
});

describe('Переложить and others at once', () => {
  test('A → B and B → A at once: both wait for A, neither holds B, both written', async () => {
    const a = await addPouch(1, 'A');
    const b = await addPouch(1, 'B');
    const rival = await pool.connect();
    let there: Response;
    let back: Response;
    try {
      await rival.query('BEGIN');
      await rival.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE', [a]);
      const going = transfer({ from: String(a), to: String(b), amount: '1' });
      assert.match((await waitingQueries(1))[0]!, TRANSFER_LOCK);
      const coming = transfer({ from: String(b), to: String(a), amount: '2' });
      const waiting = await waitingQueries(2);
      for (const query of waiting) assert.match(query, TRANSFER_LOCK);
      // B, the larger id, is not held by either of them while they wait for A.
      const probe = await pool.connect();
      try {
        await probe.query('BEGIN');
        await probe.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE NOWAIT', [b]);
      } finally {
        await probe.query('ROLLBACK');
        probe.release();
      }
      await rival.query('COMMIT');
      there = await going;
      back = await coming;
    } finally {
      // Rolls back what a failed test left open; after a COMMIT it changes nothing.
      await rival.query('ROLLBACK').catch(() => undefined);
      rival.release();
    }
    assert.equal(there.status, 303);
    assert.equal(back.status, 303);
    assert.deepEqual(await balances(), { A: '1,00 ₽', B: '−1,00 ₽' });
    assert.equal((await operations()).length, 2);
    await assertNothingHeld(a);
    await assertNothingHeld(b);
  });

  // Each pouch of a transfer against its archiving, in both orders. The pouch to archive is
  // empty before; the rival holds its row so that both requests queue on it.
  for (const role of ['source', 'target'] as const) {
    for (const first of ['transfer', 'archive'] as const) {
      test(`the ${role} archived at once, ${first} first: nothing changes a pouch in the storeroom`, async () => {
        const source = await addPouch(1, 'Источник');
        const target = await addPouch(1, 'Цель');
        const archived = role === 'source' ? source : target;
        const rival = await pool.connect();
        const answers: Record<string, Response> = {};
        try {
          await rival.query('BEGIN');
          await rival.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE', [archived]);
          const order =
            first === 'transfer'
              ? (['transfer', 'archive'] as const)
              : (['archive', 'transfer'] as const);
          const pending: Promise<Response>[] = [];
          for (const [i, action] of order.entries()) {
            pending.push(
              Promise.resolve(
                action === 'archive'
                  ? archive(archived)
                  : transfer({ from: String(source), to: String(target), amount: '5' }),
              ),
            );
            const waiting = await waitingQueries(i + 1);
            const statement = action === 'archive' ? ARCHIVE_LOCK : TRANSFER_LOCK;
            assert.ok(
              waiting.some((query) => statement.test(query)),
              waiting.join('\n'),
            );
          }
          await rival.query('COMMIT');
          const results = await Promise.all(pending);
          for (const [i, action] of order.entries()) answers[action] = results[i]!;
        } finally {
          // Rolls back what a failed test left open; after a COMMIT it changes nothing.
          await rival.query('ROLLBACK').catch(() => undefined);
          rival.release();
        }
        if (first === 'transfer') {
          // Written first; the archiving then sees it in the balance and refuses.
          assert.equal(answers.transfer!.status, 303);
          assert.equal(answers.archive!.status, 400);
          assert.equal(await isArchived(archived), false);
          assert.equal((await operations()).length, 1);
        } else {
          // Archived first; the transfer then finds the storeroom and writes nothing.
          assert.equal(answers.archive!.status, 303);
          assert.equal(answers.transfer!.status, 400);
          const field = role === 'source' ? 'from' : 'to';
          const name = role === 'source' ? 'Источник' : 'Цель';
          assert.ok(
            (await answers.transfer!.text()).includes(
              `<p id="${field}-error" class="err-text">${archivedRefusal(name)}</p>`,
            ),
          );
          assert.equal(await isArchived(archived), true);
          assert.deepEqual(await operations(), []);
        }
        await assertNothingHeld(source);
        await assertNothingHeld(target);
      });
    }
  }

  test('two transfers out of one pouch at once: both written', async () => {
    const a = await addPouch(1, 'A');
    const b = await addPouch(1, 'B');
    const c = await addPouch(1, 'C');
    const rival = await pool.connect();
    let first: Response;
    let second: Response;
    try {
      await rival.query('BEGIN');
      await rival.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE', [a]);
      const one = transfer({ from: String(a), to: String(b), amount: '1' });
      await waitingQueries(1);
      const two = transfer({ from: String(a), to: String(c), amount: '2' });
      await waitingQueries(2);
      await rival.query('COMMIT');
      first = await one;
      second = await two;
    } finally {
      // Rolls back what a failed test left open; after a COMMIT it changes nothing.
      await rival.query('ROLLBACK').catch(() => undefined);
      rival.release();
    }
    assert.equal(first.status, 303);
    assert.equal(second.status, 303);
    assert.deepEqual(await balances(), { A: '−3,00 ₽', B: '1,00 ₽', C: '2,00 ₽' });
    await assertNothingHeld(a);
  });
});
