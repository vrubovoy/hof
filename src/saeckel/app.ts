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
import { DatabaseError, type Pool, type PoolClient } from 'pg';
import { dateForField, dateForList, parseDate, today } from './dates.ts';
import { centsFrom, FORMAT_ERROR, moneyFormat, parseAmount, type MoneyFormat } from './money.ts';

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
const notEmptyError = (balance: string) =>
  `Убрать в кладовую можно только пустой мешок. Сейчас в нём ${balance}.`;
const restoreTakenError = (name: string) =>
  `Среди мешков уже есть «${name}». Переименуйте его и верните этот снова.`;
// §4.6: a pouch in a form that is not this user's — somebody else's or none at all.
const MISSING_ERROR = 'Мешок не найден.';
const EMPTY_ASSIGN_ERROR = 'Впишите сумму хотя бы для одного мешка.';
const archivedCreateError = (name: string) =>
  `Мешок «${name}» в Кладовой: записи с ним не создаются.`;

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

// A pouch in the storeroom, as Мешки lists it: its balance is zero.
interface StoredPouch {
  id: number;
  name: string;
}

// An expense as a pouch page lists it; the date is ISO text, the amount in hundredths.
interface Expense {
  id: number;
  cents: number;
  date: string;
  note: string;
}

type EntryField = 'amount' | 'date' | 'note';

// The amount, the date and the note of a form — «Записать трату», «Доход» — as typed, with the
// error of each field it has.
interface EntryForm {
  amount: string;
  date: string;
  note: string;
  errors: Partial<Record<EntryField, string>>;
}

// The same three fields once they all parse: hundredths, an ISO date, the note.
interface Entry {
  cents: number;
  date: string;
  note: string;
}

// «Разложить» as sent: what was typed in the row of each pouch, by its id; the amount of each
// row that parses; the error of each row that does not; a refusal of the whole form.
interface AssignForm {
  typed: Map<number, string>;
  amounts: Map<number, number>;
  errors: Map<number, string>;
  refusal?: string;
}

// A pouch row locked by lockPouches.
interface LockedPouch {
  id: number;
  name: string;
  is_archived: boolean;
}

