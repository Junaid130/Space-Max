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
//   * GSAP may or may not be present: the animation system is one internal RAF
//     loop + an internal tween helper; `HAS_GSAP` only routes inline DOM opacity
//     work to gsap when it exists, and those paths are token-guarded too.
//   * r128-only colour API: outputEncoding / texture.encoding = sRGBEncoding,
//     ACESFilmicToneMapping, PCFSoftShadowMap. Never outputColorSpace /
//     texture.colorSpace / useLegacyLights.
//   * Filenames in 3dmodels/ contain spaces + parentheses -> encodeURI() always.
//
// Preview Lab (?visualPreview=1): dev-only panel with a button per clip; clips
// run on isolated PREVIEW_MOCKS below and never call the simulator.
// ---------------------------------------------------------------------------

window.SMG = window.SMG || {};

SMG.scene = (function () {
  'use strict';

  // --- Constants & asset manifest ------------------------------------------
  // Internal map only; nothing is attached to window beyond SMG.scene.
  var ASSETS = {
    textures: {
      earthMap: '3dmodels/images.jpeg',       // 318x159  -- 2:1  Earth colour map
      saturnMap: '3dmodels/saturn.jpeg',      // 738x369  -- 2:1  Saturn band map
      moonPhoto: '3dmodels/moon.jpeg',        // 679x452  -- 3:2  surface PHOTO
      marsPhoto: '3dmodels/mars.jpeg'         // 679x452  -- 3:2  surface PHOTO
    },
    models: {
      landerLM: '3dmodels/Apollo Lunar Module.glb',
      station: '3dmodels/Gateway Core.glb',
      satTDRS: '3dmodels/Tracking and Data Relay Satellites (TDRS) (A).glb',
      satCubeSat: '3dmodels/CubeSat - ICECube.glb'
      // Rocket GLBs (Atlas_V_401.glb / Saturn V.glb) are deliberately not used
      // for the player vehicle: nozzle count must respond to `build` and stage
      // separation needs a detachable segment, so the pad rocket is built from
      // primitives. They can be adopted later through instanceModel() if the
      // team wants them as cutscene props.
    },
    pending: {
      // Not in the repo yet -- primitive fallback + console.warn until they land.
      roverMars: '3dmodels/Mars_Rover.glb',
      roverMoon: '3dmodels/Lunar_Rover.glb',
      astronaut: '3dmodels/Astronaut.glb'
    },
    missingNow: ['3dmodels/Mars_Rover.glb', '3dmodels/Lunar_Rover.glb', '3dmodels/Astronaut.glb']
  };

  var TOTAL_LAUNCH = 10.0;        // seconds of mission playback (8-12 contract)
  var COUNTDOWN_DUR = 2.6;        // readable 3-2-1 window
  var NOZZLE_CAP = 7;             // visual cap only -- never written to `build`
  var PAD_Y = 2.2;                // top of the launch deck (world units)
  var PREVIEW_TIME_SCALE = 0.75;  // preview timing != mission timing (slower)

  // Preview clip list -- exact data-clip values from the contract.
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
  var elapsedWall = 0;           // absolute clock for idle drift (no allocation)

  var dom = null;                // overlay element refs (created once)
  var preview = null;            // preview lab refs (created only when enabled)
  var previewEnabled = false;
  var previewCurrentClip = null;
  var pendingPreviewRun = null;  // consumed by the next playLaunch() call

  var world = {};                // shared idle-world resources (never disposed per run)
  var rocket = {};               // rocket rig (shared)
  var surface = {};              // surface set (shared, hidden by default)
  var effects = {};              // particle pools / packets / flash (shared)
  var textures = {};             // loaded textures (shared)
  var gltfTemplates = {};        // normalized GLB templates (shared)

  var tweens = [];               // internal tween list (one central system)
  var inlineEls = [];            // elements with inline opacity owned by us
  var runToken = 0;              // increments per run -- cancellation guard
  var activeRun = null;
  var finishing = false;         // re-entrancy guard for finishRun()
  var idleActive = false;
  var cameraBlend = null;        // {t, dur, x,y,z,tx,ty,tz} eased return to drift
  var assetIssues = [];          // de-duplicated asset fallback messages
  var assetIssueSeen = {};

  // Scratch objects -- reused every frame, zero per-frame allocation.
  var scratchR = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, lookAt: null };
  var scratchC = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0 };
  var scratchDrift = { x: 0, y: 0, z: 0 };
  var camTX = 0, camTY = 7, camTZ = 0;   // last camera target (for blends)

  // --- Small utilities ------------------------------------------------------
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clamp01(v) { return clamp(v, 0, 1); }
  function lerp(a, b, u) { return a + (b - a) * u; }
  function easeSoft(u) { u = clamp01(u); return lerp(u, u * u * (3 - 2 * u), 0.7); }
  function easeOutCubic(u) { u = clamp01(u); var k = 1 - u; return 1 - k * k * k; }
  function easeInQuad(u) { u = clamp01(u); return u * u; }
  function easeInOut(u) {
    u = clamp01(u);
    return u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);
  }
  // Cheap deterministic wobble for flame flicker (range approx [-1, 1]).
  function wobble(x) {
    return Math.sin(x) * 0.55 + Math.sin(x * 2.13 + 1.7) * 0.3 + Math.sin(x * 4.7 + 0.4) * 0.15;
  }
  function fmtNum(v) {
    if (!isNum(v)) return '';
    var r = Math.round(v * 100) / 100;
    return String(r);
  }
  function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : ''; }
  function humanizeType(t) {
    return String(t || '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
  }
  function encodePath(p) {
    try { return encodeURI(p); } catch (e) { return p; }
  }

  // --- Tween / timeline helper (one central RAF-driven system) --------------
  // tween({from,to,dur,delay,ease,onUpdate,onComplete,token}) -> handle
  // Every tween can be killed in one place; token-bound tweens die with their run.
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

  // Inline opacity helper. Uses gsap when a UMD build is present, otherwise the
  // internal tween -- either way the element is tracked so skip()/finish can
  // kill it and clear the inline value (class toggling stays authoritative).
  function currentOpacity(el) {
    var v = parseFloat(window.getComputedStyle ? window.getComputedStyle(el).opacity : '1');
    return isNum(v) ? v : 1;
  }
  function trackInline(el) {
    if (inlineEls.indexOf(el) === -1) inlineEls.push(el);
  }
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
          onComplete: function () {
            if (token !== null && token !== runToken) { done(); return; }
            done();
          }
        });
        return;
      } catch (e) { /* fall through to internal tween */ }
    }
    var from = currentOpacity(el);
    addTween({
      from: from, to: to, dur: dur, token: token,
      onUpdate: function (v) { el.style.opacity = String(v); },
      onComplete: done
    });
  }
  // Two gentle pulses then clear -- never a strobe (kid-safe).
  function pulseInline(el, token, dur) {
    if (!el || reducedMotion) return;
    dur = dur || 1.4;
    fadeInline(el, 0.55, dur / 2, token, function () {
      fadeInline(el, 1, dur / 2, token, null);
    });
  }

  // --- DOM overlay ----------------------------------------------------------
  // Created exactly once inside init(); class names are the shared contract
  // with css/style.css -- do not invent extras.
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

    // If the surface photo fails to load, say so once instead of showing a
    // broken image box.
    if (dom.image) {
      dom.image.addEventListener('error', function () {
        noteAssetIssue('Surface photo unavailable: ' + ASSETS.textures.marsPhoto +
          ' (image card hidden)');
        if (dom.imageCard) dom.imageCard.classList.remove('is-visible');
      });
    }
  }

  function showCountdown(text) {
    if (!dom || !dom.countdown) return;
    if (dom.countdown.textContent !== text) dom.countdown.textContent = text;
    // Restart the CSS animation by toggling the class through a reflow.
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
  // kind: 'failure' | 'warning' | '' -- parts are omitted when absent.
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
  function showUplink() {
    if (dom && dom.uplink) dom.uplink.classList.add('is-visible');
  }
  function hideUplink() {
    if (dom && dom.uplink) dom.uplink.classList.remove('is-visible');
  }
  function showError(msg) {
    if (!dom || !dom.error) return;
    dom.error.textContent = msg || '';
    if (msg) dom.error.removeAttribute('hidden');
    else dom.error.setAttribute('hidden', '');
  }
  // Transient cues only -- the failure alert and the image card survive until
  // the next run / showPad() so they stay readable.
  function clearTransientOverlays() {
    hideCountdown();
    hideCard();
    hideUplink();
  }
  function clearAllOverlays() {
    clearTransientOverlays();
    hideAlert();
    hideImageCard();
  }

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
      renderer.outputEncoding = THREE.sRGBEncoding;              // r128 name
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070f);

    camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.5, 6000);
    camera.position.set(21, 12, 31);
    camera.lookAt(0, 7, 0);
    scene.add(camera);   // required so camera-attached flash plane renders

    createLights();
    makeStarfield();
    createPlanets();
    createPad();
    createSurface();
    createEffects();
    buildRocket();
  }

  function createLights() {
    world.ambient = new THREE.AmbientLight(0x2b3a5e, 0.65);
    scene.add(world.ambient);

    world.key = new THREE.DirectionalLight(0xfff1dc, 1.25);   // "sun"
    world.key.position.set(520, 820, 330);
    world.key.castShadow = true;
    world.key.shadow.mapSize.set(1024, 1024);
    world.key.shadow.camera.near = 100;
    world.key.shadow.camera.far = 1600;
    world.key.shadow.camera.left = -70;
    world.key.shadow.camera.right = 70;
    world.key.shadow.camera.top = 70;
    world.key.shadow.camera.bottom = -70;
    world.key.shadow.bias = -0.0006;
    scene.add(world.key);
    scene.add(world.key.target);
    world.key.target.position.set(0, 0, 0);

    world.fill = new THREE.DirectionalLight(0x8fb2ff, 0.38);   // cool fill
    world.fill.position.set(-420, 180, -260);
    scene.add(world.fill);

    world.rim = new THREE.DirectionalLight(0x66d0ff, 0.32);    // rim from behind
    world.rim.position.set(140, -160, -520);
    scene.add(world.rim);
  }

  function makeStarfield() {
    var count = reducedMotion ? 700 : 1100;
    var positions = new Float32Array(count * 3);
    var colors = new Float32Array(count * 3);
    for (var i = 0; i < count; i++) {
      // Uniform-ish sphere shell, biased away from the ground plane.
      var u = Math.random() * 2 - 1;
      var theta = Math.random() * Math.PI * 2;
      var r = 2400 + Math.random() * 2200;
      var s = Math.sqrt(1 - u * u);
      positions[i * 3] = Math.cos(theta) * s * r;
      positions[i * 3 + 1] = u * r * 0.75 + 400;
      positions[i * 3 + 2] = Math.sin(theta) * s * r;
      var tint = 0.72 + Math.random() * 0.28;
      colors[i * 3] = tint;
      colors[i * 3 + 1] = tint;
      colors[i * 3 + 2] = Math.min(1, tint + 0.08);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    var mat = new THREE.PointsMaterial({
      size: 3.4, sizeAttenuation: true, vertexColors: true,
      transparent: true, opacity: 0.9, depthWrite: false
    });
    world.stars = new THREE.Points(geo, mat);
    world.stars.frustumCulled = false;
    scene.add(world.stars);
  }

  // Procedural helpers -- always available so no sphere is ever black/blank.
  function makeBandTexture() {
    var c = document.createElement('canvas');
    c.width = 64; c.height = 128;
    var ctx = c.getContext('2d');
    var bands = ['#e6cf9a', '#d8b877', '#c9a465', '#efdcb0', '#cfa870', '#e2c78e', '#d3ad6b'];
    var y = 0;
    while (y < 128) {
      var h = 6 + Math.floor(Math.random() * 14);
      ctx.fillStyle = bands[Math.floor(Math.random() * bands.length)];
      ctx.fillRect(0, y, 64, h);
      y += h;
    }
    // soft polar shading
    var g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, 'rgba(255,255,255,0.16)');
    g.addColorStop(0.5, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.2)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 128);
    var tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  function makeMottleTexture(hexA, hexB, blobs) {
    var c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    var ctx = c.getContext('2d');
    ctx.fillStyle = hexA;
    ctx.fillRect(0, 0, 128, 64);
    for (var i = 0; i < blobs; i++) {
      ctx.globalAlpha = 0.12 + Math.random() * 0.2;
      ctx.fillStyle = Math.random() < 0.5 ? hexB : '#ffffff';
      var r = 3 + Math.random() * 12;
      ctx.beginPath();
      ctx.arc(Math.random() * 128, Math.random() * 64, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    var tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  function createPlanets() {
    // Static anchors: no spin, no orbit, no bounce. Only the camera moves.
    // Positions are chosen so Earth/Moon/Mars read from the pad AND the orbit
    // shot, and Mars reads from the surface sequences.
    world.planets = {};

    // Earth -- images.jpeg (2:1) as sphere colour map, procedural blue fallback.
    var earthGeo = new THREE.SphereGeometry(400, 48, 32);
    var earthMat = new THREE.MeshStandardMaterial({
      color: 0x2f66b5, roughness: 0.92, metalness: 0.0
    });
    world.earth = new THREE.Mesh(earthGeo, earthMat);
    world.earth.position.set(-500, 430, -1450);
    scene.add(world.earth);
    world.planets.earth = { mesh: world.earth, pos: world.earth.position, r: 400 };

    // Restrained atmospheric rim glow (additive shell, back faces only).
    var glowGeo = new THREE.SphereGeometry(416, 40, 26);
    var glowMat = new THREE.MeshBasicMaterial({
      color: 0x6fb0ff, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false
    });
    world.earthGlow = new THREE.Mesh(glowGeo, glowMat);
    world.earthGlow.position.copy(world.earth.position);
    scene.add(world.earthGlow);

    // Moon -- procedural cool grey (moon.jpeg is a 3:2 PHOTO, never a sphere map).
    var moonMat = new THREE.MeshStandardMaterial({
      color: 0x9aa0a8, roughness: 1.0, metalness: 0.0,
      map: makeMottleTexture('#9aa0a8', '#7d838c', 40)
    });
    world.moon = new THREE.Mesh(new THREE.SphereGeometry(60, 36, 24), moonMat);
    world.moon.position.set(-1050, 640, -1700);
    scene.add(world.moon);
    world.planets.moon = { mesh: world.moon, pos: world.moon.position, r: 60 };

    // Mars -- procedural rust (mars.jpeg is a 3:2 PHOTO, used on cards/ground).
    var marsMat = new THREE.MeshStandardMaterial({
      color: 0xb4552f, roughness: 1.0, metalness: 0.0,
      map: makeMottleTexture('#b4552f', '#8e3f22', 46)
    });
    world.mars = new THREE.Mesh(new THREE.SphereGeometry(92, 40, 26), marsMat);
    world.mars.position.set(-960, 560, -1150);
    scene.add(world.mars);
    world.planets.mars = { mesh: world.mars, pos: world.mars.position, r: 92 };

    // Saturn -- saturn.jpeg (2:1 band map) with procedural band fallback + ring.
    var saturnMat = new THREE.MeshStandardMaterial({
      color: 0xd9b877, roughness: 0.95, metalness: 0.0
    });
    world.saturn = new THREE.Mesh(new THREE.SphereGeometry(120, 44, 28), saturnMat);
    world.saturn.position.set(760, 620, -1650);
    world.saturn.rotation.z = 0.47;   // fixed axial tilt, never animated
    scene.add(world.saturn);
    world.planets.saturn = { mesh: world.saturn, pos: world.saturn.position, r: 120 };
    world.saturnMat = saturnMat;
    world.saturnBands = makeBandTexture();
    saturnMat.map = world.saturnBands;
    saturnMat.needsUpdate = true;

    var ringGeo = new THREE.RingGeometry(150, 240, 64, 1);
    // Remap ring UVs so a band texture reads across the radius.
    var pos = ringGeo.attributes.position;
    var uv = ringGeo.attributes.uv;
    var v3 = new THREE.Vector3();
    for (var i = 0; i < pos.count; i++) {
      v3.fromBufferAttribute(pos, i);
      var d = (v3.length() - 150) / 90;
      uv.setXY(i, clamp01(d), 0.5);
    }
    var ringMat = new THREE.MeshStandardMaterial({
      color: 0xd9c294, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide,
      transparent: true, opacity: 0.72, map: world.saturnBands
    });
    world.saturnRing = new THREE.Mesh(ringGeo, ringMat);
    world.saturnRing.position.copy(world.saturn.position);
    world.saturnRing.rotation.x = Math.PI / 2 - 0.47;
    scene.add(world.saturnRing);
  }

  function createPad() {
    var g = new THREE.Group();
    world.padGroup = g;
    scene.add(g);

    // Local ground disc (surface photos are never used here -- this is a disc,
    // so a procedural colour is honest and cheap).
    var groundMat = new THREE.MeshStandardMaterial({ color: 0x3d4350, roughness: 1.0 });
    world.ground = new THREE.Mesh(new THREE.CircleGeometry(160, 48), groundMat);
    world.ground.rotation.x = -Math.PI / 2;
    world.ground.position.y = -0.02;
    world.ground.receiveShadow = true;
    g.add(world.ground);

    // Launch deck
    var deckMat = new THREE.MeshStandardMaterial({ color: 0x8f97a6, roughness: 0.75, metalness: 0.25 });
    world.deck = new THREE.Mesh(new THREE.CylinderGeometry(9, 10, PAD_Y, 28), deckMat);
    world.deck.position.y = PAD_Y / 2;
    world.deck.receiveShadow = true;
    world.deck.castShadow = true;
    g.add(world.deck);

    // Flame trench hint
    var trench = new THREE.Mesh(
      new THREE.BoxGeometry(7, PAD_Y * 0.6, 20),
      new THREE.MeshStandardMaterial({ color: 0x272b33, roughness: 1.0 })
    );
    trench.position.set(0, PAD_Y * 0.3, 14);
    g.add(trench);

    // Service tower
    var towerMat = new THREE.MeshStandardMaterial({ color: 0x5b6472, roughness: 0.7, metalness: 0.4 });
    var tower = new THREE.Group();
    var mast = new THREE.Mesh(new THREE.BoxGeometry(1.4, 30, 1.4), towerMat);
    mast.position.y = 15;
    mast.castShadow = true;
    tower.add(mast);
    for (var i = 1; i <= 4; i++) {
      var arm = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.5, 0.5), towerMat);
      arm.position.set(3.4, 4 + i * 5.4, 0);
      tower.add(arm);
    }
    tower.position.set(-11, 0, -2);
    g.add(tower);
    world.tower = tower;

    // Pad lights -- emissive bulbs (no extra realtime lights).
    world.padLightMat = new THREE.MeshStandardMaterial({
      color: 0x22262e, emissive: 0xffd98a, emissiveIntensity: 1.1, roughness: 0.6
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

    // A few static rocks for ground readability.
    var rockMat = new THREE.MeshStandardMaterial({ color: 0x4a505c, roughness: 1.0 });
    for (var r = 0; r < 10; r++) {
      var rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1 + Math.random() * 2.4, 0), rockMat);
      var ang = Math.random() * Math.PI * 2;
      var rad = 34 + Math.random() * 90;
      rock.position.set(Math.cos(ang) * rad, 0.4, Math.sin(ang) * rad);
      rock.rotation.set(Math.random(), Math.random(), Math.random());
      rock.receiveShadow = true;
      g.add(rock);
    }
  }

  // --- Assets ---------------------------------------------------------------
  function loadTexture(key, path, onReady) {
    if (!THREEOK || !scene) return;
    try {
      var loader = new THREE.TextureLoader();
      loader.load(encodePath(path), function (tex) {
        tex.encoding = THREE.sRGBEncoding;              // r128 colour maps
        if (renderer) {
          tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        }
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

  // Every GLB goes through a wrapper Group: measure, scale to target size,
  // re-center the pivot, park the base at y=0 when asked. Templates are cached
  // once and instanced with .clone() (materials shared -> never disposed here).
  function normalizeObject(obj, targetSize, baseAtZero) {
    var wrap = new THREE.Group();
    var box = new THREE.Box3().setFromObject(obj);
    var size = new THREE.Vector3();
    box.getSize(size);
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

  function loadModel(key, path, targetSize, baseAtZero, onReady) {
    if (!THREEOK) return;
    if (!hasGLTF) {
      noteAssetIssue('THREE.GLTFLoader not loaded -- built-in fallback used for ' + path);
      return;
    }
    try {
      new THREE.GLTFLoader().load(encodePath(path), function (gltf) {
        try {
          gltfTemplates[key] = normalizeObject(gltf.scene, targetSize, !!baseAtZero);
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

  // Clone a cached template into a fresh wrapper, or return null (caller
  // builds the primitive fallback + warns).
  function instanceModel(key, targetSize, baseAtZero) {
    var tpl = gltfTemplates[key];
    if (!tpl) return null;
    var clone = tpl.clone(true);
    return normalizeObject(clone, targetSize, !!baseAtZero);
  }

  function loadAssets() {
    loadTexture('earthMap', ASSETS.textures.earthMap, function (tex) {
      if (world.earth && world.earth.material) {
        world.earth.material.map = tex;
        world.earth.material.color.set(0xffffff);
        world.earth.material.needsUpdate = true;
      }
    });
    loadTexture('saturnMap', ASSETS.textures.saturnMap, function (tex) {
      if (world.saturnMat) {
        world.saturnMat.map = tex;
        world.saturnMat.color.set(0xffffff);
        world.saturnMat.needsUpdate = true;
      }
    });
    loadTexture('marsPhoto', ASSETS.textures.marsPhoto, function (tex) {
      if (surface.marsMat) {
        surface.marsMat.map = tex;
        surface.marsMat.color.set(0xffffff);
        surface.marsMat.needsUpdate = true;
      }
    });
    loadTexture('moonPhoto', ASSETS.textures.moonPhoto, function (tex) {
      if (surface.moonMat) {
        surface.moonMat.map = tex;
        surface.moonMat.color.set(0xffffff);
        surface.moonMat.needsUpdate = true;
      }
    });

    loadModel('landerLM', ASSETS.models.landerLM, 3.4, true, null);
    loadModel('station', ASSETS.models.station, 16, false, null);
    loadModel('satTDRS', ASSETS.models.satTDRS, 7, false, null);
    loadModel('satCubeSat', ASSETS.models.satCubeSat, 1.6, false, null);

    // Assets the repo does not ship yet -- say so once, keep playing.
    for (var i = 0; i < ASSETS.missingNow.length; i++) {
      noteAssetIssue('Asset not in repo yet: ' + ASSETS.missingNow[i] + ' (primitive fallback in use)');
    }
  }

  // --- Rocket ----------------------------------------------------------------
  // One shared rig. showPad() only toggles nozzle visibility / fuel fill, so
  // slider changes never rebuild geometry.
  function buildRocket() {
    var g = new THREE.Group();
    g.position.set(0, PAD_Y, 0);
    rocket.group = g;
    scene.add(g);

    rocket.matBody = new THREE.MeshStandardMaterial({ color: 0xf1f4f9, roughness: 0.42, metalness: 0.18 });
    rocket.matDark = new THREE.MeshStandardMaterial({ color: 0x2c333f, roughness: 0.55, metalness: 0.55 });
    rocket.matAccent = new THREE.MeshStandardMaterial({ color: 0xe2574c, roughness: 0.5, metalness: 0.1 });
    rocket.matNozzle = new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.35, metalness: 0.85 });
    rocket.matWindow = new THREE.MeshStandardMaterial({
      color: 0x9fd8ff, emissive: 0x2a5f8f, emissiveIntensity: 0.9,
      roughness: 0.2, metalness: 0.1
    });
    rocket.matFuelFill = new THREE.MeshBasicMaterial({
      color: 0x49d8ff, transparent: true, opacity: 0.85, depthWrite: false
    });

    // --- lower stage (first stage: body, fins, engines, its own flame) ---
    var lower = new THREE.Group();
    rocket.lower = lower;
    g.add(lower);

    var lowerBody = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 5.2, 26), rocket.matBody);
    lowerBody.position.y = 2.9;
    lowerBody.castShadow = true;
    lower.add(lowerBody);

    var stripe = new THREE.Mesh(new THREE.CylinderGeometry(1.52, 1.52, 0.55, 26), rocket.matAccent);
    stripe.position.y = 4.6;
    lower.add(stripe);

    var skirt = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.32, 0.8, 26), rocket.matDark);
    skirt.position.y = 0.55;
    lower.add(skirt);

    // three fins (shared geometry, instanced)
    var finGeo = new THREE.BoxGeometry(0.18, 1.9, 1.6);
    for (var f = 0; f < 3; f++) {
      var fin = new THREE.Mesh(finGeo, rocket.matAccent);
      var ang = (f / 3) * Math.PI * 2;
      fin.position.set(Math.cos(ang) * 1.62, 1.3, Math.sin(ang) * 1.62);
      fin.rotation.y = -ang;
      fin.castShadow = true;
      lower.add(fin);
    }

    // nozzles: pre-created up to NOZZLE_CAP, only visibility/position changes
    rocket.nozzles = [];
    var nozzleGeo = new THREE.ConeGeometry(0.4, 0.95, 14);
    nozzleGeo.rotateX(Math.PI);   // bell opens downward
    for (var n = 0; n < NOZZLE_CAP; n++) {
      var noz = new THREE.Mesh(nozzleGeo, rocket.matNozzle);
      noz.position.y = 0.1;
      noz.visible = false;
      lower.add(noz);
      rocket.nozzles.push(noz);
    }

    // fuel presentation panels (fill height only -- value comes from `build`)
    rocket.fuelFills = [];
    for (var p = 0; p < 2; p++) {
      var panel = new THREE.Group();
      var frame = new THREE.Mesh(new THREE.BoxGeometry(0.56, 2.3, 0.1), rocket.matDark);
      panel.add(frame);
      var fillGeo = new THREE.PlaneGeometry(0.4, 1.9);
      fillGeo.translate(0, 0.95, 0);          // pivot at the tank bottom
      var fill = new THREE.Mesh(fillGeo, rocket.matFuelFill);
      fill.position.z = 0.07;
      fill.scale.y = 0.001;
      panel.add(fill);
      panel.position.set(0, 3.1, 1.53);
      if (p === 1) panel.rotation.y = Math.PI;
      lower.add(panel);
      rocket.fuelFills.push(fill);
    }

    // first-stage flame (child of lower: it leaves with the stage)
    rocket.flameLower = makeFlame(0.78, 4.0);
    rocket.flameLower.group.position.y = -0.35;
    lower.add(rocket.flameLower.group);

    // --- upper stage (second stage + payload bay + nose) ---
    var upper = new THREE.Group();
    rocket.upper = upper;
    g.add(upper);

    var interstage = new THREE.Mesh(new THREE.CylinderGeometry(1.56, 1.56, 0.34, 26), rocket.matDark);
    interstage.position.y = 5.55;
    upper.add(interstage);

    var upperBody = new THREE.Mesh(new THREE.CylinderGeometry(1.44, 1.5, 3.6, 26), rocket.matBody);
    upperBody.position.y = 7.5;
    upperBody.castShadow = true;
    upper.add(upperBody);

    var windowStrip = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.34, 0.12), rocket.matWindow);
    windowStrip.position.set(0, 8.3, 1.44);
    upper.add(windowStrip);

    var nose = new THREE.Mesh(new THREE.ConeGeometry(1.44, 2.3, 26), rocket.matBody);
    nose.position.y = 10.55;
    nose.castShadow = true;
    upper.add(nose);

    var tip = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.7, 12), rocket.matAccent);
    tip.position.y = 12.0;
    upper.add(tip);

    // second-stage engine bell at the interstage (ignites after separation)
    var secondNozzle = new THREE.Mesh(nozzleGeo, rocket.matNozzle);
    secondNozzle.position.y = 5.4;
    secondNozzle.scale.setScalar(0.85);
    upper.add(secondNozzle);
    rocket.secondNozzle = secondNozzle;

    rocket.flameUpper = makeFlame(0.6, 3.2);
    rocket.flameUpper.group.position.y = 5.1;
    rocket.flameUpper.group.visible = false;
    upper.add(rocket.flameUpper.group);

    // payload (hidden until a deploy phase calls for it)
    rocket.payload = makePayload();
    rocket.payload.group.position.set(0, 7.5, 0);
    rocket.payload.group.visible = false;
    upper.add(rocket.payload.group);

    // warning beacon (sensor_fault) -- gentle amber blink, never strobing
    rocket.beaconMat = new THREE.MeshStandardMaterial({
      color: 0x332211, emissive: 0xffb347, emissiveIntensity: 0.0, roughness: 0.5
    });
    rocket.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), rocket.beaconMat);
    rocket.beacon.position.set(0, 9.6, 1.4);
    upper.add(rocket.beacon);

    // craft light + engine light (power_short dims these)
    rocket.craftLight = new THREE.PointLight(0xbfe0ff, 0.55, 46, 2);
    rocket.craftLight.position.set(0, 7, 3);
    g.add(rocket.craftLight);
    rocket.engineLight = new THREE.PointLight(0xffa44d, 0, 60, 2);
    rocket.engineLight.position.set(0, 0.4, 0);
    g.add(rocket.engineLight);

    // Shared base pose bookkeeping
    rocket.fuelRatio = null;
    rocket.engineCount = 1;
    rocket.lowerFaded = false;
    rocket.payloadDeployed = false;
  }

  function makeFlame(radius, len) {
    var group = new THREE.Group();
    var outerGeo = new THREE.ConeGeometry(radius, len, 14, 1, true);
    outerGeo.translate(0, -len / 2, 0);        // pivot at the nozzle, tip down
    var outer = new THREE.Mesh(outerGeo, new THREE.MeshBasicMaterial({
      color: 0xff8a2a, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    }));
    var innerGeo = new THREE.ConeGeometry(radius * 0.55, len * 0.7, 12, 1, true);
    innerGeo.translate(0, -len * 0.35, 0);
    var inner = new THREE.Mesh(innerGeo, new THREE.MeshBasicMaterial({
      color: 0xfff3c4, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    }));
    outer.frustumCulled = false;
    inner.frustumCulled = false;
    group.add(outer);
    group.add(inner);
    group.visible = false;
    return { group: group, outer: outer, inner: inner, len: len, radius: radius, level: 0 };
  }

  function makePayload() {
    // Prefer the CubeSat GLB; fall back to a readable primitive satellite.
    var group = new THREE.Group();
    var inner = instanceModel('satCubeSat', 1.6, false);
    if (inner) {
      group.add(inner);
      group.userData.kind = 'gltf';
    } else {
      var bodyMat = new THREE.MeshStandardMaterial({ color: 0xdfe4ec, roughness: 0.5, metalness: 0.4 });
      var panelMat = new THREE.MeshStandardMaterial({
        color: 0x1f3d8f, emissive: 0x0a1a44, emissiveIntensity: 0.5,
        roughness: 0.35, metalness: 0.3
      });
      var body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), bodyMat);
      group.add(body);
      for (var s = -1; s <= 1; s += 2) {
        var panel = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 0.8), panelMat);
        // folded against the body; unfolds when a deploy phase fires
        panel.position.set(s * 0.5, 0, 0);
        panel.rotation.z = s * 1.3;
        panel.userData.isPanel = true;
        panel.userData.side = s;
        group.add(panel);
      }
      group.userData.kind = 'primitive';
      group.userData.panels = true;
    }
    group.visible = false;
    return { group: group };
  }

  // Engine/nozzle count from `build` -- read-only, visual cap only.
  function readEngineCount(build) {
    var candidates = [build.engines, build.engineCount, build.nozzles];
    for (var i = 0; i < candidates.length; i++) {
      if (isNum(candidates[i]) && candidates[i] > 0) {
        return clamp(Math.round(candidates[i]), 1, NOZZLE_CAP);
      }
    }
    return 1;   // neutral default rocket
  }

  // Fuel presentation: fill height only, derived for display. Never written
  // back to `build`, never shown as a number (units are the builder's business).
  function readFuelRatio(build) {
    if (isNum(build.fuelPct)) return clamp01(build.fuelPct / 100);
    if (isNum(build.fuel)) {
      if (build.fuel >= 0 && build.fuel <= 1) return clamp01(build.fuel);
      if (build.fuel > 1 && build.fuel <= 100) return clamp01(build.fuel / 100);
      return null;   // present but unitless/unknown -> neutral tanks
    }
    if (isNum(build.fuelLevel)) return clamp01(build.fuelLevel);
    return null;
  }

  function updateNozzles(count) {
    rocket.engineCount = count;
    var ringR = count === 1 ? 0 : (count <= 4 ? 0.62 : 0.78);
    for (var i = 0; i < rocket.nozzles.length; i++) {
      var noz = rocket.nozzles[i];
      if (i < count) {
        noz.visible = true;
        if (count === 1) {
          noz.position.x = 0; noz.position.z = 0;
        } else if (count === NOZZLE_CAP && i === NOZZLE_CAP - 1) {
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
    for (var i = 0; i < rocket.fuelFills.length; i++) {
      rocket.fuelFills[i].scale.y = y;
    }
    // Neutral (unknown) tanks: grey instead of cyan so "no data" reads clearly.
    rocket.matFuelFill.color.setHex(ratio === null ? 0x8b93a1 : 0x49d8ff);
    rocket.matFuelFill.opacity = ratio === null ? 0.4 : 0.85;
  }

  // --- Flame / stage state ---------------------------------------------------
  function setFlame(level) {
    if (!rocket.flameLower) return;
    level = clamp01(level);
    applyFlame(rocket.flameLower, level, 1.0);
    applyFlame(rocket.flameUpper, rocket.upperFlameLevel || 0, 0.82);
    if (rocket.engineLight) rocket.engineLight.intensity = level * 2.6;
  }
  function applyFlame(f, level, widthScale) {
    if (!f) return;
    f.level = level;
    if (level <= 0.015) { f.group.visible = false; return; }
    f.group.visible = true;
    var w = widthScale * (0.72 + level * 0.4);
    f.group.scale.set(w, level, w);
    f.outer.material.opacity = 0.35 + level * 0.4;
    f.inner.material.opacity = 0.45 + level * 0.45;
  }

  function resetRocketVisual() {
    if (!rocket.group) return;
    rocket.group.visible = true;
    rocket.group.position.set(0, PAD_Y, 0);
    rocket.group.rotation.set(0, 0, 0);
    rocket.upperFlameLevel = 0;
    setFlame(0);
    rocket.beaconMat.emissiveIntensity = 0;
    if (rocket.craftLight) rocket.craftLight.intensity = 0.55;
    if (rocket.payload && rocket.payload.group) {
      rocket.payload.group.visible = false;
      rocket.payload.group.position.set(0, 7.5, 0);
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
    restoreLighting();
  }

  // Detached/faded first stage is restored in place (shared resources).
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
              mats[i].transparent = false;
              mats[i].opacity = 1;
              mats[i].needsUpdate = true;
            }
          }
        }
      });
      rocket.lowerFaded = false;
    }
    if (rocket.flameLower) rocket.flameLower.group.visible = false;
    if (rocket.flameUpper) rocket.flameUpper.group.visible = false;
  }

  // Make lower-stage materials fadeable without touching shared body materials
  // used elsewhere: clone once, flag them, restore via restoreLowerStage().
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
          if (mats[i].userData && mats[i].userData.__fadeOut && targets.indexOf(mats[i]) === -1) {
            targets.push(mats[i]);
          }
        }
      }
    });
    addTween({
      from: 1, to: 0, dur: dur, token: token, ease: easeInQuad,
      onUpdate: function (v) {
        for (var i = 0; i < targets.length; i++) targets[i].opacity = v;
      },
      onComplete: function () {
        rocket.lower.visible = false;
        for (var i = 0; i < targets.length; i++) targets[i].needsUpdate = true;
      }
    });
  }

  // --- Effects ---------------------------------------------------------------
  // Pooled particles: one BufferGeometry + custom shader per pool, spawned into
  // dead slots, integrated in place. No per-frame allocation, no post-processing
  // (emissive/additive materials carry the glow).
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
      vertexShader: POOL_VS,
      fragmentShader: POOL_FS,
      transparent: true,
      depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    var points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);

    var pool = {
      capacity: capacity,
      points: points,
      pos: positions,
      size: sizes,
      alpha: alphas,
      geo: geo,
      vx: new Float32Array(capacity),
      vy: new Float32Array(capacity),
      vz: new Float32Array(capacity),
      life: new Float32Array(capacity),
      maxLife: new Float32Array(capacity),
      base: new Float32Array(capacity),
      grow: new Float32Array(capacity),
      drag: new Float32Array(capacity),
      cursor: 0,
      dirty: false,
      spawn: function (x, y, z, vx, vy, vz, size, life, grow, drag) {
        var i = this.cursor;
        this.cursor = (this.cursor + 1) % this.capacity;
        this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
        this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
        this.life[i] = life; this.maxLife[i] = life;
        this.base[i] = size; this.grow[i] = grow || 0;
        this.drag[i] = drag === undefined ? 1.2 : drag;
        this.alpha[i] = 0;
        this.dirty = true;
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
          var fadeIn = Math.min(1, age * 6);
          this.alpha[i] = Math.min(fadeIn, k * 1.6);
          if (this.life[i] <= 0) this.alpha[i] = 0;
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
    return pool;
  }

  function createEffects() {
    var lowEnd = reducedMotion;
    effects.smoke = makePool(lowEnd ? 120 : 300, { color: 0xb9c0cc, opacity: 0.5, additive: false });
    effects.dust = makePool(lowEnd ? 90 : 220, { color: 0xc9a97e, opacity: 0.6, additive: false });
    effects.glow = makePool(lowEnd ? 50 : 120, { color: 0x9fe4ff, opacity: 0.9, additive: true });

    // Data packets: pre-made meshes reused every run (rover -> lander -> relay).
    effects.packets = [];
    var pGeo = new THREE.SphereGeometry(0.3, 8, 6);
    var pMat = new THREE.MeshBasicMaterial({
      color: 0x7ff0ff, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    for (var i = 0; i < 12; i++) {
      var m = new THREE.Mesh(pGeo, pMat);
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      effects.packets.push({ mesh: m, active: false, t: 0, dur: 1, from: null, to: null, arc: 0, onArrive: null });
    }

    // Shutter flash: a camera-attached quad (no DOM class invention, no strobe).
    var flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      depthTest: false, depthWrite: false
    });
    effects.flash = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), flashMat);
    effects.flash.position.set(0, 0, -1);
    effects.flash.renderOrder = 999;
    effects.flash.frustumCulled = false;
    effects.flash.visible = false;
    camera.add(effects.flash);

    // Capture reticle: a thin ring placed in the world at the point of interest.
    var retMat = new THREE.MeshBasicMaterial({
      color: 0x8ff3ff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });
    effects.reticle = new THREE.Mesh(new THREE.RingGeometry(0.8, 0.95, 32), retMat);
    effects.reticle.visible = false;
    effects.reticle.frustumCulled = false;
    scene.add(effects.reticle);

    effects.dustTargetY = -1;   // >=0 while a descent wants ground dust
  }

  function emitSmokeTrail(dt, level) {
    if (!rocket.flameLower || !rocket.group) return;
    var n = level > 0.6 ? 3 : 2;
    var count = Math.max(1, Math.round(n * dt * 60 * (reducedMotion ? 0.4 : 1)));
    if (count > 6) count = 6;
    var px = rocket.group.position.x;
    var pz = rocket.group.position.z;
    // emit from whichever engine is burning (upper bell after separation)
    var upperBurning = (rocket.upperFlameLevel || 0) > 0.1;
    var baseY = rocket.group.position.y + (upperBurning ? 5.0 : -0.4);
    for (var i = 0; i < count; i++) {
      effects.smoke.spawn(
        px + (Math.random() - 0.5) * 1.2,
        Math.max(baseY, PAD_Y * 0.4) + (Math.random() - 0.5) * 0.8,
        pz + (Math.random() - 0.5) * 1.2,
        (Math.random() - 0.5) * 2.4,
        -2.5 - Math.random() * 3 - (baseY > 8 ? 0 : 1.5),
        (Math.random() - 0.5) * 2.4,
        1.6 + Math.random() * 1.8,
        1.4 + Math.random() * 1.1,
        2.6,
        1.6
      );
    }
  }

  function emitDustBurst(x, y, z, strength) {
    if (!effects.dust) return;
    var n = Math.round(clamp(strength, 0, 1) * (reducedMotion ? 8 : 22));
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 3 + Math.random() * 7 * strength;
      effects.dust.spawn(
        x + Math.cos(a) * (0.6 + Math.random()),
        y + 0.25,
        z + Math.sin(a) * (0.6 + Math.random()),
        Math.cos(a) * sp,
        1 + Math.random() * 3 * strength,
        Math.sin(a) * sp,
        1.3 + Math.random() * 1.6,
        1.2 + Math.random() * 0.9,
        2.2,
        2.4
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
    updatePackets(dt);
    // Ground dust while a descent is close to the surface.
    if (effects.dustTargetY >= 0 && surface.lander) {
      var ly = surface.lander.position.y;
      if (ly < 9 && ly >= -0.5) {
        var strength = clamp01(1 - Math.max(0, ly) / 9);
        emitDustTrail(surface.lander.position.x, 0, surface.lander.position.z, dt, strength * 0.9);
      }
    }
  }

  function launchPacket(from, to, dur, arc, token, onArrive) {
    if (!effects.packets) return null;
    for (var i = 0; i < effects.packets.length; i++) {
      var p = effects.packets[i];
      if (p.active) continue;
      p.active = true;
      p.t = 0;
      p.dur = dur;
      p.from = { x: from.x, y: from.y, z: from.z };
      p.to = { x: to.x, y: to.y, z: to.z };
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
      var u = clamp01(p.t / p.dur);
      var e = easeInOut(u);
      var x = lerp(p.from.x, p.to.x, e);
      var y = lerp(p.from.y, p.to.y, e);
      var z = lerp(p.from.z, p.to.z, e);
      if (p.arc) y += Math.sin(u * Math.PI) * p.arc;
      p.mesh.position.set(x, y, z);
      var pulse = 0.8 + 0.35 * Math.sin(p.t * 14);
      p.mesh.scale.setScalar(pulse);
      if (u >= 1) {
        p.active = false;
        p.mesh.visible = false;
        var cb = p.onArrive;
        var tk = p.token;
        p.onArrive = null;
        // stale packets from a cancelled run never fire their continuation
        if (cb && (tk === null || tk === runToken)) cb();
      }
    }
  }

  function stopEffects() {
    if (effects.smoke) effects.smoke.clear();
    if (effects.dust) effects.dust.clear();
    if (effects.glow) effects.glow.clear();
    effects.dustTargetY = -1;
    if (effects.reticle) effects.reticle.visible = false;
    if (effects.flash) { effects.flash.visible = false; effects.flash.material.opacity = 0; }
    if (effects.packets) {
      for (var i = 0; i < effects.packets.length; i++) {
        effects.packets[i].active = false;
        effects.packets[i].onArrive = null;
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
          from: peak || 0.5, to: 0, dur: 0.2, token: token, ease: easeOutCubic,
          onUpdate: function (v) { f.material.opacity = v; },
          onComplete: function () { f.visible = false; f.material.opacity = 0; }
        });
      }
    });
  }

  function showReticle(pos, token) {
    if (!effects.reticle) return;
    var r = effects.reticle;
    r.position.set(pos.x, pos.y, pos.z);
    r.visible = true;
    r.material.opacity = 0.9;
    // Two gentle focus pulses (scale only -- never a flash).
    addTween({
      from: 1, to: 1.25, dur: 0.45, token: token, ease: easeInOut,
      onUpdate: function (v) { r.scale.setScalar(v); },
      onComplete: function () {
        addTween({
          from: 1.25, to: 1, dur: 0.45, token: token, ease: easeInOut,
          onUpdate: function (v) { r.scale.setScalar(v); },
          onComplete: function () {
            addTween({
              from: 1, to: 1.15, dur: 0.4, token: token, ease: easeInOut,
              onUpdate: function (v) { r.scale.setScalar(v); }
            });
          }
        });
      }
    });
  }

  // --- Surface set -----------------------------------------------------------
  // Built ONCE at init, hidden by default, reset (not rebuilt) between clips.
  function createSurface() {
    var g = new THREE.Group();
    g.visible = false;
    surface.group = g;
    scene.add(g);

    // Two ground discs (mars/moon photos ARE usable here -- flat disc UVs),
    // procedural colour until/if the photos load.
    surface.marsMat = new THREE.MeshStandardMaterial({ color: 0xa8532f, roughness: 1.0 });
    surface.moonMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 1.0 });
    var groundGeo = new THREE.CircleGeometry(160, 48);
    surface.marsGround = new THREE.Mesh(groundGeo, surface.marsMat);
    surface.marsGround.rotation.x = -Math.PI / 2;
    surface.marsGround.position.y = 0;
    surface.marsGround.receiveShadow = true;
    g.add(surface.marsGround);
    surface.moonGround = new THREE.Mesh(groundGeo, surface.moonMat);
    surface.moonGround.rotation.x = -Math.PI / 2;
    surface.moonGround.position.y = 0;
    surface.moonGround.receiveShadow = true;
    surface.moonGround.visible = false;
    g.add(surface.moonGround);

    // static dressing rocks
    var rockMat = new THREE.MeshStandardMaterial({ color: 0x6b5a4d, roughness: 1.0 });
    surface.rocks = [];
    for (var i = 0; i < 12; i++) {
      var rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.6 + Math.random() * 2.0, 0), rockMat);
      var ang = Math.random() * Math.PI * 2;
      var rad = 16 + Math.random() * 70;
      rock.position.set(Math.cos(ang) * rad, 0.3, Math.sin(ang) * rad);
      rock.rotation.set(Math.random(), Math.random(), Math.random());
      rock.castShadow = true;
      rock.receiveShadow = true;
      g.add(rock);
      surface.rocks.push(rock);
    }

    // Point-of-interest rock for the image-capture clip
    surface.poi = new THREE.Mesh(new THREE.DodecahedronGeometry(1.5, 0), rockMat);
    surface.poi.position.set(15.5, 0.6, -5);
    surface.poi.rotation.set(0.4, 0.9, 0.1);
    surface.poi.castShadow = true;
    g.add(surface.poi);

    createLander(g);
    createRover(g);
    createAstronaut(g);

    // ramp from the lander deck to the ground (rover deploy)
    var rampMat = new THREE.MeshStandardMaterial({ color: 0x9aa2b0, roughness: 0.7, metalness: 0.3 });
    surface.ramp = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.14, 1.5), rampMat);
    surface.ramp.position.set(-3.2, 1.1, 0);
    surface.ramp.rotation.z = -0.44;
    surface.ramp.castShadow = true;
    surface.ramp.visible = false;
    g.add(surface.ramp);

    // relay for the uplink hop (TDRS GLB when loaded, else a primitive satellite)
    createRelay(g);

    resetSurfaceActors();
  }

  function createLander(parent) {
    var g = new THREE.Group();
    g.position.set(-6, 0, 0);
    surface.lander = g;
    parent.add(g);

    var gold = new THREE.MeshStandardMaterial({ color: 0xcf9b4a, roughness: 0.55, metalness: 0.6 });
    var white = new THREE.MeshStandardMaterial({ color: 0xe8ecf2, roughness: 0.5, metalness: 0.15 });
    var dark = new THREE.MeshStandardMaterial({ color: 0x2f3540, roughness: 0.6, metalness: 0.4 });

    var glb = instanceModel('landerLM', 3.4, true);
    if (glb) {
      g.add(glb);
      surface.landerKind = 'gltf';
    } else {
      surface.landerKind = 'primitive';
      if (!hasGLTF) {
        // warned once at load time by loadModel(); nothing extra to do here
      }
      var descent = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.8, 1.1, 8), gold);
      descent.position.y = 1.75;
      descent.castShadow = true;
      g.add(descent);
      var ascent = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.3, 1.5), white);
      ascent.position.y = 3.0;
      ascent.castShadow = true;
      g.add(ascent);
      var hatch = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 0.7), dark);
      hatch.position.set(0.78, 2.7, 0.4);
      g.add(hatch);
      surface.hatchPos = { x: -6 + 1.3, y: 0, z: 1.4 };
      var nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.0, 12), dark);
      nozzle.rotation.x = Math.PI;
      nozzle.position.y = 0.95;
      g.add(nozzle);
      // four legs
      for (var i = 0; i < 4; i++) {
        var a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.6, 8), dark);
        leg.position.set(Math.cos(a) * 1.5, 1.1, Math.sin(a) * 1.5);
        leg.rotation.z = -Math.cos(a) * 0.5;
        leg.rotation.x = Math.sin(a) * 0.5;
        g.add(leg);
        var foot = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.4, 0.14, 10), gold);
        foot.position.set(Math.cos(a) * 2.35, 0.08, Math.sin(a) * 2.35);
        g.add(foot);
      }
      if (!surface.hatchPos) surface.hatchPos = { x: -4.7, y: 0, z: 1.4 };
    }
    if (!surface.hatchPos) surface.hatchPos = { x: -4.7, y: 0, z: 1.4 };

    // descent-engine flame (visible only while descending)
    surface.landerFlame = makeFlame(0.55, 3.0);
    surface.landerFlame.group.position.y = 0.6;
    g.add(surface.landerFlame.group);

    g.traverse(function (o) { if (o.isMesh) { o.castShadow = true; } });
  }

  function createRover(parent) {
    var g = new THREE.Group();
    surface.rover = g;
    parent.add(g);

    var bodyMat = new THREE.MeshStandardMaterial({ color: 0xe6e9ef, roughness: 0.5, metalness: 0.25 });
    var darkMat = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.8, metalness: 0.2 });
    var goldMat = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.5, metalness: 0.5 });

    // Rover GLBs are not in the repo yet -> intentional low-poly six-wheel build.
    surface.roverKind = 'primitive';
    noteAssetIssue('Asset not in repo yet: 3dmodels/Mars_Rover.glb (primitive fallback in use)');

    var body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 1.1), bodyMat);
    body.position.y = 0.78;
    body.castShadow = true;
    g.add(body);

    var deck = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.1, 0.9), goldMat);
    deck.position.y = 1.1;
    g.add(deck);

    // six wheels: geometry pre-rotated so mesh.rotation.z rolls the wheel
    var wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 14);
    wheelGeo.rotateX(Math.PI / 2);
    surface.wheels = [];
    var xs = [-0.62, 0, 0.62];
    for (var i = 0; i < xs.length; i++) {
      for (var s = -1; s <= 1; s += 2) {
        var w = new THREE.Mesh(wheelGeo, darkMat);
        w.position.set(xs[i], 0.42, s * 0.66);
        w.castShadow = true;
        g.add(w);
        surface.wheels.push(w);
      }
    }

    // camera mast (pan/tilt head)
    var mast = new THREE.Group();
    mast.position.set(0.55, 1.12, 0);
    var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.1, 8), bodyMat);
    pole.position.y = 0.55;
    mast.add(pole);
    var head = new THREE.Group();
    head.position.y = 1.15;
    var headBox = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.24, 0.24), bodyMat);
    head.add(headBox);
    var lensGeo = new THREE.SphereGeometry(0.07, 8, 6);
    var lensMat = new THREE.MeshStandardMaterial({
      color: 0x1a1d24, emissive: 0x2f6fb5, emissiveIntensity: 0.7, roughness: 0.3
    });
    for (var l = -1; l <= 1; l += 2) {
      var lens = new THREE.Mesh(lensGeo, lensMat);
      lens.position.set(0.06 * l, 0, 0.13);
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

    var suit = new THREE.MeshStandardMaterial({ color: 0xe8ecf2, roughness: 0.55, metalness: 0.05 });
    var trim = new THREE.MeshStandardMaterial({ color: 0xd8dde6, roughness: 0.6 });
    var visor = new THREE.MeshStandardMaterial({
      color: 0xd9a03f, emissive: 0x6b4a12, emissiveIntensity: 0.35, roughness: 0.25, metalness: 0.6
    });

    // Friendly low-poly astronaut (Astronaut.glb is not in the repo yet).
    var torso = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.72, 12), suit);
    torso.position.y = 1.06;
    g.add(torso);

    var pack = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.56, 0.26), trim);
    pack.position.set(0, 1.12, -0.3);
    g.add(pack);

    var helmet = new THREE.Mesh(new THREE.SphereGeometry(0.27, 14, 12), suit);
    helmet.position.y = 1.66;
    g.add(helmet);
    var visorMesh = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), visor);
    visorMesh.position.set(0, 1.66, 0.12);
    visorMesh.scale.set(1, 0.8, 0.7);
    g.add(visorMesh);

    // arms (swing slightly with the walk)
    surface.arms = [];
    for (var a = -1; a <= 1; a += 2) {
      var arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.6, 8), suit);
      arm.position.set(a * 0.36, 1.1, 0);
      g.add(arm);
      surface.arms.push(arm);
    }

    // legs pivot at the hip so rotation swings a step
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
    var glb = instanceModel('satTDRS', 7, false);
    if (glb) {
      g.add(glb);
      surface.relayKind = 'gltf';
    } else {
      surface.relayKind = 'primitive';
      var bodyMat = new THREE.MeshStandardMaterial({ color: 0xdfe4ec, roughness: 0.45, metalness: 0.4 });
      var panelMat = new THREE.MeshStandardMaterial({
        color: 0x1f3d8f, emissive: 0x0a1a44, emissiveIntensity: 0.55,
        roughness: 0.35, metalness: 0.3
      });
      var body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 1.4), bodyMat);
      g.add(body);
      for (var s = -1; s <= 1; s += 2) {
        var panel = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.1, 2.0), panelMat);
        panel.position.set(s * 3.3, 0, 0);
        g.add(panel);
      }
      var dish = new THREE.Mesh(new THREE.SphereGeometry(1.1, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), bodyMat);
      dish.rotation.x = Math.PI;
      dish.position.set(0, 1.2, 0);
      g.add(dish);
    }
    g.visible = false;
    g.traverse(function (o) { if (o.isMesh) o.castShadow = false; });
  }

  function setGroundDestination(dest) {
    var d = String(dest || '').toLowerCase();
    var isMoon = d.indexOf('moon') !== -1 || d.indexOf('luna') !== -1;
    surface.marsGround.visible = !isMoon;
    surface.moonGround.visible = isMoon;
    surface.currentGround = isMoon ? 'moon' : 'mars';
  }

  // Put every surface actor back to its neutral pose (no rebuilds).
  function resetSurfaceActors() {
    if (!surface.group) return;
    if (surface.lander) {
      surface.lander.position.set(-6, 0, 0);
      surface.lander.rotation.set(0, 0, 0);
      surface.lander.visible = true;
    }
    if (surface.landerFlame) {
      surface.landerFlame.group.visible = false;
      surface.landerFlame.level = 0;
    }
    if (surface.rover) {
      surface.rover.position.set(-4.5, 2.15, 0);
      surface.rover.rotation.set(0, 0, 0);
      surface.rover.visible = true;
    }
    if (surface.wheels) {
      for (var i = 0; i < surface.wheels.length; i++) surface.wheels[i].rotation.z = 0;
    }
    if (surface.roverHead) {
      surface.roverHead.rotation.set(0, 0, 0);
    }
    if (surface.astronaut) {
      surface.astronaut.position.set(-4.7, 0, 1.4);
      surface.astronaut.rotation.set(0, 0.7, 0);
      surface.astronaut.visible = false;
      if (surface.legs) for (var l = 0; l < surface.legs.length; l++) surface.legs[l].rotation.x = 0;
      if (surface.arms) for (var a = 0; a < surface.arms.length; a++) surface.arms[a].rotation.x = 0;
    }
    if (surface.ramp) surface.ramp.visible = false;
    if (surface.relay) surface.relay.visible = false;
    effects.dustTargetY = -1;
  }

  function prepareSurface(dest) {
    if (!scene) return;
    if (world.padGroup) world.padGroup.visible = false;
    surface.group.visible = true;
    if (rocket.group) rocket.group.visible = false;
    setGroundDestination(dest);
    resetSurfaceActors();
    hideImageCard();
    hideCountdown();
    hideCard();
    setFlame(0);
  }

  function prepareLaunch() {
    if (!scene) return;
    if (surface.group) surface.group.visible = false;
    if (world.padGroup) world.padGroup.visible = true;
    resetRocketVisual();
    hideImageCard();
    hideCountdown();
    hideCard();
    hideUplink();
  }

  // --- Timeline mapping ------------------------------------------------------
  // Reads outcome.timeline into ordered samples {phase, time}. Never mutates
  // the supplied array/objects; enforces non-decreasing playback times so the
  // phase ORDER of the source timeline is what the viewer sees.
  function normalizeTimeline(outcome) {
    var out = [];
    var tl = outcome && Array.isArray(outcome.timeline) ? outcome.timeline : [];
    for (var i = 0; i < tl.length; i++) {
      var e = tl[i];
      if (!e || typeof e !== 'object') continue;
      var phase = str(e.phase) || str(e.name) || str(e.type);
      var t = null;
      if (isNum(e.time)) t = e.time;
      else if (isNum(e.t)) t = e.t;
      out.push({ phase: phase.toLowerCase(), raw: phase, time: t });
    }
    return out;
  }

  function timelineHasTimes(samples) {
    if (!samples.length) return false;
    for (var i = 0; i < samples.length; i++) if (samples[i].time === null) return false;
    return true;
  }

  // Map source sample times onto [mapStart, mapEnd], or space by order when
  // times are missing/flat. Guarantees strictly increasing playback times.
  function mapSampleTimes(samples, mapStart, mapEnd) {
    var n = samples.length;
    var times = new Array(n);
    if (!n) return times;
    var span = Math.max(0.5, mapEnd - mapStart);
    var useRealTimes = timelineHasTimes(samples);
    var t0 = 0, t1 = 0;
    if (useRealTimes) {
      t0 = samples[0].time;
      t1 = samples[0].time;
      for (var i = 1; i < n; i++) {
        if (samples[i].time < t0) t0 = samples[i].time;
        if (samples[i].time > t1) t1 = samples[i].time;
      }
    }
    if (useRealTimes && t1 - t0 > 1e-6) {
      for (var j = 0; j < n; j++) {
        times[j] = mapStart + ((samples[j].time - t0) / (t1 - t0)) * span;
      }
    } else if (n === 1) {
      times[0] = mapStart + span * 0.45;
    } else {
      for (var k = 0; k < n; k++) times[k] = mapStart + (k / (n - 1)) * span;
    }
    // preserve order: never go backwards in playback time
    for (var m = 1; m < n; m++) {
      if (times[m] <= times[m - 1]) times[m] = times[m - 1] + 0.05;
    }
    return times;
  }

  // Map a source-time value (failure.time / event.time) into playback seconds
  // using the same transform as the timeline; null when it cannot be mapped.
  function mapSourceTime(value, samples, mapStart, mapEnd) {
    if (!isNum(value) || !timelineHasTimes(samples) || samples.length < 1) return null;
    var t0 = samples[0].time, t1 = samples[0].time;
    for (var i = 1; i < samples.length; i++) {
      if (samples[i].time < t0) t0 = samples[i].time;
      if (samples[i].time > t1) t1 = samples[i].time;
    }
    if (t1 - t0 <= 1e-6) return null;
    var span = Math.max(0.5, mapEnd - mapStart);
    return mapStart + ((value - t0) / (t1 - t0)) * span;
  }

  var PAD_PHASES = { pad: 1, countdown: 1, ignition: 1, launchpad: 1 };
  var SURFACE_HINTS = [
    'approach', 'transfer', 'descent', 'landing', 'touchdown', 'crew',
    'rover', 'surface', 'drive', 'image', 'capture', 'uplink', 'photo'
  ];

  function isSurfacePhase(phase) {
    if (!phase) return false;
    if (SURFACE_HINTS.indexOf(phase) !== -1) return true;
    for (var i = 0; i < SURFACE_HINTS.length; i++) {
      if (phase.indexOf(SURFACE_HINTS[i]) !== -1) return true;
    }
    return false;
  }
  function isPadPhase(phase) {
    if (!phase) return true;
    if (PAD_PHASES[phase]) return true;
    return phase.indexOf('pad') !== -1;
  }

  // Visual poses per launch phase (world units; PAD_Y = deck top). These are
  // camera/rocket staging choices, NOT simulation values.
  var PHASE_POSES = {
    pad: { r: { x: 0, y: PAD_Y, z: 0, rx: 0, ry: 0, rz: 0 }, c: { x: 16, y: 7, z: 30, tx: 0, ty: 6, tz: 0 } },
    ascent: { r: { x: 0, y: 62, z: -6, rx: 0, ry: 0, rz: -0.06 }, c: { x: 20, y: 68, z: 26, tx: 0, ty: 64, tz: -6 } },
    stage: { r: { x: -4, y: 150, z: -18, rx: 0, ry: 0, rz: -0.14 }, c: { x: 24, y: 158, z: 22, tx: -4, ty: 154, tz: -18 } },
    coast: { r: { x: -14, y: 300, z: -46, rx: 0, ry: 0, rz: -0.48 }, c: { x: 34, y: 314, z: 26, tx: -14, ty: 304, tz: -46 } },
    orbit: { r: { x: -40, y: 430, z: -80, rx: 0, ry: 0, rz: -1.52 }, c: { x: 120, y: 470, z: 60, tx: -46, ty: 426, tz: -80 } },
    deploy: { r: { x: -46, y: 436, z: -86, rx: 0, ry: 0, rz: -1.52 }, c: { x: 96, y: 462, z: 24, tx: -50, ty: 434, tz: -88 } }
  };

  function poseForPhase(phase) {
    if (!phase) return PHASE_POSES.pad;
    if (PAD_PHASES[phase] || phase.indexOf('pad') !== -1) return PHASE_POSES.pad;
    if (phase.indexOf('ascent') !== -1 || phase.indexOf('climb') !== -1 ||
        phase.indexOf('liftoff') !== -1) return PHASE_POSES.ascent;
    if (phase.indexOf('stage') !== -1 || phase.indexOf('separation') !== -1) return PHASE_POSES.stage;
    if (phase.indexOf('coast') !== -1) return PHASE_POSES.coast;
    if (phase.indexOf('deploy') !== -1 || phase.indexOf('payload') !== -1) return PHASE_POSES.deploy;
    if (phase.indexOf('orbit') !== -1 || phase.indexOf('orbital') !== -1) return PHASE_POSES.orbit;
    // unknown future launch phase: keep climbing gently (order still preserved)
    return PHASE_POSES.coast;
  }

  function makeKey(t, r, c) {
    return {
      t: t,
      r: r ? { x: r.x, y: r.y, z: r.z, rx: r.rx || 0, ry: r.ry || 0, rz: r.rz || 0, lookAt: r.lookAt || null } : null,
      c: { x: c.x, y: c.y, z: c.z, tx: c.tx, ty: c.ty, tz: c.tz }
    };
  }

  // Interpolate into scratch objects (zero per-frame allocation).
  function poseAtInto(keys, t, outR, outC) {
    if (!keys.length) return false;
    var i = 0;
    while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
    var a = keys[i];
    var b = keys[i + 1];
    if (!b) { copyKeyInto(a, outR, outC); return true; }
    var span = b.t - a.t;
    var u = span <= 1e-6 ? 1 : easeSoft((t - a.t) / span);
    if (a.r && b.r) {
      outR.x = lerp(a.r.x, b.r.x, u);
      outR.y = lerp(a.r.y, b.r.y, u);
      outR.z = lerp(a.r.z, b.r.z, u);
      outR.rx = lerp(a.r.rx, b.r.rx, u);
      outR.ry = lerp(a.r.ry, b.r.ry, u);
      outR.rz = lerp(a.r.rz, b.r.rz, u);
      outR.lookAt = b.r.lookAt || a.r.lookAt || null;
    } else if (a.r || b.r) {
      copyRInto(a.r || b.r, outR);
    }
    outC.x = lerp(a.c.x, b.c.x, u);
    outC.y = lerp(a.c.y, b.c.y, u);
    outC.z = lerp(a.c.z, b.c.z, u);
    outC.tx = lerp(a.c.tx, b.c.tx, u);
    outC.ty = lerp(a.c.ty, b.c.ty, u);
    outC.tz = lerp(a.c.tz, b.c.tz, u);
    return true;
  }
  function copyRInto(r, out) {
    out.x = r.x; out.y = r.y; out.z = r.z;
    out.rx = r.rx; out.ry = r.ry; out.rz = r.rz;
    out.lookAt = r.lookAt || null;
  }
  function copyKeyInto(k, outR, outC) {
    if (k.r) copyRInto(k.r, outR);
    outC.x = k.c.x; outC.y = k.c.y; outC.z = k.c.z;
    outC.tx = k.c.tx; outC.ty = k.c.ty; outC.tz = k.c.tz;
  }

  function applyPoseToRocket(r) {
    if (!rocket.group || !r) return;
    rocket.group.position.set(r.x, r.y, r.z);
    if (r.lookAt) {
      rocket.group.lookAt(r.lookAt.x, r.lookAt.y, r.lookAt.z);
      rocket.group.rotateX(Math.PI / 2);   // nose is +Y; lookAt aims +Z
    } else {
      rocket.group.rotation.set(r.rx, r.ry, r.rz);
    }
  }

  function applyPoseToCamera(c, driftT, driftAmp) {
    if (!camera || !c) return;
    var x = c.x, y = c.y, z = c.z;
    if (driftT >= 0) {
      getDrift(driftT, scratchDrift);
      var k = isNum(driftAmp) ? clamp01(driftAmp) : 1;
      x += scratchDrift.x * k; y += scratchDrift.y * k; z += scratchDrift.z * k;
    }
    camera.position.set(x, y, z);
    camera.lookAt(c.tx, c.ty, c.tz);
  }

  function getDrift(t, out) {
    var amp = reducedMotion ? 0.35 : 1;
    out.x = Math.sin(t * 0.13) * 1.7 * amp;
    out.y = Math.sin(t * 0.09 + 1.3) * 0.9 * amp;
    out.z = Math.cos(t * 0.11) * 1.7 * amp;
  }

  // --- Failure sequences -----------------------------------------------------
  // Visual-only treatment per failure.type. Label text comes exclusively from
  // outcome.failure fields + SMG.data.failures copy when that exists; absent
  // parts are omitted (never undefined/NaN/fabricated numbers).
  var FAILURE_KINDS = {
    thrust_low: { neverLeavesPad: true, hints: ['pad', 'ascent'] },
    fuel_out: { hints: ['ascent', 'climb', 'coast'] },
    power_short: { hints: ['ascent', 'coast', 'orbit'], cue: 'SIGNAL LOST' },
    sensor_fault: { hints: ['ascent', 'climb', 'coast'] },
    stage_fail: { hints: ['stage', 'separation'] },
    over_budget: { noLaunch: true },
    over_mass: { noLaunch: true }
  };

  function failureLabel(failure) {
    var out = { title: '', detail: '' };
    if (!failure || typeof failure !== 'object') return out;
    var type = str(failure.type).toLowerCase();

    // Existing failure copy from SMG.data.failures when data.js has landed
    // (object keyed by type, or an array of {type,...} entries).
    var lib = null;
    try {
      var f = (window.SMG && SMG.data) ? SMG.data.failures : null;
      if (f) {
        if (Array.isArray(f)) {
          for (var i = 0; i < f.length; i++) {
            if (f[i] && str(f[i].type).toLowerCase() === type) { lib = f[i]; break; }
          }
        } else if (typeof f === 'object' && f[type]) {
          lib = f[type];
        }
      }
    } catch (e) { lib = null; }

    var kind = FAILURE_KINDS[type] || null;
    out.title = str(failure.title) ||
      str(lib && (lib.title || lib.name || lib.label)) ||
      (kind && kind.cue ? kind.cue : (type ? humanizeType(type) : ''));

    var parts = [];
    var msg = str(failure.message) || str(failure.detail) ||
      str(lib && (lib.message || lib.description));
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
    var title = str(ev.title) || (str(ev.type) ? humanizeType(ev.type) : 'EVENT');
    var detail = str(ev.detail) || str(ev.message) || '';
    return { title: title, detail: detail };
  }

  function setPhase(run, p) { if (run) run.phase = p; }
  function setAlert(run, kind, title, detail) {
    if (run) run.alertIs = kind;
    showAlert(kind, title, detail);
  }

  // Where in the (already mapped) timeline a failure takes over.
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
      for (var h = 0; h < hints.length; h++) {
        if (ph.indexOf(hints[h]) !== -1) return times[i];
      }
    }
    return winStart + (mapEnd - winStart) * 0.4;
  }

  // Motion + beats for each failure, from tF to the end of the run.
  function appendFailure(b, kind, type, failure, tF, tokenless) {
    var dur = b.duration;
    var S = Math.max(2.0, dur - tF);
    var label = failureLabel(failure);
    var keys = b.keys;
    var steps = b.steps;

    function key(t, r, c) { keys.push(makeKey(t, r, c)); }
    function step(t, fn) { steps.push({ t: t, fn: fn }); }
    function alertAt(at) {
      step(at, function (r) {
        setAlert(r, 'failure', label.title, label.detail);
        setPhase(r, 'FAILURE \u2014 ' + humanizeType(type));
      });
    }

    if (kind.neverLeavesPad) {
      // Flame flickers weakly, rocket shudders and sinks back onto the pad.
      key(tF, { x: 0, y: PAD_Y + 0.5, z: 0, rx: 0, ry: 0, rz: 0 },
        { x: 13, y: 6.5, z: 24, tx: 0, ty: 5, tz: 0 });
      key(tF + 0.35 * S, { x: 0, y: PAD_Y + 0.34, z: 0, rx: 0, ry: 0, rz: 0 },
        { x: 12, y: 6, z: 22, tx: 0, ty: 4.8, tz: 0 });
      key(tF + 0.6 * S, { x: 0, y: PAD_Y + 0.1, z: 0, rx: 0, ry: 0, rz: 0 },
        { x: 11, y: 5.6, z: 20, tx: 0, ty: 4.6, tz: 0 });
      key(tF + 0.75 * S, { x: 0, y: PAD_Y, z: 0, rx: 0, ry: 0, rz: 0 },
        { x: 10.5, y: 5.2, z: 19, tx: 0, ty: 4.4, tz: 0 });
      step(tF, function (r) {
        r.fx.flameGoal = 0.55; r.fx.flickerAmp = 0.6; r.fx.shudder = 1; r.fx.smoke = 0.25;
        setPhase(r, 'IGNITION');
      });
      step(tF + 0.35 * S, function (r) {
        r.fx.flameGoal = 0.3; r.fx.shudder = 1.25;
      });
      step(tF + 0.6 * S, function (r) {
        r.fx.flameGoal = 0; r.fx.smoke = 0; r.fx.shudder = 0.4;
      });
      step(tF + 0.72 * S, function (r) { r.fx.shudder = 0; });
      alertAt(tF + 0.78 * S);
      return;
    }

    if (type === 'fuel_out') {
      // Flame sputters out at failure.altitudeKm (shown only if present),
      // brief coast, then a controlled fall out of frame -- no impact shown.
      var y0 = lastRocketY(keys);
      key(tF + 0.28 * S, { x: -4, y: y0 + 34, z: -14, rx: 0, ry: 0, rz: -0.1 },
        { x: 22, y: y0 + 40, z: 26, tx: -4, ty: y0 + 34, tz: -14 });
      key(tF + 0.46 * S, { x: -8, y: y0 + 44, z: -22, rx: 0, ry: 0, rz: -0.16 },
        { x: 24, y: y0 + 46, z: 28, tx: -8, ty: y0 + 42, tz: -22 });
      key(tF + 0.7 * S, { x: -12, y: y0 + 14, z: -30, rx: 0, ry: 0, rz: -0.34 },
        { x: 24, y: y0 + 44, z: 28, tx: -12, ty: y0 + 20, tz: -30 });
      key(dur, { x: -16, y: y0 - 78, z: -38, rx: 0, ry: 0, rz: -0.42 },
        { x: 24, y: y0 + 44, z: 28, tx: -16, ty: y0 - 40, tz: -38 });
      step(tF, function (r) {
        r.fx.flameGoal = 0.35; r.fx.flickerAmp = 0.85; r.fx.smoke = 0.5;
        setPhase(r, 'ENGINE FLAME OUT');
      });
      step(tF + 0.3 * S, function (r) { r.fx.flameGoal = 0.12; });
      step(tF + 0.46 * S, function (r) { r.fx.flameGoal = 0; r.fx.smoke = 0; });
      alertAt(tF + 0.5 * S);
      return;
    }

    if (type === 'power_short') {
      // Craft lights dim to dark; brief SIGNAL LOST cue; engines fade out.
      var py = lastRocketY(keys);
      key(tF + 0.35 * S, { x: -6, y: py + 30, z: -16, rx: 0, ry: 0, rz: -0.12 },
        { x: 20, y: py + 34, z: 26, tx: -6, ty: py + 30, tz: -16 });
      key(tF + 0.65 * S, { x: -10, y: py + 46, z: -26, rx: 0, ry: 0, rz: -0.22 },
        { x: 20, y: py + 40, z: 26, tx: -10, ty: py + 44, tz: -26 });
      key(dur, { x: -14, y: py + 62, z: -34, rx: 0, ry: 0, rz: -0.3 },
        { x: 20, y: py + 40, z: 26, tx: -14, ty: py + 60, tz: -34 });
      step(tF, function (r) {
        setPhase(r, 'POWER');
        addTween({
          from: 1, to: 0.06, dur: 0.9, token: r.token, ease: easeInOut,
          onUpdate: function (v) { r.fx.lights = v; }
        });
      });
      step(tF + 0.3 * S, function (r) {
        r.fx.flameGoal = 0; r.fx.smoke = 0;
      });
      alertAt(tF + 0.42 * S);
      return;
    }

    if (type === 'sensor_fault') {
      // Warning beacon blinks; gentle off-path drift and tumble, no impact.
      var sy = lastRocketY(keys);
      var sx = lastRocketX(keys);
      key(tF + 0.35 * S, { x: sx + 13, y: sy + 30, z: -16, rx: 0, ry: 0.05, rz: -0.3 },
        { x: 20, y: sy + 34, z: 26, tx: sx + 8, ty: sy + 30, tz: -16 });
      key(tF + 0.7 * S, { x: sx + 26, y: sy + 54, z: -30, rx: 0, ry: 0.1, rz: -0.55 },
        { x: 24, y: sy + 56, z: 26, tx: sx + 18, ty: sy + 52, tz: -30 });
      key(dur, { x: sx + 35, y: sy + 72, z: -42, rx: 0, ry: 0.14, rz: -0.72 },
        { x: 28, y: sy + 72, z: 26, tx: sx + 26, ty: sy + 68, tz: -42 });
      step(tF, function (r) {
        r.fx.beacon = 1;
        r.fx.smoke = 0.4;
        setPhase(r, 'SENSOR WARNING');
      });
      step(tF + 0.3 * S, function (r) { r.fx.smoke = 0; });
      alertAt(tF + 0.45 * S);
      return;
    }

    if (type === 'stage_fail') {
      // Separation jams with a glitch, then the piece drifts/spins away
      // cartoony-safe; the upper stage keeps flying.
      var gy = lastRocketY(keys);
      key(tF + 0.3 * S, { x: -6, y: gy + 40, z: -20, rx: 0, ry: 0, rz: -0.16 },
        { x: 22, y: gy + 46, z: 26, tx: -6, ty: gy + 42, tz: -20 });
      key(tF + 0.65 * S, { x: -12, y: gy + 78, z: -36, rx: 0, ry: 0, rz: -0.34 },
        { x: 26, y: gy + 84, z: 26, tx: -12, ty: gy + 80, tz: -36 });
      key(dur, { x: -18, y: gy + 108, z: -50, rx: 0, ry: 0, rz: -0.5 },
        { x: 30, y: gy + 112, z: 26, tx: -18, ty: gy + 106, tz: -50 });
      step(tF, function (r) {
        r.fx.jitterLower = 1;
        r.fx.flameGoal = 0.4; r.fx.flickerAmp = 0.8; r.fx.smoke = 0.5;
        setPhase(r, 'STAGE FAULT');
      });
      step(tF + 0.16 * S, function (r) {
        r.fx.jitterLower = 0;
        r.fx.flameGoal = 0;
        // drift + spin + fade, safely out of the flight path
        var lg = rocket.lower;
        addTween({
          from: 0, to: 1, dur: Math.min(3.2, S * 0.8), token: r.token, ease: easeInQuad,
          onUpdate: function (v) {
            lg.position.y = -18 * v;
            lg.position.x = 7 * v;
            lg.rotation.z = 1.5 * v;
          }
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

    // Unknown/unsupported failure type: keep the flight, show the label only.
    alertAt(tF + 0.4 * S);
  }

  function lastRocketY(keys) {
    for (var i = keys.length - 1; i >= 0; i--) if (keys[i].r) return keys[i].r.y;
    return PAD_Y;
  }
  function lastRocketX(keys) {
    for (var i = keys.length - 1; i >= 0; i--) if (keys[i].r) return keys[i].r.x;
    return 0;
  }

  // --- Planetary sequences ---------------------------------------------------
  // Preview-only today: real sim outcomes have no destination phases yet. They
  // play in a real run ONLY if outcome.timeline actually contains such phases.
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
    var low = name.toLowerCase();
    var key = 'mars';
    if (low.indexOf('moon') !== -1 || low.indexOf('luna') !== -1) key = 'moon';
    else if (low.indexOf('saturn') !== -1) key = 'saturn';
    else if (low.indexOf('mars') !== -1) key = 'mars';
    else if (low.indexOf('earth') !== -1) key = 'earth';
    return { key: key, name: name };
  }

  function approachTitle(dest) {
    return dest.name ? 'APPROACHING ' + dest.name.toUpperCase() : 'APPROACHING';
  }

  function seqApproach(b, t0, t1, ctx) {
    var dest = ctx.dest;
    var P = getPlanet(dest.key === 'earth' ? 'earth' : dest.key) || getPlanet('mars');
    var d = Math.max(0.5, t1 - t0);
    b.steps.push({ t: t0, fn: function (run) {
      if (world.padGroup) world.padGroup.visible = false;
      if (surface.group) surface.group.visible = false;
      if (rocket.group) rocket.group.visible = true;
      resetRocketVisual();
      setPhase(run, 'APPROACH');
    } });
    b.steps.push({ t: t0 + d * 0.3, fn: function () {
      showCard('TRANSITION', approachTitle(dest));
    } });

    if (!P) {
      // No 3D world (THREE missing): keep the pad camera, card still shows.
      b.keys.push(makeKey(t0, null, { x: 16, y: 7, z: 30, tx: 0, ty: 6, tz: 0 }));
      b.keys.push(makeKey(t1, null, { x: 16, y: 8, z: 30, tx: 0, ty: 7, tz: 0 }));
      return;
    }
    var dx = -P.x, dy = -P.y, dz = -P.z;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= len; dy /= len; dz /= len;
    var far = P.r * 16, near = P.r * 3.6;
    var cam0 = { x: P.x + dx * far, y: P.y + dy * far + P.r * 1.6, z: P.z + dz * far };
    var cam1 = { x: P.x + dx * near, y: P.y + dy * near + P.r * 0.5, z: P.z + dz * near };
    var ship0 = { x: lerp(cam0.x, P.x, 0.14), y: lerp(cam0.y, P.y, 0.14), z: lerp(cam0.z, P.z, 0.14) };
    var ship1 = { x: lerp(cam1.x, P.x, 0.45), y: lerp(cam1.y, P.y, 0.45), z: lerp(cam1.z, P.z, 0.45) };
    var look = { x: P.x, y: P.y, z: P.z };

    b.keys.push(makeKey(t0,
      { x: ship0.x, y: ship0.y, z: ship0.z, rx: 0, ry: 0, rz: 0, lookAt: look },
      { x: cam0.x, y: cam0.y, z: cam0.z, tx: P.x, ty: P.y, tz: P.z }));
    b.keys.push(makeKey(t0 + d * 0.6,
      { x: lerp(ship0.x, ship1.x, 0.6), y: lerp(ship0.y, ship1.y, 0.6), z: lerp(ship0.z, ship1.z, 0.6), rx: 0, ry: 0, rz: 0, lookAt: look },
      { x: lerp(cam0.x, cam1.x, 0.6), y: lerp(cam0.y, cam1.y, 0.6), z: lerp(cam0.z, cam1.z, 0.6), tx: P.x, ty: P.y, tz: P.z }));
    b.keys.push(makeKey(t1,
      { x: ship1.x, y: ship1.y, z: ship1.z, rx: 0, ry: 0, rz: 0, lookAt: look },
      { x: cam1.x, y: cam1.y, z: cam1.z, tx: P.x, ty: P.y, tz: P.z }));
  }

  function seqLanding(b, t0, t1, ctx) {
    var dest = ctx.dest;
    var d = Math.max(1.2, t1 - t0);
    b.steps.push({ t: t0, fn: function (run) {
      prepareSurface(dest.key);
      if (surface.lander) surface.lander.position.set(-6, 44, 0);
      effects.dustTargetY = 0;
      applyFlame(surface.landerFlame, 0.95, 1);
      setPhase(run, 'DESCENT');
      addTween({
        from: 44, to: 0, dur: d * 0.86, token: run.token, ease: easeOutCubic,
        onUpdate: function (v) { if (surface.lander) surface.lander.position.y = v; }
      });
    } });
    b.keys.push(makeKey(t0, null, { x: 30, y: 22, z: 36, tx: -6, ty: 26, tz: 0 }));
    b.keys.push(makeKey(t0 + d * 0.7, null, { x: 20, y: 8, z: 24, tx: -6, ty: 6, tz: 0 }));
    b.keys.push(makeKey(t1, null, { x: 14, y: 4.6, z: 18, tx: -6, ty: 3, tz: 0 }));
    b.steps.push({ t: t0 + d * 0.86, fn: function (run) {
      effects.dustTargetY = -1;
      applyFlame(surface.landerFlame, 0, 1);
      emitDustBurst(-6, 0.2, 0, 0.95);
      if (surface.lander) {
        var lg = surface.lander;
        addTween({
          from: 0.26, to: 0, dur: 0.5, token: run.token, ease: easeOutCubic,
          onUpdate: function (v) { lg.position.y = v; }
        });
      }
      showCard(dest.name ? dest.name.toUpperCase() : 'SURFACE', 'TOUCHDOWN');
      setPhase(run, 'TOUCHDOWN');
    } });
  }

  function seqCrew(b, t0, t1, ctx) {
    var dest = ctx.dest;
    var d = Math.max(1.2, t1 - t0);
    b.steps.push({ t: t0, fn: function (run) {
      prepareSurface(dest.key);
      if (surface.astronaut) surface.astronaut.visible = true;
      setPhase(run, 'CREW EXIT');
      var from = { x: -4.7, y: 0, z: 1.4 };
      var to = { x: -1.6, y: 0, z: 3.2 };
      var legs = surface.legs || [];
      var arms = surface.arms || [];
      addTween({
        from: 0, to: 1, dur: d * 0.78, token: run.token, ease: easeSoft,
        onUpdate: function (v) {
          if (!surface.astronaut) return;
          surface.astronaut.position.set(lerp(from.x, to.x, v), 0, lerp(from.z, to.z, v));
          var swing = reducedMotion ? 0.15 : 0.55;
          var ph = v * Math.PI * 5;
          for (var i = 0; i < legs.length; i++) {
            legs[i].rotation.x = Math.sin(ph + i * Math.PI) * swing;
          }
          for (var j = 0; j < arms.length; j++) {
            arms[j].rotation.x = Math.sin(ph + j * Math.PI) * swing * 0.6;
          }
          surface.astronaut.position.y = Math.abs(Math.sin(ph)) * 0.05;
        },
        onComplete: function () {
          for (var i = 0; i < legs.length; i++) legs[i].rotation.x = 0;
          for (var j = 0; j < arms.length; j++) arms[j].rotation.x = 0;
          if (surface.astronaut) {
            surface.astronaut.position.y = 0;
            surface.astronaut.rotation.y = 0.4;
          }
        }
      });
    } });
    b.keys.push(makeKey(t0, null, { x: 7, y: 3.4, z: 13, tx: -4, ty: 2.2, tz: 1 }));
    b.keys.push(makeKey(t1, null, { x: 5, y: 3.0, z: 12, tx: -2.5, ty: 1.6, tz: 2 }));
  }

  function seqRoverDeploy(b, t0, t1, ctx) {
    var dest = ctx.dest;
    var d = Math.max(1.2, t1 - t0);
    b.steps.push({ t: t0, fn: function (run) {
      prepareSurface(dest.key);
      if (surface.ramp) surface.ramp.visible = true;
      if (surface.rover) {
        surface.rover.position.set(-4.5, 2.15, 0);
        surface.rover.rotation.z = -0.44;
      }
      setPhase(run, 'ROVER DEPLOY');
      var from = { x: -4.5, y: 2.15 };
      var to = { x: -0.3, y: 0 };
      var totalDist = Math.sqrt(4.2 * 4.2 + 2.15 * 2.15);
      addTween({
        from: 0, to: 1, dur: d * 0.8, token: run.token, ease: easeInOut,
        onUpdate: function (v) {
          if (!surface.rover) return;
          surface.rover.position.x = lerp(from.x, to.x, v);
          surface.rover.position.y = lerp(from.y, to.y, v);
          surface.rover.rotation.z = -0.44 * (1 - clamp01((v - 0.84) / 0.16));
          var roll = (v * totalDist) / 0.42;
          for (var i = 0; i < surface.wheels.length; i++) surface.wheels[i].rotation.z = -roll;
        },
        onComplete: function () {
          if (surface.rover) surface.rover.rotation.z = 0;
        }
      });
    } });
    b.steps.push({ t: t1 - 0.05, fn: function () {
      if (surface.ramp) surface.ramp.visible = false;
    } });
    b.keys.push(makeKey(t0, null, { x: 6, y: 4.6, z: 13, tx: -3.5, ty: 1.8, tz: 0 }));
    b.keys.push(makeKey(t1, null, { x: 9, y: 3.4, z: 13, tx: -1, ty: 1.0, tz: 0 }));
  }

  function seqRoverDrive(b, t0, t1, ctx) {
    var dest = ctx.dest;
    var d = Math.max(1.2, t1 - t0);
    b.steps.push({ t: t0, fn: function (run) {
      prepareSurface(dest.key);
      if (surface.rover) {
        surface.rover.position.set(-0.3, 0, 1.6);
        surface.rover.rotation.set(0, 0, 0);
      }
      setPhase(run, 'ROVER DRIVE');
      var drive = { u: 0 };
      var x0 = -0.3, x1 = 13;
      addTween({
        from: 0, to: 1, dur: d * 0.85, token: run.token, ease: easeInOut,
        onUpdate: function (v) {
          drive.u = v;
          if (!surface.rover) return;
          var x = lerp(x0, x1, v);
          surface.rover.position.x = x;
          var roll = (x - x0) / 0.42;
          for (var i = 0; i < surface.wheels.length; i++) surface.wheels[i].rotation.z = -roll;
        }
      });
      // mast scan: pan/tilt toward a point of interest while driving
      run.updates.push(function (r, dt) {
        void dt;
        if (!surface.roverHead) return;
        var u = drive.u;
        if (reducedMotion) {
          surface.roverHead.rotation.y = 0.3;
          surface.roverHead.rotation.x = -0.05;
          return;
        }
        surface.roverHead.rotation.y = Math.sin(u * Math.PI * 2) * 0.7;
        surface.roverHead.rotation.x = -0.05 + Math.sin(u * Math.PI * 3) * 0.14;
      });
    } });
    b.keys.push(makeKey(t0, null, { x: 2, y: 4.2, z: 15, tx: 1, ty: 1.2, tz: 1.5 }));
    b.keys.push(makeKey(t0 + d * 0.5, null, { x: 8, y: 4.0, z: 14, tx: 8, ty: 1.2, tz: 1 }));
    b.keys.push(makeKey(t1, null, { x: 15, y: 3.6, z: 12, tx: 14, ty: 1.2, tz: -1 }));
  }

  function seqImageCapture(b, t0, t1, ctx) {
    var dest = ctx.dest;
    var d = Math.max(1.5, t1 - t0);
    var photo = dest.key === 'moon' ? ASSETS.textures.moonPhoto : ASSETS.textures.marsPhoto;
    var caption = 'Illustrative mission simulation image' +
      (dest.name ? ' \u2014 ' + dest.name + ' surface' : '') +
      ' (not a real photograph)';
    b.steps.push({ t: t0, fn: function (run) {
      prepareSurface(dest.key);
      if (surface.rover) {
        surface.rover.position.set(11, 0, -2);
        surface.rover.rotation.set(0, -0.5, 0);
      }
      if (surface.roverHead) {
        surface.roverHead.rotation.y = 0.55;
        surface.roverHead.rotation.x = -0.12;
      }
      setPhase(run, 'IMAGE CAPTURE');
    } });
    b.keys.push(makeKey(t0, null, { x: 6.5, y: 3.4, z: 6.5, tx: 14, ty: 1.6, tz: -4.5 }));
    b.keys.push(makeKey(t1, null, { x: 8.2, y: 3.0, z: 5.2, tx: 15, ty: 1.5, tz: -5 }));
    b.steps.push({ t: t0 + d * 0.15, fn: function (run) {
      showReticle({ x: 15.5, y: 1.7, z: -5 }, run.token);
      if (effects.reticle && camera) effects.reticle.lookAt(camera.position);
    } });
    b.steps.push({ t: t0 + d * 0.55, fn: function (run) {
      shutterFlash(run.token, 0.45);
      showImageCard(encodePath(photo), caption);
      setPhase(run, 'IMAGE CAPTURE');
    } });
    b.steps.push({ t: t0 + d * 0.8, fn: function () {
      if (effects.reticle) effects.reticle.visible = false;
    } });
  }

  function seqDataUplink(b, t0, t1, ctx) {
    var dest = ctx.dest;
    var d = Math.max(1.5, t1 - t0);
    b.steps.push({ t: t0, fn: function (run) {
      prepareSurface(dest.key);
      if (surface.rover) {
        surface.rover.position.set(9, 0, 2);
        surface.rover.rotation.set(0, -0.3, 0);
      }
      if (surface.relay) surface.relay.visible = true;
      setPhase(run, 'DATA UPLINK');
      var leg1 = d * 0.32, leg2 = d * 0.34;
      launchPacket(
        { x: 9, y: 1.4, z: 2 }, { x: -6, y: 3.8, z: 0 }, leg1, 3.5, run.token,
        function () {
          launchPacket(
            { x: -6, y: 3.8, z: 0 }, { x: 16, y: 30, z: -26 }, leg2, 12, run.token,
            function () {
              showUplink();
              pulseInline(dom && dom.uplinkDot, run.token, 1.2);
              setPhase(run, 'UPLINK CONFIRMED');
            }
          );
        }
      );
    } });
    b.keys.push(makeKey(t0, null, { x: 26, y: 16, z: 32, tx: 0, ty: 10, tz: -6 }));
    b.keys.push(makeKey(t1, null, { x: 22, y: 14, z: 28, tx: 2, ty: 12, tz: -8 }));
  }

  var SURFACE_SEQS = {
    approach: seqApproach, transfer: seqApproach,
    descent: seqLanding, landing: seqLanding, touchdown: seqLanding,
    crew: seqCrew,
    rover_deploy: seqRoverDeploy,
    drive: seqRoverDrive,
    image: seqImageCapture, capture: seqImageCapture,
    uplink: seqDataUplink
  };

  function surfaceSeqFor(phase) {
    if (!phase) return null;
    if (SURFACE_SEQS[phase]) return SURFACE_SEQS[phase];
    var keys = Object.keys(SURFACE_SEQS);
    for (var i = 0; i < keys.length; i++) {
      if (phase.indexOf(keys[i]) !== -1) return SURFACE_SEQS[keys[i]];
    }
    if (phase.indexOf('approach') !== -1 || phase.indexOf('transfer') !== -1) return seqApproach;
    if (phase.indexOf('crew') !== -1) return seqCrew;
    if (phase.indexOf('rover') !== -1) return seqRoverDeploy;
    if (phase.indexOf('drive') !== -1 || phase.indexOf('surface') !== -1) return seqRoverDrive;
    if (phase.indexOf('image') !== -1 || phase.indexOf('capture') !== -1) return seqImageCapture;
    if (phase.indexOf('uplink') !== -1) return seqDataUplink;
    return null;
  }

  // --- Timeline mapping into a runnable script ------------------------------
  // Builds ONE visual script: ordered camera/rocket keys (interpolated between
  // timeline samples) + timed steps + per-frame update fns. Nothing here
  // computes simulation values; times are playback seconds only.
  function runFxUpdate(run, dt) {
    var fx = run.fx;
    if (!rocket.group) return;

    // flame level eases toward its goal, then flickers
    fx.flame += (fx.flameGoal - fx.flame) * Math.min(1, dt * 5);
    var shown = fx.flame;
    if (shown > 0.02 && fx.flickerAmp > 0) {
      shown *= 1 + fx.flickerAmp * wobble(run.elapsed * 27);
    }
    setFlame(clamp01(shown));

    if (fx.smoke > 0 && fx.flame > 0.12) emitSmokeTrail(dt, fx.flame * fx.smoke);

    if (fx.shudder > 0 && !reducedMotion) {
      rocket.group.position.x += wobble(run.elapsed * 41) * 0.05 * fx.shudder;
      rocket.group.position.y += wobble(run.elapsed * 53 + 2) * 0.04 * fx.shudder;
      rocket.group.rotation.z += wobble(run.elapsed * 37 + 4) * 0.012 * fx.shudder;
    }

    if (fx.drift || fx.spin) {
      fx.ox += fx.drift * dt;
      fx.orz += fx.spin * dt;
      rocket.group.position.x += fx.ox;
      rocket.group.rotation.z += fx.orz;
    }

    if (fx.jitterLower > 0 && rocket.lower && !reducedMotion) {
      rocket.lower.position.x = wobble(run.elapsed * 61) * 0.12 * fx.jitterLower;
      rocket.lower.position.y = wobble(run.elapsed * 47 + 1) * 0.1 * fx.jitterLower;
      rocket.lower.rotation.z = wobble(run.elapsed * 39 + 3) * 0.05 * fx.jitterLower;
    }

    if (rocket.beaconMat) {
      if (fx.beacon > 0) {
        rocket.beaconMat.emissiveIntensity = reducedMotion ? 0.9 :
          fx.beacon * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(run.elapsed * 4.2)));
      } else {
        rocket.beaconMat.emissiveIntensity = 0;
      }
    }

    var L = fx.lights;
    if (rocket.craftLight) rocket.craftLight.intensity = 0.55 * L;
    if (rocket.engineLight) rocket.engineLight.intensity = fx.flame * 2.6 * L;
    if (rocket.matWindow) rocket.matWindow.emissiveIntensity = 0.9 * L;
    if (world.padLightMat) world.padLightMat.emissiveIntensity = 1.1 * (0.4 + 0.6 * L);
  }

  function restoreLighting() {
    if (rocket.matWindow) rocket.matWindow.emissiveIntensity = 0.9;
    if (world.padLightMat) world.padLightMat.emissiveIntensity = 1.1;
    if (rocket.craftLight) rocket.craftLight.intensity = 0.55;
    if (rocket.engineLight) rocket.engineLight.intensity = 0;
    if (rocket.beaconMat) rocket.beaconMat.emissiveIntensity = 0;
  }

  function deployPayload(run) {
    if (!rocket.payload || !rocket.payload.group) return;
    var pg = rocket.payload.group;
    pg.visible = true;
    rocket.payloadDeployed = true;
    var panels = [];
    pg.traverse(function (o) { if (o.userData && o.userData.isPanel) panels.push(o); });
    addTween({
      from: 0, to: 1, dur: 2.6, token: run.token, ease: easeOutCubic,
      onUpdate: function (v) {
        pg.position.x = v * 5.5;
        pg.position.y = 7.5 + v * 2.4;
        pg.rotation.y = v * 1.7;
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
    var out = [];
    var evs = outcome && Array.isArray(outcome.events) ? outcome.events : [];
    var rec = [];
    for (var i = 0; i < evs.length; i++) {
      if (evs[i] && evs[i].recovered === true) rec.push(evs[i]);
    }
    if (!rec.length) return out;
    var useTimes = timelineHasTimes(samples);
    var t0 = 0, t1 = 0;
    if (useTimes) {
      t0 = samples[0].time; t1 = samples[0].time;
      for (var j = 1; j < samples.length; j++) {
        if (samples[j].time < t0) t0 = samples[j].time;
        if (samples[j].time > t1) t1 = samples[j].time;
      }
    }
    var span = Math.max(1, win1 - win0);
    for (var k = 0; k < rec.length; k++) {
      var ev = rec[k];
      var raw = isNum(ev.time) ? ev.time : (isNum(ev.t) ? ev.t : null);
      var t = null;
      if (raw !== null && useTimes && t1 - t0 > 1e-6) {
        t = win0 + ((raw - t0) / (t1 - t0)) * span;
      }
      if (t === null) {
        t = win0 + span * (0.35 + 0.4 * (rec.length === 1 ? 0.5 : k / (rec.length - 1)));
      }
      out.push({ ev: ev, t: clamp(t, win0 + 0.3, Math.max(win0 + 0.4, win1 - 0.6)) });
    }
    return out;
  }

  function buildScript(outcome, mission, opts) {
    opts = opts || {};
    var preview = !!opts.preview;
    var duration = isNum(opts.duration) ? opts.duration : TOTAL_LAUNCH;
    var failure = (outcome && outcome.failure && typeof outcome.failure === 'object')
      ? outcome.failure : null;
    var failureType = failure ? str(failure.type).toLowerCase() : '';
    var kind = FAILURE_KINDS[failureType] || null;
    var dest = resolveDestination(mission);

    var b = {
      keys: [], steps: [], updates: [], duration: duration, preview: preview,
      label: opts.label || '', phase: opts.phase || '',
      drift: !!opts.drift, driftUntil: 0, hasRocketKeys: false
    };
    function step(t, fn) { b.steps.push({ t: t, fn: fn }); }

    // --- no-launch failures (over_budget / over_mass): settle immediately ---
    if (kind && kind.noLaunch) {
      b.duration = preview ? 2.6 : 1.6;
      b.keys.push(makeKey(0, PHASE_POSES.pad.r, PHASE_POSES.pad.c));
      b.keys.push(makeKey(b.duration, PHASE_POSES.pad.r, PHASE_POSES.pad.c));
      b.hasRocketKeys = true;
      step(0, function (run) {
        prepareLaunch();
        setPhase(run, 'LAUNCH BLOCKED');
      });
      step(0.15, function (run) {
        var l = failureLabel(failure);
        setAlert(run, 'failure', l.title, l.detail);
      });
      b.updates.push(runFxUpdate);
      return b;
    }

    // --- samples + safe fallback ------------------------------------------
    var samples = normalizeTimeline(outcome);
    if (samples.length === 0 ||
        (samples.length === 1 && !isSurfacePhase(samples[0].phase))) {
      // empty / single-sample timeline: safe short path from the outcome type
      samples = [
        { phase: 'pad', raw: 'pad', time: null },
        { phase: 'ascent', raw: 'ascent', time: null },
        { phase: 'coast', raw: 'coast', time: null },
        { phase: 'orbit', raw: 'orbit', time: null }
      ];
    }

    var firstIsPad = isPadPhase(samples[0].phase);
    var cd = firstIsPad ? COUNTDOWN_DUR : 0;
    var winStart = cd;
    var mapStart = cd + (firstIsPad ? 0 : 0.9);
    var mapEnd = Math.max(mapStart + 1.6, duration - 0.25);
    b.driftUntil = cd;

    // partition launch vs surface samples (surface phases are preview-only
    // today; they play in a real run only if the timeline contains them)
    var firstSurf = -1, nSurf = 0, ordered = true, seenSurf = false;
    for (var i0 = 0; i0 < samples.length; i0++) {
      var isS = isSurfacePhase(samples[i0].phase);
      if (isS) { if (firstSurf === -1) firstSurf = i0; nSurf++; seenSurf = true; }
      else if (seenSurf) ordered = false;
    }
    var nLaunch = samples.length - nSurf;
    var allSurface = nSurf === samples.length;

    // --- time allocation ----------------------------------------------------
    var launchTimes = [];
    var surfSlices = [];
    if (allSurface) {
      for (var i1 = 0; i1 < samples.length; i1++) {
        surfSlices.push({
          i: i1,
          t0: (i1 / samples.length) * duration,
          t1: ((i1 + 1) / samples.length) * duration
        });
      }
    } else if (nSurf === 0) {
      launchTimes = mapSampleTimes(samples, mapStart, mapEnd);
    } else if (ordered && firstSurf > 0) {
      var lwEnd = mapStart + Math.max(1.6, (duration - mapStart - 1.6) * 0.62);
      launchTimes = mapSampleTimes(samples.slice(0, firstSurf), mapStart, lwEnd);
      var sStart = lwEnd + 0.4;
      var sEnd = Math.max(sStart + 1.2, duration - 0.15);
      var per = (sEnd - sStart) / nSurf;
      for (var s0 = 0; s0 < nSurf; s0++) {
        surfSlices.push({ i: firstSurf + s0, t0: sStart + s0 * per, t1: sStart + (s0 + 1) * per });
      }
    } else {
      // pathological interleaving: keep one window, order preserved
      launchTimes = mapSampleTimes(samples, mapStart, mapEnd);
      for (var i2 = 0; i2 < samples.length; i2++) {
        if (!isSurfacePhase(samples[i2].phase)) continue;
        var st0 = launchTimes[i2];
        var st1 = i2 + 1 < samples.length ? launchTimes[i2 + 1] : duration - 0.15;
        surfSlices.push({ i: i2, t0: st0, t1: Math.max(st0 + 0.8, st1) });
      }
    }

    // --- failure takeover time (launch groups only) -------------------------
    var tF = null;
    if (kind && nLaunch > 0) {
      var lSamples = allSurface ? [] : (nSurf === 0 ? samples : samples.slice(0, firstSurf));
      var lTimes = nSurf === 0 ? launchTimes : launchTimes.slice(0, nLaunch);
      if (lSamples.length) {
        tF = chooseFailureTime(kind, failure, lSamples, lTimes, mapStart, mapEnd, winStart);
      }
    }

    // --- rocket/camera keys from launch samples (order preserved) -----------
    if (!allSurface) {
      if (!firstIsPad) b.keys.push(makeKey(0, PHASE_POSES.pad.r, PHASE_POSES.pad.c));
      for (var i3 = 0; i3 < nLaunch; i3++) {
        var t = launchTimes[i3];
        if (tF !== null && t > tF + 1e-6) break;
        var pose = poseForPhase(samples[i3].phase);
        b.keys.push(makeKey(t, pose.r, pose.c));
        step(t, (function (label) {
          return function (run) { setPhase(run, label); };
        })(phaseLabelOf(samples[i3].phase)));
      }
      if (tF !== null && kind) appendFailure(b, kind, failureType, failure, tF);
    }

    // --- surface sub-sequences ---------------------------------------------
    for (var s2 = 0; s2 < surfSlices.length; s2++) {
      var sl = surfSlices[s2];
      var seq = surfaceSeqFor(samples[sl.i].phase);
      if (!seq) continue;
      seq(b, sl.t0, Math.max(sl.t0 + 0.8, sl.t1), { dest: dest });
    }

    // --- base sequence steps: countdown / ignition / flame / stage ----------
    // Surface-only runs prepare themselves in their own sub-sequences, so the
    // pad/countdown beats are skipped there entirely.
    if (!allSurface) {
      step(0, function (run) {
        prepareLaunch();
        setPhase(run, cd > 0 ? 'COUNTDOWN' : 'IGNITION');
      });
      if (cd > 0) {
        step(0.25, function () { showCountdown('3'); });
        step(1.05, function () { showCountdown('2'); });
        step(1.85, function () { showCountdown('1'); });
        step(cd - 0.12, function () { hideCountdown(); });
      }
      var igT = cd > 0 ? Math.max(0.1, cd - 0.7) : 0.15;
      step(igT, function (run) {
        run.fx.flameGoal = 0.8;
        run.fx.flickerAmp = 0.2;
      });
      // A failure that takes over at liftoff owns the flame from that moment.
      if (!(tF !== null && tF <= winStart + 1e-6)) {
        step(winStart, function (run) {
          run.fx.flameGoal = 1;
          run.fx.flickerAmp = 0.12;
          run.fx.smoke = 1;
          if (cd > 0) setPhase(run, 'ASCENT');
        });
      }
    }

    // stage / coast / orbit / deploy beats -- only when the timeline has them
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
      // normal separation: only when the timeline actually contains it
      step(stageT, function (run) {
        setPhase(run, 'STAGE SEPARATION');
        run.fx.flameGoal = 0;
        run.fx.smoke = 0;
        var lg = rocket.lower;
        addTween({
          from: 0, to: 1, dur: 2.8, token: run.token, ease: easeInQuad,
          onUpdate: function (v) {
            lg.position.y = -14 * v;
            lg.rotation.z = 1.1 * v;
          }
        });
        fadeLowerStage(2.4, run.token);
        addTween({
          from: 0, to: 0.9, dur: 0.6, delay: 0.5, token: run.token, ease: easeOutCubic,
          onUpdate: function (v) { rocket.upperFlameLevel = v; }
        });
        run.fx.smoke = 0.6;
        setTimeoutSafe(run, function () { run.fx.smoke = 0.35; }, 1.2);
      });
    }

    var cutT = coastT !== null ? coastT : orbitT;
    if (cutT !== null && tF === null) {
      step(cutT, function (run) {
        run.fx.flameGoal = 0;
        run.fx.smoke = 0;
        if (coastT !== null) setPhase(run, 'COAST');
      });
    }
    if (deployT !== null && tF === null) {
      step(deployT, function (run) { deployPayload(run); });
    }

    // --- recovered events (warning pulse, then continue) --------------------
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
          if (run.alertIs === 'warning') {
            hideAlert();
            run.alertIs = null;
          }
        });
      })(events[e0]);
    }

    b.updates.push(runFxUpdate);
    for (var k0 = 0; k0 < b.keys.length; k0++) {
      if (b.keys[k0].r) { b.hasRocketKeys = true; break; }
    }
    return b;
  }

  // Timed follow-up inside a step (still token-guarded, still one system).
  function setTimeoutSafe(run, fn, delay) {
    addTween({
      from: 0, to: 1, dur: delay, token: run.token,
      onComplete: function () { fn(run); }
    });
  }

  // --- Lifecycle / run-token -------------------------------------------------
  // One active run at a time. runToken increments per run; every tween, step
  // and callback checks it, so stale runs stay dead and onDone fires exactly
  // once per run (natural completion, skip, or cancellation by a new run).
  var pendingCbs = [];

  function startRun(spec) {
    // cancel whatever is playing FIRST (its onDone must still fire once)
    cancelActiveRun();
    // A failure alert / image card survives its own run (stays readable after
    // skip) but must NEVER leak into the next run -- clear them on start.
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
      fx: {
        flame: 0, flameGoal: 0, flickerAmp: 0, smoke: 0, shudder: 0,
        beacon: 0, lights: 1, drift: 0, spin: 0, ox: 0, orz: 0, jitterLower: 0
      },
      onDone: typeof spec.onDone === 'function' ? spec.onDone : null
    };
    run.addUpdate = function (fn) { if (run.updates.indexOf(fn) === -1) run.updates.push(fn); };
    run.setPhase = function (p) { run.phase = p; };

    run.steps.sort(function (a, c) { return a.t - c.t; });
    activeRun = run;
    idleActive = false;
    cameraBlend = null;
    if (preview) setPreviewPhase(run.phase);
    return run;
  }

  function finishRun(run) {
    if (!run || run.done) return;
    if (run.token !== runToken) return;      // stale run: stays dead
    run.done = true;
    if (activeRun === run) activeRun = null;
    cleanupRun(run);
    var cb = run.onDone;
    run.onDone = null;
    if (!cb) return;
    if (finishing) { pendingCbs.push(cb); return; }   // no deep re-entrancy
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
    killTweens();                          // run tweens + tracked inline opacity
    clearTransientOverlays();              // countdown / card / uplink
    if (run.alertIs === 'warning') hideAlert();   // failure alert stays readable
    stopEffects();
    setFlame(0);
    rocket.upperFlameLevel = 0;
    restoreLighting();
    if (surface.landerFlame) applyFlame(surface.landerFlame, 0, 1);
    if (run.updates) run.updates.length = 0;
  }

  function updateRun(dt) {
    var run = activeRun;
    if (!run || run.done || run.token !== runToken) return;
    run.elapsed += dt * run.timeScale;

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
        // idle sway is eased out over the last 0.6 s instead of snapping off
        driftT = run.elapsed;
        driftAmp = clamp01((run.driftUntil - run.elapsed) / 0.6);
      }
      applyPoseToCamera(scratchC, driftT, driftAmp);
      camTX = scratchC.tx; camTY = scratchC.ty; camTZ = scratchC.tz;
    }

    for (var i = 0; i < run.updates.length; i++) {
      try { run.updates[i](run, dt * run.timeScale); }
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
    var tx = Math.sin(a) * 30 + 4;
    var ty = 12 + Math.sin(elapsedWall * 0.11 * speed) * 1.4 * amp;
    var tz = Math.cos(a) * 30 + 6;
    var cx = 0, cy = 7, cz = 0;
    if (cameraBlend) {
      cameraBlend.t += dt;
      var u = easeInOut(clamp01(cameraBlend.t / cameraBlend.dur));
      camera.position.set(
        lerp(cameraBlend.x, tx, u),
        lerp(cameraBlend.y, ty, u),
        lerp(cameraBlend.z, tz, u)
      );
      camera.lookAt(
        lerp(cameraBlend.tx, cx, u),
        lerp(cameraBlend.ty, cy, u),
        lerp(cameraBlend.tz, cz, u)
      );
      if (cameraBlend.t >= cameraBlend.dur) cameraBlend = null;
    } else {
      camera.position.set(tx, ty, tz);
      camera.lookAt(cx, cy, cz);
    }
    camTX = cx; camTY = cy; camTZ = cz;
    // subtle flame-off engine glow (light only, no flame cone)
    if (rocket.engineLight) {
      rocket.engineLight.intensity = 0.32 +
        (reducedMotion ? 0 : 0.1 * Math.sin(elapsedWall * 1.7));
    }
  }

  function showPad(build) {
    if (!initialized) {
      console.warn('[scene] showPad() called before init()');
      return;
    }
    var wasIdle = idleActive;
    cancelActiveRun();                 // active run's onDone fires exactly once
    clearAllOverlays();
    if (rocket.group) resetRocketVisual();
    restoreLighting();
    applyBuild(build);                 // read-only: never mutates `build`
    if (surface.group) surface.group.visible = false;
    if (world.padGroup) world.padGroup.visible = true;
    stopEffects();
    idleActive = true;
    if (!wasIdle && camera && !reducedMotion) {
      cameraBlend = {
        t: 0, dur: 0.75,
        x: camera.position.x, y: camera.position.y, z: camera.position.z,
        tx: camTX, ty: camTY, tz: camTZ
      };
    }
    if (preview) { setPreviewPhase('IDLE'); setPreviewProgress(0); }
  }

  // Engine/nozzle count + fuel presentation from `build` (visual only).
  function applyBuild(build) {
    var b = (build && typeof build === 'object') ? build : {};
    updateNozzles(readEngineCount(b));
    updateFuelPanels(readFuelRatio(b));
  }

  function playLaunch(outcome, mission, onDone) {
    var cb = typeof onDone === 'function' ? onDone : null;
    if (!initialized) {
      // Contract still holds without a scene: onDone exactly once, right now.
      if (cb) cb();
      return;
    }
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
    if (!run || run.done) return;         // harmless when nothing is playing
    finishRun(run);                       // onDone fires exactly once here
    settleAfterSkip(run);                 // ...then the scene lands somewhere stable
  }

  // Stop/skip settles into the stable idle presentation: the craft returns to
  // the pad, temporary effects and transient overlays are already gone (see
  // cleanupRun), and the camera eases back to the idle drift. A failure alert
  // is the informative final state, so it stays readable on the way back.
  function settleAfterSkip(run) {
    if (rocket.group) resetRocketVisual();
    if (surface.group) surface.group.visible = false;
    if (world.padGroup) world.padGroup.visible = true;
    idleActive = true;                    // idle drift owns the camera again
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
      // progress stays where it stopped so the reviewer can see how far it got
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
    // Wall-clock pacing: the 8-12 s contract must hold at ANY frame rate.
    // The old 0.05 clamp made low-fps machines (software GL, weak laptops,
    // headless CI) play the whole sequence in slow motion. Only cap the
    // pathological resume-after-pause gap instead.
    if (dt > 0.5) dt = 0.5;
    elapsedWall += dt;

    var sdt = activeRun ? dt * activeRun.timeScale : dt;
    updateTweens(sdt);
    updateRun(dt);
    updateIdle(dt);
    updateEffects(sdt);
    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  function startLoop() {
    if (rafId) return;                 // exactly one RAF loop, ever
    lastFrameTime = 0;
    rafId = window.requestAnimationFrame(frame);
  }

  function onMotionChange() {
    try { reducedMotion = !!(mediaQuery && mediaQuery.matches); }
    catch (e) { reducedMotion = false; }
  }

  function init(containerEl) {
    if (initialized) return;           // idempotent: one of everything
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
    showPad(null);      // establish the idle pad state immediately
  }

  // --- Preview lab (dev only) ----------------------------------------------
  // Enabled only with ?visualPreview=1. Isolated mocks; never calls
  // SMG.sim.launch(), never touches saved progress, never shows fake
  // score/fuel/altitude/success claims.
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
    el.removeAttribute('hidden');       // only ever created when enabled

    preview = {
      root: el,
      phase: el.querySelector('.smg-preview__phase'),
      progress: el.querySelector('.smg-preview__progress'),
      warn: el.querySelector('.smg-preview__warn'),
      current: null
    };
    // ONE delegated listener -- replays never multiply handlers or nodes.
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
      if (node.getAttribute &&
          (node.getAttribute('data-clip') || node.getAttribute('data-action'))) return node;
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
      SMG.scene.skip();                 // Stop MUST use the real skip() path
    } else if (action === 'reset') {
      previewReset();
    }
  }

  function setPreviewPhase(text) {
    if (preview && preview.phase) preview.phase.textContent = text || '';
  }
  function setPreviewProgress(f) {
    if (preview && preview.progress) {
      preview.progress.style.width = (clamp01(f) * 100).toFixed(1) + '%';
    }
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
      // A clip superseded by another click must not stamp its DONE over the
      // clip that is playing now (startRun cancels the old run synchronously).
      if (previewCurrentClip !== id) return;
      setPreviewPhase('DONE \u2014 ' + def.label.toUpperCase());
      setPreviewProgress(1);
    });
  }

  function previewIdlePad(def) {
    cancelActiveRun();
    showPad(PREVIEW_BUILD);
    var spec = {
      keys: [makeKey(0, PHASE_POSES.pad.r, PHASE_POSES.pad.c)],
      hasRocketKeys: true,
      steps: [], updates: [], duration: 4.5, preview: true, timeScale: 1,
      phase: 'IDLE PAD', label: def ? def.label : 'Idle Pad', drift: true,
      onDone: function () {
        if (previewCurrentClip !== 'pad') return;   // superseded by another clip
        setPreviewPhase('DONE \u2014 IDLE PAD');
        setPreviewProgress(1);
      }
    };
    startRun(spec);
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
  // Development-only fixtures for the Preview Lab above. Literal copy only --
  // these objects are never merged into real game data and the simulator is
  // never invoked. `ok`/`failure` here exist so the scene has something to
  // visualise; they are not results shown to a player.
  var PREVIEW_BUILD = { engines: 5, fuel: 0.78 };   // presentation only

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
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) o.failure[k] = extra[k];
      }
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
    'landing': { outcome: mockLaunch(['landing']), mission: mockMission('Mars', 'Landing Preview') },
    'crew-exit': { outcome: mockLaunch(['landing', 'crew_deploy']), mission: mockMission('Mars', 'Crew Exit Preview') },
    'rover-deploy': { outcome: mockLaunch(['landing', 'rover_deploy']), mission: mockMission('Mars', 'Rover Deploy Preview') },
    'rover-drive': { outcome: mockLaunch(['surface_drive']), mission: mockMission('Mars', 'Rover Drive Preview') },
    'image-capture': { outcome: mockLaunch(['image_capture']), mission: mockMission('Mars', 'Image Capture Preview') },
    'data-uplink': { outcome: mockLaunch(['data_uplink']), mission: mockMission('Mars', 'Data Uplink Preview') },
    'skip-replay': {
      outcome: mockLaunch(['pad', 'ascent', 'stage', 'coast', 'orbit']),
      mission: mockMission('Earth Orbit', 'Skip + Replay Preview')
    }
  };

  // --- Cleanup ---------------------------------------------------------------
  // Shared idle-world resources (renderer, geometries, textures, materials,
  // pools, GLB templates) are never disposed per run -- they outlive every
  // launch. Run-scoped temporaries (tweens, steps, particles, packets, inline
  // opacity, transient overlays) are released by cleanupRun(); init() is
  // idempotent, so 10 replays in a row cannot multiply renderers, canvases,
  // RAF loops, resize observers, listeners or DOM nodes.

  // --- Dev-only self-bootstrap -----------------------------------------------
  // Per the contract, ui.js (Person 3) owns the real SMG.scene.init() call in
  // normal play. Until those screens land nothing calls init(), which would
  // make the Preview Lab -- the only way to exercise the scene today
  // (SKILL.md 3 and 15) -- unreachable. So under ?visualPreview=1 ONLY, we
  // initialise ourselves against #scene so the lab works standalone. init()
  // is idempotent, so ui.js's later real init() cannot double-create a
  // renderer, canvas, listeners or loops.
  if (/[?&]visualPreview=1(&|$)/.test(String(window.location && window.location.search || ''))) {
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
