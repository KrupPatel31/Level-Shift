# LevelShift 🛰️

**Live satellite tracker on an interactive 3D globe.**

🌍 Live site: [https://levelshift.me/](https://levelshift.me/)

LevelShift renders thousands of real satellites — Starlink, the ISS, NOAA weather satellites, GPS, and more — in their real-time orbital positions on a 3D globe, straight from your browser. It pulls fresh orbital data (TLE) daily, computes live positions client-side, and lets you filter, search, and get notified when a satellite passes overhead.

---

## Features

- **3D interactive globe** — pan, zoom, and rotate a textured Earth with day/night terminator, atmosphere, and drifting cloud layer (via [globe.gl](https://github.com/vasturiano/globe.gl) + [three.js](https://threejs.org/)).
- **Real-time orbital propagation** — satellite positions are computed live in the browser using SGP4/SDP4 propagation from TLE (Two-Line Element) data.
- **~16,000 tracked objects** — the full active-satellite catalog from CelesTrak, auto-refreshed daily.
- **Filters** — quick filters for Starlink, ISS, NOAA, and GPS constellations, plus a best-effort "origin" filter (US, Russia, China, Europe, UK, India, Japan, etc.) inferred from naming conventions.
- **Search** — find a satellite by name or launch year and fly the camera to it.
- **Density slider** — cap how many points render at once, useful for lower-end devices.
- **"Overhead now"** — detects your location and lists satellites currently passing near your position, with an audible beep alert.
- **Shareable views** — copy a link that reproduces your current camera angle and filters.
- **Data freshness badge** — shows the TLE epoch date the current positions are based on, and flags when data is getting stale.
- **Mobile-optimized** — reduced update rate and default density on phones to avoid freezing lower-powered CPUs.

---

## Tech Stack

| Layer               | Technology                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Build tool          | [Vite](https://vitejs.dev/)                                                                       |
| 3D globe            | [globe.gl](https://github.com/vasturiano/globe.gl)                                                |
| 3D rendering        | [three.js](https://threejs.org/)                                                                  |
| Orbital propagation | [satellite.js](https://github.com/shashwatak/satellite.js) (loaded via `public/satellite.min.js`) |
| Sun position        | [solar-calculator](https://github.com/d3/d3-solar)                                                |
| Styling             | Tailwind CSS (CDN)                                                                                |
| Data source         | [CelesTrak](https://celestrak.org/) active-satellite TLE catalog                                  |
| Automation          | GitHub Actions (daily TLE refresh)                                                                |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- npm

### Installation

```bash
git clone https://github.com/KrupPatel31/Level-Shift.git
cd Level-Shift
npm install
```

### Run in development

```bash
npm run dev
```

Vite will start a local dev server (default `http://localhost:5173`) with hot reload.

### Build for production

```bash
npm run build
```

Output goes to `dist/`.

### Preview a production build

```bash
npm run preview
```

---

## Project Structure

```
Level-Shift/
├── index.html              # App shell, UI markup, inline styles
├── src/
│   └── main.js              # Globe setup, TLE parsing, propagation, UI wiring
├── public/
│   ├── satellite.min.js     # satellite.js library (SGP4/SDP4 propagation)
│   └── tle.txt               # Bundled TLE dataset (auto-updated daily)
├── .github/
│   └── workflows/            # GitHub Action that refreshes tle.txt
├── package.json
└── package-lock.json
```

---

## Data Source & Updates

Orbital data comes from CelesTrak's "active satellites" TLE feed. A scheduled GitHub Action runs daily (04:17 UTC) to re-download the catalog into `public/tle.txt`, with sanity checks (minimum file size, TLE line-format validation) so a bad or empty download never overwrites good data. The app itself also periodically re-fetches `tle.txt` every 6 hours in the browser and swaps in newer data live if a fresher epoch is found — no page reload needed.

---

## Notes & Limitations

- The "Origin" filter is a **best-effort guess** based on satellite naming conventions (e.g. `STARLINK`, `COSMOS`, `BEIDOU`) — TLE data has no official country/operator field, so this is not an authoritative registry.
- Satellite positions are only as accurate as the TLE epoch they're based on; accuracy degrades the older the data gets (see the "Data" freshness badge in the UI).

---

## License

No license file is currently included in this repository.

## Author

Built by [Krup Patel](https://github.com/KrupPatel31).
