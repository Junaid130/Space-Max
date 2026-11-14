---
name: space-mission-visuals
description: Build and polish the Three.js visuals, cinematic launch and planetary-exploration sequences, rover/astronaut deployment, animation previews, and responsive kid-friendly UI styling for the Space Mission Game. Use when working on js/scene.js and css/style.css. Covers the pinned Three.js r128 global build, the 3dmodels/ asset inventory, and the SMG.scene contract.
---

# Space Mission Game — Visuals & Animation Engineering Skill

## 1. Role and quality bar

Act as a senior real-time 3D game-visuals engineer with decades of production experience, applying the systems discipline of a space-mission visualization team and the craft of a polished family-friendly game.

The result must feel like a finished educational game, not a classroom prototype: coherent art direction, readable motion, clear visual storytelling, deliberate camera work, responsive UI, stable performance, and robust cleanup. NASA-inspired does not mean NASA-endorsed: do not add NASA logos, trademarks, or imply official affiliation.

The audience includes children. Keep the experience exciting, reassuring, accessible, and scientifically respectful. Use short labels, high contrast, readable type, and non-graphic failure effects. Do not use frightening explosions, gore, or harsh flashing.

**Primary ownership:**
- `js/scene.js`
- `css/style.css`

Read other project files when needed for integration, but do not edit another person's file. In particular, do not change `js/data.js`, `js/sim.js`, `js/ui.js`, or `index.html` without explicit agreement from that file's owner.

**Ownership discrepancy to resolve (open question):** `index.html` carries the comment `Person 4 owns this` above the `css/style.css` link, while this skill claims `css/style.css` as primary ownership. Confirm with the team who owns the stylesheet before the first edit, and record the answer here.

## 2. Project contract — never violate this

The project is a browser game for children about designing rockets and completing five missions. The flow is:

`campaign → briefing → build → launch animation → results`

The game uses arcade-style simulation and plain arithmetic. It is not a real rocket simulator.

All files attach to the shared global namespace:

```js
window.SMG = window.SMG || {};
```

The scene module must expose:

```js
SMG.scene = {
  init,
  showPad,
  playLaunch,
  skip
};
```

Required signatures:

```js
SMG.scene.init(containerEl)
SMG.scene.showPad(build)
SMG.scene.playLaunch(outcome, mission, onDone)
SMG.scene.skip()
```

`skip()` is an additive convenience API. Do not break the three required methods or their signatures.

### Non-negotiable simulation boundary

**The simulation owns every result. The scene only visualizes it.**

- `SMG.sim.launch(build, mission)` decides success, failure, numbers, events, score, and timeline.
- `outcome.timeline` is the source of truth for sequence and timing.
- `outcome.failure` is the source of truth for failure type and failure numbers.
- `outcome.events` is the source of truth for event/recovery flashes.
- `mission` and `SMG.data` are the source of truth for mission names, destinations, factual copy, and content when those fields exist.
- Never calculate thrust, mass, fuel, altitude, orbital insertion, success, failure, or score in `scene.js`.
- Never invent telemetry, scientific facts, mission outcomes, or failure measurements.
- Never change `outcome` or `mission` objects supplied by the simulation.
- Never award points, unlock missions, or alter saved progress.

If a value needed for a visual is missing, use a clearly non-numeric visual fallback or ask the relevant owner to add a field. Do not invent a game value.

## 3. Repository state — what actually exists today

Ground every decision in this snapshot (verify it still matches before relying on it; the repo moves fast).

### File inventory

| File | State | Notes |
|---|---|---|
| `index.html` | Implemented (37 lines) | Loads Three.js **r128 global build** from cdnjs, then `data.js → sim.js → scene.js → ui.js`, then calls `SMG.ui.start()`. Mount points: `#scene` (3D canvas) and `#app` (screens). |
| `js/ui.js` | Stub (1.2 KB) | Person 3. Exposes only `SMG.ui.start()`, which renders `.screen .screen--loading`. No real screens yet, and it does not call `SMG.scene` yet. |
| `js/scene.js` | **Empty (0 bytes)** | This skill's primary deliverable. |
| `css/style.css` | **Empty (0 bytes)** | This skill's second deliverable. |
| `js/data.js` | **Empty (0 bytes)** | Missions/rockets/failures content not landed yet (Person 1/2). |
| `js/sim.js` | **Empty (0 bytes)** | `SMG.sim.launch` not landed yet (Person 1/2). |
| `3dmodels/` | 11 GLB files, 74 MB | All model assets live here (not `models/`). |
| `project.md` | Empty | Ignore. |
| `README.md` | Title only | Do not edit (not ours). |
| `LICENSE` | Apache-2.0 | Repo license; keep new assets compatible. |

### Runtime facts

- **Three.js is pinned to r128 via CDN** (`https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js`). It is the old *global-script* build: everything hangs off `window.THREE`. The project intentionally has **no bundler, no ES modules, and must run with no build step**.
- The page needs **internet access at runtime** for the CDN. There is no local copy of Three.js.
- **No GLTFLoader and no GSAP are loaded yet.** `THREE.GLTFLoader` does not exist until someone adds it (see §8).
- All game files attach to `window.SMG` and communicate only through it.

### Consequences for planning

