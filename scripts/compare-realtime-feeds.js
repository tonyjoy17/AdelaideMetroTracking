const https = require('https');
const GtfsRT = require('gtfs-realtime-bindings').transit_realtime;

const FEEDS = {
  v1: 'https://gtfs.adelaidemetro.com.au/v1/realtime/vehicle_positions',
  v2: 'https://gtfs.adelaidemetro.com.au/v2/realtime/vehicle_positions',
};

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

function decodeFeed(buffer, label) {
  try {
    return GtfsRT.FeedMessage.decode(buffer);
  } catch (error) {
    throw new Error(`Failed to decode ${label}: ${error.message}`);
  }
}

function vehicleIdForEntity(entity) {
  return String(entity?.vehicle?.vehicle?.id || entity?.id || '').trim();
}

function normalizeScalar(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    if (typeof value.low === 'number') return value.low;
    if (typeof value.toNumber === 'function') return value.toNumber();
    if (typeof value.toString === 'function') {
      const asString = value.toString();
      const asNumber = Number(asString);
      return Number.isNaN(asNumber) ? asString : asNumber;
    }
  }
  return value;
}

function summarizeFeed(label, feed) {
  const entities = feed.entity || [];
  const vehicleEntities = entities.filter((entity) => entity.vehicle);
  const ids = new Set();
  const stats = {
    label,
    totalEntities: entities.length,
    vehicleEntities: vehicleEntities.length,
    withPosition: 0,
    withTrip: 0,
    withBearing: 0,
    withSpeed: 0,
    withStopSequence: 0,
    withOccupancy: 0,
    withTimestamp: 0,
    withLabel: 0,
  };

  vehicleEntities.forEach((entity) => {
    const vehicle = entity.vehicle || {};
    const position = vehicle.position || {};
    const id = vehicleIdForEntity(entity);
    if (id) ids.add(id);
    if (position.latitude != null && position.longitude != null) stats.withPosition++;
    if (vehicle.trip?.tripId || vehicle.trip?.routeId) stats.withTrip++;
    if (position.bearing != null) stats.withBearing++;
    if (position.speed != null) stats.withSpeed++;
    if (vehicle.currentStopSequence != null) stats.withStopSequence++;
    if (vehicle.occupancyStatus != null) stats.withOccupancy++;
    if (vehicle.timestamp != null) stats.withTimestamp++;
    if (vehicle.vehicle?.label) stats.withLabel++;
  });

  return { stats, ids };
}

function pct(value, total) {
  if (!total) return '0.0%';
  return `${((value / total) * 100).toFixed(1)}%`;
}

function printSummary(summary) {
  const { stats } = summary;
  const total = stats.vehicleEntities;
  console.log(`\n${stats.label.toUpperCase()} SUMMARY`);
  console.log(`Feed entities: ${stats.totalEntities}`);
  console.log(`Vehicle entities: ${stats.vehicleEntities}`);
  console.log(`Unique vehicle ids: ${summary.ids.size}`);
  console.log(`With position: ${stats.withPosition} (${pct(stats.withPosition, total)})`);
  console.log(`With trip info: ${stats.withTrip} (${pct(stats.withTrip, total)})`);
  console.log(`With bearing: ${stats.withBearing} (${pct(stats.withBearing, total)})`);
  console.log(`With speed: ${stats.withSpeed} (${pct(stats.withSpeed, total)})`);
  console.log(`With stop sequence: ${stats.withStopSequence} (${pct(stats.withStopSequence, total)})`);
  console.log(`With occupancy: ${stats.withOccupancy} (${pct(stats.withOccupancy, total)})`);
  console.log(`With timestamp: ${stats.withTimestamp} (${pct(stats.withTimestamp, total)})`);
  console.log(`With vehicle label: ${stats.withLabel} (${pct(stats.withLabel, total)})`);
}

function printOverlap(v1, v2) {
  const onlyV1 = [...v1.ids].filter((id) => !v2.ids.has(id));
  const onlyV2 = [...v2.ids].filter((id) => !v1.ids.has(id));
  const inBoth = [...v1.ids].filter((id) => v2.ids.has(id));

  console.log('\nOVERLAP');
  console.log(`In both feeds: ${inBoth.length}`);
  console.log(`Only in v1: ${onlyV1.length}`);
  console.log(`Only in v2: ${onlyV2.length}`);
  console.log(`Sample only in v1: ${onlyV1.slice(0, 10).join(', ') || '(none)'}`);
  console.log(`Sample only in v2: ${onlyV2.slice(0, 10).join(', ') || '(none)'}`);
}

