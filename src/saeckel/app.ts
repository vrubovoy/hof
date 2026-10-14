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
const TAKEN_ERROR = 'Мешок с таким названием уже есть.';
const ICON_ERROR = 'Выберите знак из списка.';

// The signs of a pouch (§5.4, design/preview/PouchEditMobile.html): the key kept in
// pouches.icon and its label. Only these keys are accepted; a stored key the set does not know
// is shown as the default one.
const ICONS = {
  pouch: 'мешок',
  cart: 'повозка',
  basket: 'корзина',
  hearth: 'очаг',
  jug: 'кувшин',
  mortar: 'ступка',
  needle: 'игла',
  lute: 'лютня',
  bundle: 'свёрток',
  scroll: 'свиток',
  pot: 'кубышка',
  toyhorse: 'лошадка',
  bowl: 'миска',
  hammer: 'молоток',
  books: 'книги',
  bag: 'котомка',
  comb: 'гребень',
} as const;

type Icon = keyof typeof ICONS;

const DEFAULT_ICON: Icon = 'pouch';

interface Pouch {
  id: number;
  name: string;
  icon: string;
  is_archived: boolean;
}

interface FormError {
  field: 'name' | 'icon';
  text: string;
}

interface NewPouchForm {
  name: string;
  error?: FormError;
}

