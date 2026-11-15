/* Diagnose: is rAF throttled in headless, or is the scene's clock slow? */
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
    executablePath: '/usr/bin/chromium-browser', headless: 'new',
    args: ['--no-sandbox','--disable-gpu','--enable-unsafe-swiftshader',
           '--use-gl=angle','--use-angle=swiftshader',
           '--disable-background-timer-throttling','--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  if (THREE_LOCAL) {
    await page.setRequestInterception(true);
    page.on('request', r => r.url().includes('three.js/r128')
      ? r.respond({ status: 200, contentType: 'application/javascript', body: THREE_LOCAL }) : r.continue());
  }
  page.on('pageerror', e => console.log('PAGEERROR', String(e)));
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });

  await page.goto((process.env.BASE || 'http://127.0.0.1:8000') + '/?visualPreview=1', { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  const raf = await page.evaluate(() => new Promise(res => {
    let n = 0; const t0 = performance.now();
    const f = () => { n++;
      if (performance.now() - t0 < 1500) requestAnimationFrame(f);
      else res({ fps: +(n / ((performance.now() - t0) / 1000)).toFixed(1),
                 hidden: document.hidden, vis: document.visibilityState }); };
    requestAnimationFrame(f);
  }));
  console.log('RAF:', JSON.stringify(raf));

  // Start a success launch; sample scene DOM progression every 500ms
  const samples = await page.evaluate(async () => {
    const out = [];
    let done = 0;
    const mk = { ok: true, timeline: [{ phase: 'pad', time: 0 }, { phase: 'ascent', time: 1 }, { phase: 'orbit', time: 2 }], events: [] };
    SMG.scene.playLaunch(mk, { id: 't', name: 'Diag' }, () => done++);
    const t0 = performance.now();
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      const cd = document.querySelector('.smg-countdown');
      const ph = document.querySelector('.smg-preview__phase');
      const pg = document.querySelector('.smg-preview__progress');
      const al = document.querySelector('.smg-alert');
      out.push({ t: Math.round(performance.now() - t0), done,
        cd: cd ? (cd.className.includes('is-visible') ? cd.textContent.trim().slice(0,4) : '-') : 'n/a',
        phase: ph ? ph.textContent.trim().slice(0, 24) : '',
        prog: pg ? pg.style.width : '',
        alert: al && al.className.includes('is-visible') ? al.textContent.trim().slice(0, 30) : '-' });
    }
    return out;
  });
  samples.forEach(s => console.log(JSON.stringify(s)));
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(1); });