- `data.js` and `sim.js` are empty, so there is **no real mission content or outcome object to integrate against yet**. Build `scene.js` defensively against the contract in §2, develop with isolated mock outcomes, and re-verify when the real files land.
- `ui.js` is a placeholder, so nothing calls `SMG.scene` yet. Use the Preview Lab (§15) as the only way to exercise the scene until the UI grows real screens.
- Do not block on other people's files: ship a working, mock-driven scene first.

## 4. First action: inspect before coding

Before editing:

1. Inspect the actual project tree and confirm the precise locations of all supplied images and GLB files (`3dmodels/`). Do not guess paths from filenames; several filenames contain spaces and parentheses and must be encoded when fetched.
2. Read `index.html` to confirm the exact Three.js build/version, script order, renderer mount points, and whether a GLTF loader or GSAP has been added since this snapshot.
3. Read `js/ui.js` to identify the real screen class names, `#scene` container dimensions, skip/replay controls, and how the UI calls `SMG.scene`.
4. Read `js/data.js` and `js/sim.js` (once they exist) to understand the actual mission objects, failure copy, outcome shape, and timeline phases. Treat the shared handoff contract as the minimum, not a reason to assume unimplemented fields exist.
5. Run the supplied mock outcomes before polishing. Keep temporary mocks isolated from production logic.
6. Record any integration blockers and ask the correct owner; do not silently edit their files.

Do not spend the first day creating elaborate effects. First make the basic rocket move on a simple timeline, confirm the UI callback works, and then polish.

## 5. Visual direction

Create a unified visual language:

- **Space:** deep midnight navy, subtle stars, restrained nebula haze, clean orbital lines, bright but controlled highlights.
- **Earth:** blue oceans, readable land, atmospheric rim glow, soft cloud/lighting treatment if suitable source assets are available.
- **Moon:** cool grey surface, visible craters, pale rim lighting.
- **Mars:** warm rust-red terrain, dusty horizon, gentle surface haze.
- **Saturn:** warm gold/tan bands and a clear ring silhouette.
- **Rocket and landers:** readable silhouettes, believable scale relationships, crisp panel details, emissive engine elements.
- **Mission UI:** bright, friendly, rounded panels; strong hierarchy; clear progress indicators; short labels; no tiny text.

The planets are **mostly static scene anchors**. Do not make planets continuously spin, orbit around one another, or bounce. Their position and orientation should remain stable while the camera, rocket, lander, and foreground objects carry the action. A subtle atmospheric shimmer or light change is acceptable; avoid obvious rotation.

Use camera movement to create scale: slow push-ins, gentle tracking, controlled pullbacks, and clear framing. Avoid fast spins, random shaking outside failure sequences, and motion that makes it hard for children to follow what happened.

## 6. Asset inventory and manifest

All shipped assets live in **`3dmodels/`**. Create a central asset manifest at the top of `scene.js` (an internal map, not globals). Do not duplicate, rename, or move assets unless approved.

### GLB models present (11)

Roles below are **expected roles inferred from filenames — verify each by inspection** (scale, pivot, axes, materials, animation clips, triangle count) before assigning it to a scene role.

| File (exact name) | Expected role | Notes |
|---|---|---|
| `Atlas_V_401.glb` | Launch vehicle (rocket) | Added recently; check whether it suits the player's configurable rocket or a cutscene rocket. |
| `Saturn V.glb` | Launch vehicle (rocket) | Second rocket option. Two rocket GLBs exist — pick per scene need, do not use both at once. |
| `Apollo Lunar Module.glb` | Lander | The **only** lander-class model. |
| `Gateway Core.glb` | Space station | Good for orbit/relay staging. |
| `Mars Global Surveyor.glb` | Orbiter/satellite | Mars-adjacent payload candidate. |
| `Landsat 8.glb` | Orbiter/satellite | Earth-observation payload candidate. |
| `Tracking and Data Relay Satellites (TDRS) (A).glb` | Relay satellite | Natural fit for the data-uplink hop in §14. |
| `CubeSat - ICECube.glb` | Small satellite | Payload-deployment candidate. |
| `Ionospheric Connection Explorer (ICON).glb` | Satellite | Payload candidate. |
| `Earth Observing-1 (EO-1).glb` | Satellite | Payload candidate. |
| `Chandra X-ray Observatory.glb` | Observatory/satellite | Payload candidate. |

**Missing entirely:** any rover (`Mars_Rover.glb`, `Lunar_Rover.glb`) and any astronaut (`Astronaut.glb`) — see §7. Also missing: any texture files (next subsection).

### Texture images (4 — supplied in the project's `models/` staging folder, copy into `3dmodels/` before use)

Measured dimensions decide how each image may be used. **Do not stretch a rectangular surface photograph around a sphere and pretend it is a proper planetary map.**

| File | Size | Dimensions | Verdict |
|---|---|---|---|
| `images.jpeg` | 8 KB | 318×159 — **exactly 2:1** | Equirectangular **world-map aspect ratio** → Earth color-map candidate. Very low resolution: use with a procedural fallback and expect soft detail. Inspect contents to confirm it is actually a world map before use. |
| `saturn.jpeg` | 12 KB | 738×369 — **exactly 2:1** | **Band-map aspect ratio** → Saturn sphere color-map candidate. |
| `moon.jpeg` | 56 KB | 679×452 — 3:2 | **Surface photograph**, not a sphere map. Use as terrain/surface detail, a mission-card image, or a background panel. |
| `mars.jpeg` | 36 KB | 679×452 — 3:2 | **Surface photograph**, not a sphere map. Same rules as `moon.jpeg`. |

