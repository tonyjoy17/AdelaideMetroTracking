/**
 * Adelaide Metro Tracker — Server
 * Runtime reads prepared local static data only.
 * GTFS ZIP sync is handled separately by scripts outside the app runtime.
 */

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const https = require('https');
const fs = require('fs/promises');
const path = require('path');
const GtfsRT = require('gtfs-realtime-bindings').transit_realtime;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(compression({ threshold: 1024 }));
app.use(express.static(__dirname));

const V1 = 'https://gtfs.adelaidemetro.com.au/v1/realtime';
const V2 = 'https://gtfs.adelaidemetro.com.au/v2/realtime';
const STATIC_DATA_DIR = process.env.STATIC_DATA_DIR || path.join(__dirname, 'data', 'static', 'current');
const STOP_SEARCH_INDEX_FILE = path.join(__dirname, 'static', 'stop-search-index.js');

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
  vehicleByTrip: {},
  trips: {},
  alerts: [],
  routeAlertCounts: {},
  routes: {},
  trips_map: {},
  stops: {},
  stopSearchIndex: [],
  stop_times_compact: {},
  stopTripIndex: {},
  shapesById: null,
  gtfsVersion: null,
  staticLoaded: false,
  lastUpdated: {
    vehicles: null,
    trips: null,
    alerts: null,
    static: null,
  },
  errors: {},
  stopRouteTypes: {},
  caches: {
    tripStops: new Map(),
    departuresByStop: new Map(),
  },
  signatures: {
    vehicles: null,
  },
};

const CACHE_LIMITS = {
  tripStops: 1500,
  departuresByStop: 500,
};

const sseClients = new Set();
const SSE_PING_MS = 25000;

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
  store.shapesById = null;
}

function matchedAlertsForVehicle(vehicle) {
  return store.alerts.filter((alert) => alert.routes.includes(vehicle.routeId) || alert.routes.includes(vehicle.routeShort));
}

function alertCountForVehicle(vehicle) {
  return (store.routeAlertCounts[vehicle.routeId] || 0) + (store.routeAlertCounts[vehicle.routeShort] || 0);
}

function serializeVehicleSummary(vehicle) {
  return {
    vehicleId: vehicle.vehicleId,
    label: vehicle.label,
    tripId: vehicle.tripId,
    routeId: vehicle.routeId,
    routeShort: vehicle.routeShort,
    routeLong: vehicle.routeLong,
    routeType: vehicle.routeType,
    headsign: vehicle.headsign,
    shapeId: vehicle.shapeId,
    directionId: vehicle.directionId,
    lat: vehicle.lat,
    lon: vehicle.lon,
    bearing: vehicle.bearing,
    speed: vehicle.speed,
    status: vehicle.status,
    stopSeq: vehicle.stopSeq,
    timestamp: vehicle.timestamp,
    occupancy: vehicle.occupancy,
    alertCount: alertCountForVehicle(vehicle),
  };
}

function vehiclesPayload() {
  return {
    timestamp: store.lastUpdated.vehicles,
    count: store.vehicles.length,
    vehicles: store.vehicles.map(serializeVehicleSummary),
  };
}

function alertsPayload() {
  return {
    timestamp: store.lastUpdated.alerts,
    count: store.alerts.length,
    alerts: store.alerts,
  };
}

function broadcastVehiclesIfChanged() {
  const vehicles = store.vehicles.map(serializeVehicleSummary);
  const nextSignature = JSON.stringify(vehicles);
  if (nextSignature === store.signatures.vehicles) return;
  store.signatures.vehicles = nextSignature;
  broadcastSse('vehicles', {
    timestamp: store.lastUpdated.vehicles,
    count: vehicles.length,
    vehicles,
  });
}

function writeSseEvent(res, event, payload) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function broadcastSse(event, payload) {
  for (const client of [...sseClients]) {
    try {
      writeSseEvent(client, event, payload);
    } catch (error) {
      sseClients.delete(client);
      try { client.end(); } catch {}
    }
  }
}

setInterval(() => {
  for (const client of [...sseClients]) {
    try {
      client.write(': ping\n\n');
    } catch (error) {
      sseClients.delete(client);
      try { client.end(); } catch {}
    }
  }
}, SSE_PING_MS);

function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 25000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
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

function decode(buf) {
  try {
    return GtfsRT.FeedMessage.decode(buf);
  } catch (e) {
    console.error('[decode]', e.message);
    return null;
  }
}

