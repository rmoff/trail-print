import { parseGpx, trackStats } from './gpx.js';
import { SHAPES, fitShape, makeProjection } from './geo.js';
import { NOZZLES } from './model.js';
import { loadDem } from './dem.js';
import { fetchWater } from './water.js';
import { Preview } from './preview.js';
import { loadSaved, save, forget } from './saved.js';
import { PRINTERS, fits, towerRoom, largestFit, footprint } from './plate.js';

const $ = id => document.getElementById(id);
const layout = document.querySelector('.layout');
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const fontReady = fetch('vendor/fredoka-600.woff').then(r => r.arrayBuffer()).then(buf => {
  worker.postMessage({ type: 'font', buffer: buf }, [buf]);
});

const state = {
  gpx: null,          // parsed GPX
  origin: null,       // [lat, lon] projection origin
  track: null,        // [[lat, lon], ...]
  markers: null,
  dem: null, demKey: null,
  water: null, waterBounds: null, waterFailed: false,
  textEdited: { title: false, sub: false, stats: false },
  buildId: 0,
  built: null,
};
let preview = null;
// Every way of choosing a run (file, example, restored state) takes a ticket; only the newest
// may finish loading, so a slow file, example or restore can't replace one chosen since.
let loadTicket = 0;

for (const p of PRINTERS) $('printer').add(new Option(`${p.name} (${p.w} × ${p.d} mm)`, p.id));
$('printer').add(new Option('Other (enter plate size)', 'custom'));
/** The chosen printer's plate, in mm. */
function plate() {
  const id = $('printer').value;
  const p = PRINTERS.find(q => q.id === id);
  if (p) return p;
  const clamp = v => Math.min(1000, Math.max(60, Math.round(+v || 180)));
  return { id: 'custom', name: 'Your printer', w: clamp($('plate-w').value), d: clamp($('plate-d').value) };
}
/** Plate drawn under the tile, with a see-through purge tower where it fits (colour prints). */
function showPlate() {
  const o = options(), pl = plate();
  $('plate-custom').hidden = pl.id !== 'custom';
  $('stage-notes').hidden = !state.gpx;
  $('plate-label').textContent = `${pl.id === 'custom' ? 'Plate' : pl.name}, ${pl.w} × ${pl.d} mm`;
  // Problems with fitting on the plate are shown on the preview itself, so the settings
  // panel never changes length (and jumps) when a setting changes.
  const fit = fits(o.shape, o.sizeMm, pl);
  const room = fit !== 'no' && o.colourMode !== 'one' ? towerRoom(o.shape, o.sizeMm, pl).room : null;
  let note = null, warn = false;
  if (fit === 'no') { note = 'Too big for this plate. Try Fit to plate.'; warn = true; }
  else if (room === 'none') { note = 'No room for the purge tower. Try Fit to plate, or one colour.'; warn = true; }
  else if (fit === 'turned' && room === 'corner') note = 'In the slicer, rotate it 90° and move it to a corner.';
  else if (fit === 'turned') note = 'In the slicer, rotate it 90° to fit.';
  else if (room === 'turned') note = 'In the slicer, rotate it 90° to make room for the purge tower.';
  else if (room === 'corner') note = 'In the slicer, move it to a corner to make room for the purge tower.';
  const cn = $('canvas-note');
  cn.hidden = !note;
  cn.textContent = note || '';
  cn.classList.toggle('warn', warn);
  // Screen readers: an always-present live region, also linked from the size slider.
  if ($('fit-live').textContent !== (note || '')) $('fit-live').textContent = note || '';
  if (!preview) return;
  const tower = room === 'centred' ? towerRoom(o.shape, o.sizeMm, pl).tower : null;
  preview.setPlate(pl, tower, { tooBig: fit === 'no' });
}
const EXPORT_BUTTONS = ['dl-3mf', 'dl-stl', 'dl-prusa'];
/** Downloads are only offered for a model that matches the current file and settings. */
function setExportsEnabled(on) { for (const id of EXPORT_BUTTONS) $(id).disabled = !on; }

