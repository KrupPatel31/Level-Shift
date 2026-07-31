import Globe from "globe.gl";
import * as THREE from "three";
import * as solar from "solar-calculator";
const { twoline2satrec, propagate, gstime, eciToGeodetic } = satellite;

const LOCAL_TLE_FILE = "/tle.txt"; // absolute path served from public/

// Detect low-power / mobile devices so we can scale computation down.
// This dataset has ~16,000 satellites — recomputing all of their orbital
// positions at 60fps (the old behavior) will lock up a phone's CPU.
const isMobile =
  window.matchMedia("(max-width: 767px)").matches ||
  (navigator.maxTouchPoints > 1 &&
    /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent));

const PERF = isMobile
  ? { updateIntervalMs: 1200, defaultDensity: 800 }
  : { updateIntervalMs: 1000, defaultDensity: Infinity };

let satellites = [];
let userMarker = null;
let userLat = null;
let userLng = null;
let activeFilter = "all";
let originFilter = "all";
let isMuted = false;
let maxDisplaySatellites = Infinity;
let searchSatellite = null;
let hoveredSatellite = null; // currently hovered satellite
let updateTimer = null;
let isPaused = false;

let audioCtx = null;

function playBeepSequence() {
  if (isMuted) return;
  if (!audioCtx) {
    console.warn("Audio context not ready. Click anywhere to enable sound.");
    return;
  }
  const now = audioCtx.currentTime;
  [
    { time: 0, freq: 800, dur: 0.2 },
    { time: 0.5, freq: 800, dur: 0.2 },
    { time: 1.0, freq: 800, dur: 0.2 },
  ].forEach(({ time, freq, dur }) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.value = 0.03;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now + time);
    osc.stop(now + time + dur);
  });
}

const globe = Globe()
  .globeImageUrl("//unpkg.com/three-globe/example/img/earth-blue-marble.jpg")
  .bumpImageUrl("//unpkg.com/three-globe/example/img/earth-topology.png")
  .backgroundImageUrl("//unpkg.com/three-globe/example/img/night-sky.png")
  .showAtmosphere(true)
  .atmosphereColor("#5eb8ff")
  .atmosphereAltitude(0.2)
  .pointOfView({ lat: 20.59, lng: 78.96, altitude: 2.5 })(
  document.getElementById("globe-container"),
);

// Thin, slowly-drifting cloud layer for extra realism. This is purely
// additive to the three.js scene graph — independent of the satellite
// points/data pipeline — so if the texture is slow or fails to load on a
// bad connection, the rest of the app (globe, satellites, all controls)
// keeps working normally regardless.
function addCloudLayer() {
  const CLOUDS_IMG_URL = "//unpkg.com/three-globe/example/img/clouds.png";
  const CLOUDS_ALT = 0.008;
  const CLOUDS_ROTATION_SPEED = -0.006; // deg/frame

  new THREE.TextureLoader().load(
    CLOUDS_IMG_URL,
    (cloudsTexture) => {
      const clouds = new THREE.Mesh(
        new THREE.SphereGeometry(
          globe.getGlobeRadius() * (1 + CLOUDS_ALT),
          75,
          75,
        ),
        new THREE.MeshPhongMaterial({
          map: cloudsTexture,
          transparent: true,
          opacity: 0.55,
        }),
      );
      globe.scene().add(clouds);

      (function rotateClouds() {
        clouds.rotation.y += (CLOUDS_ROTATION_SPEED * Math.PI) / 180;
        requestAnimationFrame(rotateClouds);
      })();
    },
    undefined,
    () => {
      // Non-fatal: the globe looks fine without clouds too.
      console.warn(
        "Cloud layer texture failed to load; continuing without it.",
      );
    },
  );
}
addCloudLayer();

