// Builds the light model of the example route that spins on the start screen
// (public/demo/intro.bin). Run after changing the model code or the example:
//   node tools/make-intro-model.mjs
// Same pipeline as the site (terrain + water tiles, model.js), at coarser detail.
//
// intro.bin layout (little-endian):
//   'TPI1', uint32 partCount, then per part:
//   uint8 r, g, b, 0 | float32 scale | uint32 vertexCount | uint32 triangleCount |
//   int16 x,y,z per vertex (times scale = mm) | padding to 4 bytes | uint16 indices (3 per triangle)
//   | padding to 4 bytes

import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { parseGpx } from '../public/js/gpx.js';
import { SHAPES, fitShape, makeProjection } from '../public/js/geo.js';
import { buildModel, NOZZLES } from '../public/js/model.js';
import { chooseZoom, tileRange, makeSampler, smooth, TILE_URL } from '../public/js/dem.js';
import { fetchWater, makeWaterTest } from '../public/js/water.js';

const SIZE = 150, SPACING = 1.6, SHAPE = SHAPES.hexagon;
const gpx = parseGpx(readFileSync(new URL('../public/demo/wharfedale-three-peaks.gpx', import.meta.url), 'utf8'));
const track = gpx.track.map(p => [p.lat, p.lon]);
const lats = track.map(p => p[0]), lons = track.map(p => p[1]);
const origin = [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lons) + Math.max(...lons)) / 2];
const proj = makeProjection(...origin);
const route = track.map(([la, lo]) => proj.fwd(la, lo));
const fit = fitShape(SHAPE, route, 1.15);
const R = SHAPE.sizeToR(SIZE);
const pad = fit.radius * 1.06;
const sw = proj.inv(fit.cx - pad, fit.cy - pad), ne = proj.inv(fit.cx + pad, fit.cy + pad);
const bounds = { south: sw[0], west: sw[1], north: ne[0], east: ne[1] };

// Terrain tiles, decoded with pngjs (the browser uses a canvas).
const mPerPx = SPACING * fit.radius / R;
const z = chooseZoom(bounds, mPerPx);
const r = tileRange(bounds, z);
const width = (r.x1 - r.x0 + 1) * 256, height = (r.y1 - r.y0 + 1) * 256;
const grid = new Float32Array(width * height);
for (let ty = r.y0; ty <= r.y1; ty++) for (let tx = r.x0; tx <= r.x1; tx++) {
  const res = await fetch(TILE_URL.replace('{z}', z).replace('{x}', tx).replace('{y}', ty));
  if (!res.ok) throw new Error(`terrain tile ${res.status}`);
  const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
  const ox = (tx - r.x0) * 256, oy = (ty - r.y0) * 256;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = (y * 256 + x) * 4;
    grid[(oy + y) * width + ox + x] = png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
  }
}
const sample = makeSampler({ z, x0: r.x0, y0: r.y0, width, height }, smooth(grid, width, height));
const elevation = (x, y) => { const [la, lo] = proj.inv(x, y); return sample(la, lo); };

const water = await fetchWater(bounds, { timeoutMs: 60000 });
const waterPolys = water.map(p => ({ rings: p.rings.map(ring => ring.map(([la, lo]) => proj.fwd(la, lo))) }));
const isWater = makeWaterTest(waterPolys, fit.cx - fit.radius, fit.cy - fit.radius, fit.cx + fit.radius, fit.cy + fit.radius, (SPACING / 2) * (fit.radius / R));


const model = buildModel({
  shape: SHAPE, sizeMm: SIZE, nozzle: 0.4, colourMode: 'full', exaggeration: null, baseMm: 4,
  fit, elevation, isWater, route, markers: [route[0], route[route.length - 1]], glyphs: [], spacing: SPACING, // the spinning top view never shows the back
});

// Serialise.
const chunks = [];
const head = Buffer.alloc(8); head.write('TPI1', 0, 'latin1'); head.writeUInt32LE(model.parts.length, 4); chunks.push(head);
let total = 0;
for (const p of model.parts) {
  const v = p.mesh.v, tri = p.mesh.t, nv = v.length / 3, nt = tri.length / 3;
  if (nv > 65535) throw new Error(`${p.name}: too many vertices (${nv}) for 16-bit indices`);
  let maxAbs = 0; for (const x of v) maxAbs = Math.max(maxAbs, Math.abs(x));
  const scale = maxAbs / 32767;
  const ph = Buffer.alloc(16);
  const c = parseInt(p.colour.slice(1), 16);
  ph.writeUInt8((c >> 16) & 255, 0); ph.writeUInt8((c >> 8) & 255, 1); ph.writeUInt8(c & 255, 2);
  ph.writeFloatLE(scale, 4); ph.writeUInt32LE(nv, 8); ph.writeUInt32LE(nt, 12);
  const pos = Buffer.alloc(nv * 6 + ((nv * 6) % 4 ? 2 : 0));
  for (let i = 0; i < v.length; i++) pos.writeInt16LE(Math.round(v[i] / scale), i * 2);
  const idx = Buffer.alloc(nt * 6 + ((nt * 6) % 4 ? 2 : 0));
  for (let i = 0; i < tri.length; i++) idx.writeUInt16LE(tri[i], i * 2);
  chunks.push(ph, pos, idx);
  total += nt;
  console.log(p.name, nv, 'vertices', nt, 'triangles');
}
const out = Buffer.concat(chunks);
writeFileSync(new URL('../public/demo/intro.bin', import.meta.url), out);
console.log('public/demo/intro.bin', (out.length / 1024).toFixed(0), 'KB,', total, 'triangles; exaggeration', model.info.exaggeration);