// What a pouch page shows besides the pouch itself.
interface PouchView {
  balance: number;
  expenses: readonly Expense[];
  // `fresh` as it came in the address: the record of that id, if it is among those shown, is
  // marked as just written.
  fresh?: string;
  form: EntryForm;
  // A refusal of the whole form, or of «Вернуть», rather than of one field.
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

// «Кладовая (N)», folded, only when there is something in it: each pouch leads to its page and
// can be brought back from here.
function storeroom(stored: readonly StoredPouch[]) {
  if (stored.length === 0) return '';
  return html`<details>
    <summary>Кладовая (${stored.length})</summary>
    <ul>
      ${stored.map(
        (pouch) =>
          html`<li>
            <a href="/saeckel/pouches/${pouch.id}">${pouch.name}</a>
            <form method="post" action="/saeckel/pouches/${pouch.id}/restore">
              <button type="submit">Вернуть</button>
            </form>
          </li>`,
      )}
    </ul>
  </details>`;
}

// «Казна» (design/preview/Saeckel.html): the money not laid out yet. Shown always — at zero,
// below zero, before the first pouch — with the way to income and to laying out.
function treasuryBlock(treasury: number, money: MoneyFormat) {
  return html`<h2>Казна</h2>
    <p>${money.format(treasury)}</p>
    <p><a href="/saeckel/assign">Разложить</a> <a href="/saeckel/income">+ Доход</a></p>`;
}

// Мешки, texts from design/preview/Saeckel.html and SaeckelEmpty.html. «Переложить» and
// «Летопись» come with what they do. The treasury is always there; the empty state is about the
// active pouches; the storeroom is there either way.
function pouchesPage(
  pouches: readonly ListedPouch[],
  stored: readonly StoredPouch[],
  treasury: number,
  money: MoneyFormat,
) {
  return page(
    'Säckel — мешки',
    html`<nav><a href="/">← Двор</a></nav>
      <h1>Säckel</h1>
      <nav><a href="/saeckel/" aria-current="page">Мешки</a></nav>
      ${treasuryBlock(treasury, money)}
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
      }
      ${storeroom(stored)}`,
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

// «Сумма», «Дата», «Заметка» of a form (design/preview/Saeckel.html, SaeckelForms.html). What
// was typed stays in the fields; the error of a field is under it.
function entryFields(form: EntryForm, money: MoneyFormat) {
  const attributes = (field: EntryField) =>
    form.errors[field] === undefined
      ? ''
      : html`aria-invalid="true" aria-describedby="${field}-error"`;
  const error = (field: EntryField) =>
    form.errors[field] === undefined ? '' : html`<p id="${field}-error">${form.errors[field]}</p>`;
  return html`<p>
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
    ${error('note')}`;
}

// The form «Записать трату» (design/preview/Saeckel.html, PouchMobile.html).
function expenseForm(pouch: Pouch, form: EntryForm, money: MoneyFormat) {
  return html`<h2>Записать трату</h2>
    <form method="post" action="/saeckel/pouches/${pouch.id}/expense">
      ${entryFields(form, money)}
      <button type="submit">Записать трату</button>
    </form>`;
}

// «Доход», texts from design/preview/SaeckelForms.html and IncomeMobile.html.
function incomePage(form: EntryForm, money: MoneyFormat) {
  return page(
    'Säckel — доход',
    html`<p><a href="/saeckel/">Мешки</a></p>
      <h1>Доход</h1>
      <form method="post" action="/saeckel/income">
        ${entryFields(form, money)}
        <p>Деньги лягут в казну. После записи откроется раскладка по мешкам — её можно отложить.</p>
        <button type="submit">Записать доход</button>
      </form>`,
  );
}

// «Разложить по мешкам», texts from design/preview/SaeckelAssign.html and AssignMobile.html: a
// row with a field for each active pouch. The income just written, if any, is named above.
function assignPage(
  pouches: readonly ListedPouch[],
  treasury: number,
  form: AssignForm,
  income: number | null,
  money: MoneyFormat,
) {
  const row = (pouch: ListedPouch) => {
    const field = `amount_${pouch.id}`;
    const error = form.errors.get(pouch.id);
    const describedBy =
      error === undefined ? '' : html`aria-invalid="true" aria-describedby="${field}-error"`;
    return html`<tr>
      <td>${pouch.name}</td>
      <td>${money.format(pouch.balance)}</td>
      <td>
        <input
          name="${field}"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          value="${form.typed.get(pouch.id) ?? ''}"
          aria-label="Положить в мешок ${pouch.name}"
          ${describedBy}
        />
        ${error === undefined ? '' : html`<p id="${field}-error">${error}</p>`}
      </td>
    </tr>`;
  };
  return page(
    'Säckel — разложить',
    html`<p><a href="/saeckel/">Мешки</a></p>
      ${
        income === null
          ? ''
          : html`<p>
              Доход ${money.format(income)} лёг в казну. Разложите его по мешкам или оставьте в
              казне на потом.
            </p>`
      }
      <h1>Разложить по мешкам</h1>
      ${form.refusal === undefined ? '' : html`<p id="refusal">${form.refusal}</p>`}
      ${
        pouches.length === 0
          ? html`<p>В казне: ${money.format(treasury)}.</p>
              <h2>Мешков пока нет</h2>
              <p><a href="/saeckel/pouches/new">+ Новый мешок</a></p>`
          : html`<p>В казне: ${money.format(treasury)}. Пустые поля пропускаются.</p>
              <form method="post" action="/saeckel/assign">
                <table>
                  <thead>
                    <tr>
                      <th>Мешок</th>
                      <th>Сейчас в мешке</th>
                      <th>Положить, ${money.symbol}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${pouches.map(row)}
                  </tbody>
                </table>
                <button type="submit">Разложить</button>
              </form>
              <p><a href="/saeckel/">Позже — вернуться к мешкам</a></p>`
      }`,
  );
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
// storeroom has neither «Изменить» nor the form, only «Вернуть»: it is brought back first.
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
      ${view.refusal === undefined ? '' : html`<p id="refusal">${view.refusal}</p>`}
      ${
        pouch.is_archived
          ? html`<form method="post" action="/saeckel/pouches/${pouch.id}/restore">
              <button type="submit">Вернуть</button>
            </form>`
          : expenseForm(pouch, view.form, money)
      }
      ${
        view.expenses.length === 0
          ? ''
          : html`<ul>
              ${view.expenses.map((expense) => expenseRow(expense, view.fresh, money))}
            </ul>`
      }`,
  );
}

// «Изменить», texts from design/preview/PouchEditMobile.html: the name and the sign, then «В
// кладовую». The heading keeps the stored name; the fields show what was typed and chosen.
// Only an empty pouch goes into the storeroom: with any other balance the block says why and
// its button is off, as in the design; the server checks again under the lock.
function editPouchPage(pouch: Pouch, form: EditPouchForm, balance: number, money: MoneyFormat) {
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
      </form>
      <h2>В кладовую</h2>
      ${balance === 0 ? '' : html`<p>${notEmptyError(money.format(balance))}</p>`}
      <form method="post" action="/saeckel/pouches/${pouch.id}/archive">
        <button type="submit" ${balance === 0 ? '' : html`disabled`}>В кладовую</button>
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

// The amount, the date and the note of a form (§4.7) — of an expense, of an income. Either all
// three parse, or the form comes back as typed with the error of each field that does not.
function parseEntry(
  body: Record<string, unknown>,
  todayDate: string,
): { form: EntryForm; entry: Entry | null } {
  const text = (name: EntryField) => {
    const value = body[name];
    return typeof value === 'string' ? value : '';
  };
  const form: EntryForm = {
    amount: text('amount'),
    date: text('date'),
    note: text('note'),
    errors: {},
  };
  const amount = parseAmount(form.amount);
  const date = parseDate(form.date, todayDate);
  const note = parseNote(form.note);
  if ('error' in amount) form.errors.amount = amount.error;
  if ('error' in date) form.errors.date = date.error;
  if (note === null) form.errors.note = NOTE_ERROR;
  if ('error' in amount || 'error' in date || note === null) return { form, entry: null };
  return { form, entry: { cents: amount.cents, date: date.date, note } };
}

// The rows of «Разложить» (§4.1): only the fields `amount_<id>` count, anything else is
// ignored. A row left empty is skipped. A field that comes more than once is one row sent
// twice: refused, so that nothing is laid out or counted twice. A non-empty field whose id is
// of the wrong form is a pouch that cannot be the user's.
function parseAssignForm(body: Record<string, unknown>): AssignForm {
  const form: AssignForm = { typed: new Map(), amounts: new Map(), errors: new Map() };
  for (const [name, value] of Object.entries(body)) {
    if (!name.startsWith('amount_')) continue;
    const texts = (Array.isArray(value) ? value : [value]).map((item) =>
      typeof item === 'string' ? item : '',
    );
    const id = parseId(name.slice('amount_'.length));
    if (id === null) {
      if (texts.some((text) => text.trim() !== '')) form.refusal = MISSING_ERROR;
      continue;
    }
    form.typed.set(id, texts.at(-1)!);
    if (texts.length > 1) {
      form.errors.set(id, FORMAT_ERROR);
      continue;
    }
    if (texts[0]!.trim() === '') continue;
    const amount = parseAmount(texts[0]!);
    if ('error' in amount) form.errors.set(id, amount.error);
    else form.amounts.set(id, amount.cents);
  }
  return form;
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

// The balance of one pouch of this user by the same rule, as text. One statement of its own:
// the archiving runs it after it has locked the pouch, so it sees every record committed
// meanwhile.
const POUCH_BALANCE = `
  SELECT coalesce(sum(CASE WHEN to_pouch_id = $1 THEN amount ELSE -amount END), 0)::text AS balance
    FROM operations
   WHERE user_id = $2 AND (from_pouch_id = $1 OR to_pouch_id = $1)`;

async function balanceOf(db: Pool | PoolClient, pouchId: number, userId: number): Promise<number> {
  const { rows } = await db.query<{ balance: string }>(POUCH_BALANCE, [pouchId, userId]);
  return centsFrom(rows[0]!.balance);
}

// «Нераспределено», the treasury (§5.6): what came in minus what was laid out into pouches, over
// the records of one user. Text, as pg gives numeric.
const TREASURY = `
  SELECT coalesce(sum(CASE WHEN kind = 'income' THEN amount ELSE -amount END), 0)::text AS treasury
    FROM operations
   WHERE user_id = $1 AND kind IN ('income', 'assign')`;

async function treasuryOf(pool: Pool, userId: number): Promise<number> {
  const { rows } = await pool.query<{ treasury: string }>(TREASURY, [userId]);
  return centsFrom(rows[0]!.treasury);
}

// §4.8: the rows of these pouches of this user, locked FOR UPDATE by one statement in the order
// of their ids. Every transaction that writes money into or out of more than one pouch locks
// them so, in the same order whatever order a form gave them in, and none waits for another
// in a circle. Repeated ids and nulls are dropped. Returns the rows found; the caller compares
// them with the ids it asked for and checks the storeroom.
async function lockPouches(
  client: PoolClient,
  userId: number,
  ids: readonly (number | null)[],
): Promise<LockedPouch[]> {
  const wanted = [...new Set(ids.filter((id) => id !== null))];
  const { rows } = await client.query<LockedPouch>(
    'SELECT id, name, is_archived FROM pouches WHERE user_id = $1 AND id = ANY($2) ORDER BY id FOR UPDATE',
    [userId, wanted],
  );
  return rows;
}

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

  // The balance of one pouch of this user and its last expenses, for its page.
  async function pouchState(pouchId: number, userId: number) {
    const balance = await balanceOf(pool, pouchId, userId);
    const recent = await pool.query<{ id: number; amount: string; date: string; note: string }>(
      `SELECT id, amount::text AS amount, to_char(date, 'YYYY-MM-DD') AS date, note
         FROM operations
        WHERE user_id = $1 AND kind = 'expense' AND from_pouch_id = $2
        ORDER BY date DESC, id DESC
        LIMIT ${RECENT_EXPENSES}`,
      [userId, pouchId],
    );
    return {
      balance,
      expenses: recent.rows.map((row) => ({
        id: row.id,
        cents: centsFrom(row.amount),
        date: row.date,
        note: row.note,
      })),
    };
  }

  // An expense or an income as its form first shows: the date of today in the time zone of the
  // court.
  const emptyEntryForm = (): EntryForm => ({
    amount: '',
    date: dateForField(today(settings.timeZone, new Date())),
    note: '',
    errors: {},
  });

  // The active pouches of this user, in the order they were made, with their balances.
  async function activePouches(userId: number): Promise<ListedPouch[]> {
    const { rows } = await pool.query<{
      id: number;
      name: string;
      balance: string;
      last_expense: string | null;
    }>(POUCHES_WITH_BALANCES, [userId]);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      balance: centsFrom(row.balance),
      lastExpense: row.last_expense === null ? null : centsFrom(row.last_expense),
    }));
  }

  // Мешки: the treasury, the active pouches of this user with their balances, and the
  // storeroom, both in the order the pouches were made.
  saeckel.get('/saeckel/', signedIn, async (c) => {
    const userId = c.get('user').id;
    const pouches = await activePouches(userId);
    const treasury = await treasuryOf(pool, userId);
    const stored = await pool.query<StoredPouch>(
      'SELECT id, name FROM pouches WHERE user_id = $1 AND is_archived ORDER BY id',
      [userId],
    );
    return c.html(pouchesPage(pouches, stored.rows, treasury, money));
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
    const view = { ...state, fresh: c.req.query('fresh'), form: emptyEntryForm() };
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

    // The pouch is in the storeroom: its page without the form, and why. A form opened before
    // that is refused whatever was typed in it, as its page has no fields to show errors in.
    const refuseArchived = async () => {
      const state = await pouchState(pouch.id, userId);
      const view = { ...state, form: emptyEntryForm(), refusal: ARCHIVED_ERROR };
      return c.html(pouchPage({ ...pouch, is_archived: true }, view, money), 400);
    };
    // Already seen by the look-up. The check that counts is the one under the lock below.
    if (pouch.is_archived) return refuseArchived();

    const { form, entry } = parseEntry(
      await c.req.parseBody(),
      today(settings.timeZone, new Date()),
    );
    if (entry === null) {
      const state = await pouchState(pouch.id, userId);
      return c.html(pouchPage(pouch, { ...state, form }, money), 400);
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
          [userId, entry.cents, settings.currency, pouch.id, entry.date, entry.note],
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
    // The pouch went into the storeroom since it was looked up.
    if (outcome === 'archived') return refuseArchived();
    return c.redirect(`/saeckel/pouches/${pouch.id}?fresh=${outcome}`, 303);
  });

  // «Доход» (§4.1): the form, and on success «Разложить» with this income named.
  saeckel.get('/saeckel/income', signedIn, (c) => c.html(incomePage(emptyEntryForm(), money)));

  // An income: into the treasury, out of no pouch. One INSERT and no transaction of our own:
  // an income touches no pouch, so there is nothing to lock (§4.8). The user is the one signed
  // in; a user_id, a kind or pouches in the form are ignored.
  saeckel.post('/saeckel/income', signedIn, async (c) => {
    const { form, entry } = parseEntry(
      await c.req.parseBody(),
      today(settings.timeZone, new Date()),
    );
    if (entry === null) return c.html(incomePage(form, money), 400);
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO operations (user_id, kind, amount, currency, date, note)
       VALUES ($1, 'income', $2, $3, $4, $5) RETURNING id`,
      [c.get('user').id, entry.cents, settings.currency, entry.date, entry.note],
    );
    return c.redirect(`/saeckel/assign?income=${rows[0]!.id}`, 303);
  });

