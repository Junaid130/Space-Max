/* Why did SKIP take ~11.9s? Inspect overlay, hit-testing, and handler effect. */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
// Optional local copy of the pinned Three.js r128 build (faster + offline):
//   curl -o three.min.js https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js
const THREE_PATH = process.env.THREE_MIN || path.join(__dirname, 'three.min.js');
const THREE_LOCAL = fs.existsSync(THREE_PATH) ? fs.readFileSync(THREE_PATH) : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/chromium-browser', headless: 'new',
    args: ['--no-sandbox','--disable-gpu','--enable-unsafe-swiftshader',
           '--use-gl=angle','--use-angle=swiftshader',
           '--disable-background-timer-throttling','--disable-renderer-backgrounding']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  if (THREE_LOCAL) {
    await page.setRequestInterception(true);
    page.on('request', r => r.url().includes('three.js/r128/three.min.js')
      ? r.respond({ status: 200, contentType: 'application/javascript', body: THREE_LOCAL }) : r.continue());
  }
  page.on('pageerror', e => console.log('PAGEERROR', String(e)));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) console.log('CONSOLE', m.text()); });

  await page.goto((process.env.BASE || 'http://127.0.0.1:8000') + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.removeItem('smg_progress'); } catch (e) {} });
  await page.goto((process.env.BASE || 'http://127.0.0.1:8000') + '/', { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  await page.click('.mission-card:not([disabled])'); await sleep(400);
  await page.click('.briefing .btn--primary'); await sleep(400);
  await page.click('.choice[data-control="staging"][data-option="dropEmpty"]');
  await page.click('.choice[data-control="brake"][data-option="retro"]'); await sleep(300);

  const t0 = Date.now();
  await page.click('.launch-bar .btn--primary');

  // wait for overlay
  const overlayAt = Date.now();
  const hasOverlay = await page.waitForSelector('.launch-overlay__skip', { timeout: 5000 })
    .then(() => true).catch(() => false);
  console.log('overlay appeared:', hasOverlay, 'after', Date.now() - overlayAt, 'ms');

  if (hasOverlay) {
    await sleep(500);
    const probe = await page.evaluate(() => {
      const b = document.querySelector('.launch-overlay__skip');
      const r = b.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      const cs = getComputedStyle(b);
      return {
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        topIsButton: top === b || (top && b.contains(top)),
        topEl: top ? (top.tagName + '.' + String(top.className).slice(0, 60)) : 'null',
        pe: cs.pointerEvents, vis: cs.visibility, disp: cs.display, z: cs.zIndex,
        appPE: getComputedStyle(document.getElementById('app')).pointerEvents
      };
    });
    console.log('probe:', JSON.stringify(probe));

    const clickT = Date.now();
    let clickErr = null;
    try { await page.click('.launch-overlay__skip'); }
    catch (e) { clickErr = String(e); }
    console.log('page.click done', clickErr ? 'ERROR ' + clickErr : 'ok', 'at +' + (Date.now() - t0) + 'ms');

    const resultsFast = await page.waitForSelector('.results', { timeout: 4000 }).then(() => true).catch(() => false);
    console.log('results within 4s of click:', resultsFast, 'at +' + (Date.now() - t0) + 'ms');

    if (!resultsFast) {
      // fallback: direct JS click to isolate hit-testing vs handler
      const direct = await page.evaluate(() => {
        const b = document.querySelector('.launch-overlay__skip');
        if (!b) return 'no button';
        b.click(); return 'clicked';
      });
      const r2 = await page.waitForSelector('.results', { timeout: 4000 }).then(() => true).catch(() => false);
      console.log('direct JS click:', direct, '→ results:', r2, 'at +' + (Date.now() - t0) + 'ms');
    }
  } else {
    console.log('screen state:', await page.evaluate(() => {
      const a = document.getElementById('app');
      return a ? a.innerHTML.slice(0, 200) : 'no #app';
    }));
  }
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(1); });
