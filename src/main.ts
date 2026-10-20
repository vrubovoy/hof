// Hof server entry point: configuration, database pool, migrations, start.
// Common request checks run here, before the routes of any module (ARCHITECTURE.md §2, §4).

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createCoreApp, requestUser, type Service } from './core/app.ts';
import { startFirstRun, type FirstRun } from './core/gate-key.ts';
import { hashPassword } from './core/password.ts';
import { describeError, log } from './log.ts';
import { migrate } from './migrate.ts';
import { handleConnectionErrors } from './postgres.ts';
import {
  createSaeckelApp,
  otherRecordedCurrency,
  type CurrentUser,
  type SaeckelSettings,
} from './saeckel/app.ts';
import { timeZoneError } from './saeckel/dates.ts';
import { currencyError } from './saeckel/money.ts';
import { staticFiles } from './static.ts';

const PORT = 3000;
const BODY_LIMIT_BYTES = 16 * 1024;
// The database and the role of Core; the maintenance CLI uses the same.
export const DATABASE = 'hof';
export const CORE_DB_ROLE = 'hof_core';
const CORE_MIGRATIONS = join(import.meta.dirname, 'core', 'migrations');
const CORE_STATIC = join(import.meta.dirname, 'core', 'static');
// The role of Säckel, in the same database (§5).
const SAECKEL_DB_ROLE = 'hof_saeckel';
const SAECKEL_MIGRATIONS = join(import.meta.dirname, 'saeckel', 'migrations');
const SAECKEL_STATIC = join(import.meta.dirname, 'saeckel', 'static');

// The applications of this installation, for «Службы двора» (§2): the name, the address and the
// emblem from the application's own static files. This is not a registry, just the list.
const SERVICES: readonly Service[] = [
  { name: 'Säckel', path: '/saeckel/', emblem: '/saeckel/static/img/emblem-saeckel-small.webp' },
];

// §4.9: explicit header values, not Hono's secureHeaders preset.
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; media-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// The common error pages, with texts from design/preview (ErrorMobile.html, Error500.html).
// Nothing from the request goes into them.
function errorPage(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  return html`<!doctype html>
    <html lang="ru">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
      </head>
      <body>
        <h1>${title}</h1>
        ${body}
      </body>
    </html>`;
}

const NOT_FOUND_PAGE = errorPage(
  'Такой тропы во дворе нет',
  html`<p>Возможно, ссылка устарела или в адресе опечатка.</p>
    <p><a href="/">Во двор</a></p>`,
);

// After GET and HEAD «Попробовать ещё раз» is href="": the browser opens the same address again,
// and the page does not repeat it. After any other method there is nothing to repeat by a link:
// the same address with GET may not exist, and the form is not sent twice.
function serverErrorPage(retry: boolean) {
  return errorPage(
    'Во дворе что-то стряслось',
    html`<p>Мы уже прибираемся. Попробуйте ещё раз через минуту — записанное раньше на месте.</p>
      <p>${retry ? html`<a href="">Попробовать ещё раз</a> ` : ''}<a href="/">Во двор</a></p>`,
  );
}

// §4.6: Origin must be exactly https://<Host>. For localhost (development)
// http://<Host> is accepted as well. No header, `null`, another scheme, host or port — rejected.
function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  if (origin === `https://${host}`) return true;
  return /^localhost(:\d+)?$/.test(host) && origin === `http://${host}`;
}

// §4.7: a POST body is an HTML form only; there are no file uploads.
function isFormContentType(contentType: string | undefined): boolean {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/x-www-form-urlencoded';
}

// §4.3: for an unknown login Argon2 runs against this hash, so the answer takes as long as for
// an existing one. Made once at startup with the current profile, from a random password nobody
// knows, so no typed password can match it.
export function newDummyPasswordHash(): Promise<string> {
  return hashPassword(randomBytes(32).toString('base64url'));
}

// §2: the one thing an application gets from Core — who is signed in, as { id, username }. Not
// the role: the administrator has no rights over anybody's budget.
export function applicationUser(corePool: Pool): CurrentUser {
  return async (request) => {
    const user = await requestUser(corePool, request);
    return user === null ? null : { id: user.id, username: user.username };
  };
}

