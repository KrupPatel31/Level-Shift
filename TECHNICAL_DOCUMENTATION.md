# LevelShift — Technical Documentation

Live site: https://levelshift.me/
Repository: https://github.com/KrupPatel31/Level-Shift

This document describes the internal architecture, data flow, and key implementation decisions behind LevelShift, for anyone maintaining or extending the codebase.

---

## 1. Overview

LevelShift is a single-page, client-side-only web application. There is no backend server for the app itself — all orbital math (SGP4/SDP4 propagation) runs in the browser, and the satellite catalog is a static file (`public/tle.txt`) refreshed on a schedule by a GitHub Action. This keeps hosting trivial (any static file host works) while still showing near-real-time satellite positions.

### 1.1 High-level architecture

```
┌─────────────────────────────┐
│   CelesTrak TLE feed         │
│ (active satellites catalog)  │
└──────────────┬───────────────┘
               │ daily, via GitHub Actions
               ▼
     public/tle.txt (bundled with the app)
               │ fetched by the client at runtime
               ▼
┌───────────────────────────────────────────┐
│ Browser (src/main.js)                      │
│  1. Parse TLE text → satrec objects         │
│  2. Propagate positions (satellite.js)      │
│  3. Render points on globe (globe.gl/three) │
│  4. Handle UI: filters, search, geolocation │
└───────────────────────────────────────────┘
```

---

## 2. Project Structure

```
Level-Shift/
├── index.html                  # DOM shell, Tailwind config, all CSS, UI markup
├── src/main.js                 # All application logic (single module, ~970 lines)
├── public/
│   ├── satellite.min.js        # satellite.js (SGP4/SDP4 propagation library)
│   └── tle.txt                 # TLE dataset, ~16,000 satellites (~2.6 MB)
├── .github/workflows/          # CI: scheduled TLE refresh job
├── package.json                # Dependencies: globe.gl, three, solar-calculator
└── vite build tooling
```

`src/main.js` is intentionally a single module with no framework (no React/Vue) — the app is one page with one continuously-updating visualization, so a plain ES module keeps the render loop and DOM updates easy to reason about without added build complexity.

---

## 3. Core Dependencies

| Package                                                        | Purpose                                                                                                                                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `globe.gl`                                                     | High-level wrapper around three.js for rendering an interactive 3D globe with points, tiles, and camera controls.                                                                   |
| `three` (r185)                                                 | Underlying WebGL rendering engine; used directly for the custom cloud layer.                                                                                                        |
| `solar-calculator`                                             | Computes the sun's sub-solar point (lat/lng) for the day/night terminator overlay.                                                                                                  |
| `satellite.js` (`public/satellite.min.js`, global `satellite`) | SGP4/SDP4 orbital propagation: converts TLE lines into a `satrec` and computes ECI position/velocity at a given time. Loaded as a plain `<script>` tag (global), not an npm import. |
| Tailwind CSS (CDN)                                             | Utility-first styling, configured inline in `index.html` with custom font families.                                                                                                 |

---

## 4. Data Pipeline

### 4.1 TLE format

A TLE (Two-Line Element set) is a fixed-width text format for describing a satellite's orbit, issued in 3-line groups:

```
<Satellite Name>
1 NNNNNU NNNNNAAA NNNNN.NNNNNNNN ...   ← line 1: catalog #, epoch, drag terms
2 NNNNN NNN.NNNN NNN.NNNN ...          ← line 2: inclination, RAAN, eccentricity, etc.
```

### 4.2 Fetching (`fetchLocalTLE`)

- Fetches `public/tle.txt` (served at the absolute path `/tle.txt`).
- Since the file is ~2.6 MB, the response body is streamed via `response.body.getReader()` with a progress callback (`onProgress`) driving the loading screen's percentage — rather than a blocking `.text()` call, which would leave the loading screen looking frozen on slow connections.
- Falls back to a plain `.text()` read if `Content-Length` isn't available.

