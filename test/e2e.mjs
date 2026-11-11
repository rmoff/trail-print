// End-to-end check in headless Chromium: load a GPX, wait for the model, download both files.
// Usage: node test/e2e.mjs <url> <gpx> [outdir] [settings JSON]
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

const [url = 'http://127.0.0.1:8817/', gpx = 'test/fixtures/morning-trail-run.gpx', out = 'out/e2e', settingsJson = '{}'] = process.argv.slice(2);
const settings = JSON.parse(settingsJson);
mkdirSync(out, { recursive: true });
const exe = process.env.CHROME || undefined; // default: Playwright's own Chromium
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(url);
await page.screenshot({ path: `${out}/0-empty.png` });
await page.setInputFiles('#file', gpx);
const t0 = Date.now();
try {
  await page.waitForFunction(() => window.__trail?.state.built || document.querySelector('#status.error'), null, { timeout: 180000 });
} catch (e) {
  console.log('TIMEOUT; status =', await page.$eval('#status', el => el.hidden ? '(hidden)' : el.textContent));
  console.log(errors.join('\n'));
  await page.screenshot({ path: `${out}/timeout.png` });
  await browser.close(); process.exit(1);
}
const err = await page.$eval('#status', el => el.classList.contains('error') && !el.hidden ? el.textContent : null);
if (err) { console.log('ERROR STATUS:', err); }
console.log('first build', ((Date.now() - t0) / 1000).toFixed(1), 's');
const before = await page.evaluate(() => window.__trail.state.buildId);
for (const [name, value] of Object.entries(settings)) {
  // Controls may sit in a closed section: open it first.
  await page.evaluate(n => {
    const el = document.querySelector(`#${CSS.escape(n)}`) || document.querySelector(`input[name="${n}"]`);
    const d = el?.closest('details');
    if (d) d.open = true;
  }, name);
  const sel = `input[name=${name}][value="${value}"]`;
  if (await page.$(sel)) await page.check(sel);
  else if (await page.$(`select#${name}`)) await page.selectOption(`#${name}`, String(value));
  else await page.fill(`#${name}`, String(value));
  await page.dispatchEvent(`#${name}`, 'input').catch(() => {});
}
if (Object.keys(settings).length) {
  try {
    await page.waitForFunction(b => window.__trail.state.buildId > b && window.__trail.state.built?.id === window.__trail.state.buildId, before, { timeout: 240000 });
  } catch (e) {
    console.log('TIMEOUT after settings; status =', await page.$eval('#status', el => el.hidden ? '(hidden)' : el.textContent), await page.evaluate(() => [window.__trail.state.buildId, window.__trail.state.built?.id]));
    console.log(errors.join('\n'));
    await browser.close(); process.exit(1);
  }
}
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/1-built.png` });
await page.click('[data-view=under]');
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/2-under.png` });
await page.click('[data-view=top]');
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/3-top.png` });
const info = await page.evaluate(() => ({ info: window.__trail.state.built.info, water: window.__trail.state.water?.length, warn: document.querySelector('#warnings').innerText, sub: document.querySelector('#t-sub').value, stats: document.querySelector('#t-stats').value, title: document.querySelector('#t-title').value }));
console.log(JSON.stringify(info));
for (const [btn, ext] of [['#dl-3mf', '3mf'], ['#dl-stl', 'stl'], ['#dl-prusa', 'prusa.3mf']]) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click(btn)]);
  await dl.saveAs(`${out}/model.${ext}`);
  console.log('saved', dl.suggestedFilename());
}
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/4-phone.png`, fullPage: true });
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
