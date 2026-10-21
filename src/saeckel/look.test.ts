// The look of Säckel (ARCHITECTURE.md §2, §4.1, §4.9, §6): the pages and the CSS of Säckel name
// only files of its own static folder, and every file there is named; the pages lead only to
// Säckel and to the courtyard; one h1, no script, no style attribute, nothing from another site;
// the column of pouches beside the pages of «Мешки» shows only what is this user's, is read by a
// fixed number of statements and never inside a transaction of a handler. The common 404 and
// 500 are drawn by Core and are not checked here. The states grow with each Issue of M9.
// Database: hof_test as hof_saeckel.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { Hono } from 'hono';
import type { PoolClient } from 'pg';
import { migrate } from '../migrate.ts';
import { staticFiles } from '../static.ts';
import {
  addOperation,
  addPouch,
  currentTab,
  deadPool,
  fold,
  get,
  pool,
  post,
  pouchLines,
  treasurySum,
  wayBack,
} from './test-helpers.ts';

before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
beforeEach(() => pool.query('TRUNCATE operations, pouches RESTART IDENTITY'));
after(() => Promise.all([pool.end(), deadPool.end()]));

const STATIC = join(import.meta.dirname, 'static');
// The static folder of Säckel as main.ts serves it, by the same handler.
const files = new Hono();
files.use('/saeckel/static/*', staticFiles('/saeckel/static/', STATIC));
const served = async (address: string) => (await files.request(address)).status;

// Every file of the static folder, by its address.
function folderFiles(dir = STATIC, prefix = '/saeckel/static/'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? folderFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

// The files a page names: src, the href of <link> and every candidate of a srcset.
function pageFiles(page: string): string[] {
  const named = [
    ...page.matchAll(/\ssrc="([^"]*)"/g),
    ...page.matchAll(/<link\s[^>]*href="([^"]*)"/g),
  ].map((match) => match[1]!);
  for (const [, set] of page.matchAll(/\ssrcset="([^"]*)"/g)) {
    named.push(...set!.split(',').map((candidate) => candidate.trim().split(/\s+/)[0]!));
  }
  return named;
}

// The addresses a page leads to: its links and its forms.
function pageLinks(page: string): string[] {
  return [
    ...page.matchAll(/<a\s[^>]*href="([^"]*)"/g),
    ...page.matchAll(/<form\s[^>]*action="([^"]*)"/g),
  ].map((match) => match[1]!);
}

const CSS = readFileSync(join(STATIC, 'saeckel.css'), 'utf8');

// The addresses saeckel.css names in url(…), resolved against the CSS itself.
const cssFiles = [...CSS.matchAll(/url\(([^)]*)\)/g)].map(
  (match) => new URL(match[1]!, 'http://hof.test/saeckel/static/saeckel.css').pathname,
);

// Who is signed in: anna (1) and boris (2) of test-helpers.
const ANNA = 1;
const BORIS = 2;

// The data of design/preview/Saeckel.html for anna: four pouches, one in debt, two in the
// storeroom, «Казна» 18 320,00.
async function prototypeBudget() {
  const ids: Record<string, number> = {};
  for (const [name, icon] of [
    ['Продукты', 'basket'],
    ['Квартира', 'hearth'],
    ['Транспорт', 'cart'],
    ['Отпуск', 'bag'],
  ] as const) {
    ids[name] = await addPouch(ANNA, name);
    await pool.query('UPDATE pouches SET icon = $1 WHERE id = $2', [icon, ids[name]]);
  }
  await addPouch(ANNA, 'Подарки', true);
  await addPouch(ANNA, 'Ремонт', true);
  await addOperation(ANNA, 'income', 7_955_030, {}, '2026-09-30', 'зарплата');
  await addOperation(ANNA, 'assign', 1_369_030, { to: ids['Продукты'] }, '2026-10-01');
  await addOperation(ANNA, 'expense', 124_000, { from: ids['Продукты'] }, '2026-10-05', 'овощи');
  await addOperation(ANNA, 'assign', 4_300_000, { to: ids['Квартира'] }, '2026-10-01');
  await addOperation(ANNA, 'expense', 1_800_000, { from: ids['Квартира'] }, '2026-10-02');
  await addOperation(ANNA, 'assign', 54_000, { to: ids['Транспорт'] }, '2026-10-01');
  await addOperation(ANNA, 'expense', 130_000, { from: ids['Транспорт'] }, '2026-10-04');
  await addOperation(ANNA, 'assign', 400_000, { to: ids['Отпуск'] }, '2026-10-01');
  return ids;
}