// ---------- status ----------
function status(text, kind = 'busy') {
  const el = $('status');
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle('error', kind === 'error');
  el.classList.toggle('info', kind === 'info');
  $('status-text').textContent = text;
}

// ---------- reading the file ----------
async function loadFile(file, restoredText = null, ticket = ++loadTicket) {
  try {
    const text = await file.text();
    if (ticket !== loadTicket) return; // a newer choice has been made since
    const gpx = parseGpx(text);
    const track = gpx.track.map(p => [p.lat, p.lon]);
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [la, lo] of track) {
      minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la);
      minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo);
    }
    if (maxLon - minLon > 180) throw new Error('Routes crossing the 180° meridian aren\u2019t supported.');
    if (Math.max(Math.abs(minLat), Math.abs(maxLat)) > 84) throw new Error('No terrain data this close to the poles.');
    const proj0 = makeProjection((minLat + maxLat) / 2, (minLon + maxLon) / 2);
    const [x0, y0] = proj0.fwd(minLat, minLon), [x1, y1] = proj0.fwd(maxLat, maxLon);
    if (Math.hypot(x1 - x0, y1 - y0) > 300000) throw new Error('Routes over 300 km across aren\u2019t supported.');
    state.gpx = gpx;
    state.gpxText = text;
    state.fileName = file.name;
    state.track = track;
    state.origin = [(minLat + maxLat) / 2, (minLon + maxLon) / 2];
    state.built = null;
    setExportsEnabled(false);
    const first = state.track[0], lastPt = state.track[state.track.length - 1];
    state.markers = [first, lastPt, ...gpx.waypoints.map(w => [w.lat, w.lon])];
    state.dem = null; state.demKey = null; state.water = []; state.waterBounds = null; state.waterFailed = false;
    water.generation++; water.pending = null; water.wanted = null;
    state.textEdited = { title: false, sub: false, stats: false };
    const stats = trackStats(gpx.track);
    state.stats = stats;
    const date = gpx.time ? new Date(gpx.time) : null;
    state.dateText = date && !isNaN(date) ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    $('run-name').textContent = gpx.name || file.name.replace(/\.gpx$/i, '');
    $('run-meta').textContent = [state.dateText, formatKm(stats.distance), stats.climb != null ? `${Math.round(stats.climb)} m climb` : null].filter(Boolean).join(', ');
    $('run-summary').hidden = false;
    setText('title', gpx.name || 'My run');
    setText('sub', state.dateText);
    setText('stats', statsLine());
    layout.classList.add('has-run');
    document.body.classList.add('has-run');
    $('view-buttons').hidden = false;
    if (!preview) preview = new Preview($('viewer'));
    showPlate();
    if (restoredText) {
      for (const [which, value] of Object.entries(restoredText.values || {})) {
        state.textEdited[which] = !!restoredText.edited?.[which];
        $({ title: 't-title', sub: 't-sub', stats: 't-stats' }[which]).value = value;
      }
    }
    lookUpPlace(state.track[0], gpx);
    rebuild();
    remember();
  } catch (e) {
    if (ticket === loadTicket) status(e.message || 'Could not read that file.', 'error');
  }
}

const formatKm = m => `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
const statsLine = () => [formatKm(state.stats.distance), state.stats.climb != null ? `${Math.round(state.stats.climb)} m climb` : null].filter(Boolean).join('  ·  ');

function setText(which, value) {
  const el = $({ title: 't-title', sub: 't-sub', stats: 't-stats' }[which]);
  if (!state.textEdited[which]) el.value = String(value).slice(0, el.maxLength > 0 ? el.maxLength : 50);
}

/**
 * Name the place the run starts from, e.g. "Ilkley", using OpenStreetMap's Nominatim.
 * The start is rounded to about a kilometre first: runs often start at someone's door.
 */
async function lookUpPlace([lat, lon], gpx) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`;
    const res = await fetch(url, { headers: { 'Accept-Language': navigator.language || 'en' } });
    if (!res.ok) return;
    const j = await res.json();
    const a = j.address || {};
    const place = a.village || a.town || a.city || a.hamlet || a.suburb || a.county || '';
    if (place && state.gpx === gpx) {
      setText('sub', [place, state.dateText].filter(Boolean).join(', '));
      scheduleRebuild();
    }
  } catch { /* the date alone is fine */ }
}

