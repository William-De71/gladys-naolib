// -----------------------------------------------------------------------------
// Naolib integration: every handler, registered on a Gladys client.
//
// Brings the trams, busways and buses of Nantes (Naolib, Nantes
// Métropole) into Gladys, through the official open data of Naolib (GTFS
// and GTFS-RT, no key):
//   - devices (device.js): one per followed stop — the three of the form and
//     the ones added with the "Add a stop" button, filtered by line and
//     direction — with the next passage, the waits and the delay; one per
//     followed line — up to six — with its traffic;
//   - scene triggers (events.js): departure soon, departure cancelled, line
//     disrupted, back to normal, new traffic message;
//   - scene actions: read the next passages of a stop, read the traffic of a
//     line;
//   - dashboard widgets (widgets.js): departures, traffic.
//
// The open data have no push: the trip updates of the whole network are read
// in ONE request for every followed stop, on the integration's own timer
// (every 30 s to 5 min, 1 min by default; every 10 min while no stop
// announces anything in the next half hour, at night), the alerts every
// 5 min, never on a Gladys poll. The timetable (GTFS) is kept in /data and
// asked again daily (network.js); the passages come from it, corrected by the
// real time (departures.js). Transport: cloud only.
//
// index.js only creates the SDK client; the tests drive this module with the
// fake Gladys of the SDK (test/app.test.js).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger as sdkLogger } from '@gladysassistant/integration-sdk';
import {
  normalizeConfig,
  readLanguage,
  parseLines,
  INTERNAL_KEYS,
  AUTO_LANGUAGE,
  MAX_ADDED_STOPS,
} from './config.js';
import { createNaolibClient } from './naolib-api.js';
import { createNetwork, fold, byLine, MODES } from './network.js';
import { createStore, DEFAULT_PATH } from './store.js';
import { buildPassages, indexTripUpdates, upcomingPassages, routeOf } from './departures.js';
import { parseTraffic, lineTraffic } from './traffic.js';
import {
  DEVICE_TYPES,
  codeKey,
  stopKey,
  followedName,
  idsOf,
  parseExternalId,
  buildStopDevice,
  buildStopStates,
  buildLineDevice,
  buildLineStates,
} from './device.js';
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
  TRIGGERS,
  NEXT_DEPARTURES_OUTPUTS,
  LINE_TRAFFIC_OUTPUTS,
} from './events.js';
import {
  WIDGETS,
  BOARD_COUNT,
  messageContent,
  readCount,
  buildDeparturesWidget,
  buildTrafficWidget,
} from './widgets.js';
import { defaultTimeZone, newDaySince, MINUTE_MS } from './time.js';
import { t, all, lineStateText, lineLabel, passageWhen, LANGUAGES } from './i18n.js';

