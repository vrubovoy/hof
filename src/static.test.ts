// static.ts: which files of a folder are served, with which versions and headers, and when the
// answer is 304 (ARCHITECTURE.md §4.1, §4.9). No database: a small app on a folder of its own.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { Hono } from 'hono';
import { byteRange, staticFolder } from './static.ts';

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
// A CSS file that names a picture and a font.
const NAMING_CSS =
  'a { background: url(img/scene.webp); }\n@font-face { src: url(fonts/font.woff2); }';

// The version of a content: the start of its SHA-256.
const version = (content: string) =>
  createHash('sha256').update(content).digest('hex').slice(0, 12);

function makeFolder(folder: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(folder, name, '..'), { recursive: true });
    writeFileSync(join(folder, name), content);
  }
}

makeFolder(dir, {
  ...Object.fromEntries(Object.entries(FILES).map(([name, [content]]) => [name, content])),
  'named.css': NAMING_CSS,
});
mkdirSync(outside);
// Never served: a hidden file, a file of another type, links to a file and to a folder outside.
writeFileSync(join(dir, '.hidden.css'), 'hidden');
writeFileSync(join(dir, 'img', 'photo.png'), 'png');
writeFileSync(join(outside, 'secret.css'), 'secret');
symlinkSync(join(outside, 'secret.css'), join(dir, 'link.css'));
symlinkSync(outside, join(dir, 'linked'));
// Listed at the start, removed or replaced afterwards (below); a CSS file is kept in memory.
for (const name of ['later-link.svg', 'later-gone.svg', 'later-link.css', 'later-gone.css']) {
  writeFileSync(join(dir, name), name.endsWith('.css') ? 'a { color: red; }' : '<svg/>');
}

const folder = staticFolder('/static/', dir);
const app = new Hono();
app.use('/static/*', folder.serve);
app.post('/static/hof.css', (c) => c.text('route'));
app.notFound((c) => c.text('not found', 404));

function get(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return app.request(path, { method, headers });
}

// The CSS of named.css as it is served: each url() with the version of its file.
const NAMED_SERVED = NAMING_CSS.replace(
  'img/scene.webp',
  `img/scene.webp?v=${version('RIFF-webp')}`,
).replace('fonts/font.woff2', `fonts/font.woff2?v=${version('wOF2-font')}`);

