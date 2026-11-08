// -----------------------------------------------------------------------------
// The departures of a stop: the timetable of the GTFS (network.js), corrected
// by the real time of the GTFS-RT trip updates.
//
//   - the timetable gives each departure of the platforms of the stop: its
//     trip (line, headsign), its service (the dates it runs) and its time, in
//     seconds from the noon of the service day minus 12 hours (beyond 24:00
//     after midnight: GTFS times, never wall-clock times);
//   - a trip update of the same trip id gives, per platform, the estimate
//     (`time`, Unix seconds) and the delay (seconds). Naolib sends no
//     stop_sequence: a platform is matched by its id, the estimate closest to
//     the timetable (a loop line calls twice at a platform). A platform
//     without its own estimate takes the delay of the last platform before it
//     in the trip (GTFS-RT propagation). A cancelled trip or a skipped
//     platform makes a cancelled passage;
//   - a passage without a trip update is the timetable only ("(théorique)"):
//     Naolib follows its trams and buses once they left their terminus.
// -----------------------------------------------------------------------------

import { fold } from './network.js';
import { wallToInstant } from './time.js';

const HOUR_MS = 3600 * 1000;
// The passages listed: the next three hours; a line silent that long shows
// its first departure of the next 24 hours.
const HORIZON_MS = 3 * HOUR_MS;
const LOOKAHEAD_MS = 24 * HOUR_MS;
// A passage gone this long is dropped (a late one may still come).
const BEHIND_MS = 2 * HOUR_MS;
const MAX_PER_ROUTE = 8;
// An estimate further than this from the timetable belongs to another day.
const MATCH_MS = 2 * HOUR_MS;

/**
 * @description Split a typed direction into the words to look for.
 * @param {string} direction - "Beaujoire | François Mitterrand".
 * @returns {string[]} The folded alternatives.
 * @example
 * directionTerms('Beaujoire | François Mitterrand'); // -> ['beaujoire', 'francois-mitterrand']
 */
function directionTerms(direction) {
  return String(direction ?? '')
    .split('|')
    .map(fold)
    .filter(Boolean);
}

/**
 * @description The instant GTFS times of a service day count from: noon of
 * that day in Paris minus 12 hours (midnight, except on the days the clocks
 * change).
 * @param {string} date - "20261027".
 * @returns {number} The instant (ms).
 */
function serviceStart(date) {
  const wall = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6)),
    12,
  );
  return wallToInstant(wall) - 12 * HOUR_MS;
}

/**
 * @description Index the trip updates by trip id.
 * @param {object|null} feed - decodeFeed() of the trip updates.
 * @returns {Map<string, object>} Trip id -> `{ cancelled, stops: [{ stopId,
 * at, delay, skipped }] }`, `at` in ms, `delay` in seconds (null when not sent).
 */
function indexTripUpdates(feed) {
  const index = new Map();
  for (const update of feed?.tripUpdates ?? []) {
    if (!update.tripId) {
      continue;
    }
    index.set(update.tripId, {
      cancelled: update.cancelled,
      stops: update.stops
        .filter((stop) => !stop.noData)
        .map((stop) => {
          const event = stop.departure?.time ? stop.departure : stop.arrival;
          return {
            stopId: stop.stopId,
            at: Number.isFinite(event?.time) ? event.time * 1000 : null,
            delay: stop.departure?.delay ?? stop.arrival?.delay ?? update.delay ?? null,
            skipped: stop.skipped,
          };
        }),
    });
  }
  return index;
}

/**
 * @description What the real time says of one departure.
 * @param {object|undefined} update - The indexed trip update.
 * @param {string} stopId - The platform.
 * @param {number} scheduled - The timetable (ms).
 * @param {number} now - Now (ms).
 * @returns {{ at: number, realtime: boolean, cancelled: boolean }} The
 * estimate (the timetable when none).
 */
function applyRealtime(update, stopId, scheduled, now) {
  const plain = { at: scheduled, realtime: false, cancelled: false };
  if (!update) {
    return plain;
  }
  if (update.cancelled) {
    // The update speaks of the run of today, not of other days.
    return Math.abs(scheduled - now) <= 12 * HOUR_MS ? { ...plain, cancelled: true } : plain;
  }
  const platform = update.stops.filter((stop) => stop.stopId === stopId);
  // A skipped platform carries no time: the trip of today does not stop there.
  if (
    platform.some((stop) => stop.skipped) &&
    !platform.some((stop) => !stop.skipped && stop.at !== null) &&
    Math.abs(scheduled - now) <= 12 * HOUR_MS
  ) {
    return { ...plain, cancelled: true };
  }
  const own = platform
    .filter((stop) => !stop.skipped)
    .map((stop) => {
      const at = stop.at ?? (stop.delay !== null ? scheduled + stop.delay * 1000 : null);
      return { ...stop, at };
    })
    .filter((stop) => stop.at !== null && Math.abs(stop.at - scheduled) <= MATCH_MS)
    .sort((a, b) => Math.abs(a.at - scheduled) - Math.abs(b.at - scheduled));
  if (own.length > 0) {
    return { at: own[0].at, realtime: true, cancelled: false };
  }
  // No estimate for this platform: the delay of the last one before it.
  const before = update.stops
    .filter((stop) => stop.at !== null && stop.delay !== null && !stop.skipped)
    .map((stop) => ({ ...stop, scheduled: stop.at - stop.delay * 1000 }))
    .filter((stop) => stop.scheduled <= scheduled && scheduled - stop.scheduled <= MATCH_MS)
    .sort((a, b) => b.scheduled - a.scheduled);
  if (before.length > 0) {
    return { at: scheduled + before[0].delay * 1000, realtime: true, cancelled: false };
  }
  return plain;
}