// Day/night terminator: a soft, semi-transparent glow oriented toward the
// sun's real current position, using globe.gl's built-in tiles layer
// (the same official pattern from its "solar-terminator" example). This is
// driven by actual current time, not an accelerated animation — the
// sub-solar point moves slowly enough that recomputing it once a minute
// is visually seamless, so it's folded into the existing update loop
// rather than adding a new per-frame timer.
function sunPosAt(date) {
  const dt = +date;
  const dayStartMs = new Date(dt).setUTCHours(0, 0, 0, 0);
  const t = solar.century(dt);
  const longitude = ((dayStartMs - dt) / 864e5) * 360 - 180;
  return [longitude - solar.equationOfTime(t) / 4, solar.declination(t)];
}

const solarTile = { pos: sunPosAt(new Date()) };

globe
  .tilesData([solarTile])
  .tileLng((d) => d.pos[0])
  .tileLat((d) => d.pos[1])
  .tileAltitude(0.005)
  .tileWidth(180)
  .tileHeight(180)
  .tileUseGlobeProjection(false)
  .tileMaterial(
    () =>
      new THREE.MeshLambertMaterial({
        color: "#ffcf6b", // warm gold, matching the existing amber HUD accent
        opacity: 0.22,
        transparent: true,
      }),
  )
  .tilesTransitionDuration(0);

function updateTerminator() {
  solarTile.pos = sunPosAt(new Date());
  globe.tilesData([solarTile]);
}

globe
  .pointLat((d) => d.lat)
  .pointLng((d) => d.lng)
  .pointAltitude((d) => scaleAltitude(d.alt))
  .pointColor((d) => d.color || "#ffffff")
  .pointRadius((d) => (d.isUserMarker ? 0.25 : 0.12))
  .pointsData([]);

function scaleAltitude(realAltKm) {
  if (!realAltKm || realAltKm <= 0) return 0.02;
  const minScale = 0.02;
  const maxScale = 0.22; // caps how far a satellite dot floats above the surface
  const scaled = Math.log(realAltKm + 1) * 0.032;
  return Math.min(maxScale, Math.max(minScale, scaled));
}

function getSatelliteColor(sat) {
  const name = sat.name.toUpperCase();
  if (name.includes("STARLINK")) return "#ffb454";
  if (name.includes("ISS")) return "#5eead4";
  if (name.includes("NOAA")) return "#8ee66d";
  if (name.includes("GPS")) return "#c9a8ff";
  const palette = [
    "#ff8a8a",
    "#8ee66d",
    "#7aa2ff",
    "#c9a8ff",
    "#5eead4",
    "#e7e9ef",
  ];
  const idx = Math.abs(hashCode(sat.name)) % palette.length;
  return palette[idx];
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash;
}

// Every TLE encodes its launch year and the exact moment ("epoch") the
// orbital elements were measured — both are on line 1, at fixed column
// positions per the standard NORAD TLE format. This gives us accurate
// launch-year filtering and a real "data current as of" freshness read,
// entirely from data we already have — no external service needed.
function parseTLEEpoch(tle1) {
  const pivotYear = (yy) => (yy < 57 ? 2000 + yy : 1900 + yy);

  const launchYY = parseInt(tle1.substring(9, 11), 10);
  const launchYear = Number.isNaN(launchYY) ? null : pivotYear(launchYY);

  const epochYY = parseInt(tle1.substring(18, 20), 10);
  const epochDayFrac = parseFloat(tle1.substring(20, 32));
  let epochDate = null;
  if (!Number.isNaN(epochYY) && !Number.isNaN(epochDayFrac)) {
    const dayOfYear = Math.floor(epochDayFrac);
    const dayFraction = epochDayFrac - dayOfYear;
    epochDate = new Date(Date.UTC(pivotYear(epochYY), 0, 1));
    epochDate.setUTCDate(epochDate.getUTCDate() + dayOfYear - 1);
    epochDate.setUTCMilliseconds(Math.round(dayFraction * 86400000));
  }

  return { launchYear, epochDate };
}