// Every page of Säckel in the states drawn so far, as [name, status, page]: Мешки with pouches,
// with every sign and an unknown one, empty, empty beside the storeroom, below zero; and the
// other pages in the shell — a pouch, one in the storeroom, the forms with and without an error,
// «Летопись» empty and with records, a record to change and one to read.
async function drawnPages(): Promise<[string, number, string][]> {
  const pages: [string, number, string][] = [];
  const add = async (name: string, res: Response | Promise<Response>) => {
    const answer = await res;
    pages.push([name, answer.status, await answer.text()]);
  };
  await add('Мешки, nothing at all', get('/saeckel/', 'anna'));
  await add('Летопись, empty', get('/saeckel/history', 'anna'));
  await addPouch(ANNA, 'В кладовой', true);
  await add('Мешки, only the storeroom', get('/saeckel/', 'anna'));
  await pool.query('TRUNCATE operations, pouches RESTART IDENTITY');

  const ids = await prototypeBudget();
  const food = ids['Продукты']!;
  await add('Мешки', get('/saeckel/', 'anna'));
  await add('a pouch', get(`/saeckel/pouches/${food}?fresh=2`, 'anna'));
  await add('a refused expense', post(`/saeckel/pouches/${food}/expense`, { amount: '0' }, 'anna'));
  await add('a pouch in the storeroom', get('/saeckel/pouches/5', 'anna'));
  await add('a new pouch', get('/saeckel/pouches/new', 'anna'));
  await add('a refused new pouch', post('/saeckel/pouches/new', { name: '' }, 'anna'));
  await add('a refused sign', post('/saeckel/pouches/new', { name: 'x', icon: 'dragon' }, 'anna'));
  await add('Изменить', get(`/saeckel/pouches/${food}/edit`, 'anna'));
  await add(
    'a refused name',
    post(`/saeckel/pouches/${food}/edit`, { name: '', icon: 'pouch' }, 'anna'),
  );
  await add('a refused archiving', post(`/saeckel/pouches/${food}/archive`, {}, 'anna'));
  await add('Доход', get('/saeckel/income', 'anna'));
  await add('a refused income', post('/saeckel/income', { amount: 'x', date: 'x' }, 'anna'));
  await add('Разложить', get('/saeckel/assign?income=1', 'anna'));
  await add('a refused laying out', post('/saeckel/assign', { [`amount_${food}`]: 'x' }, 'anna'));
  await add('Переложить', get(`/saeckel/transfer?to=${ids['Транспорт']}`, 'anna'));
  await add('a refused transfer', post('/saeckel/transfer', { from: '', to: '' }, 'anna'));
  const stored = await addOperation(ANNA, 'assign', 100, { to: 5 });
  await add('Летопись', get('/saeckel/history', 'anna'));
  await add('a record', get('/saeckel/operations/3', 'anna'));
  await add('a record of the storeroom', get(`/saeckel/operations/${stored}`, 'anna'));

  // Every sign, an unknown one, the treasury below zero and a long sum.
  await pool.query('TRUNCATE operations, pouches RESTART IDENTITY');
  for (const [key] of SIGN_FILES) {
    const id = await addPouch(ANNA, `Знак ${key}`);
    await pool.query('UPDATE pouches SET icon = $1 WHERE id = $2', [key, id]);
  }
  const unknown = await addPouch(ANNA, 'Знак неизвестный');
  await pool.query("UPDATE pouches SET icon = 'dragon' WHERE id = $1", [unknown]);
  await addOperation(ANNA, 'assign', 100_000_000_000, { to: unknown });
  await add('Мешки, every sign, below zero', get('/saeckel/', 'anna'));
  return pages;
}

