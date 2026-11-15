// ---------------------------------------------------------------------------
// js/ui.js -- every screen the player sees (Person 3)
//
// Flow (SKILL.md section 2):
//   campaign -> briefing -> build -> launch animation -> results
//
// Talks to the rest of the game only through:
//   SMG.data  -- missions (controls, win copy, knowledge, facts)
//   SMG.sim   -- computeStats / validate / launch   (all game maths live there)
//   SMG.scene -- init / showPad / playLaunch / skip (all pixels live there)
//
// This file is display-only: it never computes thrust, mass, fuel, altitude,
// success, failure or score, and it reads an outcome only as outcome.ok /
// outcome.failure for flow control. No points anywhere, ever.
//
// Robustness rules honoured throughout:
//   * every cross-file access is guarded; missing data/sim/scene degrades to
//     the friendly placeholder, never a thrown error;
//   * one screen in #app at a time (innerHTML swap), so re-entry can never
//     duplicate screens or listeners;
//   * SMG.scene.init(#scene) runs exactly once, inside try/catch;
//   * each launch run carries a run id + a settled flag: the screen advances
//     exactly once and stale callbacks from an old run are ignored;
//   * progress lives in localStorage ('smg_progress') and falls back to
//     session-only memory when storage is unavailable;
//   * every string that came from data/sim passes through esc() first.
// ---------------------------------------------------------------------------

window.SMG = window.SMG || {};

