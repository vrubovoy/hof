// Dates in Säckel (ARCHITECTURE.md §4.7, §5.6): calendar dates without a time, kept as ISO
// text YYYY-MM-DD. «Today» is the date in the time zone of the installation (TZ). Dates never
// pass through a JS Date that would carry a time zone of its own: the database gives them as
// text, and the page gets them rebuilt from that text.

const EARLIEST = '2000-01-01';
const DATE_ERROR = 'Дата — ДД.ММ.ГГГГ, не раньше 01.01.2000 и не дальше года вперёд.';

export type DateResult = { date: string } | { error: string };

// §9: the time zone of the installation must be one Intl knows. Returns what is wrong, or null.
export function timeZoneError(timeZone: string | undefined): string | null {
  if (!timeZone) return 'TZ is not set (see .env.example)';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    return `TZ=${timeZone} is not a time zone`;
  }
  return null;
}

// The calendar date of `now` in the time zone, as YYYY-MM-DD. Built from the parts Intl gives,
// not from a locale's own layout of a date.
export function today(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: 'year' | 'month' | 'day') =>
    parts.find((found) => found.type === type)?.value ?? '';
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

// The ISO date of these numbers, if such a day exists: no 31 February, no 29 February outside
// a leap year.
function isoDate(year: number, month: number, day: number): string | null {
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// The same day a year later; 29 February becomes 28 February.
function yearLater(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return isoDate(year + 1, month, day) ?? isoDate(year + 1, month, day - 1)!;
}

// §4.7: ДД.ММ.ГГГГ or ГГГГ-ММ-ДД, a day that exists, from 01.01.2000 to a year after today.
// Nothing typed means today.
export function parseDate(input: string, todayDate: string): DateResult {
  const text = input.trim();
  if (text === '') return { date: todayDate };
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  const dashed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const date = dotted
    ? isoDate(Number(dotted[3]), Number(dotted[2]), Number(dotted[1]))
    : dashed
      ? isoDate(Number(dashed[1]), Number(dashed[2]), Number(dashed[3]))
      : null;
  // ISO dates of four-digit years compare as text.
  if (date === null || date < EARLIEST || date > yearLater(todayDate)) {
    return { error: DATE_ERROR };
  }
  return { date };
}

// YYYY-MM-DD as the form shows it: ДД.ММ.ГГГГ.
export function dateForField(date: string): string {
  const [year, month, day] = date.split('-');
  return `${day}.${month}.${year}`;
}

// YYYY-MM-DD as a list of records shows it: ДД.ММ.
export function dateForList(date: string): string {
  const [, month, day] = date.split('-');
  return `${day}.${month}`;
}
