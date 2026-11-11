// Printer build plates: does the tile fit, and is there room for a purge tower?

import { SHAPES, shapeNorm } from './geo.js';

// Usable plate width x depth in mm (makers' published build volumes).
export const PRINTERS = [
  { id: 'a1mini', name: 'Bambu Lab A1 mini', w: 180, d: 180 },
  { id: 'a1', name: 'Bambu Lab A1', w: 256, d: 256 },
  { id: 'p1s', name: 'Bambu Lab P1S / P1P', w: 256, d: 256 },
  { id: 'x1c', name: 'Bambu Lab X1 Carbon', w: 256, d: 256 },
  { id: 'h2d', name: 'Bambu Lab H2D', w: 325, d: 320 },
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
    if (shapeNorm(shape, x, y) <= R + 1) return false;
  }
  return true;
}

/**
 * Where can the purge tower go?
 *  { room: 'centred', tower: {x, y} }  tile in the middle, tower in a free corner (centre of tower,
 *                                      relative to the plate centre)
 *  { room: 'turned' }                  only if the tile is turned a quarter turn
 *  { room: 'corner' }                  only if the tile is moved into a corner first
 *  { room: 'none' }
 */
export function towerRoom(shapeKey, sizeMm, plate) {
  const asPlaced = towerRoomAsPlaced(shapeKey, sizeMm, plate);
  if (asPlaced.room === 'centred') return asPlaced;
  // A quarter turn swaps the tile's width and depth relative to the plate.
  const turned = towerRoomAsPlaced(shapeKey, sizeMm, { w: plate.d, d: plate.w });
  if (turned.room === 'centred') return { room: 'turned' };
  if (asPlaced.room === 'corner') return asPlaced;
  return turned.room === 'corner' ? { room: 'corner' } : { room: 'none' };
}

function towerRoomAsPlaced(shapeKey, sizeMm, plate) {
  const shape = SHAPES[shapeKey];
  const R = shape.sizeToR(sizeMm);
  const f = footprint(shapeKey, sizeMm);
  if (f.w > plate.w - 2 * EDGE || f.d > plate.d - 2 * EDGE) return { room: 'none' };
  const corners = [[plate.w - TOWER, plate.d - TOWER], [0, plate.d - TOWER], [plate.w - TOWER, 0], [0, 0]];
  for (const [x0, y0] of corners) {
    if (towerClear(shape, R, plate.w / 2, plate.d / 2, x0, y0)) {
      return { room: 'centred', tower: { x: x0 + TOWER / 2 - plate.w / 2, y: y0 + TOWER / 2 - plate.d / 2 } };
    }
  }
  // Tile pushed into the front-left corner, tower in the back-right.
  if (towerClear(shape, R, f.w / 2, f.d / 2, plate.w - TOWER, plate.d - TOWER)) return { room: 'corner' };
  return { room: 'none' };
}

/** Largest size (5 mm steps) that fits the plate, with room for a purge tower if `tower`. */
export function largestFit(shapeKey, plate, tower) {
  if (tower) return largestWithTower(shapeKey, plate);
  for (let s = 350; s >= 40; s -= 5) if (fits(shapeKey, s, plate) !== 'no') return s;
  return null;
}

/** Largest size (5 mm steps) that leaves room for a tower, with the tile in the middle (turned if need be). */
export function largestWithTower(shapeKey, plate) {
  for (let s = 350; s >= 40; s -= 5) {
    if (fits(shapeKey, s, plate) !== 'no' && ['centred', 'turned'].includes(towerRoom(shapeKey, s, plate).room)) return s;
  }
  return null;
}
