import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRINTERS, fits, towerRoom, largestWithTower, largestFit, footprint, EDGE, tilePlacement } from '../public/js/plate.js';

const a1mini = PRINTERS.find(p => p.id === 'a1mini');
const mk4s = PRINTERS.find(p => p.id === 'mk4s');

test('ten printers, A1 mini first', () => {
  assert.equal(PRINTERS.length, 10);
  assert.equal(PRINTERS[0].id, 'a1mini');
});

test('fit on the plate', () => {
  assert.equal(fits('hexagon', 150, a1mini), 'yes');
  assert.equal(fits('square', 190, a1mini), 'no');
  // MK4S plate is 250 x 210: a 230 mm hexagon is 199 wide and 230 deep, so only turned.
  assert.equal(fits('hexagon', 230, mk4s), 'turned');
});

test('purge tower room matches what Bambu Studio sliced on an A1 mini', () => {
  // 11 Nov 2026: a 150 mm hexagon sliced with the tower in a free corner;
  // a 150 mm circle collided with the tower.
  assert.ok(['centred', 'corner'].includes(towerRoom('hexagon', 150, a1mini).room));
  assert.equal(towerRoom('square', 175, a1mini).room, 'none');
  // 11 Nov 2026, Bambu Studio command line with the tower at the A1 mini's default (back
  // left) and --arrange 0: these sizes, placed by tilePlacement, slice without collisions.
  assert.equal(largestWithTower('hexagon', a1mini), 160);
  assert.equal(largestWithTower('square', a1mini), 125);
  assert.equal(largestWithTower('circle', a1mini), 150);
  const sq = towerRoom('square', 125, a1mini);
  assert.equal(sq.room, 'corner');
  assert.ok(sq.tile.x > 0 && sq.tile.y < 0, 'tile moved front-right, away from the back-left tower');
  assert.deepEqual(tilePlacement('square', 125, a1mini, false), { x: 0, y: 0 }, 'one colour: no tower, tile in the middle');
  // 230 mm hexagon on an MK4S (250 x 210) only fits turned; the tower then has room.
  assert.equal(towerRoom('hexagon', 230, mk4s).room, 'turned');
});

test('Fit to plate keeps the edge clearance in the orientation it uses', () => {
  // Review 11 Nov 2026: a 90 x 160 plate gave a 90 mm hexagon that only fitted turned,
  // touching both side edges.
  const narrow = { w: 90, d: 160 };
  for (const shape of ['hexagon', 'circle', 'square']) {
    const s = largestFit(shape, narrow, true);
    if (s == null) continue;
    const r = towerRoom(shape, s, narrow);
    assert.notEqual(r.room, 'none', `${shape} ${s}`);
    const f = footprint(shape, s);
    const [w, d] = r.room === 'turned' ? [narrow.d, narrow.w] : [narrow.w, narrow.d];
    const t = r.tile || { x: 0, y: 0 };
    // The tile (wherever it is placed) stays EDGE clear of every side of the plate.
    assert.ok(Math.abs(t.x) + f.w / 2 <= w / 2 - EDGE + 1e-9 && Math.abs(t.y) + f.d / 2 <= d / 2 - EDGE + 1e-9, `${shape} ${s} breaks the edge clearance`);
  }
});
