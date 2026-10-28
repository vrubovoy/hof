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
  assignRows,
  currentTab,
  deadPool,
  fold,
  get,
  mainPart,
  pool,
  post,
  operations,
  pouchLines,
  pouches,
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
// The scripts of the effects of Hof that every page names (§2, §6).
const FX_SCRIPTS = [
  '<script src="/static/fx-head.js"></script>',
  '<script type="module" src="/static/fx.js"></script>',
];

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

// `count` incomes of anna on one day, of 0,01, 0,02 … in the order of their ids.
async function addIncomes(count: number): Promise<void> {
  await pool.query(
    `INSERT INTO operations (user_id, kind, amount, currency, date)
     SELECT $1, 'income', n, 'RUB', '2026-10-06' FROM generate_series(1, $2) n`,
    [ANNA, count],
  );
}

// Every page of Säckel in every state, as [name, status, page]: Мешки with pouches, with every
// sign and an unknown one, empty, empty beside the storeroom, below zero; «Доход», «Разложить»
// and «Переложить» without pouches, with them, with every sign and the treasury below zero,
// filled in to cover a debt, refused field by field, row by row and as a whole; a pouch, one in
// the storeroom, the forms of a pouch with and without an error; «Летопись» empty, with records,
// by a pouch — active, in the storeroom, without records — past the last page and three pages of
// 120; a record of each kind to change, refused, and one of the storeroom to read, also when a
// change or a deletion is sent anyway.
async function drawnPages(): Promise<[string, number, string][]> {
  const pages: [string, number, string][] = [];
  const add = async (name: string, res: Response | Promise<Response>) => {
    const answer = await res;
    pages.push([name, answer.status, await answer.text()]);
  };
  await add('Мешки, nothing at all', get('/saeckel/', 'anna'));
  await add('Летопись, empty', get('/saeckel/history', 'anna'));
  await add('Разложить, no pouch', get('/saeckel/assign', 'anna'));
  await add('Переложить, no pouch', get('/saeckel/transfer', 'anna'));
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
  await add(
    'a refused sign of Изменить',
    post(`/saeckel/pouches/${food}/edit`, { name: 'Продукты', icon: 'dragon' }, 'anna'),
  );
  await add('a pouch in debt', get(`/saeckel/pouches/${ids['Транспорт']}`, 'anna'));
  await add(
    'a refused expense of every field',
    post(`/saeckel/pouches/${food}/expense`, { amount: 'x', date: 'x', note: 'a\u0001b' }, 'anna'),
  );
  // «Вернуть» refused: an active pouch has the name of the one in the storeroom.
  await addPouch(ANNA, 'подарки');
  await add('a refused return', post('/saeckel/pouches/5/restore', {}, 'anna'));
  await add('Доход', get('/saeckel/income', 'anna'));
  await add('a refused income', post('/saeckel/income', { amount: 'x', date: 'x' }, 'anna'));
  await add(
    'a refused income of every field',
    post('/saeckel/income', { amount: '0', date: 'вчера', note: 'a\u0001b' }, 'anna'),
  );
  await add('Разложить', get('/saeckel/assign?income=1', 'anna'));
  await add('a refused laying out', post('/saeckel/assign', { [`amount_${food}`]: 'x' }, 'anna'));
  await add(
    'a refused row of each pouch',
    post(
      '/saeckel/assign',
      { amount_1: 'x', amount_2: '0', amount_3: '-1', amount_4: '1,2,3' },
      'anna',
    ),
  );
  await add('a refused laying out as a whole', post('/saeckel/assign', {}, 'anna'));
  await add('Переложить', get(`/saeckel/transfer?to=${ids['Транспорт']}`, 'anna'));
  await add(
    'Переложить to cover a debt',
    get(`/saeckel/transfer?to=${ids['Транспорт']}&amount=760,00`, 'anna'),
  );
  await add('a refused transfer', post('/saeckel/transfer', { from: '', to: '' }, 'anna'));
  await add(
    'a refused transfer of every field',
    post(
      '/saeckel/transfer',
      { from: '', to: '', amount: '', date: 'x', note: 'a\u0001b' },
      'anna',
    ),
  );
  const stored = await addOperation(ANNA, 'assign', 100, { to: 5 });
  const moved = await addOperation(
    ANNA,
    'transfer',
    76_000,
    { from: ids['Отпуск'], to: ids['Транспорт'] },
    '2026-10-04',
  );
  await add('Летопись', get('/saeckel/history', 'anna'));
  await add('Летопись of a pouch', get(`/saeckel/history?pouch=${food}`, 'anna'));
  await add('Летопись of a pouch in the storeroom', get('/saeckel/history?pouch=5', 'anna'));
  await add('Летопись of a pouch without records', get('/saeckel/history?pouch=6', 'anna'));
  await add('Летопись past the last page', get('/saeckel/history?page=2', 'anna'));
  await add('a record: an income', get('/saeckel/operations/1', 'anna'));
  await add('a record: laid out', get('/saeckel/operations/2', 'anna'));
  await add('a record', get('/saeckel/operations/3', 'anna'));
  await add('a record: a transfer', get(`/saeckel/operations/${moved}`, 'anna'));
  await add(
    'a refused record of every field',
    post('/saeckel/operations/3', { from: '', amount: 'x', date: 'x', note: 'a\u0001b' }, 'anna'),
  );
  await add(
    'a refused transfer of one pouch',
    post(`/saeckel/operations/${moved}`, { from: '1', to: '1', amount: '1' }, 'anna'),
  );
  await add('a record of the storeroom', get(`/saeckel/operations/${stored}`, 'anna'));
  await add(
    'a refused change of the storeroom',
    post(`/saeckel/operations/${stored}`, { amount: '1' }, 'anna'),
  );
  await add(
    'a refused deletion of the storeroom',
    post(`/saeckel/operations/${stored}/delete`, {}, 'anna'),
  );

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
  await add('Разложить, every sign, below zero', get('/saeckel/assign', 'anna'));
  await add('Переложить, every sign', get('/saeckel/transfer', 'anna'));
  // 120 records more: three pages of «Летопись».
  await addIncomes(120);
  for (const page of [1, 2, 3]) {
    await add(`Летопись, page ${page} of 3`, get(`/saeckel/history?page=${page}`, 'anna'));
  }
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
      // The two scripts of the effects of Hof in <head>, the only addresses of Core (§2, §6); no
      // other script, no inline code, no handler attribute.
      const scripts = [...page.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0]);
      assert.deepEqual(scripts, FX_SCRIPTS, name);
      assert.equal((page.match(/<script/g) ?? []).length, 2, name);
      assert.ok(page.indexOf('<script type="module"') < page.indexOf('</head>'), name);
      assert.doesNotMatch(page, /\son[a-z]+=/i, name);
      assert.doesNotMatch(page, /https?:\/\//, name);
      // Every id once; every aria-describedby names one of them.
      const ids = [...page.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1]!);
      assert.deepEqual(ids, [...new Set(ids)], name);
      for (const [, described] of page.matchAll(/aria-describedby="([^"]*)"/g)) {
        for (const id of described!.split(/\s+/)) assert.ok(ids.includes(id), `${name}: ${id}`);
      }
      // Files only of the static folder of Säckel, never of Core's, but for the scripts above.
      const own = FX_SCRIPTS.reduce((rest, script) => rest.replace(script, ''), page);
      for (const address of pageFiles(own)) {
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

// M10.2: with «Анимации» the book of Säckel turns a page (data-fx, read by fx.js of Hof). Links
// stay <a href>, forms <form method="post">; Säckel has no banner, so nothing keeps it.
describe('the ways between pages', () => {
  // The effects of a link fx.js of Hof knows that Säckel uses (LINK_FX in src/core/static/fx.js;
  // Säckel does not import Core, §2).
  const LINK_FX = ['flip-fwd', 'flip-back', 'flip-fwd-phone', 'page'];
  // Each way of a piece of a page as "address fx", the links only: a form of Säckel has no act.
  function ways(piece: string): string[] {
    return [...piece.matchAll(/<a\s([^>]*)>/g)].flatMap(([, attributes]) => {
      const fx = /data-fx="([^"]*)"/.exec(attributes!)?.[1];
      return fx === undefined ? [] : [`${/href="([^"]*)"/.exec(attributes!)?.[1]} ${fx}`];
    });
  }
  const head = (page: string) => ways(/<header class="sk-head">[\s\S]*?<\/header>/.exec(page)![0]);
  const tabs = (page: string) => ways(/<nav class="tabs"[\s\S]*?<\/nav>/.exec(page)![0]);
  // Everything under the ribbon and the tabs: the column and the page.
  const below = (page: string) => ways(page.slice(page.indexOf('class="caps sk-motto"')));

  async function bookPages() {
    const ids = await prototypeBudget();
    await addIncomes(60);
    const food = ids['Продукты']!;
    const paths = [
      '/saeckel/',
      `/saeckel/pouches/${food}`,
      '/saeckel/pouches/new',
      `/saeckel/pouches/${food}/edit`,
      '/saeckel/income',
      '/saeckel/assign',
      '/saeckel/transfer',
      '/saeckel/history',
      '/saeckel/history?page=2',
      '/saeckel/operations/2',
    ];
    const pages = new Map<string, string>();
    for (const path of paths) pages.set(path, await (await get(path, 'anna')).text());
    return { ids, pages };
  }

  test('every data-fx is one fx.js knows; none on the current tab or pouch; no data-keep, no act of a form', async () => {
    const { pages } = await bookPages();
    for (const [path, page] of pages) {
      for (const [, tag, attributes] of page.matchAll(/<(a|form)\s([^>]*)>/g)) {
        const fx = /data-fx="([^"]*)"/.exec(attributes!)?.[1];
        assert.doesNotMatch(attributes!, /data-keep/, path);
        if (tag === 'form') assert.equal(fx, undefined, path);
        else if (/aria-current/.test(attributes!)) assert.equal(fx, undefined, path);
        else if (fx !== undefined) assert.ok(LINK_FX.includes(fx), `${path}: ${fx}`);
      }
    }
  });

  test('Двор and «назад» turn back; a tab by the order of the tabs; deeper into Мешки forward on the phone; Летопись rustles', async () => {
    const { ids, pages } = await bookPages();
    const food = ids['Продукты']!;
    const pouches = Object.values(ids).map((id) => `/saeckel/pouches/${id} flip-fwd-phone`);
    const actions = ['/saeckel/assign flip-fwd-phone', '/saeckel/income flip-fwd-phone'];
    const of = (path: string) => pages.get(path)!;

    assert.deepEqual(head(of('/saeckel/')), ['/ flip-back']);
    assert.deepEqual(tabs(of('/saeckel/')), ['/saeckel/history flip-fwd']);
    // The column, then the first pouch open on the right of a computer: «Изменить» there too.
    assert.deepEqual(below(of('/saeckel/')), [
      ...actions,
      ...pouches,
      `/saeckel/pouches/${food}/edit flip-fwd-phone`,
    ]);

    const pouch = of(`/saeckel/pouches/${food}`);
    assert.deepEqual(head(pouch), ['/ flip-back', '/saeckel/ flip-back']);
    assert.deepEqual(tabs(pouch), ['/saeckel/history flip-fwd']);
    // The pouch itself is the current one in the column: an ordinary link.
    assert.ok(!ways(pouch).includes(`/saeckel/pouches/${food} flip-fwd-phone`));
    assert.ok(ways(pouch).includes(`/saeckel/pouches/${food}/edit flip-fwd-phone`));
    assert.deepEqual(head(of(`/saeckel/pouches/${food}/edit`)), [
      '/ flip-back',
      `/saeckel/pouches/${food} flip-back`,
    ]);
    for (const path of [
      '/saeckel/pouches/new',
      '/saeckel/income',
      '/saeckel/assign',
      '/saeckel/transfer',
    ]) {
      assert.deepEqual(head(of(path)), ['/ flip-back', '/saeckel/ flip-back'], path);
      assert.deepEqual(tabs(of(path)), ['/saeckel/history flip-fwd'], path);
    }

    for (const path of ['/saeckel/history', '/saeckel/history?page=2']) {
      assert.deepEqual(head(of(path)), ['/ flip-back'], path);
      assert.deepEqual(tabs(of(path)), ['/saeckel/ flip-back'], path);
    }
    assert.deepEqual(below(of('/saeckel/history')), ['/saeckel/history?page=2 page']);
    assert.deepEqual(below(of('/saeckel/history?page=2')), ['/saeckel/history?page=1 page']);
    assert.deepEqual(head(of('/saeckel/operations/2')), [
      '/ flip-back',
      '/saeckel/history flip-back',
    ]);
    assert.deepEqual(tabs(of('/saeckel/operations/2')), ['/saeckel/ flip-back']);
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
    // Мешки: the list, the treasury, the storeroom and the movements of the first pouch, and
    // nothing else: its balance is the one of the list.
    assert.equal(few[0]![0], 4);
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

// The pouch open on the right of Мешки: its name, the address its form of an expense is sent to,
// and the row of the column marked as open; nothing of it without a pouch.
function openPouch(page: string) {
  const pane = page.split('<div class="sk-main sk-first">')[1] ?? '';
  return {
    name: /<h2 class="title t-1">([^<]*)<\/h2>/.exec(pane)?.[1],
    action: /<form class="expense" method="post" action="([^"]*)">/.exec(pane)?.[1],
    row: /<a\s+class="pouch open"\s+href="([^"]*)"/.exec(page)?.[1],
  };
}