function parseTripStopsFromCompact(compactString) {
  if (!compactString) return [];
  return compactString
    .split(';')
    .filter(Boolean)
    .map((item) => {
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

  const results = store.stopTripIndex[stopId] || [];

  rememberInMap(store.caches.departuresByStop, stopId, results, CACHE_LIMITS.departuresByStop);
  return results;
}

function buildStopTimeLookup(stops) {
  const bySeq = new Map();
  const byStopId = new Map();
  stops.forEach((stop) => {
    if (stop.seq) bySeq.set(stop.seq, stop);
    if (stop.stopId && !byStopId.has(stop.stopId)) byStopId.set(stop.stopId, stop);
  });
  return { bySeq, byStopId };
}

function stopTimeMatch(lookup, seq, stopId) {
  if (seq && lookup.bySeq.has(seq)) return lookup.bySeq.get(seq);
  if (stopId && lookup.byStopId.has(stopId)) return lookup.byStopId.get(stopId);
  return null;
}

function adelaideTimeParts(timeMs) {
  const d = new Date(timeMs);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Adelaide', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
  }).formatToParts(d);
  const get = (type) => parseInt(parts.find(p => p.type === type).value, 10);
  return { y: get('year'), m: get('month') - 1, d: get('day'), h: get('hour') === 24 ? 0 : get('hour'), min: get('minute'), s: get('second') };
}

function getAdelaideEpoch(y, m, d, h, min, s) {
  const clockUTC = Date.UTC(y, m, d, h, min, s);
  const guessEpoch = clockUTC - 34200000;
  const p = adelaideTimeParts(guessEpoch);
  const actualClock = Date.UTC(p.y, p.m, p.d, p.h, p.min, p.s);
  return guessEpoch + (clockUTC - actualClock);
}

const SERVICE_DAY_ROLLOVER_HOUR = 4;

function serviceTimeToMillis(timeStr) {
  if (!timeStr) return null;
  const parts = String(timeStr).split(':').map(Number);
  if (parts.length < 2 || parts.some(Number.isNaN)) return null;
  const [hh = 0, mm = 0, ss = 0] = parts;

  const adl = adelaideTimeParts(Date.now());
  let { y, m, d } = adl;
  if (adl.h < SERVICE_DAY_ROLLOVER_HOUR) {
    const prev = new Date(Date.UTC(y, m, d - 1));
    y = prev.getUTCFullYear(); m = prev.getUTCMonth(); d = prev.getUTCDate();
  }
  return getAdelaideEpoch(y, m, d + Math.floor(hh / 24), hh % 24, mm, ss);
}

async function readJson(fileName) {
  const fullPath = path.join(STATIC_DATA_DIR, fileName);
  const raw = await fs.readFile(fullPath, 'utf8');
  return JSON.parse(raw);
}

async function writeStopSearchIndexFile() {
  const payload = `window.__STOP_SEARCH_INDEX__ = ${JSON.stringify(store.stopSearchIndex)};\n`;
  await fs.writeFile(STOP_SEARCH_INDEX_FILE, payload, 'utf8');
}

async function ensureShapesLoaded() {
  if (store.shapesById) return;
  try {
    store.shapesById = await readJson('shapes.json');
  } catch (e) {
    store.shapesById = {};
    throw e;
  }
}

async function getShapePoints(shapeId) {
  if (!shapeId) return null;
  await ensureShapesLoaded();
  return store.shapesById[shapeId] || null;
}

