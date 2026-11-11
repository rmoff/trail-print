// GPX parsing and run statistics. Pure functions, no DOM, so they run in Node tests too.

const R_EARTH = 6371008.8;

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`).exec(attrs);
  return m ? m[1] : null;
}

function child(body, tag) {
  const m = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(body);
  return m ? decodeEntities(m[1].trim()) : null;
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, '&');
}

function points(text, tag) {
  const out = [];
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${tag}>)`, 'g');
  let m;
  while ((m = re.exec(text))) {
    const lat = parseFloat(attr(m[1], 'lat'));
    const lon = parseFloat(attr(m[1], 'lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const body = m[2] || '';
    const ele = parseFloat(child(body, 'ele'));
    const time = child(body, 'time');
    out.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null, time, name: child(body, 'name') });
  }
  return out;
}

/** Parse GPX text into { name, time, track: [{lat,lon,ele,time}], waypoints: [{lat,lon,name}] }. */
export function parseGpx(text) {
  if (typeof text !== 'string' || !/<gpx\b/i.test(text)) throw new Error('Not a GPX file.');
  let track = points(text, 'trkpt');
  if (track.length < 2) track = points(text, 'rtept');
  if (track.length < 2) throw new Error('No route in this GPX file.');
  const trk = /<(?:\w+:)?trk\b[^>]*>([\s\S]*?)<(?:\w+:)?trkseg\b/.exec(text);
  const meta = /<(?:\w+:)?metadata\b[^>]*>([\s\S]*?)<\/(?:\w+:)?metadata>/.exec(text);
  const name = (trk && child(trk[1], 'name')) || (meta && child(meta[1], 'name')) || '';
  const time = track.find(p => p.time)?.time || (meta && child(meta[1], 'time')) || null;
  const waypoints = points(text, 'wpt').map(p => ({ lat: p.lat, lon: p.lon, name: p.name || '' }));
  return { name, time, track: track.map(({ lat, lon, ele, time }) => ({ lat, lon, ele, time })), waypoints };
}

export function haversine(a, b) {
  const k = Math.PI / 180;
  const dLat = (b.lat - a.lat) * k, dLon = (b.lon - a.lon) * k;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Total distance (m) and climb (m). Climb uses a hysteresis threshold so GPS jitter does not count. */
export function trackStats(track, eleOf = p => p.ele) {
  let dist = 0;
  for (let i = 1; i < track.length; i++) dist += haversine(track[i - 1], track[i]);
  let climb = 0, ref = null;
  const threshold = 3;
  for (const p of track) {
    const e = eleOf(p);
    if (e == null || !Number.isFinite(e)) continue;
    if (ref == null) { ref = e; continue; }
    if (e - ref >= threshold) { climb += e - ref; ref = e; }
    else if (ref - e >= threshold) ref = e;
  }
  const hasEle = track.some(p => eleOf(p) != null);
  return { distance: dist, climb: hasEle ? climb : null };
}
