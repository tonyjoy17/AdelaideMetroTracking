/**
 * Adelaide Metro Tracker — Server v3
 * - v2 API for tram occupancy (passenger counting)
 * - v1 API for trains + buses
 * - Stop search endpoint
 * - Departures board endpoint
 */
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const AdmZip  = require('adm-zip');
const { parse: parseCSV } = require('csv-parse/sync');
const GtfsRT  = require('gtfs-realtime-bindings').transit_realtime;

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.static(__dirname));

const V1 = 'https://gtfs.adelaidemetro.com.au/v1/realtime';
const V2 = 'https://gtfs.adelaidemetro.com.au/v2/realtime';
const ST = 'https://gtfs.adelaidemetro.com.au/v1/static/latest';

const OCCUPANCY_LABELS = {
  0: { label: 'Empty',           emoji: '🟢', pct: 5  },
  1: { label: 'Many seats',      emoji: '🟢', pct: 20 },
  2: { label: 'Few seats',       emoji: '🟡', pct: 55 },
  3: { label: 'Standing room',   emoji: '🟠', pct: 75 },
  4: { label: 'Limited standing',emoji: '🔴', pct: 90 },
  5: { label: 'Full',            emoji: '🔴', pct: 100},
  6: { label: 'Not accepting',   emoji: '⛔', pct: 100},
};

const store = {
  vehicles: [], trips: {}, alerts: [],
  routes: {}, trips_map: {}, stops: {}, stop_times: {}, shapes: {},
  gtfsVersion: null, staticLoaded: false,
  lastUpdated: { vehicles:null, trips:null, alerts:null, static:null },
  errors: {},
};

function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 25000 }, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout: ' + url)); });
  });
}
const fetchText = async url => (await fetchBuf(url)).toString('utf8');

function decode(buf) {
  try { return GtfsRT.FeedMessage.decode(buf); }
  catch(e) { console.error('[decode]', e.message); return null; }
}
function routeType(n) {
  n = parseInt(n);
  if (n === 0) return 'tram';
  if (n === 1 || n === 2) return 'train';
  return 'bus';
}

// ── STATIC GTFS ──
async function loadStatic(force=false) {
  try {
    const ver = (await fetchText(`${ST}/version.txt`)).trim();
    if (!force && ver === store.gtfsVersion && store.staticLoaded) return;
    console.log('[GTFS] Downloading v' + ver);
    const zip = new AdmZip(await fetchBuf(`${ST}/google_transit.zip`));
    const csv = name => {
      const e = zip.getEntry(name);
      if (!e) return [];
      return parseCSV(e.getData().toString('utf8'), { columns:true, skip_empty_lines:true, trim:true });
    };
    store.routes = {};
    csv('routes.txt').forEach(r => {
      store.routes[r.route_id] = { shortName:r.route_short_name||r.route_id, longName:r.route_long_name||'', type:routeType(r.route_type) };
    });
    store.trips_map = {};
    csv('trips.txt').forEach(t => {
      store.trips_map[t.trip_id] = { routeId:t.route_id, shapeId:t.shape_id, headsign:t.trip_headsign||'', directionId:t.direction_id };
    });
    store.stops = {};
    csv('stops.txt').forEach(s => {
      store.stops[s.stop_id] = { name:s.stop_name, lat:parseFloat(s.stop_lat), lon:parseFloat(s.stop_lon), code:s.stop_code||'' };
    });
    store.stop_times = {};
    csv('stop_times.txt').forEach(st => {
      if (!store.stop_times[st.trip_id]) store.stop_times[st.trip_id] = [];
      store.stop_times[st.trip_id].push({ seq:parseInt(st.stop_sequence), stopId:st.stop_id, arrival:st.arrival_time, departure:st.departure_time });
    });
    Object.values(store.stop_times).forEach(a => a.sort((x,y) => x.seq-y.seq));
    store.shapes = {};
    csv('shapes.txt').forEach(s => {
      if (!store.shapes[s.shape_id]) store.shapes[s.shape_id] = [];
      store.shapes[s.shape_id].push({ seq:parseInt(s.shape_pt_sequence), lat:parseFloat(s.shape_pt_lat), lon:parseFloat(s.shape_pt_lon) });
    });
    Object.values(store.shapes).forEach(a => a.sort((x,y) => x.seq-y.seq));
    store.gtfsVersion = ver; store.staticLoaded = true;
    store.lastUpdated.static = new Date().toISOString();
    console.log(`[GTFS] Done. Routes:${Object.keys(store.routes).length} Stops:${Object.keys(store.stops).length}`);
  } catch(e) { console.error('[GTFS]', e.message); store.errors.static = e.message; }
}

