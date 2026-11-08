import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeEntities,
  plainText,
  titleOf,
  firstLink,
  linkOf,
  readableHeader,
  alertState,
  messageOf,
  parseTraffic,
  messageAt,
  lineTraffic,
  seriousMessages,
} from '../src/traffic.js';
import { decodeFeed } from '../src/gtfs-rt.js';
import { ALERTS, NOW, rawAlert } from './helpers/fixtures.js';

const HOUR = 3600;
const now = NOW / 1000;

const L = (name) => `FR_NAOLIB:Line:${name}`;

test('texts: plain, a title, a link', () => {
  assert.equal(plainText(' Ligne 4 <br/>déviée\r\n\n  ce soir '), 'Ligne 4\ndéviée\nce soir');
  assert.equal(titleOf('', 'La ligne C6 est déviée. Les arrêts…'), 'La ligne C6 est déviée.');
  // A sentence ending with a colon announces a list: the colon goes.
  assert.equal(titleOf('', 'Où prendre votre bus : vers Hermeland'), 'Où prendre votre bus');
  assert.equal(linkOf('https://naolib.fr/a b'), 'https://naolib.fr/a%20b');
  assert.equal(linkOf('http://insecure.fr'), '');
  // An internal code as a header is not a title.
  assert.equal(readableHeader('    TR/L17/Dev/ TRL17Dev- 17DEV  2 SENS'), false);
  assert.equal(readableHeader('Travaux rue des Bourderies à Nantes'), true);
});

test('the HTML of Naolib: entities, paragraphs, lists, the internal reference dropped', () => {
  assert.equal(decodeEntities('&nbsp;&amp;&gt;&#233;&#x2019;&rsquo;&unknown;'), ' &>é’’&unknown;');
  const html =
    '<h4>Du lundi 31 août 2026 au vendredi 30 juillet 2027</h4>' +
    '<p>Travaux de voirie, la ligne 50 est déviée :</p>' +
    '<ul><li>arrêt Indre reporté&nbsp;</li><li>arrêt Pasteur reporté</li></ul>' +
    '<p>&nbsp;</p><p><a href="https://naolib.fr/plan?a=1&amp;b=2">Plan de la déviation</a></p>' +
    '<p>26/626 - 26/633</p>';
  assert.equal(
    plainText(html),
    'Du lundi 31 août 2026 au vendredi 30 juillet 2027\n' +
      'Travaux de voirie, la ligne 50 est déviée :\n' +
      '- arrêt Indre reporté\n- arrêt Pasteur reporté\n' +
      'Plan de la déviation',
  );
  assert.equal(plainText('<p>Arrêt reporté</p><p>26/692</p>'), 'Arrêt reporté');
  // The link of the map of a diversion, its entities decoded.
  assert.equal(firstLink(html), 'https://naolib.fr/plan?a=1&b=2');
  assert.equal(firstLink('<p>no link</p>'), '');
  // Without a header, the title skips the line of the dates.
  assert.equal(titleOf('', plainText(html)), 'Travaux de voirie, la ligne 50 est déviée');
  assert.equal(titleOf('', 'A partir du lundi 07/04 :\nLigne 5 perturbée.'), 'Ligne 5 perturbée.');
  assert.equal(
    titleOf('', 'Dimanche 8 novembre\nMatch de rugby à la Beaujoire : la ligne 75 est déviée.'),
    'Match de rugby à la Beaujoire',
  );
  assert.equal(titleOf('', 'Du 2 au 6 novembre'), 'Du 2 au 6 novembre');
  const message = messageOf(rawAlert({ header: '', description: html }));
  assert.equal(message.title, 'Travaux de voirie, la ligne 50 est déviée');
  assert.equal(message.url, 'https://naolib.fr/plan?a=1&b=2');
  // A link of the alert itself comes first.
  assert.equal(
    messageOf(rawAlert({ url: 'https://naolib.fr/info', description: html })).url,
    'https://naolib.fr/info',
  );
});

test('the weight of an alert: its effect, its severity, else its words', () => {
  const state = (fields, text = '') => alertState(rawAlert(fields), text);
  assert.equal(state({ effect: 1 }), 'major');
  assert.equal(state({ effect: 4 }), 'disrupted');
  assert.equal(state({ effect: 6 }), 'info');
  assert.equal(state({ severity: 4 }), 'major');
  assert.equal(state({}, 'Le tramway est interrompu entre Commerce et Beaujoire.'), 'major');
  assert.equal(state({}, 'La ligne C1 est déviée.'), 'disrupted');
  assert.equal(state({}, 'Arrêts non desservis dans les 2 sens.'), 'disrupted');
  assert.equal(state({}, 'Travaux de nuit, quai provisoire.'), 'info');
  // A word ending with an accented letter, then a space or a stop.
  assert.equal(state({}, 'Arrêt Commerce reporté à Bouffay.'), 'disrupted');
  assert.equal(state({}, 'Trafic perturbé ce soir'), 'disrupted');
  assert.equal(state({}, 'Le C1 est dévié'), 'disrupted');
  assert.equal(state({}, 'Un report de séance.'), 'info');
});

