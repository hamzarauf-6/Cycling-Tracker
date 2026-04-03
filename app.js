// ═══════════════════════════════════════════════════════════════
//  RIDE TRACKER — app.js
//  Plain JavaScript. No frameworks. No build step.
// ═══════════════════════════════════════════════════════════════


// ── Thresholds (tweak these if needed) ────────────────────────

const NOISE_FILTER_M   = 5;     // ignore GPS hops smaller than 5 metres (device jitter)
const SAVE_INTERVAL_MS = 5000;  // save a route point at most every 5 seconds...
const SAVE_MIN_DIST_M  = 10;    // ...AND only if you've moved at least 10 metres


// ── Ride state ─────────────────────────────────────────────────

let isRiding      = false;
let watchId       = null;   // returned by watchPosition, used to cancel it later
let startTime     = null;   // timestamp when Start was pressed
let timerInterval = null;   // setInterval handle for the clock

let totalDistance  = 0;     // metres accumulated this ride
let lastPoint      = null;  // { lat, lon } — last accepted GPS fix (used for distance)
let lastPointTime  = null;  // when lastPoint arrived (ms), used for speed fallback
let lastSavedPoint = null;  // { lat, lon, time } — last point written to routeCoords
let routeCoords    = [];    // [[lat, lon], ...] — the route drawn on the map


// ── Leaflet map objects ────────────────────────────────────────

let rideMap       = null;   // the map on the Ride screen
let routePolyline = null;   // the orange line drawn as you ride
let posMarker     = null;   // the dot showing your current position
let detailMap     = null;   // the map shown inside a past-ride detail view


