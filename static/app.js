'use strict';
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STATE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const S = {
  vehicles:[], alerts:[], tab:'all', filterRoute:null,
  selectedId:null, selectedStop:null,
  mode:'list', // list | stop | alerts | nearby | planner | favorites
  followMode:false,
  theme:(() => { try { return localStorage.getItem('adl_theme') || 'day'; } catch { return 'day'; } })(),
  tripCache:{}, shapeCache:{},
  shapeLayer:null, userLayer:null, stopFocusLayer:null,
  userPos:null,           // {lat,lon} for nearby stops
  nearbyStops:[],         // [{stopId,name,code,lat,lon,dist,routes}]
  planner:{ from:null, to:null, fromQuery:'', toQuery:'', fromSuggestions:[], toSuggestions:[], loading:false, results:[] },
  prevPositions:{},
  prevStopSeq:{},
  stopShowAll:false,
  stopBoardRequestId:0,
  etaTimer:null,          // setInterval for countdown ticking
  etaTargets:{},          // keyâ†’{el, isoTime} for live ticking
  favs: (() => { try { return JSON.parse(localStorage.getItem('adl_favs3')||'[]'); } catch { return []; }})(),
};
const saveFavs = () => localStorage.setItem('adl_favs3', JSON.stringify(S.favs));
const saveTheme = () => localStorage.setItem('adl_theme', S.theme);
const htmlCache = new WeakMap();
const VEHICLE_POLL_MS = 30000;
const ALERT_POLL_MS = 5 * 60_000;
const UI_DEBOUNCE_MS = 120;
let actionFeedbackTimer = null;
let stopSearchIndexPromise = null;
let sidebarScrollActive = false;
let sidebarScrollTimer = null;
let pendingSidebarRender = false;
let pendingVehiclesPayload = null;
let pendingAlertsPayload = null;

function vehicleAlertCount(v) {
  return v?.alertCount ?? v?.alerts?.length ?? 0;
}

function setHtmlIfChanged(el, html) {
  if (!el) return false;
  if (htmlCache.get(el) === html) return false;
  el.innerHTML = html;
  htmlCache.set(el, html);
  return true;
}

function showActionFeedback(message) {
  const overlay = document.getElementById('action-feedback');
  const text = document.getElementById('action-feedback-text');
  if (!overlay || !text) return;
  if (actionFeedbackTimer) clearTimeout(actionFeedbackTimer);
  text.textContent = message || 'Working...';
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
}

function hideActionFeedback(delay = 0) {
  const overlay = document.getElementById('action-feedback');
  if (!overlay) return;
  if (actionFeedbackTimer) clearTimeout(actionFeedbackTimer);
  actionFeedbackTimer = setTimeout(() => {
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
  }, delay);
}

function debounce(fn, wait = UI_DEBOUNCE_MS) {
  let timeoutId = null;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), wait);
  };
}

function getActiveFilterMeta() {
  if (S.filterRoute) return { kind:'route', label:`Route ${S.filterRoute}`, short:S.filterRoute };
  if (S.tab === 'tram') return { kind:'type', label:'Trams only', short:'Trams' };
  if (S.tab === 'train') return { kind:'type', label:'Trains only', short:'Trains' };
  if (S.tab === 'bus') return { kind:'type', label:'Buses only', short:'Buses' };
  if (S.tab === 'alerts') return { kind:'type', label:'Vehicles with alerts', short:'Alerts' };
  return null;
}

function isFocusedTransportTab() {
  return !S.filterRoute && ['tram', 'train', 'bus'].includes(S.tab);
}

function vehiclesForMapView() {
  if (!isMobile()) return S.vehicles;
  if (isFocusedTransportTab() || S.tab === 'alerts') return getFiltered();
  return S.vehicles;
}