  // The page «Разложить» for this user: the treasury and the rows of the active pouches.
  async function assignView(
    userId: number,
    form: AssignForm,
    income: number | null,
  ): Promise<HtmlEscapedString | Promise<HtmlEscapedString>> {
    const pouches = await activePouches(userId);
    const treasury = await treasuryOf(pool, userId);
    // An error of a row the page does not show — somebody else's pouch, one in the storeroom or
    // none at all — is told without its name.
    const shown = new Set(pouches.map((pouch) => pouch.id));
    const hidden = [...form.errors.keys()].some((id) => !shown.has(id));
    const refusal = form.refusal ?? (hidden ? MISSING_ERROR : undefined);
    return assignPage(pouches, treasury, { ...form, refusal }, income, money);
  }

  // «Разложить по мешкам». `income` is the id of an income of this user (§4.7): its amount is
  // named above the rows. Anything else — somebody else's record, another kind, a wrong id — is
  // ignored, as if there were none.
  saeckel.get('/saeckel/assign', signedIn, async (c) => {
    const userId = c.get('user').id;
    const id = parseId(c.req.query('income') ?? '');
    let income: number | null = null;
    if (id !== null) {
      const { rows } = await pool.query<{ amount: string }>(
        "SELECT amount::text AS amount FROM operations WHERE id = $1 AND user_id = $2 AND kind = 'income'",
        [id, userId],
      );
      income = rows[0] === undefined ? null : centsFrom(rows[0].amount);
    }
    const form: AssignForm = { typed: new Map(), amounts: new Map(), errors: new Map() };
    return c.html(await assignView(userId, form, income));
  });