// The picture of each sign, copied from design/preview/PouchEditMobile.html on purpose: the test
// must not share the set with the code.
const SIGN_FILES: [string, string][] = [
  ['pouch', 'emblem-saeckel-small'],
  ['cart', 'icon-cart'],
  ['basket', 'icon-basket'],
  ['hearth', 'icon-hearth'],
  ['jug', 'icon-jug'],
  ['mortar', 'icon-mortar'],
  ['needle', 'icon-needle'],
  ['lute', 'icon-lute'],
  ['bundle', 'icon-bundle'],
  ['scroll', 'icon-scroll'],
  ['pot', 'icon-pot'],
  ['toyhorse', 'icon-toyhorse'],
  ['bowl', 'icon-bowl'],
  ['hammer', 'icon-hammer'],
  ['books', 'icon-books'],
  ['bag', 'icon-bag'],
  ['comb', 'icon-comb'],
];

describe('the pages of Säckel', () => {
  test('one h1, no style attribute, script or other site; unique ids; every file is its own', async () => {
    for (const [name, status, page] of await drawnPages()) {
      assert.ok(status === 200 || status === 400, `${name}: ${status}`);
      assert.equal((page.match(/<h1[\s>]/g) ?? []).length, 1, name);
      assert.doesNotMatch(page, /\sstyle=/, name);
      assert.ok(!page.includes('<script'), name);
      assert.doesNotMatch(page, /https?:\/\//, name);
      // Every id once; every aria-describedby names one of them.
      const ids = [...page.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1]!);
      assert.deepEqual(ids, [...new Set(ids)], name);
      for (const [, described] of page.matchAll(/aria-describedby="([^"]*)"/g)) {
        for (const id of described!.split(/\s+/)) assert.ok(ids.includes(id), `${name}: ${id}`);
      }
      // Files only of the static folder of Säckel, never of Core's.
      for (const address of pageFiles(page)) {
        assert.match(address, /^\/saeckel\/static\//, `${name}: ${address}`);
        assert.equal(await served(address), 200, `${name}: ${address}`);
      }
      // Links and forms only within Säckel, and the way to the courtyard.
      for (const address of pageLinks(page)) {
        assert.match(address, /^(\/saeckel\/(?![/\\])|\/$)/, `${name}: ${address}`);
      }
      // Pictures are decorative and say nothing of the budget: an empty alt, but the scene.
      for (const [, alt] of page.matchAll(/\salt="([^"]*)"/g)) {
        assert.ok(
          alt === '' || alt === 'Казначейская: стол с весами, монетами, книгой, мешками и сундуком',
          `${name}: ${alt}`,
        );
      }
    }
  });

  test('saeckel.css: nothing from another site; every url() is a file of Säckel', async () => {
    assert.doesNotMatch(CSS, /https?:\/\/|@import/);
    assert.ok(cssFiles.length > 0);
    for (const address of cssFiles) {
      assert.match(address, /^\/saeckel\/static\//, address);
      assert.equal(await served(address), 200, address);
    }
    assert.equal(await served('/saeckel/static/saeckel.css'), 200);
  });

  test('the font: every face has its range; ₽ is drawn by latin-ext, upright and italic', () => {
    const faces = [...CSS.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, face]) => ({
      style: /font-style:\s*(\w+)/.exec(face!)?.[1],
      file: /url\(fonts\/([^)]*)\)/.exec(face!)?.[1],
      range: /unicode-range:([^;]*);/.exec(face!)?.[1],
    }));
    assert.equal(faces.length, 6);
    // Whether a code point is in a unicode-range such as «U+0000-00FF, U+2116».
    const covers = (range: string, point: number) =>
      range.split(',').some((part) => {
        const [from, to] = part.trim().replace('U+', '').split('-');
        return point >= parseInt(from!, 16) && point <= parseInt(to ?? from!, 16);
      });
    for (const face of faces) {
      assert.ok(face.range !== undefined, face.file);
      assert.ok(readdirSync(join(STATIC, 'fonts')).includes(face.file!), face.file);
    }
    const rouble = faces.filter((face) => covers(face.range!, 0x20bd));
    assert.deepEqual(rouble.map((face) => [face.style, face.file]).sort(), [
      ['italic', 'eb-garamond-italic-latin-ext.woff2'],
      ['normal', 'eb-garamond-latin-ext.woff2'],
    ]);
    // Cyrillic, U+2212 and the spaces Intl puts into amounts are covered upright and italic.
    for (const point of [0x0451, 0x2212, 0x00a0, 0x202f, 0x00e4]) {
      for (const style of ['normal', 'italic']) {
        const face = faces.find((one) => one.style === style && covers(one.range!, point));
        assert.ok(face !== undefined, `${point.toString(16)} ${style}`);
      }
    }
  });

  test('every file of the static folder is served and named, the font licence aside', async () => {
    const named = new Set([
      '/saeckel/static/saeckel.css',
      ...cssFiles,
      ...(await drawnPages()).flatMap(([, , page]) => pageFiles(page)),
    ]);
    for (const address of folderFiles()) {
      assert.equal(await served(address), 200, address);
      if (address === '/saeckel/static/fonts/OFL.txt') continue;
      assert.ok(named.has(address), `nothing names ${address}`);
    }
  });
});