SMG.ui = (function () {
  'use strict';

  // --- module state --------------------------------------------------------
  var started = false;
  var runId = 0;              // bumped per screen change; kills stale callbacks
  var sceneOK = false;        // SMG.scene.init() completed without throwing
  var previewMode = false;    // ?visualPreview=1 -- dev Preview Lab (SKILL 15)
  var completedCache = null;  // mission keys completed in this session
  var state = {
    screen: '',   // campaign | briefing | build | launch | results
    mission: null, // current mission object (entry of SMG.data.missions)
    build: null,   // { missionId, choices } -> sim.launch / scene.showPad
    outcome: null  // last sim.launch result: owned by sim, read-only here
  };

  // Placeholder copy, adapted from the original stub message.
  var MSG_LOADING = 'Loading mission data\u2026';
  var MSG_NO_SIM = 'The mission simulator isn\u2019t ready yet.';
  var HINT_FILES = 'If this sticks around, data.js or sim.js hasn\'t been added yet.';

  // --- tiny display helpers ------------------------------------------------

  // Escape anything that reaches innerHTML. Data is trusted; do it anyway.
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Non-empty trimmed string, or '' -- numbers/objects never reach the page,
  // so undefined / NaN can never be printed.
  function txt(v) {
    if (typeof v !== 'string') return '';
    var s = v.replace(/^\s+|\s+$/g, '');
    return s;
  }

  // First non-empty string among the arguments.
  function pick() {
    for (var i = 0; i < arguments.length; i++) {
      var s = txt(arguments[i]);
      if (s) return s;
    }
    return '';
  }

  // First argument that is neither null, undefined nor '' (numbers allowed).
  function firstRaw() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== null && v !== undefined && v !== '') return v;
    }
    return null;
  }

  function toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.replace(/\s/g, '') !== '') {
      var n = Number(v);
      return isFinite(n) ? n : null;
    }
    return null;
  }

  function wire(el, ev, fn) {
    if (el && el.addEventListener) el.addEventListener(ev, fn);
  }

  // --- saved progress (localStorage, degrades to session memory) -----------
  // Shape written here: { "completed": ["m1_lunar_landing", ...] }.
  // Reading is lenient so a hand-edited store still loads.

  function loadCompleted() {
    try {
      var raw = window.localStorage.getItem('smg_progress');
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      var arr = null;
      if (Array.isArray(parsed)) arr = parsed;
      else if (parsed && Array.isArray(parsed.completed)) arr = parsed.completed;
      else if (parsed && Array.isArray(parsed.done)) arr = parsed.done;
      if (!arr) return [];
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        if (typeof arr[i] === 'string' && arr[i]) out.push(arr[i]);
      }
      return out;
    } catch (e) {
      return []; // storage blocked or corrupt -> session-only progress
    }
  }

  function getCompleted() {
    if (!completedCache) completedCache = loadCompleted();
    return completedCache;
  }

  function saveCompleted() {
    try {
      window.localStorage.setItem(
        'smg_progress',
        JSON.stringify({ completed: getCompleted() })
      );
    } catch (e) {
      // Storage unavailable (private mode / quota): the in-memory cache still
      // keeps progress for this session; never throw at the player.
    }
  }

  function missionKey(m) {
    if (!m || typeof m !== 'object') return '';
    if (typeof m.id === 'string' && m.id) return m.id;
    if (typeof m.order === 'number' && isFinite(m.order)) return 'order:' + m.order;
    if (typeof m.name === 'string' && m.name) return 'name:' + m.name;
    return 'mission';
  }

  function isCompleted(m) {
    return getCompleted().indexOf(missionKey(m)) !== -1;
  }

  function markCompleted(m) {
    var list = getCompleted();
    var key = missionKey(m);
    if (key && list.indexOf(key) === -1) {
      list.push(key);
      saveCompleted();
    }
  }

  // --- scene integration (all guarded; never throws) -----------------------

  function initScene() {
    try {
      if (SMG.scene && typeof SMG.scene.init === 'function') {
        SMG.scene.init(document.getElementById('scene'));
        sceneOK = true;
      } else {
        console.warn('[ui] SMG.scene is unavailable -- running without 3D.');
      }
    } catch (e) {
      sceneOK = false;
      console.warn('[ui] SMG.scene.init failed -- running without 3D:', e);
    }
  }

  function sceneShowPad(build) {
    if (!sceneOK || !SMG.scene || typeof SMG.scene.showPad !== 'function') return;
    try {
      SMG.scene.showPad(build);
    } catch (e) {
      console.warn('[ui] scene.showPad failed:', e);
    }
  }

  // ?visualPreview=1: the dev Preview Lab lives inside #scene (z-index 0) and
  // would sit behind #app's screens. Let clicks fall through #app everywhere
  // except the real controls, so the lab stays reachable (SKILL 15).
  function peAttr() {
    return previewMode ? ' style="pointer-events:auto"' : '';
  }

  // --- screen plumbing -----------------------------------------------------

  function mount(html) {
    var app = document.getElementById('app');
    if (!app) {
      console.warn('[ui] #app mount point is missing');
      return false;
    }
    app.innerHTML = html; // full swap: no duplicate screens or listeners
    return true;
  }

  function focusFirst(sel) {
    if (!sel) return;
    var app = document.getElementById('app');
    var el = app && app.querySelector(sel);
    if (el && typeof el.focus === 'function') {
      try { el.focus(); } catch (e) { /* never trap focus */ }
    }
  }

  // Friendly placeholder -- same shell the stub used, message parameterised.
  function renderPlaceholder(message, hint) {
    runId += 1; // any in-flight launch callback is stale now
    var app = document.getElementById('app');
    if (!app) return;
    app.innerHTML =
      '<div class="screen screen--loading">' +
        '<h1>Space Mission Game</h1>' +
        '<p>' + esc(message || MSG_LOADING) + '</p>' +
        '<p class="hint">' + esc(hint || HINT_FILES) + '</p>' +
      '</div>';
  }

  // --- mission list helpers ------------------------------------------------

  function getMissions() {
    var data = SMG.data;
    if (!data || !Array.isArray(data.missions) || !data.missions.length) return null;
    var decorated = [];
    for (var i = 0; i < data.missions.length; i++) {
      var m = data.missions[i];
      if (!m || typeof m !== 'object') continue;
      var o = (typeof m.order === 'number' && isFinite(m.order)) ? m.order : Infinity;
      decorated.push({ m: m, i: i, o: o });
    }
    if (!decorated.length) return null;
    decorated.sort(function (a, b) { return (a.o - b.o) || (a.i - b.i); });
    var out = [];
    for (var j = 0; j < decorated.length; j++) out.push(decorated[j].m);
    return out;
  }

  function orderNoOf(m, idx) {
    if (m && typeof m.order === 'number' && isFinite(m.order)) return m.order;
    return idx + 1;
  }

  function indexOfMission(missions, m) {
    var key = missionKey(m);
    for (var i = 0; i < missions.length; i++) {
      if (missionKey(missions[i]) === key) return i;
    }
    return -1;
  }

  function findMission(missions, key) {
    for (var i = 0; i < missions.length; i++) {
      if (missionKey(missions[i]) === key) return missions[i];
    }
    return null;
  }

  // Mission 1 is open; completing mission N unlocks N+1 (linear campaign).
  function isUnlocked(missions, idx) {
    if (idx <= 0) return true;
    return isCompleted(missions[idx - 1]);
  }

  function hasSim() {
    return !!(SMG.sim &&
      typeof SMG.sim.launch === 'function' &&
      typeof SMG.sim.validate === 'function');
  }

  // =========================================================================
  // Screen 1 -- campaign
  // =========================================================================

  function campaignHTML(missions) {
    var html =
      '<div class="screen screen--campaign">' +
        '<h1>Space Missions</h1>' +
        '<p class="hint">Pick a mission. Finish one to unlock the next.</p>' +
        '<div class="mission-grid"' + peAttr() + '>';

    for (var i = 0; i < missions.length; i++) {
      var m = missions[i];
      var unlocked = isUnlocked(missions, i);
      var done = unlocked && isCompleted(m);
      var orderNo = orderNoOf(m, i);
      var cls = 'mission-card';
      if (!unlocked) cls += ' mission-card--locked';
      else if (done) cls += ' mission-card--done';

      html += '<button type="button" class="' + cls +
        '" data-mission="' + esc(missionKey(m)) + '"' + (unlocked ? '' : ' disabled') + '>';
      html += '<span class="mission-card__order">' + esc(String(orderNo)) + '</span>';
      html += '<span class="mission-card__name">' +
        esc(pick(m.name, 'Mission ' + orderNo)) + '</span>';
      var objective = txt(m.objective);
      if (objective) {
        html += '<span class="mission-card__objective">' + esc(objective) + '</span>';
      }
      // Locked / done state is carried by explicit text, never colour alone.
      if (!unlocked) {
        var prev = missions[i - 1];
        html += '<small>\ud83d\udd12 LOCKED \u2014 finish Mission ' +
          esc(String(orderNoOf(prev, i - 1))) + ' first</small>';
      } else if (done) {
        html += '<small>\u2713 COMPLETED</small>';
      }
      html += '</button>';
    }

    html += '</div>';
    if (!sceneOK) {
      html += '<p class="hint">3D visuals are unavailable right now \u2014 ' +
        'every mission still works.</p>';
    }
    html += '</div>';
    return html;
  }

  function wireCampaign(missions) {
    var app = document.getElementById('app');
    if (!app) return;
    var cards = app.querySelectorAll('.mission-card');
    for (var i = 0; i < cards.length; i++) {
      wire(cards[i], 'click', function (ev) {
        var card = ev.currentTarget;
        var key = card && card.getAttribute('data-mission');
        if (key) goBriefing(key);
      });
    }
    void missions;
  }

  function goCampaign(noFocus) {
    runId += 1;
    state.screen = 'campaign';
    state.mission = null;
    state.outcome = null;
    var missions = getMissions();
    if (!missions) { renderPlaceholder(); return; }
    sceneShowPad(null); // idle world stays pretty behind the translucent screen
    if (!mount(campaignHTML(missions))) return;
    if (!noFocus) focusFirst('.mission-card:not([disabled])');
    wireCampaign(missions);
  }

  // =========================================================================
  // Screen 2 -- briefing (knowledge teaser stays reserved for results)
  // =========================================================================

  function factsHTML(m) {
    var items = [];
    var dest = pick(m.destinationName, m.destination, m.destinationId);
    if (dest) items.push('Destination: ' + dest);
    var assets = m.assets;
    if (assets && typeof assets === 'object') {
      var rocket = txt(assets.rocket);
      if (rocket) items.push('Launch vehicle: ' + rocket);
      var payload = txt(assets.payload);
      if (payload) items.push('Payload: ' + payload);
    }
    if (!items.length) return '';
    var html = '<ul class="briefing__facts">';
    for (var i = 0; i < items.length; i++) html += '<li>' + esc(items[i]) + '</li>';
    return html + '</ul>';
  }

  function briefingHTML(m) {
    var objective = txt(m.objective);
    return '<div class="screen screen--briefing">' +
      '<div class="panel briefing"' + peAttr() + '>' +
        '<h1>' + esc(pick(m.name, 'Mission Briefing')) + '</h1>' +
        (objective ? '<p class="briefing__objective">' + esc(objective) + '</p>' : '') +
        factsHTML(m) +
        '<div class="launch-bar">' +
          '<button type="button" class="btn btn--ghost" data-go="campaign">BACK</button>' +
          '<button type="button" class="btn btn--primary" data-go="build">START MISSION</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function wireBriefing(m) {
    var app = document.getElementById('app');
    if (!app) return;
    var btns = app.querySelectorAll('.briefing [data-go]');
    for (var i = 0; i < btns.length; i++) {
      wire(btns[i], 'click', function (ev) {
        var go = ev.currentTarget.getAttribute('data-go');
        if (go === 'build') goBuild(missionKey(m));
        else goCampaign();
      });
    }
  }

  function goBriefing(key) {
    runId += 1;
    var missions = getMissions();
    if (!missions) { renderPlaceholder(); return; }
    var m = findMission(missions, key);
    if (!m) { goCampaign(); return; }
    state.screen = 'briefing';
    state.mission = m;
    state.outcome = null;
    if (!mount(briefingHTML(m))) return;
    focusFirst('.briefing .btn--primary');
    wireBriefing(m);
  }

  // =========================================================================
  // Screen 3 -- build (exactly two notched control groups per mission)
  // =========================================================================

  function controlGroupHTML(control) {
    var cid = (control && control.id !== null && control.id !== undefined)
      ? String(control.id) : '';
    if (!cid) return '';
    var label = pick(control.label, cid);
    var options = Array.isArray(control.options) ? control.options : [];
    var html =
      '<div class="control-group" data-control="' + esc(cid) + '">' +
        '<span class="control-group__label" id="cg-' + esc(cid) + '">' +
          esc(label) + '</span>' +
        '<div role="group" aria-labelledby="cg-' + esc(cid) + '">';

    for (var i = 0; i < options.length; i++) {
      var o = options[i];
      if (!o || typeof o !== 'object') continue;
      var oid = (o.id !== null && o.id !== undefined) ? String(o.id) : '';
      if (!oid) continue;
      var selected = !!(state.build && state.build.choices[cid] === oid);
      html += '<button type="button" class="choice' + (selected ? ' is-selected' : '') +
        '" data-control="' + esc(cid) + '" data-option="' + esc(oid) +
        '" aria-pressed="' + (selected ? 'true' : 'false') + '">' +
        esc(pick(o.label, oid));
      var hint = txt(o.hint);
      if (hint) html += '<span class="choice__hint">' + esc(hint) + '</span>';
      html += '</button>';
    }

    return html + '</div></div>';
  }

  // --- vehicle check: descriptive readouts only, every number from sim -----

  function normLevel(raw) {
    if (typeof raw === 'number' && isFinite(raw)) {
      if (raw % 1 === 0 && raw >= 0 && raw <= 2) {
        return ['crit', 'warn', 'ok'][raw];        // 0 / 1 / 2 style buckets
      }
      if (raw >= 0 && raw <= 1) {                  // 0..1 ratio
        return raw <= 0.34 ? 'crit' : (raw <= 0.67 ? 'warn' : 'ok');
      }
      return raw <= 0 ? 'crit' : (raw < 2 ? 'warn' : 'ok');
    }
    if (typeof raw === 'string') {
      var tokens = raw.toLowerCase().split(/[^a-z]+/);
      var crit = ['crit', 'critical', 'red', 'bad', 'fail', 'failed',
                  'danger', 'poor', 'unsafe', 'over'];
      var warn = ['warn', 'warning', 'yellow', 'amber', 'caution', 'medium',
                  'mid', 'marginal', 'tight', 'fair'];
      var good = ['ok', 'good', 'green', 'healthy', 'pass', 'passed',
                  'safe', 'success', 'great'];
      var i, t;
      for (i = 0; i < tokens.length; i++) {
        t = tokens[i];
        if (t && crit.indexOf(t) !== -1) return 'crit';
      }
      for (i = 0; i < tokens.length; i++) {
        t = tokens[i];
        if (t && warn.indexOf(t) !== -1) return 'warn';
      }
      for (i = 0; i < tokens.length; i++) {
        t = tokens[i];
        if (t && good.indexOf(t) !== -1) return 'ok';
      }
    }
    return 'warn'; // unknown bucket: neutral amber, never a fabricated verdict
  }

  // Decorative bar width only (the real number is the text beside it).
  function fallbackPct(level) {
    if (level === 'ok') return 85;
    if (level === 'crit') return 30;
    return 55;
  }

  function statRow(key, raw) {
    var e = raw;
    if (e !== null && typeof e === 'object') {
      // keep as-is
    } else if (typeof e === 'number' || typeof e === 'string') {
      e = { value: e };
    } else {
      return null;
    }

    var label = pick(e.label, e.name, e.title, e.caption, e.id);
    if (!label && typeof key === 'string' && key) {
      label = key.charAt(0).toUpperCase() + key.slice(1);
    }
    if (!label) label = 'Readout';

    var valueText = pick(e.text, e.display, e.valueText, e.readout);
    if (!valueText) {
      var v = firstRaw(e.value, e.amount, e.current);
      if (typeof v === 'number') {
        if (isFinite(v)) {
          valueText = String(v);
          var unit = pick(e.unit, e.units);
          if (unit) valueText += ' ' + unit;
        }
      } else if (typeof v === 'string') {
        valueText = v;
      }
    }

    var levelRaw = firstRaw(e.level, e.status, e.tone, e.bucket, e.state,
                            e.rating, e.grade);
    var level = levelRaw === null ? 'warn' : normLevel(levelRaw);

    var pct = null;
    var explicit = toNum(e.pct);
    if (explicit === null) explicit = toNum(e.percent);
    if (explicit !== null) {
      pct = explicit > 1 ? explicit : explicit * 100;
    } else {
      var ratio = toNum(e.ratio);
      if (ratio !== null) {
        pct = ratio * 100;
      } else {
        var val = toNum(e.value);
        var max = toNum(e.max);
        if (val !== null && max !== null && max > 0) pct = (val / max) * 100;
      }
    }
    if (pct === null || !isFinite(pct)) {
      // sim readouts are clamped 0..100 indexes with no max field: the value
      // itself is the bar width (presentation only, the number stays text).
      var vOnly = toNum(e.value);
      if (vOnly !== null && vOnly >= 0 && vOnly <= 100) pct = vOnly;
      else pct = fallbackPct(level);
    }
    pct = Math.max(0, Math.min(100, Math.round(pct)));

    var note = pick(e.note, e.notes, e.detail);

    return { label: label, valueText: valueText, level: level, pct: pct, note: note };
  }

  // Accepts an array, a { gauges|rows|stats: [...] } wrapper, or a
  // { key: {label, value, max, level} } map -- sim.js owns the exact shape.
  function normalizeStats(stats) {
    var pairs = [];
    var i, k;
    if (Array.isArray(stats)) {
      for (i = 0; i < stats.length; i++) pairs.push([null, stats[i]]);
    } else if (stats && typeof stats === 'object') {
      if (Array.isArray(stats.gauges)) {
        for (i = 0; i < stats.gauges.length; i++) pairs.push([null, stats.gauges[i]]);
      } else if (Array.isArray(stats.rows)) {
        for (i = 0; i < stats.rows.length; i++) pairs.push([null, stats.rows[i]]);
      } else if (Array.isArray(stats.stats)) {
        for (i = 0; i < stats.stats.length; i++) pairs.push([null, stats.stats[i]]);
      } else {
        for (k in stats) {
          if (Object.prototype.hasOwnProperty.call(stats, k)) pairs.push([k, stats[k]]);
        }
      }
    }
    var rows = [];
    for (i = 0; i < pairs.length; i++) {
      var row = statRow(pairs[i][0], pairs[i][1]);
      if (row) rows.push(row);
    }
    return rows;
  }

  function vehicleRowHTML(r) {
    var level = (r.level === 'ok' || r.level === 'crit') ? r.level : 'warn';
    var html = '<div class="vehicle-check__row">' +
      '<span>' + esc(r.label) + '</span>' +
      '<div class="gauge gauge--' + level + '">' +
        '<div class="gauge__fill" style="width:' + r.pct + '%"></div>' +
      '</div>' +
      '<span>' + esc(r.valueText) + '</span>';
    if (r.note) html += '<small>' + esc(r.note) + '</small>'; // sim's bucket copy
    return html + '</div>';
  }

  function vehicleCheckInnerHTML(m, build) {
    var html = '<h2>Vehicle Check</h2>';
    if (!SMG.sim || typeof SMG.sim.computeStats !== 'function') {
      return html + '<p class="hint">The vehicle check isn\'t available yet.</p>';
    }
    var stats = null;
    try {
      stats = SMG.sim.computeStats(build, m);
    } catch (e) {
      console.warn('[ui] computeStats failed:', e);
      return html + '<p class="hint">The vehicle check isn\'t available yet.</p>';
    }
    var rows = normalizeStats(stats);
    if (!rows.length) {
      return html + '<p class="hint">No vehicle readouts yet.</p>';
    }
    for (var i = 0; i < rows.length; i++) html += vehicleRowHTML(rows[i]);
    return html;
  }

  // --- validation hints ----------------------------------------------------

  function issuesHTML(check, ok) {
    var issues = (check && Array.isArray(check.issues)) ? check.issues : [];
    var html = '';
    for (var i = 0; i < issues.length; i++) {
      var it = issues[i];
      var s = '';
      if (typeof it === 'string') s = it;
      else if (it && typeof it === 'object') s = pick(it.message, it.text, it.hint, it.detail);
      s = txt(s);
      if (s) html += '<p>' + esc(s) + '</p>';
    }
    if (!html && !ok) {
      html = '<p>Choose one option in every control before launching.</p>';
    }
    return html;
  }

  function buildHTML(m) {
    var controls = Array.isArray(m.controls) ? m.controls : [];
    var groups = '';
    for (var i = 0; i < controls.length; i++) {
      if (controls[i] && typeof controls[i] === 'object') {
        groups += controlGroupHTML(controls[i]);
      }
    }
    if (!groups) {
      groups = '<p class="hint">This mission has no controls defined yet.</p>';
    }
    return '<div class="screen screen--build">' +
      '<div class="build"' + peAttr() + '>' +
        '<h1>' + esc(pick(m.name, 'Build Your Craft')) + '</h1>' +
        groups +
        '<div class="panel vehicle-check">' + vehicleCheckInnerHTML(m, state.build) + '</div>' +
        '<div class="hint" id="build-issues"></div>' +
        '<div class="launch-bar">' +
          '<button type="button" class="btn btn--ghost" data-go="briefing">BACK</button>' +
          '<button type="button" class="btn btn--primary" data-go="launch">LAUNCH</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // Re-reads sim.validate / sim.computeStats and refreshes the DOM in place
  // (no re-render, so keyboard focus on the clicked choice is preserved).
  function refreshBuild() {
    if (state.screen !== 'build' || !state.mission || !state.build) return;
    var app = document.getElementById('app');
    if (!app) return;
    var m = state.mission;
    var build = state.build;

    var vc = app.querySelector('.vehicle-check');
    if (vc) vc.innerHTML = vehicleCheckInnerHTML(m, build);

    var check = null;
    if (SMG.sim && typeof SMG.sim.validate === 'function') {
      try {
        check = SMG.sim.validate(build, m);
      } catch (e) {
        console.warn('[ui] validate failed:', e);
      }
    }
    var ok = !!(check && check.ok);

    var launchBtn = app.querySelector('[data-go="launch"]');
    if (launchBtn) launchBtn.disabled = !ok; // state via the disabled attribute

    var issuesEl = app.querySelector('#build-issues');
    if (issuesEl) issuesEl.innerHTML = issuesHTML(check, ok);
  }

  function onChoiceClick(btn) {
    if (state.screen !== 'build' || !state.build) return;
    var cid = btn.getAttribute('data-control');
    var oid = btn.getAttribute('data-option');
    if (!cid || !oid) return;

    state.build.choices[cid] = oid;

    var row = btn.parentNode; // the role="group" div: one notch per control
    if (row && row.querySelectorAll) {
      var siblings = row.querySelectorAll('.choice');
      for (var i = 0; i < siblings.length; i++) {
        var s = siblings[i];
        var on = (s === btn);
        s.className = on ? 'choice is-selected' : 'choice';
        s.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }

    refreshBuild();
    sceneShowPad({ missionId: state.build.missionId, choices: state.build.choices });
  }

  function ensureBuild(m) {
    var key = missionKey(m);
    if (!state.build || state.build.missionId !== key) {
      state.build = { missionId: key, choices: {} };
    }
    return state.build;
  }

  function wireBuild(m) {
    var app = document.getElementById('app');
    if (!app) return;

    var choices = app.querySelectorAll('.choice');
    for (var i = 0; i < choices.length; i++) {
      wire(choices[i], 'click', function (ev) { onChoiceClick(ev.currentTarget); });
    }

    var launchBtn = app.querySelector('[data-go="launch"]');
    if (launchBtn) launchBtn.setAttribute('aria-describedby', 'build-issues');

    var navs = app.querySelectorAll('.launch-bar [data-go]');
    for (var j = 0; j < navs.length; j++) {
      wire(navs[j], 'click', function (ev) {
        var go = ev.currentTarget.getAttribute('data-go');
        if (go === 'launch') startLaunch();
        else goBriefing(missionKey(m));
      });
    }

    refreshBuild();
  }

  function goBuild(key) {
    runId += 1;
    var missions = getMissions();
    if (!missions) { renderPlaceholder(); return; }
    var m = findMission(missions, key);
    if (!m) { goCampaign(); return; }
    if (!hasSim()) { renderPlaceholder(MSG_NO_SIM, HINT_FILES); return; }

    state.screen = 'build';
    state.mission = m;
    state.outcome = null;
    ensureBuild(m);

    if (!mount(buildHTML(m))) return;
    focusFirst('.choice');
    wireBuild(m);
    sceneShowPad({ missionId: state.build.missionId, choices: state.build.choices });
  }

  // =========================================================================
  // Screen 4 -- launch animation (scene owns every frame; sim owns the result)
  // =========================================================================

  function startLaunch() {
    var m = state.mission;
    var build = state.build;
    if (!m || !build) { goCampaign(); return; }
    if (!hasSim()) { renderPlaceholder(MSG_NO_SIM, HINT_FILES); return; }

    // Defence in depth: the LAUNCH button is disabled until validate().ok,
    // but never trust the button -- re-check before anything happens.
    var check = null;
    try {
      check = SMG.sim.validate(build, m);
    } catch (e) {
      console.warn('[ui] validate failed:', e);
      renderPlaceholder(MSG_NO_SIM, HINT_FILES);
      return;
    }
    if (!check || !check.ok) { refreshBuild(); return; }

    var outcome = null;
    try {
      outcome = SMG.sim.launch(build, m); // the ONLY source of a result
    } catch (e) {
      console.warn('[ui] sim.launch failed:', e);
      renderPlaceholder(MSG_NO_SIM, HINT_FILES);
      return;
    }
    if (!outcome || typeof outcome !== 'object') {
      renderPlaceholder(MSG_NO_SIM, HINT_FILES);
      return;
    }

    state.outcome = outcome;
    runLaunchAnimation(outcome, m);
  }

  function runLaunchAnimation(outcome, m) {
    runId += 1;
    var myRun = runId;
    var settled = false;

    // Advances to results exactly once; a stale callback from an older run
    // (myRun !== runId) is ignored, so the screen can never double-advance.
    function finish() {
      if (settled || myRun !== runId) return;
      settled = true;
      goResults();
    }

    var scene = SMG.scene;
    if (!sceneOK || !scene || typeof scene.playLaunch !== 'function') {
      finish(); // no scene: the simulation result still earns its results screen
      return;
    }

    state.screen = 'launch';
    mount(
      '<div class="launch-overlay">' +
        '<span class="sr-only" role="status">Launch sequence playing. ' +
        'Use SKIP to jump ahead.</span>' +
        '<button type="button" class="btn launch-overlay__skip"' + peAttr() +
        '>SKIP</button>' +
      '</div>'
    );
    focusFirst('.launch-overlay__skip');

    var skipBtn = document.querySelector('#app .launch-overlay__skip');
    wire(skipBtn, 'click', function () {
      try {
        if (typeof scene.skip === 'function') scene.skip();
      } catch (e) {
        console.warn('[ui] scene.skip failed:', e);
      }
      finish(); // idempotent: advances even if the scene never called onDone
    });

    try {
      scene.playLaunch(outcome, m, finish); // onDone exactly once per run
    } catch (e) {
      console.warn('[ui] scene.playLaunch failed:', e);
      finish();
    }
  }

  // =========================================================================
  // Screen 5 -- results (knowledge panel is the pedagogical payoff)
  // =========================================================================

  function resultsHTML(m, outcome, missions) {
    var win = !!outcome.ok;
    var messages = '';
    var title = win ? 'Mission Complete!' : 'So close \u2014 try again!';

    if (win) {
      var successCopy = (m.win && typeof m.win === 'object') ? txt(m.win.successCopy) : '';
      if (successCopy) {
        messages += '<p class="results__message">' + esc(successCopy) + '</p>';
      }
    } else {
      var f = outcome.failure;
      var failTitle = '';
      var failMessage = '';
      if (typeof f === 'string') {
        failMessage = txt(f);
      } else if (f && typeof f === 'object') {
        failTitle = txt(f.title);
        failMessage = txt(f.message);
      }
      if (failTitle) {
        messages += '<p class="results__message">' + esc(failTitle) + '</p>';
      }
      if (failMessage) {
        messages += '<p class="results__message">' + esc(failMessage) + '</p>';
      }
    }

    // ALWAYS the knowledge panel -- this is what the kid takes away.
    var knowledge = '';
    var k = m.knowledge;
    if (k && typeof k === 'object') {
      var kTitle = txt(k.title);
      var kText = txt(k.text);
      if (kTitle || kText) {
        knowledge = '<div class="knowledge">' +
          (kTitle ? '<h2 class="knowledge__title">' + esc(kTitle) + '</h2>' : '') +
          (kText ? '<p class="knowledge__text">' + esc(kText) + '</p>' : '') +
        '</div>';
      }
    }

    // NEXT MISSION appears only when a next mission exists and is unlocked
    // (completing mission N is exactly what unlocks N+1).
    var idx = indexOfMission(missions, m);
    var next = (idx >= 0 && idx + 1 < missions.length) ? missions[idx + 1] : null;
    var showNext = !!(win && next && isUnlocked(missions, idx + 1));

    var buttons = '';
    if (showNext) {
      buttons += '<button type="button" class="btn btn--primary" data-go="next">' +
        'NEXT MISSION</button>';
    }
    buttons += '<button type="button" class="btn' +
      (showNext ? '' : ' btn--primary') + '" data-go="retry">TRY AGAIN</button>';
    buttons += '<button type="button" class="btn btn--ghost" data-go="missions">' +
      'MISSIONS</button>';

    return '<div class="screen screen--results">' +
      '<div class="panel results ' + (win ? 'results--win' : 'results--fail') + '"' +
        peAttr() + '>' +
        '<h1 class="results__title">' + esc(title) + '</h1>' +
        messages +
        knowledge +
        '<div class="launch-bar">' + buttons + '</div>' +
      '</div>' +
    '</div>';
  }

  function wireResults(m, missions) {
    var app = document.getElementById('app');
    if (!app) return;
    var btns = app.querySelectorAll('.results [data-go]');
    for (var i = 0; i < btns.length; i++) {
      wire(btns[i], 'click', function (ev) {
        var go = ev.currentTarget.getAttribute('data-go');
        if (go === 'missions') {
          goCampaign();
        } else if (go === 'retry') {
          goBuild(missionKey(m)); // keeps the current picks for tweaking
        } else if (go === 'next') {
          var idx = indexOfMission(missions, m);
          var next = (idx >= 0 && idx + 1 < missions.length) ? missions[idx + 1] : null;
          if (next) goBriefing(missionKey(next));
          else goCampaign();
        }
      });
    }
  }

  function goResults() {
    runId += 1;
    var m = state.mission;
    var outcome = state.outcome;
    var missions = getMissions();
    if (!m || !outcome) { goCampaign(); return; }

    if (outcome.ok) markCompleted(m); // unlocks N+1 before we render

    state.screen = 'results';
    sceneShowPad(null); // idle world behind the translucent results screen
    if (!mount(resultsHTML(m, outcome, missions || []))) return;
    focusFirst('.results .btn--primary');
    wireResults(m, missions || []);
  }

  // =========================================================================
  // Entry point (called from index.html once the scripts are loaded)
  // =========================================================================

  function start() {
    if (started) return; // idempotent: never double-init or double-bind
    started = true;

    try {
      previewMode = /[?&]visualPreview=1(&|$)/.test(
        String((window.location && window.location.search) || ''));
    } catch (e) {
      previewMode = false;
    }
    if (previewMode) {
      var app0 = document.getElementById('app');
      if (app0) app0.style.pointerEvents = 'none'; // see peAttr()
    }

    initScene();       // once, guarded -- never throws
    goCampaign(true);  // no focus jump on first paint
  }

  return { start: start };
})();
