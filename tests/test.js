/* Headless verification harness for Space-Max scene.js + style.css */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });   // screenshots land here
const BASE = process.env.BASE || 'http://127.0.0.1:8000';
const CLIPS = ['pad','countdown','ascent','stage','coast','orbit','deploy',
  'fail-thrust-low','fail-fuel-out','fail-power-short','fail-sensor-fault',
  'fail-stage-fail','fail-over-budget','fail-over-mass','event-recovered',
  'approach-moon','approach-mars','approach-saturn','landing','crew-exit',
  'rover-deploy','rover-drive','image-capture','data-uplink','skip-replay'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const result = { steps: [], consoleErrors: [], pageErrors: [], failedRequests: [] };
// Optional local copy of the pinned Three.js r128 build (faster + offline):
//   curl -o three.min.js https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js
const THREE_PATH = process.env.THREE_MIN || path.join(__dirname, 'three.min.js');
const THREE_LOCAL = fs.existsSync(THREE_PATH) ? fs.readFileSync(THREE_PATH) : null;

// Serve the pinned r128 build locally so the harness does not depend on CDN
// reachability mid-test (the repo page itself still requests cdnjs).
async function routeCDN(p) {
  if (!THREE_LOCAL) return;   // no local copy: page loads cdnjs directly (needs network)
  await p.setRequestInterception(true);
  p.on('request', req => {
    if (req.url().includes('three.js/r128/three.min.js')) {
      req.respond({ status: 200, contentType: 'application/javascript', body: THREE_LOCAL });
    } else { req.continue(); }
  });
}

function step(name, ok, detail) {
  result.steps.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium-browser',
    headless: 'new',
    args: ['--no-sandbox','--disable-gpu','--enable-unsafe-swiftshader',
           '--use-gl=angle','--use-angle=swiftshader','--window-size=1280,720']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await routeCDN(page);
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) result.consoleErrors.push(m.text()); });
  page.on('pageerror', e => result.pageErrors.push(String(e)));
  page.on('requestfailed', r => result.failedRequests.push(r.url() + ' :: ' + (r.failure()||{}).errorText));
  page.on('response', r => { if (r.status() >= 400 && !r.url().includes('favicon')) result.failedRequests.push(r.url() + ' :: HTTP ' + r.status()); });

  // ---------- 1. Preview lab page ----------
  await page.goto(BASE + '/?visualPreview=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);

  const threeOK = await page.evaluate(() => typeof window.THREE !== 'undefined');
  step('THREE r128 loaded from CDN', threeOK);

  const webglOK = await page.evaluate(() => {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  });
  step('WebGL available in headless browser', webglOK);

  const canvasCount = await page.$$eval('#scene canvas', els => els.length);
  step('exactly one canvas in #scene', canvasCount === 1, `count=${canvasCount}`);

  const errVisible = await page.$eval('.smg-error', el => el.offsetParent !== null || el.classList.contains('is-visible')).catch(() => 'missing');
  step('no .smg-error shown', !errVisible);

  const previewVisible = await page.$eval('.smg-preview', el => !el.hasAttribute('hidden'));
  step('preview lab visible with ?visualPreview=1', previewVisible);

  const clipBtns = await page.$$eval('.smg-preview__btn[data-clip]', els => els.map(e => e.getAttribute('data-clip')));
  const missing = CLIPS.filter(c => !clipBtns.includes(c));
  step('all 25 clip buttons present', missing.length === 0, missing.length ? 'missing: ' + missing.join(',') : `count=${clipBtns.length}`);

  const banner = await page.$eval('.smg-preview__banner', el => el.textContent.trim());
  step('preview banner text', banner === 'VISUAL PREVIEW — NOT A SIMULATION RESULT', JSON.stringify(banner));

  // init idempotency: init twice more via contract API
  await page.evaluate(() => {
    const el = document.getElementById('scene');
    SMG.scene.init(el);
    SMG.scene.init(el);
  });
  await sleep(500);
  const canvasAfterInit = await page.$$eval('#scene canvas', els => els.length);
  step('init() idempotent — still 1 canvas after 2 extra init calls', canvasAfterInit === 1, `count=${canvasAfterInit}`);

  // showPad with valid / partial / undefined builds
  const padOK = await page.evaluate(() => {
    try {
      SMG.scene.showPad({ engines: 3, fuel: 60 });
      SMG.scene.showPad({ engines: 1 });
      SMG.scene.showPad(undefined);
      SMG.scene.showPad(null);
      return true;
    } catch (e) { return String(e); }
  });
  step('showPad tolerant of valid/partial/null builds', padOK === true, padOK === true ? '' : padOK);

  await page.screenshot({ path: SHOTS + '/01-preview-idle.png' });

  // ---------- clip sweep: each clip starts, shows phase, no errors ----------
  const clipReport = [];
  for (const clip of CLIPS) {
    await page.evaluate(c => {
      document.querySelector(`.smg-preview__btn[data-clip="${c}"]`).click();
    }, clip);
    await sleep(1600);
    const state = await page.evaluate(() => ({
      phase: (document.querySelector('.smg-preview__phase') || {}).textContent || '',
      progress: (document.querySelector('.smg-preview__progress') || {}).style.width || '',
      alert: document.querySelector('.smg-alert.is-visible') ? document.querySelector('.smg-alert').textContent.trim().slice(0, 80) : '',
      card: document.querySelector('.smg-card.is-visible') ? document.querySelector('.smg-card').textContent.trim().slice(0, 60) : ''
    }));
    clipReport.push({ clip, ...state });
    // stop it before next clip (exercises real skip path every time)
    await page.evaluate(() => document.querySelector('.smg-preview__btn[data-action="stop"]').click());
    await sleep(400);
  }
  const deadClips = clipReport.filter(c => !c.phase || /STARTING|^\s*$/.test(c.phase));
  step('every clip reports a phase label', deadClips.length === 0,
       deadClips.length ? deadClips.map(c => c.clip + ':' + c.phase).join(' | ') : `ok x${clipReport.length}`);
  fs.writeFileSync(SHOTS + '/../clip-report.json', JSON.stringify(clipReport, null, 2));

  // failure alert check: wait for the alert to appear (it lands when the
  // failure phase plays, ~end of the ~13s preview clip) — poll, don't sample once
  await page.evaluate(() => document.querySelector('.smg-preview__btn[data-clip="fail-thrust-low"]').click());
  const failAlert = await page.waitForFunction(() => {
    const a = document.querySelector('.smg-alert.is-visible');
    return a && /failure/.test(a.className) ? a.textContent.trim().slice(0, 80) : false;
  }, { timeout: 18000, polling: 400 }).then(t => ({ text: t.jsonValue() })).catch(() => null);
  step('failure alert appears for fail-thrust-low', !!failAlert, failAlert ? JSON.stringify(failAlert) : 'never visible in 18s');
  await page.screenshot({ path: SHOTS + '/02-fail-thrust-low.png' });
  await page.evaluate(() => document.querySelector('.smg-preview__btn[data-action="stop"]').click());
  await sleep(600);

  // Mars approach card: poll for visibility anywhere in the clip window
  await page.evaluate(() => document.querySelector('.smg-preview__btn[data-clip="approach-mars"]').click());
  const card = await page.waitForFunction(() => {
    const c = document.querySelector('.smg-card.is-visible');
    return c ? c.textContent.trim() : false;
  }, { timeout: 15000, polling: 400 }).then(t => t.jsonValue()).catch(() => null);
  step('Mars transition card visible', !!card && /MARS/i.test(card), JSON.stringify(card));
  await page.screenshot({ path: SHOTS + '/03-approach-mars.png' });
  await page.evaluate(() => document.querySelector('.smg-preview__btn[data-action="stop"]').click());
  await sleep(500);

  // image capture card
  await page.evaluate(() => document.querySelector('.smg-preview__btn[data-clip="image-capture"]').click());
  const imgSeen = await page.waitForFunction(() => {
    const i = document.querySelector('.smg-image-card.is-visible');
    return !!(i && i.querySelector('img') && i.querySelector('img').getAttribute('src'));
  }, { timeout: 25000, polling: 500 }).then(() => true).catch(() => false);
  step('image-capture shows .smg-image-card with src', imgSeen);
  await page.screenshot({ path: SHOTS + '/04-image-capture.png' });
  await page.evaluate(() => document.querySelector('.smg-preview__btn[data-action="stop"]').click());
  await sleep(500);

  // ---------- 2. Contract tests (playLaunch / skip / onDone once) ----------
  // Every await inside page.evaluate gets an internal watchdog so a lost
  // onDone can never hang the whole harness silently.
  const nat = await page.evaluate(async () => {
    const mk = (phases) => ({ ok: true, timeline: phases.map((p, i) => ({ phase: p, time: i })), events: [] });
    const mission = { id: 't', name: 'Harness Mission', destinationName: 'Earth Orbit' };
    const t0 = performance.now();
    let calls = 0;
    let hung = false;
    await Promise.race([
      new Promise(res => SMG.scene.playLaunch(mk(['pad', 'ascent', 'orbit']), mission, () => { calls++; res(); })),
      new Promise(res => setTimeout(() => { hung = true; res(); }, 20000))
    ]);
    return { calls, hung, ms: Math.round(performance.now() - t0) };
  }).catch(e => ({ error: String(e) }));
  step('natural completion: onDone fired once, not hung', nat.calls === 1 && !nat.hung, JSON.stringify(nat));
  step('natural completion fires onDone exactly once', nat.calls === 1, JSON.stringify(nat));
  step('duration in 8-12s window (+2s tolerance)', nat.ms >= 7000 && nat.ms <= 14000, `ms=${nat.ms}`);

  const sk = await page.evaluate(async () => {
    const mk = () => ({ ok: true, timeline: [{ phase: 'pad', time: 0 }, { phase: 'ascent', time: 1 }], events: [] });
    const mission = { id: 't', name: 'Skip Mission' };
    let calls = 0;
    const t0 = performance.now();
    SMG.scene.playLaunch(mk(), mission, () => calls++);
    await new Promise(r => setTimeout(r, 800));
    SMG.scene.skip();
    await new Promise(r => setTimeout(r, 1200));
    const afterSkip = calls;
    SMG.scene.skip(); // harmless when idle
    await new Promise(r => setTimeout(r, 400));
    return { calls, afterSkip, total: calls, ms: Math.round(performance.now() - t0) };
  }).catch(e => ({ error: String(e) }));
  step('skip() fires onDone exactly once, double-skip harmless', sk.total === 1 && sk.afterSkip === 1, JSON.stringify(sk));

  const supersede = await page.evaluate(async () => {
    const mk = () => ({ ok: true, timeline: [{ phase: 'pad', time: 0 }, { phase: 'ascent', time: 1 }, { phase: 'orbit', time: 2 }], events: [] });
    const mission = { id: 't', name: 'Supersede' };
    let a = 0, b = 0;
    SMG.scene.playLaunch(mk(), mission, () => a++);
    await new Promise(r => setTimeout(r, 600));
    SMG.scene.playLaunch(mk(), mission, () => b++);
    // watchdog: wait for both callbacks, but never more than 20s total
    const t0 = Date.now();
    while ((a < 1 || b < 1) && Date.now() - t0 < 20000) await new Promise(r => setTimeout(r, 250));
    return { a, b, waitedMs: Date.now() - t0 };
  }).catch(e => ({ error: String(e) }));
  step('new run supersedes old: each onDone fires exactly once', supersede.a === 1 && supersede.b === 1, JSON.stringify(supersede));

  const blocked = await page.evaluate(async () => {
    const mk = () => ({ ok: false, failure: { type: 'over_budget', message: 'Over budget' }, timeline: [{ phase: 'pad', time: 0 }], events: [] });
    const mission = { id: 't', name: 'Blocked' };
    let calls = 0;
    let hung = false;
    const t0 = performance.now();
    await Promise.race([
      new Promise(res => SMG.scene.playLaunch(mk(), mission, () => { calls++; res(); })),
      new Promise(res => setTimeout(() => { hung = true; res(); }, 8000))
    ]);
    return { calls, hung, ms: Math.round(performance.now() - t0) };
  }).catch(e => ({ error: String(e) }));
  step('over_budget: no launch animation, immediate onDone', blocked.calls === 1 && blocked.ms < 3000 && !blocked.hung, JSON.stringify(blocked));

  // ---------- 3. Stability: 10 runs must not grow the DOM ----------
  const domBefore = await page.evaluate(() => document.getElementById('scene').querySelectorAll('*').length);
  for (let i = 0; i < 10; i++) {
    // rapid-replay pattern: start a run, interrupt it shortly after, restart
    await page.evaluate(async () => {
      const mk = () => ({ ok: true, timeline: [{ phase: 'pad', time: 0 }, { phase: 'ascent', time: 1 }], events: [] });
      const mission = { id: 't', name: 'Replay' };
      SMG.scene.playLaunch(mk(), mission, function () {});
      await new Promise(r => setTimeout(r, 400));
      SMG.scene.skip();
      await new Promise(r => setTimeout(r, 150));
    });
  }
  const domAfter = await page.evaluate(() => document.getElementById('scene').querySelectorAll('*').length);
  const canvasFinal = await page.$$eval('#scene canvas', els => els.length);
  step('10 replays: DOM nodes stable', domAfter <= domBefore + 5, `before=${domBefore} after=${domAfter}`);
  step('10 replays: still 1 canvas', canvasFinal === 1, `count=${canvasFinal}`);

  // ---------- 4. Normal page (no query param) ----------
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 1280, height: 720 });
  await routeCDN(page2);
  const p2errors = [];
  page2.on('pageerror', e => p2errors.push(String(e)));
  page2.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) p2errors.push(m.text()); });
  await page2.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  const previewHidden = await page2.$eval('.smg-preview', el => el.hasAttribute('hidden')).catch(() => 'missing');
  step('normal play: preview lab absent or hidden', previewHidden === true || previewHidden === 'missing', String(previewHidden));
  const uiText = await page2.$eval('#app', el => el.textContent.trim().slice(0, 120));
  step('campaign screen renders (real ui.js)', /Space Missions/i.test(uiText), JSON.stringify(uiText));
  const normalCards = await page2.$$eval('.mission-card', els => els.length);
  step('campaign: 5 mission cards on normal page', normalCards === 5, `count=${normalCards}`);
  const normalCanvas = await page2.$$eval('#scene canvas', els => els.length);
  step('normal play: ui.js initialized the scene (1 canvas)', normalCanvas === 1, `count=${normalCanvas}`);
  await page2.screenshot({ path: SHOTS + '/05-normal-play.png' });
  step('normal page: no console/page errors', p2errors.length === 0, p2errors.slice(0, 5).join(' | '));

  // ---------- summary ----------
  result.summary = {
    passed: result.steps.filter(s => s.ok).length,
    failed: result.steps.filter(s => !s.ok).length,
    consoleErrors: result.consoleErrors.slice(0, 10),
    pageErrors: result.pageErrors.slice(0, 10),
    failedRequests: result.failedRequests.slice(0, 10)
  };
  console.log('\n==== SUMMARY ====');
  console.log(JSON.stringify(result.summary, null, 2));
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(result, null, 2));

  await browser.close();
  process.exit(result.summary.failed > 0 || result.pageErrors.length > 0 ? 1 : 0);
}

main().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
