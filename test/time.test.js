import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatTime, localClock, serviceDay, newDaySince, wallToInstant } from '../src/time.js';

const TZ = 'Europe/Paris';

test('times of day in the timezone of the instance', () => {
  assert.equal(formatTime(Date.parse('2026-10-17T20:19:00Z'), TZ), '22:19');
  assert.equal(formatTime(Date.parse('2026-10-17T20:19:00Z'), 'UTC'), '20:19');
  assert.equal(formatTime(null, TZ), '');
  assert.deepEqual(localClock(Date.parse('2026-10-25T01:30:00Z'), TZ), {
    date: '2026-10-25',
    minutes: 150,
  });
});

test('the service day changes at 04:00, local time', () => {
  assert.equal(serviceDay(Date.parse('2026-10-17T22:30:00Z'), TZ), '2026-10-17');
  assert.equal(serviceDay(Date.parse('2026-10-18T02:10:00Z'), TZ), '2026-10-18');
  const evening = Date.parse('2026-10-17T20:00:00Z');
  assert.equal(newDaySince(evening, Date.parse('2026-10-18T01:00:00Z'), TZ), false);
  assert.equal(newDaySince(evening, Date.parse('2026-10-18T02:05:00Z'), TZ), true);
  assert.equal(newDaySince(0, evening, TZ), true);
});

test('Paris wall-clock times, both sides of a change of hour', () => {
  const iso = (y, mo, d, h, mi) =>
    new Date(wallToInstant(Date.UTC(y, mo - 1, d, h, mi))).toISOString();
  // Winter (UTC+1), summer (UTC+2).
  assert.equal(iso(2026, 10, 27, 21, 8), '2026-10-27T20:08:00.000Z');
  assert.equal(iso(2026, 7, 1, 12, 0), '2026-07-01T10:00:00.000Z');
  // The hour repeated on 25 October: the first one. The hour skipped on 29
  // March: the offset of before.
  assert.equal(iso(2026, 10, 25, 2, 30), '2026-10-25T00:30:00.000Z');
  assert.equal(iso(2026, 3, 29, 2, 30), '2026-03-29T01:30:00.000Z');
});