Rules:

- Always provide a procedural-colour fallback if a texture fails to load; the scene must never show a black sphere.
- These are small JPEGs: set `texture.encoding = THREE.sRGBEncoding` for colour maps (r128), keep `anisotropy` modest, and do not expect fine detail at close range.
- If an image is unsuitable for sphere UVs, use it as a terrain/surface detail, a mission card image, or a background panel instead.
- The Moon/Mars surface photos are the natural source for the rover "returned image" card in §14 — label it clearly as an illustrative simulation image.

### Manifest sketch

```js
var ASSETS = {
  textures: {
    earthMap:  '3dmodels/images.jpeg',    // 2:1 — Earth colour map candidate
    saturnMap: '3dmodels/saturn.jpeg',    // 2:1 — Saturn band map candidate
    moonPhoto: '3dmodels/moon.jpeg',      // 3:2 — surface photo, not a sphere map
    marsPhoto: '3dmodels/mars.jpeg'       // 3:2 — surface photo, not a sphere map
  },
  models: {
    rocketAtlas:   '3dmodels/Atlas_V_401.glb',
    rocketSaturnV: '3dmodels/Saturn V.glb',
    landerLM:      '3dmodels/Apollo Lunar Module.glb',
    station:       '3dmodels/Gateway Core.glb',
    satMGS:        '3dmodels/Mars Global Surveyor.glb',
    satLandsat:    '3dmodels/Landsat 8.glb',
    satTDRS:       '3dmodels/Tracking and Data Relay Satellites (TDRS) (A).glb',
    satICESat:     '3dmodels/CubeSat - ICECube.glb',
    satICON:       '3dmodels/Ionospheric Connection Explorer (ICON).glb',
    satEO1:        '3dmodels/Earth Observing-1 (EO-1).glb',
    obsChandra:    '3dmodels/Chandra X-ray Observatory.glb'
  },
  pending: {   // not in the repo yet — primitive fallback until they land
    roverMars:   '3dmodels/Mars_Rover.glb',
    roverMoon:   '3dmodels/Lunar_Rover.glb',
    astronaut:   '3dmodels/Astronaut.glb'
  }
};
```

Update this map whenever the team adds or renames an asset, and record license/source for anything new (§7). Filenames contain spaces and parentheses: always `encodeURI(path)` (or equivalent) before handing a path to a loader.

If a model is missing or fails to load, show a clean primitive fallback and a console warning; do not crash the scene.

## 7. Required new GLB assets: rovers and astronauts

The planetary exploration sequence is incomplete without surface vehicles and crew. Add or source these assets as project files, subject to team approval and a clear license/source record:

### Required

- `Mars_Rover.glb` — a recognizable six-wheel robotic exploration rover with a camera mast, visible wheels, and a compact scientific instrument body.
- `Lunar_Rover.glb` — a lightweight lunar surface rover. It may share a design language with the Mars rover, but it must read clearly as a separate asset or variant.
- `Astronaut.glb` — a friendly, low-poly astronaut suitable for a child-focused game. Reuse/clone the model to show the crew; do not create a large number of unique character meshes.

### Asset quality requirements

- Prefer clean, low-to-mid-poly models with readable silhouettes and efficient materials.
- Keep models optimized for browser use. Avoid huge textures, excessive material slots, and unnecessarily dense meshes. (`3dmodels/` is already 74 MB — watch total budget.)
- Confirm the model's forward/up axes and pivot. Normalize scale through a wrapper `THREE.Group`; do not destructively alter the source file.
- If the model includes animation clips, inspect and use them where helpful. If not, create simple procedural movement: wheel rotation, mast pan/tilt, astronaut walk cycle, hatch/ramp movement.
- Keep a record of the asset's author/source, license, and any attribution requirement. The repo is **Apache-2.0**; do not use an asset whose license is unknown or incompatible (e.g. NC/ND-licensed models). Record provenance in the handoff (§21).
- If suitable GLB files cannot be found under the approved asset rules, create simple original low-poly models and export them to GLB. Do not block the first playable build while sourcing perfect models: use primitive fallbacks until the GLBs are ready.

Recommended filenames are exact and descriptive. If the team has a naming convention already, preserve it and update the asset map.

## 8. Dependencies and loaders — resolved for the pinned r128 build

The architecture conflict is now decidable because the repo pins a specific version:

- Plain `<script>` tags; no JavaScript modules; no bundler; must run with no build step.
- Three.js **r128 global build** is loaded by `index.html` and exposes `window.THREE`.
- **GLTFLoader is not loaded yet**, and modern Three.js docs describe module-only addons — but that applies to *current* Three.js, **not** to r128. r128 shipped the legacy global-script loader, and it still exists as a file in the pinned npm package.

### GLTFLoader — the smallest coherent solution

Verified to exist for the pinned version:

