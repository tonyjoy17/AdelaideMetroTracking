const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const AdmZip = require('adm-zip');
const { parse: parseCSV } = require('csv-parse/sync');

function readTextFileSafe(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith('--')) continue;
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function parseCsvText(text) {
  if (!text) return [];
  return parseCSV(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function buildCompactStopTimes(raw) {
  if (!raw) return {};
  const rows = parseCsvText(raw);
  const compact = {};
  rows.forEach((row) => {
    const tripId = row.trip_id;
    const stopId = row.stop_id;
    const seq = row.stop_sequence;
    const time = row.arrival_time || row.departure_time || '';
    if (!tripId || !stopId || !seq) return;
    const packed = `${seq}|${stopId}|${time}`;
    if (compact[tripId]) compact[tripId] += `;${packed}`;
    else compact[tripId] = packed;
  });
  return compact;
}

function buildShapesMap(raw) {
  if (!raw) return {};
  const rows = parseCsvText(raw);
  const shapes = {};
  rows.forEach((row) => {
    const shapeId = row.shape_id;
    if (!shapeId) return;
    if (!shapes[shapeId]) shapes[shapeId] = [];
    shapes[shapeId].push({
      seq: Number(row.shape_pt_sequence || 0),
      lat: parseFloat(row.shape_pt_lat),
      lon: parseFloat(row.shape_pt_lon),
    });
  });
  Object.values(shapes).forEach((points) => points.sort((a, b) => a.seq - b.seq));
  return shapes;
}

function routeType(rawType) {
  const n = parseInt(rawType, 10);
  if (n === 0) return 'tram';
  if (n === 1 || n === 2) return 'train';
  return 'bus';
}

function normalizePreparedData(files, version) {
  const routes = {};
  parseCsvText(files.routes || '').forEach((row) => {
    routes[row.route_id] = {
      shortName: row.route_short_name || row.route_id,
      longName: row.route_long_name || '',
      type: routeType(row.route_type),
    };
  });

  const trips = {};
  parseCsvText(files.trips || '').forEach((row) => {
    trips[row.trip_id] = {
      routeId: row.route_id,
      shapeId: row.shape_id || '',
      headsign: row.trip_headsign || '',
      directionId: row.direction_id ?? null,
    };
  });

  const stops = {};
  parseCsvText(files.stops || '').forEach((row) => {
    stops[row.stop_id] = {
      name: row.stop_name,
      lat: parseFloat(row.stop_lat),
      lon: parseFloat(row.stop_lon),
      code: row.stop_code || '',
    };
  });

  const stopTimesCompact = buildCompactStopTimes(files.stopTimes || '');
  const shapes = buildShapesMap(files.shapes || '');

  return {
    manifest: {
      version: version || 'unknown',
      generatedAt: new Date().toISOString(),
      counts: {
        routes: Object.keys(routes).length,
        trips: Object.keys(trips).length,
        stops: Object.keys(stops).length,
        stopTimesTrips: Object.keys(stopTimesCompact).length,
        shapes: Object.keys(shapes).length,
      },
    },
    routes,
    trips,
    stops,
    stopTimesCompact,
    shapes,
  };
}

async function writePreparedData(outputDir, data) {
  const tempDir = `${outputDir}.tmp-${Date.now()}`;
  await fsp.mkdir(tempDir, { recursive: true });

  await Promise.all([
    fsp.writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify(data.manifest, null, 2)),
    fsp.writeFile(path.join(tempDir, 'routes.json'), JSON.stringify(data.routes)),
    fsp.writeFile(path.join(tempDir, 'trips.json'), JSON.stringify(data.trips)),
    fsp.writeFile(path.join(tempDir, 'stops.json'), JSON.stringify(data.stops)),
    fsp.writeFile(path.join(tempDir, 'stop_times_compact.json'), JSON.stringify(data.stopTimesCompact)),
    fsp.writeFile(path.join(tempDir, 'shapes.json'), JSON.stringify(data.shapes)),
  ]);

  await fsp.rm(outputDir, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(outputDir), { recursive: true });
  await fsp.rename(tempDir, outputDir);
}

async function prepareStaticDataFromDirectory(inputDir, outputDir, version) {
  const data = normalizePreparedData({
    routes: readTextFileSafe(path.join(inputDir, 'routes.txt')),
    trips: readTextFileSafe(path.join(inputDir, 'trips.txt')),
    stops: readTextFileSafe(path.join(inputDir, 'stops.txt')),
    stopTimes: readTextFileSafe(path.join(inputDir, 'stop_times.txt')),
    shapes: readTextFileSafe(path.join(inputDir, 'shapes.txt')),
  }, version);

  await writePreparedData(outputDir, data);
  return data.manifest;
}

async function prepareStaticDataFromZipBuffer(zipBuffer, outputDir, version) {
  const zip = new AdmZip(zipBuffer);
  const entryText = (name) => {
    const entry = zip.getEntry(name);
    return entry ? entry.getData().toString('utf8') : '';
  };

  const data = normalizePreparedData({
    routes: entryText('routes.txt'),
    trips: entryText('trips.txt'),
    stops: entryText('stops.txt'),
    stopTimes: entryText('stop_times.txt'),
    shapes: entryText('shapes.txt'),
  }, version);

  await writePreparedData(outputDir, data);
  return data.manifest;
}

module.exports = {
  parseArgs,
  prepareStaticDataFromDirectory,
  prepareStaticDataFromZipBuffer,
};