### 4.3 Parsing (`parseTLEText`)

Splits the raw text into lines and groups them in 3s (name, line 1, line 2), validating that line 1 starts with `"1 "` and line 2 starts with `"2 "`. Malformed groups are skipped rather than crashing the whole load.

### 4.4 Epoch & launch year extraction (`parseTLEEpoch`)

TLE line 1 encodes two pieces of date info at fixed column offsets:

- **Launch year** (`tle1[9:11]`) — used for the search-by-year feature.
- **Epoch year + day-of-year fraction** (`tle1[18:20]`, `tle1[20:32]`) — the timestamp the orbital elements were measured at, used to compute the "Data: <date>" freshness badge and flag TLEs older than 7 days as stale.

Both use a pivot-year rule (`yy < 57 → 20yy, else 19yy`) per the standard two-digit-year TLE convention.

### 4.5 Satellite object creation (`createSatellites`)

For each raw `{name, tle1, tle2}`, builds an internal satellite record:

```js
{
  name, tle1, tle2,
  satrec,             // from twoline2satrec() — used every propagation tick
  lat, lng, alt,       // updated every render tick
  color,               // derived from constellation name or a hash-based palette
  isOverhead,          // whether this satellite is currently near the user
  entryTime,           // timestamp it became overhead (for "Xs ago" display)
  launchYear, epochDate,
  origin,              // best-effort country/operator guess
}
```

Records that fail `twoline2satrec()` (malformed orbital elements) are logged and dropped rather than aborting the whole load.

### 4.6 Origin inference (`guessOrigin` / `ORIGIN_PATTERNS`)

TLEs carry no operator/country field. `ORIGIN_PATTERNS` is an ordered list of regexes matched against the uppercased satellite name (e.g. `STARLINK|GPS|NOAA` → `US`, `COSMOS|GLONASS` → `RU`, `BEIDOU|TIANGONG` → `CN`). This is explicitly a heuristic, surfaced in the UI with a tooltip clarifying it's "not an authoritative registry."

### 4.7 Scheduled refresh

- **Server-side**: `.github/workflows/*.yml` runs daily at 04:17 UTC, downloads CelesTrak's `GROUP=active` TLE feed, validates it (minimum line count, `1 `/`2 ` format check per record), and commits `public/tle.txt` only if it changed. A bad/empty/too-small download aborts without touching the existing file.
- **Client-side**: `scheduleDataRefresh()` re-fetches `/tle.txt` every 6 hours in the running app. If the newly parsed data's freshest epoch is more recent than the currently loaded data's, it swaps `satellites` in place (and refreshes the density slider bounds + freshness badge) — otherwise it's discarded. This lets a long-lived open tab pick up a redeploy without a manual reload.

---

## 5. Orbital Propagation & Rendering Loop

### 5.1 Position computation (`updatePositions`)

On each tick:

1. Get current time and GMST (`gstime(now)`) — needed to convert Earth-Centered Inertial (ECI) coordinates to Earth-fixed lat/lng.
2. For every satellite: `propagate(satrec, now)` → ECI position → `eciToGeodetic()` → lat/lng/alt in degrees/km.
3. Filter by active constellation filter + origin filter (`filterSatellites`).
4. Truncate to `maxDisplaySatellites` if the density slider is below "All".
5. Union in any satellites currently "overhead" the user (even if filtered out elsewhere) and the currently-searched satellite, so they're never hidden.
6. Push the final list to `globe.pointsData()`.

### 5.2 Update cadence & performance

Recomputing all ~16,000 satellite positions on every animation frame (60 fps) is CPU-prohibitive, especially on phones — this was a known freeze bug that's since been fixed. Instead:

- A **fixed-rate `setInterval`** drives `updatePositions()`:
  - Desktop: every 1000 ms, unlimited default density.
  - Mobile (detected via `matchMedia("(max-width: 767px)")` or touch + UA sniffing): every 1200 ms, default density capped at 800 satellites.
