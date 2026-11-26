import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  arrivedAt,
  beyondNoise,
  formatChange,
  formatSummary,
  layoutShift,
  powerShort,
  longFrames,
  normalizeText,
  playingNow,
  quantile,
  recordIds,
  requestStats,
  seedExpenses,
  silence,
  slowestInput,
  summarize,
  type NetRequest,
  type Probe,
} from './measure-stats.ts';
import { report } from './measure-report.ts';
import type { Series } from './measure.ts';

const event = (kind: string, at: number, fields: Record<string, unknown> = {}): Probe => ({
  kind,
  at,
  doc: 'a',
  path: '/',
  ...fields,
});

test('quantile interpolates between the nearest ranks', () => {
  const sorted = [1, 2, 3, 4];
  assert.equal(quantile(sorted, 0), 1);
  assert.equal(quantile(sorted, 1), 4);
  assert.equal(quantile(sorted, 0.5), 2.5);
  assert.equal(quantile(sorted, 0.25), 1.75);
  assert.equal(quantile([7], 0.75), 7);
  assert.throws(() => quantile([], 0.5));
});

test('summarize skips runs without a number and sorts the rest', () => {
  const summary = summarize([30, null, 10, NaN, 20, 40, Infinity]);
  assert.deepEqual(summary, { n: 4, median: 25, q1: 17.5, q3: 32.5, min: 10, max: 40 });
  assert.equal(summarize([null, NaN]), null);
});

test('formatSummary shows the median, the quartiles and the extremes', () => {
  assert.equal(formatSummary(summarize([10, 20, 30, 40, 50])), '30 [20–40] (10–50)');
  assert.equal(formatSummary(summarize([0.25]), 2), '0,25');
  assert.equal(formatSummary(null), '—');
});

test('a change within the interquartile range of either series is noise', () => {
  const base = summarize([100, 104, 108, 112, 116])!; // median 108, IQR 104–112
  const near = summarize([110, 114, 116, 118, 120])!; // median 116: 8 apart, IQR 8
  const far = summarize([130, 131, 132, 133, 134])!;
  assert.equal(beyondNoise(base, near), false);
  assert.equal(formatChange(base, near), '≈');
  assert.equal(beyondNoise(base, far), true);
  assert.equal(formatChange(base, far), '+22 %');
  assert.equal(formatChange(far, base), '-18 %');
  assert.equal(formatChange(summarize([0, 0, 0]), summarize([2, 2, 2])), '+2');
  assert.equal(formatChange(null, far), '—');
  const tight = summarize([502, 502, 502])!;
  assert.equal(formatChange(summarize([503, 503, 503]), tight), '-0,2 %');
});

test('long frames count only frames of 50 ms or more that touch the window', () => {
  const events = [
    event('loaf', 90, { dur: 60 }), // ends at 150, inside
    event('loaf', 120, { dur: 49 }), // too short
    event('loaf', 200, { dur: 80 }),
    event('loaf', 400, { dur: 70 }), // starts after the window
    event('paint', 150),
  ];
  assert.deepEqual(longFrames(events, { from: 100, to: 300 }), { count: 2, max: 80, total: 140 });
  assert.deepEqual(longFrames([], { from: 0, to: 1 }), { count: 0, max: 0, total: 0 });
});

test('the slowest input counts interactions only, and none is null', () => {
  const events = [
    event('input', 100, { dur: 40, id: 1 }),
    event('input', 110, { dur: 90, id: 1 }),
    event('input', 120, { dur: 200, id: 0 }), // not an interaction (a hover)
    event('input', 900, { dur: 300, id: 2 }), // outside
  ];
  assert.equal(slowestInput(events, { from: 50, to: 500 }), 90);
  assert.equal(slowestInput(events, { from: 500, to: 600 }), null);
});

test('layout shift adds shifts without a recent input', () => {
  const events = [
    event('shift', 10, { value: 0.05, input: false }),
    event('shift', 20, { value: 0.5, input: true }),
    event('shift', 30, { value: 0.01, input: false }),
  ];
  assert.ok(Math.abs(layoutShift(events, { from: 0, to: 100 }) - 0.06) < 1e-9);
});