// ══════════════════════════════════════════════════════════════
//  INITIALISE — runs once when the page loads
// ══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {

  // Create the Leaflet map without the built-in zoom control so we can
  // insert the locate button above it manually
  rideMap = L.map('map', { zoomControl: false });

  // ── Locate button (sits above zoom, exactly like Strava) ──────
  const LocateControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      const btn       = L.DomUtil.create('a',   '', container);
      btn.href        = '#';
      btn.title       = 'My location';
      btn.setAttribute('role', 'button');
      // Crosshair icon — same visual language as Strava
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <circle cx="12" cy="12" r="4"/>
        <line x1="12" y1="2"  x2="12" y2="7"/>
        <line x1="12" y1="17" x2="12" y2="22"/>
        <line x1="2"  y1="12" x2="7"  y2="12"/>
        <line x1="17" y1="12" x2="22" y2="12"/>
      </svg>`;
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(btn, 'click', e => { L.DomEvent.preventDefault(e); recenterMap(); });
      return container;
    }
  });
  new LocateControl().addTo(rideMap);

  // Zoom control goes below the locate button
  L.control.zoom({ position: 'topleft' }).addTo(rideMap);

  // Load map tiles from OpenStreetMap (free, no API key)
  L.tileLayer('https://api.mapbox.com/styles/v1/mapbox/navigation-night-v1/tiles/256/{z}/{x}/{y}@2x?access_token=pk.eyJ1IjoiaGFtemFyYXVmNiIsImEiOiJjbW5pcXI0NHMwZDVtMm9zOWgxM200aHFhIn0.f2Fm07qGoVDpjUj5SjQr2Q', {
    attribution: '© <a href="https://www.mapbox.com/">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 22
  }).addTo(rideMap);

  // Centre the map on the user's real location right away.
  // Falls back to a world view if permission is denied.
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        rideMap.setView([pos.coords.latitude, pos.coords.longitude], 15);
        // Show the location marker immediately, before any ride starts
        posMarker = L.marker(
          [pos.coords.latitude, pos.coords.longitude],
          { icon: createLocationIcon(null), zIndexOffset: 1000 }
        ).addTo(rideMap);
      },
      () => rideMap.setView([30.0, 70.0], 5)   // fallback: centred on Pakistan
    );
  } else {
    rideMap.setView([30.0, 70.0], 5);
  }

  // Populate the History tab from saved data
  loadHistory();
});


// ══════════════════════════════════════════════════════════════
//  RECENTER BUTTON
// ══════════════════════════════════════════════════════════════

function recenterMap() {
  // During a ride we already have the latest position in lastPoint
  if (lastPoint) {
    rideMap.setView([lastPoint.lat, lastPoint.lon], 16);
    return;
  }
  // Otherwise (not riding) ask the device for the current position
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => rideMap.setView([pos.coords.latitude, pos.coords.longitude], 15),
      ()   => {}   // silently ignore if denied
    );
  }
}


// ══════════════════════════════════════════════════════════════
//  START / STOP
// ══════════════════════════════════════════════════════════════

function toggleRide() {
  isRiding ? stopRide() : startRide();
}

// ── startRide ──────────────────────────────────────────────────

function startRide() {

  // Guard: browser must support GPS
  if (!navigator.geolocation) {
    setStatus('GPS is not supported by your browser.', 'error');
    return;
  }

  // Reset all tracking state from scratch
  isRiding       = true;
  totalDistance  = 0;
  routeCoords    = [];
  lastPoint      = null;
  lastPointTime  = null;
  lastSavedPoint = null;
  startTime      = Date.now();

  // Reset the four stat displays
  setVal('speed',     '0.0');
  setVal('avg-speed', '0.0');
  setVal('distance',  '0.00');
  setVal('timer',     '00:00:00');

  // Clear only the previous route line — keep the location marker visible
  if (routePolyline) { rideMap.removeLayer(routePolyline); routePolyline = null; }

  // Flip button to red Stop
  const btn = document.getElementById('start-stop-btn');
  btn.textContent = 'Stop';
  btn.className   = 'stop-btn';

  setStatus('Waiting for GPS…', 'waiting');

  // Start the clock (ticks every second)
  timerInterval = setInterval(updateTimer, 1000);

  // Start listening for GPS updates
  watchId = navigator.geolocation.watchPosition(onGpsUpdate, onGpsError, {
    enableHighAccuracy: true,  // use the best available GPS signal
    maximumAge: 0,             // never use a cached position
    timeout: 15000             // give up after 15 s and call onGpsError
  });
}

// ── stopRide ───────────────────────────────────────────────────

function stopRide() {

  isRiding = false;

  // Stop GPS listener
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  // Stop the clock
  clearInterval(timerInterval);
  timerInterval = null;

  // Save the last position to close the route line neatly
  if (lastPoint && routeCoords.length > 0) {
    routeCoords.push([lastPoint.lat, lastPoint.lon]);
    if (routePolyline) routePolyline.setLatLngs(routeCoords);
  }

  // Flip button back to orange Start
  const btn = document.getElementById('start-stop-btn');
  btn.textContent = 'Start';
  btn.className   = 'start-btn';

  // Only save if there's a real route (at least a start and end point)
  if (routeCoords.length >= 2) {
    saveRide();
    setStatus('Ride saved!', 'locked');
  } else {
    setStatus('Ride too short to save.', '');
  }
}


// ══════════════════════════════════════════════════════════════
//  GPS CALLBACKS
// ══════════════════════════════════════════════════════════════

function onGpsUpdate(pos) {

  // Ignore any stale GPS callbacks that arrive after Stop was pressed
  if (!isRiding) return;

  const lat      = pos.coords.latitude;
  const lon      = pos.coords.longitude;
  const gpsSpeed = pos.coords.speed;   // device-reported speed in m/s, or null
  const now      = Date.now();

  // ── First GPS fix of this ride ──────────────────────────────
  if (!lastPoint) {
    lastPoint      = { lat, lon };
    lastPointTime  = now;
    lastSavedPoint = { lat, lon, time: now };
    routeCoords.push([lat, lon]);

    // Centre map and draw the route polyline.
    // Update the existing marker if it's already on the map (placed on load),
    // otherwise create it fresh.
    rideMap.setView([lat, lon], 16);
    if (posMarker) {
      posMarker.setLatLng([lat, lon]);
      posMarker.setIcon(createLocationIcon(pos.coords.heading));
    } else {
      posMarker = L.marker([lat, lon], { icon: createLocationIcon(pos.coords.heading), zIndexOffset: 1000 }).addTo(rideMap);
    }
    routePolyline = L.polyline(routeCoords, { color: '#f36f21', weight: 5 }).addTo(rideMap);

    setStatus('GPS locked', 'locked');
    return;
  }

  // ── Distance from the last accepted point ──────────────────
  const dist = haversine(lastPoint.lat, lastPoint.lon, lat, lon);

  // Noise filter: skip this update if movement is too small to be real
  if (dist < NOISE_FILTER_M) return;

  // ── Accumulate total distance ───────────────────────────────
  totalDistance += dist;

  // ── Speed ───────────────────────────────────────────────────
  // Prefer the device-reported speed (more accurate).
  // Fall back to calculating it from distance ÷ time.
  let speed;
  if (gpsSpeed !== null && gpsSpeed >= 0) {
    speed = gpsSpeed * 3.6;                            // m/s → km/h
  } else {
    const dt = (now - lastPointTime) / 1000;           // seconds since last point
    speed = dt > 0 ? (dist / dt) * 3.6 : 0;
  }
  speed = Math.min(speed, 150);                        // cap at 150 km/h (GPS glitch guard)

  // Record this point as the new "last accepted"
  lastPoint     = { lat, lon };
  lastPointTime = now;

  // ── Update the four stat displays ──────────────────────────
  setVal('speed', speed.toFixed(1));
  setVal('distance', (totalDistance / 1000).toFixed(2));

  const elapsedHours = (now - startTime) / 3_600_000;
  const avgSpeed = elapsedHours > 0 ? (totalDistance / 1000) / elapsedHours : 0;
  setVal('avg-speed', avgSpeed.toFixed(1));

  // ── Save route point (throttled to avoid filling up storage) ─
  const timeSinceSave = now - lastSavedPoint.time;
  const distSinceSave = haversine(lastSavedPoint.lat, lastSavedPoint.lon, lat, lon);

  if (timeSinceSave >= SAVE_INTERVAL_MS && distSinceSave >= SAVE_MIN_DIST_M) {
    routeCoords.push([lat, lon]);
    lastSavedPoint = { lat, lon, time: now };
    if (routePolyline) routePolyline.setLatLngs(routeCoords);
  }

  // ── Update map position and heading arrow ──────────────────
  if (posMarker) {
    posMarker.setLatLng([lat, lon]);
    posMarker.setIcon(createLocationIcon(pos.coords.heading));
  }

  // Auto-centre only while the ride is active.
  // Once stopped the user can freely pan/zoom to explore the route.
  if (isRiding) rideMap.setView([lat, lon]);
}

function onGpsError(err) {
  const msg = {
    [err.PERMISSION_DENIED]:    'Location permission denied. Please allow it in your browser settings.',
    [err.POSITION_UNAVAILABLE]: 'GPS signal unavailable. Try going outdoors.',
    [err.TIMEOUT]:              'GPS is taking a while. Make sure you are outdoors with a clear sky.',
  }[err.code] ?? 'GPS error. Please try again.';

  setStatus(msg, 'error');
}


// ══════════════════════════════════════════════════════════════
//  TIMER
// ══════════════════════════════════════════════════════════════

function updateTimer() {
  if (!startTime) return;
  const totalSecs = Math.floor((Date.now() - startTime) / 1000);
  const h   = String(Math.floor(totalSecs / 3600)).padStart(2, '0');
  const m   = String(Math.floor((totalSecs % 3600) / 60)).padStart(2, '0');
  const s   = String(totalSecs % 60).padStart(2, '0');
  setVal('timer', `${h}:${m}:${s}`);
}


// ══════════════════════════════════════════════════════════════
//  SAVE AND LOAD RIDES  (uses localStorage — built into every browser)
// ══════════════════════════════════════════════════════════════

function saveRide() {
  const elapsedSecs = (Date.now() - startTime) / 1000;
  const distKm      = totalDistance / 1000;
  const avgSpeed    = elapsedSecs > 0 ? distKm / (elapsedSecs / 3600) : 0;

  const ride = {
    id:         Date.now(),
    date:       new Date().toLocaleString(),
    distanceKm: distKm.toFixed(2),
    duration:   document.getElementById('timer').textContent,
    avgSpeed:   avgSpeed.toFixed(1),
    route:      routeCoords,            // full array of [lat, lon] pairs
  };

  const rides = getRides();
  rides.unshift(ride);                  // newest ride at the top
  localStorage.setItem('rides', JSON.stringify(rides));

  // Refresh the History tab in the background
  loadHistory();
}

function getRides() {
  try {
    return JSON.parse(localStorage.getItem('rides')) || [];
  } catch {
    return [];
  }
}


// ══════════════════════════════════════════════════════════════
//  HISTORY SCREEN
// ══════════════════════════════════════════════════════════════

function loadHistory() {
  const rides = getRides();
  const list  = document.getElementById('ride-list');

  if (!rides.length) {
    list.innerHTML = '<p class="empty-msg">No rides yet. Go ride!</p>';
    return;
  }

  list.innerHTML = rides.map(r => `
    <div class="ride-card" onclick="showRideDetail(${r.id})">
      <div class="ride-date">${r.date}</div>
      <div class="ride-stats-row">
        <div class="ride-stat">
          <span class="ride-stat-value">${r.distanceKm}</span>
          <span class="ride-stat-label">km</span>
        </div>
        <div class="ride-stat">
          <span class="ride-stat-value">${r.duration}</span>
          <span class="ride-stat-label">time</span>
        </div>
        <div class="ride-stat">
          <span class="ride-stat-value">${r.avgSpeed}</span>
          <span class="ride-stat-label">avg km/h</span>
        </div>
      </div>
    </div>
  `).join('');
}

function showRideDetail(id) {
  const ride = getRides().find(r => r.id === id);
  if (!ride) return;

  // Hide the list, show the detail panel
  document.getElementById('ride-list').classList.add('hidden');
  document.getElementById('ride-detail').classList.remove('hidden');

  // Fill in the stats
  document.getElementById('detail-stats').innerHTML = `
    <h3>${ride.date}</h3>
    <div class="detail-stats-row">
      <div class="ride-stat">
        <span class="ride-stat-value">${ride.distanceKm}</span>
        <span class="ride-stat-label">km</span>
      </div>
      <div class="ride-stat">
        <span class="ride-stat-value">${ride.duration}</span>
        <span class="ride-stat-label">time</span>
      </div>
      <div class="ride-stat">
        <span class="ride-stat-value">${ride.avgSpeed}</span>
        <span class="ride-stat-label">avg km/h</span>
      </div>
    </div>
  `;

  // Destroy any old detail map before creating a new one
  if (detailMap) { detailMap.remove(); detailMap = null; }

  // Leaflet needs the map div to be visible before it can render.
  // A small delay ensures the CSS transition has finished.
  setTimeout(() => {
    detailMap = L.map('detail-map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }).addTo(detailMap);

    if (ride.route && ride.route.length >= 2) {
      const poly = L.polyline(ride.route, { color: '#f36f21', weight: 5 }).addTo(detailMap);
      detailMap.fitBounds(poly.getBounds(), { padding: [30, 30] });
    } else if (ride.route && ride.route.length === 1) {
      detailMap.setView(ride.route[0], 15);
      L.circleMarker(ride.route[0], { radius: 8, color: '#f36f21', fillColor: '#f36f21', fillOpacity: 1 }).addTo(detailMap);
    } else {
      document.getElementById('detail-map').innerHTML =
        '<p style="padding:24px;text-align:center;color:#bbb">No route data saved</p>';
    }
  }, 50);
}

function closeDetail() {
  document.getElementById('ride-detail').classList.add('hidden');
  document.getElementById('ride-list').classList.remove('hidden');
  if (detailMap) { detailMap.remove(); detailMap = null; }
}


// ══════════════════════════════════════════════════════════════
//  SCREEN SWITCHING
// ══════════════════════════════════════════════════════════════

function showScreen(name) {
  // Hide all screens
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  // Show the chosen one
  document.getElementById('screen-' + name).classList.remove('hidden');

  // Update active tab button
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('nav-' + name).classList.add('active');

  // Leaflet needs a nudge when its container becomes visible again
  if (name === 'ride') {
    setTimeout(() => rideMap && rideMap.invalidateSize(), 100);
  }

  if (name === 'history') {
    loadHistory();
  }
}


// ══════════════════════════════════════════════════════════════
//  HAVERSINE DISTANCE FORMULA
//  Calculates the real-world distance (metres) between two
//  GPS coordinates, accounting for the Earth's curvature.
// ══════════════════════════════════════════════════════════════

function haversine(lat1, lon1, lat2, lon2) {
  const R   = 6_371_000;        // Earth's radius in metres
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


// ══════════════════════════════════════════════════════════════
//  TINY HELPERS
// ══════════════════════════════════════════════════════════════

// Builds a Leaflet divIcon that looks like the Google/Apple Maps location dot.
// When the device reports a heading (direction of travel), a cone appears on top
// of the dot and rotates to point the way you're going.
// When stationary (no heading), just a plain blue dot is shown.
function createLocationIcon(heading) {
  const hasHeading = heading !== null && heading !== undefined && !isNaN(heading);
  const rotation   = hasHeading ? heading : 0;

  // Everything is a single inline SVG — no extra CSS file needed.
  const svg = `
    <svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg"
         style="transform:rotate(${rotation}deg);transform-origin:50% 50%;display:block;">

      <!-- Direction cone: only drawn when we have a real heading -->
      ${hasHeading
        ? `<path d="M18 2 L25 18 L18 14 L11 18 Z"
               fill="#0a84ff" fill-opacity="0.85"/>`
        : ''}

      <!-- Outer white ring (gives a clean edge against any map background) -->
      <circle cx="18" cy="18" r="10" fill="white"/>

      <!-- Main blue dot -->
      <circle cx="18" cy="18" r="8" fill="#0a84ff"/>

    </svg>`;

  return L.divIcon({
    className:  '',          // clear Leaflet's default white box
    html:       svg,
    iconSize:   [36, 36],
    iconAnchor: [18, 18],    // centre of the icon sits on the GPS coordinate
  });
}


function setVal(id, value) {
  document.getElementById(id).textContent = value;
}

function setStatus(msg, state) {
  const el    = document.getElementById('gps-status');
  el.textContent = msg;
  el.className   = 'gps-status ' + (state || '');
}


// ── Register service worker (enables PWA install + fast loading) ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}
