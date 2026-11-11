// Map projection and tile shapes.

const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;

/** Local flat projection around (lat0, lon0) in metres. Fine for areas up to ~100 km. */
export function makeProjection(lat0, lon0) {
  const c = Math.cos(lat0 * DEG);
  return {
    lat0, lon0,
    fwd: (lat, lon) => [(lon - lon0) * DEG * R_EARTH * c, (lat - lat0) * DEG * R_EARTH],
    inv: (x, y) => [lat0 + y / (DEG * R_EARTH), lon0 + x / (DEG * R_EARTH * c)],
  };
}

/**
 * Shapes are regular polygons described by their corners on the unit circle (CCW),
 * or a circle (smooth). `size` is the longest dimension in mm:
 * hexagon corner-to-corner, circle diameter, square side.
 */
export const SHAPES = {
  hexagon: { label: 'Hexagon', K: 6, startDeg: 30, circle: false, sizeToR: s => s / 2 },
  circle: { label: 'Circle', K: 6, startDeg: 0, circle: true, sizeToR: s => s / 2 },
  square: { label: 'Square', K: 4, startDeg: 45, circle: false, sizeToR: s => s / Math.SQRT2 },
};

export function shapeCorners(shape) {
  const out = [];
  for (let k = 0; k < shape.K; k++) {
    const a = (shape.startDeg + (360 * k) / shape.K) * DEG;
    out.push([Math.cos(a), Math.sin(a)]);
  }
  return out;
}

/** How far out a point is, as the circumradius of the smallest shape (centred at 0) containing it. */
export function shapeNorm(shape, x, y) {
  if (shape.circle) return Math.hypot(x, y);
  const apothem = Math.cos(Math.PI / shape.K);
  let m = 0;
  for (let k = 0; k < shape.K; k++) {
    const a = (shape.startDeg + (360 * (k + 0.5)) / shape.K) * DEG; // edge normal
    m = Math.max(m, (x * Math.cos(a) + y * Math.sin(a)) / apothem);
  }
  return m;
}

/**
 * Fit the shape around projected points. Returns centre (metres) and circumradius (metres).
 * `margin` >= 1 is how much land to show around the route.
 */
export function fitShape(shape, pts, margin) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const normAt = (cx, cy) => pts.reduce((m, [x, y]) => Math.max(m, shapeNorm(shape, x - cx, y - cy)), 0);
  // Small coordinate search to tighten the fit (bounding-box centre is not optimal for hexagons).
  let best = normAt(cx, cy);
  let step = best / 4;
  for (let iter = 0; iter < 40 && step > best * 1e-3; iter++) {
    let improved = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = normAt(cx + dx * step, cy + dy * step);
      if (n < best) { best = n; cx += dx * step; cy += dy * step; improved = true; break; }
    }
    if (!improved) step /= 2;
  }
  const radius = Math.max(best, 50) * margin;
  return { cx, cy, radius };
}
