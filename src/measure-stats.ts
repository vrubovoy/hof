// Statistics and tables of src/measure.ts (docs/OPERATIONS.md, «Замер скорости страниц»): pure
// functions without Chrome or a server, tested by src/measure-stats.test.ts.

// --- Series -------------------------------------------------------------------------------------

export interface Summary {
  n: number;
  median: number;
  q1: number;
  q3: number;
  min: number;
  max: number;
}

// The quantile p (0…1) of sorted values, linear between the two nearest ranks (type 7 of
// Hyndman and Fan, the default of R and numpy): the same numbers in every report.
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('quantile of no values');
  const at = (sorted.length - 1) * p;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

// The finite values only: a run without a number (no paint, no API) is not a zero.
export function summarize(values: readonly (number | null)[]): Summary | null {
  const sorted = values
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    q1: quantile(sorted, 0.25),
    q3: quantile(sorted, 0.75),
    min: sorted[0]!,
    max: sorted.at(-1)!,
  };
}

const round = (value: number, digits: number) =>
  digits === 0 ? String(Math.round(value)) : value.toFixed(digits).replace('.', ',');

// «медиана [Q1–Q3] (мин–макс)»; one run — the value alone.
export function formatSummary(summary: Summary | null, digits = 0): string {
  if (summary === null) return '—';
  const r = (value: number) => round(value, digits);
  if (summary.n === 1) return r(summary.median);
  return `${r(summary.median)} [${r(summary.q1)}–${r(summary.q3)}] (${r(summary.min)}–${r(summary.max)})`;
}

// Two series differ only when their medians are further apart than the interquartile range of
// either of them; anything closer is the noise of the stand.
export function beyondNoise(a: Summary, b: Summary): boolean {
  const range = Math.max(a.q3 - a.q1, b.q3 - b.q1);
  return Math.abs(b.median - a.median) > range;
}

// The change of b against a: «+12 %», or «≈» within the noise.
export function formatChange(a: Summary | null, b: Summary | null): string {
  if (a === null || b === null) return '—';
  if (!beyondNoise(a, b)) return '≈';
  if (a.median === 0) return `${b.median > 0 ? '+' : ''}${Math.round(b.median - a.median)}`;
  const percent = ((b.median - a.median) / a.median) * 100;
  // A change beyond the noise is never shown as «0 %».
  const shown = Math.abs(percent) < 1 ? round(percent, 1) : String(Math.round(percent));
  return `${percent > 0 ? '+' : ''}${shown} %`;
}

// The tolerance of «не хуже M13» (docs/OPERATIONS.md, «Пороги приёмки M14»): the interquartile
// range of either series, 5 % of the base median or 15 ms, whichever is largest. Two series of M13
// differed by up to 4 % and 14 ms.
export function tolerance(base: Summary, other: Summary): number {
  return Math.max(base.q3 - base.q1, other.q3 - other.q1, base.median * 0.05, 15);
}

export function notWorse(base: Summary, other: Summary): boolean {
  return other.median <= base.median + tolerance(base, other);
}

// The power of a Mac from `pmset -g ps`: «сеть 100 %», «батарея 42 %»; anything else as it is.
export function powerShort(text: string): string {
  const source = /'(AC|Battery) Power'/.exec(text)?.[1];
  const level = /(\d+)%/.exec(text)?.[1];
  if (source === undefined) return text;
  return `${source === 'AC' ? 'сеть' : 'батарея'}${level === undefined ? '' : ` ${level} %`}`;
}

// --- The way -------------------------------------------------------------------------------------

// Steps of the way the report treats apart: Back to the first page of Летопись is compared with
// the way forward to the same view (docs/OPERATIONS.md, «Пороги приёмки M14»).
export const BACK_STEP = 'Назад браузера';
export const BACK_REFERENCE = 'Мешки → Летопись';

// --- The probe of a page ------------------------------------------------------------------------

