// Temporary harness for js/data.js + js/sim.js -- NOT part of the repo.
// Run: node tests/sim-test.js  (from the repo root)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = process.env.REPO || path.join(__dirname, '..');
const VOCAB = new Set([
  'pad', 'ascent', 'stage', 'coast', 'orbit', 'deploy', 'approach', 'landing',
  'crew_deploy', 'rover_deploy', 'surface_drive', 'image_capture', 'data_uplink'
]);

// --- bootstrap: a vm context where `window` IS the global object -----------
const ctx = {};
ctx.window = ctx;
vm.createContext(ctx);
function load(file) {
  const src = fs.readFileSync(REPO + '/' + file, 'utf8');
  vm.runInContext(src, ctx, { filename: file });
}
let loadError = null;
try {
  load('js/data.js');
  load('js/sim.js');
} catch (e) {
  loadError = e;
}

const SMG = ctx.SMG || {};

// --- tiny reporter ---------------------------------------------------------
let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
  if (loadError) {
    fail++;
    failures.push(name + ' — bootstrap error: ' + loadError.message);
    console.log('[FAIL] ' + name + ' — bootstrap error: ' + loadError.message);
    return;
  }
  try {
    const err = fn();
    if (err) {
      fail++;
      failures.push(name + ' — ' + err);
      console.log('[FAIL] ' + name + ' — ' + err);
    } else {
      pass++;
      console.log('[PASS] ' + name);
    }
  } catch (e) {
    fail++;
    failures.push(name + ' — threw: ' + (e && e.message));
    console.log('[FAIL] ' + name + ' — threw: ' + (e && e.message));
  }
}

// --- helpers ---------------------------------------------------------------
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function checkTimeline(tl) {
  if (!Array.isArray(tl) || tl.length === 0) return 'timeline empty/missing';
  for (let i = 0; i < tl.length; i++) {
    const e = tl[i];
    if (!e || typeof e.phase !== 'string') return 'bad phase at ' + i;
    if (!VOCAB.has(e.phase)) return 'phase "' + e.phase + '" not in vocabulary';
    if (typeof e.time !== 'number' || !isFinite(e.time)) return 'bad time at ' + i;
    if (i > 0 && !(e.time > tl[i - 1].time)) {
      return 'times not strictly increasing at ' + i + ' (' + tl[i - 1].time + ' -> ' + e.time + ')';
    }
  }
  return null;
}

function cart(mission) {
  let acc = [[]];
  for (const c of mission.controls) {
    const next = [];
    for (const prefix of acc) {
      for (const o of c.options) next.push(prefix.concat([o.id]));
    }
    acc = next;
  }
  return acc;
}

function toChoices(mission, vals) {
  const ch = {};
  mission.controls.forEach((c, i) => { ch[c.id] = vals[i]; });
  return ch;
}

function isWinChoices(mission, ch) {
  return mission.controls.every(c => ch[c.id] === mission.win.combo[c.id]);
}

function allWrongChoices(mission) {
  const ch = {};
  for (const c of mission.controls) {
    const wrong = c.options.find(o => o.id !== c.correct);
    ch[c.id] = wrong.id;
  }
  return ch;
}

// Expected failure type per SKILL.md mapping (mirrors the documented order:
// first differing control in listed order decides; M5 comboFails first).
function expectedType(mid, ch) {
  switch (mid) {
    case 'm1_lunar_landing':
      if (ch.staging !== 'dropEmpty') {
        return ch.staging === 'attached' ? 'too_heavy' : 'fuel_out';
      }
      return ch.brake === 'chute' ? 'parachute_vacuum' : 'retro_exhaust';
    case 'm2_mars_orbit':
      if (ch.flyby !== 'medium') {
        return ch.flyby === 'low' ? 'atmospheric_burn' : 'escape_trajectory';
      }
      return ch.brake === 'short' ? 'escape_trajectory' : 'gravity_well_impact';
    case 'm3_lunar_gateway':
      if (ch.zone !== 'lagrange') return 'gravity_tug';
      return 'station_drift';
    case 'm4_landsat_polar':
      if (ch.direction !== 'polar') return 'equatorial_orbit';
      return ch.altitude === 'low' ? 'drag_deorbit' : 'orbit_too_high';
    case 'm5_chandra_slingshot':
      if (ch.burn === 'apogee' && ch.nose === 'forward') return 'weak_boost';
      return 'wrong_axis_burn';
    default:
      return null;
  }
}