```html
<!-- request this via Person 3; do not edit index.html yourself -->
<script src="https://unpkg.com/three@0.128.0/examples/js/loaders/GLTFLoader.js"></script>
```

This attaches `THREE.GLTFLoader` globally (era-correct, non-module, compatible with the r128 build). Rules:

1. Inspect `index.html` first — if a loader script already exists, use it; never load two GLTFLoaders or a mismatched Three.js version.
2. The loader version **must** match the core version exactly (`three@0.128.0` ↔ r128). Never pair a modern ESM loader with the r128 global build.
3. If the team prefers a different source (cdnjs, jsdelivr, a vendored local file), that is fine — the requirement is *r128-compatible, global-script, pinned*.
4. Do not convert the project to a bundler, rewrite script loading, switch to ES modules, or downgrade/upgrade Three.js without Person 3's approval.
5. Guard defensively either way: `var hasGLTF = typeof THREE.GLTFLoader === 'function';` and keep a working primitive fallback so the scene functions with or without the loader (§19).

### GSAP

GSAP is not loaded yet. Prefer GSAP timelines for coordinated camera, object, and DOM-overlay choreography; it ships a regular browser script-tag (UMD) distribution. Verified to exist:

```html
<!-- request this via Person 3; do not edit index.html yourself -->
<script src="https://unpkg.com/gsap@3.12.5/dist/gsap.min.js"></script>
```

- Inspect whether a compatible global `gsap` is already loaded; if absent, request the pinned script above **before** `scene.js`.
- Use GSAP for choreography, not for simulation decisions.
- If GSAP is not approved, use one centralized `requestAnimationFrame` loop plus a small internal tween/timeline helper — never several competing animation systems.

Do not add a heavy post-processing stack just for glow. Use emissive materials, sprites, additive blending, light rigs, and restrained fog first. Add bloom or other post-processing only if approved and the laptop performance supports it.

### Local GLB loading and the `file://` caveat

Local GLB files are fetched by the browser. Under `file://`, that fetch is typically blocked by browser security rules, so **local GLB loading is not guaranteed from `file://`** — and note `index.html` explicitly wants to run without a build step, so this tension must be tested, not assumed.

Test asset loading through a simple local HTTP server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

Keep the code free of a build step and preserve the plain-script structure. If the team requires a `file://` fallback, the game must remain playable with procedural primitives when external/local GLB loading is blocked.

## 9. Three.js r128 specifics — do not paste modern APIs

The docs at threejs.org describe current Three.js. r128 (2021) differs in important ways. Verify every API against r128 before using it.

### Rendering setup that r128 expects

```js
renderer.outputEncoding = THREE.sRGBEncoding;          // r128 name — NOT outputColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
```

- `THREE.sRGBEncoding` is the colour-space API in r128. **`outputEncoding`/`texture.encoding`, not `outputColorSpace`/`texture.colorSpace`** (those are r152+ and will silently do nothing or throw here).
- Set `texture.encoding = THREE.sRGBEncoding` on colour textures you load manually; GLTFLoader handles its own materials.
- `THREE.MathUtils` exists in r128 (`clamp`, `lerp`, `randFloat`…). Prefer it over hand-rolled math helpers.
- Lights: r128 uses the legacy light intensity model — no `useLegacyLights` flag exists. Tune by eye.

### Loading GLBs in a global-script project

```js
function loadGLB(path, onLoad, onError) {
  if (typeof THREE.GLTFLoader !== 'function') { onError && onError(new Error('no loader')); return; }
  new THREE.GLTFLoader().load(encodeURI(path), onLoad, undefined, onError || function (e) {
    console.warn('[scene] GLB failed, using fallback:', path, e);
  });
}
```

- Normalize every model through a wrapper `THREE.Group`: measure the bounding box, scale to a target size, re-center the pivot, fix axis orientation. Never assume a model's units or forward axis.
- Cache the parsed GLTF template once; instance it with `.clone()` for repeats. For **skinned/animated** meshes, plain `.clone()` does not rebind skeletons — use `THREE.SkeletonUtils.clone` if repeated animated characters are needed, or load one instance per character (astronauts are few, so per-instance loading is acceptable).
- The `THREE.LoadingManager` `onError` callback is your single place to log asset failures for the fallback path (§19).

### Disposal (r128)

`geometry.dispose()`, `material.dispose()` (and each material in an array), `texture.dispose()`, `renderTarget.dispose()`, `renderer.dispose()`. r128 has **no automatic GPU cleanup for orphaned textures** — dispose explicitly, but only resources your run created (§17).

## 10. Scene architecture

Implement `js/scene.js` as a maintainable module attached to `SMG`, not as a pile of unrelated global variables:

```js
window.SMG = window.SMG || {};

SMG.scene = (function () {
  'use strict';
  // private state: renderer, camera, shared resources, runToken, activeRun, ...
  // private functions: initRenderer, createWorld, createRocket, loadModelAsset, ...

  function init(containerEl) { /* idempotent: one renderer, one RAF loop */ }
  function showPad(build) { /* idle rocket from build values */ }
  function playLaunch(outcome, mission, onDone) { /* timeline-driven */ }
  function skip() { /* cancel active run, settle, onDone once */ }

  return { init: init, showPad: showPad, playLaunch: playLaunch, skip: skip };
})();
```

