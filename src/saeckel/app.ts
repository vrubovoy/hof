// Säckel routes (ARCHITECTURE.md §2, §4.1, §6): a budget by pouches.
//
// Säckel knows nothing of Core. From main.ts it gets its own pool (role hof_saeckel, schema
// saeckel) and one function: who is signed in, as { id, username }. Every query of a pouch is
// bound to that user's id; the administrator is an ordinary user here.
//
// Each route of Säckel checks the session itself, before its path, its form or any query of
// Säckel. Paths that are not routes of Säckel end in the common 404, with or without a session.

import { Hono, type MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { DatabaseError, type Pool } from 'pg';

// Who is signed in, from Core through main.ts: the id and the login, nothing more.
export interface SaeckelUser {
  id: number;
  username: string;
}

export type CurrentUser = (request: Request) => Promise<SaeckelUser | null>;

type SaeckelEnv = { Variables: { user: SaeckelUser } };

// §4.7: the largest id of a PostgreSQL integer.
const MAX_ID = 2_147_483_647;

// SQLSTATE of a unique violation.
const UNIQUE_VIOLATION = '23505';

const NAME_ERROR = 'Название — от 1 до 50 символов, одной строкой.';

interface Pouch {
  id: number;
  name: string;
}

interface NewPouchForm {
  name: string;
  error?: string;
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

// The form of a new pouch: the name only. The sign is the default one (§6, SaeckelEmpty).
function newPouchForm(form: NewPouchForm) {
  const describedBy =
    form.error === undefined ? '' : html`aria-invalid="true" aria-describedby="name-error"`;
  return html`<form method="post" action="/saeckel/pouches/new">
    <p>
      <label for="name">Название</label>
      <input id="name" name="name" type="text" required value="${form.name}" ${describedBy} />
    </p>
    ${form.error === undefined ? '' : html`<p id="name-error">${form.error}</p>`}
    <button type="submit">Завести мешок</button>
  </form>`;
}

// Мешки, texts from design/preview/Saeckel.html and SaeckelEmpty.html. The parts of M6 — the
// treasury, income, laying out, «Летопись» — come with what they do.
function pouchesPage(pouches: readonly Pouch[]) {
  return page(
    'Säckel — мешки',
    html`<nav><a href="/">← Двор</a></nav>
      <h1>Säckel</h1>
      <nav><a href="/saeckel/" aria-current="page">Мешки</a></nav>
      ${
        pouches.length === 0
          ? html`<h2>Мешков пока нет</h2>
              <p>
                Заведите первый мешок: «Продукты», «Квартира», «Транспорт». Траты берутся из мешка,
                а остаток переходит дальше сам.
              </p>
              ${newPouchForm({ name: '' })}`
          : html`<ul>
                ${pouches.map(
                  (pouch) =>
                    html`<li><a href="/saeckel/pouches/${pouch.id}">${pouch.name}</a></li>`,
                )}
              </ul>
              <p><a href="/saeckel/pouches/new">+ Новый мешок</a></p>`
      }`,
  );
}

function newPouchPage(form: NewPouchForm) {
  return page(
    'Säckel — новый мешок',
    html`<p><a href="/saeckel/">Мешки</a></p>
      <h1>Новый мешок</h1>
      ${newPouchForm(form)}`,
  );
}

function pouchPage(pouch: Pouch) {
  return page(
    `Säckel — ${pouch.name}`,
    html`<p><a href="/saeckel/">Мешки</a></p>
      <h1>${pouch.name}</h1>`,
  );
}

// §4.7: a pouch name — NFC, trimmed, 1–50 code points, one line: no control characters. The
// CHECK on pouches.name is the second line.
function parsePouchName(input: string): string | null {
  const name = input.normalize('NFC').trim();
  const length = [...name].length;
  if (length < 1 || length > 50 || /[\u0000-\u001F\u007F]/.test(name)) return null;
  return name;
}

// §4.7: an id from the path — digits without a leading zero, at most MAX_ID — or null. A copy of
// the rule Core uses, not an import (§2).
function parseId(input: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(input)) return null;
  const id = Number(input);
  return id <= MAX_ID ? id : null;
}

// §4.6: without a session, GET and HEAD come back to the same address after sign-in, any other
// method goes to /login without it. /login decides whether `next` is a safe local path.
function loginLocation(method: string, requestUrl: string): string {
  if (method !== 'GET' && method !== 'HEAD') return '/login';
  const url = new URL(requestUrl);
  return `/login?next=${encodeURIComponent(url.pathname + url.search)}`;
}

export function createSaeckelApp(pool: Pool, currentUser: CurrentUser): Hono<SaeckelEnv> {
  const saeckel = new Hono<SaeckelEnv>();

  // A signed-in user or the way to /login. Put on each route, not on /saeckel/*: an address
  // that is not a route stays the common 404 for everyone.
  const signedIn: MiddlewareHandler<SaeckelEnv> = async (c, next) => {
    const user = await currentUser(c.req.raw);
    if (user === null) return c.redirect(loginLocation(c.req.method, c.req.url), 303);
    c.set('user', user);
    await next();
  };

  // The pouch of the :id in the path, if it is the user's: no such pouch, a wrong id and the
  // pouch of somebody else are all null, and the caller answers the same 404.
  async function findPouch(idInPath: string, userId: number): Promise<Pouch | null> {
    const id = parseId(idInPath);
    if (id === null) return null;
    const { rows } = await pool.query<Pouch>(
      'SELECT id, name FROM pouches WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return rows[0] ?? null;
  }

  // Мешки: the active pouches of this user, in the order they were made.
  saeckel.get('/saeckel/', signedIn, async (c) => {
    const { rows } = await pool.query<Pouch>(
      'SELECT id, name FROM pouches WHERE user_id = $1 AND NOT is_archived ORDER BY id',
      [c.get('user').id],
    );
    return c.html(pouchesPage(rows));
  });

  // Registered before /saeckel/pouches/:id, which would match it too.
  saeckel.get('/saeckel/pouches/new', signedIn, (c) => c.html(newPouchPage({ name: '' })));

  // A new pouch: the name only, the sign by default. The user is the one signed in; a user_id
  // or any other field in the form is ignored.
  saeckel.post('/saeckel/pouches/new', signedIn, async (c) => {
    const form = await c.req.parseBody();
    const typed = typeof form.name === 'string' ? form.name : '';
    const name = parsePouchName(typed);
    if (name === null) return c.html(newPouchPage({ name: typed, error: NAME_ERROR }), 400);

    // One statement, so no transaction of our own. Two pouches of one name at once are
    // settled by the unique index: the second INSERT waits for the first to commit and then
    // fails on pouches_active_name. That one violation is the expected «taken»; any other
    // error, another unique index included, is unexpected and goes to onError in main.ts (500).
    let id: number;
    try {
      const { rows } = await pool.query<{ id: number }>(
        'INSERT INTO pouches (user_id, name) VALUES ($1, $2) RETURNING id',
        [c.get('user').id, name],
      );
      id = rows[0]!.id;
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.code === UNIQUE_VIOLATION &&
        error.constraint === 'pouches_active_name'
      ) {
        return c.html(
          newPouchPage({ name: typed, error: 'Мешок с таким названием уже есть.' }),
          400,
        );
      }
      throw error;
    }
    return c.redirect(`/saeckel/pouches/${id}`, 303);
  });

  saeckel.get('/saeckel/pouches/:id', signedIn, async (c) => {
    const pouch = await findPouch(c.req.param('id'), c.get('user').id);
    if (pouch === null) return c.notFound();
    return c.html(pouchPage(pouch));
  });

  return saeckel;
}