interface EditPouchForm {
  name: string;
  // The sign to show as chosen; none after an unknown one was sent.
  icon: Icon | null;
  error?: FormError;
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

// The error of a form, under its field.
function formError(error: FormError | undefined, field: FormError['field']) {
  return error?.field === field ? html`<p id="${field}-error">${error.text}</p>` : '';
}

// The name field of both forms of a pouch.
function nameField(name: string, error: FormError | undefined) {
  const describedBy =
    error?.field === 'name' ? html`aria-invalid="true" aria-describedby="name-error"` : '';
  return html`<p>
      <label for="name">Название</label>
      <input id="name" name="name" type="text" required value="${name}" ${describedBy} />
    </p>
    ${formError(error, 'name')}`;
}

// The form of a new pouch: the name only. The sign is the default one (§6, SaeckelEmpty); a
// sign sent anyway is checked like in «Изменить».
function newPouchForm(form: NewPouchForm) {
  return html`<form method="post" action="/saeckel/pouches/new">
    ${nameField(form.name, form.error)} ${formError(form.error, 'icon')}
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
              ${newPouchForm({ name: '' })}
              <p>Знак мешка можно выбрать потом, в «Изменить».</p>`
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

// A pouch in the storeroom has no «Изменить»: it is brought back first.
function pouchPage(pouch: Pouch) {
  return page(
    `Säckel — ${pouch.name}`,
    html`<p><a href="/saeckel/">Мешки</a></p>
      <h1>${pouch.name}</h1>
      ${
        pouch.is_archived
          ? ''
          : html`<p><a href="/saeckel/pouches/${pouch.id}/edit">Изменить</a></p>`
      }`,
  );
}

// «Изменить», texts from design/preview/PouchEditMobile.html: the name and the sign. The
// heading keeps the stored name; the fields show what was typed and chosen.
function editPouchPage(pouch: Pouch, form: EditPouchForm) {
  const describedBy = form.error?.field === 'icon' ? html`aria-describedby="icon-error"` : '';
  return page(
    `Säckel — ${pouch.name}`,
    html`<p><a href="/saeckel/pouches/${pouch.id}">${pouch.name}</a></p>
      <h1>Мешок «${pouch.name}»</h1>
      <form method="post" action="/saeckel/pouches/${pouch.id}/edit">
        ${nameField(form.name, form.error)}
        <fieldset ${describedBy}>
          <legend>Знак мешка</legend>
          ${(Object.keys(ICONS) as Icon[]).map(
            (icon) =>
              html`<label>
                <input
                  type="radio"
                  name="icon"
                  value="${icon}"
                  ${icon === form.icon ? html`checked` : ''}
                />
                ${ICONS[icon]}
              </label>`,
          )}
        </fieldset>
        ${formError(form.error, 'icon')}
        <button type="submit">Сохранить</button>
      </form>`,
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

// §4.7: a sign — a key of the set, or null. A form field that is not text is no sign either.
function parseIcon(input: unknown): Icon | null {
  return typeof input === 'string' && Object.hasOwn(ICONS, input) ? (input as Icon) : null;
}

// §4.7: an id from the path — digits without a leading zero, at most MAX_ID — or null. A copy of
// the rule Core uses, not an import (§2).
function parseId(input: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(input)) return null;
  const id = Number(input);
  return id <= MAX_ID ? id : null;
}

// The one refusal of the database a form expects: another active pouch of this user has the
// name (the partial unique index). Any other error, another unique index included, is
// unexpected and goes on to onError in main.ts (500).
function isNameTaken(error: unknown): boolean {
  return (
    error instanceof DatabaseError &&
    error.code === UNIQUE_VIOLATION &&
    error.constraint === 'pouches_active_name'
  );
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
      'SELECT id, name, icon, is_archived FROM pouches WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return rows[0] ?? null;
  }

  // Мешки: the active pouches of this user, in the order they were made.
  saeckel.get('/saeckel/', signedIn, async (c) => {
    const { rows } = await pool.query<Pouch>(
      'SELECT id, name, icon, is_archived FROM pouches WHERE user_id = $1 AND NOT is_archived ORDER BY id',
      [c.get('user').id],
    );
    return c.html(pouchesPage(rows));
  });

  // Registered before /saeckel/pouches/:id, which would match it too.
  saeckel.get('/saeckel/pouches/new', signedIn, (c) => c.html(newPouchPage({ name: '' })));

  // A new pouch: the name, and the sign only if one is sent (§4.1); the form itself has the
  // name only. The user is the one signed in; a user_id or any other field is ignored.
  saeckel.post('/saeckel/pouches/new', signedIn, async (c) => {
    const form = await c.req.parseBody();
    const typed = typeof form.name === 'string' ? form.name : '';
    const refuse = (error: FormError) => c.html(newPouchPage({ name: typed, error }), 400);
    const name = parsePouchName(typed);
    if (name === null) return refuse({ field: 'name', text: NAME_ERROR });
    const icon = form.icon === undefined ? DEFAULT_ICON : parseIcon(form.icon);
    if (icon === null) return refuse({ field: 'icon', text: ICON_ERROR });

    // One statement, so no transaction of our own. Two pouches of one name at once are
    // settled by the unique index: the second INSERT waits for the first to commit and then
    // fails on pouches_active_name.
    let id: number;
    try {
      const { rows } = await pool.query<{ id: number }>(
        'INSERT INTO pouches (user_id, name, icon) VALUES ($1, $2, $3) RETURNING id',
        [c.get('user').id, name, icon],
      );
      id = rows[0]!.id;
    } catch (error) {
      if (isNameTaken(error)) return refuse({ field: 'name', text: TAKEN_ERROR });
      throw error;
    }
    return c.redirect(`/saeckel/pouches/${id}`, 303);
  });

  saeckel.get('/saeckel/pouches/:id', signedIn, async (c) => {
    const pouch = await findPouch(c.req.param('id'), c.get('user').id);
    if (pouch === null) return c.notFound();
    return c.html(pouchPage(pouch));
  });

  // «Изменить»: only an active pouch of this user. A pouch in the storeroom is the same 404 as
  // somebody else's: it is brought back first. A stored key the set does not know shows as
  // the default sign.
  saeckel.get('/saeckel/pouches/:id/edit', signedIn, async (c) => {
    const pouch = await findPouch(c.req.param('id'), c.get('user').id);
    if (pouch === null || pouch.is_archived) return c.notFound();
    const icon = parseIcon(pouch.icon) ?? DEFAULT_ICON;
    return c.html(editPouchPage(pouch, { name: pouch.name, icon }));
  });

  // The pouch first, then the form, then one UPDATE. The UPDATE checks the user and the
  // storeroom again: the pouch may have gone into the storeroom since it was looked up.
  saeckel.post('/saeckel/pouches/:id/edit', signedIn, async (c) => {
    const userId = c.get('user').id;
    const pouch = await findPouch(c.req.param('id'), userId);
    if (pouch === null || pouch.is_archived) return c.notFound();

    const form = await c.req.parseBody();
    const typed = typeof form.name === 'string' ? form.name : '';
    const icon = parseIcon(form.icon);
    const refuse = (error: FormError) =>
      c.html(editPouchPage(pouch, { name: typed, icon, error }), 400);
    const name = parsePouchName(typed);
    if (name === null) return refuse({ field: 'name', text: NAME_ERROR });
    if (icon === null) return refuse({ field: 'icon', text: ICON_ERROR });

    // One statement, so no transaction of our own. A name taken by another active pouch,
    // or by one being made at this moment, is settled by the unique index; renaming a pouch to
    // its own name in another case is not a conflict.
    let updated: number;
    try {
      const { rowCount } = await pool.query(
        'UPDATE pouches SET name = $1, icon = $2 WHERE id = $3 AND user_id = $4 AND NOT is_archived RETURNING id',
        [name, icon, pouch.id, userId],
      );
      updated = rowCount ?? 0;
    } catch (error) {
      if (isNameTaken(error)) return refuse({ field: 'name', text: TAKEN_ERROR });
      throw error;
    }
    if (updated === 0) return c.notFound();
    return c.redirect(`/saeckel/pouches/${pouch.id}`, 303);
  });

  return saeckel;
}