test('silence of a new document: from its hide to the next playing, then the fade-in', () => {
  const events = [
    { ...event('media', 0, { type: 'playing', el: 'a:1' }), doc: 'a' },
    { ...event('hide', 1000), doc: 'a' },
    { ...event('media', 1600, { type: 'playing', el: 'b:1' }), doc: 'b' },
    { ...event('gain', 1610, { target: 0.25, seconds: 0.4 }), doc: 'b' },
  ];
  assert.deepEqual(silence(events, { from: 500, to: 3000 }), {
    longest: 600,
    toLevel: 1610 + 400 - 1000,
    starts: 1,
  });
});

test('a new document committed ends the music of the one before', () => {
  const events = [
    { ...event('media', 0, { type: 'playing', el: 'a:1' }), doc: 'a' },
    { ...event('commit', 300), doc: '' },
    { ...event('media', 650, { type: 'playing', el: 'b:1' }), doc: 'b' },
  ];
  assert.equal(silence(events, { from: 100, to: 1000 }).longest, 350);
  assert.equal(playingNow(events.slice(0, 2)), false);
  assert.equal(playingNow(events), true);
});

test('music that keeps playing has no silence and no new player', () => {
  const events = [event('media', 0, { type: 'playing', el: 'a:1' })];
  assert.deepEqual(silence(events, { from: 100, to: 2000 }), {
    longest: 0,
    toLevel: null,
    starts: 0,
  });
  assert.equal(playingNow(events), true);
});

test('a pause ends playing, and the longest of several gaps counts', () => {
  const events = [
    event('media', 0, { type: 'playing', el: 'a:1' }),
    event('media', 200, { type: 'pause', el: 'a:1' }),
    event('media', 300, { type: 'playing', el: 'a:1' }),
    event('media', 400, { type: 'waiting', el: 'a:1' }),
    event('media', 900, { type: 'playing', el: 'a:1' }),
  ];
  const result = silence(events, { from: 100, to: 1000 });
  assert.equal(result.longest, 500);
  assert.equal(result.starts, 0);
  assert.equal(playingNow(events.slice(0, 4)), false);
});

test('no music at all is silence for the whole window', () => {
  assert.deepEqual(silence([], { from: 0, to: 1500 }), { longest: 1500, toLevel: null, starts: 0 });
  assert.equal(playingNow([]), false);
  assert.equal(
    playingNow([
      { ...event('media', 0, { type: 'playing', el: 'a:1' }), doc: 'a' },
      { ...event('hide', 10), doc: 'a' },
    ]),
    false,
  );
});

test('request stats find repeated, cancelled and failed requests and the POSTs', () => {
  const r = (fields: Partial<NetRequest>): NetRequest => ({
    method: 'GET',
    url: 'http://localhost:3000/',
    type: 'Document',
    at: 100,
    status: 200,
    bytes: 1024,
    canceled: false,
    failed: false,
    ...fields,
  });
  const stats = requestStats(
    [
      r({ method: 'POST', url: 'http://localhost:3000/saeckel/pouches/1/expense', status: 303 }),
      r({ url: 'http://localhost:3000/saeckel/pouches/1' }),
      r({ url: 'http://localhost:3000/saeckel/pouches/1', canceled: true, failed: true }),
      r({ url: 'http://localhost:3000/static/a.css', status: 304, bytes: 0 }),
      r({ url: 'http://localhost:3000/x', failed: true }),
      r({ at: 5000 }),
    ],
    { from: 0, to: 1000 },
  );
  assert.deepEqual(stats, {
    total: 5,
    kb: 4,
    repeated: 1,
    canceled: 1,
    failed: 1,
    posts: 1,
    notModified: 1,
  });
});

