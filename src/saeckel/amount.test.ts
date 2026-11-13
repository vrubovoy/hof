// M13.4: the groups of an amount as the field keeps them while it is typed (static/amount.js),
// the caret, and what the server makes of an amount so grouped.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { migrate } from '../migrate.ts';
import { AMOUNT_MAX_CENTS, amountForField, parseAmount } from './money.ts';
import { eraseAcross, groupAmount, regroup } from './static/amount.js';
import { addOperation, addPouch, operations, pool, post } from './test-helpers.ts';

const NBSP = '\u00A0';
// A text with U+00A0 written as a plain space, so the cases below read as on the page; «|» is
// the caret.
const spaced = (text: string) => text.replaceAll(' ', NBSP);
const field = (text: string) => ({
  value: spaced(text.replace('|', '')),
  caret: text.indexOf('|'),
});

describe('groupAmount', () => {
  // [typed, shown]; a space in the second is U+00A0.
  const grouped: [string, string][] = [
    ['1234', '1 234'],
    ['1234567,89', '1 234 567,89'],
    // The decimal mark as typed: «.» is as good as «,» for the server.
    ['1234567.89', '1 234 567.89'],
    // An unfinished decimal part is what it is: 1 234,5 is 1 234,50 for the server too.
    ['1234,5', '1 234,5'],
    // Typed on: the groups stay while the mark and the decimals come.
    ['1234,', '1 234,'],
    ['1', '1'],
    ['999', '999'],
    ['0,01', '0,01'],
    ['0.5', '0.5'],
    ['1000000000', '1 000 000 000'],
    ['1000000000,00', '1 000 000 000,00'],
    ['999999999,99', '999 999 999,99'],
    // Too big, and the server says so of either text.
    ['1000000000,01', '1 000 000 000,01'],
    ['10000000000', '10 000 000 000'],
    ['1'.repeat(15), '111 111 111 111 111'],
    // Spaces typed or pasted, of any kind the server knows, and in any place.
    ['1 234 567,89', '1 234 567,89'],
    [`1${NBSP}234`, '1 234'],
    ['1\u202F234', '1 234'],
    ['12 34', '1 234'],
    ['  1240,50 ', '1 240,50'],
    ['1 240,5 0', '1 240,50'],
  ];
  for (const [typed, shown] of grouped) {
    test(`${JSON.stringify(typed)} → ${JSON.stringify(shown)}`, () => {
      assert.equal(groupAmount(typed), spaced(shown));
    });
  }

  // Not the shape of an amount, leading zeros, or longer than the server reads: left as typed.
  const unchanged = [
    '',
    '   ',
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
    // Grouped, these would be longer than twenty characters; already are, or are refused anyway.
    '1'.repeat(16),
    '1'.repeat(21),
    `1${' '.repeat(19)}2`,
    '9'.repeat(20),
  ];
  for (const typed of unchanged) {
    test(`${JSON.stringify(typed)} is left as typed`, () => {
      assert.equal(groupAmount(typed), typed);
    });
  }

  // Every case above and amounts of every length with every kind of decimal part, made from
  // digits without a random number.
  const corpus = [...grouped.map(([typed]) => typed), ...unchanged];
  for (let length = 1; length <= 17; length += 1) {
    for (const whole of ['98765432109876543'.slice(0, length), '1' + '0'.repeat(length - 1)]) {
      for (const decimals of ['', ',0', ',05', '.5', '.99', ',', ',123']) {
        corpus.push(whole + decimals, ` ${whole}${decimals}`);
      }
    }
  }

  test('the server answers the grouped text as the typed one: the same hundredths, or error', () => {
    for (const typed of corpus) {
      assert.deepEqual(parseAmount(groupAmount(typed)), parseAmount(typed), JSON.stringify(typed));
    }
  });

  test('only separators of groups change', () => {
    const bare = (text: string) => text.replace(/[ \u00A0\u202F]/g, '');
    for (const typed of corpus) {
      assert.equal(bare(groupAmount(typed)), bare(typed), JSON.stringify(typed));
    }
  });

  test('once grouped, the text stays', () => {
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

describe('the caret while typing', () => {
  test('typed one key after another, the caret at the end: grouped at each step', () => {
    let value = '';
    let caret = 0;
    const steps = [];
    for (const key of '1234567,89') {
      value = value.slice(0, caret) + key + value.slice(caret);
      caret += 1;
      const edit = regroup(value, caret);
      if (edit !== null) ({ value, caret } = edit);
      steps.push(`${value.slice(0, caret)}|${value.slice(caret)}`.replaceAll(NBSP, ' '));
    }
    assert.deepEqual(steps, [
      '1|',
      '12|',
      '123|',
      '1 234|',
      '12 345|',
      '123 456|',
      '1 234 567|',
      '1 234 567,|',
      '1 234 567,8|',
      '1 234 567,89|',
    ]);
  });

  // [what happened, the field as the browser left it, the field regrouped]; «|» is the caret.
  const typed: [string, string, string][] = [
    ['a digit in the middle', '1 234 58|67', '12 345 8|67'],
    ['a digit at the start', '9|123 456', '9| 123 456'],
    ['pasted into an empty field', '1234567,89|', '1 234 567,89|'],
    ['pasted into the middle', '1 256|34', '125 6|34'],
    ['a digit taken from the middle', '12 4|5', '1 24|5'],
    ['a part chosen and typed over', '1 9| 567', '19| 567'],
  ];
  for (const [what, before, after] of typed) {
    test(`${what}: ${before} → ${after}`, () => {
      const { value, caret } = field(before);
      assert.deepEqual(regroup(value, caret), field(after));
    });
  }

  test('nothing to change: no edit, the browser keeps the field', () => {
    for (const before of ['1 234,|', '12 руб.|', '0001|', '|']) {
      const { value, caret } = field(before);
      assert.equal(regroup(value, caret), null, before);
    }
  });

  // [Backspace or Delete, the field before the key, the field after it]: the digit beyond the
  // separator goes, not the separator alone.
  const erased: [boolean, string, string][] = [
    [true, '1 |234', '|234'],
    [true, '12 |345', '1| 345'],
    [true, '1 234 |567', '123| 567'],
    [false, '1| 234', '1|34'],
    [false, '1 234| 567', '123 4|67'],
  ];
  for (const [backward, before, after] of erased) {
    test(`${backward ? 'Backspace' : 'Delete'} beside a separator: ${before} → ${after}`, () => {
      const { value, caret } = field(before);
      assert.deepEqual(eraseAcross(value, caret, backward), field(after));
    });
  }

  test('Backspace or Delete elsewhere, or in a text that is no amount: the browser does it', () => {
    for (const [backward, before] of [
      [true, '1 23|4'],
      [true, '|1 234'],
      [false, '1 234|'],
      [true, '1 234,|5'],
      [true, '12 |руб.'],
      [false, '12| руб.'],
    ] as const) {
      const { value, caret } = field(before);
      assert.equal(eraseAcross(value, caret, backward), null, before);
    }
  });
});

// The script in a page: a stand-in document with its own input fields, the module loaded anew.
describe('amount.js on a page', () => {
  class Input {
    readonly name: string;
    value: string;
    selectionStart: number | null;
    selectionEnd: number | null;
    constructor(name: string, before: string) {
      this.name = name;
      const { value, caret } = field(before);
      this.value = value;
      this.selectionStart = caret;
      this.selectionEnd = caret;
    }
    matches(selector: string) {
      return selector.split(',').some((one) => {
        const exact = /name="([^"]+)"\]$/.exec(one.trim());
        const prefix = /name\^="([^"]+)"\]$/.exec(one.trim());
        return exact ? this.name === exact[1] : prefix ? this.name.startsWith(prefix[1]!) : false;
      });
    }
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }
    // The field as the cases above write it: the caret as «|», U+00A0 as a space.
    get shown() {
      const caret = this.selectionEnd ?? this.value.length;
      return `${this.value.slice(0, caret)}|${this.value.slice(caret)}`.replaceAll(NBSP, ' ');
    }
  }
  interface Event {
    target: unknown;
    inputType?: string;
    data?: string;
    isComposing?: boolean;
    preventDefault?: () => void;
  }
  const listeners = new Map<string, (event: Event) => void>();
  const send = (type: string, event: Event) => listeners.get(type)!(event);

  before(async () => {
    Object.assign(globalThis, {
      HTMLInputElement: Input,
      document: {
        addEventListener(type: string, listener: (event: Event) => void) {
          listeners.set(type, listener);
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

  test('typing into the amount of a form or of a row of «Разложить»: grouped, the caret kept', () => {
    for (const name of ['amount', 'amount_7', 'amount_123']) {
      const input = new Input(name, '1234567|');
      send('input', { target: input, inputType: 'insertText' });
      assert.equal(input.shown, '1 234 567|', name);
    }
  });

  test('other fields, a word being composed, other elements: left alone', () => {
    for (const name of ['date', 'note', 'amounts']) {
      const input = new Input(name, '1234567|');
      send('input', { target: input });
      assert.equal(input.shown, '1234567|', name);
    }
    const composing = new Input('amount', '1234567|');
    send('input', { target: composing, isComposing: true });
    assert.equal(composing.shown, '1234567|');
    // A space typed by hand stays; the next key decides.
    const spacedByHand = new Input('amount', '12 |');
    send('input', { target: spacedByHand, inputType: 'insertText', data: ' ' });
    assert.equal(spacedByHand.shown, '12 |');
    const letter = new Input('amount', '12 р|');
    send('input', { target: letter, inputType: 'insertText', data: 'р' });
    assert.equal(letter.shown, '12 р|');
    // Not an input field at all, though it looks like one.
    const other = { name: 'amount', value: '1234', matches: () => true };
    send('input', { target: other });
    assert.equal(other.value, '1234');
  });

  test('Backspace after a separator: the digit before it goes, the browser does nothing', () => {
    const input = new Input('amount', '12 |345');
    let prevented = false;
    const preventDefault = () => {
      prevented = true;
    };
    send('beforeinput', { target: input, inputType: 'deleteContentBackward', preventDefault });
    assert.ok(prevented);
    assert.equal(input.shown, '1| 345');
  });

  test('other keys, a chosen part, a key elsewhere: the browser does it', () => {
    for (const [before, inputType, chosen] of [
      ['12 |345', 'insertText', false],
      ['12 3|45', 'deleteContentBackward', false],
      ['12 |345', 'deleteContentBackward', true],
      ['12 |345', 'deleteWordBackward', false],
    ] as const) {
      const input = new Input('amount', before);
      if (chosen) input.selectionStart = 0;
      let prevented = false;
      const preventDefault = () => {
        prevented = true;
      };
      send('beforeinput', { target: input, inputType, preventDefault });
      assert.ok(!prevented, `${before} ${inputType}`);
      assert.equal(input.value, spaced(before.replace('|', '')));
    }
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
