// The widget contents pass the validator of the SDK (what the core would
// drop or truncate), in every language.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import {
  buildDeparturesWidget,
  buildTrafficWidget,
  messageContent,
  readCount,
  routeValue,
  shortDate,
  dateText,
  BOARD_COUNT,
} from '../src/widgets.js';
import { parseTraffic, lineTraffic } from '../src/traffic.js';
import { LANGUAGES } from '../src/i18n.js';
import { NOW, TZ, passage, rawAlert, fixturePassages } from './helpers/fixtures.js';

const PIRMIL = await fixturePassages('Pirmil');
const GARE = await fixturePassages('Gare Nord - Jardin des Plantes');
const line = (id, name, mode = 'bus') => ({ id: `FR_NAOLIB:Line:${id}`, name, mode });

/**
 * @description Assert that the core would keep the content whole.
 * @param {object} content - The content.
 * @param {string} label - For the message.
 */
function assertValid(content, label) {
  assert.deepEqual(validateWidgetContent(content), [], label);
}

test('departures widget: one compact row per route, soonest first, in every language', () => {
  for (const language of LANGUAGES) {
    const content = buildDeparturesWidget({
      title: 'Pirmil',
      passages: PIRMIL,
      readAt: NOW,
      count: 6,
      language,
      now: NOW,
      timeZone: TZ,
    });
    assertValid(content, language);
    const [heading, caption, status] = content.components;
    assert.equal(heading.text, 'Pirmil');
    assert.match(caption.text, /^Naolib · .*00:06/);
    assert.equal(status.items.length, 6);
  }
  const fr = buildDeparturesWidget({
    title: 'Pirmil',
    passages: PIRMIL,
    readAt: NOW,
    count: 4,
    language: 'fr',
    now: NOW,
    timeZone: TZ,
  });
  assert.deepEqual(
    fr.components[2].items.map((item) => [item.label, item.value]),
    [
      ['3 → Neustrie', '3 · 18 · 33 · 48 min · 01:10'],
      ['C4 → Les Sorinières', '9 · 39 min · 01:16 · 01:46'],
      ['C9 → Basse Goulaine / Chalonges', '13 · 43 min'],
      ['3 → Marcel Paul', '13 · 28 · 43 · 58 min · 01:20'],
    ],
  );
});

test('departures widget: a cancelled trip and a late one colour their row', () => {
  const passages = [
    passage({ time: '24:10', cancelled: true, trip: 'C1', destination: 'Beaujoire' }),
    passage({ time: '24:18', trip: 'C2', destination: 'Beaujoire' }),
    passage({ time: '24:08', line: 'C1', destination: 'Ranzay', delay: 6 }),
    passage({ time: '24:12', line: '2', destination: 'Neustrie' }),
  ].sort((a, b) => a.at - b.at);
  const content = buildDeparturesWidget({
    title: 'Commerce',
    passages,
    readAt: NOW,
    count: 6,
    language: 'fr',
    now: NOW,
    timeZone: TZ,
  });
  assertValid(content, 'troubled');
  assert.deepEqual(
    content.components[2].items.map((item) => [item.label, item.value, item.color]),
    [
      ['2 → Neustrie', '5 min', 'success'],
      ['C1 → Ranzay', '7 min', 'warning'],
      ['1 → Beaujoire', 'supprimé 00:10 · 11 min', 'warning'],
    ],
  );
});

test('departures widget: times beyond an hour, nothing announced', () => {
  const options = { language: 'en', now: NOW, timeZone: TZ };
  const late = [passage({ time: '24:12' }), passage({ time: '25:32', realtime: false })];
  assert.equal(routeValue(late, options), '5 min · 01:32');
  const empty = buildDeparturesWidget({
    title: 'Poitou',
    passages: [],
    readAt: NOW,
    count: 6,
    language: 'de',
    now: NOW,
    timeZone: TZ,
  });
  assertValid(empty, 'empty');
  assert.equal(
    empty.components[1].text,
    'Keine Abfahrt angekündigt. Naolib · aktualisiert um 00:06.',
  );
  assert.equal(empty.ttl_seconds, 300);
});