// ── VEHICLES (v1 for all, v2 for trams with occupancy) ──
async function pollVehicles() {
  try {
    // Fetch both v1 (all) and v2 (trams with occupancy)
    const [bufV1, bufV2] = await Promise.allSettled([
      fetchBuf(`${V1}/vehicle_positions`),
      fetchBuf(`${V2}/vehicle_positions`),
    ]);

    const feedV1 = bufV1.status==='fulfilled' ? decode(bufV1.value) : null;
    const feedV2 = bufV2.status==='fulfilled' ? decode(bufV2.value) : null;

    // Build occupancy map from v2 (keyed by vehicleId)
    const occupancyMap = {};
    if (feedV2) {
      feedV2.entity.filter(e => e.vehicle).forEach(e => {
        const id = String(e.vehicle.vehicle?.id || e.id || '');
        const occ = e.vehicle.occupancyStatus;
        if (occ !== undefined && occ !== null) occupancyMap[id] = occ;
      });
    }

    if (!feedV1) throw new Error('v1 feed failed');

    store.vehicles = feedV1.entity.filter(e => e.vehicle?.position).map(e => {
      const v   = e.vehicle;
      const pos = v.position;
      const tripId  = v.trip?.tripId  || '';
      const routeId = v.trip?.routeId || '';
      const tm  = store.trips_map[tripId] || {};
      const rid = tm.routeId || routeId;
      const rm  = store.routes[rid] || {};
      const vid = String(v.vehicle?.id || e.id || '');
      const occ = occupancyMap[vid] ?? v.occupancyStatus ?? null;
      return {
        vehicleId: vid,
        label:     String(v.vehicle?.label || vid),
        tripId, routeId: rid,
        routeShort: rm.shortName || rid || routeId,
        routeLong:  rm.longName  || '',
        routeType:  rm.type      || 'bus',
        headsign:   tm.headsign  || '',
        shapeId:    tm.shapeId   || '',
        directionId:tm.directionId,
        lat:     pos.latitude,
        lon:     pos.longitude,
        bearing: pos.bearing  || 0,
        speed:   Math.round((pos.speed||0)*3.6*10)/10,
        status:  String(v.currentStatus||'IN_TRANSIT_TO'),
        stopSeq: v.currentStopSequence || 0,
        timestamp: v.timestamp ? Number(v.timestamp) : 0,
        occupancy: occ !== null ? { status: occ, ...(OCCUPANCY_LABELS[occ] || { label:'Unknown', emoji:'⬜', pct:0 }) } : null,
      };
    });

    store.lastUpdated.vehicles = new Date().toISOString();
    delete store.errors.vehicles;
    console.log(`[Vehicles] ${store.vehicles.length} (${Object.keys(occupancyMap).length} with occupancy)`);
  } catch(e) { console.error('[Vehicles]', e.message); store.errors.vehicles = e.message; }
}

// ── TRIP UPDATES ──
async function pollTrips() {
  try {
    const feed = decode(await fetchBuf(`${V1}/trip_updates`));
    if (!feed) throw new Error('decode failed');
    store.trips = {};
    feed.entity.filter(e => e.tripUpdate).forEach(e => {
      const tu = e.tripUpdate;
      const tripId = tu.trip?.tripId; if (!tripId) return;
      const ss = store.stop_times[tripId] || [];
      store.trips[tripId] = {
        tripId, routeId: tu.trip?.routeId || '',
        stopUpdates: (tu.stopTimeUpdate||[]).map(stu => {
          const sid = stu.stopId||''; const si = store.stops[sid]||{};
          const seq = stu.stopSequence||0;
          const se  = ss.find(s=>s.seq===seq||s.stopId===sid);
          const arrTs = stu.arrival?.time ? Number(stu.arrival.time) : null;
          const depTs = stu.departure?.time ? Number(stu.departure.time) : null;
          const delay = Number(stu.arrival?.delay||stu.departure?.delay||0);
          return { sequence:seq, stopId:sid, stopName:si.name||sid, stopLat:si.lat||null, stopLon:si.lon||null, scheduledTime:se?.arrival||se?.departure||null, arrivalTime:arrTs?new Date(arrTs*1000).toISOString():null, departureTime:depTs?new Date(depTs*1000).toISOString():null, delay, delayMin:Math.round(delay/60) };
        }),
      };
    });
    store.lastUpdated.trips = new Date().toISOString();
    console.log(`[Trips] ${Object.keys(store.trips).length}`);
  } catch(e) { console.error('[Trips]', e.message); store.errors.trips = e.message; }
}

