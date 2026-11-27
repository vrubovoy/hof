// Prototype B of M14 (Issue #167): what the JSON reads of Säckel give the React views of the way —
// Мешки, a pouch and Летопись. Amounts and dates come formatted by the server, by the same
// functions as its HTML pages (one moneyFormat, the dates of Säckel): the browser shows them and
// computes nothing. Pictures come as the addresses of the static folder of Säckel, with versions.

export interface SignedPouch {
  id: number;
  name: string;
  sign: string;
}

export interface ListedPouchData extends SignedPouch {
  note: string;
  balance: string;
  debt: boolean;
}

export interface ColumnData {
  treasury: string;
  treasuryDebt: boolean;
  pouches: ListedPouchData[];
  stored: SignedPouch[];
}

export interface MovementData {
  id: number;
  date: string;
  kind: string;
  note: string;
  amount: string;
  expense: boolean;
}

// The fields «Записать трату» starts with; the form itself is still sent by the browser (M14.5).
export interface ExpenseFormData {
  symbol: string;
  date: string;
  today: string;
  earliest: string;
  latest: string;
}

export interface PouchPaneData {
  pouch: SignedPouch & { archived: boolean };
  balance: string;
  debt: boolean;
  movements: MovementData[];
  form: ExpenseFormData;
}

export interface PouchesData {
  column: ColumnData;
  first: PouchPaneData | null;
}

export interface PouchData {
  column: ColumnData;
  pane: PouchPaneData;
}

export interface HistoryRowData {
  id: number;
  date: string;
  pouches: string;
  kind: string;
  phoneKind: string;
  note: string;
  sum: string;
  expense: boolean;
  href: string;
}

export interface HistoryData {
  empty: boolean;
  page: number;
  pouch: number | null;
  pouches: { id: number; label: string }[];
  rows: HistoryRowData[];
  none: string;
  previous: string | null;
  next: string | null;
}

// The data of the view a shell is drawn for, embedded into it (src/saeckel/app.ts).
export type ViewData =
  | { view: 'pouches'; data: PouchesData }
  | { view: 'pouch'; id: number; data: PouchData }
  | { view: 'history'; search: string; data: HistoryData };

// JSON inside <script type="application/json">: nothing in it may end the element, open a comment
// or be read as an HTML entity, and the two line separators JavaScript once refused stay escaped.
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}
