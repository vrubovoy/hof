// M13.5: the calendar of a date field (static/calendar.js) — its dates, its month, its keys — and
// what the server gives the field: today in the time zone of the installation and the edges a
// form takes.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { migrate } from '../migrate.ts';
import {
  addDays,
  addMonths,
  dateOfField,
  dayAndMonth,
  dayLabel,
  daysIn,
  fieldOfDate,
  monthTitle,
  monthWeeks,
  moveByKey,
  weekday,
} from './static/calendar.js';
import { addOperation, addPouch, get, pool, post } from './test-helpers.ts';

describe('the dates of the calendar', () => {
  test('a field read as the server reads it: ДД.ММ.ГГГГ or ГГГГ-ММ-ДД, a day that exists', () => {
    for (const [text, date] of [
      ['05.11.2026', '2026-11-05'],
      [' 05.11.2026 ', '2026-11-05'],
      ['2026-11-05', '2026-11-05'],
      ['29.02.2024', '2024-02-29'],
      ['31.12.1999', '1999-12-31'],
      ['29.02.2025', null],
      ['31.04.2026', null],
      ['00.01.2026', null],
      ['01.13.2026', null],
      ['5.11.2026', null],
      ['05/11/2026', null],
      ['', null],
    ] as const) {
      assert.equal(dateOfField(text), date, text);
    }
  });

  test('a date written into the field as ДД.ММ.ГГГГ', () => {
    assert.equal(fieldOfDate('2026-11-05'), '05.11.2026');
    assert.equal(fieldOfDate('2000-01-01'), '01.01.2000');
  });

  test('days: over the end of a month and of a year, in a leap February and not', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2027-01-01', -1), '2026-12-31');
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
    assert.equal(addDays('2025-02-28', 1), '2025-03-01');
    assert.equal(addDays('2026-11-13', -7), '2026-11-06');
    assert.equal(daysIn(2024, 2), 29);
    assert.equal(daysIn(2025, 2), 28);
    assert.equal(daysIn(2000, 2), 29);
    assert.equal(daysIn(2100, 2), 28);
  });

  test('months: December to January and back, the last day where a month is shorter', () => {
    assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
    assert.equal(addMonths('2027-01-15', -1), '2026-12-15');
    assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
    assert.equal(addMonths('2025-01-31', 1), '2025-02-28');
    assert.equal(addMonths('2024-02-29', 12), '2025-02-28');
    assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  });

  test('the weeks of a month from Monday', () => {
    assert.equal(weekday('2026-11-13'), 4);
    assert.equal(weekday('2000-01-01'), 5);
    const november = monthWeeks('2026-11-13');
    // 1 November 2026 is a Sunday: six weeks, the first with one day.
    assert.equal(november.length, 6);
    assert.deepEqual(november[0], [null, null, null, null, null, null, '2026-11-01']);
    assert.deepEqual(november[5], ['2026-11-30', null, null, null, null, null, null]);
    // February 2027 begins on a Monday and has 28 days: four whole weeks.
    const february = monthWeeks('2027-02-10');
    assert.equal(february.length, 4);
    assert.equal(february[0]![0], '2027-02-01');
    assert.equal(february[3]![6], '2027-02-28');
    // A leap February ends on its 29th.
    assert.equal(monthWeeks('2024-02-01').flat().filter(Boolean).at(-1), '2024-02-29');
  });

  test('the words: the month, today, a day for a screen reader', () => {
    assert.equal(monthTitle('2026-11-13'), 'Ноябрь 2026');
    assert.equal(monthTitle('2000-01-01'), 'Январь 2000');
    assert.equal(dayAndMonth('2026-11-13'), '13 ноября');
    assert.equal(dayLabel('2026-11-05'), '5 ноября 2026, четверг');
    assert.equal(dayLabel('2024-02-29'), '29 февраля 2024, четверг');
  });
});

