// Money in Säckel (ARCHITECTURE.md §4.7, §5.6): whole hundredths of the currency of the
// installation, from the form to the database and back to the page. A float never holds an
// amount: input is parsed as text, the database keeps bigint, sums come back as text, and the
// page gets them through Intl as an exact decimal string.

// §4.7: a typed amount is at most this long, before group separators are taken out.
const AMOUNT_MAX_LENGTH = 20;
// 1 000 000 000,00 in hundredths: the largest amount of one record, as operations.amount allows.
export const AMOUNT_MAX_CENTS = 100_000_000_000;
// Digits of the largest whole part, 1 000 000 000.
const WHOLE_MAX_DIGITS = 10;

const FORMAT_ERROR = 'Сумма — число, например 1 240,50.';
const ZERO_ERROR = 'Сумма должна быть больше нуля.';
const TOO_BIG_ERROR = 'Сумма — не больше 1 000 000 000,00.';

export type AmountResult = { cents: number } | { error: string };

// §4.7: digits, groups apart by a space, U+00A0 or U+202F, one "," or "." and at most two
// digits after it; no sign, no exponent; from 0,01 to 1 000 000 000,00. Everything Hof prints
// is accepted. The bounds are checked on the text, before it becomes a number: a long run of
// digits is refused without ever being rounded.
export function parseAmount(input: string): AmountResult {
  if ([...input].length > AMOUNT_MAX_LENGTH) return { error: FORMAT_ERROR };
  const parts = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(input.replace(/[   ]/g, ''));
  if (parts === null) return { error: FORMAT_ERROR };
  const whole = parts[1]!.replace(/^0+(?=\d)/, '');
  if (whole.length > WHOLE_MAX_DIGITS) return { error: TOO_BIG_ERROR };
  // At most ten digits, so every number below is a whole number far under 2^53.
  const cents = Number(whole) * 100 + Number((parts[2] ?? '').padEnd(2, '0'));
  if (cents === 0) return { error: ZERO_ERROR };
  if (cents > AMOUNT_MAX_CENTS) return { error: TOO_BIG_ERROR };
  return { cents };
}

// A bigint or numeric from pg, which arrives as text, as a number of hundredths. Sums over a
// long history could in principle leave the range where a number is exact: then this is a
// server error, and its text carries no amount, so none reaches the log.
export function centsFrom(text: string): number {
  const cents = /^-?\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(cents)) throw new Error('a sum is outside the exact range of numbers');
  return cents;
}

export interface MoneyFormat {
  // Hundredths as the page shows them: two decimals, "−" for a minus, the currency sign.
  format(cents: number): string;
  // The currency sign alone, for a label such as «Сумма, ₽».
  symbol: string;
}

// The one way Säckel shows money. Intl gets an exact decimal string built from the integer, not
// a float, so no amount is rounded however large.
export function moneyFormat(currency: string): MoneyFormat {
  const numberFormat = new Intl.NumberFormat('ru-RU', { style: 'currency', currency });
  return {
    format(cents) {
      const digits = String(Math.abs(cents)).padStart(3, '0');
      const decimal = `${cents < 0 ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
      return numberFormat.format(decimal as Intl.StringNumericLiteral).replace('-', '−');
    },
    symbol: numberFormat.formatToParts(0).find((part) => part.type === 'currency')?.value ?? '',
  };
}

// §5.6: the currency of the installation is an ISO 4217 code Intl knows, with exactly two
// decimal places. Returns what is wrong with it, or null.
export function currencyError(code: string | undefined): string | null {
  if (!code) return 'CURRENCY is not set (see .env.example)';
  if (!Intl.supportedValuesOf('currency').includes(code)) {
    return `CURRENCY=${code} is not an ISO 4217 currency code`;
  }
  const { minimumFractionDigits, maximumFractionDigits } = new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: code,
  }).resolvedOptions();
  if (minimumFractionDigits !== 2 || maximumFractionDigits !== 2) {
    return `CURRENCY=${code} does not have two decimal places`;
  }
  return null;
}
