// dates.ts: «today» in a time zone, a typed date, dates on the page (ARCHITECTURE.md §4.7, §5.6).
// Every «now» is fixed. No database.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dateForField, dateForList, parseDate, timeZoneError, today } from './dates.ts';

const DATE_ERROR = 'Дата — ДД.ММ.ГГГГ, не раньше 01.01.2000 и не дальше года вперёд.';

describe('today', () => {
  test('the calendar date of the moment in the time zone, around midnight', () => {
    // 21:30 UTC on 31 December: still 31 December in London, already 1 January in Moscow.
    const evening = new Date('2026-12-31T21:30:00Z');
    assert.equal(today('Europe/London', evening), '2026-12-31');
    assert.equal(today('Europe/Moscow', evening), '2027-01-01');
    assert.equal(today('UTC', evening), '2026-12-31');
    // 03:00 UTC: the evening before in New York, the morning in Tokyo.
    const night = new Date('2026-03-01T03:00:00Z');
    assert.equal(today('America/New_York', night), '2026-02-28');
    assert.equal(today('Asia/Tokyo', night), '2026-03-01');
    // The exact minute of midnight in Moscow (UTC+3).
    assert.equal(today('Europe/Moscow', new Date('2026-05-31T20:59:59Z')), '2026-05-31');
    assert.equal(today('Europe/Moscow', new Date('2026-05-31T21:00:00Z')), '2026-06-01');
  });

  test('always ISO, whatever the process time zone and locale', () => {
    assert.match(today('Pacific/Kiritimati', new Date()), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('parseDate', () => {
  const TODAY = '2026-10-14';

  test('ДД.ММ.ГГГГ and ГГГГ-ММ-ДД', () => {
    assert.deepEqual(parseDate('05.10.2026', TODAY), { date: '2026-10-05' });
    assert.deepEqual(parseDate('2026-10-05', TODAY), { date: '2026-10-05' });
    assert.deepEqual(parseDate('  05.10.2026 ', TODAY), { date: '2026-10-05' });
  });

  test('nothing typed is today', () => {
    assert.deepEqual(parseDate('', TODAY), { date: TODAY });
    assert.deepEqual(parseDate('   ', TODAY), { date: TODAY });
  });

  test('only days that exist', () => {
    assert.deepEqual(parseDate('29.02.2024', TODAY), { date: '2024-02-29' });
    for (const text of [
      '31.02.2026',
      '29.02.2026',
      '30.02.2024',
      '31.04.2026',
      '00.10.2026',
      '32.01.2026',
      '15.13.2026',
      '15.00.2026',
      '2026-02-29',
    ]) {
      assert.deepEqual(parseDate(text, TODAY), { error: DATE_ERROR }, text);
    }
  });

  test('from 01.01.2000 to a year after today', () => {
    assert.deepEqual(parseDate('01.01.2000', TODAY), { date: '2000-01-01' });
    assert.deepEqual(parseDate('31.12.1999', TODAY), { error: DATE_ERROR });
    assert.deepEqual(parseDate('14.10.2027', TODAY), { date: '2027-10-14' });
    assert.deepEqual(parseDate('15.10.2027', TODAY), { error: DATE_ERROR });
    // From 29 February the year ends on 28 February.
    assert.deepEqual(parseDate('28.02.2029', '2028-02-29'), { date: '2029-02-28' });
    assert.deepEqual(parseDate('01.03.2029', '2028-02-29'), { error: DATE_ERROR });
  });

  test('other forms are refused', () => {
    for (const text of [
      '5.10.2026',
      '05.10.26',
      '05/10/2026',
      '2026-10-5',
      '2026.10.05',
      '05-10-2026',
      'вчера',
      '2026-10-05T00:00',
      '１５.１０.２０２６',
    ]) {
      assert.deepEqual(parseDate(text, TODAY), { error: DATE_ERROR }, text);
    }
  });
});

describe('dates on the page', () => {
  test('ДД.ММ.ГГГГ in the field, ДД.ММ in a list', () => {
    assert.equal(dateForField('2026-10-05'), '05.10.2026');
    assert.equal(dateForList('2026-10-05'), '05.10');
    assert.equal(dateForField('2000-01-01'), '01.01.2000');
  });

  test('a date the field shows is read back as the same date', () => {
    for (const date of ['2000-01-01', '2024-02-29', '2026-12-31']) {
      assert.deepEqual(parseDate(dateForField(date), '2026-10-14'), { date });
    }
  });
});

describe('timeZoneError', () => {
  test('a time zone Intl knows', () => {
    assert.equal(timeZoneError('Europe/Moscow'), null);
    assert.equal(timeZoneError('UTC'), null);
  });

  test('missing or unknown', () => {
    assert.equal(timeZoneError(undefined), 'TZ is not set (see .env.example)');
    assert.equal(timeZoneError(''), 'TZ is not set (see .env.example)');
    assert.equal(timeZoneError('Mars/Olympus'), 'TZ=Mars/Olympus is not a time zone');
  });
});