describe('static files', () => {
  for (const [name, [content, type]] of Object.entries(FILES)) {
    test(`GET ${name} without a version: the file, its type, length, ETag, no-cache, ranges`, async () => {
      const res = await get(`/static/${name}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), type);
      assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(content)));
      assert.equal(res.headers.get('etag'), `"${version(content)}"`);
      assert.equal(res.headers.get('last-modified'), null);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      assert.equal(await res.text(), content);
    });
  }

  test('url(): the address with the version of the content; a name not in the folder is an error', () => {
    for (const [name, [content]] of Object.entries(FILES)) {
      assert.equal(folder.url(name), `/static/${name}?v=${version(content)}`);
    }
    for (const name of [
      'missing.css',
      'img/photo.png',
      'link.css',
      '.hidden.css',
      '/hof.css',
      'img',
    ]) {
      assert.throws(() => folder.url(name), /is not a file of/, name);
    }
  });

  test('the address of url(): a year without asking; another version or none: no-cache', async () => {
    for (const name of Object.keys(FILES)) {
      const res = await get(folder.url(name));
      assert.equal(res.status, 200, name);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable', name);
    }
    const [content] = FILES['img/scene.webp']!;
    for (const address of [
      '/static/img/scene.webp?v=000000000000',
      '/static/img/scene.webp?v=',
      '/static/img/scene.webp?w=1',
    ]) {
      const res = await get(address);
      assert.equal(res.status, 200, address);
      assert.equal(res.headers.get('cache-control'), 'no-cache', address);
      assert.equal(res.headers.get('etag'), `"${version(content)}"`, address);
      assert.equal(await res.text(), content, address);
    }
  });

  test('a CSS file: every url() with the version of its file, from memory, its own version over that', async () => {
    assert.equal(folder.url('named.css'), `/static/named.css?v=${version(NAMED_SERVED)}`);
    const res = await get(folder.url('named.css'));
    assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(NAMED_SERVED)));
    assert.equal(res.headers.get('etag'), `"${version(NAMED_SERVED)}"`);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(await res.text(), NAMED_SERVED);
    const part = await get('/static/named.css', { range: 'bytes=0-4' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 0-4/${Buffer.byteLength(NAMED_SERVED)}`);
    assert.equal(await part.text(), 'a { b');
  });

  test('HEAD: the same headers, no body', async () => {
    const res = await get('/static/hof.css', {}, 'HEAD');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(res.headers.get('content-length'), String(FILES['hof.css']![0].length));
    assert.equal(res.headers.get('etag'), `"${version(FILES['hof.css']![0])}"`);
    assert.equal(await res.text(), '');
  });

  test('If-None-Match with the ETag, weak, in a list or *: 304 without a body', async () => {
    const etag = `"${version('RIFF-webp')}"`;
    for (const tags of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      for (const address of ['/static/img/scene.webp', folder.url('img/scene.webp')]) {
        const res = await get(address, { 'if-none-match': tags });
        assert.equal(res.status, 304, `${address} ${tags}`);
        assert.equal(res.headers.get('etag'), etag);
        assert.ok(res.headers.get('cache-control'));
        assert.equal(await res.text(), '');
      }
    }
    for (const tags of ['"other"', etag.slice(0, -2) + '"', 'not a tag']) {
      const res = await get('/static/img/scene.webp', { 'if-none-match': tags });
      assert.equal(res.status, 200, tags);
      assert.equal(await res.text(), 'RIFF-webp');
    }
  });

  test('If-Modified-Since: no longer read, the whole file', async () => {
    const res = await get('/static/img/scene.webp', {
      'if-modified-since': 'Fri, 01 Jan 2100 00:00:00 GMT',
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'RIFF-webp');
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

  test('a file removed or replaced by a link after the start: 404, a CSS file in memory too', async () => {
    for (const type of ['svg', 'css']) {
      unlinkSync(join(dir, `later-gone.${type}`));
      unlinkSync(join(dir, `later-link.${type}`));
      symlinkSync(join(outside, 'secret.css'), join(dir, `later-link.${type}`));
      for (const name of [`later-gone.${type}`, `later-link.${type}`]) {
        assert.equal((await get(`/static/${name}`)).status, 404, name);
        assert.equal((await get(folder.url(name))).status, 404, name);
      }
    }
  });

  test('other methods go on to the routes', async () => {
    const res = await get('/static/hof.css', {}, 'POST');
    assert.equal(await res.text(), 'route');
  });
});

// The version depends on the content only: two builds of the same files give the same addresses,
// and a changed file changes its own address and that of the CSS naming it, nothing else.
describe('static files: versions', () => {
  const CONTENT = {
    'site.css': 'a { background: url(img/a.webp); }',
    'plain.css': 'b { color: blue; }',
    'img/a.webp': 'RIFF-a',
    'img/b.webp': 'RIFF-b',
    'fx.js': 'export {};',
    'sounds/door-1.m4a': 'door',
  };
  const names = Object.keys(CONTENT);
  const addresses = (path: string) => {
    const one = staticFolder('/static/', path);
    return Object.fromEntries(names.map((name) => [name, one.url(name)]));
  };

  test('the same files with other dates: the same addresses', () => {
    const first = join(root, 'build-1');
    makeFolder(first, CONTENT);
    const second = join(root, 'build-2');
    cpSync(first, second, { recursive: true });
    for (const name of names)
      utimesSync(join(second, name), new Date('2020-01-01'), new Date('2020-01-01'));
    assert.deepEqual(addresses(second), addresses(first));
  });

  test('one picture changed: its address and that of the CSS naming it change, nothing else', () => {
    const before = join(root, 'build-before');
    makeFolder(before, CONTENT);
    const changed = join(root, 'build-changed');
    makeFolder(changed, { ...CONTENT, 'img/a.webp': 'RIFF-a, drawn again' });
    const old = addresses(before);
    const now = addresses(changed);
    assert.deepEqual(
      names.filter((name) => old[name] !== now[name]),
      ['site.css', 'img/a.webp'],
    );
  });

  for (const [what, css] of [
    ['a file not in the folder', 'a { background: url(img/missing.webp); }'],
    ['another CSS', 'a { background: url(plain.css); }'],
    ['a quoted address', 'a { background: url("img/a.webp"); }'],
    ['a data address', 'a { background: url(data:image/webp;base64,AAAA); }'],
    ['an address of another site', 'a { background: url(https://example.org/a.webp); }'],
  ]) {
    test(`a CSS file naming ${what}: the folder is refused at the start`, () => {
      const broken = mkdtempSync(join(root, 'broken-'));
      makeFolder(broken, { ...CONTENT, 'site.css': css! });
      assert.throws(
        () => staticFolder('/static/', broken),
        /site\.css: url\(.*\) is not a file of/,
      );
    });
  }
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
      assert.equal(res.headers.get('etag'), `"${version('0123456789')}"`);
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
    ['If-Range', { range: 'bytes=0-1', 'if-range': `"${version('0123456789')}"` }],
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
    const res = await get(MUSIC, {
      range: 'bytes=0-1',
      'if-none-match': `"${version('0123456789')}"`,
    });
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

  test('a range past 4 GiB: exact numbers', () => {
    const size = 4 * 1024 ** 3 + 2;
    assert.deepEqual(byteRange(`bytes=${size - 2}-`, size), { start: size - 2, end: size - 1 });
    assert.deepEqual(byteRange('bytes=-2', size), { start: size - 2, end: size - 1 });
  });
});
