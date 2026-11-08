// The traps of the Gladys core that the fake Gladys does not catch
// (community feedback, thread 11005): a device is only polled with
// should_poll AND poll_frequency, every feature needs min / max / read_only /
// has_feedback, a wrong category / type pair shows no icon nor label, and a
// single invalid field rejects the whole discovery batch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

import {
  codeKey,
  stopKey,
  followedName,
  idsOf,
  parseExternalId,
  buildStopDevice,
  buildStopStates,
  buildLineDevice,
  buildLineStates,
  lineStatusText,
  DEVICE_TYPES,
} from '../src/device.js';
import { parseTraffic, lineTraffic } from '../src/traffic.js';
import { LANGUAGES } from '../src/i18n.js';
import { fakeGladys, NOW, TZ, passage, rawAlert } from './helpers/fixtures.js';

const GARE_1 = {
  stop: { code: 'gare-nord-jardin-des-plantes', name: 'Gare Nord - Jardin des Plantes' },
  line: { id: 'FR_NAOLIB:Line:1', name: '1', mode: 'tram' },
  direction: 'Beaujoire',
};
GARE_1.key = stopKey(GARE_1.stop, GARE_1.line, GARE_1.direction);
GARE_1.name = followedName(GARE_1);
const PIRMIL = {
  stop: { code: 'pirmil', name: 'Pirmil' },
  line: null,
  direction: '',
};
PIRMIL.key = stopKey(PIRMIL.stop, null, '');
PIRMIL.name = followedName(PIRMIL);
const L4 = { id: 'FR_NAOLIB:Line:4', name: '4', mode: 'bus' };
const T1 = { id: 'FR_NAOLIB:Line:1', name: '1', mode: 'tram' };
const N1 = { id: 'FR_NAOLIB:Line:N1', name: 'N1', mode: 'bus' };
const C1 = { id: 'FR_NAOLIB:Line:C1', name: 'C1', mode: 'bus' };
const PASSAGES = [
  passage({ time: '24:20', delay: 1 }),
  passage({ time: '24:35', delay: 0 }),
  passage({ time: '24:10', line: '2', destination: 'Orvault Grand Val' }),
];
const forStop = (list) =>
  list.filter((entry) => entry.lineId === 'FR_NAOLIB:Line:1').sort((a, b) => a.at - b.at);
const traffic = parseTraffic({
  alerts: [
    rawAlert(),
    rawAlert({
      id: 'info-1',
      routeIds: ['FR_NAOLIB:Line:1'],
      header: 'Travaux de nuit',
      description: 'Arrêt Commerce : quai provisoire après 22h.',
    }),
  ],
});

const devices = (language) => [
  buildStopDevice(fakeGladys, GARE_1, language),
  buildStopDevice(fakeGladys, PIRMIL, language),
  buildLineDevice(fakeGladys, L4, language),
  buildLineDevice(fakeGladys, T1, language),
  buildLineDevice(fakeGladys, N1, language),
];

// Pairs with an icon and a label in the Gladys front (front/src/utils/consts.js).
const PAIRS = [
  [DEVICE_FEATURE_CATEGORIES.TEXT, DEVICE_FEATURE_TYPES.TEXT.TEXT, undefined],
  [
    DEVICE_FEATURE_CATEGORIES.DURATION,
    DEVICE_FEATURE_TYPES.DURATION.INTEGER,
    DEVICE_FEATURE_UNITS.MINUTES,
  ],
  [DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR, DEVICE_FEATURE_TYPES.SENSOR.INTEGER, undefined],
];

test('devices are never polled by Gladys: the integration has its own timer', () => {
  for (const device of devices('en')) {
    assert.equal(device.should_poll, false, device.external_id);
    assert.equal(device.poll_frequency, undefined);
  }
});

test('every feature carries min, max, read_only and has_feedback, in every language', () => {
  for (const language of LANGUAGES) {
    for (const device of devices(language)) {
      for (const feature of device.features) {
        for (const key of ['min', 'max']) {
          assert.equal(typeof feature[key], 'number', `${feature.external_id}.${key}`);
        }
        assert.ok(feature.min <= feature.max, feature.external_id);
        assert.equal(feature.read_only, true, feature.external_id);
        assert.equal(feature.has_feedback, false, feature.external_id);
        assert.ok(feature.name.length > 0 && feature.name.length <= 255);
      }
      const names = new Set(device.features.map((feature) => feature.name));
      assert.equal(names.size, device.features.length, 'every feature has its own name');
    }
  }
});

test('category / type / unit pairs known to the Gladys front, from the SDK constants', () => {
  for (const feature of devices('en').flatMap((device) => device.features)) {
    assert.ok(
      PAIRS.some(
        ([category, type, unit]) =>
          feature.category === category && feature.type === type && feature.unit === unit,
      ),
      `${feature.external_id}: ${feature.category}/${feature.type}/${feature.unit}`,
    );
  }
});

