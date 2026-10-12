// Core routes (ARCHITECTURE.md §4.1): founding the court, signing in and out, the courtyard,
// my chambers and the change of one's own password.
//
// Order inside Core, after the common checks and the first-run gate in main.ts:
//   1. /setup has its own rules before and after founding;
//   2. public paths (/login, /logout) need no session;
//   3. the known protected paths need a signed-in user;
//   4. anything else is not a Core route and ends in the common 404.

import { Hono } from 'hono';
import { html } from 'hono/html';
import { parse as parseCookies } from 'hono/utils/cookie';
import type { HtmlEscapedString } from 'hono/utils/html';
import { DatabaseError, type Pool } from 'pg';
import { log } from '../log.ts';
import type { FirstRun } from './gate-key.ts';
import {
  hashPassword,
  newPasswordError,
  normalizePassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordLength,
  verifyPassword,
} from './password.ts';
import {
  CLEARED_SESSION_COOKIE,
  createSession,
  currentUser,
  deleteSession,
  SESSION_COOKIE,
  sessionCookie,
  type CurrentUser,
} from './sessions.ts';
import { parseUsername } from './username.ts';

// One entry of «Службы двора» on the courtyard.
export interface Service {
  name: string;
  path: string;
}

type CoreEnv = { Variables: { user: CurrentUser } };

// Core paths that need a signed-in user, for every method. /login and /logout are public and
// not here.
const PROTECTED_PATHS = ['/', '/account', '/account/password'];

type SetupField = 'code' | 'username' | 'password' | 'password2';

interface SetupForm {
  username: string;
  error?: { field: SetupField; text: string };
}

type PasswordField = 'current' | 'password' | 'password2';

interface AccountForm {
  done: boolean;
  error?: { field: PasswordField; text: string };
}

interface LoginForm {
  username: string;
  next: string;
  failed: boolean;
}

// Why a sign-in of an existing user was refused; written to the log only (§4.10).
type LoginFailure = 'wrong_password' | 'disabled' | 'password_changed';