// What the probe of src/measure.ts sends out of every page, `at` in epoch milliseconds of the page
// clock (timeOrigin + startTime), `doc` — the document it came from.
export interface Probe {
  kind: string;
  at: number;
  doc: string;
  path: string;
  [field: string]: unknown;
}

// The window of one step: from the press to its end.
export interface Window {
  from: number;
  to: number;
}

const inside = (at: number, { from, to }: Window) => at >= from && at <= to;

// Long animation frames (LoAF) of 50 ms or more that end after the press and start before the
// end of the step.
export function longFrames(events: readonly Probe[], window: Window, minimum = 50) {
  const frames = events.filter(
    (e) =>
      e.kind === 'loaf' &&
      (e.dur as number) >= minimum &&
      e.at + (e.dur as number) >= window.from &&
      e.at <= window.to,
  );
  const lengths = frames.map((e) => e.dur as number);
  return {
    count: lengths.length,
    max: Math.max(0, ...lengths),
    total: lengths.reduce((sum, length) => sum + length, 0),
  };
}

// The slowest answer to an input in the window (Event Timing, the measure of INP), or null when
// the browser reported none: a page gone at once may leave no entry.
export function slowestInput(events: readonly Probe[], window: Window): number | null {
  const entries = events.filter(
    (e) => e.kind === 'input' && (e.id as number) > 0 && inside(e.at, window),
  );
  return entries.length === 0 ? null : Math.max(...entries.map((e) => e.dur as number));
}

// Layout shifts in the window that came without a recent input (the rule of CLS).
export function layoutShift(events: readonly Probe[], window: Window): number {
  return events
    .filter((e) => e.kind === 'shift' && e.input !== true && inside(e.at, window))
    .reduce((sum, e) => sum + (e.value as number), 0);
}

// --- Music --------------------------------------------------------------------------------------

// The media states of the probe: an element plays from `playing` until it pauses, waits, ends,
// fails, is emptied, or its document is put away (`hide`) or replaced by a new one (`commit`).
const STOPS = new Set(['pause', 'waiting', 'ended', 'error', 'emptied']);

export interface Silence {
  // The longest time in the window when no music element was playing, ms.
  longest: number;
  // The longest such time up to the end of the fade-in after it (the gain ramp of fx.js), ms; null
  // without a ramp seen.
  toLevel: number | null;
  // Music elements that started playing in the window: a new player each.
  starts: number;
}

