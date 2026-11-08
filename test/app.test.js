// The whole integration against the fake Gladys of the SDK
// (`@gladysassistant/integration-sdk/testing`), which checks the discovered
// devices, the states and the scene events like the host API does, and a
// fake Naolib serving real (reduced) open data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import { createApp, SCENE_ACTIONS, ACTIONS, IDLE_INTERVAL_MS } from '../src/app.js';
import { BUSY_RETRIES } from '../src/naolib-api.js';
import { WIDGETS } from '../src/widgets.js';
import { TRIGGERS } from '../src/events.js';
import { formatTime } from '../src/time.js';
import { fakeNaolib, storePath, silent, encodeFeed, alertC1, NOW, TZ } from './helpers/fixtures.js';

const CONFIG = {
  stop_1: 'Haluchère',
  stop_1_line: 'chronobus C1',
  stop_1_direction: 'Chantenay',
  stop_2: 'gare nord',
  stop_3: 'Nulle part',
  lines: '1, C1, 4, Z9',
  interval: '60',
  language: 'fr',
};
const PREFIX = 'ext:test-integration';
const HALU_C1 = `${PREFIX}:stop:haluchere-batignolles_c1_chantenay`;
const GARE = `${PREFIX}:stop:gare-nord-jardin-des-plantes`;
const T1 = `${PREFIX}:line:1`;
const C1 = `${PREFIX}:line:c1`;
const L4 = `${PREFIX}:line:4`;
const QUIET = encodeFeed({ alerts: [] });
const MINUTE = 60 * 1000;
const TRIP_UPDATES = 'trip_updates';

/**
 * @description The integration, connected to a fake Gladys and a fake Naolib.
 * @param {object} [options] - `{ config, path, logger, alerts }`: `alerts`
 * the feed of alerts served from the start (the real one by default, where
 * the demonstration of Saturday cuts most lines).
 * @returns {Promise<object>} `{ gladys, app, api, clock, path, pauses }`.
 */
async function startApp({ config = CONFIG, path = storePath(), logger = silent, alerts } = {}) {
  const clock = { now: NOW };
  const api = fakeNaolib();
  if (alerts) {
    api.state.alerts = alerts;
  }
  const pauses = [];
  const gladys = createFakeGladys({ config });
  const app = createApp(gladys, {
    fetch: api,
    storePath: path,
    now: () => clock.now,
    timeZone: TZ,
    timers: false,
    logger,
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
  await gladys.connect();
  await app.whenReady();
  return { gladys, app, api, clock, path, pauses };
}

const created = async (gladys, externalId) => {
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === externalId);
  assert.ok(device, `${externalId} is offered`);
  await gladys.fake.deviceCreated(device);
  return device;
};
const eventsOf = (gladys, key) => gladys.fake.sceneEvents.filter((event) => event.key === key);
const realtimeReads = (app) => app.api.requests.byEndpoint[TRIP_UPDATES] ?? 0;
const tripOf = (passage) => passage.trip.split('@')[0];

const LINE = (name) => `FR_NAOLIB:Line:${name}`;

test('two stops and three lines become five devices; unknown names are reported', async (t) => {
  const { gladys, api } = await startApp();
  t.after(() => gladys.fake.shutdown());
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((device) => [device.external_id, device.name]),
    [
      [HALU_C1, 'Naolib Haluchère - Batignolles (C1 → Chantenay)'],
      [GARE, 'Naolib Gare Nord - Jardin des Plantes'],
      [T1, 'Naolib tram 1'],
      [C1, 'Naolib ligne C1'],
      [L4, 'Naolib ligne 4'],
    ],
  );
  const status = gladys.fake.connectionStatus;
  assert.equal(status.connected, true);
  assert.equal(
    status.message.fr,
    'Connecté à Naolib : 2 arrêt(s), 3 ligne(s), temps réel lu toutes les 60 s. Inconnu ou ambigu : Nulle part, Z9.',
  );
  // The record of the timetable and its zip once, the real time of both
  // stops in one request, the alerts.
  assert.deepEqual(
    api.calls.map((call) => call.path),
    [
      'json',
      '0cc0469a72de54ee045cb66d1a21de9e',
      'naolib-nantes-gtfs-rt-trip-update',
      'naolib-nantes-gtfs-rt-alerts',
    ],
  );
  // The first readings are a baseline: nothing fires.
  assert.deepEqual(gladys.fake.sceneEvents, []);
});