test('the real alerts of Naolib: titles, texts, links, under way or coming', () => {
  const traffic = parseTraffic(decodeFeed(ALERTS));
  // 47 alerts, 28 without a line or without a text: 19 messages.
  assert.equal(traffic.messages.length, 19);
  assert.deepEqual(
    traffic.messages.find((m) => m.id === 'd276371c-96cb-45f0-a002-e031af8bff1e'),
    {
      id: 'd276371c-96cb-45f0-a002-e031af8bff1e',
      lineIds: [L('50'), L('81')],
      state: 'disrupted',
      title: 'Travaux quais Langlois et Jean Bart à Basse Indre',
      text:
        'Du lundi 31 août 2026 au vendredi 30 juillet 2027\n' +
        'Travaux de voirie quais Langlois et Jean Bart, les lignes 50 et 81 sont déviées dans les 2 sens comme suit :\n' +
        "Ligne 50 déviée dans les 2 sens entre les arrêts Rue d'Indre et Basse Indre\n" +
        "- arrêts Indre et Dayat reportés à l'arrêt provisoire placé sur la D107 avant le rond point\n" +
        "- arrêts Pasteur et Jean Bart reportés à l'arrêt Basse Indre\n" +
        "Ligne 81 déviée dans les 2 sens entre les arrêts Rue d'Indre et Pont Allard\n" +
        "- arrêts Indre et Basse Indre reportés à l'arrêt Mairie d'Indre situé rue de la Gare\n" +
        "- arrêts Pasteur et Jean Bart reportés à l'arrêt Basse Indre\n" +
        'Plan de la déviation',
      url: 'https://naolib.fr/medias/photo/plan-basse-indre_1787560470632_crop',
      periods: [{ start: 1788145200000, end: 1816970400000 }],
      hours: '',
    },
  );
  // The demonstration of Saturday cuts the trams until 03:00.
  const tram1 = lineTraffic(traffic, L('1'), NOW);
  assert.equal(tram1.state, 'major');
  assert.equal(tram1.messages[0].title, 'Manifestation du samedi 7 novembre');
  assert.equal(tram1.since, 1794044220000);
  assert.match(tram1.messages[0].text, /- Ligne 1 coupée entre Gare Nord et Chantiers Navals/);
  assert.equal(lineTraffic(traffic, L('1'), Date.parse('2026-11-08T03:00:00Z')).state, 'normal');
  // The rugby match of Sunday afternoon is coming on the 75.
  assert.deepEqual(
    lineTraffic(traffic, L('75'), NOW).upcoming.map((m) => m.title),
    ['Match de rugby à la Beaujoire'],
  );
});

test('a platform alert concerns the lines calling there', () => {
  const message = messageOf(
    rawAlert({ routeIds: [L('1')], stopIds: ['FR_NAOLIB:Quay:151', 'FR_NAOLIB:Quay:151'] }),
    (stopId) => (stopId === 'FR_NAOLIB:Quay:151' ? [L('1'), L('C1')] : []),
  );
  // Each line once, though Naolib repeats them.
  assert.deepEqual(message.lineIds, [L('1'), L('C1')]);
  // No line at all: dropped.
  assert.deepEqual(parseTraffic({ alerts: [rawAlert({ routeIds: [] })] }).messages, []);
});

test('periods: under way, coming, over; the state of a line', () => {
  const base = messageOf(rawAlert());
  assert.equal(messageAt(base, NOW).coming, false);
  assert.equal(messageAt({ ...base, periods: [] }, NOW).start, null);
  assert.equal(
    messageAt(
      { ...base, periods: [{ start: (now - 5 * HOUR) * 1000, end: (now - HOUR) * 1000 }] },
      NOW,
    ),
    null,
  );
  const traffic = parseTraffic({
    alerts: [
      rawAlert({ id: 'detour' }),
      rawAlert({ id: 'cut', effect: 1, periods: [{ start: now - 600, end: null }] }),
      rawAlert({
        id: 'soon',
        header: 'Concert',
        description: 'Desserte renforcée.',
        periods: [{ start: now + 24 * HOUR, end: now + 28 * HOUR }],
      }),
      rawAlert({ id: 'later', periods: [{ start: now + 5 * 24 * HOUR, end: null }] }),
    ],
  });
  const line = lineTraffic(traffic, L('C1'), NOW);
  assert.equal(line.state, 'major');
  assert.equal(line.since, NOW - 600000);
  assert.deepEqual(
    line.messages.map((m) => m.id),
    ['cut', 'detour'],
  );
  assert.deepEqual(
    line.upcoming.map((m) => m.id),
    ['soon'],
  );
  assert.equal(seriousMessages(line).length, 2);
  assert.equal(lineTraffic(traffic, L('1'), NOW).state, 'normal');
  assert.equal(lineTraffic(null, L('1'), NOW).state, 'unknown');
  const info = parseTraffic({ alerts: [rawAlert({ effect: 6 })] });
  assert.deepEqual(
    [lineTraffic(info, L('C1'), NOW).state, lineTraffic(info, L('C1'), NOW).since],
    ['info', null],
  );
});
