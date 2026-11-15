

// ---------------------------------------------------------------------------
// js/scene.js -- 3D scene, launch cinematics & planetary sequences
//
// Public contract (the ONLY methods exposed on SMG.scene):
//
//   SMG.scene.init(containerEl)            idempotent: one renderer, one canvas,
//                                          one RAF loop, one resize observer
//   SMG.scene.showPad(build)               idle rocket on the pad; engine/nozzle
//                                          count and fuel presentation come from
//                                          `build` (never invented, never mutated)
//   SMG.scene.playLaunch(outcome, mission, onDone)
//                                          visualises outcome.timeline /
//                                          outcome.failure / outcome.events;
//                                          calls onDone EXACTLY once per run
//   SMG.scene.skip()                       cancel the active run, settle to a
//                                          stable state, fire its onDone once;
//                                          harmless when idle
//
// SIMULATION BOUNDARY (non-negotiable):
//   The scene NEVER computes thrust, mass, fuel, altitude, orbital insertion,
//   success, failure or score. It never calls SMG.sim.launch() (it does not even
//   reference SMG.sim). It never mutates the supplied `outcome` or `mission`
//   objects and never awards points or touches saved progress. It only reads
//   outcome.timeline (sequence + timing), outcome.failure (type + numbers),
//   outcome.events (recovered-event flashes) and mission/SMG.data (names and
//   copy when those fields exist). Missing values are omitted from labels --
//   never printed as undefined/NaN/fabricated numbers.
//
// Environment facts this file is written against:
//   * Three.js r128 GLOBAL build via CDN (window.THREE), no bundler, no modules.
//   * GLTFLoader may or may not be present: `hasGLTF` guards every use; without
//     it we use intentional primitive fallbacks + console.warn.
//   * GSAP may or may not be present: `HAS_GSAP` only routes inline DOM opacity
//     work to gsap when it exists, token-guarded.
//   * r128-only colour API: outputEncoding / texture.encoding = sRGBEncoding,
//     ACESFilmicToneMapping, PCFSoftShadowMap.
//   * Filenames in 3dmodels/ contain spaces + parentheses -> encodeURI() always.
// ---------------------------------------------------------------------------

window.SMG = window.SMG || {};

