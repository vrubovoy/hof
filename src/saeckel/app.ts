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
import {
  AMOUNT_MAX_CENTS,
  amountForField,
  centsFrom,
  FORMAT_ERROR,
  moneyFormat,
  parseAmount,
  type MoneyFormat,
} from './money.ts';

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
const restoreTakenError = (name: string) =>
  `Среди мешков уже есть «${name}». Переименуйте его и верните этот снова.`;
// §4.6: a pouch in a form that is not this user's — somebody else's or none at all.
const MISSING_ERROR = 'Мешок не найден.';
const EMPTY_ASSIGN_ERROR = 'Впишите сумму хотя бы для одного мешка.';
const archivedCreateError = (name: string) =>
  `Мешок «${name}» в Кладовой: записи с ним не создаются.`;
const archivedEditError = (name: string) =>
  `Мешок «${name}» в Кладовой: запись с ним не исправляется и не удаляется. Сначала верните мешок.`;
const CHOOSE_POUCH_ERROR = 'Выберите мешок.';
const SAME_POUCH_ERROR = 'Нельзя переложить в тот же мешок.';

// §4.7: text of a form is one line; PostgreSQL does not take \0 at all.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

// The movements a pouch page shows; the whole history is «Летопись».
const RECENT_MOVEMENTS = 10;

// «Летопись»: records on one page, and the last page there is (§4.1, §4.7).
const HISTORY_PAGE_SIZE = 50;
const HISTORY_LAST_PAGE = 1000;

const EMPTY_POUCH_HISTORY = 'По этому мешку записей пока нет.';
const PAST_LAST_PAGE = 'На этой странице записей нет.';

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

// The picture of each sign, a file of the static folder of Säckel; the default sign is the emblem
// of Säckel. The name of a file comes from this set, never from the database or a form.
const SIGN_FILES: Record<Icon, string> = {
  pouch: 'emblem-saeckel-small',
  cart: 'icon-cart',
  basket: 'icon-basket',
  hearth: 'icon-hearth',
  jug: 'icon-jug',
  mortar: 'icon-mortar',
  needle: 'icon-needle',
  lute: 'icon-lute',
  bundle: 'icon-bundle',
  scroll: 'icon-scroll',
  pot: 'icon-pot',
  toyhorse: 'icon-toyhorse',
  bowl: 'icon-bowl',
  hammer: 'icon-hammer',
  books: 'icon-books',
  bag: 'icon-bag',
  comb: 'icon-comb',
};

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

// A pouch in the list of Мешки, with its sign, its balance and its last expense, in hundredths.
interface ListedPouch {
  id: number;
  name: string;
  icon: string;
  balance: number;
  lastExpense: number | null;
}

// A pouch in the storeroom, as Мешки lists it: its balance is zero.
interface StoredPouch {
  id: number;
  name: string;
  icon: string;
}

// The column of the pages of «Мешки» (§6, design/preview/Saeckel.html): the treasury, the active
// pouches and the storeroom of one user.
interface PouchColumn {
  treasury: number;
  pouches: readonly ListedPouch[];
  stored: readonly StoredPouch[];
}

// Where a column stands: beside the page of a pouch, which it marks as the current one; on Мешки
// beside the first pouch open on the right, which it marks by look only; and whether the
// treasury has its buttons — not beside «Разложить», where one of them leads
// (design/preview/SaeckelAssign.html).
interface ColumnPlace {
  current?: number;
  open?: number;
  buttons: boolean;
}

// The two tabs of Säckel (§6): Мешки with every page about pouches and money, and «Летопись»
// with the records.
type Tab = 'pouches' | 'history';

// A page of Säckel: its title and tab; on a page below a tab, the way back the phone shows on
// the band of the scene; on the pages of «Мешки», the column beside it.
interface Place {
  title: string;
  tab: Tab;
  back?: { href: string; text: string };
  column?: HtmlEscapedString | Promise<HtmlEscapedString>;
}

type Kind = 'income' | 'assign' | 'expense' | 'transfer';

// The words for each kind of record (design/preview/SaeckelHistory.html).
const KIND_LABELS: Record<Kind, string> = {
  income: 'Доход',
  assign: 'Из казны',
  expense: 'Трата',
  transfer: 'Из мешка в мешок',
};

// A record as Säckel shows it: the date is ISO text, the amount in hundredths; its pouches and
// their names, where the kind has them.
interface Operation {
  id: number;
  kind: Kind;
  cents: number;
  date: string;
  note: string;
  fromPouchId: number | null;
  toPouchId: number | null;
  fromName: string | null;
  toName: string | null;
  // Whether a pouch of the record is in the storeroom; false where it has none.
  fromArchived: boolean;
  toArchived: boolean;
}

// The pouches of a record by its kind (§5.5): the lists its form has.
const POUCH_FIELDS: Record<Kind, readonly PouchField[]> = {
  income: [],
  assign: ['to'],
  expense: ['from'],
  transfer: ['from', 'to'],
};

// A pouch of the filter of «Летопись»: active ones and those in the storeroom alike.
interface FilterPouch {
  id: number;
  name: string;
  is_archived: boolean;
}

