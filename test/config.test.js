import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeConfig,
  readLanguage,
  readInterval,
  parseLines,
  parseAddedStops,
  DEFAULT_INTERVAL,
  MAX_ADDED_STOPS,
} from '../src/config.js';

test('stops, lines, interval and language from the raw config', () => {
  const config = normalizeConfig({
    stop_1: ' Commerce ',
    stop_1_line: 'C1',
    stop_1_direction: 'Gare de Chantenay',
    stop_2: '',
    stop_3: 'haluchere',
    lines: 'C1, 4 ; ns, c1',
    interval: '30',
    language: 'de',
  });
  assert.deepEqual(config, {
    stops: [
      { slot: 1, stop: 'Commerce', line: 'C1', direction: 'Gare de Chantenay' },
      { slot: 3, stop: 'haluchere', line: '', direction: '' },
    ],
    addedStops: [],
    lines: ['C1', '4', 'ns'],
    interval: 30,
    language: 'de',
  });
  assert.deepEqual(normalizeConfig(null), {
    stops: [],
    addedStops: [],
    lines: [],
    interval: DEFAULT_INTERVAL,
    language: 'auto',
  });
});

test('bounds: six lines, the intervals offered, the stored language', () => {
  assert.equal(parseLines('1,2,3,4,5,6,7,8').length, 6);
  assert.deepEqual(parseLines(undefined), []);
  assert.equal(readInterval(45), DEFAULT_INTERVAL);
  assert.equal(readInterval(300), 300);
  assert.equal(readLanguage({ last_language: 'es' }, 'fr'), 'es');
  assert.equal(readLanguage({ last_language: 'español' }, 'fr'), 'fr');
  assert.equal(readLanguage(undefined, 'en'), 'en');
});

test('the stops added with the buttons follow the three of the form', () => {
  const added = [
    { stop: 'commerce', line: '2', direction: '' },
    { stop: ' Pirmil ', line: '', direction: 'Neustrie' },
    { stop: '', line: '4' },
    'Pirmil',
  ];
  const config = normalizeConfig({ stop_2: 'Poitou', added_stops: added });
  assert.deepEqual(config.stops, [
    { slot: 2, stop: 'Poitou', line: '', direction: '' },
    { slot: null, added: 1, stop: 'commerce', line: '2', direction: '' },
    { slot: null, added: 2, stop: 'Pirmil', line: '', direction: 'Neustrie' },
  ]);
  assert.equal(config.addedStops.length, 2);
  // Stored as JSON text by an older core: read the same.
  assert.deepEqual(parseAddedStops(JSON.stringify(added)), config.addedStops);
  assert.deepEqual(parseAddedStops('not json'), []);
  assert.deepEqual(parseAddedStops(undefined), []);
  const many = Array.from({ length: 20 }, (_, n) => ({ stop: `S${n}` }));
  assert.equal(parseAddedStops(many).length, MAX_ADDED_STOPS);
});
