// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data/naolib.json
// (the only writable place of the container; the GTFS zip lies next to it,
// in naolib-gtfs.zip):
//   - `network`   the lines and the stops of the timetable, its Last-Modified
//                 and when it was last asked, so a restart reads nothing but
//                 the real time and the traffic;
//   - `seen`      what the scene triggers already know: the reminders fired
//                 and the cancellations reported per stop, the state and the
//                 messages of each followed line.
//                 A restart never fires the same event twice.
// The passages and the timetables of the stops are not kept: they are built
// again from the zip at start.
// -----------------------------------------------------------------------------

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_PATH = '/data/naolib.json';
const EMPTY = () => ({
  network: { lines: null, stops: null, lastModified: '', checkedAt: 0 },
  seen: { reminders: {}, cancelled: {}, lines: {} },
});

/**
 * @description The store.
 * @param {object} [options] - `{ path, logger }`.
 * @returns {object} `{ data, load, save }`.
 */
function createStore({ path = DEFAULT_PATH, logger } = {}) {
  const store = {
    data: EMPTY(),
    /**
     * @description Read the file; an absent or broken file is an empty store.
     * @returns {Promise<void>}
     */
    async load() {
      try {
        const raw = JSON.parse(await readFile(path, 'utf8'));
        const base = EMPTY();
        const value = raw && typeof raw === 'object' ? raw : {};
        const part = (name) => (value[name] && typeof value[name] === 'object' ? value[name] : {});
        store.data = {
          network: { ...base.network, ...part('network') },
          seen: { ...base.seen, ...part('seen') },
        };
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger?.warn(`Unable to read ${path}: ${err.message}`);
        }
        store.data = EMPTY();
      }
    },
    /**
     * @description Write the file (atomically: a temporary file, then a rename).
     * @returns {Promise<void>}
     */
    async save() {
      try {
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.tmp`;
        await writeFile(temporary, JSON.stringify(store.data));
        await rename(temporary, path);
      } catch (err) {
        logger?.warn(`Unable to write ${path}: ${err.message}`);
      }
    },
  };
  return store;
}

export { DEFAULT_PATH, createStore };