// TLE data has no country/operator field at all — this is a best-effort
// guess from well-known naming conventions (STARLINK, GLONASS, etc), NOT
// an authoritative registry lookup. It's clearly labeled as such in the UI.
const ORIGIN_PATTERNS = [
  {
    re: /STARLINK|\bGPS\b|\bUSA[ -]|NOAA|LANDSAT|TDRS|IRIDIUM|ORBCOMM|PLANET|SPIRE|CYGNUS|DRAGON|NAVSTAR/,
    origin: "US",
  },
  {
    re: /COSMOS|GLONASS|METEOR|RESURS|YAMAL|\bEKS\b|GONETS|PROGRESS/,
    origin: "RU",
  },
  {
    re: /YAOGAN|BEIDOU|TIANGONG|SHIJIAN|GAOFEN|FENGYUN|CHINASAT|JILIN|\bCZ-/,
    origin: "CN",
  },
  { re: /GALILEO|SENTINEL|METOP|EUTELSAT|ARIANE/, origin: "EU" },
  { re: /ONEWEB/, origin: "UK" },
  { re: /CARTOSAT|RISAT|\bGSAT\b|IRNSS|OCEANSAT|\bPSLV\b/, origin: "IN" },
  { re: /HIMAWARI|\bQZS\b|\bALOS\b|IGS[ -]/, origin: "JP" },
  { re: /ISS \(ZARYA\)|^ISS$/, origin: "Intl" },
];
function guessOrigin(name) {
  const upper = name.toUpperCase();
  for (const p of ORIGIN_PATTERNS) {
    if (p.re.test(upper)) return p.origin;
  }
  return "Other";
}

function filterSatellites(list, filter, origin) {
  return list.filter((s) => {
    const name = s.name.toUpperCase();
    let passConstellation = true;
    if (filter === "starlink") passConstellation = name.includes("STARLINK");
    else if (filter === "iss") passConstellation = name.includes("ISS");
    else if (filter === "noaa") passConstellation = name.includes("NOAA");
    else if (filter === "gps") passConstellation = name.includes("GPS");
    if (!passConstellation) return false;
    if (origin && origin !== "all" && s.origin !== origin) return false;
    return true;
  });
}

async function fetchLocalTLE(onProgress) {
  const response = await fetch(LOCAL_TLE_FILE);
  if (!response.ok)
    throw new Error(
      `Failed to load ${LOCAL_TLE_FILE} (status ${response.status})`,
    );

  // The TLE dataset is ~2.6MB — on a slow mobile connection that can take a
  // while. Stream it with progress feedback instead of a blocking .text()
  // call, so the loading screen doesn't look frozen.
  const contentLength = response.headers.get("Content-Length");
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  if (!response.body || !total) {
    const text = await response.text();
    return parseTLEText(text);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    text += decoder.decode(value, { stream: true });
    if (onProgress)
      onProgress(Math.min(100, Math.round((received / total) * 100)));
  }
  return parseTLEText(text);
}

