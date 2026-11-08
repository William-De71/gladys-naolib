// -----------------------------------------------------------------------------
// A GTFS Realtime decoder, without dependency: the feeds of Naolib are
// Protocol Buffers (https://gtfs.org/realtime/proto/), and the integration
// only needs a few messages of them. Fields not listed here are skipped.
//
//   FeedMessage   1 header (3 timestamp), 2 entity*
//   FeedEntity    1 id, 2 is_deleted, 3 trip_update, 5 alert
//   TripUpdate    1 trip, 2 stop_time_update*, 4 timestamp, 5 delay
//   TripDescriptor 1 trip_id, 2 start_time, 3 start_date,
//                 4 schedule_relationship (3 CANCELED, 7 DELETED), 5 route_id,
//                 6 direction_id
//   StopTimeUpdate 1 stop_sequence, 2 arrival, 3 departure, 4 stop_id,
//                 5 schedule_relationship (1 SKIPPED, 2 NO_DATA)
//   StopTimeEvent 1 delay (int32, seconds), 2 time (int64, Unix seconds)
//   Alert         1 active_period* (1 start, 2 end), 5 informed_entity*
//                 (2 route_id, 5 stop_id), 6 cause, 7 effect, 8 url,
//                 10 header_text, 11 description_text, 14 severity_level
//   TranslatedString 1 translation* (1 text, 2 language)
// -----------------------------------------------------------------------------

const WIRE = { VARINT: 0, I64: 1, LEN: 2, I32: 5 };
const TRIP_CANCELLED = new Set([3, 7]);
const STOP_SKIPPED = 1;
const STOP_NO_DATA = 2;

class FeedError extends Error {
  /**
   * @param {string} message - The detail.
   */
  constructor(message) {
    super(message);
    this.name = 'FeedError';
    this.kind = 'invalid';
  }
}

/**
 * @description Read a varint.
 * @param {Uint8Array} buf - The bytes.
 * @param {number} offset - Where it starts.
 * @returns {[bigint, number]} The value (unsigned, 64 bits) and the next offset.
 */
function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let index = offset;
  for (;;) {
    if (index >= buf.length || shift > 63n) {
      throw new FeedError('truncated varint');
    }
    const byte = buf[index];
    index += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if (byte < 0x80) {
      return [value, index];
    }
    shift += 7n;
  }
}

/**
 * @description The fields of a message, in order.
 * @param {Uint8Array} buf - The bytes of the message.
 * @returns {Array<[number, bigint|Uint8Array]>} `[field, value]`: a varint as
 * a bigint, a length-delimited field as its bytes; fixed-size ones skipped.
 */
function fields(buf) {
  const list = [];
  let offset = 0;
  while (offset < buf.length) {
    const [tag, next] = readVarint(buf, offset);
    offset = next;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === WIRE.VARINT) {
      const [value, after] = readVarint(buf, offset);
      list.push([field, value]);
      offset = after;
    } else if (wire === WIRE.LEN) {
      const [length, after] = readVarint(buf, offset);
      const end = after + Number(length);
      if (end > buf.length) {
        throw new FeedError('truncated field');
      }
      list.push([field, buf.subarray(after, end)]);
      offset = end;
    } else if (wire === WIRE.I64) {
      offset += 8;
    } else if (wire === WIRE.I32) {
      offset += 4;
    } else {
      throw new FeedError(`wire type ${wire}`);
    }
  }
  if (offset !== buf.length) {
    throw new FeedError('truncated message');
  }
  return list;
}

const decoder = new TextDecoder('utf-8');
const text = (value) => (value instanceof Uint8Array ? decoder.decode(value) : '');
const unsigned = (value) => (typeof value === 'bigint' ? Number(value) : null);
// An int32 / int64 written as a varint: negative values take 64 bits.
const signed = (value) => (typeof value === 'bigint' ? Number(BigInt.asIntN(64, value)) : null);
const bytes = (value) => (value instanceof Uint8Array ? value : new Uint8Array(0));

/**
 * @description A translated string, French first.
 * @param {Uint8Array} buf - The TranslatedString.
 * @returns {string} The text.
 */
function translated(buf) {
  const texts = [];
  for (const [field, value] of fields(buf)) {
    if (field !== 1) {
      continue;
    }
    const entry = { text: '', language: '' };
    for (const [key, part] of fields(bytes(value))) {
      if (key === 1) {
        entry.text = text(part);
      } else if (key === 2) {
        entry.language = text(part).toLowerCase();
      }
    }
    texts.push(entry);
  }
  const french = texts.find((entry) => entry.language.startsWith('fr'));
  return (french ?? texts.find((entry) => !entry.language) ?? texts[0])?.text ?? '';
}

/**
 * @description A stop time event.
 * @param {Uint8Array} buf - The StopTimeEvent.
 * @returns {{ delay: number|null, time: number|null }} Seconds, Unix seconds.
 */
function stopTimeEvent(buf) {
  const event = { delay: null, time: null };
  for (const [field, value] of fields(buf)) {
    if (field === 1) {
      event.delay = signed(value);
    } else if (field === 2) {
      event.time = signed(value);
    }
  }
  return event;
}

