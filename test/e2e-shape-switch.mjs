// Changing shape must not move the old tile before the new one appears: the tile's position on
// the plate changes in the same frame as the new shape (RM, 12 Nov 2026).
// Usage: node test/e2e-shape-switch.mjs <url> <gpx>
import { chromium } from 'playwright';
const [url = 'http://127.0.0.1:8787/', gpx = 'test/fixtures/run.gpx'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(url);
await p.setInputFiles('#file', gpx);
const settled = () => p.waitForFunction(() => window.__trail.state.built?.id === window.__trail.state.buildId && !document.querySelector('#dl-3mf').disabled, null, { timeout: 180000 });
await settled();
// Sample, every animation frame, which model is on screen and where the tile sits.
await p.evaluate(() => {
  window.__samples = [];
  const tick = () => {
    const pv = window.__trail.preview;
    window.__samples.push({ model: pv.group.children[0]?.geometry.uuid, x: +pv.group.position.x.toFixed(2), z: +pv.group.position.z.toFixed(2) });
    window.__raf = requestAnimationFrame(tick);
  };
  tick();
});
let bad = 0;
for (const shape of ['square', 'circle', 'hexagon', 'square']) {
  await p.check(`input[name=shape][value=${shape}]`);
  await p.waitForTimeout(400);
  await settled();
  await p.waitForTimeout(300);
}
const samples = await p.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__samples; });
// Every change of position must happen in the same frame as a change of model.
for (let i = 1; i < samples.length; i++) {
  const a = samples[i - 1], c = samples[i];
  if ((a.x !== c.x || a.z !== c.z) && a.model === c.model) bad++;
}
console.log(bad === 0 ? 'SHAPE SWITCH OK' : `SHAPE SWITCH BAD: tile moved ${bad} time(s) without its new shape`, `(${samples.length} frames)`, errs.join('; ') || 'no page errors');
await b.close();