// One page of «Летопись»: its records, the pouch it is filtered by, if any, and whether a next
// page has records.
interface HistoryView {
  operations: readonly Operation[];
  page: number;
  pouch: number | null;
  pouches: readonly FilterPouch[];
  hasNext: boolean;
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

// The two pouches of «Переложить» and of a record.
type PouchField = 'from' | 'to';

// «Переложить», or a record, as typed: the ids chosen in the lists, the three fields of an
// entry, and the error of each field.
interface PouchesForm extends EntryForm {
  from: string;
  to: string;
  errors: Partial<Record<EntryField | PouchField, string>>;
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
  // The last records into or out of the pouch, newest first.
  movements: readonly Operation[];
  // `fresh` as it came in the address: the record of that id, if it is among those shown, is
  // marked as just written.
  fresh?: string;
  form: EntryForm;
  // A refusal of the whole form, or of «Вернуть», rather than of one field.
  refusal?: string;
}

// Every page of Säckel: its own CSS and its own copy of the mark of Hof as the icon of the tab
// (§4.1: Säckel names only files of its own static folder), and the two scripts of the effects of
// Hof — the only addresses of Core a page of Säckel names (§2).
function page(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  return html`<!doctype html>
    <html lang="ru">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <link rel="stylesheet" href="/saeckel/static/saeckel.css" />
        <link rel="icon" href="/saeckel/static/img/hof-mark.svg" type="image/svg+xml" />
        <script src="/static/fx-head.js"></script>
        <script type="module" src="/static/fx.js"></script>
      </head>
      <body>
        ${body}
      </body>
    </html>`;
}

// The frame of every page of Säckel (design/preview/Saeckel.html, SaeckelMobile.html,
// PouchMobile.html). On a computer: the scene of the treasury room to the edges with «Двор» on
// it, below it the ribbon, the two tabs and the motto, then the page — beside the column of
// pouches on the pages of «Мешки». On the phone: the scene as a band; on the two tabs themselves
// «Двор», the ribbon and the tabs, on a page below them only the way back on the band, and the
// column only on Мешки. CSS shows one of the two, so the hidden parts take no focus. The ribbon is
// the h1 of the tabs themselves; any other page has its own.
//
// With «Анимации» the book turns a page (data-fx, read by fx.js of Hof, §6): forward to Летопись
// and, on the phone, deeper into Мешки; back to Мешки, to Двор and on «назад». A link marked
// flip-fwd-phone turns the page on the phone only: on a computer the column stays where it is.
function saeckelPage(place: Place, body: HtmlEscapedString | Promise<HtmlEscapedString> | '') {
  const here = (tab: Tab) =>
    tab === place.tab
      ? html`aria-current="page"`
      : html`data-fx="${tab === 'history' ? 'flip-fwd' : 'flip-back'}"`;
  const below = place.back !== undefined;
  const ribbon = below
    ? html`<p class="ribbon ribbon-md"><span>Säckel</span></p>`
    : html`<h1 class="ribbon ribbon-md"><span>Säckel</span></h1>`;
  let layout;
  if (place.column === undefined) {
    layout = html`<main class="sk-main sk-wide">${body}</main>`;
  } else if (below) {
    layout = html`<div class="sk-body">
      <aside class="sk-list" aria-label="Казна и мешки">${place.column}</aside>
      <main class="sk-main">${body}</main>
    </div>`;
  } else {
    // Мешки itself: the column is what the page is about.
    layout = html`<main class="sk-body sk-pouches">
      <div class="sk-list">${place.column}</div>
      ${body}
    </main>`;
  }
  return page(
    place.title,
    html`<div class="${below ? 'sk sk-below' : 'sk'}">
      <header class="sk-head">
        <img
          class="sk-scene"
          src="/saeckel/static/img/scene-treasury-band.webp"
          srcset="
            /saeckel/static/img/scene-treasury-band.webp    1536w,
            /saeckel/static/img/scene-treasury-band@2x.webp 3072w
          "
          sizes="100vw"
          alt="Казначейская: стол с весами, монетами, книгой, мешками и сундуком"
        />
        <a class="sk-gate sk-court" href="/" data-fx="flip-back"
          ><img src="/saeckel/static/img/hof-mark.svg" width="22" height="22" alt="" />Двор</a
        >
        ${
          below
            ? html`<a class="sk-gate sk-back" href="${place.back!.href}" data-fx="flip-back"
                ><span>${place.back!.text}</span></a
              >`
            : ''
        }
      </header>
      <div class="sk-nav">
        ${ribbon}
        <nav class="tabs" aria-label="Säckel">
          <a class="tab" href="/saeckel/" ${here('pouches')}>Мешки</a>
          <a class="tab" href="/saeckel/history" ${here('history')}>Летопись</a>
        </nav>
        <p class="caps sk-motto">Бюджет по мешкам</p>
      </div>
      ${layout}
    </div>`,
  );
}

// A blot of ink on the empty paper of a page; `place` is its class, which sets where it lies.
function blot(file: string, place: string) {
  return html`<img
    class="blot ${place}"
    src="/saeckel/static/img/${file}.webp"
    alt=""
    loading="lazy"
  />`;
}

// A sign as a picture (§5.4): its key of the set, or the default sign for a stored key the set
// does not know. Decorative: the name of the pouch is said by the text beside it.
function signPicture(stored: string) {
  const icon = parseIcon(stored) ?? DEFAULT_ICON;
  if (icon !== DEFAULT_ICON) {
    return html`<img src="/saeckel/static/img/${SIGN_FILES[icon]}.webp" alt="" />`;
  }
  return html`<img
    src="/saeckel/static/img/${SIGN_FILES[icon]}.webp"
    srcset="/saeckel/static/img/${SIGN_FILES[icon]}@2x.webp 2x"
    alt=""
  />`;
}

// The error of a form, under its field.
function formError(error: FormError | undefined, field: FormError['field']) {
  return error?.field === field
    ? html`<p id="${field}-error" class="err-text">${error.text}</p>`
    : '';
}

// The name field of both forms of a pouch: the error under the field, the field drawn red.
function nameField(name: string, error: FormError | undefined) {
  const invalid = error?.field === 'name';
  return html`<div class="${invalid ? 'field err' : 'field'}">
    <label for="name">Название</label>
    <input
      id="name"
      class="input"
      name="name"
      type="text"
      required
      value="${name}"
      ${invalid ? html`aria-invalid="true" aria-describedby="name-error"` : ''}
    />
    ${formError(error, 'name')}
  </div>`;
}

// The form of a new pouch: the name only, the button beside it. The sign is the default one (§6,
// SaeckelEmpty); a sign sent anyway is checked like in «Изменить».
function newPouchForm(form: NewPouchForm) {
  return html`<form class="form-row new-pouch" method="post" action="/saeckel/pouches/new">
    ${nameField(form.name, form.error)}
    <button type="submit" class="btn btn-ochre">Завести мешок</button>
    ${formError(form.error, 'icon')}
  </form>`;
}

// What the list says under a pouch (design/preview/Saeckel.html): in debt, its last expense,
// or none yet.
function pouchNote(pouch: ListedPouch, money: MoneyFormat): string {
  if (pouch.balance < 0) return 'в долгу';
  if (pouch.lastExpense !== null) return `последняя трата ${money.format(-pouch.lastExpense)}`;
  return 'трат пока не было';
}

// «Казна» (design/preview/Saeckel.html): the money not laid out yet, in a frame with the closed
// chest. Shown always — at zero, below zero, before the first pouch — with the way to laying out
// and to income where the page asks for them. A sum longer than «1 234 567,89 ₽» is set smaller,
// so that it stays on one line beside the chest. The chest itself is decor of Hof (data-poke,
// M10.5): a press on it creaks and opens it, never one on the sum or the buttons beside it.
function treasuryFrame(treasury: number, money: MoneyFormat, buttons: boolean) {
  const sum = money.format(treasury);
  const classes = ['money', ...(treasury < 0 ? ['neg'] : []), ...(sum.length > 14 ? ['long'] : [])];
  return html`<div class="framed treasury">
    <span class="chest-box" aria-hidden="true" data-poke="chest"
      ><img class="chest" src="/saeckel/static/img/emblem-chest-closed.webp" alt=""
    /></span>
    <h2 class="title t-3">Казна</h2>
    <p class="${classes.join(' ')}">${sum}</p>
    ${
      buttons
        ? html`<p class="treasury-actions">
            <a class="btn btn-ochre" href="/saeckel/assign" data-fx="flip-fwd-phone">Разложить</a>
            <a class="btn" href="/saeckel/income" data-fx="flip-fwd-phone">+ Доход</a>
          </p>`
        : ''
    }
  </div>`;
}

// One active pouch of the column: its sign, its name and what is said under it, its balance; a
// balance below zero is red. The pouch of the page beside the column is the current one; the
// pouch open on the right of Мешки only looks so.
function pouchRow(pouch: ListedPouch, money: MoneyFormat, place: ColumnPlace) {
  const debt = pouch.balance < 0;
  return html`<li>
    <a
      class="${pouch.id === place.open ? 'pouch open' : 'pouch'}"
      href="/saeckel/pouches/${pouch.id}"
      ${pouch.id === place.current ? html`aria-current="page"` : html`data-fx="flip-fwd-phone"`}
    >
      ${signPicture(pouch.icon)}
      <span class="pouch-text">
        <span class="name">${pouch.name}</span>
        <span class="${debt ? 'sub neg' : 'sub'}">${pouchNote(pouch, money)}</span>
      </span>
      <span class="${debt ? 'bal neg' : 'bal'}">${money.format(pouch.balance)}</span>
    </a>
  </li>`;
}

// «Кладовая (N)», folded, only when there is something in it: each pouch leads to its page and
// can be brought back from here.
function storeroom(stored: readonly StoredPouch[]) {
  if (stored.length === 0) return '';
  return html`<details class="storeroom">
    <summary>Кладовая (${stored.length})</summary>
    <ul>
      ${stored.map(
        (pouch) =>
          html`<li>
            <a class="stored" href="/saeckel/pouches/${pouch.id}"
              >${signPicture(pouch.icon)}<span>${pouch.name}</span></a
            >
            <form method="post" action="/saeckel/pouches/${pouch.id}/restore">
              <button type="submit" class="btn">Вернуть</button>
            </form>
          </li>`,
      )}
    </ul>
  </details>`;
}

// The column of the pages of «Мешки»: the treasury, the active pouches in the order they were
// made, «+ Новый мешок» once there is a pouch, and the storeroom.
function pouchColumn(column: PouchColumn, money: MoneyFormat, place: ColumnPlace) {
  const treasury = treasuryFrame(column.treasury, money, place.buttons);
  if (column.pouches.length === 0) {
    return column.stored.length === 0
      ? treasury
      : html`${treasury}
          <div class="list-foot">${storeroom(column.stored)}</div>`;
  }
  return html`${treasury}
    <ul class="pouches">
      ${column.pouches.map((pouch) => pouchRow(pouch, money, place))}
    </ul>
    <div class="list-foot">
      <a class="link-plain" href="/saeckel/pouches/new">+ Новый мешок</a>
      ${storeroom(column.stored)}
    </div>`;
}

// Мешки, texts from design/preview/Saeckel.html, SaeckelMobile.html, SaeckelEmpty.html and
// SaeckelEmptyMobile.html. The treasury is always there; the empty state is about the active
// pouches, beside the treasury and the storeroom (M6.1: SaeckelEmpty has no treasury); on a
// computer the picture and the form of the first pouch stand to the right of them; the cat of the
// picture is decor of Hof (data-poke, M10.5) and sniffs at the pouches when pressed. With pouches,
// the first of the list is open on the right of a computer, as in Saeckel; the phone has only
// the list, its pouches open on their own pages (SaeckelMobile).
function pouchesPage(
  column: PouchColumn,
  money: MoneyFormat,
  first: { pouch: Pouch; view: PouchView } | null,
) {
  if (first !== null) {
    return saeckelPage(
      {
        title: 'Säckel — мешки',
        tab: 'pouches',
        column: pouchColumn(column, money, { open: first.pouch.id, buttons: true }),
      },
      html`<div class="sk-main sk-first">${pouchPane(first.pouch, first.view, money, 2)}</div>
        ${blot('ink-blot-medium', 'blot-pouches-medium')}
        ${blot('ink-splatter-a', 'blot-pouches-splatter')} ${blot('ink-drip', 'blot-pouches-drip')}
        ${blot('ink-blot-small', 'blot-pouches-small')}`,
    );
  }
  return saeckelPage(
    {
      title: 'Säckel — мешки',
      tab: 'pouches',
      column: pouchColumn(column, money, { buttons: true }),
    },
    html`<div class="sk-main sk-empty">
        <span class="vignette sniff" aria-hidden="true"
          ><img src="/saeckel/static/img/empty-saeckel.webp" alt="" /><span
            class="cat"
            data-poke="sniff"
          ></span
        ></span>
        <div class="sk-empty-text">
          <h2 class="title">Мешков пока нет</h2>
          <img class="sprig" src="/saeckel/static/img/sprig-divider.webp" alt="" />
          <p class="muted">
            Заведите первый мешок: «Продукты», «Квартира», «Транспорт». Траты берутся из мешка, а
            остаток переходит дальше сам.
          </p>
          ${newPouchForm({ name: '' })}
          <p class="hint text-full">Знак мешка можно выбрать потом, в «Изменить».</p>
        </div>
      </div>
      <img class="sk-corner" src="/saeckel/static/img/sprig-corner.webp" alt="" loading="lazy" />
      ${blot('ink-blot-medium', 'blot-empty-medium')}`,
  );
}

// «Новый мешок» (no picture of its own): the form on the right, in a frame drawn by pen, like the
// forms of SaeckelForms; on the phone one column (IncomeMobile).
function newPouchPage(form: NewPouchForm, column: PouchColumn, money: MoneyFormat) {
  return saeckelPage(
    {
      title: 'Säckel — новый мешок',
      tab: 'pouches',
      back: { href: '/saeckel/', text: 'Мешки' },
      column: pouchColumn(column, money, { buttons: true }),
    },
    html`<div class="sk-form">
      <h1 class="title t-2">Новый мешок</h1>
      ${newPouchForm(form)}
    </div>`,
  );
}

// «Сумма», «Дата», «Заметка» of a form (design/preview/Saeckel.html, SaeckelForms.html,
// PouchMobile.html): fields drawn by pen, the amount larger. What was typed stays in the fields;
// the error of a field is under it, and the field is drawn red.
function entryFields(form: EntryForm, money: MoneyFormat) {
  const attributes = (field: EntryField) =>
    form.errors[field] === undefined
      ? ''
      : html`aria-invalid="true" aria-describedby="${field}-error"`;
  const fieldClass = (field: EntryField) =>
    form.errors[field] === undefined ? `field field-${field}` : `field field-${field} err`;
  const error = (field: EntryField) =>
    form.errors[field] === undefined
      ? ''
      : html`<p id="${field}-error" class="err-text">${form.errors[field]}</p>`;
  return html`<div class="${fieldClass('amount')}">
      <label for="amount">Сумма, ${money.symbol}</label>
      <input
        id="amount"
        class="input big"
        name="amount"
        type="text"
        inputmode="decimal"
        autocomplete="off"
        required
        value="${form.amount}"
        ${attributes('amount')}
      />
      ${error('amount')}
    </div>
    <div class="${fieldClass('date')}">
      <label for="date">Дата</label>
      <input
        id="date"
        class="input"
        name="date"
        type="text"
        value="${form.date}"
        ${attributes('date')}
      />
      ${error('date')}
    </div>
    <div class="${fieldClass('note')}">
      <label for="note">Заметка</label>
      <input
        id="note"
        class="input"
        name="note"
        type="text"
        value="${form.note}"
        ${attributes('note')}
      />
      ${error('note')}
    </div>`;
}

// The form «Записать трату» (design/preview/Saeckel.html, PouchMobile.html): on a computer the
// fields and the button in a row, on the phone in a frame, the amount the whole width. Its
// heading is for the screen reader only on the phone; `level` is the level of that heading. With
// «Анимации» or «Звуки» the page of the pouch after it rings and writes the record in (data-fx,
// read by fx.js of Hof, M10.5) — as do the pages after an income, laying out and a transfer.
function expenseForm(pouch: Pouch, form: EntryForm, money: MoneyFormat, level: 2 | 3) {
  const heading =
    level === 2
      ? html`<h2 class="title t-3 visually-hidden-phone">Записать трату</h2>`
      : html`<h3 class="title t-3 visually-hidden-phone">Записать трату</h3>`;
  return html`<form
    class="expense"
    method="post"
    action="/saeckel/pouches/${pouch.id}/expense"
    data-fx="expense"
  >
    ${heading}
    <div class="expense-row">
      ${entryFields(form, money)}
      <button type="submit" class="btn btn-ochre">Записать трату</button>
    </div>
  </form>`;
}

// «Доход», texts from design/preview/SaeckelForms.html and IncomeMobile.html: the form on the
// right in its frame; on a computer the amount, the date and the note in a row, on the phone one
// under another.
function incomePage(form: EntryForm, money: MoneyFormat, column: PouchColumn) {
  return saeckelPage(
    {
      title: 'Säckel — доход',
      tab: 'pouches',
      back: { href: '/saeckel/', text: 'Мешки' },
      column: pouchColumn(column, money, { buttons: true }),
    },
    html`<div class="sk-form">
      <h1 class="title t-2">Доход</h1>
      <form class="entry" method="post" action="/saeckel/income" data-fx="income">
        <div class="entry-row">${entryFields(form, money)}</div>
        <p class="hint">
          Деньги лягут в казну. После записи откроется раскладка по мешкам — её можно отложить.
        </p>
        <button type="submit" class="btn btn-ochre">Записать доход</button>
      </form>
    </div>`,
  );
}

// «Разложить по мешкам», texts from design/preview/SaeckelAssign.html and AssignMobile.html. The
// income just written, if any, is named above in a note with the blue seal: in full on a
// computer, on the phone only its first sentence, the whole of it left to the screen reader. On a
// computer a table — the sign and the name, the balance, a field; on the phone the same rows as
// lines of AssignMobile, the balance under the name. The error of a row is under its field; a
// refusal of the whole form is a note with the red seal. The note of the income is what fx.js of
// Hof looks for before it rings after «Записать доход» (note-income).
function assignPage(
  column: PouchColumn,
  form: AssignForm,
  income: number | null,
  money: MoneyFormat,
) {
  const { pouches, treasury } = column;
  const row = (pouch: ListedPouch) => {
    const field = `amount_${pouch.id}`;
    const error = form.errors.get(pouch.id);
    const describedBy =
      error === undefined ? '' : html`aria-invalid="true" aria-describedby="${field}-error"`;
    return html`<tr>
      <td class="assign-pouch">
        <span class="assign-sign"
          >${signPicture(pouch.icon)}<span class="assign-name">${pouch.name}</span></span
        >
      </td>
      <td class="${pouch.balance < 0 ? 'num money neg' : 'num money'}">
        ${money.format(pouch.balance)}
      </td>
      <td class="${error === undefined ? 'put' : 'put err'}">
        <input
          class="input slim"
          name="${field}"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          value="${form.typed.get(pouch.id) ?? ''}"
          aria-label="Положить в мешок ${pouch.name}"
          ${describedBy}
        />
        ${error === undefined ? '' : html`<p id="${field}-error" class="err-text">${error}</p>`}
      </td>
    </tr>`;
  };
  const sum = html`<span class="${treasury < 0 ? 'money neg' : 'money'}"
    >${money.format(treasury)}</span
  >`;
  return saeckelPage(
    {
      title: 'Säckel — разложить',
      tab: 'pouches',
      back: { href: '/saeckel/', text: 'Мешки' },
      column: pouchColumn(column, money, { buttons: false }),
    },
    html`${
        income === null
          ? ''
          : html`<p class="note note-income">
              Доход ${money.format(income)} лёг в казну.<span class="visually-hidden-phone">
                Разложите его по мешкам или оставьте в казне на потом.</span
              >
            </p>`
      }
      <div class="assign-head">
        <h1 class="title t-2">Разложить по мешкам</h1>
        <p class="muted">
          В казне: ${sum}.${pouches.length === 0 ? '' : ' Пустые поля пропускаются.'}
        </p>
      </div>
      ${
        form.refusal === undefined
          ? ''
          : html`<p id="refusal" class="note note-error">${form.refusal}</p>`
      }
      ${
        pouches.length === 0
          ? html`<div class="assign-empty">
              <h2 class="title t-3">Мешков пока нет</h2>
              <p><a class="link" href="/saeckel/pouches/new">+ Новый мешок</a></p>
            </div>`
          : html`<form class="assign" method="post" action="/saeckel/assign" data-fx="assign">
              <table class="table assign-table">
                <thead>
                  <tr>
                    <th>Мешок</th>
                    <th class="num">Сейчас в мешке</th>
                    <th class="put-head">Положить, ${money.symbol}</th>
                  </tr>
                </thead>
                <tbody>
                  ${pouches.map(row)}
                </tbody>
              </table>
              <div class="assign-actions">
                <button type="submit" class="btn btn-ochre">Разложить</button>
                <a class="link" href="/saeckel/">Позже — вернуться к мешкам</a>
              </div>
            </form>`
      }
      ${blot('ink-blot-small', 'blot-assign-small')} ${blot('ink-ring', 'blot-assign-ring')}`,
  );
}

// «Покрыть из другого мешка» (§6, design/preview/PouchEditMobile.html), only under a balance
// below zero: «Переложить» with this pouch as the target and its debt as the amount. A debt
// larger than one record can hold is left out, and the form then asks for the amount. Only a
// hint for the form: the debt may change before it is sent.
function coverLink(pouchId: number, balance: number) {
  if (balance >= 0) return '';
  const debt = -balance;
  const amount =
    debt <= AMOUNT_MAX_CENTS ? `&amount=${encodeURIComponent(amountForField(debt))}` : '';
  return html`<p class="cover">
    <a class="link" href="/saeckel/transfer?to=${pouchId}${amount}">Покрыть из другого мешка</a>
  </p>`;
}

// One list of pouches of a form (design/preview/SaeckelForms.html): the active pouches of the
// user, each with its text, and in «Переложить» an empty choice first. Drawn as a field with an
// arrow by pen; its error is under it, and the field is drawn red. Only an id of one of them is
// ever shown as chosen.
function pouchSelect(
  field: PouchField,
  label: string,
  choices: readonly { id: number; text: string }[],
  form: PouchesForm,
  empty: boolean,
) {
  const error = form.errors[field];
  const describedBy =
    error === undefined ? '' : html`aria-invalid="true" aria-describedby="${field}-error"`;
  const classes = error === undefined ? `field field-${field}` : `field field-${field} err`;
  return html`<div class="${classes}">
    <label for="${field}">${label}</label>
    <span class="select">
      <select id="${field}" name="${field}" class="input" ${describedBy}>
        ${empty ? html`<option value="">— выберите —</option>` : ''}
        ${choices.map(
          (choice) =>
            html`<option
              value="${choice.id}"
              ${String(choice.id) === form[field] ? html`selected` : ''}
            >
              ${choice.text}
            </option>`,
        )}
      </select>
    </span>
    ${error === undefined ? '' : html`<p id="${field}-error" class="err-text">${error}</p>`}
  </div>`;
}

// «Переложить из мешка в мешок», texts from design/preview/SaeckelForms.html: the form on the
// right in its frame; the two lists side by side while their longest line fits half of the
// frame, else one under another; on the phone one column, as in IncomeMobile.
function transferPage(column: PouchColumn, form: PouchesForm, money: MoneyFormat) {
  const choices = column.pouches.map((pouch) => ({
    id: pouch.id,
    text: `${pouch.name} — ${money.format(pouch.balance)}`,
  }));
  return saeckelPage(
    {
      title: 'Säckel — переложить',
      tab: 'pouches',
      back: { href: '/saeckel/', text: 'Мешки' },
      column: pouchColumn(column, money, { buttons: true }),
    },
    html`<div class="sk-form">
      <h1 class="title t-2">Переложить из мешка в мешок</h1>
      <form class="entry" method="post" action="/saeckel/transfer" data-fx="transfer">
        <div class="pouch-pair">
          ${pouchSelect('from', 'Из мешка', choices, form, true)}
          ${pouchSelect('to', 'В мешок', choices, form, true)}
        </div>
        <div class="entry-row">${entryFields(form, money)}</div>
        <button type="submit" class="btn btn-ochre">Переложить</button>
      </form>
    </div>`,
  );
}

// One movement of a pouch, seen from that pouch, as a row of Saeckel and PouchMobile: the date
// ДД.ММ, the kind — «Трата», «из казны», «из мешка «X»» or «в мешок «Y»» — the note, and the
// amount: what comes in has «+», what goes out «−». The record just written is marked — `mark`,
// drawn by pen — with no animation (§4.8: a record written twice is seen at once).
function movementRow(
  movement: Operation,
  pouchId: number,
  fresh: string | undefined,
  money: MoneyFormat,
) {
  const incoming = movement.toPouchId === pouchId;
  const kind =
    movement.kind === 'expense'
      ? 'Трата'
      : movement.kind === 'assign'
        ? 'из казны'
        : incoming
          ? `из мешка «${movement.fromName}»`
          : `в мешок «${movement.toName}»`;
  const amount = incoming ? `+${money.format(movement.cents)}` : money.format(-movement.cents);
  const row = movement.kind === 'expense' ? 'move move-expense' : 'move';
  const cells = html`<span class="move-date">${dateForList(movement.date)}</span>
    <span class="move-kind">${kind}</span>
    <span class="move-note">${movement.note}</span>
    <span class="move-sum">${amount}</span>`;
  return html`<li>
    ${
      String(movement.id) === fresh
        ? html`<mark class="${row}">${cells}</mark>`
        : html`<span class="${row}">${cells}</span>`
    }
  </li>`;
}

// Where a record of «Летопись» goes: «Казна» for an income, the pouch, or «Отпуск →
// Транспорт».
function operationPouches(operation: Operation): string {
  if (operation.kind === 'income') return 'Казна';
  if (operation.kind === 'assign') return operation.toName ?? '';
  if (operation.kind === 'expense') return operation.fromName ?? '';
  return `${operation.fromName} → ${operation.toName}`;
}

// The amount of a record of «Летопись»: income and laying out «+», an expense «−», a transfer
// without a sign — it stays among the pouches.
function signedAmount(operation: Operation, money: MoneyFormat): string {
  if (operation.kind === 'expense') return money.format(-operation.cents);
  if (operation.kind === 'transfer') return money.format(operation.cents);
  return `+${money.format(operation.cents)}`;
}

// An address of «Летопись», with the pouch it is filtered by.
function historyHref(pouch: number | null, page: number): string {
  const query = new URLSearchParams(pouch === null ? {} : { pouch: String(pouch) });
  query.set('page', String(page));
  return `/saeckel/history?${query.toString()}`;
}

// One record of «Летопись» (design/preview/SaeckelHistory.html): a row of the table — the date,
// the pouches, the kind, the note, the amount and «›» to the record. On the phone the same row is a
// line of HistoryMobile — the date and the amount, «pouch · kind», the note — and its link covers
// the whole line: one link a record, named as before, described by its row. The kind is in its
// own cell on a computer and after the pouches on the phone, where a transfer is «Переложено», as
// HistoryMobile has it; CSS shows one of the two. An expense is red on the phone only, as the two
// prototypes have it.
function historyRow(operation: Operation, money: MoneyFormat) {
  const kind = KIND_LABELS[operation.kind];
  const phoneKind = operation.kind === 'transfer' ? 'Переложено' : kind;
  return html`<tr id="op-${operation.id}">
    <td class="h-date">${dateForField(operation.date)}</td>
    <td class="h-pouch">
      ${operationPouches(operation)}<span class="h-kind-phone"> · ${phoneKind}</span>
    </td>
    <td class="h-kind">${kind}</td>
    <td class="h-note">${operation.note}</td>
    <td class="${operation.kind === 'expense' ? 'h-sum neg' : 'h-sum'}">
      ${signedAmount(operation, money)}
    </td>
    <td class="h-go">
      <a
        class="link-plain"
        href="/saeckel/operations/${operation.id}"
        aria-label="Открыть запись"
        aria-describedby="op-${operation.id}"
        >›</a
      >
    </td>
  </tr>`;
}

// «Летопись», texts from design/preview/SaeckelHistory.html, HistoryMobile.html and
// SaeckelHistoryEmpty.html: the whole width under the tabs, no column of pouches. A filter by
// pouch with «Показать» — without a script the list does not send the form itself — 50 records a
// page, «Назад» and «Следующие 50». With no record at all, the empty page: the closed book, on the
// phone above the text, as in SaeckelEmptyMobile. A pouch without records and a page past the
// last one say so under the filter (no picture of their own). «Назад» and «Следующие 50» do not
// turn the page: with «Звуки» the next one only rustles (data-fx="page").
function historyPage(view: HistoryView, money: MoneyFormat) {
  if (view.operations.length === 0 && view.page === 1 && view.pouch === null) {
    return saeckelPage(
      { title: 'Säckel — летопись', tab: 'history' },
      html`<div class="sk-empty history-empty">
          <img class="vignette" src="/saeckel/static/img/empty-history-closed.webp" alt="" />
          <div class="sk-empty-text">
            <h2 class="title">Летопись пока пуста</h2>
            <img class="sprig" src="/saeckel/static/img/sprig-divider.webp" alt="" />
            <p class="muted">
              Сюда ляжет каждый доход, трата и перекладывание — по порядку, с датой и заметкой.
            </p>
            <p class="empty-actions">
              <a class="btn btn-ochre" href="/saeckel/income">Записать доход</a>
              <a class="link" href="/saeckel/">К мешкам</a>
            </p>
          </div>
        </div>
        <img class="sk-corner" src="/saeckel/static/img/sprig-corner.webp" alt="" loading="lazy" />
        ${blot('ink-blot-small', 'blot-history-empty')}`,
    );
  }
  const none = view.page === 1 ? EMPTY_POUCH_HISTORY : PAST_LAST_PAGE;
  const back = view.page > 1;
  return saeckelPage(
    { title: 'Säckel — летопись', tab: 'history' },
    html`<div class="history-head">
        <h2 class="title t-2 visually-hidden-phone">Летопись</h2>
        <form class="history-filter" method="get" action="/saeckel/history">
          <div class="field">
            <label for="pouch">Мешок</label>
            <span class="select">
              <select id="pouch" name="pouch" class="input slim">
                <option value="">Все мешки</option>
                ${view.pouches.map(
                  (pouch) =>
                    html`<option
                      value="${pouch.id}"
                      ${pouch.id === view.pouch ? html`selected` : ''}
                    >
                      ${pouch.is_archived ? `${pouch.name} (в Кладовой)` : pouch.name}
                    </option>`,
                )}
              </select>
            </span>
          </div>
          <button type="submit" class="btn">Показать</button>
        </form>
      </div>
      ${
        view.operations.length > 0
          ? html`<table class="table history">
              <thead>
                <tr>
                  <th class="h-date">Дата</th>
                  <th class="h-pouch">Мешок</th>
                  <th class="h-kind">Запись</th>
                  <th class="h-note">Заметка</th>
                  <th class="h-sum">Сумма</th>
                  <th class="h-go"></th>
                </tr>
              </thead>
              <tbody>
                ${view.operations.map((operation) => historyRow(operation, money))}
              </tbody>
            </table>`
          : html`<p class="muted history-none">${none}</p>`
      }
      ${
        back || view.hasNext
          ? html`<nav class="pages" aria-label="Страницы летописи">
              ${
                back
                  ? html`<a
                      class="btn"
                      href="${historyHref(view.pouch, view.page - 1)}"
                      data-fx="page"
                      >Назад</a
                    >`
                  : ''
              }
              ${
                view.hasNext
                  ? html`<a
                      class="btn"
                      href="${historyHref(view.pouch, view.page + 1)}"
                      data-fx="page"
                      >Следующие 50</a
                    >`
                  : ''
              }
            </nav>`
          : ''
      }
      ${blot('ink-blot-medium', 'blot-history-medium')}
      ${blot('ink-splatter-b', 'blot-history-splatter')}`,
  );
}

// Whether a pouch of the record is in the storeroom: then the record is not changed (§5.4).
const inStoreroom = (operation: Operation) => operation.fromArchived || operation.toArchived;

// A record of «Летопись», to read (no picture of its own): the frame of a record, for each of its
// pouches in the storeroom a note with the red seal — why it is not changed, with the way to that
// pouch — then its amount, date, pouches and note as lines ruled by pen.
function operationPage(operation: Operation, money: MoneyFormat) {
  const stored = [
    [operation.fromArchived, operation.fromPouchId, operation.fromName],
    [operation.toArchived, operation.toPouchId, operation.toName],
  ] as const;
  const pouchLink = (id: number | null, name: string | null) =>
    html`<a class="link" href="/saeckel/pouches/${id}">${name}</a>`;
  const line = (term: string, value: string, kind = 'line') =>
    html`<div class="${kind}">
      <dt>${term}</dt>
      <dd>${value}</dd>
    </div>`;
  return saeckelPage(
    {
      title: 'Säckel — запись',
      tab: 'history',
      back: { href: '/saeckel/history', text: 'Летопись' },
    },
    html`<div class="sk-form record">
      <h1 class="title t-2">${KIND_LABELS[operation.kind]} · ${dateForField(operation.date)}</h1>
      ${stored.map(([archived, id, name]) =>
        archived
          ? html`<p class="note note-error">
              Мешок «${pouchLink(id, name)}» в Кладовой: запись с ним не исправляется и не
              удаляется. Сначала верните мешок.
            </p>`
          : '',
      )}
      <dl class="record-lines">
        ${line('Сумма', money.format(operation.cents), 'line line-sum')}
        ${line('Дата', dateForField(operation.date))}
        ${operation.fromName === null ? '' : line('Из мешка', operation.fromName)}
        ${operation.toName === null ? '' : line('В мешок', operation.toName)}
        ${operation.note === '' ? '' : line('Заметка', operation.note, 'line line-note')}
      </dl>
    </div>`,
  );
}

// A record to change (design/preview/SaeckelForms.html, «Трата · 05.10.2026»): the lists of its
// pouches by its kind — the active pouches by name, the chosen one first chosen — then the
// amount, the date and the note. One list stands beside the amount, the date and the note under
// them, as in the prototype; two lists stand above the fields, as in «Переложить»; an income has
// the fields only. The heading keeps the stored date; the kind does not change. «Сохранить» and
// «Удалить» stand in a row: «Сохранить» belongs to the form by its `form`, «Удалить» is a
// <details> (§4.1) whose opening is the confirmation — no script, and no form inside another.
function operationEditPage(
  operation: Operation,
  pouches: readonly { id: number; name: string }[],
  form: PouchesForm,
  money: MoneyFormat,
) {
  const choices = pouches.map((pouch) => ({ id: pouch.id, text: pouch.name }));
  const fields = POUCH_FIELDS[operation.kind];
  const lists = html`${fields.includes('from') ? pouchSelect('from', 'Из мешка', choices, form, false) : ''}
  ${fields.includes('to') ? pouchSelect('to', 'В мешок', choices, form, false) : ''}`;
  let body;
  if (fields.length === 1) {
    body = html`<div class="record-row">${lists} ${entryFields(form, money)}</div>`;
  } else if (fields.length === 2) {
    body = html`<div class="pouch-pair">${lists}</div>
      <div class="entry-row">${entryFields(form, money)}</div>`;
  } else {
    body = html`<div class="entry-row">${entryFields(form, money)}</div>`;
  }
  return saeckelPage(
    {
      title: 'Säckel — запись',
      tab: 'history',
      back: { href: '/saeckel/history', text: 'Летопись' },
    },
    html`<div class="sk-form record">
      <h1 class="title t-2">${KIND_LABELS[operation.kind]} · ${dateForField(operation.date)}</h1>
      <form id="record" class="entry" method="post" action="/saeckel/operations/${operation.id}">
        ${body}
        <p class="hint">Вид записи не меняется. Удаление попросит подтверждения.</p>
      </form>
      <div class="record-actions">
        <button type="submit" form="record" class="btn btn-ochre">Сохранить</button>
        <details class="delete">
          <summary class="btn btn-danger">Удалить</summary>
          <form method="post" action="/saeckel/operations/${operation.id}/delete">
            <button type="submit" class="btn btn-danger">Удалить запись</button>
          </form>
        </details>
      </div>
    </div>`,
  );
}

// An open pouch (design/preview/Saeckel.html on the right, PouchMobile.html): its sign and name
// with «Переложить» and «Изменить», the balance in a frame drawn by pen — red below zero, then
// «Покрыть из другого мешка» — the refusal, if any, the form of an expense and the last
// movements. A pouch in the storeroom has neither the links nor the form, only «Вернуть»: it is
// brought back first. `heading` is the level of its name: 1 on its own page, 2 on Мешки, where
// the ribbon is the h1.
function pouchPane(pouch: Pouch, view: PouchView, money: MoneyFormat, heading: 1 | 2) {
  const name =
    heading === 1
      ? html`<h1 class="title t-1">${pouch.name}</h1>`
      : html`<h2 class="title t-1">${pouch.name}</h2>`;
  return html`<div class="pouch-pane">
    <div class="pouch-head">
      ${signPicture(pouch.icon)} ${name}
      ${
        pouch.is_archived
          ? ''
          : html`<p class="pouch-links">
              <a class="link" href="/saeckel/transfer?from=${pouch.id}">Переложить</a>
              <a class="link" href="/saeckel/pouches/${pouch.id}/edit" data-fx="flip-fwd-phone"
                >Изменить</a
              >
            </p>`
      }
    </div>
    <p class="balance">
      <span class="caps">Остаток</span>
      <span class="${view.balance < 0 ? 'money neg' : 'money'}">${money.format(view.balance)}</span>
    </p>
    ${pouch.is_archived ? '' : coverLink(pouch.id, view.balance)}
    ${
      view.refusal === undefined
        ? ''
        : html`<p id="refusal" class="note note-error">${view.refusal}</p>`
    }
    ${
      pouch.is_archived
        ? html`<form class="restore" method="post" action="/saeckel/pouches/${pouch.id}/restore">
            <button type="submit" class="btn btn-ochre">Вернуть</button>
          </form>`
        : expenseForm(pouch, view.form, money, heading === 1 ? 2 : 3)
    }
    ${
      view.movements.length === 0
        ? ''
        : html`<ul class="moves">
            ${view.movements.map((movement) => movementRow(movement, pouch.id, view.fresh, money))}
          </ul>`
    }
  </div>`;
}

// The page of a pouch: the open pouch beside the column, where it is the current one; the blots
// of Saeckel on a computer and of PouchMobile on the phone.
function pouchPage(pouch: Pouch, view: PouchView, money: MoneyFormat, column: PouchColumn) {
  return saeckelPage(
    {
      title: `Säckel — ${pouch.name}`,
      tab: 'pouches',
      back: { href: '/saeckel/', text: 'Мешки' },
      column: pouchColumn(column, money, { current: pouch.id, buttons: true }),
    },
    html`${pouchPane(pouch, view, money, 1)} ${blot('ink-blot-medium', 'blot-pouches-medium')}
    ${blot('ink-splatter-a', 'blot-pouches-splatter')} ${blot('ink-drip', 'blot-pouches-drip')}
    ${blot('ink-splatter-b', 'blot-pouch-splatter')}`,
  );
}

// «Изменить», texts from design/preview/PouchEditMobile.html and the frame «Мешок «Транспорт»» of
// SaeckelForms.html: the name and the sign — each sign a picture with its word, the chosen one
// ringed by pen — then «В кладовую», in the same frame under a line on a computer and in a frame
// of its own on the phone. The heading keeps the stored name; the fields show what was typed and
// chosen. Only an empty pouch goes into the storeroom: with any other balance the block says why
// and its button is off, as in the design; the server checks again under the lock.
function editPouchPage(
  pouch: Pouch,
  form: EditPouchForm,
  balance: number,
  money: MoneyFormat,
  column: PouchColumn,
) {
  const describedBy = form.error?.field === 'icon' ? html`aria-describedby="icon-error"` : '';
  return saeckelPage(
    {
      title: `Säckel — ${pouch.name}`,
      tab: 'pouches',
      back: { href: `/saeckel/pouches/${pouch.id}`, text: pouch.name },
      column: pouchColumn(column, money, { current: pouch.id, buttons: true }),
    },
    html`<div class="sk-form pouch-edit">
      <form method="post" action="/saeckel/pouches/${pouch.id}/edit">
        <h1 class="title t-2">Мешок «${pouch.name}»</h1>
        ${nameField(form.name, form.error)}
        <fieldset class="signs" ${describedBy}>
          <legend>Знак мешка</legend>
          <div class="icons">
            ${(Object.keys(ICONS) as Icon[]).map(
              (icon) =>
                html`<label class="icon-pick">
                  <input
                    type="radio"
                    name="icon"
                    value="${icon}"
                    ${icon === form.icon ? html`checked` : ''}
                  />
                  ${signPicture(icon)} ${ICONS[icon]}
                </label>`,
            )}
          </div>
        </fieldset>
        ${formError(form.error, 'icon')}
        <button type="submit" class="btn btn-ochre">Сохранить</button>
      </form>
      <section class="to-storeroom">
        <h2 class="title t-3">В кладовую</h2>
        ${
          balance === 0
            ? ''
            : html`<p class="muted">
                Убрать в кладовую можно только пустой мешок. Сейчас в нём
                <span class="${balance < 0 ? 'money neg' : 'money'}">${money.format(balance)}</span
                >.
              </p>`
        }
        <div class="to-storeroom-actions">
          <form method="post" action="/saeckel/pouches/${pouch.id}/archive">
            <button type="submit" class="btn" ${balance === 0 ? '' : html`disabled`}>
              В кладовую
            </button>
          </form>
          ${coverLink(pouch.id, balance)}
        </div>
      </section>
    </div>`,
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

// The active pouches of one user with their signs, balances and the last expense of each, in
// one query (§5.6). A balance is what came into the pouch minus what went out of it, over every record
// of the user whatever its kind: assign and transfer in, expense and transfer out. Sums come
// back as text, as pg gives bigint and numeric.
const POUCHES_WITH_BALANCES = `
  SELECT p.id, p.name, p.icon, coalesce(moved.balance, 0)::text AS balance,
         last.amount::text AS last_expense
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

// The records of one user with the names of their pouches, by one statement; the callers add
// their own condition, order and limit. A pouch is joined by its user too, not by its id alone.
// The date comes as ISO text, as PostgreSQL keeps it, with no time zone to move it.
const OPERATIONS = `
  SELECT o.id, o.kind, o.amount::text AS amount, to_char(o.date, 'YYYY-MM-DD') AS date, o.note,
         o.from_pouch_id, o.to_pouch_id, f.name AS from_name, t.name AS to_name,
         coalesce(f.is_archived, false) AS from_archived, coalesce(t.is_archived, false) AS to_archived
    FROM operations o
    LEFT JOIN pouches f ON f.id = o.from_pouch_id AND f.user_id = o.user_id
    LEFT JOIN pouches t ON t.id = o.to_pouch_id AND t.user_id = o.user_id
   WHERE o.user_id = $1`;

interface OperationRow {
  id: number;
  kind: Kind;
  amount: string;
  date: string;
  note: string;
  from_pouch_id: number | null;
  to_pouch_id: number | null;
  from_name: string | null;
  to_name: string | null;
  from_archived: boolean;
  to_archived: boolean;
}

function operationFrom(row: OperationRow): Operation {
  return {
    id: row.id,
    kind: row.kind,
    cents: centsFrom(row.amount),
    date: row.date,
    note: row.note,
    fromPouchId: row.from_pouch_id,
    toPouchId: row.to_pouch_id,
    fromName: row.from_name,
    toName: row.to_name,
    fromArchived: row.from_archived,
    toArchived: row.to_archived,
  };
}

// §4.8: a record of this user locked FOR UPDATE, before any of its pouches — by a change and by
// a deletion alike, so neither waits for the other in a circle. Its pouches as they are now.
const LOCK_OPERATION =
  'SELECT from_pouch_id, to_pouch_id FROM operations WHERE id = $1 AND user_id = $2 FOR UPDATE';

// A list of pouches of a form, as sent (§4.6, §4.7): nothing chosen, an id of the wrong form,
// or the id to look for under the lock. The error goes under the list.
function parsePouchField(form: PouchesForm, field: PouchField): number | null {
  if (form[field] === '') {
    form.errors[field] = CHOOSE_POUCH_ERROR;
    return null;
  }
  const id = parseId(form[field]);
  if (id === null) form.errors[field] = MISSING_ERROR;
  return id;
}

// §4.7: `page` of «Летопись» — none is the first; otherwise digits without a leading zero, from 1
// to the last page. Anything else is null, and the caller answers 404.
function parsePage(input: string | undefined): number | null {
  if (input === undefined) return 1;
  if (!/^[1-9][0-9]{0,3}$/.test(input)) return null;
  const page = Number(input);
  return page <= HISTORY_LAST_PAGE ? page : null;
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
  if (wanted.length === 0) return [];
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

  // The last movements of one pouch of this user, newest first: every record into or out of it —
  // laid out, spent, moved in, moved out; an income touches no pouch. One statement.
  async function recentMovements(pouchId: number, userId: number): Promise<Operation[]> {
    const { rows } = await pool.query<OperationRow>(
      `${OPERATIONS} AND (o.from_pouch_id = $2 OR o.to_pouch_id = $2)
        ORDER BY o.date DESC, o.id DESC
        LIMIT ${RECENT_MOVEMENTS}`,
      [userId, pouchId],
    );
    return rows.map(operationFrom);
  }

  // The balance of one pouch of this user and its last movements, for its page.
  async function pouchState(pouchId: number, userId: number) {
    const balance = await balanceOf(pool, pouchId, userId);
    return { balance, movements: await recentMovements(pouchId, userId) };
  }

  // The record of the :id in the path, if it is the user's, with its pouches: no such record, a
  // wrong id and the record of somebody else are all null, and the caller answers the same 404.
  async function findOperation(idInPath: string, userId: number): Promise<Operation | null> {
    const id = parseId(idInPath);
    if (id === null) return null;
    const { rows } = await pool.query<OperationRow>(`${OPERATIONS} AND o.id = $2`, [userId, id]);
    return rows[0] === undefined ? null : operationFrom(rows[0]);
  }

  // The active pouches of this user by name, in the order they were made: the lists of a record.
  async function namedPouches(userId: number): Promise<{ id: number; name: string }[]> {
    const { rows } = await pool.query<{ id: number; name: string }>(
      'SELECT id, name FROM pouches WHERE user_id = $1 AND NOT is_archived ORDER BY id',
      [userId],
    );
    return rows;
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
      icon: string;
      balance: string;
      last_expense: string | null;
    }>(POUCHES_WITH_BALANCES, [userId]);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      icon: row.icon,
      balance: centsFrom(row.balance),
      lastExpense: row.last_expense === null ? null : centsFrom(row.last_expense),
    }));
  }

  // The column of a page of «Мешки» for this request (§6): the treasury, the active pouches with
  // their signs, balances and last expenses, and the storeroom, both in the order the pouches
  // were made — one statement each, whatever the number of pouches, every one bound to this
  // user. What the handler has read already is taken as it is, not read again. Only through the
  // pool and only outside a transaction of the handler: after its COMMIT or ROLLBACK, also when
  // it answers 400.
  async function columnOf(
    userId: number,
    read: { pouches?: readonly ListedPouch[]; treasury?: number } = {},
  ): Promise<PouchColumn> {
    const pouches = read.pouches ?? (await activePouches(userId));
    const treasury = read.treasury ?? (await treasuryOf(pool, userId));
    const stored = await pool.query<StoredPouch>(
      'SELECT id, name, icon FROM pouches WHERE user_id = $1 AND is_archived ORDER BY id',
      [userId],
    );
    return { treasury, pouches, stored: stored.rows };
  }

  // Мешки: the column is the page. On a computer the first pouch of the column — the active pouch
  // of this user with the smallest id, the list is in that order — is open on the right, as in
  // Saeckel: its balance is the one the column has, only its last movements are read besides.
  // No choice is kept anywhere: no cookie, no address, nothing written.
  saeckel.get('/saeckel/', signedIn, async (c) => {
    const userId = c.get('user').id;
    const column = await columnOf(userId);
    const listed = column.pouches[0];
    const first =
      listed === undefined
        ? null
        : {
            pouch: { id: listed.id, name: listed.name, icon: listed.icon, is_archived: false },
            view: {
              balance: listed.balance,
              movements: await recentMovements(listed.id, userId),
              form: emptyEntryForm(),
            },
          };
    return c.html(pouchesPage(column, money, first));
  });

  // Registered before /saeckel/pouches/:id, which would match it too.
  saeckel.get('/saeckel/pouches/new', signedIn, async (c) => {
    const column = await columnOf(c.get('user').id);
    return c.html(newPouchPage({ name: '' }, column, money));
  });

  // A new pouch: the name, and the sign only if one is sent (§4.1); the form itself has the
  // name only. The user is the one signed in; a user_id or any other field is ignored.
  saeckel.post('/saeckel/pouches/new', signedIn, async (c) => {
    const form = await c.req.parseBody();
    const typed = typeof form.name === 'string' ? form.name : '';
    const refuse = async (error: FormError) =>
      c.html(newPouchPage({ name: typed, error }, await columnOf(c.get('user').id), money), 400);
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
    return c.html(pouchPage(pouch, view, money, await columnOf(userId)));
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
      const column = await columnOf(userId);
      return c.html(pouchPage({ ...pouch, is_archived: true }, view, money, column), 400);
    };
    // Already seen by the look-up. The check that counts is the one under the lock below.
    if (pouch.is_archived) return refuseArchived();

    const { form, entry } = parseEntry(
      await c.req.parseBody(),
      today(settings.timeZone, new Date()),
    );
    if (entry === null) {
      const state = await pouchState(pouch.id, userId);
      return c.html(pouchPage(pouch, { ...state, form }, money, await columnOf(userId)), 400);
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
  saeckel.get('/saeckel/income', signedIn, async (c) => {
    const column = await columnOf(c.get('user').id);
    return c.html(incomePage(emptyEntryForm(), money, column));
  });

  // An income: into the treasury, out of no pouch. One INSERT and no transaction of our own:
  // an income touches no pouch, so there is nothing to lock (§4.8). The user is the one signed
  // in; a user_id, a kind or pouches in the form are ignored.
  saeckel.post('/saeckel/income', signedIn, async (c) => {
    const { form, entry } = parseEntry(
      await c.req.parseBody(),
      today(settings.timeZone, new Date()),
    );
    if (entry === null) {
      return c.html(incomePage(form, money, await columnOf(c.get('user').id)), 400);
    }
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
    const column = await columnOf(userId, {
      pouches: await activePouches(userId),
      treasury: await treasuryOf(pool, userId),
    });
    // An error of a row the page does not show — somebody else's pouch, one in the storeroom or
    // none at all — is told without its name.
    const shown = new Set(column.pouches.map((pouch) => pouch.id));
    const hidden = [...form.errors.keys()].some((id) => !shown.has(id));
    const refusal = form.refusal ?? (hidden ? MISSING_ERROR : undefined);
    return assignPage(column, { ...form, refusal }, income, money);
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

  // «Переложить». `from`, `to` and `amount` only fill the form in (§4.1, §4.7): a pouch is
  // chosen only if it is an active pouch of this user, an amount only if it parses, and then
  // as Hof writes it, never as it came. Anything else leaves the field empty.
  saeckel.get('/saeckel/transfer', signedIn, async (c) => {
    const userId = c.get('user').id;
    const pouches = await activePouches(userId);
    const own = (name: PouchField) => {
      const id = parseId(c.req.query(name) ?? '');
      return pouches.some((pouch) => pouch.id === id) ? String(id) : '';
    };
    const amount = parseAmount(c.req.query('amount') ?? '');
    const form: PouchesForm = {
      ...emptyEntryForm(),
      amount: 'cents' in amount ? amountForField(amount.cents) : '',
      from: own('from'),
      to: own('to'),
    };
    return c.html(transferPage(await columnOf(userId, { pouches }), form, money));
  });

  // A transfer (§4.1, §4.8): every field first, then one transaction that locks both pouches by
  // one statement in the order of their ids — whichever way the money goes, so two transfers
  // in opposite directions wait for each other instead of in a circle — and checks them before
  // the INSERT: both found, two different ones, neither in the storeroom. An archiving of
  // either pouch takes the same lock: it either waits and then sees this record in the balance,
  // or goes first and this is refused. The source may go below zero; the treasury is not
  // touched.
  saeckel.post('/saeckel/transfer', signedIn, async (c) => {
    const userId = c.get('user').id;
    const body = await c.req.parseBody();
    const parsed = parseEntry(body, today(settings.timeZone, new Date()));
    const typed = (name: PouchField) => {
      const value = body[name];
      return typeof value === 'string' ? value : '';
    };
    const form: PouchesForm = {
      ...parsed.form,
      from: typed('from'),
      to: typed('to'),
      errors: { ...parsed.form.errors },
    };
    const from = parsePouchField(form, 'from');
    const to = parsePouchField(form, 'to');
    const refuse = async () => {
      const column = await columnOf(userId, { pouches: await activePouches(userId) });
      return c.html(transferPage(column, form, money), 400);
    };
    const entry = parsed.entry;
    if (entry === null || from === null || to === null || Object.keys(form.errors).length > 0) {
      return refuse();
    }

    // Why the pouches under the lock refuse the transfer, and on which field.
    let refusal: { field: PouchField; text: string } | null = null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await lockPouches(client, userId, [from, to]);
      const chosen = [
        ['from', locked.find((pouch) => pouch.id === from)],
        ['to', locked.find((pouch) => pouch.id === to)],
      ] as const;
      for (const [field, pouch] of chosen) {
        if (refusal === null && pouch === undefined) refusal = { field, text: MISSING_ERROR };
      }
      // One pouch in both lists, now known to be this user's: somebody else's or a missing one
      // was refused above as not found, like any other.
      if (refusal === null && from === to) refusal = { field: 'to', text: SAME_POUCH_ERROR };
      for (const [field, pouch] of chosen) {
        if (refusal === null && pouch?.is_archived === true) {
          refusal = { field, text: archivedCreateError(pouch.name) };
        }
      }
      if (refusal !== null) {
        await client.query('ROLLBACK');
      } else {
        await client.query(
          `INSERT INTO operations (user_id, kind, amount, currency, from_pouch_id, to_pouch_id, date, note)
           VALUES ($1, 'transfer', $2, $3, $4, $5, $6, $7)`,
          [userId, entry.cents, settings.currency, from, to, entry.date, entry.note],
        );
        await client.query('COMMIT');
      }
    } catch (error) {
      // The connection may already be broken; the original error matters more.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (refusal !== null) {
      form.errors[refusal.field] = refusal.text;
      return refuse();
    }
    return c.redirect('/saeckel/', 303);
  });

  // «Летопись» (§4.1): the records of this user, newest first, 50 a page. `pouch` is a pouch of
  // this user, active or in the storeroom: then only the records into or out of it, a transfer
  // under both of its pouches, no income. Somebody else's pouch, a missing one and a wrong id
  // are the same 404, as is a page outside 1–1000. A page past the last one is empty, not 404.
  saeckel.get('/saeckel/history', signedIn, async (c) => {
    const userId = c.get('user').id;
    const page = parsePage(c.req.query('page'));
    if (page === null) return c.notFound();
    const pouches = await pool.query<FilterPouch>(
      'SELECT id, name, is_archived FROM pouches WHERE user_id = $1 ORDER BY is_archived, id',
      [userId],
    );
    const wanted = c.req.query('pouch') ?? '';
    const pouch = wanted === '' ? null : parseId(wanted);
    if (wanted !== '' && !pouches.rows.some((own) => own.id === pouch)) return c.notFound();
    // One more than a page: whether there is a next one.
    const { rows } = await pool.query<OperationRow>(
      `${OPERATIONS} AND ($2::int IS NULL OR o.from_pouch_id = $2 OR o.to_pouch_id = $2)
        ORDER BY o.date DESC, o.id DESC
        LIMIT ${HISTORY_PAGE_SIZE + 1} OFFSET $3`,
      [userId, pouch, HISTORY_PAGE_SIZE * (page - 1)],
    );
    const view: HistoryView = {
      operations: rows.slice(0, HISTORY_PAGE_SIZE).map(operationFrom),
      page,
      pouch,
      pouches: pouches.rows,
      hasNext: rows.length > HISTORY_PAGE_SIZE && page < HISTORY_LAST_PAGE,
    };
    return c.html(historyPage(view, money));
  });

  // A record of this user, to read. Somebody else's, a missing one and a wrong id are the same
  // 404; a record of a pouch in the storeroom is shown like any other.
  saeckel.get('/saeckel/operations/:id', signedIn, async (c) => {
    const userId = c.get('user').id;
    const operation = await findOperation(c.req.param('id'), userId);
    if (operation === null) return c.notFound();
    if (inStoreroom(operation)) return c.html(operationPage(operation, money));
    const form: PouchesForm = {
      amount: amountForField(operation.cents),
      date: dateForField(operation.date),
      note: operation.note,
      from: operation.fromPouchId === null ? '' : String(operation.fromPouchId),
      to: operation.toPouchId === null ? '' : String(operation.toPouchId),
      errors: {},
    };
    return c.html(operationEditPage(operation, await namedPouches(userId), form, money));
  });

  // A record changed (§4.1, §4.8): its amount, date, note and pouches; never its kind, user or
  // currency. The look-up before only tells which lists the form has, and refuses early a
  // record already of a pouch in the storeroom. Then one transaction: the record locked FOR
  // UPDATE first; its pouches as that locked row has them now — not as the page or the
  // look-up saw them, another tab may have moved it meanwhile — together with the pouches of
  // the form, locked by one statement in the order of their ids; then the checks and the
  // UPDATE. The order «record, then pouches» is the one deleting takes too, so neither waits
  // for the other in a circle. An archiving of an old or a new pouch takes the same lock as
  // here: it either waits and then sees the record as changed, or goes first and this is
  // refused. Two tabs: the second waits for the row and writes over — the last one wins.
  saeckel.post('/saeckel/operations/:id', signedIn, async (c) => {
    const userId = c.get('user').id;
    const found = await findOperation(c.req.param('id'), userId);
    if (found === null) return c.notFound();
    if (inStoreroom(found)) return c.html(operationPage(found, money), 400);

    const body = await c.req.parseBody();
    const parsed = parseEntry(body, today(settings.timeZone, new Date()));
    const fields = POUCH_FIELDS[found.kind];
    // Only the lists this kind has; any other field — `kind`, `user_id`, `currency` — is not read.
    const typed = (name: PouchField) => {
      const value = body[name];
      return fields.includes(name) && typeof value === 'string' ? value : '';
    };
    const form: PouchesForm = {
      ...parsed.form,
      from: typed('from'),
      to: typed('to'),
      errors: { ...parsed.form.errors },
    };
    const from = fields.includes('from') ? parsePouchField(form, 'from') : null;
    const to = fields.includes('to') ? parsePouchField(form, 'to') : null;
    const refuse = async () =>
      c.html(operationEditPage(found, await namedPouches(userId), form, money), 400);
    const entry = parsed.entry;
    if (entry === null || Object.keys(form.errors).length > 0) return refuse();

    // Why the record under its lock is not changed: gone, of a pouch in the storeroom now, or a
    // list of the form refused.
    let refusal: 'missing' | 'stored' | { field: PouchField; text: string } | null = null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{
        from_pouch_id: number | null;
        to_pouch_id: number | null;
      }>(LOCK_OPERATION, [found.id, userId]);
      const row = current.rows[0];
      if (row === undefined) {
        refusal = 'missing';
      } else {
        const locked = await lockPouches(client, userId, [
          row.from_pouch_id,
          row.to_pouch_id,
          from,
          to,
        ]);
        const pouchOf = (id: number | null) => locked.find((pouch) => pouch.id === id);
        const chosen = [
          ['from', from],
          ['to', to],
        ] as const;
        if ([row.from_pouch_id, row.to_pouch_id].some((id) => pouchOf(id)?.is_archived === true)) {
          refusal = 'stored';
        }
        for (const [field, id] of chosen) {
          if (refusal === null && id !== null && pouchOf(id) === undefined) {
            refusal = { field, text: MISSING_ERROR };
          }
        }
        // One pouch in both lists of a transfer, now known to be this user's.
        if (refusal === null && from !== null && from === to) {
          refusal = { field: 'to', text: SAME_POUCH_ERROR };
        }
        for (const [field, id] of chosen) {
          const pouch = pouchOf(id);
          if (refusal === null && pouch?.is_archived === true) {
            refusal = { field, text: archivedEditError(pouch.name) };
          }
        }
        if (refusal === null) {
          await client.query(
            `UPDATE operations
                SET amount = $3, date = $4, note = $5, from_pouch_id = $6, to_pouch_id = $7
              WHERE id = $1 AND user_id = $2`,
            [found.id, userId, entry.cents, entry.date, entry.note, from, to],
          );
        }
      }
      await client.query(refusal === null ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      // The connection may already be broken; the original error matters more.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (refusal === 'missing') return c.notFound();
    if (refusal === 'stored') {
      const now = await findOperation(String(found.id), userId);
      return now === null ? c.notFound() : c.html(operationPage(now, money), 400);
    }
    if (refusal !== null) {
      form.errors[refusal.field] = refusal.text;
      return refuse();
    }
    return c.redirect('/saeckel/history', 303);
  });

  // A record deleted (§4.1, §4.8): for real, no bin. The same order as a change: the record
  // locked FOR UPDATE first; then its pouches as that locked row has them now — not as any page
  // saw them — by one statement in the order of their ids; then the storeroom; then DELETE. An
  // income has no pouch, so nothing but the record is locked. An archiving of a pouch of the
  // record takes the same lock: it either waits and then counts the balance without this
  // record, or goes first and this is refused. A form sends nothing that is read.
  saeckel.post('/saeckel/operations/:id/delete', signedIn, async (c) => {
    const userId = c.get('user').id;
    const id = parseId(c.req.param('id'));
    if (id === null) return c.notFound();

    // Why the record is not deleted: gone, or of a pouch in the storeroom.
    let refusal: 'missing' | 'stored' | null = null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{
        from_pouch_id: number | null;
        to_pouch_id: number | null;
      }>(LOCK_OPERATION, [id, userId]);
      const row = current.rows[0];
      if (row === undefined) {
        refusal = 'missing';
      } else {
        // The pouches of a record are the user's: the composite foreign keys make sure of it.
        const locked = await lockPouches(client, userId, [row.from_pouch_id, row.to_pouch_id]);
        if (locked.some((pouch) => pouch.is_archived)) {
          refusal = 'stored';
        } else {
          await client.query('DELETE FROM operations WHERE id = $1 AND user_id = $2', [id, userId]);
        }
      }
      await client.query(refusal === null ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      // The connection may already be broken; the original error matters more.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (refusal === 'missing') return c.notFound();
    if (refusal === 'stored') {
      const now = await findOperation(String(id), userId);
      return now === null ? c.notFound() : c.html(operationPage(now, money), 400);
    }
    return c.redirect('/saeckel/history', 303);
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
    const column = await columnOf(userId);
    return c.html(editPouchPage(pouch, { name: pouch.name, icon }, balance, money, column));
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
      const column = await columnOf(userId);
      return c.html(
        editPouchPage(pouch, { name: typed, icon, error }, balance, money, column),
        400,
      );
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
    return c.html(editPouchPage(pouch, form, balance, money, await columnOf(userId)), 400);
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
      return c.html(pouchPage(pouch, view, money, await columnOf(userId)), 400);
    }
    if (restored === 0) return c.notFound();
    return c.redirect(`/saeckel/pouches/${id}`, 303);
  });

  return saeckel;
}
