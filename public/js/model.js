// Builds the printable parts (land, water, route, details) from terrain + route.
// Pure: all outside data arrives as plain functions/arrays, so this runs in Node tests.

import earcut from '../vendor/earcut.js';
import { Mesh } from './mesh.js';
import { shapeCorners, shapeNorm, shapeApothem } from './geo.js';

export const NOZZLES = {
  0.4: { spacing: 0.5, routeWidth: 1.2, routeHeight: 1.2, embed: 0.8, marker: 3.2, markerExtra: 0.8, textDepth: 0.6, waterDepth: 0.6, minFont: 5.5 },
  0.2: { spacing: 0.3, routeWidth: 0.7, routeHeight: 0.8, embed: 0.6, marker: 2.0, markerExtra: 0.6, textDepth: 0.4, waterDepth: 0.4, minFont: 3.5 },
};

export const COLOUR_MODES = {
  full: { label: 'Full colour', slots: { land: 1, water: 2, route: 3, details: 4 } },
  two: { label: 'Two colours', slots: { land: 1, water: null, route: 2, details: 2 } },
  one: { label: 'One colour', slots: { land: 1, water: null, route: 1, details: null } },
};

export const PART_COLOURS = {
  full: { land: '#3fae4a', water: '#2f8fdc', route: '#d8322a', details: '#f4f4f0' },
  two: { land: '#3fae4a', route: '#d8322a' },
  one: { land: '#c9c4b8', route: '#c9c4b8' },
};

const MAX_RINGS = 360;

/**
 * Regular lattice covering the shape: centre vertex + N rings, ring i has K*i vertices.
 * Returns { x, y, ringStart(i), tris: Uint32Array, N }. Coordinates in mm, centred on 0.
 */