test('created devices get their states, sent again after the creation', async (t) => {
  const { gladys, app, api, clock } = await startApp();
  t.after(() => gladys.fake.shutdown());
  await created(gladys, HALU_C1);
  await created(gladys, GARE);
  await created(gladys, C1);
  const [next] = app.getSnapshot('haluchere-batignolles_c1_chantenay').passages;
  assert.equal(next.destination, 'Gare de Chantenay');
  assert.equal(gladys.fake.lastState(`${HALU_C1}:wait`), Math.floor((next.at - NOW) / MINUTE));
  assert.match(gladys.fake.lastState(`${HALU_C1}:next`), /^C1 → Gare de Chantenay · \d+ min/);
  assert.equal(gladys.fake.lastState(`${GARE}:next`), '1 → Beaujoire / Babinière · 1 min');
  assert.equal(gladys.fake.lastState(`${GARE}:following`), 3);
  // The demonstration of Saturday cuts the C1 until 03:00.
  assert.equal(
    gladys.fake.lastState(`${C1}:status`),
    'Trafic très perturbé : Manifestation du samedi 7 novembre',
  );
  assert.equal(gladys.fake.lastState(`${C1}:messages`), 1);
  // The bus gets four minutes late; the line not created gets nothing.
  api.state.tripUpdates = encodeFeed({
    timestamp: (NOW + MINUTE) / 1000,
    tripUpdates: [
      {
        tripId: tripOf(next),
        routeId: LINE('C1'),
        stops: [
          {
            sequence: 1,
            stopId: next.platform,
            time: (next.scheduled + 4 * MINUTE) / 1000,
            delay: 240,
          },
        ],
      },
    ],
  });
  clock.now += MINUTE;
  await app.readStops();
  assert.equal(gladys.fake.lastState(`${HALU_C1}:delay`), 4);
  assert.match(gladys.fake.lastState(`${HALU_C1}:next`), /\(\+4 min de retard\)$/);
  assert.equal(gladys.fake.lastState(`${T1}:status`), undefined);
});

test('departure soon: fired close to its mark, once, between two readings too', async (t) => {
  const { gladys, app, api, clock } = await startApp({
    config: {
      stop_1: 'Pirmil',
      stop_1_line: 'tram 3',
      stop_1_direction: 'Neustrie',
      language: 'en',
    },
  });
  t.after(() => gladys.fake.shutdown());
  const passage = app
    .getSnapshot('pirmil_3_neustrie')
    .passages.find((entry) => entry.scheduled > NOW + 20 * MINUTE);
  clock.now += MINUTE;
  const at = clock.now + 12 * MINUTE;
  api.state.tripUpdates = encodeFeed({
    timestamp: clock.now / 1000,
    tripUpdates: [
      {
        tripId: tripOf(passage),
        routeId: LINE('3'),
        stops: [
          {
            sequence: 5,
            stopId: passage.platform,
            time: at / 1000,
            delay: (at - passage.scheduled) / 1000,
          },
        ],
      },
    ],
  });
  await app.readStops({ force: true });
  const ours = () =>
    eventsOf(gladys, TRIGGERS.DEPARTURE_SOON).filter(
      (event) => event.data.time === formatTime(at, TZ),
    );
  assert.deepEqual(ours(), []);
  // Seven minutes later, without a reading: the 5-minute mark (between readings).
  clock.now += 7 * MINUTE + 10000;
  await app.checkReminders();
  assert.deepEqual(
    ours().map((event) => [event.data.minutes, event.data.line, event.data.destination]),
    [['5', '3', 'Neustrie']],
  );
  assert.equal(ours()[0].data.stop, `${PREFIX}:stop:pirmil_3_neustrie`);
  assert.match(
    ours()[0].data.summary,
    new RegExp(`^3 towards Neustrie leaves Pirmil in 5 min \\(${formatTime(at, TZ)}`),
  );
  await app.checkReminders();
  await app.readStops({ force: true });
  assert.equal(ours().length, 1);
});