// ── ALERTS ──
async function pollAlerts() {
  try {
    const feed = decode(await fetchBuf(`${V1}/service_alerts`));
    if (!feed) throw new Error('decode failed');
    const getText = ts => { if (!ts?.translation?.length) return ''; const en=ts.translation.find(t=>!t.language||t.language==='en'); return (en||ts.translation[0])?.text||''; };
    store.alerts = feed.entity.filter(e=>e.alert).map(e => {
      const a = e.alert;
      return {
        id: String(e.id), cause:a.cause||0, effect:a.effect||0,
        header: getText(a.headerText), description: getText(a.descriptionText),
        routes: [...new Set((a.informedEntity||[]).map(ie=>ie.routeId||ie.trip?.routeId||'').filter(Boolean))],
        stops:  [...new Set((a.informedEntity||[]).map(ie=>ie.stopId||'').filter(Boolean))],
        activePeriods: (a.activePeriod||[]).map(p=>({ start:p.start?Number(p.start):null, end:p.end?Number(p.end):null })),
      };
    });
    store.lastUpdated.alerts = new Date().toISOString();
    console.log(`[Alerts] ${store.alerts.length}`);
  } catch(e) { console.error('[Alerts]', e.message); store.errors.alerts = e.message; }
}

// ── HELPERS ──
function staticStops(tripId, fromSeq=0) {
  return (store.stop_times[tripId]||[]).filter(s=>s.seq>=fromSeq).slice(0,12).map(s => {
    const si=store.stops[s.stopId]||{};
    return { sequence:s.seq, stopId:s.stopId, stopName:si.name||s.stopId, stopLat:si.lat||null, stopLon:si.lon||null, scheduledTime:s.arrival||s.departure, arrivalTime:null, departureTime:null, delay:0, delayMin:0 };
  });
}

// Smart upcoming stops — handles stale/zero stopSeq by falling back to time-based filtering
function upcomingStopsFor(v) {
  const seq = v.stopSeq || 0;
  const td  = store.trips[v.tripId];

  if (td && td.stopUpdates.length) {
    // Try sequence filter first
    let stops = td.stopUpdates.filter(s => s.sequence >= seq);
    // If empty or seq is 0/stale, fall back to future stops by realtime time
    if (!stops.length || seq === 0) {
      const now = Date.now();
      stops = td.stopUpdates.filter(s => {
        const t = s.arrivalTime || s.departureTime;
        return !t || (new Date(t).getTime() >= now - 90000); // include up to 90s ago
      });
    }
    // Still empty? just return last few (end of line)
    if (!stops.length) stops = td.stopUpdates.slice(-3);
    return stops.slice(0, 10);
  }

  // No realtime — use static timetable with time-based fallback
  let stops = staticStops(v.tripId, seq);
  if (!stops.length || seq === 0) {
    // Get Adelaide local time HH:MM for comparison
    const nowStr = new Date().toLocaleTimeString('en-AU', {
      hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Australia/Adelaide'
    }).replace(/^24:/, '00:'); // handle midnight
    const all = staticStops(v.tripId, 0);
    const future = all.filter(s => (s.scheduledTime||'') >= nowStr);
    stops = future.length ? future : all.slice(-3);
  }
  return stops.slice(0, 10);
}


// ── API ──
app.get('/api/vehicles', (req, res) => {
  res.json({
    timestamp: store.lastUpdated.vehicles, count: store.vehicles.length,
    vehicles: store.vehicles.map(v => ({
      ...v,
      upcomingStops: upcomingStopsFor(v),
      alerts: store.alerts.filter(a=>a.routes.includes(v.routeId)||a.routes.includes(v.routeShort)),
    })),
  });
});

app.get('/api/trips/:tripId', (req, res) => {
  const { tripId } = req.params;
  const tu = store.trips[tripId];
  const st = staticStops(tripId, 0);
  if (!tu && !st.length) return res.status(404).json({ error:'not found' });
  res.json({ tripId, stops: tu ? tu.stopUpdates : st, hasRealtime:!!tu });
});

app.get('/api/alerts', (req, res) => {
  res.json({ timestamp:store.lastUpdated.alerts, count:store.alerts.length, alerts:store.alerts });
});

app.get('/api/shape/:shapeId', (req, res) => {
  const s = store.shapes[req.params.shapeId];
  if (!s) return res.status(404).json({ error:'not found' });
  res.json({ shapeId:req.params.shapeId, points:s });
});

// Stop search
app.get('/api/stops/search', (req, res) => {
  const q = (req.query.q||'').toLowerCase().trim();
  if (!q || q.length < 2) return res.json({ stops:[] });
  const results = Object.entries(store.stops)
    .filter(([id,s]) => s.name?.toLowerCase().includes(q) || s.code?.toLowerCase().includes(q) || id.includes(q))
    .slice(0, 20)
    .map(([id,s]) => ({ stopId:id, name:s.name, lat:s.lat, lon:s.lon, code:s.code }));
  res.json({ stops: results });
});

