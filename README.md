# Adelaide Metro Tracker

Real-time Adelaide Metro tracker with a Node.js backend and a single-file frontend.

## Runtime model

The app server no longer downloads `google_transit.zip` at runtime.

Instead:
- static GTFS is prepared ahead of time into local JSON files under [`data/static/current`](/c:/Projects/Adelaide%20Metro/data/static/current)
- `server.js` reads those prepared files on startup
- realtime feeds are still polled directly from Adelaide Metro
- the server reloads local static data daily at `1:05 AM` Adelaide time

This keeps the heavy GTFS ZIP download out of the live app server.

## Prepared static files

The runtime currently uses only:
- `routes.json`
- `trips.json`
- `stops.json`
- `stop_times_compact.json`
- `shapes.json`
- `manifest.json`

These are generated from:
- `routes.txt`
- `trips.txt`
- `stops.txt`
- `stop_times.txt`
- `shapes.txt`

## Quick start

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Static data workflow

### Option 1: build from an extracted GTFS folder

```bash
npm run build:static -- --input-dir C:\path\to\google_transit --version 2026-03-14
```

### Option 2: build from a local ZIP file

```bash
npm run build:static -- --zip C:\path\to\google_transit.zip --version 2026-03-14
```

### Option 3: external updater checks `version.txt` and downloads only when changed

This is intended for an external machine, cron worker, or CI job, not the live app server.

```bash
npm run sync:static
```

That script:
1. checks `https://gtfs.adelaidemetro.com.au/v1/static/latest/version.txt`
2. compares it with the local prepared dataset version
3. downloads `google_transit.zip` only if the version changed
4. rebuilds the prepared files in `data/static/current`

## Files

| File | Purpose |
|---|---|
| [`server.js`](/c:/Projects/Adelaide%20Metro/server.js) | Express server and realtime polling |
| [`index.html`](/c:/Projects/Adelaide%20Metro/index.html) | Full frontend UI |
| [`scripts/build-static-data.js`](/c:/Projects/Adelaide%20Metro/scripts/build-static-data.js) | Build prepared runtime data from local GTFS input |
| [`scripts/sync-static-feed.js`](/c:/Projects/Adelaide%20Metro/scripts/sync-static-feed.js) | External updater that checks `version.txt` and pulls ZIP only when needed |
| [`scripts/lib/static-data.js`](/c:/Projects/Adelaide%20Metro/scripts/lib/static-data.js) | Shared static-data preparation logic |
| [`data/static/current`](/c:/Projects/Adelaide%20Metro/data/static/current) | Prepared local runtime dataset |

## API sources

Realtime only:
- `v1/realtime/vehicle_positions`
- `v1/realtime/trip_updates`
- `v1/realtime/service_alerts`

Static update check for external sync only:
- `v1/static/latest/version.txt`
- `v1/static/latest/google_transit.zip`