Recommended internal responsibilities:

- `initRenderer(containerEl)` — renderer, canvas, pixel ratio, sizing, colour/tone configuration.
- `createWorld()` — scene, camera, lights, starfield, Earth, static planetary anchors.
- `createRocket()` — primitive rocket, configurable engine/nozzle groups, flame, stage/tank groups.
- `loadModelAsset(key, path)` — safe GLB loading through `THREE.GLTFLoader`, loading state, error callback, fallback.
- `buildLanderAndSurfaceSet(destination)` — lander, astronaut, rover, surface dressing.
- `createEffects()` — reusable flame, smoke, dust, warning, signal, and data-packet pools.
- `createOverlay()` — small accessible labels and transition cards inside `containerEl`.
- `mapTimeline(outcome)` — normalize the supplied simulation timeline into a visual schedule without changing event order.
- `playPhase(phase, context)` — one implementation per visual phase.
- `cleanupRun()` — stop tweens and clear only temporary objects/resources.
- `renderLoop()` — one persistent render loop; do not create one loop per launch.

Use private closures or an internal object. Avoid attaching many one-off globals to `window`.

### `scene.init(containerEl)`

- Initialize Three.js once. Repeated calls must not create duplicate renderers, canvases, resize handlers, or RAF loops (guard with an `initialized` flag).
- Build the renderer, perspective camera, ambient/key/fill/rim lighting, Earth, starfield, and launch pad.
- Mount the canvas inside `#scene` (the `containerEl` passed by the UI); keep the canvas from covering `#app` controls.
- Use a restrained atmospheric glow around Earth. Keep the launch area visually readable.
- Use `ResizeObserver` where available and a `window.resize` fallback. Disconnect/reuse observers correctly.
- Cap device pixel ratio (normally 1.5–2 maximum) to protect ordinary laptops.
- Handle WebGL/context initialization failure gracefully with a clear fallback message instead of a blank panel.
- Respect `prefers-reduced-motion` by reducing camera travel, shake, and particles.

### `scene.showPad(build)`

Show the idle rocket on the pad while the player builds it.

- Derive engine count and fuel presentation from the supplied `build` object. Do not invent builder values.
- Show multiple nozzle meshes when the build has multiple engines, within a sensible visual cap. The cap is visual only; never modify the build.
- Use subtle flame-off engine glow, pad lights, slow camera drift, and restrained ambient motion.
- Avoid restarting the entire scene or rebuilding shared geometries every time a slider changes.
- If `build` is missing or incomplete, use the default neutral pad rocket; never throw.

## 11. Animation timeline and sequence design

`playLaunch(outcome, mission, onDone)` must be driven by `outcome.timeline` and related fields. Map the source timeline's time range onto an overall playback of approximately **8–12 seconds**, as specified by the shared contract. Preserve the order of phases and interpolate camera/rocket positions between timeline samples. Do not assume the timeline always has many samples.

If the timeline is empty or contains only one sample, use a safe, short fallback path based on the actual outcome/failure type. The mock failure contains only a pad sample; the mock success contains pad, ascent, and orbit. Both must work.

Recommended base sequence:

1. **Pad / countdown:** rocket on pad, readable 3–2–1 overlay, pad lights, flame ignition.
2. **Ascent:** camera follows the rocket; engine flame, short smoke trail, and controlled speed lines.
3. **Stage:** a tank or stage separates only when the supplied timeline contains a stage phase/event. The detached section drifts safely away and fades; the active stage continues.
4. **Coast:** engine flame shuts off; the rocket glides while Earth curvature becomes visible.
5. **Orbit:** camera pulls back to establish the rocket's relationship to Earth; deploy a satellite/payload only when the timeline or mission data calls for it.

Do not force a stage separation or payload deployment into a mission that does not contain it.

### Transition to a destination planet

Planets are already visible as stable scene anchors; use the camera and a clean transition overlay to signal arrival, not a planet spin.

A planetary sequence should visually support:

1. **Approach:** camera reveals the destination planet; rocket/lander moves into frame.
2. **Transition card:** a short readable label such as `APPROACHING MARS` or `MOON DESCENT`, using the actual mission destination name where provided.
3. **Descent:** lander descends toward the surface; engine glow and dust build gradually.
4. **Touchdown:** landing gear meets the surface; dust dissipates; engines shut down.
5. **Crew deployment:** hatch/ramp opens and astronauts exit in a short, clear walk sequence.
6. **Rover deployment:** rover moves down a ramp or drives away from the lander; wheels rotate with the motion.
7. **Exploration:** rover travels a short readable path; camera mast pans/tilts toward a point of interest.
8. **Image capture:** a camera reticle or focus cue appears, a shutter/light pulse happens, and an image card appears in the UI.
9. **Data uplink:** small glowing data packets travel from rover to lander/relay and onward to the mission-control/HUD indicator. Keep this clearly a game visualization.

**Do not make up a real interplanetary journey if the simulation timeline does not include it.** The currently supplied contract only guarantees `pad`, `ascent`, `stage`, `coast`, and `orbit`-style launch phases. Coordinate with Person 1 and Person 2 to add explicit destination and surface phases before wiring a planetary landing into real mission outcomes.

