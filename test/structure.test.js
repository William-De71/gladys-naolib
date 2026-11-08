// -----------------------------------------------------------------------------
// Non-regression of everything users store: the device and feature external
// ids, the fields the Discovery "Update" button compares (category, type,
// unit, min, max, step), and every key of the manifest a scene, a widget or a
// saved configuration refers to.
//
// test/fixtures/discovery.baseline.json was generated from version 0.1.0 (the
// first release). A failure here means existing users would have to delete
// and recreate a device, or would lose a scene or a widget setting: never
// update the baseline without a documented migration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildStopDevice, buildLineDevice, stopKey, followedName } from '../src/device.js';
import { LANGUAGES } from '../src/i18n.js';
import { fakeGladys } from './helpers/fixtures.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const baseline = read('./fixtures/discovery.baseline.json');
const manifest = read('../gladys-assistant-integration.json');

const ETERNAL = [
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'step',
  'read_only',
  'has_feedback',
];
const pick = (feature) =>
  Object.fromEntries(
    ETERNAL.filter((key) => feature[key] !== undefined).map((key) => [key, feature[key]]),
  );
const keys = (list) => (list ?? []).map((entry) => entry.key);
const byKey = (list) => new Map((list ?? []).map((entry) => [entry.key, entry]));
const shape = (device) => ({
  external_id: device.external_id,
  should_poll: device.should_poll,
  params: device.params.map((param) => param.name),
  features: device.features.map(pick),
});

/**
 * @description A followed stop.
 * @param {object} stop - `{ code, name }`.
 * @param {object|null} line - `{ id, name }`.
 * @param {string} direction - The direction typed.
 * @returns {object} The followed stop.
 */
function followed(stop, line, direction) {
  const entry = { stop, line, direction, key: stopKey(stop, line, direction) };
  return { ...entry, name: followedName(entry) };
}

/**
 * @description Every device of the integration, in a language.
 * @param {string} language - The language.
 * @returns {object} The devices, by kind.
 */
const devices = (language) => ({
  stopWithLine: buildStopDevice(
    fakeGladys,
    followed(
      { code: 'commerce', name: 'Commerce' },
      { id: 'FR_NAOLIB:Line:1', name: '1', mode: 'tram' },
      'Beaujoire',
    ),
    language,
  ),
  stop: buildStopDevice(
    fakeGladys,
    followed(
      { code: 'gare-nord-jardin-des-plantes', name: 'Gare Nord - Jardin des Plantes' },
      null,
      '',
    ),
    language,
  ),
  busLine: buildLineDevice(
    fakeGladys,
    { id: 'FR_NAOLIB:Line:C1', name: 'C1', mode: 'bus' },
    language,
  ),
  tramLine: buildLineDevice(
    fakeGladys,
    { id: 'FR_NAOLIB:Line:1', name: '1', mode: 'tram' },
    language,
  ),
  namedLine: buildLineDevice(
    fakeGladys,
    { id: 'FR_NAOLIB:Line:N1', name: 'N1', mode: 'bus' },
    language,
  ),
});

test('the devices keep their external ids and the fields Discovery compares, in every language', () => {
  for (const language of LANGUAGES) {
    const current = Object.fromEntries(
      Object.entries(devices(language)).map(([kind, device]) => [kind, shape(device)]),
    );
    assert.deepEqual(current, baseline.devices, language);
  }
});

test('no configuration key or action disappears', () => {
  assert.deepEqual(
    keys(manifest.actions).filter((key) => baseline.manifest.actions.includes(key)),
    baseline.manifest.actions,
  );
});

test('no configuration key disappears or changes type', () => {
  const current = byKey(manifest.config_schema);
  for (const { key, type } of baseline.manifest.config_schema) {
    assert.equal(current.get(key)?.type, type, `config_schema.${key}`);
  }
});

test('scene triggers keep their keys, filters, options and variables', () => {
  const current = byKey(manifest.scene_triggers);
  for (const trigger of baseline.manifest.scene_triggers) {
    const now = current.get(trigger.key);
    assert.ok(now, `scene_triggers.${trigger.key}`);
    const fields = byKey(now.fields);
    for (const { key, options } of trigger.fields) {
      assert.ok(fields.has(key), `${trigger.key}.fields.${key}`);
      const values = (fields.get(key).options ?? []).map((option) => option.value);
      options.forEach((value) =>
        assert.ok(values.includes(value), `${trigger.key}.${key}: ${value}`),
      );
    }
    const variables = byKey(now.variables);
    for (const { key, type } of trigger.variables) {
      assert.equal(variables.get(key)?.type, type, `${trigger.key}.variables.${key}`);
    }
  }
});

test('scene actions keep their keys, fields and outputs', () => {
  const current = byKey(manifest.scene_actions);
  for (const action of baseline.manifest.scene_actions) {
    const now = current.get(action.key);
    assert.ok(now, `scene_actions.${action.key}`);
    action.fields.forEach((field) =>
      assert.ok(keys(now.fields).includes(field), `${action.key}.${field}`),
    );
    const outputs = byKey(now.outputs);
    for (const { key, type } of action.outputs) {
      assert.equal(outputs.get(key)?.type, type, `${action.key}.outputs.${key}`);
    }
  }
});

test('widgets keep their keys, settings and option values', () => {
  const current = byKey(manifest.widgets);
  for (const widget of baseline.manifest.widgets) {
    const now = current.get(widget.key);
    assert.ok(now, `widgets.${widget.key}`);
    const settings = byKey(now.settings);
    for (const key of widget.settings) {
      assert.ok(settings.has(key), `${widget.key}.settings.${key}`);
    }
    for (const [key, values] of Object.entries(widget.options)) {
      const options = settings.get(key).options.map((option) => option.value);
      values.forEach((value) =>
        assert.ok(options.includes(value), `${widget.key}.${key}: ${value}`),
      );
    }
  }
});
