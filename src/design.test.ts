// M12.13: the pictures made from the finished masters of design/ (design/README.md). Every line
// of design/export.txt names a master that is there and a file the site serves; every master is
// used. Whether a file is still made from its master byte for byte is checked by
// `python3 design/export.py check` (it needs ImageMagick).

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const SITE: Record<string, string> = {
  core: 'src/core/static/img',
  saeckel: 'src/saeckel/static/img',
};

const rows = readFileSync(join(ROOT, 'design', 'export.txt'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.startsWith('#'))
  .map((line) => line.trim().split(/\s+/));

test('M12.13: every line of design/export.txt joins a master to a file of the site', () => {
  assert.ok(rows.length > 0);
  const files = new Set<string>();
  for (const row of rows) {
    assert.equal(row.length, 4, row.join(' '));
    const [master, file, size, quality] = row as [string, string, string, string];
    assert.ok(existsSync(join(ROOT, 'design', 'masters', master)), master);
    const [module, name] = file.split('/') as [string, string];
    assert.ok(SITE[module] !== undefined && existsSync(join(ROOT, SITE[module], name)), file);
    assert.match(name, /\.webp$/, file);
    assert.match(size, /^(1x|2x|2x\/\d+|\d+)$/, file);
    assert.match(quality, /^\d+$/, file);
    assert.ok(!files.has(file), `${file} twice`);
    files.add(file);
  }
});

test('M12.13: every master is a PNG the table uses; the folder has nothing else', () => {
  const used = new Set(rows.map(([master]) => master));
  for (const file of readdirSync(join(ROOT, 'design', 'masters'))) {
    assert.match(file, /\.png$/, file);
    assert.ok(used.has(file), `${file} is in no line of export.txt`);
  }
});
