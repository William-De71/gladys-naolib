import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNaolibClient, USER_AGENT, BUSY_RETRIES, BUSY_PAUSE_MS } from '../src/naolib-api.js';
import {
  fakeNaolib,
  gtfsRecord,
  GTFS_FILE_ID,
  GTFS_ZIP,
  GTFS_RECORD_URL,
  NOW,
} from './helpers/fixtures.js';

/**
 * @description A client of the fake Naolib, pausing for nothing.
 * @param {Function} fetch - fakeNaolib().
 * @returns {{ api: object, pauses: number[] }} The client and its pauses.
 */
function client(fetch) {
  const pauses = [];
  const api = createNaolibClient({
    fetch,
    now: () => NOW,
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
  return { api, pauses };
}

test('the timetable, then nothing while its file is unchanged; the feeds decoded', async () => {
  const fetch = fakeNaolib();
  const { api } = client(fetch);
  const answer = await api.gtfs();
  assert.equal(answer.lastModified, GTFS_FILE_ID);
  assert.equal(answer.zip.length, GTFS_ZIP.length);
  // The record says the file kept is the current one: no download.
  assert.equal(await api.gtfs(GTFS_FILE_ID), null);
  assert.equal((await api.tripUpdates()).tripUpdates.length, 79);
  assert.equal((await api.alerts()).alerts.length, 47);
  assert.deepEqual(api.requests.byEndpoint, {
    gtfs_record: 2,
    gtfs: 1,
    trip_updates: 1,
    alerts: 1,
  });
  assert.equal(api.requests.notModified, 1);
  assert.equal(fetch.calls[0].url, GTFS_RECORD_URL);
  assert.deepEqual(
    fetch.calls.slice(3).map((call) => call.url),
    [
      'https://proxy.transport.data.gouv.fr/resource/naolib-nantes-gtfs-rt-trip-update',
      'https://proxy.transport.data.gouv.fr/resource/naolib-nantes-gtfs-rt-alerts',
    ],
  );
  assert.match(USER_AGENT, /^gladys-naolib\//);
  // A new file: downloaded.
  fetch.state.fileId = 'f00d';
  assert.equal((await api.gtfs(GTFS_FILE_ID)).lastModified, 'f00d');
});

test('the GTFS file in force today among the ones of the record', async () => {
  const fetch = fakeNaolib();
  const { api } = client(fetch);
  // The next period is announced before the current one ends.
  fetch.state.records = [
    gtfsRecord('next', { from: '2027-02-08', to: '2027-05-09' }),
    gtfsRecord(GTFS_FILE_ID),
    gtfsRecord('old', { from: '2026-08-01', to: '2026-11-05' }),
  ];
  assert.equal((await api.gtfs()).lastModified, GTFS_FILE_ID);
  // None in force: the latest.
  fetch.state.records = [gtfsRecord('old', { from: '2026-08-01', to: '2026-11-05' })];
  fetch.state.fileId = 'old';
  assert.equal((await api.gtfs()).lastModified, 'old');
  // No usable file.
  fetch.state.records = [{ debut_de_validite: '2026-11-06', fichier: { id: 'x', url: 'ftp://x' } }];
  await assert.rejects(api.gtfs(), { kind: 'invalid', message: /no GTFS file/ });
  fetch.state.records = { error: 'quota' };
  await assert.rejects(api.gtfs(), { kind: 'invalid' });
});

test('a feed refused with 429 is asked again a few seconds later', async () => {
  const fetch = fakeNaolib();
  const { api, pauses } = client(fetch);
  fetch.state.busy = 2;
  assert.equal((await api.tripUpdates()).tripUpdates.length, 79);
  assert.deepEqual(pauses, [BUSY_PAUSE_MS, BUSY_PAUSE_MS]);
  assert.equal(api.requests.busy, 2);
  assert.equal(api.requests.failed, 0);
  // Still busy after the last try: an error of kind busy.
  fetch.state.busy = BUSY_RETRIES + 1;
  await assert.rejects(api.alerts(), { kind: 'busy', status: 429 });
  assert.equal(pauses.length, 2 + BUSY_RETRIES);
  assert.equal(fetch.state.busy, 0);
});

test('errors: unreachable, busy, invalid', async () => {
  const fetch = fakeNaolib();
  const { api } = client(fetch);
  fetch.state.fail = 'network';
  await assert.rejects(api.tripUpdates(), { kind: 'unreachable', message: 'ECONNREFUSED' });
  fetch.state.fail = 503;
  await assert.rejects(api.alerts(), { kind: 'busy', status: 503 });
  fetch.state.fail = 404;
  await assert.rejects(api.gtfs(), { kind: 'invalid' });
  fetch.state.fail = 500;
  await assert.rejects(api.gtfs(), { kind: 'unreachable', status: 500 });
  fetch.state.fail = null;
  fetch.state.tripUpdates = Buffer.from('<html>oops</html>');
  await assert.rejects(api.tripUpdates(), { kind: 'invalid' });
  assert.equal(api.requests.failed, 4);
});