describe('the shell', () => {
  test('the tab, the way back on the band and the column of each page', async () => {
    const ids = await prototypeBudget();
    const food = ids['Продукты']!;
    for (const [path, tab, back, column] of [
      ['/saeckel/', 'Мешки', undefined, true],
      [`/saeckel/pouches/${food}`, 'Мешки', '/saeckel/ Мешки', true],
      ['/saeckel/pouches/5', 'Мешки', '/saeckel/ Мешки', true],
      ['/saeckel/pouches/new', 'Мешки', '/saeckel/ Мешки', true],
      [`/saeckel/pouches/${food}/edit`, 'Мешки', `/saeckel/pouches/${food} Продукты`, true],
      ['/saeckel/income', 'Мешки', '/saeckel/ Мешки', true],
      ['/saeckel/assign', 'Мешки', '/saeckel/ Мешки', true],
      ['/saeckel/transfer', 'Мешки', '/saeckel/ Мешки', true],
      ['/saeckel/history', 'Летопись', undefined, false],
      ['/saeckel/operations/2', 'Летопись', '/saeckel/history Летопись', false],
    ] as const) {
      const page = await (await get(path, 'anna')).text();
      assert.equal(currentTab(page), tab, path);
      assert.equal(wayBack(page), back, path);
      assert.equal(page.includes('class="sk-list"'), column, path);
      // «Двор» leads to the courtyard on every page; the ribbon is the h1 of the tabs only.
      assert.match(page, /<a class="sk-gate sk-court" href="\/"/, path);
      const ribbon = back === undefined ? 'h1' : 'p';
      assert.ok(page.includes(`<${ribbon} class="ribbon ribbon-md"><span>Säckel</span>`), path);
    }
  });
});

