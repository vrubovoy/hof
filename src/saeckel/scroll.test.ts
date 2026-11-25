// M13.9: where a page of Säckel opens. A page drawn for a refused form opens at the field refused
// first — it alone has `autofocus`, so the browser focuses it and scrolls to it without a script.
// The way back of a pouch and of a record leads to that pouch or record in its list (an anchor),
// a quarter of the window down. In a low window of a computer the scene is lower. Database:
// hof_test as hof_saeckel.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { migrate } from '../migrate.ts';
import { addOperation, addPouch, deadPool, get, pool, post, wayBack } from './test-helpers.ts';

before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
beforeEach(() => pool.query('TRUNCATE operations, pouches RESTART IDENTITY'));
after(() => Promise.all([pool.end(), deadPool.end()]));

// The tags of a page that have `autofocus`, each as its name.
const focused = (page: string) =>
  [...page.matchAll(/<(?:input|select)\s[^>]*\bautofocus\b[^>]*>/g)].map(
    ([tag]) => /name="([^"]*)"/.exec(tag)?.[1],
  );

describe('a refused form opens at its first refused field', () => {
  test('an expense: two fields refused, the amount first', async () => {
    const food = await addPouch(1, 'Продукты');
    const res = await post(
      `/saeckel/pouches/${food}/expense`,
      { amount: 'x', date: '31.02.2026', note: '' },
      'anna',
    );
    assert.equal(res.status, 400);
    assert.deepEqual(focused(await res.text()), ['amount']);
  });

  test('«Переложить»: no pouch chosen and a wrong amount — «Из мешка» first', async () => {
    await addPouch(1, 'Продукты');
    const res = await post(
      '/saeckel/transfer',
      { from: '', to: '', amount: 'x', date: '', note: '' },
      'anna',
    );
    assert.equal(res.status, 400);
    assert.deepEqual(focused(await res.text()), ['from']);
  });

  test('a record: its amount', async () => {
    const food = await addPouch(1, 'Продукты');
    const id = await addOperation(1, 'assign', 100, { to: food });
    const res = await post(
      `/saeckel/operations/${id}`,
      { to: String(food), amount: 'x', date: '05.10.2026', note: '' },
      'anna',
    );
    assert.equal(res.status, 400);
    assert.deepEqual(focused(await res.text()), ['amount']);
  });

  test('«Разложить»: two rows refused, the first of the list', async () => {
    const food = await addPouch(1, 'Продукты');
    const flat = await addPouch(1, 'Квартира');
    const cart = await addPouch(1, 'Транспорт');
    await addOperation(1, 'income', 100_000);
    const res = await post(
      '/saeckel/assign',
      { [`amount_${food}`]: '10', [`amount_${flat}`]: 'x', [`amount_${cart}`]: 'y' },
      'anna',
    );
    assert.equal(res.status, 400);
    assert.deepEqual(focused(await res.text()), [`amount_${flat}`]);
  });

  test('a new pouch and «Изменить» without a name: the name', async () => {
    const res = await post('/saeckel/pouches/new', { name: ' ', icon: 'pouch' }, 'anna');
    assert.equal(res.status, 400);
    assert.deepEqual(focused(await res.text()), ['name']);
    const food = await addPouch(1, 'Продукты');
    const edit = await post(`/saeckel/pouches/${food}/edit`, { name: '', icon: 'pouch' }, 'anna');
    assert.equal(edit.status, 400);
    assert.deepEqual(focused(await edit.text()), ['name']);
  });

  test('a form not refused has no field focused', async () => {
    const food = await addPouch(1, 'Продукты');
    const id = await addOperation(1, 'assign', 100, { to: food });
    for (const path of [
      `/saeckel/pouches/${food}`,
      '/saeckel/transfer',
      '/saeckel/assign',
      '/saeckel/pouches/new',
      `/saeckel/operations/${id}`,
    ]) {
      assert.deepEqual(focused(await (await get(path, 'anna')).text()), [], path);
    }
  });
});

describe('the way back leads to the pouch or the record in its list', () => {
  test('each pouch of the list has its anchor; an active pouch leads back to it', async () => {
    const food = await addPouch(1, 'Продукты');
    const cart = await addPouch(1, 'Транспорт');
    const list = await (await get('/saeckel/', 'anna')).text();
    assert.ok(list.includes(`<li id="pouch-${food}">`) && list.includes(`<li id="pouch-${cart}">`));
    const page = await (await get(`/saeckel/pouches/${cart}`, 'anna')).text();
    assert.equal(wayBack(page), `/saeckel/#pouch-${cart} Мешки`);
    // A pouch in the storeroom is not in the list: back to its top.
    const old = await addPouch(1, 'Старый', true);
    assert.equal(
      wayBack(await (await get(`/saeckel/pouches/${old}`, 'anna')).text()),
      '/saeckel/ Мешки',
    );
  });

  test('a record leads back to its row; saved, to its row; deleted, to its page', async () => {
    const food = await addPouch(1, 'Продукты');
    const id = await addOperation(1, 'assign', 100, { to: food });
    const history = await (await get('/saeckel/history', 'anna')).text();
    assert.ok(history.includes(`<tr id="op-${id}">`));
    const page = await (await get(`/saeckel/operations/${id}?page=2`, 'anna')).text();
    assert.equal(wayBack(page), `/saeckel/history?page=2#op-${id} Летопись`);
    const saved = await post(
      `/saeckel/operations/${id}`,
      { page: '2', to: String(food), amount: '2', date: '05.10.2026', note: '' },
      'anna',
    );
    assert.equal(saved.headers.get('location'), `/saeckel/history?page=2#op-${id}`);
    const deleted = await post(`/saeckel/operations/${id}/delete`, { page: '2' }, 'anna');
    assert.equal(deleted.headers.get('location'), '/saeckel/history?page=2');
  });
});

describe('the CSS of where a page opens', () => {
  const css = readFileSync(join(import.meta.dirname, 'static', 'saeckel.css'), 'utf8');

  test('a refused field in sight with its error under it; a row of an anchor a quarter down', () => {
    assert.match(css, /\n\[aria-invalid='true'\] \{\s*scroll-margin: 24px 0 80px;\s*\}/);
    assert.match(css, /\n\.pouches > li,\n\.history tr\[id\] \{\s*scroll-margin-top: 25vh;\s*\}/);
  });

  test('the scene of a computer: lower in a low window, its middle shown then, as before else', () => {
    const at = css.indexOf('\n  .sk-head {\n    width: 100%;');
    assert.ok(at > 0);
    assert.ok(
      css.slice(css.lastIndexOf('@media', at), at).startsWith('@media (min-width: 1024px)'),
    );
    const head = css.slice(at, css.indexOf('}', at));
    assert.match(head, /aspect-ratio: 1440 \/ 330;/);
    assert.match(head, /max-height: max\(200px, 100vh - 560px\);/);
    assert.match(head, /container-type: size;/);
    assert.match(
      css,
      /\.sk-scene \{\s*object-position: 50% calc\(min\(0px, 100cqh - 100cqw \* 330 \/ 1440 \+ 0\.5px\) \* 0\.7\);\s*\}/,
    );
  });
});
