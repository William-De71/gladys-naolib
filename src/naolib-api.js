// -----------------------------------------------------------------------------
// HTTP client of the open data of Naolib, the trams, busways, buses and
// Navibus of Nantes Métropole. No key, ODbL.
//   - the timetable (GTFS zip, 19 MB) on data.nantesmetropole.fr: the record
//     of the dataset gives the id and the URL of the current file; the id
//     changes with each new file (the portal sends no Last-Modified), so the
//     zip is downloaded only when its id changed;
//   - the GTFS-RT trip updates of the whole network (about 220 KB, ONE
//     request for every followed stop) and the GTFS-RT service alerts,
//     through the proxy of transport.data.gouv.fr, the national access point
//     that lists them for Naolib. The source behind it (the Okina gateway of
//     Nantes Métropole) answers once per 30 seconds: the proxy then relays a
//     429, asked again a few seconds later.
// Datasets: https://transport.data.gouv.fr/datasets/reseau-de-transports-collectifs-naolib
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { decodeFeed } from './gtfs-rt.js';

const GTFS_RECORD_URL =
  process.env.NAOLIB_GTFS_URL ||
  'https://data.nantesmetropole.fr/api/explore/v2.1/catalog/datasets/244400404_transports_commun_naolib_nantes_metropole_gtfs/exports/json';
const FEEDS_URL = process.env.NAOLIB_API_URL || 'https://proxy.transport.data.gouv.fr/resource';
const TIMEOUT_MS = 20000;
const GTFS_TIMEOUT_MS = 180000;
// The zip is about 19 MB: anything far bigger is not the timetable.
const GTFS_MAX_BYTES = 96 * 1024 * 1024;
const FEED_MAX_BYTES = 8 * 1024 * 1024;
// A feed refused with 429 is asked again this many times, this far apart:
// 40 seconds in all, beyond the 30-second window of the source (shared by
// every user of the proxy).
const BUSY_RETRIES = 4;
const BUSY_PAUSE_MS = 10000;
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const USER_AGENT = `gladys-naolib/${version} (+https://github.com/William-De71/gladys-naolib)`;

const ENDPOINTS = {
  GTFS_RECORD: 'gtfs_record',
  GTFS: 'gtfs',
  TRIP_UPDATES: 'trip_updates',
  ALERTS: 'alerts',
};

const FEED_PATHS = {
  [ENDPOINTS.TRIP_UPDATES]: '/naolib-nantes-gtfs-rt-trip-update',
  [ENDPOINTS.ALERTS]: '/naolib-nantes-gtfs-rt-alerts',
};

