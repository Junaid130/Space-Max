/**
 * ============================================================================
 * Space-Max — Simulation module (js/sim.js)
 * ============================================================================
 * Public API (frozen by the Simulation Handoff contract):
 *
 *   window.SMG = window.SMG || {};
 *   SMG.sim = { computeStats, validate, launch, _selfTest };
 *
 * Outcome structure (frozen — field names must never change):
 *
 *   {
 *     success,
 *     failure: null | { type, altitudeKm, timeS, stage, numbers },
 *     stats: {
 *       totalMassKg, thrustKN, weightKN, twr, powerBalanceW,
 *       cost, fuelLeftPct, deltaVAvailable, deltaVNeeded        // 9 stats
 *     },
 *     events: [ { type, atS, recovered } ],
 *     score: { total, passed,
 *              parts: { base, budgetBonus, massBonus,
 *                       sparePowerBonus, spareFuelBonus, eventPenalty } },
 *     timeline: [ { t, altitudeKm, phase } ]
 *   }
 *
 * Seven mission failure types (all testable):
 *   thrust_low, fuel_out, power_short, over_budget, over_mass,
 *   sensor_fault, stage_fail
 *
 * Validation-class failure types (pre-launch only, NOT mission failures):
 *   invalid_build, rocket_not_allowed, engine_limit
 *
 * Data schema consumed from data.js (agreed interface, implemented by
 * Person 1 — sim.js reads it defensively and never invents missing values):
 *   SMG.data = {
 *     missions, rockets, components, fuelCostPerKg,
 *     getMission(id), getRocket(id), getComponent(id)
 *   }
 *   rocket.engine = { id, name, massKg, cost, powerDrawW }   // per engine
 *   rocket.thrustKN = thrust PER ENGINE
 *   mission.stageSeparationAltitudeKm  (targetAltitudeKm > 0 and 0 <= value < targetAltitudeKm)
 *
 * Purity: no DOM, no Three.js, no localStorage, no external dependencies,
 * no Math.random(), no Date.now(). Deterministic seeded randomness only.
 * ============================================================================
 */
