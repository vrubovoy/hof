// money.ts: an amount from text to hundredths, sums from pg, money on the page, the currency
// of the installation (ARCHITECTURE.md §4.7, §5.6). No database.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AMOUNT_MAX_CENTS,
  amountForField,
  centsFrom,
  currencyError,
  moneyFormat,
  parseAmount,
} from './money.ts';

const FORMAT_ERROR = 'Сумма — число, например 1 240,50.';
const ZERO_ERROR = 'Сумма должна быть больше нуля.';
const TOO_BIG_ERROR = 'Сумма — не больше 1 000 000 000,00.';

describe('parseAmount', () => {
  const accepted: [string, number][] = [
    ['1', 100],
    ['0,01', 1],
    ['0.01', 1],
    ['1240.5', 124050],
    ['1240,50', 124050],
    ['1 240,50', 124050],
    ['1 240,50', 124050],
    ['1 240,50', 124050],
    ['  1 240,50 ', 124050],
    ['0001', 100],
    ['00,10', 10],
    ['1 000 000 000,00', 100_000_000_000],
    // Decimals a float would get wrong: 0.29 · 100 is 28.999999999999996 there.
    ['0,29', 29],
    ['0,57', 57],
    ['1,15', 115],
    ['4,35', 435],
    ['8,2', 820],
    ['9 999 999,99', 999_999_999],
    ['999 999 999,99', 99_999_999_999],
    ['1000000000', 100_000_000_000],
    // What Hof itself prints, sign and minus left out: «1 240,50 ₽» in the page is 1 240,50.
    ['90 071', 9_007_100],
  ];
  for (const [text, cents] of accepted) {
    test(`${JSON.stringify(text)} is ${cents} hundredths`, () => {
      assert.deepEqual(parseAmount(text), { cents });
    });
  }

  const refused: [string, string][] = [
    ['0', ZERO_ERROR],
    ['0,00', ZERO_ERROR],
    ['000', ZERO_ERROR],
    ['', FORMAT_ERROR],
    ['   ', FORMAT_ERROR],
    ['-1', FORMAT_ERROR],
    ['+1', FORMAT_ERROR],
    ['1e3', FORMAT_ERROR],
    ['1,234,5', FORMAT_ERROR],
    ['1.234,56', FORMAT_ERROR],
    ['1,234', FORMAT_ERROR],
    ['1,', FORMAT_ERROR],
    [',5', FORMAT_ERROR],
    ['1.2.3', FORMAT_ERROR],
    ['12 руб.', FORMAT_ERROR],
    ['1\t240', FORMAT_ERROR],
    ['１２', FORMAT_ERROR],
    ['Infinity', FORMAT_ERROR],
    ['0x10', FORMAT_ERROR],
    ['1'.repeat(21), FORMAT_ERROR],
    ['1000000000,01', TOO_BIG_ERROR],
    ['1000000001', TOO_BIG_ERROR],
    ['10000000000', TOO_BIG_ERROR],
  ];
  for (const [text, error] of refused) {
    test(`${JSON.stringify(text)} is refused: ${error}`, () => {
      assert.deepEqual(parseAmount(text), { error });
    });
  }

  test('twenty nines are refused as too big, not rounded into something smaller', () => {
    // As a number, this text would already be 1e20 and lose its last digits.
    assert.deepEqual(parseAmount('9'.repeat(20)), { error: TOO_BIG_ERROR });
    assert.deepEqual(parseAmount(`0000000000${'9'.repeat(10)}`), { error: TOO_BIG_ERROR });
    // Twenty characters with leading zeros are fine when the value is.
    assert.deepEqual(parseAmount('0000000000001000,00'), { cents: 100_000 });
  });

  test('hundredths add up exactly: 0,10 + 0,20 = 0,30', () => {
    const a = parseAmount('0,10');
    const b = parseAmount('0,20');
    assert.ok('cents' in a && 'cents' in b);
    assert.equal(a.cents + b.cents, 30);
    assert.equal(moneyFormat('RUB').format(a.cents + b.cents), '0,30 ₽');
  });
});