function parseTLEText(tleText) {
  const lines = tleText.split(/\r?\n/);
  const result = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      i++;
      continue;
    }
    if (i + 2 < lines.length) {
      const name = lines[i].trim();
      const tle1 = lines[i + 1].trim();
      const tle2 = lines[i + 2].trim();
      if (tle1.startsWith("1 ") && tle2.startsWith("2 ")) {
        result.push({ name, tle1, tle2 });
        i += 3;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return result;
}

function createSatellites(rawList) {
  const created = rawList
    .map((sat) => {
      try {
        const satrec = twoline2satrec(sat.tle1, sat.tle2);
        const { launchYear, epochDate } = parseTLEEpoch(sat.tle1);
        return {
          ...sat,
          satrec,
          lat: 0,
          lng: 0,
          alt: 0,
          color: getSatelliteColor(sat),
          isOverhead: false,
          entryTime: 0,
          launchYear,
          epochDate,
          origin: guessOrigin(sat.name),
        };
      } catch (e) {
        console.error(`Error creating satrec for ${sat.name}:`, e);
        return null;
      }
    })
    .filter((s) => s !== null);
  return created;
}

function updatePositions() {
  const now = new Date();
  const gmst = gstime(now);
  updateTerminator();
  satellites.forEach((sat) => {
    if (!sat.satrec) return;
    const posAndVel = propagate(sat.satrec, now);
    if (posAndVel && posAndVel.position) {
      const geo = eciToGeodetic(posAndVel.position, gmst);
      sat.lat = (geo.latitude * 180) / Math.PI;
      sat.lng = (geo.longitude * 180) / Math.PI;
      sat.alt = geo.height;
    } else {
      sat.lat = null;
      sat.lng = null;
      sat.alt = null;
    }
  });

  const validSats = satellites.filter((s) => s.lat != null);
  const filteredSats = filterSatellites(validSats, activeFilter, originFilter);

  let displaySats = filteredSats;
  if (
    maxDisplaySatellites !== Infinity &&
    displaySats.length > maxDisplaySatellites
  ) {
    displaySats = displaySats.slice(0, maxDisplaySatellites);
  }

  if (userLat != null && userLng != null) {
    const overheadSats = validSats.filter(
      (s) => s.alt > 0 && angularDistance(userLat, userLng, s.lat, s.lng) < 2,
    );
    overheadSats.forEach((s) => {
      if (!displaySats.includes(s)) displaySats.push(s);
    });
  }

  if (searchSatellite && !displaySats.includes(searchSatellite)) {
    displaySats.push(searchSatellite);
  }

  if (userMarker) displaySats.push(userMarker);

  globe.pointsData(displaySats);
  updateSatelliteCounter(
    displaySats.length - (userMarker ? 1 : 0),
    satellites.length,
  );

  if (userLat != null && userLng != null) updateOverheadList(validSats);
}

// Position updates run on a fixed-rate timer instead of requestAnimationFrame.
// At orbital speeds a satellite's angular position barely changes within a
// second, so updating once (or ~1.2x) per second is visually smooth while
// cutting CPU load by roughly 60x compared to a per-frame recompute — this
// is what was freezing the map (and every other control) on phones with
// ~16k satellites loaded. globe.gl still renders/animates camera movement
// on its own internal loop, so interaction stays smooth even though
// satellite positions refresh on the slower timer.
function startUpdateLoop() {
  if (updateTimer) clearInterval(updateTimer);
  updatePositions();
  updateTimer = setInterval(() => {
    if (!isPaused) updatePositions();
  }, PERF.updateIntervalMs);
}

// Pause updates while the tab/app is backgrounded to save battery/CPU,
// especially relevant on mobile where this matters a lot more.
document.addEventListener("visibilitychange", () => {
  isPaused = document.hidden;
});

// The info panel (hovered satellite's lat/lng/alt) gets its own fast loop,
// separate from the throttled fleet-wide position update above. Tracking
// just one satellite is cheap, so this can safely run at full frame rate
// for a smooth live readout, without reintroducing the per-frame cost of
// recomputing all ~16k satellites that was freezing the app on mobile.
function hoverInfoLoop() {
  if (!isPaused && hoveredSatellite && hoveredSatellite.satrec) {
    const now = new Date();
    const posAndVel = propagate(hoveredSatellite.satrec, now);
    if (posAndVel && posAndVel.position) {
      const gmst = gstime(now);
      const geo = eciToGeodetic(posAndVel.position, gmst);
      const lat = (geo.latitude * 180) / Math.PI;
      const lng = (geo.longitude * 180) / Math.PI;
      const alt = geo.height;
      const infoPanel = document.getElementById("info-panel");
      if (infoPanel) {
        infoPanel.innerHTML = `<strong>${hoveredSatellite.name}</strong><br>Alt: ${alt.toFixed(0)} km<br>Lat/Lng: ${lat.toFixed(2)}°, ${lng.toFixed(2)}°`;
        infoPanel.style.borderColor = "#5eead4";
        infoPanel.style.color = "#5eead4";
      }
    }
  }
  requestAnimationFrame(hoverInfoLoop);
}
requestAnimationFrame(hoverInfoLoop);

function angularDistance(lat1, lng1, lat2, lng2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 180) / Math.PI;
}

