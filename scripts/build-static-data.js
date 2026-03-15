const path = require('path');
const { parseArgs, prepareStaticDataFromDirectory, prepareStaticDataFromZipBuffer } = require('./lib/static-data');
const fs = require('fs/promises');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(args.output || path.join(__dirname, '..', 'data', 'static', 'current'));
  const version = args.version || 'manual';

  let manifest;
  if (args['input-dir']) {
    manifest = await prepareStaticDataFromDirectory(path.resolve(args['input-dir']), outputDir, version);
  } else if (args.zip) {
    const zipBuffer = await fs.readFile(path.resolve(args.zip));
    manifest = await prepareStaticDataFromZipBuffer(zipBuffer, outputDir, version);
  } else {
    throw new Error('Provide --input-dir <folder> or --zip <google_transit.zip>');
  }

  console.log(`[static-build] Prepared version ${manifest.version}`);
  console.log(`[static-build] Routes:${manifest.counts.routes} Trips:${manifest.counts.trips} Stops:${manifest.counts.stops}`);
}

main().catch((err) => {
  console.error('[static-build]', err.message);
  process.exit(1);
});