// ---------- settings ----------
function options() {
  const auto = $('exag-auto').checked;
  return {
    shape: document.querySelector('input[name=shape]:checked').value,
    sizeMm: +$('size').value,
    nozzle: +document.querySelector('input[name=nozzle]:checked').value,
    colourMode: document.querySelector('input[name=colours]:checked').value,
    exaggeration: auto ? null : +$('exag').value,
    margin: 1 + +$('margin').value / 100,
    baseMm: 4,
  };
}

function updateNotes() {
  const o = options();
  $('size-out').textContent = `${o.sizeMm} mm`;
  $('margin-out').textContent = `${$('margin').value}%`;
  const exagText = o.exaggeration == null ? (state.built ? `${state.built.info.exaggeration}× (auto)` : 'auto') : `${o.exaggeration}×`;
  $('exag-out').textContent = o.exaggeration == null ? (state.built ? `${state.built.info.exaggeration}×` : '') : `${o.exaggeration}×`;
  $('exag').disabled = o.exaggeration == null;
  const f = footprint(o.shape, o.sizeMm);
  $('size-note').textContent = `${Math.round(f.w)} × ${Math.round(f.d)} mm`;
  showPlate();
  // Closed sections show their current values in the heading.
  const pl = plate();
  const shortName = pl.id === 'custom' ? `${pl.w} × ${pl.d} mm plate` : pl.name.replace(/^(Bambu Lab|Prusa|Creality) /, '');
  $('sum-printer').textContent = `${shortName}, ${o.nozzle} mm`;
  $('sum-terrain').textContent = `Hills ${exagText}, ${$('margin').value}% margin`;
  $('sum-text').textContent = $('t-title').value || 'None';
  renderSlots();
}

const PART_LABELS = { land: 'land', water: 'water', route: 'route', details: 'start, finish and text', 'Route & text': 'route and text' };
/** "How to print" list: one line per filament slot of the last built model. */
function renderSlots() {
  const parts = state.built?.parts;
  if (!parts) { $('slot-list').innerHTML = ''; return; }
  const bySlot = new Map();
  for (const p of parts) {
    const label = PART_LABELS[p.name] || PART_LABELS[p.key] || p.name;
    if (!bySlot.has(p.slot)) bySlot.set(p.slot, { colour: p.colour, labels: [] });
    bySlot.get(p.slot).labels.push(label);
  }
  const lines = [...bySlot].sort((a, b) => a[0] - b[0]).map(([slot, v]) => {
    const what = v.labels.join(', ');
    const text = bySlot.size === 1 ? 'One filament for everything' : `Filament ${slot}: ${what}`;
    return `<li><i class="sw" style="--c:${v.colour}"></i>${text}</li>`;
  });
  $('slot-list').innerHTML = lines.join('');
}

let timer = null;
function scheduleRebuild() {
  remember();
  updateNotes();
  clearTimeout(timer);
  setExportsEnabled(false); // the shown model no longer matches the settings
  timer = setTimeout(() => { timer = null; rebuild(); }, 350);
}

// Fit to plate: the biggest tile that fits (leaving room for the purge tower on colour prints).
$('fit-plate').addEventListener('click', () => {
  const o = options();
  const best = largestFit(o.shape, plate(), o.colourMode !== 'one');
  const min = +$('size').min;
  if (!best || best < min) {
    status(`Plate too small for a ${min} mm tile${o.colourMode !== 'one' ? ' and purge tower' : ''}.`, 'error');
    return;
  }
  $('size').value = String(Math.min(+$('size').max, best));
  scheduleRebuild();
});

