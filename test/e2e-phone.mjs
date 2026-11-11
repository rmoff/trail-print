// Phone check: drag spins the model (page stays put), settings scroll, taps work, download works.
// Usage: node test/e2e-phone.mjs <url> <gpx>
import { chromium, devices } from 'playwright';
const [url = 'http://127.0.0.1:8787/', gpx = 'test/fixtures/run.gpx'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await b.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(url);
await p.setInputFiles('#file', gpx);
await p.waitForFunction(() => window.__trail?.state.built, null, { timeout: 180000 });
const cdp = await ctx.newCDPSession(p);
const cam = () => p.evaluate(() => { const c = document.querySelector('.viewer canvas'); return c ? c.toDataURL().length : 0; });
// One-finger drag across the preview should spin the model (image changes), not scroll the page.
const before = await cam();
const box = await p.locator('.viewer canvas').boundingBox();
const y = box.y + box.height / 2;
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 100, y }] });
for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 100 + i * 15, y }] });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await p.waitForTimeout(800);
console.log('drag spins model:', (await cam()) !== before, '| page scrolled:', await p.evaluate(() => scrollY));
// Settings scroll inside their own area.
const scrolled = await p.evaluate(() => { const el = document.querySelector('.panel-body'); el.scrollTop = 400; return [el.scrollTop, el.scrollHeight, el.clientHeight]; });
console.log('panel scrolls (top, scrollH, clientH):', scrolled);
// Tap through: colours, open text section, change title, download.
await p.tap('label:has(> input[name=colours][value=two])');
await p.tap('#sec-text summary');
await p.fill('#t-title', 'Phone test');
await p.waitForFunction(() => window.__trail.state.built?.id === window.__trail.state.buildId && !document.querySelector('#dl-3mf').disabled, null, { timeout: 180000 });
const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 120000 }), p.tap('#dl-3mf')]);
console.log('download:', dl.suggestedFilename());
await p.screenshot({ path: 'out/mobile/touch-final.png' });
console.log(errs.join('; ') || 'no page errors');
await b.close();
