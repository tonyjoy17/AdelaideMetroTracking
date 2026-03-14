/**
 * Adelaide Metro Tracker — Server v4
 * Memory-optimized + daily static refresh at 1:00 AM Adelaide time
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const AdmZip = require('adm-zip');
const { parse: parseCSV } = require('csv-parse/sync');
const GtfsRT = require('gtfs-realtime-bindings').transit_realtime;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(__dirname));

const V1 = 'https://gtfs.adelaidemetro.com.au/v1/realtime';
const V2 = 'https://gtfs.adelaidemetro.com.au/v2/realtime';
const ST = 'https://gtfs.adelaidemetro.com.au/v1/static/latest';

const OCCUPANCY_LABELS = {
  0: { label: 'Empty', emoji: '🟢', pct: 5 },
  1: { label: 'Many seats', emoji: '🟢', pct: 20 },
  2: { label: 'Few seats', emoji: '🟡', pct: 55 },
  3: { label: 'Standing room', emoji: '🟠', pct: 75 },
  4: { label: 'Limited standing', emoji: '🔴', pct: 90 },
  5: { label: 'Full', emoji: '🔴', pct: 100 },
  6: { label: 'Not accepting', emoji: '⛔', pct: 100 },
};

const store = {
  vehicles: [],
  trips: {},
  alerts: [],
  routes: {},
  trips_map: {},
  stops: {},

  // Compact stop_times
  // tripId -> "seq|stopId|time;seq|stopId|time;..."
  stop_times_compact: {},

  // Raw shapes text loaded lazily
  gtfsZip: null,
  shapesRaw: null,
  shapesCache: {},

  gtfsVersion: null,
  staticLoaded: false,

  lastUpdated: {
    vehicles: null,
    trips: null,
    alerts: null,
    static: null,
  },

  errors: {},
  caches: {
    tripStops: new Map(),
    departuresByStop: new Map(),
  },
};

const CACHE_LIMITS = {
  tripStops: 1500,
  departuresByStop: 500,
  shapes: 300,
};

function rememberInMap(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);

  if (map.size > limit) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

function clearRuntimeCaches() {
  store.caches.tripStops.clear();
  store.caches.departuresByStop.clear();
  store.shapesCache = {};
  store.shapesRaw = null;
}

function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 25000 }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }

      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout: ${url}`));
    });
  });
}

async function fetchText(url) {
  return (await fetchBuf(url)).toString('utf8');
}

function decode(buf) {
  try {
    return GtfsRT.FeedMessage.decode(buf);
  } catch (e) {
    console.error('[decode]', e.message);
    return null;
  }
}

function routeType(n) {
  n = parseInt(n, 10);
  if (n === 0) return 'tram';
  if (n === 1 || n === 2) return 'train';
  return 'bus';
}

function* iterLines(raw) {
  let start = 0;
  while (start < raw.length) {
    let end = raw.indexOf('\n', start);
    if (end === -1) end = raw.length;
    let line = raw.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    yield line;
    start = end + 1;
  }
}

function splitSimpleCsv(line) {
  return line.split(',');
}

function getZipTextFrom(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) return '';
  return entry.getData().toString('utf8');
}

function getZipText(name) {
  if (!store.gtfsZip) return '';
  return getZipTextFrom(store.gtfsZip, name);
}

function buildCompactStopTimes(raw) {
  const compact = {};
  const lines = iterLines(raw);
  const first = lines.next();

  if (first.done || !first.value) return compact;

  const headers = splitSimpleCsv(first.value);
  const tripIdx = headers.indexOf('trip_id');
  const arrIdx = headers.indexOf('arrival_time');
  const depIdx = headers.indexOf('departure_time');
  const stopIdx = headers.indexOf('stop_id');
  const seqIdx = headers.indexOf('stop_sequence');

  if ([tripIdx, arrIdx, depIdx, stopIdx, seqIdx].some(i => i === -1)) {
    throw new Error('stop_times.txt missing expected columns');
  }

  for (const line of lines) {
    if (!line) continue;

    const parts = splitSimpleCsv(line);
    const tripId = parts[tripIdx];
    const stopId = parts[stopIdx];
    const seq = parts[seqIdx];
    const time = parts[arrIdx] || parts[depIdx] || '';

    if (!tripId || !stopId || !seq) continue;

    const packed = `${seq}|${stopId}|${time}`;
    if (compact[tripId]) compact[tripId] += `;${packed}`;
    else compact[tripId] = packed;
  }

  return compact;
}

function parseTripStopsFromCompact(compactString) {
  if (!compactString) return [];

  return compactString
    .split(';')
    .filter(Boolean)
    .map(item => {
      const [seq, stopId, time] = item.split('|');
      return {
        seq: Number(seq),
        stopId,
        t: time || null,
      };
    })
    .sort((a, b) => a.seq - b.seq);
}

function getStopTimesForTrip(tripId) {
  if (!tripId) return [];

  const cached = store.caches.tripStops.get(tripId);
  if (cached) {
    rememberInMap(store.caches.tripStops, tripId, cached, CACHE_LIMITS.tripStops);
    return cached;
  }

  const compact = store.stop_times_compact[tripId];
  if (!compact) return [];

  const parsed = parseTripStopsFromCompact(compact);
  rememberInMap(store.caches.tripStops, tripId, parsed, CACHE_LIMITS.tripStops);
  return parsed;
}

function getDepartureRowsForStop(stopId) {
  const cached = store.caches.departuresByStop.get(stopId);
  if (cached) {
    rememberInMap(store.caches.departuresByStop, stopId, cached, CACHE_LIMITS.departuresByStop);
    return cached;
  }

  const results = [];
  const marker = `|${stopId}|`;

  for (const [tripId, compact] of Object.entries(store.stop_times_compact)) {
    if (!compact.includes(marker)) continue;

    const rows = compact.split(';');
    for (const row of rows) {
      if (!row.includes(marker)) continue;

      const [seq, stopIdValue, time] = row.split('|');
      results.push({
        tripId,
        seq: Number(seq),
        stopId: stopIdValue,
        t: time || null,
      });
    }
  }

  rememberInMap(store.caches.departuresByStop, stopId, results, CACHE_LIMITS.departuresByStop);
  return results;
}

function adelaideNowParts() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Adelaide' }));
  return now;
}

function serviceTimeToMillis(timeStr) {
  if (!timeStr) return null;
  const parts = String(timeStr).split(':').map(Number);
  if (parts.length < 2 || parts.some(Number.isNaN)) return null;
  const [hh = 0, mm = 0, ss = 0] = parts;
  const dt = adelaideNowParts();
  const dayOffset = Math.floor(hh / 24);
  dt.setDate(dt.getDate() + dayOffset);
  dt.setHours(hh % 24, mm, ss, 0);
  return dt.getTime();
}

function ensureShapesRawLoaded() {
  if (store.shapesRaw) return;
  store.shapesRaw = getZipText('shapes.txt') || '';
}

function getShapePoints(shapeId) {
  if (!shapeId) return null;
  if (store.shapesCache[shapeId]) return store.shapesCache[shapeId];

  ensureShapesRawLoaded();
  if (!store.shapesRaw) return null;

  const lines = iterLines(store.shapesRaw);
  const first = lines.next();

  if (first.done || !first.value) return null;

  const headers = splitSimpleCsv(first.value);
  const shapeIdIdx = headers.indexOf('shape_id');
  const latIdx = headers.indexOf('shape_pt_lat');
  const lonIdx = headers.indexOf('shape_pt_lon');
  const seqIdx = headers.indexOf('shape_pt_sequence');

  if ([shapeIdIdx, latIdx, lonIdx, seqIdx].some(i => i === -1)) {
    throw new Error('shapes.txt missing expected columns');
  }

  const points = [];

  for (const line of lines) {
    if (!line) continue;
    const parts = splitSimpleCsv(line);
    if (parts[shapeIdIdx] !== shapeId) continue;

    points.push({
      seq: Number(parts[seqIdx]),
      lat: parseFloat(parts[latIdx]),
      lon: parseFloat(parts[lonIdx]),
    });
  }

  if (!points.length) return null;

  points.sort((a, b) => a.seq - b.seq);

  if (Object.keys(store.shapesCache).length >= CACHE_LIMITS.shapes) {
    const firstKey = Object.keys(store.shapesCache)[0];
    delete store.shapesCache[firstKey];
  }

  store.shapesCache[shapeId] = points;
  return points;
}

// ── STATIC GTFS ──
async function loadStatic(force = false) {
  try {
    const ver = (await fetchText(`${ST}/version.txt`)).trim();

    if (!force && ver === store.gtfsVersion && store.staticLoaded) {
      console.log('[GTFS] Static already up to date');
      return;
    }

    console.log('[GTFS] Downloading v' + ver);
    const zipBuf = await fetchBuf(`${ST}/google_transit.zip`);
    const zip = new AdmZip(zipBuf);

    const csv = (name) => {
      const entry = zip.getEntry(name);
      if (!entry) return [];
      return parseCSV(entry.getData().toString('utf8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    };

    // Lightweight tables
    store.routes = {};
    csv('routes.txt').forEach((r) => {
      store.routes[r.route_id] = {
        shortName: r.route_short_name || r.route_id,
        longName: r.route_long_name || '',
        type: routeType(r.route_type),
      };
    });

    store.trips_map = {};
    csv('trips.txt').forEach((t) => {
      store.trips_map[t.trip_id] = {
        routeId: t.route_id,
        shapeId: t.shape_id,
        headsign: t.trip_headsign || '',
        directionId: t.direction_id,
      };
    });

    store.stops = {};
    csv('stops.txt').forEach((s) => {
      store.stops[s.stop_id] = {
        name: s.stop_name,
        lat: parseFloat(s.stop_lat),
        lon: parseFloat(s.stop_lon),
        code: s.stop_code || '',
      };
    });

    // Compact stop_times
    const stopTimesRaw = getZipTextFrom(zip, 'stop_times.txt');
    store.stop_times_compact = buildCompactStopTimes(stopTimesRaw);

    // Keep zip for lazy shape loading
    store.gtfsZip = zip;

    clearRuntimeCaches();

    store.gtfsVersion = ver;
    store.staticLoaded = true;
    store.lastUpdated.static = new Date().toISOString();
    delete store.errors.static;

    console.log(
      `[GTFS] Done. Routes:${Object.keys(store.routes).length} Stops:${Object.keys(store.stops).length} Trips:${Object.keys(store.trips_map).length}`
    );
  } catch (e) {
    console.error('[GTFS]', e.message);
    store.errors.static = e.message;
  }
}

// ── REALTIME ──
async function pollVehicles() {
  try {
    const [bufV1, bufV2] = await Promise.allSettled([
      fetchBuf(`${V1}/vehicle_positions`),
      fetchBuf(`${V2}/vehicle_positions`),
    ]);

    const feedV1 = bufV1.status === 'fulfilled' ? decode(bufV1.value) : null;
    const feedV2 = bufV2.status === 'fulfilled' ? decode(bufV2.value) : null;

    const occupancyMap = {};
    if (feedV2) {
      feedV2.entity
        .filter(e => e.vehicle)
        .forEach(e => {
          const id = String(e.vehicle.vehicle?.id || e.id || '');
          const occ = e.vehicle.occupancyStatus;
          if (occ !== undefined && occ !== null) occupancyMap[id] = occ;
        });
    }

    if (!feedV1) throw new Error('v1 feed failed');

    store.vehicles = feedV1.entity
      .filter(e => e.vehicle?.position)
      .map(e => {
        const v = e.vehicle;
        const pos = v.position;
        const tripId = v.trip?.tripId || '';
        const routeId = v.trip?.routeId || '';
        const tm = store.trips_map[tripId] || {};
        const rid = tm.routeId || routeId;
        const rm = store.routes[rid] || {};
        const vid = String(v.vehicle?.id || e.id || '');
        const occ = occupancyMap[vid] ?? v.occupancyStatus ?? null;

        return {
          vehicleId: vid,
          label: String(v.vehicle?.label || vid),
          tripId,
          routeId: rid,
          routeShort: rm.shortName || rid || routeId,
          routeLong: rm.longName || '',
          routeType: rm.type || 'bus',
          headsign: tm.headsign || '',
          shapeId: tm.shapeId || '',
          directionId: tm.directionId,
          lat: pos.latitude,
          lon: pos.longitude,
          bearing: pos.bearing || 0,
          speed: Math.round((pos.speed || 0) * 3.6 * 10) / 10,
          status: String(v.currentStatus || 'IN_TRANSIT_TO'),
          stopSeq: v.currentStopSequence || 0,
          timestamp: v.timestamp ? Number(v.timestamp) : 0,
          occupancy: occ !== null
            ? { status: occ, ...(OCCUPANCY_LABELS[occ] || { label: 'Unknown', emoji: '⬜', pct: 0 }) }
            : null,
        };
      });

    store.lastUpdated.vehicles = new Date().toISOString();
    delete store.errors.vehicles;
    console.log(`[Vehicles] ${store.vehicles.length} (${Object.keys(occupancyMap).length} with occupancy)`);
  } catch (e) {
    console.error('[Vehicles]', e.message);
    store.errors.vehicles = e.message;
  }
}

async function pollTrips() {
  try {
    const feed = decode(await fetchBuf(`${V1}/trip_updates`));
    if (!feed) throw new Error('decode failed');

    store.trips = {};

    feed.entity
      .filter(e => e.tripUpdate)
      .forEach(e => {
        const tu = e.tripUpdate;
        const tripId = tu.trip?.tripId;
        if (!tripId) return;

        const ss = getStopTimesForTrip(tripId);

        store.trips[tripId] = {
          tripId,
          routeId: tu.trip?.routeId || '',
          stopUpdates: (tu.stopTimeUpdate || []).map(stu => {
            const sid = stu.stopId || '';
            const si = store.stops[sid] || {};
            const seq = stu.stopSequence || 0;
            const se = ss.find(s => s.seq === seq || s.stopId === sid);
            const arrTs = stu.arrival?.time ? Number(stu.arrival.time) : null;
            const depTs = stu.departure?.time ? Number(stu.departure.time) : null;
            const delay = Number(stu.arrival?.delay || stu.departure?.delay || 0);

            return {
              sequence: seq,
              stopId: sid,
              stopName: si.name || sid,
              stopLat: si.lat || null,
              stopLon: si.lon || null,
              scheduledTime: se?.t || null,
              arrivalTime: arrTs ? new Date(arrTs * 1000).toISOString() : null,
              departureTime: depTs ? new Date(depTs * 1000).toISOString() : null,
              delay,
              delayMin: Math.round(delay / 60),
            };
          }),
        };
      });

    store.lastUpdated.trips = new Date().toISOString();
    delete store.errors.trips;
    console.log(`[Trips] ${Object.keys(store.trips).length}`);
  } catch (e) {
    console.error('[Trips]', e.message);
    store.errors.trips = e.message;
  }
}

async function pollAlerts() {
  try {
    const feed = decode(await fetchBuf(`${V1}/service_alerts`));
    if (!feed) throw new Error('decode failed');

    const getText = (ts) => {
      if (!ts?.translation?.length) return '';
      const en = ts.translation.find(t => !t.language || t.language === 'en');
      return (en || ts.translation[0])?.text || '';
    };

    store.alerts = feed.entity
      .filter(e => e.alert)
      .map(e => {
        const a = e.alert;
        return {
          id: String(e.id),
          cause: a.cause || 0,
          effect: a.effect || 0,
          header: getText(a.headerText),
          description: getText(a.descriptionText),
          routes: [...new Set((a.informedEntity || []).map(ie => ie.routeId || ie.trip?.routeId || '').filter(Boolean))],
          stops: [...new Set((a.informedEntity || []).map(ie => ie.stopId || '').filter(Boolean))],
          activePeriods: (a.activePeriod || []).map(p => ({
            start: p.start ? Number(p.start) : null,
            end: p.end ? Number(p.end) : null,
          })),
        };
      });

    store.lastUpdated.alerts = new Date().toISOString();
    delete store.errors.alerts;
    console.log(`[Alerts] ${store.alerts.length}`);
  } catch (e) {
    console.error('[Alerts]', e.message);
    store.errors.alerts = e.message;
  }
}

// ── HELPERS ──
function staticStops(tripId, fromSeq = 0) {
  return getStopTimesForTrip(tripId)
    .filter(s => s.seq >= fromSeq)
    .slice(0, 12)
    .map(s => {
      const si = store.stops[s.stopId] || {};
      return {
        sequence: s.seq,
        stopId: s.stopId,
        stopName: si.name || s.stopId,
        stopLat: si.lat || null,
        stopLon: si.lon || null,
        scheduledTime: s.t,
        arrivalTime: null,
        departureTime: null,
        delay: 0,
        delayMin: 0,
      };
    });
}

function upcomingStopsFor(v) {
  const seq = v.stopSeq || 0;
  const td = store.trips[v.tripId];

  if (td && td.stopUpdates.length) {
    let stops = td.stopUpdates.filter(s => s.sequence >= seq);

    if (!stops.length || seq === 0) {
      const now = Date.now();
      stops = td.stopUpdates.filter(s => {
        const t = s.arrivalTime || s.departureTime;
        return !t || new Date(t).getTime() >= now - 90000;
      });
    }

    if (!stops.length) stops = td.stopUpdates.slice(-3);
    return stops.slice(0, 10);
  }

  let stops = staticStops(v.tripId, seq);

  if (!stops.length || seq === 0) {
    const nowStr = new Date().toLocaleTimeString('en-AU', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Australia/Adelaide',
    }).replace(/^24:/, '00:');

    const all = staticStops(v.tripId, 0);
    const future = all.filter(s => (s.scheduledTime || '') >= nowStr);
    stops = future.length ? future : all.slice(-3);
  }

  return stops.slice(0, 10);
}

function scheduleDailyStaticLoad() {
  const now = new Date();
  const adelaideNow = new Date(
    now.toLocaleString('en-US', { timeZone: 'Australia/Adelaide' })
  );

  const nextRun = new Date(adelaideNow);
  nextRun.setHours(1, 0, 0, 0);

  if (adelaideNow >= nextRun) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  const delay = nextRun.getTime() - adelaideNow.getTime();

  console.log(`[GTFS] Next static refresh at ${nextRun.toString()} Adelaide time`);

  setTimeout(async () => {
    try {
      console.log('[GTFS] Running scheduled daily static refresh');
      await loadStatic(true);
    } catch (err) {
      console.error('[GTFS] Scheduled static refresh failed', err);
    } finally {
      scheduleDailyStaticLoad();
    }
  }, delay);
}

// ── API ──
app.get('/api/vehicles', (req, res) => {
  res.json({
    timestamp: store.lastUpdated.vehicles,
    count: store.vehicles.length,
    vehicles: store.vehicles.map(v => ({
      ...v,
      upcomingStops: upcomingStopsFor(v),
      alerts: store.alerts.filter(a => a.routes.includes(v.routeId) || a.routes.includes(v.routeShort)),
    })),
  });
});

app.get('/api/trips/:tripId', (req, res) => {
  const { tripId } = req.params;
  const tu = store.trips[tripId];
  const st = staticStops(tripId, 0);

  if (!tu && !st.length) {
    return res.status(404).json({ error: 'not found' });
  }

  res.json({
    tripId,
    stops: tu ? tu.stopUpdates : st,
    hasRealtime: !!tu,
  });
});

app.get('/api/alerts', (req, res) => {
  res.json({
    timestamp: store.lastUpdated.alerts,
    count: store.alerts.length,
    alerts: store.alerts,
  });
});

app.get('/api/shape/:shapeId', (req, res) => {
  try {
    const points = getShapePoints(req.params.shapeId);
    if (!points) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json({ shapeId: req.params.shapeId, points });
  } catch (e) {
    console.error('[Shape]', e.message);
    res.status(500).json({ error: 'shape load failed' });
  }
});

app.get('/api/stops/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();

  if (!q || q.length < 2) {
    return res.json({ stops: [] });
  }

  const results = Object.entries(store.stops)
    .filter(([id, s]) =>
      s.name?.toLowerCase().includes(q) ||
      s.code?.toLowerCase().includes(q) ||
      id.toLowerCase().includes(q)
    )
    .slice(0, 20)
    .map(([id, s]) => ({
      stopId: id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      code: s.code,
    }));

  res.json({ stops: results });
});

app.get('/api/stops/nearby', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = parseFloat(req.query.radius) || 800;

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.json({ stops: [] });
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  const stopRouteTypes = {};

  Object.entries(store.trips_map || {}).forEach(([tripId, trip]) => {
    const route = store.routes[trip.routeId] || {};
    const type = route.type === 0 ? 'tram' : route.type === 2 ? 'train' : 'bus';
    const stops = getStopTimesForTrip(tripId);

    stops.forEach(s => {
      if (!stopRouteTypes[s.stopId]) stopRouteTypes[s.stopId] = new Set();
      stopRouteTypes[s.stopId].add(type);
    });
  });

  const results = Object.entries(store.stops)
    .filter(([, s]) => s.lat && s.lon)
    .map(([id, s]) => {
      const dist = haversine(lat, lon, s.lat, s.lon);
      return {
        stopId: id,
        name: s.name,
        code: s.code,
        lat: s.lat,
        lon: s.lon,
        dist,
        routeTypes: [...(stopRouteTypes[id] || [])],
      };
    })
    .filter(s => s.dist <= radius)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 30);

  res.json({ stops: results });
});

app.get('/api/stops/:stopId/departures', (req, res) => {
  const { stopId } = req.params;
  const departures = [];
  const stopRows = getDepartureRowsForStop(stopId);

  stopRows.forEach(stopEntry => {
    const tripId = stopEntry.tripId;
    const tm = store.trips_map[tripId] || {};
    const rm = store.routes[tm.routeId] || {};
    const tu = store.trips[tripId];

    let realtimeTime = null;
    let delay = 0;

    if (tu) {
      const rts = tu.stopUpdates.find(
        s => s.stopId === stopId || s.sequence === stopEntry.seq
      );

      if (rts) {
        realtimeTime = rts.arrivalTime || rts.departureTime;
        delay = rts.delay || 0;
      }
    }

    const vehicle = store.vehicles.find(v => v.tripId === tripId);

    departures.push({
      tripId,
      routeId: tm.routeId || '',
      routeShort: rm.shortName || tm.routeId || '',
      routeLong: rm.longName || '',
      routeType: rm.type || 'bus',
      headsign: tm.headsign || '',
      scheduledTime: stopEntry.t,
      realtimeTime,
      delay,
      delayMin: Math.round(delay / 60),
      vehicleId: vehicle?.vehicleId || null,
      occupancy: vehicle?.occupancy || null,
    });
  });

  departures.sort((a, b) => (a.scheduledTime || '').localeCompare(b.scheduledTime || ''));

  res.json({
    stopId,
    stopName: store.stops[stopId]?.name || stopId,
    departures,
  });
});

app.get('/api/plan', (req, res) => {
  const fromStopId = String(req.query.fromStopId || '').trim();
  const toStopId = String(req.query.toStopId || '').trim();

  if (!fromStopId || !toStopId) {
    return res.status(400).json({ error: 'fromStopId and toStopId are required' });
  }

  if (fromStopId === toStopId) {
    return res.json({
      fromStopId,
      toStopId,
      fromStopName: store.stops[fromStopId]?.name || fromStopId,
      toStopName: store.stops[toStopId]?.name || toStopId,
      options: [],
    });
  }

  const now = Date.now();
  const options = [];

  Object.entries(store.trips_map || {}).forEach(([tripId, trip]) => {
    const stops = getStopTimesForTrip(tripId);
    if (!stops.length) return;

    const fromIdx = stops.findIndex(s => s.stopId === fromStopId);
    const toIdx = stops.findIndex((s, i) => i > fromIdx && s.stopId === toStopId);
    if (fromIdx === -1 || toIdx === -1) return;

    const fromStop = stops[fromIdx];
    const toStop = stops[toIdx];
    const route = store.routes[trip.routeId] || {};
    const tripUpdate = store.trips[tripId];
    const fromRt = tripUpdate?.stopUpdates?.find(s => s.sequence === fromStop.seq || s.stopId === fromStopId);
    const toRt = tripUpdate?.stopUpdates?.find(s => s.sequence === toStop.seq || s.stopId === toStopId);

    const departureRealtime = fromRt?.arrivalTime || fromRt?.departureTime || null;
    const arrivalRealtime = toRt?.arrivalTime || toRt?.departureTime || null;
    const departureTs = departureRealtime ? new Date(departureRealtime).getTime() : serviceTimeToMillis(fromStop.t);
    const arrivalTs = arrivalRealtime ? new Date(arrivalRealtime).getTime() : serviceTimeToMillis(toStop.t);

    if (departureTs && departureTs < now - 60000) return;

    const vehicle = store.vehicles.find(v => v.tripId === tripId);
    options.push({
      tripId,
      routeId: trip.routeId || '',
      routeShort: route.shortName || trip.routeId || '',
      routeLong: route.longName || '',
      routeType: route.type || 'bus',
      headsign: trip.headsign || '',
      fromStopId,
      fromStopName: store.stops[fromStopId]?.name || fromStopId,
      toStopId,
      toStopName: store.stops[toStopId]?.name || toStopId,
      departureScheduled: fromStop.t || null,
      arrivalScheduled: toStop.t || null,
      departureRealtime,
      arrivalRealtime,
      departureDelay: fromRt?.delay || 0,
      arrivalDelay: toRt?.delay || 0,
      departureTs: departureTs || null,
      arrivalTs: arrivalTs || null,
      stopsBetween: Math.max(0, toIdx - fromIdx - 1),
      vehicleId: vehicle?.vehicleId || null,
      occupancy: vehicle?.occupancy || null,
    });
  });

  options.sort((a, b) => (a.departureTs || Number.MAX_SAFE_INTEGER) - (b.departureTs || Number.MAX_SAFE_INTEGER));

  res.json({
    fromStopId,
    toStopId,
    fromStopName: store.stops[fromStopId]?.name || fromStopId,
    toStopName: store.stops[toStopId]?.name || toStopId,
    options: options.slice(0, 20),
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    staticLoaded: store.staticLoaded,
    gtfsVersion: store.gtfsVersion,
    lastUpdated: store.lastUpdated,
    errors: store.errors,
    counts: {
      vehicles: store.vehicles.length,
      trips: Object.keys(store.trips).length,
      alerts: store.alerts.length,
      routes: Object.keys(store.routes).length,
      stops: Object.keys(store.stops).length,
    },
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    staticLoaded: store.staticLoaded,
    gtfsVersion: store.gtfsVersion,
    lastUpdated: store.lastUpdated,
    errors: store.errors,
  });
});

// ── START ──
async function start() {
  console.log('Adelaide Metro Tracker v4');

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✓ Server running on port ${PORT}`);
  });

  try {
    await loadStatic();
    await Promise.all([pollVehicles(), pollTrips(), pollAlerts()]);
  } catch (e) {
    console.error('Initial data load failed:', e);
  }

  setInterval(() => {
    pollVehicles().catch(err => console.error('pollVehicles', err));
  }, 15_000);

  setInterval(() => {
    pollTrips().catch(err => console.error('pollTrips', err));
  }, 60_000);

  setInterval(() => {
    pollAlerts().catch(err => console.error('pollAlerts', err));
  }, 5 * 60_000);

  scheduleDailyStaticLoad();
}

start().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
