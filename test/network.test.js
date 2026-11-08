import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  fold,
  slug,
  lineOf,
  byLine,
  groupStops,
  findLine,
  findStop,
  searchStops,
  gtfsDate,
  createNetwork,
  MODES,
} from '../src/network.js';
import { readGtfs } from '../src/gtfs.js';
import { createNaolibClient } from '../src/naolib-api.js';
import { createStore } from '../src/store.js';
import { newDaySince } from '../src/time.js';
import {
  GTFS_ZIP,
  NOW,
  TZ,
  GTFS_FILE_ID,
  fakeNaolib,
  storePath,
  silent,
} from './helpers/fixtures.js';

const reference = await readGtfs(GTFS_ZIP);
const lines = reference.routes.map(lineOf).sort(byLine);
const stops = groupStops(reference.stops, reference.linesByStop);

const L = (name) => `FR_NAOLIB:Line:${name}`;

test('names folded for comparisons, slugs for the ids', () => {
  assert.equal(fold('Haluchère - Batignolles'), 'haluchere batignolles');
  assert.equal(slug('Gare Nord - Jardin des Plantes'), 'gare-nord-jardin-des-plantes');
  assert.equal(gtfsDate(NOW, TZ), '20261108');
});

test('lines: route id, public name, mode and colour, trams first', () => {
  assert.deepEqual(
    lines.find((line) => line.id === L('1')),
    {
      id: L('1'),
      name: '1',
      longName: 'François Mitterrand / Jamet - Beaujoire / Babinière',
      mode: MODES.TRAM,
      color: '#007A45',
    },
  );
  assert.equal(lines.length, 96);
  assert.deepEqual(
    lines.slice(0, 5).map((line) => [line.name, line.mode]),
    [
      ['1', 'tram'],
      ['2', 'tram'],
      ['3', 'tram'],
      ['1B', 'bus'],
      ['4', 'bus'],
    ],
  );
  // The Navibus (route_type 4) reads as a bus line.
  assert.equal(lines.find((line) => line.name === 'N1').mode, MODES.BUS);
});

test('a line is typed the way users read it', () => {
  const id = (typed) => findLine(lines, typed)?.id ?? null;
  assert.equal(id('1'), L('1'));
  assert.equal(id('tram 1'), L('1'));
  assert.equal(id('Tramway 2'), L('2'));
  assert.equal(id('C1'), L('C1'));
  assert.equal(id('chronobus c1'), L('C1'));
  assert.equal(id('busway 4'), L('4'));
  assert.equal(id('ligne 4'), L('4'));
  assert.equal(id('navibus n1'), L('N1'));
  assert.equal(id('NS'), L('NS'));
  assert.equal(id('1B'), L('1B'));
  assert.equal(id('FR_NAOLIB:Line:C1'), L('C1'));
  assert.equal(id('Z9'), null);
  assert.equal(id(''), null);
});

test('stops: the platforms of one stop place, their codes and lines', () => {
  assert.equal(stops.length, 39);
  const gare = stops.find((stop) => stop.name === 'Gare Nord - Jardin des Plantes');
  assert.deepEqual(gare, {
    code: 'gare-nord-jardin-des-plantes',
    name: 'Gare Nord - Jardin des Plantes',
    ids: ['FR_NAOLIB:Quay:151', 'FR_NAOLIB:Quay:152'],
    platforms: ['FR_NAOLIB:Quay:151', 'FR_NAOLIB:Quay:152'],
    lines: [L('1')],
    lat: gare.lat,
    lon: gare.lon,
  });
  assert.ok(Math.abs(gare.lat - 47.218) < 0.01 && Math.abs(gare.lon + 1.543) < 0.01);
  // The six platforms of Commerce: trams and buses.
  const commerce = stops.find((stop) => stop.code === 'commerce');
  assert.equal(commerce.ids.length, 6);
  assert.deepEqual([...commerce.lines].sort(), [L('1'), L('2'), L('3'), L('C2'), L('C3'), L('C8')]);
  // Two places named Poitou (two towns): the second gets "-2".
  assert.deepEqual(
    stops.filter((stop) => stop.name === 'Poitou').map((stop) => [stop.code, stop.ids]),
    [
      ['poitou', ['FR_NAOLIB:Quay:822', 'FR_NAOLIB:Quay:823']],
      ['poitou-2', ['FR_NAOLIB:Quay:1174', 'FR_NAOLIB:Quay:1175']],
    ],
  );
  // Every code is unique.
  assert.equal(new Set(stops.map((stop) => stop.code)).size, stops.length);
  // Grouped by place, not by name; the most common spelling; a platform
  // without a place is a stop of its own; the place numbers order homonyms.
  const grouped = groupStops(
    [
      { id: 'Q3', code: '', name: 'Château', parent: 'P10', lat: 0, lon: 0 },
      { id: 'Q1', code: '', name: 'Chateau', parent: 'P2', lat: 1, lon: 1 },
      { id: 'Q2', code: '', name: 'Château', parent: 'P10', lat: 0, lon: 0 },
      { id: 'Q4', code: '', name: 'Chateau', parent: 'P10', lat: 0, lon: 0 },
      { id: 'Q5', code: '', name: 'Seul', parent: '', lat: 0, lon: 0 },
    ],
    { Q2: ['L1'], Q3: ['L2', 'L1'] },
  );
  assert.deepEqual(
    grouped.map((stop) => [stop.code, stop.name, stop.ids, stop.lines]),
    [
      ['chateau', 'Chateau', ['Q1'], []],
      ['chateau-2', 'Château', ['Q2', 'Q3', 'Q4'], ['L1', 'L2']],
      ['seul', 'Seul', ['Q5'], []],
    ],
  );
});