Suggested optional timeline phase names to discuss with Person 2 (not to invent locally):

```js
[
  "transfer",
  "approach",
  "descent",
  "landing",
  "crew_deploy",
  "rover_deploy",
  "surface_drive",
  "image_capture",
  "data_uplink"
]
```

Suggested optional fields to discuss with Person 1/2:

```js
{
  destinationId: "moon" | "mars" | "saturn",
  destinationName: "Mars",
  payloadModelId: "...",
  surfaceSequence: [/* simulation-owned events, if needed */]
}
```

These are proposals only. Use the team's actual agreed field names and do not change the shared contract unilaterally.

### Animation duration

- Standard launch animation: 8–12 seconds total.
- If the outcome includes an approved planetary surface sequence, compress the complete run into the contract's 8–12 second presentation window rather than arbitrarily extending it.
- The preview lab may play individual clips separately at a slower, inspectable pace. Preview timing is not mission timing.

## 12. Failure animations — distinct, readable, data-driven

Every supported failure type must have a visually distinct sequence. The on-screen label must use the actual outcome fields and the existing failure copy from `SMG.data.failures` where available.

| `failure.type` | Required visual treatment |
|---|---|
| `thrust_low` | Flame flickers; rocket gently shudders and sinks back onto the pad. It never leaves the pad. |
| `fuel_out` | Flame sputters out at `failure.altitudeKm`; rocket briefly coasts, then begins a controlled fall. |
| `power_short` | Rocket/payload lights dim and go dark; show a brief `SIGNAL LOST` cue based on the failure data. |
| `sensor_fault` | Warning light blinks; rocket moves off its ideal camera path and tumbles gently, without graphic impact. |
| `stage_fail` | Stage separation visibly jams or glitches; detached components drift/spin away in a safe, cartoony manner. |
| `over_budget` | No launch animation. UI validation should block launch. |
| `over_mass` | No launch animation. UI validation should block launch. |

Failure overlay requirements:

- Show a short label using the provided failure title/message, type, altitude, time, stage, or numbers only when those exact values exist.
- Example phrasing is illustrative only. Never display invented numbers such as `40 km` unless `outcome.failure.altitudeKm` actually equals that value.
- If a value is absent, omit that part of the label instead of printing `undefined`, `NaN`, or a fabricated substitute.
- Keep the message readable for children and do not blame the player.

## 13. Recovered events

For every `outcome.events` entry with `recovered: true`:

- show a brief, non-alarming warning cue at the corresponding point in the sequence;
- use the event's actual type and timing if present;
- then continue the normal timeline;
- do not convert a recovered event into a failure or score penalty in the visual layer.

Keep the warning flash short and avoid rapid strobing. A pulse, border highlight, and gentle HUD beep animation (if sound is implemented) is enough.

## 14. Rover science and image-return moment

This is a signature moment of the game and deserves special attention.

- The rover must be visibly separate from the lander and astronauts.
- Animate wheel rotation while it drives; keep wheel speed consistent with travel distance.
- Animate the camera mast scanning/panning before capture.
- Use a reticle/focus pulse, then a single shutter flash or camera indicator.
- Show a framed image preview in the UI. `moon.jpeg`/`mars.jpeg` (the supplied surface photos, §6) are the natural source for a clearly labeled *illustrative returned image*. Do not imply the rover has captured a real photo from a real mission.
- Animate data packets from rover to lander/relay satellite (`Gateway Core.glb` or `TDRS` are natural relays) and then to a `MISSION CONTROL` indicator.
- If the game receives an actual image URL or capture object later, show that data rather than a placeholder. Coordinate any new schema with Person 1/2/3.
- If no actual image payload exists, use an approved static preview card and label it as a mission simulation image.

## 15. Preview Lab — previews for every animation are mandatory

Do not make the team infer whether an animation works by reading source code. Build a development-only **Visual Preview Lab** inside the existing `containerEl`, implemented by `scene.js` and styled by `style.css`. Do not edit `index.html` or add a new runtime screen without the UI owner's approval.

> Note: because `ui.js` is still a stub (§3), the Preview Lab is currently the **only** way to see the scene at all. Prioritize it early.

Activate it with a query parameter:

```text
?visualPreview=1
```

The preview panel must be hidden in normal play. When enabled, it must provide clear buttons/tabs to replay each visual clip independently.

### Required preview cases

**Core flight**
- Idle launch pad / rocket build preview
- Countdown and ignition
- Ascent with flame and smoke
- Stage separation
- Coast
- Orbit camera pullback
- Satellite/payload deployment

**Failures**
- `thrust_low`
- `fuel_out`
- `power_short`
- `sensor_fault`
- `stage_fail`
- `over_budget` blocked/no-launch state
- `over_mass` blocked/no-launch state

**Events and planetary exploration**
- Recovered event warning and resume
- Moon approach and transition card
- Mars approach and transition card
- Saturn approach and transition card (only if a mission uses Saturn)
- Landing and dust settling
- Astronaut hatch/ramp exit
- Rover ramp deployment
- Rover surface drive and camera mast scan
- Image capture and image-preview card
- Data uplink to relay / mission-control indicator
- Skip during an active animation, then replay

