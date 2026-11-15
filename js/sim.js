// ---------------------------------------------------------------------------
// sim.js -- pure simulation logic: validate / computeStats / launch.
//
// No DOM, no THREE, no randomness, no dates. Same inputs -> same output.
// Never mutates build or mission. Attaches to the shared SMG namespace.
//
// Evaluation order (SKILL.md "Mission design (v2)", shared rules):
//   1. every control matches win.combo            -> success
//   2. else first matching comboFails key         -> that failure
//   3. else walk controls in order; the first
//      control that differs from the win combo
//      and HAS a fails["controlId:optionId"]
//      entry determines the failure (entries
//      are skipped when absent, e.g. Mission 5's
//      burn:apogee, which only fails in
//      combination)
//   4. else safety net                            -> mission_fail
// ---------------------------------------------------------------------------

window.SMG = window.SMG || {};

SMG.sim = (function () {
  'use strict';

  // Base timestamps for each phase (strictly increasing along any subsequence).
  var PHASE_TIME = {
    pad: 0, ascent: 1, stage: 3, coast: 6,
    approach: 9, orbit: 12, deploy: 15, landing: 16
  };

  // Generic timeline used when no mission can be resolved at all.
  var GENERIC_PHASES = ['pad', 'ascent', 'coast', 'orbit'];
  var GENERIC_AT_PHASE = 'orbit';

  var DEFAULT_FAILURE = {
    type: 'mission_fail',
    title: 'A Small Setback',
    message: 'Something did not go as planned this time -- check the settings and try again.'
  };

  // -- small helpers --------------------------------------------------------

  function isObj(v) {
    return v !== null && typeof v === 'object';
  }

  function hasOwn(o, k) {
    return isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
  }

  function isNonEmptyStr(v) {
    return typeof v === 'string' && v.length > 0;
  }

  function dataRoot() {
    return (typeof SMG !== 'undefined' && isObj(SMG.data)) ? SMG.data : null;
  }

  function missionById(id) {
    var d = dataRoot();
    if (!d || !Array.isArray(d.missions) || !isNonEmptyStr(id)) return null;
    for (var i = 0; i < d.missions.length; i++) {
      var m = d.missions[i];
      if (isObj(m) && m.id === id) return m;
    }
    return null;
  }

  function failureLib(type) {
    var d = dataRoot();
    if (!d || !isObj(d.failures)) return null;
    var e = d.failures[type];
    return isObj(e) ? e : null;
  }

  // Resolve the mission: a passed object wins when it looks like a mission;
  // otherwise look it up (by string id, object id, or build.missionId).
  function resolveMission(mission, build) {
    if (typeof mission === 'string') return missionById(mission);
    if (isObj(mission)) {
      if (Array.isArray(mission.controls)) {
        // Prefer the full data copy when the passed object shares its id.
        if (isNonEmptyStr(mission.id)) {
          var byId = missionById(mission.id);
          if (byId) return byId;
        }
        return mission;
      }
      if (isNonEmptyStr(mission.id)) return missionById(mission.id);
    }
    if (isObj(build) && isNonEmptyStr(build.missionId)) {
      return missionById(build.missionId);
    }
    return null;
  }

  function choicesOf(build) {
    return (isObj(build) && isObj(build.choices)) ? build.choices : {};
  }

  function controlsOf(m) {
    return (isObj(m) && Array.isArray(m.controls)) ? m.controls : [];
  }

  function winComboOf(m) {
    return (isObj(m) && isObj(m.win) && isObj(m.win.combo)) ? m.win.combo : null;
  }

  function hasControl(m, id) {
    var cs = controlsOf(m);
    for (var i = 0; i < cs.length; i++) {
      if (isObj(cs[i]) && cs[i].id === id) return true;
    }
    return false;
  }

  // -- timeline construction ------------------------------------------------

  // The mission's full success path, derived only from mission shape:
  //   pad -> ascent -> [stage when the mission has a staging control, e.g. M1]
  //        -> coast  -> [approach for Moon/Mars destinations]
  //        -> orbit  -> [deploy for payload placement (M3/M4);
  //                      landing instead for the Moon landing (M1)]
  function successPhases(m) {
    var phases = ['pad', 'ascent'];
    if (hasControl(m, 'staging')) phases.push('stage');
    phases.push('coast');
    var d = (isObj(m) && isNonEmptyStr(m.destinationId)) ? m.destinationId : '';
    if (d === 'moon' || d === 'mars') phases.push('approach');
    phases.push('orbit');
    if (d === 'earth_moon' || d === 'earth_orbit') phases.push('deploy');
    else if (d === 'moon') phases.push('landing');
    return phases;
  }

  function timeFor(phase, prevTime) {
    var t = PHASE_TIME[phase];
    if (typeof t === 'number' && t > prevTime) return t;
    return prevTime + 1;
  }

  function buildTimeline(phases) {
    var out = [];
    var prev = -1;
    for (var i = 0; i < phases.length; i++) {
      var t = timeFor(phases[i], prev);
      out.push({ phase: phases[i], time: t });
      prev = t;
    }
    return out;
  }

  // Timeline that runs pad -> ... -> the phase where the failure bites,
  // always ending ON failure.atPhase (appended if the phase isn't already
  // part of the mission's success path).
  function failureTimeline(m, atPhase) {
    var phases = m ? successPhases(m) : GENERIC_PHASES;
    var idx = -1;
    for (var i = 0; i < phases.length; i++) {
      if (phases[i] === atPhase) { idx = i; break; }
    }
    var out = idx >= 0 ? phases.slice(0, idx + 1) : phases.slice();
    if (!out.length || out[out.length - 1] !== atPhase) out.push(atPhase);
    return buildTimeline(out);
  }

  // -- outcome builders -----------------------------------------------------

  function successOutcome(m) {
    return {
      ok: true,
      timeline: buildTimeline(successPhases(m)),
      events: []
    };
  }

  // entry: a mission fails/comboFails record, or null for the safety net.
  function failureOutcome(m, entry) {
    var e = isObj(entry) ? entry : null;
    var type = (e && isNonEmptyStr(e.type)) ? e.type : DEFAULT_FAILURE.type;
    var lib = failureLib(type);
    var atPhase = (e && isNonEmptyStr(e.atPhase)) ? e.atPhase : GENERIC_AT_PHASE;
    var title = (e && isNonEmptyStr(e.title)) ? e.title :
      (lib && isNonEmptyStr(lib.title)) ? lib.title : DEFAULT_FAILURE.title;
    var message = (e && isNonEmptyStr(e.message)) ? e.message :
      (lib && isNonEmptyStr(lib.message)) ? lib.message : DEFAULT_FAILURE.message;
    return {
      ok: false,
      timeline: failureTimeline(m, atPhase),
      failure: { type: type, title: title, message: message, atPhase: atPhase },
      events: []
    };
  }

  // -- evaluation -----------------------------------------------------------

  function isWin(m, choices) {
    var combo = winComboOf(m);
    var cs = controlsOf(m);
    if (!combo || !cs.length) return false;
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (!isObj(c) || !isNonEmptyStr(c.id)) return false;
      var v = combo[c.id];
      if (!isNonEmptyStr(v)) return false;
      if (choices[c.id] !== v) return false;
    }
    return true;
  }

  // comboFails key: 'controlId:optionId|controlId:optionId' -- all parts must
  // match the player's choices.
  function matchesComboKey(key, choices) {
    if (!isNonEmptyStr(key)) return false;
    var parts = key.split('|');
    if (!parts.length) return false;
    for (var i = 0; i < parts.length; i++) {
      var sep = parts[i].indexOf(':');
      if (sep <= 0) return false;
      var id = parts[i].slice(0, sep);
      var opt = parts[i].slice(sep + 1);
      if (!isNonEmptyStr(opt) || choices[id] !== opt) return false;
    }
    return true;
  }

  // -- public API -----------------------------------------------------------

  function validate(build, mission) {
    var issues = [];
    try {
      var m = resolveMission(mission, build);
      if (!m || !controlsOf(m).length) {
        return { ok: false, issues: ['Mission settings could not be loaded.'] };
      }
      var choices = choicesOf(build);
      var cs = controlsOf(m);
      for (var i = 0; i < cs.length; i++) {
        var c = cs[i];
        if (!isObj(c)) continue;
        var label = isNonEmptyStr(c.label) ? c.label :
          (isNonEmptyStr(c.id) ? c.id : 'every setting');
        var pick = choices[c.id];
        if (pick === undefined || pick === null || pick === '') {
          issues.push('Pick a setting for ' + label);
        }
      }
      return { ok: issues.length === 0, issues: issues };
    } catch (e) {
      return {
        ok: false,
        issues: ['Pick a setting for every control before launch.']
      };
    }
  }

  // Descriptive vehicle readouts only -- never a win prediction.
  // Buckets are derived from physical-sounding option traits, so no single
  // stat's bucket ever lines up with the winning combo across all controls.
  var MASS_DELTA = {
    attached: 28, drop50: -2, dropEmpty: -6,
    chute: 7, retro: 3, blast: 9
  };
  var FUEL_DELTA = {
    drop50: -22, blast: -28, retro: -8,
    short: 6, balanced: -12, full: -24, low: -18
  };
  var STABILITY_DELTA = {
    up: -30, off: -18, low: -14, east: -6
  };

  var MASS_NOTES = {
    ok: 'A healthy weight for launch.',
    warn: 'Some extra weight riding along.',
    crit: 'Really heavy -- the engines have to work hard.'
  };
  var FUEL_NOTES = {
    ok: 'Plenty of fuel in the tanks.',
    warn: 'Fuel is getting tight.',
    crit: 'Very little fuel left in the tanks.'
  };
  var STABILITY_NOTES = {
    ok: 'The craft is sitting steady.',
    warn: 'A bit wobbly on its path.',
    crit: 'Badly off balance for its route.'
  };

  function clamp0100(v) {
    if (typeof v !== 'number' || isNaN(v)) return 0;
    if (v < 0) return 0;
    if (v > 100) return 100;
    return Math.round(v);
  }

  // bucket for stats where a HIGHER value is worse (mass)
  function bucketHeavy(v) {
    if (v >= 75) return 'crit';
    if (v >= 55) return 'warn';
    return 'ok';
  }
  // bucket for stats where a LOWER value is worse (fuel, stability)
  function bucketLow(v, warnAt, critBelow) {
    if (v < critBelow) return 'crit';
    if (v < warnAt) return 'warn';
    return 'ok';
  }

  function sumDelta(table, picks) {
    var total = 0;
    for (var i = 0; i < picks.length; i++) {
      var d = table[picks[i]];
      if (typeof d === 'number') total += d;
    }
    return total;
  }

  function picksFor(build, mission) {
    var choices = choicesOf(build);
    var m = resolveMission(mission, build);
    var out = [];
    if (m && controlsOf(m).length) {
      var cs = controlsOf(m);
      for (var i = 0; i < cs.length; i++) {
        if (isObj(cs[i]) && choices[cs[i].id] !== undefined) {
          out.push(choices[cs[i].id]);
        }
      }
    } else {
      for (var k in choices) {
        if (hasOwn(choices, k)) out.push(choices[k]);
      }
    }
    return out;
  }

  function stat(id, label, value, bucket, notes) {
    return {
      id: id,
      label: label,
      value: value,
      bucket: bucket,
      note: notes[bucket] || ''
    };
  }

  function computeStats(build, mission) {
    try {
      var picks = picksFor(build, mission);
      var massV = clamp0100(42 + sumDelta(MASS_DELTA, picks));
      var fuelV = clamp0100(68 + sumDelta(FUEL_DELTA, picks));
      var stabV = clamp0100(62 + sumDelta(STABILITY_DELTA, picks));
      return [
        stat('mass', 'Mass', massV, bucketHeavy(massV), MASS_NOTES),
        stat('fuel', 'Fuel', fuelV, bucketLow(fuelV, 45, 25), FUEL_NOTES),
        stat('stability', 'Stability', stabV, bucketLow(stabV, 55, 40), STABILITY_NOTES)
      ];
    } catch (e) {
      return [
        stat('mass', 'Mass', 42, 'ok', MASS_NOTES),
        stat('fuel', 'Fuel', 68, 'ok', FUEL_NOTES),
        stat('stability', 'Stability', 62, 'ok', STABILITY_NOTES)
      ];
    }
  }

  function launch(build, mission) {
    try {
      var m = resolveMission(mission, build);
      var choices = choicesOf(build);

      // No usable mission -> well-formed generic mission_fail.
      if (!m || !controlsOf(m).length) {
        return failureOutcome(null, null);
      }

      // (1) win combo -> success
      if (isWin(m, choices)) return successOutcome(m);

      // (2) comboFails -- exact multi-control keys, first defined match wins
      if (isObj(m.comboFails)) {
        for (var key in m.comboFails) {
          if (!hasOwn(m.comboFails, key)) continue;
          var cf = m.comboFails[key];
          if (isObj(cf) && matchesComboKey(key, choices)) {
            return failureOutcome(m, cf);
          }
        }
      }

      // (3) walk controls in order; first control that differs from the win
      // combo AND has a fails entry decides. Controls without an entry are
      // skipped (Mission 5's burn:apogee only fails in combination).
      var combo = winComboOf(m) || {};
      var fails = isObj(m.fails) ? m.fails : {};
      var cs = controlsOf(m);
      for (var i = 0; i < cs.length; i++) {
        var c = cs[i];
        if (!isObj(c) || !isNonEmptyStr(c.id)) continue;
        var pick = choices[c.id];
        if (pick === combo[c.id] && isNonEmptyStr(combo[c.id])) continue;
        var entry = fails[c.id + ':' + pick];
        if (isObj(entry) && isNonEmptyStr(entry.type)) {
          return failureOutcome(m, entry);
        }
      }

      // (4) safety net -- generic but well-formed
      return failureOutcome(m, null);
    } catch (e) {
      try {
        return failureOutcome(null, null);
      } catch (e2) {
        return {
          ok: false,
          timeline: [
            { phase: 'pad', time: 0 },
            { phase: 'ascent', time: 1 },
            { phase: 'coast', time: 6 },
            { phase: 'orbit', time: 12 }
          ],
          failure: {
            type: DEFAULT_FAILURE.type,
            title: DEFAULT_FAILURE.title,
            message: DEFAULT_FAILURE.message,
            atPhase: GENERIC_AT_PHASE
          },
          events: []
        };
      }
    }
  }

  return {
    computeStats: computeStats,
    validate: validate,
    launch: launch
  };
})();
