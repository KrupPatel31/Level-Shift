import Globe from "globe.gl";
const { twoline2satrec, propagate, gstime, eciToGeodetic } = satellite;

const LOCAL_TLE_FILE = "/tle.txt"; // public/ folder ke liye absolute

let satellites = [];
let userMarker = null;
let userLat = null;
let userLng = null;
let activeFilter = "all";
let isMuted = false;
let maxDisplaySatellites = Infinity;
let searchSatellite = null;
let hoveredSatellite = null; // <-- NEW: currently hovered satellite

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
  .globeImageUrl("//unpkg.com/three-globe/example/img/earth-dark.jpg")
  .bumpImageUrl("//unpkg.com/three-globe/example/img/earth-topology.png")
  .pointOfView({ lat: 20.59, lng: 78.96, altitude: 2.5 })(
  document.getElementById("globe-container"),
);

globe
  .pointLat((d) => d.lat)
  .pointLng((d) => d.lng)
  .pointAltitude((d) => scaleAltitude(d.alt))
  .pointColor((d) => d.color || "#ffffff")
  .pointRadius((d) => (d.isUserMarker ? 0.25 : 0.12))
  .pointsData([]);

globe
  .pathsData([])
  .pathPoints("trail")
  .pathPointLat("lat")
  .pathPointLng("lng")
  .pathPointAlt("alt")
  .pathColor((d) => d.trailColor || "#ffaa0066")
  .pathDashLength(0.1)
  .pathDashGap(0.02)
  .pathDashAnimateTime(2000);

function scaleAltitude(realAltKm) {
  if (!realAltKm || realAltKm <= 0) return 0.02;
  const minScale = 0.02;
  const maxScale = 0.4;
  const scaled = Math.log(realAltKm + 1) * 0.045;
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

function filterSatellites(list, filter) {
  if (filter === "all") return list;
  return list.filter((s) => {
    const name = s.name.toUpperCase();
    if (filter === "starlink") return name.includes("STARLINK");
    if (filter === "iss") return name.includes("ISS");
    if (filter === "noaa") return name.includes("NOAA");
    if (filter === "gps") return name.includes("GPS");
    return true;
  });
}

async function fetchLocalTLE() {
  const response = await fetch(LOCAL_TLE_FILE);
  if (!response.ok)
    throw new Error(
      `Failed to load ${LOCAL_TLE_FILE} (status ${response.status})`,
    );
  const text = await response.text();
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
        return {
          ...sat,
          satrec,
          lat: 0,
          lng: 0,
          alt: 0,
          color: getSatelliteColor(sat),
          isOverhead: false,
          entryTime: 0,
        };
      } catch (e) {
        console.error(`Error creating satrec for ${sat.name}:`, e);
        return null;
      }
    })
    .filter((s) => s !== null);
  return created;
}

function computeTrail(satrec, startTime, durationMin, steps) {
  const points = [];
  const stepMs = (durationMin * 60 * 1000) / steps;
  for (let i = 0; i <= steps; i++) {
    const future = new Date(startTime.getTime() + i * stepMs);
    const posAndVel = propagate(satrec, future);
    if (posAndVel && posAndVel.position) {
      const gmst = gstime(future);
      const geo = eciToGeodetic(posAndVel.position, gmst);
      points.push({
        lat: (geo.latitude * 180) / Math.PI,
        lng: (geo.longitude * 180) / Math.PI,
        alt: geo.height,
      });
    } else {
      break;
    }
  }
  return points;
}

function updatePositions() {
  const now = new Date();
  const gmst = gstime(now);
  let validCount = 0;
  satellites.forEach((sat) => {
    if (!sat.satrec) return;
    const posAndVel = propagate(sat.satrec, now);
    if (posAndVel && posAndVel.position) {
      const geo = eciToGeodetic(posAndVel.position, gmst);
      sat.lat = (geo.latitude * 180) / Math.PI;
      sat.lng = (geo.longitude * 180) / Math.PI;
      sat.alt = geo.height;
      validCount++;
    } else {
      sat.lat = null;
      sat.lng = null;
      sat.alt = null;
    }
  });

  const validSats = satellites.filter((s) => s.lat != null);
  const filteredSats = filterSatellites(validSats, activeFilter);

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

  const trailLimit = 50;
  const paths = [];
  for (let i = 0; i < displaySats.length && i < trailLimit; i++) {
    const sat = displaySats[i];
    if (!sat.satrec) continue;
    const trail = computeTrail(sat.satrec, now, 10, 20);
    if (trail.length > 1) paths.push({ trail, trailColor: sat.color });
  }
  globe.pathsData(paths);

  if (userLat != null && userLng != null) updateOverheadList(validSats);

  // --- NEW: Auto‑update info panel for the hovered satellite ---
  const infoPanel = document.getElementById("info-panel");
  if (infoPanel) {
    if (hoveredSatellite) {
      infoPanel.innerHTML = `<strong>${hoveredSatellite.name}</strong><br>Alt: ${hoveredSatellite.alt ? hoveredSatellite.alt.toFixed(0) : "?"} km<br>Lat/Lng: ${hoveredSatellite.lat.toFixed(2)}°, ${hoveredSatellite.lng.toFixed(2)}°`;
      infoPanel.style.borderColor = "#5eead4";
      infoPanel.style.color = "#5eead4";
    }
  }

  requestAnimationFrame(updatePositions);
}

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
  (err) => console.warn("Geolocation denied. Overhead feature disabled."),
);

function setupDensitySlider() {
  const slider = document.getElementById("density-slider");
  const valueSpan = document.getElementById("density-value");
  if (!slider || !valueSpan) return;
  slider.max = satellites.length;
  slider.value = satellites.length;
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

async function init() {
  document.addEventListener(
    "click",
    () => {
      if (!audioCtx)
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    },
    { once: true },
  );

  let raw = [];
  let usingFallback = false;
  try {
    raw = await fetchLocalTLE();
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
  updatePositions();
}

init();

// Filter buttons, search, mute, toggle overhead, etc.
const filterButtons = document.querySelectorAll(".filter-btn");
filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    filterButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeFilter = btn.dataset.filter;
  });
});

const searchInput = document.getElementById("satellite-search");
if (searchInput) {
  searchInput.addEventListener("input", (e) => {
    const query = e.target.value.toLowerCase().trim();
    if (query === "") {
      searchSatellite = null;
      return;
    }
    const matches = satellites.filter((s) =>
      s.name.toLowerCase().includes(query),
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
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
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
  if (!isNaN(lat) && !isNaN(lng) && !isNaN(alt))
    globe.pointOfView({ lat, lng, altitude: alt }, 0);
  if (filter && ["all", "starlink", "iss", "noaa", "gps"].includes(filter)) {
    activeFilter = filter;
    document.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.classList.remove("active");
      if (btn.dataset.filter === filter) btn.classList.add("active");
    });
  }
} catch (e) {}

function updateUserCoordsDisplay() {
  const el = document.getElementById("user-coords-text");
  if (el && userLat != null && userLng != null)
    el.textContent = `${userLat.toFixed(2)}°, ${userLng.toFixed(2)}°`;
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