/**
 * @description The passages of a stop, soonest first.
 * @param {object} options - Options.
 * @param {object|null} options.timetable - network.timetable().
 * @param {object} options.stop - The stop (`ids`).
 * @param {Map|null} [options.realtime] - indexTripUpdates().
 * @param {number} options.now - Now (ms).
 * @param {string} [options.lineId] - Only this line.
 * @param {string} [options.direction] - Only the destinations holding these words.
 * @param {Function} [options.lineName] - `(route id) => public name`.
 * @returns {object[]} The passages, cancelled ones included: `{ lineId, line,
 * destination, terminus, at, scheduled, realtime, delay, cancelled,
 * occupancy, trip, platform }`, `trip` the trip id and its service date.
 */
function buildPassages({
  timetable,
  stop,
  realtime = null,
  now,
  lineId = '',
  direction = '',
  lineName = (id) => id,
}) {
  if (!timetable) {
    return [];
  }
  const platforms = new Set(stop.ids);
  const terms = directionTerms(direction);
  const starts = new Map();
  const startOf = (date) => {
    if (!starts.has(date)) {
      starts.set(date, serviceStart(date));
    }
    return starts.get(date);
  };
  const passages = [];
  for (const [tripId, stopId, seconds] of timetable.rows) {
    if (!platforms.has(stopId)) {
      continue;
    }
    const trip = timetable.trips[tripId];
    if (!trip || (lineId && trip[0] !== lineId)) {
      continue;
    }
    const [routeId, serviceId, rawHeadsign] = trip;
    // Some headsigns hold double spaces ("Collège  P. M. France").
    const headsign = String(rawHeadsign ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (terms.length > 0 && !terms.some((term) => fold(headsign).includes(term))) {
      continue;
    }
    for (const date of timetable.services[serviceId] ?? []) {
      const scheduled = startOf(date) + seconds * 1000;
      if (scheduled < now - BEHIND_MS || scheduled > now + LOOKAHEAD_MS + MATCH_MS) {
        continue;
      }
      const estimate = applyRealtime(realtime?.get(tripId), stopId, scheduled, now);
      passages.push({
        lineId: routeId,
        line: String(lineName(routeId) || routeId),
        destination: headsign,
        terminus: headsign,
        at: estimate.at,
        scheduled,
        realtime: estimate.realtime,
        // `|| 0`: never a -0 minute.
        delay: estimate.realtime ? Math.round((estimate.at - scheduled) / 60000) || 0 : 0,
        cancelled: estimate.cancelled,
        occupancy: null,
        trip: `${tripId}@${date}`,
        platform: stopId,
      });
    }
  }
  passages.sort((a, b) => a.at - b.at);
  // The next hours, a few per route; the first departure of a silent route.
  const kept = [];
  const counts = new Map();
  for (const passage of passages) {
    const gone = passage.cancelled ? passage.scheduled < now - 30000 : passage.at < now - 30000;
    if (gone || passage.at > now + LOOKAHEAD_MS) {
      continue;
    }
    const route = routeOf(passage);
    const count = counts.get(route) ?? 0;
    if (count >= MAX_PER_ROUTE || (passage.at > now + HORIZON_MS && count > 0)) {
      continue;
    }
    counts.set(route, count + 1);
    kept.push(passage);
  }
  return kept;
}

/**
 * @description The minutes left before a passage.
 * @param {object} passage - The passage.
 * @param {number} now - Now (ms).
 * @returns {number} Whole minutes (rounded down, like the screens).
 */
function minutesLeft(passage, now) {
  return Math.max(0, Math.floor((passage.at - now) / 60000));
}

/**
 * @description The passages not gone yet, cancelled ones left out.
 * @param {object[]} passages - The passages.
 * @param {number} now - Now (ms).
 * @returns {object[]} The passages to come.
 */
const upcomingPassages = (passages, now) =>
  passages.filter((passage) => !passage.cancelled && passage.at > now - 30000);

/**
 * @description The cancelled passages not gone yet.
 * @param {object[]} passages - The passages.
 * @param {number} now - Now (ms).
 * @returns {object[]} The cancelled passages to come.
 */
const cancelledPassages = (passages, now) =>
  passages.filter((passage) => passage.cancelled && passage.scheduled > now - 30000);

/**
 * @description Who a passage is, across readings: line and destination.
 * @param {object} passage - The passage.
 * @returns {string} "1|beaujoire".
 */
const routeOf = (passage) => `${passage.lineId}|${fold(passage.destination)}`;

export {
  HORIZON_MS,
  LOOKAHEAD_MS,
  directionTerms,
  serviceStart,
  indexTripUpdates,
  applyRealtime,
  buildPassages,
  minutesLeft,
  upcomingPassages,
  cancelledPassages,
  routeOf,
};