test('departure cancelled: fired once per trip of the next hour', async (t) => {
  const { gladys, app, api } = await startApp({
    config: { stop_1: 'Pirmil', language: 'fr' },
  });
  t.after(() => gladys.fake.shutdown());
  const passage = app
    .getSnapshot('pirmil')
    .passages.find((entry) => entry.lineId === LINE('3') && entry.scheduled > NOW + 10 * MINUTE);
  api.state.tripUpdates = encodeFeed({
    tripUpdates: [{ tripId: tripOf(passage), routeId: LINE('3'), cancelled: true }],
  });
  await app.readStops({ force: true });
  await app.readStops({ force: true });
  const time = formatTime(passage.scheduled, TZ);
  const cancelled = eventsOf(gladys, TRIGGERS.DEPARTURE_CANCELLED);
  assert.deepEqual(
    cancelled.map((event) => [event.data.line, event.data.time, event.data.stop]),
    [['3', time, `${PREFIX}:stop:pirmil`]],
  );
  assert.equal(
    cancelled[0].data.summary,
    `Le 3 de ${time} vers ${passage.destination} à Pirmil est supprimé.`,
  );
  // Shown in the widget, left out of the waits.
  const widget = await gladys.fake.widgetGet(WIDGETS.DEPARTURES, { settings: {}, language: 'fr' });
  assert.ok(
    widget.data.content.components[2].items.some((item) => item.value.includes(`supprimé ${time}`)),
  );
});

test('a disruption, then back to normal: fired once each, never again after a restart', async (t) => {
  const path = storePath();
  const config = { stop_1: 'Haluchère', lines: 'C1', language: 'fr' };
  const { gladys, app, api, clock } = await startApp({ config, path, alerts: QUIET });
  t.after(() => gladys.fake.shutdown());
  // The C1 diverted.
  api.state.alerts = encodeFeed({ alerts: [alertC1()] });
  await app.trafficTick();
  assert.deepEqual(
    gladys.fake.sceneEvents.map((event) => [event.key, event.data.line_name, event.data.kind]),
    [
      [TRIGGERS.LINE_DISRUPTED, 'Ligne C1', undefined],
      [TRIGGERS.TRAFFIC_MESSAGE, 'Ligne C1', 'disrupted'],
    ],
  );
  const [disrupted] = gladys.fake.sceneEvents;
  assert.equal(disrupted.data.line, C1);
  assert.deepEqual(
    [disrupted.data.state, disrupted.data.title, disrupted.data.start],
    ['disrupted', 'Travaux rue de la Garde', '07/11 23:06'],
  );
  assert.match(disrupted.data.message, /^Du samedi 7 au dimanche 8 novembre\nEn raison de travaux/);
  assert.equal(disrupted.data.summary, 'Ligne C1 : Trafic perturbé (Travaux rue de la Garde)');
  // The same reading again: nothing new.
  await app.trafficTick();
  assert.equal(gladys.fake.sceneEvents.length, 2);
  // A restart on the same /data: nothing replayed, nothing downloaded again.
  const second = createFakeGladys({ config });
  t.after(() => second.fake.shutdown());
  const calls = api.calls.length;
  const restarted = createApp(second, {
    fetch: api,
    storePath: path,
    now: () => clock.now,
    timeZone: TZ,
    timers: false,
    logger: silent,
  });
  await second.connect();
  await restarted.whenReady();
  assert.deepEqual(second.fake.sceneEvents, []);
  assert.ok(!api.calls.slice(calls).some((call) => call.url.includes('/files/')));
  // The detour over; a mere information still runs.
  clock.now += 30 * MINUTE;
  api.state.alerts = encodeFeed({ alerts: [alertC1({ effect: 6 })] });
  await restarted.trafficTick();
  assert.deepEqual(
    second.fake.sceneEvents.map((event) => [event.key, event.data.state]),
    [[TRIGGERS.LINE_RESTORED, 'info']],
  );
});

