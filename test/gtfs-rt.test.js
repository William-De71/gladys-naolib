import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeFeed, readVarint } from '../src/gtfs-rt.js';
import { TRIP_UPDATES, ALERTS, NOW, encodeFeed, varint } from './helpers/fixtures.js';

test('varints, negative ones on 64 bits', () => {
  assert.deepEqual(readVarint(varint(300), 0), [300n, 2]);
  assert.equal(BigInt.asIntN(64, readVarint(varint(-44), 0)[0]), -44n);
  assert.throws(() => readVarint(Buffer.from([0x80]), 0), { kind: 'invalid' });
});

test('the real trip updates of Naolib', () => {
  const feed = decodeFeed(TRIP_UPDATES);
  assert.equal(feed.timestamp * 1000, NOW);
  assert.equal(feed.tripUpdates.length, 79);
  const [first] = feed.tripUpdates;
  assert.match(first.tripId, /^FR_NAOLIB:VehicleJourney:/);
  assert.match(first.routeId, /^FR_NAOLIB:Line:/);
  assert.ok(first.stops.length > 0);
  // Early or late, in seconds; Naolib sends a stop_sequence, a time and a
  // delay for every platform.
  const stops = feed.tripUpdates.flatMap((update) => update.stops);
  assert.ok(stops.some((stop) => stop.departure.delay < 0));
  assert.ok(stops.every((stop) => stop.sequence !== null && stop.departure.time > 0));
  assert.deepEqual([first.stops[0].sequence, first.stops[0].departure.delay], [1, 0]);
});

test('the real alerts of Naolib: lines, platforms, period, HTML texts', () => {
  const { alerts } = decodeFeed(ALERTS);
  assert.equal(alerts.length, 47);
  const works = alerts.find((alert) => alert.id === 'd276371c-96cb-45f0-a002-e031af8bff1e');
  assert.deepEqual(
    [works.routeIds, works.periods],
    [['FR_NAOLIB:Line:50', 'FR_NAOLIB:Line:81'], [{ start: 1788145200, end: 1816970400 }]],
  );
  assert.equal(works.header, 'Travaux quais Langlois et Jean Bart à Basse Indre');
  assert.match(works.description, /^<h4>Du lundi 31 août 2026/);
  // Some only name platforms, some have neither header nor description.
  assert.ok(alerts.some((alert) => alert.routeIds.length === 0 && alert.stopIds.length > 0));
  assert.ok(alerts.some((alert) => !alert.header && !alert.description));
});

test('cancelled trips, skipped stops, effects; garbage refused', () => {
  const feed = decodeFeed(
    encodeFeed({
      tripUpdates: [
        { tripId: 'T1', routeId: 'FR_NAOLIB:Line:1', cancelled: true },
        {
          tripId: 'T2',
          routeId: 'FR_NAOLIB:Line:2',
          directionId: 1,
          stops: [
            { sequence: 4, stopId: 'FR_NAOLIB:Quay:151', time: 1794093000, delay: -30 },
            { sequence: 5, stopId: 'FR_NAOLIB:Quay:106', skipped: true },
          ],
        },
      ],
      alerts: [
        {
          id: 'a',
          routeIds: ['FR_NAOLIB:Line:3'],
          stopIds: ['FR_NAOLIB:Quay:151'],
          effect: 1,
          url: 'https://x.fr',
        },
      ],
    }),
  );
  assert.equal(feed.tripUpdates[0].cancelled, true);
  const [arrival, skipped] = feed.tripUpdates[1].stops;
  assert.deepEqual(arrival.departure, { delay: -30, time: 1794093000 });
  assert.equal(arrival.sequence, 4);
  assert.equal(skipped.skipped, true);
  assert.equal(feed.tripUpdates[1].directionId, 1);
  assert.deepEqual(
    [feed.alerts[0].effect, feed.alerts[0].stopIds, feed.alerts[0].url],
    [1, ['FR_NAOLIB:Quay:151'], 'https://x.fr'],
  );
  assert.throws(() => decodeFeed(Buffer.from('<html>Bad Gateway</html>')), { kind: 'invalid' });
  assert.throws(() => decodeFeed(Buffer.alloc(0)), { kind: 'invalid' });
});
