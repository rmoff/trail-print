import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { unzipSync, strFromU8 } from '../public/vendor/fflate.js';
import { SHAPES, fitShape, makeProjection, rectangleShape, shapeNorm, shapeApothem } from '../public/js/geo.js';
import { buildModel, buildLattice } from '../public/js/model.js';
import { parseFont, layoutText } from '../public/js/text.js';
import { write3mfBambu, write3mfPrusa, writeStl } from '../public/js/export.js';
import { parseGpx, trackStats } from '../public/js/gpx.js';

const fontBuf = readFileSync(new URL('../public/vendor/fredoka-600.woff', import.meta.url));
const font = parseFont(fontBuf.buffer.slice(fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength));

// Synthetic landscape: two hills and a lake basin, in projected metres.
const elevation = (x, y) => 200 + 180 * Math.exp(-((x - 800) ** 2 + (y - 300) ** 2) / 4e5)
  + 120 * Math.exp(-((x + 900) ** 2 + (y + 500) ** 2) / 3e5) + 20 * Math.sin(x / 300) * Math.cos(y / 400);
const isWater = (x, y) => (x - 200) ** 2 + (y + 900) ** 2 < 350 ** 2;
const route = [];
for (let i = 0; i <= 400; i++) {
  const a = (i / 400) * Math.PI * 3.2;
  route.push([Math.cos(a) * (600 + i * 2), Math.sin(a) * (500 + i * 1.5)]);
}

function build(shapeKey, colourMode, nozzle = 0.4) {
  const shape = SHAPES[shapeKey];
  const fit = fitShape(shape, route, 1.2);
  const { glyphs } = layoutText(font, [
    { text: 'Morning Trail Run', size: 9 },
    { text: 'Ilkley Moor · 11 Nov 2026', size: 6 },
    { text: '13.6 km · 386 m climb', size: 6 },
  ], { maxWidth: 110, minSize: 5 });
  return buildModel({
    shape, sizeMm: 150, nozzle, colourMode, exaggeration: null, baseMm: 4,
    fit, elevation, isWater, route, markers: [route[0], route[route.length - 1]], glyphs,
  });
}

for (const shapeKey of Object.keys(SHAPES)) {
  for (const mode of ['full', 'two', 'one']) {
    test(`${shapeKey} / ${mode}: every part is closed, outward-facing and fits the bed`, () => {
      const m = build(shapeKey, mode);
      for (const p of m.parts) {
        assert.equal(p.mesh.openEdges(), 0, `${p.name} has open or mis-oriented edges`);
        assert.ok(p.mesh.volume() > 0, `${p.name} volume should be positive`);
        const b = p.mesh.bounds();
        assert.ok(b.min[2] >= -1e-9, `${p.name} goes below the bed`);
        assert.ok(b.max[0] - b.min[0] <= 150.01 && b.max[1] - b.min[1] <= 150.01, `${p.name} wider than 150 mm`);
      }
      const keys = m.parts.map(p => p.key);
      if (mode === 'full') assert.deepEqual(keys, ['land', 'water', 'route', 'details']);
      if (mode === 'two') assert.deepEqual(keys, ['land', 'route']);
      if (mode === 'one') assert.deepEqual(keys, ['land', 'route']);
      assert.ok(m.info.exaggeration >= 1 && m.info.exaggeration <= 3);
    });
  }
}

test('rectangle shape: norm, apothem, lattice area', () => {
  const r = rectangleShape(160, 80);
  const R = r.sizeToR(160);
  assert.ok(Math.abs(R - Math.hypot(80, 40)) < 1e-9);
  assert.ok(Math.abs(shapeNorm(r, 80, 0) - R) < 1e-9, 'end of the long axis is on the edge');
  assert.ok(Math.abs(shapeNorm(r, 0, 40) - R) < 1e-9, 'end of the short axis is on the edge');
  assert.ok(Math.abs(shapeNorm(r, 80, 40) - R) < 1e-9, 'corner');
  assert.ok(Math.abs(shapeApothem(r) - 40 / R) < 1e-9);
  // Regular shapes keep their old values.
  assert.ok(Math.abs(shapeApothem(SHAPES.hexagon) - Math.cos(Math.PI / 6)) < 1e-12);
  const L = buildLattice(r, R, 12);
  let area = 0;
  for (let t = 0; t < L.tris.length; t += 3) {
    const [a, b, c] = [L.tris[t], L.tris[t + 1], L.tris[t + 2]];
    area += ((L.x[b] - L.x[a]) * (L.y[c] - L.y[a]) - (L.y[b] - L.y[a]) * (L.x[c] - L.x[a])) / 2;
  }
  assert.ok(Math.abs(area - 160 * 80) < 1e-6);
});

