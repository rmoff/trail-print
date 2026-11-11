// Water (sea, lakes, reservoirs, wide rivers) from OpenFreeMap's vector tiles
// (OpenMapTiles schema, data © OpenStreetMap contributors), turned into a fast
// "is this point water?" test.

import Pbf from '../vendor/pbf.js';
import { lonToX, latToY } from './dem.js';

export const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const MAX_ZOOM = 14;

// ---------- minimal Mapbox Vector Tile decoder (polygons of one layer) ----------
/** Decode polygon rings of layer `layerName` from an MVT buffer. Returns [{ rings: [[[x,y]...]...], extent }] */
export function decodePolygons(buffer, layerName) {
  const pbf = new Pbf(buffer);
  const features = [];
  pbf.readFields((tag, _, p) => {
    if (tag !== 3) return; // layers
    const layer = { name: '', extent: 4096, features: [] };
    p.readMessage((ltag, l, lp) => {
      if (ltag === 1) l.name = lp.readString();
      else if (ltag === 5) l.extent = lp.readVarint();
      else if (ltag === 2) {
        const f = { type: 0, geometry: null };
        lp.readMessage((ftag, ff, fp) => {
          if (ftag === 3) ff.type = fp.readVarint();
          else if (ftag === 4) {
            const end = fp.readVarint() + fp.pos;
            const g = [];
            while (fp.pos < end) g.push(fp.readVarint());
            ff.geometry = g;
          }
        }, f);
        l.features.push(f);
      }
    }, layer);
    if (layer.name === layerName) {
      for (const f of layer.features) {
        if (f.type !== 3 || !f.geometry) continue;
        features.push({ rings: decodeGeometry(f.geometry), extent: layer.extent });
      }
    }
  }, null);
  return features;
}

function decodeGeometry(g) {
  const rings = [];
  let x = 0, y = 0, ring = null, i = 0;
  while (i < g.length) {
    const cmd = g[i] & 7, count = g[i] >> 3;
    i++;
    if (cmd === 1 || cmd === 2) {
      for (let k = 0; k < count; k++) {
        const dx = g[i++], dy = g[i++];
        x += (dx >> 1) ^ -(dx & 1);
        y += (dy >> 1) ^ -(dy & 1);
        if (cmd === 1) { if (ring && ring.length >= 3) rings.push(ring); ring = [[x, y]]; }
        else ring.push([x, y]);
      }
    } else if (cmd === 7) {
      if (ring && ring.length >= 3) rings.push(ring);
      ring = null;
    }
  }
  if (ring && ring.length >= 3) rings.push(ring);
  return rings;
}

function tileToLatLon(z, tx, ty, extent, [px, py]) {
  const n = 2 ** z;
  const lon = ((tx + px / extent) / n) * 360 - 180;
  const yy = (ty + py / extent) / n;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * yy))) * 180) / Math.PI;
  return [lat, lon];
}

let tileTemplate = null;
async function template(signal) {
  if (!tileTemplate) {
    const res = await fetch(TILEJSON_URL, { signal });
    if (!res.ok) throw new Error(`map data ${res.status}`);
    tileTemplate = (await res.json()).tiles[0];
  }
  return tileTemplate;
}

export function chooseWaterZoom(b, maxTiles = 30) {
  for (let z = MAX_ZOOM; z >= 5; z--) {
    const x0 = Math.floor(lonToX(b.west, z)), x1 = Math.floor(lonToX(b.east, z));
    const y0 = Math.floor(latToY(b.north, z)), y1 = Math.floor(latToY(b.south, z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= maxTiles) return { z, x0, x1, y0, y1 };
  }
  return null;
}

/** Browser: water polygons for `bounds` as [{ rings: [[[lat,lon],...], ...] }]. */
export async function fetchWater(bounds, { signal, timeoutMs = 20000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const url = await template(sig);
  const r = chooseWaterZoom(bounds);
  if (!r) return [];
  const jobs = [];
  for (let ty = r.y0; ty <= r.y1; ty++) for (let tx = r.x0; tx <= r.x1; tx++) jobs.push([tx, ty]);
  const polys = [];
  await Promise.all(jobs.map(async ([tx, ty]) => {
    const res = await fetch(url.replace('{z}', r.z).replace('{x}', tx).replace('{y}', ty), { signal: sig });
    if (res.status === 204 || res.status === 404) return;
    if (!res.ok) throw new Error(`map data ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    for (const f of decodePolygons(buf, 'water')) {
      polys.push({ rings: f.rings.map(ring => ring.map(p => tileToLatLon(r.z, tx, ty, f.extent, p))) });
    }
  }));
  return polys;
}

/**
 * Rasterise polygons (projected to metres: { rings: [[[x,y],...], ...] }, even-odd within each
 * polygon) onto a grid covering [minX,maxX]x[minY,maxY]; returns (x, y) => boolean.
 */
export function makeWaterTest(polys, minX, minY, maxX, maxY, cell) {
  if (!polys.length) return null;
  const W = Math.max(1, Math.ceil((maxX - minX) / cell)), H = Math.max(1, Math.ceil((maxY - minY) / cell));
  const mask = new Uint8Array(W * H);
  const xs = [];
  for (const poly of polys) {
    let pminY = Infinity, pmaxY = -Infinity;
    for (const ring of poly.rings) for (const [, y] of ring) { if (y < pminY) pminY = y; if (y > pmaxY) pmaxY = y; }
    const r0 = Math.max(0, Math.floor((pminY - minY) / cell)), r1 = Math.min(H - 1, Math.ceil((pmaxY - minY) / cell));
    for (let r = r0; r <= r1; r++) {
      const y = minY + (r + 0.5) * cell;
      xs.length = 0;
      for (const ring of poly.rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i], [xj, yj] = ring[j];
          if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - minX) / cell - 0.5)), c1 = Math.min(W - 1, Math.floor((xs[k + 1] - minX) / cell - 0.5));
        for (let c = c0; c <= c1; c++) mask[r * W + c] = 1;
      }
    }
  }
  return (x, y) => {
    const c = Math.floor((x - minX) / cell), r = Math.floor((y - minY) / cell);
    return c >= 0 && r >= 0 && c < W && r < H && mask[r * W + c] === 1;
  };
}