function updateOverheadList(validSats) {
  const now = Date.now();
  const overhead = validSats
    .filter((s) => s.alt > 0)
    .map((s) => {
      const angle = angularDistance(userLat, userLng, s.lat, s.lng);
      return { ...s, angle };
    })
    .filter((s) => s.angle < 2);

  overhead.sort((a, b) => (b.entryTime || 0) - (a.entryTime || 0));

  const listEl = document.getElementById("overhead-list");
  if (!listEl) return;
  listEl.innerHTML = overhead
    .slice(0, 5)
    .map((s) => {
      const elapsed = s.entryTime ? Math.floor((now - s.entryTime) / 1000) : 0;
      return `<li>${s.name} (${s.angle.toFixed(1)}°) · ${elapsed}s ago</li>`;
    })
    .join("");

  validSats.forEach((s) => {
    if (s.alt <= 0) return;
    const angle = angularDistance(userLat, userLng, s.lat, s.lng);
    const isNowOverhead = angle < 2;
    if (isNowOverhead && !s.isOverhead) {
      s.isOverhead = true;
      s.entryTime = Date.now();
      playBeepSequence();
    } else if (!isNowOverhead && s.isOverhead) {
      s.isOverhead = false;
    }
  });
}

function updateSatelliteCounter(visible, total) {
  const badge = document.getElementById("satellite-counter");
  if (!badge) return;
  badge.textContent = `${visible} / ${total}`;
}

function showError(msg) {
  const info = document.getElementById("info-panel");
  if (info) {
    info.innerHTML = `⚠ ${msg}`;
    info.style.borderColor = "#ff6b6b";
    info.style.color = "#ff6b6b";
  }
}

function hideLoading() {
  const overlay = document.getElementById("loading-overlay");
  if (overlay) overlay.style.display = "none";
}

// --- NEW: Hover event (replaces click) ---
globe.onPointHover((point) => {
  if (point) {
    hoveredSatellite = point;
  }
  // When point is null, do nothing – keep the last hovered satellite
});

function setCoordsBadgeState(state, text) {
  const badge = document.getElementById("user-coords");
  const label = document.getElementById("user-coords-text");
  if (!badge || !label) return;
  badge.classList.remove("is-loading", "is-ok", "is-error");
  if (state) badge.classList.add(state);
  label.textContent = text;
}

function requestUserLocation() {
  setCoordsBadgeState("is-loading", "Locating…");

  if (!("geolocation" in navigator)) {
    setCoordsBadgeState("is-error", "Not supported");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLat = pos.coords.latitude;
      userLng = pos.coords.longitude;
      userMarker = {
        lat: userLat,
        lng: userLng,
        alt: 0,
        color: "#ffffff",
        name: "📍 You are here",
        isUserMarker: true,
      };
      updateUserCoordsDisplay();
    },
    (err) => {
      // Give a real, visible reason instead of only logging to console —
      // on mobile the person has no way to see console.warn output, so a
      // silently-failing geolocation call just looks like a broken feature.
      let msg = "Location unavailable";
      if (err.code === err.PERMISSION_DENIED)
        msg = "Location denied — tap to retry";
      else if (err.code === err.POSITION_UNAVAILABLE)
        msg = "Position unavailable — tap to retry";
      else if (err.code === err.TIMEOUT)
        msg = "Location timed out — tap to retry";
      console.warn("Geolocation error:", err.message);
      setCoordsBadgeState("is-error", msg);
    },
    {
      enableHighAccuracy: false, // faster fix, less battery drain on mobile
      timeout: 12000, // never hang forever waiting for a GPS lock indoors
      maximumAge: 60000,
    },
  );
}

document
  .getElementById("user-coords")
  ?.addEventListener("click", requestUserLocation);
requestUserLocation();

function setupDensitySlider() {
  const slider = document.getElementById("density-slider");
  const valueSpan = document.getElementById("density-value");
  if (!slider || !valueSpan) return;
  slider.max = satellites.length;
  slider.min = Math.min(100, satellites.length);
  slider.step = Math.max(50, Math.round(satellites.length / 100));
  slider.value = Math.min(PERF.defaultDensity, satellites.length);
  const updateDisplay = () => {
    const val = parseInt(slider.value);
    if (val >= satellites.length) {
      valueSpan.textContent = "All";
      maxDisplaySatellites = Infinity;
    } else {
      valueSpan.textContent = val;
      maxDisplaySatellites = val;
    }
  };
  slider.addEventListener("input", updateDisplay);
  updateDisplay();
}

