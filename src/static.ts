// Static files of a module (ARCHITECTURE.md §4.1, §4.9): its CSS, fonts and pictures, for
// everybody, without a session and without the database.
//
// Only the regular files found in the module's static folder when the server starts are served.
// The path of a request is looked up in that list; it is never joined to a path on disk, so no
// address can reach a file outside the folder. Directories are walked for the list but never
// served; symbolic links, hidden files and files of other types are left out of it.
//
// `Cache-Control: no-cache` lets the browser keep its copy but ask every time whether it is still
// current: after an update of Hof a changed file comes at once, and an unchanged one costs a 304
// without a body. A file is streamed from disk and never held in memory. A file added while the
// server runs is served only after a restart; a changed one at once.
//
// One byte range of a GET (RFC 9110 §14) is answered with 206 and only those bytes are read from
// disk: Safari plays <audio> only from a server that answers ranges, and music goes on from the
// place it was left at a jump into the file. Anything Hof does not answer with a part — several
// ranges, another unit, a wrong form, If-Range, HEAD — gets the whole file, as RFC 9110 allows.

import type { MiddlewareHandler } from 'hono';
import { createReadStream, readdirSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

interface StaticFile {
  path: string;
  type: string;
}

// Every regular file of `dir` and its subfolders with a known type, by its name in the address
// ("hof.css", "img/frame.webp").
function listFiles(dir: string, prefix = '', files = new Map<string, StaticFile>()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    // A Dirent describes the entry itself: a symbolic link is neither a file nor a directory.
    if (entry.isDirectory()) listFiles(path, `${prefix}${entry.name}/`, files);
    const type = CONTENT_TYPES[extname(entry.name)];
    if (entry.isFile() && type !== undefined) files.set(`${prefix}${entry.name}`, { path, type });
  }
  return files;
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

// GET and HEAD of `prefix` + a listed name; any other address under the prefix is the common
// 404. Other methods go on to the routes.
export function staticFiles(prefix: string, dir: string): MiddlewareHandler {
  const files = listFiles(dir);
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const file = files.get(c.req.path.slice(prefix.length));
    // Looked at again: a file removed or replaced by a link since the start is not served.
    const stats = file === undefined ? undefined : await lstat(file.path).catch(() => undefined);
    if (file === undefined || stats === undefined || !stats.isFile()) return c.notFound();

    // HTTP dates have whole seconds.
    const modified = Math.floor(stats.mtimeMs / 1000) * 1000;
    c.header('Last-Modified', new Date(modified).toUTCString());
    c.header('Cache-Control', 'no-cache');
    // An unreadable date is NaN, and NaN >= anything is false.
    if (Date.parse(c.req.header('If-Modified-Since') ?? '') >= modified) return c.body(null, 304);

    // A range only for GET without If-Range: the date of the copy is not compared here.
    const range =
      c.req.method === 'GET' && c.req.header('If-Range') === undefined
        ? byteRange(c.req.header('Range'), stats.size)
        : null;
    if (range === 'unsatisfiable') {
      c.header('Content-Range', `bytes */${stats.size}`);
      return c.body(null, 416);
    }

    c.header('Content-Type', file.type);
    c.header('Accept-Ranges', 'bytes');
    if (range !== null) {
      c.header('Content-Range', `bytes ${range.start}-${range.end}/${stats.size}`);
      c.header('Content-Length', String(range.end - range.start + 1));
      // Only these bytes are read from disk.
      return c.body(Readable.toWeb(createReadStream(file.path, range)) as ReadableStream, 206);
    }
    c.header('Content-Length', String(stats.size));
    if (c.req.method === 'HEAD') return c.body(null, 200);
    return c.body(Readable.toWeb(createReadStream(file.path)) as ReadableStream, 200);
  };
}