test('one request for every stop; quiet stops every 10 minutes', async (t) => {
  const { gladys, app, clock } = await startApp({
    config: {
      stop_1: 'Pirmil',
      stop_2: 'Pirmil',
      stop_2_line: '3',
      interval: '30',
      added_stops: [
        { stop: 'gare-nord-jardin-des-plantes', line: '', direction: '' },
        { stop: 'haluchere-batignolles', line: 'FR_NAOLIB:Line:C1', direction: '' },
      ],
    },
  });
  t.after(() => gladys.fake.shutdown());
  assert.equal(app.getStops().length, 4);
  const before = realtimeReads(app);
  clock.now += 31 * 1000;
  await app.readStops();
  assert.equal(realtimeReads(app), before + 1, 'four devices, one request');
  // No tram through Commerce that night: read every 10 minutes.
  const night = await startApp({ config: { stop_1: 'Commerce' } });
  t.after(() => night.gladys.fake.shutdown());
  const quiet = realtimeReads(night.app);
  night.clock.now += 2 * MINUTE;
  await night.app.readStops();
  assert.equal(realtimeReads(night.app), quiet);
  night.clock.now += IDLE_INTERVAL_MS;
  await night.app.readStops();
  assert.equal(realtimeReads(night.app), quiet + 1);
});

test('the open data down: a clear status; without real time, the timetable', async (t) => {
  const { gladys, app, api, clock } = await startApp();
  t.after(() => gladys.fake.shutdown());
  await created(gladys, GARE);
  api.state.fail = 404;
  await app.trafficTick();
  clock.now += 4 * MINUTE;
  await app.readStops();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /do not answer \(alerts: HTTP 404\)/);
  // The timetable kept in /data still gives the departures.
  assert.match(gladys.fake.lastState(`${GARE}:next`), /\(théorique\)$/);
  api.state.fail = null;
  await app.trafficTick();
  await app.readStops();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  // Back in real time (the next tram of 00:21 is not under way yet: its
  // timetable only).
  const realtime = () =>
    app.getSnapshot('gare-nord-jardin-des-plantes').passages.filter((p) => p.realtime).length;
  assert.ok(realtime() > 0);
  // The real time alone failing for a while: still connected, the timetable
  // meanwhile.
  api.state.failRealtime = 502;
  clock.now += 4 * MINUTE;
  await app.readStops();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(realtime(), 0);
});

test('a refused real time: asked again after a pause, else the reading of less than 3 min', async (t) => {
  const { gladys, app, api, clock, pauses } = await startApp();
  t.after(() => gladys.fake.shutdown());
  await created(gladys, GARE);
  // The source answers once per 30 s: one 429, then the feed.
  api.state.busy = 1;
  clock.now += MINUTE;
  await app.readStops();
  assert.equal(pauses.length, 1);
  assert.doesNotMatch(gladys.fake.lastState(`${GARE}:next`), /théorique/);
  // Refused every time: the reading of a minute ago stands in, no error.
  api.state.busy = 100;
  clock.now += MINUTE;
  await app.readStops();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.doesNotMatch(gladys.fake.lastState(`${GARE}:next`), /théorique/);
  assert.equal(app.api.requests.busy, 1 + BUSY_RETRIES + 1);
  // Too old after 3 minutes: the timetable only.
  clock.now += 3 * MINUTE;
  await app.readStops();
  assert.match(gladys.fake.lastState(`${GARE}:next`), /\(théorique\)$/);
});