// Shows the freshest TLE epoch across all loaded satellites — the actual
// "as of" timestamp the orbital math is based on, not just when the page
// happened to load. TLEs degrade in accuracy over time, so this is flagged
// visually once the data starts getting stale.
function updateDataFreshness(sats) {
  const el = document.getElementById("data-epoch-text");
  const badge = document.getElementById("data-epoch-badge");
  if (!el) return;

  const epochs = sats.map((s) => s.epochDate).filter(Boolean);
  if (epochs.length === 0) {
    el.textContent = "Data: unknown";
    return;
  }

  const freshest = new Date(Math.max(...epochs.map((d) => d.getTime())));
  const ageDays = (Date.now() - freshest.getTime()) / 86400000;
  const dateStr = freshest.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  el.textContent = `Data: ${dateStr}`;

  if (badge) {
    badge.classList.toggle("is-stale", ageDays > 7);
    badge.title = `Freshest orbital data (TLE epoch) is from ${freshest.toUTCString()} — ${ageDays.toFixed(1)} day(s) old. Older TLEs drift further from a satellite's true position.`;
  }
}

// The site loads its dataset from a static tle.txt bundled with the app —
// it won't gain new data on its own. This periodically re-checks that same
// file in case the person hosting the site has redeployed it with fresher
// TLEs (e.g. via a scheduled job), and swaps in the newer data live without
// needing a page reload. If the fetch fails or returns nothing usable, the
// currently-loaded data is left untouched — a bad refresh should never
// erase good data.
const REFRESH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
function scheduleDataRefresh() {
  setInterval(async () => {
    try {
      const raw = await fetchLocalTLE();
      if (!raw || raw.length === 0) return;
      const created = createSatellites(raw);
      if (created.length === 0) return;

      const latestEpoch = (list) =>
        list.reduce(
          (max, s) => (s.epochDate && s.epochDate > max ? s.epochDate : max),
          new Date(0),
        );
      if (latestEpoch(created) > latestEpoch(satellites)) {
        satellites = created;
        setupDensitySlider();
        updateDataFreshness(satellites);
        console.info("TLE data refreshed — newer epoch detected.");
      }
    } catch (e) {
      console.warn("Scheduled TLE refresh failed; keeping existing data.", e);
    }
  }, REFRESH_CHECK_INTERVAL_MS);
}

async function init() {
  document.addEventListener(
    "click",
    () => {
      if (!audioCtx)
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    },
    { once: true },
  );

  const loadingText = document.querySelector("#loading-overlay p");
  let raw = [];
  let usingFallback = false;
  try {
    raw = await fetchLocalTLE((pct) => {
      if (loadingText) loadingText.textContent = `Acquiring signal… ${pct}%`;
    });
  } catch (e) {
    console.error("Local TLE load failed.", e);
    raw = [
      {
        name: "ISS (ZARYA)",
        tle1: "1 25544U 98067A   24297.54828871  .00002175  00000+0  43562-4 0  9994",
        tle2: "2 25544  51.6417 298.1187 0001488  59.1274  13.2459 15.49528635448700",
      },
      {
        name: "STARLINK-1007",
        tle1: "1 44713U 19074A   24296.50001157  .00000215  00000+0  16514-4 0  9990",
        tle2: "2 44713  53.0010  46.7997 0001471  69.7550 290.3735 15.06387785258904",
      },
      {
        name: "NOAA 15",
        tle1: "1 25338U 98030A   24296.53105789  .00000258  00000+0  14801-3 0  9990",
        tle2: "2 25338  98.5464 271.9470 0011373 112.7515 247.4930 14.25896823346012",
      },
    ];
    usingFallback = true;
  }
  if (raw.length === 0) {
    showError("No TLE data available. Please add tle.txt to the server.");
    hideLoading();
    return;
  }
  satellites = createSatellites(raw);
  if (satellites.length === 0) {
    showError("Failed to create any satellites. Check TLE format.");
    hideLoading();
    return;
  }
  if (usingFallback)
    showError("Could not load tle.txt – showing sample satellites only.");
  hideLoading();
  setupDensitySlider();
  updateDataFreshness(satellites);
  startUpdateLoop();
  scheduleDataRefresh();
}

