// M12.12: every picture the site serves has a line in design/assets.json, and every master named
// there lies in design/masters. Whether a picture still comes out of its master byte for byte is
// checked by design/tools/export.py (it needs ImageMagick and Python, design/README.md).

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const IMG = ['src/core/static/img', 'src/saeckel/static/img'];
const RECIPES = ['1x', '2x', 'width', 'band', 'frames', 'pen', 'copy'];

interface Entry {
  out: string;
  recipe: string;
  master?: string;
  panel?: string;
}

const { entries } = JSON.parse(readFileSync(join(ROOT, 'design', 'assets.json'), 'utf8')) as {
  entries: Entry[];
};

test('M12.12: every picture of static is in design/assets.json, once, and nothing else is', () => {
  const shipped = IMG.flatMap((dir) =>
    readdirSync(join(ROOT, dir)).map((file) => `${dir}/${file}`),
  );
  const listed = entries.map((entry) => entry.out);
  assert.equal(new Set(listed).size, listed.length);
  assert.deepEqual([...listed].sort(), shipped.sort());
});

test('M12.12: every master and panel named is there; every recipe is one export.py knows', () => {
  for (const entry of entries) {
    assert.ok(RECIPES.includes(entry.recipe), `${entry.out}: ${entry.recipe}`);
    if (entry.master !== undefined) {
      assert.ok(existsSync(join(ROOT, 'design', entry.master)), `${entry.out}: ${entry.master}`);
    }
    if (entry.panel !== undefined) {
      assert.ok(existsSync(join(ROOT, entry.panel)), `${entry.out}: ${entry.panel}`);
    }
    // Only the pictures with a recipe have a master; one made by hand is its own.
    assert.equal(
      entry.master !== undefined,
      ['1x', '2x', 'width', 'frames'].includes(entry.recipe),
      entry.out,
    );
  }
  const masters = readdirSync(join(ROOT, 'design', 'masters'));
  const named = new Set(entries.flatMap((entry) => (entry.master ? [entry.master] : [])));
  for (const file of masters) assert.ok(named.has(`masters/${file}`), `no picture of ${file}`);
});
