const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const trips = JSON.parse(fs.readFileSync(path.join(dir, 'trips.json'), 'utf8'));
const compact = JSON.parse(fs.readFileSync(path.join(dir, 'stop_times_compact.json'), 'utf8'));

const index = {};
Object.entries(trips).forEach(([tripId]) => {
  const c = compact[tripId];
  if (!c) return;
  c.split(';').filter(Boolean).forEach(item => {
    const [seq, stopId, t] = item.split('|');
    if (!index[stopId]) index[stopId] = [];
    index[stopId].push({ tripId, seq: Number(seq), stopId, t: t || null });
  });
});

fs.writeFileSync(path.join(dir, 'stop_trip_index.json'), JSON.stringify(index));
console.log(`stop_trip_index.json written — ${Object.keys(index).length} stops indexed`);