  // Laying out (§4.1, §4.8): every row first, then one transaction that locks all its pouches
  // by one statement in the order of their ids and checks them before the first INSERT. Either
  // every row is written or none: a pouch that is not the user's, a pouch in the storeroom, a
  // failure of any INSERT or of the COMMIT leaves nothing. An archiving of one of the pouches
  // takes the same lock: it either waits and then sees these records in the balance, or goes
  // first and this is refused. The treasury is not compared with: it may go below zero.
  saeckel.post('/saeckel/assign', signedIn, async (c) => {
    const userId = c.get('user').id;
    const form = parseAssignForm(await c.req.parseBody({ all: true }));
    const refuse = async (refusal?: string) =>
      c.html(
        await assignView(userId, refusal === undefined ? form : { ...form, refusal }, null),
        400,
      );
    if (form.refusal !== undefined || form.errors.size > 0) return refuse();
    if (form.amounts.size === 0) return refuse(EMPTY_ASSIGN_ERROR);

    const date = today(settings.timeZone, new Date());
    let refusal: string | null = null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await lockPouches(client, userId, [...form.amounts.keys()]);
      const archived = locked.find((pouch) => pouch.is_archived);
      if (locked.length < form.amounts.size) refusal = MISSING_ERROR;
      else if (archived !== undefined) refusal = archivedCreateError(archived.name);
      if (refusal !== null) {
        await client.query('ROLLBACK');
      } else {
        for (const pouch of locked) {
          await client.query(
            `INSERT INTO operations (user_id, kind, amount, currency, to_pouch_id, date)
             VALUES ($1, 'assign', $2, $3, $4, $5)`,
            [userId, form.amounts.get(pouch.id), settings.currency, pouch.id, date],
          );
        }
        await client.query('COMMIT');
      }
    } catch (error) {
      // The connection may already be broken; the original error matters more.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (refusal !== null) return refuse(refusal);
    return c.redirect('/saeckel/', 303);
  });