function syncTabButtons() {
  document.querySelectorAll('.tab-btn, .drawer-tab-btn').forEach(btn => {
    const active = btn.dataset.t === S.tab;
    btn.classList.toggle('on', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function syncControlState() {
  const drawerOpen = document.getElementById('sidebar').classList.contains('drawer-open');
  const detailOpen = document.getElementById('detail').classList.contains('open');
  const favActive = !!(S.selectedId && S.favs.includes(S.selectedId));
  const dpFollow = document.getElementById('dp-follow');
  const dpFav = document.getElementById('dp-fav');
  document.getElementById('mob-hamburger').setAttribute('aria-expanded', drawerOpen ? 'true' : 'false');
  document.getElementById('mob-hamburger').setAttribute('aria-label', drawerOpen ? 'Close vehicle list' : 'Open vehicle list');
  document.getElementById('mc-follow').setAttribute('aria-pressed', S.followMode ? 'true' : 'false');
  if (dpFollow) dpFollow.setAttribute('aria-pressed', S.followMode ? 'true' : 'false');
  if (dpFav) dpFav.setAttribute('aria-pressed', favActive ? 'true' : 'false');
  document.getElementById('detail').setAttribute('aria-hidden', detailOpen ? 'false' : 'true');
  document.getElementById('planner-toggle').classList.toggle('on', S.mode === 'planner');
  document.getElementById('favorites-toggle').classList.toggle('on', S.mode === 'favorites');
  const themeBtn = document.getElementById('theme-toggle');
  themeBtn.classList.toggle('on', S.theme === 'night');
  themeBtn.setAttribute('aria-pressed', S.theme === 'night' ? 'true' : 'false');
  themeBtn.setAttribute('aria-label', S.theme === 'night' ? 'Switch to day view' : 'Switch to night view');
  themeBtn.textContent = S.theme === 'night' ? '☀' : '☾';
  syncTabButtons();
}

function updateDetailActionButtons() {
  const followBtn = document.getElementById('dp-follow');
  const favBtn = document.getElementById('dp-fav');
  const favActive = !!(S.selectedId && S.favs.includes(S.selectedId));
  if (followBtn) {
    followBtn.classList.toggle('on', S.followMode);
    followBtn.innerHTML = `<span class="ico">◎</span><span>${S.followMode ? 'Following vehicle' : 'Follow vehicle'}</span>`;
  }
  if (favBtn) {
    favBtn.classList.toggle('fav-on', favActive);
    favBtn.innerHTML = `<span class="ico">${favActive ? '★' : '☆'}</span><span>${favActive ? 'Saved' : 'Save vehicle'}</span>`;
  }
}

function clearFilters() {
  S.filterRoute = null;
  S.tab = 'all';
  S.mode = 'list';
  renderSidebar();
  updateMarkers();
  syncControlState();
  flushFrozenLiveUiUpdates();
}

function openFavorites() {
  S.mode = S.mode === 'favorites' ? 'list' : 'favorites';
  S.selectedStop = null;
  renderSidebar();
  syncControlState();
  if (isMobile()) {
    if (S.mode === 'favorites') mobDrawerOpen();
    else mobileShowFilteredList();
  }
}

function mobileShowFilteredList() {
  if (!isMobile()) return;
  const detail = document.getElementById('detail');
  detail.classList.remove('open','expanded','follow-compact');
  mobDrawerOpen();
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ETA COUNTDOWN ENGINE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Returns minutes until an ISO datetime (negative = overdue)
function minsUntil(iso) {
  if (!iso) return null;
  return (new Date(iso) - Date.now()) / 60000;
}

// Formats minutes into a human countdown string
function fmtCountdown(mins) {
  if (mins === null) return null;
  if (mins < -1)   return { text: 'Due', cls: 'due',    color: '#c62828' };
  if (mins < 0.5)  return { text: 'Now', cls: 'urgent', color: '#e65100' };
  if (mins < 2)    return { text: `${Math.round(mins * 60)} sec`,  cls: 'urgent', color: '#e65100' };
  if (mins < 60)   return { text: `${Math.floor(mins)} min`,       cls: mins < 8 ? 'soon' : 'later', color: mins < 8 ? '#2e7d32' : 'var(--ink2)' };
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return { text: m > 0 ? `${h} hr ${m} min` : `${h} hr`, cls: 'later', color: 'var(--ink3)' };
}

// Build an ETA pill element string for a realtime ISO time + scheduled fallback
function etaPill(realtimeIso, scheduledStr, delay) {
  const mins = minsUntil(realtimeIso);
  const cd   = mins !== null ? fmtCountdown(mins) : null;
  const delayInfo = fmtDelay(delay);
  const schedDisplay = scheduledTimeDisplay(scheduledStr);

  if (cd) {
    // Register this element for live ticking — we use a data attr as key
    const key = `eta-${realtimeIso}`;
    S.etaTargets[key] = { iso: realtimeIso };
    return `<div style="text-align:right">
      <div class="eta-pill ${cd.cls}" data-eta="${key}">${cd.text}</div>
      ${scheduledStr ? `<div class="eta-sched">${schedDisplay}</div>` : ''}
      ${delayInfo ? `<div class="dep-delay ${delayInfo.cls}">${delayInfo.label}</div>` : ''}
    </div>`;
  }
  // Fallback to static time
  return `<div style="text-align:right">
    ${scheduledStr ? `<div class="dep-sched">${schedDisplay}</div>` : ''}
    ${delayInfo ? `<div class="dep-delay ${delayInfo.cls}">${delayInfo.label}</div>` : ''}
  </div>`;
}
function etaPillFromDeparture(dep, keySeed='sched') {
  const targetTs = departureTs(dep);
  const delayInfo = fmtDelay(deriveDelaySeconds(dep));
  const schedDisplay = scheduledTimeDisplay(dep.scheduledTime);
  if (targetTs != null) {
    const mins = (targetTs - Date.now()) / 60000;
    const cd = fmtCountdown(mins);
    if (cd) {
      const key = `eta-${keySeed}-${dep.tripId||dep.routeId||dep.scheduledTime}`;
      S.etaTargets[key] = { ts: targetTs };
      return `<div style="text-align:right">
        <div class="eta-pill ${cd.cls}" data-eta="${key}">${cd.text}</div>
        ${dep.scheduledTime ? `<div class="eta-sched">${schedDisplay}</div>` : ''}
        ${delayInfo ? `<div class="dep-delay ${delayInfo.cls}">${delayInfo.label}</div>` : ''}
      </div>`;
    }
  }
  return etaPill(dep.realtimeTime, dep.scheduledTime, dep.delay);
}

// Tick all registered ETA elements every second
function startEtaTicker() {
  if (S.etaTimer) clearInterval(S.etaTimer);
  S.etaTimer = setInterval(() => {
    const els = document.querySelectorAll('[data-eta]');
    els.forEach(el => {
      const key = el.dataset.eta;
      const target = S.etaTargets[key];
      if (!target) return;
      const mins = target.iso ? minsUntil(target.iso) : target.ts!=null ? ((target.ts - Date.now()) / 60000) : null;
      const cd   = fmtCountdown(mins);
      if (!cd) return;
      el.textContent = cd.text;
      el.className   = `eta-pill ${cd.cls}`;
    });
  }, 1000);
}

// Stop ticker and clear targets when rebuilding DOM
function resetEtaTargets() {
  S.etaTargets = {};
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// HELPERS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const DIRS = ['N','NE','E','SE','S','SW','W','NW'];
const bearDir = b => DIRS[Math.round(((b||0)+360)/45)%8];
const fmtTime = iso => { try { return new Date(iso).toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit',timeZone:'Australia/Adelaide'}); } catch{ return '—'; }};
const adelaideNowDate = () => new Date();

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

function scheduledTimeTs(scheduledStr) {
  if (!scheduledStr) return null;
  const parts = String(scheduledStr).split(':').map(Number);
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

function scheduledTimeDisplay(scheduledStr) {
  const ts = scheduledTimeTs(scheduledStr);
  if (!ts) return scheduledStr || '—';
  return new Date(ts).toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit', hour12:true, timeZone:'Australia/Adelaide' }).toLowerCase();
}

function departureTs(dep) {
  if (dep.realtimeTime) {
    const ts = new Date(dep.realtimeTime).getTime();
    return Number.isNaN(ts) ? null : ts;
  }
  return scheduledTimeTs(dep.scheduledTime);
}

function upcomingDeparturesOnly(departures) {
  const now = Date.now();
  return departures.filter(dep => {
    const ts = departureTs(dep);
    return ts == null || ts >= now - 60000;
  });
}

function stopBoardVisibleServices(allServices) {
  const upcoming = upcomingDeparturesOnly(allServices);
  const baseList = upcoming.length ? upcoming : allServices;
  const now = Date.now();
  const withinHour = upcoming.filter(dep => {
    const ts = departureTs(dep);
    return ts == null || ts <= now + 60 * 60 * 1000;
  });

  if (withinHour.length > 5) {
    return {
      upcoming,
      visible: withinHour,
      mode: 'hour_window',
    };
  }

  return {
    upcoming,
    visible: baseList.slice(0, 5),
    mode: upcoming.length ? 'next_five' : 'available_five',
  };
}

function canDeferSidebarRender() {
  return ['list', 'favorites', 'alerts'].includes(S.mode) && sidebarScrollActive;
}

function flushDeferredSidebarRender() {
  if (!pendingSidebarRender) return;
  pendingSidebarRender = false;
  renderSidebar();
}

function isSearchBrowsingActive() {
  const searchInput = document.getElementById('search-in');
  const searchDrop = document.getElementById('search-drop');
  const hasSearchText = !!searchInput?.value?.trim();
  const searchOpen = !!searchDrop?.classList.contains('show');
  return !!(S.filterRoute || hasSearchText || searchOpen);
}

function shouldFreezeLiveUiUpdates() {
  return sidebarScrollActive && isSearchBrowsingActive() && S.mode === 'list' && !S.selectedId && !S.selectedStop;
}

function dedupeStopBoardServices(services) {
  const unique = new Map();
  services.forEach((dep) => {
    const ts = departureTs(dep);
    const scheduledTs = scheduledTimeTs(dep.scheduledTime);
    const canonicalTs = dep.realtimeTime ? ts : scheduledTs ?? ts;
    const timeKey = canonicalTs != null ? String(Math.round(canonicalTs / 30000)) : String(dep.scheduledTime || dep.realtimeTime || '');
    const key = [
      dep.routeShort || dep.routeId || '',
      dep.headsign || '',
      timeKey,
    ].join('|');

    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, dep);
      return;
    }

    const existingTs = departureTs(existing);
    const nextTs = ts;
    const pickRealtime = !existing.realtimeTime && dep.realtimeTime;
    const pickVehicle = !existing.vehicleId && dep.vehicleId;
    const pickOccupancy = !existing.occupancy && dep.occupancy;
    const pickEarlier = nextTs != null && (existingTs == null || nextTs < existingTs);
    if (pickRealtime || pickVehicle || pickOccupancy || pickEarlier) unique.set(key, dep);
  });

  return [...unique.values()].sort((a, b) => (departureTs(a) ?? Number.MAX_SAFE_INTEGER) - (departureTs(b) ?? Number.MAX_SAFE_INTEGER));
}
function deriveDelaySeconds(item) {
  const explicit = Number(item?.delay || 0);
  if (explicit) return explicit;
  const realtimeIso = item?.realtimeTime || item?.arrivalTime || item?.departureTime || null;
  const scheduledStr = item?.scheduledTime || null;
  if (!realtimeIso || !scheduledStr) return 0;
  const realtimeTs = new Date(realtimeIso).getTime();
  const scheduledTs = scheduledTimeTs(scheduledStr);
  if (Number.isNaN(realtimeTs) || scheduledTs == null) return 0;
  return Math.round((realtimeTs - scheduledTs) / 1000);
}
const fmtDelay = sec => {
  if (!sec) return null;
  const m = Math.round(sec/60);
  if (m===0) return {label:'On time',cls:'ontime',color:'var(--ok)'};
  if (m>0)   return {label:`+${m} min`,cls:'late',color:'var(--danger)'};
  return {label:`${Math.abs(m)} min early`,cls:'early',color:'var(--ok)'};
};
const vColor = (type, speed) => type==='tram'?'var(--tram)':type==='train'?'var(--train)':speed>0.5?'var(--bus)':'var(--stopped)';
const vBg    = (type, speed) => type==='tram'?'var(--tram-lt)':type==='train'?'var(--train-lt)':speed>0.5?'var(--bus-lt)':'var(--stopped-lt)';

const CROWD = {
  0:{label:'Empty',           emoji:'🟢',pct:5,   color:'var(--crowd-low)'},
  1:{label:'Many seats',      emoji:'🟢',pct:20,  color:'var(--crowd-low)'},
  2:{label:'Few seats left',  emoji:'🟡',pct:55,  color:'var(--crowd-mid)'},
  3:{label:'Standing room',   emoji:'🟠',pct:78,  color:'var(--crowd-mid)'},
  4:{label:'Very crowded',    emoji:'🔴',pct:92,  color:'var(--crowd-high)'},
  5:{label:'Full',            emoji:'🔴',pct:100, color:'var(--crowd-high)'},
  6:{label:'Not accepting',   emoji:'⛔',pct:100, color:'var(--crowd-high)'},
};

function firstDelayedStop(upcomingStops) {
  if (!upcomingStops?.length) return null;
  return upcomingStops.find(s => s?.timelineStatus !== 'passed' && Math.abs(deriveDelaySeconds(s)) > 0) || null;
}

function vehicleToward(v) {
  const lastStopName = v?.upcomingStops?.[v.upcomingStops.length - 1]?.stopName;
  const fallback = v?.headsign || '';
  const toward = lastStopName || fallback;
  return toward ? `Toward ${toward}` : '';
}

function nextStopForVehicle(v) {
  const stop = vehicleNextStop(v) || v?.upcomingStops?.find(s => s?.stopId && (s?.lat != null || s?.stopLat != null) && (s?.lon != null || s?.stopLon != null));
  if (!stop) return null;
  return {
    stopId: stop.stopId,
    name: stop.stopName || stop.name || 'Next stop',
    code: stop.stopCode || stop.code || '',
    lat: stop.lat ?? stop.stopLat,
    lon: stop.lon ?? stop.stopLon
  };
}

function vehicleCurrentStop(v) {
  return v?.upcomingStops?.find(s => s?.timelineStatus === 'current') || null;
}

function vehicleNextStop(v) {
  return v?.upcomingStops?.find(s => s?.timelineStatus === 'next')
    || v?.upcomingStops?.find(s => s?.timelineStatus === 'upcoming')
    || null;
}

function openVehicleNextStop(vehicleId, ev) {
  ev?.stopPropagation?.();
  const v = S.vehicles.find(x => x.vehicleId === vehicleId);
  const stop = nextStopForVehicle(v);
  if (!stop) return;
  focusStopOnMap(stop);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// MAP
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const ADELAIDE = [-34.928, 138.600];
const map = L.map('map', { center:ADELAIDE, zoom:12, zoomControl:false, attributionControl:true, preferCanvas:true });
const tileLayers = {
  day: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom:19
  }),
  night: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © CARTO', maxZoom:20
  })
};
let activeTileLayer = null;
function applyTheme(theme) {
  S.theme = theme === 'night' ? 'night' : 'day';
  document.body.classList.toggle('theme-night', S.theme === 'night');
  document.getElementById('theme-color-meta').setAttribute('content', S.theme === 'night' ? '#07111f' : '#f2f4fb');
  if (activeTileLayer) map.removeLayer(activeTileLayer);
  activeTileLayer = tileLayers[S.theme];
  activeTileLayer.addTo(map);
  saveTheme();
  syncControlState();
}
function toggleTheme() {
  applyTheme(S.theme === 'night' ? 'day' : 'night');
}

const markers = {};
const busDots = {};
const iconCache = new Map();
const MARKER_VIEWPORT_PAD = 0.35;
const DETAILED_MARKER_ZOOM = 14;
let mapInteractionActive = false;

function markerIconKey(v, sel) {
  const zoom = map.getZoom ? map.getZoom() : DETAILED_MARKER_ZOOM;
  const compact = zoom < DETAILED_MARKER_ZOOM && !sel;
  const bearingBucket = v.speed > 0.5 ? Math.round((v.bearing || 0) / 10) * 10 : 0;
  return [
    v.routeType || 'bus',
    v.routeShort || '',
    sel ? 'sel' : 'base',
    compact ? 'compact' : 'full',
    v.speed > 0.5 ? 'moving' : 'stopped',
    bearingBucket,
    vehicleAlertCount(v) ? 'alert' : 'clear',
    v.occupancy?.emoji || '',
  ].join('|');
}

function shouldRenderMarker(v, bounds) {
  if (!bounds) return true;
  return bounds.contains([v.lat, v.lon]) || v.vehicleId === S.selectedId;
}

function useBusDot(v) {
  const zoom = map.getZoom ? map.getZoom() : DETAILED_MARKER_ZOOM;
  return v.routeType === 'bus' && v.vehicleId !== S.selectedId && zoom < DETAILED_MARKER_ZOOM;
}

function busDotStyle(v, visible) {
  const moving = v.speed > 0.5;
  return {
    radius: moving ? 5 : 4,
    color: '#ffffff',
    weight: 1.25,
    fillColor: vColor(v.routeType, v.speed),
    fillOpacity: S.followMode ? 0.18 : visible ? 0.88 : 0.18,
    opacity: S.followMode ? 0.25 : visible ? 0.95 : 0.2,
  };
}

function syncBusDot(v, visible) {
  const id = v.vehicleId;
  const style = busDotStyle(v, visible);
  let dot = busDots[id];
  if (dot) {
    dot.setLatLng([v.lat, v.lon]);
    dot.setStyle(style);
    if (visible) dot.bringToFront();
    return;
  }
  dot = L.circleMarker([v.lat, v.lon], style);
  dot.on('click', () => selectVehicle(v.vehicleId));
  dot.addTo(map);
  busDots[id] = dot;
}

function removeMarkerInstance(id) {
  if (markers[id]) {
    markers[id].remove();
    delete markers[id];
  }
}

function removeBusDot(id) {
  if (busDots[id]) {
    busDots[id].remove();
    delete busDots[id];
  }
}

function makeIcon(v, sel) {
  const key = markerIconKey(v, sel);
  const cached = iconCache.get(key);
  if (cached) return cached;
  const color = vColor(v.routeType, v.speed);
  const label = (v.routeShort||'').substring(0,6);
  const isTram = v.routeType==='tram', isTrain = v.routeType==='train';
  const zoom = map.getZoom ? map.getZoom() : DETAILED_MARKER_ZOOM;
  const compact = zoom < DETAILED_MARKER_ZOOM && !sel;
  let sz = isTram?28:isTrain?26:v.speed>0.5?20:13;
  if (sel) sz = Math.round(sz*1.4);
  if (compact) sz = isTram ? 16 : isTrain ? 15 : 11;

  let arrow='';
  if (v.speed>0.5 && !compact) {
    const a=v.bearing||0, asz=sz+12, mid=asz/2;
    arrow=`<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(${a}deg);pointer-events:none;width:${asz}px;height:${asz}px;overflow:visible"><svg width="${asz}" height="${asz}" viewBox="0 0 ${asz} ${asz}" style="overflow:visible"><polygon points="${mid},2 ${mid-4},10 ${mid+4},10" fill="${color}" opacity="0.7"/></svg></div>`;
  }
  const alertRing = vehicleAlertCount(v) ? `<div style="position:absolute;inset:${compact ? '-3px' : '-5px'};border-radius:50%;border:${compact ? '1.5px' : '2px'} solid rgba(183,28,28,.6);pointer-events:none"></div>` : '';
  const selRing   = sel ? `<div style="position:absolute;inset:-6px;border-radius:50%;border:2.5px solid ${color};opacity:.4;pointer-events:none"></div>` : '';
  const occBadge  = (isTram && v.occupancy && !compact) ? `<div style="position:absolute;bottom:-9px;left:50%;transform:translateX(-50%);font-size:10px;line-height:1;pointer-events:none">${v.occupancy.emoji}</div>` : '';
  const liveBadge = (v.speed>0.5 && !compact) ? `<div style="position:absolute;top:-2px;right:-2px;width:7px;height:7px;border-radius:50%;background:var(--ok);border:1.5px solid var(--surface);animation:pulse 2s infinite;box-shadow:0 0 4px var(--ok);pointer-events:none;z-index:2"></div>` : '';
  const border    = sel ? `border:3px solid var(--surface);box-shadow:0 0 0 3px ${color},0 4px 12px rgba(0,0,0,.25)` : compact ? `border:1.5px solid rgba(255,255,255,.9);box-shadow:0 1px 4px rgba(0,0,0,.18)` : `border:2px solid var(--surface);box-shadow:0 2px 6px rgba(0,0,0,.2)`;
  const showLbl   = !compact && (isTram||isTrain||sel);
  const fs        = Math.max(7, Math.round(sz/3.2));
  const lbl       = showLbl ? `<span style="font-family:'JetBrains Mono',monospace;font-size:${fs}px;font-weight:600;color:white;line-height:1;text-align:center;max-width:${sz-4}px;overflow:hidden;display:block">${label}</span>` : '';

  const html = `<div style="position:relative;width:${sz}px;height:${sz}px">${selRing}${arrow}${alertRing}<div style="width:${sz}px;height:${sz}px;border-radius:50%;background:${color};${border};display:flex;align-items:center;justify-content:center;cursor:pointer">${lbl}</div>${occBadge}${liveBadge}</div>`;
  const icon = L.divIcon({ html, className:'', iconSize:[sz,sz], iconAnchor:[sz/2,sz/2] });
  iconCache.set(key, icon);
  return icon;
}

// Smooth interpolation between two GPS positions over `ms` milliseconds
function animateMarkerTo(marker, toLat, toLon, ms) {
  if (mapInteractionActive) { marker.setLatLng([toLat, toLon]); return; }
  const el = marker.getElement();
  if (!el) { marker.setLatLng([toLat, toLon]); return; }

  const from = marker.getLatLng();
  const dLat = toLat - from.lat;
  const dLon = toLon - from.lng;
  if (Math.abs(dLat) < 0.000005 && Math.abs(dLon) < 0.000005) return; // no meaningful movement

  const start = performance.now();
  function step(now) {
    const t = Math.min((now - start) / ms, 1);
    // Ease in-out cubic
    const e = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;
    marker.setLatLng([from.lat + dLat*e, from.lng + dLon*e]);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function updateMarkers() {
  const visibleVehicles = vehiclesForMapView();
  const filteredSet = new Set(visibleVehicles.map(v=>v.vehicleId));
  const seen = new Set();
  const bounds = map.getBounds ? map.getBounds().pad(MARKER_VIEWPORT_PAD) : null;

  visibleVehicles.forEach(v => {
    if (!v.lat||!v.lon) return;
    if (!shouldRenderMarker(v, bounds)) return;
    seen.add(v.vehicleId);
    const sel = v.vehicleId===S.selectedId;
    const vis = filteredSet.has(v.vehicleId);
    if (useBusDot(v)) {
      removeMarkerInstance(v.vehicleId);
      syncBusDot(v, vis);
      return;
    }
    removeBusDot(v.vehicleId);
    const icon = makeIcon(v, sel);
    const zi = v.routeType==='tram'?200:v.routeType==='train'?100:0;

    // Follow mode: selected vehicle stays bright, everything else fades away
    const opacity = sel ? 1 : S.followMode ? 0.05 : vis ? 1 : 0.07;

    if (markers[v.vehicleId]) {
      const m = markers[v.vehicleId];
      if (v.speed > 0.5) {
        animateMarkerTo(m, v.lat, v.lon, 900);
      } else {
        m.setLatLng([v.lat, v.lon]);
      }
      m.setIcon(icon);
      m.setOpacity(opacity);
      m.setZIndexOffset(sel ? 900 : zi);
    } else {
      const m = L.marker([v.lat,v.lon], {icon, opacity, zIndexOffset:zi});
      m.on('click', () => selectVehicle(v.vehicleId));
      m.addTo(map);
      markers[v.vehicleId] = m;
    }
  });

  Object.keys(markers).forEach(id => {
    if (!seen.has(id)) removeMarkerInstance(id);
  });
  Object.keys(busDots).forEach(id => {
    if (!seen.has(id)) removeBusDot(id);
  });
}

function drawShape(shapeId, type) {
  if (S.shapeLayer) { S.shapeLayer.remove(); S.shapeLayer=null; }
  const pts = S.shapeCache[shapeId]; if (!pts?.length) return;
  const color = type==='tram'?'#00897b':type==='train'?'#3949ab':'#e65100';
  S.shapeLayer = L.polyline(pts.map(p=>[p.lat,p.lon]), {color,weight:4,opacity:.65,smoothFactor:1.5}).addTo(map);
}

function resetView() {
  showActionFeedback('Returning to map...');
  S.followMode=false;
  document.getElementById('mc-follow').classList.remove('on');
  document.getElementById('detail').classList.remove('follow-compact');
  if (S.stopFocusLayer) { S.stopFocusLayer.remove(); S.stopFocusLayer=null; }
  updateDetailActionButtons();
  syncControlState();
  map.setView(ADELAIDE,12,{animate:true});
  hideActionFeedback(450);
}
function focusStopOnMap(stop) {
  if (!stop?.lat || !stop?.lon) return;
  if (S.stopFocusLayer) { S.stopFocusLayer.remove(); S.stopFocusLayer=null; }
  const ring = L.circleMarker([stop.lat,stop.lon], {
    radius: 15,
    color: '#0ea5c6',
    weight: 3,
    fillColor: '#8fdcff',
    fillOpacity: .22
  });
  const dot = L.circleMarker([stop.lat,stop.lon], {
    radius: 6,
    color: '#ffffff',
    weight: 2,
    fillColor: '#0ea5c6',
    fillOpacity: 1
  });
  S.stopFocusLayer = L.layerGroup([ring, dot]).addTo(map);
  map.panTo([stop.lat,stop.lon], {animate:true, duration:.45});
  if (isMobile()) {
    mobDrawerClose();
    document.getElementById('detail').classList.remove('open','expanded','follow-compact');
  }
}
function restoreFullMapFromNearby() {
  closeNearby();
  document.getElementById('mc-locate').classList.remove('on');
  if (S.userLayer) { S.userLayer.remove(); S.userLayer=null; }
  S.userPos=null;
  map.setView(ADELAIDE,12,{animate:true});
}

function focusVehicleForFollow(v, animate = true) {
  if (!v) return;
  const zoom = Math.max(map.getZoom(), 15);
  if (!isMobile()) {
    map.setView([v.lat, v.lon], zoom, { animate, duration: animate ? 0.45 : 0 });
    return;
  }

  const detail = document.getElementById('detail');
  if (!detail?.classList.contains('open')) {
    map.setView([v.lat, v.lon], zoom, { animate, duration: animate ? 0.45 : 0 });
    return;
  }

  const detailRect = detail.getBoundingClientRect();
  const mapSize = map.getSize();
  const topSafe = Math.max(112, window.innerHeight * 0.14);
  const desiredY = Math.max(topSafe, Math.min(detailRect.top - 104, mapSize.y * 0.46));
  const vehiclePoint = map.project([v.lat, v.lon], zoom);
  const targetCenterPoint = L.point(vehiclePoint.x, vehiclePoint.y + (mapSize.y / 2 - desiredY));
  const targetCenter = map.unproject(targetCenterPoint, zoom);

  map.setView(targetCenter, zoom, { animate, duration: animate ? 0.45 : 0 });
}

function toggleFollow() {
  showActionFeedback(S.followMode ? 'Stopping follow...' : 'Following vehicle...');
  S.followMode = !S.followMode;
  document.getElementById('mc-follow').classList.toggle('on', S.followMode);
  const detail = document.getElementById('detail');
  if (S.followMode && S.selectedId) {
    const v = S.vehicles.find(x=>x.vehicleId===S.selectedId);
    if (isMobile()) {
      detail.classList.add('open','follow-compact');
      detail.classList.remove('expanded');
      mobDrawerClose();
    }
    focusVehicleForFollow(v);
  } else if (!S.followMode) {
    if (S.stopFocusLayer) { S.stopFocusLayer.remove(); S.stopFocusLayer=null; }
    detail.classList.remove('follow-compact');
    map.setView(ADELAIDE,12,{animate:true});
  }
  // Immediately re-render markers to apply/remove fade
  updateMarkers();
  updateDetailActionButtons();
  syncControlState();
  hideActionFeedback(450);
}
function locateMe() {
  if (!navigator.geolocation) { alert('Geolocation not supported'); return; }
  if (isMobile() && S.mode==='nearby' && document.getElementById('sidebar').classList.contains('drawer-open')) {
    restoreFullMapFromNearby();
    mobDrawerClose();
    return;
  }
  const btn = document.getElementById('mc-locate');
  btn.style.animation = 'spin 1s linear infinite';
  navigator.geolocation.getCurrentPosition(pos => {
    btn.style.animation='';
    btn.classList.add('on');
    const lat=pos.coords.latitude, lon=pos.coords.longitude, acc=pos.coords.accuracy;
    S.userPos={lat,lon};
    if (S.userLayer) { S.userLayer.remove(); S.userLayer=null; }
    const circle = L.circle([lat,lon],{radius:acc,color:'#2196f3',fillColor:'#2196f3',fillOpacity:.1,weight:1.5});
    const dot    = L.divIcon({html:'<div class="user-dot"></div>',className:'',iconSize:[14,14],iconAnchor:[7,7]});
    S.userLayer  = L.layerGroup([circle, L.marker([lat,lon],{icon:dot})]).addTo(map);
    map.setView([lat,lon],15,{animate:true});
    showNearby();
  }, err => { btn.style.animation=''; alert('Location error: '+err.message); });
}

// Haversine distance in metres
function haversine(lat1,lon1,lat2,lon2){
  const R=6371000, phi1=lat1*Math.PI/180, phi2=lat2*Math.PI/180;
  const dPhi=(lat2-lat1)*Math.PI/180, dLambda=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dPhi/2)**2+Math.cos(phi1)*Math.cos(phi2)*Math.sin(dLambda/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
const fmtDist = m => m<1000?`${Math.round(m)}m`:`${(m/1000).toFixed(1)}km`;
const walkMins= m => { const n=Math.round(m/80); return n<1?'< 1 min walk':`${n} min walk`; };

function normalizeStopName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stopSearchScore(stop, query) {
  const q = query.toLowerCase();
  const name = String(stop.name || '').toLowerCase();
  const code = String(stop.code || '').toLowerCase();
  const id = String(stop.stopId || '').toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (code === q) return 2;
  if (code.startsWith(q)) return 3;
  if (id === q) return 4;
  if (name.includes(q)) return 5;
  if (code.includes(q)) return 6;
  if (id.includes(q)) return 7;
  return 99;
}

async function ensureStopSearchIndex() {
  if (S.stopSearchIndex?.length) return S.stopSearchIndex;
  if (Array.isArray(window.__STOP_SEARCH_INDEX__) && window.__STOP_SEARCH_INDEX__.length) {
    S.stopSearchIndex = window.__STOP_SEARCH_INDEX__;
    return S.stopSearchIndex;
  }
  if (!stopSearchIndexPromise) {
    stopSearchIndexPromise = fetch('/api/stops/index')
      .then(r => r.json())
      .then(data => {
        S.stopSearchIndex = data.stops || [];
        return S.stopSearchIndex;
      })
      .catch(() => {
        stopSearchIndexPromise = null;
        return [];
      });
  }
  return stopSearchIndexPromise;
}

function groupStopSearchResults(stops, query) {
  const sorted = [...stops].sort((a, b) => {
    const scoreDiff = stopSearchScore(a, query) - stopSearchScore(b, query);
    if (scoreDiff) return scoreDiff;
    const nameDiff = String(a.name || '').localeCompare(String(b.name || ''));
    if (nameDiff) return nameDiff;
    return String(a.code || a.stopId || '').localeCompare(String(b.code || b.stopId || ''));
  });

  const groups = [];
  sorted.forEach((stop) => {
    const key = normalizeStopName(stop.name);
    const existing = groups.find((group) =>
      group.key === key &&
      haversine(group.anchor.lat, group.anchor.lon, stop.lat, stop.lon) <= 120
    );
    if (existing) {
      existing.members.push(stop);
      return;
    }
    groups.push({ key, anchor: stop, members: [stop] });
  });

  return groups.slice(0, 8).map((group) => {
    const members = group.members;
    const preferred = S.userPos
      ? [...members].sort((a, b) => haversine(S.userPos.lat, S.userPos.lon, a.lat, a.lon) - haversine(S.userPos.lat, S.userPos.lon, b.lat, b.lon))[0]
      : members[0];
    const codes = [...new Set(members.map((s) => s.code).filter(Boolean))];
    return {
      ...preferred,
      memberStopIds: members.map((s) => s.stopId),
      variants: members.length,
      variantCodes: codes,
    };
  });
}

async function showNearby() {
  if (!S.userPos) { locateMe(); return; }
  if (isMobile() && S.mode==='nearby' && document.getElementById('sidebar').classList.contains('drawer-open')) {
    restoreFullMapFromNearby();
    mobDrawerClose();
    return;
  }
  S.mode='nearby'; S.selectedStop=null; S.selectedId=null;
  document.getElementById('detail').classList.remove('open');
  document.getElementById('mc-nearby').classList.add('on');
  if (isMobile()) mobDrawerOpen();
  showActionFeedback('Finding nearby stops...');
  const scroll=document.getElementById('sb-scroll');
  setHtmlIfChanged(scroll, `<div class="empty"><div class="empty-i" style="animation:spin 1s linear infinite;display:inline-block">📍</div><div class="empty-t">Finding nearby stops...</div></div>`);
  try {
    const res  = await fetch(`/api/stops/nearby?lat=${S.userPos.lat}&lon=${S.userPos.lon}&radius=800`);
    const data = await res.json();
    const stops=(data.stops||[])
      .map(s=>({...s,dist:haversine(S.userPos.lat,S.userPos.lon,s.lat,s.lon)}))
      .filter(s=>s.dist<=800).sort((a,b)=>a.dist-b.dist).slice(0,25);
    S.nearbyStops=stops;
    renderNearby(scroll);
    hideActionFeedback(250);
  } catch(e) {
    setHtmlIfChanged(scroll, `<div class="empty"><div class="empty-i">⚠️</div><div class="empty-t">Could not load nearby stops</div></div>`);
    hideActionFeedback(250);
  }
}

function renderNearby(scroll) {
  const stops=S.nearbyStops;
  const hdr=`<div class="nearby-hdr"><div class="nearby-hdr-row"><button class="stop-back" onclick="closeNearby()">←</button><div><div class="nearby-title">Nearby stops</div><div class="nearby-sub">${stops.length} stops within 800m</div></div></div></div>`;
  if (!stops.length) { setHtmlIfChanged(scroll, hdr+`<div class="empty"><div class="empty-i">🔍</div><div class="empty-t">No stops found nearby</div></div>`); return; }
  const rows=stops.map((s,i)=>{
    const icon=s.routeTypes?.includes('tram')?'🚊':s.routeTypes?.includes('train')?'🚆':'🚌';
    return `<div class="nearby-row" onclick="pickStop(${JSON.stringify({stopId:s.stopId,name:s.name,code:s.code,lat:s.lat,lon:s.lon}).replace(/"/g,'&quot;')})" style="animation:fadeUp .12s both;animation-delay:${i*.03}s">
      <div class="nearby-dot">${icon}</div>
      <div class="nearby-body"><div class="nearby-name">${s.name}</div><div class="nearby-meta">Stop ${s.code||s.stopId} · ${walkMins(s.dist)}</div></div>
      <div class="nearby-dist">${fmtDist(s.dist)}</div>
    </div>`;
  }).join('');
  setHtmlIfChanged(scroll, hdr+rows);
}

function closeNearby() {
  S.mode='list'; S.nearbyStops=[];
  document.getElementById('mc-nearby').classList.remove('on');
  renderSidebar();
  syncControlState();
}


// FILTER + TABS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function getFiltered() {
  return S.vehicles.filter(v => {
    if (S.filterRoute) return v.routeShort===S.filterRoute;
    if (S.tab==='tram')   return v.routeType==='tram';
    if (S.tab==='train')  return v.routeType==='train';
    if (S.tab==='bus')    return v.routeType==='bus';
    if (S.tab==='alerts') return vehicleAlertCount(v)>0;
    return true;
  });
}

function setTab(t, el) {
  S.tab=t; S.filterRoute=null;
  S.mode = t==='alerts'?'alerts':'list';
  S.selectedStop=null;
  S.selectedId=null;
  S.followMode=false;
  if (S.stopFocusLayer) { S.stopFocusLayer.remove(); S.stopFocusLayer=null; }
  if (S.shapeLayer) { S.shapeLayer.remove(); S.shapeLayer=null; }
  document.getElementById('mc-follow').classList.remove('on');
  document.getElementById('detail').classList.remove('open','expanded','follow-compact');
  renderSidebar(); updateMarkers();
  syncControlState();
  if (isMobile()) mobileShowFilteredList();
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SIDEBAR
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function updateTabCounts() {
  const ct = {all:S.vehicles.length,tram:0,train:0,bus:0,alerts:0};
  S.vehicles.forEach(v => { if (ct[v.routeType] !== undefined) ct[v.routeType]++; if (vehicleAlertCount(v)) ct.alerts++; });
  Object.keys(ct).forEach(k => { const el=document.getElementById('tc-' + k); if(el) el.textContent=ct[k]; });
  Object.keys(ct).forEach(k => {
    document.querySelectorAll('[data-count=\"' + k + '\"]').forEach(el => { el.textContent = ct[k]; });
  });
}

function renderSidebar() {
  if (canDeferSidebarRender()) {
    pendingSidebarRender = true;
    return;
  }
  updateTabCounts();
  const scroll = document.getElementById('sb-scroll');
  if (S.mode==='stop' && S.selectedStop) { renderStopBoard(scroll); return; }
  if (S.mode==='nearby') { renderNearby(scroll); return; }
  if (S.mode==='alerts') { renderAlerts(scroll); return; }
  if (S.mode==='planner') { renderPlanner(scroll); return; }
  if (S.mode==='favorites') { renderFavorites(scroll); return; }
  renderVList(scroll);
}

function vehicleGroupsFor(list) {
  const to = {tram:0,train:1,bus:2};
  const sorted = [...list].sort((a,b) => {
    const fa=S.favs.includes(a.vehicleId)?0:1, fb=S.favs.includes(b.vehicleId)?0:1;
    if (fa!==fb) return fa-fb;
    if (to[a.routeType]!==to[b.routeType]) return to[a.routeType]-to[b.routeType];
    const latDiff = (b.lat || 0) - (a.lat || 0);
    if (Math.abs(latDiff) > 0.0001) return latDiff;
    const lonDiff = (a.lon || 0) - (b.lon || 0);
    if (Math.abs(lonDiff) > 0.0001) return lonDiff;
    return String(a.vehicleId || '').localeCompare(String(b.vehicleId || ''));
  });
  const groups={};
  sorted.forEach(v => {
    const gk = (S.tab==='all'&&!S.filterRoute)?v.routeType:v.routeShort||v.routeType;
    if (!groups[gk]) groups[gk]=[];
    groups[gk].push(v);
  });
  return groups;
}

function renderVehicleGroupCards(scroll, groups, extraHtml='') {
  const tc={tram:'var(--tram)',train:'var(--train)',bus:'var(--bus)'};
  const tpb={tram:'var(--tram-lt)',train:'var(--train-lt)',bus:'var(--bus-lt)'};
  const tl={tram:'Trams',train:'Trains',bus:'Buses'};
  const tIcon={tram:'🚊',train:'🚆',bus:'🚌'};

  let html = extraHtml;
  const gkOrder = Object.keys(groups).sort((a,b)=>{
    const ia=['tram','train','bus'].indexOf(a), ib=['tram','train','bus'].indexOf(b);
    if (ia>-1&&ib>-1) return ia-ib; if (ia>-1) return -1; if (ib>-1) return 1; return a.localeCompare(b);
  });
  gkOrder.forEach(gk => {
    const gvs=groups[gk];
    const isType=['tram','train','bus'].includes(gk);
    const gc  = isType?tc[gk]:vColor(gvs[0].routeType,1);
    const gpb = isType?tpb[gk]:vBg(gvs[0].routeType,1);
    const gl  = isType?tl[gk]:`Route ${gk}`;
    const ico = isType?tIcon[gk]:(tIcon[gvs[0].routeType]||'🚌');
    html += `<div class="vg-hdr" style="color:${gc}">${ico} ${gl} <span class="vg-pill" style="background:${gpb};color:${gc}">${gvs.length}</span></div>`;
    gvs.forEach((v,i) => {
      const sel=v.vehicleId===S.selectedId, fav=S.favs.includes(v.vehicleId);
      const col=vColor(v.routeType,v.speed), bg=vBg(v.routeType,v.speed);
      const spd=v.speed>0.5?`${Math.round(v.speed)} km/h`:'Stopped';
      const spdC=v.speed>0.5?'var(--ok)':'var(--stopped)';
      const occ = v.routeType==='tram'&&v.occupancy ? `<div class="vc-occ">${v.occupancy.emoji} <span>${v.occupancy.label}</span></div>` : '';
      const toward = vehicleToward(v);
      const nextStop = nextStopForVehicle(v);
      html += `<div class="vcard${sel?' sel':''}" data-t="${v.routeType}" onclick="selectVehicle('${v.vehicleId}')" style="animation:fadeUp .15s both;animation-delay:${i*.012}s">
        <div class="vc-bd" style="background:${bg};color:${col}">${(v.routeShort||'').substring(0,6)}</div>
        <div class="vc-body">
          <div class="vc-name">${v.routeLong||v.routeShort||v.vehicleId}</div>
          <div class="vc-sub"><span>Veh ${v.vehicleId}</span><div class="vc-dot"></div><span>${v.headsign||v.routeShort||'—'}</span></div>
          ${toward?`<div class="vc-meta">${toward}</div>`:''}
          ${occ}
          ${nextStop?`<div class="vc-actions"><button class="vc-btn" onclick="openVehicleNextStop('${v.vehicleId}', event)">Next stop</button></div>`:''}
        </div>
        <div class="vc-right">
          <div class="vc-spd" style="color:${spdC}">${spd}</div>
          <div class="vc-bear">${bearDir(v.bearing)} ${Math.round(v.bearing||0)}°</div>
        </div>
        ${fav?'<div class="vc-fav"></div>':''}
        ${vehicleAlertCount(v)?'<div class="vc-alert"></div>':''}
      </div>`;
    });
  });
  const updated = setHtmlIfChanged(scroll, html);
  if (!updated) return;
  // Scroll to selected
  const selEl = scroll.querySelector('.vcard.sel');
  if (selEl) setTimeout(()=>selEl.scrollIntoView({block:'nearest',behavior:'smooth'}),80);
}

function renderVList(scroll) {
  const fv = getFiltered();
  if (!fv.length) {
    setHtmlIfChanged(scroll, `<div class="empty"><div class="empty-i">🔍</div><div class="empty-t">No vehicles</div></div>`);
    return;
  }
  const filterMeta = getActiveFilterMeta();
  let extraHtml = '';
  if (filterMeta) {
    extraHtml += `<div class="filter-bar">
      <div class="filter-meta">
        <span class="filter-lbl">Filter</span>
        <span class="filter-chip">${filterMeta.label}${filterMeta.short ? ` <strong>${filterMeta.short}</strong>` : ''}</span>
      </div>
      <div class="filter-actions">
        <button class="filter-btn" onclick="clearFilters()" aria-label="Clear active filter">Clear</button>
      </div>
    </div>`;
  }
  renderVehicleGroupCards(scroll, vehicleGroupsFor(fv), extraHtml);
}

function renderFavorites(scroll) {
  const favVehicles = S.vehicles.filter(v => S.favs.includes(v.vehicleId));
  const hdr = `<div class="planner-head"><button class="stop-back" onclick="openFavorites()">←</button><div><div class="planner-title">Favorites</div><div class="planner-sub">${favVehicles.length} saved vehicle${favVehicles.length===1?'':'s'}</div></div></div>`;
  if (!favVehicles.length) {
    setHtmlIfChanged(scroll, hdr + `<div class="empty"><div class="empty-i">★</div><div class="empty-t">No favorites saved yet</div><div class="empty-s">Open a vehicle and tap Save vehicle to add it here.</div></div>`);
    return;
  }
  renderVehicleGroupCards(scroll, vehicleGroupsFor(favVehicles), hdr);
}

function renderAlerts(scroll) {
  if (!S.alerts.length) {
    setHtmlIfChanged(scroll, `<div class="empty"><div class="empty-i">✅</div><div class="empty-t">No active disruptions</div><div class="empty-s">All services running normally</div></div>`);
    return;
  }
  setHtmlIfChanged(scroll, S.alerts.map(a => `<div class="alerts-list"><div class="alert-card">
    <div class="alert-hd"><div class="alert-ico">⚠️</div><div class="alert-title">${a.header||'Service Alert'}</div></div>
    ${a.description?`<div class="alert-body">${a.description}</div>`:''}
    ${a.routes?.length?`<div class="alert-routes">${a.routes.map(r=>`<span class="alert-rt">⚠ ${r}</span>`).join('')}</div>`:''}
  </div></div>`).join(''));
}

function plannerInputValue(field) {
  const stop = S.planner[field];
  const query = S.planner[`${field}Query`];
  return query || stop?.name || '';
}

function restorePlannerInputFocus(field, value) {
  requestAnimationFrame(() => {
    const el = document.getElementById(`planner-${field}`);
    if (!el) return;
    el.focus();
    const pos = (value || '').length;
    try { el.setSelectionRange(pos, pos); } catch {}
  });
}

async function plannerSearch(field, inputEl) {
  const value = inputEl.value;
  S.planner[`${field}Query`] = value;
  if (S.planner[field] && value !== S.planner[field].name) S.planner[field] = null;
  if (!value.trim() || value.trim().length < 2) {
    const hadSuggestions = (S.planner[`${field}Suggestions`] || []).length > 0;
    S.planner[`${field}Suggestions`] = [];
    if (hadSuggestions) {
      renderSidebar();
      restorePlannerInputFocus(field, value);
    }
    return;
  }
  try {
    const data = await fetch(`/api/stops/search?q=${encodeURIComponent(value.trim())}`).then(r=>r.json());
    S.planner[`${field}Suggestions`] = data.stops || [];
  } catch {
    S.planner[`${field}Suggestions`] = [];
  }
  renderSidebar();
  restorePlannerInputFocus(field, value);
}

function pickPlannerStop(field, stop) {
  S.planner[field] = stop;
  S.planner[`${field}Query`] = '';
  S.planner[`${field}Suggestions`] = [];
  renderSidebar();
}

function swapPlannerStops() {
  const from = S.planner.from, to = S.planner.to;
  S.planner.from = to; S.planner.to = from;
  S.planner.fromQuery = ''; S.planner.toQuery = '';
  S.planner.fromSuggestions = []; S.planner.toSuggestions = [];
  S.planner.results = [];
  renderSidebar();
}

async function runPlanner() {
  if (!S.planner.from?.stopId || !S.planner.to?.stopId) return;
  S.planner.loading = true;
  S.planner.results = [];
  renderSidebar();
  try {
    const data = await fetch(`/api/plan?fromStopId=${encodeURIComponent(S.planner.from.stopId)}&toStopId=${encodeURIComponent(S.planner.to.stopId)}`).then(r=>r.json());
    S.planner.results = data.options || [];
    if (S.planner.from?.lat && S.planner.from?.lon && S.planner.to?.lat && S.planner.to?.lon) {
      map.fitBounds([[S.planner.from.lat,S.planner.from.lon],[S.planner.to.lat,S.planner.to.lon]], {padding:[40,40]});
    }
  } catch {
    S.planner.results = [];
  } finally {
    S.planner.loading = false;
    renderSidebar();
  }
}

function openPlanner() {
  S.mode = 'planner';
  S.selectedId = null;
  S.selectedStop = null;
  document.getElementById('detail').classList.remove('open','expanded','follow-compact');
  renderSidebar();
  syncControlState();
  if (isMobile()) mobDrawerOpen();
}

function closePlanner() {
  S.mode = 'list';
  S.planner.fromSuggestions = [];
  S.planner.toSuggestions = [];
  renderSidebar();
  syncControlState();
}

function focusPlannerOption(opt) {
  if (opt.vehicleId) {
    selectVehicle(opt.vehicleId);
    return;
  }
  if (S.planner.from?.lat && S.planner.from?.lon) {
    focusStopOnMap(S.planner.from);
  }
}

function renderPlanner(scroll) {
  const fromSuggestions = S.planner.fromSuggestions.map(s => `<div class="planner-suggestion" onclick="pickPlannerStop('from',${JSON.stringify(s).replace(/"/g,'&quot;')})"><div class="dd-name">${s.name}</div><div class="dd-sub">Stop ${s.code||s.stopId}</div></div>`).join('');
  const toSuggestions = S.planner.toSuggestions.map(s => `<div class="planner-suggestion" onclick="pickPlannerStop('to',${JSON.stringify(s).replace(/"/g,'&quot;')})"><div class="dd-name">${s.name}</div><div class="dd-sub">Stop ${s.code||s.stopId}</div></div>`).join('');
  const results = S.planner.results.length ? S.planner.results.map((opt,i) => {
    const col=vColor(opt.routeType,1), bg=vBg(opt.routeType,1);
    const dep = { realtimeTime: opt.departureRealtime, scheduledTime: opt.departureScheduled, delay: opt.departureDelay, tripId: opt.tripId, routeId: opt.routeId };
    const arrTs = opt.arrivalTs != null ? ((opt.arrivalTs - Date.now()) / 60000) : null;
    const arrCd = fmtCountdown(arrTs);
    return `<div class="planner-route" onclick="focusPlannerOption(${JSON.stringify(opt).replace(/"/g,'&quot;')})" style="animation:fadeUp .15s both;animation-delay:${i*.03}s">
      <div class="planner-badge" style="background:${bg};color:${col}">${(opt.routeShort||'').substring(0,6)}</div>
      <div class="planner-body">
        <div class="planner-route-name">${opt.routeLong||opt.routeShort||opt.routeId}</div>
        <div class="planner-meta">To: ${opt.headsign||opt.toStopName}</div>
        <div class="planner-inline">
          <span class="planner-chip">${opt.stopsBetween ? `${opt.stopsBetween} stops between` : 'Direct stop-to-stop'}</span>
          ${opt.vehicleId ? `<span class="planner-chip">Veh ${opt.vehicleId}</span>` : `<span class="planner-chip">Scheduled trip</span>`}
        </div>
      </div>
      <div class="planner-times">
        <div>${etaPillFromDeparture(dep, 'plan-'+i)}</div>
        <div class="planner-time-sub">${arrCd ? `Arrives ${arrCd.text}` : (opt.arrivalScheduled||'')}</div>
      </div>
    </div>`;
  }).join('') : `<div class="empty"><div class="empty-i">${S.planner.loading ? '⏳' : '🗺️'}</div><div class="empty-t">${S.planner.loading ? 'Finding trips...' : 'Choose origin and destination stops'}</div><div class="empty-s">${!S.planner.loading && S.planner.from && S.planner.to ? 'No direct upcoming trips found yet' : 'Direct trip planner using live Adelaide Metro data'}</div></div>`;

  setHtmlIfChanged(scroll, `<div class="planner-head"><button class="stop-back" onclick="closePlanner()">←</button><div><div class="planner-title">Trip Planner</div><div class="planner-sub">Direct trips between two stops</div></div></div>
    <div class="planner-wrap">
      <div class="planner-card">
        <div class="planner-grid">
          <div class="planner-field">
            <div class="planner-label">From</div>
            <input class="planner-input" id="planner-from" value="${plannerInputValue('from').replace(/"/g,'&quot;')}" oninput="plannerSearch('from',this)" placeholder="Search origin stop">
            ${fromSuggestions ? `<div class="planner-suggestions">${fromSuggestions}</div>` : ''}
          </div>
          <button class="planner-swap" onclick="swapPlannerStops()" aria-label="Swap origin and destination">⇅</button>
          <div class="planner-field">
            <div class="planner-label">To</div>
            <input class="planner-input" id="planner-to" value="${plannerInputValue('to').replace(/"/g,'&quot;')}" oninput="plannerSearch('to',this)" placeholder="Search destination stop">
            ${toSuggestions ? `<div class="planner-suggestions">${toSuggestions}</div>` : ''}
          </div>
          <button class="planner-btn" onclick="runPlanner()" ${(!S.planner.from || !S.planner.to || S.planner.loading)?'disabled':''}>Find Trips</button>
        </div>
      </div>
      ${results}
    </div>`);
}

async function renderStopBoard(scroll) {
  const stop = S.selectedStop;
  const requestId = ++S.stopBoardRequestId;
  const stopLabel = stop.variants > 1
    ? `${stop.variantCodes?.slice(0, 2).map(code => `Stop ${code}`).join(', ')}${(stop.variantCodes?.length || 0) > 2 ? ' +' : ''}`
    : (stop.code ? `Stop ${stop.code}` : '');
  setHtmlIfChanged(scroll, `<div class="stop-hdr"><div class="stop-hdr-row"><button class="stop-back" onclick="closeStop()">←</button><div><div class="stop-name-big">${stop.name||stop.stopId}</div>${stopLabel?`<div class="stop-id-sm">${stopLabel}</div>`:''}</div></div></div><div class="empty"><div class="empty-i" style="animation:spin 1s linear infinite;display:inline-block">⏳</div><div class="empty-t">Loading departures...</div></div>`);
  try {
    const stopIds = stop.memberStopIds?.length ? stop.memberStopIds : [stop.stopId];
    const responses = await Promise.all(
      stopIds.map(id => fetch(`/api/stops/${id}/departures`).then(r=>r.json()))
    );
    if (requestId !== S.stopBoardRequestId || S.mode !== 'stop' || !S.selectedStop || S.selectedStop.stopId !== stop.stopId) return;
    const mergedDepartures = responses.flatMap((data) => data.departures || []);
    const allServices = dedupeStopBoardServices(mergedDepartures);
    if (!allServices.length) {
      setHtmlIfChanged(scroll, `<div class="stop-hdr"><div class="stop-hdr-row"><button class="stop-back" onclick="closeStop()">←</button><div><div class="stop-name-big">${stop.name}</div></div></div></div><div class="empty"><div class="empty-i">🚏</div><div class="empty-t">No departures found</div></div>`);
      hideActionFeedback(180);
      return;
    }
    resetEtaTargets();
    const stopBoardView = stopBoardVisibleServices(allServices);
    const { upcoming } = stopBoardView;
    const visible = S.stopShowAll ? allServices : stopBoardView.visible;
    let rows='';
    visible.forEach((d,i) => {
      const col=vColor(d.routeType,1), bg=vBg(d.routeType,1);
      const occSpan = d.routeType==='tram'&&d.occupancy?`<span title="${d.occupancy.label}" style="margin-left:4px">${d.occupancy.emoji}</span>`:'';
      const timeHtml = etaPillFromDeparture(d, i);
      rows+=`<div class="dep-row" onclick="selectVehicleFromStop('${d.vehicleId||''}')" style="opacity:${d.vehicleId?1:.65}">
        <div class="dep-bd" style="background:${bg};color:${col}">${(d.routeShort||'').substring(0,6)}</div>
        <div class="dep-body">
          <div class="dep-route">${d.routeLong||d.routeShort||d.routeId}${occSpan}</div>
          <div class="dep-head">${d.headsign?`To: ${d.headsign}`:'Service'}${!d.vehicleId?'<span class="dep-tag">Scheduled</span>':''}</div>
        </div>
        ${timeHtml}
      </div>`;
    });
    const meta = S.stopShowAll
      ? `${stop.variants > 1 ? `${stopIds.length} stop points` : `Stop ${stop.stopId}`} · full service (${allServices.length})`
      : stopBoardView.mode === 'hour_window'
        ? `${stop.variants > 1 ? `${stopIds.length} stop points` : `Stop ${stop.stopId}`} · all services in the next hour (${visible.length})`
        : stopBoardView.mode === 'next_five'
          ? `${stop.variants > 1 ? `${stopIds.length} stop points` : `Stop ${stop.stopId}`} · next 5 services`
          : `${stop.variants > 1 ? `${stopIds.length} stop points` : `Stop ${stop.stopId}`} · next 5 available services`;
    const moreBtn = !S.stopShowAll && allServices.length > visible.length ? `<div class="dep-actions"><button class="dep-more-btn" onclick="showAllStopServices()">Show full service (${allServices.length})</button></div>` : '';
    setHtmlIfChanged(scroll, `<div class="stop-hdr"><div class="stop-hdr-row"><button class="stop-back" onclick="closeStop()">←</button><div><div class="stop-name-big">${stop.name}</div><div class="stop-id-sm">${meta}</div></div></div></div>${rows}${moreBtn}`);
    hideActionFeedback(180);
  } catch(e) {
    setHtmlIfChanged(scroll, `<div class="stop-hdr"><div class="stop-hdr-row"><button class="stop-back" onclick="closeStop()">←</button><div><div class="stop-name-big">${stop.name}</div></div></div></div><div class="empty"><div class="empty-i">⚠️</div><div class="empty-t">Failed to load departures</div></div>`);
    hideActionFeedback(180);
  }
}
function closeStop() {
  S.stopBoardRequestId++;
  S.selectedStop=null; S.mode='list'; S.stopShowAll=false;
  resetEtaTargets();
  renderSidebar();
}
function showAllStopServices() {
  S.stopShowAll=true;
  renderSidebar();
}
function selectVehicleFromStop(id) {
  if (!id) {
    focusStopOnMap(S.selectedStop);
    return;
  }
  S.mode='list'; S.selectedStop=null; S.stopShowAll=false;
  if (S.stopFocusLayer) { S.stopFocusLayer.remove(); S.stopFocusLayer=null; }
  selectVehicle(id);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// VEHICLE SELECTION
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function selectVehicle(id) {
  S.selectedId=id; S.selectedStop=null;
  S.mode='list';
  // Reset stop tracking so first poll doesn't trigger a spurious re-render
  delete S.prevStopSeq[id];
  let v = S.vehicles.find(x => x.vehicleId === id);
  if (!v) return;
  renderSidebar(); updateMarkers();
  map.panTo([v.lat,v.lon], {animate:true, duration:.5});

  // Fetch detailed vehicle payload (with upcomingStops)
  document.getElementById('dp-title').textContent=`Loading...`;
  document.getElementById('detail').classList.add('open');
  updateDetailActionButtons();
  syncControlState();
  mobileOpenDetail();

  fetch(`/api/vehicles/${id}`).then(r=>r.json()).then(data => {
    if (data && data.vehicleId) {
      // Overwrite local subset with detailed set
      const idx = S.vehicles.findIndex(x=>x.vehicleId === id);
      if (idx > -1) S.vehicles[idx] = data;
      v = data;
    }
    document.getElementById('dp-title').textContent=`${v.routeShort||'Vehicle'} — ${v.headsign||'Details'}`;
    renderDetailContent(v);
    loadDetailData(v);
  }).catch(e => {
    document.getElementById('dp-title').textContent=`${v.routeShort||'Vehicle'} — ${v.headsign||'Details'}`;
    renderDetailContent(v);
    loadDetailData(v);
  });
}

function closeDetail() {
  showActionFeedback('Returning to map...');
  S.selectedId = null;
  if (S.followMode) {
    S.followMode = false;
    document.getElementById('mc-follow').classList.remove('on');
  }
  if (S.stopFocusLayer) { S.stopFocusLayer.remove(); S.stopFocusLayer=null; }
  if (S.shapeLayer) { S.shapeLayer.remove(); S.shapeLayer=null; }
  document.getElementById('detail').classList.remove('open','expanded','follow-compact');
  updateDetailActionButtons();
  renderSidebar(); updateMarkers();
  syncControlState();
  map.setView(ADELAIDE,12,{animate:true});
  hideActionFeedback(450);
}

function toggleFav() {
  if (!S.selectedId) return;
  const i=S.favs.indexOf(S.selectedId);
  if (i>-1) S.favs.splice(i,1); else S.favs.push(S.selectedId);
  saveFavs();
  updateDetailActionButtons();
  syncControlState();
  renderSidebar();
}

function renderDetailContent(v) {
  const col=vColor(v.routeType,v.speed), bg=vBg(v.routeType,v.speed);
  const typeC={tram:{l:'TRAM',bg:'var(--tram-lt)',col:'var(--tram)',brd:'var(--tram-mid)'},train:{l:'TRAIN',bg:'var(--train-lt)',col:'var(--train)',brd:'var(--train-mid)'},bus:{l:'BUS',bg:'var(--bus-lt)',col:'var(--bus)',brd:'var(--bus-mid)'}}[v.routeType]||{l:'BUS',bg:'var(--bus-lt)',col:'var(--bus)',brd:'var(--bus-mid)'};
  const isMoving=v.speed>0.5;
  const stsC=isMoving?{l:'In Transit',bg:'var(--ok-lt)',col:'var(--ok)'}:{l:'Stopped',bg:'var(--stopped-lt)',col:'var(--stopped)'};
  const delayedStop=firstDelayedStop(v.upcomingStops), delayInfo=delayedStop?fmtDelay(deriveDelaySeconds(delayedStop)):null;
  const currentStop = vehicleCurrentStop(v);
  const nextStop = vehicleNextStop(v);
  const favActive = S.favs.includes(v.vehicleId);

  // Crowd card
  const occInfo = v.occupancy ? (CROWD[v.occupancy.status]||{label:'Unknown',emoji:'⬜',pct:0,color:'var(--ink3)'}) : null;
  const crowdHtml = (v.routeType==='tram'&&occInfo) ? `
    <div class="crowd-card">
      <div class="crowd-lbl">Tram Crowd Level</div>
      <div class="crowd-bg"><div class="crowd-fill" style="width:${occInfo.pct}%;background:${occInfo.color}"></div></div>
      <div class="crowd-row"><span style="font-size:18px">${occInfo.emoji}</span><span>${occInfo.label}</span><span>${occInfo.pct}% full</span></div>
    </div>` : '';

  const alertsHtml=(v.alerts||[]).map(a=>`<div class="dp-alert"><div class="dp-alert-title">⚠️ ${a.header||'Alert'}</div>${a.description?`<div class="dp-alert-body">${a.description}</div>`:''}</div>`).join('');

  document.getElementById('dp-content').innerHTML=`
    <div class="detail-actions">
      <div class="detail-actions-row">
        <button class="detail-action-btn" onclick="closeDetail()" aria-label="Go back to map">
          <span class="ico">←</span><span>Back to map</span>
        </button>
        <button class="detail-action-btn${S.followMode?' on':''}" id="dp-follow" onclick="toggleFollow()" aria-label="Toggle follow selected vehicle" aria-pressed="${S.followMode?'true':'false'}">
          <span class="ico">◎</span><span>${S.followMode?'Following vehicle':'Follow vehicle'}</span>
        </button>
        <button class="detail-action-btn${favActive?' fav-on':''}" id="dp-fav" onclick="toggleFav()" aria-label="Toggle favorite vehicle" aria-pressed="${favActive?'true':'false'}">
          <span class="ico">${favActive?'★':'☆'}</span><span>${favActive?'Saved':'Save vehicle'}</span>
        </button>
      </div>
      <div class="detail-actions-note">Follow keeps this vehicle centered on the map while it moves. Drag the sheet up or down any time to change how much map you can see.</div>
    </div>
    <div class="d-hero">
      <div class="d-hero-top">
        <div class="d-hero-bd" style="background:${bg};color:${col}">${(v.routeShort||'').substring(0,6)}</div>
        <div class="d-hero-main">
          <div class="d-hero-name">${v.routeLong||v.routeShort||v.vehicleId}</div>
          <div class="d-hero-long">${v.headsign?'To: ' + v.headsign:'—'}</div>
          <div class="d-chips">
            <span class="d-chip" style="background:${typeC.bg};color:${typeC.col};border-color:${typeC.brd}">${typeC.l}</span>
            <span class="d-chip" style="background:${stsC.bg};color:${stsC.col};border-color:transparent">${stsC.l}</span>
            ${delayInfo?.cls==='late'?`<span class="d-chip" style="background:var(--danger-lt);color:${delayInfo.color};border-color:transparent">Delayed ${delayInfo.label}</span>`:''}
            ${vehicleAlertCount(v)?'<span class="d-chip" style="background:var(--danger-lt);color:var(--danger);border-color:transparent">⚠ Alert</span>':''}
          </div>
        </div>
      </div>
      <div class="d-hero-stops">
        <div class="d-hero-stop">
          <span class="d-hero-stop-lbl">Current Stop</span>
          <span class="d-hero-stop-val${currentStop?'':' muted'}" id="kv-cur">${currentStop?.stopName||currentStop?.stopId||'Unavailable'}</span>
        </div>
        <div class="d-hero-stop">
          <span class="d-hero-stop-lbl">Next Stop</span>
          <span class="d-hero-stop-val${nextStop?'':' muted'}" id="kv-nxt">${nextStop?.stopName||nextStop?.stopId||'Unavailable'}</span>
        </div>
      </div>
    </div>
        </div>
      </div>
    </div>
    <div class="kpi-row stops">
      <div class="kpi"><div class="kpi-v" id="kv-spd" style="color:${isMoving?'var(--ok)':'var(--stopped)'}">${isMoving?Math.round(v.speed):'0'}</div><div class="kpi-l">km / h</div></div>
      <div class="kpi"><div class="kpi-v" id="kv-dly" style="font-size:${delayInfo?13:21}px;color:${delayInfo?.color||'var(--ink3)'}">${delayInfo?.label||'—'}</div><div class="kpi-l">Delay</div></div>

    </div>
    ${crowdHtml}
    ${alertsHtml}
    <div class="d-sec">Live Position</div>
    <div class="gps-row">
      <div class="gps-cell"><div class="gps-lbl">Latitude</div><div class="gps-val" id="gv-lat">${v.lat?.toFixed(6)}</div></div>
      <div class="gps-cell"><div class="gps-lbl">Longitude</div><div class="gps-val" id="gv-lon">${v.lon?.toFixed(6)}</div></div>
    </div>
    <div class="d-sec">Route Stops</div>
    <div id="stops-zone"><div class="empty-t" style="text-align:center;padding:16px;color:var(--ink3)">Loading...</div></div>
    <div class="d-sec">Trip Info</div>
    <div class="trip-grid">
      <div class="ti-cell"><div class="ti-lbl">Trip</div><div class="ti-val">${v.tripId||'—'}</div></div>
      <div class="ti-cell"><div class="ti-lbl">Route</div><div class="ti-val">${v.routeId||'—'}</div></div>
      <div class="ti-cell"><div class="ti-lbl">Vehicle</div><div class="ti-val">${v.label||v.vehicleId}</div></div>
      <div class="ti-cell"><div class="ti-lbl">Direction</div><div class="ti-val">${v.directionId!=null?(v.directionId==0?'Outbound':'Inbound'):'—'}</div></div>
    </div>
    <div style="height:12px"></div>`;
  updateDetailActionButtons();
}

async function loadDetailData(v) {
  if (!v.tripId) { const sz=document.getElementById('stops-zone'); if(sz) sz.innerHTML='<div class="empty-t" style="text-align:center;padding:16px;color:var(--ink3)">No trip data</div>'; return; }
  try {
    if (v.upcomingStops?.length) {
      renderStopTimelineDirect(v.upcomingStops, v.routeType, !!v.upcomingStops[0]?.arrivalTime);
    }
    if (!S.tripCache[v.tripId]) {
      const r=await fetch(`/api/trips/${v.tripId}`); S.tripCache[v.tripId]=await r.json();
    }
    const td=S.tripCache[v.tripId];
    if (!v.upcomingStops?.length) renderStopTimeline(td.stops||[], v.stopSeq||0, v.routeType, td.hasRealtime);
    const ns=(td.stops||[]).find(s=>s.sequence>=(v.stopSeq||0));
    if (ns) {
      const d=fmtDelay(ns.delay);
      const kd=document.getElementById('kv-dly');
      if (kd&&d) { kd.textContent=d.label; kd.style.color=d.color; kd.style.fontSize='13px'; }
    }
    if (v.shapeId) {
      if (!S.shapeCache[v.shapeId]) {
        fetch(`/api/shape/${v.shapeId}`).then(r=>r.json()).then(data => {
          S.shapeCache[v.shapeId]=data.points||[];
          if (S.selectedId===v.vehicleId) drawShape(v.shapeId,v.routeType);
        }).catch(()=>{});
      } else drawShape(v.shapeId,v.routeType);
    }
  } catch(e) { const sz=document.getElementById('stops-zone'); if(sz) sz.innerHTML='<div class="empty-t" style="text-align:center;padding:16px;color:var(--ink3)">Stop data unavailable</div>'; }
}


function renderStopTimelineRows(el, stops, type, hasRT) {
  if (!stops?.length) { el.innerHTML='<div class="empty-t" style="text-align:center;padding:16px;color:var(--ink3)">End of line</div>'; return; }
  const dc  = type==='tram'?'var(--tram)':type==='train'?'var(--train)':'var(--bus)';
  const dlt = type==='tram'?'var(--tram-lt)':type==='train'?'var(--train-lt)':'var(--bus-lt)';
  let html = '<div class="stop-tl">';
  if (!hasRT) html += '<div style="padding:4px 14px 8px;font-size:10px;color:var(--ink3);display:flex;gap:4px;align-items:center">\u{1F4C5} Scheduled times only</div>';
  stops.forEach((s, i) => {
    const state = s.timelineStatus || (i === 0 ? 'next' : 'upcoming');
    const isPast = state === 'passed';
    const isCurrent = state === 'current';
    const isNext = state === 'next';
    const rtIso  = s.arrivalTime || s.departureTime;
    const delay  = fmtDelay(deriveDelaySeconds(s));
    const mins   = minsUntil(rtIso);
    const cd     = mins !== null ? fmtCountdown(mins) : null;
    const schedDisplay = scheduledTimeDisplay(s.scheduledTime);
    let timeHtml = '';
    if (isPast) {
      timeHtml = '<span class="stop-sched">' + schedDisplay + '</span><span class="stop-delay ontime">Passed</span>';
    } else if (isCurrent) {
      timeHtml = '<span class="stop-delay ontime">Current stop</span>';
      if (schedDisplay) timeHtml = '<span class="stop-sched">' + schedDisplay + '</span> ' + timeHtml;
      if (rtIso) timeHtml += '<span class="stop-rt" style="color:' + (delay?.color || dc) + '">' + fmtTime(rtIso) + '</span>';
    } else if (isNext && cd) {
      const key = 'eta-tl-' + (rtIso||i);
      S.etaTargets[key] = { iso: rtIso };
      timeHtml = '<span class="eta-pill ' + cd.cls + '" data-eta="' + key + '" style="font-size:11px;padding:2px 7px">' + cd.text + '</span>';
    } else if (rtIso) {
      timeHtml = '<span class="stop-rt" style="color:' + (delay?.color || 'var(--ok)') + '">' + fmtTime(rtIso) + '</span>';
    }
    if (s.scheduledTime && !isNext && !isCurrent && !isPast) timeHtml = '<span class="stop-sched">' + schedDisplay + '</span> ' + timeHtml;
    if (delay && !isNext && !isCurrent && !isPast) timeHtml += '<span class="stop-delay ' + delay.cls + '">' + delay.label + '</span>';
    const dotClass = isPast ? ' past' : isCurrent ? ' cur nxt' : isNext ? ' nxt' : '';
    const dotStyle = isPast
      ? ''
      : (isCurrent || isNext)
        ? 'background:' + dc + ';border-color:' + dc + ';box-shadow:0 0 0 3px ' + dlt
        : '';
    const label = isPast ? '(passed)' : isCurrent ? '(current)' : isNext ? '(next)' : '';
    html += '<div class="stop-row">'
      + '<div class="stop-spine"><div class="stop-dot' + dotClass + '" style="' + dotStyle + '"></div>' + (i < stops.length-1 ? '<div class="stop-conn"></div>' : '') + '</div>'
      + '<div class="stop-content">'
      + '<div class="stop-nm" style="' + ((isNext || isCurrent) ? 'color:' + dc + ';font-weight:700' : (isPast ? 'color:var(--ink3)' : '')) + '">' + (s.stopName||s.stopId) + (label ? '<span style="font-size:9px;opacity:.7;margin-left:4px">' + label + '</span>' : '') + '</div>'
      + '<div class="stop-times">' + timeHtml + '</div>'
      + '</div></div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

function renderStopTimelineDirect(upcoming, type, hasRT) {
  const el = document.getElementById('stops-zone');
  if (el) renderStopTimelineRows(el, upcoming, type, hasRT);
}


function renderStopTimeline(stops, curSeq, type, hasRT) {
  const el = document.getElementById('stops-zone');
  if (!el) return;
  const currentIdx = Math.max(stops.findIndex(s => (s.sequence || 0) >= (curSeq || 0)), 0);
  const startIdx = Math.max(0, currentIdx - 3);
  const visible = stops.slice(startIdx).map((s, idx) => {
    const absoluteIdx = startIdx + idx;
    let timelineStatus = 'upcoming';
    if (absoluteIdx < currentIdx) timelineStatus = 'passed';
    else if (absoluteIdx === currentIdx) timelineStatus = 'current';
    else if (absoluteIdx === currentIdx + 1) timelineStatus = 'next';
    return { ...s, timelineStatus };
  });
  renderStopTimelineRows(el, visible, type, hasRT);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SEARCH
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
let searchTimer=null;
document.getElementById('search-in').addEventListener('input', e => {
  const q=e.target.value.trim();
  document.getElementById('search-clear').classList.toggle('show',q.length>0);
  clearTimeout(searchTimer);
  if (q.length<2) { document.getElementById('search-drop').classList.remove('show'); flushFrozenLiveUiUpdates(); return; }
  searchTimer=setTimeout(()=>doSearch(q),260);
});
document.getElementById('search-in').addEventListener('focus', () => {
  const q=document.getElementById('search-in').value.trim();
  if (q.length>=2) doSearch(q);
});
document.getElementById('search-clear').addEventListener('click', () => {
  document.getElementById('search-in').value='';
  document.getElementById('search-clear').classList.remove('show');
  document.getElementById('search-drop').classList.remove('show');
  flushFrozenLiveUiUpdates();
});
document.addEventListener('click', e => {
  if (!document.getElementById('search-wrap').contains(e.target)) {
    document.getElementById('search-drop').classList.remove('show');
    flushFrozenLiveUiUpdates();
  }
});

async function doSearch(q) {
  const ql=q.toLowerCase();
  let html='';
  
  // Routes
  const uniq={};
  S.vehicles.filter(v=>v.routeShort?.toLowerCase().includes(ql)||v.routeLong?.toLowerCase().includes(ql)||v.vehicleId.toLowerCase().includes(ql))
    .forEach(v=>{ if (!uniq[v.routeShort]) uniq[v.routeShort]=v; });
  const rv=Object.values(uniq).slice(0,5);
  if (rv.length) {
    html+=`<div class="dd-sec">🗺️ Active Routes</div>`;
    rv.forEach(v => {
      const cnt=S.vehicles.filter(x=>x.routeShort===v.routeShort).length;
      const col=vColor(v.routeType,1), bg=vBg(v.routeType,1);
      const ico=v.routeType==='tram'?'🚊':v.routeType==='train'?'🚆':'🚌';
      html+=`<div class="dd-item" onclick="filterByRoute('${v.routeShort}')">
        <div class="dd-badge" style="background:${bg};color:${col}">${v.routeShort}</div>
        <div><div class="dd-name">${v.routeLong||v.routeShort}</div><div class="dd-sub">${ico} ${v.routeType} · ${cnt} vehicle${cnt!==1?'s':''} active</div></div>
      </div>`;
    });
  }

  // Stops
  try {
    const allStops = await ensureStopSearchIndex();
    const matchedStops = allStops.filter(s =>
      s.name?.toLowerCase().includes(ql) ||
      s.code?.toLowerCase().includes(ql) ||
      s.stopId?.toLowerCase().includes(ql)
    );
    const groupedStops = groupStopSearchResults(matchedStops, q);
    if (groupedStops.length) {
      html+=`<div class="dd-sec">🚏 Stops</div>`;
      groupedStops.forEach(s => {
        const sub = s.variants > 1
          ? `${s.variants} stop points nearby · ${s.variantCodes.slice(0,2).map(code => `Stop ${code}`).join(', ')}${s.variantCodes.length > 2 ? ' +' : ''}`
          : `Stop ${s.code||s.stopId}`;
        html+=`<div class="dd-item" onclick="pickStop(${JSON.stringify(s).replace(/"/g,'&quot;')})">
          <div class="dd-badge" style="background:var(--surface3);color:var(--ink2)">🚏</div>
          <div><div class="dd-name">${s.name}</div><div class="dd-sub">${sub}</div></div>
        </div>`;
      });
    }
  } catch {}

  if (!html) html=`<div class="dd-empty">No results for "${q}"</div>`;
  document.getElementById('search-drop').innerHTML=html;
  document.getElementById('search-drop').classList.add('show');
}

function pickStop(stopObj) {
  document.getElementById('search-in').value='';
  document.getElementById('search-clear').classList.remove('show');
  document.getElementById('search-drop').classList.remove('show');
  S.stopBoardRequestId++;
  S.selectedStop=stopObj; S.mode='stop'; S.selectedId=null; S.stopShowAll=false;
  document.getElementById('detail').classList.remove('open');
  showActionFeedback('Loading stop details...');
  syncControlState();
  renderSidebar();
  if (stopObj.lat&&stopObj.lon) map.panTo([stopObj.lat,stopObj.lon],{animate:true});
}
function filterByRoute(rs) {
  document.getElementById('search-in').value='';
  document.getElementById('search-clear').classList.remove('show');
  document.getElementById('search-drop').classList.remove('show');
  S.filterRoute=rs; S.tab='all'; S.mode='list'; S.selectedStop=null;
  renderSidebar(); updateMarkers();
  syncControlState();
  if (isMobile()) mobileShowFilteredList();
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// DATA FETCH
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const scheduleVehicleUiRefresh = debounce(() => {
  renderSidebar();
  updateMarkers();
}, UI_DEBOUNCE_MS);

async function applyVehiclesPayloadNow(data) {
  S.vehicles = data.vehicles || [];
  if (data.timestamp) {
    document.getElementById('feed-time').textContent = new Date(data.timestamp).toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit',timeZone:'Australia/Adelaide'});
  }
  if (S.selectedId) await refreshSelectedVehicleDetail();
  scheduleVehicleUiRefresh();
}

function applyAlertsPayloadNow(data) {
  S.alerts = data.alerts || [];
  updateTabCounts();
  if (S.mode === 'alerts') renderSidebar();
}

async function flushFrozenLiveUiUpdates() {
  if (shouldFreezeLiveUiUpdates()) return;
  const nextVehicles = pendingVehiclesPayload;
  const nextAlerts = pendingAlertsPayload;
  pendingVehiclesPayload = null;
  pendingAlertsPayload = null;
  if (nextVehicles) await applyVehiclesPayloadNow(nextVehicles);
  if (nextAlerts) applyAlertsPayloadNow(nextAlerts);
}

async function refreshSelectedVehicleDetail() {
  if (!S.selectedId) return;
  let sv = S.vehicles.find(x => x.vehicleId === S.selectedId);
  try {
    const detail = await fetch('/api/vehicles/' + S.selectedId).then(r => r.json());
    if (detail?.vehicleId === S.selectedId) {
      sv = detail;
      const idx = S.vehicles.findIndex(x => x.vehicleId === S.selectedId);
      if (idx > -1) S.vehicles[idx] = detail;
    }
  } catch {}
  if (!sv) return;

  const la=document.getElementById('gv-lat'); if(la) la.textContent=sv.lat.toFixed(6);
  const lo=document.getElementById('gv-lon'); if(lo) lo.textContent=sv.lon.toFixed(6);
  const ks=document.getElementById('kv-spd'); if(ks){ks.textContent=sv.speed>0.5?Math.round(sv.speed):'0';ks.style.color=sv.speed>0.5?'var(--ok)':'var(--stopped)';}
  const kc=document.getElementById('kv-cur'); if(kc) kc.textContent=vehicleCurrentStop(sv)?.stopName||vehicleCurrentStop(sv)?.stopId||'Unavailable';
  const kn=document.getElementById('kv-nxt'); if(kn) kn.textContent=vehicleNextStop(sv)?.stopName||vehicleNextStop(sv)?.stopId||'Unavailable';

  if (sv.routeType==='tram'&&sv.occupancy) {
    const cf=document.querySelector('.crowd-fill');
    const cr=document.querySelector('.crowd-row');
    const oi=CROWD[sv.occupancy.status]||{pct:0,label:'Unknown',emoji:'?',color:'var(--ink3)'};
    if(cf){cf.style.width=oi.pct+'%';cf.style.background=oi.color;}
    if(cr) cr.innerHTML='<span style=\"font-size:18px\">' + oi.emoji + '</span><span>' + oi.label + '</span><span>' + oi.pct + '% full</span>';
  }

  const currSeq = sv.stopSeq || 0;
  const prevSeq = S.prevStopSeq[S.selectedId];
  const stopsChanged = prevSeq !== currSeq ||
    (sv.upcomingStops?.length && (sv.upcomingStops[0]?.stopId + ':' + (sv.upcomingStops[0]?.timelineStatus||'')) !== S.prevFirstStopId);

  if (stopsChanged) {
    if (sv.upcomingStops?.length) {
      renderStopTimelineDirect(sv.upcomingStops, sv.routeType, !!sv.upcomingStops[0]?.arrivalTime);
      const sz = document.getElementById('stops-zone');
      if (sz && prevSeq !== undefined) {
        sz.style.opacity='0.4';
        setTimeout(()=>sz.style.opacity='1', 300);
      }
    } else if (S.tripCache[sv.tripId]) {
      const td = S.tripCache[sv.tripId];
      renderStopTimeline(td.stops||[], currSeq, sv.routeType, td.hasRealtime);
    }
    S.prevFirstStopId = sv.upcomingStops?.length ? (sv.upcomingStops[0]?.stopId + ':' + (sv.upcomingStops[0]?.timelineStatus||'')) : null;

    const ns = firstDelayedStop(sv.upcomingStops);
    if (ns) {
      const d = fmtDelay(deriveDelaySeconds(ns));
      const kd = document.getElementById('kv-dly');
      if (kd && d) { kd.textContent=d.label; kd.style.color=d.color; kd.style.fontSize='13px'; }
    }
  }
  S.prevStopSeq[S.selectedId] = currSeq;

  if (S.followMode) {
    focusVehicleForFollow(sv);
  }
}

async function applyVehiclesPayload(data) {
  if (shouldFreezeLiveUiUpdates()) {
    pendingVehiclesPayload = data;
    return;
  }
  await applyVehiclesPayloadNow(data);
}

function applyAlertsPayload(data) {
  if (shouldFreezeLiveUiUpdates()) {
    pendingAlertsPayload = data;
    return;
  }
  applyAlertsPayloadNow(data);
}

async function fetchVehicles() {
  try {
    const data = await fetch('/api/vehicles').then(r => r.json());
    await applyVehiclesPayload(data);
  } catch(e) { console.error('[Vehicles]',e.message); }
}

async function fetchAlerts() {
  try {
    const data = await fetch('/api/alerts').then(r => r.json());
    applyAlertsPayload(data);
  } catch(e) { console.error('[Alerts]',e.message); }
}

function stopVehiclePolling() {
  if (S.vehiclePollTimer) clearInterval(S.vehiclePollTimer);
  S.vehiclePollTimer = null;
}

function startVehiclePolling() {
  if (S.vehiclePollTimer) return;
  S.vehiclePollTimer = setInterval(fetchVehicles, VEHICLE_POLL_MS);
}

function stopVehicleStream() {
  if (S.stream) S.stream.close();
  S.stream = null;
}

function startVehicleStream() {
  if (document.hidden) return;
  if (!window.EventSource) {
    startVehiclePolling();
    return;
  }

  stopVehiclePolling();
  stopVehicleStream();
  const stream = new EventSource('/api/stream');
  S.stream = stream;

  stream.addEventListener('vehicles', async (event) => {
    try {
      await applyVehiclesPayload(JSON.parse(event.data));
    } catch (error) {
      console.error('[Stream vehicles]', error.message);
    }
  });

  stream.addEventListener('alerts', (event) => {
    try {
      applyAlertsPayload(JSON.parse(event.data));
    } catch (error) {
      console.error('[Stream alerts]', error.message);
    }
  });

  stream.onerror = () => {
    if (S.stream !== stream) return;
    stopVehicleStream();
    startVehiclePolling();
    setTimeout(() => {
      if (!document.hidden && !S.stream) startVehicleStream();
    }, 5000);
  };
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// INIT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// MOBILE DRAWER + SHEET BEHAVIOUR
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function isMobile() { return window.innerWidth <= 680; }

function mobDrawerOpen() {
  if (!isMobile()) return;
  document.getElementById('detail').classList.remove('expanded');
  document.getElementById('sidebar').classList.add('drawer-open');
  document.getElementById('mob-backdrop').classList.add('show');
  document.getElementById('mob-hamburger').classList.add('open');
  syncControlState();
}

function mobDrawerClose() {
  if (!isMobile()) return;
  document.getElementById('sidebar').classList.remove('drawer-open');
  document.getElementById('mob-backdrop').classList.remove('show');
  document.getElementById('mob-hamburger').classList.remove('open');
  syncControlState();
}

function mobDrawerToggle() {
  if (!isMobile()) return;
  const open = document.getElementById('sidebar').classList.contains('drawer-open');
  open ? mobDrawerClose() : mobDrawerOpen();
}

// Selecting a vehicle on mobile closes the drawer and opens detail sheet
function mobileOpenDetail() {
  if (!isMobile()) return;
  mobDrawerClose();
  const detail = document.getElementById('detail');
  detail.classList.add('open');
  detail.classList.toggle('follow-compact', !!S.followMode);
  if (S.followMode) detail.classList.remove('expanded');
  else detail.classList.add('expanded');
  syncControlState();
}

// Tapping a tab on mobile closes drawer, keeps map visible
function mobilePeekSidebar() {
  if (!isMobile()) return;
  mobDrawerClose();
  syncControlState();
}

// Detail sheet drag — swipe up to expand, down to peek
function setupDetailDrag() {
  const el = document.getElementById('detail');
  let startY=0, startT=0, dragging=false;

  function onStart(e) {
    const head = e.target?.closest?.('.dp-head');
    if (!head) return;
    if (e.target?.closest?.('button, a, input, select, textarea, [role="button"]')) return;
    const rect = head.getBoundingClientRect();
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    if (clientY < rect.top || clientY > rect.bottom) return;
    startY=clientY; startT=Date.now(); dragging=true;
    el.style.transition='none';
  }
  function onEnd(e) {
    if (!dragging) return;
    dragging=false; el.style.transition='';
    const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    const dy = clientY - startY;
    const vel = Math.abs(dy) / Math.max(Date.now()-startT, 1);
    if (Math.abs(dy) < 8) { el.classList.toggle('expanded'); return; }
    if (dy < -30 || vel > 0.35) el.classList.add('expanded');
    else if (dy > 30 || vel > 0.35) el.classList.remove('expanded');
  }
  el.addEventListener('touchstart', onStart, {passive:true});
  el.addEventListener('touchend', onEnd);
  el.addEventListener('mousedown', onStart);
  window.addEventListener('mouseup', onEnd);
}

function initMobileSheets() {
  if (!isMobile()) return;
  setupDetailDrag();
  // Tapping map closes drawer and collapses detail to peek
  map.on('click', () => {
    if (!isMobile()) return;
    mobDrawerClose();
    document.getElementById('detail').classList.remove('expanded');
  });
}

function initSidebarScrollGuard() {
  const scroll = document.getElementById('sb-scroll');
  if (!scroll) return;
  const markScrolling = () => {
    sidebarScrollActive = true;
    if (sidebarScrollTimer) clearTimeout(sidebarScrollTimer);
    sidebarScrollTimer = setTimeout(() => {
      sidebarScrollActive = false;
      flushDeferredSidebarRender();
      flushFrozenLiveUiUpdates();
    }, 220);
  };
  scroll.addEventListener('scroll', markScrolling, { passive: true });
  scroll.addEventListener('touchstart', markScrolling, { passive: true });
  scroll.addEventListener('wheel', markScrolling, { passive: true });
}

map.on('moveend zoomend resize', () => {
  mapInteractionActive = false;
  updateMarkers();
});
map.on('movestart zoomstart', () => {
  mapInteractionActive = true;
});

async function init() {
  applyTheme(S.theme);
  const msg=document.getElementById('ld-msg');
  const msgs=['Connecting to server...','Downloading GTFS timetable...','Loading stops & routes...','Almost ready...'];
  let mi=0;
  const msgT=setInterval(()=>{ mi=Math.min(mi+1,msgs.length-1); msg.textContent=msgs[mi]; },3000);
  try {
    let ready=false;
    for (let i=0;i<30&&!ready;i++) {
      try { const s=await fetch('/api/status').then(r=>r.json()); if(s.staticLoaded) ready=true; } catch {}
      if (!ready) await new Promise(r=>setTimeout(r,2000));
    }
  } catch {}
  clearInterval(msgT);
  msg.textContent='Loading live vehicles...';
  await Promise.all([fetchVehicles(), fetchAlerts()]);
  const ls=document.getElementById('loading-screen');
  ls.classList.add('fade');
  setTimeout(()=>ls.remove(),500);
  startEtaTicker();
  initMobileSheets();
  initSidebarScrollGuard();
  startVehicleStream();
  S.alertPollTimer = setInterval(fetchAlerts, ALERT_POLL_MS);
}

// Background optimization - pause network work when app hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopVehicleStream();
    stopVehiclePolling();
  } else {
    fetchVehicles();
    fetchAlerts();
    startVehicleStream();
  }
});

init();

