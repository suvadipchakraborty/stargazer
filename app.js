'use strict';

/* ---------- Config ---------- */
const FALLBACK = { lat: 22.5726, lon: 88.3639, name: 'Kolkata' };
const APIS = {
  iss: 'https://api.wheretheiss.at/v1/satellites/25544',
  // NASA moved APOD to science.nasa.gov on 29 Sep 2026; the old api.nasa.gov endpoint now returns a logo placeholder. No key needed.
  apod: 'https://science.nasa.gov/wp-json/wp/v2/apod-basic?per_page=1&_fields=date,title,media_type,explanation,credit,copyright,hdurl,url,permalink',
  weather: (lat, lon) =>
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=cloudcover,visibility&daily=sunrise,sunset&timezone=auto&past_days=1&forecast_days=2`,
};
const ISS_INTERVAL_MS = 10000;
const TRAIL_MAX = 90;

const $ = (s) => document.querySelector(s);
let apod = null, userLoc = null;
let map, issMarker, trailLayer, meMarker, mapReady = false;
let trail = [], firstFix = true, lastIssAt = 0;

/* ---------- Utilities ---------- */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/* ---------- Tabs ---------- */
document.querySelectorAll('.bottom-nav button').forEach((b) =>
  b.addEventListener('click', () => showTab(b.dataset.tab))
);
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  document.querySelectorAll('.bottom-nav button').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  window.scrollTo(0, 0);
  if (name === 'iss') {
    initMap();
    setTimeout(() => map && map.invalidateSize(), 50);
  }
}

/* ---------- Location ---------- */
function getLocation() {
  return new Promise((resolve) => {
    const fallback = () => resolve({ lat: FALLBACK.lat, lon: FALLBACK.lon, fallback: true });
    if (!navigator.geolocation) return fallback();
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, fallback: false }),
      fallback,
      { timeout: 8000, maximumAge: 600000 }
    );
  });
}

/* ---------- Moon phase (synodic-month algorithm) ---------- */
function moonPhase(date = new Date()) {
  const SYNODIC = 29.530588853;
  const jd = date.getTime() / 86400000 + 2440587.5;
  let f = ((jd - 2451550.1) / SYNODIC) % 1; // 2000-01-06 new moon
  if (f < 0) f += 1;
  return f; // 0 = new, 0.5 = full
}
const MOON_NAMES = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
function renderMoon() {
  const f = moonPhase();
  const name = MOON_NAMES[Math.floor(f * 8 + 0.5) % 8];
  const illum = Math.round(((1 - Math.cos(2 * Math.PI * f)) / 2) * 100);
  $('#moonName').textContent = name;
  $('#moonIllum').textContent = illum;
  $('#moonNote').textContent =
    illum < 15 ? 'Dark skies: best for faint galaxies and nebulae.' :
    illum > 85 ? 'Bright moonlight washes out faint objects. Aim at the Moon itself.' :
    'Moderate moonlight. Planets and star clusters still look great.';

  const r = 48, c = 50, k = Math.cos(2 * Math.PI * f), rx = Math.abs(k) * r;
  const waxing = f < 0.5;
  let lit;
  if (illum <= 1) lit = '';
  else if (illum >= 99) lit = `M${c},${c - r} A${r},${r} 0 1 1 ${c},${c + r} A${r},${r} 0 1 1 ${c},${c - r}Z`;
  else {
    const outer = waxing ? 1 : 0;
    const term = waxing ? (k > 0 ? 0 : 1) : (k > 0 ? 1 : 0);
    lit = `M${c},${c - r} A${r},${r} 0 0 ${outer} ${c},${c + r} A${rx},${r} 0 0 ${term} ${c},${c - r}Z`;
  }
  $('#moonSvg').innerHTML =
    `<defs><radialGradient id="mg" cx="40%" cy="38%"><stop offset="0" stop-color="#f4f6fb"/><stop offset="1" stop-color="#b9c1d6"/></radialGradient></defs>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="#121a33" stroke="rgba(150,170,255,.25)"/>` +
    (lit ? `<path d="${lit}" fill="url(#mg)"/>` : '');
}

/* ---------- Tonight's sky (Open-Meteo) ---------- */
async function loadSky(loc) {
  userLoc = loc;
  $('#locLabel').textContent = loc.fallback ? `${FALLBACK.name} (default)` : `${loc.lat.toFixed(2)}°, ${loc.lon.toFixed(2)}°`;
  const d = await getJSON(APIS.weather(loc.lat, loc.lon));

  const nowLocal = new Date(Date.now() + d.utc_offset_seconds * 1000).toISOString().slice(0, 16);
  const { sunset, sunrise } = d.daily;
  let start = null, end = null, dark = null, label = 'Tonight';
  for (let i = 0; i < sunset.length - 1; i++) {
    if (sunset[i] <= nowLocal && nowLocal < sunrise[i + 1]) { start = nowLocal; end = sunrise[i + 1]; dark = sunset[i]; label = 'Right now'; break; }
    if (sunset[i] > nowLocal) { start = sunset[i]; end = sunrise[i + 1]; dark = start; break; }
  }
  if (!start) { start = sunset[sunset.length - 2]; end = sunrise[sunrise.length - 1]; dark = start; }

  const hours = d.hourly.time.map((t, i) => ({ t, c: d.hourly.cloudcover[i], v: d.hourly.visibility[i] }))
    .filter((h) => h.t >= start.slice(0, 13) + ':00' && h.t <= end);
  const rows = hours.length ? hours : [{ c: d.hourly.cloudcover[0], v: d.hourly.visibility[0] }];
  const clouds = rows.map((h) => h.c).filter((x) => x != null);
  const vis = rows.map((h) => h.v).filter((x) => x != null);
  const avg = clouds.length ? Math.round(clouds.reduce((a, b) => a + b, 0) / clouds.length) : null;

  $('#cloudPct').textContent = avg ?? '--';
  setSkyMood(avg);
  if (vis.length) {
    const lo = Math.min(...vis) / 1000, hi = Math.max(...vis) / 1000;
    $('#visRange').textContent = Math.abs(hi - lo) < 1 ? `${hi.toFixed(0)} km` : `${lo.toFixed(0)}–${hi.toFixed(0)} km`;
  }
  const hm = (s) => s.slice(11, 16);
  $('#sunsetT').textContent = hm(dark);
  $('#sunriseT').textContent = hm(end);
  document.querySelector('#forecastCard h2').textContent = `${label === 'Right now' ? 'The sky right now' : "Tonight's sky"}`;
}

function setSkyMood(pct) {
  const icon = $('#skyIcon'), v = $('#verdict');
  if (pct == null) { icon.textContent = '🌌'; v.textContent = 'No cloud data for your location.'; return; }
  if (pct < 20) { icon.textContent = '✨'; v.textContent = 'Clear skies. Take the telescope out.'; }
  else if (pct < 50) { icon.textContent = '🌤️'; v.textContent = 'Mostly clear, with some passing cloud.'; }
  else if (pct < 80) { icon.textContent = '🌥️'; v.textContent = 'Patchy views. Wait for gaps in the cloud.'; }
  else { icon.textContent = '☁️'; v.textContent = 'Heavy cloud. Better to stay in tonight.'; }
}

/* ---------- NASA APOD ---------- */
const APOD_CACHE_KEY = 'sg-apod-v2';
const htmlToText = (html) => {
  const d = new DOMParser().parseFromString(html || '', 'text/html');
  return (d.body.textContent || '').replace(/\s+/g, ' ').trim();
};
function normalizeAPOD(raw) {
  if (!raw || !raw.title || raw.title === 'NASA Science') throw new Error('APOD placeholder or empty response');
  let text = htmlToText(raw.explanation).replace(/^Explanation:\s*/i, '');
  // Drop APOD boilerplate that follows the explanation
  const cut = text.search(/Your Sky Surprise|APOD's email|APOD's main NASA site|Tomorrow's picture/i);
  if (cut > 0) text = text.slice(0, cut).trim();
  let image = null;
  if (raw.media_type === 'image' && raw.hdurl) {
    try {
      const u = new URL(raw.hdurl);
      u.searchParams.set('w', '1280'); u.searchParams.set('h', '1280'); u.searchParams.set('fit', 'clip');
      u.searchParams.delete('crop');
      image = u.toString();
    } catch (e) { image = raw.hdurl; }
  }
  const credit = htmlToText(raw.credit || raw.copyright).replace(/^Image Credit( & Copyright)?:\s*/i, '');
  return {
    title: htmlToText(raw.title), date: raw.date, explanation: text, credit,
    media_type: raw.media_type, image, link: raw.permalink || raw.url || 'https://science.nasa.gov/apod/',
  };
}
async function loadAPOD() {
  let data;
  try {
    const list = await getJSON(APIS.apod);
    data = normalizeAPOD(Array.isArray(list) ? list[0] : list);
    localStorage.setItem(APOD_CACHE_KEY, JSON.stringify(data));
  } catch (e) {
    const cached = localStorage.getItem(APOD_CACHE_KEY);
    if (!cached) { $('#apodTitle').textContent = 'Picture unavailable right now'; $('#apodText').textContent = 'NASA could not be reached. Try again in a minute.'; $('#heroBg').classList.add('ready'); throw e; }
    data = JSON.parse(cached);
    toast('Showing the last saved picture');
  }
  apod = data;
  $('#apodTitle').textContent = data.title;
  $('#apodDate').textContent = new Date(data.date + 'T12:00:00').toLocaleDateString(undefined, { dateStyle: 'long' });
  $('#apodText').textContent = data.explanation;
  $('#apodCredit').textContent = data.credit ? `Image credit: ${data.credit}` : 'Image credit: NASA';
  if (data.image) {
    const pre = new Image();
    pre.onload = () => { const bg = $('#heroBg'); bg.style.backgroundImage = `url("${data.image}")`; bg.classList.add('ready'); };
    pre.onerror = () => $('#heroBg').classList.add('ready');
    pre.src = data.image;
  } else $('#heroBg').classList.add('ready');
}
try { localStorage.removeItem('sg-apod'); } catch (e) {} // old cache may hold the placeholder
$('#shareBtn').addEventListener('click', async () => {
  if (!apod) return toast('Picture is still loading');
  const shareData = {
    title: apod.title,
    text: `${apod.title}: NASA's Astronomy Picture of the Day, via Stargazer`,
    url: apod.link,
  };
  try {
    if (navigator.share) await navigator.share(shareData);
    else { await navigator.clipboard.writeText(shareData.url); toast('Link copied'); }
  } catch (e) { if (e.name !== 'AbortError') toast('Could not share'); }
});

