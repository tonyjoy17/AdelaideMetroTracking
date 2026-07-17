const fs = require('fs/promises');
const path = require('path');

function shapeShardKey(shapeId) {
  let hash = 2166136261;
  for (const char of String(shapeId || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 32).toString(16).padStart(2, '0');
}

async function main() {
  const dataDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'static', 'current'));
  const shapes = JSON.parse(await fs.readFile(path.join(dataDir, 'shapes.json'), 'utf8'));
  const shards = {};
  Object.entries(shapes).forEach(([shapeId, points]) => {
    const key = shapeShardKey(shapeId);
    if (!shards[key]) shards[key] = {};
    shards[key][shapeId] = points;
  });
  const outputDir = path.join(dataDir, 'shape_shards');
  await fs.rm(outputDir, { recursive:true, force:true });
  await fs.mkdir(outputDir, { recursive:true });
  await Promise.all(Object.entries(shards).map(([key, value]) =>
    fs.writeFile(path.join(outputDir, `${key}.json`), JSON.stringify(value))
  ));
  console.log(`[shape-shards] Wrote ${Object.keys(shards).length} shards for ${Object.keys(shapes).length} shapes`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
