# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). This file is generated at
each release from the Conventional Commits: do not edit it by hand.

## [0.1.0] - unreleased

### Added

- One device per followed stop of the Naolib network of Nantes (three in the form and up to 10 more with the "Add a stop" button, typed by name, filtered by line and direction): the next departure as text, the wait of the next two departures and the delay of the next one, from the timetable corrected in real time.
- One device per followed line (up to six), trams, busways, Chronobus, buses and Navibus: its traffic state worked out from the alerts of Naolib (normal, traffic information, disrupted, heavily disrupted) and the number of traffic messages under way.
- Scene triggers: departure soon (2 to 20 minutes before, on the real-time estimate), departure cancelled, line disrupted, back to normal, and a new traffic message about a followed line.
- Scene actions: read the next departures of a stop (with the delay), and read the traffic of a line, each with a ready-made sentence.
- Dashboard widgets: the next departures of one or several stops, like the screens of the stops, with cancelled trips and delays highlighted (any stop can be typed in the widget); the traffic of lines with the full messages, their period and the map of a diversion, the three tram lines by default.
- Configuration actions: test the connection, find a stop by name (with its code and its lines), add, list and remove stops, and a diagnostic written to the Logs tab.
- Cloud transport: the official open data of Naolib, no account and no key; the GTFS of Nantes Métropole downloaded only when a new file is published, kept in /data and streamed within 256 MB, the GTFS-RT real time of every followed stop in one request every 30 seconds to 5 minutes and the alerts every 5 minutes through transport.data.gouv.fr, asked again when its source is busy.
- English, French, German and Spanish everywhere: settings, devices, widgets, scenes and documentation.

[0.1.0]: https://github.com/William-De71/gladys-naolib/releases/tag/v0.1.0
