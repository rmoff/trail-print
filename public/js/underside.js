// Lays out the three lines of text for the underside of the tile.

import { shapeNorm } from './geo.js';
import { NOZZLES } from './model.js';
import { layoutText } from './text.js';

/** Layout of the underside text: returns glyphs + warnings. */
export function underside(fontObj, shape, sizeMm, nozzle, text) {
  const noz = NOZZLES[nozzle] || NOZZLES[0.4];
  const R = shape.sizeToR(sizeMm);
  const inner = shape.circle ? R : R * Math.cos(Math.PI / shape.K);
  // Shrink the whole block until every letter sits inside the tile outline with a margin
  // (the model also drops any letter that still pokes out, with a warning).
  const limit = R - 3.5 / (shape.circle ? 1 : Math.cos(Math.PI / shape.K));
  let scale = 1, result;
  for (let attempt = 0; attempt < 6; attempt++) {
    const titleSize = Math.max(noz.minFont, Math.min(16, sizeMm * 0.075) * scale);
    const smallSize = Math.max(noz.minFont, titleSize * 0.62);
    result = layoutText(fontObj, [
      { text: text.title, size: titleSize },
      { text: text.subtitle, size: smallSize },
      { text: text.stats, size: smallSize },
    ], { maxWidth: inner * 1.45 * Math.min(1, scale), minSize: noz.minFont });
    let worst = 0;
    for (const g of result.glyphs) for (const r of [g.outer, ...g.holes]) for (const [x, y] of r) worst = Math.max(worst, shapeNorm(shape, x, y));
    if (worst <= limit) break;
    scale *= Math.max(0.5, (limit / worst) * 0.97);
  }
  return result;
}

const LINE_NAMES = ['title', 'second line', 'third line'];
const quote = t => `“${t}”`;
const cap = t => t[0].toUpperCase() + t.slice(1);

/**
 * Plain-language messages about the text on the back: which line was shortened or lost
 * letters, why, and what to do. `notes` come from underside(), `dropped` from the model.
 */
export function textMessages(text, sizeMm, notes = [], dropped = []) {
  const lineText = [text.title, text.subtitle, text.stats];
  const out = [];
  for (const n of notes) {
    const name = LINE_NAMES[n.line];
    if (n.kind === 'shortened') out.push(`${cap(name)} shortened to ${quote(n.shown)} to fit.`);
    else out.push(`${cap(name)} left off: it couldn’t be made printable.`);
  }
  if (dropped.some(d => d.reason === 'all')) {
    out.push('Text on the back left off: it couldn’t be made printable. Try another size.');
  } else {
    for (const reason of ['edge', 'shape']) {
      const lines = [...new Set(dropped.filter(d => d.reason === reason).map(d => d.line))];
      for (const l of lines) {
        const name = LINE_NAMES[l] ?? 'text';
        out.push(reason === 'edge'
          ? `${cap(name)}: letters too near the edge were left off.`
          : `${cap(name)}: some letters couldn’t be made printable and were left off. Try another size.`);
      }
    }
  }
  return out;
}
