// Layout check at phone, tablet and short-desktop sizes: no page scroll, nothing off-screen.
// Usage: node test/e2e-sizes.mjs <url> <gpx>  (screenshots in out/mobile/)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const [url = 'http://127.0.0.1:8787/', gpx = 'test/fixtures/run.gpx'] = process.argv.slice(2);
mkdirSync('out/mobile', { recursive: true });
const b = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const sizes = [['se-320x568', 320, 568, true], ['se-land-568x320', 568, 320, true], ['iphone-390x664', 390, 664, true], ['iphone-land-750x342', 750, 342, true], ['ipad-810x1080', 810, 1080, true], ['ipad-land-1080x810', 1080, 810, true], ['short-desk-1280x500', 1280, 500, false]];
for (const [name, w, h, touch] of sizes) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: touch && w < 900, hasTouch: touch, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(url);
  await p.setInputFiles('#file', gpx);
  await p.waitForFunction(() => window.__trail?.state.built, null, { timeout: 180000 });
  await p.waitForTimeout(600);
  const m = await p.evaluate(() => {
    const r = sel => { const e = document.querySelector(sel); const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
    const out = [...document.querySelectorAll('.downloads > *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).length;
    return { hscroll: document.documentElement.scrollWidth > innerWidth, docH: document.documentElement.scrollHeight, winH: innerHeight, stage: r('.stage'), panel: r('.panel'), dl: r('.downloads'), offscreenDownloads: out };
  });
  console.log(name, JSON.stringify(m), errs.join('; ') || '');
  await p.screenshot({ path: `out/mobile/size-${name}.png` });
  await ctx.close();
}
await b.close();
