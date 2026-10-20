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
// without a body. A file is streamed from disk. A file added while the server runs is served only
// after a restart; a changed one at once.

import type { MiddlewareHandler } from 'hono';
import { createReadStream, readdirSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
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

    c.header('Content-Type', file.type);
    c.header('Content-Length', String(stats.size));
    if (c.req.method === 'HEAD') return c.body(null, 200);
    return c.body(Readable.toWeb(createReadStream(file.path)) as ReadableStream, 200);
  };
}