describe('the keys of the calendar', () => {
  const EARLIEST = '2000-01-01';
  const LATEST = '2027-11-13';
  const move = (date: string, key: string, shift = false) =>
    moveByKey(date, key, shift, EARLIEST, LATEST);

  test('a day and a week by the arrows, Monday and Sunday by Home and End', () => {
    assert.equal(move('2026-11-13', 'ArrowLeft'), '2026-11-12');
    assert.equal(move('2026-11-13', 'ArrowRight'), '2026-11-14');
    assert.equal(move('2026-11-13', 'ArrowUp'), '2026-11-06');
    assert.equal(move('2026-11-13', 'ArrowDown'), '2026-11-20');
    assert.equal(move('2026-11-13', 'Home'), '2026-11-09');
    assert.equal(move('2026-11-13', 'End'), '2026-11-15');
    // Over the edge of a month the arrows go on into the next.
    assert.equal(move('2026-11-30', 'ArrowRight'), '2026-12-01');
  });

  test('a month by Page Up and Page Down, a year with Shift', () => {
    assert.equal(move('2026-11-13', 'PageDown'), '2026-12-13');
    assert.equal(move('2026-12-13', 'PageDown'), '2027-01-13');
    assert.equal(move('2026-11-13', 'PageUp', true), '2025-11-13');
    assert.equal(move('2024-02-29', 'PageDown', true), '2025-02-28');
  });

  test('never before 01.01.2000 or after the last date a form takes', () => {
    assert.equal(move('2000-01-03', 'ArrowUp'), EARLIEST);
    assert.equal(move('2000-01-15', 'PageUp'), EARLIEST);
    assert.equal(move('2027-11-10', 'ArrowDown'), LATEST);
    assert.equal(move('2027-11-13', 'ArrowRight'), LATEST);
    assert.equal(move('2027-06-01', 'PageDown', true), LATEST);
  });

  test('any other key is not the grid’s: Escape, Enter, a letter', () => {
    for (const key of ['Escape', 'Enter', ' ', 'Tab', 'a']) {
      assert.equal(move('2026-11-13', key), null, key);
    }
  });
});

// What the server gives each date field of a form.
describe('the dates a date field is given', () => {
  before(() => migrate(pool, join(import.meta.dirname, 'migrations')));
  beforeEach(() => pool.query('TRUNCATE operations, pouches RESTART IDENTITY'));
  after(() => pool.end());

  const datesOf = (page: string) => {
    const field = /<input\s[^>]*name="date"[^>]*>/.exec(page)?.[0] ?? '';
    const data = (name: string) => new RegExp(`data-${name}="([^"]*)"`).exec(field)?.[1];
    return {
      type: /type="([^"]*)"/.exec(field)?.[1],
      today: data('today'),
      earliest: data('earliest'),
      latest: data('latest'),
    };
  };

  test('today in the time zone of the installation, not of the server or the browser', async (t: TestContext) => {
    // 22:30 in UTC on 13 November is already 14 November in Moscow (UTC+3), the zone of the tests.
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 13, 22, 30) });
    const page = await (await get('/saeckel/income', 'anna')).text();
    assert.deepEqual(datesOf(page), {
      type: 'text',
      today: '2026-11-14',
      earliest: '2000-01-01',
      latest: '2027-11-14',
    });
  });

  test('a year after 29 February is 28 February, as the server takes it', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2028, 1, 29, 12) });
    const page = await (await get('/saeckel/income', 'anna')).text();
    assert.equal(datesOf(page).latest, '2029-02-28');
  });

  test('every form with a date: the field keeps its text and gets the dates', async () => {
    const food = await addPouch(1, 'Продукты');
    const rent = await addPouch(1, 'Квартира');
    const record = await addOperation(1, 'income', 100);
    const pages = [
      await get('/saeckel/income', 'anna'),
      await get(`/saeckel/transfer?from=${food}`, 'anna'),
      await get(`/saeckel/pouches/${rent}`, 'anna'),
      await get(`/saeckel/operations/${record}`, 'anna'),
      // A refused form: the date typed stays, and the calendar has its dates.
      await post('/saeckel/income', { amount: 'x', date: '05.11.2026', note: '' }, 'anna'),
    ];
    for (const res of pages) {
      const page = await res.text();
      const dates = datesOf(page);
      assert.equal(dates.type, 'text', res.url);
      assert.match(dates.today ?? '', /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(dates.earliest, '2000-01-01');
      assert.ok((dates.latest ?? '') > (dates.today ?? ''));
      // The button is the script's: a page without it has none.
      assert.ok(!page.includes('date-open'));
    }
    assert.match(
      await (
        await post('/saeckel/income', { amount: 'x', date: '05.11.2026', note: '' }, 'anna')
      ).text(),
      /name="date"[^>]*value="05\.11\.2026"/,
    );
  });
});
