/* End-to-end game flow: campaign → briefing → build → launch → results
   (drives the REAL data.js + sim.js + ui.js + scene.js in a headless browser) */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
// Optional local copy of the pinned Three.js r128 build (faster + offline):
//   curl -o three.min.js https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js
const THREE_PATH = process.env.THREE_MIN || path.join(__dirname, 'three.min.js');
const THREE_LOCAL = fs.existsSync(THREE_PATH) ? fs.readFileSync(THREE_PATH) : null;
fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });   // screenshots land here
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = process.env.BASE || 'http://127.0.0.1:8000';
const steps = [];
function step(name, ok, detail) {
  steps.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
}
const errors = [];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/chromium-browser', headless: 'new',
    args: ['--no-sandbox','--disable-gpu','--enable-unsafe-swiftshader',
           '--use-gl=angle','--use-angle=swiftshader',
           '--disable-background-timer-throttling','--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  if (THREE_LOCAL) {
    await page.setRequestInterception(true);
    page.on('request', r => r.url().includes('three.js/r128/three.min.js')
      ? r.respond({ status: 200, contentType: 'application/javascript', body: THREE_LOCAL }) : r.continue());
  }
  page.on('pageerror', e => errors.push('pageerror: ' + e));
  page.on('console', m => {
    const t = m.text();
    if (m.type() !== 'error') return;
    if (t.includes('favicon') || t.startsWith('Failed to load resource')) return; // 404s tracked via response
    errors.push('console: ' + t);
  });
  page.on('response', r => { if (r.status() >= 400 && !r.url().includes('favicon')) errors.push('http ' + r.status() + ': ' + r.url()); });

  // fresh progress each run
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.removeItem('smg_progress'); } catch (e) {} });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  // --- campaign ---
  const cards = await page.$$eval('.mission-card', els =>
    els.map(e => ({ name: e.querySelector('.mission-card__name')?.textContent || '',
                    disabled: e.disabled,
                    locked: e.className.includes('--locked') })));
  step('campaign: 5 mission cards', cards.length === 5, `count=${cards.length}`);
  step('campaign: mission 1 unlocked, rest locked',
       cards.length === 5 && !cards[0].disabled && cards[1].disabled && cards[1].locked,
       JSON.stringify(cards.map(c => c.disabled ? 'L' : 'U')));
  step('campaign: card 1 is the Apollo mission', /Apollo/i.test(cards[0]?.name || ''), cards[0]?.name);
  const canvasNormal = await page.$$eval('#scene canvas', els => els.length);
  step('normal play: scene initialized by ui.js (1 canvas)', canvasNormal === 1, `count=${canvasNormal}`);

  // --- briefing ---
  await page.click('.mission-card:not([disabled])');
  await sleep(600);
  const brief = await page.$eval('.briefing', el => el.textContent);
  step('briefing renders with objective + START MISSION', /Reach the Moon/.test(brief) && /START MISSION/.test(brief));
  const spoil = await page.$$eval('.knowledge', els => els.length);
  step('briefing does NOT spoil knowledge panel', spoil === 0, `knowledge panels=${spoil}`);

  // --- build ---
  await page.click('.briefing .btn--primary');
  await sleep(600);
  const groups = await page.$$eval('.control-group', els => els.length);
  const choices = await page.$$eval('.choice', els => els.length);
  step('build: exactly 2 control groups', groups === 2, `count=${groups}`);
  step('build: 6 choices (3 staging + 3 brake)', choices === 6, `count=${choices}`);
  const launchDisabled = await page.$eval('.launch-bar .btn--primary', el => el.disabled);
  step('build: LAUNCH disabled until all controls picked', launchDisabled === true);
  const gauges = await page.$$eval('.vehicle-check .gauge', els => els.length);
  step('build: vehicle-check gauges rendered', gauges > 0, `gauges=${gauges}`);

  // --- wrong combo (parachute on the Moon) ---
  await page.click('.choice[data-control="staging"][data-option="attached"]');
  await page.click('.choice[data-control="brake"][data-option="chute"]');
  await sleep(400);
  const sel = await page.$$eval('.choice.is-selected', els => els.length);
  step('build: 2 selections registered', sel === 2, `selected=${sel}`);
  const launchEnabled = await page.$eval('.launch-bar .btn--primary', el => !el.disabled);
  step('build: LAUNCH enabled after valid picks', launchEnabled === true);
  await page.screenshot({ path: path.join(__dirname, 'shots', '10-build.png') });

  await page.click('.launch-bar .btn--primary');
  // launch plays ~10s (wall-clock) — wait for results
  const failShown = await page.waitForSelector('.results--fail', { timeout: 25000 }).then(() => true).catch(() => false);
  step('wrong combo → failure results screen', failShown);
  if (failShown) {
    const res = await page.$eval('.results', el => el.textContent);
    step('failure shows parachute lesson copy', /limp|no air|atmosphere/i.test(res), res.slice(0, 120));
    step('knowledge panel present on failure', await page.$('.knowledge') !== null);
    await page.screenshot({ path: path.join(__dirname, 'shots', '11-results-fail.png') });
  }

  // --- retry with the WIN combo ---
  await page.click('.results [data-go="retry"]');
  await sleep(600);
  await page.click('.choice[data-control="staging"][data-option="dropEmpty"]');
  await page.click('.choice[data-control="brake"][data-option="retro"]');
  await sleep(300);
  await page.click('.launch-bar .btn--primary');
  const winShown = await page.waitForSelector('.results--win', { timeout: 25000 }).then(() => true).catch(() => false);
  step('win combo → success results screen', winShown);
  if (winShown) {
    const res = await page.$eval('.results', el => el.textContent);
    step('success copy present', /Mission Complete/i.test(res));
    const k = await page.$eval('.knowledge', el => el.textContent);
    step('knowledge panel shows rocket-staging lesson', /staging|vacuum/i.test(k), k.slice(0, 100));
    const hasNext = await page.$('.results [data-go="next"]') !== null;
    step('NEXT MISSION offered (mission 2 unlocked)', hasNext);
    await page.screenshot({ path: path.join(__dirname, 'shots', '12-results-win.png') });
  }

  // --- skip path: launch then SKIP must reach results fast ---
  await page.click('.results [data-go="retry"]').catch(() => {});
  await sleep(500);
  await page.click('.choice[data-control="staging"][data-option="dropEmpty"]');
  await page.click('.choice[data-control="brake"][data-option="retro"]');
  await sleep(300);
  await page.click('.launch-bar .btn--primary');
  const hasSkip = await page.waitForSelector('.launch-overlay__skip', { timeout: 12000 }).then(() => true).catch(() => false);
  step('launch overlay with SKIP appears', hasSkip);
  const tClick = Date.now();
  if (hasSkip) { try { await page.click('.launch-overlay__skip'); } catch (e) { errors.push('skip click failed: ' + e); } }
  const skipped = await page.waitForSelector('.results', { timeout: 6000 }).then(() => true).catch(() => false);
  step('SKIP during launch reaches results quickly', skipped && (Date.now() - tClick) < 5000,
       `results=${skipped} afterSkip=${Date.now() - tClick}ms`);

  // --- campaign progression persisted ---
  await page.click('.results [data-go="missions"]').catch(() => {});
  await sleep(600);
  const after = await page.$$eval('.mission-card', els => els.map(e => ({
    done: e.className.includes('--done'), disabled: e.disabled })));
  step('mission 1 marked completed after win, mission 2 unlocked',
       after.length === 5 && after[0].done && !after[1].disabled, JSON.stringify(after.map(a => (a.done ? 'D' : (a.disabled ? 'L' : 'U')))));

  step('no console/page errors during full flow', errors.length === 0, errors.slice(0, 5).join(' | '));

  const failed = steps.filter(s => !s.ok).length;
  console.log(`\nGAMEFLOW: ${steps.length - failed} passed, ${failed} failed`);
  fs.writeFileSync(path.join(__dirname, 'gameflow.json'), JSON.stringify({ steps, errors }, null, 2));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