/* ---------- ISS tracker ---------- */
const fmtCoord = (v, pos, neg) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? pos : neg}`;

function initMap() {
  if (mapReady || typeof L === 'undefined') return;
  mapReady = true;
  map = L.map('map', { zoomControl: false, worldCopyJump: true, minZoom: 1 }).setView([20, 0], 2);
  // Keyless OpenStreetMap tiles, darkened with CSS (.dark-tiles). CARTO's free tiles now require an API key.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors', maxZoom: 8, className: 'dark-tiles',
  }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  trailLayer = L.polyline([], { color: '#5ee7ff', weight: 2, opacity: 0.8, dashArray: '2 6' }).addTo(map);
  issMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="iss-marker">🛰️</div>', iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(map);
  if (userLoc) meMarker = L.marker([userLoc.lat, userLoc.lon], { icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [12, 12] }), title: 'You' }).addTo(map);
  if (trail.length) drawIss(trail[trail.length - 1][0], trail[trail.length - 1][1]);
}
function drawIss(lat, lon) {
  if (!mapReady) return;
  issMarker.setLatLng([lat, lon]);
  // Split the path at the antimeridian so lines don't streak across the map
  const segs = [[]];
  trail.forEach((p, i) => {
    if (i && Math.abs(p[1] - trail[i - 1][1]) > 180) segs.push([]);
    segs[segs.length - 1].push(p);
  });
  trailLayer.setLatLngs(segs);
  if (firstFix) { map.setView([lat, lon], 3); firstFix = false; } else map.panTo([lat, lon], { animate: true });
}
async function updateISS() {
  if (document.hidden && lastIssAt) return;
  try {
    const d = await getJSON(APIS.iss);
    lastIssAt = Date.now();
    $('#issLat').textContent = fmtCoord(d.latitude, 'N', 'S');
    $('#issLon').textContent = fmtCoord(d.longitude, 'E', 'W');
    $('#issAlt').textContent = `${d.altitude.toFixed(1)} km`;
    $('#issSpeed').textContent = `· ${Math.round(d.velocity).toLocaleString()} km/h`;
    $('#issStatus').textContent = 'Live · updates every 10 seconds';
    $('#liveDot').classList.add('on');
    trail.push([d.latitude, d.longitude]);
    if (trail.length > TRAIL_MAX) trail.shift();
    drawIss(d.latitude, d.longitude);
  } catch (e) {
    $('#liveDot').classList.remove('on');
    $('#issStatus').textContent = 'Signal lost. Retrying in 10 seconds…';
  }
}

/* ---------- PWA install ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('#installHint').textContent = '';
});
$('#installBtn').addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  } else if (window.matchMedia('(display-mode: standalone)').matches) {
    $('#installHint').textContent = 'Stargazer is already installed on this device.';
  } else if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
    $('#installHint').textContent = 'On iPhone or iPad: tap Share, then Add to Home Screen.';
  } else {
    $('#installHint').textContent = 'Open your browser menu and choose Install app or Add to Home Screen.';
  }
});
window.addEventListener('appinstalled', () => { $('#installHint').textContent = 'Installed. Find Stargazer on your home screen.'; });

/* ---------- Boot ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
renderMoon();
Promise.allSettled([
  getLocation().then(loadSky).catch(() => { $('#verdict').textContent = 'Could not load the forecast. Check your connection.'; $('#locLabel').textContent = 'Offline'; }),
  loadAPOD(),
  updateISS(),
]);
setInterval(updateISS, ISS_INTERVAL_MS);
