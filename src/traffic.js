// -----------------------------------------------------------------------------
// The traffic of the lines, read every 5 minutes from the GTFS-RT service
// alerts of Naolib (works, diversions, stops not served, events):
//   - each alert names its lines (`informed_entity.route_id`) or its
//     platforms (`stop_id`: the lines calling there are concerned), its
//     periods of validity (Unix times) and its texts. The description is
//     HTML (paragraphs, lists, a link to the map of a diversion), ending with
//     an internal reference ("26/626 - 26/633") that is dropped. Without a
//     header, the title is the first sentence of the description that is not
//     its dates ("Du lundi 31 août au vendredi 30 juillet");
//   - its weight comes from its effect when Naolib sets one (NO_SERVICE ->
//     major; reduced service, delays, detour, stop moved -> disrupted; the
//     others -> info), else from its words ("interrompu" -> major, "déviée",
//     "non desservis", "perturbé" -> disrupted).
// States of a line, from the mildest: `unknown` (nothing read yet), `normal`,
// `info` (a message under way, normal service), `disrupted`, `major`: the
// heaviest message under way. The texts are in French only.
// -----------------------------------------------------------------------------

import { MINUTE_MS } from './time.js';

const STATES = ['unknown', 'normal', 'info', 'disrupted', 'major'];
const SERIOUS = ['disrupted', 'major'];
// A message starting this soon is shown as coming.
const UPCOMING_MS = 3 * 24 * 60 * MINUTE_MS;
const TEXT_MAX = 2000;
const TITLE_MAX = 140;
// GTFS-RT effects.
const EFFECT_STATES = {
  1: 'major',
  2: 'disrupted',
  3: 'disrupted',
  4: 'disrupted',
  5: 'info',
  6: 'info',
  7: 'info',
  9: 'disrupted',
  10: 'info',
  11: 'info',
};
const SEVERE = 4;
// Word bounds that know accented letters: `\b` does not, so "reporté" or
// "perturbé" followed by a space would never match.
const MAJOR_WORDS =
  /(?<![\p{L}\p{N}])(interrompue?s?|interruption|suspendue?s?|hors service|ne circule(nt)? (pas|plus)|aucun(e)? (tram|bus|circulation|desserte)|pas de (circulation|tram|bus))(?![\p{L}\p{N}])/iu;
const DISRUPTED_WORDS =
  /(?<![\p{L}\p{N}])(d[ée]vi[ée]e?s?|d[ée]viation|perturb[ée]e?s?|perturbation|retards?|non desservie?s?|pas desservie?s?|ralentie?s?|report[ée]e?s?|limit[ée]e?s?|accident|incident|manifestation)(?![\p{L}\p{N}])/iu;

// The entities of the descriptions of Naolib.
const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  rsquo: '’',
  lsquo: '‘',
  laquo: '«',
  raquo: '»',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  hellip: '…',
};
// An internal reference closing a description: "26/626", "26/626 - 26/633".
const REFERENCE_LINE = /^\d{2}\/\d+(\s*[-–,]\s*\d{2}\/\d+)*$/;
// A line giving the dates of a message, not its subject: "Du lundi 2 au
// vendredi 6 novembre", "A partir du 1er septembre", or a date alone,
// "Dimanche 8 novembre".
const DATES_LINE =
  /^((du|le|les|à partir du|a partir du|jusqu'au|jusqu’au|depuis le|dès le|des le)\s+(\d|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|1er)|(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+\d{1,2}(er)?\s+\S+(\s+\d{4})?\s*$)/i;

/**
 * @description Decode the HTML entities of a text.
 * @param {string} value - The text.
 * @returns {string} The text.
 */
const decodeEntities = (value) =>
  value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, name) => {
    if (name[0] === '#') {
      const code =
        name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });

/**
 * @description A plain text: no tags, one line per paragraph or list item,
 * blank lines and internal references dropped.
 * @param {unknown} value - The text (HTML or plain).
 * @param {number} [max] - Its longest length.
 * @returns {string} The text.
 */
function plainText(value, max = TEXT_MAX) {
  const text = String(value ?? '')
    .replace(/\r/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line && line !== '-' && !REFERENCE_LINE.test(line))
    .join('\n')
    .slice(0, max);
}

/**
 * @description A short title.
 * @param {string} title - The title of the message.
 * @param {string} text - Its text.
 * @returns {string} The title, or the first sentence of the text that is not
 * its dates, at most TITLE_MAX characters.
 */
function titleOf(title, text) {
  const lines = text.split('\n');
  const firstLine = lines.find((line) => !DATES_LINE.test(line)) ?? lines[0] ?? '';
  const sentence =
    title || (/^(.+?[.!?:])(\s|$)/.exec(firstLine)?.[1] ?? firstLine).replace(/\s*:$/, '');
  return sentence.length > TITLE_MAX ? `${sentence.slice(0, TITLE_MAX - 1)}…` : sentence;
}

/**
 * @description The first link of an HTML description (the map of a diversion).
 * @param {unknown} html - The description.
 * @returns {string} The URL, '' when none.
 */
const firstLink = (html) => decodeEntities(/href="([^"]+)"/i.exec(String(html ?? ''))?.[1] ?? '');

/**
 * @description The document of a message, when on https.
 * @param {unknown} value - The URL.
 * @returns {string} The URL, '' when none.
 */
function linkOf(value) {
  const url = String(value ?? '').trim();
  if (!/^https:\/\/\S+$/i.test(url.replace(/ /g, '%20')) || url.length > 2048) {
    return '';
  }
  return url.replace(/ /g, '%20');
}