test('rectangle model is closed; lowM fixes the base height', () => {
  const shape = rectangleShape(160, 80);
  const R = shape.sizeToR(160);
  const fit = { cx: 0, cy: 0, radius: 1.3 * Math.hypot(1400, 700) };
  const { glyphs } = layoutText(font, [{ text: 'Dales Way 2026', size: 8 }], { maxWidth: 100, minSize: 5 });
  const make = lowM => buildModel({ shape, sizeMm: 160, nozzle: 0.4, colourMode: 'full', exaggeration: 3, baseMm: 4,
    fit, elevation, isWater, route, markers: [route[0]], glyphs, lowM });
  const m = make(0);
  for (const p of m.parts) {
    assert.equal(p.mesh.openEdges(), 0, `${p.name} has open or mis-oriented edges`);
    assert.ok(p.mesh.volume() > 0, p.name);
    const b = p.mesh.bounds();
    assert.ok(b.max[0] - b.min[0] <= 160.01 && b.max[1] - b.min[1] <= 80.01, `${p.name} outside the rectangle`);
  }
  assert.equal(m.info.textDropped.length, 0);
  assert.throws(() => make(1000), /below lowM/);
  // A route cut at the right-hand edge, with a square end there, stops exactly at the edge.
  const edgeM = 80 / (R / fit.radius); // right edge in metres
  const cut = buildModel({ shape, sizeMm: 160, nozzle: 0.4, colourMode: 'full', exaggeration: 3, baseMm: 4, fit, elevation,
    route: [[0, 0], [edgeM - 300, 50], [edgeM, 50]], markers: [], routeFlatEnds: { end: true } });
  const rt = cut.parts.find(p => p.key === 'route').mesh;
  assert.equal(rt.openEdges(), 0);
  assert.ok(Math.abs(rt.bounds().max[0] - 80) < 1e-6, `route ends at ${rt.bounds().max[0]}`);
  // Ground at about 200 m, so sea level as the base makes it taller than the lowest-point default.
  const s = R / fit.radius;
  const d = make(undefined);
  assert.equal(m.info.lowM, 0);
  assert.ok(Math.abs((m.info.heightMm - d.info.heightMm) - d.info.lowM * s * 3) < 0.05);
});

test('0.2 mm nozzle gives a finer mesh and a thinner route', () => {
  const coarse = build('hexagon', 'full', 0.4), fine = build('hexagon', 'full', 0.2);
  assert.ok(fine.info.rings > coarse.info.rings);
  for (const p of fine.parts) assert.equal(p.mesh.openEdges(), 0, p.name);
});

test('lattice covers the hexagon with counter-clockwise triangles', () => {
  const L = buildLattice(SHAPES.hexagon, 10, 8);
  assert.equal(L.tris.length / 3, 6 * 64);
  let area = 0;
  for (let t = 0; t < L.tris.length; t += 3) {
    const [a, b, c] = [L.tris[t], L.tris[t + 1], L.tris[t + 2]];
    const cross = (L.x[b] - L.x[a]) * (L.y[c] - L.y[a]) - (L.y[b] - L.y[a]) * (L.x[c] - L.x[a]);
    assert.ok(cross > 0);
    area += cross / 2;
  }
  assert.ok(Math.abs(area - (3 * Math.sqrt(3) / 2) * 100) < 1e-6);
});