const sim = SMG.sim || {};
const missions = (SMG.data && Array.isArray(SMG.data.missions)) ? SMG.data.missions : [];

// ============================================================================
// 1. win combos
// ============================================================================
if (!missions.length) {
  check('data: five missions loaded', () => 'SMG.data.missions missing/empty');
} else {
  check('data: five missions loaded', () =>
    missions.length === 5 ? null : 'expected 5 missions, got ' + missions.length);
}

for (const m of missions) {
  check('win: ' + m.id + ' exact combo succeeds', () => {
    if (typeof sim.launch !== 'function') return 'SMG.sim.launch missing';
    const ch = deepClone(m.win.combo);
    const out = sim.launch({ missionId: m.id, choices: ch }, m);
    if (!out || out.ok !== true) return 'expected ok:true, got ' + JSON.stringify(out && out.ok);
    const tlErr = checkTimeline(out.timeline);
    if (tlErr) return tlErr;
    if (!Array.isArray(out.events)) return 'events not an array';
    if ('score' in out) return 'outcome must not carry score';
    if ('failure' in out && out.failure) return 'success must not carry failure';
    return null;
  });
}

// ============================================================================
// 2. every non-winning combination fails with the documented type
// ============================================================================
for (const m of missions) {
  for (const vals of cart(m)) {
    const ch = toChoices(m, vals);
    if (isWinChoices(m, ch)) continue;
    const label = 'fail: ' + m.id + ' [' + m.controls.map((c, i) => c.id + '=' + vals[i]).join(', ') + ']';
    check(label, () => {
      const out = sim.launch({ missionId: m.id, choices: deepClone(ch) }, m);
      if (!out || out.ok !== false) return 'expected ok:false';
      if (!out.failure) return 'missing failure object';
      const want = expectedType(m.id, ch);
      if (out.failure.type !== want) return 'type ' + out.failure.type + ', wanted ' + want;
      if (typeof out.failure.atPhase !== 'string' || !out.failure.atPhase) return 'missing atPhase';
      if (!VOCAB.has(out.failure.atPhase)) return 'atPhase "' + out.failure.atPhase + '" not in vocabulary';
      if (typeof out.failure.title !== 'string' || !out.failure.title.trim()) return 'empty title';
      if (typeof out.failure.message !== 'string' || !out.failure.message.trim()) return 'empty message';
      const tlErr = checkTimeline(out.timeline);
      if (tlErr) return tlErr;
      const last = out.timeline[out.timeline.length - 1];
      if (last.phase !== out.failure.atPhase) {
        return 'timeline must end on atPhase (' + last.phase + ' vs ' + out.failure.atPhase + ')';
      }
      if (!Array.isArray(out.events)) return 'events not an array';
      if ('score' in out) return 'outcome must not carry score';
      return null;
    });
  }
}

// ============================================================================
// 3. evaluation-order spot checks
// ============================================================================
const m5 = missions.find(m => m.id === 'm5_chandra_slingshot');
const m3 = missions.find(m => m.id === 'm3_lunar_gateway');
if (m5) {
  check('order: M5 apogee+forward -> weak_boost (comboFails, not wrong_axis)', () => {
    const out = sim.launch({ missionId: m5.id, choices: { burn: 'apogee', nose: 'forward' } }, m5);
    if (!out || !out.failure) return 'no failure';
    return out.failure.type === 'weak_boost' ? null : 'got ' + out.failure.type;
  });
  check('order: M5 apogee+up -> wrong_axis_burn (control walk, not safety net)', () => {
    const out = sim.launch({ missionId: m5.id, choices: { burn: 'apogee', nose: 'up' } }, m5);
    if (!out || !out.failure) return 'no failure';
    if (out.failure.type !== 'wrong_axis_burn') return 'got ' + out.failure.type;
    if (out.failure.type === 'mission_fail') return 'safety net must not trigger';
    return null;
  });
}
if (m3) {
  check('order: M3 earth+off -> gravity_tug (control order, not station_drift)', () => {
    const out = sim.launch({ missionId: m3.id, choices: { zone: 'earth', rcs: 'off' } }, m3);
    if (!out || !out.failure) return 'no failure';
    return out.failure.type === 'gravity_tug' ? null : 'got ' + out.failure.type;
  });
  check('order: M3 lagrange+off -> station_drift', () => {
    const out = sim.launch({ missionId: m3.id, choices: { zone: 'lagrange', rcs: 'off' } }, m3);
    if (!out || !out.failure) return 'no failure';
    return out.failure.type === 'station_drift' ? null : 'got ' + out.failure.type;
  });
}