// Nearby stops by lat/lon radius
app.get('/api/stops/nearby', (req, res) => {
  const lat    = parseFloat(req.query.lat);
  const lon    = parseFloat(req.query.lon);
  const radius = parseFloat(req.query.radius) || 800;
  if (isNaN(lat) || isNaN(lon)) return res.json({ stops:[] });

  function haversine(lat1, lon1, lat2, lon2) {
    const R=6371000, φ1=lat1*Math.PI/180, φ2=lat2*Math.PI/180;
    const Δφ=(lat2-lat1)*Math.PI/180, Δλ=(lon2-lon1)*Math.PI/180;
    const a=Math.sin(Δφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }

  // Collect route types per stop from trips
  const stopRouteTypes = {};
  Object.entries(store.trips_map || {}).forEach(([tripId, trip]) => {
    const route = store.routes[trip.routeId] || {};
    const type  = route.type === 0 ? 'tram' : route.type === 2 ? 'train' : 'bus';
    const stops = store.stop_times[tripId] || [];
    stops.forEach(s => {
      if (!stopRouteTypes[s.stopId]) stopRouteTypes[s.stopId] = new Set();
      stopRouteTypes[s.stopId].add(type);
    });
  });

  const results = Object.entries(store.stops)
    .filter(([id, s]) => s.lat && s.lon)
    .map(([id, s]) => {
      const dist = haversine(lat, lon, s.lat, s.lon);
      return { stopId:id, name:s.name, code:s.code, lat:s.lat, lon:s.lon, dist,
               routeTypes: [...(stopRouteTypes[id] || [])] };
    })
    .filter(s => s.dist <= radius)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 30);

  res.json({ stops: results });
});


// Departures board for a stop
app.get('/api/stops/:stopId/departures', (req, res) => {
  const { stopId } = req.params;
  const now = Date.now() / 1000;
  const departures = [];

  // Find all trips visiting this stop, build departure board
  Object.entries(store.stop_times).forEach(([tripId, stops]) => {
    const stopEntry = stops.find(s => s.stopId === stopId);
    if (!stopEntry) return;

    const tm = store.trips_map[tripId] || {};
    const rm = store.routes[tm.routeId] || {};
    const tu = store.trips[tripId];

    // Real-time arrival if available
    let realtimeTime = null, delay = 0;
    if (tu) {
      const rts = tu.stopUpdates.find(s => s.stopId === stopId || s.sequence === stopEntry.seq);
      if (rts) {
        realtimeTime = rts.arrivalTime || rts.departureTime;
        delay = rts.delay || 0;
      }
    }

    // Find vehicle currently on this trip
    const vehicle = store.vehicles.find(v => v.tripId === tripId);

    departures.push({
      tripId,
      routeId:    tm.routeId || '',
      routeShort: rm.shortName || tm.routeId || '',
      routeLong:  rm.longName  || '',
      routeType:  rm.type      || 'bus',
      headsign:   tm.headsign  || '',
      scheduledTime: stopEntry.arrival || stopEntry.departure,
      realtimeTime,
      delay,
      delayMin: Math.round(delay/60),
      vehicleId: vehicle?.vehicleId || null,
      occupancy: vehicle?.occupancy || null,
    });
  });

  // Sort by scheduled time
  departures.sort((a,b) => (a.scheduledTime||'').localeCompare(b.scheduledTime||''));

  res.json({ stopId, stopName: store.stops[stopId]?.name || stopId, departures: departures.slice(0,30) });
});

app.get('/api/status', (req, res) => {
  res.json({ staticLoaded:store.staticLoaded, gtfsVersion:store.gtfsVersion, lastUpdated:store.lastUpdated, errors:store.errors, counts:{ vehicles:store.vehicles.length, trips:Object.keys(store.trips).length, alerts:store.alerts.length, routes:Object.keys(store.routes).length, stops:Object.keys(store.stops).length } });
});
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    staticLoaded: store.staticLoaded,
    gtfsVersion: store.gtfsVersion,
    lastUpdated: store.lastUpdated,
    errors: store.errors
  });
});

async function start() {
  console.log('Adelaide Metro Tracker v3');

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✓ Server running on port ${PORT}`);
  });

  try {
    await loadStatic();
    await Promise.all([pollVehicles(), pollTrips(), pollAlerts()]);
  } catch (e) {
    console.error('Initial data load failed:', e);
  }

  setInterval(() => pollVehicles().catch(err => console.error('pollVehicles', err)), 15_000);
  setInterval(() => pollTrips().catch(err => console.error('pollTrips', err)), 60_000);
  setInterval(() => pollAlerts().catch(err => console.error('pollAlerts', err)), 5 * 60_000);
  setInterval(() => loadStatic().catch(err => console.error('loadStatic', err)), 24 * 60 * 60_000);
}

start().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});

start().catch(e => { console.error('Fatal:', e); process.exit(1); });