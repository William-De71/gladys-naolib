import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  zipEntries,
  readEntry,
  splitCsvLine,
  eachRow,
  gtfsSeconds,
  serviceDates,
  readGtfs,
} from '../src/gtfs.js';
import { GTFS_ZIP, makeZip, gtfsFiles } from './helpers/fixtures.js';

test('a zip, deflated or stored, read through its central directory', async () => {
  for (const store of [false, true]) {
    const zip = makeZip({ 'a.txt': 'héllo', 'dir/b.txt': 'b' }, { store });
    const entries = zipEntries(zip);
    assert.deepEqual([...entries.keys()], ['a.txt', 'b.txt']);
    assert.equal((await readEntry(zip, entries, 'a.txt')).toString('utf8'), 'héllo');
    assert.equal(await readEntry(zip, entries, 'none.txt'), null);
  }
  assert.throws(() => zipEntries(Buffer.from('not a zip at all, not at all')), {
    kind: 'invalid',
  });
});

test('CSV: quotes, CRLF, a byte order mark', () => {
  assert.deepEqual(splitCsvLine('a,"b, c",d'), ['a', 'b, c', 'd']);
  assert.deepEqual(splitCsvLine('"say ""hi""",x'), ['say "hi"', 'x']);
  const rows = [];
  eachRow(Buffer.from('﻿id,name\r\n1,"Gare, Sud"\r\n\r\n2,Pirmil\r\n'), (row, column) =>
    rows.push([row[column('id')], row[column('name')]]),
  );
  assert.deepEqual(rows, [
    ['1', 'Gare, Sud'],
    ['2', 'Pirmil'],
  ]);
  eachRow(null, () => assert.fail('no row'));
});

test('GTFS times beyond midnight; the dates of the services', () => {
  assert.equal(gtfsSeconds('06:43:00'), 6 * 3600 + 43 * 60);
  assert.equal(gtfsSeconds('25:10:30'), 25 * 3600 + 10 * 60 + 30);
  assert.equal(gtfsSeconds('soon'), null);
  const calendar = Buffer.from(
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
      'WEEK,1,1,1,1,1,0,0,20261001,20261231\n',
  );
  const dates = Buffer.from(
    'service_id,date,exception_type\nWEEK,20261028,2\nSUN,20261101,1\nOLD,20250101,1\n',
  );
  assert.deepEqual(Object.fromEntries(serviceDates(calendar, dates, '20261026', '20261102')), {
    WEEK: ['20261026', '20261027', '20261029', '20261030', '20261102'],
    SUN: ['20261101'],
  });
});

test('the GTFS of Naolib: reference data, then the departures of some platforms', async () => {
  const reference = await readGtfs(GTFS_ZIP);
  assert.equal(reference.routes.length, 96);
  // The platforms only: the stop places (location_type 1) are their parents.
  assert.equal(reference.stops.length, 92);
  assert.ok(reference.stops.every((stop) => stop.id.startsWith('FR_NAOLIB:Quay:')));
  assert.equal(
    reference.stops.find((stop) => stop.id === 'FR_NAOLIB:Quay:95').parent,
    'FR_NAOLIB:StopPlace:20',
  );
  assert.equal(reference.timetable, null);
  assert.deepEqual(reference.linesByStop['FR_NAOLIB:Quay:151'], ['FR_NAOLIB:Line:1']);
  const platforms = ['FR_NAOLIB:Quay:151', 'FR_NAOLIB:Quay:152'];
  const { timetable } = await readGtfs(GTFS_ZIP, {
    stopIds: new Set(platforms),
    from: '20261107',
    to: '20261108',
  });
  assert.ok(timetable.rows.length > 20);
  for (const [tripId, stopId, seconds] of timetable.rows) {
    assert.ok(platforms.includes(stopId));
    assert.ok(seconds > 0 && seconds < 30 * 3600);
    const trip = timetable.trips[tripId];
    assert.equal(trip[0], 'FR_NAOLIB:Line:1', tripId);
    assert.ok(timetable.services[trip[1]].length > 0);
  }
  // A terminus is an arrival, never a departure.
  const files = gtfsFiles();
  const last = files['stop_times.txt'].trim().split('\n').at(-1).split(',');
  const { timetable: end } = await readGtfs(GTFS_ZIP, {
    stopIds: new Set([last[3]]),
    from: '20261107',
    to: '20261108',
  });
  assert.ok(!end.rows.some(([tripId]) => tripId === last[0]));
});

test('trips.txt streamed, only the trips of the services running in the window', async () => {
  // Sunday only: the Saturday trips are skipped, their platforms lose them.
  const sunday = await readGtfs(GTFS_ZIP, { from: '20261108', to: '20261108' });
  const both = await readGtfs(GTFS_ZIP, { from: '20261107', to: '20261108' });
  const count = (gtfs) => Object.values(gtfs.linesByStop).flat().length;
  assert.ok(count(sunday) < count(both));
  // No service at all in the window: no line on any platform.
  const none = await readGtfs(GTFS_ZIP, { from: '20250101', to: '20250102' });
  assert.deepEqual(none.linesByStop, {});
  const { timetable } = await readGtfs(GTFS_ZIP, {
    stopIds: new Set(['FR_NAOLIB:Quay:151']),
    from: '20261108',
    to: '20261108',
  });
  assert.ok(timetable.rows.length > 0);
  assert.ok(Object.values(timetable.trips).every((trip) => trip[1].includes('Dimanche')));
});

test('a GTFS without its files is refused', async () => {
  await assert.rejects(readGtfs(makeZip({ 'agency.txt': 'agency_id\nFR_NAOLIB:Operator:1\n' })), {
    kind: 'invalid',
  });
});
