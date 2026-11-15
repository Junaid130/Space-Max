// ---------------------------------------------------------------------------
// data.js -- mission content, failure copy and knowledge blurbs.
//
// Content only, zero logic. Mission design (v2): five missions, two notched
// controls each -- per SKILL.md "Mission design (v2)" (section 2). The sim
// evaluates choices; this file only describes missions and failures.
// Option labels, objectives, control labels and knowledge text follow the
// mission design in SKILL.md verbatim.
// ---------------------------------------------------------------------------

window.SMG = window.SMG || {};

SMG.data = {

  missions: [

    // -- Mission 1 ---------------------------------------------------------
    {
      id: 'm1_lunar_landing',
      order: 1,
      name: 'The Apollo 11 Lunar Landing',
      destinationId: 'moon',
      destinationName: 'Moon',
      objective: 'Reach the Moon and land softly inside the green target zone.',
      assets: { rocket: 'Saturn V.glb', payload: 'Apollo Lunar Module.glb' },
      controls: [
        {
          id: 'staging',
          label: 'Empty Booster Stages',
          options: [
            { id: 'attached', label: 'Keep Attached' },
            { id: 'drop50', label: 'Drop at 50% Fuel' },
            { id: 'dropEmpty', label: 'Drop When Empty' }
          ],
          correct: 'dropEmpty'
        },
        {
          id: 'brake',
          label: 'Moon Landing Brake',
          options: [
            { id: 'chute', label: 'Deploy Parachute' },
            { id: 'retro', label: 'Steady Retro-Thrust' },
            { id: 'blast', label: 'Max Blast Retro-Thrust' }
          ],
          correct: 'retro'
        }
      ],
      win: {
        combo: { staging: 'dropEmpty', brake: 'retro' },
        successCopy: 'The empty booster dropped away at just the right time, and steady retro-thrust set the lander down softly inside the green target zone. One small step -- the crew is safe!'
      },
      fails: {
        'staging:attached': {
          type: 'too_heavy',
          title: 'Too Heavy to Fly',
          message: 'The empty tanks are still onboard, so the rocket never gets high enough to reach the Moon.',
          atPhase: 'ascent'
        },
        'staging:drop50': {
          type: 'fuel_out',
          title: 'Ran Out of Fuel',
          message: 'Dropping the booster with fuel still in it leaves the rocket dry partway to the Moon.',
          atPhase: 'coast'
        },
        'brake:chute': {
          type: 'parachute_vacuum',
          title: 'No Air for Parachutes',
          message: 'The Moon has no air, so the parachute pops open and hangs limp, slowing nothing.',
          atPhase: 'landing'
        },
        'brake:blast': {
          type: 'retro_exhaust',
          title: 'Too Much Retro Blast',
          message: 'Max blast spends all the landing fuel high above the surface, so the lander drops the rest of the way down.',
          atPhase: 'landing'
        }
      },
      knowledge: {
        title: 'Rocket Staging & Vacuum Physics',
        text: 'carrying empty tanks wastes energy; parachutes only work where there is an atmosphere.'
      }
    },

    // -- Mission 2 ---------------------------------------------------------
    {
      id: 'm2_mars_orbit',
      order: 2,
      name: 'Mars Surveyor Orbit Capture',
      destinationId: 'mars',
      destinationName: 'Mars',
      objective: 'Use Mars\'s gravity and reverse engines to lock into a stable orbit.',
      assets: { rocket: 'Atlas_V_401.glb', payload: 'Mars Global Surveyor.glb' },
      controls: [
        {
          id: 'flyby',
          label: 'Flyby Distance',
          options: [
            { id: 'low', label: 'Low (Skim Atmosphere)' },
            { id: 'medium', label: 'Medium (Just Above Air)' },
            { id: 'high', label: 'High (Far Out)' }
          ],
          correct: 'medium'
        },
        {
          id: 'brake',
          label: 'Retro-Burn Brake',
          options: [
            { id: 'short', label: 'Short Puff' },
            { id: 'balanced', label: 'Balanced Burn' },
            { id: 'full', label: 'Full Stop' }
          ],
          correct: 'balanced'
        }
      ],
      win: {
        combo: { flyby: 'medium', brake: 'balanced' },
        successCopy: 'A balanced burn at the medium flyby let Mars gravity bend the path into a stable orbit. The surveyor is locked in and ready to map the planet.'
      },
      fails: {
        'flyby:low': {
          type: 'atmospheric_burn',
          title: 'Skimming Too Low',
          message: 'Skimming the atmosphere made air friction heat the probe as it raced past Mars.',
          atPhase: 'approach'
        },
        'flyby:high': {
          type: 'escape_trajectory',
          title: 'Drifting into Deep Space',
          message: 'Out that far, Mars gravity is too weak to bend the path, so the probe sails on into space.',
          atPhase: 'orbit'
        },
        'brake:short': {
          type: 'escape_trajectory',
          title: 'Drifting into Deep Space',
          message: 'A short puff does not slow the probe enough, so it sails past Mars and keeps going.',
          atPhase: 'orbit'
        },
        'brake:full': {
          type: 'gravity_well_impact',
          title: 'Pulled Down to Mars',
          message: 'A full stop kills the forward speed, and Mars gravity pulls the probe down to the surface.',
          atPhase: 'orbit'
        }
      },
      knowledge: {
        title: 'Orbital Capture & Atmospheric Entry',
        text: 'orbiting balances forward speed and gravity; dip too low and air friction destroys you, brake too hard and you fall.'
      }
    },

    // -- Mission 3 ---------------------------------------------------------
    {
      id: 'm3_lunar_gateway',
      order: 3,
      name: 'Lunar Gateway Core Placement',
      destinationId: 'earth_moon',
      destinationName: 'Earth–Moon Space',
      objective: 'Park the station module in a stable Halo Orbit between Earth and the Moon.',
      assets: { rocket: 'Saturn V.glb', payload: 'Gateway Core.glb' },
      controls: [
        {
          id: 'zone',
          label: 'Parking Zone',
          options: [
            { id: 'earth', label: 'Earth Side' },
            { id: 'lagrange', label: 'Lagrange Balance Point' },
            { id: 'moon', label: 'Moon Side' }
          ],
          correct: 'lagrange'
        },
        {
          id: 'rcs',
          label: 'Micro-Thrusters (RCS)',
          options: [
            { id: 'off', label: 'OFF' },
            { id: 'auto', label: 'Auto-Pulse' }
          ],
          correct: 'auto'
        }
      ],
      win: {
        combo: { zone: 'lagrange', rcs: 'auto' },
        successCopy: 'The micro-thrusters pulsed at the Lagrange balance point, and the Gateway core settled into a steady halo orbit between Earth and the Moon.'
      },
      fails: {
        'zone:earth': {
          type: 'gravity_tug',
          title: 'Tugged Toward Earth',
          message: 'Parking on the Earth side lets our own world tug the station slowly off course.',
          atPhase: 'deploy'
        },
        'zone:moon': {
          type: 'gravity_tug',
          title: 'Tugged Toward the Moon',
          message: 'Parking on the Moon side lets the Moon win the tug-of-war and pull the station away.',
          atPhase: 'deploy'
        },
        'rcs:off': {
          type: 'station_drift',
          title: 'The Station Drifts Away',
          message: 'With the micro-thrusters off, the station hovers for a moment, then drifts away as the Moon moves.',
          atPhase: 'deploy'
        }
      },
      knowledge: {
        title: 'Lagrange Points & Station-Keeping',
        text: 'space isn\'t zero gravity; stations park in gravitational balance zones and use tiny thruster pulses to fight drift.'
      }
    },

    // -- Mission 4 ---------------------------------------------------------
    {
      id: 'm4_landsat_polar',
      order: 4,
      name: 'Landsat 8 Polar Deployment',
      destinationId: 'earth_orbit',
      destinationName: 'Earth Orbit',
      objective: 'Place an Earth-mapping satellite where it photographs the entire planet over time.',
      assets: { rocket: 'Atlas_V_401.glb', payload: 'Landsat 8.glb' },
      controls: [
        {
          id: 'direction',
          label: 'Launch Direction',
          options: [
            { id: 'east', label: 'East (Along Equator)' },
            { id: 'polar', label: 'North–South (Over the Poles)' }
          ],
          correct: 'polar'
        },
        {
          id: 'altitude',
          label: 'Orbit Altitude',
          options: [
            { id: 'low', label: 'Low (150 km)' },
            { id: 'medium', label: 'Medium (700 km)' },
            { id: 'ultra', label: 'Ultra-High (36,000 km)' }
          ],
          correct: 'medium'
        }
      ],
      win: {
        combo: { direction: 'polar', altitude: 'medium' },
        successCopy: 'A polar orbit lets Earth\'s spin slide new land under the cameras, and a medium altitude stays high enough to skip the air drag. Landsat 8 will photograph the whole planet over time.'
      },
      fails: {
        'direction:east': {
          type: 'equatorial_orbit',
          title: 'Stuck Over the Equator',
          message: 'An eastward launch locks the satellite into the middle belt, so it photographs the same regions over and over.',
          atPhase: 'orbit'
        },
        'altitude:low': {
          type: 'drag_deorbit',
          title: 'Air Drag Pulled It Down',
          message: 'At low altitude the thin air drags on the satellite until its orbit decays and it falls back.',
          atPhase: 'orbit'
        },
        'altitude:ultra': {
          type: 'orbit_too_high',
          title: 'Too Far to See',
          message: 'The orbit is safe, but Earth looks tiny from up there, so the cameras cannot photograph the surface.',
          atPhase: 'deploy'
        }
      },
      knowledge: {
        title: 'Polar Orbits & Atmospheric Drag',
        text: 'let Earth\'s daily spin bring new land beneath the camera; fly high enough to escape air drag.'
      }
    },

    // -- Mission 5 ---------------------------------------------------------
    {
      id: 'm5_chandra_slingshot',
      order: 5,
      name: 'Chandra Deep Space Slingshot',
      destinationId: 'high_earth_orbit',
      destinationName: 'High Earth Orbit',
      objective: 'Catapult the delicate X-ray telescope outside Earth\'s glowing red radiation belts.',
      assets: { payload: 'Chandra X-ray Observatory.glb' },
      controls: [
        {
          id: 'burn',
          label: 'Where to Fire Booster',
          options: [
            { id: 'apogee', label: 'Highest Point (Apogee)' },
            { id: 'perigee', label: 'Lowest Point (Perigee)' }
          ],
          correct: 'perigee'
        },
        {
          id: 'nose',
          label: 'Which Way to Point Nose',
          options: [
            { id: 'up', label: 'Point Up (Away from Earth)' },
            { id: 'forward', label: 'Point Forward (Along Orbit)' }
          ],
          correct: 'forward'
        }
      ],
      win: {
        combo: { burn: 'perigee', nose: 'forward' },
        successCopy: 'A forward burn at perigee -- the Oberth effect at its strongest -- stretched Chandra\'s orbit outward, clear of the glowing radiation belts.'
      },
      fails: {
        // burn:apogee has no per-option entry: it only fails in combination
        // (see comboFails below). The sim's control walk skips it and lands
        // on the nose entry, exactly as the mission design specifies.
        'nose:up': {
          type: 'wrong_axis_burn',
          title: 'Orbit Twisted Sideways',
          message: 'Pointing up pushes the nose the wrong way, and the orbit twists sideways instead of stretching out.',
          atPhase: 'orbit'
        }
      },
      comboFails: {
        'burn:apogee|nose:forward': {
          type: 'weak_boost',
          title: 'Boost Too Weak',
          message: 'Firing at the slowest point gives a feeble push, so Chandra stays trapped inside the Van Allen belts.',
          atPhase: 'orbit'
        }
      },
      knowledge: {
        title: 'The Oberth Effect & Van Allen Belts',
        text: 'you reach deep space by speeding up forward, not pointing up; firing engines at maximum speed gives the biggest boost.'
      }
    }
  ],

  // Fallback copy keyed by every failure TYPE (14 v2 types + the 7 legacy
  // types from SKILL.md section 12). Used when a mission entry lacks copy,
  // and by the scene's failure labels / preview lab mock outcomes.
  failures: {
    // --- v2 mission-design types ---
    too_heavy: {
      title: 'Too Heavy to Fly',
      message: 'The extra weight onboard keeps the rocket from climbing all the way.'
    },
    parachute_vacuum: {
      title: 'No Air for Parachutes',
      message: 'A parachute needs air to push against, and without an atmosphere it just hangs limp.'
    },
    retro_exhaust: {
      title: 'Too Much Retro Blast',
      message: 'Burning too hard too early spends the landing fuel high up, leaving nothing for the touchdown.'
    },
    atmospheric_burn: {
      title: 'Skimming Too Low',
      message: 'Flying through air makes friction and heat build up on the outside of the craft.'
    },
    escape_trajectory: {
      title: 'Drifting into Deep Space',
      message: 'Without enough pull or enough braking, the craft drifts away on a straight line into space.'
    },
    gravity_well_impact: {
      title: 'Gravity Pulled It Down',
      message: 'Braking too hard leaves no forward speed, so gravity pulls the craft down to the surface.'
    },
    gravity_tug: {
      title: 'Tugged Off Course',
      message: 'The nearer world wins the tug-of-war and slowly pulls the craft off its parking spot.'
    },
    station_drift: {
      title: 'The Station Drifts Away',
      message: 'With no thruster pulses, the station hovers for a moment, then slowly drifts away.'
    },
    equatorial_orbit: {
      title: 'Stuck Over the Equator',
      message: 'An eastward launch keeps the craft over the middle belt, repeating the same view.'
    },
    drag_deorbit: {
      title: 'Air Drag Pulled It Down',
      message: 'Thin air drags on the craft until the orbit decays and it falls back.'
    },
    orbit_too_high: {
      title: 'Too Far to See',
      message: 'From up high the planet looks tiny, so the cameras cannot photograph much detail.'
    },
    weak_boost: {
      title: 'Boost Too Weak',
      message: 'A push at the slowest point is too feeble to reach deep space.'
    },
    wrong_axis_burn: {
      title: 'Orbit Twisted Sideways',
      message: 'Thrusting the wrong way twists the orbit sideways instead of stretching it outward.'
    },
    mission_fail: {
      title: 'A Small Setback',
      message: 'Something did not go as planned this time -- check the settings and try again.'
    },

    // --- legacy types (SKILL.md section 12) ---
    thrust_low: {
      title: 'Not Enough Thrust',
      message: 'The engines could not push hard enough, and the rocket settled gently back onto the pad.'
    },
    fuel_out: {
      title: 'Ran Out of Fuel',
      message: 'The rocket ran dry before it could finish the climb.'
    },
    power_short: {
      title: 'Power Ran Short',
      message: 'The lights and signals went dark when the power ran short.'
    },
    sensor_fault: {
      title: 'A Sensor Got Confused',
      message: 'A confused sensor nudged the rocket gently off its ideal path.'
    },
    stage_fail: {
      title: 'Stage Did Not Separate',
      message: 'The stage separation jammed, and the loose pieces drifted safely away.'
    },
    over_budget: {
      title: 'Over Budget',
      message: 'This build costs more than the mission can cover, so launch is paused.'
    },
    over_mass: {
      title: 'Too Heavy to Launch',
      message: 'The vehicle is heavier than the launch limit, so it needs a lighter build.'
    }
  }
};