const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  SEARCH_STOP: 'search_stop',
  ADD_STOP: 'add_stop',
  REMOVE_STOP: 'remove_stop',
  LIST_STOPS: 'list_stops',
  DIAGNOSTIC: 'diagnostic',
};
const SCENE_ACTIONS = {
  GET_NEXT_DEPARTURES: 'get_next_departures',
  GET_LINE_TRAFFIC: 'get_line_traffic',
};
// While no stop announces anything in QUIET_HORIZON_MS (the night), the stops
// are read this often.
const IDLE_INTERVAL_MS = 10 * MINUTE_MS;
const QUIET_HORIZON_MS = 30 * MINUTE_MS;
const TRAFFIC_INTERVAL_MS = 5 * MINUTE_MS;
const REMINDER_TICK_MS = 30 * 1000;
// A widget or a scene action reuses a reading this fresh.
const SNAPSHOT_MAX_AGE_MS = 90 * 1000;
const BOARD_MAX_AGE_MS = 60 * 1000;
const TRAFFIC_MAX_AGE_MS = 3 * MINUTE_MS;
// A reading of the real time this recent replaces a refused one.
const REALTIME_STANDIN_MS = 3 * MINUTE_MS;
// Names that could not be resolved for a network reason are tried again.
const RESOLVE_RETRY_MS = 5 * MINUTE_MS;
const DIAGNOSTIC_CHUNK = 3000;
const SEARCH_ROUTES_MAX = 12;
const ACTION_TEXT_MAX = 1500;
const { version: VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

/**
 * @description Cut a text of several lines at a line break, under a bound.
 * @param {string} text - The text.
 * @param {number} max - The bound.
 * @returns {string} The whole lines that fit, then "…".
 */
function clipLines(text, max) {
  if (text.length <= max) {
    return text;
  }
  const cut = text.lastIndexOf('\n', max - 2);
  return `${text.slice(0, cut > 0 ? cut : max - 2)}\n…`;
}

/**
 * @description The lines of one stop, for "Find a stop".
 * @param {string[]} names - The names of its lines.
 * @returns {string} "A, B, C1, 12".
 */
function routesText(names) {
  if (names.length === 0) {
    return '–';
  }
  const shown = names.slice(0, SEARCH_ROUTES_MAX);
  return names.length > SEARCH_ROUTES_MAX ? `${shown.join(', ')}, …` : shown.join(', ');
}

/**
 * @description Register every handler of the integration on a Gladys client.
 * @param {object} gladys - A GladysIntegration (or the fake Gladys of the SDK).
 * @param {object} [options] - Options.
 * @param {Function} [options.fetch] - HTTP transport of the open data (tests).
 * @param {string} [options.baseUrl] - The feeds root (tests).
 * @param {string} [options.gtfsRecordUrl] - The record of the GTFS dataset (tests).
 * @param {Function} [options.sleep] - `(ms) => Promise`, the pause before
 * asking a busy feed again (tests).
 * @param {string} [options.storePath] - The file kept in /data (the GTFS zip
 * is kept next to it).
 * @param {Function} [options.now] - `() => number` in ms (tests).
 * @param {string} [options.timeZone] - IANA timezone of the times (TZ by default).
 * @param {boolean} [options.timers] - Arm the reading timers (false in tests).
 * @param {object} [options.logger] - Logger.
 * @returns {object} Handles for the tests.
 */
function createApp(
  gladys,
  {
    fetch: fetchFn,
    baseUrl,
    gtfsRecordUrl,
    sleep,
    storePath = DEFAULT_PATH,
    now = () => Date.now(),
    timeZone = defaultTimeZone(),
    timers = true,
    logger = sdkLogger,
  } = {},
) {
  let config = normalizeConfig();
  // The raw values last read, internal keys included: the base of setConfig.
  let rawConfig = {};
  // The stops added with the buttons, one change at a time.
  let writingStops = Promise.resolve();
  // Language of the last widget request: the fallback of the texts Gladys does
  // not ask for in a language, when the `language` setting is `auto`. French
  // until a widget is shown: the network serves Nantes.
  let language = 'fr';
  let createdDevices = new Set();
  // The followed stops and lines, resolved, and what Naolib does not know.
  let stops = [];
  // config.stops[i] -> its followed stop (null when unknown), for
  // "List the stops".
  let entries = [];
  let lines = [];
  let notFound = [];
  // stop key -> { passages, readAt } of its last reading; the last error of
  // the reading of the stops.
  const snapshots = new Map();
  // The last trip updates of the network, indexed by trip.
  let realtime = { index: null, readAt: 0 };
  let stopsError = null;
  let stopsReadAt = 0;
  // The last reading of the traffic.
  let traffic = { data: null, readAt: 0, error: null };
  let trafficPending = null;
  // typed stop -> { passages, readAt }, for the widgets of other stops.
  const boards = new Map();
  let resolveError = null;
  let lastStatus = null;
  let lastDiscovery = null;
  let stopTimer = null;
  let trafficTimer = null;
  let reminderTimer = null;
  let resolveTimer = null;
  let readingStops = null;
  let stopped = false;

  const api = createNaolibClient({
    now,
    ...(fetchFn ? { fetch: fetchFn } : {}),
    ...(baseUrl ? { feedsUrl: baseUrl } : {}),
    ...(gtfsRecordUrl ? { gtfsRecordUrl } : {}),
    ...(sleep ? { sleep } : {}),
  });
  const store = createStore({ path: storePath, logger });
  const network = createNetwork({
    api,
    store,
    zipPath: join(dirname(storePath), 'naolib-gtfs.zip'),
    now,
    isNewDay: (since) => newDaySince(since, now(), timeZone),
    logger,
  });

  /**
   * @description Remember the language of a request, and store it when it changed.
   * @param {string} next - The language.
   */
  function rememberLanguage(next) {
    if (typeof next !== 'string' || !/^[a-z]{2}$/.test(next) || next === language) {
      return;
    }
    language = next;
    gladys
      .setConfig({ [INTERNAL_KEYS.language]: next })
      .catch((err) => logger.warn(`Unable to store the language: ${err.message}`));
  }

  /**
   * @description Language of the texts Gladys does not ask for in a language.
   * @returns {string} The language.
   */
  const textLanguage = () => (config.language === AUTO_LANGUAGE ? language : config.language);

  /**
   * @description The message of an error, for a user.
   * @param {Error} err - The error.
   * @param {string} lang - The language.
   * @returns {string} The message.
   */
  function errorText(err, lang) {
    return t(err?.kind === 'busy' ? 'errorBusy' : 'errorUnreachable', lang);
  }

  /**
   * @description The public name of a line, by route id.
   * @param {string} id - The route id.
   * @returns {string} Its name, the id when unknown.
   */
  const lineName = (id) => network.peekLine(id)?.name ?? String(id);

  /**
   * @description Report the connection status, only when it changed.
   * @param {boolean} connected - Connected or not.
   * @param {object} message - The multi-language message.
   * @returns {Promise<void>}
   */
  async function reportStatus(connected, message) {
    const signature = JSON.stringify([connected, message]);
    if (signature === lastStatus) {
      return;
    }
    lastStatus = signature;
    try {
      await gladys.setConnectionStatus(connected, message);
    } catch (err) {
      lastStatus = null;
      logger.error('Unable to report the connection status', err);
    }
  }

  /**
   * @description Work out the connection status from the last readings.
   * @returns {Promise<void>}
   */
  async function refreshStatus() {
    const failing = (stops.length && stopsError ? 1 : 0) + (traffic.error ? 1 : 0);
    if (resolveError || failing >= (stops.length ? 2 : 1)) {
      const err = resolveError ?? traffic.error ?? stopsError;
      await reportStatus(
        false,
        all('statusUnreachable', {
          detail: String(err?.message ?? '').slice(0, 80),
          minutes: Math.round(Math.max(config.interval * 1000, MINUTE_MS) / MINUTE_MS),
        }),
      );
      return;
    }
    const unknown = notFound.length
      ? (l) => ` ${t('statusNotFound', l, { names: notFound.join(', ') })}`
      : () => '';
    if (stops.length + lines.length === 0) {
      await reportStatus(
        true,
        Object.fromEntries(LANGUAGES.map((l) => [l, `${t('statusNothing', l)}${unknown(l)}`])),
      );
      return;
    }
    const { interval } = config;
    await reportStatus(
      true,
      Object.fromEntries(
        LANGUAGES.map((l) => [
          l,
          `${t('statusConnected', l, { stops: stops.length, lines: lines.length, interval })}${unknown(l)}`,
        ]),
      ),
    );
  }

  /**
   * @description Refresh the list of the devices the user created.
   * @returns {Promise<void>}
   */
  async function refreshCreatedDevices() {
    try {
      const devices = await gladys.getDevices();
      createdDevices = new Set(devices.map((device) => device.external_id));
    } catch (err) {
      logger.warn(`Unable to read the devices: ${err.message}`);
    }
  }

  /**
   * @description Ask the open widgets to pull their content again.
   * @param {string[]} keys - The widget keys.
   */
  function refreshWidgets(keys) {
    for (const key of keys) {
      Promise.resolve(gladys.requestWidgetRefresh(key)).catch(() => {});
    }
  }

  /**
   * @description Publish scene events, one by one.
   * @param {Array<{ key: string, data: object }>} events - The events.
   * @returns {Promise<void>}
   */
  async function publishEvents(events) {
    for (const { key, data } of events) {
      logger.info(`${data.stop_name ?? data.line_name}: ${key}`);
      try {
        await gladys.publishSceneEvent(key, data);
      } catch (err) {
        logger.warn(`Unable to fire ${key}: ${err.message}`);
      }
    }
  }

  // --- Stops and lines ---------------------------------------------------------------

  /**
   * @description Resolve one stop of the configuration.
   * @param {object} entry - `{ slot, added, stop, line, direction }`.
   * @returns {Promise<object>} The followed stop, or `{ unknown }`: the typed
   * stop or line Naolib does not know (or a name of several stops).
   */
  async function resolveEntry(entry) {
    const line = entry.line ? await network.resolveLine(entry.line) : null;
    if (entry.line && !line) {
      return { unknown: entry.line };
    }
    const stop = await network.resolveStop(entry.stop);
    if (!stop) {
      return { unknown: entry.stop };
    }
    const key = stopKey(stop, line, entry.direction);
    const followed = {
      slot: entry.slot,
      added: entry.added ?? null,
      stop,
      line,
      direction: entry.direction,
      key,
    };
    return {
      ...followed,
      name: followedName(followed),
      deviceId: idsOf(gladys, DEVICE_TYPES.STOP, key).device,
    };
  }

  /**
   * @description Resolve the configured stops and lines.
   * @returns {Promise<void>}
   */
  async function resolveConfig() {
    clearTimeout(resolveTimer);
    const resolvedStops = [];
    const resolvedEntries = [];
    const resolvedLines = [];
    const unknown = [];
    try {
      for (const entry of config.stops) {
        const followed = await resolveEntry(entry);
        if (followed.unknown) {
          unknown.push(followed.unknown);
          resolvedEntries.push(null);
          continue;
        }
        const known = resolvedStops.find((other) => other.key === followed.key);
        if (!known) {
          resolvedStops.push(followed);
        }
        resolvedEntries.push(known ?? followed);
      }
      for (const typed of config.lines) {
        const line = await network.resolveLine(typed);
        if (!line) {
          unknown.push(typed);
        } else if (!resolvedLines.some((known) => known.id === line.id)) {
          resolvedLines.push({
            ...line,
            deviceId: idsOf(gladys, DEVICE_TYPES.LINE, line.id).device,
          });
        }
      }
      resolveError = null;
    } catch (err) {
      // Keep what was resolved before; try again later.
      logger.warn(`Unable to read the networks (${err.kind ?? 'error'}): ${err.message}`);
      resolveError = err;
      if (timers && !stopped) {
        resolveTimer = setTimeout(() => {
          applyConfig().catch(() => {});
        }, RESOLVE_RETRY_MS);
        resolveTimer.unref?.();
      }
      return;
    }
    stops = resolvedStops;
    entries = resolvedEntries;
    lines = resolvedLines;
    notFound = unknown;
    for (const key of [...snapshots.keys()]) {
      if (!stops.some((followed) => followed.key === key)) {
        snapshots.delete(key);
      }
    }
  }

  /**
   * @description Offer a device per stop and per line on the Discovery screen,
   * when they changed.
   * @param {boolean} [force] - Publish even when unchanged.
   * @returns {Promise<number>} How many devices were offered.
   */
  async function publishDiscoveredDevices(force = false) {
    const lang = textLanguage();
    const devices = [
      ...stops.map((followed) => buildStopDevice(gladys, followed, lang)),
      ...lines.map((line) => buildLineDevice(gladys, line, lang)),
    ];
    const signature = JSON.stringify(devices);
    if (force || signature !== lastDiscovery) {
      await gladys.publishDiscoveredDevices(devices);
      lastDiscovery = signature;
    }
    return devices.length;
  }

  // --- Reading the stops -------------------------------------------------------------

  /**
   * @description Publish the states of a stop, when its device exists.
   * @param {object} followed - The followed stop.
   * @returns {Promise<void>}
   */
  async function publishStopStates(followed) {
    const snapshot = snapshots.get(followed.key);
    if (!snapshot || !createdDevices.has(followed.deviceId)) {
      return;
    }
    await gladys
      .publishChangedStates(
        buildStopStates(gladys, followed, snapshot.passages, {
          language: textLanguage(),
          now: now(),
          timeZone,
        }),
      )
      .catch((err) =>
        logger.warn(`Unable to publish the states of ${followed.name}: ${err.message}`),
      );
  }

  /**
   * @description The reminders due on the last reading of a stop.
   * @param {object} followed - The followed stop.
   * @returns {object[]} The events.
   */
  function reminderEvents(followed) {
    const snapshot = snapshots.get(followed.key);
    if (!snapshot) {
      return [];
    }
    const { due, fired } = detectReminders({
      passages: snapshot.passages,
      fired: store.data.seen.reminders[followed.key],
      now: now(),
    });
    store.data.seen.reminders[followed.key] = fired;
    return due.map(({ passage, mark }) => ({
      key: TRIGGERS.DEPARTURE_SOON,
      data: reminderData(followed, passage, mark, { language: textLanguage(), timeZone }),
    }));
  }

  /**
   * @description The cancellations not reported yet on the last reading of a stop.
   * @param {object} followed - The followed stop.
   * @returns {object[]} The events.
   */
  function cancellationEvents(followed) {
    const snapshot = snapshots.get(followed.key);
    if (!snapshot) {
      return [];
    }
    store.data.seen.cancelled ??= {};
    const { due, known } = detectCancellations({
      passages: snapshot.passages,
      known: store.data.seen.cancelled[followed.key],
      now: now(),
    });
    store.data.seen.cancelled[followed.key] = known;
    return due.map((passage) => ({
      key: TRIGGERS.DEPARTURE_CANCELLED,
      data: cancelledData(followed, passage, { language: textLanguage(), timeZone }),
    }));
  }

  /**
   * @description The passages of a followed (or typed) stop.
   * @param {object} followed - `{ stop, line, direction }`.
   * @param {object|null} timetable - network.timetable().
   * @param {Map|null} index - The trip updates (none: the timetable only).
   * @returns {object[]} Its passages.
   */
  function passagesOf({ stop, line, direction = '' }, timetable, index) {
    return buildPassages({
      timetable,
      stop,
      realtime: index,
      now: now(),
      lineId: line?.id ?? '',
      direction,
      lineName,
    });
  }

  /**
   * @description Read the trip updates of the whole network.
   * @returns {Promise<Map>} Their index.
   */
  async function readRealtime() {
    const feed = await api.tripUpdates();
    realtime = { index: indexTripUpdates(feed), readAt: now() };
    return realtime.index;
  }

  /**
   * @description What follows a reading of a stop: events, states.
   * @param {object} followed - The followed stop.
   * @returns {Promise<void>}
   */
  async function digestStop(followed) {
    const events =
      gladys.connected !== false
        ? [...cancellationEvents(followed), ...reminderEvents(followed)]
        : [];
    await store.save();
    await publishEvents(events);
    await publishStopStates(followed);
  }

  /**
   * @description Read some followed stops now: their timetable, and the trip
   * updates of the network in one request. Without the real time, the
   * passages are the timetable only; the error is thrown once they are set.
   * Without a timetable, the stops keep their last reading.
   * @param {object[]} list - The followed stops.
   * @returns {Promise<void>}
   */
  async function readFollowed(list) {
    let failure = null;
    let timetable = null;
    try {
      timetable = await network.timetable(list.map((followed) => followed.stop));
    } catch (err) {
      failure = err;
    }
    let index = null;
    try {
      index = await readRealtime();
    } catch (err) {
      // The source answers once per 30 seconds: a recent reading stands in
      // for a refused one.
      if (realtime.index && now() - realtime.readAt <= REALTIME_STANDIN_MS) {
        index = realtime.index;
        logger.debug?.(`Naolib real time not read (${err.kind ?? 'error'}): the last one is used`);
      } else {
        failure ??= err;
      }
    }
    stopsError = failure;
    if (!timetable) {
      throw failure ?? new Error('no timetable');
    }
    const readAt = now();
    for (const followed of list) {
      snapshots.set(followed.key, { passages: passagesOf(followed, timetable, index), readAt });
    }
    stopsReadAt = readAt;
    for (const followed of list) {
      await digestStop(followed);
    }
    if (failure) {
      throw failure;
    }
  }

  /**
   * @description Whether the stops are due for a reading.
   * @returns {boolean} True when due.
   */
  function stopsDue() {
    if (stopsError || stops.some((followed) => !snapshots.has(followed.key))) {
      return true;
    }
    const age = now() - stopsReadAt;
    // At night no stop announces anything soon: read them less often.
    const quiet = stops.every((followed) =>
      upcomingPassages(snapshots.get(followed.key).passages, now()).every(
        (passage) => passage.at - now() > QUIET_HORIZON_MS,
      ),
    );
    return age >= (quiet ? IDLE_INTERVAL_MS : config.interval * 1000) - 1000;
  }

  /**
   * @description Read every followed stop when due (one reading at a time).
   * @param {object} [options] - `{ force }`: read even when not due.
   * @returns {Promise<void>}
   */
  function readStops({ force = false } = {}) {
    if (!readingStops) {
      readingStops = (async () => {
        if (stops.length > 0 && (force || stopsDue())) {
          try {
            await readFollowed(stops);
            refreshWidgets([WIDGETS.DEPARTURES]);
          } catch (err) {
            logger.warn(`Naolib stops (${err.kind ?? 'error'}): ${err.message}`);
          }
        }
        await refreshStatus();
      })().finally(() => {
        readingStops = null;
      });
    }
    return readingStops;
  }

  /**
   * @description The snapshots of followed stops, read again (together) when
   * older than `maxAgeMs`.
   * @param {object[]} list - The followed stops.
   * @param {number} maxAgeMs - The freshness wanted.
   * @returns {Promise<object[]>} Their snapshots, in the same order.
   */
  async function snapshotsOf(list, maxAgeMs) {
    const stale = list.filter((followed) => {
      const snapshot = snapshots.get(followed.key);
      return !snapshot || now() - snapshot.readAt > maxAgeMs;
    });
    if (stale.length > 0) {
      await readFollowed(stale);
    }
    return list.map((followed) => snapshots.get(followed.key));
  }

  /**
   * @description Check the reminders on the last readings (between readings).
   * @returns {Promise<void>}
   */
  async function checkReminders() {
    // Disconnected, the event would be lost while marked as fired.
    if (gladys.connected === false) {
      return;
    }
    const events = stops.flatMap((followed) => [
      ...cancellationEvents(followed),
      ...reminderEvents(followed),
    ]);
    if (events.length) {
      await store.save();
      await publishEvents(events);
    }
  }

  // --- Reading the traffic -----------------------------------------------------------

  /**
   * @description Publish what a traffic reading changed: events of the
   * followed lines, states of the line devices.
   * @returns {Promise<void>}
   */
  async function digestTraffic() {
    const current = now();
    if (gladys.connected !== false) {
      const lineChanges = detectLineChanges({
        lines,
        traffic: traffic.data,
        seen: store.data.seen.lines,
        now: current,
      });
      store.data.seen.lines = lineChanges.seen;
      await store.save();
      await publishEvents(
        lineChanges.changes.map((change) =>
          lineEvent(change, { language: textLanguage(), timeZone }),
        ),
      );
    }
    const states = lines
      .filter((line) => createdDevices.has(line.deviceId))
      .flatMap((line) =>
        buildLineStates(gladys, line, lineTraffic(traffic.data, line.id, current), textLanguage()),
      );
    if (states.length > 0) {
      await gladys
        .publishChangedStates(states)
        .catch((err) => logger.warn(`Unable to publish the traffic states: ${err.message}`));
    }
    refreshWidgets([WIDGETS.TRAFFIC]);
  }

  /**
   * @description Read the traffic now (one reading at a time).
   * @returns {Promise<object>} `{ data, readAt }`.
   */
  function readTrafficNow() {
    if (!trafficPending) {
      trafficPending = (async () => {
        try {
          const feed = await api.alerts();
          traffic = {
            data: parseTraffic(feed, { linesOfPlatform: network.linesOfPlatform }),
            readAt: now(),
            error: null,
          };
          await digestTraffic();
          return traffic;
        } catch (err) {
          traffic = { ...traffic, error: err };
          throw err;
        } finally {
          trafficPending = null;
        }
      })();
    }
    return trafficPending;
  }

  /**
   * @description The traffic, read again when older than `maxAgeMs`.
   * @param {number} maxAgeMs - The freshness wanted.
   * @returns {Promise<object>} `{ data, readAt }`.
   */
  async function trafficOf(maxAgeMs) {
    if (traffic.data && now() - traffic.readAt <= maxAgeMs) {
      return traffic;
    }
    return readTrafficNow();
  }

  /**
   * @description The regular reading of the traffic: always, the traffic
   * widget shows the trams without a followed line.
   * @returns {Promise<void>}
   */
  async function trafficTick() {
    await readTrafficNow().catch((err) =>
      logger.warn(`Naolib traffic (${err.kind ?? 'error'}): ${err.message}`),
    );
    await refreshStatus();
  }

  // --- Timers ------------------------------------------------------------------------

  /**
   * @description (Re)arm the timers.
   */
  function schedule() {
    clearInterval(stopTimer);
    clearInterval(trafficTimer);
    clearInterval(reminderTimer);
    if (!timers || stopped) {
      return;
    }
    // A short tick: stopsDue() decides whether the stops are due.
    stopTimer = setInterval(
      () => {
        readStops().catch((err) => logger.error('Stops', err));
      },
      Math.min(config.interval * 1000, 30000),
    );
    trafficTimer = setInterval(() => {
      trafficTick().catch((err) => logger.error('Traffic', err));
    }, TRAFFIC_INTERVAL_MS);
    reminderTimer = setInterval(() => {
      checkReminders().catch((err) => logger.warn(`Reminders: ${err.message}`));
    }, REMINDER_TICK_MS);
    [stopTimer, trafficTimer, reminderTimer].forEach((timer) => timer.unref?.());
  }

  /**
   * @description Resolve the configuration, offer the devices, read everything.
   * @returns {Promise<void>}
   */
  async function applyConfig() {
    await resolveConfig();
    logger.info(
      `${stops.length} stop(s): ${stops.map((followed) => followed.name).join(', ') || 'none'}; ` +
        `${lines.length} line(s): ${lines.map((line) => line.name).join(', ') || 'none'}` +
        (notFound.length ? `; unknown: ${notFound.join(', ')}` : ''),
    );
    await publishDiscoveredDevices().catch((err) =>
      logger.warn(`Unable to offer the devices: ${err.message}`),
    );
    await readStops({ force: true });
    await trafficTick();
    await refreshStatus();
    schedule();
  }

  // --- Dashboard widgets -------------------------------------------------------------

  /**
   * @description What a widget or a scene action targets, by device external id.
   * @param {unknown} externalId - The `source: "devices"` value.
   * @param {string} type - DEVICE_TYPES.
   * @returns {object|null} The followed stop or line, the first one by default.
   */
  function target(externalId, type) {
    const parsed = parseExternalId(externalId);
    const list = type === DEVICE_TYPES.STOP ? stops : lines;
    const keyOf = (item) => (type === DEVICE_TYPES.STOP ? item.key : codeKey(item.id));
    const found = parsed?.type === type ? list.find((item) => keyOf(item) === parsed.key) : null;
    return found ?? list[0] ?? null;
  }

  /**
   * @description The passages of a stop typed in a widget.
   * @param {string} typed - The stop.
   * @param {string} typedLine - Its optional line.
   * @param {string} lang - The language.
   * @returns {Promise<object>} `{ title, passages, readAt }` or `{ message }`.
   */
  async function typedBoard(typed, typedLine, lang) {
    const line = typedLine ? await network.resolveLine(typedLine) : null;
    if (typedLine && !line) {
      return { message: t('statusNotFound', lang, { names: typedLine.slice(0, 60) }) };
    }
    const stop = await network.resolveStop(typed);
    if (!stop) {
      return { message: t('statusNotFound', lang, { names: typed.slice(0, 60) }) };
    }
    const key = stopKey(stop, line, '');
    let board = boards.get(key);
    if (!board || now() - board.readAt > BOARD_MAX_AGE_MS) {
      const timetable = await network.timetable([stop]);
      let { index } = realtime;
      if (!index || now() - realtime.readAt > BOARD_MAX_AGE_MS) {
        index = await readRealtime().catch(() => realtime.index);
      }
      board = { readAt: now(), passages: passagesOf({ stop, line }, timetable, index) };
      boards.set(key, board);
    }
    const title = followedName({ stop, line, direction: '' });
    return { title, ...board };
  }

  /**
   * @description The followed stops chosen in the `stops` setting of a widget,
   * grouped by stop: devices of one stop (one per line and direction) make
   * one board, their routes merged.
   * @param {unknown} raw - The `multi_select` value: device external ids.
   * @returns {Promise<object[]>} `[{ title, label, passages, readAt }]`,
   * in the order chosen; empty when no chosen device is followed any more.
   */
  async function followedBoards(raw) {
    const ids = Array.isArray(raw) ? raw : [];
    const groups = new Map();
    for (const id of ids) {
      const parsed = parseExternalId(id);
      const followed =
        parsed?.type === DEVICE_TYPES.STOP ? stops.find((item) => item.key === parsed.key) : null;
      if (!followed) {
        continue;
      }
      const group = followed.stop.code;
      const members = groups.get(group) ?? [];
      if (!members.includes(followed)) {
        groups.set(group, [...members, followed]);
      }
    }
    // Every chosen device in one reading when they need a new one.
    await snapshotsOf([...groups.values()].flat(), SNAPSHOT_MAX_AGE_MS);
    const result = [];
    for (const members of groups.values()) {
      const read = members.map((followed) => snapshots.get(followed.key));
      // A route of two chosen devices (all the lines and one of them) once.
      const passages = new Map();
      for (const passage of read.flatMap((snapshot) => snapshot.passages)) {
        passages.set(`${routeOf(passage)}|${passage.at}`, passage);
      }
      const [first] = members;
      result.push({
        title: members.length > 1 ? followedName({ stop: first.stop }) : first.name,
        label: first.stop.name,
        passages: [...passages.values()].sort((a, b) => a.at - b.at),
        readAt: Math.min(...read.map((snapshot) => snapshot.readAt)),
      });
    }
    return result;
  }

  gladys.onWidgetGet(WIDGETS.DEPARTURES, async ({ settings = {}, language: lang }) => {
    rememberLanguage(lang);
    const count = readCount(settings.count, BOARD_COUNT);
    const typed = typeof settings.stop_name === 'string' ? settings.stop_name.trim() : '';
    const typedLine = typeof settings.line === 'string' ? settings.line.trim() : '';
    try {
      let board;
      if (typed) {
        board = await typedBoard(typed, typedLine, lang);
        if (board.message) {
          return messageContent(board.message);
        }
      } else {
        const several = await followedBoards(settings.stops);
        if (several.length > 1) {
          board = { boards: several };
        } else if (several.length === 1) {
          board = several[0];
        } else {
          const followed = target(settings.stop, DEVICE_TYPES.STOP);
          if (!followed) {
            return messageContent(t('widgetNoStop', lang));
          }
          const [snapshot] = await snapshotsOf([followed], SNAPSHOT_MAX_AGE_MS);
          board = { title: followed.name, ...snapshot };
        }
      }
      return buildDeparturesWidget({ ...board, count, language: lang, now: now(), timeZone });
    } catch (err) {
      logger.warn(`Widget: unable to read the passages: ${err.message}`);
      return messageContent(errorText(err, lang), 60);
    }
  });

  gladys.onWidgetGet(WIDGETS.TRAFFIC, async ({ settings = {}, language: lang }) => {
    rememberLanguage(lang);
    try {
      let wanted = lines;
      const typed = parseLines(settings.lines);
      if (typed.length > 0) {
        wanted = [];
        for (const entry of typed) {
          const line = await network.resolveLine(entry);
          if (!line) {
            return messageContent(t('statusNotFound', lang, { names: entry.slice(0, 60) }));
          }
          wanted.push(line);
        }
      }
      if (wanted.length === 0) {
        // Nothing followed nor typed: the trams.
        wanted = (await network.lines()).filter((line) => line.mode === MODES.TRAM);
      }
      const current = await trafficOf(TRAFFIC_MAX_AGE_MS);
      return buildTrafficWidget({
        lines: wanted.map((line) => ({
          line,
          traffic: lineTraffic(current.data, line.id, now()),
        })),
        readAt: current.readAt,
        language: lang,
        now: now(),
        timeZone,
      });
    } catch (err) {
      logger.warn(`Widget: unable to read the traffic: ${err.message}`);
      return messageContent(errorText(err, lang), 60);
    }
  });

  // --- Scene actions -----------------------------------------------------------------
  gladys.onSceneAction(SCENE_ACTIONS.GET_NEXT_DEPARTURES, async (fields = {}) => {
    const followed = target(fields.stop, DEVICE_TYPES.STOP);
    if (!followed) {
      throw new Error('No Naolib stop is followed');
    }
    const [snapshot] = await snapshotsOf([followed], SNAPSHOT_MAX_AGE_MS);
    return pick(
      nextDeparturesOutputs({
        followed,
        passages: snapshot.passages,
        now: now(),
        language: textLanguage(),
        timeZone,
      }),
      NEXT_DEPARTURES_OUTPUTS,
    );
  });

  gladys.onSceneAction(SCENE_ACTIONS.GET_LINE_TRAFFIC, async (fields = {}) => {
    const line = target(fields.line, DEVICE_TYPES.LINE);
    if (!line) {
      throw new Error('No Naolib line is followed');
    }
    const current = await trafficOf(SNAPSHOT_MAX_AGE_MS);
    return pick(
      lineTrafficOutputs({
        line,
        traffic: lineTraffic(current.data, line.id, now()),
        language: textLanguage(),
      }),
      LINE_TRAFFIC_OUTPUTS,
    );
  });

  // --- Configuration screen actions --------------------------------------------------
  gladys.onAction(ACTIONS.TEST_CONNECTION, async () => {
    const messages = [];
    try {
      const [known, knownStops] = await Promise.all([network.lines(true), network.stops(true)]);
      messages.push(all('testNetworkOk', { lines: known.length, stops: knownStops.length }));
    } catch (err) {
      resolveError = err;
      await refreshStatus();
      return all('testTrafficError', (l) => ({ error: errorText(err, l) }));
    }
    await resolveConfig();
    await publishDiscoveredDevices().catch(() => {});
    let stopsFailure = null;
    if (stops.length > 0) {
      try {
        await readFollowed(stops);
      } catch (err) {
        stopsFailure = err;
      }
    }
    for (const followed of stops) {
      const snapshot = snapshots.get(followed.key);
      if (!snapshot || (stopsFailure && now() - snapshot.readAt > SNAPSHOT_MAX_AGE_MS)) {
        messages.push(
          all('testStopError', (l) => ({ stop: followed.name, error: errorText(stopsFailure, l) })),
        );
        continue;
      }
      const [first] = upcomingPassages(snapshot.passages, now());
      messages.push(
        all('testStop', (l) => ({
          stop: followed.name,
          count: snapshot.passages.length,
          next: first
            ? `${first.line} ${passageWhen(first, { language: l, now: now(), timeZone })}`
            : '–',
        })),
      );
    }
    try {
      const current = await readTrafficNow();
      lines.forEach((line) => {
        const { state } = lineTraffic(current.data, line.id, now());
        messages.push(
          all('testLine', (l) => ({ line: lineLabel(line, l), state: lineStateText(state, l) })),
        );
      });
    } catch (err) {
      messages.push(all('testTrafficError', (l) => ({ error: errorText(err, l) })));
    }
    notFound.forEach((name) => messages.push(all('unknownEntry', { name })));
    refreshWidgets(Object.values(WIDGETS));
    await refreshStatus();
    return Object.fromEntries(
      LANGUAGES.map((l) => [
        l,
        messages
          .map((entry) => entry[l])
          .join(' · ')
          .slice(0, 1000),
      ]),
    );
  });

  gladys.onAction(ACTIONS.SEARCH_STOP, async (fields = {}) => {
    const query = typeof fields.query === 'string' ? fields.query.trim() : '';
    if (query.length < 2) {
      return all('searchTooShort');
    }
    const found = await network.searchStops(query);
    if (found.length === 0) {
      return all('searchNone', { query: query.slice(0, 60) });
    }
    const blocks = found.map((stop) => {
      const names = stop.lines
        .map((id) => network.peekLine(id))
        .filter(Boolean)
        .sort(byLine)
        .map((line) => line.name);
      // The code ("poitou-2") is what tells two places of one name apart.
      return `• ${stop.name} [${stop.code}] → ${routesText(names)}`;
    });
    return all('searchFound', { list: clipLines(blocks.join('\n'), ACTION_TEXT_MAX - 300) });
  });

  // --- Stops added with the buttons -------------------------------------------------

  const field = (value) => (typeof value === 'string' ? value.trim() : '');

  /**
   * @description Change the added stops, one change after the other: two quick
   * buttons never lose a stop. Applied in memory once Gladys saved it.
   * @param {Function} change - `(added) => Promise<{ next?, message }>`: the new
   * list (none: nothing to save) and the answer, or a function of nothing
   * giving it once the stops are read.
   * @returns {Promise<object>} The answer.
   */
  function changeAddedStops(change) {
    const run = writingStops.then(async () => {
      const { next, message } = await change(config.addedStops);
      if (next) {
        await gladys.setConfig({ [INTERNAL_KEYS.addedStops]: next });
        rawConfig = { ...rawConfig, [INTERNAL_KEYS.addedStops]: next };
        config = normalizeConfig(rawConfig);
        await resolveConfig();
        await publishDiscoveredDevices().catch((err) =>
          logger.warn(`Unable to offer the devices: ${err.message}`),
        );
        // Only the new stop is due: it has no reading yet.
        await readStops();
      }
      return typeof message === 'function' ? message() : message;
    });
    writingStops = run.catch(() => {});
    return run;
  }

  /**
   * @description How a stop of the configuration reads in "List the stops".
   * @param {object} entry - A stop of `config.stops`.
   * @param {number} index - Its position.
   * @param {string} lang - The language.
   * @returns {string} "2. République (C1) (formulaire, arrêt 2)".
   */
  function entryText(entry, index, lang) {
    const followed = entries[index];
    const typed = [entry.stop, entry.line, entry.direction && `→ ${entry.direction}`]
      .filter(Boolean)
      .join(' ');
    const notes = [
      entry.slot ? t('stopFromForm', lang, { slot: entry.slot }) : '',
      entries.length && !followed ? t('stopUnknownMark', lang) : '',
    ].filter(Boolean);
    const name = followed?.name ?? typed;
    return `${index + 1}. ${name}${notes.length ? ` (${notes.join(', ')})` : ''}`;
  }

  gladys.onAction(ACTIONS.ADD_STOP, async (fields = {}) => {
    const entry = {
      stop: field(fields.stop),
      line: field(fields.line),
      direction: field(fields.direction),
    };
    if (entry.stop.length < 2) {
      return all('searchTooShort');
    }
    return changeAddedStops(async (added) => {
      if (added.length >= MAX_ADDED_STOPS) {
        return { message: all('stopsFull', { max: MAX_ADDED_STOPS }) };
      }
      let followed;
      try {
        followed = await resolveEntry(entry);
      } catch (err) {
        return { message: all('testTrafficError', (l) => ({ error: errorText(err, l) })) };
      }
      if (followed.unknown) {
        return { message: all('statusNotFound', { names: followed.unknown.slice(0, 60) }) };
      }
      if (stops.some((other) => other.key === followed.key)) {
        return { message: all('stopAlreadyFollowed', { name: followed.name }) };
      }
      // Stored as resolved: the codes of the stop and of the line.
      const stored = {
        stop: followed.stop.code,
        line: followed.line?.id ?? '',
        direction: entry.direction,
      };
      logger.info(`Stop added: ${followed.name}`);
      return {
        next: [...added, stored],
        message: () => all('stopAdded', { name: followed.name, count: stops.length }),
      };
    });
  });

  gladys.onAction(ACTIONS.REMOVE_STOP, async (fields = {}) => {
    const query = field(fields.stop);
    if (!query) {
      return all('stopRemoveUnknown', { query });
    }
    return changeAddedStops(async (added) => {
      const number =
        /^#?\d+$/.test(query) && query.length <= 3 ? Number(query.replace('#', '')) : null;
      let found;
      if (number !== null) {
        found = config.stops[number - 1] ? [number - 1] : [];
      } else {
        const wanted = fold(query);
        found = config.stops
          .map((entry, index) => ({ entry, index, followed: entries[index] }))
          .filter(
            ({ entry, followed }) =>
              fold(entry.stop) === wanted ||
              (followed && (fold(followed.name) === wanted || fold(followed.stop.name) === wanted)),
          )
          .map(({ index }) => index);
        // The same name in the form and in the added stops: the added one.
        const fromButtons = found.filter((index) => !config.stops[index].slot);
        found = fromButtons.length > 0 ? fromButtons : found;
      }
      if (found.length === 0) {
        return { message: all('stopRemoveUnknown', { query: query.slice(0, 60) }) };
      }
      if (found.length > 1) {
        return { message: all('stopRemoveAmbiguous', { query: query.slice(0, 60) }) };
      }
      const entry = config.stops[found[0]];
      const name = entries[found[0]]?.name ?? entry.stop;
      if (entry.slot) {
        return { message: all('stopInForm', { name, slot: entry.slot }) };
      }
      logger.info(`Stop removed: ${name}`);
      return {
        next: added.filter((_, index) => index !== entry.added - 1),
        message: all('stopRemoved', { name }),
      };
    });
  });

  gladys.onAction(ACTIONS.LIST_STOPS, async () => {
    if (config.stops.length === 0) {
      return all('stopsNone');
    }
    return all('stopsList', (l) => ({
      count: config.stops.length,
      list: clipLines(
        config.stops.map((entry, index) => entryText(entry, index, l)).join('\n'),
        ACTION_TEXT_MAX - 100,
      ),
    }));
  });

  gladys.onAction(ACTIONS.DIAGNOSTIC, async () => {
    const report = {
      version: VERSION,
      timeZone: timeZone ?? null,
      interval: config.interval,
      language: config.language,
      stops: stops.map((followed) => {
        const snapshot = snapshots.get(followed.key);
        return {
          slot: followed.slot,
          added: followed.added,
          key: followed.key,
          stop: followed.stop,
          line: followed.line?.id ?? null,
          direction: followed.direction,
          created: createdDevices.has(followed.deviceId),
          readAt: snapshot ? new Date(snapshot.readAt).toISOString() : null,
          passages: snapshot?.passages
            .slice(0, 6)
            .map(
              (p) =>
                `${p.line}>${p.destination} ${new Date(p.at).toISOString().slice(11, 16)}Z` +
                `${p.cancelled ? ' cancelled' : p.realtime ? ` +${p.delay}` : ' sched'}`,
            ),
        };
      }),
      stopsError: stopsError?.message ?? null,
      lines: lines.map((line) => {
        const current = traffic.data ? lineTraffic(traffic.data, line.id, now()) : null;
        return {
          id: line.id,
          name: line.name,
          mode: line.mode,
          created: createdDevices.has(line.deviceId),
          state: current?.state ?? null,
          messages: current?.messages.length ?? null,
        };
      }),
      notFound,
      traffic: {
        readAt: traffic.readAt ? new Date(traffic.readAt).toISOString() : null,
        messages: traffic.data?.messages.length ?? null,
        error: traffic.error?.message ?? null,
      },
      realtime: {
        readAt: realtime.readAt ? new Date(realtime.readAt).toISOString() : null,
        trips: realtime.index?.size ?? null,
      },
      network: {
        lines: store.data.network.lines?.length ?? null,
        stops: store.data.network.stops?.length ?? null,
        lastModified: store.data.network.lastModified || null,
        checkedAt: store.data.network.checkedAt
          ? new Date(store.data.network.checkedAt).toISOString()
          : null,
        timetable: network.describeTimetable(),
      },
      resolveError: resolveError?.message ?? null,
      requests: api.requests,
    };
    const json = JSON.stringify(report);
    const count = Math.max(1, Math.ceil(json.length / DIAGNOSTIC_CHUNK));
    for (let chunk = 0; chunk < count; chunk += 1) {
      logger.info(
        `Naolib diagnostic ${chunk + 1}/${count}: ${json.slice(chunk * DIAGNOSTIC_CHUNK, (chunk + 1) * DIAGNOSTIC_CHUNK)}`,
      );
    }
    return all('diagnosticDone', { count });
  });

  // --- Devices -----------------------------------------------------------------------
  gladys.onScanRequest(async () => {
    await resolveConfig();
    const count = await publishDiscoveredDevices(true);
    logger.info(`Scan: ${count} device(s) offered`);
  });

  gladys.onDeviceCreated(async () => {
    await refreshCreatedDevices();
    // States sent before the device existed were dropped by Gladys, and the SDK
    // forgot what it sent for this device: send everything known again.
    for (const followed of stops) {
      await publishStopStates(followed);
    }
    if (traffic.data) {
      await digestTraffic();
    }
    refreshWidgets(Object.values(WIDGETS));
  });

  gladys.onDeviceDeleted(refreshCreatedDevices);

  // --- Configuration -----------------------------------------------------------------

  /**
   * @description Reload the whole config (internal keys included).
   * @param {object} [fallback] - Raw values to use when the read fails.
   * @returns {Promise<void>}
   */
  async function loadConfig(fallback) {
    try {
      const raw = await gladys.getConfig();
      rawConfig = raw ?? {};
      config = normalizeConfig(raw);
      language = readLanguage(raw, language);
    } catch (err) {
      if (fallback) {
        // The form values may lack the internal keys: never forget the added
        // stops, the next button would save the list without them.
        rawConfig = {
          [INTERNAL_KEYS.addedStops]: rawConfig[INTERNAL_KEYS.addedStops],
          ...fallback,
        };
        config = normalizeConfig(rawConfig);
      }
      logger.error('Unable to read the configuration', err);
    }
  }

  gladys.onConfigUpdated(async (raw) => {
    await loadConfig(raw);
    lastDiscovery = null;
    boards.clear();
    snapshots.clear();
    stopsError = null;
    logger.info('Configuration updated');
    await applyConfig();
  });

  // --- Connection lifecycle ----------------------------------------------------------
  // Each (re)connection resynchronizes; the promise lets the tests wait for it.
  let startup = Promise.resolve();
  gladys.on('connected', () => {
    startup = (async () => {
      await loadConfig();
      await store.load();
      await refreshCreatedDevices();
      lastStatus = null;
      lastDiscovery = null;
      await applyConfig();
    })().catch((err) => logger.error('Startup', err));
  });

  // --- Graceful shutdown -------------------------------------------------------------
  gladys.handleShutdown(async (signal) => {
    logger.info(`Received ${signal} -> graceful shutdown`);
    stopped = true;
    clearInterval(stopTimer);
    clearInterval(trafficTimer);
    clearInterval(reminderTimer);
    clearTimeout(resolveTimer);
    await store.save();
  });

  return {
    store,
    api,
    readStops,
    trafficTick,
    checkReminders,
    applyConfig,
    getConfig: () => config,
    getStops: () => stops,
    getLines: () => lines,
    getSnapshot: (key) => snapshots.get(key),
    getTraffic: () => traffic,
    whenReady: () => startup,
  };
}

export {
  createApp,
  ACTIONS,
  SCENE_ACTIONS,
  IDLE_INTERVAL_MS,
  TRAFFIC_INTERVAL_MS,
  SNAPSHOT_MAX_AGE_MS,
};