- Updates **pause entirely** when the tab is hidden (`visibilitychange`), saving battery.
- The **hovered satellite's info panel** runs on its own separate `requestAnimationFrame` loop (`hoverInfoLoop`) — since propagating a single satellite is cheap, this stays smooth at full frame rate without reintroducing the full-fleet-per-frame cost.
- globe.gl's own internal render loop (camera movement, drag/zoom interaction) is unaffected by the slower position-update timer — only the satellite _positions_ refresh at the throttled rate, not the 3D rendering itself.

### 5.3 Altitude scaling (`scaleAltitude`)

Real satellite altitudes range from ~200 km (LEO) to ~36,000 km (GEO). Rendering that literally would either bury low satellites inside the globe surface or place GEO satellites impractically far out, so altitude is compressed logarithmically:

```js
scaled = log(realAltKm + 1) * 0.032; // then clamped to [0.02, 0.22]
```

### 5.4 Coloring (`getSatelliteColor`)

Known constellations get fixed colors (Starlink amber, ISS teal, NOAA green, GPS violet); everything else gets a deterministic color from a 6-color palette via a simple string hash (`hashCode`) on the satellite name, so the same satellite always renders the same color across sessions.

---

## 6. Globe / Visual Layer (globe.gl + three.js)

- **Base globe**: blue-marble Earth texture + topology bump map + night-sky background, loaded from `three-globe`'s CDN-hosted example assets.
- **Atmosphere**: `globe.gl` built-in atmosphere glow (`showAtmosphere`, `atmosphereColor`).
- **Cloud layer** (`addCloudLayer`): a separate translucent sphere mesh added directly to the three.js scene graph (independent of globe.gl's data-driven layers), slowly rotated each frame. Wrapped so a failed texture load degrades gracefully — the rest of the app is unaffected.
- **Day/night terminator**: uses globe.gl's `tilesData` layer with a single "tile" positioned at the current sub-solar point (computed via `solar-calculator`'s `century`/`equationOfTime`/`declination`), re-synced once a minute inside the same throttled update loop rather than a separate timer.
- **Points layer**: satellites + the user marker are rendered as `pointsData`, with `pointColor`, `pointAltitude`, and `pointRadius` accessor functions.

---

## 7. Geolocation & "Overhead Now"

- `requestUserLocation()` uses the browser Geolocation API (`enableHighAccuracy: false`, 12 s timeout, 60 s max cached age — tuned for a fast fix over precision).
- On success, stores `userLat`/`userLng`, creates a `userMarker` point (rendered on the globe), and updates the coordinates badge.
- On failure, maps each `GeolocationPositionError` code to a specific, user-visible retry message (denied / unavailable / timed out) rather than a silent console warning — the badge itself is clickable to retry.
- **Overhead detection**: on every position update tick, any satellite within an angular distance of **2°** great-circle from the user's lat/lng (via the haversine-derived `angularDistance`) and with `alt > 0` is considered "overhead." A satellite transitioning into that state triggers a short 3-beep Web Audio tone (`playBeepSequence`) and is timestamped (`entryTime`) for the "Xs ago" display in the Overhead panel.
- The Overhead panel lists up to 5 currently-overhead satellites, sorted by most-recently-entered first.

---

## 8. UI Controls Reference