// ============================================================================
// 4. validate
// ============================================================================
if (missions.length) {
  const m1 = missions[0];
  check('validate: missing pick -> ok:false with readable issue', () => {
    const res = sim.validate({ missionId: m1.id, choices: { staging: 'dropEmpty' } }, m1);
    if (!res || res.ok !== false) return 'expected ok:false';
    if (!Array.isArray(res.issues) || res.issues.length !== 1) return 'expected 1 issue';
    const issue = String(res.issues[0]);
    if (issue.indexOf('Moon Landing Brake') === -1) return 'issue not readable: ' + issue;
    if (issue.indexOf('Pick a setting') === -1) return 'issue not readable: ' + issue;
    return null;
  });
  check('validate: all picks present -> ok:true, no issues', () => {
    const res = sim.validate({ missionId: m1.id, choices: deepClone(m1.win.combo) }, m1);
    if (!res || res.ok !== true) return 'expected ok:false? got ok=' + (res && res.ok);
    if (!Array.isArray(res.issues) || res.issues.length !== 0) return 'expected no issues';
    return null;
  });
  check('validate: empty build -> ok:false without throwing', () => {
    const res = sim.validate({}, m1);
    return (res && res.ok === false && Array.isArray(res.issues)) ? null : 'bad result';
  });
}
check('validate: null inputs -> ok:false without throwing', () => {
  const res = sim.validate(null, null);
  return (res && res.ok === false && Array.isArray(res.issues)) ? null : 'bad result';
});

// ============================================================================
// 5. computeStats
// ============================================================================
const GARBAGE = [
  () => sim.computeStats(null, null),
  () => sim.computeStats(undefined, undefined),
  () => sim.computeStats(42, 42),
  () => sim.computeStats('nonsense', 'nonsense'),
  () => sim.computeStats({}, {}),
  () => sim.computeStats({ choices: null }, null),
  () => sim.computeStats({ choices: 'x' }, { id: 'nope' }),
  () => sim.computeStats({ missionId: 'nope', choices: { a: {} } }, null)
];
check('stats: never throws on garbage input, always a shaped array', () => {
  for (const fn of GARBAGE) {
    const s = fn();
    if (!Array.isArray(s) || s.length === 0) return 'not an array';
    for (const st of s) {
      if (typeof st.id !== 'string' || typeof st.label !== 'string') return 'bad stat shape';
      if (typeof st.value !== 'number' || st.value < 0 || st.value > 100) return 'value out of 0-100';
      if (!['ok', 'warn', 'crit'].includes(st.bucket)) return 'bad bucket ' + st.bucket;
      if (typeof st.note !== 'string' || !st.note.length) return 'empty note';
    }
  }
  return null;
});