function normalizeVehicle(entity) {
  const vehicle = entity?.vehicle || {};
  const position = vehicle.position || {};
  return {
    id: vehicleIdForEntity(entity),
    label: vehicle.vehicle?.label ?? null,
    tripId: vehicle.trip?.tripId ?? null,
    routeId: vehicle.trip?.routeId ?? null,
    latitude: normalizeScalar(position.latitude),
    longitude: normalizeScalar(position.longitude),
    bearing: normalizeScalar(position.bearing),
    speed: normalizeScalar(position.speed),
    stopSequence: normalizeScalar(vehicle.currentStopSequence),
    occupancyStatus: normalizeScalar(vehicle.occupancyStatus),
    timestamp: normalizeScalar(vehicle.timestamp),
    currentStatus: vehicle.currentStatus != null ? String(normalizeScalar(vehicle.currentStatus)) : null,
  };
}

function roundNumber(value, decimals) {
  if (value == null) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function sameValue(field, left, right) {
  if (field === 'latitude' || field === 'longitude') return roundNumber(left, 6) === roundNumber(right, 6);
  if (field === 'bearing' || field === 'speed') return roundNumber(left, 3) === roundNumber(right, 3);
  return left === right;
}

function compareFeeds(v1Feed, v2Feed) {
  const v1Map = new Map((v1Feed.entity || []).filter((entity) => entity.vehicle).map((entity) => {
    const vehicle = normalizeVehicle(entity);
    return [vehicle.id, vehicle];
  }));
  const v2Map = new Map((v2Feed.entity || []).filter((entity) => entity.vehicle).map((entity) => {
    const vehicle = normalizeVehicle(entity);
    return [vehicle.id, vehicle];
  }));

  const sharedIds = [...v1Map.keys()].filter((id) => v2Map.has(id));
  const fields = ['label', 'tripId', 'routeId', 'latitude', 'longitude', 'bearing', 'speed', 'stopSequence', 'occupancyStatus', 'timestamp', 'currentStatus'];
  const diffCounts = Object.fromEntries(fields.map((field) => [field, 0]));
  const examples = [];

  sharedIds.forEach((id) => {
    const left = v1Map.get(id);
    const right = v2Map.get(id);
    const differences = {};

    fields.forEach((field) => {
      if (!sameValue(field, left[field], right[field])) {
        diffCounts[field]++;
        differences[field] = { v1: left[field], v2: right[field] };
      }
    });

    if (Object.keys(differences).length && examples.length < 5) {
      examples.push({ id, differences });
    }
  });

  return { sharedIds: sharedIds.length, diffCounts, examples };
}

function printDiff(diff) {
  console.log('\nFIELD DIFFERENCES (shared vehicle ids)');
  console.log(`Shared vehicles compared: ${diff.sharedIds}`);
  Object.entries(diff.diffCounts).forEach(([field, count]) => {
    console.log(`${field}: ${count}`);
  });

  console.log('\nSAMPLE DIFFERENCES');
  if (!diff.examples.length) {
    console.log('(none)');
    return;
  }

  diff.examples.forEach((example) => {
    console.log(`Vehicle ${example.id}`);
    Object.entries(example.differences).forEach(([field, values]) => {
      console.log(`  ${field}: v1=${values.v1} | v2=${values.v2}`);
    });
  });
}

async function main() {
  const [v1Buffer, v2Buffer] = await Promise.all([
    fetchBuffer(FEEDS.v1),
    fetchBuffer(FEEDS.v2),
  ]);

  const v1Feed = decodeFeed(v1Buffer, 'v1');
  const v2Feed = decodeFeed(v2Buffer, 'v2');

  const v1Summary = summarizeFeed('v1', v1Feed);
  const v2Summary = summarizeFeed('v2', v2Feed);
  const diff = compareFeeds(v1Feed, v2Feed);

  console.log('Adelaide Metro realtime vehicle_positions comparison');
  console.log(`v1: ${FEEDS.v1}`);
  console.log(`v2: ${FEEDS.v2}`);

  printSummary(v1Summary);
  printSummary(v2Summary);
  printOverlap(v1Summary, v2Summary);
  printDiff(diff);
}

main().catch((error) => {
  console.error('[compare-realtime-feeds]', error.message);
  process.exit(1);
});