export function buildLattice(shape, R, N) {
  const K = shape.K;
  const corners = shapeCorners(shape);
  const count = 1 + (K * N * (N + 1)) / 2;
  const x = new Float64Array(count), y = new Float64Array(count);
  const ringStart = i => (i === 0 ? 0 : 1 + (K * i * (i - 1)) / 2);
  const idx = (i, j) => (i === 0 ? 0 : ringStart(i) + (((j % (K * i)) + K * i) % (K * i)));
  const start = (shape.startDeg * Math.PI) / 180;
  for (let i = 1; i <= N; i++) {
    const r = (R * i) / N;
    for (let j = 0; j < K * i; j++) {
      const id = idx(i, j);
      if (shape.circle) {
        const a = start + (2 * Math.PI * j) / (K * i);
        x[id] = r * Math.cos(a); y[id] = r * Math.sin(a);
      } else {
        const s = Math.floor(j / i), t = j % i;
        const A = corners[s], B = corners[(s + 1) % K];
        x[id] = r * (A[0] + ((B[0] - A[0]) * t) / i);
        y[id] = r * (A[1] + ((B[1] - A[1]) * t) / i);
      }
    }
  }
  const tris = new Uint32Array(3 * K * N * N);
  let n = 0;
  const push = (a, b, c) => {
    // Keep every triangle counter-clockwise seen from above.
    const cross = (x[b] - x[a]) * (y[c] - y[a]) - (y[b] - y[a]) * (x[c] - x[a]);
    if (cross >= 0) { tris[n++] = a; tris[n++] = b; tris[n++] = c; }
    else { tris[n++] = a; tris[n++] = c; tris[n++] = b; }
  };
  for (let i = 1; i <= N; i++) {
    for (let s = 0; s < K; s++) {
      for (let t = 0; t < i; t++) {
        const o0 = idx(i, s * i + t), o1 = idx(i, s * i + t + 1), in0 = idx(i - 1, s * (i - 1) + t);
        push(o0, o1, in0);
        if (t < i - 1) push(in0, o1, idx(i - 1, s * (i - 1) + t + 1));
      }
    }
  }
  /**
   * Which lattice triangle holds (px, py), as three vertex ids and barycentric weights.
   * Points just outside the shape are clamped onto its edge.
   */
  const locate = (px, py) => {
    if (shape.circle) {
      // Rings are evenly spaced circles; interpolate around each ring, then between rings.
      let rf = (Math.hypot(px, py) / R) * N;
      rf = Math.min(N, Math.max(0, rf));
      const i0 = Math.min(N - 1, Math.floor(rf)), fr = rf - i0;
      const ang = ((Math.atan2(py, px) - start) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      const around = i => {
        if (i === 0) return [[0, 1]];
        const jf = (ang / (2 * Math.PI)) * K * i, j0 = Math.floor(jf), f = jf - j0;
        return [[idx(i, j0), 1 - f], [idx(i, j0 + 1), f]];
      };
      return [...around(i0).map(([id, w]) => [id, w * (1 - fr)]), ...around(i0 + 1).map(([id, w]) => [id, w * fr])];
    }
    for (let s = 0; s < K; s++) {
      const A = corners[s], B = corners[(s + 1) % K];
      const det = A[0] * B[1] - A[1] * B[0];
      let u = (px * B[1] - py * B[0]) / det / R, v = (A[0] * py - A[1] * px) / det / R;
      if (u < -1e-9 || v < -1e-9) continue;
      if (u + v > 1) { const k = 1 / (u + v); u *= k; v *= k; }
      const a = u * N, b = v * N;
      let fa = Math.floor(a), fb = Math.floor(b);
      if (fa + fb > N - 1) { if (fa > 0) fa--; else fb--; }
      fa = Math.max(0, fa); fb = Math.max(0, fb);
      const fx = a - fa, fy = b - fb;
      const id = (aa, bb) => { const i = aa + bb; return i === 0 ? 0 : idx(i, s * i + bb); };
      if (fx + fy <= 1 || fa + fb + 2 > N) return [[id(fa, fb), 1 - fx - fy], [id(fa + 1, fb), fx], [id(fa, fb + 1), fy]];
      return [[id(fa + 1, fb + 1), fx + fy - 1], [id(fa, fb + 1), 1 - fx], [id(fa + 1, fb), 1 - fy]];
    }
    return [[0, 1]];
  };
  return { x, y, tris, N, count, ringStart, idx, K, locate };
}

function percentile(values, p) {
  const s = Float64Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

/** Douglas-Peucker simplification of [[x,y],...] with tolerance tol. */
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let worst = -1, wd = 0;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d;
      if (L2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
        d = Math.hypot(px - ax - u * dx, py - ay - u * dy);
      }
      if (d > wd) { wd = d; worst = i; }
    }
    if (wd > tol && worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Closed prism around a convex ring of [x,y] (CCW or CW), from z = bot(x,y) to z = top. */
function addCylinder(mesh, cx, cy, radius, sides, bot, top) {
  const b = [], t = [];
  for (let k = 0; k < sides; k++) {
    const a = (2 * Math.PI * k) / sides;
    const x = cx + radius * Math.cos(a), y = cy + radius * Math.sin(a);
    b.push(mesh.add(x, y, bot));
    t.push(mesh.add(x, y, top));
  }
  const rz = (bot + top) / 2;
  for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides;
    mesh.triAway(b[k], b[k2], t[k2], cx, cy, rz);
    mesh.triAway(b[k], t[k2], t[k], cx, cy, rz);
    if (k > 0 && k2 > 0) {
      mesh.triFacing(b[0], b[k], b[k2], 0, 0, -1);
      mesh.triFacing(t[0], t[k], t[k2], 0, 0, 1);
    }
  }
}

/**
 * Text contours arrive as glyphs: [{ outer: [[x,y],...], holes: [[[x,y],...], ...] }] in mm,
 * already positioned on the underside (and mirrored so they read correctly from below).
 */
function signedArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}
const ccw = r => (signedArea(r) >= 0 ? r : r.slice().reverse());
const cw = r => (signedArea(r) < 0 ? r : r.slice().reverse());