(function (root) {
  "use strict";

  if (typeof window !== "undefined") {
    window.SMG = window.SMG || {};
  }
  root.SMG = root.SMG || {};

  /* ==========================================================================
   * TUNING CONSTANTS — all configurable in one place.
   * Assumptions documented inline; values may be tuned in playtesting
   * without touching any logic.
   * ========================================================================== */

  // Physics-ish presentation constants
  var G_KN_PER_KG = 0.00981;          // standard gravity → weight in kilonewtons
  var MIN_TWR = 1.0;                  // AGREED: twr < 1.0 triggers thrust_low

  // Arcade delta-v model (AGREED formulas — NOT the Tsiolkovsky equation):
  //   deltaVAvailable = DELTA_V_K * fuelKg / totalMassKg * thrustFactor
  //   deltaVNeeded    = DELTA_V_BASE + DELTA_V_PER_KM * targetAltitudeKm
  var DELTA_V_K = 9000;               // ASSUMPTION: arcade scale factor
  var DELTA_V_BASE = 2000;            // ASSUMPTION: baseline delta-v requirement
  var DELTA_V_PER_KM = 15;            // ASSUMPTION: requirement per km of altitude
  var THRUST_FACTOR_REF_KN = 1000;    // ASSUMPTION: thrustFactor = thrustKN / REF

  // Scoring weights (fractions of mission.maxScore; success runs only).
  // ASSUMPTION: weights sum to 1.0 so total never structurally exceeds maxScore.
  var BASE_K = 0.5;
  var BUDGET_K = 0.15;
  var MASS_K = 0.15;
  var POWER_K = 0.10;
  var FUEL_K = 0.10;
  var EVENT_PENALTY = 50;             // per incident event (success runs have none)

  // Phase durations in seconds. ASSUMPTION: mission data carries no duration
  // fields, so the timeline uses these configurable constants.
  var PAD_S = 10;
  var ASCENT_S = 480;
  var STAGE_SEP_S = 15;
  var COAST_S = 600;
  var ORBIT_S = 60;

  var PHASES = ["pad", "ascent", "stage_separation", "coast", "orbit"];

  /* ==========================================================================
   * Small numeric / object helpers (all NaN/Infinity safe)
   * ========================================================================== */

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  // Finite number or fallback (0 by default). Never returns NaN/Infinity.
  function num(v, fallback) {
    return isNum(v) ? v : (fallback === undefined ? 0 : fallback);
  }

  // Non-negative finite number or 0.
  function nn(v) {
    return isNum(v) && v > 0 ? v : 0;
  }

  function clamp(v, lo, hi) {
    if (!isNum(v)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function clamp01(v) {
    return clamp(v, 0, 1);
  }

  // Final safety net: any non-finite number becomes 0.
  function finite(v) {
    return isNum(v) ? v : 0;
  }

  function isPlainObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function safeStr(v, fallback) {
    if (typeof v === "string") return v;
    if (isNum(v) || typeof v === "boolean") return String(v);
    return fallback === undefined ? "" : fallback;
  }

  /* ==========================================================================
   * Deterministic seeded randomness
   *   seed  = FNV-1a hash of stable-stringified (build + mission)
   *   PRNG  = mulberry32
   * Identical inputs always produce an identical random sequence.
   * ========================================================================== */

  function stableStringify(v) {
    if (v === null || typeof v !== "object") {
      var s = JSON.stringify(v);
      return s === undefined ? "null" : s;
    }
    if (Array.isArray(v)) {
      return "[" + v.map(stableStringify).join(",") + "]";
    }
    var keys = Object.keys(v).sort();
    return "{" + keys.map(function (k) {
      return JSON.stringify(k) + ":" + stableStringify(v[k]);
    }).join(",") + "}";
  }

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRng(build, mission) {
    var seedInput = stableStringify(build) + "|" + stableStringify(mission);
    return mulberry32(fnv1a(seedInput));
  }

  /* ==========================================================================
   * Data access
   *   - runtime reads SMG.data (provided by data.js / Person 1)
   *   - _selfTest injects an isolated synthetic fixture that takes priority,
   *     so self-tests never depend on (or touch) real game data
   * ========================================================================== */

  var testFixture = null;   // only set while _selfTest() runs; restored after

  function dataSrc() {
    if (testFixture) return testFixture;
    return (root.SMG && root.SMG.data) || null;
  }

  function getRocket(id) {
    var d = dataSrc();
    if (!d || typeof id !== "string") return null;
    if (typeof d.getRocket === "function") return d.getRocket(id) || null;
    var arr = Array.isArray(d.rockets) ? d.rockets : [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === id) return arr[i];
    }
    return null;
  }

  function getComponent(id) {
    var d = dataSrc();
    if (!d || typeof id !== "string") return null;
    if (typeof d.getComponent === "function") return d.getComponent(id) || null;
    var arr = Array.isArray(d.components) ? d.components : [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === id) return arr[i];
    }
    return null;
  }

  function getFuelCostPerKg() {
    var d = dataSrc();
    if (!d) return 0;
    var p = d.fuelCostPerKg;
    return isNum(p) && p >= 0 ? p : 0;   // missing/invalid price → 0 (documented)
  }

  // Defensive only: validate() REJECTS unknown component IDs, so a valid
  // launch can never reach computeStats with unresolved components.
  function resolveComponents(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var c = getComponent(list[i]);
      if (c) out.push(c);
    }
    return out;
  }

  /* ==========================================================================
   * computeStats(build, mission)
   * Pure, zero randomness. Returns EXACTLY the 9 agreed stats, all finite.
   *
   * Accounting rules (agreed):
   *   - rocket.thrustKN is thrust PER ENGINE  → thrustKN = thrustKN * engineCount
   *   - rocket.engine.powerDrawW is per engine → draw = powerDrawW * engineCount
   *   - engine mass/cost scale with build.engineCount
   *   - fuel cost  = build.fuelKg * data.fuelCostPerKg
   *   - rocket.dryMassKg / rocket.cost exclude engines, fuel and components
   *     (no double-counting — enforced by data.js, asserted by _selfTest)
   * ========================================================================== */
  function computeStats(build, mission) {
    build = isPlainObj(build) ? build : {};
    mission = isPlainObj(mission) ? mission : {};

    var rocket = getRocket(build.rocketId);
    var engine = (rocket && isPlainObj(rocket.engine)) ? rocket.engine : {};

    var engineCount = isNum(build.engineCount) && build.engineCount > 0 ? build.engineCount : 0;
    var fuelKg = nn(build.fuelKg);

    var eMass = nn(engine.massKg) * engineCount;
    var eCost = nn(engine.cost) * engineCount;
    var ePower = nn(engine.powerDrawW) * engineCount;
    var fuelCost = fuelKg * getFuelCostPerKg();

    var comps = resolveComponents(build.components);
    var compMass = 0, compDraw = 0, compGen = 0, compCost = 0;
    for (var i = 0; i < comps.length; i++) {
      compMass += nn(comps[i].massKg);
      compDraw += nn(comps[i].powerDrawW);
      compGen += nn(comps[i].powerGenW);
      compCost += nn(comps[i].cost);
    }

    var payloadMassKg = nn(mission.payloadMassKg);
    var dryMassKg = rocket ? nn(rocket.dryMassKg) : 0;
    var rocketCost = rocket ? nn(rocket.cost) : 0;
    var maxFuelKg = rocket ? nn(rocket.maxFuelKg) : 0;
    var thrustPerEngineKN = rocket ? nn(rocket.thrustKN) : 0;

    var totalMassKg = dryMassKg + eMass + fuelKg + payloadMassKg + compMass;
    var thrustKN = thrustPerEngineKN * engineCount;
    var weightKN = totalMassKg * G_KN_PER_KG;
    var twr = weightKN > 0 ? thrustKN / weightKN : 0;
    var powerBalanceW = compGen - compDraw - ePower;
    var cost = rocketCost + eCost + fuelCost + compCost;
    var fuelLeftPct = maxFuelKg > 0 ? clamp((fuelKg / maxFuelKg) * 100, 0, 100) : 0;

    var deltaVNeeded = DELTA_V_BASE + DELTA_V_PER_KM * nn(mission.targetAltitudeKm);
    var thrustFactor = THRUST_FACTOR_REF_KN > 0 ? thrustKN / THRUST_FACTOR_REF_KN : 0;
    var deltaVAvailable = totalMassKg > 0
      ? DELTA_V_K * fuelKg / totalMassKg * thrustFactor
      : 0;

    return {
      totalMassKg: finite(totalMassKg),
      thrustKN: finite(thrustKN),
      weightKN: finite(weightKN),
      twr: finite(twr),
      powerBalanceW: finite(powerBalanceW),
      cost: finite(cost),
      fuelLeftPct: finite(fuelLeftPct),
      deltaVAvailable: finite(deltaVAvailable),
      deltaVNeeded: finite(deltaVNeeded)
    };
  }

  /* ==========================================================================
   * validate(build, mission)
   * Static pre-launch gate, zero randomness.
   * Returns { ok, violations: [{ type, reason, numbers }] }.
    *
    * Fixed check order:
    *   input sanity (invalid_build) → over_budget → over_mass
    *   → rocket_not_allowed → engine_limit
    * Input sanity also validates required game data (rocket/engine fields,
    * selected component fields, data.fuelCostPerKg), fuel capacity
    * (fuelKg <= rocket.maxFuelKg) and component ID resolution — any missing,
    * negative or non-finite required value yields invalid_build; it is never
    * silently treated as zero during a valid launch.
    * Boundary semantics: cost == budget passes, mass == maxMassKg passes,
    * fuelKg == rocket.maxFuelKg passes; targetAltitudeKm must be > 0 and
    * stageSeparationAltitudeKm must be strictly less than targetAltitudeKm.
    * ========================================================================== */

  // Required data fields must be finite numbers >= 0.
  function validDataField(v) {
    return isNum(v) && v >= 0;
  }

  // Names of fields that are missing, non-finite or negative.
  function badFields(obj, fields) {
    var out = [];
    if (!isPlainObj(obj)) return fields.slice();
    for (var i = 0; i < fields.length; i++) {
      if (!validDataField(obj[fields[i]])) out.push(fields[i]);
    }
    return out;
  }

  function viol(type, reason, numbers) {
    return { type: type, reason: safeStr(reason, ""), numbers: numbers || {} };
  }

  function validate(build, mission) {
    var violations = [];

    if (!isPlainObj(build)) {
      violations.push(viol("invalid_build", "build must be an object"));
      return { ok: false, violations: violations };
    }
    if (!isPlainObj(mission)) {
      violations.push(viol("invalid_build", "mission must be an object"));
      return { ok: false, violations: violations };
    }

    var bad = false;

    // --- input sanity: build -------------------------------------------------
    var rocket = null;
    if (typeof build.rocketId !== "string" || !getRocket(build.rocketId)) {
      violations.push(viol(
        "invalid_build",
        "rocketId is missing or unknown: " + safeStr(build.rocketId, "<invalid>"),
        { rocketId: safeStr(build.rocketId, "<invalid>") }
      ));
      bad = true;
    } else {
      rocket = getRocket(build.rocketId);
      // required rocket + engine data: present, finite, non-negative
      var rocketIssues = badFields(rocket, ["thrustKN", "dryMassKg", "maxFuelKg", "maxEngines", "cost"]);
      if (!isPlainObj(rocket.engine)) {
        rocketIssues.push("engine");
      } else {
        badFields(rocket.engine, ["massKg", "cost", "powerDrawW"]).forEach(function (f) {
          rocketIssues.push("engine." + f);
        });
      }
      if (rocketIssues.length > 0) {
        violations.push(viol(
          "invalid_build",
          "rocket '" + safeStr(rocket.id, "?") + "' has missing/invalid required data: " + rocketIssues.join(", "),
          { rocketId: safeStr(rocket.id, "?"), invalidFields: rocketIssues.join(", ") }
        ));
        bad = true;
      }
    }
    if (!isNum(build.engineCount) || build.engineCount < 0 || Math.floor(build.engineCount) !== build.engineCount) {
      violations.push(viol(
        "invalid_build",
        "engineCount must be a non-negative integer, got: " + safeStr(build.engineCount, "<invalid>"),
        { engineCount: isNum(build.engineCount) ? build.engineCount : 0 }
      ));
      bad = true;
    }
    if (!isNum(build.fuelKg) || build.fuelKg < 0) {
      violations.push(viol(
        "invalid_build",
        "fuelKg must be a non-negative number, got: " + safeStr(build.fuelKg, "<invalid>"),
        { fuelKg: isNum(build.fuelKg) ? Math.max(build.fuelKg, 0) : 0 }
      ));
      bad = true;
    } else if (rocket && validDataField(rocket.maxFuelKg) && build.fuelKg > rocket.maxFuelKg) {
      // fuel capacity: exceeds the rocket's tank (validation error, not a
      // mission failure type — no new type introduced)
      violations.push(viol(
        "invalid_build",
        "fuelKg " + build.fuelKg + " exceeds rocket.maxFuelKg " + rocket.maxFuelKg +
          " for rocket '" + safeStr(rocket.id, "?") + "'",
        { fuelKg: build.fuelKg, maxFuelKg: rocket.maxFuelKg }
      ));
      bad = true;
    }
    if (!Array.isArray(build.components)) {
      violations.push(viol("invalid_build", "components must be an array of component IDs"));
      bad = true;
    } else {
      var compShapeBad = false;
      for (var ci = 0; ci < build.components.length; ci++) {
        if (typeof build.components[ci] !== "string") {
          violations.push(viol("invalid_build", "components[" + ci + "] must be a string ID"));
          bad = true;
          compShapeBad = true;
          break;
        }
      }
      // every component ID must resolve through getComponent() and carry
      // valid numeric data — unknown components never pass validation,
      // so a valid launch can never contain unresolved components
      if (!compShapeBad) {
        for (var cj = 0; cj < build.components.length; cj++) {
          var compId = build.components[cj];
          var comp = getComponent(compId);
          if (!comp) {
            violations.push(viol(
              "invalid_build",
              "unknown component ID: '" + safeStr(compId, "?") + "' (not found via getComponent)",
              { componentId: safeStr(compId, "?"), index: cj }
            ));
            bad = true;
            break;
          }
          var compIssues = badFields(comp, ["massKg", "powerDrawW", "powerGenW", "cost"]);
          if (compIssues.length > 0) {
            violations.push(viol(
              "invalid_build",
              "component '" + safeStr(compId, "?") + "' has missing/invalid required data: " + compIssues.join(", "),
              { componentId: safeStr(compId, "?"), invalidFields: compIssues.join(", ") }
            ));
            bad = true;
            break;
          }
        }
      }
    }

    // --- required game data: fuel price -------------------------------------
    var priceSrc = dataSrc();
    var fuelPrice = priceSrc ? priceSrc.fuelCostPerKg : undefined;
    if (!isNum(fuelPrice) || fuelPrice < 0) {
      violations.push(viol(
        "invalid_build",
        priceSrc
          ? "data.fuelCostPerKg is missing, non-finite or negative"
          : "game data (SMG.data) is missing — cannot read fuelCostPerKg",
        {}
      ));
      bad = true;
    }

    // --- input sanity: mission ---------------------------------------------
    if (!isNum(mission.targetAltitudeKm) || mission.targetAltitudeKm <= 0) {
      violations.push(viol("invalid_build", "mission.targetAltitudeKm must be a number greater than 0"));
      bad = true;
    }
    var targetOk = isNum(mission.targetAltitudeKm) && mission.targetAltitudeKm > 0;
    if (!isNum(mission.stageSeparationAltitudeKm) ||
        mission.stageSeparationAltitudeKm < 0 ||
        (targetOk && mission.stageSeparationAltitudeKm >= mission.targetAltitudeKm)) {
      violations.push(viol(
        "invalid_build",
        "mission.stageSeparationAltitudeKm must be >= 0 and strictly less than targetAltitudeKm (data requirement — value never invented)"
      ));
      bad = true;
    }
    if (!isNum(mission.payloadMassKg) || mission.payloadMassKg < 0) {
      violations.push(viol("invalid_build", "mission.payloadMassKg must be a non-negative number"));
      bad = true;
    }
    if (!isPlainObj(mission.limits) ||
        !isNum(mission.limits.budget) || mission.limits.budget < 0 ||
        !isNum(mission.limits.maxMassKg) || mission.limits.maxMassKg < 0 ||
        !isNum(mission.limits.requiredPowerW) || mission.limits.requiredPowerW < 0) {
      violations.push(viol("invalid_build", "mission.limits must contain non-negative budget, maxMassKg and requiredPowerW"));
      bad = true;
    }
    if (!Array.isArray(mission.allowedRockets)) {
      violations.push(viol("invalid_build", "mission.allowedRockets must be an array of rocket IDs"));
      bad = true;
    }
    if (!isNum(mission.passScore) || mission.passScore < 0 ||
        !isNum(mission.maxScore) || mission.maxScore < 0 ||
        !isNum(mission.eventChance) || mission.eventChance < 0) {
      violations.push(viol("invalid_build", "mission passScore, maxScore and eventChance must be non-negative numbers"));
      bad = true;
    }

    // Restriction checks only run on fully sane input (documented behaviour:
    // the first violation is always the most fundamental problem).
    if (bad) return { ok: false, violations: violations };

    rocket = getRocket(build.rocketId);   // (already resolved and data-validated above)
    var stats = computeStats(build, mission);
    var budget = mission.limits.budget;
    var maxMassKg = mission.limits.maxMassKg;

    if (stats.cost > budget) {
      violations.push(viol("over_budget",
        "cost " + stats.cost + " exceeds budget " + budget,
        { cost: stats.cost, budget: budget, overBy: stats.cost - budget }));
    }
    if (stats.totalMassKg > maxMassKg) {
      violations.push(viol("over_mass",
        "total mass " + stats.totalMassKg + " kg exceeds limit " + maxMassKg + " kg",
        { totalMassKg: stats.totalMassKg, maxMassKg: maxMassKg, overBy: stats.totalMassKg - maxMassKg }));
    }
    if (mission.allowedRockets.indexOf(build.rocketId) === -1) {
      violations.push(viol("rocket_not_allowed",
        "rocket '" + build.rocketId + "' is not allowed for this mission",
        { rocketId: build.rocketId }));
    }
    if (build.engineCount < 1) {
      violations.push(viol("engine_limit",
        "at least 1 engine is required (engineCount = " + build.engineCount + ")",
        { engineCount: build.engineCount, maxEngines: nn(rocket.maxEngines) }));
    } else if (build.engineCount > rocket.maxEngines) {
      violations.push(viol("engine_limit",
        "engineCount " + build.engineCount + " exceeds rocket maximum of " + rocket.maxEngines,
        { engineCount: build.engineCount, maxEngines: nn(rocket.maxEngines) }));
    }

    return { ok: violations.length === 0, violations: violations };
  }

  /* ==========================================================================
   * Outcome builders (exact contract field names — nothing added or removed)
   * ========================================================================== */

  function zeroScore() {
    return {
      total: 0,
      passed: false,
      parts: {
        base: 0,
        budgetBonus: 0,
        massBonus: 0,
        sparePowerBonus: 0,
        spareFuelBonus: 0,
        eventPenalty: 0
      }
    };
  }

  function padTimeline() {
    return [{ t: 0, altitudeKm: 0, phase: "pad" }];
  }

  function failureOutcome(stats, type, timeS, altitudeKm, stage, numbers, events, timeline) {
    var nums = {};
    if (numbers && typeof numbers === "object") {
      Object.keys(numbers).forEach(function (k) { nums[k] = numbers[k]; });
    }
    return {
      success: false,
      failure: {
        type: type,
        altitudeKm: finite(altitudeKm),
        timeS: finite(timeS),
        stage: safeStr(stage, "pad"),
        numbers: nums
      },
      stats: stats,
      events: Array.isArray(events) ? events : [],
      score: zeroScore(),       // AGREED: every failed launch scores ZERO
      timeline: Array.isArray(timeline) ? timeline : padTimeline()
    };
  }

  function bonusPart(weight, maxScore, ratio) {
    if (!isNum(maxScore) || maxScore <= 0) return 0;
    return Math.round(weight * maxScore * clamp01(ratio));
  }

  function successOutcome(stats, mission, events, timeline) {
    var maxScore = nn(mission.maxScore);
    var limits = mission.limits || {};
    var budget = nn(limits.budget);
    var maxMassKg = nn(limits.maxMassKg);
    var requiredPowerW = nn(limits.requiredPowerW);

    var budgetRatio = budget > 0 ? (budget - stats.cost) / budget : 0;
    var massRatio = maxMassKg > 0 ? (maxMassKg - stats.totalMassKg) / maxMassKg : 0;
    var powerRatio = requiredPowerW > 0 ? (stats.powerBalanceW - requiredPowerW) / requiredPowerW : 0;
    var fuelRatio = stats.fuelLeftPct / 100;

    var parts = {
      base: Math.round(BASE_K * maxScore),
      budgetBonus: bonusPart(BUDGET_K, maxScore, budgetRatio),
      massBonus: bonusPart(MASS_K, maxScore, massRatio),
      sparePowerBonus: bonusPart(POWER_K, maxScore, powerRatio),
      spareFuelBonus: bonusPart(FUEL_K, maxScore, fuelRatio),
      eventPenalty: events.length * EVENT_PENALTY   // success runs normally have 0 events
    };

    var total = parts.base + parts.budgetBonus + parts.massBonus +
                parts.sparePowerBonus + parts.spareFuelBonus - parts.eventPenalty;
    total = Math.round(clamp(total, 0, maxScore));

    return {
      success: true,
      failure: null,
      stats: stats,
      events: events,
      score: {
        total: finite(total),
        passed: total >= nn(mission.passScore),
        parts: parts
      },
      timeline: timeline
    };
  }

  /* ==========================================================================
   * launch(build, mission)
   *
   * Flow:
   *   1. validate() first → first violation aborts at the pad
   *   2. computeStats()
   *   3. seeded RNG from stable inputs
   *   4. Deterministic mission-failure checks in AGREED fixed order:
   *        thrust_low → fuel_out → power_short   (all pre-flight, static stats)
   *      then the phase pipeline with SEEDED INCIDENTS:
   *        stage_fail (stage_separation), sensor_fault (coast / orbit)
   *   5. Stop at the FIRST failure (events exist only for seeded incidents)
   *   6. Timeline: pad → ascent → stage_separation → coast → orbit
   *      Altitude anchors come only from mission data (0,
   *      stageSeparationAltitudeKm, targetAltitudeKm) — never invented.
   * ========================================================================== */
  function launch(build, mission) {
    var v = validate(build, mission);
    var stats = computeStats(build, mission);   // computed regardless (diagnostics)

    // --- 1. pre-launch validation failures ---------------------------------
    if (!v.ok) {
      var first = v.violations[0];
      var nums = {};
      Object.keys(first.numbers || {}).forEach(function (k) { nums[k] = first.numbers[k]; });
      nums.reason = first.reason;      // explains validation-class failures
      return failureOutcome(stats, first.type, 0, 0, "pad", nums, [], padTimeline());
    }

    var rng = makeRng(build, mission);
    var target = nn(mission.targetAltitudeKm);
    var sepAlt = clamp(mission.stageSeparationAltitudeKm, 0, target);
    var eventChance = clamp01(mission.eventChance);

    // --- 2. deterministic mission-failure checks (fixed order) -------------

    // (a) thrust_low — AGREED threshold: twr < 1.0
    if (stats.twr < MIN_TWR) {
      return failureOutcome(stats, "thrust_low", 0, 0, "pad", {
        twr: stats.twr, minTwr: MIN_TWR,
        thrustKN: stats.thrustKN, weightKN: stats.weightKN
      }, [], padTimeline());
    }

    // (b) fuel_out — ONLY when deltaVAvailable < deltaVNeeded (no random margin)
    if (stats.deltaVAvailable < stats.deltaVNeeded) {
      return failureOutcome(stats, "fuel_out", 0, 0, "pad", {
        deltaVAvailable: stats.deltaVAvailable,
        deltaVNeeded: stats.deltaVNeeded,
        fuelLeftPct: stats.fuelLeftPct,
        fuelKg: nn(build.fuelKg)
      }, [], padTimeline());
    }

    // (c) power_short — ONLY deterministic: balance < mission required power
    var requiredPowerW = nn(mission.limits.requiredPowerW);
    if (stats.powerBalanceW < requiredPowerW) {
      return failureOutcome(stats, "power_short", 0, 0, "pad", {
        powerBalanceW: stats.powerBalanceW,
        requiredPowerW: requiredPowerW,
        deficitW: requiredPowerW - stats.powerBalanceW
      }, [], padTimeline());
    }

    // --- 3. phase pipeline with seeded incidents ---------------------------
    var timeline = [];
    var events = [];
    var t = 0;

    function push(phase, timeS, alt) {
      timeline.push({ t: finite(timeS), altitudeKm: finite(alt), phase: phase });
    }

    // pad
    push("pad", t, 0);

    // ascent: 0 → stageSeparationAltitudeKm
    t += PAD_S;
    push("ascent", t, 0);
    t += ASCENT_S;
    push("ascent", t, sepAlt);

    // stage_separation: incident → stage_fail
    push("stage_separation", t, sepAlt);
    if (rng() < eventChance) {
      events.push({ type: "stage_fail", atS: t, recovered: false });
      return failureOutcome(stats, "stage_fail", t, sepAlt, "stage_separation",
        { atS: t, stage: "stage_separation" }, events, timeline);
    }

    // coast: stageSeparationAltitudeKm → targetAltitudeKm; incident → sensor_fault
    t += STAGE_SEP_S;
    push("coast", t, sepAlt);
    if (rng() < eventChance) {
      events.push({ type: "sensor_fault", atS: t, recovered: false });
      return failureOutcome(stats, "sensor_fault", t, sepAlt, "coast",
        { atS: t, sensorRisk: eventChance }, events, timeline);
    }

    // orbit: reached target altitude; second incident point → sensor_fault
    t += COAST_S;
    push("coast", t, target);
    push("orbit", t, target);
    if (rng() < eventChance) {
      events.push({ type: "sensor_fault", atS: t, recovered: false });
      return failureOutcome(stats, "sensor_fault", t, target, "orbit",
        { atS: t, sensorRisk: eventChance }, events, timeline);
    }

    // --- 4. mission success -------------------------------------------------
    t += ORBIT_S;
    push("orbit", t, target);
    return successOutcome(stats, mission, events, timeline);
  }

  /* ==========================================================================
   * _selfTest()
   * Runs the module against ISOLATED synthetic fixtures (TEST_* IDs).
   * Never touches real game data, DOM, storage or network.
   * Returns { passed, failed, checks: [{ name, pass, detail }] }.
   * ========================================================================== */
  function _selfTest() {
    var checks = [];
    var savedFixture = testFixture;

    /* ---------- synthetic fixtures (isolated, test-only) ---------- */
    var FIXTURE_ROCKETS = [
      {
        id: "TEST_ROCKET_A", name: "Test Heavy Lift",
        thrustKN: 1000,          // per engine
        dryMassKg: 4000, maxFuelKg: 20000, maxEngines: 5, cost: 1000000, stages: 2,
        engine: { id: "TEST_ENGINE_A", name: "Test Engine A", massKg: 200, cost: 50000, powerDrawW: 500 }
      },
      {
        id: "TEST_ROCKET_B", name: "Test Weak Lift",
        thrustKN: 100,           // per engine
        dryMassKg: 8000, maxFuelKg: 5000, maxEngines: 1, cost: 400000, stages: 1,
        engine: { id: "TEST_ENGINE_B", name: "Test Engine B", massKg: 50, cost: 20000, powerDrawW: 50 }
      },
      {
        // data-validation fixture: engine object missing entirely
        id: "TEST_ROCKET_NO_ENGINE", name: "Missing Engine Data",
        thrustKN: 500, dryMassKg: 3000, maxFuelKg: 8000, maxEngines: 2, cost: 500000, stages: 1
      },
      {
        // data-validation fixture: thrustKN missing, dryMassKg negative
        id: "TEST_ROCKET_BAD_FIELDS", name: "Bad Numeric Data",
        dryMassKg: -1, maxFuelKg: 5000, maxEngines: 3, cost: 100000, stages: 1,
        engine: { id: "TEST_ENGINE_C", name: "Test Engine C", massKg: 100, cost: 1000, powerDrawW: 100 }
      }
    ];
    var FIXTURE_COMPONENTS = [
      { id: "TEST_COMP_SOLAR", name: "Solar Panel", category: "power", massKg: 50, powerDrawW: 10, powerGenW: 2000, cost: 20000 },
      { id: "TEST_COMP_SENSOR", name: "Sensor Suite", category: "science", massKg: 30, powerDrawW: 800, powerGenW: 0, cost: 40000 },
      { id: "TEST_COMP_HEAVY", name: "Heavy Payload", category: "payload", massKg: 5000, powerDrawW: 0, powerGenW: 0, cost: 10000 },
      { id: "TEST_COMP_EXPENSIVE", name: "Premium Module", category: "science", massKg: 20, powerDrawW: 5, powerGenW: 0, cost: 5000000 },
      { id: "TEST_COMP_BAD_COST", name: "Bad Data Module", category: "science", massKg: 10, powerDrawW: 1, powerGenW: 0, cost: "unpriced" }
    ];
    function findRocket(id) {
      for (var i = 0; i < FIXTURE_ROCKETS.length; i++) if (FIXTURE_ROCKETS[i].id === id) return FIXTURE_ROCKETS[i];
      return null;
    }
    function findComponent(id) {
      for (var i = 0; i < FIXTURE_COMPONENTS.length; i++) if (FIXTURE_COMPONENTS[i].id === id) return FIXTURE_COMPONENTS[i];
      return null;
    }
    testFixture = {
      fuelCostPerKg: 10,
      rockets: FIXTURE_ROCKETS,
      components: FIXTURE_COMPONENTS,
      getRocket: findRocket,
      getComponent: findComponent,
      getMission: function () { return null; }   // tests pass mission objects directly
    };

    function mkMission(over) {
      var base = {
        id: "TEST_MISSION_DEFAULT", name: "Default Test Mission",
        briefing: "Synthetic self-test mission",
        targetAltitudeKm: 400, stageSeparationAltitudeKm: 80,
        payloadMassKg: 1000,
        limits: { budget: 2000000, maxMassKg: 30000, requiredPowerW: 500 },
        passScore: 600, maxScore: 1000, eventChance: 0,
        allowedRockets: ["TEST_ROCKET_A"], fact: "synthetic fixture"
      };
      var out = Object.assign({}, base, over || {});
      out.limits = Object.assign({}, base.limits, (over && over.limits) || {});
      return out;
    }
    function mkBuild(over) {
      return Object.assign({
        rocketId: "TEST_ROCKET_A", engineCount: 4, fuelKg: 10000,
        components: ["TEST_COMP_SOLAR", "TEST_COMP_SOLAR", "TEST_COMP_SENSOR"]
      }, over || {});
    }

    /* ---------- test helpers ---------- */
    function expect(cond, msg) {
      if (!cond) throw new Error(msg || "assertion failed");
    }
    function expectEq(actual, expected, msg) {
      if (actual !== expected) {
        throw new Error((msg || "") + " — expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
      }
    }
    function deepEq(a, b) {
      return JSON.stringify(a) === JSON.stringify(b);
    }
    function allFinite(v) {
      if (typeof v === "number") return isFinite(v);
      if (Array.isArray(v)) return v.every(allFinite);
      if (v && typeof v === "object") return Object.keys(v).every(function (k) { return allFinite(v[k]); });
      return true;
    }
    function check(name, fn) {
      try {
        fn();
        checks.push({ name: name, pass: true, detail: "ok" });
      } catch (e) {
        checks.push({ name: name, pass: false, detail: String((e && e.message) || e) });
      }
    }
    var STATS_KEYS = ["totalMassKg", "thrustKN", "weightKN", "twr", "powerBalanceW",
                      "cost", "fuelLeftPct", "deltaVAvailable", "deltaVNeeded"];

    try {
      var okMission = mkMission();
      var okBuild = mkBuild();

      /* ---------- API surface ---------- */
      check("API surface: computeStats/validate/launch/_selfTest exposed", function () {
        expect(typeof root.SMG.sim.computeStats === "function", "computeStats missing");
        expect(typeof root.SMG.sim.validate === "function", "validate missing");
        expect(typeof root.SMG.sim.launch === "function", "launch missing");
        expect(typeof root.SMG.sim._selfTest === "function", "_selfTest missing");
      });

      /* ---------- computeStats: 9 stats, exact keys, all finite ---------- */
      check("computeStats returns exactly the 9 agreed stats, all finite", function () {
        var s = computeStats(okBuild, okMission);
        expectEq(Object.keys(s).length, 9, "stat count");
        STATS_KEYS.forEach(function (k) {
          expect(Object.prototype.hasOwnProperty.call(s, k), "missing stat: " + k);
        });
        expect(allFinite(s), "non-finite value in stats");
        var weird = computeStats(
          { rocketId: "TEST_ROCKET_A", engineCount: NaN, fuelKg: NaN, components: [null, undefined] },
          { payloadMassKg: NaN, targetAltitudeKm: NaN }
        );
        expect(allFinite(weird), "stats not NaN-safe with invalid input");
      });

      /* ---------- computeStats: formulas ---------- */
      check("computeStats formulas (mass, thrust×count, weight, twr, power, fuel%)", function () {
        var b = mkBuild({ engineCount: 3, fuelKg: 12000 });
        var m = mkMission({ payloadMassKg: 1500 });
        var s = computeStats(b, m);
        // engine mass = 3 × 200; fuel cost = 12000 × 10
        var compMass = 50 + 50 + 30;
        expectEq(s.totalMassKg, 4000 + 3 * 200 + 12000 + 1500 + compMass, "totalMassKg");
        expectEq(s.thrustKN, 1000 * 3, "thrustKN = thrust per engine × engineCount");
        expectEq(s.weightKN, s.totalMassKg * 0.00981, "weightKN");
        expect(Math.abs(s.twr - s.thrustKN / s.weightKN) < 1e-9, "twr");
        // power: gen 4000 − component draws (10+10+800) − engine draw (500×3)
        expectEq(s.powerBalanceW, 4000 - 820 - 1500, "powerBalanceW");
        expectEq(s.fuelLeftPct, 12000 / 20000 * 100, "fuelLeftPct");
        // cost = rocket + engines + fuel + components (no double counting)
        expectEq(s.cost, 1000000 + 3 * 50000 + 12000 * 10 + (20000 + 20000 + 40000), "cost exclusivity");
      });

      check("computeStats delta-v (agreed arcade formulas)", function () {
        var s = computeStats(okBuild, okMission);
        var thrustFactor = s.thrustKN / 1000;   // THRUST_FACTOR_REF_KN
        expect(Math.abs(s.deltaVAvailable - (9000 * 10000 / s.totalMassKg * thrustFactor)) < 1e-6,
          "deltaVAvailable = K * fuelKg / totalMassKg * thrustFactor");
        expectEq(s.deltaVNeeded, 2000 + 15 * 400, "deltaVNeeded = DV_BASE + DV_PER_KM * targetAltitudeKm");
      });

      check("computeStats: zero engines → zero thrust/engine mass/cost/power", function () {
        var s = computeStats(mkBuild({ engineCount: 0, fuelKg: 10000 }), okMission);
        expectEq(s.thrustKN, 0, "thrustKN");
        expectEq(s.cost, 1000000 + 0 + 100000 + 80000, "no engine cost at count 0");
        expectEq(s.powerBalanceW, 4000 - 820 - 0, "no engine power draw at count 0");
        expectEq(s.totalMassKg, 4000 + 0 + 10000 + 1000 + 130, "no engine mass at count 0");
        expectEq(s.twr, 0, "twr with zero thrust still finite");
        expect(allFinite(s), "all finite");
      });

      check("computeStats: zero fuel → fuelLeftPct 0 and no fuel cost", function () {
        var s = computeStats(mkBuild({ fuelKg: 0 }), okMission);
        expectEq(s.fuelLeftPct, 0, "fuelLeftPct");
        expectEq(s.cost, 1000000 + 200000 + 0 + 80000, "fuel cost zero");
        expect(allFinite(s), "all finite");
      });

      check("computeStats: unknown component IDs are skipped safely", function () {
        var s = computeStats(mkBuild({ components: ["TEST_COMP_SOLAR", "DOES_NOT_EXIST", "TEST_COMP_SENSOR"] }), okMission);
        expectEq(s.totalMassKg, 4000 + 800 + 10000 + 1000 + 80, "mass without unknown component");
        expect(allFinite(s), "all finite");
      });

      /* ---------- validate ---------- */
      check("validate returns { ok, violations[{type,reason,numbers}] }", function () {
        var r = validate(okBuild, okMission);
        expect(typeof r.ok === "boolean", "ok must be boolean");
        expect(Array.isArray(r.violations), "violations must be array");
        var r2 = validate(mkBuild({ fuelKg: -5 }), okMission);
        expect(r2.violations.length > 0, "expected violations");
        r2.violations.forEach(function (v) {
          expect(typeof v.type === "string" && typeof v.reason === "string" && v.numbers && typeof v.numbers === "object",
            "violation shape");
        });
      });

      check("validate: healthy build passes", function () {
        expectEq(validate(okBuild, okMission).ok, true, "expected ok");
      });

      check("validate: exact budget passes, budget − 1 fails over_budget", function () {
        var s = computeStats(okBuild, okMission);
        var exact = mkMission({ limits: { budget: s.cost } });
        expectEq(validate(okBuild, exact).ok, true, "exact budget must pass");
        var under = mkMission({ limits: { budget: s.cost - 1 } });
        var r = validate(okBuild, under);
        expectEq(r.ok, false, "budget-1 must fail");
        expectEq(r.violations[0].type, "over_budget", "first violation type");
        expectEq(r.violations[0].numbers.overBy, 1, "overBy");
      });

      check("validate: exact mass passes, mass − 1 kg fails over_mass", function () {
        var s = computeStats(okBuild, okMission);
        var exact = mkMission({ limits: { maxMassKg: s.totalMassKg } });
        expectEq(validate(okBuild, exact).ok, true, "exact mass must pass");
        var under = mkMission({ limits: { maxMassKg: s.totalMassKg - 1 } });
        var r = validate(okBuild, under);
        expectEq(r.ok, false, "mass-1 must fail");
        expectEq(r.violations[0].type, "over_mass", "first violation type");
      });

      check("validate: rocket_not_allowed", function () {
        // fuel kept within TEST_ROCKET_B capacity so the rocket-allowed
        // restriction (not input sanity) is what fails
        var r = validate(mkBuild({ rocketId: "TEST_ROCKET_B", fuelKg: 3000 }), okMission);
        expectEq(r.ok, false, "must fail");
        expectEq(r.violations[0].type, "rocket_not_allowed", "type");
      });

      check("validate: engine_limit (0 engines and above-max engines)", function () {
        var r0 = validate(mkBuild({ engineCount: 0 }), okMission);
        expectEq(r0.ok, false, "0 engines must fail");
        expectEq(r0.violations[0].type, "engine_limit", "zero → engine_limit");
        var r6 = validate(mkBuild({ engineCount: 6 }), okMission);   // maxEngines = 5
        expectEq(r6.ok, false, "6 engines must fail");
        expectEq(r6.violations[0].type, "engine_limit", "over max → engine_limit");
      });

      check("validate: invalid_build for bad IDs and invalid numerics", function () {
        expectEq(validate(mkBuild({ rocketId: "NO_SUCH_ROCKET" }), okMission).violations[0].type, "invalid_build", "unknown rocket");
        expectEq(validate(mkBuild({ fuelKg: -1 }), okMission).violations[0].type, "invalid_build", "negative fuel");
        expectEq(validate(mkBuild({ fuelKg: NaN }), okMission).violations[0].type, "invalid_build", "NaN fuel");
        expectEq(validate(mkBuild({ engineCount: 2.5 }), okMission).violations[0].type, "invalid_build", "fractional engines");
        expectEq(validate(mkBuild({ components: "not-an-array" }), okMission).violations[0].type, "invalid_build", "components shape");
        var m = mkMission(); delete m.stageSeparationAltitudeKm;
        expectEq(validate(okBuild, m).violations[0].type, "invalid_build", "missing stageSeparationAltitudeKm");
        var m2 = mkMission({ stageSeparationAltitudeKm: 9999 });
        expectEq(validate(okBuild, m2).violations[0].type, "invalid_build", "sep alt above target");
        expectEq(validate(null, okMission).violations[0].type, "invalid_build", "null build");
        expectEq(validate(okBuild, null).violations[0].type, "invalid_build", "null mission");
      });

      check("validate: budget violation ordered before mass violation", function () {
        var s = computeStats(okBuild, okMission);
        var m = mkMission({ limits: { budget: 1, maxMassKg: 1 } });
        var r = validate(okBuild, m);
        expectEq(r.violations[0].type, "over_budget", "budget first");
        expectEq(r.violations[1].type, "over_mass", "mass second");
      });

      /* ---------- required game data, capacity & component resolution ------ */
      check("validate: unknown component IDs rejected with useful diagnostics", function () {
        var b = mkBuild({ components: ["TEST_COMP_SOLAR", "GHOST_COMPONENT"] });
        var r = validate(b, okMission);
        expectEq(r.ok, false, "must fail");
        expectEq(r.violations[0].type, "invalid_build", "type");
        expect(r.violations[0].reason.indexOf("GHOST_COMPONENT") !== -1, "reason names the unknown ID");
        expectEq(r.violations[0].numbers.componentId, "GHOST_COMPONENT", "numbers.componentId");
        expectEq(r.violations[0].numbers.index, 1, "numbers.index");
        // a launch must not silently ignore unknown components
        var out = launch(b, okMission);
        expectEq(out.success, false, "launch must fail");
        expectEq(out.failure.type, "invalid_build", "launch failure type");
        expect(out.failure.numbers.reason.indexOf("GHOST_COMPONENT") !== -1, "failure reason names the ID");
        expectEq(out.score.total, 0, "zero score");
      });

      check("validate: fuelKg above rocket.maxFuelKg rejected", function () {
        var r = validate(mkBuild({ fuelKg: 20001 }), okMission);   // TEST_ROCKET_A cap = 20000
        expectEq(r.ok, false, "must fail");
        expectEq(r.violations[0].type, "invalid_build", "type (no new mission failure type)");
        expectEq(r.violations[0].numbers.fuelKg, 20001, "numbers.fuelKg");
        expectEq(r.violations[0].numbers.maxFuelKg, 20000, "numbers.maxFuelKg");
        expect(r.violations[0].reason.indexOf("maxFuelKg") !== -1, "reason mentions maxFuelKg");
        var out = launch(mkBuild({ fuelKg: 20001 }), okMission);
        expectEq(out.failure.type, "invalid_build", "launch reports invalid_build");
        expectEq(out.score.total, 0, "zero score");
        expectEq(validate(mkBuild({ fuelKg: 20000 }), okMission).ok, true, "exact capacity passes");
      });

      check("validate: missing rocket engine data rejected", function () {
        var b = mkBuild({ rocketId: "TEST_ROCKET_NO_ENGINE" });
        var m = mkMission({ allowedRockets: ["TEST_ROCKET_NO_ENGINE"] });
        var r = validate(b, m);
        expectEq(r.ok, false, "must fail");
        expectEq(r.violations[0].type, "invalid_build", "type");
        expect(r.violations[0].reason.indexOf("engine") !== -1, "reason mentions engine data");
        expectEq(r.violations[0].numbers.rocketId, "TEST_ROCKET_NO_ENGINE", "diagnostic rocketId");
        var out = launch(b, m);
        expectEq(out.failure.type, "invalid_build", "launch rejects it");
        expectEq(out.score.total, 0, "zero score");
      });

      check("validate: missing/negative rocket numeric data rejected", function () {
        var b = mkBuild({ rocketId: "TEST_ROCKET_BAD_FIELDS" });
        var m = mkMission({ allowedRockets: ["TEST_ROCKET_BAD_FIELDS"] });
        var r = validate(b, m);
        expectEq(r.ok, false, "must fail");
        expectEq(r.violations[0].type, "invalid_build", "type");
        expect(r.violations[0].reason.indexOf("thrustKN") !== -1, "reason lists missing thrustKN");
        expect(r.violations[0].reason.indexOf("dryMassKg") !== -1, "reason lists negative dryMassKg");
        expect(typeof r.violations[0].numbers.invalidFields === "string", "diagnostic invalidFields");
        var out = launch(b, m);
        expectEq(out.failure.type, "invalid_build", "launch rejects it");
        expectEq(out.score.total, 0, "zero score");
      });

      check("validate: invalid data.fuelCostPerKg rejected (fixture restored)", function () {
        var saved = testFixture.fuelCostPerKg;
        try {
          testFixture.fuelCostPerKg = "not-a-number";
          var r1 = validate(okBuild, okMission);
          expectEq(r1.ok, false, "non-numeric price must fail");
          expectEq(r1.violations[0].type, "invalid_build", "type");
          expect(r1.violations[0].reason.indexOf("fuelCostPerKg") !== -1, "reason mentions fuelCostPerKg");
          testFixture.fuelCostPerKg = -2;
          var r2 = validate(okBuild, okMission);
          expectEq(r2.ok, false, "negative price must fail");
          expectEq(r2.violations[0].type, "invalid_build", "type");
        } finally {
          testFixture.fuelCostPerKg = saved;
        }
        expectEq(testFixture.fuelCostPerKg, 10, "fixture restored");
        expectEq(validate(okBuild, okMission).ok, true, "restored price passes again");
      });

      check("validate: invalid component numeric fields rejected", function () {
        var r = validate(mkBuild({ components: ["TEST_COMP_SOLAR", "TEST_COMP_BAD_COST"] }), okMission);
        expectEq(r.ok, false, "must fail");
        expectEq(r.violations[0].type, "invalid_build", "type");
        expectEq(r.violations[0].numbers.componentId, "TEST_COMP_BAD_COST", "componentId diagnostic");
        expect(r.violations[0].reason.indexOf("cost") !== -1, "reason names the invalid field");
        var out = launch(mkBuild({ components: ["TEST_COMP_BAD_COST"] }), okMission);
        expectEq(out.failure.type, "invalid_build", "launch rejects it");
        expectEq(out.score.total, 0, "zero score");
      });

      check("validate: fully valid build passes every data check", function () {
        expectEq(validate(okBuild, okMission).ok, true, "healthy build passes");
        expectEq(validate(mkBuild({ fuelKg: 20000 }), okMission).ok, true, "fuel at exact capacity passes");
        expectEq(launch(okBuild, okMission).success, true, "healthy build still launches successfully");
        expectEq(launch(okBuild, okMission).failure, null, "no failure on healthy build");
      });

      /* ---------- mission altitude boundary rules --------------------------- */
      check("validate: stageSeparationAltitudeKm equal to targetAltitudeKm rejected", function () {
        var m = mkMission({ stageSeparationAltitudeKm: 400 });   // target = 400 → not strictly below
        var r = validate(okBuild, m);
        expectEq(r.ok, false, "must fail");
        expectEq(r.violations[0].type, "invalid_build", "type");
        expect(r.violations[0].reason.indexOf("stageSeparationAltitudeKm") !== -1,
          "reason mentions stageSeparationAltitudeKm");
        var out = launch(okBuild, m);
        expectEq(out.success, false, "launch fails");
        expectEq(out.failure.type, "invalid_build", "launch failure type");
        expectEq(out.score.total, 0, "zero score");
      });

      check("validate: stageSeparationAltitudeKm greater than targetAltitudeKm rejected", function () {
        var m = mkMission({ stageSeparationAltitudeKm: 500 });   // target = 400
        var r = validate(okBuild, m);
        expectEq(r.ok, false, "must fail");
        expectEq(r.violations[0].type, "invalid_build", "type");
        expect(r.violations[0].reason.indexOf("stageSeparationAltitudeKm") !== -1,
          "reason mentions stageSeparationAltitudeKm");
        var out = launch(okBuild, m);
        expectEq(out.failure.type, "invalid_build", "launch failure type");
        expectEq(out.score.total, 0, "zero score");
      });

      check("validate: targetAltitudeKm equal to 0 rejected", function () {
        var m = mkMission({ targetAltitudeKm: 0, stageSeparationAltitudeKm: 0 });
        var r = validate(okBuild, m);
        expectEq(r.ok, false, "must fail");
        expectEq(r.violations[0].type, "invalid_build", "type");
        expect(r.violations[0].reason.indexOf("targetAltitudeKm") !== -1, "reason mentions targetAltitudeKm");
        var out = launch(okBuild, m);
        expectEq(out.failure.type, "invalid_build", "launch failure type");
        expectEq(out.score.total, 0, "zero score");
        // negative target is rejected too
        expectEq(validate(okBuild, mkMission({ targetAltitudeKm: -1 })).violations[0].type,
          "invalid_build", "negative target rejected");
      });

      check("validate: valid stage separation altitudes pass", function () {
        // default (80 < 400)
        expectEq(validate(okBuild, okMission).ok, true, "default sep altitude 80 passes");
        // boundary: 0 is allowed (>= 0 and < target)
        expectEq(validate(okBuild, mkMission({ stageSeparationAltitudeKm: 0 })).ok, true, "sep altitude 0 passes");
        // just below target
        expectEq(validate(okBuild, mkMission({ stageSeparationAltitudeKm: 399 })).ok, true, "sep altitude 399 passes");
        // launch with a valid custom separation altitude succeeds and uses the data anchor
        var m = mkMission({ stageSeparationAltitudeKm: 120 });
        var out = launch(okBuild, m);
        expectEq(out.success, true, "launch succeeds with valid sep altitude");
        expectEq(out.failure, null, "no failure");
        var sepSample = out.timeline.filter(function (p) { return p.phase === "stage_separation"; })[0];
        expectEq(sepSample.altitudeKm, 120, "timeline uses the provided separation altitude");
      });

      /* ---------- launch: the seven mission failure types ---------- */
      function expectFailure(build, mission, expectedType) {
        var out = launch(build, mission);
        expectEq(out.success, false, "success flag");
        expect(out.failure !== null && out.failure !== undefined, "failure must be set");
        expectEq(out.failure.type, expectedType, "failure type");
        expectEq(out.score.total, 0, "failed score must be 0");
        expectEq(out.score.passed, false, "failed passed must be false");
        Object.keys(out.score.parts).forEach(function (k) {
          expectEq(out.score.parts[k], 0, "part " + k + " must be 0");
        });
        expect(allFinite(out), "outcome must contain only finite numbers");
        return out;
      }

      check("launch: thrust_low (twr < 1.0) beats fuel_out and power_short", function () {
        var b = { rocketId: "TEST_ROCKET_B", engineCount: 1, fuelKg: 3000, components: ["TEST_COMP_SENSOR"] };
        var m = mkMission({ allowedRockets: ["TEST_ROCKET_B"] });
        var s = computeStats(b, m);
        expect(s.twr < 1, "fixture must be under-thrusted");
        expect(s.deltaVAvailable < s.deltaVNeeded, "fixture also fuel-deficient (order test)");
        expect(s.powerBalanceW < m.limits.requiredPowerW, "fixture also power-deficient (order test)");
        var out = expectFailure(b, m, "thrust_low");
        expect(out.failure.numbers.twr < 1, "numbers.twr");
        expectEq(out.failure.stage, "pad", "stage");
        expectEq(out.failure.timeS, 0, "timeS");
        expectEq(out.events.length, 0, "no events for ordinary failure");
        expectEq(out.timeline.length, 1, "failed timeline stops at failure");
      });

      check("launch: fuel_out (deltaVAvailable < deltaVNeeded) beats power_short", function () {
        var b = mkBuild({ fuelKg: 500, components: ["TEST_COMP_SENSOR"] });
        var s = computeStats(b, okMission);
        expect(s.twr >= 1, "fixture must pass thrust");
        expect(s.deltaVAvailable < s.deltaVNeeded, "fixture must be delta-v deficient");
        expect(s.powerBalanceW < okMission.limits.requiredPowerW, "fixture also power-deficient (order test)");
        var out = expectFailure(b, okMission, "fuel_out");
        expect(out.failure.numbers.deltaVAvailable < out.failure.numbers.deltaVNeeded, "numbers show deficit");
        expectEq(out.events.length, 0, "no events for ordinary failure");
      });

      check("launch: power_short (powerBalanceW < requiredPowerW)", function () {
        var b = mkBuild({ components: ["TEST_COMP_SENSOR"] });
        var s = computeStats(b, okMission);
        expect(s.twr >= 1, "thrust ok");
        expect(s.deltaVAvailable >= s.deltaVNeeded, "delta-v ok");
        expect(s.powerBalanceW < okMission.limits.requiredPowerW, "power deficit");
        var out = expectFailure(b, okMission, "power_short");
        expect(out.failure.numbers.deficitW > 0, "deficitW");
        expectEq(out.failure.numbers.requiredPowerW, okMission.limits.requiredPowerW, "requiredPowerW");
      });

      check("launch: over_budget", function () {
        var m = mkMission({ limits: { budget: 100 } });
        var out = expectFailure(okBuild, m, "over_budget");
        expectEq(out.failure.stage, "pad", "stage");
        expectEq(out.failure.timeS, 0, "timeS");
        expect(out.failure.numbers.overBy > 0, "overBy positive");
        expectEq(out.timeline.length, 1, "timeline stops at pad");
      });

      check("launch: over_mass", function () {
        var m = mkMission({ limits: { maxMassKg: 100 } });
        var out = expectFailure(okBuild, m, "over_mass");
        expect(out.failure.numbers.overBy > 0, "overBy positive");
        expectEq(out.score.total, 0, "score zero");
      });

      check("launch: stage_fail (seeded incident at stage separation)", function () {
        var m = mkMission({ id: "TEST_MISSION_STAGE", eventChance: 1 });
        var out = expectFailure(okBuild, m, "stage_fail");
        expectEq(out.events.length, 1, "one incident event");
        expectEq(out.events[0].type, "stage_fail", "event type");
        expectEq(out.events[0].recovered, false, "recovered is always false (no recovery system)");
        expectEq(out.events[0].atS, out.failure.timeS, "event time matches failure");
        expectEq(out.failure.stage, "stage_separation", "failure stage");
        var last = out.timeline[out.timeline.length - 1];
        expectEq(last.phase, "stage_separation", "timeline ends at failure phase");
        expectEq(last.t, out.failure.timeS, "timeline ends at failure time");
        expectEq(last.altitudeKm, out.failure.altitudeKm, "timeline ends at failure altitude");
        expectEq(out.failure.altitudeKm, 80, "altitude from mission data (stageSeparationAltitudeKm)");
      });

      check("launch: sensor_fault (seeded incident during coast/orbit)", function () {
        var m = mkMission({ id: "TEST_MISSION_SENSOR_2", eventChance: 0.5 });
        var out = expectFailure(okBuild, m, "sensor_fault");
        expectEq(out.events.length, 1, "one incident event");
        expectEq(out.events[0].type, "sensor_fault", "event type");
        expectEq(out.events[0].recovered, false, "recovered always false");
        expect(out.failure.stage === "coast" || out.failure.stage === "orbit", "stage in flight");
        var last = out.timeline[out.timeline.length - 1];
        expectEq(last.t, out.failure.timeS, "timeline ends at failure");
        expectEq(last.altitudeKm, out.failure.altitudeKm, "altitude matches failure");
      });

      /* ---------- launch: success ---------- */
      check("launch: successful mission (full outcome structure)", function () {
        var out = launch(okBuild, okMission);
        expectEq(out.success, true, "success");
        expectEq(out.failure, null, "failure null");
        expectEq(out.events.length, 0, "no incidents at eventChance 0");
        expect(Object.keys(out).join(",") === "success,failure,stats,events,score,timeline",
          "outcome keys exact: " + Object.keys(out).join(","));
        expect(Object.keys(out.failure === null ? { success: 1, failure: 1, stats: 1, events: 1, score: 1, timeline: 1 } : {})
          .length > 0, "structure check");
        expect(Object.keys(out.score).join(",") === "total,passed,parts", "score keys");
        expect(Object.keys(out.score.parts).join(",") ===
          "base,budgetBonus,massBonus,sparePowerBonus,spareFuelBonus,eventPenalty", "score.parts keys");
        expect(Object.keys(out.stats).length === 9, "9 stats");
        expect(out.score.total > 0, "positive score");
        expectEq(out.score.passed, out.score.total >= okMission.passScore, "passed semantics");
        expectEq(out.timeline[0].phase, "pad", "starts at pad");
        expectEq(out.timeline[0].altitudeKm, 0, "pad altitude 0");
        var last = out.timeline[out.timeline.length - 1];
        expectEq(last.phase, "orbit", "ends in orbit");
        expectEq(last.altitudeKm, okMission.targetAltitudeKm, "orbit altitude = target");
        expect(allFinite(out), "all finite");
      });

      check("launch: timeline rises through ascent and coast (data anchors only)", function () {
        var out = launch(okBuild, okMission);
        var tPrev = -1, aPrev = -1;
        out.timeline.forEach(function (p) {
          expect(p.t >= tPrev, "time monotonic");
          expect(p.altitudeKm >= aPrev, "altitude non-decreasing");
          tPrev = p.t;
          aPrev = p.altitudeKm;
        });
        var phases = out.timeline.map(function (p) { return p.phase; });
        expectEq(phases[0], "pad", "pad first");
        expect(phases.indexOf("ascent") > 0, "ascent present");
        expect(phases.indexOf("stage_separation") > phases.indexOf("ascent"), "stage sep after ascent");
        expect(phases.indexOf("coast") > phases.indexOf("stage_separation"), "coast after stage sep");
        expectEq(phases[phases.length - 1], "orbit", "orbit last");
        // altitude actually increases during ascent (0 → stageSeparationAltitudeKm)
        var ascentStart = out.timeline[1], ascentEnd = out.timeline[2];
        expectEq(ascentStart.altitudeKm, 0, "ascent starts at 0");
        expectEq(ascentEnd.altitudeKm, okMission.stageSeparationAltitudeKm, "ascent ends at stage sep altitude");
        expect(ascentEnd.altitudeKm > ascentStart.altitudeKm, "altitude rises during ascent");
        // coast rises from stage sep altitude to target
        var coastSamples = out.timeline.filter(function (p) { return p.phase === "coast"; });
        expect(coastSamples.length >= 2, "coast has start and end samples");
        var coastEnd = coastSamples[coastSamples.length - 1];
        expectEq(coastEnd.altitudeKm, okMission.targetAltitudeKm, "coast ends at target altitude");
        expect(coastEnd.altitudeKm > ascentEnd.altitudeKm, "altitude rises during coast");
      });

      check("launch: failed in-flight timeline ends exactly at failure point", function () {
        var m = mkMission({ id: "TEST_MISSION_STAGE", eventChance: 1 });
        var out = launch(okBuild, m);
        var last = out.timeline[out.timeline.length - 1];
        expectEq(last.t, out.failure.timeS, "t matches");
        expectEq(last.altitudeKm, out.failure.altitudeKm, "altitude matches");
        expectEq(last.phase, out.failure.stage, "phase matches");
        // no sample after the failure
        expect(out.timeline.every(function (p) { return p.t <= out.failure.timeS; }), "no post-failure samples");
      });

      check("launch: validation failure stops at pad with reason diagnostic", function () {
        var out = launch(mkBuild({ rocketId: "NOPE" }), okMission);
        expectEq(out.success, false, "failed");
        expectEq(out.failure.type, "invalid_build", "type");
        expect(typeof out.failure.numbers.reason === "string" && out.failure.numbers.reason.length > 0,
          "reason present");
        expectEq(out.failure.timeS, 0, "timeS 0");
        expectEq(out.timeline.length, 1, "pad only");
        expectEq(out.score.total, 0, "zero score");
      });

      /* ---------- deterministic randomness ---------- */
      check("determinism: identical inputs → identical outcomes", function () {
        var m = mkMission({ id: "TEST_MISSION_DETERMINISM", eventChance: 0.35 });
        var a = launch(okBuild, m);
        var b = launch(okBuild, m);
        expect(deepEq(a, b), "same inputs must deep-equal");
      });

      check("determinism: changing fuelKg changes stats; identical inputs stay identical", function () {
        var low = mkBuild({ fuelKg: 8000 });
        var high = mkBuild({ fuelKg: 12000 });
        var s1 = computeStats(low, okMission);
        var s2 = computeStats(high, okMission);
        // meaningful input change → the related stats must actually change
        expect(s2.totalMassKg > s1.totalMassKg, "totalMassKg must rise with fuelKg");
        expect(s2.fuelLeftPct > s1.fuelLeftPct, "fuelLeftPct must rise with fuelKg");
        expect(s2.cost > s1.cost, "cost must rise with fuelKg (fuel cost)");
        expect(s2.deltaVAvailable > s1.deltaVAvailable, "deltaVAvailable must rise with fuelKg");
        expectEq(s2.cost - s1.cost, (12000 - 8000) * 10, "cost delta = Δfuel × fuelCostPerKg");
        expectEq(s2.totalMassKg - s1.totalMassKg, 4000, "mass delta = Δfuel");
        // different build → different full outcome
        var o1 = launch(low, okMission);
        var o2 = launch(high, okMission);
        expect(!deepEq(o1, o2), "different builds must produce different outcomes");
        // identical inputs → byte-identical outcome
        expect(deepEq(launch(okBuild, okMission), launch(okBuild, okMission)),
          "identical inputs must reproduce identical outcomes");
      });

      check("determinism: every failure case reproduces exactly (incl. incidents)", function () {
        var cases = [
          [mkBuild({ rocketId: "TEST_ROCKET_B", engineCount: 1, fuelKg: 3000, components: ["TEST_COMP_SENSOR"] }),
           mkMission({ allowedRockets: ["TEST_ROCKET_B"] })],
          [okBuild, mkMission({ id: "TEST_MISSION_STAGE", eventChance: 1 })],
          [okBuild, mkMission({ id: "TEST_MISSION_SENSOR_2", eventChance: 0.5 })]
        ];
        cases.forEach(function (c, i) {
          var a = launch(c[0], c[1]);
          var b = launch(c[0], c[1]);
          expect(deepEq(a, b), "case " + i + " must be reproducible");
        });
      });

      /* ---------- numeric safety across outcomes ---------- */
      check("no NaN/Infinity anywhere in any outcome", function () {
        var outs = [
          launch(okBuild, okMission),
          launch(mkBuild({ fuelKg: 0, engineCount: 0 }), okMission),
          launch(mkBuild({ rocketId: "NO_SUCH_ROCKET" }), okMission),
          launch(mkBuild({ rocketId: "TEST_ROCKET_B", engineCount: 1, fuelKg: 3000, components: ["TEST_COMP_SENSOR"] }),
                 mkMission({ allowedRockets: ["TEST_ROCKET_B"] })),
          launch(okBuild, mkMission({ id: "TEST_MISSION_STAGE", eventChance: 1 })),
          launch(okBuild, mkMission({ id: "TEST_MISSION_EMPTY_FUEL", fuelKg: 0 }))
        ];
        outs.forEach(function (o, i) {
          expect(allFinite(o), "outcome " + i + " contains NaN/Infinity");
        });
      });

      check("edge: zero engines in build → engine_limit validation failure", function () {
        var out = launch(mkBuild({ engineCount: 0 }), okMission);
        expectEq(out.success, false, "fails");
        expectEq(out.failure.type, "engine_limit", "validation-class type");
        expectEq(out.score.total, 0, "zero score");
      });

      check("edge: zero fuel → fuel_out or valid zero-pct stats", function () {
        var out = launch(mkBuild({ fuelKg: 0 }), okMission);
        expectEq(out.success, false, "cannot reach orbit with no fuel");
        expectEq(out.failure.type, "fuel_out", "type");
        expectEq(out.stats.fuelLeftPct, 0, "fuelLeftPct 0");
        expectEq(out.failure.numbers.fuelKg, 0, "fuelKg 0");
      });

      check("edge: negative/NaN engineCount fuel etc. never leak NaN into outcome", function () {
        var out = launch(mkBuild({ engineCount: -3, fuelKg: NaN }), okMission);
        expectEq(out.success, false, "fails");
        expectEq(out.failure.type, "invalid_build", "invalid_build");
        expect(allFinite(out), "finite");
      });

      /* ---------- structure equality with the frozen contract ---------- */
      check("outcome structure matches the frozen contract exactly", function () {
        var good = launch(okBuild, okMission);
        var bad = launch(okBuild, mkMission({ limits: { budget: 10 } }));
        [good, bad].forEach(function (o) {
          expect(Object.keys(o).join(",") === "success,failure,stats,events,score,timeline",
            "outcome keys: " + Object.keys(o).join(","));
          expect(Object.keys(o.stats).join(",") === STATS_KEYS.join(","),
            "stats keys: " + Object.keys(o.stats).join(","));
          expect(Object.keys(o.score).join(",") === "total,passed,parts", "score keys");
          expect(Object.keys(o.score.parts).join(",") ===
            "base,budgetBonus,massBonus,sparePowerBonus,spareFuelBonus,eventPenalty", "parts keys");
          if (o.failure) {
            expect(Object.keys(o.failure).join(",") === "type,altitudeKm,timeS,stage,numbers",
              "failure keys: " + Object.keys(o.failure).join(","));
          }
          o.events.forEach(function (e) {
            expect(Object.keys(e).join(",") === "type,atS,recovered", "event keys");
          });
          o.timeline.forEach(function (p) {
            expect(Object.keys(p).join(",") === "t,altitudeKm,phase", "timeline keys");
          });
        });
      });

      check("all seven mission failure types are reachable", function () {
        var seen = {};
        seen.thrust_low = launch({ rocketId: "TEST_ROCKET_B", engineCount: 1, fuelKg: 3000, components: ["TEST_COMP_SENSOR"] },
          mkMission({ allowedRockets: ["TEST_ROCKET_B"] })).failure.type;
        seen.fuel_out = launch(mkBuild({ fuelKg: 500, components: ["TEST_COMP_SENSOR"] }), okMission).failure.type;
        seen.power_short = launch(mkBuild({ components: ["TEST_COMP_SENSOR"] }), okMission).failure.type;
        seen.over_budget = launch(okBuild, mkMission({ limits: { budget: 100 } })).failure.type;
        seen.over_mass = launch(okBuild, mkMission({ limits: { maxMassKg: 100 } })).failure.type;
        seen.stage_fail = launch(okBuild, mkMission({ id: "TEST_MISSION_STAGE", eventChance: 1 })).failure.type;
        seen.sensor_fault = launch(okBuild, mkMission({ id: "TEST_MISSION_SENSOR_2", eventChance: 0.5 })).failure.type;
        Object.keys(seen).forEach(function (k) {
          expectEq(seen[k], k, "reachability of " + k);
        });
      });

      check("no recovery logic anywhere in the module (contract removal)", function () {
        expect(typeof root.SMG.sim === "object", "sim exposed");
        // every incident event in every test run must be unrecovered
        var out = launch(okBuild, mkMission({ id: "TEST_MISSION_STAGE", eventChance: 1 }));
        expectEq(out.events[0].recovered, false, "recovered always false");
        expect(root.SMG.sim.launch.length === 2, "launch(build, mission) arity");
      });

      check("score bonuses computed only for successful missions", function () {
        var out = launch(okBuild, okMission);
        expect(out.score.parts.base > 0, "base > 0");
        expect(out.score.parts.budgetBonus >= 0, "budget bonus");
        expect(out.score.parts.massBonus >= 0, "mass bonus");
        expect(out.score.parts.sparePowerBonus >= 0, "power bonus");
        expect(out.score.parts.spareFuelBonus >= 0, "fuel bonus");
        expectEq(out.score.parts.eventPenalty, 0, "no events on success");
        var sum = out.score.parts.base + out.score.parts.budgetBonus + out.score.parts.massBonus +
                  out.score.parts.sparePowerBonus + out.score.parts.spareFuelBonus - out.score.parts.eventPenalty;
        expectEq(out.score.total, Math.round(clamp(sum, 0, okMission.maxScore)), "total = clamp(sum)");
      });

    } finally {
      testFixture = savedFixture;   // isolate: restore whatever was there before
    }

    var passed = 0, failed = 0;
    checks.forEach(function (c) { c.pass ? passed++ : failed++; });
    return { passed: passed, failed: failed, checks: checks };
  }

  /* ==========================================================================
   * Public API export (exact frozen surface)
   * ========================================================================== */
  root.SMG.sim = {
    computeStats: computeStats,
    validate: validate,
    launch: launch,
    _selfTest: _selfTest
  };

})(typeof window !== "undefined" ? window : globalThis);
