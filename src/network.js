// -----------------------------------------------------------------------------
// The reference data of Naolib, from its GTFS (gtfs.js):
//
//   - the GTFS zip (19 MB) is kept in /data; once a day, after 04:00, the
//     record of the dataset on data.nantesmetropole.fr tells whether a new
//     file was published (its id changes), and only then is it downloaded;
//   - lines: the routes, typed the way the user reads them: "1", "tram 1",
//     "C1", "ligne 4", "N1" (the Navibus);
//   - stops: the platforms of one stop place (parent_station, 1 084 names):
//     "Commerce" gathers the platforms of the trams and the buses. The same
//     name in another town ("Poitou") is another stop: its code takes "-2".
//     A stop is typed by name ("Commerce", "gare sud") or by the id of one of
//     its platforms ("FR_NAOLIB:Quay:95"). A name typed with other words
//     resolves when one stop only holds them all ("haluch" -> "Haluchère");
//   - the timetable of the followed stops: their departures over eight
//     service days (yesterday to six days ahead), extracted from the zip
//     kept, in memory only, rebuilt each day and when a stop is added.
//
// Names are compared folded: no case, no accent, no punctuation.
// -----------------------------------------------------------------------------

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readGtfs } from './gtfs.js';
import { localClock } from './time.js';

const DAY_MS = 24 * 3600 * 1000;
const MODES = { TRAM: 'tram', BUS: 'bus' };
// GTFS route types: 0 tram, 3 bus and busway, 4 the Navibus (read as buses).
const TRAM_TYPES = new Set([0, 900]);

/**
 * @description Fold a text for comparisons.
 * @param {unknown} value - The text.
 * @returns {string} Lower case, no accent, words separated by one space.
 * @example
 * fold("Pérols Étang de l'Or"); // -> 'perols etang de l or'
 */
function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * @description A slug for an external id.
 * @param {unknown} value - The text.
 * @param {number} [max] - Its longest length.
 * @returns {string} "gare-saint-roch".
 */
function slug(value, max = 40) {
  return fold(value).replace(/ /g, '-').slice(0, max).replace(/-$/, '');
}

/**
 * @description What is kept of a line.
 * @param {object} route - A route of the GTFS.
 * @returns {object} `{ id, name, longName, mode, color }`.
 */
const lineOf = (route) => ({
  id: String(route.id),
  name: String(route.shortName || route.id),
  longName: String(route.longName ?? ''),
  mode: TRAM_TYPES.has(route.type) ? MODES.TRAM : MODES.BUS,
  color: /^[0-9a-f]{6}$/i.test(route.color ?? '') ? `#${route.color.toUpperCase()}` : '',
});

/**
 * @description The order of lines: trams first, then by name.
 * @param {object} a - A line.
 * @param {object} b - Another one.
 * @returns {number} The order.
 */
const byLine = (a, b) =>
  Number(a.mode !== MODES.TRAM) - Number(b.mode !== MODES.TRAM) ||
  a.name.localeCompare(b.name, 'fr', { numeric: true });

/**
 * @description The stops: the platforms of one stop place (the
 * parent_station of the GTFS, reliable at Naolib: "Commerce" gathers the
 * platforms of the trams and the buses). A platform without a place is a stop
 * of its own.
 * @param {object[]} platforms - The stops of the GTFS (`parent` the place).
 * @param {object} linesByStop - `{ platform id: [route id] }`.
 * @returns {object[]} `[{ code, name, ids, platforms, lines, lat, lon }]`,
 * `code` the slug of the name (another place of the same slug, "Poitou" in
 * two towns, gets "-2", "-3"… in the order of the place numbers), `platforms`
 * the ids of the platforms.
 */
