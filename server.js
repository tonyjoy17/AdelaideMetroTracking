/**
 * Adelaide Metro Tracker — Server
 * Runtime reads prepared local static data only.
 * GTFS ZIP sync is handled separately by scripts outside the app runtime.
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs/promises');
const path = require('path');
const GtfsRT = require('gtfs-realtime-bindings').transit_realtime;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(__dirname));

const V1 = 'https://gtfs.adelaidemetro.com.au/v1/realtime';
const V2 = 'https://gtfs.adelaidemetro.com.au/v2/realtime';
const STATIC_DATA_DIR = process.env.STATIC_DATA_DIR || path.join(__dirname, 'data', 'static', 'current');

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
  stop_times_compact: {},
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
  caches: {
    tripStops: new Map(),
    departuresByStop: new Map(),
  },
};

const CACHE_LIMITS = {
  tripStops: 1500,
  departuresByStop: 500,
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
  store.shapesById = null;
}

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
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Adelaide' }));
}

const SERVICE_DAY_ROLLOVER_HOUR = 4;

function serviceDayBaseDate() {
  const dt = adelaideNowParts();
  if (dt.getHours() < SERVICE_DAY_ROLLOVER_HOUR) dt.setDate(dt.getDate() - 1);
  return dt;
}

function serviceTimeToMillis(timeStr) {
  if (!timeStr) return null;
  const parts = String(timeStr).split(':').map(Number);
  if (parts.length < 2 || parts.some(Number.isNaN)) return null;
  const [hh = 0, mm = 0, ss = 0] = parts;
  const dt = serviceDayBaseDate();
  const dayOffset = Math.floor(hh / 24);
  dt.setDate(dt.getDate() + dayOffset);
  dt.setHours(hh % 24, mm, ss, 0);
  return dt.getTime();
}

async function readJson(fileName) {
  const fullPath = path.join(STATIC_DATA_DIR, fileName);
  const raw = await fs.readFile(fullPath, 'utf8');
  return JSON.parse(raw);
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
    store.stop_times_compact = stopTimesCompact || {};
    store.shapesById = null;
    clearRuntimeCaches();

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

    store.vehicles = feedV1.entity
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
      .filter((e) => e.tripUpdate)
      .forEach((e) => {
        const tu = e.tripUpdate;
        const tripId = tu.trip?.tripId;
        if (!tripId) return;

        const ss = getStopTimesForTrip(tripId);

        store.trips[tripId] = {
          tripId,
          routeId: tu.trip?.routeId || '',
          stopUpdates: (tu.stopTimeUpdate || []).map((stu) => {
            const sid = stu.stopId || '';
            const si = store.stops[sid] || {};
            const seq = stu.stopSequence || 0;
            const se = ss.find((s) => s.seq === seq || s.stopId === sid);
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

    store.lastUpdated.alerts = new Date().toISOString();
    delete store.errors.alerts;
    console.log(`[Alerts] ${store.alerts.length}`);
  } catch (e) {
    console.error('[Alerts]', e.message);
    store.errors.alerts = e.message;
  }
}

function staticStops(tripId, fromSeq = 0) {
  return getStopTimesForTrip(tripId)
    .filter((s) => s.seq >= fromSeq)
    .slice(0, 12)
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

  if (td && td.stopUpdates.length) {
    let stops = td.stopUpdates.filter((s) => s.sequence >= seq);

    if (!stops.length || seq === 0) {
      const now = Date.now();
      stops = td.stopUpdates.filter((s) => {
        const t = s.arrivalTime || s.departureTime;
        return !t || new Date(t).getTime() >= now - 90000;
      });
    }

    if (!stops.length) stops = td.stopUpdates.slice(-3);
    return stops.slice(0, 10);
  }

  let stops = staticStops(v.tripId, seq);
  if (!stops.length || seq === 0) {
    const all = staticStops(v.tripId, 0);
    const now = Date.now();
    const future = all.filter((s) => {
      const ts = serviceTimeToMillis(s.scheduledTime);
      return ts == null || ts >= now - 60000;
    });
    stops = future.length ? future : all.slice(-3);
  }

  return stops.slice(0, 10);
}

function scheduleDailyStaticReload() {
  const now = new Date();
  const adelaideNow = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Adelaide' }));
  const nextRun = new Date(adelaideNow);
  nextRun.setHours(1, 5, 0, 0);

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

app.get('/api/vehicles', (req, res) => {
  res.json({
    timestamp: store.lastUpdated.vehicles,
    count: store.vehicles.length,
    vehicles: store.vehicles.map((v) => ({
      ...v,
      upcomingStops: upcomingStopsFor(v),
      alerts: store.alerts.filter((a) => a.routes.includes(v.routeId) || a.routes.includes(v.routeShort)),
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

  return res.json({
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

  return res.json({ stops: results });
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

  const stopRouteTypes = {};
  Object.entries(store.trips_map || {}).forEach(([tripId, trip]) => {
    const route = store.routes[trip.routeId] || {};
    const type = route.type || 'bus';
    getStopTimesForTrip(tripId).forEach((s) => {
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
    .filter((s) => s.dist <= radius)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 30);

  return res.json({ stops: results });
});

app.get('/api/stops/:stopId/departures', (req, res) => {
  const { stopId } = req.params;
  const departures = [];
  const stopRows = getDepartureRowsForStop(stopId);

  stopRows.forEach((stopEntry) => {
    const tripId = stopEntry.tripId;
    const tm = store.trips_map[tripId] || {};
    const rm = store.routes[tm.routeId] || {};
    const tu = store.trips[tripId];

    let realtimeTime = null;
    let delay = 0;

    if (tu) {
      const rts = tu.stopUpdates.find((s) => s.stopId === stopId || s.sequence === stopEntry.seq);
      if (rts) {
        realtimeTime = rts.arrivalTime || rts.departureTime;
        delay = rts.delay || 0;
      }
    }

    const vehicle = store.vehicles.find((v) => v.tripId === tripId);

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

  Object.entries(store.trips_map || {}).forEach(([tripId, trip]) => {
    const stops = getStopTimesForTrip(tripId);
    if (!stops.length) return;

    const fromIdx = stops.findIndex((s) => s.stopId === fromStopId);
    const toIdx = stops.findIndex((s, i) => i > fromIdx && s.stopId === toStopId);
    if (fromIdx === -1 || toIdx === -1) return;

    const fromStop = stops[fromIdx];
    const toStop = stops[toIdx];
    const route = store.routes[trip.routeId] || {};
    const tripUpdate = store.trips[tripId];
    const fromRt = tripUpdate?.stopUpdates?.find((s) => s.sequence === fromStop.seq || s.stopId === fromStopId);
    const toRt = tripUpdate?.stopUpdates?.find((s) => s.sequence === toStop.seq || s.stopId === toStopId);

    const departureRealtime = fromRt?.arrivalTime || fromRt?.departureTime || null;
    const arrivalRealtime = toRt?.arrivalTime || toRt?.departureTime || null;
    const departureTs = departureRealtime ? new Date(departureRealtime).getTime() : serviceTimeToMillis(fromStop.t);
    const arrivalTs = arrivalRealtime ? new Date(arrivalRealtime).getTime() : serviceTimeToMillis(toStop.t);

    if (departureTs && departureTs < now - 60000) return;

    const vehicle = store.vehicles.find((v) => v.tripId === tripId);
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