describe('the first pouch on Мешки', () => {
  test('the active pouch of this user with the smallest id, and the same every time', async () => {
    const theirs = await addPouch(BORIS, 'Чужой');
    const stored = await addPouch(ANNA, 'В кладовой', true);
    const first = await addPouch(ANNA, 'Первый');
    const second = await addPouch(ANNA, 'Второй');
    assert.ok(theirs < stored && stored < first && first < second);
    const expected = {
      name: 'Первый',
      action: `/saeckel/pouches/${first}/expense`,
      row: `/saeckel/pouches/${first}`,
    };
    for (let n = 0; n < 3; n++) {
      assert.deepEqual(openPouch(await (await get('/saeckel/', 'anna')).text()), expected);
    }
    // Neither a new name nor money moves the choice; the open row is not «the current page».
    await pool.query("UPDATE pouches SET name = 'Яяя' WHERE id = $1", [first]);
    await addOperation(ANNA, 'assign', 500, { to: second });
    await addOperation(ANNA, 'expense', 900, { from: first });
    const page = await (await get('/saeckel/', 'anna')).text();
    assert.deepEqual(openPouch(page), { ...expected, name: 'Яяя' });
    assert.ok(!page.includes('aria-current="page" >'));
    assert.doesNotMatch(page, /class="pouch open"[^>]*aria-current/);
    // Boris has his own first pouch.
    const his = openPouch(await (await get('/saeckel/', 'boris')).text());
    assert.equal(his.row, `/saeckel/pouches/${theirs}`);
  });

  test('the first goes into the storeroom: the next one opens; none left: the empty state', async () => {
    const first = await addPouch(ANNA, 'Первый');
    const second = await addPouch(ANNA, 'Второй');
    assert.equal((await post(`/saeckel/pouches/${first}/archive`, {}, 'anna')).status, 303);
    assert.equal(
      openPouch(await (await get('/saeckel/', 'anna')).text()).row,
      `/saeckel/pouches/${second}`,
    );
    assert.equal((await post(`/saeckel/pouches/${second}/archive`, {}, 'anna')).status, 303);
    const empty = await (await get('/saeckel/', 'anna')).text();
    assert.deepEqual(openPouch(empty), { name: undefined, action: undefined, row: undefined });
    assert.ok(empty.includes('<h2 class="title">Мешков пока нет</h2>'));
  });

  test('its expense is the expense of the pouch page: the same form, 303 with fresh, the same row', async () => {
    const food = await addPouch(ANNA, 'Продукты');
    const fields = { amount: '1 240,50', date: '05.10.2026', note: 'овощи' };
    const fromList = openPouch(await (await get('/saeckel/', 'anna')).text()).action!;
    const ownPage = await (await get(`/saeckel/pouches/${food}`, 'anna')).text();
    assert.ok(ownPage.includes(`<form class="expense" method="post" action="${fromList}">`));
    const written = [];
    for (let n = 0; n < 2; n++) {
      const res = await post(fromList, fields, 'anna');
      assert.equal(res.status, 303);
      const [last] = (await operations()).slice(-1);
      const { id, ...record } = last!;
      assert.equal(res.headers.get('location'), `/saeckel/pouches/${food}?fresh=${id}`);
      written.push(record);
    }
    assert.deepEqual(written[0], written[1]);
    assert.deepEqual(written[0], {
      user_id: ANNA,
      kind: 'expense',
      amount: '124050',
      currency: 'RUB',
      from_pouch_id: food,
      to_pouch_id: null,
      date: '2026-10-05',
      note: 'овощи',
    });
  });

  test('GET /saeckel/ writes nothing', async (t: TestContext) => {
    const food = await addPouch(ANNA, 'Продукты');
    await addPouch(ANNA, 'Старый', true);
    await addOperation(ANNA, 'income', 10_000);
    await addOperation(ANNA, 'assign', 5_000, { to: food });
    const before = [await pouches(), await operations()];
    const query = t.mock.method(pool, 'query');
    for (let n = 0; n < 3; n++) assert.equal((await get('/saeckel/', 'anna')).status, 200);
    for (const call of query.mock.calls) {
      assert.match(String(call.arguments[0]).trim(), /^SELECT/, String(call.arguments[0]));
    }
    query.mock.restore();
    assert.deepEqual([await pouches(), await operations()], before);
  });
});

