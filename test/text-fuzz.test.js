// Many titles x sizes x shapes x nozzles: every part must stay a closed mesh, and every
// letter must stay inside the tile. (The review on 11 Nov 2026 found long titles spilling
// off the tile and an "S" at 200 mm leaving the land open.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SHAPES, fitShape, shapeNorm } from '../public/js/geo.js';
import { buildModel } from '../public/js/model.js';
import { parseFont } from '../public/js/text.js';
import { underside, textMessages } from "../public/js/underside.js";

const buf = readFileSync(new URL('../public/vendor/fredoka-600.woff', import.meta.url));
const font = parseFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const flat = () => 100;
const route = [[-400, -300], [0, 200], [450, -100]];
const texts = [
  { title: 'Sunday long run up Pen-y-ghent and Ingle', subtitle: 'Horton-in-Ribblesdale, 3 March 2026', stats: '42.20 km  ·  1520 m climb' },
  { title: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', subtitle: 'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', stats: '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@' },
  { title: 'Ilkley Moor bah t’at', subtitle: 'Saturday & Sunday — été ß ø', stats: '8 km' },
  { title: 'S', subtitle: '', stats: '' },
  { title: 'Bøgø%&$#@!?', subtitle: 'gjpqy QOB8 ggg', stats: '0.00 km  ·  0 m climb' },
  { title: 'g', subtitle: 'ÅÅÅ', stats: 'ÉÈÊ gyp' },
];

for (const shapeKey of Object.keys(SHAPES)) {
  for (const sizeMm of [80, 150, 200, 250]) {
    for (const nozzle of [0.4, 0.2]) {
      test(`${shapeKey} ${sizeMm} mm, ${nozzle} nozzle: text keeps every part closed and inside`, () => {
        const shape = SHAPES[shapeKey];
        const R = shape.sizeToR(sizeMm);
        const fit = fitShape(shape, route, 1.3);
        for (const text of texts) {
          const { glyphs } = underside(font, shape, sizeMm, nozzle, text);
          const m = buildModel({
            shape, sizeMm, nozzle, colourMode: 'full', exaggeration: 1, baseMm: 4,
            fit, elevation: flat, route, markers: [], glyphs,
          });
          for (const p of m.parts) {
            assert.equal(p.mesh.openEdges(), 0, `${p.name} open with title "${text.title}"`);
            const v = p.mesh.v;
            for (let i = 0; i < v.length; i += 3) {
              assert.ok(shapeNorm(shape, v[i], v[i + 1]) <= R + 1e-6, `${p.name} outside the tile with "${text.title}"`);
            }
          }
        }
      });
    }
  }
}

test('ordinary text on ordinary tiles: no letters left off, messages name the line', () => {
  const text = { title: 'Morning Trail Run', subtitle: 'Grassington, 3 May 2026', stats: '13.7 km  ·  363 m climb' };
  for (const shapeKey of Object.keys(SHAPES)) {
    for (const sizeMm of [100, 120, 150, 180, 200, 250]) {
      for (const nozzle of [0.4, 0.2]) {
        const shape = SHAPES[shapeKey];
        const t = underside(font, shape, sizeMm, nozzle, text);
        const m = buildModel({ shape, sizeMm, nozzle, colourMode: 'full', exaggeration: 1, baseMm: 4,
          fit: fitShape(shape, route, 1.3), elevation: flat, route, markers: [], glyphs: t.glyphs });
        assert.deepEqual(m.info.textDropped, [], `${shapeKey} ${sizeMm} ${nozzle}: letters left off`);
        const t2 = underside(font, shape, sizeMm, nozzle, { title: 'g', subtitle: 'ÅÅÅ', stats: '' });
        const m2 = buildModel({ shape, sizeMm, nozzle, colourMode: 'full', exaggeration: 1, baseMm: 4,
          fit: fitShape(shape, route, 1.3), elevation: flat, route, markers: [], glyphs: t2.glyphs });
        assert.deepEqual(m2.info.textDropped, [], `${shapeKey} ${sizeMm} ${nozzle}: g over ÅÅÅ lost letters`);
      }
    }
  }
  const msgs = textMessages(text, 90, [{ line: 1, kind: 'shortened', shown: 'Grassington, 3 M…' }], [{ line: 0, reason: 'edge' }]);
  assert.equal(msgs[0], 'Second line shortened to “Grassington, 3 M…” to fit. Shorten it or enlarge the tile.');
  assert.equal(msgs[1], 'Title: letters too near the edge were left off. Shorten it or enlarge the tile.');
});

test('a title shrunk to fit is not also shortened (rounding)', () => {
  // 11 Nov 2026: "Wharfedale Three Peaks" on a 150 mm hexagon came out as "Wharfedale Three Pea…".
  for (const title of ['Wharfedale Three Peaks', 'Morning Trail Run', 'Dales Dazzler 50', 'Wharfedale Trail Half']) {
    for (const shapeKey of Object.keys(SHAPES)) {
      for (const sizeMm of [120, 150, 180]) {
        const t = underside(font, SHAPES[shapeKey], sizeMm, 0.4, { title, subtitle: 'Kettlewell with Starbotton', stats: '27.2 km  ·  1128 m climb' });
        assert.deepEqual(t.notes, [], `${title} ${shapeKey} ${sizeMm}`);
      }
    }
  }
});
