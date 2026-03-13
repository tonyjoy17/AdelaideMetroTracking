# Adelaide Metro Tracker

Real-time transit tracker for Adelaide Metro — trams, trains, and buses.
Built with Node.js backend + vanilla HTML/JS frontend. Ready for Capacitor mobile conversion.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open in browser
open http://localhost:3000
```

---

## How It Works

```
Browser/App
    │
    ▼
Node.js Server (server.js)  ←── polls every 15s
    │
    ├── /api/vehicles   — enriched vehicle positions
    ├── /api/alerts     — service disruptions
    ├── /api/trips/:id  — stop ETAs for a trip
    ├── /api/shape/:id  — route polyline for map
    └── /api/status     — feed health check
    │
    ▼
Adelaide Metro GTFS-RT APIs
    ├── vehicle_positions/debug   (15s)
    ├── trip_updates/debug        (60s)
    ├── service_alerts/debug      (5min)
    └── static/latest/google_transit.zip  (daily version check)
```

---

## Files

| File         | Purpose                                      |
|--------------|----------------------------------------------|
| `server.js`  | Node.js proxy — parses feeds, serves API     |
| `index.html` | Full web app — map, sidebar, detail panel    |
| `package.json` | Dependencies                               |

---

## Features

- **Live map** — all 53+ vehicles plotted with direction arrows
- **Filter by type** — Tram / Train / Bus tabs with live counts
- **Search** — by route number, route name, or vehicle ID
- **Select any vehicle** — tap in list or tap on map
- **Detail panel** — speed, bearing, GPS, upcoming stops with real ETAs + delay info
- **Route shape** — draws the vehicle's route path on the map when selected
- **Service alerts** — real disruptions from the alerts feed, linked to vehicles
- **Favourites** — star vehicles, filter to starred only, persisted in localStorage
- **Follow mode** — map stays centred on selected vehicle as it moves
- **Light theme** — clean, readable design
- **Mobile-ready** — responsive layout, touch/pinch zoom, bottom sheet panel

---

## Convert to Mobile App (Capacitor)

```bash
# Install Capacitor
npm install @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android

# Initialise
npx cap init "Adelaide Metro" "com.adelaidemetro.tracker"

# Add platforms
npx cap add ios
npx cap add android

# Build and sync
npx cap sync

# Open in Xcode / Android Studio
npx cap open ios
npx cap open android
```

For mobile, update `API` in `index.html` to point to your deployed server URL instead of `/api/...`.

---

## API Endpoints Used

| Endpoint | Interval | Purpose |
|---|---|---|
| `v1/realtime/vehicle_positions/debug` | 15s | Vehicle lat/lon/speed/bearing |
| `v1/realtime/trip_updates/debug` | 60s | Stop ETAs and delays |
| `v1/realtime/service_alerts/debug` | 5min | Disruptions and alerts |
| `v1/static/latest/google_transit.zip` | Daily | Routes, stops, shapes, timetables |
| `v1/static/latest/version.txt` | Daily | Check if timetable changed |