describe('the page of a pouch', () => {
  test('in debt: red, and «Покрыть…»; not in debt: neither', async () => {
    const cart = await addPouch(ANNA, 'Транспорт');
    const page = async () => fold(await (await get(`/saeckel/pouches/${cart}`, 'anna')).text());
    assert.match(await page(), /<span class="money">0,00 ₽<\/span>/);
    assert.ok(!(await page()).includes('Покрыть'));
    await addOperation(ANNA, 'expense', 76_000, { from: cart });
    const debt = await page();
    assert.match(debt, /<span class="money neg">−760,00 ₽<\/span>/);
    assert.ok(debt.includes('Покрыть из другого мешка'));
  });

  test('errors of the expense: each field drawn red, described by its error, one aria-invalid each', async () => {
    const food = await addPouch(ANNA, 'Продукты');
    for (const [fields, wrong] of [
      [{ amount: '0', date: '05.10.2026', note: '' }, ['amount']],
      [{ amount: '1', date: 'вчера', note: 'a\u0001b' }, ['date', 'note']],
      [{ amount: 'x', date: 'x', note: 'a\u0001b' }, ['amount', 'date', 'note']],
    ] as const) {
      const res = await post(`/saeckel/pouches/${food}/expense`, fields, 'anna');
      assert.equal(res.status, 400);
      const page = await res.text();
      assert.equal((page.match(/aria-invalid="true"/g) ?? []).length, wrong.length);
      for (const field of wrong) {
        assert.match(page, new RegExp(`<div class="field field-${field} err">`), field);
        assert.match(page, new RegExp(`aria-describedby="${field}-error"`), field);
        assert.match(page, new RegExp(`<p id="${field}-error" class="err-text">`), field);
      }
    }
    assert.deepEqual(await operations(), []);
  });

  test('Изменить: the 17 signs as pictures with their words, the current one chosen', async () => {
    const food = await addPouch(ANNA, 'Продукты');
    await pool.query("UPDATE pouches SET icon = 'cart' WHERE id = $1", [food]);
    const page = fold(await (await get(`/saeckel/pouches/${food}/edit`, 'anna')).text());
    const offered = [
      ...page.matchAll(
        /<label class="icon-pick"> <input type="radio" name="icon" value="([^"]*)" ?(checked)? \/> <img src="([^"]*)"[^>]*alt="" \/> ([^<]*) <\/label>/g,
      ),
    ].map(([, key, checked, src]) => [key, checked !== undefined, src]);
    assert.deepEqual(
      offered,
      SIGN_FILES.map(([key, file]) => [key, key === 'cart', `/saeckel/static/img/${file}.webp`]),
    );
    // A name refused: one field invalid, the chosen sign kept.
    const refused = await (
      await post(`/saeckel/pouches/${food}/edit`, { name: '', icon: 'lute' }, 'anna')
    ).text();
    assert.equal((refused.match(/aria-invalid="true"/g) ?? []).length, 1);
    assert.match(refused, /value="lute"\s+checked/);
  });
});