export function silence(events: readonly Probe[], window: Window): Silence {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  // The intervals of playing, by element; open ones end at the end of the window.
  const open = new Map<string, number>();
  const intervals: [number, number][] = [];
  const firstPlay = new Set<string>();
  let starts = 0;
  for (const e of ordered) {
    if (e.kind === 'media') {
      const id = e.el as string;
      if (e.type === 'playing') {
        if (!open.has(id)) open.set(id, e.at);
        if (!firstPlay.has(id)) {
          firstPlay.add(id);
          if (inside(e.at, window)) starts += 1;
        }
      } else if (STOPS.has(e.type as string) && open.has(id)) {
        intervals.push([open.get(id)!, e.at]);
        open.delete(id);
      }
    } else if (e.kind === 'hide' || e.kind === 'commit') {
      for (const [id, start] of open) {
        if (e.kind === 'commit' || id.startsWith(`${e.doc}:`)) {
          intervals.push([start, e.at]);
          open.delete(id);
        }
      }
    }
  }
  for (const start of open.values()) intervals.push([start, window.to]);

  // The gaps of the window not covered by any interval.
  const clipped = intervals
    .map(([a, b]): [number, number] => [Math.max(a, window.from), Math.min(b, window.to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let cursor = window.from;
  let longest: [number, number] = [window.from, window.from];
  for (const [a, b] of clipped) {
    if (a > cursor && a - cursor > longest[1] - longest[0]) longest = [cursor, a];
    cursor = Math.max(cursor, b);
  }
  if (window.to > cursor && window.to - cursor > longest[1] - longest[0]) {
    longest = [cursor, window.to];
  }
  const length = longest[1] - longest[0];

  // The fade-in that follows the gap: a ramp to a level above zero starting near its end.
  let toLevel: number | null = null;
  if (length > 0) {
    const ramp = ordered.find(
      (e) =>
        e.kind === 'gain' &&
        (e.target as number) > 0 &&
        e.at >= longest[1] - 50 &&
        e.at <= longest[1] + 2000,
    );
    if (ramp !== undefined) toLevel = ramp.at + (ramp.seconds as number) * 1000 - longest[0];
  }
  return { longest: length, toLevel, starts };
}

// --- Requests -----------------------------------------------------------------------------------

export interface NetRequest {
  method: string;
  url: string;
  type: string;
  // Epoch milliseconds when the request was sent.
  at: number;
  status: number;
  bytes: number;
  canceled: boolean;
  failed: boolean;
}

// The requests of a step: how many and their weight; repeated — sent again although the same
// method and address had already been answered in the step (a needless second request); replaced —
// sent again after the first was cancelled (a navigation that took over, as at the sign-out of
// M13); cancelled and failed; the POSTs — a form goes once; data — the views and data fetched from
// the server with a fresh answer (a document, fetch or XHR answered 200), what a view shown again
// must have to show current data.
export function requestStats(list: readonly NetRequest[], window: Window) {
  const mine = list.filter((r) => inside(r.at, window)).sort((a, b) => a.at - b.at);
  const before = new Map<string, NetRequest>();
  let repeated = 0;
  let replaced = 0;
  for (const r of mine) {
    const key = `${r.method} ${r.url}`;
    const first = before.get(key);
    if (first !== undefined) {
      if (first.canceled) replaced += 1;
      else repeated += 1;
    }
    before.set(key, r);
  }
  return {
    total: mine.length,
    kb: mine.reduce((sum, r) => sum + r.bytes, 0) / 1024,
    repeated,
    replaced,
    canceled: mine.filter((r) => r.canceled).length,
    failed: mine.filter((r) => r.failed && !r.canceled).length,
    posts: mine.filter((r) => r.method === 'POST').length,
    notModified: mine.filter((r) => r.status === 304).length,
    data: mine.filter(
      (r) =>
        r.method === 'GET' &&
        r.status === 200 &&
        !r.failed &&
        (r.type === 'Document' || r.type === 'Fetch' || r.type === 'XHR'),
    ).length,
  };
}

// --- Test data ----------------------------------------------------------------------------------

// Text as the page shows it, without the layout of its white space: the fingerprint of the data.
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// A row of Летопись as the page shows it: the id of the record and its cells.
export interface HistoryRow {
  id: number;
  pouch: string;
  kind: string;
  note: string;
  sum: string;
}

// The record a run of the scenario writes: an expense of 123,45 from Еда with the note «Замер».
export interface Mark {
  pouch: string;
  kind: string;
  note: string;
  amount: string;
}

// Whether a row is that record: every cell must be it, the note whole — not a word of the row.
export function isMark(row: HistoryRow, mark: Mark): boolean {
  return (
    normalizeText(row.note) === mark.note &&
    normalizeText(row.kind) === mark.kind &&
    normalizeText(row.pouch) === mark.pouch &&
    /^[−-]/.test(normalizeText(row.sum)) &&
    row.sum.replace(/[^\d,]/g, '') === mark.amount
  );
}

export function markIds(rows: readonly HistoryRow[], mark: Mark): number[] {
  return rows.filter((row) => isMark(row, mark)).map((row) => row.id);
}

// Whether Летопись is that of the test court: besides records of the mark, exactly `count` records,
// among them every note of `notes` once. Nothing is deleted before this holds.
export function isTestCourt(
  rows: readonly HistoryRow[],
  mark: Mark,
  count: number,
  notes: readonly string[],
): boolean {
  const others = rows.filter((row) => !isMark(row, mark));
  if (others.length !== count) return false;
  return notes.every(
    (note) => others.filter((row) => normalizeText(row.note) === note).length === 1,
  );
}

// The id of the record written, from the address a form led to (`?fresh=<id>` of M13), or null.
export function freshId(path: string): number | null {
  const value = new URLSearchParams(path.split('?')[1] ?? '').get('fresh');
  return value !== null && /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

// What became of the document at a step: the same one went on (a view drawn by a script), one
// seen before in this tab came back (the back/forward cache), or a new one was loaded. `before` —
// the document of the press, `seen` — every document of the tab until then, `restored` — the
// arrival came with pageshow of a persisted page.
export type DocumentFate = 'new' | 'same' | 'restored';

export function documentFate(
  arrival: { doc: string; restored?: unknown },
  before: string,
  seen: ReadonlySet<string>,
): DocumentFate {
  if (arrival.restored === true) return 'restored';
  if (arrival.doc === before) return 'same';
  return seen.has(arrival.doc) ? 'restored' : 'new';
}

// The fixed test budget of the measurement (docs/OPERATIONS.md): an income, the same share laid
// out into every pouch, and expenses on fixed dates and amounts, so that Летопись has two pages.
export interface SeedExpense {
  pouch: number;
  amount: string;
  date: string;
  note: string;
}

export function seedExpenses(count: number, pouches: number): SeedExpense[] {
  const list: SeedExpense[] = [];
  for (let i = 0; i < count; i += 1) {
    const rubles = 150 + ((i * 37) % 400);
    const kopecks = String((i * 13) % 100).padStart(2, '0');
    // October 2026, two records a day from the 2nd on.
    const day = String(2 + Math.floor(i / 2)).padStart(2, '0');
    list.push({
      pouch: (i % pouches) + 1,
      amount: `${rubles},${kopecks}`,
      date: `2026-10-${day}`,
      note: `Запись ${i + 1}`,
    });
  }
  return list;
}

// Whether some music element plays now: it has started and neither stopped nor left with its
// document since.
export function playingNow(events: readonly Probe[]): boolean {
  const open = new Set<string>();
  for (const e of events) {
    if (e.kind === 'media') {
      if (e.type === 'playing') open.add(e.el as string);
      else if (STOPS.has(e.type as string)) open.delete(e.el as string);
    } else if (e.kind === 'commit') {
      open.clear();
    } else if (e.kind === 'hide') {
      for (const id of open) if (id.startsWith(`${e.doc}:`)) open.delete(id);
    }
  }
  return open.size > 0;
}

// Whether a view arrived on one of the addresses of its step: an address with a query must match
// whole, one without it by its path (an expense written comes with ?fresh=<id>).
export function arrivedAt(path: string, to: readonly string[]): boolean {
  const [bare] = path.split('?');
  return to.some((address) => (address.includes('?') ? path === address : bare === address));
}

// What nginx compresses in production (deploy/nginx.conf, M14.2 --gzip): the static files of
// Core and Säckel only, CSS, JS and SVG (gzip_types), answers 200, 403 and 404 (nginx compresses
// no others) not compressed already, at least 20 bytes (gzip_min_length), for a browser that
// takes gzip. Pages and pictures go as they are.
export function nginxGzips(answer: {
  path: string;
  status: number;
  type: string;
  length: number | null;
  encoding: string | undefined;
  accept: string;
}): boolean {
  const media = answer.type.split(';', 1)[0]!.trim().toLowerCase();
  return (
    (answer.path.startsWith('/static/') || answer.path.startsWith('/saeckel/static/')) &&
    [200, 403, 404].includes(answer.status) &&
    ['text/css', 'text/javascript', 'image/svg+xml'].includes(media) &&
    (answer.length === null || answer.length >= 20) &&
    (answer.encoding === undefined || answer.encoding === '' || answer.encoding === 'identity') &&
    /(^|[\s,])gzip($|[\s,;])/i.test(answer.accept)
  );
}