test('widgets: followed stops, a typed stop, lines; valid in every language', async (t) => {
  const { gladys } = await startApp();
  t.after(() => gladys.fake.shutdown());
  for (const language of ['en', 'fr', 'de', 'es']) {
    const answers = [
      await gladys.fake.widgetGet(WIDGETS.DEPARTURES, { settings: {}, language }),
      await gladys.fake.widgetGet(WIDGETS.DEPARTURES, {
        settings: { stops: [HALU_C1, GARE] },
        language,
      }),
      await gladys.fake.widgetGet(WIDGETS.DEPARTURES, {
        settings: { stop_name: 'Pirmil', line: 'C4' },
        language,
      }),
      await gladys.fake.widgetGet(WIDGETS.TRAFFIC, { settings: {}, language }),
      await gladys.fake.widgetGet(WIDGETS.TRAFFIC, { settings: { lines: 'C1' }, language }),
    ];
    for (const answer of answers) {
      assert.equal(answer.success, true);
      assert.deepEqual(validateWidgetContent(answer.data.content), [], language);
    }
  }
  const typed = await gladys.fake.widgetGet(WIDGETS.DEPARTURES, {
    settings: { stop_name: 'Pirmil', line: 'C4' },
    language: 'fr',
  });
  const [heading, , status] = typed.data.content.components;
  assert.equal(heading.text, 'Pirmil (C4)');
  assert.deepEqual(
    status.items.map((item) => item.label),
    ['C4 → Les Sorinières', 'C4 → Greneraie'],
  );
  const unknown = await gladys.fake.widgetGet(WIDGETS.TRAFFIC, {
    settings: { lines: 'Z9' },
    language: 'en',
  });
  assert.equal(unknown.data.content.components[0].text, 'Unknown or ambiguous: Z9.');
});

test('the traffic widget shows the trams when no line is followed', async (t) => {
  const { gladys } = await startApp({ config: { stop_1: 'Pirmil' } });
  t.after(() => gladys.fake.shutdown());
  const traffic = await gladys.fake.widgetGet(WIDGETS.TRAFFIC, { settings: {}, language: 'fr' });
  assert.deepEqual(
    traffic.data.content.components[1].items.map((item) => [item.label, item.value]),
    [
      ['Tram 1', 'Trafic très perturbé'],
      ['Tram 2', 'Trafic très perturbé'],
      ['Tram 3', 'Trafic très perturbé'],
    ],
  );
});

test('scene actions: next departures of a stop, traffic of a line', async (t) => {
  const { gladys, api } = await startApp({ alerts: QUIET });
  t.after(() => gladys.fake.shutdown());
  const next = await gladys.fake.sceneAction(SCENE_ACTIONS.GET_NEXT_DEPARTURES, { stop: GARE });
  assert.equal(next.success, true);
  const { outputs } = next.data;
  assert.deepEqual(
    [outputs.found, outputs.line, outputs.destination, outputs.minutes, outputs.realtime],
    [true, '1', 'Beaujoire / Babinière', 1, true],
  );
  assert.equal(outputs.following_minutes, 3);
  assert.equal(
    outputs.summary,
    'Prochain passage à Gare Nord - Jardin des Plantes : 1 vers Beaujoire / Babinière dans 1 min. Le suivant dans 3 min.',
  );
  api.state.alerts = encodeFeed({ alerts: [alertC1()] });
  const traffic = await gladys.fake.sceneAction(SCENE_ACTIONS.GET_LINE_TRAFFIC, { line: C1 });
  // A reading of less than 90 s is reused: the alert is not seen yet.
  assert.equal(traffic.data.outputs.state, 'normal');
  const first = await gladys.fake.sceneAction(SCENE_ACTIONS.GET_LINE_TRAFFIC, {});
  assert.deepEqual(
    [first.data.outputs.line_name, first.data.outputs.summary],
    ['Tram 1', 'Tram 1 : Trafic normal.'],
  );
});

