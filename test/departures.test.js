import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  directionTerms,
  serviceStart,
  indexTripUpdates,
  applyRealtime,
  buildPassages,
  minutesLeft,
  upcomingPassages,
  cancelledPassages,
  routeOf,
} from '../src/departures.js';
import { decodeFeed } from '../src/gtfs-rt.js';
import { NOW, encodeFeed, paris, passage, fixturePassages } from './helpers/fixtures.js';

const MINUTE = 60 * 1000;
const index = (tripUpdates) => indexTripUpdates(decodeFeed(encodeFeed({ tripUpdates })));

test('GTFS times count from noon minus 12 hours, even when the clocks change', () => {
  assert.equal(serviceStart('20261107'), Date.parse('2026-11-06T23:00:00Z'));
  // 25 October 2026: back to winter time at 03:00. Noon minus 12 hours is
  // 01:00 summer time, not midnight.
  assert.equal(serviceStart('20261025'), Date.parse('2026-10-24T23:00:00Z'));
  assert.deepEqual(directionTerms('Beaujoire | Ranzay'), ['beaujoire', 'ranzay']);
  assert.deepEqual(directionTerms(''), []);
});

test('real time: the estimate of the platform, the closest one on a loop line', () => {
  const scheduled = paris('24:20');
  const at = (minutes) => (scheduled + minutes * MINUTE) / 1000;
  const updates = index([
    {
      tripId: 'T1',
      stops: [
        { sequence: 1, stopId: 'FR_NAOLIB:Quay:151', time: at(-40), delay: 0 },
        { sequence: 2, stopId: 'FR_NAOLIB:Quay:133', time: at(-5), delay: 30 },
        { sequence: 3, stopId: 'FR_NAOLIB:Quay:151', time: at(3), delay: 120 },
      ],
    },
    { tripId: 'T2', cancelled: true },
    { tripId: 'T3', stops: [{ stopId: 'FR_NAOLIB:Quay:151', skipped: true }] },
  ]);
  assert.deepEqual(applyRealtime(updates.get('T1'), 'FR_NAOLIB:Quay:151', scheduled, NOW), {
    at: scheduled + 3 * MINUTE,
    realtime: true,
    cancelled: false,
  });
  // No estimate for this platform: the delay of the platform before it.
  assert.deepEqual(applyRealtime(updates.get('T1'), 'FR_NAOLIB:Quay:106', scheduled, NOW), {
    at: scheduled + 30000,
    realtime: true,
    cancelled: false,
  });
  assert.equal(
    applyRealtime(updates.get('T2'), 'FR_NAOLIB:Quay:151', scheduled, NOW).cancelled,
    true,
  );
  // A cancelled trip of today says nothing of tomorrow.
  assert.equal(
    applyRealtime(updates.get('T2'), 'FR_NAOLIB:Quay:151', scheduled + 24 * 60 * MINUTE, NOW)
      .cancelled,
    false,
  );
  assert.equal(
    applyRealtime(updates.get('T3'), 'FR_NAOLIB:Quay:151', scheduled, NOW).cancelled,
    true,
  );
  // No update, or one of another day: the timetable only.
  assert.deepEqual(applyRealtime(undefined, 'FR_NAOLIB:Quay:151', scheduled, NOW), {
    at: scheduled,
    realtime: false,
    cancelled: false,
  });
  assert.equal(
    applyRealtime(updates.get('T1'), 'FR_NAOLIB:Quay:151', scheduled + 24 * 60 * MINUTE, NOW)
      .realtime,
    false,
  );
});

test('the passages of a real stop: timetable, real time, filters', async () => {
  const gare = await fixturePassages('Gare Nord - Jardin des Plantes');
  assert.equal(gare.length, 16);
  assert.ok(gare.every((p, i) => i === 0 || gare[i - 1].at <= p.at));
  // The trams in service are followed; the later ones are the timetable.
  const [first] = gare;
  assert.deepEqual(
    [first.line, first.destination, first.realtime, minutesLeft(first, NOW)],
    ['1', 'Beaujoire / Babinière', true, 1],
  );
  assert.equal(first.lineId, 'FR_NAOLIB:Line:1');
  assert.equal(gare.filter((p) => p.realtime).length, 7);
  assert.ok(gare.every((p) => p.at > NOW - 30000 && p.at <= NOW + 24 * 60 * MINUTE));
  // The next three hours, eight per route at most.
  const pirmil = await fixturePassages('Pirmil');
  assert.equal(pirmil.length, 40);
  const routes = Map.groupBy(pirmil, routeOf);
  assert.equal(routes.size, 13);
  assert.ok([...routes.values()].every((list) => list.length <= 8));
  const timetable = await fixturePassages('Pirmil', { realtime: false });
  assert.ok(timetable.every((p) => !p.realtime && p.delay === 0));
  const tram3 = await fixturePassages('Pirmil', {
    lineId: 'FR_NAOLIB:Line:3',
    direction: 'neustrie|orvault',
  });
  assert.equal(tram3.length, 8);
  assert.ok(tram3.every((p) => p.lineId === 'FR_NAOLIB:Line:3' && p.destination === 'Neustrie'));
  // A stop asleep (no tram through Commerce that night): the first departure
  // of each route, the next morning.
  const commerce = await fixturePassages('Commerce');
  assert.equal(commerce.length, 12);
  assert.ok(commerce.every((p) => !p.realtime));
  assert.deepEqual(
    commerce.slice(0, 4).map((p) => [p.line, p.destination]),
    [
      ['1', 'Beaujoire / Babinière'],
      ['2', 'Orvault Grand Val'],
      ['1', 'François Mitterrand / Jamet'],
      ['3', 'Neustrie'],
    ],
  );
  assert.equal(new Set(commerce.map(routeOf)).size, 12);
  assert.deepEqual(buildPassages({ timetable: null, stop: { ids: [] }, now: NOW }), []);
});

test('waits, the passages to come, the cancelled ones', () => {
  const list = [
    passage({ time: '24:00' }),
    passage({ time: '24:10', cancelled: true }),
    passage({ time: '24:17' }),
  ];
  assert.equal(minutesLeft(list[2], NOW), 10);
  assert.equal(minutesLeft(list[0], NOW), 0);
  assert.deepEqual(
    upcomingPassages(list, NOW).map((p) => p.trip),
    ['1-24:17'],
  );
  assert.deepEqual(
    cancelledPassages(list, NOW).map((p) => p.trip),
    ['1-24:10'],
  );
  assert.equal(routeOf(list[0]), 'FR_NAOLIB:Line:1|beaujoire babiniere');
});
