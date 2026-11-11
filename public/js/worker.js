// Builds the model off the main thread so the page stays responsive.

import { SHAPES, fitShape, makeProjection } from './geo.js';
import { buildModel, NOZZLES, COLOUR_MODES } from './model.js';
import { makeSampler } from './dem.js';
import { makeWaterTest } from './water.js';
import { parseFont } from './text.js';
import { underside, textMessages } from './underside.js';
import { write3mfBambu, write3mfPrusa, writeStl } from './export.js';

let font = null;
let last = null; // { parts, title, colourMode }

function build(job) {
  const shape = SHAPES[job.options.shape] || SHAPES.hexagon;
  const proj = makeProjection(job.origin[0], job.origin[1]);
  const route = job.track.map(([lat, lon]) => proj.fwd(lat, lon));
  const fit = fitShape(shape, route, job.options.margin);
  const sample = makeSampler(job.dem.meta, job.dem.grid);
  const elevation = (x, y) => { const [lat, lon] = proj.inv(x, y); return sample(lat, lon); };
  const noz = NOZZLES[job.options.nozzle] || NOZZLES[0.4];
  const R = shape.sizeToR(job.options.sizeMm);
  const cellM = (noz.spacing / 2) * (fit.radius / R);
  const waterPolys = (job.water || []).map(p => ({ rings: p.rings.map(r => r.map(([la, lo]) => proj.fwd(la, lo))) }));
  const isWater = makeWaterTest(waterPolys, fit.cx - fit.radius, fit.cy - fit.radius, fit.cx + fit.radius, fit.cy + fit.radius, cellM);
  const t = underside(font, shape, job.options.sizeMm, job.options.nozzle, job.text);
  const model = buildModel({
    shape, sizeMm: job.options.sizeMm, nozzle: job.options.nozzle, colourMode: job.options.colourMode,
    exaggeration: job.options.exaggeration, baseMm: job.options.baseMm, fit, elevation, isWater, route,
    markers: job.markers.map(([lat, lon]) => proj.fwd(lat, lon)), glyphs: t.glyphs,
    progress: (f, label) => postMessage({ type: 'progress', id: job.id, fraction: f, label }),
  });
  last = { id: job.id, parts: model.parts, title: job.text.title || 'Trail print', colourMode: job.options.colourMode };
  const parts = model.parts.map(p => ({
    key: p.key, name: p.name, slot: p.slot, colour: p.colour,
    positions: Float32Array.from(p.mesh.v), indices: Uint32Array.from(p.mesh.t),
  }));
  const textNotes = textMessages(job.text, job.options.sizeMm, t.notes, model.info.textDropped);
  postMessage({ type: 'built', id: job.id, parts, info: model.info, warnings: [...textNotes, ...model.warnings] },
    parts.flatMap(p => [p.positions.buffer, p.indices.buffer]));
}

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.type === 'font') { font = parseFont(m.buffer); postMessage({ type: 'font-ready' }); }
    else if (m.type === 'build') build(m);
    else if (m.type === 'export') {
      if (!last) throw new Error('Nothing built yet.');
      if (m.buildId != null && m.buildId !== last.id) throw new Error('The model is still being updated. Try again in a moment.');
      const opts = { title: last.title, bedW: m.bedW || 180, bedD: m.bedD || 180 };
      const bytes = m.format === 'stl' ? writeStl(last.parts)
        : m.format === 'prusa' ? write3mfPrusa(last.parts, opts) : write3mfBambu(last.parts, opts);
      postMessage({ type: 'exported', id: m.id, format: m.format, bytes }, [bytes.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: err?.message || String(err) });
  }
};

export { COLOUR_MODES };