/**
 * @description A trip update.
 * @param {Uint8Array} buf - The TripUpdate.
 * @returns {object} `{ tripId, routeId, directionId, startDate, cancelled,
 * delay, timestamp, stops: [{ sequence, stopId, arrival, departure, skipped, noData }] }`.
 */
function tripUpdate(buf) {
  const update = {
    tripId: '',
    routeId: '',
    directionId: null,
    startDate: '',
    cancelled: false,
    delay: null,
    timestamp: null,
    stops: [],
  };
  for (const [field, value] of fields(buf)) {
    if (field === 1) {
      for (const [key, part] of fields(bytes(value))) {
        if (key === 1) {
          update.tripId = text(part);
        } else if (key === 3) {
          update.startDate = text(part);
        } else if (key === 4) {
          update.cancelled = TRIP_CANCELLED.has(unsigned(part));
        } else if (key === 5) {
          update.routeId = text(part);
        } else if (key === 6) {
          update.directionId = unsigned(part);
        }
      }
    } else if (field === 2) {
      const stop = {
        sequence: null,
        stopId: '',
        arrival: null,
        departure: null,
        skipped: false,
        noData: false,
      };
      for (const [key, part] of fields(bytes(value))) {
        if (key === 1) {
          stop.sequence = unsigned(part);
        } else if (key === 2) {
          stop.arrival = stopTimeEvent(bytes(part));
        } else if (key === 3) {
          stop.departure = stopTimeEvent(bytes(part));
        } else if (key === 4) {
          stop.stopId = text(part);
        } else if (key === 5) {
          stop.skipped = unsigned(part) === STOP_SKIPPED;
          stop.noData = unsigned(part) === STOP_NO_DATA;
        }
      }
      update.stops.push(stop);
    } else if (field === 4) {
      update.timestamp = unsigned(value);
    } else if (field === 5) {
      update.delay = signed(value);
    }
  }
  return update;
}

/**
 * @description An alert.
 * @param {string} id - The id of its entity.
 * @param {Uint8Array} buf - The Alert.
 * @returns {object} `{ id, periods: [{ start, end }], routeIds, stopIds,
 * cause, effect, severity, url, header, description }`, times in Unix seconds.
 */
function alert(id, buf) {
  const result = {
    id,
    periods: [],
    routeIds: [],
    stopIds: [],
    cause: null,
    effect: null,
    severity: null,
    url: '',
    header: '',
    description: '',
  };
  for (const [field, value] of fields(buf)) {
    if (field === 1) {
      const period = { start: null, end: null };
      for (const [key, part] of fields(bytes(value))) {
        if (key === 1) {
          period.start = unsigned(part) || null;
        } else if (key === 2) {
          period.end = unsigned(part) || null;
        }
      }
      result.periods.push(period);
    } else if (field === 5) {
      for (const [key, part] of fields(bytes(value))) {
        if (key === 2) {
          result.routeIds.push(text(part));
        } else if (key === 5) {
          result.stopIds.push(text(part));
        }
      }
    } else if (field === 6) {
      result.cause = unsigned(value);
    } else if (field === 7) {
      result.effect = unsigned(value);
    } else if (field === 8) {
      result.url = translated(bytes(value));
    } else if (field === 10) {
      result.header = translated(bytes(value));
    } else if (field === 11) {
      result.description = translated(bytes(value));
    } else if (field === 14) {
      result.severity = unsigned(value);
    }
  }
  return result;
}

/**
 * @description Decode a feed.
 * @param {Uint8Array} buf - The FeedMessage.
 * @returns {{ timestamp: number|null, tripUpdates: object[], alerts: object[] }}
 * The time of the feed (Unix seconds) and its trip updates and alerts;
 * deleted entities left out.
 * @throws {FeedError} When the bytes are not a feed.
 */
function decodeFeed(buf) {
  const feed = { timestamp: null, tripUpdates: [], alerts: [] };
  let header = false;
  for (const [field, value] of fields(bytes(buf))) {
    if (field === 1) {
      header = true;
      for (const [key, part] of fields(bytes(value))) {
        if (key === 3) {
          feed.timestamp = unsigned(part);
        }
      }
    } else if (field === 2) {
      let id = '';
      let deleted = false;
      const parts = [];
      for (const [key, part] of fields(bytes(value))) {
        if (key === 1) {
          id = text(part);
        } else if (key === 2) {
          deleted = part === 1n;
        } else if (key === 3 || key === 5) {
          parts.push([key, part]);
        }
      }
      if (deleted) {
        continue;
      }
      for (const [key, part] of parts) {
        if (key === 3) {
          feed.tripUpdates.push(tripUpdate(bytes(part)));
        } else {
          feed.alerts.push(alert(id, bytes(part)));
        }
      }
    }
  }
  if (!header) {
    throw new FeedError('no feed header');
  }
  return feed;
}

export { FeedError, readVarint, fields, decodeFeed };
