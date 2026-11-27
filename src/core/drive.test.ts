// Prototype A of M14 (Issue #165): the copy of Turbo is the file of its release, and the glue of
// drive.js decides which addresses Turbo opens and which stylesheet a view switches on.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { TURBO } from './app.ts';
import { DRIVEN, drives, sheetSwap } from './static/drive.js';

const STATIC = join(import.meta.dirname, 'static');

describe('drive: the copy of Turbo', () => {
  // dist/turbo.es2017-esm.js of the npm package @hotwired/turbo 8.0.23 (npm pack checked its
  // integrity, sha512-GZ7cijxEZ6Ig71u7rD6LHaRv/wcE/hNsc+nEfiWOkLNqUgLOwo5MNGWOy5ZV9ZUDSiQx1no7YxjTNnT4O6//cQ==).
  const SHA256 = 'b9d35d123a07614f55eaaf993f74d687a503ae41ba50ef835aafa18dbb265a13';

  test('is the file of release 8.0.23, unchanged, with its licence beside it', () => {
    const file = readFileSync(join(STATIC, TURBO));
    assert.equal(createHash('sha256').update(file).digest('hex'), SHA256);
    assert.match(file.toString('utf8', 0, 64), /^\/\*!\nTurbo 8\.0\.23\n/);
    assert.equal(TURBO, 'vendor/turbo-8.0.23.js');
    const licence = readFileSync(join(STATIC, 'vendor', 'turbo-LICENSE.txt'), 'utf8');
    assert.match(licence, /Turbo 8\.0\.23/);
    assert.match(licence, /MIT License/);
  });
});

describe('drive: the views Turbo opens in this document', () => {
  const origin = 'https://hof.example';

  test('Двор, Мешки, a pouch and Летопись with its pages', () => {
    for (const href of [
      '/',
      '/saeckel/',
      '/saeckel/pouches/1',
      '/saeckel/pouches/42',
      '/saeckel/history',
      '/saeckel/history?page=2',
      'https://hof.example/saeckel/history?pouch=3',
    ]) {
      assert.equal(drives(href, origin), true, href);
    }
    assert.equal(DRIVEN.length, 4);
  });

  test('not the pages not moved yet, the sign-in, forms, files or another origin', () => {
    for (const href of [
      '/login',
      '/logout',
      '/account',
      '/admin/users',
      '/saeckel',
      '/saeckel/assign',
      '/saeckel/income',
      '/saeckel/transfer',
      '/saeckel/pouches/0',
      '/saeckel/pouches/1/edit',
      '/saeckel/pouches/1/expense',
      '/saeckel/operations/5',
      '/static/hof.css',
      'https://other.example/saeckel/',
      'http://hof.example/saeckel/',
      'javascript:alert(1)',
    ]) {
      assert.equal(drives(href, origin), false, href);
    }
  });
});

describe('drive: the stylesheet of a view', () => {
  const hof = '/static/hof.css?v=aaaaaaaaaaaa';
  const saeckel = '/saeckel/static/saeckel.css?v=bbbbbbbbbbbb';

  test('the one the view names is switched on, every other goes', () => {
    assert.deepEqual(sheetSwap([hof, saeckel], saeckel), { on: saeckel, off: [hof] });
    assert.deepEqual(sheetSwap([saeckel], saeckel), { on: saeckel, off: [] });
  });

  test('a view that names none, or one not there, changes nothing', () => {
    assert.deepEqual(sheetSwap([hof], undefined), { on: null, off: [] });
    assert.deepEqual(sheetSwap([hof], saeckel), { on: null, off: [] });
  });
});