/**
 * Triangulate a polygon given as rings of [x,y] (first = outer, rest = holes).
 * Returns counter-clockwise triangles as indices into the rings' points taken in order,
 * or null if the result does not exactly cover the polygon (earcut can fold or skip
 * triangles on awkward outlines; such a cap would leave the mesh open).
 */
export function triangulate(rings) {
  const flat = [], holes = [];
  rings.forEach((r, i) => { if (i) holes.push(flat.length / 2); for (const [x, y] of r) flat.push(x, y); });
  const tri = earcut(flat, holes.length ? holes : null);
  let sum = 0, abs = 0;
  for (let i = 0; i < tri.length; i += 3) {
    const a = 2 * tri[i], b = 2 * tri[i + 1], c = 2 * tri[i + 2];
    const ar = ((flat[b] - flat[a]) * (flat[c + 1] - flat[a + 1]) - (flat[b + 1] - flat[a + 1]) * (flat[c] - flat[a])) / 2;
    sum += ar; abs += Math.abs(ar);
  }
  const expected = Math.abs(signedArea(rings[0])) - rings.slice(1).reduce((t, r) => t + Math.abs(signedArea(r)), 0);
  if (!(expected > 0) || !tri.length) return null;
  if (Math.abs(abs - expected) > 1e-4 * expected + 1e-4) return null;       // gaps or overlaps
  if (Math.abs(Math.abs(sum) - abs) > 1e-6 * abs + 1e-6) return null;      // mixed orientation
  // Edges: the triangles' outline must be exactly the rings' edges. (A ring edge lying along
  // another ring's edge gives a "T-junction": right area, but a mesh that is not closed.)
  const nPts = flat.length / 2;
  const count = new Map();
  const ek = (a, b) => (a < b ? a * nPts + b : b * nPts + a);
  for (let i = 0; i < tri.length; i += 3) {
    for (let k = 0; k < 3; k++) { const e = ek(tri[i + k], tri[i + (k + 1) % 3]); count.set(e, (count.get(e) || 0) + 1); }
  }
  let ringEdges = 0, start = 0;
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      ringEdges++;
      if (count.get(ek(start + i, start + (i + 1) % r.length)) !== 1) return null;
    }
    start += r.length;
  }
  let outline = 0;
  for (const c of count.values()) { if (c === 1) outline++; else if (c !== 2) return null; }
  if (outline !== ringEdges) return null;
  if (sum < 0) for (let i = 0; i < tri.length; i += 3) { const t = tri[i + 1]; tri[i + 1] = tri[i + 2]; tri[i + 2] = t; }
  return tri;
}

/** Shrink a hole ring slightly towards its centre (to part it from an edge it lies along). */
function nudgeHole(ring, by = 0.02) {
  let cx = 0, cy = 0;
  for (const [x, y] of ring) { cx += x; cy += y; }
  cx /= ring.length; cy /= ring.length;
  return ring.map(([x, y]) => {
    const d = Math.hypot(x - cx, y - cy) || 1;
    return [x - ((x - cx) / d) * by, y - ((y - cy) / d) * by];
  });
}

/** Add triangles from triangulate() using vertex ids, facing up (+z) or down. */
function capIds(mesh, ids, tri, up) {
  for (let i = 0; i < tri.length; i += 3) {
    if (up) mesh.tri(ids[tri[i]], ids[tri[i + 1]], ids[tri[i + 2]]);
    else mesh.tri(ids[tri[i]], ids[tri[i + 2]], ids[tri[i + 1]]);
  }
}