async function loadStatic(force = false) {
  try {
    const manifest = await readJson('manifest.json');
    const version = manifest.version || 'unknown';

    if (!force && version === store.gtfsVersion && store.staticLoaded) {
      console.log('[GTFS] Local static data already current');
      return;
    }

    const [routes, trips, stops, stopTimesCompact] = await Promise.all([
      readJson('routes.json'),
      readJson('trips.json'),
      readJson('stops.json'),
      readJson('stop_times_compact.json'),
    ]);

    store.routes = routes || {};
    store.trips_map = trips || {};
    store.stops = stops || {};
    store.stopSearchIndex = Object.entries(store.stops).map(([id, stop]) => ({
      stopId: id,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      code: stop.code,
    }));
    await writeStopSearchIndexFile();
    store.stop_times_compact = stopTimesCompact || {};
    store.shapesById = null;
    clearRuntimeCaches();

    store.stopRouteTypes = {};
    store.stopTripIndex = {};
    Object.entries(store.trips_map).forEach(([tripId, trip]) => {
      const route = store.routes[trip.routeId] || {};
      const type = route.type || 'bus';
      const compact = store.stop_times_compact[tripId];
      if (!compact) return;
      parseTripStopsFromCompact(compact).forEach((s) => {
        if (!store.stopRouteTypes[s.stopId]) store.stopRouteTypes[s.stopId] = new Set();
        store.stopRouteTypes[s.stopId].add(type);
        if (!store.stopTripIndex[s.stopId]) store.stopTripIndex[s.stopId] = [];
        store.stopTripIndex[s.stopId].push({
          tripId,
          seq: s.seq,
          stopId: s.stopId,
          t: s.t || null,
        });
      });
    });

    store.gtfsVersion = version;
    store.staticLoaded = true;
    store.lastUpdated.static = manifest.generatedAt || new Date().toISOString();
    delete store.errors.static;

    console.log(
      `[GTFS] Loaded local static v${store.gtfsVersion} Routes:${Object.keys(store.routes).length} Stops:${Object.keys(store.stops).length} Trips:${Object.keys(store.trips_map).length}`
    );
  } catch (e) {
    console.error('[GTFS]', e.message);
    store.errors.static = e.message;
  }
}

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
        .filter((e) => e.vehicle)
        .forEach((e) => {
          const id = String(e.vehicle.vehicle?.id || e.id || '');
          const occ = e.vehicle.occupancyStatus;
          if (occ !== undefined && occ !== null) occupancyMap[id] = occ;
        });
    }

    if (!feedV1) throw new Error('v1 feed failed');

    const nextVehicles = feedV1.entity
      .filter((e) => e.vehicle?.position)
      .map((e) => {
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

    store.vehicles = nextVehicles;
    store.vehicleByTrip = Object.fromEntries(nextVehicles.filter((v) => v.tripId).map((v) => [v.tripId, v]));
    store.lastUpdated.vehicles = new Date().toISOString();
    delete store.errors.vehicles;
    console.log(`[Vehicles] ${store.vehicles.length} (${Object.keys(occupancyMap).length} with occupancy)`);

    broadcastVehiclesIfChanged();
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
      .filter((e) => e.tripUpdate)
      .forEach((e) => {
        const tu = e.tripUpdate;
        const tripId = tu.trip?.tripId;
        if (!tripId) return;

        const ss = getStopTimesForTrip(tripId);
        const lookup = buildStopTimeLookup(ss);

        store.trips[tripId] = {
          tripId,
          routeId: tu.trip?.routeId || '',
          stopUpdates: (tu.stopTimeUpdate || []).map((stu) => {
            const sid = stu.stopId || '';
            const si = store.stops[sid] || {};
            const seq = stu.stopSequence || 0;
            const se = stopTimeMatch(lookup, seq, sid);
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
      const en = ts.translation.find((t) => !t.language || t.language === 'en');
      return (en || ts.translation[0])?.text || '';
    };

    store.alerts = feed.entity
      .filter((e) => e.alert)
      .map((e) => {
        const a = e.alert;
        return {
          id: String(e.id),
          cause: a.cause || 0,
          effect: a.effect || 0,
          header: getText(a.headerText),
          description: getText(a.descriptionText),
          routes: [...new Set((a.informedEntity || []).map((ie) => ie.routeId || ie.trip?.routeId || '').filter(Boolean))],
          stops: [...new Set((a.informedEntity || []).map((ie) => ie.stopId || '').filter(Boolean))],
          activePeriods: (a.activePeriod || []).map((p) => ({
            start: p.start ? Number(p.start) : null,
            end: p.end ? Number(p.end) : null,
          })),
        };
      });

    store.routeAlertCounts = {};
    store.alerts.forEach((alert) => {
      alert.routes.forEach((routeKey) => {
        if (!routeKey) return;
        store.routeAlertCounts[routeKey] = (store.routeAlertCounts[routeKey] || 0) + 1;
      });
    });

    store.lastUpdated.alerts = new Date().toISOString();
    delete store.errors.alerts;
    console.log(`[Alerts] ${store.alerts.length}`);
    broadcastVehiclesIfChanged();
    broadcastSse('alerts', alertsPayload());
  } catch (e) {
    console.error('[Alerts]', e.message);
    store.errors.alerts = e.message;
  }
}

function staticStops(tripId, fromSeq = 0) {
  return getStopTimesForTrip(tripId)
    .filter((s) => s.seq >= fromSeq)
    .map((s) => {
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
  const now = Date.now();
  const annotateWindow = (stops) => {
    if (!stops.length) return stops;

    let currentIdx = stops.findIndex((s) => (s.sequence || 0) >= seq);
    if (currentIdx < 0) currentIdx = stops.findIndex((s) => {
      const t = s.arrivalTime || s.departureTime;
      if (!t) return true;
      const ts = new Date(t).getTime();
      return Number.isNaN(ts) || ts >= now - 30000;
    });
    if (currentIdx < 0) currentIdx = Math.max(stops.length - 1, 0);

    const start = Math.max(0, currentIdx - 3);
    return stops.slice(start).map((s, idx) => {
      const absoluteIdx = start + idx;
      let timelineStatus = 'upcoming';
      if (absoluteIdx < currentIdx) timelineStatus = 'passed';
      else if (absoluteIdx === currentIdx) timelineStatus = 'current';
      else if (absoluteIdx === currentIdx + 1) timelineStatus = 'next';

      return {
        ...s,
        timelineStatus,
        lat: s.lat ?? s.stopLat ?? null,
        lon: s.lon ?? s.stopLon ?? null,
      };
    });
  };

  if (td && td.stopUpdates.length) {
    const isUpcomingRealtimeStop = (s) => {
      const t = s.arrivalTime || s.departureTime;
      if (!t) return true;
      const ts = new Date(t).getTime();
      return Number.isNaN(ts) || ts >= now - 30000;
    };

    let stops = td.stopUpdates.slice();
    if (!stops.length || seq === 0) {
      stops = td.stopUpdates.filter(isUpcomingRealtimeStop);
    }
    if (!stops.length) stops = td.stopUpdates.slice(-4);
    return annotateWindow(stops);
  }

  const isUpcomingStaticStop = (s) => {
    const ts = serviceTimeToMillis(s.scheduledTime);
    return ts == null || ts >= now - 60000;
  };

  let stops = staticStops(v.tripId, 0);
  if (!stops.length) return stops;
  const future = stops.filter(isUpcomingStaticStop);
  if ((!future.length || seq === 0) && future.length) {
    return annotateWindow(stops);
  }
  return annotateWindow(stops);
}

function scheduleDailyStaticReload() {
  const now = new Date();
  const adelaideNow = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Adelaide' }));
  const nextRun = new Date(adelaideNow);
  nextRun.setHours(1, 15, 0, 0);

  if (adelaideNow >= nextRun) nextRun.setDate(nextRun.getDate() + 1);

  const delay = nextRun.getTime() - adelaideNow.getTime();
  console.log(`[GTFS] Next local static reload at ${nextRun.toString()} Adelaide time`);

  setTimeout(async () => {
    try {
      console.log('[GTFS] Reloading prepared local static data');
      await loadStatic(true);
    } catch (err) {
      console.error('[GTFS] Scheduled local static reload failed', err);
    } finally {
      scheduleDailyStaticReload();
    }
  }, delay);
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  sseClients.add(res);
  writeSseEvent(res, 'ready', { ok: true });
  if (store.lastUpdated.vehicles) writeSseEvent(res, 'vehicles', vehiclesPayload());
  if (store.lastUpdated.alerts) writeSseEvent(res, 'alerts', alertsPayload());

  req.on('close', () => {
    sseClients.delete(res);
    res.end();
  });
});

app.get('/api/vehicles', (req, res) => {
  res.json(vehiclesPayload());
});

app.get('/api/vehicles/:id', (req, res) => {
  const v = store.vehicles.find((x) => x.vehicleId === req.params.id);
  if (!v) return res.status(404).json({ error: 'not found' });
  const alerts = matchedAlertsForVehicle(v);
  res.json({
    ...serializeVehicleSummary(v),
    upcomingStops: upcomingStopsFor(v),
    alerts,
  });
});

app.get('/api/trips/:tripId', (req, res) => {
  const { tripId } = req.params;
  const tu = store.trips[tripId];
  const st = staticStops(tripId, 0);

  if (!tu && !st.length) {
    return res.status(404).json({ error: 'not found' });
  }

  return res.json({
    tripId,
    stops: tu ? tu.stopUpdates : st,
    hasRealtime: !!tu,
  });
});

app.get('/api/alerts', (req, res) => {
  res.json(alertsPayload());
});

app.get('/api/shape/:shapeId', async (req, res) => {
  try {
    const points = await getShapePoints(req.params.shapeId);
    if (!points) {
      return res.status(404).json({ error: 'not found' });
    }
    return res.json({ shapeId: req.params.shapeId, points });
  } catch (e) {
    console.error('[Shape]', e.message);
    return res.status(500).json({ error: 'shape load failed' });
  }
});

app.get('/api/stops/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q || q.length < 2) return res.json({ stops: [] });

  const results = store.stopSearchIndex
    .filter((s) =>
      s.name?.toLowerCase().includes(q) ||
      s.code?.toLowerCase().includes(q) ||
      s.stopId.toLowerCase().includes(q)
    )
    .slice(0, 20)
    .map((s) => ({ ...s }));

  return res.json({ stops: results });
});

app.get('/api/stops/index', (req, res) => {
  res.json({ stops: store.stopSearchIndex });
});
app.get('/api/stops/nearby', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = parseFloat(req.query.radius) || 800;

  if (Number.isNaN(lat) || Number.isNaN(lon)) return res.json({ stops: [] });

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  const stopRouteTypes = store.stopRouteTypes || {};

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
    .filter((s) => s.dist <= radius)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 30);

  return res.json({ stops: results });
});

app.get('/api/stops/:stopId/departures', (req, res) => {
  const { stopId } = req.params;
  const departures = [];
  const stopRows = getDepartureRowsForStop(stopId);
  const tripUpdateLookupCache = new Map();

  stopRows.forEach((stopEntry) => {
    const tripId = stopEntry.tripId;
    const tm = store.trips_map[tripId] || {};
    const rm = store.routes[tm.routeId] || {};
    const tu = store.trips[tripId];
    let stopUpdateLookup = tripUpdateLookupCache.get(tripId);
    if (stopUpdateLookup === undefined) {
      stopUpdateLookup = tu
        ? buildStopTimeLookup(tu.stopUpdates.map((s) => ({ seq: s.sequence, stopId: s.stopId, ...s })))
        : null;
      tripUpdateLookupCache.set(tripId, stopUpdateLookup);
    }

    let realtimeTime = null;
    let delay = 0;

    if (stopUpdateLookup) {
      const rts = stopTimeMatch(stopUpdateLookup, stopEntry.seq, stopId);
      if (rts) {
        realtimeTime = rts.arrivalTime || rts.departureTime;
        delay = rts.delay || 0;
      }
    }

    const vehicle = store.vehicleByTrip[tripId];

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

  return res.json({
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

  const markerFrom = `|${fromStopId}|`;
  const markerTo = `|${toStopId}|`;

  Object.entries(store.trips_map || {}).forEach(([tripId, trip]) => {
    const compact = store.stop_times_compact[tripId];
    if (!compact || !compact.includes(markerFrom) || !compact.includes(markerTo)) return;

    const stops = getStopTimesForTrip(tripId);
    if (!stops.length) return;

    const fromIdx = stops.findIndex((s) => s.stopId === fromStopId);
    const toIdx = stops.findIndex((s, i) => i > fromIdx && s.stopId === toStopId);
    if (fromIdx === -1 || toIdx === -1) return;

    const fromStop = stops[fromIdx];
    const toStop = stops[toIdx];
    const route = store.routes[trip.routeId] || {};
    const tripUpdate = store.trips[tripId];
    const tripLookup = tripUpdate ? buildStopTimeLookup(tripUpdate.stopUpdates.map((s) => ({ seq: s.sequence, stopId: s.stopId, ...s }))) : null;
    const fromRt = tripLookup ? stopTimeMatch(tripLookup, fromStop.seq, fromStopId) : null;
    const toRt = tripLookup ? stopTimeMatch(tripLookup, toStop.seq, toStopId) : null;

    const departureRealtime = fromRt?.arrivalTime || fromRt?.departureTime || null;
    const arrivalRealtime = toRt?.arrivalTime || toRt?.departureTime || null;
    const departureTs = departureRealtime ? new Date(departureRealtime).getTime() : serviceTimeToMillis(fromStop.t);
    const arrivalTs = arrivalRealtime ? new Date(arrivalRealtime).getTime() : serviceTimeToMillis(toStop.t);

    if (departureTs && departureTs < now - 60000) return;

    const vehicle = store.vehicleByTrip[tripId];
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

  return res.json({
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
    staticDir: STATIC_DATA_DIR,
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
    staticDir: STATIC_DATA_DIR,
    lastUpdated: store.lastUpdated,
    errors: store.errors,
  });
});

async function start() {
  console.log('Adelaide Metro Tracker');

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });

  try {
    await loadStatic();
    await Promise.all([pollVehicles(), pollTrips(), pollAlerts()]);
  } catch (e) {
    console.error('Initial data load failed:', e);
  }

  setInterval(() => {
    pollVehicles().catch((err) => console.error('pollVehicles', err));
  }, 15_000);

  setInterval(() => {
    pollTrips().catch((err) => console.error('pollTrips', err));
  }, 60_000);

  setInterval(() => {
    pollAlerts().catch((err) => console.error('pollAlerts', err));
  }, 5 * 60_000);

  scheduleDailyStaticReload();
}

start().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
