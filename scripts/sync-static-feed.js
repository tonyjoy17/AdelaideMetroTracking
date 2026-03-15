const https = require('https');
const path = require('path');
const fs = require('fs/promises');
const { parseArgs, prepareStaticDataFromZipBuffer } = require('./lib/static-data');

const VERSION_URL = 'https://gtfs.adelaidemetro.com.au/v1/static/latest/version.txt';
const ZIP_URL = 'https://gtfs.adelaidemetro.com.au/v1/static/latest/google_transit.zip';

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

async function readManifestVersion(outputDir) {
  try {
    const raw = await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf8');
    return JSON.parse(raw).version || null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(args.output || path.join(__dirname, '..', 'data', 'static', 'current'));
  const remoteVersion = (await fetchBuffer(VERSION_URL)).toString('utf8').trim();
  const currentVersion = await readManifestVersion(outputDir);

  if (remoteVersion && currentVersion === remoteVersion) {
    console.log(`[static-sync] Already up to date at ${remoteVersion}`);
    return;
  }

  const zipBuffer = await fetchBuffer(ZIP_URL);
  const manifest = await prepareStaticDataFromZipBuffer(zipBuffer, outputDir, remoteVersion || 'unknown');
  console.log(`[static-sync] Updated to version ${manifest.version}`);
}

main().catch((err) => {
  console.error('[static-sync]', err.message);
  process.exit(1);
});
