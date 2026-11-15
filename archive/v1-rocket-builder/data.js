/**
 * ============================================================================
 * Space-Max — game data module (js/data.js)
 * ============================================================================
 * Schema matches js/sim.js exactly (Simulation Handoff contract):
 *
 *   SMG.data = {
 *     missions, rockets, components, fuelCostPerKg,
 *     getMission(id), getRocket(id), getComponent(id)   // null when not found
 *   }
 *
 * Mission: id, name, briefing, targetAltitudeKm, stageSeparationAltitudeKm,
 *          payloadMassKg, limits { budget, maxMassKg, requiredPowerW },
 *          passScore, maxScore, eventChance, allowedRockets, fact
 *   - targetAltitudeKm > 0
 *   - 0 <= stageSeparationAltitudeKm < targetAltitudeKm
 *
 * Rocket:  id, name, thrustKN, dryMassKg, maxFuelKg, maxEngines, cost, stages,
 *          engine { id, name, massKg, cost, powerDrawW }
 *   - thrustKN is thrust PER ENGINE (sim multiplies by build.engineCount)
 *   - engine.massKg / cost / powerDrawW are PER ENGINE values
 *   - dryMassKg and cost EXCLUDE engines and fuel (no double counting)
 *
 * Component: id, name, category, massKg, powerDrawW, powerGenW, cost
 *
 * NOTE: All numeric values below are realistic, internally consistent
 * PROVISIONAL game values for playable testing. They are intended to be
 * tuned later during playtesting (balancing budgets, masses, power, prices)
 * — every field is data-only and requires no code changes to adjust.
 * ============================================================================
 */