describe('the column of pouches', () => {
  // The pages of «Мешки» with the column, for one person, after a few writes of that person.
  async function columnPages(who: 'anna' | 'boris', own: number) {
    return [
      await get('/saeckel/', who),
      await get(`/saeckel/pouches/${own}`, who),
      await get('/saeckel/pouches/new', who),
      await get(`/saeckel/pouches/${own}/edit`, who),
      await get('/saeckel/income', who),
      await get('/saeckel/assign', who),
      await get('/saeckel/transfer', who),
      await post('/saeckel/income', { amount: '0' }, who),
      await post(`/saeckel/pouches/${own}/archive`, {}, who),
    ];
  }

  test('only what is this user’s: the pouches, the treasury and the storeroom', async () => {
    const hers = await addPouch(ANNA, 'Анин мешок');
    await addPouch(ANNA, 'Анина кладовая', true);
    await addOperation(ANNA, 'income', 1_111_111);
    await addOperation(ANNA, 'assign', 22_222, { to: hers });
    const his = await addPouch(BORIS, 'Борин мешок');
    await addPouch(BORIS, 'Борина кладовая', true);
    await addOperation(BORIS, 'income', 9_999_999);
    await addOperation(BORIS, 'assign', 88_888, { to: his });
    for (const [who, own, mine, theirs] of [
      ['anna', hers, ['Анин мешок', 'Анина кладовая', '10 888,89 ₽', '222,22 ₽'], 'Бор'],
      ['boris', his, ['Борин мешок', 'Борина кладовая', '99 111,11 ₽', '888,88 ₽'], 'Ан'],
    ] as const) {
      for (const res of await columnPages(who, own)) {
        // Money on the page is spaced with U+00A0: compared with whitespace folded.
        const page = fold(await res.text());
        for (const text of mine) assert.ok(page.includes(text), `${who} ${res.url}: ${text}`);
        assert.ok(!page.includes(theirs), `${who} ${res.url}`);
        assert.ok(!page.includes(who === 'anna' ? '99 111,11' : '10 888,89'), who);
      }
    }
  });

  test('a fixed number of statements, whatever the number of pouches', async (t: TestContext) => {
    const query = t.mock.method(pool, 'query');
    // The statements of one request, and how many of them read the list of pouches.
    const count = async (path: string) => {
      query.mock.resetCalls();
      assert.equal((await get(path, 'anna')).status, 200, path);
      const statements = query.mock.calls.map((call) => String(call.arguments[0]));
      return [statements.length, statements.filter((sql) => sql.includes('LATERAL')).length];
    };
    const paths = (first: number) => [
      '/saeckel/',
      `/saeckel/pouches/${first}`,
      `/saeckel/pouches/${first}/edit`,
      '/saeckel/pouches/new',
      '/saeckel/income',
      '/saeckel/assign',
      '/saeckel/transfer',
    ];
    const first = await addPouch(ANNA, 'Мешок 1');
    await addPouch(ANNA, 'Мешок 2');
    await addPouch(ANNA, 'Мешок 3', true);
    const few = [];
    for (const path of paths(first)) few.push(await count(path));
    for (let n = 4; n <= 30; n++) await addPouch(ANNA, `Мешок ${n}`, n % 3 === 0);
    const many = [];
    for (const path of paths(first)) many.push(await count(path));
    assert.deepEqual(many, few);
    // The list of pouches with their balances is read once per request, also where the page
    // itself needs it (Разложить, Переложить).
    assert.deepEqual(
      few.map(([, lists]) => lists),
      [1, 1, 1, 1, 1, 1, 1],
    );
    // Мешки: the list, the treasury, the storeroom, and nothing else.
    assert.equal(few[0]![0], 3);
  });

  test('read outside a transaction: after the ROLLBACK of a refusal under a lock', async (t: TestContext) => {
    // What runs inside transactions, from BEGIN to COMMIT or ROLLBACK, in order. A client goes back
    // to the pool and may serve pool.query later: that is not recorded. The clients go back as
    // they were after the test.
    const run: string[] = [];
    let inside = false;
    const clients: PoolClient[] = [];
    const connect = pool.connect.bind(pool) as (callback?: unknown) => Promise<PoolClient>;
    t.mock.method(pool, 'connect', async (callback?: unknown) => {
      // pool.query takes its client by a callback: a single statement, not a transaction.
      if (callback !== undefined) return connect(callback);
      const client = await connect();
      // The pool hands the same client out again: it is wrapped once.
      if (!Object.hasOwn(client, 'query')) {
        const original = client.query.bind(client);
        clients.push(client);
        Object.assign(client, {
          query: (...args: Parameters<PoolClient['query']>) => {
            const sql = String(args[0]);
            if (sql === 'BEGIN') inside = true;
            if (inside) run.push(sql);
            if (sql === 'COMMIT' || sql === 'ROLLBACK') inside = false;
            return (original as (...rest: unknown[]) => unknown)(...args);
          },
        });
      }
      return client;
    });
    t.after(() => clients.forEach((client) => delete (client as { query?: unknown }).query));

    const food = await addPouch(ANNA, 'Продукты');
    const old = await addPouch(ANNA, 'Старый', true);
    await addOperation(ANNA, 'assign', 100, { to: food });
    for (const res of [
      // Laying out into a pouch of the storeroom, a transfer into the same pouch, the storeroom
      // for a pouch that is not empty: refused under the lock, then the page with its column.
      await post('/saeckel/assign', { [`amount_${old}`]: '1' }, 'anna'),
      await post(
        '/saeckel/transfer',
        { from: String(food), to: String(food), amount: '1', date: '05.10.2026' },
        'anna',
      ),
      await post(`/saeckel/pouches/${food}/archive`, {}, 'anna'),
    ]) {
      assert.equal(res.status, 400);
      const page = await res.text();
      assert.equal(treasurySum(page), '−1,00 ₽');
      assert.deepEqual(pouchLines(page), [
        `<a href="/saeckel/pouches/${food}">Продукты</a> · 1,00 ₽ · трат пока не было`,
      ]);
    }
    // Inside the transactions: BEGIN, the locks, the balance under the lock, ROLLBACK; never a
    // statement of the column.
    assert.ok(run.length > 0);
    for (const sql of run) {
      assert.doesNotMatch(
        sql,
        /LATERAL|kind IN \('income', 'assign'\)|AND is_archived ORDER BY/,
        sql,
      );
    }
    assert.equal(run.filter((sql) => sql === 'ROLLBACK').length, 3);
  });
});