### Preview behavior

- Preview cases must use isolated development mock data and must never call `SMG.sim.launch()` or alter saved progress.
- The preview label must clearly say `VISUAL PREVIEW — NOT A SIMULATION RESULT`.
- Provide `Replay`, `Stop`, and `Reset` controls. `Stop` must exercise the real `SMG.scene.skip()` path.
- Individual clips should be slow enough to inspect, with camera framing that makes the action obvious.
- Include a simple progress bar or phase label so the reviewer knows which clip is playing.
- Show a clear fallback warning if a GLB asset is missing; still preview the primitive fallback.
- Do not show fake score, mission unlock, fuel, altitude, or success claims in the preview lab.

When reporting completion, give the reviewer a preview URL such as `http://localhost:8000/?visualPreview=1` and a checklist of the clips actually verified. Do not claim a preview was visually tested unless it was opened and inspected in a browser.

## 16. Skip, replay, and lifecycle safety

`playLaunch(outcome, mission, onDone)` must call `onDone()` exactly once per run, whether it completes normally or the user skips.

Implement a run token or equivalent cancellation guard:

```js
var runToken = 0;                 // increments per run
function playLaunch(outcome, mission, onDone) {
  var token = ++runToken;
  var done = false;
  function finish() {
    if (done || token !== runToken) return;  // once per run; stale runs stay dead
    done = true;
    cleanupRun();
    onDone && onDone();
  }
  // every tween/RAF/callback path must check `token === runToken` before touching state
}
```

Requirements:

- Starting a new run cancels the old run safely.
- `skip()` cancels active timelines/tweens, stops temporary effects, places the scene in a stable final/idle state, and calls the active run's `onDone` exactly once.
- Calling `skip()` when nothing is playing is harmless.
- A late callback from a cancelled tween must not finish a newer run (that is what the token check prevents).
- `onDone` must be protected against duplicate invocation.
- Replaying ten launches in a row must not multiply RAF loops, event listeners, DOM overlays, renderer instances, or particle systems.

Never dispose shared geometries, textures, or materials still used by the idle world. Track temporary run resources separately from shared resources.

## 17. Performance and memory discipline

Target a stable 60 fps on an ordinary laptop where hardware allows. A stable 30 fps is preferable to expensive effects that make the whole game stutter.

- Reuse geometries and materials for repeated objects.
- Use particle pools for smoke, dust, warning sparks, and data packets.
- Keep star count, particle counts, shadow maps, and texture sizes within sensible limits (the supplied textures are already tiny — do not compensate with huge procedural maps).
- Avoid creating new objects in every render-loop iteration.
- Avoid many real-time lights and expensive transparent layers.
- Use frustum culling and sensible model scales.
- Cache loaded GLB templates; clone a model instance when reused.
- Dispose temporary geometries, materials, textures, render targets, and animation resources when truly no longer used. Be careful with shared resources.
- Stop old tweens and remove temporary DOM elements between runs.
- Inspect `renderer.info.memory` during repeated preview/replay runs. Counts should stabilize instead of growing on every launch.
- Provide a reduced-effects mode for slower hardware if needed.

## 18. CSS responsibilities

`css/style.css` (currently empty, §3) owns the visual styling for every screen Person 3 builds. Read their real class names and style those selectors; do not invent a second UI framework or rename their classes. The only class that exists today is `.screen .screen--loading` from the `ui.js` stub.

Style at minimum:

- campaign/mission cards, including locked and unlocked states;
- briefing panel and mission facts;
- builder panel, component cards, sliders, and red/yellow/green gauge;
- launch/scene wrapper and transition overlays;
- countdown and failure/recovery labels;
- results screen and score breakdown;
- buttons, disabled buttons, focus states, tooltips, and status indicators;
- rover image-preview card and mission-control/data-return indicator;
- development-only Visual Preview Lab.

### Design and responsive requirements

- Bright, kid-friendly, polished style with consistent spacing, rounded shapes, clear hierarchy, and high contrast.
- Keep the space canvas visually integrated with the rest of the interface; do not let it cover controls or text. (`#scene` sits before `#app` in the DOM — make sure `#app` screens layer above the canvas.)
- At 1280×720, all critical controls and information must fit without awkward clipping.
- At tablet widths, stack or rearrange panels cleanly; do not shrink text until it becomes unreadable.
- Use responsive units and a small set of CSS custom properties for color, radius, spacing, and typography.
- Use a system font stack unless the team already ships a font. Do not add a remote font dependency without approval.
- Make hover effects optional enhancements, not the only way to discover controls.
- Provide visible keyboard focus states and adequate hit areas.
- Respect `prefers-reduced-motion`.
- Avoid rapid flashing; no status should rely on color alone.
- Do not override global styles in a way that breaks Person 3's screens.

## 19. Suggested scene and asset fallback behavior

The game must remain playable even if some 3D assets fail.