// The fields of a refused form that are drawn as wrong: each such field is red, the field itself
// is invalid and described by its error, which stands right under it in the same field; no other
// field of the page is invalid.
function assertInvalid(page: string, fields: readonly string[], name: string) {
  assert.equal((page.match(/aria-invalid="true"/g) ?? []).length, fields.length, name);
  for (const field of fields) {
    assert.match(
      page,
      new RegExp(
        `<div class="field field-${field} err">\\s*<label for="${field}">[^<]*</label>[\\s\\S]*?` +
          `\\sid="${field}"[^>]*aria-invalid="true" aria-describedby="${field}-error"[^>]*>[\\s\\S]*?` +
          `<p id="${field}-error" class="err-text">[^<]+</p>\\s*</div>`,
      ),
      `${name}: ${field}`,
    );
  }
}

describe('Доход, Разложить, Переложить', () => {
  test('Доход: each wrong field red with its error under it, what was typed kept, nothing written', async () => {
    for (const [fields, wrong] of [
      [{ amount: '0', date: '05.10.2026', note: 'зарплата' }, ['amount']],
      [{ amount: '1', date: 'вчера', note: 'a\u0001b' }, ['date', 'note']],
      [{ amount: 'x', date: '31.02.2026', note: 'a\u0001b' }, ['amount', 'date', 'note']],
    ] as const) {
      const res = await post('/saeckel/income', fields, 'anna');
      assert.equal(res.status, 400);
      const page = await res.text();
      const name = JSON.stringify(fields);
      assert.ok(page.includes('<form class="entry" method="post" action="/saeckel/income">'), name);
      assertInvalid(page, wrong, name);
      for (const value of Object.values(fields)) {
        assert.ok(page.includes(`value="${value}"`), `${name}: ${value}`);
      }
    }
    assert.deepEqual(await operations(), []);
  });

  test('Переложить: the errors of the lists under the lists, of the fields under the fields', async () => {
    const food = await addPouch(ANNA, 'Продукты');
    const empty = { amount: '760', date: '', note: '' };
    for (const [fields, wrong] of [
      [{ ...empty, from: '', to: '' }, ['from', 'to']],
      [{ ...empty, from: String(food), to: String(food) }, ['to']],
      [
        { from: '', to: '', amount: 'x', date: 'x', note: 'a\u0001b' },
        ['from', 'to', 'amount', 'date', 'note'],
      ],
    ] as const) {
      const res = await post('/saeckel/transfer', fields, 'anna');
      assert.equal(res.status, 400);
      const page = await res.text();
      assert.ok(page.includes('<span class="select">'));
      assertInvalid(page, wrong, JSON.stringify(fields));
    }
    assert.deepEqual(await operations(), []);
  });

  test('Разложить: each row its sign and name, a field named after its pouch, an error under its field', async () => {
    const ids = await prototypeBudget();
    const before = await operations();
    const cart = ids['Транспорт']!;
    const res = await post(
      '/saeckel/assign',
      { [`amount_${ids['Продукты']}`]: '100', [`amount_${cart}`]: 'x' },
      'anna',
    );
    assert.equal(res.status, 400);
    const page = await res.text();
    const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(page)![1]!;
    const rows = [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) => [
      /<img src="([^"]*)"/.exec(row!)?.[1],
      /<span class="assign-name">([^<]*)<\/span>/.exec(row!)?.[1],
      /aria-label="([^"]*)"/.exec(row!)?.[1],
      /<td class="(put[^"]*)">/.exec(row!)?.[1],
      (row!.match(/aria-invalid="true"/g) ?? []).length,
    ]);
    const sign = (file: string) => `/saeckel/static/img/${file}.webp`;
    assert.deepEqual(rows, [
      [sign('icon-basket'), 'Продукты', 'Положить в мешок Продукты', 'put', 0],
      [sign('icon-hearth'), 'Квартира', 'Положить в мешок Квартира', 'put', 0],
      [sign('icon-cart'), 'Транспорт', 'Положить в мешок Транспорт', 'put err', 1],
      [sign('icon-bag'), 'Отпуск', 'Положить в мешок Отпуск', 'put', 0],
    ]);
    // The error of «Транспорт» is in its cell, right under its field, and describes it.
    assert.match(
      fold(page),
      new RegExp(
        `<td class="put err"> <input class="input slim" name="amount_${cart}"[^>]*` +
          `aria-invalid="true" aria-describedby="amount_${cart}-error" /> ` +
          `<p id="amount_${cart}-error" class="err-text">[^<]+</p> </td>`,
      ),
    );
    assert.deepEqual(
      assignRows(page).map(([, , typed]) => typed),
      ['100', '', 'x', ''],
    );
    assert.deepEqual(await operations(), before);
  });

  test('Разложить: the income in a note with the blue seal, on the phone its first sentence; a refusal with the red one', async () => {
    const food = await addPouch(ANNA, 'Продукты');
    const id = await addOperation(ANNA, 'income', 8_000_000);
    const page = fold(await (await get(`/saeckel/assign?income=${id}`, 'anna')).text());
    // The second sentence is hidden from the screen of a phone only; a screen reader reads both.
    assert.match(
      page,
      /<p class="note"> Доход 80 000,00 ₽ лёг в казну\.<span class="visually-hidden-phone"> Разложите его по мешкам или оставьте в казне на потом\.<\/span ?> <\/p>/,
    );
    assert.ok(!page.includes('note-error'));
    const refused = fold(
      await (await post('/saeckel/assign', { [`amount_${food}`]: ' ' }, 'anna')).text(),
    );
    assert.ok(
      refused.includes(
        '<p id="refusal" class="note note-error">Впишите сумму хотя бы для одного мешка.</p>',
      ),
    );
    assert.ok(!refused.includes('<p class="note">'));
  });

  test('Разложить: the treasury as the column shows it, red below zero; no pouch — the way to a new one', async () => {
    const food = await addPouch(ANNA, 'Продукты');
    await addOperation(ANNA, 'assign', 50_000, { to: food });
    const page = await (await get('/saeckel/assign', 'anna')).text();
    assert.match(
      fold(mainPart(page)),
      /В казне: <span class="money neg"\s?>−500,00 ₽<\/span\s?>\. Пустые поля пропускаются\./,
    );
    assert.equal(treasurySum(page), '−500,00 ₽');
    await pool.query('UPDATE pouches SET is_archived = true');
    const none = fold(mainPart(await (await get('/saeckel/assign', 'anna')).text()));
    assert.ok(none.includes('<h2 class="title t-3">Мешков пока нет</h2>'));
    assert.ok(none.includes('<a class="link" href="/saeckel/pouches/new">+ Новый мешок</a>'));
    assert.ok(!none.includes('<form') && !none.includes('<table'));
  });

  test('a name is escaped in the rows, in the names of their fields and in the lists', async () => {
    await addPouch(ANNA, '<b>Пир</b> & "Co"');
    const escaped = '&lt;b&gt;Пир&lt;/b&gt; &amp; &quot;Co&quot;';
    const assign = await (await get('/saeckel/assign', 'anna')).text();
    assert.ok(assign.includes(`aria-label="Положить в мешок ${escaped}"`));
    assert.ok(assign.includes(`<span class="assign-name">${escaped}</span>`));
    const transfer = fold(await (await get('/saeckel/transfer', 'anna')).text());
    assert.equal(transfer.split(`${escaped} — 0,00 ₽`).length, 3, 'once in each list');
    for (const page of [assign, transfer]) assert.ok(!page.includes('<b>'));
  });

  test('the pouches and the treasury are read once a request, also by a refusal', async (t: TestContext) => {
    const food = await addPouch(ANNA, 'Продукты');
    await addPouch(ANNA, 'Старый', true);
    const income = await addOperation(ANNA, 'income', 10_000);
    const query = t.mock.method(pool, 'query');
    const requests: [string, () => Response | Promise<Response>, number, number][] = [
      ['Доход', () => get('/saeckel/income', 'anna'), 200, 3],
      ['a refused income', () => post('/saeckel/income', { amount: '0' }, 'anna'), 400, 3],
      ['Разложить', () => get('/saeckel/assign', 'anna'), 200, 3],
      ['Разложить after an income', () => get(`/saeckel/assign?income=${income}`, 'anna'), 200, 4],
      ['a refused row', () => post('/saeckel/assign', { [`amount_${food}`]: 'x' }, 'anna'), 400, 3],
      ['Переложить', () => get(`/saeckel/transfer?to=${food}&amount=5`, 'anna'), 200, 3],
      ['a refused transfer', () => post('/saeckel/transfer', { from: '' }, 'anna'), 400, 3],
    ];
    for (const [name, request, status, count] of requests) {
      query.mock.resetCalls();
      assert.equal((await request()).status, status, name);
      const statements = query.mock.calls.map((call) => String(call.arguments[0]));
      assert.equal(statements.length, count, `${name}: ${statements.join('\n')}`);
      assert.equal(statements.filter((sql) => sql.includes('LATERAL')).length, 1, name);
      assert.equal(
        statements.filter((sql) => sql.includes("kind IN ('income', 'assign')")).length,
        1,
        name,
      );
    }
  });
});