/** Vertical wall along a closed ring between two id lists, facing `side` (+1 = right of travel, -1 = left). */
function wallRing(mesh, botIds, topIds, side) {
  const n = botIds.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = mesh.v[3 * botIds[i]], ay = mesh.v[3 * botIds[i] + 1];
    const bx = mesh.v[3 * botIds[j]], by = mesh.v[3 * botIds[j] + 1];
    const nx = (by - ay) * side, ny = -(bx - ax) * side; // right normal when side = +1
    mesh.triFacing(botIds[i], botIds[j], topIds[j], nx, ny, 0);
    mesh.triFacing(botIds[i], topIds[j], topIds[i], nx, ny, 0);
  }
}

/**
 * Build all printable parts.
 * @param o.shape        entry from SHAPES
 * @param o.sizeMm       longest dimension in mm
 * @param o.nozzle       0.4 or 0.2
 * @param o.colourMode   'full' | 'two' | 'one'
 * @param o.exaggeration number, or null for automatic
 * @param o.baseMm       thickness under the lowest point
 * @param o.lowM         optional: height (m) that sits at baseMm, instead of the lowest point
 *                       (pieces built separately then line up); no ground may lie below it
 * @param o.routeFlatEnds optional { start, end }: square route end (no round cap), for a
 *                       route cut at the tile edge so it meets the next piece flush
 * @param o.fit          { cx, cy, radius } in projected metres
 * @param o.elevation    (xm, ym) => metres above sea level (projected metres in)
 * @param o.isWater      (xm, ym) => boolean (lakes from the map), optional
 * @param o.route        [[xm, ym], ...] projected metres
 * @param o.markers      [[xm, ym], ...] projected metres
 * @param o.glyphs       text glyphs in mm (see above), optional
 * @param o.progress     optional (fraction, label) => void
 */
