// Static files of a module (ARCHITECTURE.md §4.1, §4.9): its CSS, scripts, fonts, pictures and
// sounds, for everybody, without a session and without the database.
//
// Only the regular files found in the module's static folder when the server starts are served.
// The path of a request is looked up in that list; it is never joined to a path on disk, so no
// address can reach a file outside the folder. Directories are walked for the list but never
// served; symbolic links, hidden files and files of other types are left out of it.
//
// When the server starts, every file gets a version: the start of the SHA-256 of its content. A
// page names a file by url(), "/static/img/frame.webp?v=<version>", and the content of such an
// address never changes: the browser keeps it a year without asking. After an update of Hof a
// changed file has a new address, an unchanged one the same. An address without a version (the
// sounds, which fx.js names itself) or with another one (a page opened before an update) gets the
// current file with `no-cache`. The version is also the ETag: a copy the browser asks about with
// If-None-Match is current if its content is, whenever it was made, and the answer is a 304.
//
// A CSS file names its pictures and fonts by url(img/…) and url(fonts/…). When the server starts,
// each of them gets the version of its file, and the CSS is served from memory, its own version
// counted over that text. A url() of anything that is not a file of the folder stops the start.
// Any other file is streamed from disk and never held in memory. Files are read once, at the
// start: a file added or changed afterwards needs a restart (`npm run dev` restarts on any change
// under src); a file removed or replaced by a link is no longer served.
//
// One byte range of a GET (RFC 9110 §14) is answered with 206 and only those bytes are read from
// disk: Safari plays <audio> only from a server that answers ranges, and music goes on from the
// place it was left at a jump into the file. Anything Hof does not answer with a part — several
// ranges, another unit, a wrong form, If-Range, HEAD — gets the whole file, as RFC 9110 allows.

import type { MiddlewareHandler } from 'hono';
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { extname, join, posix } from 'node:path';
import { Readable } from 'node:stream';

const CSS = 'text/css; charset=utf-8';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': CSS,
  '.js': 'text/javascript; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

// An address with the current version of its file.
const IMMUTABLE = 'public, max-age=31536000, immutable';

// Every url(…) of a CSS file, the address between the parentheses.
const CSS_URL = /url\(([^)]*)\)/g;

interface StaticFile {
  path: string;
  type: string;
  version: string;
  // A CSS file with the versions in its url(): served from here, not from disk.
  text?: Uint8Array<ArrayBuffer>;
}

function versionOf(content: Uint8Array) {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

// Every regular file of `dir` and its subfolders with a known type, by its name in the address
// ("hof.css", "img/frame.webp"), with its version.
function listFiles(dir: string, prefix = '', files = new Map<string, StaticFile>()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    // A Dirent describes the entry itself: a symbolic link is neither a file nor a directory.
    if (entry.isDirectory()) listFiles(path, `${prefix}${entry.name}/`, files);
    const type = CONTENT_TYPES[extname(entry.name)];
    if (entry.isFile() && type !== undefined) {
      files.set(`${prefix}${entry.name}`, { path, type, version: versionOf(readFileSync(path)) });
    }
  }
  return files;
}

// The CSS files of the list with the version of each file they name; then their own versions.
function versionUrls(files: Map<string, StaticFile>, dir: string) {
  for (const [name, file] of files) {
    if (file.type !== CSS) continue;
    const text = readFileSync(file.path, 'utf8').replace(CSS_URL, (_, address: string) => {
      const named = files.get(posix.join(posix.dirname(name), address));
      if (named === undefined || named.type === CSS) {
        throw new Error(`${join(dir, name)}: url(${address}) is not a file of ${dir}`);
      }
      return `url(${address}?v=${named.version})`;
    });
    file.text = new TextEncoder().encode(text);
    file.version = versionOf(file.text);
  }
}

// The bytes from `start` to `end` (both included) of a file of `size` bytes that a Range header
// asks for; 'unsatisfiable' when it starts past the end (or asks for the last 0 bytes); null when
// Hof answers it with the whole file: no header, another unit, several ranges, spaces, a last
// byte before the first, a number too long to be exact.
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (match === null) return null;
  const [, first = '', last = ''] = match;
  const exact = (digits: string) => (Number.isSafeInteger(Number(digits)) ? Number(digits) : null);
  if (first === '') {
    // bytes=-n: the last n bytes, the whole file if it is shorter.
    const count = last === '' ? null : exact(last);
    if (count === null) return null;
    if (count === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - count), end: size - 1 };
  }
  // bytes=a- and bytes=a-b: from a to b or to the end, b past the end means the end.
  const start = exact(first);
  const end = last === '' ? Infinity : exact(last);
  if (start === null || end === null || end < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

// If-None-Match names this ETag, or any: RFC 9110 §13.1.2 compares them weakly, and nginx marks
// the ETag of an answer it compresses as weak (W/).
function namesTag(header: string | undefined, etag: string) {
  return (header ?? '')
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === etag);
}

export interface StaticFolder {
  // The address of a file of the folder with its version: url('img/frame.webp') is
  // "/static/img/frame.webp?v=…". A name that is not in the folder is an error.
  url: (name: string) => string;
  // GET and HEAD of the prefix + a listed name; any other address under the prefix is the common
  // 404. Other methods go on to the routes.
  serve: MiddlewareHandler;
}

// The folder `dir` at the addresses `prefix` + name.
export function staticFolder(prefix: string, dir: string): StaticFolder {
  const files = listFiles(dir);
  versionUrls(files, dir);

  const url = (name: string) => {
    const file = files.get(name);
    if (file === undefined) throw new Error(`${name} is not a file of ${dir}`);
    return `${prefix}${name}?v=${file.version}`;
  };

  const serve: MiddlewareHandler = async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const file = files.get(c.req.path.slice(prefix.length));
    if (file === undefined) return c.notFound();
    let size = file.text?.length;
    if (size === undefined) {
      // Looked at again: a file removed or replaced by a link since the start is not served.
      const stats = await lstat(file.path).catch(() => undefined);
      if (stats === undefined || !stats.isFile()) return c.notFound();
      size = stats.size;
    }

    const etag = `"${file.version}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', c.req.query('v') === file.version ? IMMUTABLE : 'no-cache');
    if (namesTag(c.req.header('If-None-Match'), etag)) return c.body(null, 304);

    // A range only for GET without If-Range.
    const range =
      c.req.method === 'GET' && c.req.header('If-Range') === undefined
        ? byteRange(c.req.header('Range'), size)
        : null;
    if (range === 'unsatisfiable') {
      c.header('Content-Range', `bytes */${size}`);
      return c.body(null, 416);
    }

    c.header('Content-Type', file.type);
    c.header('Accept-Ranges', 'bytes');
    if (range !== null) {
      c.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      c.header('Content-Length', String(range.end - range.start + 1));
      if (file.text !== undefined)
        return c.body(file.text.subarray(range.start, range.end + 1), 206);
      // Only these bytes are read from disk.
      return c.body(Readable.toWeb(createReadStream(file.path, range)) as ReadableStream, 206);
    }
    c.header('Content-Length', String(size));
    if (c.req.method === 'HEAD') return c.body(null, 200);
    if (file.text !== undefined) return c.body(file.text, 200);
    return c.body(Readable.toWeb(createReadStream(file.path)) as ReadableStream, 200);
  };

  return { url, serve };
}