describe('centsFrom', () => {
  test('bigint and numeric text of pg as whole hundredths', () => {
    assert.equal(centsFrom('124050'), 124050);
    assert.equal(centsFrom('0'), 0);
    assert.equal(centsFrom('-124050'), -124050);
    assert.equal(centsFrom('9007199254740991'), Number.MAX_SAFE_INTEGER);
    assert.equal(centsFrom('-9007199254740991'), -Number.MAX_SAFE_INTEGER);
  });

  test('outside the exact range of numbers: an error without the amount', () => {
    for (const text of [
      '9007199254740992',
      '-9007199254740992',
      '123456789012345678901',
      '1e3',
      '',
    ]) {
      assert.throws(
        () => centsFrom(text),
        (error: Error) => {
          assert.equal(error.message, 'a sum is outside the exact range of numbers');
          return !error.message.includes(text.slice(0, 5) || '#');
        },
        text,
      );
    }
  });
});

describe('moneyFormat', () => {
  const rub = moneyFormat('RUB');

  test('two decimals, groups apart, the sign after a space, «−» for a minus', () => {
    assert.equal(rub.format(-124050), '−1 240,50 ₽');
    assert.equal(rub.format(124050), '1 240,50 ₽');
    assert.equal(rub.format(0), '0,00 ₽');
    assert.equal(rub.format(5), '0,05 ₽');
    assert.equal(rub.format(-1), '−0,01 ₽');
    assert.equal(rub.format(100_000_000_000), '1 000 000 000,00 ₽');
    // No ASCII hyphen anywhere.
    assert.ok(!rub.format(-124050).includes('-'));
  });

  test('the largest exact sums without rounding', () => {
    assert.equal(rub.format(Number.MAX_SAFE_INTEGER), '90 071 992 547 409,91 ₽');
    assert.equal(rub.format(-Number.MAX_SAFE_INTEGER), '−90 071 992 547 409,91 ₽');
    assert.equal(rub.format(9_007_199_254_740_899), '90 071 992 547 408,99 ₽');
  });

  test('the sign of the currency, from Intl', () => {
    assert.equal(rub.symbol, '₽');
    assert.equal(moneyFormat('EUR').symbol, '€');
    assert.equal(moneyFormat('EUR').format(-124050), '−1 240,50 €');
  });

  test('what Hof prints is read back as the same amount', () => {
    for (const cents of [1, 124050, 9_007_100, 100_000_000_000]) {
      const printed = rub.format(cents).replace(/ ₽$/, '');
      assert.deepEqual(parseAmount(printed), { cents }, printed);
    }
  });
});

describe('amountForField', () => {
  test('two decimals after a comma, groups apart by U+00A0, no sign of the currency', () => {
    for (const [cents, text] of [
      [1, '0,01'],
      [5, '0,05'],
      [99, '0,99'],
      [100, '1,00'],
      [99_999, '999,99'],
      [100_000, '1\u00A0000,00'],
      [124_050, '1\u00A0240,50'],
      [100_000_000_000, '1\u00A0000\u00A0000\u00A0000,00'],
    ] as const) {
      assert.equal(amountForField(cents), text, String(cents));
    }
  });

  test('read back by parseAmount as the same hundredths', () => {
    const back = (cents: number) => assert.deepEqual(parseAmount(amountForField(cents)), { cents });
    // Every amount up to 1 000,00, the edges of every group, and a spread over the whole range.
    for (let cents = 1; cents <= 100_000; cents++) back(cents);
    for (let power = 1; power <= AMOUNT_MAX_CENTS; power *= 10) {
      for (const cents of [power - 1, power, power + 1]) {
        if (cents >= 1 && cents <= AMOUNT_MAX_CENTS) back(cents);
      }
    }
    let seed = 20_261_014;
    for (let i = 0; i < 20_000; i++) {
      seed = (seed * 48_271) % 2_147_483_647;
      back(1 + Math.floor((seed / 2_147_483_647) * AMOUNT_MAX_CENTS));
    }
    back(AMOUNT_MAX_CENTS);
  });
});

describe('currencyError', () => {
  test('a code Intl knows, with two decimal places', () => {
    assert.equal(currencyError('RUB'), null);
    assert.equal(currencyError('EUR'), null);
    assert.equal(currencyError('USD'), null);
  });

  test('missing, unknown, in lower case, or without two decimal places', () => {
    assert.equal(currencyError(undefined), 'CURRENCY is not set (see .env.example)');
    assert.equal(currencyError(''), 'CURRENCY is not set (see .env.example)');
    assert.equal(currencyError('XXX'), 'CURRENCY=XXX is not an ISO 4217 currency code');
    assert.equal(currencyError('rub'), 'CURRENCY=rub is not an ISO 4217 currency code');
    assert.equal(currencyError('JPY'), 'CURRENCY=JPY does not have two decimal places');
    assert.equal(currencyError('KWD'), 'CURRENCY=KWD does not have two decimal places');
  });
});