test('configuration actions: test, find a stop, diagnostic', async (t) => {
  const { gladys, api } = await startApp();
  t.after(() => gladys.fake.shutdown());
  api.state.alerts = encodeFeed({ alerts: [alertC1()] });
  const tested = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.equal(tested.success, true);
  const fr = tested.data.message.fr;
  assert.match(fr, /^Open data Naolib joint : 96 lignes, 39 arrêts/);
  assert.match(fr, /Gare Nord - Jardin des Plantes : 16 passage\(s\), prochain 1 dans 1 min/);
  assert.match(fr, /Tram 1 : Trafic normal · Ligne C1 : Trafic perturbé · Ligne 4 : Trafic normal/);
  assert.match(fr, /inconnu ou ambigu : Nulle part · inconnu ou ambigu : Z9/);
  // The record of the timetable asked again; the zip, unchanged, is not.
  const files = api.calls.filter((call) => call.url.includes('/files/'));
  assert.equal(files.length, 1);
  assert.equal(api.calls.filter((call) => call.path === 'json').length, 2);
  const found = await gladys.fake.action(ACTIONS.SEARCH_STOP, { query: 'poitou' });
  const text = found.data.message.fr;
  assert.match(text, /^Saisissez le nom/);
  assert.match(text, /\n• Poitou \[poitou\] → 3\n/);
  assert.match(text, /\n• Poitou \[poitou-2\]/);
  const gare = await gladys.fake.action(ACTIONS.SEARCH_STOP, { query: 'gare nord' });
  assert.match(
    gare.data.message.fr,
    /\n• Gare Nord - Jardin des Plantes \[gare-nord-jardin-des-plantes\] → 1/,
  );
  const short = await gladys.fake.action(ACTIONS.SEARCH_STOP, { query: 'r' });
  assert.match(short.data.message.en, /at least two letters/);
  const none = await gladys.fake.action(ACTIONS.SEARCH_STOP, { query: 'zzz' });
  assert.equal(none.data.message.en, 'No stop matches "zzz".');
  const diagnostic = await gladys.fake.action(ACTIONS.DIAGNOSTIC);
  assert.match(diagnostic.data.message.en, /Naolib diagnostic/);
});

test('add, list and remove stops with the buttons, beyond the three of the form', async (t) => {
  const { gladys, app } = await startApp();
  t.after(() => gladys.fake.shutdown());
  const added = await gladys.fake.action(ACTIONS.ADD_STOP, { stop: 'pirmil', line: 'tram 2' });
  assert.match(added.data.message.en, /^Stop added: Pirmil \(2\)\. 3 stop\(s\)/);
  assert.deepEqual(gladys.fake.config.added_stops, [
    { stop: 'pirmil', line: LINE('2'), direction: '' },
  ]);
  assert.ok(
    gladys.fake.discoveredDevices.some(
      (device) => device.external_id === `${PREFIX}:stop:pirmil_2`,
    ),
  );
  const snapshot = app.getSnapshot('pirmil_2');
  assert.ok(snapshot.passages.length > 0);
  assert.ok(snapshot.passages.every((p) => p.lineId === LINE('2')));
  const again = await gladys.fake.action(ACTIONS.ADD_STOP, { stop: 'Pirmil', line: '2' });
  assert.match(again.data.message.en, /already followed/);
  const unknown = await gladys.fake.action(ACTIONS.ADD_STOP, { stop: 'Nowhere' });
  assert.equal(unknown.data.message.en, 'Unknown or ambiguous: Nowhere.');
  const list = await gladys.fake.action(ACTIONS.LIST_STOPS);
  assert.equal(
    list.data.message.fr,
    '4 arrêt(s) suivi(s) :\n' +
      '1. Haluchère - Batignolles (C1 → Chantenay) (formulaire, arrêt 1)\n' +
      '2. Gare Nord - Jardin des Plantes (formulaire, arrêt 2)\n' +
      '3. Nulle part (formulaire, arrêt 3, inconnu ou ambigu)\n' +
      '4. Pirmil (2)',
  );
  const inForm = await gladys.fake.action(ACTIONS.REMOVE_STOP, { stop: '2' });
  assert.match(inForm.data.message.en, /is stop 2 of the form/);
  const removed = await gladys.fake.action(ACTIONS.REMOVE_STOP, { stop: '4' });
  assert.match(removed.data.message.en, /^Stop removed: Pirmil \(2\)/);
  assert.deepEqual(gladys.fake.config.added_stops, []);
  assert.equal(app.getStops().length, 2);
});