test('record ids are the rows of Летопись with the note of a run', () => {
  const rows = [
    { href: '/saeckel/operations/12?page=1', text: '25.11.2026 Еда Трата Замер −123,45 ₽ ›' },
    { href: '/saeckel/operations/7', text: '02.10.2026 Еда Трата Запись 1 −150,00 ₽' },
    { href: '/saeckel/operations/8', text: 'Замерить −1,00' },
    { href: '/elsewhere', text: 'Замер' },
  ];
  assert.deepEqual(recordIds(rows, 'Замер'), [12]);
  assert.equal(normalizeText('  a \n\t b  '), 'a b');
});

test('the test budget is fixed: the same expenses every time, valid amounts and dates', () => {
  const list = seedExpenses(56, 4);
  assert.deepEqual(list, seedExpenses(56, 4));
  assert.equal(list.length, 56);
  assert.deepEqual(list[0], { pouch: 1, amount: '150,00', date: '2026-10-02', note: 'Запись 1' });
  assert.deepEqual(list.at(-1)!.date, '2026-10-29');
  for (const { amount, pouch } of list) {
    assert.match(amount, /^[1-9]\d{2},\d{2}$/);
    assert.ok(pouch >= 1 && pouch <= 4);
  }
  // Every pouch spends less than the 25 000 laid out into it.
  for (let pouch = 1; pouch <= 4; pouch += 1) {
    const spent = list
      .filter((e) => e.pouch === pouch)
      .reduce((sum, e) => sum + Number(e.amount.replace(',', '.')), 0);
    assert.ok(spent < 25_000, String(spent));
  }
});

test('a view arrives on its path; a query must match whole', () => {
  assert.equal(arrivedAt('/saeckel/pouches/1?fresh=5', ['/saeckel/pouches/1']), true);
  assert.equal(arrivedAt('/saeckel/pouches/1/expense', ['/saeckel/pouches/1']), false);
  assert.equal(arrivedAt('/saeckel/history?page=2', ['/saeckel/history?page=2']), true);
  assert.equal(arrivedAt('/saeckel/history', ['/saeckel/history?page=2']), false);
  assert.equal(arrivedAt('/saeckel/history?page=3', ['/saeckel/history?page=2']), false);
});

test('the report compares series and names the noise', () => {
  const step = (toView: number) => ({
    name: 'Двор → Мешки',
    toRequest: 1,
    toView,
    toSettled: toView + 500,
    toLcp: null,
    newDocument: true,
    loaf: { count: 0, max: 0, total: 0 },
    input: 20,
    shift: 0,
    requests: { total: 3, kb: 10, repeated: 0, canceled: 0, failed: 0, posts: 0, notModified: 0 },
    blots: [
      { file: 'ink.webp', place: 'blot-x', box: [1, 2, 3, 4] as [number, number, number, number] },
    ],
  });
  const series = (label: string, views: number[]): Series => ({
    label,
    date: '2026-11-25T12:00:00.000Z',
    product: 'HeadlessChrome/158',
    flags: [],
    node: 'v24',
    power: { start: 'AC', end: 'AC' },
    build: [],
    fingerprint: 'Казна',
    runs: views.length,
    loads: [],
    chain: views.map((v, i) => ({ profile: 'Телефон', anim: false, run: i + 1, steps: [step(v)] })),
    music: [],
    memory: [],
  });
  const text = report([
    series('M13', [200, 210, 220]),
    series('M13 повтор', [205, 212, 225]),
    series('A', [100, 101, 102]),
  ]);
  assert.match(text, /\| Телефон \| выкл \| Двор → Мешки \| 210 \[205–215\] \(200–220\) \|/);
  assert.match(text, /\| ≈ \| -52 % \|/);
  assert.match(text, /\| M13 повтор \| \d+ из \d+ \|/);
  assert.match(text, /ink\.webp 1,2,3,4 \| да \|/);
});

test('the power of the Mac is shown short', () => {
  const ac = "Now drawing from 'AC Power' -InternalBattery-0 (id=1) 32%; charging; present: true";
  assert.equal(powerShort(ac), 'сеть 32 %');
  assert.equal(
    powerShort("Now drawing from 'Battery Power' -InternalBattery-0 80%;"),
    'батарея 80 %',
  );
  assert.equal(powerShort(''), '');
});
