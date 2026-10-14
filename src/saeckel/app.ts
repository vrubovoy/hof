// Säckel routes (ARCHITECTURE.md §2, §4.1, §6): a budget by pouches.
//
// Säckel knows nothing of Core. From main.ts it gets its own pool (role hof_saeckel, schema
// saeckel), one function — who is signed in, as { id, username } — and the checked settings
// of the installation: its currency and its time zone. Every query of a pouch or a record is
// bound to that user's id; the administrator is an ordinary user here.
//
// Each route of Säckel checks the session itself, before its path, its form or any query of
// Säckel. Paths that are not routes of Säckel end in the common 404, with or without a session.

import { Hono, type MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { DatabaseError, type Pool } from 'pg';
import { dateForField, dateForList, parseDate, today } from './dates.ts';
import { centsFrom, moneyFormat, parseAmount, type MoneyFormat } from './money.ts';

// Who is signed in, from Core through main.ts: the id and the login, nothing more.
export interface SaeckelUser {
  id: number;
  username: string;
}

export type CurrentUser = (request: Request) => Promise<SaeckelUser | null>;

// The settings of the installation, checked by main.ts at startup (§5.6, §9).
export interface SaeckelSettings {
  // ISO 4217 code with two decimal places: the unit of every amount.
  currency: string;
  // The time zone of «today».
  timeZone: string;
}

type SaeckelEnv = { Variables: { user: SaeckelUser } };

// §4.7: the largest id of a PostgreSQL integer.
const MAX_ID = 2_147_483_647;

// SQLSTATE of a unique violation.
const UNIQUE_VIOLATION = '23505';

const NAME_ERROR = 'Название — от 1 до 50 символов, одной строкой.';
const TAKEN_ERROR = 'Мешок с таким названием уже есть.';
const ICON_ERROR = 'Выберите знак из списка.';
const NOTE_ERROR = 'Заметка — до 200 символов, одной строкой.';
const ARCHIVED_ERROR = 'Мешок в Кладовой: траты в нём не записываются.';

// §4.7: text of a form is one line; PostgreSQL does not take \0 at all.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

// The expenses a pouch page shows; the whole history is «Летопись» (M6).
const RECENT_EXPENSES = 10;

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

// A pouch in the list of Мешки, with its balance and its last expense, in hundredths.
interface ListedPouch {
  id: number;
  name: string;
  balance: number;
  lastExpense: number | null;
}

// An expense as a pouch page lists it; the date is ISO text, the amount in hundredths.
interface Expense {
  id: number;
  cents: number;
  date: string;
  note: string;
}

type ExpenseField = 'amount' | 'date' | 'note';

// The form «Записать трату» as typed, with the error of each field it has.
interface ExpenseForm {
  amount: string;
  date: string;
  note: string;
  errors: Partial<Record<ExpenseField, string>>;
}

// What a pouch page shows besides the pouch itself.
interface PouchView {
  balance: number;
  expenses: readonly Expense[];
  // `fresh` as it came in the address: the record of that id, if it is among those shown, is
  // marked as just written.
  fresh?: string;
  form: ExpenseForm;
  // A refusal of the whole form rather than of one field.
  refusal?: string;
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

// What the list says under a pouch (design/preview/Saeckel.html): in debt, its last expense,
// or none yet.
function pouchNote(pouch: ListedPouch, money: MoneyFormat): string {
  if (pouch.balance < 0) return 'в долгу';
  if (pouch.lastExpense !== null) return `последняя трата ${money.format(-pouch.lastExpense)}`;
  return 'трат пока не было';
}

// Мешки, texts from design/preview/Saeckel.html and SaeckelEmpty.html. The parts of M6 — the
// treasury, income, laying out, «Летопись» — come with what they do.
function pouchesPage(pouches: readonly ListedPouch[], money: MoneyFormat) {
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
                    html`<li>
                      <a href="/saeckel/pouches/${pouch.id}">${pouch.name}</a> ·
                      ${money.format(pouch.balance)} · ${pouchNote(pouch, money)}
                    </li>`,
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

// The form «Записать трату» (design/preview/Saeckel.html, PouchMobile.html). What was typed
// stays in the fields; the error of a field is under it.
function expenseForm(pouch: Pouch, form: ExpenseForm, money: MoneyFormat) {
  const attributes = (field: ExpenseField) =>
    form.errors[field] === undefined
      ? ''
      : html`aria-invalid="true" aria-describedby="${field}-error"`;
  const error = (field: ExpenseField) =>
    form.errors[field] === undefined ? '' : html`<p id="${field}-error">${form.errors[field]}</p>`;
  return html`<h2>Записать трату</h2>
    <form method="post" action="/saeckel/pouches/${pouch.id}/expense">
      <p>
        <label for="amount">Сумма, ${money.symbol}</label>
        <input
          id="amount"
          name="amount"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          required
          value="${form.amount}"
          ${attributes('amount')}
        />
      </p>
      ${error('amount')}
      <p>
        <label for="date">Дата</label>
        <input id="date" name="date" type="text" value="${form.date}" ${attributes('date')} />
      </p>
      ${error('date')}
      <p>
        <label for="note">Заметка</label>
        <input id="note" name="note" type="text" value="${form.note}" ${attributes('note')} />
      </p>
      ${error('note')}
      <button type="submit">Записать трату</button>
    </form>`;
}

// One expense of the list: «ДД.ММ · заметка · −X», the note left out when there is none. The
// record just written is marked.
function expenseRow(expense: Expense, fresh: string | undefined, money: MoneyFormat) {
  const text = html`${dateForList(expense.date)}${
    expense.note === '' ? '' : html` · ${expense.note}`
  }
  · ${money.format(-expense.cents)}`;
  return html`<li>${String(expense.id) === fresh ? html`<mark>${text}</mark>` : text}</li>`;
}

// The pouch, its balance, the form of an expense and its last expenses. A pouch in the
// storeroom has neither «Изменить» nor the form: it is brought back first.
function pouchPage(pouch: Pouch, view: PouchView, money: MoneyFormat) {
  return page(
    `Säckel — ${pouch.name}`,
    html`<p><a href="/saeckel/">Мешки</a></p>
      <h1>${pouch.name}</h1>
      ${
        pouch.is_archived
          ? ''
          : html`<p><a href="/saeckel/pouches/${pouch.id}/edit">Изменить</a></p>`
      }
      <p>Остаток ${money.format(view.balance)}</p>
      ${view.refusal === undefined ? '' : html`<p id="expense-error">${view.refusal}</p>`}
      ${pouch.is_archived ? '' : expenseForm(pouch, view.form, money)}
      ${
        view.expenses.length === 0
          ? ''
          : html`<ul>
              ${view.expenses.map((expense) => expenseRow(expense, view.fresh, money))}
            </ul>`
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
  if (length < 1 || length > 50 || CONTROL_CHARACTERS.test(name)) return null;
  return name;
}

// §4.7: a note — NFC, trimmed, 0–200 code points, one line. The CHECK on operations.note is
// the second line.
function parseNote(input: string): string | null {
  const note = input.normalize('NFC').trim();
  if ([...note].length > 200 || CONTROL_CHARACTERS.test(note)) return null;
  return note;
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

// The balances of the active pouches of one user and the last expense of each, in one query
// (§5.6). A balance is what came into the pouch minus what went out of it, over every record
// of the user whatever its kind: assign and transfer in, expense and transfer out. Sums come
// back as text, as pg gives bigint and numeric.
const POUCHES_WITH_BALANCES = `
  SELECT p.id, p.name, coalesce(moved.balance, 0)::text AS balance, last.amount::text AS last_expense
    FROM pouches p
    LEFT JOIN (
      SELECT pouch_id, sum(delta) AS balance
        FROM (
          SELECT to_pouch_id AS pouch_id, amount AS delta
            FROM operations WHERE user_id = $1 AND to_pouch_id IS NOT NULL
          UNION ALL
          SELECT from_pouch_id, -amount
            FROM operations WHERE user_id = $1 AND from_pouch_id IS NOT NULL
        ) moves
       GROUP BY pouch_id
    ) moved ON moved.pouch_id = p.id
    LEFT JOIN LATERAL (
      SELECT amount FROM operations
       WHERE user_id = $1 AND kind = 'expense' AND from_pouch_id = p.id
       ORDER BY date DESC, id DESC
       LIMIT 1
    ) last ON true
   WHERE p.user_id = $1 AND NOT p.is_archived
   ORDER BY p.id`;

// §5.6: a currency the records of Säckel were written in other than this one, or null. The
// first record fixes the currency of an installation; main.ts does not start on another one.
export async function otherRecordedCurrency(pool: Pool, currency: string): Promise<string | null> {
  const { rows } = await pool.query<{ currency: string }>(
    'SELECT currency FROM operations WHERE currency <> $1 LIMIT 1',
    [currency],
  );
  return rows[0]?.currency ?? null;
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

export function createSaeckelApp(
  pool: Pool,
  currentUser: CurrentUser,
  settings: SaeckelSettings,
): Hono<SaeckelEnv> {
  const saeckel = new Hono<SaeckelEnv>();
  const money = moneyFormat(settings.currency);

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
  // The balance of one pouch of this user and its last expenses, for its page.
  async function pouchState(pouchId: number, userId: number) {
    const sum = await pool.query<{ balance: string }>(
      `SELECT coalesce(sum(CASE WHEN to_pouch_id = $1 THEN amount ELSE -amount END), 0)::text AS balance
         FROM operations
        WHERE user_id = $2 AND (from_pouch_id = $1 OR to_pouch_id = $1)`,
      [pouchId, userId],
    );
    const recent = await pool.query<{ id: number; amount: string; date: string; note: string }>(
      `SELECT id, amount::text AS amount, to_char(date, 'YYYY-MM-DD') AS date, note
         FROM operations
        WHERE user_id = $1 AND kind = 'expense' AND from_pouch_id = $2
        ORDER BY date DESC, id DESC
        LIMIT ${RECENT_EXPENSES}`,
      [userId, pouchId],
    );
    return {
      balance: centsFrom(sum.rows[0]!.balance),
      expenses: recent.rows.map((row) => ({
        id: row.id,
        cents: centsFrom(row.amount),
        date: row.date,
        note: row.note,
      })),
    };
  }

  // The form of an expense as it first shows: the date of today in the time zone of the court.
  const emptyExpenseForm = (): ExpenseForm => ({
    amount: '',
    date: dateForField(today(settings.timeZone, new Date())),
    note: '',
    errors: {},
  });

  // Мешки: the active pouches of this user, in the order they were made, with their balances.
  saeckel.get('/saeckel/', signedIn, async (c) => {
    const { rows } = await pool.query<{
      id: number;
      name: string;
      balance: string;
      last_expense: string | null;
    }>(POUCHES_WITH_BALANCES, [c.get('user').id]);
    const pouches = rows.map((row) => ({
      id: row.id,
      name: row.name,
      balance: centsFrom(row.balance),
      lastExpense: row.last_expense === null ? null : centsFrom(row.last_expense),
    }));
    return c.html(pouchesPage(pouches, money));
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

  // A pouch. `fresh` is the id of the record just written (§4.1): it is only compared with the
  // records shown, so a strange or foreign one marks nothing.
  saeckel.get('/saeckel/pouches/:id', signedIn, async (c) => {
    const userId = c.get('user').id;
    const pouch = await findPouch(c.req.param('id'), userId);
    if (pouch === null) return c.notFound();
    const state = await pouchState(pouch.id, userId);
    const view = { ...state, fresh: c.req.query('fresh'), form: emptyExpenseForm() };
    return c.html(pouchPage(pouch, view, money));
  });

  // An expense (§4.1, §4.8): the pouch, then the form, then one transaction that locks the row
  // of the pouch before it looks at the storeroom. The lock is what M5.4 needs: a pouch cannot
  // go into the storeroom between this check and the INSERT, and its archiving, which takes
  // the same lock, then sees this expense in the balance. The lock the foreign key takes would
  // not do: it does not conflict with UPDATE is_archived.
  saeckel.post('/saeckel/pouches/:id/expense', signedIn, async (c) => {
    const userId = c.get('user').id;
    const pouch = await findPouch(c.req.param('id'), userId);
    if (pouch === null) return c.notFound();

    const fields = await c.req.parseBody();
    const text = (name: ExpenseField) => {
      const value = fields[name];
      return typeof value === 'string' ? value : '';
    };
    const typed = { amount: text('amount'), date: text('date'), note: text('note') };
    const amount = parseAmount(typed.amount);
    const date = parseDate(typed.date, today(settings.timeZone, new Date()));
    const note = parseNote(typed.note);
    if ('error' in amount || 'error' in date || note === null) {
      const errors: ExpenseForm['errors'] = {};
      if ('error' in amount) errors.amount = amount.error;
      if ('error' in date) errors.date = date.error;
      if (note === null) errors.note = NOTE_ERROR;
      const state = await pouchState(pouch.id, userId);
      return c.html(pouchPage(pouch, { ...state, form: { ...typed, errors } }, money), 400);
    }

    // The new record's id, or why there is none.
    let outcome: number | 'missing' | 'archived';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ is_archived: boolean }>(
        'SELECT is_archived FROM pouches WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [pouch.id, userId],
      );
      const row = locked.rows[0];
      if (row === undefined || row.is_archived) {
        outcome = row === undefined ? 'missing' : 'archived';
        await client.query('ROLLBACK');
      } else {
        const inserted = await client.query<{ id: number }>(
          `INSERT INTO operations (user_id, kind, amount, currency, from_pouch_id, date, note)
           VALUES ($1, 'expense', $2, $3, $4, $5, $6) RETURNING id`,
          [userId, amount.cents, settings.currency, pouch.id, date.date, note],
        );
        await client.query('COMMIT');
        outcome = inserted.rows[0]!.id;
      }
    } catch (error) {
      // The connection may already be broken; the original error matters more.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (outcome === 'missing') return c.notFound();
    if (outcome === 'archived') {
      // The pouch went into the storeroom since the page was opened: no form any more.
      const archived = { ...pouch, is_archived: true };
      const state = await pouchState(pouch.id, userId);
      const view = { ...state, form: emptyExpenseForm(), refusal: ARCHIVED_ERROR };
      return c.html(pouchPage(archived, view, money), 400);
    }
    return c.redirect(`/saeckel/pouches/${pouch.id}?fresh=${outcome}`, 303);
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