const PLATE_CONTROLS = ['printer', 'plate-w', 'plate-d'];
for (const id of PLATE_CONTROLS) $(id).addEventListener(id === 'printer' ? 'change' : 'input', () => { updateNotes(); remember(); });
for (const el of document.querySelectorAll('#panel input')) {
  if (PLATE_CONTROLS.includes(el.id)) continue;
  if (el.type === 'text') {
    el.addEventListener('input', () => {
      const which = { 't-title': 'title', 't-sub': 'sub', 't-stats': 'stats' }[el.id];
      state.textEdited[which] = true;
      scheduleRebuild();
    });
  } else {
    el.addEventListener(el.type === 'range' ? 'input' : 'change', scheduleRebuild);
  }
}

// ---------- lakes (background) ----------
const water = { generation: 0, pending: null, wanted: null };
const covers = (wb, b) => wb && wb.south <= b.south && wb.west <= b.west && wb.north >= b.north && wb.east >= b.east;
/**
 * Fetch water for a wider area than needed (so most setting changes reuse it), then rebuild.
 * One request at a time; the newest area asked for is remembered and checked again when the
 * running request finishes. Results for an earlier file are thrown away.
 */
function requestWater(bounds) {
  water.wanted = bounds;
  if (covers(state.waterBounds, bounds) || state.waterFailed || water.pending) return;
  const cLat = (bounds.south + bounds.north) / 2, cLon = (bounds.west + bounds.east) / 2;
  const big = {
    south: cLat - (cLat - bounds.south) * 1.6, north: cLat + (bounds.north - cLat) * 1.6,
    west: cLon - (cLon - bounds.west) * 1.6, east: cLon + (bounds.east - cLon) * 1.6,
  };
  const gen = water.generation;
  const req = fetchWater(big, { timeoutMs: 25000 }).then(polys => {
    if (gen !== water.generation) return;
    state.water = polys; state.waterBounds = big;
    scheduleRebuild();
  }).catch(() => {
    if (gen !== water.generation) return;
    state.waterFailed = true;
    if (state.built) showInfo(state.built.info, state.built.warnings);
  }).finally(() => {
    if (water.pending !== req) return;
    water.pending = null;
    if (gen === water.generation && water.wanted && !covers(state.waterBounds, water.wanted)) requestWater(water.wanted);
  });
  water.pending = req;
}

// ---------- building ----------
async function rebuild() {
  if (!state.gpx) return;
  const id = ++state.buildId;
  setExportsEnabled(false);
  const o = options();
  const shape = SHAPES[o.shape];
  const noz = NOZZLES[o.nozzle];
  try {
    const proj = makeProjection(state.origin[0], state.origin[1]);
    const pts = state.track.map(([la, lo]) => proj.fwd(la, lo));
    const fit = fitShape(shape, pts, o.margin);
    const R = shape.sizeToR(o.sizeMm);
    const mPerMm = fit.radius / R;
    const pad = fit.radius * 1.06;
    const sw = proj.inv(fit.cx - pad, fit.cy - pad), ne = proj.inv(fit.cx + pad, fit.cy + pad);
    const bounds = { south: sw[0], west: sw[1], north: ne[0], east: ne[1] };

    const demKey = JSON.stringify([bounds, Math.round(Math.log2(noz.spacing * mPerMm) * 2)]);
    if (state.demKey !== demKey) {
      status('Loading terrain');
      const dem = await loadDem(bounds, noz.spacing * mPerMm, { onProgress: f => id === state.buildId && status(`Loading terrain ${Math.round(f * 100)}%`) });
      if (id !== state.buildId) return;
      state.dem = dem; state.demKey = demKey;
    }
    requestWater(bounds);
    await fontReady;
    status('Building model');
    worker.postMessage({
      type: 'build', id,
      origin: state.origin, track: state.track, markers: state.markers,
      dem: state.dem, water: state.water, options: o,
      text: { title: $('t-title').value, subtitle: $('t-sub').value, stats: $('t-stats').value },
    });
  } catch (e) {
    if (id === state.buildId) status(`Could not build the model: ${e.message}`, 'error');
  }
}