function groupStops(platforms, linesByStop) {
  const byPlace = new Map();
  for (const platform of platforms) {
    const place = platform.parent || platform.id;
    const list = byPlace.get(place) ?? [];
    list.push(platform);
    byPlace.set(place, list);
  }
  const groups = [...byPlace].map(([place, list]) => {
    // The most common spelling of the place.
    const counts = new Map();
    list.forEach((item) => counts.set(item.name, (counts.get(item.name) ?? 0) + 1));
    const name = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fr'))[0][0];
    return { place, name, list };
  });
  const numeric = (a, b) => a.localeCompare(b, 'fr', { numeric: true });
  groups.sort(
    (a, b) => fold(a.name).localeCompare(fold(b.name), 'fr') || numeric(a.place, b.place),
  );
  const used = new Set();
  return groups.map(({ name, list }) => {
    list.sort((a, b) => numeric(a.id, b.id));
    let code = slug(name, 60) || slug(list[0].id);
    for (let index = 2; used.has(code); index += 1) {
      code = `${slug(name, 56)}-${index}`;
    }
    used.add(code);
    const average = (key) =>
      Math.round((list.reduce((sum, item) => sum + item[key], 0) / list.length) * 1e5) / 1e5;
    return {
      code,
      name,
      ids: list.map((item) => item.id),
      platforms: [...new Set(list.map((item) => item.code || item.id))],
      lines: [...new Set(list.flatMap((item) => linesByStop[item.id] ?? []))],
      lat: average('lat'),
      lon: average('lon'),
    };
  });
}

/**
 * @description Find a line among the known ones.
 * @param {object[]} lines - The known lines.
 * @param {string} typed - "1", "tram 1", "ligne 6", "Amigo".
 * @returns {object|null} The line.
 * @example
 * findLine(lines, 'tram 1'); // -> { id: '1', name: '1', mode: 'tram', … }
 */
function findLine(lines, typed) {
  const raw = String(typed ?? '').trim();
  if (!raw) {
    return null;
  }
  const byId = lines.find((line) => line.id.toLowerCase() === raw.toLowerCase());
  if (byId) {
    return byId;
  }
  const compact = (value) => fold(value).replace(/ /g, '');
  const wanted = compact(
    raw.replace(
      /^\s*(ligne|line|linie|l[ií]nea|tram(way)?|tranv[ií]a|stra(ss|ß)enbahn|bus|autobus|busway|chronobus|navibus)\s+/i,
      '',
    ),
  );
  if (!wanted) {
    return null;
  }
  return lines.find((line) => compact(line.name) === wanted) ?? null;
}

/**
 * @description Find a stop among the known ones.
 * @param {object[]} stops - The known stops.
 * @param {string} typed - A name, a stop code ("commerce") or a platform code.
 * @returns {object|null} The stop.
 * @example
 * findStop(stops, 'commerce'); // -> { code: 'commerce', name: 'Commerce', … }
 */
function findStop(stops, typed) {
  const raw = String(typed ?? '').trim();
  if (!raw) {
    return null;
  }
  const lower = raw.toLowerCase();
  const byCode = stops.find(
    (stop) => stop.code === lower || stop.platforms.includes(raw) || stop.ids.includes(raw),
  );
  if (byCode) {
    return byCode;
  }
  const wanted = fold(raw);
  if (!wanted) {
    return null;
  }
  const exact = stops.filter((stop) => fold(stop.name) === wanted);
  if (exact.length > 0) {
    return exact.length === 1 ? exact[0] : null;
  }
  // A unique stop holding every typed word ("rondel" -> "Rondelet").
  const words = wanted.split(' ');
  const holding = stops.filter((stop) =>
    words.every((word) => ` ${fold(stop.name)} `.includes(` ${word}`)),
  );
  return holding.length === 1 ? holding[0] : null;
}

/**
 * @description Search stops by name, for the "Find a stop" button.
 * @param {object[]} stops - The known stops.
 * @param {string} query - Words of the name.
 * @param {number} [max] - The most stops returned.
 * @returns {object[]} The stops, exact names first, then names starting so.
 */
function searchStops(stops, query, max = 8) {
  const words = fold(query).split(' ').filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  const wanted = words.join(' ');
  const rank = (stop) => {
    const name = fold(stop.name);
    if (name === wanted) {
      return 0;
    }
    return name.startsWith(wanted) ? 1 : 2;
  };
  return stops
    .filter((stop) => words.every((word) => ` ${fold(stop.name)} `.includes(` ${word}`)))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'fr'))
    .slice(0, max);
}