interface LoginUser {
  id: number;
  password_hash: string;
  is_disabled: boolean;
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

// Texts from design/preview/DemoLogin.html. One error for every refusal, so the page does not
// tell whether the login exists. The login is written back as typed, the password never.
function loginPage(form: LoginForm) {
  const describedBy = form.failed ? html`aria-describedby="login-error"` : '';
  return page(
    'Hof — вход',
    html`<h1>С возвращением во двор!</h1>
      <form method="post" action="/login">
        ${form.failed ? html`<p id="login-error">Неверный логин или пароль.</p>` : ''}
        <input type="hidden" name="next" value="${form.next}" />
        <p>
          <label for="username">Логин</label>
          <input
            id="username"
            name="username"
            type="text"
            autocomplete="username"
            required
            value="${form.username}"
            ${describedBy}
          />
        </p>
        <p>
          <label for="password">Пароль</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            ${describedBy}
          />
        </p>
        <button type="submit">Войти во двор</button>
      </form>
      <p>Нет ключа или забыли пароль? Обратитесь к хозяину двора.</p>`,
  );
}

// Minimal courtyard: the place, the services of this installation, who is signed in, the way out.
function courtyardPage(user: CurrentUser, services: readonly Service[]) {
  return page(
    'Hof — двор',
    html`<nav><a href="/account">Мои покои</a></nav>
      <h1>Двор</h1>
      <p>${user.username}</p>
      <h2>Службы двора</h2>
      <ul>
        ${services.map((service) => html`<li><a href="${service.path}">${service.name}</a></li>`)}
      </ul>
      <form method="post" action="/logout">
        <button type="submit">Покинуть двор</button>
      </form>`,
  );
}

// Texts from design/preview/Account.html: who is signed in, the change of the password, the way
// out. The «Звуки и движение» block comes with the effects (M10). No password is ever written
// back into the page.
function accountPage(user: CurrentUser, form: AccountForm) {
  const describedBy = (field: PasswordField, hint?: string) => {
    const ids = [hint, form.error?.field === field ? `${field}-error` : undefined].filter(Boolean);
    const invalid = form.error?.field === field ? html`aria-invalid="true"` : '';
    return ids.length > 0 ? html`${invalid} aria-describedby="${ids.join(' ')}"` : invalid;
  };
  const error = (field: PasswordField) =>
    form.error?.field === field ? html`<p id="${field}-error">${form.error.text}</p>` : '';

  return page(
    'Hof — мои покои',
    html`<nav><a href="/">Двор</a></nav>
      <h1>Мои покои</h1>
      <p>${user.isAdmin ? `${user.username} · хозяин двора` : user.username}</p>
      ${form.done ? html`<p>Пароль сменён.</p>` : ''}
      <h2>Сменить пароль</h2>
      <form method="post" action="/account/password">
        <p>
          <label for="current">Текущий пароль</label>
          <input
            id="current"
            name="current"
            type="password"
            autocomplete="current-password"
            required
            ${describedBy('current')}
          />
        </p>
        ${error('current')}
        <p>
          <label for="password">Новый пароль</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="new-password"
            required
            ${describedBy('password', 'password-hint')}
          />
        </p>
        ${error('password')}
        <p>
          <label for="password2">Ещё раз</label>
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
        <p id="password-hint">
          Не короче ${PASSWORD_MIN_LENGTH} символов. На других устройствах вы выйдете со двора.
        </p>
        <button type="submit">Сменить пароль</button>
      </form>
      <form method="post" action="/logout">
        <button type="submit" aria-describedby="logout-hint">Покинуть двор</button>
      </form>
      <p id="logout-hint">на этом устройстве; всё во дворе останется на месте</p>`,
  );
}

// §4.6: the only addresses sign-in sends a person back to — a local path. "/" first; then not
// "/" or "\", so "//host" and "/\host" cannot become another site; then printable ASCII from
// "!" to "~" without "\" (\x5C), so no spaces or control characters a browser would strip;
// 512 characters at most. Anything else, or nothing, is "/". The one rule for GET and POST.
function safeNext(input: string | undefined): string {
  return input !== undefined && /^\/(?![/\\])[\x21-\x5B\x5D-\x7E]{0,511}$/.test(input)
    ? input
    : '/';
}

// §4.6: without a session, GET and HEAD come back to the same address after sign-in, any other
// method goes to /login without it. The address only travels URL-encoded inside the query;
// /login decides with safeNext whether it is a safe local path. Location is always relative.
function loginLocation(method: string, requestUrl: string): string {
  if (method !== 'GET' && method !== 'HEAD') return '/login';
  const url = new URL(requestUrl);
  return `/login?next=${encodeURIComponent(url.pathname + url.search)}`;
}

// The session cookie from the Cookie header, if there is one.
function sessionToken(cookieHeader: string | undefined): string | undefined {
  return cookieHeader === undefined ? undefined : parseCookies(cookieHeader)[SESSION_COOKIE];
}

// dummyPasswordHash: made at startup with the current profile from a password nobody knows;
// an unknown login is checked against it (§4.3).
export function createCoreApp(
  pool: Pool,
  firstRun: FirstRun,
  dummyPasswordHash: string,
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
    // Compared as one password, after NFKC: two Unicode forms of "й" are the same password.
    if (normalizePassword(password) !== normalizePassword(text('password2'))) {
      return refuse('password2', 'Пароли не совпадают.');
    }

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

  // 2. Public paths.

  // Sign-in page. With a live session there is nothing to sign in to: straight on to `next`.
  core.get('/login', async (c) => {
    const next = safeNext(c.req.query('next'));
    if ((await currentUser(pool, sessionToken(c.req.header('Cookie')))) !== null) {
      return c.redirect(next, 303);
    }
    return c.html(loginPage({ username: '', next, failed: false }));
  });

  // Sign-in (§4.2, §4.3, §4.8). Every refusal gets the same answer, and every refusal that
  // depends on the database costs exactly one Argon2: neither the page nor the time tells
  // whether the login exists.
  core.post('/login', async (c) => {
    const form = await c.req.parseBody();
    const text = (name: 'username' | 'password' | 'next') => {
      const value = form[name];
      return typeof value === 'string' ? value : '';
    };
    const typedUsername = text('username');
    const password = text('password');
    const next = safeNext(text('next'));
    const ip = c.req.header('X-Real-IP') ?? '-';

    const refuse = () => c.html(loginPage({ username: typedUsername, next, failed: true }), 400);
    // §4.10: what was typed as the login of an unknown user is not written down — people
    // type their password into that field.
    const refuseUnknown = () => {
      log('warn', 'login_failed', { reason: 'unknown_user', ip });
      return refuse();
    };
    const refuseUser = (id: number, username: string, reason: LoginFailure) => {
      log('warn', 'login_failed', { user_id: id, username, ip, reason });
      return refuse();
    };

    // A login of the wrong form cannot exist. The refusal says nothing about real logins, so
    // neither the database nor Argon2 is asked.
    const username = parseUsername(typedUsername);
    if (username === null) return refuseUnknown();

    // Read without a lock: the lock is taken only after Argon2, inside the transaction.
    const { rows } = await pool.query<LoginUser>(
      'SELECT id, password_hash, is_disabled FROM users WHERE username = $1',
      [username],
    );
    const user = rows[0];

    // No stored password is longer than the maximum, so a longer one matches nothing.
    // Argon2 is skipped for known and unknown logins alike, so the time says nothing either.
    if (passwordLength(password) > PASSWORD_MAX_LENGTH) {
      return user === undefined ? refuseUnknown() : refuseUser(user.id, username, 'wrong_password');
    }

    if (user === undefined) {
      await verifyPassword(password, dummyPasswordHash);
      return refuseUnknown();
    }

    // Argon2 runs before the transaction, against the hash read above.
    const check = await verifyPassword(password, user.password_hash);
    if (check === 'unreadable') {
      // Not a 500: access comes back with a password reset (§4.3). The stored string was
      // rejected before Argon2 ran, so the dummy hash keeps the time of a real check.
      await verifyPassword(password, dummyPasswordHash);
      log('error', 'password_hash_unreadable', { user_id: user.id });
      return refuse();
    }
    if (check === 'wrong') return refuseUser(user.id, username, 'wrong_password');
    if (user.is_disabled) return refuseUser(user.id, username, 'disabled');

    // The checked password must still be the user's password, and the user still allowed in,
    // when the session is written. The row lock makes a reset or a disable either finish
    // before this check, or wait for this COMMIT and then delete the new session (§4.8).
    let token: string | null = null;
    let failure: LoginFailure = 'password_changed';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<Omit<LoginUser, 'id'>>(
        'SELECT password_hash, is_disabled FROM users WHERE id = $1 FOR UPDATE',
        [user.id],
      );
      // Users are never deleted (§5.2), so the row is there.
      const current = locked.rows[0]!;
      if (current.is_disabled || current.password_hash !== user.password_hash) {
        failure = current.is_disabled ? 'disabled' : 'password_changed';
        // Nothing has been written: no session is deleted or created.
        await client.query('ROLLBACK');
      } else {
        // Expired sessions of every user are deleted at each successful sign-in: no scheduler.
        await client.query('DELETE FROM sessions WHERE expires_at <= now()');
        // The session this browser had before is replaced, not kept beside the new one.
        await deleteSession(client, sessionToken(c.req.header('Cookie')));
        token = await createSession(client, user.id);
        await client.query('COMMIT');
      }
    } catch (error) {
      // The connection may already be broken; the original error matters more.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (token === null) return refuseUser(user.id, username, failure);

    c.header('Set-Cookie', sessionCookie(token));
    log('info', 'login', { user_id: user.id, username, ip });
    return c.redirect(next, 303);
  });

  // Sign-out ends only the session of this browser (§4.2). It needs no live session: without
  // one there is nothing to delete, and the cookie is cleared all the same. Origin is checked
  // in main.ts as for every POST, so another site cannot sign a person out.
  core.post('/logout', async (c) => {
    await deleteSession(pool, sessionToken(c.req.header('Cookie')));
    c.header('Set-Cookie', CLEARED_SESSION_COOKIE);
    return c.redirect('/login', 303);
  });

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

  // Мои покои. `done` is a flag from a fixed list; anything else is ignored (§4.1).
  core.get('/account', (c) =>
    c.html(accountPage(c.get('user'), { done: c.req.query('done') === 'password' })),
  );

  // Change of one's own password (§4.2, §4.3, §4.8). Every Argon2 runs before the transaction;
  // inside it the new hash, the end of every old session and the new session of this browser
  // are written together or not at all.
  core.post('/account/password', async (c) => {
    const user = c.get('user');
    const form = await c.req.parseBody();
    const text = (name: PasswordField) => {
      const value = form[name];
      return typeof value === 'string' ? value : '';
    };
    const refuse = (field: PasswordField, message: string) =>
      c.html(accountPage(user, { done: false, error: { field, text: message } }), 400);
    const wrongCurrent = () => refuse('current', 'Текущий пароль не подходит.');

    // The form first, without Argon2. Like at sign-in, only the maximum applies to the current
    // password: no stored password is longer, so a longer one matches nothing.
    const current = text('current');
    if (passwordLength(current) > PASSWORD_MAX_LENGTH) return wrongCurrent();
    const password = text('password');
    const passwordError = newPasswordError(password);
    if (passwordError !== null) return refuse('password', `${passwordError}.`);
    // Compared as one password, after NFKC: two Unicode forms of "й" are the same password.
    if (normalizePassword(password) !== normalizePassword(text('password2'))) {
      return refuse('password2', 'Пароли не совпадают.');
    }

    // The current password is checked against the hash read here, without a lock.
    const { rows } = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id],
    );
    // Users are never deleted (§5.2), so the row is there.
    const checkedHash = rows[0]!.password_hash;
    const check = await verifyPassword(current, checkedHash);
    if (check === 'unreadable') {
      // Not a 500, and the hash itself is not logged; access comes back with a reset (§4.3).
      log('error', 'password_hash_unreadable', { user_id: user.id });
      return wrongCurrent();
    }
    if (check === 'wrong') return wrongCurrent();

    // Only after the current password is confirmed, and still before the transaction.
    const passwordHash = await hashPassword(password);

    // The checked hash must still be the user's hash, and the user still allowed in. A reset,
    // a disable or a change from another device in between has already ended this user's
    // sessions; it is not overwritten, and this request is left without a session.
    let token: string | null = null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ password_hash: string; is_disabled: boolean }>(
        'SELECT password_hash, is_disabled FROM users WHERE id = $1 FOR UPDATE',
        [user.id],
      );
      const latest = locked.rows[0]!;
      if (latest.is_disabled || latest.password_hash !== checkedHash) {
        // Nothing has been written: the password, the sessions and the cookie stay as they are.
        await client.query('ROLLBACK');
      } else {
        // The hash first, then every session of the user — the one of this browser included —
        // then the new session of this browser.
        await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
          passwordHash,
          user.id,
        ]);
        await client.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
        token = await createSession(client, user.id);
        await client.query('COMMIT');
      }
    } catch (error) {
      // The connection may already be broken; the original error matters more.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (token === null) return c.redirect('/login', 303);

    c.header('Set-Cookie', sessionCookie(token));
    log('info', 'password_changed', {
      user_id: user.id,
      username: user.username,
      ip: c.req.header('X-Real-IP') ?? '-',
    });
    return c.redirect('/account?done=password', 303);
  });

  return core;
}