test('ids from the code of the stop, the route id and the direction; read back', () => {
  const [gare, pirmil, l4, t1, n1] = devices('fr');
  assert.equal(gare.external_id, 'ext:naolib:stop:gare-nord-jardin-des-plantes_1_beaujoire');
  assert.equal(gare.name, 'Naolib Gare Nord - Jardin des Plantes (1 → Beaujoire)');
  assert.equal(pirmil.external_id, 'ext:naolib:stop:pirmil');
  assert.equal(pirmil.name, 'Naolib Pirmil');
  // The route ids of Naolib carry a prefix: "FR_NAOLIB:Line:4" -> "4".
  assert.deepEqual([l4.external_id, l4.name], ['ext:naolib:line:4', 'Naolib ligne 4']);
  assert.deepEqual([t1.external_id, t1.name], ['ext:naolib:line:1', 'Naolib tram 1']);
  assert.deepEqual([n1.external_id, n1.name], ['ext:naolib:line:n1', 'Naolib ligne N1']);
  assert.equal(codeKey('FR_NAOLIB:Line:C1'), 'c1');
  assert.equal(codeKey('fr_naolib:line:NS'), 'ns');
  assert.equal(stopKey({ code: 'commerce' }, C1, ''), 'commerce_c1');
  assert.equal(devices('de')[3].name, 'Naolib Straßenbahn 1');
  assert.deepEqual(parseExternalId('ext:naolib:stop:pirmil:wait'), {
    type: 'stop',
    key: 'pirmil',
  });
  assert.deepEqual(parseExternalId('ext:naolib:line:c1'), { type: 'line', key: 'c1' });
  assert.equal(parseExternalId('something'), null);
  // Other accents or case in the direction: the same device.
  assert.equal(stopKey(GARE_1.stop, GARE_1.line, 'BEAUJOIRE'), GARE_1.key);
  assert.deepEqual(
    gare.params.map((param) => [param.name, param.value]),
    [
      ['NAOLIB_STOP', 'Gare Nord - Jardin des Plantes'],
      ['NAOLIB_LINE', '1'],
      ['NAOLIB_DIRECTION', 'Beaujoire'],
    ],
  );
});

test('stop states: the next passage, the two waits and the delay', () => {
  const states = buildStopStates(fakeGladys, GARE_1, forStop(PASSAGES), {
    language: 'fr',
    now: NOW,
    timeZone: TZ,
  });
  const byKey = Object.fromEntries(
    states.map((s) => [s.device_feature_external_id.split(':').pop(), s.state ?? s.text]),
  );
  // 00:06:50: the 1 of 00:20, 1 min late (00:21), then the one of 00:35.
  assert.equal(byKey.wait, 14);
  assert.equal(byKey.following, 28);
  assert.equal(byKey.delay, 1);
  assert.equal(byKey.next, '1 → Beaujoire / Babinière · 14 min (+1 min de retard)');
  // The timetable only: no delay published, the text says it.
  const scheduled = buildStopStates(
    fakeGladys,
    GARE_1,
    [passage({ time: '24:12', realtime: false })],
    { language: 'en', now: NOW, timeZone: TZ },
  );
  assert.deepEqual(
    scheduled.map((s) => s.device_feature_external_id.split(':').pop()),
    ['next', 'wait'],
  );
  assert.equal(scheduled[0].text, '1 → Beaujoire / Babinière · 5 min (timetable)');
  // Nothing announced: the waits are left untouched.
  const empty = buildStopStates(fakeGladys, PIRMIL, [], { language: 'es', now: NOW });
  assert.deepEqual(
    empty.map((s) => s.text),
    ['Ningún paso anunciado'],
  );
});

test('line states: the state with the title of the heaviest message, the count', () => {
  assert.deepEqual(
    buildLineStates(fakeGladys, C1, lineTraffic(traffic, C1.id, NOW), 'fr').map(
      (s) => s.text ?? s.state,
    ),
    ['Trafic perturbé : Travaux rue de la Garde', 1],
  );
  assert.deepEqual(
    buildLineStates(fakeGladys, L4, lineTraffic(traffic, L4.id, NOW), 'en').map(
      (s) => s.text ?? s.state,
    ),
    ['Normal traffic', 0],
  );
  const [status] = buildLineStates(fakeGladys, T1, lineTraffic(traffic, T1.id, NOW), 'de');
  assert.equal(status.text, 'Verkehrsinformation: Travaux de nuit');
  assert.equal(lineStatusText({ state: 'major', messages: [] }, 'es'), 'Tráfico muy alterado');
});

test('the discovery batch and the states pass the checks of the fake host API', async (t) => {
  const gladys = createFakeGladys({});
  t.after(() => gladys.fake.shutdown());
  await gladys.connect();
  for (const language of LANGUAGES) {
    await gladys.publishDiscoveredDevices([
      buildStopDevice(gladys, GARE_1, language),
      buildLineDevice(gladys, C1, language),
    ]);
  }
  const [stop, line] = gladys.fake.discoveredDevices;
  await gladys.fake.deviceCreated(stop);
  await gladys.fake.deviceCreated(line);
  await gladys.publishStates(
    buildStopStates(gladys, GARE_1, forStop(PASSAGES), { language: 'en', now: NOW }),
  );
  await gladys.publishStates(buildLineStates(gladys, C1, lineTraffic(traffic, C1.id, NOW), 'en'));
  assert.equal(idsOf(gladys, DEVICE_TYPES.STOP, GARE_1.key).device, stop.external_id);
  assert.equal(idsOf(gladys, DEVICE_TYPES.LINE, C1.id).device, line.external_id);
  assert.equal(gladys.fake.lastState(`${stop.external_id}:wait`), 14);
  assert.equal(gladys.fake.lastState(`${line.external_id}:messages`), 1);
});