/**
 * @description A GTFS date, from a local date.
 * @param {number} instant - The instant (ms).
 * @param {string} [timeZone] - IANA timezone.
 * @returns {string} "20261027".
 */
const gtfsDate = (instant, timeZone) => localClock(instant, timeZone).date.replace(/-/g, '');

/**
 * @description The reference data and the timetables, through the API, kept
 * in the store and in a zip next to it.
 * @param {object} options - Options.
 * @param {object} options.api - Naolib client.
 * @param {object} options.store - The store (`data.network`).
 * @param {string} options.zipPath - Where the GTFS zip is kept.
 * @param {Function} options.now - `() => number` in ms.
 * @param {Function} options.isNewDay - `(readAt) => boolean`: a 04:00 passed since.
 * @param {string} [options.timeZone] - IANA timezone of the network.
 * @param {object} [options.logger] - Logger.
 * @returns {object} The network.
 */
function createNetwork({ api, store, zipPath, now, isNewDay, timeZone = 'Europe/Paris', logger }) {
  // In memory only: rebuilt from the zip.
  let timetable = null;
  let checking = null;
  let building = null;
  let zipCache = null;

  const data = () => {
    if (!store.data.network || typeof store.data.network !== 'object') {
      store.data.network = { lines: null, stops: null, lastModified: '', checkedAt: 0 };
    }
    return store.data.network;
  };

  /**
   * @description The zip kept, read once.
   * @returns {Promise<Buffer|null>} Its bytes, null when absent.
   */
  async function readZip() {
    if (zipCache) {
      return zipCache;
    }
    try {
      zipCache = await readFile(zipPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger?.warn(`Unable to read ${zipPath}: ${err.message}`);
      }
      return null;
    }
    return zipCache;
  }

  /**
   * @description Keep a new zip (atomically).
   * @param {Buffer} zip - The archive.
   * @returns {Promise<void>}
   */
  async function writeZip(zip) {
    zipCache = zip;
    try {
      await mkdir(dirname(zipPath), { recursive: true });
      await writeFile(`${zipPath}.tmp`, zip);
      await rename(`${zipPath}.tmp`, zipPath);
    } catch (err) {
      logger?.warn(`Unable to write ${zipPath}: ${err.message}`);
    }
  }

  /**
   * @description Read the lines and stops of a zip into the store.
   * @param {Buffer} zip - The archive.
   * @returns {Promise<void>}
   */
  async function adopt(zip) {
    // The lines of each platform from the trips of two weeks around today:
    // reading the three months of trips would not fit in 256 MB.
    const current = now();
    const gtfs = await readGtfs(zip, {
      from: gtfsDate(current - DAY_MS, timeZone),
      to: gtfsDate(current + 13 * DAY_MS, timeZone),
    });
    const lines = gtfs.routes.map(lineOf).sort(byLine);
    const stops = groupStops(gtfs.stops, gtfs.linesByStop);
    if (lines.length === 0 || stops.length === 0) {
      throw Object.assign(new Error('empty timetable'), { kind: 'invalid' });
    }
    Object.assign(data(), { lines, stops });
  }

  /**
   * @description Ask for the zip again when a new day began (or when forced),
   * and read it when it changed. A failure keeps what is known.
   * @param {boolean} [force] - Ask even when checked today.
   * @returns {Promise<void>}
   */
  function check(force = false) {
    const kept = data();
    const fresh = kept.lines && kept.stops && !isNewDay(kept.checkedAt);
    if (fresh && !force) {
      return Promise.resolve();
    }
    checking ??= (async () => {
      try {
        const zipKept = await readZip();
        // Without the zip on disk, the lines alone are not enough.
        const answer = await api.gtfs(zipKept ? kept.lastModified : '');
        if (answer) {
          await adopt(answer.zip);
          await writeZip(answer.zip);
          kept.lastModified = answer.lastModified;
          timetable = null;
          logger?.info(
            `Naolib timetable read (${answer.zip.length} bytes, ${answer.lastModified})`,
          );
        } else if (!kept.lines || !kept.stops) {
          await adopt(zipKept);
        }
        kept.checkedAt = now();
        await store.save();
      } catch (err) {
        if (!kept.lines || !kept.stops) {
          throw err;
        }
        logger?.warn(`Naolib timetable not read again (${err.kind ?? 'error'}): ${err.message}`);
      } finally {
        checking = null;
      }
    })();
    return checking;
  }

  /**
   * @description The lines.
   * @param {boolean} [force] - Ask for the timetable again.
   * @returns {Promise<object[]>} The lines.
   */
  async function lines(force = false) {
    await check(force);
    return data().lines;
  }

  /**
   * @description The stops.
   * @param {boolean} [force] - Ask for the timetable again.
   * @returns {Promise<object[]>} The stops.
   */
  async function stops(force = false) {
    await check(force);
    return data().stops;
  }

  /**
   * @description The timetable holding some stops, built from the zip when
   * the day, the zip or the stops changed. The stops already held stay.
   * @param {object[]} wanted - The stops (`code`, `ids`).
   * @returns {Promise<object|null>} `{ from, to, codes, services, trips,
   * rows }`, null without a zip.
   */
  async function timetableOf(wanted) {
    await check();
    const current = now();
    const from = gtfsDate(current - DAY_MS, timeZone);
    const to = gtfsDate(current + 6 * DAY_MS, timeZone);
    const valid = timetable && timetable.from === from && timetable.version === data().lastModified;
    if (valid && wanted.every((stop) => timetable.codes.includes(stop.code))) {
      return timetable;
    }
    building ??= (async () => {
      try {
        const zip = await readZip();
        if (!zip) {
          return null;
        }
        const codes = [
          ...new Set([...(valid ? timetable.codes : []), ...wanted.map((stop) => stop.code)]),
        ];
        const known = data().stops ?? [];
        const ids = new Set(
          codes.flatMap((code) => known.find((stop) => stop.code === code)?.ids ?? []),
        );
        const started = Date.now();
        const gtfs = await readGtfs(zip, { stopIds: ids, from, to });
        timetable = { ...gtfs.timetable, codes, version: data().lastModified, builtAt: now() };
        logger?.info(
          `Naolib timetable of ${codes.length} stop(s): ${timetable.rows.length} departures, ` +
            `${Date.now() - started} ms`,
        );
        return timetable;
      } finally {
        building = null;
      }
    })();
    await building;
    // Another stop may have been asked while building.
    return wanted.every((stop) => timetable?.codes.includes(stop.code))
      ? timetable
      : timetableOf(wanted);
  }

  return {
    check,
    lines,
    stops,
    timetable: timetableOf,
    /**
     * @description A line known without reading anything.
     * @param {string} id - The route id ("1").
     * @returns {object|null} The line.
     */
    peekLine: (id) => data().lines?.find((line) => line.id === String(id)) ?? null,
    /**
     * @description The lines calling at a platform, known without reading.
     * @param {string} stopId - The platform id.
     * @returns {string[]} The route ids.
     */
    linesOfPlatform: (stopId) =>
      data().stops?.find((stop) => stop.ids.includes(String(stopId)))?.lines ?? [],
    /**
     * @description Resolve a typed line.
     * @param {string} typed - The line as typed.
     * @returns {Promise<object|null>} The line, null when unknown.
     */
    resolveLine: async (typed) => findLine(await lines(), typed),
    /**
     * @description Resolve a typed stop.
     * @param {string} typed - A name or a code.
     * @returns {Promise<object|null>} The stop.
     */
    resolveStop: async (typed) => findStop(await stops(), typed),
    /**
     * @description Search stops by name.
     * @param {string} query - Words of the name.
     * @returns {Promise<object[]>} The stops.
     */
    searchStops: async (query) => searchStops(await stops(), query),
    /**
     * @description What the diagnostic tells of the timetable.
     * @returns {object|null} Its window, stops and size.
     */
    describeTimetable: () =>
      timetable
        ? {
            from: timetable.from,
            to: timetable.to,
            stops: timetable.codes,
            departures: timetable.rows.length,
            builtAt: new Date(timetable.builtAt).toISOString(),
          }
        : null,
  };
}

export {
  MODES,
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
};