for (const m of missions) {
  check('stats: ' + m.id + ' all combos well-formed, no win leak', () => {
    const combos = cart(m);
    const seen = { mass: {}, fuel: {}, stability: {} };
    let winStats = null, wrongStats = null;
    for (const vals of combos) {
      const ch = toChoices(m, vals);
      const s = sim.computeStats({ missionId: m.id, choices: ch }, m);
      if (!Array.isArray(s) || s.length !== 3) return 'expected 3 stats';
      const byId = {};
      for (const st of s) {
        if (typeof st.value !== 'number' || st.value < 0 || st.value > 100) return 'value out of 0-100';
        if (!['ok', 'warn', 'crit'].includes(st.bucket)) return 'bad bucket';
        if (/risk|win|fail|chance|success|prob/i.test(String(st.note) + String(st.label))) {
          return 'stat leaks outcome: ' + st.note;
        }
        byId[st.id] = st;
      }
      for (const id of ['mass', 'fuel', 'stability']) {
        if (!byId[id]) return 'missing stat ' + id;
        seen[id][byId[id].bucket] = seen[id][byId[id].bucket] || { win: 0, lose: 0 };
        seen[id][byId[id].bucket][isWinChoices(m, ch) ? 'win' : 'lose']++;
      }
      const key = JSON.stringify(s);
      if (isWinChoices(m, ch)) winStats = key;
      if (JSON.stringify(ch) === JSON.stringify(allWrongChoices(m))) wrongStats = key;
    }
    // winning stats must not be trivially identical to all-wrong stats
    if (winStats && wrongStats && winStats === wrongStats) {
      return 'win stats identical to all-wrong stats';
    }
    // no single stat's bucket may perfectly correlate with winning:
    // every stat must be "ok" for at least one losing combo.
    for (const id of ['mass', 'fuel', 'stability']) {
      const ok = seen[id].ok;
      if (!ok || !ok.lose) return 'stat ' + id + ' is "ok" only for wins (leaks the answer)';
    }
    return null;
  });
}

// ============================================================================
// 6. launch safety: unknown mission / missing choices
// ============================================================================
const SAFETY = [
  ['launch(null, null)', () => sim.launch(null, null)],
  ['launch({}, null)', () => sim.launch({}, null)],
  ['launch unknown missionId', () => sim.launch({ missionId: 'nope_not_a_mission', choices: {} }, null)],
  ['launch unknown mission object', () => sim.launch({}, { id: 'also_not_a_mission' })],
  ['launch missing choices on real mission', () =>
    missions.length ? sim.launch({ missionId: missions[0].id }, missions[0]) : sim.launch({}, null)]
];
for (const [name, fn] of SAFETY) {
  check('safety: ' + name + ' -> well-formed mission_fail, no throw', () => {
    const out = fn();
    if (!out || out.ok !== false) return 'expected ok:false';
    if (!out.failure || out.failure.type !== 'mission_fail') {
      return 'expected mission_fail, got ' + (out.failure && out.failure.type);
    }
    if (typeof out.failure.title !== 'string' || !out.failure.title) return 'missing title';
    if (typeof out.failure.message !== 'string' || !out.failure.message) return 'missing message';
    if (!out.failure.atPhase) return 'missing atPhase';
    const tlErr = checkTimeline(out.timeline);
    if (tlErr) return tlErr;
    if (!Array.isArray(out.events)) return 'events not an array';
    return null;
  });
}

// --- purity + determinism --------------------------------------------------
if (missions.length) {
  check('purity: launch does not mutate build or mission', () => {
    const m = missions[0];
    const build = { missionId: m.id, choices: { staging: 'attached', brake: 'blast' } };
    const b0 = JSON.stringify(build), m0 = JSON.stringify(m);
    sim.launch(build, m);
    sim.computeStats(build, m);
    sim.validate(build, m);
    if (JSON.stringify(build) !== b0) return 'build mutated';
    if (JSON.stringify(m) !== m0) return 'mission mutated';
    return null;
  });
  check('determinism: same inputs -> deep-equal outcomes', () => {
    for (const m of missions) {
      const ch = isWinChoices(m, m.win.combo) ? deepClone(m.win.combo) : allWrongChoices(m);
      const a = sim.launch({ missionId: m.id, choices: ch }, m);
      const b = sim.launch({ missionId: m.id, choices: ch }, m);
      if (JSON.stringify(a) !== JSON.stringify(b)) return 'non-deterministic for ' + m.id;
    }
    return null;
  });
}

// ============================================================================
console.log('');
console.log('FAILURES (' + fail + '):');
if (failures.length === 0) console.log('  (none)');
for (const f of failures) console.log('  - ' + f);
console.log('');
console.log('TOTAL: ' + (pass + fail) + ' cases, PASS: ' + pass + ', FAIL: ' + fail);
process.exit(fail === 0 ? 0 : 1);