init();

// Filter buttons, search, mute, toggle overhead, etc.
const filterButtons = document.querySelectorAll(".filter-btn");
filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    filterButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeFilter = btn.dataset.filter;
  });
});

// Most origin + constellation combinations would silently return zero
// results (e.g. "Russia" + "ISS" never matches anything, since the ISS is
// tagged International) — rather than let people land on a confusing empty
// globe, picking a specific country resets the constellation filter to
// "All" and disables the other constellation buttons until origin is reset
// back to "All" origins. This one function is the single source of truth
// for that behavior, used both for direct user input and for restoring a
// shared link, so the two can't drift out of sync.
function applyOriginFilter(value) {
  originFilter = value;

  const originSelect = document.getElementById("origin-filter");
  if (originSelect && originSelect.value !== value) originSelect.value = value;

  const isSpecificOrigin = value !== "all";
  filterButtons.forEach((btn) => {
    if (btn.dataset.filter === "all") return; // ALL stays always available
    btn.disabled = isSpecificOrigin;
    btn.classList.toggle("is-disabled", isSpecificOrigin);
  });

  if (isSpecificOrigin && activeFilter !== "all") {
    activeFilter = "all";
    filterButtons.forEach((b) =>
      b.classList.toggle("active", b.dataset.filter === "all"),
    );
  }
}

document.getElementById("origin-filter")?.addEventListener("change", (e) => {
  applyOriginFilter(e.target.value);
});

const searchInput = document.getElementById("satellite-search");
if (searchInput) {
  let searchDebounce = null;
  searchInput.addEventListener("input", (e) => {
    const query = e.target.value.toLowerCase().trim();
    clearTimeout(searchDebounce);
    if (query === "") {
      searchSatellite = null;
      return;
    }
    searchDebounce = setTimeout(() => {
      const isYearQuery = /^\d{4}$/.test(query);
      const matches = satellites.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          (isYearQuery && String(s.launchYear) === query),
      );
      if (matches.length > 0) {
        searchSatellite = matches[0];
        globe.pointOfView(
          { lat: searchSatellite.lat, lng: searchSatellite.lng, altitude: 0.5 },
          1000,
        );
      } else {
        searchSatellite = null;
      }
    }, 150);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const query = e.target.value.toLowerCase().trim();
      const match = satellites.find((s) =>
        s.name.toLowerCase().includes(query),
      );
      if (match) {
        searchSatellite = match;
        globe.pointOfView(
          { lat: match.lat, lng: match.lng, altitude: 0.3 },
          800,
        );
      }
    }
  });
}

const muteBtn = document.getElementById("mute-btn");
if (muteBtn) {
  const volOnIcon = muteBtn.querySelector('[data-icon="volume-on"]');
  const volOffIcon = muteBtn.querySelector('[data-icon="volume-off"]');
  const syncMuteIcon = () => {
    volOnIcon?.classList.toggle("hidden", isMuted);
    volOffIcon?.classList.toggle("hidden", !isMuted);
    muteBtn.classList.toggle("is-on", isMuted);
  };
  syncMuteIcon();
  muteBtn.addEventListener("click", () => {
    isMuted = !isMuted;
    syncMuteIcon();
  });
}

const toggleOverheadBtn = document.getElementById("toggle-overhead");
const overheadPanel = document.getElementById("overhead-panel");
if (toggleOverheadBtn && overheadPanel) {
  const hiddenClasses = [
    "translate-x-[calc(100%+16px)]",
    "opacity-0",
    "pointer-events-none",
  ];
  toggleOverheadBtn.addEventListener("click", () => {
    const isHidden = overheadPanel.classList.contains(hiddenClasses[0]);
    overheadPanel.classList.toggle(hiddenClasses[0], !isHidden);
    overheadPanel.classList.toggle(hiddenClasses[1], !isHidden);
    overheadPanel.classList.toggle(hiddenClasses[2], !isHidden);
    toggleOverheadBtn.classList.toggle("is-on", isHidden);
  });
}

