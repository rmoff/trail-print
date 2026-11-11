// Printer build plates: does the tile fit, and is there room for a purge tower?

import { SHAPES, shapeNorm } from './geo.js';

// Usable plate width x depth in mm (makers' published build volumes). `tower` is where the
// slicer puts the purge tower by default, as fractions of the plate (Bambu Studio's
// default_wipe_tower_pos for that printer); others are assumed to use the back-left corner.
export const PRINTERS = [
  { id: 'a1mini', name: 'Bambu Lab A1 mini', w: 180, d: 180, tower: [0, 1] },
  { id: 'a1', name: 'Bambu Lab A1', w: 256, d: 256, tower: [0, 1] },
  { id: 'p1s', name: 'Bambu Lab P1S / P1P', w: 256, d: 256, tower: [0.644, 0.977] },
  { id: 'x1c', name: 'Bambu Lab X1 Carbon', w: 256, d: 256, tower: [0.644, 0.977] },
  { id: 'h2d', name: 'Bambu Lab H2D', w: 325, d: 320, tower: [0.644, 0.977] },
  { id: 'mk4s', name: 'Prusa MK4S', w: 250, d: 210 },
  { id: 'coreone', name: 'Prusa CORE One', w: 250, d: 220 },
  { id: 'mini', name: 'Prusa MINI+', w: 180, d: 180 },
  { id: 'ender3v3se', name: 'Creality Ender-3 V3 SE', w: 220, d: 220 },
  { id: 'k1c', name: 'Creality K1C', w: 220, d: 220 },
];

// A purge tower is about 35 mm square plus its brim; keep 40 mm clear.
export const TOWER = 40;
// Keep the tile this far from the plate's edges (skirt, brim, nozzle wipe areas).
export const EDGE = 5;
// Clearance between the tile and the purge tower: the slicer adds a brim round the tile and
// checks for collisions with a safety margin (Bambu Studio refused a 1 mm gap, 11 Nov 2026).
export const GAP = 8;

/** Width (x) and depth (y) of the tile on the plate. */
export function footprint(shapeKey, sizeMm) {
  const shape = SHAPES[shapeKey];
  const R = shape.sizeToR(sizeMm);
  if (shape.circle) return { w: 2 * R, d: 2 * R };
  if (shape.K === 6) return { w: 2 * R * Math.cos(Math.PI / 6), d: 2 * R };
  return { w: sizeMm, d: sizeMm };
}

/** Does the tile fit on the plate: 'yes', 'turned' (only a quarter turn), or 'no'. */
export function fits(shapeKey, sizeMm, plate) {
  const f = footprint(shapeKey, sizeMm);
  const w = plate.w - 2 * EDGE, d = plate.d - 2 * EDGE;
  if (f.w <= w && f.d <= d) return 'yes';
  if (f.d <= w && f.w <= d) return 'turned';
  return 'no';
}

/** Is a tower square (corner at x0,y0, plate coordinates) clear of a tile centred at (cx, cy)? */
function towerClear(shape, R, cx, cy, x0, y0) {
  const n = 8;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    const x = x0 + (TOWER * i) / n - cx, y = y0 + (TOWER * j) / n - cy;
    // shapeNorm measures in circumradius units; a straight side GAP mm away is GAP/cos(π/K) further.
    if (shapeNorm(shape, x, y) <= R + GAP / (shape.circle ? 1 : Math.cos(Math.PI / shape.K))) return false;
  }
  return true;
}

/** Where the slicer puts the purge tower by default (corner of the tower square, plate coords). */
function defaultTower(plate) {
  const [nx, ny] = plate.tower || [0, 1];
  return [Math.min(plate.w - TOWER, Math.max(0, nx * plate.w)), Math.min(plate.d - TOWER, Math.max(0, ny * plate.d))];
}

/**
 * Where do the tile and the purge tower go? Positions are centres relative to the plate centre.
 *  { room: 'centred', tile: {x:0,y:0}, tower }        tile in the middle; tower where the slicer puts it
 *  { room: 'corner', tile, tower }                     tile moved away from the slicer's tower spot
 *                                                      (the downloaded file already places it there)
 *  { room: 'drag', tile: {x:0,y:0}, tower }            tile in the middle; drag the tower to this corner
 *  { room: 'none' }
 */
export function towerRoom(shapeKey, sizeMm, plate) {
  const shape = SHAPES[shapeKey];
  const R = shape.sizeToR(sizeMm);
  const f = footprint(shapeKey, sizeMm);
  if (f.w > plate.w - 2 * EDGE || f.d > plate.d - 2 * EDGE) return { room: 'none' };
  const rel = (x0, y0) => ({ x: x0 + TOWER / 2 - plate.w / 2, y: y0 + TOWER / 2 - plate.d / 2 });
  const [tx, ty] = defaultTower(plate);
  // 1. Tile in the middle, tower where the slicer puts it.
  if (towerClear(shape, R, plate.w / 2, plate.d / 2, tx, ty)) return { room: 'centred', tile: { x: 0, y: 0 }, tower: rel(tx, ty) };
  // 2. Tile moved as far from the slicer's tower spot as the edges allow.
  const cx = tx + TOWER / 2 < plate.w / 2 ? plate.w - EDGE - f.w / 2 : EDGE + f.w / 2;
  const cy = ty + TOWER / 2 < plate.d / 2 ? plate.d - EDGE - f.d / 2 : EDGE + f.d / 2;
  if (towerClear(shape, R, cx, cy, tx, ty)) {
    return { room: 'corner', tile: { x: cx - plate.w / 2, y: cy - plate.d / 2 }, tower: rel(tx, ty) };
  }
  // 3. Tile in the middle, tower dragged to another free corner.
  for (const [x0, y0] of [[plate.w - TOWER, plate.d - TOWER], [0, plate.d - TOWER], [plate.w - TOWER, 0], [0, 0]]) {
    if (towerClear(shape, R, plate.w / 2, plate.d / 2, x0, y0)) return { room: 'drag', tile: { x: 0, y: 0 }, tower: rel(x0, y0) };
  }
  return { room: 'none' };
}

/** Where the tile sits on the plate (centre offset from the plate centre), for the preview and the file. */
export function tilePlacement(shapeKey, sizeMm, plate, colours) {
  if (!colours) return { x: 0, y: 0 };
  const r = towerRoom(shapeKey, sizeMm, plate);
  return r.tile || { x: 0, y: 0 };
}

/** Largest size (5 mm steps) that fits the plate, with room for a purge tower if `tower`. */
export function largestFit(shapeKey, plate, tower) {
  if (tower) return largestWithTower(shapeKey, plate);
  for (let s = 350; s >= 40; s -= 5) if (fits(shapeKey, s, plate) !== 'no') return s;
  return null;
}

/** Largest size (5 mm steps) that leaves room for a purge tower, in any of the ways above. */
export function largestWithTower(shapeKey, plate) {
  for (let s = 350; s >= 40; s -= 5) {
    if (fits(shapeKey, s, plate) !== 'no' && towerRoom(shapeKey, s, plate).room !== 'none') return s;
  }
  return null;
}
