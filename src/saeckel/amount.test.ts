// M13.4: the groups of an amount as the field shows them after the focus leaves it
// (static/amount.js), and what the server makes of an amount so grouped.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { migrate } from '../migrate.ts';
import { AMOUNT_MAX_CENTS, amountForField, parseAmount } from './money.ts';
import { groupAmount } from './static/amount.js';
import { addOperation, addPouch, operations, pool, post } from './test-helpers.ts';

const NBSP = ' ';
// A text with U+00A0 written as a plain space, so the cases below read as on the page.
const spaced = (text: string) => text.replaceAll(' ', NBSP);

describe('groupAmount', () => {
  // [typed, shown after the focus leaves the field]; a space in the second is U+00A0.
  const grouped: [string, string][] = [
    ['1234', '1 234'],
    ['1234567,89', '1 234 567,89'],
    // The decimal mark as typed: «.» is as good as «,» for the server.
    ['1234567.89', '1 234 567.89'],
    // An unfinished decimal part is what it is: 1 234,5 is 1 234,50 for the server too.
    ['1234,5', '1 234,5'],
    ['1', '1'],
    ['999', '999'],
    ['0,01', '0,01'],
    ['0.5', '0.5'],
    ['1000000000', '1 000 000 000'],
    ['1000000000,00', '1 000 000 000,00'],
    ['999999999,99', '999 999 999,99'],
    // Spaces typed or pasted, of any kind the server knows, and in any place.
    ['1 234 567,89', '1 234 567,89'],
    [`1${NBSP}234`, '1 234'],
    ['1 234', '1 234'],
    ['12 34', '1 234'],
    ['  1240,50 ', '1 240,50'],
    ['1 240,5 0', '1 240,50'],
  ];
  for (const [typed, shown] of grouped) {
    test(`${JSON.stringify(typed)} → ${JSON.stringify(shown)}`, () => {
      assert.equal(groupAmount(typed), spaced(shown));
    });
  }

  // Empty, unfinished, wrong, zero, leading zeros, too long or too big: left as typed.
  const unchanged = [
    '',
    '   ',
    '1240,',
    ',5',
    '1,234',
    '1,234,5',
    '1.234,56',
    '1.2.3',
    '-1',
    '+1',
    '1e3',
    '0x10',
    'Infinity',
    '12 руб.',
    '1 234,50 ₽',
    '1\t240',
    '１２',
    'abc',
    '0',
    '0,00',
    '000',
    '0001',
    '00,10',
    '1'.repeat(21),
    `1${' '.repeat(19)}2`,
    '1000000000,01',
    '1000000001',
    '10000000000',
    '9'.repeat(20),
  ];
  for (const typed of unchanged) {
    test(`${JSON.stringify(typed)} is left as typed`, () => {
      assert.equal(groupAmount(typed), typed);
    });
  }

  // Every case above, those of parseAmount, and amounts of every length with every kind of
  // decimal part, made from digits without a random number.
  const corpus = [...grouped.map(([typed]) => typed), ...unchanged];
  for (let length = 1; length <= 11; length += 1) {
    for (const whole of ['98765432109'.slice(0, length), '1' + '0'.repeat(length - 1)]) {
      for (const decimals of ['', ',0', ',05', '.5', '.99', ',', ',123']) {
        corpus.push(whole + decimals, ` ${whole}${decimals}`);
      }
    }
  }

  test('the server reads the grouped text as the same amount, or the typed text is kept', () => {
    for (const typed of corpus) {
      const shown = groupAmount(typed);
      if (shown === typed) continue;
      const amount = parseAmount(typed);
      assert.ok('cents' in amount, `${JSON.stringify(typed)} was changed though it is refused`);
      assert.deepEqual(parseAmount(shown), amount, JSON.stringify(typed));
    }
  });

  test('an amount the server refuses is never changed', () => {
    for (const typed of corpus) {
      if ('error' in parseAmount(typed)) assert.equal(groupAmount(typed), typed, typed);
    }
  });

  test('once grouped, the text stays: leaving the field again changes nothing', () => {
    for (const typed of corpus) {
      const shown = groupAmount(typed);
      assert.equal(groupAmount(shown), shown, JSON.stringify(typed));
    }
  });

  test('an amount filled in by the server is left as it is', () => {
    for (const cents of [1, 99, 100, 124_050, 100_000, 99_999_999_999, AMOUNT_MAX_CENTS]) {
      assert.equal(groupAmount(amountForField(cents)), amountForField(cents), String(cents));
    }
  });
});

