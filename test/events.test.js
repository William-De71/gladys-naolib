// Scene triggers fire once per transition, with flat payloads within the
// limits of the core; scene actions return their declared outputs only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  detectReminders,
  detectCancellations,
  detectLineChanges,
  reminderData,
  cancelledData,
  lineEvent,
  nextDeparturesOutputs,
  lineTrafficOutputs,
  pick,
  tolerance,
  TRIGGERS,
  REMINDER_MINUTES,
  NEXT_DEPARTURES_OUTPUTS,
  LINE_TRAFFIC_OUTPUTS,
} from '../src/events.js';
import { parseTraffic, lineTraffic } from '../src/traffic.js';
import { LANGUAGES } from '../src/i18n.js';
import { NOW, TZ, passage, rawAlert } from './helpers/fixtures.js';

const manifest = JSON.parse(
  readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const FOLLOWED = {
  name: 'Gare Nord - Jardin des Plantes (1 → Beaujoire)',
  deviceId: 'ext:naolib:stop:gare-nord-jardin-des-plantes_1_beaujoire',
  stop: { code: 'gare-nord-jardin-des-plantes', name: 'Gare Nord - Jardin des Plantes' },
};
const C1 = { id: 'FR_NAOLIB:Line:C1', name: 'C1', mode: 'bus', deviceId: 'ext:naolib:line:c1' };
const T1 = { id: 'FR_NAOLIB:Line:1', name: '1', mode: 'tram', deviceId: 'ext:naolib:line:1' };
const MINUTE = 60 * 1000;
const disrupted = (alerts = [rawAlert()]) => parseTraffic({ alerts });
const normal = parseTraffic({ alerts: [] });

/**
 * @description Assert that event data is flat and within the limits of the core.
 * @param {object} data - The data.
 * @param {string} key - The trigger key.
 */
function assertPayload(data, key) {
  const trigger = manifest.scene_triggers.find((entry) => entry.key === key);
  assert.ok(trigger, key);
  assert.ok(Object.keys(data).length <= 30);
  for (const [name, value] of Object.entries(data)) {
    assert.ok(
      value === null || ['string', 'number', 'boolean'].includes(typeof value),
      `${key}.${name}`,
    );
    if (typeof value === 'string') {
      assert.ok(value.length <= 1000, `${key}.${name}`);
    }
  }
  // Every variable is in the data, and every field filters a key of it.
  for (const variable of trigger.variables) {
    assert.ok(variable.key in data, `${key}: variable ${variable.key}`);
  }
  for (const field of trigger.fields) {
    assert.ok(field.key in data, `${key}: field ${field.key}`);
  }
}

test('reminders: once per passage and mark, never on the first reading', () => {
  // 00:11:30 in Paris: 4 min 40 s after 00:06:50.
  const passages = [passage({ time: '24:11:30', trip: 'T1@20261107' })];
  // First reading of the stop: a baseline.
  const first = detectReminders({ passages, fired: undefined, now: NOW });
  assert.deepEqual(first.due, []);
  assert.equal(first.fired.length, 1);
  // 4 min 40 s before: the 5-minute mark, once.
  const memory = detectReminders({ passages, fired: [], now: NOW });
  assert.deepEqual(
    memory.due.map((entry) => entry.mark),
    [5],
  );
  const again = detectReminders({ passages, fired: memory.fired, now: NOW + 10000 });
  assert.deepEqual(again.due, []);
  // The same trip announced later (a delay) is the same passage: no new 5.
  const later = [passage({ time: '24:11:30', delay: 1, trip: 'T1@20261107' })];
  assert.deepEqual(detectReminders({ passages: later, fired: memory.fired, now: NOW }).due, []);
  // Old reminders are forgotten.
  const forgotten = detectReminders({ passages: [], fired: memory.fired, now: NOW + 20 * MINUTE });
  assert.deepEqual(forgotten.fired, []);
  assert.deepEqual(REMINDER_MINUTES.map(tolerance), [1, 1, 1.5, 3, 3, 3]);
});

test('cancellations: once per trip, within the hour, never on the first reading', () => {
  const passages = [
    passage({ time: '24:18', cancelled: true, trip: 'C1' }),
    passage({ time: '25:22', cancelled: true, trip: 'C2' }),
    passage({ time: '24:23', trip: 'C3' }),
  ];
  assert.deepEqual(detectCancellations({ passages, known: undefined, now: NOW }).due, []);
  const first = detectCancellations({ passages, known: [], now: NOW });
  assert.deepEqual(
    first.due.map((entry) => entry.trip),
    ['C1'],
  );
  assert.deepEqual(detectCancellations({ passages, known: first.known, now: NOW }).due, []);
  for (const language of LANGUAGES) {
    assertPayload(
      cancelledData(FOLLOWED, first.due[0], { language, timeZone: TZ }),
      TRIGGERS.DEPARTURE_CANCELLED,
    );
  }
  assert.equal(
    cancelledData(FOLLOWED, first.due[0], { language: 'fr', timeZone: TZ }).summary,
    'Le 1 de 00:18 vers Beaujoire / Babinière à Gare Nord - Jardin des Plantes est supprimé.',
  );
});

test('departure soon: a flat payload, its summary in every language', () => {
  const late = passage({ time: '24:12', delay: 3 });
  for (const language of LANGUAGES) {
    const data = reminderData(FOLLOWED, late, 5, { language, timeZone: TZ });
    assertPayload(data, TRIGGERS.DEPARTURE_SOON);
    assert.equal(data.minutes, '5');
    assert.equal(data.time, '00:15');
    assert.equal(data.delay_minutes, 3);
  }
  assert.equal(
    reminderData(FOLLOWED, late, 5, { language: 'fr', timeZone: TZ }).summary,
    '1 vers Beaujoire / Babinière passe à Gare Nord - Jardin des Plantes dans 5 min (00:15, 3 min de retard).',
  );
  assert.equal(
    reminderData(FOLLOWED, passage({ time: '24:12' }), 5, { language: 'en', timeZone: TZ }).summary,
    '1 towards Beaujoire / Babinière leaves Gare Nord - Jardin des Plantes in 5 min (00:12).',
  );
});

test('line changes: disrupted, a new message, back to normal', () => {
  // First reading of the line: a baseline, even disrupted.
  const first = detectLineChanges({ lines: [C1, T1], traffic: disrupted(), seen: {}, now: NOW });
  assert.deepEqual(first.changes, []);
  assert.equal(first.seen['FR_NAOLIB:Line:C1'].state, 'disrupted');
  // From normal to disrupted: the disruption and its message.
  const before = detectLineChanges({ lines: [C1], traffic: normal, seen: {}, now: NOW - MINUTE });
  const now = detectLineChanges({
    lines: [C1],
    traffic: disrupted(),
    seen: before.seen,
    now: NOW,
  });
  assert.deepEqual(
    now.changes.map((change) => [change.key, change.message?.state]),
    [
      [TRIGGERS.LINE_DISRUPTED, 'disrupted'],
      [TRIGGERS.TRAFFIC_MESSAGE, 'disrupted'],
    ],
  );
  // The same reading again: nothing.
  const same = detectLineChanges({ lines: [C1], traffic: disrupted(), seen: now.seen, now: NOW });
  assert.deepEqual(same.changes, []);
  // A coming message is new too.
  const coming = detectLineChanges({
    lines: [C1],
    traffic: disrupted([
      rawAlert(),
      rawAlert({
        id: 'SOON',
        header: 'Concert au Zénith',
        description: 'Desserte renforcée en soirée.',
        periods: [{ start: NOW / 1000 + 2 * 86400, end: NOW / 1000 + 2 * 86400 + 4 * 3600 }],
      }),
    ]),
    seen: same.seen,
    now: NOW,
  });
  assert.deepEqual(
    coming.changes.map((change) => [change.key, change.message.id, change.message.state]),
    [[TRIGGERS.TRAFFIC_MESSAGE, 'SOON', 'info']],
  );
  // Back to normal.
  const over = detectLineChanges({ lines: [C1], traffic: normal, seen: coming.seen, now: NOW });
  assert.deepEqual(
    over.changes.map((change) => [change.key, change.traffic.state]),
    [[TRIGGERS.LINE_RESTORED, 'normal']],
  );
});

test('line events: flat payloads, summaries in every language', () => {
  const traffic = lineTraffic(disrupted(), C1.id, NOW);
  const [message] = traffic.messages;
  for (const language of LANGUAGES) {
    const event = lineEvent(
      { key: TRIGGERS.LINE_DISRUPTED, line: C1, traffic, message },
      { language, timeZone: TZ },
    );
    assertPayload(event.data, TRIGGERS.LINE_DISRUPTED);
    const fresh = lineEvent(
      { key: TRIGGERS.TRAFFIC_MESSAGE, line: C1, traffic, message },
      { language, timeZone: TZ },
    );
    assertPayload(fresh.data, TRIGGERS.TRAFFIC_MESSAGE);
    const restored = lineEvent(
      { key: TRIGGERS.LINE_RESTORED, line: T1, traffic: lineTraffic(normal, T1.id, NOW) },
      { language, timeZone: TZ },
    );
    assertPayload(restored.data, TRIGGERS.LINE_RESTORED);
  }
  const fresh = lineEvent(
    { key: TRIGGERS.TRAFFIC_MESSAGE, line: C1, traffic, message },
    { language: 'en', timeZone: TZ },
  );
  assert.deepEqual(
    [fresh.data.line, fresh.data.line_name, fresh.data.kind, fresh.data.start, fresh.data.end],
    ['ext:naolib:line:c1', 'Line C1', 'disrupted', '07/11 23:06', '08/11 03:06'],
  );
  assert.equal(fresh.data.summary, 'Line C1, disruption: Travaux rue de la Garde');
  const event = lineEvent(
    { key: TRIGGERS.LINE_DISRUPTED, line: C1, traffic, message },
    { language: 'fr', timeZone: TZ },
  );
  assert.equal(event.data.summary, 'Ligne C1 : Trafic perturbé (Travaux rue de la Garde)');
});

test('scene action outputs: declared keys only, flat values', () => {
  const declared = (key) =>
    manifest.scene_actions.find((action) => action.key === key).outputs.map((output) => output.key);
  assert.deepEqual(NEXT_DEPARTURES_OUTPUTS, declared('get_next_departures'));
  assert.deepEqual(LINE_TRAFFIC_OUTPUTS, declared('get_line_traffic'));
  const passages = [
    passage({ time: '24:12', delay: 2 }),
    passage({ time: '24:27', realtime: false }),
  ];
  const next = pick(
    nextDeparturesOutputs({ followed: FOLLOWED, passages, now: NOW, language: 'en', timeZone: TZ }),
    NEXT_DEPARTURES_OUTPUTS,
  );
  assert.deepEqual(
    [
      next.found,
      next.line,
      next.minutes,
      next.time,
      next.realtime,
      next.delay_minutes,
      next.following_minutes,
    ],
    [true, '1', 7, '00:14', true, 2, 20],
  );
  assert.equal(
    next.summary,
    'Next passage at Gare Nord - Jardin des Plantes: 1 towards Beaujoire / Babinière in 7 min. The following one in 20 min.',
  );
  const none = nextDeparturesOutputs({
    followed: FOLLOWED,
    passages: [],
    now: NOW,
    language: 'en',
    timeZone: TZ,
  });
  assert.deepEqual([none.found, none.minutes, none.time, none.realtime], [false, -1, '', false]);
  assert.equal(none.summary, 'No passage announced at Gare Nord - Jardin des Plantes.');
  const traffic = lineTrafficOutputs({
    line: C1,
    traffic: lineTraffic(disrupted(), C1.id, NOW),
    language: 'fr',
  });
  assert.deepEqual(
    [
      traffic.line_name,
      traffic.state,
      traffic.disrupted,
      traffic.message_count,
      traffic.state_label,
    ],
    ['Ligne C1', 'disrupted', true, 1, 'Trafic perturbé'],
  );
  for (const value of [...Object.values(next), ...Object.values(traffic)]) {
    assert.ok(['string', 'number', 'boolean'].includes(typeof value));
  }
});