class NaolibError extends Error {
  /**
   * @param {string} kind - `busy`, `unreachable` or `invalid`.
   * @param {string} message - The detail.
   * @param {object} [extra] - `{ status }`.
   */
  constructor(kind, message, { status = null } = {}) {
    super(message);
    this.name = 'NaolibError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * @description A client of the open data of Naolib.
 * @param {object} [options] - Options.
 * @param {Function} [options.fetch] - The fetch function (tests).
 * @param {Function} [options.now] - `() => number` in ms.
 * @param {Function} [options.sleep] - `(ms) => Promise` (tests).
 * @param {string} [options.feedsUrl] - The root of the feeds (tests, end-to-end runs).
 * @param {string} [options.gtfsRecordUrl] - The record of the GTFS dataset.
 * @returns {object} The methods, and `requests` for the diagnostic.
 */
function createNaolibClient({
  fetch: fetchFn = globalThis.fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  feedsUrl = FEEDS_URL,
  gtfsRecordUrl = GTFS_RECORD_URL,
} = {}) {
  // Requests made, per endpoint, for the diagnostic.
  const requests = { total: 0, byEndpoint: {}, failed: 0, busy: 0, notModified: 0, last: null };

  /**
   * @description Get a URL.
   * @param {string} endpoint - ENDPOINTS, for the counters.
   * @param {string} url - The URL.
   * @param {object} [options] - `{ timeout }`.
   * @returns {Promise<Response>} The answer (2xx).
   */
  async function call(endpoint, url, { timeout = TIMEOUT_MS } = {}) {
    requests.total += 1;
    requests.byEndpoint[endpoint] = (requests.byEndpoint[endpoint] ?? 0) + 1;
    requests.last = now();
    let response;
    try {
      response = await fetchFn(url, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      requests.failed += 1;
      throw new NaolibError('unreachable', err.cause?.code ?? err.message);
    }
    if (!response.ok) {
      let kind = 'unreachable';
      if (response.status === 429 || response.status === 503) {
        kind = 'busy';
        requests.busy += 1;
      } else {
        requests.failed += 1;
        if (response.status >= 400 && response.status < 500) {
          kind = 'invalid';
        }
      }
      throw new NaolibError(kind, `${endpoint}: HTTP ${response.status}`, {
        status: response.status,
      });
    }
    return response;
  }

  /**
   * @description The bytes of an answer.
   * @param {string} endpoint - ENDPOINTS.
   * @param {Response} response - The answer.
   * @param {number} max - The largest accepted size.
   * @returns {Promise<Buffer>} The bytes.
   */
  async function bytesOf(endpoint, response, max) {
    let body;
    try {
      body = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      requests.failed += 1;
      throw new NaolibError('unreachable', `${endpoint}: ${err.message}`);
    }
    if (body.length > max) {
      requests.failed += 1;
      throw new NaolibError('invalid', `${endpoint}: ${body.length} bytes`);
    }
    return body;
  }

  /**
   * @description A GTFS-RT feed, asked again while the source is busy.
   * @param {string} endpoint - ENDPOINTS.TRIP_UPDATES or ALERTS.
   * @returns {Promise<object>} decodeFeed().
   */
  async function feed(endpoint) {
    let response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await call(endpoint, `${feedsUrl}${FEED_PATHS[endpoint]}`);
        break;
      } catch (err) {
        if (err.kind !== 'busy' || attempt >= BUSY_RETRIES) {
          throw err;
        }
        await sleep(BUSY_PAUSE_MS);
      }
    }
    const body = await bytesOf(endpoint, response, FEED_MAX_BYTES);
    try {
      return decodeFeed(body);
    } catch (err) {
      requests.failed += 1;
      throw new NaolibError('invalid', `${endpoint}: ${err.message}`);
    }
  }

  /**
   * @description The current GTFS file, from the record of the dataset.
   * @returns {Promise<{ id: string, url: string, validFrom: string, validTo: string }>}
   * The file.
   */
  async function gtfsFile() {
    const response = await call(ENDPOINTS.GTFS_RECORD, gtfsRecordUrl);
    let records;
    try {
      records = await response.json();
    } catch (err) {
      requests.failed += 1;
      throw new NaolibError('invalid', `${ENDPOINTS.GTFS_RECORD}: ${err.message}`);
    }
    // Several files may be listed (the next period announced): the one in
    // force today, else the latest.
    const today = new Date(now()).toISOString().slice(0, 10);
    const files = (Array.isArray(records) ? records : [])
      .map((record) => ({
        id: String(record?.fichier?.id ?? ''),
        url: String(record?.fichier?.url ?? ''),
        validFrom: String(record?.debut_de_validite ?? ''),
        validTo: String(record?.fin_de_validite ?? ''),
      }))
      .filter((file) => file.id && /^https:\/\//.test(file.url))
      .sort((a, b) => b.validFrom.localeCompare(a.validFrom));
    const current =
      files.find((file) => file.validFrom <= today && (!file.validTo || today <= file.validTo)) ??
      files[0];
    if (!current) {
      requests.failed += 1;
      throw new NaolibError('invalid', `${ENDPOINTS.GTFS_RECORD}: no GTFS file`);
    }
    return current;
  }

  return {
    requests,
    /**
     * @description The timetable, when a new file was published.
     * @param {string} [knownId] - The id of the file kept.
     * @returns {Promise<{ zip: Buffer, lastModified: string }|null>} The
     * archive and the id of its file (kept as `lastModified`), null when
     * the file kept is still the current one.
     */
    gtfs: async (knownId = '') => {
      const file = await gtfsFile();
      if (knownId && file.id === knownId) {
        requests.notModified += 1;
        return null;
      }
      const response = await call(ENDPOINTS.GTFS, file.url, { timeout: GTFS_TIMEOUT_MS });
      const zip = await bytesOf(ENDPOINTS.GTFS, response, GTFS_MAX_BYTES);
      return { zip, lastModified: file.id };
    },
    /**
     * @description The trip updates of the whole network.
     * @returns {Promise<object>} `{ timestamp, tripUpdates }`.
     */
    tripUpdates: () => feed(ENDPOINTS.TRIP_UPDATES),
    /**
     * @description The service alerts.
     * @returns {Promise<object>} `{ timestamp, alerts }`.
     */
    alerts: () => feed(ENDPOINTS.ALERTS),
  };
}

export {
  FEEDS_URL,
  GTFS_RECORD_URL,
  USER_AGENT,
  ENDPOINTS,
  FEED_PATHS,
  BUSY_RETRIES,
  BUSY_PAUSE_MS,
  NaolibError,
  createNaolibClient,
};