test('a stop is typed by its name, a few of its words or a platform id', () => {
  const name = (typed) => findStop(stops, typed)?.name ?? null;
  assert.equal(name('gare nord'), 'Gare Nord - Jardin des Plantes');
  assert.equal(name('Haluchère - Batignolles'), 'Haluchère - Batignolles');
  assert.equal(name('commerce'), 'Commerce');
  assert.equal(name('PIRMIL'), 'Pirmil');
  assert.equal(name('haluch'), 'Haluchère - Batignolles');
  assert.equal(name('FR_NAOLIB:Quay:95'), 'Commerce');
  assert.equal(name('chateau'), 'Duchesse Anne - Château');
  // The code of the second Poitou.
  assert.deepEqual(findStop(stops, 'poitou-2').ids, ['FR_NAOLIB:Quay:1174', 'FR_NAOLIB:Quay:1175']);
  // Several stops hold "gare": the user says which.
  assert.equal(name('gare'), null);
  assert.equal(name('Nulle part'), null);
  assert.equal(name(''), null);
  assert.deepEqual(
    searchStops(stops, 'gare').map((stop) => stop.name),
    [
      'Gare de Chantenay',
      'Gare de Pont Rousseau',
      'Gare Maritime',
      'Gare Nord - Jardin des Plantes',
      'Gare Sud',
    ],
  );
  assert.deepEqual(searchStops(stops, '  '), []);
});

/**
 * @description A network on the fake Naolib, with its store.
 * @param {object} [options] - `{ path, clock }`.
 * @returns {Promise<object>} `{ network, api, fetch, store, clock, path }`.
 */
async function network({ path = storePath(), clock = { now: NOW } } = {}) {
  const fetch = fakeNaolib();
  const api = createNaolibClient({ fetch, now: () => clock.now });
  const store = createStore({ path });
  await store.load();
  return {
    network: createNetwork({
      api,
      store,
      zipPath: join(dirname(path), 'naolib-gtfs.zip'),
      now: () => clock.now,
      isNewDay: (since) => newDaySince(since, clock.now, TZ),
      timeZone: TZ,
      logger: silent,
    }),
    api,
    fetch,
    store,
    clock,
    path,
  };
}

test('the timetable is read once, kept with the zip, asked again daily', async () => {
  const first = await network();
  assert.equal((await first.network.lines()).length, 96);
  assert.equal((await first.network.stops()).length, 39);
  await first.network.resolveStop('commerce');
  // The record of the dataset, then the zip.
  assert.deepEqual(
    first.fetch.calls.map((call) => call.path),
    ['json', GTFS_FILE_ID],
  );
  assert.equal(first.store.data.network.lastModified, GTFS_FILE_ID);
  assert.ok(existsSync(join(dirname(first.path), 'naolib-gtfs.zip')));
  // A restart: the store and the zip, nothing downloaded.
  const restart = await network({ path: first.path });
  assert.equal((await restart.network.resolveLine('tram 2')).id, 'FR_NAOLIB:Line:2');
  assert.equal(restart.fetch.calls.length, 0);
  // The next day: the record only, the file is unchanged.
  restart.clock.now = NOW + 24 * 3600 * 1000;
  await restart.network.lines();
  assert.deepEqual(
    restart.fetch.calls.map((call) => call.path),
    ['json'],
  );
  assert.equal(restart.api.requests.notModified, 1);
  // A failure keeps what is known.
  restart.fetch.state.fail = 503;
  assert.equal((await restart.network.lines(true)).length, 96);
  // A new file: downloaded and read.
  restart.fetch.state.fail = null;
  restart.fetch.state.fileId = 'next-file';
  await restart.network.lines(true);
  assert.equal(restart.store.data.network.lastModified, 'next-file');
  assert.equal(restart.fetch.calls.at(-1).path, 'next-file');
});

test('without anything kept, a failure is an error', async () => {
  const { network: net, fetch } = await network();
  fetch.state.fail = 'network';
  await assert.rejects(net.lines(), { kind: 'unreachable' });
});

test('the timetable of the stops: built from the zip, kept while it holds them', async () => {
  const { network: net } = await network();
  const gare = await net.resolveStop('gare nord');
  const pirmil = await net.resolveStop('pirmil');
  const first = await net.timetable([gare]);
  assert.deepEqual(first.codes, ['gare-nord-jardin-des-plantes']);
  assert.equal(first.from, '20261107');
  assert.equal(first.to, '20261114');
  assert.ok(first.rows.length > 20);
  assert.ok(first.rows.every(([, stopId]) => gare.ids.includes(stopId)));
  // Kept as is for the same stop.
  assert.equal(await net.timetable([gare]), first);
  // Another stop: both.
  const both = await net.timetable([pirmil]);
  assert.deepEqual(both.codes, ['gare-nord-jardin-des-plantes', 'pirmil']);
  assert.equal(net.describeTimetable().stops.length, 2);
  assert.deepEqual(net.linesOfPlatform('FR_NAOLIB:Quay:151'), ['FR_NAOLIB:Line:1']);
  assert.equal(net.peekLine('FR_NAOLIB:Line:C1').name, 'C1');
});