test('departures widget: several stops in one list, a row per stop then its routes', () => {
  const content = buildDeparturesWidget({
    boards: [
      { title: 'Gare Nord', label: 'Gare Nord', passages: GARE, readAt: NOW },
      { title: 'Poitou', label: 'Poitou', passages: [], readAt: NOW - 60000 },
    ],
    count: 6,
    language: 'fr',
    now: NOW,
    timeZone: TZ,
  });
  assertValid(content, 'several');
  const [heading, caption, status] = content.components;
  assert.equal(heading.text, 'Gare Nord · Poitou');
  assert.equal(caption.text, 'Naolib');
  assert.deepEqual(
    status.items.map((item) => [item.icon ?? null, item.label, item.value]),
    [
      ['map-pin', 'Gare Nord', 'lu à 00:06'],
      [null, '1 → Beaujoire / Babinière', '1 · 14 · 31 · 44 min'],
      [null, '1 → François Mitterrand / Jamet', '3 · 18 · 33 min'],
      ['map-pin', 'Poitou', 'Aucun passage annoncé'],
    ],
  );
});

test('traffic widget: states, messages under way and coming, in every language', () => {
  const traffic = parseTraffic({
    alerts: [
      rawAlert(),
      rawAlert({
        id: 'info-1',
        routeIds: ['FR_NAOLIB:Line:1'],
        header: 'Travaux de nuit',
        description: 'Arrêt Commerce : quai provisoire après 22h.',
        url: 'https://naolib.fr/info-trafic',
      }),
      rawAlert({
        id: 'rugby',
        routeIds: ['FR_NAOLIB:Line:C1'],
        header: '',
        description:
          '<p><strong>Dimanche 8 novembre</strong></p>' +
          '<p>Match de rugby à la Beaujoire : la ligne C1 est déviée. Arrêts Ranzay non desservis.</p>',
        periods: [{ start: NOW / 1000 + 2 * 86400, end: NOW / 1000 + 2 * 86400 + 5 * 3600 }],
      }),
    ],
  });
  const lines = [
    line('1', '1', 'tram'),
    line('2', '2', 'tram'),
    line('C1', 'C1'),
    line('4', '4'),
  ].map((entry) => ({ line: entry, traffic: lineTraffic(traffic, entry.id, NOW) }));
  for (const language of LANGUAGES) {
    const content = buildTrafficWidget({ lines, readAt: NOW, language, now: NOW, timeZone: TZ });
    assertValid(content, language);
  }
  const fr = buildTrafficWidget({ lines, readAt: NOW, language: 'fr', now: NOW, timeZone: TZ });
  const [heading, status, cards, caption] = fr.components;
  assert.equal(heading.text, 'Trafic Naolib');
  assert.deepEqual(
    status.items.map((item) => [item.label, item.value, item.color]),
    [
      ['Tram 1', 'Info trafic', 'info'],
      ['Tram 2', 'Trafic normal', 'success'],
      ['Ligne C1', 'Trafic perturbé', 'warning'],
      ['Ligne 4', 'Trafic normal', 'success'],
    ],
  );
  // Under way, the heaviest first, then the coming ones, with their period.
  assert.deepEqual(
    cards.items.map((item) => [item.title, item.badge.text, item.subtitle]),
    [
      ['Travaux rue de la Garde', 'Ligne C1', 'Perturbation · 07/11 23:06 → 03:06'],
      ['Travaux de nuit', 'Tram 1', 'Information · 07/11 23:06 → 03:06'],
      ['Match de rugby à la Beaujoire', 'Ligne C1', 'À venir · 10/11 00:06 → 10/11 05:06'],
    ],
  );
  assert.match(cards.items[2].description, /non desservis/);
  assert.equal(cards.items[1].links[0].url, 'https://naolib.fr/info-trafic');
  assert.equal(caption.text, 'Naolib · mis à jour à 00:06');
  // Nothing to say.
  const calm = buildTrafficWidget({
    lines: [lines[3]],
    readAt: NOW,
    language: 'es',
    now: NOW,
    timeZone: TZ,
  });
  assertValid(calm, 'calm');
  assert.equal(
    calm.components[2].text,
    'Ningún aviso de tráfico para estas líneas. Naolib · actualizado a las 00:06.',
  );
});

test('messages and settings', () => {
  assertValid(messageContent('Hello'), 'message');
  assert.equal(readCount(undefined, BOARD_COUNT), BOARD_COUNT.default);
  assert.equal(readCount('99', BOARD_COUNT), BOARD_COUNT.max);
  assert.equal(readCount(0, BOARD_COUNT), BOARD_COUNT.min);
  assert.equal(shortDate(Date.parse('2026-12-31T22:59:00Z'), TZ), '31/12');
  assert.equal(shortDate(null, TZ), '');
  assert.equal(dateText(Date.parse('2026-11-07T23:01:00Z'), NOW, TZ), '00:01');
  assert.equal(dateText(Date.parse('2026-11-06T20:31:00Z'), NOW, TZ), '06/11 21:31');
  assert.equal(dateText(null, NOW, TZ), '');
});