| Control                    | Element ID                        | Behavior                                                                                                                                                                                                                                             |
| -------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Constellation filter chips | `#filter-buttons` (`.filter-btn`) | All / Starlink / ISS / NOAA / GPS — substring match on satellite name.                                                                                                                                                                               |
| Origin dropdown            | `#origin-filter`                  | Filters by inferred country/operator. Selecting a specific origin resets the constellation filter to "All" and disables the other chips (`applyOriginFilter`) to avoid landing on an empty globe from an impossible combination (e.g. Russia + ISS). |
| Search box                 | `#satellite-search`               | Debounced (150 ms) substring match on name, or exact match on 4-digit launch year; flies camera to the first match. Enter key does an immediate (non-debounced) search.                                                                              |
| Density slider             | `#density-slider`                 | Caps the number of rendered points; bounds/step are computed from the actual loaded satellite count in `setupDensitySlider`.                                                                                                                         |
| Fullscreen button          | `#fullscreen-btn`                 | Wraps `requestFullscreen`/`exitFullscreen` in try/catch since iOS Safari support is inconsistent.                                                                                                                                                    |
| Reset view                 | `#reset-view-btn`                 | Returns camera to the default point of view (centered on India, altitude 2.5).                                                                                                                                                                       |
| Share button               | `#share-btn`                      | Serializes current camera position + filters into URL query params and copies the link to the clipboard.                                                                                                                                             |
| Mute toggle                | `#mute-btn`                       | Toggles the overhead-alert beep sound.                                                                                                                                                                                                               |
| Overhead panel toggle      | `#toggle-overhead`                | Shows/hides the "Overhead Now" side panel.                                                                                                                                                                                                           |
| User coords badge          | `#user-coords`                    | Shows geolocation status; click to retry.                                                                                                                                                                                                            |
| UTC clock                  | `#utc-clock`                      | Live-updating UTC time, ticking every second.                                                                                                                                                                                                        |
| Data freshness badge       | `#data-epoch-badge`               | Shows the freshest TLE epoch date among loaded satellites; visually flagged if >7 days old.                                                                                                                                                          |

### 8.1 Shareable links

`share-btn` builds a URL with `lat`, `lng`, `alt`, `filter`, `origin` query params. On load, `main.js` reads these same params (with validation against known allowed values) and reapplies the camera position and filters — `applyOriginFilter` is reused for both direct user interaction and this restore path so the two can never drift out of sync.

---

## 9. Error Handling & Resilience

- **TLE fetch/parse failure**: falls back to a small hardcoded sample of 3 satellites (ISS, a Starlink, a NOAA satellite) so the app still renders something functional, with a visible warning banner.
- **Individual malformed TLE records**: skipped during parsing/`satrec` creation rather than failing the whole batch.
- **Cloud texture load failure**: logged and ignored; globe still renders without clouds.
- **Scheduled refresh failure** (client-side): caught and logged; the currently-loaded satellite data is left untouched.
- **Geolocation errors**: surfaced directly in the UI badge (not just console), since console output isn't visible on mobile.
- **Fullscreen API absence/rejection**: caught and surfaced as an inline error message rather than a silent no-op.

---

## 10. Responsive / Mobile Considerations

- `isMobile` detection combines a media query (`max-width: 767px`) with touch-point + user-agent sniffing, driving the `PERF` config (slower update interval, lower default density).
- The toolbar wraps into a variable number of rows depending on viewport width; `observeToolbarHeight()` uses a `ResizeObserver` to write the toolbar's live rendered height into a CSS custom property (`--toolbar-h`), which the Overhead panel's `top` offset reads — avoiding a hardcoded offset that would break whenever the toolbar's row count changes.
- Safe-area insets (`env(safe-area-inset-*)`) are respected for the HUD corner brackets, for notched devices.

---

## 11. Build & Deployment

- **Dev server**: `npm run dev` (Vite).
- **Production build**: `npm run build` → static output in `dist/` (HTML/JS/CSS + copied `public/` assets). Deployable to any static host (the production site is served at `https://levelshift.me/`).
- **Preview**: `npm run preview` serves the built `dist/` locally.
- No environment variables or backend configuration are required — the only external runtime dependency is the CDN-hosted `three-globe` example textures and Google Fonts, plus the bundled `tle.txt`.

---

## 12. Known Limitations

- Origin/country attribution is a heuristic based on naming conventions only — not sourced from an authoritative satellite registry.
- Positions are as accurate as the underlying TLE's propagation model (SGP4/SDP4) and degrade the further the current time is from the TLE epoch — this is inherent to the TLE format, not specific to this app.
- No automated test suite is currently present in the repository.
- No license file is currently included.