export function buildModel(o) {
  const noz = NOZZLES[o.nozzle] || NOZZLES[0.4];
  const mode = COLOUR_MODES[o.colourMode] || COLOUR_MODES.full;
  const shape = o.shape;
  const R = shape.sizeToR(o.sizeMm);
  const s = R / o.fit.radius; // mm per metre
  // o.spacing (mm) overrides the nozzle's mesh spacing: used for the light start-screen preview.
  const N = Math.min(MAX_RINGS, Math.max(20, Math.ceil(R / (o.spacing || noz.spacing))));
  const L = buildLattice(shape, R, N);
  const toM = (x, y) => [x / s + o.fit.cx, y / s + o.fit.cy];
  const progress = o.progress || (() => {});
  const warnings = [];

  // 1. Sample terrain and water at every lattice vertex.
  progress(0.1, 'Sampling terrain');
  const elev = new Float64Array(L.count);
  const water = new Uint8Array(L.count);
  for (let i = 0; i < L.count; i++) {
    const [xm, ym] = toM(L.x[i], L.y[i]);
    let e = o.elevation(xm, ym);
    if (!Number.isFinite(e)) e = 0;
    // With map water (which includes the sea) use it; without, treat height <= 0 as sea.
    if (o.isWater ? o.isWater(xm, ym) : e <= 0) water[i] = 1;
    elev[i] = e;
  }

  // 2. Group touching water vertices into lakes/sea, drop specks, flatten each to one level.
  progress(0.25, 'Finding lakes');
  const parent = new Int32Array(L.count).map((_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const tris = L.tris;
  for (let t = 0; t < tris.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = tris[t + k], b = tris[t + (k + 1) % 3];
      if (water[a] && water[b]) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    }
  }
  const groups = new Map();
  for (let i = 0; i < L.count; i++) if (water[i]) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const minWaterVerts = Math.ceil(6 / (noz.spacing * noz.spacing)); // ~6 mm² on the print
  for (const ids of groups.values()) {
    if (ids.length < minWaterVerts) { for (const i of ids) water[i] = 0; continue; }
    const level = Math.max(0, percentile(ids.map(i => elev[i]), 0.2)); // sea surface, not sea bed
    for (const i of ids) elev[i] = level;
  }

  // 3. Vertical scale.
  let eMin = Infinity, eMax = -Infinity;
  for (let i = 0; i < L.count; i++) { if (elev[i] < eMin) eMin = elev[i]; if (elev[i] > eMax) eMax = elev[i]; }
  if (Number.isFinite(o.lowM)) {
    if (eMin < o.lowM) throw new Error(`Ground at ${eMin.toFixed(1)} m is below lowM (${o.lowM} m)`);
    eMin = o.lowM;
  }
  const realRelief = (eMax - eMin) * s;
  let exaggeration = o.exaggeration;
  if (!(exaggeration > 0)) {
    const target = 0.1 * o.sizeMm;
    exaggeration = realRelief > 0.01 ? Math.min(3, Math.max(1, target / realRelief)) : 1;
    exaggeration = Math.round(exaggeration * 10) / 10;
  }
  const zs = s * exaggeration;
  const base = Math.max(o.baseMm ?? 4, noz.textDepth + 2);
  const zOf = e => base + (e - eMin) * zs;
  const top = new Float64Array(L.count);
  for (let i = 0; i < L.count; i++) top[i] = zOf(elev[i]);
  // Height of the finished top surface (water at its flattened level) anywhere on the tile.
  const heightAt = (x, y) => {
    let h = 0;
    for (const [id, w] of L.locate(x, y)) h += w * top[id];
    return h;
  };

  const separateWater = mode.slots.water != null;
  const hasWater = water.some(Boolean);
  const landTop = Float64Array.from(top);
  if (separateWater && hasWater) for (let i = 0; i < L.count; i++) if (water[i]) landTop[i] = top[i] - noz.waterDepth;

  // 4. Land: terrain top, outer wall, bottom with text-shaped pockets.
  progress(0.4, 'Building land');
  const land = new Mesh('Land');
  for (let i = 0; i < L.count; i++) land.add(L.x[i], L.y[i], landTop[i]);
  for (let t = 0; t < tris.length; t += 3) land.tri(tris[t], tris[t + 1], tris[t + 2]);
  const ringN = [];
  for (let j = 0; j < L.K * N; j++) ringN.push(L.idx(N, j));
  let ringBot;
  if (shape.circle) {
    ringBot = ringN.map(i => land.add(L.x[i], L.y[i], 0));
    wallRing(land, ringBot, ringN, +1);
  } else {
    // Straight sides: the bottom edge of each wall is one segment between two corners
    // (collinear points would give the bottom face zero-width triangles).
    ringBot = [];
    for (let k = 0; k < L.K; k++) ringBot.push(land.add(L.x[ringN[k * N]], L.y[ringN[k * N]], 0));
    for (let k = 0; k < L.K; k++) {
      const A = ringBot[k], B = ringBot[(k + 1) % L.K];
      const T = []; for (let t = 0; t <= N; t++) T.push(ringN[(k * N + t) % ringN.length]);
      // Orientation is set by vertex order, not geometry: these fan triangles are thin
      // slivers whose computed normals are unreliable. The terrain uses edge T[t]->T[t+1]
      // and the bottom face uses B->A, so the wall uses the reverse of both.
      const mid = Math.floor(N / 2);
      for (let t = 0; t < N; t++) land.tri(t < mid ? A : B, T[t + 1], T[t]);
      land.tri(A, B, T[mid]);
    }
  }

  // Text: keep only letters that sit inside the tile (with a margin) and triangulate cleanly.
  const cosK = shapeApothem(shape);
  const textLimit = R - 2.5 / cosK;
  const glyphs = [];
  const textDropped = []; // { line, reason: 'edge' | 'shape' | 'all' }
  for (const g0 of o.glyphs || []) {
    let g = { outer: ccw(g0.outer), holes: g0.holes.map(cw) };
    const inside = [g.outer, ...g.holes].every(r => r.every(([x, y]) => shapeNorm(shape, x, y) <= textLimit));
    if (!inside) { textDropped.push({ line: g0.line, reason: 'edge' }); continue; }
    let tri = triangulate([g.outer, ...g.holes]);
    if (!tri && g.holes.length) {
      g = { outer: g.outer, holes: g.holes.map(h => nudgeHole(h)) };
      tri = triangulate([g.outer, ...g.holes]);
    }
    const holeTris = tri ? g.holes.map(h => triangulate([h])) : [];
    if (!tri || holeTris.some(t => !t)) { textDropped.push({ line: g0.line, reason: 'shape' }); continue; }
    glyphs.push({ ...g, line: g0.line, points: [g.outer, ...g.holes].flat(), tri, holeTris });
  }
  const depth = noz.textDepth;
  // Land bottom = shape outline minus every glyph outline.
  const ringBotXY = ringBot.map(id => [land.v[3 * id], land.v[3 * id + 1]]);
  let bottomTri = triangulate([ringBotXY, ...glyphs.map(g => g.outer)]);
  if (!bottomTri && glyphs.length) {
    textDropped.push({ line: null, reason: 'all' });
    glyphs.length = 0;
    bottomTri = triangulate([ringBotXY]);
  }
  const glyphIds = glyphs.map(g => ({
    bot: g.points.map(([x, y]) => land.add(x, y, 0)),
    top: g.points.map(([x, y]) => land.add(x, y, depth)),
  }));
  capIds(land, [...ringBot, ...glyphIds.flatMap((ids, gi) => ids.bot.slice(0, glyphs[gi].outer.length))], bottomTri, false);
  glyphs.forEach((g, gi) => {
    const { bot, top: topIds } = glyphIds[gi];
    // Ring id ranges inside this glyph's point list.
    let at = 0;
    const ranges = [g.outer, ...g.holes].map(r => { const range = [at, at + r.length]; at += r.length; return range; });
    // Counters (the inside of an "o") stay land at the very bottom.
    g.holes.forEach((h, hi) => capIds(land, bot.slice(...ranges[hi + 1]), g.holeTris[hi], false));
    // Pocket walls face into the pocket (glyph material lies to the left of each ring).
    ranges.forEach(rg => wallRing(land, bot.slice(...rg), topIds.slice(...rg), -1));
    capIds(land, topIds, g.tri, false); // pocket ceiling, facing down into the pocket
  });

  const parts = [{ key: 'land', name: 'Land', slot: mode.slots.land, mesh: land }];

  // 5. Water: thin slab sitting in the dip left in the land.
  if (separateWater && hasWater) {
    progress(0.55, 'Building water');
    const wm = new Mesh('Water');
    // Wet triangles (all three corners water).
    const wet = [];
    for (let t = 0; t < tris.length; t += 3) if (water[tris[t]] && water[tris[t + 1]] && water[tris[t + 2]]) wet.push(t);
    // Each corner of each wet triangle is a "slot". Slots of the same lattice vertex are merged
    // only across shared edges, so two regions touching at a single point get separate
    // vertices there (otherwise their walls would share one edge four times).
    const slotParent = new Int32Array(wet.length * 3).map((_, i) => i);
    const findSlot = a => { while (slotParent[a] !== a) { slotParent[a] = slotParent[slotParent[a]]; a = slotParent[a]; } return a; };
    const edgeSlot = new Map();
    const key = (a, b) => a * L.count + b;
    wet.forEach((t, w) => { for (let k = 0; k < 3; k++) edgeSlot.set(key(tris[t + k], tris[t + (k + 1) % 3]), w * 3 + k); });
    for (const [kk, sa] of edgeSlot) {
      const a = Math.floor(kk / L.count), b = kk - a * L.count;
      const other = edgeSlot.get(key(b, a));
      if (other === undefined || other < sa) continue;
      const sb = sa - (sa % 3) + ((sa % 3) + 1) % 3;           // slot of b in the first triangle
      const ob = other, oa = other - (other % 3) + ((other % 3) + 1) % 3; // b then a in the second
      const unite = (p, q) => { const rp = findSlot(p), rq = findSlot(q); if (rp !== rq) slotParent[rp] = rq; };
      unite(sa, oa); unite(sb, ob);
    }
    const topOf = new Map(), botOf = new Map();
    const ids = slot => {
      const r = findSlot(slot);
      if (!topOf.has(r)) {
        const v = tris[wet[Math.floor(slot / 3)] + (slot % 3)];
        topOf.set(r, wm.add(L.x[v], L.y[v], top[v]));
        botOf.set(r, wm.add(L.x[v], L.y[v], landTop[v]));
      }
      return [topOf.get(r), botOf.get(r)];
    };
    wet.forEach((t, w) => {
      const [ta, ba] = ids(w * 3), [tb, bb] = ids(w * 3 + 1), [tc, bc] = ids(w * 3 + 2);
      wm.tri(ta, tb, tc);
      wm.tri(ba, bc, bb);
    });
    for (const [kk, sa] of edgeSlot) {
      const a = Math.floor(kk / L.count), b = kk - a * L.count;
      if (edgeSlot.has(key(b, a))) continue; // interior edge
      // Boundary edge a->b: the top uses topA->topB and the bottom botB->botA, so the wall
      // uses the reverse of each (order-based, so no reliance on computed normals).
      const sb = sa - (sa % 3) + ((sa % 3) + 1) % 3;
      const [tA, bA] = ids(sa), [tB, bB] = ids(sb);
      wm.tri(bA, bB, tB);
      wm.tri(bA, tB, tA);
    }
    if (wm.triangleCount) parts.push({ key: 'water', name: 'Water', slot: mode.slots.water, mesh: wm });
  }

  // 6. Route: raised strip that follows the ground, built from overlapping closed pieces.
  progress(0.7, 'Building route');
  const route = new Mesh('Route');
  const w = noz.routeWidth, half = w / 2;
  const routeMm = simplify(o.route.map(([xm, ym]) => [(xm - o.fit.cx) * s, (ym - o.fit.cy) * s]), (o.spacing || noz.spacing) * 0.3);
  const step = o.spacing || noz.spacing;
  // Heights depend on position only (not direction), so neighbouring pieces and the
  // round joints meet flush instead of stepping.
  const ringH = (cx, cy, r) => {
    let lo = Infinity, hi = -Infinity;
    for (const [ox, oy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]]) {
      const h = heightAt(cx + ox, cy + oy); lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    return [lo, hi];
  };
  const strip = (cx, cy) => {
    const [lo, hi] = ringH(cx, cy, half);
    return [lo - noz.embed, hi + noz.routeHeight];
  };
  for (let p = 0; p + 1 < routeMm.length; p++) {
    const [ax, ay] = routeMm[p], [bx, by] = routeMm[p + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    const dx = (bx - ax) / len, dy = (by - ay) / len, nx = -dy, ny = dx;
    const m = Math.max(1, Math.ceil(len / step));
    let prev = null;
    for (let k = 0; k <= m; k++) {
      const cx = ax + (dx * len * k) / m, cy = ay + (dy * len * k) / m;
      const [zb, zt] = strip(cx, cy);
      const lx = cx + nx * half, ly = cy + ny * half, rx = cx - nx * half, ry = cy - ny * half;
      const sec = [route.add(lx, ly, zb), route.add(rx, ry, zb), route.add(rx, ry, zt), route.add(lx, ly, zt)];
      sec.c = [cx, cy, (zb + zt) / 2];
      if (prev) {
        const r = [(prev.c[0] + cx) / 2, (prev.c[1] + cy) / 2, (prev.c[2] + sec.c[2]) / 2];
        for (let e = 0; e < 4; e++) {
          const e2 = (e + 1) % 4;
          route.triAway(prev[e], prev[e2], sec[e2], ...r);
          route.triAway(prev[e], sec[e2], sec[e], ...r);
        }
      } else {
        route.triAway(sec[0], sec[1], sec[2], cx + dx, cy + dy, sec.c[2]);
        route.triAway(sec[0], sec[2], sec[3], cx + dx, cy + dy, sec.c[2]);
      }
      prev = sec;
    }
    route.triAway(prev[0], prev[1], prev[2], prev.c[0] - dx, prev.c[1] - dy, prev.c[2]);
    route.triAway(prev[0], prev[2], prev[3], prev.c[0] - dx, prev.c[1] - dy, prev.c[2]);
  }
  // Round joints so corners have no notches.
  const flatEnds = o.routeFlatEnds || {};
  for (const [i, [x, y]] of routeMm.entries()) {
    if ((i === 0 && flatEnds.start) || (i === routeMm.length - 1 && flatEnds.end)) continue;
    const [zb, zt] = strip(x, y);
    addCylinder(route, x, y, half, 16, zb, zt);
  }
  parts.push({ key: 'route', name: 'Route', slot: mode.slots.route, mesh: route });

  // 7. Details: start/finish markers and the text that fills the pockets underneath.
  progress(0.85, 'Building markers and text');
  const details = new Mesh('Details');
  const markerR = noz.marker / 2;
  const markerPts = [];
  for (const [xm, ym] of o.markers || []) {
    const x = (xm - o.fit.cx) * s, y = (ym - o.fit.cy) * s;
    if (markerPts.some(([px, py]) => Math.hypot(px - x, py - y) < noz.marker * 1.5)) continue;
    if (shapeNorm(shape, x, y) > R - (markerR + 0.5) / cosK) continue;
    markerPts.push([x, y]);
    const [lo, hi] = ringH(x, y, markerR);
    addCylinder(details, x, y, markerR, 24, lo - noz.embed, hi + noz.routeHeight + noz.markerExtra);
  }
  const textMesh = new Mesh('Text');
  if (mode.slots.details != null) {
    for (const g of glyphs) {
      const bot = g.points.map(([x, y]) => textMesh.add(x, y, 0));
      const topIds = g.points.map(([x, y]) => textMesh.add(x, y, depth));
      capIds(textMesh, bot, g.tri, false);
      capIds(textMesh, topIds, g.tri, true);
      let at = 0;
      for (const r of [g.outer, ...g.holes]) {
        wallRing(textMesh, bot.slice(at, at + r.length), topIds.slice(at, at + r.length), +1);
        at += r.length;
      }
    }
  }
  if (mode.slots.details == null) {
    // One colour: markers join the route; text stays as engraved pockets in the land.
    route.append(details);
  } else if (mode.slots.details === mode.slots.route) {
    route.append(details).append(textMesh);
    route.name = 'Route & text';
    parts[parts.length - 1].name = 'Route & text';
  } else {
    details.append(textMesh);
    if (details.triangleCount) parts.push({ key: 'details', name: 'Markers & text', slot: mode.slots.details, mesh: details });
  }

  // Number the filament slots 1, 2, 3... in use order (e.g. no water -> no empty slot).
  const used = [...new Set(parts.map(p => p.slot))].sort((a, b) => a - b);
  for (const p of parts) {
    p.slot = used.indexOf(p.slot) + 1;
    p.colour = (PART_COLOURS[o.colourMode] || PART_COLOURS.full)[p.key] || '#c0c0c0';
  }

  let zMax = 0;
  for (const p of parts) zMax = Math.max(zMax, p.mesh.bounds().max[2]);
  return {
    parts,
    info: {
      sizeMm: o.sizeMm, heightMm: zMax, exaggeration, mmPerKm: s * 1000,
      reliefM: eMax - eMin, lowM: eMin, highM: eMax, rings: N, base,
      hasWater, waterSeparate: separateWater && hasWater, textDropped,
    },
    warnings,
  };
}
