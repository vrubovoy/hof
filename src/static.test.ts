// static.ts: which files of a folder are served, with which headers, and when the answer is 304
// (ARCHITECTURE.md §4.1, §4.9). No database: a small app on a folder of its own.

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { Hono } from 'hono';
import { staticFiles } from './static.ts';

const root = mkdtempSync(join(tmpdir(), 'hof-static-'));
const dir = join(root, 'static');
const outside = join(root, 'outside');
after(() => rmSync(root, { recursive: true, force: true }));

const FILES: Record<string, [content: string, type: string]> = {
  'hof.css': ['body { margin: 0; }', 'text/css; charset=utf-8'],
  'img/mark.svg': ['<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'],
  'img/scene.webp': ['RIFF-webp', 'image/webp'],
  'fonts/font.woff2': ['wOF2-font', 'font/woff2'],
  'fonts/OFL.txt': ['SIL Open Font License', 'text/plain; charset=utf-8'],
};
// A fixed time, so Last-Modified is known: 2026-10-01 12:00:00 UTC.
const MODIFIED = new Date('2026-10-01T12:00:00Z');
const MODIFIED_HTTP = 'Thu, 01 Oct 2026 12:00:00 GMT';

mkdirSync(join(dir, 'img'), { recursive: true });
mkdirSync(join(dir, 'fonts'));
mkdirSync(outside);
for (const [name, [content]] of Object.entries(FILES)) {
  writeFileSync(join(dir, name), content);
  utimesSync(join(dir, name), MODIFIED, MODIFIED);
}
// Never served: a hidden file, a file of another type, links to a file and to a folder outside.
writeFileSync(join(dir, '.hidden.css'), 'hidden');
writeFileSync(join(dir, 'img', 'photo.png'), 'png');
writeFileSync(join(outside, 'secret.css'), 'secret');
symlinkSync(join(outside, 'secret.css'), join(dir, 'link.css'));
symlinkSync(outside, join(dir, 'linked'));
// Listed at the start, changed afterwards (below).
writeFileSync(join(dir, 'later-link.css'), 'a file at the start');
writeFileSync(join(dir, 'later-gone.css'), 'a file at the start');
writeFileSync(join(dir, 'later-edited.css'), 'short');

const app = new Hono();
app.use('/static/*', staticFiles('/static/', dir));
app.post('/static/hof.css', (c) => c.text('route'));
app.notFound((c) => c.text('not found', 404));

function get(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return app.request(path, { method, headers });
}

describe('static files', () => {
  for (const [name, [content, type]] of Object.entries(FILES)) {
    test(`GET ${name}: the file, its type, length, date and no-cache`, async () => {
      const res = await get(`/static/${name}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), type);
      assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(content)));
      assert.equal(res.headers.get('last-modified'), MODIFIED_HTTP);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      assert.equal(await res.text(), content);
    });
  }

  test('HEAD: the same headers, no body', async () => {
    const res = await get('/static/hof.css', {}, 'HEAD');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(res.headers.get('content-length'), String(FILES['hof.css']![0].length));
    assert.equal(res.headers.get('last-modified'), MODIFIED_HTTP);
    assert.equal(await res.text(), '');
  });

  test('If-Modified-Since: 304 without a body for a current copy, 200 for an old one', async () => {
    for (const since of [MODIFIED_HTTP, 'Fri, 02 Oct 2026 00:00:00 GMT']) {
      const res = await get('/static/img/scene.webp', { 'if-modified-since': since });
      assert.equal(res.status, 304, since);
      assert.equal(res.headers.get('last-modified'), MODIFIED_HTTP);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      assert.equal(await res.text(), '');
    }
    for (const since of ['Thu, 01 Oct 2026 11:59:59 GMT', 'not a date']) {
      const res = await get('/static/img/scene.webp', { 'if-modified-since': since });
      assert.equal(res.status, 200, since);
      assert.equal(await res.text(), 'RIFF-webp');
    }
  });

  // A literal "\" or ".." never reaches the application: the URL parser turns "\" into "/" and
  // resolves "..", as a browser does. What reaches it is looked up in the list as it is.
  const refused = [
    '/static/',
    '/static/img',
    '/static/img/',
    '/static/fonts/',
    '/static//hof.css',
    '/static/img//scene.webp',
    '/static/%2e%2e/outside/secret.css',
    '/static/img/..%2fhof.css',
    '/static/img%5Cscene.webp',
    '/static/HOF.CSS',
    '/static/hof.css/',
    '/static/missing.css',
    '/static/.hidden.css',
    '/static/img/photo.png',
    '/static/link.css',
    '/static/linked/secret.css',
  ];
  for (const path of refused) {
    test(`GET ${path}: the common 404`, async () => {
      const res = await get(path);
      assert.equal(res.status, 404);
      assert.equal(await res.text(), 'not found');
    });
  }

  test('a file removed or replaced by a link after the start: 404', async () => {
    unlinkSync(join(dir, 'later-gone.css'));
    unlinkSync(join(dir, 'later-link.css'));
    symlinkSync(join(outside, 'secret.css'), join(dir, 'later-link.css'));
    for (const path of ['/static/later-gone.css', '/static/later-link.css']) {
      assert.equal((await get(path)).status, 404, path);
    }
  });

  test('a file changed after the start: its new content, length and date', async () => {
    writeFileSync(join(dir, 'later-edited.css'), 'a longer content');
    const res = await get('/static/later-edited.css');
    assert.equal(res.headers.get('content-length'), '16');
    const seconds = Math.floor(statSync(join(dir, 'later-edited.css')).mtimeMs / 1000) * 1000;
    assert.equal(res.headers.get('last-modified'), new Date(seconds).toUTCString());
    assert.equal(await res.text(), 'a longer content');
  });

  test('other methods go on to the routes', async () => {
    const res = await get('/static/hof.css', {}, 'POST');
    assert.equal(await res.text(), 'route');
  });
});