(function (root) {
  "use strict";

  if (typeof window !== "undefined") {
    window.SMG = window.SMG || {};
  }
  root.SMG = root.SMG || {};

  /* ==========================================================================
   * Fuel pricing (provisional — tunable)
   * ========================================================================== */
  var FUEL_COST_PER_KG = 18;   // $/kg of propellant

  /* ==========================================================================
   * Rockets (provisional values — tunable)
   * ========================================================================== */
  var rockets = [
    {
      id: "atlas_v_401",
      name: "Atlas V-401 (Medium Lift)",
      thrustKN: 1200,             // PER ENGINE
      dryMassKg: 12000,           // airframe only — no engines, no fuel
      maxFuelKg: 40000,
      maxEngines: 4,
      cost: 12000000,             // airframe only — no engines, no fuel
      stages: 2,
      engine: {
        id: "eng_rs68_a",
        name: "RS-68A Booster Engine",
        massKg: 550,              // per engine
        cost: 2500000,            // per engine
        powerDrawW: 1200          // per engine
      }
    },
    {
      id: "heavy_explorer",
      name: "Heavy Explorer SLS-Class (Heavy Lift)",
      thrustKN: 2400,             // PER ENGINE
      dryMassKg: 30000,           // airframe only — no engines, no fuel
      maxFuelKg: 140000,
      maxEngines: 4,
      cost: 42000000,             // airframe only — no engines, no fuel
      stages: 3,
      engine: {
        id: "eng_rs25_c",
        name: "RS-25 Deep-Cycle Engine",
        massKg: 950,              // per engine
        cost: 4200000,            // per engine
        powerDrawW: 2000          // per engine
      }
    }
  ];

  /* ==========================================================================
   * Components (provisional values — tunable)
   * ========================================================================== */
  var components = [
    {
      id: "solar_array_x",
      name: "Deployable Solar Array",
      category: "power",
      massKg: 420,
      powerDrawW: 25,
      powerGenW: 7000,
      cost: 3200000
    },
    {
      id: "xray_scope",
      name: "X-Ray Telescope Assembly",
      category: "science",
      massKg: 860,
      powerDrawW: 420,
      powerGenW: 0,
      cost: 7400000
    },
    {
      id: "star_tracker",
      name: "Star Tracker Guidance Unit",
      category: "guidance",
      massKg: 55,
      powerDrawW: 120,
      powerGenW: 0,
      cost: 1100000
    },
    {
      id: "high_gain_dish",
      name: "High-Gain Antenna Dish",
      category: "comms",
      massKg: 260,
      powerDrawW: 300,
      powerGenW: 0,
      cost: 2600000
    },
    {
      id: "land_imager",
      name: "Multispectral Land Imager",
      category: "science",
      massKg: 640,
      powerDrawW: 520,
      powerGenW: 0,
      cost: 5800000
    },
    {
      id: "mag_sweep",
      name: "Magnetometer Sweep Array",
      category: "science",
      massKg: 95,
      powerDrawW: 90,
      powerGenW: 0,
      cost: 950000
    }
  ];

  /* ==========================================================================
   * Missions (provisional values — tunable)
   *
   * Example builds that satisfy each mission (verified: validate OK,
   * launch succeeds and passes the score threshold — reference only, not data):
   *   leo_earth_survey:
   *     { rocketId: "atlas_v_401", engineCount: 3, fuelKg: 22000,
   *       components: ["solar_array_x", "land_imager", "star_tracker"] }
   *   meo_comm_relay:
   *     { rocketId: "heavy_explorer", engineCount: 4, fuelKg: 108000,
   *       components: ["solar_array_x", "solar_array_x",
   *                    "high_gain_dish", "mag_sweep"] }
   *   lunar_gateway_run:
   *     { rocketId: "heavy_explorer", engineCount: 4, fuelKg: 123000,
   *       components: ["solar_array_x", "solar_array_x", "solar_array_x",
   *                    "high_gain_dish", "star_tracker"] }
   * ========================================================================== */
  var missions = [
    {
      id: "leo_earth_survey",
      name: "Landsat Horizon Survey",
      briefing: "Deploy an Earth-observation platform into low orbit and return " +
                "continuous multispectral imagery of the planet's surface.",
      targetAltitudeKm: 705,
      stageSeparationAltitudeKm: 115,
      payloadMassKg: 2600,
      limits: {
        budget: 32000000,
        maxMassKg: 42000,
        requiredPowerW: 1000
      },
      passScore: 600,
      maxScore: 1000,
      eventChance: 0.15,
      allowedRockets: ["atlas_v_401"],
      fact: "Landsat 8 flies at 705 km, completing a full ground-track repeat every 16 days."
    },
    {
      id: "meo_comm_relay",
      name: "TDRS Relay Cluster",
      briefing: "Boost a communications relay package into medium Earth orbit to " +
                "extend deep-space network coverage for future missions.",
      targetAltitudeKm: 1500,
      stageSeparationAltitudeKm: 140,
      payloadMassKg: 4200,
      limits: {
        budget: 95000000,
        maxMassKg: 160000,
        requiredPowerW: 2500
      },
      passScore: 650,
      maxScore: 1000,
      eventChance: 0.3,
      allowedRockets: ["atlas_v_401", "heavy_explorer"],
      fact: "NASA's TDRS satellites relay data between spacecraft and ground stations worldwide."
    },
    {
      id: "lunar_gateway_run",
      name: "Gateway Assembly Run",
      briefing: "Haul a heavy habitat module toward cislunar space. Only the most " +
                "powerful vehicle in the fleet qualifies for this contract.",
      targetAltitudeKm: 3000,
      stageSeparationAltitudeKm: 250,
      payloadMassKg: 9500,
      limits: {
        budget: 100000000,
        maxMassKg: 180000,
        requiredPowerW: 4000
      },
      passScore: 700,
      maxScore: 1000,
      eventChance: 0.45,
      allowedRockets: ["heavy_explorer"],
      fact: "The real lunar Gateway will orbit the Moon at about 70,000 km — this arcade model compresses that scale."
    }
  ];

  /* ==========================================================================
   * Accessors (null when not found — sim.js relies on this behaviour)
   * ========================================================================== */
  function findById(list, id) {
    if (typeof id !== "string") return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  root.SMG.data = {
    missions: missions,
    rockets: rockets,
    components: components,
    fuelCostPerKg: FUEL_COST_PER_KG,
    getMission: function (id) { return findById(missions, id); },
    getRocket: function (id) { return findById(rockets, id); },
    getComponent: function (id) { return findById(components, id); }
  };

})(typeof window !== "undefined" ? window : globalThis);
