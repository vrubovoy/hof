// static.ts: which files of a folder are served, with which headers, and when the answer is 304
// (ARCHITECTURE.md §4.1, §4.9). No database: a small app on a folder of its own.

import assert from 'node:assert/strict';
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
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
  'fx.js': ['export const fx = 1;', 'text/javascript; charset=utf-8'],
  // Ten known bytes, so every range below has a known answer.
  'sounds/music.m4a': ['0123456789', 'audio/mp4'],
};
const MUSIC = '/static/sounds/music.m4a';
// A fixed time, so Last-Modified is known: 2026-10-01 12:00:00 UTC.
const MODIFIED = new Date('2026-10-01T12:00:00Z');
const MODIFIED_HTTP = 'Thu, 01 Oct 2026 12:00:00 GMT';

mkdirSync(join(dir, 'img'), { recursive: true });
mkdirSync(join(dir, 'fonts'));
mkdirSync(join(dir, 'sounds'));
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
    test(`GET ${name}: the file, its type, length, date, no-cache and ranges`, async () => {
      const res = await get(`/static/${name}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), type);
      assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(content)));
      assert.equal(res.headers.get('last-modified'), MODIFIED_HTTP);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
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

// RFC 9110 §14: one range is a part (206), one past the end is 416, anything else is the whole
// file. The music file has the ten bytes «0123456789».
describe('static files: byte ranges', () => {
  const parts: [range: string, body: string, contentRange: string][] = [
    ['bytes=0-0', '0', 'bytes 0-0/10'],
    ['bytes=0-1', '01', 'bytes 0-1/10'],
    ['bytes=9-', '9', 'bytes 9-9/10'],
    ['bytes=-1', '9', 'bytes 9-9/10'],
    ['bytes=3-6', '3456', 'bytes 3-6/10'],
    ['bytes=0-110', '0123456789', 'bytes 0-9/10'],
    ['bytes=-20', '0123456789', 'bytes 0-9/10'],
    ['bytes=007-008', '78', 'bytes 7-8/10'],
  ];
  for (const [range, body, contentRange] of parts) {
    test(`${range}: 206 with only those bytes`, async () => {
      const res = await get(MUSIC, { range });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), contentRange);
      assert.equal(res.headers.get('content-length'), String(body.length));
      assert.equal(res.headers.get('content-type'), 'audio/mp4');
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      assert.equal(res.headers.get('last-modified'), MODIFIED_HTTP);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      assert.equal(await res.text(), body);
    });
  }

  for (const range of ['bytes=10-', 'bytes=11-20', 'bytes=-0']) {
    test(`${range}: 416 with the size, no body`, async () => {
      const res = await get(MUSIC, { range });
      assert.equal(res.status, 416);
      assert.equal(res.headers.get('content-range'), 'bytes */10');
      assert.equal(await res.text(), '');
    });
  }

  const whole: [name: string, headers: Record<string, string>][] = [
    ['a last byte before the first', { range: 'bytes=5-2' }],
    ['a space', { range: 'bytes= 0-1' }],
    ['letters', { range: 'bytes=a-b' }],
    ['no numbers', { range: 'bytes=-' }],
    ['another unit', { range: 'items=0-1' }],
    ['several ranges', { range: 'bytes=0-1,3-4' }],
    ['a number past the exact ones', { range: 'bytes=0-9007199254740993' }],
    ['If-Range', { range: 'bytes=0-1', 'if-range': MODIFIED_HTTP }],
  ];
  for (const [name, headers] of whole) {
    test(`${name}: 200 with the whole file`, async () => {
      const res = await get(MUSIC, headers);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-range'), null);
      assert.equal(res.headers.get('content-length'), '10');
      assert.equal(await res.text(), '0123456789');
    });
  }

  test('HEAD with a range: 200 with the length of the file, no body', async () => {
    const res = await get(MUSIC, { range: 'bytes=0-1' }, 'HEAD');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), '10');
    assert.equal(res.headers.get('content-range'), null);
    assert.equal(await res.text(), '');
  });

  test('a current copy with a range: 304 first', async () => {
    const res = await get(MUSIC, { range: 'bytes=0-1', 'if-modified-since': MODIFIED_HTTP });
    assert.equal(res.status, 304);
    assert.equal(await res.text(), '');
  });

  test('a range of a name not in the list: the common 404', async () => {
    for (const path of [
      '/static/sounds/missing.m4a',
      '/static/link.css',
      '/static/img/photo.png',
    ]) {
      const res = await get(path, { range: 'bytes=0-1' });
      assert.equal(res.status, 404, path);
      assert.equal(await res.text(), 'not found', path);
    }
  });

  // A sparse file of 4 GiB takes no room on disk. If the file were read whole, two bytes at its
  // end would take far longer than the test may, and an offset past 2³² must be exact.
  test('the last two bytes of a 4 GiB file: 206 at once', { timeout: 5000 }, async () => {
    const bigDir = join(root, 'big');
    mkdirSync(bigDir);
    const size = 4 * 1024 ** 3 + 2;
    const fd = openSync(join(bigDir, 'big.m4a'), 'w');
    ftruncateSync(fd, size);
    writeSync(fd, Buffer.from('ok'), 0, 2, size - 2);
    closeSync(fd);
    const big = new Hono();
    big.use('/static/*', staticFiles('/static/', bigDir));

    const res = await big.request('/static/big.m4a', { headers: { range: `bytes=${size - 2}-` } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes ${size - 2}-${size - 1}/${size}`);
    assert.equal(res.headers.get('content-length'), '2');
    assert.equal(await res.text(), 'ok');
  });
});