const pending = new Map(); // export id -> { resolve, reject }
worker.onmessage = e => {
  const m = e.data;
  if (m.type === 'progress' && m.id === state.buildId) status('Building model');
  else if (m.type === 'built' && m.id === state.buildId) {
    const o = options();
    state.built = m;
    preview.setParts(m.parts, o.sizeMm);
    showInfo(m.info, m.warnings);
    setExportsEnabled(timer === null);
    status(null);
    updateNotes();
  } else if (m.type === 'exported') {
    pending.get(m.id)?.resolve(m);
    pending.delete(m.id);
  } else if (m.type === 'error') {
    if (pending.has(m.id)) {
      pending.get(m.id).reject(new Error(m.message));
      pending.delete(m.id);
    } else if (m.id === state.buildId) {
      status(`Could not build the model: ${m.message}`, 'error');
    }
  }
};
worker.onerror = e => {
  e.preventDefault?.();
  for (const p of pending.values()) p.reject(new Error('Out of memory.'));
  pending.clear();
  status('Out of memory. Try a smaller size or the 0.4 mm nozzle, then reload.', 'error');
};

function showInfo(info, warnings) {
  const el = $('model-info');
  el.hidden = false;
  el.innerHTML = `<dl>
    <dt>Height</dt><dd>${info.heightMm.toFixed(1)} mm</dd>
    <dt>Scale</dt><dd>1 km = ${info.mmPerKm.toFixed(1)} mm</dd>
  </dl>`;
  const all = [...warnings];
  if (state.waterFailed) all.push('Couldn\u2019t load water: lakes and rivers are missing.');
  const w = $('warnings');
  w.hidden = !all.length;
  w.innerHTML = all.map(x => `<li>${escapeHtml(x)}</li>`).join('');
}
const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- downloads ----------
let exportId = 1e6;
function exportFile(format, pl) {
  return new Promise((resolve, reject) => {
    const id = ++exportId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'export', id, format, bedW: pl.w, bedD: pl.d, buildId: state.built?.id });
  });
}
function fileBase() {
  const t = ($('t-title').value || 'trail-print').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return t || 'trail-print';
}
const lastDownloadUrl = {};
async function download(format) {
  const btn = { stl: $('dl-stl'), prusa: $('dl-prusa') }[format] || $('dl-3mf');
  const ext = format === 'stl' ? 'stl' : '3mf';
  btn.disabled = true;
  status(`Making the ${ext.toUpperCase()} file`);
  try {
    const pl = plate();
    const m = await exportFile(format, pl);
    const now = plate();
    if (!modelIsCurrent() || now.w !== pl.w || now.d !== pl.d) throw new Error('Settings changed. Download again.');
    const blob = new Blob([m.bytes], { type: ext === 'stl' ? 'model/stl' : 'model/3mf' });
    // Keep the file's link alive until the next download of the same type: the browser may
    // hold a download for the visitor to confirm (Chrome does this on plain-HTTP pages), and
    // releasing the link early leaves nothing to save once they click Keep.
    if (lastDownloadUrl[format]) URL.revokeObjectURL(lastDownloadUrl[format]);
    const a = document.createElement('a');
    a.href = lastDownloadUrl[format] = URL.createObjectURL(blob);
    a.download = `${fileBase()}${format === 'prusa' ? '-prusaslicer' : ''}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
    status(null);
  } catch (e) {
    status(e.message, 'error');
  } finally {
    btn.disabled = !modelIsCurrent();
  }
}
const modelIsCurrent = () => !!state.built && state.built.id === state.buildId && timer === null;
$('dl-3mf').addEventListener('click', () => download('3mf'));

$('dl-stl').addEventListener('click', () => download('stl'));
$('dl-prusa').addEventListener('click', () => download('prusa'));

// ---------- remembered between visits (this browser only) ----------
const SETTING_INPUTS = ['size', 'exag', 'margin', 'printer', 'plate-w', 'plate-d'];
const SETTING_RADIOS = ['shape', 'nozzle', 'colours'];
let rememberTimer = null, lastSave = Promise.resolve(), forgetting = false;
function remember() {
  if (!state.gpxText || forgetting) return;
  clearTimeout(rememberTimer);
  rememberTimer = setTimeout(() => { if (!forgetting) lastSave = save({
    gpxText: state.gpxText, fileName: state.fileName,
    inputs: Object.fromEntries(SETTING_INPUTS.map(id => [id, $(id).value])),
    radios: Object.fromEntries(SETTING_RADIOS.map(n => [n, document.querySelector(`input[name=${n}]:checked`).value])),
    exagAuto: $('exag-auto').checked,
    text: {
      values: { title: $('t-title').value, sub: $('t-sub').value, stats: $('t-stats').value },
      edited: { ...state.textEdited },
    },
  }); }, 400);
}
async function restore() {
  const ticket = ++loadTicket;
  const s = await loadSaved();
  if (!s?.gpxText || state.gpx || ticket !== loadTicket) return;
  for (const [id, v] of Object.entries(s.inputs || {})) if ($(id)) $(id).value = v;
  for (const [n, v] of Object.entries(s.radios || {})) {
    const el = document.querySelector(`input[name=${n}][value="${CSS.escape(String(v))}"]`);
    if (el) el.checked = true;
  }
  if (typeof s.exagAuto === 'boolean') $('exag-auto').checked = s.exagAuto;
  updateNotes();
  await loadFile({ name: s.fileName || 'run.gpx', text: async () => s.gpxText }, s.text, ticket);
}
$('forget').addEventListener('click', async () => {
  forgetting = true;            // nothing may save from here on (timers, place lookup, rebuilds)
  clearTimeout(rememberTimer);
  await lastSave;               // let a write already in flight finish first...
  await forget();               // ...so this delete is the last word
  location.reload();
});

// ---------- example route ----------
// The course of the Wharfedale Three Peaks fell race (Kettlewell, Yorkshire Dales): times and
// heart rate stripped, track thinned. ?demo in the address opens straight into it.
const DEMO = { url: 'demo/wharfedale-three-peaks.gpx', title: 'Wharfedale Three Peaks', sub: 'Upper Wharfedale, Yorkshire Dales' };
async function loadDemo() {
  const ticket = ++loadTicket;
  try {
    status('Loading example');
    const res = await fetch(DEMO.url);
    if (!res.ok) throw new Error(`example route ${res.status}`);
    const text = await res.text();
    if (ticket !== loadTicket) return;
    await loadFile({ name: 'wharfedale-three-peaks.gpx', text: async () => text },
      { values: { title: DEMO.title, sub: DEMO.sub }, edited: { title: false, sub: true } }, ticket);
  } catch (e) {
    if (ticket === loadTicket) status(`Couldn\u2019t load the example (${e.message}).`, 'error');
  }
}
$('try-demo').addEventListener('click', loadDemo);

// ---------- file input ----------
$('file').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
$('change-file').addEventListener('click', () => $('file').click());
const dz = $('dropzone');
const stage = document.querySelector('.stage');
stage.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragging'); });
stage.addEventListener('dragleave', () => dz.classList.remove('dragging'));
stage.addEventListener('drop', e => {
  e.preventDefault(); dz.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => preview?.view(b.dataset.view));

updateNotes();
// ?demo opens the example once: it is removed from the address so a reload restores
// whatever the visitor has done since, instead of loading the example again.
const params = new URLSearchParams(location.search);
if (params.has('demo')) {
  params.delete('demo');
  history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : '') + location.hash);
  loadDemo();
} else {
  restore();
}
// For automated tests: window.__trail exposes state.
window.__trail = { state, loadFile };
