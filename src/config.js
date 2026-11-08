// -----------------------------------------------------------------------------
// Configuration of Naolib integration.
//
// Fields of the config_schema (the open data of Naolib need no key):
//   - `stop_<n>`              a followed stop (`<n>` from 1 to 3): its name
//                             ("Commerce") or the code of a platform ("41115");
//   - `stop_<n>_line`         only this line ("1", "6", "Amigo"), empty for
//                             every line;
//   - `stop_<n>_direction`    only the destinations holding these words
//                             ("Beaujoire | François Mitterrand"), empty for both
//                             directions;
//   - `lines`                 the lines whose traffic is followed ("1, 2,
//                             6, 17"), six at most;
//   - `interval`              seconds between two readings of the stops;
//   - `language`              language of the texts Gladys does not ask for in
//                             a language (device names, scene summaries):
//                             `auto` follows the last widget request.
//
// Internal keys, outside the config_schema (never shown in the UI, stored by
// setConfig):
//   - `added_stops`           the stops added with the "Add a stop" button,
//                             `[{ stop, line, direction }]`: as many as the
//                             user wants (MAX_ADDED_STOPS), next to the three
//                             of the form. Kept in the Gladys database, so
//                             they follow its backups;
//   - `last_language`         language of the last widget request.
// -----------------------------------------------------------------------------

import { isLanguage } from './i18n.js';

const MAX_STOPS = 3;
// The real time of every stop comes in one request, but each stop adds to
// the timetable kept in memory: a home, a workplace, a school and a few more.
const MAX_ADDED_STOPS = 10;
const MAX_LINES = 6;
const AUTO_LANGUAGE = 'auto';
const INTERNAL_KEYS = { addedStops: 'added_stops', language: 'last_language' };
const INTERVALS = [30, 60, 120, 300];
const DEFAULT_INTERVAL = 60;

const readString = (raw) => (typeof raw === 'string' ? raw.trim() : '');

/**
 * @description Read the reading interval.
 * @param {unknown} raw - The raw value ("60", 60).
 * @returns {number} Seconds, one of INTERVALS.
 */
function readInterval(raw) {
  const value = Number(raw);
  return INTERVALS.includes(value) ? value : DEFAULT_INTERVAL;
}

/**
 * @description Split a list of lines typed by hand.
 * @param {unknown} raw - "1, 6 ; 17".
 * @returns {string[]} The lines, without duplicates, six at most.
 * @example
 * parseLines('1, 6 ; 17'); // -> ['1', '6', '17']
 */
function parseLines(raw) {
  const seen = new Set();
  return readString(raw)
    .split(/[,;\n]+/)
    .map((entry) => entry.trim())
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (!entry || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, MAX_LINES);
}

/**
 * @description Read the stops added with the configuration buttons.
 * @param {unknown} raw - The stored value: an array (or its JSON text).
 * @returns {Array<{ stop: string, line: string, direction: string }>} The
 * valid entries, MAX_ADDED_STOPS at most.
 * @example
 * parseAddedStops([{ stop: 'commerce', line: '1', direction: '' }]);
 */
function parseAddedStops(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return (Array.isArray(list) ? list : [])
    .filter((entry) => entry && typeof entry === 'object' && readString(entry.stop))
    .map((entry) => ({
      stop: readString(entry.stop),
      line: readString(entry.line),
      direction: readString(entry.direction),
    }))
    .slice(0, MAX_ADDED_STOPS);
}

/**
 * @description Normalize the raw config object from the host API.
 * @param {object} [rawConfig] - The raw config values.
 * @returns {object} `{ stops: [{ slot, stop, line, direction }],
 * addedStops, lines, interval, language }`; a slot without a stop is left
 * out. `stops` holds the three slots of the form, then the added stops
 * (`slot` null, `added` their position from 1).
 * @example
 * normalizeConfig({ stop_1: 'Commerce', stop_1_line: '1' });
 */
function normalizeConfig(rawConfig = {}) {
  const config = rawConfig ?? {};
  const stops = [];
  for (let slot = 1; slot <= MAX_STOPS; slot += 1) {
    const stop = readString(config[`stop_${slot}`]);
    if (stop) {
      stops.push({
        slot,
        stop,
        line: readString(config[`stop_${slot}_line`]),
        direction: readString(config[`stop_${slot}_direction`]),
      });
    }
  }
  const addedStops = parseAddedStops(config[INTERNAL_KEYS.addedStops]);
  addedStops.forEach((entry, index) => stops.push({ slot: null, added: index + 1, ...entry }));
  return {
    stops,
    addedStops,
    lines: parseLines(config.lines),
    interval: readInterval(config.interval),
    language: isLanguage(config.language) ? config.language : AUTO_LANGUAGE,
  };
}

/**
 * @description Read the stored language of the last request.
 * @param {object} [rawConfig] - The raw config values.
 * @param {string} fallback - The language to keep when nothing valid is stored.
 * @returns {string} The language.
 * @example
 * readLanguage({ last_language: 'fr' }, 'en'); // -> 'fr'
 */
function readLanguage(rawConfig, fallback) {
  const language = (rawConfig ?? {})[INTERNAL_KEYS.language];
  return typeof language === 'string' && /^[a-z]{2}$/.test(language) ? language : fallback;
}

export {
  MAX_STOPS,
  MAX_ADDED_STOPS,
  MAX_LINES,
  AUTO_LANGUAGE,
  INTERNAL_KEYS,
  INTERVALS,
  DEFAULT_INTERVAL,
  readInterval,
  parseLines,
  parseAddedStops,
  normalizeConfig,
  readLanguage,
};