| Asset not available | Fallback |
|---|---|
| Earth texture (`images.jpeg`) | Blue sphere, land-shape hint, atmospheric rim glow |
| Moon/Mars surface photos | Procedural sphere color and simple crater detail; photos used as cards/panels instead |
| Saturn band texture | Procedural gold/tan banded shader or gradient sphere |
| Rocket GLB (`Atlas_V_401` / `Saturn V`) | Primitive cylinder/cone/fins/nozzles rocket |
| Apollo Lunar Module GLB | Simple lander made from legs, body, windows, and descent engine |
| Astronaut GLB | Friendly low-poly primitive astronaut silhouette |
| Rover GLB | Original low-poly six-wheel rover with a camera mast |
| Satellite GLB | Simple solar-panel satellite primitive |
| `THREE.GLTFLoader` unavailable | Use primitive fallbacks and record the Person 3 integration blocker |
| Local texture/model blocked under `file://` | Show fallback and document the local-server preview route |

Fallbacks must match the scene's scale and lighting; they should look intentional, not like broken debug cubes.

## 20. Testing checklist

Run these tests before handing the files to Person 3.

### Contract tests

- [ ] `SMG.scene.init(containerEl)` initializes once and tolerates repeated calls.
- [ ] `SMG.scene.showPad(build)` works with valid and incomplete builds.
- [ ] `SMG.scene.playLaunch(MOCK_OUTCOME_OK, mission, onDone)` completes.
- [ ] `SMG.scene.playLaunch(MOCK_OUTCOME_FAIL, mission, onDone)` plays `thrust_low` distinctly.
- [ ] All supported failure types have distinct visuals and data-grounded labels.
- [ ] `over_budget` and `over_mass` do not launch.
- [ ] A recovered event flashes and the normal sequence resumes.
- [ ] `onDone` fires exactly once after natural completion.
- [ ] `onDone` fires exactly once after skip.
- [ ] Starting a new run during an old run does not produce duplicate callbacks.

### Visual tests

- [ ] Rocket scale and nozzle count respond to the build without changing game data.
- [ ] Earth and other planets read clearly and remain static scene anchors.
- [ ] `images.jpeg` and `saturn.jpeg` are mapped as 2:1 sphere maps; `moon.jpeg`/`mars.jpeg` are used as photos/cards, not stretched over spheres.
- [ ] Every GLB in `3dmodels/` is inspected before use; filenames with spaces/parentheses load correctly (encoded paths).
- [ ] Both rover GLB files load or intentional fallbacks appear.
- [ ] Astronaut deployment is visible and understandable.
- [ ] Rover drives, scans, captures an image, and sends a visible data-return signal.
- [ ] Every required Preview Lab case can be started, stopped, replayed, and reset.
- [ ] No preview case changes the real simulation result or saved progress.

### Dependency and loader tests

- [ ] Three.js version in `index.html` is still r128 (or the team has agreed a migration).
- [ ] Exactly one GLTFLoader is loaded, and its version matches the core build.
- [ ] The scene works with **and** without GLTFLoader present (primitive fallback path).
- [ ] GSAP, if present, is a pinned UMD build loaded before `scene.js`.
- [ ] Asset loading verified over `http://localhost:8000/`, not assumed from `file://`.

### Performance and layout tests

- [ ] 10 consecutive launches do not create additional render loops or memory growth.
- [ ] `renderer.info.memory` stabilizes across repeated runs.
- [ ] No duplicate resize handlers or preview panels are created.
- [ ] No uncaught console errors with missing optional assets.
- [ ] Normal play works with Preview Lab hidden.
- [ ] Layout is readable at 1280×720 and tablet width.
- [ ] Reduced-motion mode remains understandable.

## 21. Handoff rules

When finished, provide Person 3 with:

1. The exact files changed: `js/scene.js` and `css/style.css` only, unless another owner approved more.
2. Any requested changes to `index.html` (GLTFLoader/GSAP script tags) as a message, not an unapproved edit. Include the exact pinned URLs from §8.
3. The asset map: filename, role, status (loaded/fallback), and license/source note for new assets.
4. The local preview URL and the list of preview cases actually inspected.
5. The mock test results, especially callback-once and 10-replay checks.
6. Any timeline fields or phases needed from Person 1 or Person 2.

Do not mark the work complete if the preview lab is absent, any failure type is missing, the real launch outcome is being calculated in `scene.js`, or the rover image/data-return sequence is only described in comments rather than visibly implemented.

## 22. Technical references

Use documentation matching the pinned r128 build first; fall back to current docs only for concepts that carry over.

- **Pinned Three.js core (r128, global build):** https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js
- **Pinned GLTFLoader for r128 (verified to exist):** https://unpkg.com/three@0.128.0/examples/js/loaders/GLTFLoader.js
- **Pinned GSAP UMD (verified to exist):** https://unpkg.com/gsap@3.12.5/dist/gsap.min.js
- Three.js r128 API reference: https://threejs.org/docs/#api/en/core/BufferGeometry
- Three.js GLTFLoader (concept reference — check r128 compatibility): https://threejs.org/docs/#api/en/loaders/GLTFLoader
- Three.js resource disposal: https://threejs.org/manual/pages/how-to-dispose-of-objects.html
- GSAP installation and script-tag/UMD guidance: https://gsap.com/docs/v3/Installation/

Always verify examples against the project's actual pinned library version. Do not paste APIs from the latest docs into the r128 build without checking compatibility — `outputColorSpace`, `texture.colorSpace`, `useLegacyLights`, and module-only loaders are all modern-only and will not work here.
