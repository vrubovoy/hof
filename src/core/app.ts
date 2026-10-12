// Core routes (ARCHITECTURE.md §4.1): founding the court and the courtyard.
//
// Order inside Core, after the common checks and the first-run gate in main.ts:
//   1. /setup has its own rules before and after founding;
//   2. public paths (/login) need no session — there is no /login route yet, so it is a 404;
//   3. the known protected paths need a signed-in user;
//   4. anything else is not a Core route and ends in the common 404.

import { Hono } from 'hono';
import { html } from 'hono/html';
import { parse as parseCookies } from 'hono/utils/cookie';
import type { HtmlEscapedString } from 'hono/utils/html';
import { DatabaseError, type Pool } from 'pg';
import { log } from '../log.ts';
import type { FirstRun } from './gate-key.ts';
import { hashPassword, newPasswordError, PASSWORD_MIN_LENGTH } from './password.ts';
import {
  createSession,
  currentUser,
  SESSION_COOKIE,
  sessionCookie,
  type CurrentUser,
} from './sessions.ts';

// One entry of «Службы двора» on the courtyard.
export interface Service {
  name: string;
  path: string;
}

type CoreEnv = { Variables: { user: CurrentUser } };

// Core paths that need a signed-in user, for every method. /login is public and not here.
const PROTECTED_PATHS = ['/'];

type SetupField = 'code' | 'username' | 'password' | 'password2';

interface SetupForm {
  username: string;
  error?: { field: SetupField; text: string };
}

function page(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  return html`<!doctype html>
    <html lang="ru">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
      </head>
      <body>
        ${body}
      </body>
    </html>`;
}

// Texts from design/preview/Setup.html. The gate key and the passwords are never written back
// into the page; the login is, as typed.
function setupPage(form: SetupForm) {
  const describedBy = (field: SetupField, hint: string) =>
    form.error?.field === field
      ? html`aria-invalid="true" aria-describedby="${hint} ${field}-error"`
      : html`aria-describedby="${hint}"`;
  const error = (field: SetupField) =>
    form.error?.field === field ? html`<p id="${field}-error">${form.error.text}</p>` : '';

  return page(
    'Hof — основание двора',
    html`<h1>Основание двора</h1>
      <p>Станьте хозяином двора: вы принимаете приближённых и присматриваете за Hof.</p>
      <form method="post" action="/setup">
        <p>
          <label for="code">Ключ от ворот</label>
          <input
            id="code"
            name="code"
            type="text"
            autocomplete="off"
            required
            ${describedBy('code', 'code-hint')}
          />
        </p>
        <p id="code-hint">Одноразовый код из лога сервера: <code>docker compose logs hof</code></p>
        ${error('code')}
        <p>
          <label for="username">Логин</label>
          <input
            id="username"
            name="username"
            type="text"
            autocomplete="username"
            required
            value="${form.username}"
            ${describedBy('username', 'username-hint')}
          />
        </p>
        <p id="username-hint">Латиница, цифры, точка, дефис и подчёркивание, до 32 символов.</p>
        ${error('username')}
        <p>
          <label for="password">Пароль</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="new-password"
            required
            ${describedBy('password', 'password-hint')}
          />
        </p>
        <p id="password-hint">Не короче ${PASSWORD_MIN_LENGTH} символов.</p>
        ${error('password')}
        <p>
          <label for="password2">Пароль ещё раз</label>
          <input
            id="password2"
            name="password2"
            type="password"
            autocomplete="new-password"
            required
            ${describedBy('password2', 'password-hint')}
          />
        </p>
        ${error('password2')}
        <button type="submit">Основать двор</button>
      </form>`,
  );
}

// Minimal courtyard: the place, the services of this installation, who is signed in.
function courtyardPage(user: CurrentUser, services: readonly Service[]) {
  return page(
    'Hof — двор',
    html`<h1>Двор</h1>
      <p>${user.username}</p>
      <h2>Службы двора</h2>
      <ul>
        ${services.map((service) => html`<li><a href="${service.path}">${service.name}</a></li>`)}
      </ul>`,
  );
}

// §4.7: trimmed and lower-cased; a letter or digit first, then letters, digits, ".", "_", "-";
// at most 32 characters. The same rule as the CHECK on users.username.
function parseUsername(input: string): string | null {
  const username = input.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(username) ? username : null;
}