test('Bambu 3MF: one object with a named part per filament, on plate 1', () => {
  const m = build('hexagon', 'full');
  const bytes = write3mfBambu(m.parts, { title: 'Test & "run"\u0001' });
  const files = unzipSync(bytes);
  assert.deepEqual(Object.keys(files).sort(), ['3D/3dmodel.model', '3D/Objects/object_1.model', '3D/_rels/3dmodel.model.rels', 'Metadata/model_settings.config', '[Content_Types].xml', '_rels/.rels']);
  const root = strFromU8(files['3D/3dmodel.model']);
  assert.match(root, /<metadata name="Application">BambuStudio-/);
  assert.equal((root.match(/<component /g) || []).length, 4);
  assert.match(root, /<metadata name="Title">Test &amp; &quot;run&quot;<\/metadata>/);
  const objects = strFromU8(files['3D/Objects/object_1.model']);
  assert.equal((objects.match(/<object /g) || []).length, 4);
  const cfg = strFromU8(files['Metadata/model_settings.config']);
  for (const [name, slot] of [['Land', 1], ['Water', 2], ['Route', 3], ['Markers &amp; text', 4]]) {
    assert.match(cfg, new RegExp(`value="${name}"/>\\s*<metadata key="matrix"[^>]*/>\\s*<metadata key="extruder" value="${slot}"`));
  }
  assert.match(cfg, /<plate>[\s\S]*<metadata key="object_id" value="5"\/>/);
  mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../out/test-full.3mf', import.meta.url), bytes);
  writeFileSync(new URL('../out/test-two.3mf', import.meta.url), write3mfBambu(build('hexagon', 'two').parts, { title: 'two' }));
  writeFileSync(new URL('../out/test-full-prusa.3mf', import.meta.url), write3mfPrusa(m.parts, { title: 'prusa' }));
  const stl = writeStl(m.parts);
  const tris = m.parts.reduce((n, p) => n + p.mesh.triangleCount, 0);
  assert.equal(stl.length, 84 + 50 * tris);
});

test('GPX parsing and stats', () => {
  const gpx = `<?xml version="1.0"?><gpx version="1.1"><metadata><time>2026-01-01T00:00:00Z</time></metadata>
    <wpt lat="54" lon="-1.9"><name>Cafe &amp; loo</name></wpt>
    <trk><name>Hill &amp; dale</name><trkseg>
    <trkpt lat="54.0" lon="-1.9"><ele>100</ele><time>2026-01-01T08:00:00Z</time></trkpt>
    <trkpt lat="54.001" lon="-1.9"><ele>101</ele></trkpt>
    <trkpt lat="54.002" lon="-1.9"><ele>110</ele></trkpt>
    <trkpt lat="54.003" lon="-1.9"><ele>105</ele></trkpt>
    <trkpt lat="54.004" lon="-1.9"/>
    </trkseg></trk></gpx>`;
  const g = parseGpx(gpx);
  assert.equal(g.name, 'Hill & dale');
  assert.equal(g.track.length, 5);
  assert.equal(g.waypoints[0].name, 'Cafe & loo');
  assert.equal(g.time, '2026-01-01T08:00:00Z');
  const s = trackStats(g.track);
  assert.ok(Math.abs(s.distance - 444.8) < 2, String(s.distance));
  assert.equal(s.climb, 10);
  assert.throws(() => parseGpx('<html></html>'));
});

test('real run fixture parses (skipped when absent)', { skip: !safeExists('fixtures/morning-trail-run.gpx') }, () => {
  const g = parseGpx(readFileSync(new URL('./fixtures/morning-trail-run.gpx', import.meta.url), 'utf8'));
  assert.equal(g.name, 'Morning Trail Run');
  assert.ok(g.track.length > 1000);
  const proj = makeProjection(g.track[0].lat, g.track[0].lon);
  const pts = g.track.map(p => proj.fwd(p.lat, p.lon));
  const fit = fitShape(SHAPES.hexagon, pts, 1.15);
  assert.ok(fit.radius > 100);
});

function safeExists(rel) {
  try { readFileSync(new URL('./' + rel, import.meta.url)); return true; } catch { return false; }
}