describe('the signs, the money and the storeroom of the column', () => {
  test('each sign of the set its picture; an unknown key the default one', async () => {
    for (const [key] of SIGN_FILES) {
      const id = await addPouch(ANNA, key);
      await pool.query('UPDATE pouches SET icon = $1 WHERE id = $2', [key, id]);
    }
    const unknown = await addPouch(ANNA, 'неизвестный');
    await pool.query("UPDATE pouches SET icon = '../saeckel.css' WHERE id = $1", [unknown]);
    const page = await (await get('/saeckel/', 'anna')).text();
    const pictures = [...page.matchAll(/<a\s+class="pouch"[^>]*>\s*<img\s+src="([^"]*)"/g)].map(
      (match) => match[1]!,
    );
    assert.deepEqual(pictures, [
      ...SIGN_FILES.map(([, file]) => `/saeckel/static/img/${file}.webp`),
      '/saeckel/static/img/emblem-saeckel-small.webp',
    ]);
    // The default sign has its sharper copy for dense screens.
    assert.ok(
      page.includes('srcset="/saeckel/static/img/emblem-saeckel-small@2x.webp 2x"'),
      'the default sign at 2x',
    );
  });

  test('a name is escaped in the column and the storeroom, and is never in an alt', async () => {
    await addPouch(ANNA, '<b>Пир</b> & "Co"');
    await addPouch(ANNA, '<i>Склад</i>', true);
    const page = await (await get('/saeckel/', 'anna')).text();
    assert.ok(page.includes('&lt;b&gt;Пир&lt;/b&gt; &amp; &quot;Co&quot;'));
    assert.ok(page.includes('&lt;i&gt;Склад&lt;/i&gt;'));
    assert.ok(!page.includes('<b>') && !page.includes('<i>'));
    assert.doesNotMatch(page, /alt="[^"]*(Пир|Склад)/);
  });

  test('the treasury at zero, above and below zero; a pouch in debt in red', async () => {
    // Money on the page is spaced with U+00A0: compared with whitespace folded.
    const page = async () => fold(await (await get('/saeckel/', 'anna')).text());
    assert.match(await page(), /<p class="money">0,00 ₽<\/p>/);
    const food = await addPouch(ANNA, 'Продукты');
    await addOperation(ANNA, 'income', 1_832_000);
    assert.match(await page(), /<p class="money">18 320,00 ₽<\/p>/);
    await addOperation(ANNA, 'assign', 1_900_000, { to: food });
    await addOperation(ANNA, 'expense', 2_000_000, { from: food });
    const below = await page();
    assert.match(below, /<p class="money neg">−680,00 ₽<\/p>/);
    assert.ok(below.includes('<span class="sub neg">в долгу</span>'));
    assert.ok(below.includes('<span class="bal neg">−1 000,00 ₽</span>'));
    // A sum longer than «1 234 567,89 ₽» is set smaller.
    await addOperation(ANNA, 'income', 100_000_000_000);
    assert.match(await page(), /<p class="money long">999 999 320,00 ₽<\/p>/);
  });

  test('the storeroom: none — no block; some — «Кладовая (N)», folded, each with «Вернуть»', async () => {
    await addPouch(ANNA, 'Продукты');
    assert.ok(!(await (await get('/saeckel/', 'anna')).text()).includes('<details'));
    const old = await addPouch(ANNA, 'Старый', true);
    const page = await (await get('/saeckel/', 'anna')).text();
    assert.ok(page.includes('<details class="storeroom">'));
    assert.ok(!page.includes('<details class="storeroom" open'));
    assert.ok(page.includes('<summary>Кладовая (1)</summary>'));
    assert.ok(page.includes(`<form method="post" action="/saeckel/pouches/${old}/restore">`));
    // Beside the empty state as well, without «+ Новый мешок».
    await pool.query('UPDATE pouches SET is_archived = true');
    const empty = await (await get('/saeckel/', 'anna')).text();
    assert.ok(empty.includes('<h2 class="title">Мешков пока нет</h2>'));
    assert.ok(empty.includes('<summary>Кладовая (2)</summary>'));
    assert.ok(!empty.includes('+ Новый мешок'));
  });
});