// The rows of the table of «Летопись» as [id, row].
function historyTable(page: string) {
  const table = /<table class="table history">([\s\S]*?)<\/table>/.exec(page)?.[1] ?? '';
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(table)?.[1] ?? '';
  return { table, body, rows: [...body.matchAll(/<tr id="op-(\d+)">([\s\S]*?)<\/tr>/g)] };
}

describe('Летопись and a record', () => {
  test('the table: rows only, one link a record — named as before, described by its row — and the headers', async () => {
    const ids = await prototypeBudget();
    await addOperation(ANNA, 'transfer', 76_000, { from: ids['Отпуск'], to: ids['Транспорт'] });
    const page = await (await get('/saeckel/history', 'anna')).text();
    const { table, body, rows } = historyTable(page);
    assert.deepEqual(
      [...table.matchAll(/<th class="[^"]*">([^<]*)<\/th>/g)].map(([, text]) => text),
      ['Дата', 'Мешок', 'Запись', 'Заметка', 'Сумма', ''],
    );
    // Nothing in the body but rows, no link around a row.
    assert.equal(body.replace(/<tr id="op-\d+">[\s\S]*?<\/tr>/g, '').trim(), '');
    assert.doesNotMatch(page, /<a\s[^>]*>\s*<tr/);
    assert.equal(rows.length, 9);
    for (const [, id, row] of rows) {
      const links = [...row!.matchAll(/<a\s[^>]*>/g)].map(([link]) => fold(link));
      assert.deepEqual(
        links,
        [
          `<a class="link-plain" href="/saeckel/operations/${id}" aria-label="Открыть запись" aria-describedby="op-${id}" >`,
        ],
        id,
      );
      // The kind the phone shows after the pouches is the kind of the row; a transfer is
      // «Переложено» there (HistoryMobile).
      const kind = /<td class="h-kind">([^<]*)<\/td>/.exec(row!)![1];
      const phone = kind === 'Из мешка в мешок' ? 'Переложено' : kind;
      assert.ok(fold(row!).includes(`<span class="h-kind-phone"> · ${phone}</span>`), id);
    }
    // No link to a record anywhere else on the page.
    assert.equal((page.match(/href="\/saeckel\/operations\//g) ?? []).length, rows.length);
  });

  test('three pages of 120: «Назад» and «Следующие 50» as plaques; past the last one, a line', async () => {
    await pool.query(
      `INSERT INTO operations (user_id, kind, amount, currency, date)
       SELECT $1, 'income', n, 'RUB', '2026-10-06' FROM generate_series(1, 120) n`,
      [ANNA],
    );
    const pager = (page: string) =>
      fold(
        /<nav class="pages" aria-label="Страницы летописи">([\s\S]*?)<\/nav>/.exec(page)?.[1] ?? '',
      );
    const expected: [number, number, string[]][] = [
      [1, 50, ['Следующие 50']],
      [2, 50, ['Назад', 'Следующие 50']],
      [3, 20, ['Назад']],
      [4, 0, ['Назад']],
    ];
    for (const [number, count, links] of expected) {
      const page = await (await get(`/saeckel/history?page=${number}`, 'anna')).text();
      assert.equal(historyTable(page).rows.length, count, String(number));
      assert.deepEqual(
        [
          ...pager(page).matchAll(/<a class="btn" href="[^"]*" data-fx="page" ?>([^<]*)<\/a ?>/g),
        ].map(([, text]) => text),
        links,
        String(number),
      );
      assert.equal(
        page.includes('<p class="muted history-none">На этой странице записей нет.</p>'),
        count === 0,
        String(number),
      );
    }
  });

  test('the empty Летопись: the closed book, the sprig, «Записать доход» and «К мешкам»; no table, no filter', async () => {
    const page = fold(await (await get('/saeckel/history', 'anna')).text());
    for (const text of [
      '<img class="vignette" src="/saeckel/static/img/empty-history-closed.webp" alt="" />',
      '<h2 class="title">Летопись пока пуста</h2>',
      '<img class="sprig" src="/saeckel/static/img/sprig-divider.webp" alt="" />',
      '<a class="btn btn-ochre" href="/saeckel/income">Записать доход</a>',
      '<a class="link" href="/saeckel/">К мешкам</a>',
    ]) {
      assert.ok(page.includes(text), text);
    }
    assert.ok(!page.includes('<table') && !page.includes('<form') && !page.includes('<select'));
  });

  test('a record: the form of its kind — one list beside the amount, two above the fields, none for an income', async () => {
    const ids = await prototypeBudget();
    const moved = await addOperation(ANNA, 'transfer', 100, {
      from: ids['Отпуск'],
      to: ids['Транспорт'],
    });
    for (const [id, layout, lists] of [
      [1, /<div class="entry-row">\s*<div class="field field-amount">/, []],
      [2, /<div class="record-row">\s*<div class="field field-to">/, ['to']],
      [3, /<div class="record-row">\s*<div class="field field-from">/, ['from']],
      [moved, /<div class="pouch-pair">\s*<div class="field field-from">/, ['from', 'to']],
    ] as const) {
      const page = await (await get(`/saeckel/operations/${id}`, 'anna')).text();
      assert.match(page, layout, String(id));
      assert.deepEqual(
        [...page.matchAll(/<select id="(\w+)"/g)].map(([, list]) => list),
        lists,
        String(id),
      );
      assert.ok(page.includes('<p class="hint">Вид записи не меняется.'), String(id));
    }
  });

  test('Удалить: a form only inside <details>, posting to /delete; no form in another; «Сохранить» of the form of the record', async () => {
    await prototypeBudget();
    for (const id of [1, 3]) {
      const page = await (await get(`/saeckel/operations/${id}`, 'anna')).text();
      assert.deepEqual(
        [...page.matchAll(/<form\b[^>]*>/g)].map(([form]) => form),
        [
          `<form id="record" class="entry" method="post" action="/saeckel/operations/${id}">`,
          `<form method="post" action="/saeckel/operations/${id}/delete">`,
        ],
      );
      // Each form closes before the next one opens.
      assert.doesNotMatch(page, /<form\b(?:(?!<\/form>)[\s\S])*<form\b/);
      assert.ok(
        fold(page).includes(
          `<details class="delete"> <summary class="btn btn-danger">Удалить</summary> <form method="post" action="/saeckel/operations/${id}/delete"> <button type="submit" class="btn btn-danger">Удалить запись</button> </form> </details>`,
        ),
      );
      // The form of the record has no button of its own: «Сохранить» stands beside «Удалить»
      // and belongs to it by `form`.
      const record = /<form id="record"[\s\S]*?<\/form>/.exec(page)![0];
      assert.ok(!record.includes('<button'));
      assert.ok(
        page.includes(
          '<button type="submit" form="record" class="btn btn-ochre">Сохранить</button>',
        ),
      );
    }
  });

  test('a record refused: each wrong field and list red, its error under it; what was typed kept', async () => {
    const ids = await prototypeBudget();
    const spent = await post(
      '/saeckel/operations/3',
      { from: '', amount: 'x', date: 'x', note: 'a\u0001b' },
      'anna',
    );
    assert.equal(spent.status, 400);
    const page = await spent.text();
    assertInvalid(page, ['from', 'amount', 'date', 'note'], 'an expense');
    for (const value of ['x', 'a\u0001b']) assert.ok(page.includes(`value="${value}"`), value);
    const moved = await addOperation(ANNA, 'transfer', 100, {
      from: ids['Отпуск'],
      to: ids['Транспорт'],
    });
    const same = await post(
      `/saeckel/operations/${moved}`,
      { from: String(ids['Отпуск']), to: String(ids['Отпуск']), amount: '1' },
      'anna',
    );
    assert.equal(same.status, 400);
    assertInvalid(await same.text(), ['to'], 'a transfer into the same pouch');
  });

  test('a record of a pouch in the storeroom: to read, also when a change or a deletion is sent anyway', async () => {
    const old = await addPouch(ANNA, 'Старый');
    const id = await addOperation(ANNA, 'expense', 124_050, { from: old }, '2026-10-05', 'овощи');
    await pool.query('UPDATE pouches SET is_archived = true');
    const read = await get(`/saeckel/operations/${id}`, 'anna');
    const changed = await post(
      `/saeckel/operations/${id}`,
      { amount: '1', from: String(old) },
      'anna',
    );
    const deleted = await post(`/saeckel/operations/${id}/delete`, {}, 'anna');
    assert.deepEqual([read.status, changed.status, deleted.status], [200, 400, 400]);
    const page = await read.text();
    for (const answer of [changed, deleted]) assert.equal(await answer.text(), page);
    const folded = fold(page);
    assert.ok(
      folded.includes(
        `<p class="note note-error"> Мешок «<a class="link" href="/saeckel/pouches/${old}">Старый</a>» в Кладовой: запись с ним не исправляется и не удаляется. Сначала верните мешок. </p>`,
      ),
    );
    assert.deepEqual(
      [
        ...folded.matchAll(/<div class="line[^"]*"> <dt>([^<]*)<\/dt> <dd>([^<]*)<\/dd> <\/div>/g),
      ].map(([, term, value]) => `${term}: ${value}`),
      ['Сумма: 1 240,50 ₽', 'Дата: 05.10.2026', 'Из мешка: Старый', 'Заметка: овощи'],
    );
    assert.ok(!page.includes('<form') && !page.includes('<details') && !page.includes('<input'));
    assert.equal((await operations()).length, 1);
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
    const pictures = [
      ...page.matchAll(/<a\s+class="pouch[^"]*"[^>]*>\s*<img\s+src="([^"]*)"/g),
    ].map((match) => match[1]!);
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