// The script in a page: a stand-in document with its own input fields, the module loaded anew.
describe('amount.js on a page', () => {
  class Input {
    readonly name: string;
    value: string;
    constructor(name: string, value: string) {
      this.name = name;
      this.value = value;
    }
    matches(selector: string) {
      return selector.split(',').some((one) => {
        const exact = /name="([^"]+)"\]$/.exec(one.trim());
        const prefix = /name\^="([^"]+)"\]$/.exec(one.trim());
        return exact ? this.name === exact[1] : prefix ? this.name.startsWith(prefix[1]!) : false;
      });
    }
  }
  let leave: (event: { target: unknown }) => void = () => undefined;

  before(async () => {
    Object.assign(globalThis, {
      HTMLInputElement: Input,
      document: {
        addEventListener(type: string, listener: typeof leave) {
          if (type === 'focusout') leave = listener;
        },
      },
    });
    // A query of its own: a module apart from the one imported above, so start() runs.
    await import(new URL('./static/amount.js?page', import.meta.url).href);
  });
  after(() => {
    const global = globalThis as Record<string, unknown>;
    delete global.document;
    delete global.HTMLInputElement;
  });

  test('the amount of a form and of a row of «Разложить» are grouped when the focus leaves', () => {
    for (const name of ['amount', 'amount_7', 'amount_123']) {
      const field = new Input(name, '1234567,89');
      leave({ target: field });
      assert.equal(field.value, spaced('1 234 567,89'), name);
    }
  });

  test('other fields, other elements and a wrong amount are left alone', () => {
    for (const [name, value] of [
      ['date', '12345678'],
      ['note', '1234567'],
      ['amounts', '1234567'],
      ['amount', '1234,'],
    ] as const) {
      const field = new Input(name, value);
      leave({ target: field });
      assert.equal(field.value, value, name);
    }
    // Not an input field at all, though it looks like one.
    const other = { name: 'amount', value: '1234', matches: () => true };
    leave({ target: other });
    assert.equal(other.value, '1234');
  });
});

// What the forms keep of a grouped amount: the same hundredths as of the amount typed bare.
describe('a grouped amount sent by each form of money', () => {
  before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
  beforeEach(() => pool.query('TRUNCATE operations, pouches RESTART IDENTITY'));
  after(() => pool.end());

  const typed = '1234567,89';
  const shown = groupAmount(typed);
  const cents = String((parseAmount(typed) as { cents: number }).cents);

  const sent = async (path: string, fields: Record<string, string>) => {
    const res = await post(path, fields, 'anna');
    assert.equal(res.status, 303, `${path}: ${res.status}`);
  };

  test('the text sent is the grouped one, apart by U+00A0', () => {
    assert.equal(shown, `1${NBSP}234${NBSP}567,89`);
    assert.equal(cents, '123456789');
  });

  test('Доход, трата, Разложить, Переложить and the edit of a record keep 123456789', async () => {
    const food = await addPouch(1, 'Продукты');
    const rent = await addPouch(1, 'Квартира');
    await sent('/saeckel/income', { amount: shown, date: '', note: '' });
    await sent('/saeckel/assign', { [`amount_${food}`]: shown, [`amount_${rent}`]: typed });
    await sent(`/saeckel/pouches/${food}/expense`, { amount: shown, date: '', note: '' });
    await sent('/saeckel/transfer', {
      from: String(food),
      to: String(rent),
      amount: shown,
      date: '',
      note: '',
    });
    const record = await addOperation(1, 'income', 100);
    await sent(`/saeckel/operations/${record}`, { amount: shown, date: '', note: '' });
    const kept = (await operations()).map(({ kind, amount }) => [kind, amount]);
    assert.deepEqual(kept, [
      ['income', cents],
      ['assign', cents],
      ['assign', cents],
      ['expense', cents],
      ['transfer', cents],
      ['income', cents],
    ]);
  });

  test('a refused form shows the grouped amount again as it was sent', async () => {
    const res = await post('/saeckel/income', { amount: shown, date: '31.02.2026' }, 'anna');
    assert.equal(res.status, 400);
    // Not folded: U+00A0 is white space to a regular expression.
    assert.ok((await res.text()).includes(`value="${shown}"`));
    assert.deepEqual(await operations(), []);
  });
});