// §4.6: without a session, GET and HEAD come back to the same address after sign-in, any other
// method goes to /login without it. The address only travels URL-encoded inside the query;
// /login will decide whether it is a safe local path. Location is always relative.
function loginLocation(method: string, requestUrl: string): string {
  if (method !== 'GET' && method !== 'HEAD') return '/login';
  const url = new URL(requestUrl);
  return `/login?next=${encodeURIComponent(url.pathname + url.search)}`;
}

// The session cookie from the Cookie header, if there is one.
function sessionToken(cookieHeader: string | undefined): string | undefined {
  return cookieHeader === undefined ? undefined : parseCookies(cookieHeader)[SESSION_COOKIE];
}

export function createCoreApp(
  pool: Pool,
  firstRun: FirstRun,
  services: readonly Service[],
): Hono<CoreEnv> {
  const core = new Hono<CoreEnv>();

  // 1. Founding the court (§4.4). After founding, GET is a 404 and POST goes to the courtyard
  //    without looking at the form or writing anything.
  core.get('/setup', async (c) => {
    if (await firstRun.isFounded()) return c.notFound();
    return c.html(setupPage({ username: '' }));
  });

  core.post('/setup', async (c) => {
    if (await firstRun.isFounded()) return c.redirect('/', 303);

    const form = await c.req.parseBody();
    const text = (name: SetupField) => {
      const value = form[name];
      return typeof value === 'string' ? value : '';
    };
    const typedUsername = text('username');
    const refuse = (field: SetupField, message: string) =>
      c.html(setupPage({ username: typedUsername, error: { field, text: message } }), 400);

    // The key first: without it nothing else is looked at and Argon2 does not run.
    if (!firstRun.keyMatches(text('code'))) {
      // §4.10: no typed value in the log. The IP comes from X-Real-IP, which nginx always
      // overwrites; it is only written down, never used for a decision.
      log('warn', 'gate_key_rejected', { ip: c.req.header('X-Real-IP') ?? '-' });
      return refuse('code', 'Ключ от ворот не подходит.');
    }
    const username = parseUsername(typedUsername);
    if (username === null) {
      return refuse(
        'username',
        'Логин: латиница, цифры, точка, дефис и подчёркивание, до 32 символов, первый символ — буква или цифра.',
      );
    }
    const password = text('password');
    const passwordError = newPasswordError(password);
    if (passwordError !== null) return refuse('password', `${passwordError}.`);
    if (password !== text('password2')) return refuse('password2', 'Пароли не совпадают.');

    // Argon2 takes tens of milliseconds: it runs before the transaction, so no row lock
    // and no connection are held while it computes.
    const passwordHash = await hashPassword(password);

    // The administrator and the session in one transaction (§4.4, §4.8).
    let userId: number;
    let token: string;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: number }>(
        'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, true) RETURNING id',
        [username, passwordHash],
      );
      userId = rows[0]!.id;
      token = await createSession(client, userId);
      await client.query('COMMIT');
    } catch (error) {
      // The connection may already be broken; the original error matters more.
      await client.query('ROLLBACK').catch(() => undefined);
      // Two submissions with the right key at once: the unique index on the administrator
      // lets one through. The other one is not an error, the court is simply founded.
      if (error instanceof DatabaseError && error.constraint === 'users_one_admin') {
        return c.redirect('/', 303);
      }
      throw error;
    } finally {
      client.release();
    }

    // Only after COMMIT: the court counts as founded and the key is destroyed. A failure
    // above leaves both as they were, so the same key can be tried again.
    firstRun.markFounded();
    c.header('Set-Cookie', sessionCookie(token));
    log('info', 'court_founded', {
      user_id: userId,
      username,
      ip: c.req.header('X-Real-IP') ?? '-',
    });
    return c.redirect('/', 303);
  });

  // 2. Public paths: /login needs no session. Nothing is registered for it yet.

  // 3. Protected paths: a signed-in user or the way to /login.
  for (const path of PROTECTED_PATHS) {
    core.use(path, async (c, next) => {
      const user = await currentUser(pool, sessionToken(c.req.header('Cookie')));
      if (user === null) return c.redirect(loginLocation(c.req.method, c.req.url), 303);
      c.set('user', user);
      await next();
    });
  }

  core.get('/', (c) => c.html(courtyardPage(c.get('user'), services)));

  return core;
}
