// Reload check: load a run, change settings and title, reload, expect the same state back.
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const [url = 'http://127.0.0.1:8820/', gpx = 'test/fixtures/morning-trail-run.gpx'] = process.argv.slice(2);
const exe = process.env.CHROME || undefined; // default: Playwright's own Chromium
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const built = () => page.waitForFunction(() => window.__trail?.state.built?.id === window.__trail?.state.buildId && !document.querySelector('#dl-3mf').disabled, null, { timeout: 180000 });
await page.goto(url);
await page.setInputFiles('#file', gpx);
await built();
await page.check('input[name=shape][value=circle]');
await page.click('#sec-text summary');
await page.fill('#t-title', 'My own title');
await page.dispatchEvent('#t-title', 'input');
await page.waitForTimeout(1500);
await built();
await page.reload();
await built();
const s = await page.evaluate(() => ({
  shape: document.querySelector('input[name=shape]:checked').value,
  title: document.querySelector('#t-title').value,
  name: document.querySelector('#run-name').textContent,
  hasRun: document.querySelector('.layout').classList.contains('has-run'),
}));
console.log(JSON.stringify(s));
const ok = s.shape === 'circle' && s.title === 'My own title' && s.hasRun;
await page.click('#forget');
await page.waitForLoadState('load');
await page.waitForTimeout(1000);
const cleared = await page.evaluate(() => !document.querySelector('.layout').classList.contains('has-run'));
console.log(ok && cleared ? 'RELOAD OK' : 'RELOAD FAILED', 'cleared:', cleared, errors.join('; ') || 'no page errors');
await browser.close();