/**
 * @description Whether the header of an alert reads as a title, not a code.
 * @param {string} header - The header text.
 * @returns {boolean} True for words, false for "TR/L17/Dev/ TRL17Dev- …".
 */
const readableHeader = (header) =>
  /[a-zàâçéèêëîïôûùüÿœ]{3}/.test(header) && !/[A-Za-z0-9]+\/[A-Za-z0-9]+\//.test(header);

/**
 * @description The weight of an alert.
 * @param {object} alert - The alert (effect, severity, texts).
 * @param {string} text - Its text.
 * @returns {string} `info`, `disrupted` or `major`.
 */
function alertState(alert, text) {
  if (alert.severity === SEVERE) {
    return 'major';
  }
  if (EFFECT_STATES[alert.effect]) {
    return EFFECT_STATES[alert.effect];
  }
  if (MAJOR_WORDS.test(text)) {
    return 'major';
  }
  return DISRUPTED_WORDS.test(text) ? 'disrupted' : 'info';
}

/**
 * @description What is kept of an alert.
 * @param {object} alert - An alert of the feed.
 * @param {Function} [linesOfPlatform] - `(platform id) => route ids`.
 * @returns {object} `{ id, lineIds, state, title, text, url, periods, hours }`,
 * periods `[{ start, end }]` in ms (null when open).
 */
function messageOf(alert, linesOfPlatform = () => []) {
  const header = plainText(alert.header, TITLE_MAX * 2);
  const description = plainText(alert.description);
  const title = titleOf(readableHeader(header) ? header : '', description);
  const text = description || (readableHeader(header) ? header : '');
  const lineIds = [
    ...new Set([
      ...alert.routeIds.filter(Boolean),
      ...alert.stopIds.flatMap((stopId) => linesOfPlatform(stopId)),
    ]),
  ];
  return {
    id: String(alert.id),
    lineIds,
    state: alertState(alert, `${header} ${description}`),
    title,
    text,
    url: linkOf(alert.url) || linkOf(firstLink(alert.description)),
    periods: alert.periods.map((period) => ({
      start: period.start ? period.start * 1000 : null,
      end: period.end ? period.end * 1000 : null,
    })),
    hours: '',
  };
}

/**
 * @description Read the traffic.
 * @param {object} feed - decodeFeed() of the alerts.
 * @param {object} [options] - `{ linesOfPlatform }`.
 * @returns {{ messages: object[] }} The messages about a line.
 */
function parseTraffic(feed, { linesOfPlatform } = {}) {
  return {
    messages: (feed?.alerts ?? [])
      .map((alert) => messageOf(alert, linesOfPlatform))
      .filter((message) => message.lineIds.length > 0 && (message.text || message.title)),
  };
}

/**
 * @description The rank of a state, for comparisons.
 * @param {string} state - A state.
 * @returns {number} Its position in STATES.
 */
const rank = (state) => STATES.indexOf(state);

/**
 * @description A message as it stands at an instant: under way (the period
 * holding now), coming (its next period) or over.
 * @param {object} message - The message.
 * @param {number} now - Now (ms).
 * @returns {object|null} The message with `start`, `end` and `coming`, null when over.
 */
function messageAt(message, now) {
  const periods = message.periods.length ? message.periods : [{ start: null, end: null }];
  const current = periods.find(
    (period) => (period.start ?? -Infinity) <= now && (period.end ?? Infinity) > now,
  );
  if (current) {
    return { ...message, start: current.start, end: current.end, coming: false };
  }
  const next = periods
    .filter((period) => period.start !== null && period.start > now)
    .sort((a, b) => a.start - b.start)[0];
  return next ? { ...message, start: next.start, end: next.end, coming: true } : null;
}

/**
 * @description The traffic of one line.
 * @param {object|null} traffic - parseTraffic().
 * @param {string} lineId - The route id.
 * @param {number} now - Now (ms).
 * @returns {{ state: string, since: number|null, messages: object[], upcoming: object[] }}
 * Its state, the messages under way (heaviest, then latest start first) and
 * the ones coming in the next three days (soonest first).
 */
function lineTraffic(traffic, lineId, now) {
  if (!traffic) {
    return { state: 'unknown', since: null, messages: [], upcoming: [] };
  }
  const own = traffic.messages
    .filter((message) => message.lineIds.includes(lineId))
    .map((message) => messageAt(message, now))
    .filter(Boolean);
  const messages = own
    .filter((message) => !message.coming)
    .sort((a, b) => rank(b.state) - rank(a.state) || (b.start ?? 0) - (a.start ?? 0));
  const upcoming = own
    .filter((message) => message.coming && message.start - now <= UPCOMING_MS)
    .sort((a, b) => a.start - b.start);
  const state = messages[0]?.state ?? 'normal';
  return {
    state,
    since: SERIOUS.includes(state) ? (messages[0].start ?? null) : null,
    messages,
    upcoming,
  };
}

/**
 * @description The messages of a line about a disruption under way.
 * @param {{ messages: object[] }} line - lineTraffic().
 * @returns {object[]} The messages.
 */
const seriousMessages = (line) => line.messages.filter((m) => SERIOUS.includes(m.state));

export {
  STATES,
  SERIOUS,
  UPCOMING_MS,
  decodeEntities,
  plainText,
  titleOf,
  firstLink,
  linkOf,
  readableHeader,
  alertState,
  messageOf,
  parseTraffic,
  rank,
  messageAt,
  lineTraffic,
  seriousMessages,
};
