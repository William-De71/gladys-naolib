// Builds the widget contents of the illustrations with the integration's own
// code: node gen.mjs <repo> <out.json> (run by render.sh)
//
// The two widgets on a real Saturday night in Nantes: the open data of
// Naolib read on 2026-11-08 at 00:06 and kept in test/fixtures (the GTFS of
// Pirmil and the trip updates of that minute) go through the real code
// (src/gtfs.js, src/departures.js, src/traffic.js) and the real widget
// builders (src/widgets.js). Added to show what the widgets do: a cancelled
// tram 3, night works on tram 1, a diversion of the busway 5 under way (a
// real alert) and works on the C1 coming in two days.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [repo, out] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(`${repo}/${path}`).href);
const { buildDeparturesWidget, buildTrafficWidget } = await load('src/widgets.js');
const { parseTraffic, lineTraffic } = await load('src/traffic.js');
const { LANGUAGES } = await load('src/i18n.js');
const { NOW, TZ, fixturePassages } = await load('test/helpers/fixtures.js');
const manifest = JSON.parse(readFileSync(`${repo}/gladys-assistant-integration.json`, 'utf8'));

const passages = await fixturePassages('Pirmil');
// The second tram 3 towards Marcel Paul cancelled.
const tram3 = passages.filter(
  (p) => p.lineId === 'FR_NAOLIB:Line:3' && p.destination === 'Marcel Paul',
);
if (tram3[1]) {
  tram3[1].cancelled = true;
}
const day = 24 * 3600;
const now = NOW / 1000;
const alert = (fields) => ({
  id: '',
  periods: [],
  routeIds: [],
  stopIds: [],
  cause: null,
  effect: null,
  severity: null,
  url: '',
  header: '',
  description: '',
  ...fields,
});
const traffic = parseTraffic({
  alerts: [
    alert({
      id: 'night-works',
      routeIds: ['FR_NAOLIB:Line:1'],
      header: 'Travaux de nuit place du Commerce',
      description:
        '<p>Après 22h, le tram 1 ne marque pas l’arrêt Commerce vers François Mitterrand : arrêt reporté à Bouffay.</p>',
      periods: [{ start: now - 2 * 3600, end: now + 5 * 3600 }],
    }),
    alert({
      id: 'estuaire',
      routeIds: ['FR_NAOLIB:Line:5'],
      header: "Travaux boulevard de l'Estuaire",
      description:
        "<p>A partir du lundi 07/04 :</p><p>En raison de travaux Boulevard de l'Estuaire, la ligne 5 est perturbée dans le secteur, uniquement vers Hangar à Bananes.</p><p>26/412</p>",
      periods: [{ start: now - 30 * day, end: now + 60 * day }],
    }),
    alert({
      id: 'c1-works',
      routeIds: ['FR_NAOLIB:Line:C1'],
      header: 'Travaux rue de Strasbourg',
      description:
        '<p>Du mardi 10 au jeudi 12 novembre</p><p>La ligne C1 est déviée entre les arrêts Foch - Cathédrale et Bouffay.</p>',
      periods: [{ start: now + 2 * day - 18 * 3600, end: now + 4 * day }],
    }),
  ],
});
const LINES = [
  { id: 'FR_NAOLIB:Line:1', name: '1', mode: 'tram' },
  { id: 'FR_NAOLIB:Line:3', name: '3', mode: 'tram' },
  { id: 'FR_NAOLIB:Line:5', name: '5', mode: 'bus' },
  { id: 'FR_NAOLIB:Line:C1', name: 'C1', mode: 'bus' },
];
const lines = LINES.map((line) => ({ line, traffic: lineTraffic(traffic, line.id, NOW) }));

const contents = {};
for (const language of LANGUAGES) {
  contents[language] = {
    departures: buildDeparturesWidget({
      title: 'Pirmil',
      passages,
      readAt: NOW,
      count: 6,
      language,
      now: NOW,
      timeZone: TZ,
    }),
    traffic: buildTrafficWidget({
      lines,
      readAt: NOW - 2 * 60 * 1000,
      language,
      now: NOW,
      timeZone: TZ,
    }),
  };
}
const widgets = Object.fromEntries(
  manifest.widgets.map((w) => [w.key, { icon: w.icon, label: w.label }]),
);
writeFileSync(out, JSON.stringify({ now: NOW, widgets, contents }));
