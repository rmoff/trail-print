// Turns text into clean glyph polygons (in mm) for the underside of the tile.

import opentype from '../vendor/opentype.module.js';
import polygonClipping from '../vendor/polygon-clipping.js';

export function parseFont(arrayBuffer) {
  return opentype.parse(arrayBuffer);
}

function flatten(commands, size) {
  const rings = [];
  let ring = null, px = 0, py = 0;
  const steps = Math.max(4, Math.min(16, Math.round(size * 1.5)));
  const close = () => { if (ring && ring.length >= 3) rings.push(ring); ring = null; };
  for (const c of commands) {
    if (c.type === 'M') { close(); ring = [[c.x, -c.y]]; px = c.x; py = c.y; }
    else if (c.type === 'L') { ring.push([c.x, -c.y]); px = c.x; py = c.y; }
    else if (c.type === 'Q') {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        ring.push([u * u * px + 2 * u * t * c.x1 + t * t * c.x, -(u * u * py + 2 * u * t * c.y1 + t * t * c.y)]);
      }
      px = c.x; py = c.y;
    } else if (c.type === 'C') {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        const x = u * u * u * px + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x;
        const y = u * u * u * py + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y;
        ring.push([x, -y]);
      }
      px = c.x; py = c.y;
    } else if (c.type === 'Z') close();
  }
  close();
  // Drop repeated points (including a closing point equal to the first).
  return rings.map(r => r.filter((p, i) => {
    const q = r[(i + r.length - 1) % r.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4;
  })).filter(r => r.length >= 3);
}

/**
 * Tidy a ring for triangulation: drop points closer than minDist to the previous one and
 * points that are (almost) on the straight line between their neighbours.
 */
export function cleanRing(ring, minDist = 0.03) {
  let out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= minDist) out.push(p);
  }
  while (out.length > 3 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < minDist) out.pop();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length && out.length > 3; i++) {
      const n = out.length, a = out[(i + n - 1) % n], b = out[i], c = out[(i + 1) % n];
      const area2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(area2) < 2e-4) { out.splice(i, 1); changed = true; i--; }
    }
  }
  return out;
}

function ringArea(r) {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

/**
 * Lay out lines of text centred at (0, 0) and return glyph polygons for buildModel.
 * lines: [{ text, size }] with size = font size in mm.
 * Returns glyphs tagged with their line's index, and notes about lines that were shortened.
 * maxWidth: widest a line may be (mm); lines shrink to fit, but not below minSize.
 * mirror: flip left-right so the text reads correctly when the tile is turned over.
 */
export function layoutText(font, lines, { maxWidth, minSize, mirror = true, gap = 0.45 }) {
  const placed = [];
  const notes = []; // { line, kind: 'shortened', shown }
  lines.forEach((line, index) => {
    const text = (line.text || '').trim();
    if (!text) return;
    let size = line.size;
    let shown = text;
    let width = font.getAdvanceWidth(shown, size);
    if (width > maxWidth) {
      // Shrink to fit (a hair under, so rounding can't leave it a fraction too wide).
      size = Math.max(minSize, (size * maxWidth * 0.995) / width);
      width = font.getAdvanceWidth(shown, size);
      // Still too wide at the smallest readable size: cut it short.
      if (width > maxWidth) {
        while (shown.length > 1 && font.getAdvanceWidth(shown + '…', size) > maxWidth) shown = shown.slice(0, -1).trimEnd();
        shown += '…';
        width = font.getAdvanceWidth(shown, size);
        notes.push({ line: index, kind: 'shortened', shown });
      }
    }
    placed.push({ index, text: shown, size, width });
  });
  if (!placed.length) return { glyphs: [], notes, height: 0 };
  // Stack lines by the real extent of their letters (accents, descenders), with a gap,
  // so lines never touch.
  for (const p of placed) {
    const bb = font.getPath(p.text, 0, 0, p.size).getBoundingBox();
    p.inkTop = Number.isFinite(bb.y1) ? -bb.y1 : p.size * 0.7;   // above the baseline (y up)
    p.inkBottom = Number.isFinite(bb.y2) ? -bb.y2 : 0;            // below it (negative)
  }
  let y = 0;
  const baselines = placed.map((p, i) => {
    if (i > 0) {
      const prev = placed[i - 1];
      y += prev.inkBottom - Math.max(0.6, prev.size * gap * 0.6) - p.inkTop;
    }
    return y;
  });
  const top = baselines[0] + placed[0].inkTop;
  const last = placed.length - 1;
  const bottom = baselines[last] + placed[last].inkBottom;
  const shift = -(top + bottom) / 2;
  const bands = placed.map((p, i) => [baselines[i] + p.inkBottom + shift, baselines[i] + p.inkTop + shift]);

  const inside = (pt, ring) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  // Font outlines use winding direction to mark holes (the largest outline of each line is
  // an outer); letters may overlap, so the whole block is unioned into clean polygons.
  const pieces = [];
  placed.forEach((p, i) => {
    const polys = [];
    const path = font.getPath(p.text, -p.width / 2, 0, p.size);
    for (const ring of flatten(path.commands, p.size)) {
      polys.push(ring.map(([x, yy]) => [mirror ? -x : x, yy + baselines[i] + shift]));
    }
    if (!polys.length) return;
    const largest = polys.reduce((a, r) => (Math.abs(ringArea(r)) > Math.abs(ringArea(a)) ? r : a), polys[0]);
    const outerSign = Math.sign(ringArea(largest)) || 1;
    const outers = [], holes = [];
    for (const r of polys) (Math.sign(ringArea(r)) === outerSign ? outers : holes).push(r);
    for (const o of outers) pieces.push([o.map(q => [...q]), ...holes.filter(h => inside(h[0], o)).map(h => h.map(q => [...q]))]);
  });
  let merged = [];
  try {
    merged = pieces.length ? polygonClipping.union(...pieces.map(pc => [pc])) : [];
  } catch {
    for (const p of placed) notes.push({ line: p.index, kind: 'unprintable' });
  }
  // Which line a polygon belongs to: the band holding its middle (or the nearest band).
  const lineOf = ring => {
    let lo = Infinity, hi = -Infinity;
    for (const [, yy] of ring) { lo = Math.min(lo, yy); hi = Math.max(hi, yy); }
    const mid = (lo + hi) / 2;
    let best = 0, bestD = Infinity;
    bands.forEach(([b0, b1], i) => {
      const d = mid < b0 ? b0 - mid : mid > b1 ? mid - b1 : 0;
      if (d < bestD) { bestD = d; best = i; }
    });
    return placed[best].index;
  };
  const glyphs = [];
  for (const poly of merged) {
    const g = {
      line: lineOf(poly[0]),
      outer: cleanRing(poly[0].slice(0, -1)),
      holes: poly.slice(1).map(h => cleanRing(h.slice(0, -1))).filter(h => h.length >= 3 && Math.abs(ringArea(h)) > 0.01),
    };
    if (g.outer.length >= 3 && Math.abs(ringArea(g.outer)) > 0.01) glyphs.push(g);
  }
  return { glyphs, notes, height: top - bottom };
}