document.getElementById("fullscreen-btn")?.addEventListener("click", () => {
  // Fullscreen API support on mobile (especially iOS Safari) is
  // inconsistent and can reject/throw rather than silently no-op.
  try {
    if (!document.fullscreenElement) {
      const req = document.documentElement.requestFullscreen?.();
      req?.catch?.(() =>
        showError("Fullscreen isn't supported on this browser."),
      );
      if (!document.documentElement.requestFullscreen) {
        showError("Fullscreen isn't supported on this browser.");
      }
    } else {
      document.exitFullscreen();
    }
  } catch (e) {
    showError("Fullscreen isn't supported on this browser.");
  }
});

document.getElementById("reset-view-btn")?.addEventListener("click", () => {
  globe.pointOfView({ lat: 20.59, lng: 78.96, altitude: 2.5 }, 800);
});

document.getElementById("share-btn")?.addEventListener("click", () => {
  const { lat, lng, altitude } = globe.pointOfView();
  const params = new URLSearchParams({
    lat: lat.toFixed(2),
    lng: lng.toFixed(2),
    alt: altitude.toFixed(2),
    filter: activeFilter,
    origin: originFilter,
  });
  const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
  navigator.clipboard
    .writeText(url)
    .then(() => {
      const info = document.getElementById("info-panel");
      if (info) {
        info.innerHTML = "🔗 Link copied to clipboard!";
        info.style.borderColor = "#0ff";
        info.style.color = "#0ff";
      }
    })
    .catch(() => alert("Sharing link: " + url));
});

try {
  const urlParams = new URLSearchParams(window.location.search);
  const lat = parseFloat(urlParams.get("lat"));
  const lng = parseFloat(urlParams.get("lng"));
  const alt = parseFloat(urlParams.get("alt"));
  const filter = urlParams.get("filter");
  const origin = urlParams.get("origin");
  if (!isNaN(lat) && !isNaN(lng) && !isNaN(alt))
    globe.pointOfView({ lat, lng, altitude: alt }, 0);
  if (filter && ["all", "starlink", "iss", "noaa", "gps"].includes(filter)) {
    activeFilter = filter;
    document.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.classList.remove("active");
      if (btn.dataset.filter === filter) btn.classList.add("active");
    });
  }
  // Applied after the constellation filter restore above so the same
  // mutual-exclusivity rule from applyOriginFilter takes effect here too.
  if (
    origin &&
    ["all", "US", "RU", "CN", "EU", "UK", "IN", "JP", "Intl", "Other"].includes(
      origin,
    )
  ) {
    applyOriginFilter(origin);
  }
} catch (e) {}

function updateUserCoordsDisplay() {
  if (userLat != null && userLng != null) {
    setCoordsBadgeState(
      "is-ok",
      `${userLat.toFixed(2)}°, ${userLng.toFixed(2)}°`,
    );
  }
}

function startUtcClock() {
  const el = document.getElementById("utc-clock");
  if (!el) return;
  const tick = () => {
    el.textContent = new Date().toISOString().slice(11, 19) + "Z";
  };
  tick();
  setInterval(tick, 1000);
}
startUtcClock();

// The toolbar wraps into a different number of rows depending on screen
// width (e.g. search/filters/density each get their own row on mobile),
// so its height isn't a fixed value. The overhead panel sits just below
// it, so instead of a hardcoded CSS offset (which breaks any time the
// toolbar's row count changes), track the toolbar's real rendered height
// live and expose it as a CSS variable the panel's `top` reads from.
function observeToolbarHeight() {
  const toolbar = document.getElementById("toolbar");
  if (!toolbar || !("ResizeObserver" in window)) return;
  const applyHeight = () => {
    document.documentElement.style.setProperty(
      "--toolbar-h",
      `${toolbar.offsetHeight}px`,
    );
  };
  new ResizeObserver(applyHeight).observe(toolbar);
  applyHeight();
}
observeToolbarHeight();