// Request order: response headers, Origin, POST body (common checks below), then static files,
// then the first-run gate, then the modules' own routes, and finally the common 404.
export function createApp(
  corePool: Pool,
  saeckelPool: Pool,
  saeckelSettings: SaeckelSettings,
  firstRun: FirstRun,
  dummyPasswordHash: string,
): Hono {
  const app = new Hono();

  // Response headers go on every response, including the rejections below.
  app.use(async (c, next) => {
    await next();
    c.res.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'same-origin');
    if (c.res.headers.get('Content-Type')?.startsWith('text/html')) {
      c.res.headers.set('Cache-Control', 'no-store');
    }
  });

  // CSRF: every method except GET and HEAD needs a matching Origin.
  app.use(async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    const origin = c.req.header('Origin');
    const host = c.req.header('Host');
    if (!isAllowedOrigin(origin, host)) {
      log('warn', 'origin_rejected', {
        method: c.req.method,
        path: c.req.path,
        origin: origin ?? '-',
        host: host ?? '-',
      });
      return c.text('Запрос отклонён', 403);
    }
    return next();
  });

  // POST body: form type (415) and size (413).
  const limitBody = bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: (c) => c.text('Слишком большой запрос', 413),
  });
  app.use(async (c, next) => {
    if (c.req.method !== 'POST') return next();
    if (!isFormContentType(c.req.header('Content-Type'))) {
      return c.text('Неподдерживаемый тип запроса', 415);
    }
    return limitBody(c, next);
  });

  // Static files (§4.1) before the first-run gate: the pages of /setup need them before founding.
  // Each module has its own folder; the routes of Säckel never see a request for its files.
  app.use('/static/*', staticFiles('/static/', CORE_STATIC));
  app.use('/saeckel/static/*', staticFiles('/saeckel/static/', SAECKEL_STATIC));

  // First run (§4.1, §4.4): until the court is founded, every path leads to /setup, for every
  // module. /setup itself decides what it does before and after founding.
  app.use(async (c, next) => {
    if (c.req.path === '/setup' || (await firstRun.isFounded())) return next();
    return c.redirect('/setup', 303);
  });

  app.route('/', createCoreApp(corePool, firstRun, dummyPasswordHash, SERVICES));
  app.route('/', createSaeckelApp(saeckelPool, applicationUser(corePool), saeckelSettings));

  // Unknown paths and methods (§4.1).
  app.notFound((c) => c.html(NOT_FOUND_PAGE, 404));

  // Unexpected errors (§3, §4.1, §4.10), from the checks above as well as from the modules'
  // routes: the details go to the log only, the person gets a page without them. The log line
  // has the method and the path without the query; describeError gives the message only, not
  // the extra fields of a DatabaseError (detail, where and the rest). log() writes a value with
  // line breaks or quotes as one JSON string, so the stack stays on one line.
  app.onError((error, c) => {
    log('error', 'unexpected_error', {
      method: c.req.method,
      path: c.req.path,
      error: describeError(error),
      stack: error.stack ?? '-',
    });
    const retry = c.req.method === 'GET' || c.req.method === 'HEAD';
    return c.html(serverErrorPage(retry), 500);
  });

  return app;
}

// Startup order: configuration, migrations of Core and then of Säckel, the currency of the
// records, first-run state, the dummy password hash, and only then the HTTP port.
// Any failure before listen is logged and ends the process with exit code 1.
async function start(): Promise<void> {
  const corePassword = process.env.HOF_CORE_DB_PASSWORD;
  const saeckelPassword = process.env.HOF_SAECKEL_DB_PASSWORD;
  for (const [name, value] of [
    ['HOF_CORE_DB_PASSWORD', corePassword],
    ['HOF_SAECKEL_DB_PASSWORD', saeckelPassword],
  ] as const) {
    if (!value) {
      log('error', 'startup_failed', { error: `${name} is not set (see .env.example)` });
      process.exitCode = 1;
      return;
    }
  }
  // §5.6, §9: the currency and the time zone of the installation, checked before the database.
  const currency = process.env.CURRENCY;
  const timeZone = process.env.TZ;
  const settingsError = currencyError(currency) ?? timeZoneError(timeZone);
  if (settingsError !== null) {
    log('error', 'startup_failed', { error: settingsError });
    process.exitCode = 1;
    return;
  }
  const saeckelSettings: SaeckelSettings = { currency: currency!, timeZone: timeZone! };

  // Host and port come from the standard PGHOST and PGPORT that the pg driver reads itself;
  // without them it connects to localhost:5432. Each module has its own pool under its own
  // role (§2, §5).
  const corePool = new Pool({ database: DATABASE, user: CORE_DB_ROLE, password: corePassword });
  const saeckelPool = new Pool({
    database: DATABASE,
    user: SAECKEL_DB_ROLE,
    password: saeckelPassword,
  });
  // Before the first connection: a broken one must not end the process (§4.10).
  handleConnectionErrors(corePool);
  handleConnectionErrors(saeckelPool);

  let applied: string[];
  let firstRun: FirstRun;
  let dummyPasswordHash: string;
  try {
    // Each module's migrations under its own role; the file names say which module they are.
    const core = await migrate(corePool, CORE_MIGRATIONS);
    const saeckel = await migrate(saeckelPool, SAECKEL_MIGRATIONS);
    applied = [...core.map((name) => `core/${name}`), ...saeckel.map((name) => `saeckel/${name}`)];
    // §5.6: the first record fixes the currency; another one in .env would change what every
    // amount means, so the server does not start.
    const recorded = await otherRecordedCurrency(saeckelPool, saeckelSettings.currency);
    if (recorded !== null) {
      throw new Error(
        `в .env CURRENCY=${saeckelSettings.currency}, а записи Säckel в ${recorded}; смена валюты не поддерживается`,
      );
    }
    // Until the court is founded, this writes the gate key to the log.
    firstRun = await startFirstRun(corePool);
    dummyPasswordHash = await newDummyPasswordHash();
  } catch (error) {
    log('error', 'startup_failed', { error: describeError(error) });
    await Promise.all([corePool.end(), saeckelPool.end()]);
    process.exitCode = 1;
    return;
  }

  const app = createApp(corePool, saeckelPool, saeckelSettings, firstRun, dummyPasswordHash);
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    log('info', 'start', { port: info.port, migrations: applied.join(',') || 'none' });
  });
}

if (import.meta.main) {
  await start();
}