  // «Изменить»: only an active pouch of this user. A pouch in the storeroom is the same 404 as
  // somebody else's: it is brought back first. A stored key the set does not know shows as
  // the default sign.
  saeckel.get('/saeckel/pouches/:id/edit', signedIn, async (c) => {
    const userId = c.get('user').id;
    const pouch = await findPouch(c.req.param('id'), userId);
    if (pouch === null || pouch.is_archived) return c.notFound();
    const icon = parseIcon(pouch.icon) ?? DEFAULT_ICON;
    const balance = await balanceOf(pool, pouch.id, userId);
    return c.html(editPouchPage(pouch, { name: pouch.name, icon }, balance, money));
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
    const refuse = async (error: FormError) => {
      const balance = await balanceOf(pool, pouch.id, userId);
      return c.html(editPouchPage(pouch, { name: typed, icon, error }, balance, money), 400);
    };
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

  // «В кладовую» (§4.8, §5.4): one transaction that locks the row of the pouch first and only
  // then counts its balance, in a statement of its own. An expense takes the same lock, so
  // either it waits and finds the pouch in the storeroom, or the archiving waits and — as a
  // new statement under READ COMMITTED — sees that expense in the balance. A pouch already in
  // the storeroom is where it was asked to go.
  saeckel.post('/saeckel/pouches/:id/archive', signedIn, async (c) => {
    const userId = c.get('user').id;
    const id = parseId(c.req.param('id'));
    if (id === null) return c.notFound();

    // The pouch as locked and its balance, or why there is nothing to refuse.
    let outcome: 'missing' | 'archived' | { pouch: Pouch; balance: number };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The name and the sign are only for the page of a refusal.
      const locked = await client.query<Pouch>(
        'SELECT id, name, icon, is_archived FROM pouches WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [id, userId],
      );
      const pouch = locked.rows[0];
      if (pouch === undefined || pouch.is_archived) {
        outcome = pouch === undefined ? 'missing' : 'archived';
        await client.query('ROLLBACK');
      } else {
        const balance = await balanceOf(client, id, userId);
        if (balance !== 0) {
          outcome = { pouch, balance };
          await client.query('ROLLBACK');
        } else {
          await client.query(
            'UPDATE pouches SET is_archived = true WHERE id = $1 AND user_id = $2',
            [id, userId],
          );
          await client.query('COMMIT');
          outcome = 'archived';
        }
      }
    } catch (error) {
      // The connection may already be broken; the original error matters more.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (outcome === 'missing') return c.notFound();
    if (outcome === 'archived') return c.redirect('/saeckel/', 303);
    // Not empty: «Изменить» again, with the balance the lock saw.
    const { pouch, balance } = outcome;
    const form = { name: pouch.name, icon: parseIcon(pouch.icon) ?? DEFAULT_ICON };
    return c.html(editPouchPage(pouch, form, balance, money), 400);
  });

  // «Вернуть» (§5.4): one UPDATE, no transaction of our own and no look for the name first. A
  // name another active pouch of this user has is settled by the unique index, the same way
  // as two pouches of one name at once. A pouch that is already active stays so: 303 again.
  saeckel.post('/saeckel/pouches/:id/restore', signedIn, async (c) => {
    const userId = c.get('user').id;
    const id = parseId(c.req.param('id'));
    if (id === null) return c.notFound();

    let restored: number;
    try {
      const { rowCount } = await pool.query(
        'UPDATE pouches SET is_archived = false WHERE id = $1 AND user_id = $2 RETURNING name',
        [id, userId],
      );
      restored = rowCount ?? 0;
    } catch (error) {
      if (!isNameTaken(error)) throw error;
      // The page of the pouch, still in the storeroom; its name is the one taken, in any case.
      const pouch = await findPouch(c.req.param('id'), userId);
      if (pouch === null) return c.notFound();
      const state = await pouchState(pouch.id, userId);
      const view = { ...state, form: emptyEntryForm(), refusal: restoreTakenError(pouch.name) };
      return c.html(pouchPage(pouch, view, money), 400);
    }
    if (restored === 0) return c.notFound();
    return c.redirect(`/saeckel/pouches/${id}`, 303);
  });

  return saeckel;
}