SMG.scene = (function () {
  'use strict';

  // --- Constants & asset manifest ------------------------------------------
  var ASSETS = {
    textures: {
      earthMap: '3dmodels/images.jpeg',
      saturnMap: '3dmodels/saturn.jpeg',
      moonPhoto: '3dmodels/moon.jpeg',
      marsPhoto: '3dmodels/mars.jpeg'
    },
    models: {
      rocketSaturnV: '3dmodels/Saturn V.glb',
      landerLM: '3dmodels/Apollo Lunar Module.glb',
      station: '3dmodels/Gateway Core.glb',
      satTDRS: '3dmodels/Tracking and Data Relay Satellites (TDRS) (A).glb',
             satCubeSat: '3dmodels/CubeSat - ICECube.glb',
             satMGS: '3dmodels/Mars Global Surveyor.glb',
             satICON: '3dmodels/Ionospheric Connection Explorer (ICON).glb',
             satEO1: '3dmodels/Earth Observing-1 (EO-1).glb',
             satChandra: '3dmodels/Chandra X-ray Observatory.glb',
             satLandsat: '3dmodels/Landsat 8.glb'
    },
    pending: {
      roverMars: '3dmodels/Mars_Rover.glb',
      roverMoon: '3dmodels/Lunar_Rover.glb',
      astronaut: '3dmodels/Astronaut.glb'
    },
    missingNow: ['3dmodels/Mars_Rover.glb', '3dmodels/Lunar_Rover.glb', '3dmodels/Astronaut.glb']
  };

  var TOTAL_LAUNCH = 10.0;
  var COUNTDOWN_DUR = 2.6;
  var NOZZLE_CAP = 7;
  var PAD_Y = 2.2;
  var ROCKET_SPLIT_Y = 5.55;
  var SATURN_TARGET_H = 14.8;
  var PREVIEW_TIME_SCALE = 0.75;
  var BASE_FOV = 52;

  var CLIPS = [
    { id: 'pad', label: 'Idle Pad' },
    { id: 'countdown', label: 'Countdown' },
    { id: 'ascent', label: 'Ascent' },
    { id: 'stage', label: 'Stage Separation' },
    { id: 'coast', label: 'Coast' },
    { id: 'orbit', label: 'Orbit Pullback' },
    { id: 'deploy', label: 'Payload Deploy' },
    { id: 'fail-thrust-low', label: 'Fail: Thrust Low' },
    { id: 'fail-fuel-out', label: 'Fail: Fuel Out' },
    { id: 'fail-power-short', label: 'Fail: Power Short' },
    { id: 'fail-sensor-fault', label: 'Fail: Sensor Fault' },
    { id: 'fail-stage-fail', label: 'Fail: Stage Fail' },
    { id: 'fail-over-budget', label: 'Fail: Over Budget' },
    { id: 'fail-over-mass', label: 'Fail: Over Mass' },
    { id: 'event-recovered', label: 'Recovered Event' },
    { id: 'approach-moon', label: 'Approach: Moon' },
    { id: 'approach-mars', label: 'Approach: Mars' },
    { id: 'approach-saturn', label: 'Approach: Saturn' },
    { id: 'landing', label: 'Landing + Dust' },
    { id: 'crew-exit', label: 'Crew Exit' },
    { id: 'rover-deploy', label: 'Rover Deploy' },
    { id: 'rover-drive', label: 'Rover Drive' },
    { id: 'image-capture', label: 'Image Capture' },
    { id: 'data-uplink', label: 'Data Uplink' },
    { id: 'skip-replay', label: 'Skip + Replay' }
  ];

  // --- State ----------------------------------------------------------------
  var initialized = false;
  var THREEOK = false;
  var hasGLTF = false;
  var HAS_GSAP = false;
  var webglOK = false;
  var reducedMotion = false;
  var mediaQuery = null;

  var container = null;
  var renderer = null;
  var scene = null;
  var camera = null;
  var rafId = 0;
  var lastFrameTime = 0;
  var resizeObserver = null;
  var windowResizeHandler = null;
  var elapsedWall = 0;
  var cryoTimer = 0;

  var dom = null;
  var preview = null;
  var previewEnabled = false;
  var previewCurrentClip = null;
  var pendingPreviewRun = null;

  var world = {};
  var rocket = {};
  var surface = {};
  var effects = {};
  var textures = {};
  var gltfTemplates = {};
  var terrainCtx = {};

  var tweens = [];
  var inlineEls = [];
  var runToken = 0;
  var activeRun = null;
  var finishing = false;
  var idleActive = false;
  var cameraBlend = null;
  var assetIssues = [];
  var assetIssueSeen = {};

  // Zero-allocation per-frame scratch state
  var scratchR = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, lookAt: null };
  var scratchC = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, fov: BASE_FOV };
  var scratchDrift = { x: 0, y: 0, z: 0 };
  var camTX = 0, camTY = 7, camTZ = 0;
  var camSmooth = { ready: false, x: 21, y: 12, z: 31, tx: 0, ty: 7, tz: 0, fov: BASE_FOV };
  var scratchColorA = null;
  var scratchColorB = null;
  var scratchVecA = null;

  // --- Utilities ------------------------------------------------------------
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clamp01(v) { return clamp(v, 0, 1); }
  function lerp(a, b, u) { return a + (b - a) * u; }
  function easeSoft(u) { u = clamp01(u); return lerp(u, u * u * (3 - 2 * u), 0.72); }
  function easeOutCubic(u) { u = clamp01(u); var k = 1 - u; return 1 - k * k * k; }
  function easeInQuad(u) { u = clamp01(u); return u * u; }
  function easeOutQuad(u) { u = clamp01(u); return 1 - (1 - u) * (1 - u); }
  function easeInOut(u) { u = clamp01(u); return u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u); }
  function wobble(x) {
    return Math.sin(x) * 0.55 + Math.sin(x * 2.13 + 1.7) * 0.3 + Math.sin(x * 4.7 + 0.4) * 0.15;
  }
  function fmtNum(v) { return isNum(v) ? String(Math.round(v * 100) / 100) : ''; }
  function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : ''; }
  function humanizeType(t) {
    return String(t || '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
  }
  function encodePath(p) { try { return encodeURI(p); } catch (e) { return p; } }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeNoise2(seed) {
    var rand = mulberry32(seed);
    var perm = new Float32Array(512);
    for (var i = 0; i < 512; i++) perm[i] = rand();
    function at(ix, iy) {
      var h = (ix * 374761393 + iy * 668265263) ^ (ix << 13);
      h = (h ^ (h >>> 13)) >>> 0;
      return perm[h & 511];
    }
    return function noise(x, y) {
      var x0 = Math.floor(x), y0 = Math.floor(y);
      var fx = x - x0, fy = y - y0;
      var ux = fx * fx * (3 - 2 * fx);
      var uy = fy * fy * (3 - 2 * fy);
      return lerp(lerp(at(x0, y0), at(x0 + 1, y0), ux), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), ux), uy);
    };
  }

  function fbm(noise, x, y, octaves) {
    var amp = 1, freq = 1, sum = 0, norm = 0;
    for (var i = 0; i < octaves; i++) {
      sum += noise(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5; freq *= 2.03;
    }
    return sum / (norm || 1);
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function canvasTexture(c) {
    var tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 4;
    return tex;
  }

  function srgb(hex) { return new THREE.Color(hex).convertSRGBToLinear(); }

  // --- Locale table ---------------------------------------------------------
  var LOCALES = {
    earth: {
      terrain: 'earth',
      sky: ['#0b2a52', '#2f6ba8', '#83b7e2', '#cfe3ee'],
      bg: 0x9fc0da,
      fog: 0xb4cbdd, fogNear: 150, fogFar: 520,
      hemiSky: 0xbcd8f5, hemiGround: 0x5a4c36, hemiI: 0.46,
      ambI: 0.16,
      keyColor: 0xfff2dc, keyI: 1.12,
      fillColor: 0x86b0e2, fillI: 0.28,
      rimColor: 0xa8dcff, rimI: 0.22,
      dust: 0xb59a72,
      stars: false,
      exposure: 0.94
    },
    moon: {
      terrain: 'moon',
      sky: ['#000000', '#000002', '#020307', '#04060c'],
      bg: 0x020307,
      fog: 0x04060c, fogNear: 120, fogFar: 460,
      hemiSky: 0x94a4bd, hemiGround: 0x24262b, hemiI: 0.26,
      ambI: 0.12,
      keyColor: 0xfff8ef, keyI: 1.24,
      fillColor: 0x7d90ad, fillI: 0.14,
      rimColor: 0x9cc7ff, rimI: 0.2,
      dust: 0xc2c7cf,
      stars: true,
      exposure: 0.86
    },
    mars: {
      terrain: 'mars',
      sky: ['#2a1410', '#5c2a1c', '#a2583a', '#d99b6f'],
      bg: 0x8a4a30,
      fog: 0xb06f48, fogNear: 85, fogFar: 350,
      hemiSky: 0xe0a075, hemiGround: 0x4a2417, hemiI: 0.45,
      ambI: 0.16,
      keyColor: 0xffd9b0, keyI: 1.16,
      fillColor: 0xcc8a5f, fillI: 0.3,
      rimColor: 0xffb27a, rimI: 0.22,
      dust: 0xb87a52,
      stars: false,
      exposure: 0.92
    },
    space: {
      terrain: null,
      sky: ['#000000', '#000001', '#010205', '#02040a'],
      bg: 0x010205,
      fog: null, fogNear: 0, fogFar: 0,
      hemiSky: 0x8fb2e0, hemiGround: 0x0a1020, hemiI: 0.28,
      ambI: 0.14,
      keyColor: 0xffffff, keyI: 1.08,
      fillColor: 0x6f8dbf, fillI: 0.22,
      rimColor: 0x7fd2ff, rimI: 0.3,
      dust: 0xbfc7d4,
      stars: true,
      exposure: 0.96
    }
  };
  var currentLocale = 'earth';
  var PLANET_VISIBILITY = {
    earth: { earth: false, moon: true, mars: false, saturn: false },
    moon: { earth: true, moon: false, mars: false, saturn: false },
    mars: { earth: true, moon: false, mars: false, saturn: false },
    space: { earth: true, moon: true, mars: true, saturn: true }
  };

  // --- Tween system ---------------------------------------------------------
  function addTween(opts) {
    var tw = {
      t: -(opts.delay || 0),
             dur: opts.dur > 0 ? opts.dur : 0.0001,
             from: isNum(opts.from) ? opts.from : 0,
             to: isNum(opts.to) ? opts.to : 0,
             ease: typeof opts.ease === 'function' ? opts.ease : easeInOut,
             onUpdate: opts.onUpdate || null,
             onComplete: opts.onComplete || null,
             token: opts.token === undefined ? null : opts.token,
             cancelled: false
    };
    tweens.push(tw);
    return tw;
  }

  function updateTweens(dt) {
    for (var i = tweens.length - 1; i >= 0; i--) {
      var tw = tweens[i];
      if (!tw) continue;
      if (tw.cancelled || (tw.token !== null && tw.token !== runToken)) {
        if (tweens[i] === tw) tweens.splice(i, 1);
        continue;
      }
      tw.t += dt;
      var local = tw.t > 0 ? tw.t : 0;
      var u = clamp01(local / tw.dur);
      if (tw.onUpdate) {
        try { tw.onUpdate(lerp(tw.from, tw.to, tw.ease(u)), u); }
        catch (e) { console.warn('[scene] tween update error:', e); }
      }
      if (tw.t >= tw.dur) {
        if (tweens[i] === tw) tweens.splice(i, 1);
        if (tw.onComplete) {
          try { tw.onComplete(); }
          catch (e2) { console.warn('[scene] tween complete error:', e2); }
        }
      }
    }
  }

  function killTweens() {
    for (var i = 0; i < tweens.length; i++) if (tweens[i]) tweens[i].cancelled = true;
    tweens.length = 0;
    clearInlineOpacity();
  }

  function currentOpacity(el) {
    var v = parseFloat(window.getComputedStyle ? window.getComputedStyle(el).opacity : '1');
    return isNum(v) ? v : 1;
  }
  function trackInline(el) { if (inlineEls.indexOf(el) === -1) inlineEls.push(el); }
  function clearInlineOpacity() {
    for (var i = 0; i < inlineEls.length; i++) {
      var el = inlineEls[i];
      if (!el) continue;
      if (HAS_GSAP && typeof gsap !== 'undefined') {
        try { gsap.killTweensOf(el); } catch (e) { /* ignore */ }
      }
      el.style.opacity = '';
    }
    inlineEls.length = 0;
  }
  function fadeInline(el, to, dur, token, onDone) {
    if (!el) { if (onDone) onDone(); return; }
    trackInline(el);
    var done = function () {
      var idx = inlineEls.indexOf(el);
      if (idx !== -1) inlineEls.splice(idx, 1);
      el.style.opacity = '';
      if (onDone) onDone();
    };
      if (HAS_GSAP && typeof gsap !== 'undefined') {
        try {
          gsap.to(el, {
            opacity: to, duration: dur, ease: 'sine.inOut', overwrite: true,
            onComplete: function () { done(); }
          });
          return;
        } catch (e) { /* fall through */ }
      }
      addTween({
        from: currentOpacity(el), to: to, dur: dur, token: token,
               onUpdate: function (v) { el.style.opacity = String(v); },
               onComplete: done
      });
  }
  function pulseInline(el, token, dur) {
    if (!el || reducedMotion) return;
    dur = dur || 1.4;
    fadeInline(el, 0.55, dur / 2, token, function () { fadeInline(el, 1, dur / 2, token, null); });
  }

  // --- DOM overlay ----------------------------------------------------------
  function createOverlay(root) {
    var wrap = document.createElement('div');
    wrap.className = 'smg-overlay';
    wrap.setAttribute('aria-live', 'polite');
    wrap.innerHTML =
    '<div class="smg-countdown"></div>' +
    '<div class="smg-card">' +
    '<span class="smg-card__kicker"></span>' +
    '<span class="smg-card__title"></span>' +
    '</div>' +
    '<div class="smg-alert">' +
    '<span class="smg-alert__title"></span>' +
    '<span class="smg-alert__detail"></span>' +
    '</div>' +
    '<figure class="smg-image-card">' +
    '<img class="smg-image-card__img" alt="">' +
    '<figcaption class="smg-image-card__caption"></figcaption>' +
    '</figure>' +
    '<div class="smg-uplink">' +
    '<span class="smg-uplink__dot"></span>' +
    '<span class="smg-uplink__label">MISSION CONTROL</span>' +
    '</div>' +
    '<div class="smg-error" hidden></div>';
    root.appendChild(wrap);

    dom = {
      root: wrap,
      countdown: wrap.querySelector('.smg-countdown'),
             card: wrap.querySelector('.smg-card'),
             cardKicker: wrap.querySelector('.smg-card__kicker'),
             cardTitle: wrap.querySelector('.smg-card__title'),
             alert: wrap.querySelector('.smg-alert'),
             alertTitle: wrap.querySelector('.smg-alert__title'),
             alertDetail: wrap.querySelector('.smg-alert__detail'),
             imageCard: wrap.querySelector('.smg-image-card'),
             image: wrap.querySelector('.smg-image-card__img'),
             imageCaption: wrap.querySelector('.smg-image-card__caption'),
             uplink: wrap.querySelector('.smg-uplink'),
             uplinkDot: wrap.querySelector('.smg-uplink__dot'),
             error: wrap.querySelector('.smg-error')
    };

    if (dom.image) {
      dom.image.addEventListener('error', function () {
        noteAssetIssue('Surface photo unavailable: ' + ASSETS.textures.marsPhoto + ' (image card hidden)');
        if (dom.imageCard) dom.imageCard.classList.remove('is-visible');
      });
    }
  }

  function showCountdown(text) {
    if (!dom || !dom.countdown) return;
    if (dom.countdown.textContent !== text) dom.countdown.textContent = text;
    dom.countdown.classList.remove('is-visible');
    void dom.countdown.offsetHeight;
    dom.countdown.classList.add('is-visible');
  }
  function hideCountdown() {
    if (dom && dom.countdown) {
      dom.countdown.classList.remove('is-visible');
      dom.countdown.textContent = '';
    }
  }
  function showCard(kicker, title) {
    if (!dom || !dom.card) return;
    if (dom.cardKicker) dom.cardKicker.textContent = kicker || '';
    if (dom.cardTitle) dom.cardTitle.textContent = title || '';
    dom.card.classList.add('is-visible');
  }
  function hideCard() {
    if (dom && dom.card) {
      dom.card.classList.remove('is-visible');
      if (dom.cardKicker) dom.cardKicker.textContent = '';
      if (dom.cardTitle) dom.cardTitle.textContent = '';
    }
  }
  function showAlert(kind, title, detail) {
    if (!dom || !dom.alert) return;
    var cls = 'smg-alert';
    if (kind === 'failure') cls += ' smg-alert--failure';
    else if (kind === 'warning') cls += ' smg-alert--warning';
    dom.alert.className = cls;
    if (dom.alertTitle) dom.alertTitle.textContent = title || '';
    if (dom.alertDetail) dom.alertDetail.textContent = detail || '';
    if (dom.alertDetail) dom.alertDetail.hidden = !detail;
    dom.alert.classList.add('is-visible');
  }
  function hideAlert() {
    if (!dom || !dom.alert) return;
    dom.alert.classList.remove('is-visible');
    dom.alert.className = 'smg-alert';
    if (dom.alertTitle) dom.alertTitle.textContent = '';
    if (dom.alertDetail) { dom.alertDetail.textContent = ''; dom.alertDetail.hidden = false; }
    dom.alert.style.opacity = '';
  }
  function showImageCard(src, caption) {
    if (!dom || !dom.imageCard || !dom.image) return;
    if (src) dom.image.src = src;
    if (dom.imageCaption) dom.imageCaption.textContent = caption || '';
    dom.imageCard.classList.add('is-visible');
  }
  function hideImageCard() {
    if (!dom || !dom.imageCard) return;
    dom.imageCard.classList.remove('is-visible');
    if (dom.image) dom.image.removeAttribute('src');
    if (dom.imageCaption) dom.imageCaption.textContent = '';
  }
  function showUplink() { if (dom && dom.uplink) dom.uplink.classList.add('is-visible'); }
  function hideUplink() { if (dom && dom.uplink) dom.uplink.classList.remove('is-visible'); }
  function showError(msg) {
    if (!dom || !dom.error) return;
    dom.error.textContent = msg || '';
    if (msg) dom.error.removeAttribute('hidden');
    else dom.error.setAttribute('hidden', '');
  }
  function clearTransientOverlays() { hideCountdown(); hideCard(); hideUplink(); }
  function clearAllOverlays() { clearTransientOverlays(); hideAlert(); hideImageCard(); }

  function noteAssetIssue(msg) {
    if (!msg || assetIssueSeen[msg]) return;
    assetIssueSeen[msg] = true;
    assetIssues.push(msg);
    console.warn('[scene] ' + msg);
    if (preview && preview.warn) {
      preview.warn.textContent = assetIssues.join('  |  ');
      preview.warn.removeAttribute('hidden');
    }
  }

  // --- Renderer -------------------------------------------------------------
  function initRenderer(root) {
    if (!THREEOK) return false;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.localClippingEnabled = true;
      var canvas = renderer.domElement;
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      root.appendChild(canvas);
      webglOK = true;
      return true;
    } catch (e) {
      renderer = null;
      webglOK = false;
      console.warn('[scene] WebGL init failed:', e);
      return false;
    }
  }

  function onResize() {
    if (!container) return;
    var w = container.clientWidth || window.innerWidth || 1;
    var h = container.clientHeight || window.innerHeight || 1;
    if (renderer) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
    }
    if (camera) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  // --- World ----------------------------------------------------------------
  function createWorld() {
    scratchColorA = new THREE.Color();
    scratchColorB = new THREE.Color();
    scratchVecA = new THREE.Vector3();

    scene = new THREE.Scene();
    scene.background = srgb(0x05070f);

    camera = new THREE.PerspectiveCamera(BASE_FOV, 16 / 9, 0.5, 6500);
    camera.position.set(21, 12, 31);
    camera.lookAt(0, 7, 0);
    scene.add(camera);

    createLights();
    makeStarfield();
    createSky();
    createPlanets();
    createOrbitProps();
    createTerrains();
    createPad();
    createSurface();
    createEffects();
    buildRocket();
    applyLocale('earth');
  }

  function createLights() {
    world.hemi = new THREE.HemisphereLight(0xbcd8f5, 0x6a5b42, 0.72);
    scene.add(world.hemi);

    world.ambient = new THREE.AmbientLight(0x2b3a5e, 0.28);
    scene.add(world.ambient);

    world.key = new THREE.DirectionalLight(0xfff2dc, 1.5);
    world.key.position.set(520, 640, 380);
    world.key.castShadow = true;
    world.key.shadow.mapSize.set(2048, 2048);
    world.key.shadow.camera.near = 40;
    world.key.shadow.camera.far = 2200;
    world.key.shadow.camera.left = -150;
    world.key.shadow.camera.right = 150;
    world.key.shadow.camera.top = 150;
    world.key.shadow.camera.bottom = -150;
    world.key.shadow.bias = -0.0004;
    world.key.shadow.normalBias = 0.02;
    scene.add(world.key);
    scene.add(world.key.target);
    world.key.target.position.set(0, 0, 0);

    world.fill = new THREE.DirectionalLight(0x86b0e2, 0.3);
    world.fill.position.set(-420, 180, -260);
    scene.add(world.fill);

    world.rim = new THREE.DirectionalLight(0xa8dcff, 0.22);
    world.rim.position.set(140, -160, -520);
    scene.add(world.rim);
  }

  function makeStarfield() {
    var count = reducedMotion ? 900 : 1800;
    var positions = new Float32Array(count * 3);
    var colors = new Float32Array(count * 3);
    var rand = mulberry32(1969);
    for (var i = 0; i < count; i++) {
      var u = rand() * 2 - 1;
      var theta = rand() * Math.PI * 2;
      var r = 2400 + rand() * 2200;
      var s = Math.sqrt(1 - u * u);
      positions[i * 3] = Math.cos(theta) * s * r;
      positions[i * 3 + 1] = u * r * 0.8 + 380;
      positions[i * 3 + 2] = Math.sin(theta) * s * r;
      var tint = 0.72 + rand() * 0.28;
      var warm = rand();
      colors[i * 3] = tint * (warm > 0.84 ? 1.0 : 0.9);
      colors[i * 3 + 1] = tint * 0.94;
      colors[i * 3 + 2] = Math.min(1, tint + (warm < 0.18 ? 0.18 : 0.07));
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    world.stars = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 3.5, sizeAttenuation: true, vertexColors: true,
      transparent: true, opacity: 0.92, depthWrite: false, fog: false
    }));
    world.stars.frustumCulled = false;
    scene.add(world.stars);

    var count2 = reducedMotion ? 600 : 2800;
    var pos2 = new Float32Array(count2 * 3);
    for (var j = 0; j < count2; j++) {
      var u2 = rand() * 2 - 1;
      var th2 = rand() * Math.PI * 2;
      var r2 = 1800 + rand() * 2600;
      var s2 = Math.sqrt(1 - u2 * u2);
      pos2[j * 3] = Math.cos(th2) * s2 * r2;
      pos2[j * 3 + 1] = u2 * r2 * 0.85 + 340;
      pos2[j * 3 + 2] = Math.sin(th2) * s2 * r2;
    }
    var geo2 = new THREE.BufferGeometry();
    geo2.setAttribute('position', new THREE.BufferAttribute(pos2, 3));
    world.stars2 = new THREE.Points(geo2, new THREE.PointsMaterial({
      size: 1.6, sizeAttenuation: true, color: srgb(0xcfd9ff),
                                                                   transparent: true, opacity: 0.56, depthWrite: false, fog: false
    }));
    world.stars2.frustumCulled = false;
    scene.add(world.stars2);
  }

  // --- Sky dome (GLSL gradient + smooth space transition) -------------------
  function createSky() {
    var geo = new THREE.SphereGeometry(4300, 36, 24);
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: srgb(0x0b2a52) },
                                       uMid: { value: srgb(0x2f6ba8) },
                                       uLow: { value: srgb(0x83b7e2) },
                                       uHoriz: { value: srgb(0xcfe3ee) },
                                       uSpaceMix: { value: 0.0 }
      },
      vertexShader: [
        'varying vec3 vDir;',
        'void main() {',
          '  vDir = normalize(position);',
                                       '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
                                       '}'
      ].join('\n'),
                                       fragmentShader: [
                                         'uniform vec3 uTop;',
                                         'uniform vec3 uMid;',
                                         'uniform vec3 uLow;',
                                         'uniform vec3 uHoriz;',
                                         'uniform float uSpaceMix;',
                                         'varying vec3 vDir;',
                                         'void main() {',
                                           '  float h = clamp(vDir.y, -0.2, 1.0);',
                                       '  float up = clamp(h, 0.0, 1.0);',
                                       '  vec3 base = mix(uHoriz, uLow, smoothstep(0.0, 0.18, up));',
                                       '  base = mix(base, uMid, smoothstep(0.16, 0.52, up));',
                                       '  base = mix(base, uTop, smoothstep(0.45, 0.96, up));',
                                       '  vec3 spaceCol = vec3(0.0005, 0.0012, 0.0032);',
                                       '  vec3 limb = vec3(0.06, 0.28, 0.68) * exp(-abs(h - 0.01) * 14.0) * (1.0 - smoothstep(0.65, 1.0, uSpaceMix));',
                                       '  float skyDrop = smoothstep(0.0, 1.0, uSpaceMix);',
                                       '  float fade = clamp(skyDrop * (0.55 + 0.85 * up), 0.0, 1.0);',
                                       '  vec3 col = mix(base, spaceCol, fade) + limb * smoothstep(0.08, 0.35, uSpaceMix);',
                                       '  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));',
                                       '  gl_FragColor = vec4(col, 1.0);',
                                       '}'
                                       ].join('\n'),
                                       side: THREE.BackSide,
                                       depthWrite: false,
                                       fog: false
    });
    world.sky = new THREE.Mesh(geo, mat);
    world.sky.frustumCulled = false;
    world.sky.renderOrder = -100;
    scene.add(world.sky);
  }

  function setSkyLocaleColors(kind) {
    if (!world.sky) return;
    var L = LOCALES[kind] || LOCALES.earth;
    var u = world.sky.material.uniforms;
    u.uTop.value.copy(srgb(L.sky[0]));
    u.uMid.value.copy(srgb(L.sky[1]));
    u.uLow.value.copy(srgb(L.sky[2]));
    u.uHoriz.value.copy(srgb(L.sky[3]));
    u.uSpaceMix.value = (kind === 'space' ? 1.0 : 0.0);
  }

  function setAtmosphereBlend(u) {
    u = clamp01(u);
    if (!scene || !world.sky) return;
    world.sky.material.uniforms.uSpaceMix.value = u;

    scratchColorA.copy(srgb(LOCALES.earth.bg));
    scratchColorB.copy(srgb(LOCALES.space.bg));
    scene.background.copy(scratchColorA).lerp(scratchColorB, easeOutQuad(u));

    var starOp = clamp01((u - 0.18) / 0.55);
    if (world.stars) {
      world.stars.visible = starOp > 0.01;
      world.stars.material.opacity = 0.92 * starOp;
    }
    if (world.stars2) {
      world.stars2.visible = starOp > 0.01;
      world.stars2.material.opacity = 0.56 * starOp;
    }

    if (scene.fog) {
      scene.fog.near = lerp(LOCALES.earth.fogNear, 900, u);
      scene.fog.far = lerp(LOCALES.earth.fogFar, 2600, u);
      scene.fog.color.copy(srgb(LOCALES.earth.fog)).lerp(srgb(LOCALES.space.bg), u);
    }

    var showGround = u < 0.85;
    if (world.terrains && world.terrains.earth) world.terrains.earth.visible = showGround;
    if (world.padGroup) world.padGroup.visible = showGround;

    var showGlobe = u > 0.25;
    if (world.earthParts) {
      for (var i = 0; i < world.earthParts.length; i++) {
        world.earthParts[i].visible = showGlobe;
      }
    }
  }

  // --- Terrain --------------------------------------------------------------
  var TERRAIN_SIZE = 400;
  var TERRAIN_SEG = 190;
  var TERRAIN_EDGE = 200;

  function terrainContext(kind) {
    var ctx = {
      noiseA: makeNoise2(kind === 'moon' ? 71 : kind === 'mars' ? 137 : 211),
             noiseB: makeNoise2(kind === 'moon' ? 211 : kind === 'mars' ? 311 : 401),
             craters: []
    };
    if (kind === 'moon') {
      var rand = mulberry32(9001);
      for (var i = 0; i < 34; i++) {
        var a = rand() * Math.PI * 2;
        var r = 12 + rand() * 176;
        ctx.craters.push({
          x: Math.cos(a) * r, z: Math.sin(a) * r,
                         r: 3.5 + rand() * 18, depth: 2.6 + rand() * 4.4, rim: 0.6 + rand() * 1.0
        });
      }
    }
    return ctx;
  }

  function terrainHeight(ctx, kind, x, z) {
    var h = 0;
    var d = Math.sqrt(x * x + z * z);
    var edge = clamp01(d / TERRAIN_EDGE);
    if (kind === 'earth') {
      h = (fbm(ctx.noiseA, x * 0.012, z * 0.012, 4) - 0.5) * 6.0;
      h += (ctx.noiseB(x * 0.07, z * 0.07) - 0.5) * 0.6;
      h += easeSoft(edge) * (fbm(ctx.noiseA, x * 0.004 + 9, z * 0.004, 3) - 0.35) * 16;
    } else if (kind === 'moon') {
      h = (fbm(ctx.noiseA, x * 0.02, z * 0.02, 3) - 0.5) * 2.0;
      for (var i = 0; i < ctx.craters.length; i++) {
        var cr = ctx.craters[i];
        var dx = x - cr.x, dz = z - cr.z;
        var u = Math.sqrt(dx * dx + dz * dz) / cr.r;
        if (u < 2.1) {
          if (u < 1) {
            var bowl = 1 - u * u;
            h -= cr.depth * bowl * bowl;
          }
          var rimD = (u - 1) / 0.3;
          h += cr.rim * Math.exp(-rimD * rimD);
        }
      }
      h += easeSoft(clamp01((edge - 0.68) / 0.32)) * (fbm(ctx.noiseB, x * 0.006, z * 0.006, 3) * 14 - 3);
    } else {
      var warp = fbm(ctx.noiseB, x * 0.01, z * 0.01, 3);
      var dune = Math.sin((x * 0.75 + z * 0.42) * 0.09 + warp * 5.4);
      h = dune * 2.2 + (fbm(ctx.noiseA, x * 0.025, z * 0.025, 4) - 0.5) * 3.4;
      h += easeSoft(edge) * (fbm(ctx.noiseA, x * 0.006, z * 0.006 + 4, 3) - 0.4) * 9;
    }
    var flat = clamp01((d - 10) / 14);
    return h * easeSoft(flat);
  }

  function sampleActiveTerrainHeight(x, z) {
    var kind = currentLocale === 'mars' ? 'mars' : (currentLocale === 'moon' ? 'moon' : 'earth');
    var ctx = terrainCtx[kind];
    return ctx ? terrainHeight(ctx, kind, x, z) : 0;
  }

  function makeBumpTexture() {
    var S = 256;
    var c = makeCanvas(S, S);
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(S, S);
    var noise = makeNoise2(1234);
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var v = fbm(noise, x * 0.075, y * 0.075, 4);
        var g = Math.round(80 + v * 140);
        var i = (y * S + x) * 4;
        img.data[i] = g; img.data[i + 1] = g; img.data[i + 2] = g; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
    tex.repeat.set(16, 16);
    return tex;
  }

  function terrainPalette(kind) {
    if (kind === 'moon') return { a: srgb(0x7c828a), b: srgb(0x60666e), low: srgb(0x4c525a), hi: srgb(0x9298a0) };
    if (kind === 'mars') return { a: srgb(0x8f3f20), b: srgb(0x6b2c18), low: srgb(0x542314), hi: srgb(0xa85a34) };
    return { a: srgb(0x3d6029), b: srgb(0x566a2f), low: srgb(0x433a28), hi: srgb(0x6f8140) };
  }

  function addBoulders(group, kind, ctx) {
    var rand = mulberry32(kind === 'earth' ? 55 : kind === 'moon' ? 66 : 77);
    var colors = { earth: 0x6b6152, moon: 0x767c85, mars: 0x7c3a22 };
    var mat = new THREE.MeshStandardMaterial({
      color: srgb(colors[kind] || 0x6b6152), roughness: 1, flatShading: true
    });
    var count = kind === 'earth' ? 20 : 18;
    for (var i = 0; i < count; i++) {
      var ang = rand() * Math.PI * 2;
      var rad = 26 + rand() * 170;
      var x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
      var size = 0.55 + rand() * (kind === 'moon' ? 2.4 : 2.0);
      var rock = new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), mat);
      rock.position.set(x, terrainHeight(ctx, kind, x, z) + size * 0.28, z);
      rock.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
      rock.scale.y = 0.6 + rand() * 0.7;
      rock.castShadow = true; rock.receiveShadow = true;
      group.add(rock);
    }
    for (var p = 0; p < 28; p++) {
      var pa = rand() * Math.PI * 2, pr = 6 + rand() * 70;
      var px = Math.cos(pa) * pr, pz = Math.sin(pa) * pr;
      var ps = 0.12 + rand() * 0.34;
      var pebble = new THREE.Mesh(new THREE.DodecahedronGeometry(ps, 0), mat);
      pebble.position.set(px, terrainHeight(ctx, kind, px, pz) + ps * 0.4, pz);
      pebble.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
      pebble.castShadow = true;
      group.add(pebble);
    }
    if (kind === 'earth') {
      var bushMat = new THREE.MeshStandardMaterial({ color: srgb(0x3d5c31), roughness: 1, flatShading: true });
      for (var b = 0; b < 14; b++) {
        var ba = rand() * Math.PI * 2, br = 30 + rand() * 150;
        var bx = Math.cos(ba) * br, bz = Math.sin(ba) * br;
        var bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7 + rand() * 1.1, 0), bushMat);
        bush.position.set(bx, terrainHeight(ctx, kind, bx, bz) + 0.35, bz);
        bush.scale.set(1.2, 0.7, 1.2);
        bush.castShadow = true;
        group.add(bush);
      }
    }
  }

  function createTerrainGroup(kind) {
    var ctx = terrainContext(kind);
    terrainCtx[kind] = ctx;
    var geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEG, TERRAIN_SEG);
    geo.rotateX(-Math.PI / 2);
    var pos = geo.attributes.position;
    var colors = new Float32Array(pos.count * 3);
    var pal = terrainPalette(kind);
    var col = new THREE.Color();
    var minH = 0, maxH = 0;
    for (var i = 0; i < pos.count; i++) {
      var h = terrainHeight(ctx, kind, pos.getX(i), pos.getZ(i));
      pos.setY(i, h);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    for (var j = 0; j < pos.count; j++) {
      var x2 = pos.getX(j), z2 = pos.getZ(j), h2 = pos.getY(j);
      var n = fbm(ctx.noiseB, x2 * 0.09 + 3, z2 * 0.09 + 5, 3);
      var t = clamp01((h2 - minH) / Math.max(0.001, maxH - minH));
      if (kind === 'moon') {
        var maria = ctx.noiseA(x2 * 0.012 + 11, z2 * 0.012 + 7);
        col.copy(pal.b).lerp(pal.a, n);
        col.lerp(pal.low, clamp01(-h2 / 3.0) * 0.9);
        col.lerp(pal.hi, clamp01((h2 - 0.5) / 2.2) * 0.75);
        col.lerp(pal.low, clamp01((maria - 0.5) * 2.6) * 0.7);
      } else if (kind === 'mars') {
        var mpatch = fbm(ctx.noiseB, x2 * 0.022 + 5, z2 * 0.022 + 9, 3);
        col.copy(pal.b).lerp(pal.a, clamp01(n * 1.3));
        col.lerp(pal.low, clamp01((mpatch - 0.5) * 3.0) * 0.85);
        col.lerp(pal.hi, clamp01((0.47 - mpatch) * 2.4) * 0.6);
        col.lerp(pal.hi, clamp01((h2 - 1.4) / 3.0) * 0.55);
      } else {
        var patch = fbm(ctx.noiseA, x2 * 0.028 + 17, z2 * 0.028 + 3, 3);
        col.copy(pal.a).lerp(pal.b, clamp01(n * 1.5));
        col.lerp(pal.hi, clamp01((patch - 0.5) * 3.0) * 0.9);
        col.lerp(pal.low, clamp01((0.46 - patch) * 2.2) * 0.7);
        col.lerp(pal.low, clamp01((0.42 - t) * 1.2) * 0.5);
      }
      colors[j * 3] = col.r; colors[j * 3 + 1] = col.g; colors[j * 3 + 2] = col.b;
    }
    pos.needsUpdate = true;
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    if (!world.terrainBump) world.terrainBump = makeBumpTexture();
    var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1.0, metalness: 0.0,
      bumpMap: world.terrainBump, bumpScale: 0.32
    }));
    mesh.receiveShadow = true;

    var group = new THREE.Group();
    group.add(mesh);
    addBoulders(group, kind, ctx);
    group.visible = false;
    scene.add(group);
    return group;
  }

  function createTerrains() {
    world.terrains = {
      earth: createTerrainGroup('earth'),
             moon: createTerrainGroup('moon'),
             mars: createTerrainGroup('mars')
    };
  }

  function showTerrain(kind) {
    if (!world.terrains) return;
    for (var k in world.terrains) {
      if (Object.prototype.hasOwnProperty.call(world.terrains, k)) {
        world.terrains[k].visible = (k === kind);
      }
    }
  }

  function applyLocale(kind) {
    var key = LOCALES[kind] ? kind : 'earth';
    var L = LOCALES[key];
    currentLocale = key;
    if (!scene) return;

    setSkyLocaleColors(key);
    scene.background = new THREE.Color().copy(srgb(L.bg));
    scene.fog = L.fog === null ? null : new THREE.Fog(L.fog, L.fogNear, L.fogFar);

    if (world.hemi) {
      world.hemi.color.copy(srgb(L.hemiSky));
      world.hemi.groundColor.copy(srgb(L.hemiGround));
      world.hemi.intensity = L.hemiI;
    }
    if (world.ambient) world.ambient.intensity = L.ambI;
    if (world.key) { world.key.color.copy(srgb(L.keyColor)); world.key.intensity = L.keyI; }
    if (world.fill) { world.fill.color.copy(srgb(L.fillColor)); world.fill.intensity = L.fillI; }
    if (world.rim) { world.rim.color.copy(srgb(L.rimColor)); world.rim.intensity = L.rimI; }
    if (world.stars) { world.stars.visible = !!L.stars; world.stars.material.opacity = L.stars ? 0.92 : 0; }
    if (world.stars2) { world.stars2.visible = !!L.stars; world.stars2.material.opacity = L.stars ? 0.56 : 0; }

    showTerrain(L.terrain || null);
    if (world.padGroup && !L.terrain) world.padGroup.visible = false;

    var planetVis = PLANET_VISIBILITY[key] || PLANET_VISIBILITY.space;
    if (world.earthParts) {
      for (var ei = 0; ei < world.earthParts.length; ei++) world.earthParts[ei].visible = !!planetVis.earth;
    }
    if (world.moon) world.moon.visible = !!planetVis.moon;
    if (world.mars) world.mars.visible = !!planetVis.mars;
    if (world.saturn) world.saturn.visible = !!planetVis.saturn;
    if (world.saturnRing) world.saturnRing.visible = !!planetVis.saturn;
    if (world.orbitGroup && key !== 'space') world.orbitGroup.visible = false;

    if (effects.smoke) effects.smoke.points.visible = !!L.terrain || key === 'space';
    if (effects.dust) effects.dust.points.visible = !!L.terrain;
    if (effects.sparks) effects.sparks.points.visible = true;

    if (surface.poi && surface.poi.material) {
      surface.poi.material.color.copy(srgb(key === 'mars' ? 0x7e4a34 :
      key === 'moon' ? 0x8b9099 : 0x6b5a4d));
    }
    if (effects.dust && effects.dust.points) {
      effects.dust.points.material.uniforms.uColor.value.copy(srgb(L.dust));
    }
    if (renderer) renderer.toneMappingExposure = L.exposure;
  }

  function localeForDestination(destKey) {
    var k = String(destKey || '').toLowerCase();
    if (k.indexOf('moon') !== -1 || k.indexOf('luna') !== -1) return 'moon';
    if (k.indexOf('mars') !== -1) return 'mars';
    if (k.indexOf('earth') !== -1) return 'earth';
    return 'moon';
  }

  // --- Planet Shaders & Textures --------------------------------------------
  function makePlanetMaterial(tex, opts) {
    opts = opts || {};
    return new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: tex },
        uSunDir: { value: new THREE.Vector3(0.72, 0.34, 0.58).normalize() },
                                    uRimColor: { value: srgb(opts.rimColor || 0x7fc0ff) },
                                    uRimPower: { value: isNum(opts.rimPower) ? opts.rimPower : 3.2 },
                                    uRimStrength: { value: isNum(opts.rimStrength) ? opts.rimStrength : 0.45 },
                                    uNightAmbient: { value: isNum(opts.nightAmbient) ? opts.nightAmbient : 0.035 }
      },
      vertexShader: [
        'varying vec2 vUv;',
        'varying vec3 vWorldN;',
        'varying vec3 vWorldPos;',
        'void main() {',
          '  vUv = uv;',
          '  vec4 wp = modelMatrix * vec4(position, 1.0);',
                                    '  vWorldPos = wp.xyz;',
                                    '  vWorldN = normalize(mat3(modelMatrix) * normal);',
                                    '  gl_Position = projectionMatrix * viewMatrix * wp;',
                                    '}'
      ].join('\n'),
                                    fragmentShader: [
                                      'uniform sampler2D uMap;',
                                      'uniform vec3 uSunDir;',
                                      'uniform vec3 uRimColor;',
                                      'uniform float uRimPower;',
                                      'uniform float uRimStrength;',
                                      'uniform float uNightAmbient;',
                                      'varying vec2 vUv;',
                                      'varying vec3 vWorldN;',
                                      'varying vec3 vWorldPos;',
                                      'void main() {',
                                        '  vec3 N = normalize(vWorldN);',
                                    '  vec3 V = normalize(cameraPosition - vWorldPos);',
                                    '  vec3 L = normalize(uSunDir);',
                                    '  float ndl = dot(N, L);',
                                    '  float diff = smoothstep(-0.16, 0.28, ndl) * 0.78 + max(ndl, 0.0) * 0.34;',
                                    '  vec3 tex = pow(texture2D(uMap, vUv).rgb, vec3(2.2));',
                                    '  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uRimPower);',
                                    '  float dayMask = smoothstep(-0.22, 0.25, ndl);',
                                    '  vec3 lit = tex * (uNightAmbient + diff) + uRimColor * fres * (0.14 + 0.86 * dayMask) * uRimStrength;',
                                    '  lit = lit / (1.0 + lit * 0.32);',
                                    '  lit = pow(clamp(lit, 0.0, 1.0), vec3(1.0 / 2.2));',
                                    '  gl_FragColor = vec4(lit, 1.0);',
                                    '}'
                                    ].join('\n'),
                                    fog: false
    });
  }

  function makeBandTexture() {
    var c = makeCanvas(64, 128);
    var ctx = c.getContext('2d');
    var rand = mulberry32(6060);
    var bands = ['#e6cf9a', '#d8b877', '#c9a465', '#efdcb0', '#cfa870', '#e2c78e', '#d3ad6b'];
    var y = 0;
    while (y < 128) {
      var h = 6 + Math.floor(rand() * 14);
      ctx.fillStyle = bands[Math.floor(rand() * bands.length)];
      ctx.fillRect(0, y, 64, h);
      y += h;
    }
    var g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, 'rgba(255,255,255,0.16)');
    g.addColorStop(0.5, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.2)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 128);
    return canvasTexture(c);
  }

  function makeRingTexture() {
    var W = 512, H = 16;
    var c = makeCanvas(W, H);
    var ctx = c.getContext('2d');
    var rand = mulberry32(4499);
    for (var x = 0; x < W; x++) {
      var u = x / (W - 1);
      var alpha = 0, col = '#d8c59e';
      if (u > 0.04 && u < 0.23) {
        alpha = 0.22 + 0.12 * Math.sin(u * 120); col = '#9f947c';
      } else if (u >= 0.23 && u < 0.62) {
        alpha = 0.72 + 0.2 * Math.sin(u * 160) + (rand() - 0.5) * 0.1;
        col = u < 0.4 ? '#dfd0a8' : '#efe3c1';
      } else if (u >= 0.62 && u < 0.68) {
        alpha = 0.06; col = '#4c463c';
      } else if (u >= 0.68 && u < 0.97) {
        alpha = (u > 0.87 && u < 0.89) ? 0.1 : 0.54 + 0.15 * Math.cos(u * 180) + (rand() - 0.5) * 0.08;
        col = '#d4c39c';
      }
      ctx.globalAlpha = clamp01(alpha);
      ctx.fillStyle = col;
      ctx.fillRect(x, 0, 1, H);
    }
    ctx.globalAlpha = 1;
    return canvasTexture(c);
  }

  function makeEarthFallbackTexture() {
    var W = 512, H = 256;
    var c = makeCanvas(W, H);
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#1b4f8c';
    ctx.fillRect(0, 0, W, H);
    var noise = makeNoise2(5151);
    for (var y = 0; y < H; y += 2) {
      for (var x = 0; x < W; x += 2) {
        var ang = (x / W) * Math.PI * 2;
        var lat = (y / H - 0.5) * 2;
        var v = fbm(noise, Math.cos(ang) * 1.9 + 3, Math.sin(ang) * 1.9 + lat * 2.2, 4);
        if (Math.abs(lat) > 0.82) {
          ctx.fillStyle = '#e7edf4'; ctx.fillRect(x, y, 2, 2);
        } else if (v > 0.53) {
          ctx.fillStyle = v > 0.63 ? '#7c7654' : '#3d743e'; ctx.fillRect(x, y, 2, 2);
        }
      }
    }
    return canvasTexture(c);
  }

  function makePlanetTexture(kind) {
    var W = 1024, H = 512;
    var c = makeCanvas(W, H);
    var ctx = c.getContext('2d');
    var rand = mulberry32(kind === 'moon' ? 4242 : 8484);
    var i, r;
    if (kind === 'moon') {
      ctx.fillStyle = '#9aa0a8';
      ctx.fillRect(0, 0, W, H);
      for (i = 0; i < 24; i++) {
        ctx.globalAlpha = 0.14 + rand() * 0.15;
        ctx.fillStyle = '#686e78';
        var mx = rand() * W, my = 70 + rand() * (H - 140), mr = 40 + rand() * 130;
        ctx.beginPath(); ctx.ellipse(mx, my, mr, mr * (0.45 + rand() * 0.4), rand() * Math.PI, 0, Math.PI * 2); ctx.fill();
      }
      for (i = 0; i < 450; i++) {
        r = 1.5 + rand() * (rand() < 0.92 ? 9 : 24);
        var cx = rand() * W, cy = rand() * H;
        ctx.globalAlpha = 0.3; ctx.fillStyle = '#676c74';
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.42; ctx.strokeStyle = '#d3d8de'; ctx.lineWidth = Math.max(0.6, r * 0.16);
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      }
      var pg = ctx.createLinearGradient(0, 0, 0, H);
      pg.addColorStop(0, 'rgba(240,244,248,0.35)');
      pg.addColorStop(0.12, 'rgba(240,244,248,0)');
      pg.addColorStop(0.88, 'rgba(240,244,248,0)');
      pg.addColorStop(1, 'rgba(240,244,248,0.35)');
      ctx.globalAlpha = 1; ctx.fillStyle = pg; ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = '#b4552f';
      ctx.fillRect(0, 0, W, H);
      for (i = 0; i < 44; i++) {
        ctx.globalAlpha = 0.18 + rand() * 0.24;
        ctx.fillStyle = rand() < 0.58 ? '#6d2f1a' : '#cf8352';
        var dx = rand() * W, dy = 50 + rand() * (H - 100), dr = 26 + rand() * 160;
        ctx.beginPath(); ctx.ellipse(dx, dy, dr, dr * (0.25 + rand() * 0.55), rand() * Math.PI, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 0.4; ctx.strokeStyle = '#5e2716'; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(W * 0.16, H * 0.56);
      ctx.bezierCurveTo(W * 0.3, H * 0.5, W * 0.42, H * 0.62, W * 0.56, H * 0.55); ctx.stroke();
      for (i = 0; i < 90; i++) {
        ctx.globalAlpha = 0.12 + rand() * 0.2; ctx.strokeStyle = '#6e2f1c'; ctx.lineWidth = 0.8 + rand() * 3.4;
        var sx = rand() * W, sy = 80 + rand() * (H - 160), sl = 30 + rand() * 150;
        ctx.beginPath(); ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(sx + sl * 0.3, sy + (rand() - 0.5) * 24, sx + sl * 0.7, sy + (rand() - 0.5) * 30, sx + sl, sy + (rand() - 0.5) * 18);
        ctx.stroke();
      }
      for (i = 0; i < 5000; i++) {
        ctx.globalAlpha = 0.03 + rand() * 0.05;
        ctx.fillStyle = rand() < 0.5 ? '#ffffff' : '#3c160c';
        ctx.fillRect(rand() * W, rand() * H, 1 + rand() * 2, 1 + rand() * 2);
      }
      ctx.globalAlpha = 0.92; ctx.fillStyle = '#f0e6dd';
      ctx.beginPath(); ctx.ellipse(W * 0.5, 6, W * 0.34, 26, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(W * 0.5, H - 6, W * 0.26, 20, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    return canvasTexture(c);
  }

  function makeCloudTexture() {
    var W = 1024, H = 512;
    var c = makeCanvas(W, H);
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(W, H);
    var noise = makeNoise2(777);
    for (var y = 0; y < H; y++) {
      var lat = Math.abs(y / H - 0.5) * 2;
      var band = 0.5 + 0.5 * Math.cos(lat * Math.PI * 2.1);
      for (var x = 0; x < W; x++) {
        var ang = (x / W) * Math.PI * 2;
        var v = fbm(noise, Math.cos(ang) * 4.08 + y * 0.0035, Math.sin(ang) * 4.08 - y * 0.0035, 5);
        var a = clamp01((v - 0.5) * 3.4) * (0.25 + band * 0.75);
        var i = (y * W + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(clamp01(a) * 235);
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvasTexture(c);
  }

  function createPlanets() {
    world.planets = {};

    var earthMat = makePlanetMaterial(makeEarthFallbackTexture(), {
      rimColor: 0x70bfff, rimPower: 2.8, rimStrength: 0.72, nightAmbient: 0.04
    });
    world.earth = new THREE.Mesh(new THREE.SphereGeometry(420, 56, 36), earthMat);
    world.earth.position.set(-760, 290, -2400);
    world.earth.rotation.y = -Math.PI / 2;
    world.earth.rotation.z = 0.41;
    scene.add(world.earth);
    world.planets.earth = { mesh: world.earth, pos: world.earth.position, r: 420 };
    world.earthMat = earthMat;

    world.earthGlow = new THREE.Mesh(new THREE.SphereGeometry(427, 48, 32), new THREE.ShaderMaterial({
      uniforms: { uColor: { value: srgb(0x7fc0ff) } },
                                                                                                     vertexShader: [
                                                                                                       'varying vec3 vN; varying vec3 vV;',
                                                                                                       'void main() {',
                                                                                                         '  vec4 wp = modelMatrix * vec4(position, 1.0);',
                                                                                                     '  vN = normalize(mat3(modelMatrix) * normal);',
                                                                                                     '  vV = normalize(cameraPosition - wp.xyz);',
                                                                                                     '  gl_Position = projectionMatrix * viewMatrix * wp;',
                                                                                                     '}'
                                                                                                     ].join('\n'),
                                                                                                     fragmentShader: [
                                                                                                       'uniform vec3 uColor; varying vec3 vN; varying vec3 vV;',
                                                                                                       'void main() {',
                                                                                                         '  float rim = pow(1.0 - clamp(dot(vN, vV), 0.0, 1.0), 2.5);',
                                                                                                     '  gl_FragColor = vec4(uColor, rim * 0.65);',
                                                                                                     '}'
                                                                                                     ].join('\n'),
                                                                                                     transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide
    }));
    world.earthGlow.position.copy(world.earth.position);
    world.earthGlow.rotation.copy(world.earth.rotation);
    scene.add(world.earthGlow);

    world.earthClouds = new THREE.Mesh(new THREE.SphereGeometry(424, 48, 32), new THREE.MeshBasicMaterial({
      map: makeCloudTexture(), transparent: true, opacity: 0.46, depthWrite: false, fog: false
    }));
    world.earthClouds.position.copy(world.earth.position);
    world.earthClouds.rotation.copy(world.earth.rotation);
    scene.add(world.earthClouds);
    world.earthParts = [world.earth, world.earthGlow, world.earthClouds];

    world.moon = new THREE.Mesh(new THREE.SphereGeometry(72, 48, 32), makePlanetMaterial(makePlanetTexture('moon'), {
      rimColor: 0xc8d2df, rimPower: 4.0, rimStrength: 0.25, nightAmbient: 0.03
    }));
    world.moon.position.set(1500, 560, -2400);
    scene.add(world.moon);
    world.planets.moon = { mesh: world.moon, pos: world.moon.position, r: 72 };

    world.mars = new THREE.Mesh(new THREE.SphereGeometry(102, 48, 32), makePlanetMaterial(makePlanetTexture('mars'), {
      rimColor: 0xffa676, rimPower: 3.0, rimStrength: 0.55, nightAmbient: 0.035
    }));
    world.mars.position.set(-1500, 700, -2500);
    scene.add(world.mars);
    world.planets.mars = { mesh: world.mars, pos: world.mars.position, r: 102 };

    world.saturnBands = makeBandTexture();
    world.saturnRingTex = makeRingTexture();
    world.saturnMat = makePlanetMaterial(world.saturnBands, {
      rimColor: 0xf4dca8, rimPower: 3.2, rimStrength: 0.42, nightAmbient: 0.05
    });
    world.saturn = new THREE.Mesh(new THREE.SphereGeometry(142, 48, 32), world.saturnMat);
    world.saturn.position.set(950, 820, -3300);
    world.saturn.rotation.z = 0.47;
    scene.add(world.saturn);
    world.planets.saturn = { mesh: world.saturn, pos: world.saturn.position, r: 142 };

    var ringGeo = new THREE.RingGeometry(156, 265, 96, 1);
    var pos = ringGeo.attributes.position, uv = ringGeo.attributes.uv, v3 = new THREE.Vector3();
    for (var i = 0; i < pos.count; i++) {
      v3.fromBufferAttribute(pos, i);
      uv.setXY(i, clamp01((v3.length() - 156) / 109), 0.5);
    }
    world.saturnRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: srgb(0xe8d9b8), side: THREE.DoubleSide,
                                                                           transparent: true, opacity: 0.92, map: world.saturnRingTex, depthWrite: false, fog: false
    }));
    world.saturnRing.position.copy(world.saturn.position);
    world.saturnRing.rotation.x = Math.PI / 2 - 0.47;
    scene.add(world.saturnRing);
  }

  // --- Orbital Constellation Showcase (Gateway, TDRS, EO-1, Landsat 8, ICON, MGS, Chandra) ---
  function makePrimitiveSatellite(accentHex) {
    var g = new THREE.Group();
    var bodyMat = new THREE.MeshStandardMaterial({ color: srgb(0xdce2ea), roughness: 0.45, metalness: 0.45 });
    var goldMat = new THREE.MeshStandardMaterial({ color: srgb(0xd4a348), roughness: 0.4, metalness: 0.6 });
    var panelMat = new THREE.MeshStandardMaterial({
      color: srgb(accentHex || 0x1f3d8f), emissive: srgb(0x0a1a44), emissiveIntensity: 0.45,
                                                  roughness: 0.3, metalness: 0.3
    });
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.9, 1.1), goldMat));
    var dish = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.12, 0.3, 12), bodyMat);
    dish.position.y = 0.65;
    g.add(dish);
    for (var s = -1; s <= 1; s += 2) {
      var wing = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.06, 0.9), panelMat);
      wing.position.set(s * 1.9, 0, 0);
      g.add(wing);
    }
    return g;
  }

  function makeOrbitSlot(modelKey, targetSize, accentHex) {
    var slot = new THREE.Group();
    var fb = makePrimitiveSatellite(accentHex);
    fb.scale.setScalar(targetSize / 5.0);
    slot.add(fb);
    slot.userData = { modelKey: modelKey, targetSize: targetSize, fallback: fb, glbMounted: false };
    return slot;
  }

  function tryMountSlotGLB(slot) {
    if (!slot || !slot.userData || slot.userData.glbMounted) return;
    var ud = slot.userData;
    var inst = instanceModel(ud.modelKey, ud.targetSize, false);
    if (!inst) return;
    inst.traverse(function (o) { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    slot.add(inst);
    if (ud.fallback) ud.fallback.visible = false;
    ud.glbMounted = true;
  }

  function createOrbitProps() {
    var g = new THREE.Group();
    g.visible = false;
    world.orbitGroup = g;
    scene.add(g);

    world.orbitSlots = {
      station: makeOrbitSlot('station', 16, 0x264899),
             tdrs: makeOrbitSlot('satTDRS', 7.5, 0x224488),
             eo1: makeOrbitSlot('satEO1', 5.5, 0x1e4c9a),
             landsat: makeOrbitSlot('satLandsat', 6.5, 0x1c3d82),
             icon: makeOrbitSlot('satICON', 5.0, 0x2b55aa),
             mgs: makeOrbitSlot('satMGS', 6.5, 0x3a4d82),
             chandra: makeOrbitSlot('satChandra', 10.5, 0x334770)
    };
    for (var k in world.orbitSlots) {
      if (Object.prototype.hasOwnProperty.call(world.orbitSlots, k)) g.add(world.orbitSlots[k]);
    }
  }

  function setupOrbitShowcase(mode) {
    if (!world.orbitGroup || !world.orbitSlots) return;
    world.orbitGroup.visible = true;
    for (var k in world.orbitSlots) {
      if (Object.prototype.hasOwnProperty.call(world.orbitSlots, k)) {
        world.orbitSlots[k].visible = false;
        tryMountSlotGLB(world.orbitSlots[k]);
      }
    }
    world.orbitMotion = [];
    function place(slot, x, y, z, rx, ry, rz, vx, vy, vz) {
      if (!slot) return;
      slot.visible = true;
      slot.position.set(x, y, z);
      slot.rotation.set(rx, ry, rz);
      world.orbitMotion.push({ obj: slot, x: x, y: y, z: z, vx: vx, vy: vy, vz: vz, ry: ry });
    }
    if (mode === 'earth-orbit') {
      place(world.orbitSlots.station, -108, 434, -155, 0.14, 0.6, -0.08, 1.4, -0.2, 0.5);
      place(world.orbitSlots.landsat, -18, 446, -122, 0.1, -0.4, 0.12, 1.9, 0.15, -0.4);
      place(world.orbitSlots.eo1, -76, 412, -110, -0.1, 0.9, 0.05, 1.6, 0.1, 0.6);
      place(world.orbitSlots.icon, -5, 416, -68, 0.08, -1.1, 0.15, 1.2, 0.2, -0.3);
      place(world.orbitSlots.tdrs, -135, 456, -190, 0.06, 0.3, -0.1, 1.1, 0.05, 0.3);
    } else if (mode === 'moon-approach') {
      var mp = getPlanet('moon');
      if (mp) {
        place(world.orbitSlots.station, mp.x - mp.r * 1.8, mp.y + mp.r * 0.45, mp.z + mp.r * 2.1,
              0.12, 0.55, -0.15, -2.5, 0.4, 1.2);
      }
    } else if (mode === 'mars-approach') {
      var rp = getPlanet('mars');
      if (rp) {
        place(world.orbitSlots.mgs, rp.x + rp.r * 1.9, rp.y + rp.r * 0.4, rp.z + rp.r * 2.3,
              0.18, -0.7, 0.12, -3.2, 0.5, 1.4);
      }
    } else if (mode === 'saturn-approach') {
      var sp = getPlanet('saturn');
      if (sp) {
        place(world.orbitSlots.chandra, sp.x - sp.r * 2.5, sp.y + sp.r * 0.9, sp.z + sp.r * 3.1,
              0.15, 0.45, -0.1, 3.0, -0.4, -1.2);
      }
    }
  }

  function updateOrbitShowcase(elapsed) {
    if (!world.orbitGroup || !world.orbitGroup.visible || !world.orbitMotion) return;
    var spd = reducedMotion ? 0.25 : 1.0;
    for (var i = 0; i < world.orbitMotion.length; i++) {
      var m = world.orbitMotion[i];
      m.obj.position.set(m.x + m.vx * elapsed * spd, m.y + m.vy * elapsed * spd, m.z + m.vz * elapsed * spd);
      m.obj.rotation.y = m.ry + elapsed * 0.04 * spd;
    }
  }

  // --- Launchpad & Articulated Service Tower ------------------------------
  function createPad() {
    var g = new THREE.Group();
    world.padGroup = g;
    scene.add(g);

    var deckMat = new THREE.MeshStandardMaterial({ color: srgb(0x7a828e), roughness: 0.78, metalness: 0.22 });
    world.deck = new THREE.Mesh(new THREE.CylinderGeometry(9, 10, PAD_Y, 28), deckMat);
    world.deck.position.y = PAD_Y / 2;
    world.deck.receiveShadow = true;
    world.deck.castShadow = true;
    g.add(world.deck);

    var trenchMat = new THREE.MeshStandardMaterial({ color: srgb(0x3a404a), roughness: 0.9, metalness: 0.25 });
    var deflector = new THREE.Mesh(new THREE.ConeGeometry(2.6, 1.4, 4), trenchMat);
    deflector.rotation.y = Math.PI / 4;
    deflector.position.set(0, 0.7, 0);
    g.add(deflector);

    var roadMat = new THREE.MeshStandardMaterial({ color: srgb(0x666d78), roughness: 0.96 });
    var road = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.22, 16), roadMat);
    road.position.set(0, 0.16, 19);
    road.rotation.x = 0.035;
    road.receiveShadow = true;
    g.add(road);
    var roadLineMat = new THREE.MeshStandardMaterial({ color: srgb(0xc9c27a), roughness: 0.9 });
    for (var rl = -1; rl <= 1; rl += 2) {
      var edgeLine = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 15), roadLineMat);
      edgeLine.position.set(rl * 2.85, 0.30, 19);
      edgeLine.rotation.x = 0.035;
      g.add(edgeLine);
    }

    var towerMat = new THREE.MeshStandardMaterial({ color: srgb(0x5b6472), roughness: 0.7, metalness: 0.42 });
    var armMat = new THREE.MeshStandardMaterial({ color: srgb(0x9aa4b2), roughness: 0.6, metalness: 0.45 });
    var tower = new THREE.Group();
    var mast = new THREE.Mesh(new THREE.BoxGeometry(1.5, 22, 1.5), towerMat);
    mast.position.y = 11;
    mast.castShadow = true;
    tower.add(mast);

    var spire = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.18, 3.2, 8), towerMat);
    spire.position.y = 23.6;
    tower.add(spire);
    world.towerBeaconMat = new THREE.MeshStandardMaterial({
      color: srgb(0x4a1010), emissive: srgb(0xff3c2a), emissiveIntensity: 1.2, roughness: 0.4
    });
    var tBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), world.towerBeaconMat);
    tBeacon.position.y = 25.2;
    tower.add(tBeacon);

    world.towerArms = [];
    var armHeights = [6.2, 10.6, 14.5];
    for (var i = 0; i < armHeights.length; i++) {
      var pivot = new THREE.Group();
      pivot.position.set(0.6, armHeights[i], 0);
      var arm = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.42, 0.44), armMat);
      arm.position.set(3.1, 0, 0);
      arm.castShadow = true;
      pivot.add(arm);
      var clampHead = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.6, 0.9), towerMat);
      clampHead.position.set(6.2, 0, 0);
      pivot.add(clampHead);
      pivot.rotation.y = -0.22;
      tower.add(pivot);
      world.towerArms.push({ pivot: pivot, baseYaw: -0.22 });
    }
    tower.position.set(-7.6, 0, -1.6);
    g.add(tower);
    world.tower = tower;

    world.padLightMat = new THREE.MeshStandardMaterial({
      color: srgb(0x22262e), emissive: srgb(0xffd98a), emissiveIntensity: 1.1, roughness: 0.6
    });
    var bulbGeo = new THREE.SphereGeometry(0.34, 10, 8);
    world.padLights = [];
    for (var k = 0; k < 8; k++) {
      var a = (k / 8) * Math.PI * 2;
      var bulb = new THREE.Mesh(bulbGeo, world.padLightMat);
      bulb.position.set(Math.cos(a) * 9.4, PAD_Y + 0.4, Math.sin(a) * 9.4);
      g.add(bulb);
      world.padLights.push(bulb);
    }

    var apronMat = new THREE.MeshStandardMaterial({ color: srgb(0x5b626c), roughness: 0.95, metalness: 0.05 });
    var apron = new THREE.Mesh(new THREE.CylinderGeometry(16, 17.5, 0.3, 48), apronMat);
    apron.position.y = 0.13;
    apron.receiveShadow = true;
    g.add(apron);

    var hazardMat = new THREE.MeshStandardMaterial({
      color: srgb(0xd7b24a), roughness: 0.7, metalness: 0.1,
                                                   emissive: srgb(0x2a1f00), emissiveIntensity: 0.35
    });
    var hazard = new THREE.Mesh(new THREE.TorusGeometry(8.6, 0.12, 6, 64), hazardMat);
    hazard.rotation.x = Math.PI / 2;
    hazard.position.y = 2.34;
    g.add(hazard);

    var ringMat = new THREE.MeshStandardMaterial({ color: srgb(0x5d636d), roughness: 0.9 });
    var safetyRing = new THREE.Mesh(new THREE.TorusGeometry(12.4, 0.18, 6, 72), ringMat);
    safetyRing.rotation.x = Math.PI / 2;
    safetyRing.position.y = 0.30;
    g.add(safetyRing);
  }

  function setTowerArmsRetract(u) {
    if (!world.towerArms) return;
    u = clamp01(u);
    for (var i = 0; i < world.towerArms.length; i++) {
      world.towerArms[i].pivot.rotation.y = world.towerArms[i].baseYaw - u * 1.15;
    }
  }

  // --- Assets ---------------------------------------------------------------
  function loadTexture(key, path, onReady) {
    if (!THREEOK || !scene) return;
    try {
      new THREE.TextureLoader().load(encodePath(path), function (tex) {
        tex.encoding = THREE.sRGBEncoding;
        if (renderer) tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        textures[key] = tex;
        if (onReady) onReady(tex);
      }, undefined, function (err) {
        console.warn('[scene] texture failed, using procedural fallback:', path, err);
        noteAssetIssue('Texture unavailable: ' + path + ' (procedural look in use)');
      });
    } catch (e) {
      console.warn('[scene] texture error:', path, e);
      noteAssetIssue('Texture unavailable: ' + path + ' (procedural look in use)');
    }
  }

  function normalizeObject(obj, targetSize, baseAtZero, forceVertical) {
    var wrap = new THREE.Group();
    var box = new THREE.Box3().setFromObject(obj);
    var size = new THREE.Vector3();
    box.getSize(size);
    if (forceVertical) {
      if (size.x > size.y * 2.2 && size.x >= size.z) obj.rotation.z = Math.PI / 2;
      else if (size.z > size.y * 2.2 && size.z > size.x) obj.rotation.x = -Math.PI / 2;
      box.setFromObject(obj);
      box.getSize(size);
    }
    var maxDim = Math.max(size.x, size.y, size.z) || 1;
    obj.scale.setScalar(targetSize / maxDim);
    box.setFromObject(obj);
    var center = new THREE.Vector3();
    box.getCenter(center);
    obj.position.x -= center.x;
    obj.position.z -= center.z;
    if (baseAtZero) obj.position.y -= box.min.y;
    else obj.position.y -= center.y;
    wrap.add(obj);
    return wrap;
  }

  function loadModel(key, path, targetSize, baseAtZero, onReady, forceVertical) {
    if (!THREEOK) return;
    if (!hasGLTF) {
      noteAssetIssue('THREE.GLTFLoader not loaded -- built-in fallback used for ' + path);
      return;
    }
    try {
      new THREE.GLTFLoader().load(encodePath(path), function (gltf) {
        try {
          gltfTemplates[key] = normalizeObject(gltf.scene, targetSize, !!baseAtZero, !!forceVertical);
          if (onReady) onReady();
        } catch (e) {
          console.warn('[scene] model normalize failed:', path, e);
          noteAssetIssue('Model unusable: ' + path + ' (fallback in use)');
        }
      }, undefined, function (err) {
        console.warn('[scene] GLB failed, using fallback:', path, err);
        noteAssetIssue('Model unavailable: ' + path + ' (primitive fallback in use)');
      });
    } catch (e) {
      console.warn('[scene] GLB error:', path, e);
      noteAssetIssue('Model unavailable: ' + path + ' (primitive fallback in use)');
    }
  }

  function instanceModel(key, targetSize, baseAtZero) {
    var tpl = gltfTemplates[key];
    if (!tpl) return null;
    return normalizeObject(tpl.clone(true), targetSize, !!baseAtZero, false);
  }

  function onOrbitModelReady(slotKey) {
    if (world.orbitSlots && world.orbitSlots[slotKey]) tryMountSlotGLB(world.orbitSlots[slotKey]);
  }

  function loadAssets() {
    loadTexture('earthMap', ASSETS.textures.earthMap, function (tex) {
      if (!world.earth || !world.earthMat || !tex || !tex.image) return;
      var c = makeCanvas(1024, 512);
      var ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tex.image, 0, 0, 1024, 512);
      var rand = mulberry32(5150);
      for (var i = 0; i < 5600; i++) {
        ctx.globalAlpha = 0.03 + rand() * 0.05;
        ctx.fillStyle = rand() < 0.5 ? '#ffffff' : '#000000';
        ctx.fillRect(rand() * 1024, rand() * 512, 2 + rand() * 3, 2 + rand() * 3);
      }
      ctx.globalAlpha = 1;
      world.earthMat.uniforms.uMap.value = canvasTexture(c);
    });
    loadTexture('saturnMap', ASSETS.textures.saturnMap, function (tex) {
      if (world.saturnMat) world.saturnMat.uniforms.uMap.value = tex;
    });

      loadModel('rocketSaturnV', ASSETS.models.rocketSaturnV, SATURN_TARGET_H, true, function () {
        mountSaturnVRocket();
      }, true);
      loadModel('landerLM', ASSETS.models.landerLM, 5.4, true, function () {
        mountLanderGLB();
      }, false);
      loadModel('station', ASSETS.models.station, 16, false, function () {
        onOrbitModelReady('station'); refreshActivePayloadModel();
      }, false);
      loadModel('satTDRS', ASSETS.models.satTDRS, 7.5, false, function () {
        mountRelayGLB(); onOrbitModelReady('tdrs'); refreshActivePayloadModel();
      }, false);
      loadModel('satCubeSat', ASSETS.models.satCubeSat, 1.9, false, function () {
        refreshActivePayloadModel();
      }, false);
      loadModel('satMGS', ASSETS.models.satMGS, 6.5, false, function () {
        mountRelayGLB(); onOrbitModelReady('mgs'); refreshActivePayloadModel();
      }, false);
      loadModel('satICON', ASSETS.models.satICON, 5.0, false, function () {
        onOrbitModelReady('icon'); refreshActivePayloadModel();
      }, false);
      loadModel('satEO1', ASSETS.models.satEO1, 5.5, false, function () {
        onOrbitModelReady('eo1'); refreshActivePayloadModel();
      }, false);
      loadModel('satChandra', ASSETS.models.satChandra, 10.5, false, function () {
        onOrbitModelReady('chandra'); refreshActivePayloadModel();
      }, false);
      loadModel('satLandsat', ASSETS.models.satLandsat, 6.5, false, function () {
        onOrbitModelReady('landsat'); refreshActivePayloadModel();
      }, false);

      for (var i = 0; i < ASSETS.missingNow.length; i++) {
        noteAssetIssue('Asset not in repo yet: ' + ASSETS.missingNow[i] + ' (primitive fallback in use)');
      }
  }

  // --- Rocket ---------------------------------------------------------------
  function buildRocket() {
    var g = new THREE.Group();
    g.position.set(0, PAD_Y, 0);
    rocket.group = g;
    scene.add(g);

    rocket.matBody = new THREE.MeshStandardMaterial({ color: srgb(0xf1f4f9), roughness: 0.42, metalness: 0.18 });
    rocket.matDark = new THREE.MeshStandardMaterial({ color: srgb(0x2c333f), roughness: 0.55, metalness: 0.55 });
    rocket.matAccent = new THREE.MeshStandardMaterial({ color: srgb(0xe2574c), roughness: 0.5, metalness: 0.1 });
    rocket.matNozzle = new THREE.MeshStandardMaterial({ color: srgb(0x3a3f4a), roughness: 0.35, metalness: 0.85 });
    rocket.matWindow = new THREE.MeshStandardMaterial({
      color: srgb(0x9fd8ff), emissive: srgb(0x2a5f8f), emissiveIntensity: 0.9, roughness: 0.2, metalness: 0.1
    });
    rocket.matFuelFill = new THREE.MeshBasicMaterial({
      color: srgb(0x49d8ff), transparent: true, opacity: 0.88, depthWrite: false
    });

    rocket.primLower = [];
    rocket.primUpper = [];

    var lower = new THREE.Group();
    rocket.lower = lower;
    g.add(lower);

    var lowerBody = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 5.2, 26), rocket.matBody);
    lowerBody.position.y = 2.9;
    lowerBody.castShadow = true;
    lower.add(lowerBody);
    rocket.primLower.push(lowerBody);

    var stripe = new THREE.Mesh(new THREE.CylinderGeometry(1.52, 1.52, 0.55, 26), rocket.matAccent);
    stripe.position.y = 4.6;
    lower.add(stripe);
    rocket.primLower.push(stripe);

    rocket.skirt = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.32, 0.72, 26), rocket.matDark);
    rocket.skirt.position.y = 0.58;
    lower.add(rocket.skirt);

    rocket.collar = new THREE.Mesh(new THREE.CylinderGeometry(1.53, 1.53, 0.42, 26), rocket.matDark);
    rocket.collar.position.y = 5.38;
    lower.add(rocket.collar);

    var seamGeo = new THREE.CylinderGeometry(1.508, 1.508, 0.05, 26);
    for (var sm = 0; sm < 2; sm++) {
      var seam = new THREE.Mesh(seamGeo, rocket.matDark);
      seam.position.y = 1.85 + sm * 1.9;
      lower.add(seam);
      rocket.primLower.push(seam);
    }

    var finGeo = new THREE.BoxGeometry(0.18, 1.9, 1.6);
    for (var f = 0; f < 3; f++) {
      var fin = new THREE.Mesh(finGeo, rocket.matAccent);
      var ang = (f / 3) * Math.PI * 2;
      fin.position.set(Math.cos(ang) * 1.62, 1.3, Math.sin(ang) * 1.62);
      fin.rotation.y = -ang;
      fin.castShadow = true;
      lower.add(fin);
      rocket.primLower.push(fin);
    }

    rocket.nozzles = [];
    var nozzleGeo = new THREE.ConeGeometry(0.38, 0.92, 14);
    nozzleGeo.rotateX(Math.PI);
    for (var n = 0; n < NOZZLE_CAP; n++) {
      var noz = new THREE.Mesh(nozzleGeo, rocket.matNozzle);
      noz.position.y = 0.14;
      noz.visible = false;
      lower.add(noz);
      rocket.nozzles.push(noz);
    }
    rocket.bodyRadius = 1.5;

    rocket.fuelFills = [];
    rocket.fuelPanels = [];
    for (var p = 0; p < 2; p++) {
      var panel = new THREE.Group();
      panel.add(new THREE.Mesh(new THREE.BoxGeometry(0.56, 2.3, 0.1), rocket.matDark));
      var fillGeo = new THREE.PlaneGeometry(0.4, 1.9);
      fillGeo.translate(0, 0.95, 0);
      var fill = new THREE.Mesh(fillGeo, rocket.matFuelFill);
      fill.position.z = 0.07;
      fill.scale.y = 0.001;
      panel.add(fill);
      panel.position.set(0, 3.1, 1.53);
      if (p === 1) panel.rotation.y = Math.PI;
      lower.add(panel);
      rocket.fuelFills.push(fill);
      rocket.fuelPanels.push(panel);
    }

    rocket.flameLower = makeFlame(0.84, 4.4);
    rocket.flameLower.group.position.y = -0.35;
    lower.add(rocket.flameLower.group);

    var upper = new THREE.Group();
    rocket.upper = upper;
    g.add(upper);

    rocket.interstage = new THREE.Mesh(new THREE.CylinderGeometry(1.56, 1.56, 0.34, 26), rocket.matDark);
    rocket.interstage.position.y = 5.62;
    upper.add(rocket.interstage);

    var upperBody = new THREE.Mesh(new THREE.CylinderGeometry(1.44, 1.5, 3.6, 26), rocket.matBody);
    upperBody.position.y = 7.5;
    upperBody.castShadow = true;
    upper.add(upperBody);
    rocket.primUpper.push(upperBody);

    var windowStrip = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.34, 0.12), rocket.matWindow);
    windowStrip.position.set(0, 8.3, 1.44);
    upper.add(windowStrip);
    rocket.primUpper.push(windowStrip);

    var nose = new THREE.Mesh(new THREE.ConeGeometry(1.44, 2.3, 26), rocket.matBody);
    nose.position.y = 10.55;
    nose.castShadow = true;
    upper.add(nose);
    rocket.primUpper.push(nose);

    var tip = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.7, 12), rocket.matAccent);
    tip.position.y = 12.0;
    upper.add(tip);
    rocket.primUpper.push(tip);

    rocket.secondNozzle = new THREE.Mesh(nozzleGeo, rocket.matNozzle);
    rocket.secondNozzle.position.y = 5.4;
    rocket.secondNozzle.scale.setScalar(0.85);
    upper.add(rocket.secondNozzle);

    rocket.flameUpper = makeFlame(0.65, 3.6);
    rocket.flameUpper.group.position.y = 5.1;
    rocket.flameUpper.group.visible = false;
    upper.add(rocket.flameUpper.group);

    rocket.payload = makePayload();
    rocket.payload.group.position.set(0, 8.2, 0);
    rocket.payload.group.visible = false;
    upper.add(rocket.payload.group);

    rocket.beaconMat = new THREE.MeshStandardMaterial({
      color: srgb(0x332211), emissive: srgb(0xffb347), emissiveIntensity: 0.0, roughness: 0.5
    });
    rocket.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), rocket.beaconMat);
    rocket.beacon.position.set(0, 9.6, 1.4);
    upper.add(rocket.beacon);

    rocket.craftLight = new THREE.PointLight(0xbfe0ff, 0.65, 52, 2);
    rocket.craftLight.position.set(0, 7, 3);
    g.add(rocket.craftLight);
    rocket.engineLight = new THREE.PointLight(0xffa44d, 0, 75, 2);
    rocket.engineLight.position.set(0, 0.4, 0);
    g.add(rocket.engineLight);

    rocket.clip = {
      active: false,
      localBottom: new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.82),
             localLowerTop: new THREE.Plane(new THREE.Vector3(0, -1, 0), ROCKET_SPLIT_Y),
             localUpperBottom: new THREE.Plane(new THREE.Vector3(0, 1, 0), -ROCKET_SPLIT_Y),
             worldBottom: new THREE.Plane(),
             worldLowerTop: new THREE.Plane(),
             worldUpperBottom: new THREE.Plane()
    };

    rocket.fuelRatio = null;
    rocket.engineCount = 1;
    rocket.lowerFaded = false;
    rocket.payloadDeployed = false;
    rocket.pendingSaturnMount = false;
  }

  function measureTemplateRadius(tpl, yMin, yMax) {
    tpl.updateMatrixWorld(true);
    var v = new THREE.Vector3();
    var maxR = 0;
    tpl.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      var pos = o.geometry.attributes.position;
      var step = Math.max(1, Math.floor(pos.count / 600));
      for (var i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (v.y >= yMin && v.y <= yMax) {
          var r = Math.sqrt(v.x * v.x + v.z * v.z);
          if (r > maxR) maxR = r;
        }
      }
    });
    return maxR > 0.35 ? clamp(maxR, 0.55, 1.7) : 0.85;
  }

  function cloneWithClipPlanes(src, planes, fadeable) {
    var copy = src.clone(true);
    copy.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      o.castShadow = true; o.receiveShadow = true;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      var out = [];
      for (var i = 0; i < mats.length; i++) {
        var m = mats[i].clone();
        m.clippingPlanes = planes;
        m.clipShadows = true;
        if (fadeable) { m.userData = m.userData || {}; m.userData.__fadeOut = true; }
        out.push(m);
      }
      o.material = Array.isArray(o.material) ? out : out[0];
    });
    return copy;
  }

  function mountSaturnVRocket() {
    if (!rocket.lower || !rocket.upper || !gltfTemplates.rocketSaturnV) return;
    if (rocket.saturnMounted) return;
    if (rocket.lowerFaded) { rocket.pendingSaturnMount = true; return; }
    rocket.pendingSaturnMount = false;
    rocket.saturnMounted = true;

    var tpl = gltfTemplates.rocketSaturnV;
    var rLower = measureTemplateRadius(tpl, 2.2, 4.8);
    var rUpper = measureTemplateRadius(tpl, 5.8, 8.8);
    rocket.bodyRadius = rLower;

    rocket.clip.active = true;
    rocket.saturnLower = cloneWithClipPlanes(tpl, [rocket.clip.worldBottom, rocket.clip.worldLowerTop], true);
    rocket.saturnUpper = cloneWithClipPlanes(tpl, [rocket.clip.worldUpperBottom], false);
    rocket.lower.add(rocket.saturnLower);
    rocket.upper.add(rocket.saturnUpper);

    var i;
    for (i = 0; i < rocket.primLower.length; i++) rocket.primLower[i].visible = false;
    for (i = 0; i < rocket.primUpper.length; i++) rocket.primUpper[i].visible = false;

    var scL = rLower / 1.5, scU = rUpper / 1.5;
    if (rocket.skirt) { rocket.skirt.scale.set(scL * 1.03, 1.05, scL * 1.03); rocket.skirt.position.y = 0.62; }
    if (rocket.collar) { rocket.collar.scale.set(scL * 1.02, 0.72, scL * 1.02); rocket.collar.position.y = ROCKET_SPLIT_Y - 0.14; }
    if (rocket.interstage) { rocket.interstage.scale.set(scL * 1.01, 0.7, scL * 1.01); rocket.interstage.position.y = ROCKET_SPLIT_Y + 0.1; }
    if (rocket.secondNozzle) { rocket.secondNozzle.scale.setScalar(clamp(scU * 0.85, 0.45, 0.95)); rocket.secondNozzle.position.y = ROCKET_SPLIT_Y - 0.18; }
    if (rocket.beacon) rocket.beacon.position.set(0, 9.6, rUpper + 0.08);

    var pScale = clamp(rLower / 1.35, 0.58, 1.0);
    for (i = 0; i < rocket.fuelPanels.length; i++) {
      rocket.fuelPanels[i].scale.set(pScale, 1, pScale);
      rocket.fuelPanels[i].position.set(0, 3.1, (i === 0 ? 1 : -1) * (rLower + 0.04));
    }

    updateNozzles(rocket.engineCount);
    updateRocketClipPlanes();
  }

  function updateRocketClipPlanes() {
    if (!rocket.clip || !rocket.clip.active || !rocket.lower || !rocket.upper) return;
    rocket.lower.updateMatrixWorld(true);
    rocket.clip.worldBottom.copy(rocket.clip.localBottom).applyMatrix4(rocket.lower.matrixWorld);
    rocket.clip.worldLowerTop.copy(rocket.clip.localLowerTop).applyMatrix4(rocket.lower.matrixWorld);
    rocket.upper.updateMatrixWorld(true);
    rocket.clip.worldUpperBottom.copy(rocket.clip.localUpperBottom).applyMatrix4(rocket.upper.matrixWorld);
  }

  function makeFlame(radius, len) {
    var group = new THREE.Group();
    var outerGeo = new THREE.ConeGeometry(radius, len, 16, 1, true);
    outerGeo.translate(0, -len / 2, 0);
    var outer = new THREE.Mesh(outerGeo, new THREE.MeshBasicMaterial({
      color: srgb(0xff6b1a), transparent: true, opacity: 0.7,
                                                                     blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    }));
    var midGeo = new THREE.ConeGeometry(radius * 0.72, len * 0.86, 14, 1, true);
    midGeo.translate(0, -len * 0.43, 0);
    var mid = new THREE.Mesh(midGeo, new THREE.MeshBasicMaterial({
      color: srgb(0xffb648), transparent: true, opacity: 0.8,
                                                                 blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    }));
    var innerGeo = new THREE.ConeGeometry(radius * 0.42, len * 0.65, 12, 1, true);
    innerGeo.translate(0, -len * 0.325, 0);
    var inner = new THREE.Mesh(innerGeo, new THREE.MeshBasicMaterial({
      color: srgb(0xfffbe0), transparent: true, opacity: 0.92,
                                                                     blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    }));
    outer.frustumCulled = false; mid.frustumCulled = false; inner.frustumCulled = false;
    group.add(outer); group.add(mid); group.add(inner);

    var diamonds = [];
    var diaGeo = new THREE.OctahedronGeometry(radius * 0.34, 0);
    var diaMat = new THREE.MeshBasicMaterial({
      color: srgb(0xfff3d4), transparent: true, opacity: 0.82,
                                             blending: THREE.AdditiveBlending, depthWrite: false
    });
    for (var d = 0; d < 3; d++) {
      var dia = new THREE.Mesh(diaGeo, diaMat);
      dia.scale.set(0.75, 1.5, 0.75);
      dia.position.y = -len * (0.28 + d * 0.24);
      dia.frustumCulled = false;
      group.add(dia);
      diamonds.push(dia);
    }

    group.visible = false;
    return { group: group, outer: outer, mid: mid, inner: inner, diamonds: diamonds, len: len, radius: radius, level: 0 };
  }

  function makePayload() {
    var group = new THREE.Group();
    var fallback = new THREE.Group();
    var bodyMat = new THREE.MeshStandardMaterial({ color: srgb(0xdfe4ec), roughness: 0.5, metalness: 0.4 });
    var panelMat = new THREE.MeshStandardMaterial({
      color: srgb(0x1f3d8f), emissive: srgb(0x0a1a44), emissiveIntensity: 0.5, roughness: 0.35, metalness: 0.3
    });
    fallback.add(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), bodyMat));
    for (var s = -1; s <= 1; s += 2) {
      var panel = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 0.8), panelMat);
      panel.position.set(s * 0.5, 0, 0);
      panel.rotation.z = s * 1.3;
      panel.userData.isPanel = true;
      panel.userData.side = s;
      fallback.add(panel);
    }
    group.add(fallback);
    var glbSlot = new THREE.Group();
    group.add(glbSlot);
    group.userData = { fallback: fallback, glbSlot: glbSlot, currentKey: null };
    group.visible = false;
    return { group: group };
  }

  function payloadKeyForMission(mission) {
    var m = mission && typeof mission === 'object' ? mission : {};
    var txt = (str(m.id) + ' ' + str(m.name) + ' ' + str(m.destinationName) + ' ' + str(m.destination)).toLowerCase();
    if (txt.indexOf('landsat') !== -1) return 'satLandsat';
    if (txt.indexOf('eo-1') !== -1 || txt.indexOf('eo1') !== -1 || txt.indexOf('earth observing') !== -1) return 'satEO1';
    if (txt.indexOf('icon') !== -1 || txt.indexOf('ionospher') !== -1) return 'satICON';
    if (txt.indexOf('chandra') !== -1 || txt.indexOf('x-ray') !== -1 || txt.indexOf('observatory') !== -1) return 'satChandra';
    if (txt.indexOf('tdrs') !== -1 || txt.indexOf('relay') !== -1) return 'satTDRS';
    if (txt.indexOf('mars') !== -1 || txt.indexOf('surveyor') !== -1) return 'satMGS';
    if (txt.indexOf('gateway') !== -1 || txt.indexOf('station') !== -1) return 'station';
    return 'satCubeSat';
  }

  function setPayloadModelForMission(mission) {
    rocket.activePayloadMission = mission || null;
    refreshActivePayloadModel();
  }

  function refreshActivePayloadModel() {
    if (!rocket.payload || !rocket.payload.group) return;
    var ud = rocket.payload.group.userData;
    if (!ud || !ud.glbSlot) return;
    var wantKey = payloadKeyForMission(rocket.activePayloadMission);
    if (!gltfTemplates[wantKey] && gltfTemplates.satCubeSat) wantKey = 'satCubeSat';
    if (!gltfTemplates[wantKey]) {
      ud.fallback.visible = true; ud.glbSlot.visible = false; return;
    }
    if (ud.currentKey === wantKey && ud.glbSlot.children.length > 0) {
      ud.fallback.visible = false; ud.glbSlot.visible = true; return;
    }
    while (ud.glbSlot.children.length) ud.glbSlot.remove(ud.glbSlot.children[0]);
    var inst = instanceModel(wantKey, wantKey === 'satCubeSat' ? 2.0 : 3.2, false);
    if (inst) {
      ud.glbSlot.add(inst);
      ud.glbSlot.visible = true;
      ud.fallback.visible = false;
      ud.currentKey = wantKey;
    } else {
      ud.fallback.visible = true; ud.glbSlot.visible = false;
    }
  }

  function readEngineCount(build) {
    var candidates = [build.engines, build.engineCount, build.nozzles];
    for (var i = 0; i < candidates.length; i++) {
      if (isNum(candidates[i]) && candidates[i] > 0) return clamp(Math.round(candidates[i]), 1, NOZZLE_CAP);
    }
    return 1;
  }

  function readFuelRatio(build) {
    if (isNum(build.fuelPct)) return clamp01(build.fuelPct / 100);
    if (isNum(build.fuel)) {
      if (build.fuel >= 0 && build.fuel <= 1) return clamp01(build.fuel);
      if (build.fuel > 1 && build.fuel <= 100) return clamp01(build.fuel / 100);
      return null;
    }
    if (isNum(build.fuelLevel)) return clamp01(build.fuelLevel);
    return null;
  }

  function updateNozzles(count) {
    rocket.engineCount = count;
    var rBody = rocket.bodyRadius || 1.5;
    var nScale = clamp(rBody / 1.35, 0.5, 1.0);
    var ringR = count === 1 ? 0 : rBody * (count <= 4 ? 0.44 : 0.56);
    for (var i = 0; i < rocket.nozzles.length; i++) {
      var noz = rocket.nozzles[i];
      if (i < count) {
        noz.visible = true;
        noz.scale.setScalar(nScale);
        if (count === 1 || (count === NOZZLE_CAP && i === NOZZLE_CAP - 1)) {
          noz.position.x = 0; noz.position.z = 0;
        } else {
          var slots = count === NOZZLE_CAP ? count - 1 : count;
          var ang = (i / slots) * Math.PI * 2 - Math.PI / 2;
          noz.position.x = Math.cos(ang) * ringR;
          noz.position.z = Math.sin(ang) * ringR;
        }
      } else {
        noz.visible = false;
      }
    }
  }

  function updateFuelPanels(ratio) {
    rocket.fuelRatio = ratio;
    var y = ratio === null ? 0.001 : Math.max(0.001, ratio);
    for (var i = 0; i < rocket.fuelFills.length; i++) rocket.fuelFills[i].scale.y = y;
    rocket.matFuelFill.color.setHex(ratio === null ? 0x8b93a1 : 0x49d8ff);
    rocket.matFuelFill.opacity = ratio === null ? 0.4 : 0.88;
  }

  function setFlame(level, vacExpand) {
    if (!rocket.flameLower) return;
    level = clamp01(level);
    var rScale = clamp((rocket.bodyRadius || 1.5) / 1.35, 0.62, 1.05);
    var vac = isNum(vacExpand) ? vacExpand : 1.0;
    applyFlame(rocket.flameLower, level, rScale * vac);
    applyFlame(rocket.flameUpper, rocket.upperFlameLevel || 0, rScale * 0.85 * Math.max(1.2, vac));
    if (rocket.engineLight) rocket.engineLight.intensity = level * 3.2;
  }

  function applyFlame(f, level, widthScale) {
    if (!f) return;
    f.level = level;
    if (level <= 0.015) { f.group.visible = false; return; }
    f.group.visible = true;
    var w = widthScale * (0.72 + level * 0.4);
    var flick = 0.94 + 0.1 * wobble(elapsedWall * 38);
    f.group.scale.set(w, level * flick, w);
    f.outer.material.opacity = 0.35 + level * 0.42;
    if (f.mid) f.mid.material.opacity = 0.45 + level * 0.42;
    f.inner.material.opacity = 0.55 + level * 0.45;
    if (f.diamonds) {
      for (var d = 0; d < f.diamonds.length; d++) {
        var pulse = 0.72 + 0.35 * Math.sin(elapsedWall * 44 + d * 1.9);
        f.diamonds[d].scale.set(0.75 * pulse, 1.45 * pulse, 0.75 * pulse);
      }
    }
  }

  function resetRocketVisual() {
    if (!rocket.group) return;
    rocket.group.visible = true;
    rocket.group.position.set(0, PAD_Y, 0);
    rocket.group.rotation.set(0, 0, 0);
    rocket.upperFlameLevel = 0;
    rocket.lastSmokeY = PAD_Y;
    setFlame(0);
    rocket.beaconMat.emissiveIntensity = 0;
    if (rocket.craftLight) rocket.craftLight.intensity = 0.65;
    if (rocket.payload && rocket.payload.group) {
      rocket.payload.group.visible = false;
      rocket.payload.group.position.set(0, 8.2, 0);
      rocket.payload.group.rotation.set(0, 0, 0);
      rocket.payload.group.traverse(function (o) {
        if (o.userData && o.userData.isPanel) {
          var s = o.userData.side || 1;
          o.position.x = s * 0.5;
          o.rotation.z = s * 1.3;
        }
      });
    }
    rocket.payloadDeployed = false;
    restoreLowerStage();
    if (rocket.pendingSaturnMount) mountSaturnVRocket();
    updateFuelPanels(rocket.fuelRatio);
    setTowerArmsRetract(0);
    restoreLighting();
    updateRocketClipPlanes();
  }

  function restoreLowerStage() {
    if (!rocket.lower) return;
    rocket.lower.position.set(0, 0, 0);
    rocket.lower.rotation.set(0, 0, 0);
    rocket.lower.scale.set(1, 1, 1);
    rocket.lower.visible = true;
    if (rocket.lowerFaded) {
      rocket.lower.traverse(function (o) {
        if (o.isMesh && o.material) {
          var mats = Array.isArray(o.material) ? o.material : [o.material];
          for (var i = 0; i < mats.length; i++) {
            if (mats[i].userData && mats[i].userData.__fadeOut) {
              mats[i].transparent = false; mats[i].opacity = 1; mats[i].needsUpdate = true;
            }
          }
        }
      });
      rocket.lowerFaded = false;
    }
    if (rocket.flameLower) rocket.flameLower.group.visible = false;
    if (rocket.flameUpper) rocket.flameUpper.group.visible = false;
  }

  function makeLowerFadeable() {
    if (rocket.lowerFaded) return;
    rocket.lower.traverse(function (o) {
      if (o.isMesh && o.material) {
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        var cloned = [];
        for (var i = 0; i < mats.length; i++) {
          var m = mats[i].clone();
          m.transparent = true;
          m.userData = m.userData || {};
          m.userData.__fadeOut = true;
          cloned.push(m);
        }
        o.material = Array.isArray(o.material) ? cloned : cloned[0];
      }
    });
    rocket.lowerFaded = true;
  }

  function fadeLowerStage(dur, token) {
    makeLowerFadeable();
    var targets = [];
    rocket.lower.traverse(function (o) {
      if (o.isMesh && o.material) {
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        for (var i = 0; i < mats.length; i++) {
          if (mats[i].userData && mats[i].userData.__fadeOut && targets.indexOf(mats[i]) === -1) targets.push(mats[i]);
        }
      }
    });
    addTween({
      from: 1, to: 0, dur: dur, token: token, ease: easeInQuad,
      onUpdate: function (v) { for (var i = 0; i < targets.length; i++) targets[i].opacity = v; },
             onComplete: function () {
               rocket.lower.visible = false;
               for (var i = 0; i < targets.length; i++) targets[i].needsUpdate = true;
             }
    });
  }

  // --- Effects --------------------------------------------------------------
  var POOL_VS = [
    'attribute float aSize;',
    'attribute float aAlpha;',
    'varying float vAlpha;',
    'void main() {',
      '  vAlpha = aAlpha;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
             '  gl_PointSize = aSize * (320.0 / max(-mv.z, 1.0));',
             '  gl_Position = projectionMatrix * mv;',
             '}'
  ].join('\n');

  var POOL_FS = [
    'uniform vec3 uColor;',
    'uniform float uOpacity;',
    'varying float vAlpha;',
    'void main() {',
      '  vec2 d = gl_PointCoord - vec2(0.5);',
             '  float r = length(d);',
             '  if (r > 0.5) discard;',
             '  float a = smoothstep(0.5, 0.04, r) * vAlpha * uOpacity;',
             '  gl_FragColor = vec4(uColor, a);',
             '}'
  ].join('\n');

  function makePool(capacity, opts) {
    var positions = new Float32Array(capacity * 3);
    var sizes = new Float32Array(capacity);
    var alphas = new Float32Array(capacity);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    geo.setDrawRange(0, capacity);
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(opts.color) },
                                       uOpacity: { value: opts.opacity }
      },
      vertexShader: POOL_VS, fragmentShader: POOL_FS,
      transparent: true, depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    var points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);

    return {
      capacity: capacity, points: points, pos: positions, size: sizes, alpha: alphas, geo: geo,
      vx: new Float32Array(capacity), vy: new Float32Array(capacity), vz: new Float32Array(capacity),
             life: new Float32Array(capacity), maxLife: new Float32Array(capacity),
             base: new Float32Array(capacity), grow: new Float32Array(capacity), drag: new Float32Array(capacity),
             cursor: 0, dirty: false,
             spawn: function (x, y, z, vx, vy, vz, size, life, grow, drag) {
               var i = this.cursor;
               this.cursor = (this.cursor + 1) % this.capacity;
               this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
               this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
               this.life[i] = life; this.maxLife[i] = life;
               this.base[i] = size; this.grow[i] = grow || 0;
               this.drag[i] = drag === undefined ? 1.2 : drag;
               this.alpha[i] = 0; this.dirty = true;
             },
             update: function (dt) {
               if (dt <= 0) return;
               var any = false;
               for (var i = 0; i < this.capacity; i++) {
                 if (this.life[i] <= 0) { if (this.alpha[i] !== 0) { this.alpha[i] = 0; any = true; } continue; }
                 this.life[i] -= dt;
                 var k = Math.max(0, this.life[i]) / (this.maxLife[i] || 1);
                 var dmp = Math.max(0, 1 - this.drag[i] * dt);
                 this.vx[i] *= dmp; this.vy[i] *= dmp; this.vz[i] *= dmp;
                 this.pos[i * 3] += this.vx[i] * dt;
                 this.pos[i * 3 + 1] += this.vy[i] * dt;
                 this.pos[i * 3 + 2] += this.vz[i] * dt;
                 var age = 1 - k;
                 this.size[i] = this.base[i] * (1 + age * this.grow[i]);
                 this.alpha[i] = this.life[i] <= 0 ? 0 : Math.min(Math.min(1, age * 6), k * 1.6);
                 any = true;
               }
               if (any || this.dirty) {
                 this.geo.attributes.position.needsUpdate = true;
                 this.geo.attributes.aSize.needsUpdate = true;
                 this.geo.attributes.aAlpha.needsUpdate = true;
                 this.dirty = false;
               }
             },
             clear: function () {
               for (var i = 0; i < this.capacity; i++) { this.life[i] = 0; this.alpha[i] = 0; }
               this.geo.attributes.aAlpha.needsUpdate = true;
               this.geo.attributes.position.needsUpdate = true;
             }
    };
  }

  function createEffects() {
    var low = reducedMotion;
    effects.smoke = makePool(low ? 140 : 340, { color: srgb(0xd4dbe4), opacity: 0.54, additive: false });
    effects.dust = makePool(low ? 100 : 260, { color: srgb(0xc9a97e), opacity: 0.62, additive: false });
    effects.glow = makePool(low ? 60 : 140, { color: srgb(0x9fe4ff), opacity: 0.9, additive: true });
    effects.sparks = makePool(low ? 60 : 160, { color: srgb(0xffb54d), opacity: 0.95, additive: true });

    effects.packets = [];
    var pGeo = new THREE.SphereGeometry(0.32, 8, 6);
    var pMat = new THREE.MeshBasicMaterial({
      color: srgb(0x7ff0ff), transparent: true, opacity: 0.95,
                                           blending: THREE.AdditiveBlending, depthWrite: false
    });
    for (var i = 0; i < 16; i++) {
      var m = new THREE.Mesh(pGeo, pMat);
      m.visible = false; m.frustumCulled = false;
      scene.add(m);
      effects.packets.push({ mesh: m, active: false, t: 0, dur: 1, from: null, to: null, toObj: null, arc: 0, onArrive: null });
    }

    effects.flash = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({
      color: srgb(0xffffff), transparent: true, opacity: 0, depthTest: false, depthWrite: false
    }));
    effects.flash.position.set(0, 0, -1);
    effects.flash.renderOrder = 999;
    effects.flash.frustumCulled = false;
    effects.flash.visible = false;
    scene.add(effects.flash);

    effects.reticle = new THREE.Mesh(new THREE.RingGeometry(0.8, 0.95, 32), new THREE.MeshBasicMaterial({
      color: srgb(0x8ff3ff), transparent: true, opacity: 0,
                                                                                                        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    }));
    effects.reticle.visible = false;
    effects.reticle.frustumCulled = false;
    scene.add(effects.reticle);

    createWarp();
    effects.dustTargetY = -1;
  }

  function emitPadSteam(dt, strength) {
    if (!effects.smoke) return;
    var n = Math.max(1, Math.round(strength * dt * 45 * (reducedMotion ? 0.35 : 1)));
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 5.5 + Math.random() * 10.5 * strength;
      effects.smoke.spawn(
        Math.cos(a) * 1.4, 0.6 + Math.random() * 0.9, Math.sin(a) * 1.4,
                          Math.cos(a) * sp, 1.2 + Math.random() * 3.5, Math.sin(a) * sp,
                          2.6 + Math.random() * 2.2, 1.4 + Math.random() * 1.1, 3.6, 1.8
      );
      if (effects.sparks && Math.random() < 0.65) {
        effects.sparks.spawn(
          Math.cos(a) * 1.1, 0.8 + Math.random() * 0.6, Math.sin(a) * 1.1,
                             Math.cos(a) * (sp * 1.4), 1.8 + Math.random() * 4.5, Math.sin(a) * (sp * 1.4),
                             0.35 + Math.random() * 0.35, 0.45 + Math.random() * 0.45, -0.4, 1.5
        );
      }
    }
  }

  function emitCryoVent(dt) {
    if (!effects.smoke || !rocket.group) return;
    cryoTimer += dt;
    var interval = reducedMotion ? 0.24 : 0.085;
    if (cryoTimer < interval) return;
    cryoTimer = 0;
    var r = rocket.bodyRadius || 1.2;
    effects.smoke.spawn(
      rocket.group.position.x + r * 0.95, PAD_Y + 8.6 + (Math.random() - 0.5) * 0.4, rocket.group.position.z + 0.2,
                        1.6 + Math.random() * 1.4, 0.35 + Math.random() * 0.5, (Math.random() - 0.5) * 0.7,
                        0.8 + Math.random() * 0.7, 1.2 + Math.random() * 0.7, 2.2, 1.2
    );
  }

  function emitSmokeTrail(dt, level) {
    if (!rocket.flameLower || !rocket.group) return;
    var px = rocket.group.position.x, pz = rocket.group.position.z, py = rocket.group.position.y;
    var upperBurning = (rocket.upperFlameLevel || 0) > 0.1;
    var offY = upperBurning ? 5.0 : -0.4;
    var lastY = isNum(rocket.lastSmokeY) ? rocket.lastSmokeY : py;
    if (Math.abs(py - lastY) > 40) lastY = py;
    var span = Math.abs(py - lastY);
    var steps = Math.max(1, Math.min(6, Math.round(span / 1.5)));
    var n = level > 0.6 ? 2 : 1;

    for (var s = 0; s < steps; s++) {
      var sy = lastY + (py - lastY) * ((s + 1) / steps);
      var count = Math.max(1, Math.round(n * (reducedMotion ? 0.4 : 1)));
      for (var i = 0; i < count; i++) {
        effects.smoke.spawn(
          px + (Math.random() - 0.5) * 1.3,
                            Math.max(sy + offY, PAD_Y * 0.4) + (Math.random() - 0.5) * 0.9,
                            pz + (Math.random() - 0.5) * 1.3,
                            (Math.random() - 0.5) * 2.4,
                            -2.2 - Math.random() * 2.8 - (sy + offY > 8 ? 0 : 1.4),
                            (Math.random() - 0.5) * 2.4,
                            2.2 + Math.random() * 2.1,
                            1.7 + Math.random() * 1.2,
                            3.4, 1.5
        );
      }
    }
    if (py < 18) emitPadSteam(dt, clamp01(1 - py / 18) * level);
    rocket.lastSmokeY = py;
  }

  function emitSepBurst(x, y, z) {
    if (!effects.smoke || !effects.glow) return;
    var count = reducedMotion ? 10 : 22;
    for (var i = 0; i < count; i++) {
      var a = (i / count) * Math.PI * 2;
      var sp = 3.2 + Math.random() * 2.6;
      effects.smoke.spawn(x, y, z, Math.cos(a) * sp, (Math.random() - 0.5) * 1.8, Math.sin(a) * sp,
                          1.1 + Math.random() * 0.8, 1.1 + Math.random() * 0.5, 2.4, 2.2);
      effects.glow.spawn(x, y, z, Math.cos(a) * (sp * 1.25), (Math.random() - 0.5) * 2.0, Math.sin(a) * (sp * 1.25),
                         0.55 + Math.random() * 0.3, 0.5 + Math.random() * 0.25, 1.2, 2.6);
    }
  }

  function emitRcsPuff(x, y, z, dx, dy, dz) {
    if (!effects.glow) return;
    for (var i = 0; i < (reducedMotion ? 3 : 6); i++) {
      effects.glow.spawn(x, y, z,
                         dx * (3 + Math.random() * 2) + (Math.random() - 0.5) * 0.7,
                         dy * (3 + Math.random() * 2) + (Math.random() - 0.5) * 0.7,
                         dz * (3 + Math.random() * 2) + (Math.random() - 0.5) * 0.7,
                         0.55 + Math.random() * 0.3, 0.45 + Math.random() * 0.2, 2.0, 2.2);
    }
  }

  function emitDustBurst(x, y, z, strength) {
    if (!effects.dust) return;
    var n = Math.round(clamp(strength, 0, 1) * (reducedMotion ? 9 : 26));
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 3.2 + Math.random() * 7.8 * strength;
      effects.dust.spawn(
        x + Math.cos(a) * (0.6 + Math.random()), y + 0.25, z + Math.sin(a) * (0.6 + Math.random()),
                         Math.cos(a) * sp, 1 + Math.random() * 3.2 * strength, Math.sin(a) * sp,
                         1.3 + Math.random() * 1.7, 1.2 + Math.random() * 0.9, 2.4, 2.3
      );
    }
  }

  function emitDustTrail(x, y, z, dt, strength) {
    if (!effects.dust || strength <= 0) return;
    var count = Math.max(1, Math.round(strength * dt * 45 * (reducedMotion ? 0.4 : 1)));
    if (count > 5) count = 5;
    for (var i = 0; i < count; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 1.5 + Math.random() * 4 * strength;
      effects.dust.spawn(
        x + (Math.random() - 0.5) * 2.4, y + 0.2, z + (Math.random() - 0.5) * 2.4,
                         Math.cos(a) * sp, 0.8 + Math.random() * 2 * strength, Math.sin(a) * sp,
                         1.1 + Math.random() * 1.4, 0.9 + Math.random() * 0.7, 2.0, 2.6
      );
    }
  }

  function updateEffects(dt) {
    if (effects.smoke) effects.smoke.update(dt);
    if (effects.dust) effects.dust.update(dt);
    if (effects.glow) effects.glow.update(dt);
    if (effects.sparks) effects.sparks.update(dt);
    updatePackets(dt);
    if (effects.dustTargetY >= 0 && surface.lander) {
      var ly = surface.lander.position.y;
      if (ly < 11 && ly >= -0.5) {
        var strength = clamp01(1 - Math.max(0, ly) / 11);
        emitDustTrail(surface.lander.position.x, 0, surface.lander.position.z, dt, strength * 0.95);
      }
    }
  }

  function launchPacket(from, to, dur, arc, token, onArrive, toObj) {
    if (!effects.packets) return null;
    for (var i = 0; i < effects.packets.length; i++) {
      var p = effects.packets[i];
      if (p.active) continue;
      p.active = true; p.t = 0; p.dur = dur;
      p.from = { x: from.x, y: from.y, z: from.z };
      p.to = { x: to.x, y: to.y, z: to.z };
      p.toObj = toObj || null;
      p.arc = arc || 0;
      p.token = token === undefined ? null : token;
      p.onArrive = onArrive || null;
      p.mesh.visible = true;
      p.mesh.position.set(p.from.x, p.from.y, p.from.z);
      return p;
    }
    return null;
  }

  function updatePackets(dt) {
    if (!effects.packets) return;
    for (var i = 0; i < effects.packets.length; i++) {
      var p = effects.packets[i];
      if (!p.active) continue;
      p.t += dt;
      var u = clamp01(p.t / p.dur), e = easeInOut(u);
      var tx = p.toObj ? p.toObj.position.x : p.to.x;
      var ty = p.toObj ? p.toObj.position.y : p.to.y;
      var tz = p.toObj ? p.toObj.position.z : p.to.z;
      var y = lerp(p.from.y, ty, e) + (p.arc ? Math.sin(u * Math.PI) * p.arc : 0);
      p.mesh.position.set(lerp(p.from.x, tx, e), y, lerp(p.from.z, tz, e));
      p.mesh.scale.setScalar(0.85 + 0.35 * Math.sin(p.t * 16));
      if (u >= 1) {
        p.active = false; p.mesh.visible = false;
        var cb = p.onArrive, tk = p.token;
        p.onArrive = null; p.toObj = null;
        if (cb && (tk === null || tk === runToken)) cb();
      }
    }
  }

  function stopEffects() {
    if (effects.smoke) effects.smoke.clear();
    if (effects.dust) effects.dust.clear();
    if (effects.glow) effects.glow.clear();
    if (effects.sparks) effects.sparks.clear();
    effects.dustTargetY = -1;
    if (effects.reticle) effects.reticle.visible = false;
    if (effects.flash) { effects.flash.visible = false; effects.flash.material.opacity = 0; }
    if (effects.warp) {
      effects.warp.visible = false;
      if (effects.warp.material.userData.base) {
        effects.warp.material.color.copy(effects.warp.material.userData.base).multiplyScalar(0);
      }
    }
    if (effects.packets) {
      for (var i = 0; i < effects.packets.length; i++) {
        effects.packets[i].active = false;
        effects.packets[i].onArrive = null;
        effects.packets[i].toObj = null;
        effects.packets[i].mesh.visible = false;
      }
    }
  }

  function shutterFlash(token, peak) {
    if (!effects.flash) return;
    var f = effects.flash;
    f.visible = true;
    addTween({
      from: 0, to: peak || 0.5, dur: 0.09, token: token,
      onUpdate: function (v) { f.material.opacity = v; },
             onComplete: function () {
               addTween({
                 from: peak || 0.5, to: 0, dur: 0.22, token: token, ease: easeOutCubic,
                 onUpdate: function (v) { f.material.opacity = v; },
                        onComplete: function () { f.visible = false; f.material.opacity = 0; }
               });
             }
    });
  }

  function createWarp() {
    var count = reducedMotion ? 50 : 170;
    var positions = new Float32Array(count * 6);
    var rand = mulberry32(3131);
    for (var i = 0; i < count; i++) {
      var a = rand() * Math.PI * 2, z = -4 - rand() * 8;
      var r1 = 0.25 + rand() * 1.7, r2 = r1 + 1.2 + rand() * 3.8;
      var ca = Math.cos(a), sa = Math.sin(a);
      positions[i * 6] = ca * r1; positions[i * 6 + 1] = sa * r1; positions[i * 6 + 2] = z;
      positions[i * 6 + 3] = ca * r2; positions[i * 6 + 4] = sa * r2; positions[i * 6 + 5] = z;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    var mat = new THREE.LineBasicMaterial({
      color: srgb(0xd8ecff), transparent: true, opacity: 1,
                                          blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false
    });
    mat.userData.base = mat.color.clone();
    var lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    lines.renderOrder = 998;
    lines.visible = false;
    scene.add(lines);
    effects.warp = lines;
  }

  function warpBurst(token, peak, dur) {
    var w = effects.warp;
    if (!w) return;
    var d = isNum(dur) ? dur : 1.0, p = isNum(peak) ? peak : 0.75;
    var base = w.material.userData.base || w.material.color.clone();
    w.material.userData.base = base;
    w.visible = true;
    w.material.color.copy(base).multiplyScalar(0);
    w.scale.set(0.85, 0.85, 1);
    addTween({
      from: 0, to: p, dur: d * 0.3, token: token, ease: easeInQuad,
      onUpdate: function (v) {
        var k = p > 0 ? clamp01(v / p) : 0;
        w.material.color.copy(base).multiplyScalar(k);
        w.scale.set(0.85 + k * 0.55, 0.85 + k * 0.55, 1);
      },
      onComplete: function () {
        addTween({
          from: p, to: 0, dur: d * 0.7, token: token, ease: easeOutCubic,
          onUpdate: function (v) {
            var k = p > 0 ? clamp01(v / p) : 0;
            w.material.color.copy(base).multiplyScalar(k);
            w.scale.set(0.85 + k * 0.55, 0.85 + k * 0.55, 1);
          },
          onComplete: function () {
            w.visible = false; w.material.color.copy(base).multiplyScalar(0); w.scale.set(1, 1, 1);
          }
        });
      }
    });
  }

  function localeCut(kind, token, opts) {
    opts = opts || {};
    applyLocale(kind);
    if (opts.flash !== false) shutterFlash(token, isNum(opts.flashPeak) ? opts.flashPeak : 0.42);
    if (opts.warp !== false) warpBurst(token, isNum(opts.warpPeak) ? opts.warpPeak : 0.7, 1.0);
  }

  function showReticle(pos, token) {
    if (!effects.reticle) return;
    var r = effects.reticle;
    r.position.set(pos.x, pos.y, pos.z);
    r.visible = true; r.material.opacity = 0.92;
    addTween({
      from: 1, to: 1.28, dur: 0.42, token: token, ease: easeInOut,
      onUpdate: function (v) { r.scale.setScalar(v); },
             onComplete: function () {
               addTween({
                 from: 1.28, to: 0.92, dur: 0.4, token: token, ease: easeInOut,
                 onUpdate: function (v) { r.scale.setScalar(v); },
                        onComplete: function () {
                          addTween({
                            from: 0.92, to: 1.1, dur: 0.35, token: token, ease: easeInOut,
                            onUpdate: function (v) { r.scale.setScalar(v); }
                          });
                        }
               });
             }
    });
  }

  // --- Surface Set (Apollo LM GLB, Relay GLBs, Articulated Rover & Astronaut) ---
  function createSurface() {
    var g = new THREE.Group();
    g.visible = false;
    surface.group = g;
    scene.add(g);

    var rockMat = new THREE.MeshStandardMaterial({ color: srgb(0x6b5a4d), roughness: 1.0, flatShading: true });
    surface.poi = new THREE.Mesh(new THREE.DodecahedronGeometry(1.5, 0), rockMat);
    surface.poi.position.set(15.5, 0.6, -5);
    surface.poi.rotation.set(0.4, 0.9, 0.1);
    surface.poi.castShadow = true;
    g.add(surface.poi);

    createLander(g);
    createRover(g);
    createAstronaut(g);

    // Hinged deployment ramp pivoting at the lander base
    surface.rampPivot = new THREE.Group();
    surface.rampPivot.position.set(-5.2, 2.25, 0);
    var rampMat = new THREE.MeshStandardMaterial({ color: srgb(0x9aa2b0), roughness: 0.7, metalness: 0.3 });
    surface.ramp = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.14, 1.5), rampMat);
    surface.ramp.position.set(2.6, 0, 0);
    surface.ramp.castShadow = true;
    surface.rampPivot.add(surface.ramp);
    surface.rampPivot.rotation.z = -0.44;
    surface.rampPivot.visible = false;
    g.add(surface.rampPivot);

    createRelay(g);
    resetSurfaceActors();
  }

  function createLander(parent) {
    var g = new THREE.Group();
    g.position.set(-6, 0, 0);
    surface.lander = g;
    parent.add(g);

    var fallback = new THREE.Group();
    surface.landerFallback = fallback;
    g.add(fallback);

    var gold = new THREE.MeshStandardMaterial({ color: srgb(0xcf9b4a), roughness: 0.55, metalness: 0.6 });
    var white = new THREE.MeshStandardMaterial({ color: srgb(0xe8ecf2), roughness: 0.5, metalness: 0.15 });
    var dark = new THREE.MeshStandardMaterial({ color: srgb(0x2f3540), roughness: 0.6, metalness: 0.4 });

    var descent = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.8, 1.1, 8), gold);
    descent.position.y = 1.75; descent.castShadow = true; fallback.add(descent);
    var ascent = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.3, 1.5), white);
    ascent.position.y = 3.0; ascent.castShadow = true; fallback.add(ascent);
    var hatch = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 0.7), dark);
    hatch.position.set(0.78, 2.7, 0.4); fallback.add(hatch);
    var nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.0, 12), dark);
    nozzle.rotation.x = Math.PI; nozzle.position.y = 0.95; fallback.add(nozzle);
    for (var i = 0; i < 4; i++) {
      var a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.6, 8), dark);
      leg.position.set(Math.cos(a) * 1.5, 1.1, Math.sin(a) * 1.5);
      leg.rotation.z = -Math.cos(a) * 0.5; leg.rotation.x = Math.sin(a) * 0.5;
      fallback.add(leg);
      var foot = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.4, 0.14, 10), gold);
      foot.position.set(Math.cos(a) * 2.35, 0.08, Math.sin(a) * 2.35);
      fallback.add(foot);
    }

    surface.hatchPos = { x: -4.4, y: 0, z: 1.5 };
    surface.landerFlame = makeFlame(0.6, 3.2);
    surface.landerFlame.group.position.y = 0.65;
    g.add(surface.landerFlame.group);

    surface.landerLight = new THREE.PointLight(0xffa44c, 0, 42, 2);
    surface.landerLight.position.set(0, 1.2, 0);
    g.add(surface.landerLight);

    mountLanderGLB();
  }

  function mountLanderGLB() {
    if (!surface.lander || surface.landerGLB) return;
    var glb = instanceModel('landerLM', 5.4, true);
    if (!glb) return;
    glb.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    surface.landerGLB = glb;
    surface.lander.add(glb);
    if (surface.landerFallback) surface.landerFallback.visible = false;
  }

  function createRover(parent) {
    var g = new THREE.Group();
    surface.rover = g;
    parent.add(g);

    var bodyMat = new THREE.MeshStandardMaterial({ color: srgb(0xe6e9ef), roughness: 0.48, metalness: 0.28 });
    var darkMat = new THREE.MeshStandardMaterial({ color: srgb(0x4c525b), roughness: 0.75, metalness: 0.25 });
    var goldMat = new THREE.MeshStandardMaterial({ color: srgb(0xd9a441), roughness: 0.42, metalness: 0.58 });

    noteAssetIssue('Asset not in repo yet: 3dmodels/Mars_Rover.glb (primitive fallback in use)');

    var body = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.52, 1.12), bodyMat);
    body.position.y = 0.78; body.castShadow = true; g.add(body);

    var deck = new THREE.Mesh(new THREE.BoxGeometry(1.36, 0.1, 0.94), goldMat);
    deck.position.y = 1.09; g.add(deck);

    var dish = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.06, 0.14, 14), bodyMat);
    dish.position.set(-0.46, 1.28, -0.2); dish.rotation.z = 0.25; g.add(dish);

    var wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 14);
    wheelGeo.rotateX(Math.PI / 2);
    surface.wheels = [];
    var xs = [-0.64, 0, 0.64];
    for (var i = 0; i < xs.length; i++) {
      for (var s = -1; s <= 1; s += 2) {
        var w = new THREE.Mesh(wheelGeo, darkMat);
        w.position.set(xs[i], 0.42, s * 0.68);
        w.castShadow = true;
        g.add(w);
        surface.wheels.push(w);
      }
    }

    var mast = new THREE.Group();
    mast.position.set(0.55, 1.12, 0);
    var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.1, 8), bodyMat);
    pole.position.y = 0.55; mast.add(pole);
    var head = new THREE.Group();
    head.position.y = 1.15;
    head.add(new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.24, 0.24), bodyMat));
    var lensGeo = new THREE.SphereGeometry(0.07, 8, 6);
    var lensMat = new THREE.MeshStandardMaterial({
      color: srgb(0x1a1d24), emissive: srgb(0x2f6fb5), emissiveIntensity: 0.75, roughness: 0.3
    });
    for (var l = -1; l <= 1; l += 2) {
      var lens = new THREE.Mesh(lensGeo, lensMat);
      lens.position.set(0.07 * l, 0, 0.13);
      head.add(lens);
    }
    mast.add(head);
    g.add(mast);
    surface.roverMast = mast;
    surface.roverHead = head;
  }

  function createAstronaut(parent) {
    var g = new THREE.Group();
    g.visible = false;
    surface.astronaut = g;
    parent.add(g);

    var suit = new THREE.MeshStandardMaterial({ color: srgb(0xe8ecf2), roughness: 0.55, metalness: 0.05 });
    var trim = new THREE.MeshStandardMaterial({ color: srgb(0xd8dde6), roughness: 0.6 });
    var visor = new THREE.MeshStandardMaterial({
      color: srgb(0xd9a03f), emissive: srgb(0x6b4a12), emissiveIntensity: 0.35, roughness: 0.25, metalness: 0.6
    });

    var torso = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.72, 12), suit);
    torso.position.y = 1.06; g.add(torso);
    var pack = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.56, 0.26), trim);
    pack.position.set(0, 1.12, -0.3); g.add(pack);
    var helmet = new THREE.Mesh(new THREE.SphereGeometry(0.27, 14, 12), suit);
    helmet.position.y = 1.66; g.add(helmet);
    var visorMesh = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), visor);
    visorMesh.position.set(0, 1.66, 0.12); visorMesh.scale.set(1, 0.8, 0.7); g.add(visorMesh);

    surface.arms = [];
    for (var a = -1; a <= 1; a += 2) {
      var shoulder = new THREE.Group();
      shoulder.position.set(a * 0.36, 1.36, 0);
      var arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.6, 8), suit);
      arm.position.y = -0.28;
      shoulder.add(arm);
      g.add(shoulder);
      surface.arms.push(shoulder);
    }

    surface.legs = [];
    for (var l = -1; l <= 1; l += 2) {
      var hip = new THREE.Group();
      hip.position.set(l * 0.14, 0.72, 0);
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.1, 0.7, 8), suit);
      leg.position.y = -0.35;
      hip.add(leg);
      g.add(hip);
      surface.legs.push(hip);
    }
    g.traverse(function (o) { if (o.isMesh) o.castShadow = true; });
  }

  function createRelay(parent) {
    var g = new THREE.Group();
    g.position.set(16, 30, -26);
    surface.relay = g;
    parent.add(g);

    var fallback = makePrimitiveSatellite(0x1f3d8f);
    surface.relayFallback = fallback;
    g.add(fallback);

    surface.relaySlots = {};
    g.visible = false;
    mountRelayGLB();
  }

  function mountRelayGLB() {
    if (!surface.relay) return;
    var keys = ['satTDRS', 'satMGS'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!surface.relaySlots[k] && gltfTemplates[k]) {
        var inst = instanceModel(k, 8.0, false);
        if (inst) {
          inst.traverse(function (o) { if (o.isMesh) o.castShadow = false; });
          inst.visible = false;
          surface.relay.add(inst);
          surface.relaySlots[k] = inst;
        }
      }
    }
    selectRelayForLocale(surface.currentGround || 'moon');
  }

  function selectRelayForLocale(loc) {
    if (!surface.relay) return;
    var want = (loc === 'mars' && surface.relaySlots.satMGS) ? 'satMGS' :
    (surface.relaySlots.satTDRS ? 'satTDRS' : (surface.relaySlots.satMGS ? 'satMGS' : null));
    for (var k in surface.relaySlots) {
      if (Object.prototype.hasOwnProperty.call(surface.relaySlots, k)) {
        surface.relaySlots[k].visible = (k === want);
      }
    }
    if (surface.relayFallback) surface.relayFallback.visible = !want;
  }

  function setGroundDestination(dest) {
    applyLocale(localeForDestination(dest));
    surface.currentGround = currentLocale;
    selectRelayForLocale(currentLocale);
  }

  function resetSurfaceActors() {
    if (!surface.group) return;
    if (surface.lander) {
      surface.lander.position.set(-6, 0, 0);
      surface.lander.rotation.set(0, 0, 0);
      surface.lander.visible = true;
    }
    if (surface.landerFlame) { surface.landerFlame.group.visible = false; surface.landerFlame.level = 0; }
    if (surface.landerLight) surface.landerLight.intensity = 0;
    if (surface.rover) {
      surface.rover.position.set(-4.5, 2.25, 0);
      surface.rover.rotation.set(0, 0, 0);
      surface.rover.visible = true;
    }
    if (surface.wheels) for (var i = 0; i < surface.wheels.length; i++) surface.wheels[i].rotation.z = 0;
    if (surface.roverMast) surface.roverMast.rotation.set(0, 0, 0);
    if (surface.roverHead) surface.roverHead.rotation.set(0, 0, 0);
    if (surface.astronaut) {
      surface.astronaut.position.set(-4.4, 0, 1.5);
      surface.astronaut.rotation.set(0, 0.7, 0);
      surface.astronaut.visible = false;
      if (surface.legs) for (var l = 0; l < surface.legs.length; l++) surface.legs[l].rotation.x = 0;
      if (surface.arms) for (var a = 0; a < surface.arms.length; a++) surface.arms[a].rotation.set(0, 0, 0);
    }
    if (surface.rampPivot) { surface.rampPivot.visible = false; surface.rampPivot.rotation.z = -0.44; }
    if (surface.relay) { surface.relay.visible = false; surface.relay.position.set(16, 30, -26); }
    effects.dustTargetY = -1;
  }

  function prepareSurface(dest) {
    if (!scene) return;
    if (world.padGroup) world.padGroup.visible = false;
    surface.group.visible = true;
    if (rocket.group) rocket.group.visible = false;
    setGroundDestination(dest);
    resetSurfaceActors();
    hideImageCard(); hideCountdown(); hideCard();
    setFlame(0);
  }

  function prepareLaunch() {
    if (!scene) return;
    if (surface.group) surface.group.visible = false;
    if (world.padGroup) world.padGroup.visible = true;
    applyLocale('earth');
    resetRocketVisual();
    hideImageCard(); hideCountdown(); hideCard(); hideUplink();
  }

  // --- Timeline mapping -----------------------------------------------------
  function normalizeTimeline(outcome) {
    var out = [];
    var tl = outcome && Array.isArray(outcome.timeline) ? outcome.timeline : [];
    for (var i = 0; i < tl.length; i++) {
      var e = tl[i];
      if (!e || typeof e !== 'object') continue;
      var phase = str(e.phase) || str(e.name) || str(e.type);
      var t = isNum(e.time) ? e.time : (isNum(e.t) ? e.t : null);
      out.push({ phase: phase.toLowerCase(), raw: phase, time: t });
    }
    return out;
  }

  function timelineHasTimes(samples) {
    if (!samples.length) return false;
    for (var i = 0; i < samples.length; i++) if (samples[i].time === null) return false;
    return true;
  }

  function mapSampleTimes(samples, mapStart, mapEnd) {
    var n = samples.length, times = new Array(n);
    if (!n) return times;
    var span = Math.max(0.5, mapEnd - mapStart);
    var useRealTimes = timelineHasTimes(samples);
    var t0 = 0, t1 = 0;
    if (useRealTimes) {
      t0 = t1 = samples[0].time;
      for (var i = 1; i < n; i++) {
        if (samples[i].time < t0) t0 = samples[i].time;
        if (samples[i].time > t1) t1 = samples[i].time;
      }
    }
    if (useRealTimes && t1 - t0 > 1e-6) {
      for (var j = 0; j < n; j++) times[j] = mapStart + ((samples[j].time - t0) / (t1 - t0)) * span;
    } else if (n === 1) {
      times[0] = mapStart + span * 0.45;
    } else {
      for (var k = 0; k < n; k++) times[k] = mapStart + (k / (n - 1)) * span;
    }
    for (var m = 1; m < n; m++) if (times[m] <= times[m - 1]) times[m] = times[m - 1] + 0.05;
    return times;
  }

  function mapSourceTime(value, samples, mapStart, mapEnd) {
    if (!isNum(value) || !timelineHasTimes(samples) || samples.length < 1) return null;
    var t0 = samples[0].time, t1 = samples[0].time;
    for (var i = 1; i < samples.length; i++) {
      if (samples[i].time < t0) t0 = samples[i].time;
      if (samples[i].time > t1) t1 = samples[i].time;
    }
    if (t1 - t0 <= 1e-6) return null;
    return mapStart + ((value - t0) / (t1 - t0)) * Math.max(0.5, mapEnd - mapStart);
  }

  var PAD_PHASES = { pad: 1, countdown: 1, ignition: 1, launchpad: 1 };
  var SURFACE_HINTS = [
    'approach', 'transfer', 'descent', 'landing', 'touchdown', 'crew',
    'rover', 'surface', 'drive', 'image', 'capture', 'uplink', 'photo'
  ];

  function isSurfacePhase(phase) {
    if (!phase) return false;
    if (SURFACE_HINTS.indexOf(phase) !== -1) return true;
    for (var i = 0; i < SURFACE_HINTS.length; i++) if (phase.indexOf(SURFACE_HINTS[i]) !== -1) return true;
    return false;
  }
  function isPadPhase(phase) {
    return !phase || !!PAD_PHASES[phase] || phase.indexOf('pad') !== -1;
  }

  var PHASE_POSES = {
    pad:    { r: { x: 0, y: PAD_Y, z: 0, rx: 0, ry: 0, rz: 0 },       c: { x: 24, y: 10.5, z: 38, tx: 0, ty: 8.2, tz: 0, fov: 54 } },
    ascent: { r: { x: -2, y: 68, z: -7, rx: 0, ry: 0, rz: -0.09 },    c: { x: 22, y: 74, z: 26, tx: -2, ty: 71, tz: -7, fov: 46 } },
    stage:  { r: { x: -8, y: 158, z: -20, rx: 0, ry: 0, rz: -0.22 },  c: { x: 26, y: 164, z: 22, tx: -8, ty: 161, tz: -20, fov: 48 } },
    coast:  { r: { x: -20, y: 305, z: -48, rx: 0, ry: 0, rz: -0.62 }, c: { x: 34, y: 318, z: 24, tx: -20, ty: 309, tz: -48, fov: 50 } },
    orbit:  { r: { x: -40, y: 430, z: -80, rx: 0, ry: 0, rz: -1.52 }, c: { x: 95, y: 462, z: 45, tx: -46, ty: 428, tz: -82, fov: 54 } },
    deploy: { r: { x: -46, y: 436, z: -86, rx: 0, ry: 0, rz: -1.52 }, c: { x: 64, y: 452, z: -12, tx: -48, ty: 436, tz: -86, fov: 46 } }
  };

  function poseForPhase(phase) {
    if (!phase) return PHASE_POSES.pad;
    if (PAD_PHASES[phase] || phase.indexOf('pad') !== -1) return PHASE_POSES.pad;
    if (phase.indexOf('ascent') !== -1 || phase.indexOf('climb') !== -1 || phase.indexOf('liftoff') !== -1) return PHASE_POSES.ascent;
    if (phase.indexOf('stage') !== -1 || phase.indexOf('separation') !== -1) return PHASE_POSES.stage;
    if (phase.indexOf('coast') !== -1) return PHASE_POSES.coast;
    if (phase.indexOf('deploy') !== -1 || phase.indexOf('payload') !== -1) return PHASE_POSES.deploy;
    if (phase.indexOf('orbit') !== -1 || phase.indexOf('orbital') !== -1) return PHASE_POSES.orbit;
    return PHASE_POSES.coast;
  }

  function makeKey(t, r, c) {
    return {
      t: t,
      r: r ? { x: r.x, y: r.y, z: r.z, rx: r.rx || 0, ry: r.ry || 0, rz: r.rz || 0, lookAt: r.lookAt || null } : null,
      c: { x: c.x, y: c.y, z: c.z, tx: c.tx, ty: c.ty, tz: c.tz, fov: isNum(c.fov) ? c.fov : BASE_FOV }
    };
  }

  function poseAtInto(keys, t, outR, outC) {
    if (!keys.length) return false;
    var i = 0;
    while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
    var a = keys[i], b = keys[i + 1];
    if (!b) { copyKeyInto(a, outR, outC); return true; }
    var span = b.t - a.t;
    var u = span <= 1e-6 ? 1 : easeSoft((t - a.t) / span);
    if (a.r && b.r) {
      outR.x = lerp(a.r.x, b.r.x, u); outR.y = lerp(a.r.y, b.r.y, u); outR.z = lerp(a.r.z, b.r.z, u);
      outR.rx = lerp(a.r.rx, b.r.rx, u); outR.ry = lerp(a.r.ry, b.r.ry, u); outR.rz = lerp(a.r.rz, b.r.rz, u);
      outR.lookAt = b.r.lookAt || a.r.lookAt || null;
    } else if (a.r || b.r) {
      copyRInto(a.r || b.r, outR);
    }
    outC.x = lerp(a.c.x, b.c.x, u); outC.y = lerp(a.c.y, b.c.y, u); outC.z = lerp(a.c.z, b.c.z, u);
    outC.tx = lerp(a.c.tx, b.c.tx, u); outC.ty = lerp(a.c.ty, b.c.ty, u); outC.tz = lerp(a.c.tz, b.c.tz, u);
    outC.fov = lerp(a.c.fov || BASE_FOV, b.c.fov || BASE_FOV, u);
    return true;
  }
  function copyRInto(r, out) {
    out.x = r.x; out.y = r.y; out.z = r.z; out.rx = r.rx; out.ry = r.ry; out.rz = r.rz; out.lookAt = r.lookAt || null;
  }
  function copyKeyInto(k, outR, outC) {
    if (k.r) copyRInto(k.r, outR);
    outC.x = k.c.x; outC.y = k.c.y; outC.z = k.c.z;
    outC.tx = k.c.tx; outC.ty = k.c.ty; outC.tz = k.c.tz;
    outC.fov = k.c.fov || BASE_FOV;
  }

  function applyPoseToRocket(r) {
    if (!rocket.group || !r) return;
    rocket.group.position.set(r.x, r.y, r.z);
    if (r.lookAt) {
      rocket.group.lookAt(r.lookAt.x, r.lookAt.y, r.lookAt.z);
      rocket.group.rotateX(Math.PI / 2);
    } else {
      rocket.group.rotation.set(r.rx, r.ry, r.rz);
    }
  }

  function applyPoseToCamera(c, driftT, driftAmp, dt, shakeAmt) {
    if (!camera || !c) return;
    var tx = c.x, ty = c.y, tz = c.z;
    if (driftT >= 0) {
      getDrift(driftT, scratchDrift);
      var k = isNum(driftAmp) ? clamp01(driftAmp) : 1;
      tx += scratchDrift.x * k; ty += scratchDrift.y * k; tz += scratchDrift.z * k;
    }
    var targetFov = isNum(c.fov) ? c.fov : BASE_FOV;

    if (!camSmooth.ready || dt <= 0) {
      camSmooth.ready = true;
      camSmooth.x = tx; camSmooth.y = ty; camSmooth.z = tz;
      camSmooth.tx = c.tx; camSmooth.ty = c.ty; camSmooth.tz = c.tz;
      camSmooth.fov = targetFov;
    } else {
      var damp = 1 - Math.exp(-8.5 * dt);
      camSmooth.x = lerp(camSmooth.x, tx, damp);
      camSmooth.y = lerp(camSmooth.y, ty, damp);
      camSmooth.z = lerp(camSmooth.z, tz, damp);
      camSmooth.tx = lerp(camSmooth.tx, c.tx, damp);
      camSmooth.ty = lerp(camSmooth.ty, c.ty, damp);
      camSmooth.tz = lerp(camSmooth.tz, c.tz, damp);
      camSmooth.fov = lerp(camSmooth.fov, targetFov, 1 - Math.exp(-5 * dt));
    }

    var sx = 0, sy = 0;
    if (shakeAmt > 0 && !reducedMotion) {
      sx = wobble(elapsedWall * 47) * 0.16 * shakeAmt;
      sy = wobble(elapsedWall * 59 + 1.3) * 0.14 * shakeAmt;
    }

    camera.position.set(camSmooth.x + sx, camSmooth.y + sy, camSmooth.z);
    camera.lookAt(camSmooth.tx + sx * 0.4, camSmooth.ty + sy * 0.4, camSmooth.tz);
    if (Math.abs(camera.fov - camSmooth.fov) > 0.04) {
      camera.fov = camSmooth.fov;
      camera.updateProjectionMatrix();
    }
  }

  function getDrift(t, out) {
    var amp = reducedMotion ? 0.35 : 1;
    out.x = Math.sin(t * 0.13) * 1.7 * amp;
    out.y = Math.sin(t * 0.09 + 1.3) * 0.9 * amp;
    out.z = Math.cos(t * 0.11) * 1.7 * amp;
  }

  // --- Failures -------------------------------------------------------------
  var FAILURE_KINDS = {
    thrust_low:   { neverLeavesPad: true, hints: ['pad', 'ascent'] },
    fuel_out:     { hints: ['ascent', 'climb', 'coast'] },
    power_short:  { hints: ['ascent', 'coast', 'orbit'], cue: 'SIGNAL LOST' },
    sensor_fault: { hints: ['ascent', 'climb', 'coast'] },
    stage_fail:   { hints: ['stage', 'separation'] },
    over_budget:  { noLaunch: true },
    over_mass:    { noLaunch: true }
  };

  function failureLabel(failure) {
    var out = { title: '', detail: '' };
    if (!failure || typeof failure !== 'object') return out;
    var type = str(failure.type).toLowerCase();
    var lib = null;
    try {
      var f = (window.SMG && SMG.data) ? SMG.data.failures : null;
      if (f) {
        if (Array.isArray(f)) {
          for (var i = 0; i < f.length; i++) if (f[i] && str(f[i].type).toLowerCase() === type) { lib = f[i]; break; }
        } else if (typeof f === 'object' && f[type]) lib = f[type];
      }
    } catch (e) { lib = null; }

    var kind = FAILURE_KINDS[type] || null;
    out.title = str(failure.title) || str(lib && (lib.title || lib.name || lib.label)) ||
    (kind && kind.cue ? kind.cue : (type ? humanizeType(type) : ''));

    var parts = [];
    var msg = str(failure.message) || str(failure.detail) || str(lib && (lib.message || lib.description));
    if (msg) parts.push(msg);
    if (isNum(failure.altitudeKm)) parts.push('ALT ' + fmtNum(failure.altitudeKm) + ' KM');
    var ft = isNum(failure.timeS) ? failure.timeS : (isNum(failure.time) ? failure.time : null);
    if (ft !== null) parts.push('T+' + fmtNum(ft) + ' S');
    if (isNum(failure.stage)) parts.push('STAGE ' + fmtNum(failure.stage));
    else if (str(failure.stage)) parts.push('STAGE ' + str(failure.stage));
    out.detail = parts.join('  \u00b7  ');
    return out;
  }

  function eventLabel(ev) {
    return {
      title: str(ev.title) || (str(ev.type) ? humanizeType(ev.type) : 'EVENT'),
             detail: str(ev.detail) || str(ev.message) || ''
    };
  }

  function setPhase(run, p) { if (run) run.phase = p; }
  function setAlert(run, kind, title, detail) { if (run) run.alertIs = kind; showAlert(kind, title, detail); }

  function chooseFailureTime(kind, failure, samples, times, mapStart, mapEnd, winStart) {
    if (kind.neverLeavesPad) return winStart;
    var explicit = isNum(failure.timeS) ? failure.timeS : (isNum(failure.time) ? failure.time : null);
    if (explicit !== null) {
      var mapped = mapSourceTime(explicit, samples, mapStart, mapEnd);
      if (mapped !== null) return clamp(mapped, winStart + 0.4, mapEnd - 1.4);
    }
    var hints = kind.hints || [];
    for (var i = 0; i < samples.length; i++) {
      var ph = samples[i].phase;
      if (!ph) continue;
      for (var h = 0; h < hints.length; h++) if (ph.indexOf(hints[h]) !== -1) return times[i];
    }
    return winStart + (mapEnd - winStart) * 0.4;
  }

  function appendFailure(b, kind, type, failure, tF) {
    var dur = b.duration, S = Math.max(2.0, dur - tF), label = failureLabel(failure);
    var keys = b.keys, steps = b.steps;
    function key(t, r, c) { keys.push(makeKey(t, r, c)); }
    function step(t, fn) { steps.push({ t: t, fn: fn }); }
    function alertAt(at) {
      step(at, function (r) { setAlert(r, 'failure', label.title, label.detail); setPhase(r, 'FAILURE \u2014 ' + humanizeType(type)); });
    }

    if (kind.neverLeavesPad) {
      key(tF, { x: 0, y: PAD_Y + 0.8, z: 0, rx: 0, ry: 0, rz: 0 }, { x: 14, y: 7, z: 25, tx: 0, ty: 5.5, tz: 0, fov: 48 });
      key(tF + 0.35 * S, { x: 0, y: PAD_Y + 1.4, z: 0, rx: 0, ry: 0, rz: 0.02 }, { x: 12.5, y: 6.5, z: 22, tx: 0, ty: 5.5, tz: 0, fov: 46 });
      key(tF + 0.6 * S, { x: 0, y: PAD_Y + 0.15, z: 0, rx: 0, ry: 0, rz: 0 }, { x: 11.5, y: 5.8, z: 20, tx: 0, ty: 4.8, tz: 0, fov: 48 });
      key(tF + 0.78 * S, { x: 0, y: PAD_Y, z: 0, rx: 0, ry: 0, rz: 0 }, { x: 11, y: 5.4, z: 19, tx: 0, ty: 4.6, tz: 0, fov: 50 });
      step(tF, function (r) {
        r.fx.flameGoal = 0.55; r.fx.flickerAmp = 0.65; r.fx.shudder = 1.1; r.fx.smoke = 0.45; r.fx.camShake = 0.7;
        setPhase(r, 'IGNITION');
      });
      step(tF + 0.35 * S, function (r) { r.fx.flameGoal = 0.25; r.fx.shudder = 1.3; r.fx.camShake = 0.4; });
      step(tF + 0.6 * S, function (r) { r.fx.flameGoal = 0; r.fx.smoke = 0; r.fx.shudder = 0.4; r.fx.camShake = 0; });
      step(tF + 0.72 * S, function (r) { r.fx.shudder = 0; });
      alertAt(tF + 0.78 * S);
      return;
    }

    if (type === 'fuel_out') {
      var y0 = lastRocketY(keys);
      key(tF + 0.28 * S, { x: -4, y: y0 + 34, z: -14, rx: 0, ry: 0, rz: -0.1 }, { x: 22, y: y0 + 40, z: 26, tx: -4, ty: y0 + 34, tz: -14, fov: 46 });
      key(tF + 0.46 * S, { x: -8, y: y0 + 44, z: -22, rx: 0, ry: 0, rz: -0.16 }, { x: 24, y: y0 + 46, z: 28, tx: -8, ty: y0 + 42, tz: -22, fov: 48 });
      key(tF + 0.7 * S, { x: -12, y: y0 + 14, z: -30, rx: 0, ry: 0, rz: -0.34 }, { x: 24, y: y0 + 44, z: 28, tx: -12, ty: y0 + 20, tz: -30, fov: 50 });
      key(dur, { x: -16, y: y0 - 78, z: -38, rx: 0, ry: 0, rz: -0.42 }, { x: 24, y: y0 + 44, z: 28, tx: -16, ty: y0 - 40, tz: -38, fov: 52 });
      step(tF, function (r) {
        r.fx.flameGoal = 0.35; r.fx.flickerAmp = 0.85; r.fx.smoke = 0.5;
        setPhase(r, 'ENGINE FLAME OUT');
        // Visual tank gauge drain only (never mutates `build`)
        var startFill = rocket.fuelRatio === null ? 0.4 : rocket.fuelRatio;
        addTween({
          from: startFill, to: 0.001, dur: Math.max(0.4, 0.42 * S), token: r.token, ease: easeInQuad,
                 onUpdate: function (v) { for (var fi = 0; fi < rocket.fuelFills.length; fi++) rocket.fuelFills[fi].scale.y = v; }
        });
      });
      step(tF + 0.3 * S, function (r) { r.fx.flameGoal = 0.12; });
      step(tF + 0.46 * S, function (r) { r.fx.flameGoal = 0; r.fx.smoke = 0; r.fx.camShake = 0; });
      alertAt(tF + 0.5 * S);
      return;
    }

    if (type === 'power_short') {
      var py = lastRocketY(keys);
      key(tF + 0.35 * S, { x: -6, y: py + 30, z: -16, rx: 0, ry: 0, rz: -0.12 }, { x: 20, y: py + 34, z: 26, tx: -6, ty: py + 30, tz: -16, fov: 48 });
      key(tF + 0.65 * S, { x: -10, y: py + 46, z: -26, rx: 0, ry: 0, rz: -0.22 }, { x: 20, y: py + 40, z: 26, tx: -10, ty: py + 44, tz: -26, fov: 52 });
      key(dur, { x: -14, y: py + 62, z: -34, rx: 0, ry: 0, rz: -0.3 }, { x: 24, y: py + 44, z: 30, tx: -14, ty: py + 60, tz: -34, fov: 54 });
      step(tF, function (r) {
        setPhase(r, 'POWER');
        addTween({
          from: 1, to: 0.05, dur: 0.9, token: r.token, ease: easeInOut,
          onUpdate: function (v) { r.fx.lights = v; }
        });
      });
      step(tF + 0.3 * S, function (r) { r.fx.flameGoal = 0; r.fx.smoke = 0; r.fx.camShake = 0; });
      alertAt(tF + 0.42 * S);
      return;
    }

    if (type === 'sensor_fault') {
      var sy = lastRocketY(keys), sx = lastRocketX(keys);
      key(tF + 0.35 * S, { x: sx + 13, y: sy + 30, z: -16, rx: 0, ry: 0.08, rz: -0.32 }, { x: 20, y: sy + 34, z: 26, tx: sx + 8, ty: sy + 30, tz: -16, fov: 48 });
      key(tF + 0.7 * S, { x: sx + 26, y: sy + 54, z: -30, rx: 0, ry: 0.14, rz: -0.56 }, { x: 24, y: sy + 56, z: 26, tx: sx + 18, ty: sy + 52, tz: -30, fov: 52 });
      key(dur, { x: sx + 35, y: sy + 72, z: -42, rx: 0, ry: 0.2, rz: -0.74 }, { x: 28, y: sy + 72, z: 26, tx: sx + 26, ty: sy + 68, tz: -42, fov: 54 });
      step(tF, function (r) {
        r.fx.beacon = 1; r.fx.smoke = 0.4; setPhase(r, 'SENSOR WARNING');
        emitRcsPuff(rocket.group.position.x, rocket.group.position.y + 8, rocket.group.position.z, 1, 0.2, 0.3);
      });
      step(tF + 0.25 * S, function () {
        emitRcsPuff(rocket.group.position.x, rocket.group.position.y + 8, rocket.group.position.z, -1, 0.1, -0.4);
      });
      step(tF + 0.35 * S, function (r) { r.fx.smoke = 0; r.fx.camShake = 0; });
      alertAt(tF + 0.45 * S);
      return;
    }

    if (type === 'stage_fail') {
      var gy = lastRocketY(keys);
      key(tF + 0.3 * S, { x: -6, y: gy + 40, z: -20, rx: 0, ry: 0, rz: -0.16 }, { x: 22, y: gy + 46, z: 26, tx: -6, ty: gy + 42, tz: -20, fov: 50 });
      key(tF + 0.65 * S, { x: -12, y: gy + 78, z: -36, rx: 0, ry: 0, rz: -0.34 }, { x: 26, y: gy + 84, z: 26, tx: -12, ty: gy + 80, tz: -36, fov: 52 });
      key(dur, { x: -18, y: gy + 108, z: -50, rx: 0, ry: 0, rz: -0.5 }, { x: 30, y: gy + 112, z: 26, tx: -18, ty: gy + 106, tz: -50, fov: 54 });
      step(tF, function (r) {
        r.fx.jitterLower = 1; r.fx.flameGoal = 0.4; r.fx.flickerAmp = 0.8; r.fx.smoke = 0.5; r.fx.camShake = 0.7;
        setPhase(r, 'STAGE FAULT');
      });
      step(tF + 0.16 * S, function (r) {
        r.fx.jitterLower = 0; r.fx.flameGoal = 0; r.fx.camShake = 0.2;
        emitSepBurst(rocket.group.position.x, rocket.group.position.y + 5.4, rocket.group.position.z);
        var lg = rocket.lower;
        addTween({
          from: 0, to: 1, dur: Math.min(3.2, S * 0.8), token: r.token, ease: easeInQuad,
                 onUpdate: function (v) { lg.position.y = -18 * v; lg.position.x = 7 * v; lg.rotation.z = 1.6 * v; lg.rotation.x = 0.7 * v; }
        });
        fadeLowerStage(Math.min(2.6, S * 0.6), r.token);
      });
      step(tF + 0.3 * S, function (r) {
        addTween({
          from: 0, to: 0.9, dur: 0.6, token: r.token, ease: easeOutCubic,
          onUpdate: function (v) { rocket.upperFlameLevel = v; }
        });
        r.fx.smoke = 0.7;
      });
      step(tF + 0.45 * S, function (r) { r.fx.smoke = 0.4; });
      alertAt(tF + 0.55 * S);
      return;
    }

    alertAt(tF + 0.4 * S);
  }

  function lastRocketY(keys) { for (var i = keys.length - 1; i >= 0; i--) if (keys[i].r) return keys[i].r.y; return PAD_Y; }
  function lastRocketX(keys) { for (var i = keys.length - 1; i >= 0; i--) if (keys[i].r) return keys[i].r.x; return 0; }

  // --- Planetary & Surface Sequences ----------------------------------------
  function getPlanet(key) {
    try {
      var p = world.planets && world.planets[key];
      if (p && p.pos) return { x: p.pos.x, y: p.pos.y, z: p.pos.z, r: p.r };
    } catch (e) { /* no THREE */ }
    return null;
  }

  function resolveDestination(mission) {
    var m = mission && typeof mission === 'object' ? mission : {};
    var name = str(m.destinationName) || str(m.destination) || str(m.destinationId);
    var low = (name + ' ' + str(m.id) + ' ' + str(m.name) + ' ' + str(m.destinationId)).toLowerCase();
    var key = 'earth';
    if (low.indexOf('moon') !== -1 || low.indexOf('luna') !== -1 || low.indexOf('apollo') !== -1 || low.indexOf('gateway') !== -1) key = 'moon';
    else if (low.indexOf('mars') !== -1) key = 'mars';
    else if (low.indexOf('saturn') !== -1) key = 'saturn';
    else if (low.indexOf('earth') !== -1) key = 'earth';
    return { key: key, name: name };
  }

  function approachTitle(dest) { return dest.name ? 'APPROACHING ' + dest.name.toUpperCase() : 'APPROACHING'; }

  function focusPlanets(key) {
    if (world.moon) world.moon.visible = (key === 'moon');
    if (world.mars) world.mars.visible = (key === 'mars');
    if (world.saturn) world.saturn.visible = (key === 'saturn');
    if (world.saturnRing) world.saturnRing.visible = (key === 'saturn');
    if (world.earthParts) for (var i = 0; i < world.earthParts.length; i++) world.earthParts[i].visible = true;
  }

  function seqApproach(b, t0, t1, ctx) {
    var dest = ctx.dest;
    var pKey = dest.key === 'earth' ? 'earth' : dest.key;
    var P = getPlanet(pKey) || getPlanet('mars');
    var d = Math.max(0.5, t1 - t0);

    b.steps.push({ t: t0, fn: function (run) {
      if (world.padGroup) world.padGroup.visible = false;
      if (surface.group) surface.group.visible = false;
      if (rocket.group) rocket.group.visible = true;
      resetRocketVisual();
      // Approach shows the upper cruise stage + payload GLB cleanly
      if (rocket.lower) rocket.lower.visible = false;
      rocket.upperFlameLevel = 0.5;
      localeCut('space', run.token, { flashPeak: 0.36, warpPeak: 0.72 });
      focusPlanets(pKey);
      if (pKey === 'moon') setupOrbitShowcase('moon-approach');
      else if (pKey === 'mars') setupOrbitShowcase('mars-approach');
      else if (pKey === 'saturn') setupOrbitShowcase('saturn-approach');
      else setupOrbitShowcase('earth-orbit');
      setPhase(run, 'APPROACH');
      run.addUpdate(function (r) { updateOrbitShowcase(r.elapsed); });
    } });
    b.steps.push({ t: t0 + d * 0.28, fn: function () { showCard('TRANSITION', approachTitle(dest)); } });
    b.steps.push({ t: t0 + d * 0.65, fn: function () { rocket.upperFlameLevel = 0; } });

    if (!P) {
      b.keys.push(makeKey(t0, null, { x: 16, y: 7, z: 30, tx: 0, ty: 6, tz: 0 }));
      b.keys.push(makeKey(t1, null, { x: 16, y: 8, z: 30, tx: 0, ty: 7, tz: 0 }));
      return;
    }

    var dx = -P.x, dy = -P.y, dz = -P.z;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= len; dy /= len; dz /= len;
    var far = P.r * 16, near = P.r * 3.4;
    var perpX = -dz, perpZ = dx, perpLen = Math.sqrt(perpX * perpX + perpZ * perpZ) || 1;
    perpX /= perpLen; perpZ /= perpLen;

    var cam0 = { x: P.x + dx * far, y: P.y + dy * far + P.r * 1.8, z: P.z + dz * far };
    var camM = { x: P.x + dx * lerp(far, near, 0.55) + perpX * P.r * 1.8, y: P.y + dy * lerp(far, near, 0.55) + P.r * 1.1, z: P.z + dz * lerp(far, near, 0.55) + perpZ * P.r * 1.8 };
    var cam1 = { x: P.x + dx * near + perpX * P.r * 0.9, y: P.y + dy * near + P.r * 0.55, z: P.z + dz * near + perpZ * P.r * 0.9 };

    var ship0 = { x: lerp(cam0.x, P.x, 0.14) + perpX * P.r * 0.8, y: lerp(cam0.y, P.y, 0.14) - P.r * 0.4, z: lerp(cam0.z, P.z, 0.14) + perpZ * P.r * 0.8 };
    var shipM = { x: lerp(camM.x, P.x, 0.28) + perpX * P.r * 1.0, y: lerp(camM.y, P.y, 0.28) - P.r * 0.3, z: lerp(camM.z, P.z, 0.28) + perpZ * P.r * 1.0 };
    var ship1 = { x: lerp(cam1.x, P.x, 0.45) + perpX * P.r * 1.2, y: lerp(cam1.y, P.y, 0.45) - P.r * 0.25, z: lerp(cam1.z, P.z, 0.45) + perpZ * P.r * 1.2 };
    var look = { x: P.x, y: P.y, z: P.z };

    b.keys.push(makeKey(t0, { x: ship0.x, y: ship0.y, z: ship0.z, lookAt: look },
                        { x: cam0.x, y: cam0.y, z: cam0.z, tx: P.x, ty: P.y, tz: P.z, fov: 60 }));
    b.keys.push(makeKey(t0 + d * 0.52, { x: shipM.x, y: shipM.y, z: shipM.z, lookAt: look },
                        { x: camM.x, y: camM.y, z: camM.z, tx: P.x, ty: P.y, tz: P.z, fov: 50 }));
    b.keys.push(makeKey(t1, { x: ship1.x, y: ship1.y, z: ship1.z, lookAt: look },
                        { x: cam1.x, y: cam1.y, z: cam1.z, tx: P.x, ty: P.y, tz: P.z, fov: 46 }));
  }

  function seqLanding(b, t0, t1, ctx) {
    var dest = ctx.dest, d = Math.max(1.2, t1 - t0);
    b.steps.push({ t: t0, fn: function (run) {
      prepareSurface(dest.key);
      localeCut(localeForDestination(dest.key), run.token, { flashPeak: 0.46, warpPeak: 0.78 });
      if (surface.lander) { surface.lander.position.set(-14, 46, -4); surface.lander.rotation.set(0, 0, -0.18); }
      effects.dustTargetY = 0;
      applyFlame(surface.landerFlame, 1.0, 1);
      if (surface.landerLight) surface.landerLight.intensity = 2.8;
      setPhase(run, 'DESCENT');
      addTween({
        from: 0, to: 1, dur: d * 0.85, token: run.token, ease: easeOutCubic,
        onUpdate: function (u) {
          if (!surface.lander) return;
          var hover = clamp01(u / 0.72);
          surface.lander.position.set(lerp(-14, -6, easeOutCubic(hover)), lerp(46, 0, u), lerp(-4, 0, easeOutCubic(hover)));
          surface.lander.rotation.z = -0.18 * (1 - clamp01((u - 0.3) / 0.45));
          applyFlame(surface.landerFlame, u < 0.75 ? 1.0 : lerp(1.0, 0.5, (u - 0.75) / 0.25), 1);
          if (surface.landerLight) surface.landerLight.intensity = 2.6 * (1 - u * 0.25);
        }
      });
    } });
    b.keys.push(makeKey(t0, null, { x: 28, y: 22, z: 36, tx: -8, ty: 26, tz: -1, fov: 56 }));
    b.keys.push(makeKey(t0 + d * 0.65, null, { x: 18, y: 8.5, z: 24, tx: -6, ty: 6.5, tz: 0, fov: 48 }));
    b.keys.push(makeKey(t1, null, { x: 14, y: 4.5, z: 18, tx: -6, ty: 3.2, tz: 0, fov: 46 }));
    b.steps.push({ t: t0 + d * 0.85, fn: function (run) {
      effects.dustTargetY = -1;
      applyFlame(surface.landerFlame, 0, 1);
      if (surface.landerLight) surface.landerLight.intensity = 0;
      emitDustBurst(-6, 0.2, 0, 1.0);
      if (surface.lander) {
        var lg = surface.lander;
        addTween({
          from: 0, to: Math.PI, dur: 0.45, token: run.token, ease: easeOutQuad,
          onUpdate: function (v) { lg.position.y = -Math.sin(v) * 0.14; },
                 onComplete: function () { lg.position.y = 0; }
        });
      }
      showCard(dest.name ? dest.name.toUpperCase() : 'SURFACE', 'TOUCHDOWN');
      setPhase(run, 'TOUCHDOWN');
    } });
  }

  function seqCrew(b, t0, t1, ctx) {
    var dest = ctx.dest, d = Math.max(1.2, t1 - t0);
    var isMoon = dest.key === 'moon';
    b.steps.push({ t: t0, fn: function (run) {
      prepareSurface(dest.key);
      if (surface.astronaut) {
        surface.astronaut.visible = true;
        surface.astronaut.position.set(-4.6, 1.7, 1.3);
        surface.astronaut.rotation.set(0, 0.6, 0);
      }
      setPhase(run, 'CREW EXIT');
      var legs = surface.legs || [], arms = surface.arms || [];
      // Phase 1: ladder climb-down onto surface
      addTween({
        from: 0, to: 1, dur: d * 0.28, token: run.token, ease: easeInOut,
        onUpdate: function (v) {
          if (!surface.astronaut) return;
          surface.astronaut.position.set(lerp(-4.6, -4.3, v), lerp(1.7, 0, v), lerp(1.3, 1.5, v));
          for (var i = 0; i < legs.length; i++) legs[i].rotation.x = Math.sin(v * Math.PI * 3 + i * Math.PI) * 0.25;
        },
        onComplete: function () {
          emitDustBurst(-4.3, 0.1, 1.5, 0.35);
          // Phase 2: buoyant low-G walk forward
          var from = { x: -4.3, z: 1.5 }, to = { x: -1.4, z: 3.3 };
          addTween({
            from: 0, to: 1, dur: d * 0.46, token: run.token, ease: easeSoft,
            onUpdate: function (v) {
              if (!surface.astronaut) return;
              surface.astronaut.position.x = lerp(from.x, to.x, v);
              surface.astronaut.position.z = lerp(from.z, to.z, v);
              var ph = v * Math.PI * (isMoon ? 4 : 5);
              var swing = reducedMotion ? 0.15 : 0.6;
              for (var i = 0; i < legs.length; i++) legs[i].rotation.x = Math.sin(ph + i * Math.PI) * swing;
              for (var j = 0; j < arms.length; j++) arms[j].rotation.x = Math.sin(ph + j * Math.PI) * swing * 0.55;
              surface.astronaut.position.y = reducedMotion ? 0 : Math.abs(Math.sin(ph)) * (isMoon ? 0.22 : 0.08);
            },
            onComplete: function () {
              for (var i = 0; i < legs.length; i++) legs[i].rotation.x = 0;
              for (var j = 0; j < arms.length; j++) arms[j].rotation.x = 0;
              if (surface.astronaut) surface.astronaut.position.y = 0;
              // Phase 3: turn toward camera and wave!
              addTween({
                from: 0, to: 1, dur: d * 0.22, token: run.token, ease: easeInOut,
                onUpdate: function (v) {
                  if (!surface.astronaut) return;
                  surface.astronaut.rotation.y = lerp(0.6, 0.25, clamp01(v * 2));
                  if (arms[1] && !reducedMotion) arms[1].rotation.z = lerp(0, 2.5, clamp01(v * 2.2)) + Math.sin(v * Math.PI * 5) * 0.25;
                },
                onComplete: function () {
                  if (arms[1]) arms[1].rotation.z = 2.2;
                }
              });
            }
          });
        }
      });
    } });
    b.keys.push(makeKey(t0, null, { x: 7, y: 3.8, z: 12.5, tx: -4.2, ty: 2.3, tz: 1.2, fov: 46 }));
    b.keys.push(makeKey(t1, null, { x: 4.6, y: 2.8, z: 11.5, tx: -2.2, ty: 1.5, tz: 2.4, fov: 44 }));
  }

  function seqRoverDeploy(b, t0, t1, ctx) {
    var dest = ctx.dest, d = Math.max(1.2, t1 - t0);
    b.steps.push({ t: t0, fn: function (run) {
      prepareSurface(dest.key);
      if (surface.rampPivot) { surface.rampPivot.visible = true; surface.rampPivot.rotation.z = -1.2; }
      if (surface.rover) { surface.rover.position.set(-4.5, 2.25, 0); surface.rover.rotation.z = 0; }
      if (surface.roverMast) surface.roverMast.rotation.z = 1.45;
      setPhase(run, 'ROVER DEPLOY');
      // 1) Unfold ramp downward
      addTween({
        from: -1.2, to: -0.44, dur: d * 0.2, token: run.token, ease: easeOutCubic,
        onUpdate: function (v) { if (surface.rampPivot) surface.rampPivot.rotation.z = v; },
               onComplete: function () {
                 // 2) Roll rover down ramp with wheel rotation & pitch settle
                 var from = { x: -4.5, y: 2.25 }, to = { x: -0.1, y: 0 };
                 var totalDist = Math.sqrt(4.4 * 4.4 + 2.25 * 2.25);
                 addTween({
                   from: 0, to: 1, dur: d * 0.56, token: run.token, ease: easeInOut,
                   onUpdate: function (v) {
                     if (!surface.rover) return;
                     surface.rover.position.set(lerp(from.x, to.x, v), lerp(from.y, to.y, v), 0);
                     surface.rover.rotation.z = v < 0.14 ? lerp(0, -0.44, v / 0.14) : -0.44 * (1 - clamp01((v - 0.8) / 0.2));
                     var roll = (v * totalDist) / 0.42;
                     for (var i = 0; i < surface.wheels.length; i++) surface.wheels[i].rotation.z = -roll;
                   },
                   onComplete: function () {
                     if (surface.rover) surface.rover.rotation.z = 0;
                     emitDustBurst(-0.1, 0.1, 0, 0.45);
                     // 3) Unfold camera mast upright
                     addTween({
                       from: 1.45, to: 0, dur: d * 0.2, token: run.token, ease: easeOutCubic,
                       onUpdate: function (v) { if (surface.roverMast) surface.roverMast.rotation.z = v; }
                     });
                   }
                 });
               }
      });
    } });
    b.steps.push({ t: t1 - 0.05, fn: function () { if (surface.rampPivot) surface.rampPivot.visible = false; } });
    b.keys.push(makeKey(t0, null, { x: 6, y: 4.6, z: 13, tx: -3.5, ty: 1.8, tz: 0, fov: 48 }));
    b.keys.push(makeKey(t1, null, { x: 9, y: 3.2, z: 12.5, tx: -0.5, ty: 1.2, tz: 0, fov: 44 }));
  }

  function seqRoverDrive(b, t0, t1, ctx) {
    var dest = ctx.dest, d = Math.max(1.2, t1 - t0);
    b.steps.push({ t: t0, fn: function (run) {
      prepareSurface(dest.key);
      if (surface.rover) { surface.rover.position.set(-0.3, 0, 1.6); surface.rover.rotation.set(0, 0, 0); }
      setPhase(run, 'ROVER DRIVE');
      var drive = { u: 0 };
      addTween({
        from: 0, to: 1, dur: d * 0.86, token: run.token, ease: easeInOut,
        onUpdate: function (v) {
          drive.u = v;
          if (!surface.rover) return;
          var x = lerp(-0.3, 13, v);
          var z = 1.6 - Math.sin(v * Math.PI) * 3.2;
          var yaw = Math.cos(v * Math.PI) * 0.22;
          var y = sampleActiveTerrainHeight(x, z);
          surface.rover.position.set(x, y, z);
          surface.rover.rotation.set(0, yaw, 0);
          var roll = (x + 0.3) / 0.42;
          for (var i = 0; i < surface.wheels.length; i++) surface.wheels[i].rotation.z = -roll;
        }
      });
      run.updates.push(function (r, dt) {
        if (surface.rover && drive.u > 0.05 && drive.u < 0.92 && Math.random() < 0.45) {
          emitDustTrail(surface.rover.position.x - 0.5, surface.rover.position.y, surface.rover.position.z, dt, 0.35);
        }
        if (!surface.roverHead) return;
        if (reducedMotion) { surface.roverHead.rotation.y = 0.3; surface.roverHead.rotation.x = -0.05; return; }
        surface.roverHead.rotation.y = Math.sin(drive.u * Math.PI * 2.5) * 0.72;
        surface.roverHead.rotation.x = -0.05 + Math.sin(drive.u * Math.PI * 3.5) * 0.14;
      });
    } });
    b.keys.push(makeKey(t0, null, { x: 2, y: 4.2, z: 15, tx: 1, ty: 1.2, tz: 1.5, fov: 48 }));
    b.keys.push(makeKey(t0 + d * 0.5, null, { x: 8, y: 3.8, z: 13.5, tx: 8, ty: 1.2, tz: -0.5, fov: 45 }));
    b.keys.push(makeKey(t1, null, { x: 16, y: 3.6, z: 11.5, tx: 13.5, ty: 1.2, tz: 0.5, fov: 44 }));
  }

  function seqImageCapture(b, t0, t1, ctx) {
    var dest = ctx.dest, d = Math.max(1.5, t1 - t0);
    var photo = dest.key === 'moon' ? ASSETS.textures.moonPhoto : ASSETS.textures.marsPhoto;
    var caption = 'Illustrative mission simulation image' +
    (dest.name ? ' \u2014 ' + dest.name + ' surface' : '') + ' (not a real photograph)';
    b.steps.push({ t: t0, fn: function (run) {
      prepareSurface(dest.key);
      if (surface.rover) { surface.rover.position.set(11, 0, -2); surface.rover.rotation.set(0, -0.5, 0); }
      if (surface.roverHead) { surface.roverHead.rotation.y = 0.55; surface.roverHead.rotation.x = -0.12; }
      setPhase(run, 'IMAGE CAPTURE');
    } });
    b.keys.push(makeKey(t0, null, { x: 6.5, y: 3.4, z: 6.5, tx: 14, ty: 1.6, tz: -4.5, fov: 46 }));
    b.keys.push(makeKey(t1, null, { x: 8.2, y: 2.9, z: 5.0, tx: 15.2, ty: 1.5, tz: -5, fov: 40 }));
    b.steps.push({ t: t0 + d * 0.14, fn: function (run) {
      showReticle({ x: 15.5, y: 1.6, z: -5 }, run.token);
      if (effects.reticle && camera) effects.reticle.lookAt(camera.position);
      if (surface.roverHead) {
        addTween({
          from: 0.25, to: 0.58, dur: d * 0.35, token: run.token, ease: easeInOut,
          onUpdate: function (v) { if (surface.roverHead) surface.roverHead.rotation.y = v; }
        });
      }
    } });
    b.steps.push({ t: t0 + d * 0.54, fn: function (run) {
      shutterFlash(run.token, 0.45);
      showImageCard(encodePath(photo), caption);
      setPhase(run, 'IMAGE CAPTURE');
    } });
    b.steps.push({ t: t0 + d * 0.82, fn: function () { if (effects.reticle) effects.reticle.visible = false; } });
  }

  function seqDataUplink(b, t0, t1, ctx) {
    var dest = ctx.dest, d = Math.max(1.5, t1 - t0);
    b.steps.push({ t: t0, fn: function (run) {
      prepareSurface(dest.key);
      if (surface.rover) { surface.rover.position.set(9, 0, 2); surface.rover.rotation.set(0, -0.3, 0); }
      if (surface.relay) { surface.relay.visible = true; surface.relay.position.set(-4, 29, -24); }
      setPhase(run, 'DATA UPLINK');
      run.addUpdate(function (r) {
        if (!surface.relay) return;
        var u = clamp01((r.elapsed - t0) / d);
        surface.relay.position.set(lerp(-4, 20, u), 29 + Math.sin(u * Math.PI) * 2.2, -24);
        surface.relay.rotation.y = -0.35 + u * 0.45;
      });
      var leg1 = d * 0.28, leg2 = d * 0.34;
      function sendBurst(delay) {
        setTimeoutSafe(run, function () {
          launchPacket({ x: 9, y: 1.4, z: 2 }, { x: -6, y: 3.8, z: 0 }, leg1, 3.2, run.token, function () {
            launchPacket({ x: -6, y: 3.8, z: 0 }, { x: 16, y: 30, z: -24 }, leg2, 11, run.token, function () {
              if (!run.uplinkDone) {
                run.uplinkDone = true;
                showUplink();
                pulseInline(dom && dom.uplinkDot, run.token, 1.2);
                setPhase(run, 'UPLINK CONFIRMED');
              }
            }, surface.relay);
          });
        }, delay);
      }
      sendBurst(0); sendBurst(0.28); sendBurst(0.56);
    } });
    b.keys.push(makeKey(t0, null, { x: 26, y: 16, z: 32, tx: 0, ty: 10, tz: -6, fov: 54 }));
    b.keys.push(makeKey(t1, null, { x: 22, y: 14, z: 28, tx: 4, ty: 14, tz: -10, fov: 52 }));
  }

  var SURFACE_SEQS = {
    approach: seqApproach, transfer: seqApproach,
    descent: seqLanding, landing: seqLanding, touchdown: seqLanding,
    crew: seqCrew, rover_deploy: seqRoverDeploy, drive: seqRoverDrive,
    image: seqImageCapture, capture: seqImageCapture, uplink: seqDataUplink
  };

  function surfaceSeqFor(phase) {
    if (!phase) return null;
    if (SURFACE_SEQS[phase]) return SURFACE_SEQS[phase];
    var keys = Object.keys(SURFACE_SEQS);
    for (var i = 0; i < keys.length; i++) if (phase.indexOf(keys[i]) !== -1) return SURFACE_SEQS[keys[i]];
    if (phase.indexOf('approach') !== -1 || phase.indexOf('transfer') !== -1) return seqApproach;
    if (phase.indexOf('crew') !== -1) return seqCrew;
    if (phase.indexOf('rover') !== -1) return seqRoverDeploy;
    if (phase.indexOf('drive') !== -1 || phase.indexOf('surface') !== -1) return seqRoverDrive;
    if (phase.indexOf('image') !== -1 || phase.indexOf('capture') !== -1) return seqImageCapture;
    if (phase.indexOf('uplink') !== -1) return seqDataUplink;
    return null;
  }

  // --- Per-frame launch updaters --------------------------------------------
  function runFxUpdate(run, dt) {
    var fx = run.fx;
    if (!rocket.group) return;

    fx.flame += (fx.flameGoal - fx.flame) * Math.min(1, dt * 6);
    var shown = fx.flame;
    if (shown > 0.02 && fx.flickerAmp > 0) shown *= 1 + fx.flickerAmp * wobble(run.elapsed * 27);
    var vac = 1.0 + clamp01((rocket.group.position.y - 75) / 140) * 0.75;
    setFlame(clamp01(shown), vac);

    if (fx.smoke > 0 && fx.flame > 0.12) emitSmokeTrail(dt, fx.flame * fx.smoke);
    if (fx.padSteam > 0) emitPadSteam(dt, fx.padSteam);

    if (fx.shudder > 0 && !reducedMotion) {
      rocket.group.position.x += wobble(run.elapsed * 41) * 0.05 * fx.shudder;
      rocket.group.position.y += wobble(run.elapsed * 53 + 2) * 0.04 * fx.shudder;
      rocket.group.rotation.z += wobble(run.elapsed * 37 + 4) * 0.012 * fx.shudder;
    }

    if (fx.jitterLower > 0 && rocket.lower && !reducedMotion) {
      rocket.lower.position.x = wobble(run.elapsed * 61) * 0.12 * fx.jitterLower;
      rocket.lower.position.y = wobble(run.elapsed * 47 + 1) * 0.1 * fx.jitterLower;
      rocket.lower.rotation.z = wobble(run.elapsed * 39 + 3) * 0.05 * fx.jitterLower;
    }

    if (rocket.beaconMat) {
      rocket.beaconMat.emissiveIntensity = fx.beacon > 0
      ? (reducedMotion ? 0.9 : fx.beacon * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(run.elapsed * 4.2)))) : 0;
    }

    var L = fx.lights;
    if (rocket.craftLight) rocket.craftLight.intensity = 0.65 * L;
    if (rocket.engineLight) rocket.engineLight.intensity = fx.flame * 3.2 * L;
    if (rocket.matWindow) rocket.matWindow.emissiveIntensity = 0.9 * L;
    if (world.padLightMat) world.padLightMat.emissiveIntensity = 1.1 * (0.4 + 0.6 * L);
  }

  function runAtmosphereUpdate(run) {
    if (!rocket.group) return;
    var u = clamp01((rocket.group.position.y - 65) / 175);
    setAtmosphereBlend(u);
    if (u > 0.72) {
      if (!run.orbitShown) {
        run.orbitShown = true;
        setupOrbitShowcase('earth-orbit');
      }
      updateOrbitShowcase(run.elapsed);
    }
  }

  function restoreLighting() {
    if (rocket.matWindow) rocket.matWindow.emissiveIntensity = 0.9;
    if (world.padLightMat) world.padLightMat.emissiveIntensity = 1.1;
    if (rocket.craftLight) rocket.craftLight.intensity = 0.65;
    if (rocket.engineLight) rocket.engineLight.intensity = 0;
    if (rocket.beaconMat) rocket.beaconMat.emissiveIntensity = 0;
  }

  function deployPayload(run) {
    if (!rocket.payload || !rocket.payload.group) return;
    refreshActivePayloadModel();
    var pg = rocket.payload.group;
    pg.visible = true;
    rocket.payloadDeployed = true;
    var panels = [];
    pg.traverse(function (o) { if (o.userData && o.userData.isPanel) panels.push(o); });
    emitRcsPuff(rocket.group.position.x, rocket.group.position.y, rocket.group.position.z, 0.8, 0.3, 0.2);
    addTween({
      from: 0, to: 1, dur: 2.8, token: run.token, ease: easeOutCubic,
      onUpdate: function (v) {
        pg.position.x = v * 6.5;
        pg.position.y = 8.2 + v * 2.8;
        pg.position.z = v * 1.4;
        pg.rotation.y = v * 1.8;
        pg.rotation.x = v * 0.35;
        for (var i = 0; i < panels.length; i++) {
          var s = panels[i].userData.side || 1;
          panels[i].position.x = s * (0.5 + v * 0.95);
          panels[i].rotation.z = s * (1 - v) * 1.3;
        }
      }
    });
    setPhase(run, 'PAYLOAD DEPLOY');
  }

  function phaseLabelOf(phase) {
    if (!phase) return 'FLIGHT';
    if (PAD_PHASES[phase]) return 'ON STAND';
    return humanizeType(phase);
  }

  function mapRecoveredEvents(outcome, samples, win0, win1) {
    var out = [], evs = outcome && Array.isArray(outcome.events) ? outcome.events : [], rec = [];
    for (var i = 0; i < evs.length; i++) if (evs[i] && evs[i].recovered === true) rec.push(evs[i]);
    if (!rec.length) return out;
    var useTimes = timelineHasTimes(samples), t0 = 0, t1 = 0;
    if (useTimes) {
      t0 = t1 = samples[0].time;
      for (var j = 1; j < samples.length; j++) {
        if (samples[j].time < t0) t0 = samples[j].time;
        if (samples[j].time > t1) t1 = samples[j].time;
      }
    }
    var span = Math.max(1, win1 - win0);
    for (var k = 0; k < rec.length; k++) {
      var ev = rec[k], raw = isNum(ev.time) ? ev.time : (isNum(ev.t) ? ev.t : null), t = null;
      if (raw !== null && useTimes && t1 - t0 > 1e-6) t = win0 + ((raw - t0) / (t1 - t0)) * span;
      if (t === null) t = win0 + span * (0.35 + 0.4 * (rec.length === 1 ? 0.5 : k / (rec.length - 1)));
      out.push({ ev: ev, t: clamp(t, win0 + 0.3, Math.max(win0 + 0.4, win1 - 0.6)) });
    }
    return out;
  }

  function buildScript(outcome, mission, opts) {
    opts = opts || {};
    var preview = !!opts.preview, duration = isNum(opts.duration) ? opts.duration : TOTAL_LAUNCH;
    var failure = (outcome && outcome.failure && typeof outcome.failure === 'object') ? outcome.failure : null;
    var failureType = failure ? str(failure.type).toLowerCase() : '';
    var kind = FAILURE_KINDS[failureType] || null;
    var dest = resolveDestination(mission);

    var b = {
      keys: [], steps: [], updates: [], duration: duration, preview: preview,
      label: opts.label || '', phase: opts.phase || '',
      drift: !!opts.drift, driftUntil: 0, hasRocketKeys: false
    };
    function step(t, fn) { b.steps.push({ t: t, fn: fn }); }

    if (kind && kind.noLaunch) {
      b.duration = preview ? 2.6 : 1.6;
      b.keys.push(makeKey(0, PHASE_POSES.pad.r, PHASE_POSES.pad.c));
      b.keys.push(makeKey(b.duration, PHASE_POSES.pad.r, { x: 18, y: 9, z: 30, tx: 0, ty: 8, tz: 0, fov: 46 }));
      b.hasRocketKeys = true;
      step(0, function (run) { prepareLaunch(); setPhase(run, 'LAUNCH BLOCKED'); });
      step(0.15, function (run) { var l = failureLabel(failure); setAlert(run, 'failure', l.title, l.detail); });
      b.updates.push(runFxUpdate);
      return b;
    }

    var samples = normalizeTimeline(outcome);
    if (samples.length === 0 || (samples.length === 1 && !isSurfacePhase(samples[0].phase))) {
      samples = [
        { phase: 'pad', raw: 'pad', time: null },
        { phase: 'ascent', raw: 'ascent', time: null },
        { phase: 'coast', raw: 'coast', time: null },
        { phase: 'orbit', raw: 'orbit', time: null }
      ];
    }

    var firstIsPad = isPadPhase(samples[0].phase);
    var cd = firstIsPad ? COUNTDOWN_DUR : 0;
    var winStart = cd, mapStart = cd + (firstIsPad ? 0 : 0.9), mapEnd = Math.max(mapStart + 1.6, duration - 0.25);
    b.driftUntil = cd;

    var firstSurf = -1, nSurf = 0, ordered = true, seenSurf = false;
    for (var i0 = 0; i0 < samples.length; i0++) {
      var isS = isSurfacePhase(samples[i0].phase);
      if (isS) { if (firstSurf === -1) firstSurf = i0; nSurf++; seenSurf = true; }
      else if (seenSurf) ordered = false;
    }
    var nLaunch = samples.length - nSurf, allSurface = nSurf === samples.length;

    var launchTimes = [], surfSlices = [];
    if (allSurface) {
      for (var i1 = 0; i1 < samples.length; i1++) {
        surfSlices.push({ i: i1, t0: (i1 / samples.length) * duration, t1: ((i1 + 1) / samples.length) * duration });
      }
    } else if (nSurf === 0) {
      launchTimes = mapSampleTimes(samples, mapStart, mapEnd);
    } else if (ordered && firstSurf > 0) {
      var lwEnd = mapStart + Math.max(1.6, (duration - mapStart - 1.6) * 0.62);
      launchTimes = mapSampleTimes(samples.slice(0, firstSurf), mapStart, lwEnd);
      var sStart = lwEnd + 0.4, sEnd = Math.max(sStart + 1.2, duration - 0.15), per = (sEnd - sStart) / nSurf;
      for (var s0 = 0; s0 < nSurf; s0++) surfSlices.push({ i: firstSurf + s0, t0: sStart + s0 * per, t1: sStart + (s0 + 1) * per });
    } else {
      launchTimes = mapSampleTimes(samples, mapStart, mapEnd);
      for (var i2 = 0; i2 < samples.length; i2++) {
        if (!isSurfacePhase(samples[i2].phase)) continue;
        var st0 = launchTimes[i2], st1 = i2 + 1 < samples.length ? launchTimes[i2 + 1] : duration - 0.15;
        surfSlices.push({ i: i2, t0: st0, t1: Math.max(st0 + 0.8, st1) });
      }
    }

    var tF = null;
    if (kind && nLaunch > 0) {
      var lSamples = allSurface ? [] : (nSurf === 0 ? samples : samples.slice(0, firstSurf));
      var lTimes = nSurf === 0 ? launchTimes : launchTimes.slice(0, nLaunch);
      if (lSamples.length) tF = chooseFailureTime(kind, failure, lSamples, lTimes, mapStart, mapEnd, winStart);
    }

    if (!allSurface) {
      if (!firstIsPad) b.keys.push(makeKey(0, PHASE_POSES.pad.r, PHASE_POSES.pad.c));
      for (var i3 = 0; i3 < nLaunch; i3++) {
        var t = launchTimes[i3];
        if (tF !== null && t > tF + 1e-6) break;
        var phKey = samples[i3].phase, pose = poseForPhase(phKey);
        b.keys.push(makeKey(t, pose.r, pose.c));
        step(t, (function (label) { return function (run) { setPhase(run, label); }; })(phaseLabelOf(phKey)));
      }
      if (tF !== null && kind) appendFailure(b, kind, failureType, failure, tF);
    }

    for (var s2 = 0; s2 < surfSlices.length; s2++) {
      var sl = surfSlices[s2], seq = surfaceSeqFor(samples[sl.i].phase);
      if (seq) seq(b, sl.t0, Math.max(sl.t0 + 0.8, sl.t1), { dest: dest });
    }

    if (!allSurface) {
      step(0, function (run) {
        prepareLaunch();
        setPayloadModelForMission(mission);
        setPhase(run, cd > 0 ? 'COUNTDOWN' : 'IGNITION');
      });
      if (cd > 0) {
        step(0.25, function () { showCountdown('3'); });
        step(0.6, function (run){
          addTween({
            from: 0, to: 1, dur: Math.min(1.5, Math.max(0.6, cd - 0.8)), token: run.token, ease: easeInOut,
                   onUpdate: function (v) { setTowerArmsRetract(v); }
          });
        });
        step(1.05, function () { showCountdown('2'); });
        step(1.85, function () { showCountdown('1'); });
        step(cd - 0.12, function () { hideCountdown(); });
        b.updates.push(function (r, dt) { if (r.elapsed < cd) emitCryoVent(dt); });
      }
      var igT = cd > 0 ? Math.max(0.1, cd - 0.7) : 0.15;
      step(igT, function (run) {
        run.fx.flameGoal = 0.84;
        run.fx.flickerAmp = 0.22;
        run.fx.padSteam = 0.9;
        run.fx.camShake = 0.65;
      });
      if (!(tF !== null && tF <= winStart + 1e-6)) {
        step(winStart, function (run) {
          run.fx.flameGoal = 1;
          run.fx.flickerAmp = 0.12;
          run.fx.smoke = 1;
          run.fx.padSteam = 0.8;
          run.fx.camShake = 0.5;
          if (cd > 0) setPhase(run, 'ASCENT');
        });
          step(winStart + 1.4, function (run) {
            run.fx.padSteam = 0;
            run.fx.camShake = 0.14;
          });
      }
      b.updates.push(runAtmosphereUpdate);
    }

    var stageT = null, coastT = null, orbitT = null, deployT = null;
    if (!allSurface) {
      for (var i4 = 0; i4 < nLaunch; i4++) {
        var tt = launchTimes[i4];
        if (tF !== null && tt > tF + 1e-6) break;
        var ph = samples[i4].phase || '';
        if (stageT === null && (ph.indexOf('stage') !== -1 || ph.indexOf('separation') !== -1)) stageT = tt;
        if (coastT === null && ph.indexOf('coast') !== -1) coastT = tt;
        if (orbitT === null && ph.indexOf('orbit') !== -1) orbitT = tt;
        if (deployT === null && (ph.indexOf('deploy') !== -1 || ph.indexOf('payload') !== -1)) deployT = tt;
      }
    }

    if (stageT !== null && !(tF !== null && stageT >= tF - 1e-6)) {
      step(stageT, function (run) {
        setPhase(run, 'STAGE SEPARATION');
        run.fx.flameGoal = 0;
        run.fx.smoke = 0;
        run.fx.camShake = 0.22;
        if (rocket.group) {
          emitSepBurst(rocket.group.position.x, rocket.group.position.y + 5.5, rocket.group.position.z);
        }
        var lg = rocket.lower;
        addTween({
          from: 0, to: 1, dur: 2.8, token: run.token, ease: easeInQuad,
          onUpdate: function (v) {
            lg.position.y = -15 * v;
            lg.position.x = -3.2 * v;
            lg.rotation.z = 1.25 * v;
            lg.rotation.x = 0.55 * v;
          }
        });
        fadeLowerStage(2.5, run.token);
        addTween({
          from: 0, to: 0.95, dur: 0.65, delay: 0.45, token: run.token, ease: easeOutCubic,
          onUpdate: function (v) { rocket.upperFlameLevel = v; }
        });
        run.fx.smoke = 0.55;
        setTimeoutSafe(run, function () {
          run.fx.smoke = 0.3;
          run.fx.camShake = 0.08;
        }, 1.1);
      });
    }

    var cutT = coastT !== null ? coastT : orbitT;
    if (cutT !== null && tF === null) {
      step(cutT, function (run) {
        run.fx.flameGoal = 0;
        run.fx.smoke = 0;
        run.fx.camShake = 0;
        addTween({
          from: rocket.upperFlameLevel || 0, to: 0, dur: 0.35, token: run.token, ease: easeOutQuad,
          onUpdate: function (v) { rocket.upperFlameLevel = v; }
        });
        if (rocket.group) {
          emitRcsPuff(rocket.group.position.x, rocket.group.position.y, rocket.group.position.z, 0.3, 0.9, 0.2);
        }
        if (coastT !== null) setPhase(run, 'COAST');
      });
    }
    if (deployT !== null && tF === null) {
      step(deployT, function (run) {
        rocket.upperFlameLevel = 0;
        deployPayload(run);
      });
    }

    var evWin0 = allSurface ? 0 : mapStart;
    var evWin1 = allSurface ? duration : mapEnd;
    var events = mapRecoveredEvents(outcome, samples, evWin0, evWin1);
    for (var e0 = 0; e0 < events.length; e0++) {
      (function (item) {
        step(item.t, function (run) {
          var lab = eventLabel(item.ev);
          setAlert(run, 'warning', lab.title, lab.detail);
          pulseInline(dom && dom.alert, run.token, 1.5);
          setPhase(run, 'RECOVERED EVENT');
        });
        step(item.t + 1.9, function (run) {
          if (run.alertIs === 'warning') { hideAlert(); run.alertIs = null; }
        });
      })(events[e0]);
    }

    b.updates.push(runFxUpdate);
    for (var k0 = 0; k0 < b.keys.length; k0++) {
      if (b.keys[k0].r) { b.hasRocketKeys = true; break; }
    }
    return b;
  }

  function setTimeoutSafe(run, fn, delay) {
    addTween({ from: 0, to: 1, dur: delay, token: run.token, onComplete: function () { fn(run); } });
  }

  // --- Lifecycle / run-token ------------------------------------------------
  var pendingCbs = [];

  function startRun(spec) {
    cancelActiveRun();
    clearAllOverlays();
    var token = ++runToken;
    killTweens();

    var run = {
      token: token,
      done: false,
      elapsed: 0,
      duration: spec.duration > 0 ? spec.duration : TOTAL_LAUNCH,
      timeScale: spec.timeScale > 0 ? spec.timeScale : 1,
      keys: spec.keys || [],
      hasRocketKeys: !!spec.hasRocketKeys,
      steps: spec.steps || [],
      stepIdx: 0,
      updates: spec.updates || [],
      phase: spec.phase || spec.label || '',
      label: spec.label || '',
      preview: !!spec.preview,
      drift: !!spec.drift,
      driftUntil: spec.driftUntil || 0,
      alertIs: null,
      orbitShown: false,
      uplinkDone: false,
      fx: {
        flame: 0, flameGoal: 0, flickerAmp: 0, smoke: 0, padSteam: 0,
        shudder: 0,beacon: 0, lights: 1, jitterLower: 0, camShake: 0
      },
      onDone: typeof spec.onDone === 'function' ? spec.onDone : null
    };
    run.addUpdate = function (fn) { if (run.updates.indexOf(fn) === -1) run.updates.push(fn); };
    run.setPhase = function (p) { run.phase = p; };

    run.steps.sort(function (a, c) { return a.t - c.t; });
    activeRun = run;
    idleActive = false;
    cameraBlend = null;
    camSmooth.ready = false;
    if (preview) setPreviewPhase(run.phase);
    return run;
  }

  function finishRun(run) {
    if (!run || run.done) return;
    if (run.token !== runToken) return;
    run.done = true;
    if (activeRun === run) activeRun = null;
    cleanupRun(run);
    var cb = run.onDone;
    run.onDone = null;
    if (!cb) return;
    if (finishing) { pendingCbs.push(cb); return; }
    finishing = true;
    try { cb(); } catch (e) { console.warn('[scene] onDone error:', e); }
    finishing = false;
    flushPendingCbs();
  }

  function flushPendingCbs() {
    var guard = 0;
    while (pendingCbs.length && guard < 16) {
      guard++;
      var cb = pendingCbs.shift();
      finishing = true;
      try { cb(); } catch (e) { console.warn('[scene] onDone error:', e); }
      finishing = false;
    }
    pendingCbs.length = 0;
  }

  function cancelActiveRun() {
    var guard = 0;
    while (activeRun && !activeRun.done && guard < 4) {
      guard++;
      finishRun(activeRun);
    }
    if (activeRun && !activeRun.done) {
      activeRun.done = true;
      activeRun = null;
    }
  }

  function cleanupRun(run) {
    killTweens();
    clearTransientOverlays();
    if (run.alertIs === 'warning') hideAlert();
    stopEffects();
    setFlame(0);
    rocket.upperFlameLevel = 0;
    restoreLighting();
    if (surface.landerFlame) applyFlame(surface.landerFlame, 0, 1);
    if (surface.landerLight) surface.landerLight.intensity = 0;
    if (run.updates) run.updates.length = 0;
  }

  function updateRun(dt) {
    var run = activeRun;
    if (!run || run.done || run.token !== runToken) return;
    var sdt = dt * run.timeScale;
    run.elapsed += sdt;

    while (run.stepIdx < run.steps.length && run.steps[run.stepIdx].t <= run.elapsed) {
      var st = run.steps[run.stepIdx++];
      if (run.done || run.token !== runToken) break;
      try { st.fn(run); } catch (e) { console.warn('[scene] step error:', e); }
    }

    if (run.keys.length && camera) {
      poseAtInto(run.keys, run.elapsed, scratchR, scratchC);
      if (run.hasRocketKeys) applyPoseToRocket(scratchR);
      var driftT = -1, driftAmp = 1;
      if (run.drift) {
        driftT = run.elapsed;
      } else if (run.elapsed < run.driftUntil) {
        driftT = run.elapsed;
        driftAmp = clamp01((run.driftUntil - run.elapsed) / 0.6);
      }
      applyPoseToCamera(scratchC, driftT, driftAmp, sdt, run.fx.camShake || 0);
      camTX = scratchC.tx; camTY = scratchC.ty; camTZ = scratchC.tz;
    }

    for (var i = 0; i < run.updates.length; i++) {
      try { run.updates[i](run, sdt); }
      catch (e) { console.warn('[scene] update error:', e); }
    }

    if (run.preview && preview) {
      setPreviewPhase(run.phase || run.label);
      setPreviewProgress(clamp01(run.elapsed / run.duration));
    }

    if (run.elapsed >= run.duration) finishRun(run);
  }

  function updateIdle(dt) {
    if (!idleActive || !camera) return;
    var amp = reducedMotion ? 0.35 : 1;
    var speed = reducedMotion ? 0.5 : 1;
    var a = elapsedWall * 0.045 * speed + 0.6;
    var tx = Math.sin(a) * 44 + 4;
    var ty = 15 + Math.sin(elapsedWall * 0.11 * speed) * 1.6 * amp;
    var tz = Math.cos(a) * 44 + 6;
    var cx = 0, cy = 7.5, cz = 0;

    if (cameraBlend) {
      cameraBlend.t += dt;
      var u = easeInOut(clamp01(cameraBlend.t / cameraBlend.dur));
      camera.position.set(lerp(cameraBlend.x, tx, u), lerp(cameraBlend.y, ty, u), lerp(cameraBlend.z, tz, u));
      camera.lookAt(lerp(cameraBlend.tx, cx, u), lerp(cameraBlend.ty, cy, u), lerp(cameraBlend.tz, cz, u));
      if (Math.abs(camera.fov - BASE_FOV) > 0.05) {
        camera.fov = lerp(camera.fov, BASE_FOV, u);
        camera.updateProjectionMatrix();
      }
      if (cameraBlend.t >= cameraBlend.dur) cameraBlend = null;
    } else {
      camera.position.set(tx, ty, tz);
      camera.lookAt(cx, cy, cz);
    }
    camTX = cx; camTY = cy; camTZ = cz;

    if (world.padGroup && world.padGroup.visible) emitCryoVent(dt);

    if (world.towerBeaconMat) {
      var bPulse = 0.5 + 0.5 * Math.sin(elapsedWall * 2.4);
      world.towerBeaconMat.emissiveIntensity = 0.5 + bPulse * 1.2;
    }
    if (world.stars && world.stars.visible) {
      var tw = 0.5 + 0.5 * Math.sin(elapsedWall * 0.9);
      world.stars.material.opacity = 0.8 + tw * 0.16;
      if (world.stars2) world.stars2.material.opacity = 0.4 + tw * 0.24;
    }
    if (rocket.engineLight) {
      rocket.engineLight.intensity = 0.32 + (reducedMotion ? 0 : 0.1 * Math.sin(elapsedWall * 1.7));
    }
  }

  function showPad(build) {
    if (!initialized) {
      console.warn('[scene] showPad() called before init()');
      return;
    }
    var wasIdle = idleActive;
    cancelActiveRun();
    clearAllOverlays();
    if (rocket.group) resetRocketVisual();
    restoreLighting();
    applyBuild(build);
    if (surface.group) surface.group.visible = false;
    if (world.padGroup) world.padGroup.visible = true;
    applyLocale('earth');
    stopEffects();
    idleActive = true;
    camSmooth.ready = false;
    if (!wasIdle && camera && !reducedMotion) {
      cameraBlend = {
        t: 0, dur: 0.75,
        x: camera.position.x, y: camera.position.y, z: camera.position.z,
        tx: camTX, ty: camTY, tz: camTZ
      };
    } else if (camera) {
      camera.fov = BASE_FOV;
      camera.updateProjectionMatrix();
    }
    if (preview) { setPreviewPhase('IDLE'); setPreviewProgress(0); }
  }

  function applyBuild(build) {
    var b = (build && typeof build === 'object') ? build : {};
    updateNozzles(readEngineCount(b));
    updateFuelPanels(readFuelRatio(b));
  }

  function playLaunch(outcome, mission, onDone) {
    var cb = typeof onDone === 'function' ? onDone : null;
    if (!initialized) { if (cb) cb(); return; }
    var pv = pendingPreviewRun;
    pendingPreviewRun = null;
    var spec = buildScript(outcome, mission, {
      preview: !!pv,
      duration: TOTAL_LAUNCH,
      label: pv && pv.label ? pv.label : ''
    });
    spec.preview = !!pv;
    spec.timeScale = pv ? PREVIEW_TIME_SCALE : 1;
    spec.onDone = cb;
    startRun(spec);
  }

  function skip() {
    if (!initialized) return;
    var run = activeRun;
    if (!run || run.done) return;
    finishRun(run);
    settleAfterSkip(run);
  }

  function settleAfterSkip(run) {
    applyLocale('earth');
    if (rocket.group) resetRocketVisual();
    if (surface.group) surface.group.visible = false;
    if (world.padGroup) world.padGroup.visible = true;
    idleActive = true;
    camSmooth.ready = false;
    if (camera) {
      cameraBlend = {
        t: 0, dur: reducedMotion ? 0.4 : 0.9,
        x: camera.position.x, y: camera.position.y, z: camera.position.z,
        tx: camTX, ty: camTY, tz: camTZ
      };
    }
    if (preview && preview.current) {
      var def = null;
      for (var i = 0; i < CLIPS.length; i++) if (CLIPS[i].id === preview.current) { def = CLIPS[i]; break; }
      setPreviewPhase('STOPPED \u2014 ' + ((def && def.label) || preview.current).toUpperCase());
    }
    void run;
  }

  // --- Render loop / init ---------------------------------------------------
  function frame(now) {
    rafId = window.requestAnimationFrame(frame);
    var dt = 0.016;
    if (lastFrameTime) dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    if (!(dt >= 0)) dt = 0;
    if (dt > 0.5) dt = 0.5;
    elapsedWall += dt;

    var sdt = activeRun ? dt * activeRun.timeScale : dt;
    updateTweens(sdt);
    updateRun(dt);
    updateIdle(dt);
    updateEffects(sdt);
    updateRocketClipPlanes();
    syncCameraHud();
    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  function syncCameraHud() {
    if (!camera) return;
    if (effects.flash && effects.flash.visible) {
      effects.flash.position.copy(camera.position);
      effects.flash.quaternion.copy(camera.quaternion);
      effects.flash.translateZ(-1);
    }
    if (effects.warp && effects.warp.visible) {
      effects.warp.position.copy(camera.position);
      effects.warp.quaternion.copy(camera.quaternion);
    }
  }

  function startLoop() {
    if (rafId) return;
    lastFrameTime = 0;
    rafId = window.requestAnimationFrame(frame);
  }

  function onMotionChange() {
    try { reducedMotion = !!(mediaQuery && mediaQuery.matches); }
    catch (e) { reducedMotion = false; }
  }

  function init(containerEl) {
    if (initialized) return;
    if (!containerEl || !containerEl.appendChild) {
      console.warn('[scene] init() needs a container element');
      return;
    }
    initialized = true;
    container = containerEl;

    THREEOK = typeof THREE !== 'undefined';
    HAS_GSAP = typeof gsap !== 'undefined';
    hasGLTF = THREEOK && typeof THREE.GLTFLoader === 'function';

    try {
      if (window.matchMedia) {
        mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        reducedMotion = !!mediaQuery.matches;
        if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', onMotionChange);
        else if (mediaQuery.addListener) mediaQuery.addListener(onMotionChange);
      }
    } catch (e) { mediaQuery = null; }

    createOverlay(container);

    previewEnabled = /[?&]visualPreview=1(&|$)/.test(
      String(window.location && window.location.search || ''));
    if (previewEnabled) createPreview();

    if (!THREEOK) {
      showError('3D could not start: Three.js (r128) did not load. Check the connection and reload.');
      console.warn('[scene] window.THREE is missing -- DOM overlays only.');
      startLoop();
      return;
    }

    if (!initRenderer(container)) {
      showError('3D could not start: WebGL is unavailable here. The mission screens still work.');
    }

    try {
      createWorld();
      loadAssets();
    } catch (e) {
      console.warn('[scene] world setup failed:', e);
      showError('3D could not start: the scene failed to build. The mission screens still work.');
    }
    onResize();

    if (typeof window.ResizeObserver !== 'undefined') {
      resizeObserver = new window.ResizeObserver(function () { onResize(); });
      resizeObserver.observe(container);
    } else {
      windowResizeHandler = function () { onResize(); };
      window.addEventListener('resize', windowResizeHandler);
    }

    startLoop();
    showPad(null);
  }

  // --- Preview lab (dev only) ----------------------------------------------
  function createPreview() {
    var el = document.createElement('div');
    el.className = 'smg-preview';
    el.setAttribute('hidden', '');
    el.innerHTML =
    '<div class="smg-preview__banner">VISUAL PREVIEW \u2014 NOT A SIMULATION RESULT</div>' +
    '<div class="smg-preview__tabs"></div>' +
    '<div class="smg-preview__status">' +
    '<span class="smg-preview__phase"></span>' +
    '<div class="smg-preview__track"><div class="smg-preview__progress"></div></div>' +
    '</div>' +
    '<div class="smg-preview__actions">' +
    '<button type="button" class="smg-preview__btn" data-action="replay">Replay</button>' +
    '<button type="button" class="smg-preview__btn" data-action="stop">Stop</button>' +
    '<button type="button" class="smg-preview__btn" data-action="reset">Reset</button>' +
    '</div>' +
    '<div class="smg-preview__warn" hidden></div>';

    var tabs = el.querySelector('.smg-preview__tabs');
    var html = '';
    for (var i = 0; i < CLIPS.length; i++) {
      html += '<button type="button" class="smg-preview__btn" data-clip="' +
      CLIPS[i].id + '">' + CLIPS[i].label + '</button>';
    }
    tabs.innerHTML = html;
    container.appendChild(el);
    el.removeAttribute('hidden');

    preview = {
      root: el,
      phase: el.querySelector('.smg-preview__phase'),
      progress: el.querySelector('.smg-preview__progress'),
      warn: el.querySelector('.smg-preview__warn'),
      current: null
    };
    el.addEventListener('click', onPreviewClick);
    setPreviewPhase('IDLE');
    setPreviewProgress(0);

    if (assetIssues.length && preview.warn) {
      preview.warn.textContent = assetIssues.join('  |  ');
      preview.warn.removeAttribute('hidden');
    }
  }

  function walkToButton(target) {
    var node = target;
    while (node && node !== document) {
      if (node.getAttribute && (node.getAttribute('data-clip') || node.getAttribute('data-action'))) return node;
      node = node.parentNode;
    }
    return null;
  }

  function onPreviewClick(e) {
    var btn = walkToButton(e && e.target);
    if (!btn) return;
    var clip = btn.getAttribute('data-clip');
    if (clip) { previewPlay(clip); return; }
    var action = btn.getAttribute('data-action');
    if (action === 'replay') {
      if (preview && preview.current) previewPlay(preview.current);
      else previewReset();
    } else if (action === 'stop') {
      SMG.scene.skip();
    } else if (action === 'reset') {
      previewReset();
    }
  }

  function setPreviewPhase(text) { if (preview && preview.phase) preview.phase.textContent = text || ''; }
  function setPreviewProgress(f) {
    if (preview && preview.progress) preview.progress.style.width = (clamp01(f) * 100).toFixed(1) + '%';
  }

  function previewPlay(id) {
    if (!initialized) return;
    var def = null;
    for (var i = 0; i < CLIPS.length; i++) if (CLIPS[i].id === id) { def = CLIPS[i]; break; }
    if (!def) return;
    if (preview) preview.current = id;
    previewCurrentClip = id;
    setPreviewPhase('STARTING \u2014 ' + def.label.toUpperCase());
    setPreviewProgress(0);

    if (id === 'pad') { previewIdlePad(def); return; }
    var mock = PREVIEW_MOCKS[id];
    if (!mock) { setPreviewPhase('NO MOCK FOR ' + id); return; }
    pendingPreviewRun = { label: def.label };
    SMG.scene.playLaunch(mock.outcome, mock.mission, function () {
      if (previewCurrentClip !== id) return;
      setPreviewPhase('DONE \u2014 ' + def.label.toUpperCase());
      setPreviewProgress(1);
    });
  }

  function previewIdlePad(def) {
    cancelActiveRun();
    showPad(PREVIEW_BUILD);
    startRun({
      keys: [makeKey(0, PHASE_POSES.pad.r, PHASE_POSES.pad.c)],
             hasRocketKeys: true,
             steps: [],
             updates: [function (r, dt) { emitCryoVent(dt); }],
             duration: 4.5, preview: true, timeScale: 1,
             phase: 'IDLE PAD', label: def ? def.label : 'Idle Pad', drift: true,
             onDone: function () {
               if (previewCurrentClip !== 'pad') return;
               setPreviewPhase('DONE \u2014 IDLE PAD');
               setPreviewProgress(1);
             }
    });
  }

  function previewReset() {
    cancelActiveRun();
    clearAllOverlays();
    showPad(PREVIEW_BUILD);
    if (preview) preview.current = null;
    previewCurrentClip = null;
    setPreviewPhase('IDLE');
    setPreviewProgress(0);
  }

  // ============================ PREVIEW_MOCKS =============================
  var PREVIEW_BUILD = { engines: 5, fuel: 0.78 };

  function mockMission(destName, name) {
    return { id: 'preview', name: name || 'Preview Mission', destinationName: destName || '' };
  }
  function mockLaunch(phases) {
    var tl = [];
    for (var i = 0; i < phases.length; i++) tl.push({ phase: phases[i], time: i });
    return { ok: true, timeline: tl, events: [] };
  }
  function mockFailure(type, extra, phases) {
    var o = mockLaunch(phases);
    o.ok = false;
    o.failure = { type: type };
    if (extra) {
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o.failure[k] = extra[k];
    }
    return o;
  }

  var PREVIEW_MOCKS = {
    'countdown': { outcome: mockLaunch(['pad', 'ascent']), mission: mockMission('Earth Orbit', 'Countdown Preview') },
    'ascent': { outcome: mockLaunch(['pad', 'ascent']), mission: mockMission('Earth Orbit', 'Ascent Preview') },
    'stage': { outcome: mockLaunch(['pad', 'ascent', 'stage', 'coast']), mission: mockMission('Earth Orbit', 'Staging Preview') },
    'coast': { outcome: mockLaunch(['ascent', 'coast']), mission: mockMission('Earth Orbit', 'Coast Preview') },
    'orbit': { outcome: mockLaunch(['ascent', 'coast', 'orbit']), mission: mockMission('Earth Orbit', 'Orbit Preview') },
    'deploy': { outcome: mockLaunch(['ascent', 'orbit', 'deploy']), mission: mockMission('Earth Orbit', 'Deploy Preview') },
    'fail-thrust-low': {
      outcome: mockFailure('thrust_low', { message: 'Engines were too weak to climb.' }, ['pad', 'ascent']),
      mission: mockMission('Earth Orbit', 'Thrust Low Preview')
    },
    'fail-fuel-out': {
      outcome: mockFailure('fuel_out', { message: 'Fuel ran out during the climb.', altitudeKm: 84 }, ['pad', 'ascent', 'coast']),
      mission: mockMission('Earth Orbit', 'Fuel Out Preview')
    },
    'fail-power-short': {
      outcome: mockFailure('power_short', { message: 'A power bus failed mid-flight.' }, ['pad', 'ascent', 'orbit']),
      mission: mockMission('Earth Orbit', 'Power Short Preview')
    },
    'fail-sensor-fault': {
      outcome: mockFailure('sensor_fault', { message: 'A navigation sensor drifted off nominal.' }, ['pad', 'ascent', 'coast']),
      mission: mockMission('Earth Orbit', 'Sensor Fault Preview')
    },
    'fail-stage-fail': {
      outcome: mockFailure('stage_fail', { message: 'The stage separation did not complete.', stage: 1 }, ['pad', 'ascent', 'stage', 'coast']),
      mission: mockMission('Earth Orbit', 'Stage Fault Preview')
    },
    'fail-over-budget': {
      outcome: mockFailure('over_budget', { message: 'The build stayed over the budget line.' }, ['pad']),
      mission: mockMission('Earth Orbit', 'Over Budget Preview')
    },
    'fail-over-mass': {
      outcome: mockFailure('over_mass', { message: 'The build was heavier than the limit.' }, ['pad']),
      mission: mockMission('Earth Orbit', 'Over Mass Preview')
    },
    'event-recovered': {
      outcome: (function () {
        var o = mockLaunch(['pad', 'ascent', 'orbit']);
        o.events = [{
          type: 'telemetry_gap', recovered: true, time: 1.5,
          detail: 'The signal came back on its own.'
        }];
        return o;
      })(),
      mission: mockMission('Earth Orbit', 'Recovered Event Preview')
    },
    'approach-moon': { outcome: mockLaunch(['approach']), mission: mockMission('Moon', 'Lunar Approach Preview') },
    'approach-mars': { outcome: mockLaunch(['approach']), mission: mockMission('Mars', 'Mars Approach Preview') },
    'approach-saturn': { outcome: mockLaunch(['approach']), mission: mockMission('Saturn', 'Saturn Approach Preview') },
    'landing': { outcome: mockLaunch(['landing']), mission: mockMission('Moon', 'Landing Preview') },
    'crew-exit': { outcome: mockLaunch(['landing', 'crew_deploy']), mission: mockMission('Moon', 'Crew Exit Preview') },
    'rover-deploy': { outcome: mockLaunch(['landing', 'rover_deploy']), mission: mockMission('Moon', 'Rover Deploy Preview') },
    'rover-drive': { outcome: mockLaunch(['surface_drive']), mission: mockMission('Moon', 'Rover Drive Preview') },
    'image-capture': { outcome: mockLaunch(['image_capture']), mission: mockMission('Mars', 'Image Capture Preview') },
    'data-uplink': { outcome: mockLaunch(['data_uplink']), mission: mockMission('Mars', 'Data Uplink Preview') },
    'skip-replay': {
      outcome: mockLaunch(['pad', 'ascent', 'stage', 'coast', 'orbit']),
      mission: mockMission('Earth Orbit', 'Skip + Replay Preview')
    }
  };

  if (/[?&]visualPreview=1(&|$)/.test(String(window.location && window.location.search || ''))) {
    try { document.documentElement.classList.add('smg-preview-mode'); } catch (e) { /* older browsers */ }
    var bootPreview = function () {
      var host = document.getElementById('scene');
      if (host) init(host);
    };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootPreview);
      } else {
        bootPreview();
      }
  }

  return { init: init, showPad: showPad, playLaunch: playLaunch, skip: skip };
})();
