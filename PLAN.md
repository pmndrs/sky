# Unified Hillaire Sky → Three.js TSL/WebGPU — Port Plan

## Context

We want a production-quality atmospheric sky in Three.js using TSL on the WebGPU renderer, modeled after Sébastien Hillaire's "A Scalable and Production Ready Sky and Atmosphere Rendering Technique" (EGSR 2020, shipped in Unreal Engine). The existing Three.js [`SkyMesh.js`](../../../../../Documents/GitHub/homefig/SebH-TSL-Sky/resources/SkyMesh.js) uses Preetham — analytic, cheap, but visually limited (poor twilight, no multi-scatter, no ground-shadow band, no aerial perspective, no planetary views).

**Architecture (user-specified):** a _split-scene bake-first_ design. A dedicated sky scene owns the atmosphere; a `CubeCamera` writes it into a `CubeRenderTarget`; the main scene uses that cube texture as `scene.environment` + `scene.background`. This deliberately trades view-dependent effects (aerial perspective, sun-motion parallax) for PBR reflections and near-zero runtime cost. Re-bakes happen only when sun or atmosphere params change.

**Phase 1 goal:** Ground-based sky rendered correctly and baked into a cube target, delivered in two sub-steps:

- **Phase 1a (scaffold):** Prove the split-scene + CubeCamera + environment-map plumbing by baking the existing Preetham `SkyMesh` into the cube target. Zero LUT risk.
- **Phase 1b (Hillaire):** Swap the sky's fragment shader to sample a Sky-View LUT built from Transmittance + Multiple-Scattering LUTs, using a fragment render-to-texture pipeline.

Aerial perspective, per-frame LUT updates, high-altitude / space views, volumetric shadows, and clouds are explicitly out of scope; tracked as future phases.

---

## Where does the "raymarch" live?

Three distinct raymarch contexts in Hillaire's pipeline. Conflating them is the usual source of confusion.

| Context                                           | What marches                                                                                   | Output                                | Cadence                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------- |
| **LUT generation**                                | rays through atmosphere math, inside a fullscreen fragment pass writing into a RenderTarget    | the LUT textures                      | on sun / param change (for our baked use case) |
| **Sky shading**                                   | nothing — sample Sky-View LUT by direction                                                     | sky-pixel color                       | per sky pixel                                  |
| **Aerial perspective LUT generation** _(phase 2)_ | camera-frustum froxel rays through atmosphere math                                             | AP 3D LUT RGB + alpha                 | per frame while camera moves                   |
| **Aerial perspective on geometry** _(phase 2)_    | usually nothing — sample AP 3D LUT by depth-reconstructed world position                       | haze blended onto scene pixels        | per scene pixel, post-process                  |
| **Planet-scale AP fallback** _(phase 3 bridge)_   | camera-to-surface ray for pixels outside AP coverage, or when a debug/quality policy forces it | finite-path inscatter + transmittance | per scene pixel, post-process                  |

In the ground-level steady state, the only raymarches happen inside LUT generation passes; geometry haze normally samples the AP 3D LUT. Planet-scale views add an explicit per-pixel raymarch fallback for geometry past the AP volume coverage (and for debug / high-quality overrides). The "mountain haze fade" you asked about is still the aerial-perspective depth post-process over the main scene — not bakeable into an envmap, which is why it started as phase 2.

---

## User decisions (baseline)

| Decision                 | Chosen                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Code location            | New `src/` in this repo (`SebH-TSL-Sky/src/`)                                                                                                                                                                                  |
| Build system             | npm + Vite                                                                                                                                                                                                                     |
| LUT generation           | Fragment render-to-texture (portable, simple)                                                                                                                                                                                  |
| Scaffold pass            | Yes — Preetham-in-cube first                                                                                                                                                                                                   |
| Clouds                   | Skipped entirely                                                                                                                                                                                                               |
| Sun control              | `setSun({ elevation, azimuth })`                                                                                                                                                                                               |
| Demo scene               | Mirror sphere + matte ground + one PBR (metal/rough) sphere                                                                                                                                                                    |
| IBL pipeline             | Bake → PMREM-filter in phase 1. Baker exposes both `baker.texture` (raw cube) and `baker.environmentTexture` (PMREM-filtered); demo uses the filtered one                                                                      |
| Update model             | Explicit `baker.update()` in the caller's animation loop; no hidden auto-hooks                                                                                                                                                 |
| LUT sizing               | Tunable constants — `src/sky/luts/resolutions.js` exports `LUT_RESOLUTIONS = { transmittance, multiScatter, skyView }`, defaulting to the paper values; overridable via `new SkyAtmosphereBaker(renderer, { lutResolutions })` |
| AtmosphereParams presets | Earth only for phase 1. Presets for Mars / fictional atmospheres are trivial to add later and deferred                                                                                                                         |

---

## Repo layout

```
SebH-TSL-Sky/
├── package.json                      # three, vite
├── vite.config.js
├── index.html                        # entry redirect / landing
├── examples/
│   ├── 01-legacy-baked.html          # Phase 1a: Preetham baked into cube
│   └── 02-hillaire-baked.html        # Phase 1b: LUT sky baked into cube
├── src/
│   ├── sky/
│   │   ├── AtmosphereParams.js       # Earth defaults + overrides
│   │   ├── SkyAtmosphereBaker.js     # Public API, owns cube target + CubeCamera
│   │   ├── SkyAtmosphereMesh.js      # Box+BackSide mesh, samples Sky-View LUT
│   │   ├── shaders/
│   │   │   └── atmosphere.tsl.js     # Shared TSL Fns: density, phase, rayIntegrator
│   │   └── luts/
│   │       ├── TransmittanceLUT.js   # 256×64 RenderTarget + fragment pass
│   │       ├── MultiScatterLUT.js    # 32×32
│   │       └── SkyViewLUT.js         # 192×108
│   └── demo/
│       ├── createDemoScene.js        # mirror sphere + ground + PBR sphere
│       └── sunGui.js                 # elevation/azimuth + atmosphere params
└── resources/                        # (existing — SkyMesh.js, pdf, md notes)
```

---

## Phase 1a — Scaffold (Preetham baked into cube)

Goal: prove that `scene.environment = cubeTarget.texture` works end-to-end before we touch LUT math.

### What we build

1. **`SkyAtmosphereBaker` v0** — owns:
   - A private `skyScene: THREE.Scene` holding one sky mesh
   - A `CubeRenderTarget` (default `256²` per face, RGBA16F, linear filter)
   - A `CubeCamera` positioned at origin of the sky scene
   - Dirty flags: `sunDirty`, `atmosDirty`, `cubeDirty` (any → `cubeDirty`)
   - A `PMREMGenerator` and an internal PMREM-filtered output texture
   - Public API:
     - `constructor(renderer, { cubeSize = 256, atmosphere?, lutResolutions? })`
     - `setSun({ elevation, azimuth })` — degrees, matching the legacy example
     - `setAtmosphereParams(partial)` — merges onto current `AtmosphereParams`
     - `update()` — if any dirty flag set, regenerates dirty LUTs, re-bakes the cube, then runs `PMREMGenerator.fromCubeRenderTarget` to refresh the filtered IBL; clears flags. **Caller must invoke this; no auto-hooking of render.**
     - `.texture` — raw cube texture, for `scene.background` or custom sampling
     - `.environmentTexture` — PMREM-filtered, intended for `scene.environment`
     - `dispose()` — disposes cube target, LUT targets, PMREM generator, filtered texture
   - Internally, for 1a the "sky mesh" is literally the existing `SkyMesh` (copied into `src/sky/legacy/SkyMesh.js` or imported from `three/addons`). Its `showSunDisc` is toggled off during bake to avoid an over-bright sun reflecting in metals.

2. **`createDemoScene(renderer, baker)`** — returns `{ scene, camera }`:
   - Matte ground plane (`MeshStandardMaterial`, roughness 0.9)
   - Mirror sphere (`metalness: 1, roughness: 0`) — samples PMREM level 0
   - PBR sphere (`metalness: 1, roughness: 0.35`) — exercises IBL mip chain
   - `scene.environment = baker.environmentTexture` (PMREM-filtered)
   - `scene.background = baker.texture` (raw cube — sharper sun disc on the background than the filtered mips would give)
   - No directional light from the sun in phase 1 (IBL only). Add one later for shadow casting.

3. **`examples/01-legacy-baked.html`** — WebGPURenderer, ACES, GUI wired to `baker.setSun` + atmosphere scalars. Animation loop calls `baker.update()` then renders the main scene.

### Phase 1a verification

- Mirror sphere reflects a coherent sky cube (no seams → CubeCamera correctly captures all six faces).
- Changing elevation in the GUI retints the reflections (proves re-bake is running).
- Azimuth change rotates the sun reflection around the mirror sphere.
- `renderer.info` confirms only one extra draw-set per bake (not every frame).

---

## Phase 1b — Hillaire LUT pipeline (replace the sky shader)

Goal: replace the Preetham sky inside the skyScene with a Hillaire LUT-sampled sky. Baker API and demo scene do not change.

### Shared atmosphere helpers — `src/sky/shaders/atmosphere.tsl.js`

Pure TSL `Fn` helpers, no side effects:

- `densityAtHeight(h, params) → vec3` — Rayleigh/Mie/ozone densities
- `rayleighPhase(cosTheta) → float`
- `miePhaseHG(cosTheta, g) → float` (Henyey-Greenstein; Hillaire uses Cornette-Shanks, consider both)
- `raySphereIntersect(ro, rd, R) → vec2` — planet / atmosphere boundary hits
- `sampleAtmosphere(ro, rd, params, sunDir, options) → { L, transmittance }` — the inner ray integrator used by every LUT pass

All LUT sizes below come from `LUT_RESOLUTIONS` in `src/sky/luts/resolutions.js`. Stated numbers are the defaults (Hillaire's paper values) and can be overridden per-construction.

### 1. Transmittance LUT — `256 × 64` (default), RGBA16F, on-change

- Parameterization (Bruneton): `x ← view zenith cos remapping`, `y ← altitude remapping` (both nonlinear).
- Fragment pass: fullscreen triangle, `NodeMaterial` with `colorNode` that un-maps UV → (height, mu), integrates along the ray to the atmosphere boundary, returns `exp(-opticalDepth)`.
- ~40 steps.
- Rebuilt only on `atmosDirty`.

### 2. Multiple-Scattering LUT — `32 × 32` (default), RGBA16F, on-change

- Parameterization: `(sun zenith cos, altitude)`.
- Hillaire's closed-form: sample ~64 directions on the sphere, for each march ~20 steps accumulating second-order luminance `L_2nd` and transfer factor `f_ms`, output `L_2nd / (1 − f_ms)`.
- Reads Transmittance LUT.
- Rebuilt only on `atmosDirty`.

### 3. Sky-View LUT — `192 × 108` (default), RGBA16F, on sun or atmos change

- Parameterization: azimuth ∈ [0, 2π] on X, view zenith with horizon-packed non-linear mapping on Y (Hillaire packs more texels near the horizon where the visual detail is).
- Ray-marches ~30 steps reading Transmittance + Multi-Scatter LUTs.
- Rebuilt on `sunDirty || atmosDirty`.
- (In baked mode this runs once per bake and we could have _also_ baked it to the cube directly; keeping it as an intermediate lets phase 2 move the camera without re-baking the Sky-View.)

### 4. `SkyAtmosphereMesh` — the visible sky

- Same shape as legacy: `Mesh(BoxGeometry(1,1,1), NodeMaterial)`, `BackSide`, `depthWrite = false`, vertex shader with `z = w` trick so the box always sits at far plane.
- `colorNode`: view direction = `normalize(positionWorld - cameraPosition)`, converted to (azimuth, view zenith) relative to `upUniform`, then Sky-View LUT sample. Sun disc added on top as a smoothstep against `dot(viewDir, sunDir)` against the cos-angular-diameter.
- Sun-disc toggle kept for bake vs. direct-render scenarios.

### 5. `SkyAtmosphereBaker` v1 changes

- Owns the three LUT render targets; regenerates on the matching dirty flag inside `update()`, _then_ renders cube target.
- No public-API break vs v0.
- `AtmosphereParams` drives LUT content; default = Earth constants from Hillaire / Bruneton (planet radius 6360 km, top 6460 km, Rayleigh/Mie coefficients from the paper).

### Phase 1b verification

- Daytime zenith reads a richer, deeper blue than Preetham; horizon is desaturated with warmer band.
- Sunset produces the orange horizon band and darker zenith _without_ the Preetham tinting tricks.
- Twilight (elevation = -2°) shows faint residual glow, not black — this is the multi-scatter contribution and is the clearest visual "did we get it right" signal vs Preetham.
- Changing atmosphere params (e.g. Mars-ish ozone off + red-biased scattering) yields a coherent Martian-looking cube, something Preetham cannot produce.
- Mirror sphere / PBR sphere show the IBL picking up the new sky.
- Perf budget: on sun change, LUT regen + cube bake under ~5 ms on a mid-tier GPU. Idle frames should show zero sky work.

---

## Deferred (not built in phase 1)

| Phase | Feature                                                              | Why deferred                                                                     |
| ----- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 2     | Aerial Perspective LUT (32³) + main-scene depth-sampled post-process | View-dependent, cannot be baked; requires depth-buffer integration in main scene |
| 2     | Per-frame Sky-View LUT updates                                       | Needed once the main camera moves through altitudes or sun animates continuously |
| 3     | High-altitude / space view fallback (per-pixel raymarch)             | Sky-View LUT stops being useful past some altitude                               |
| 4     | Volumetric shadows / god rays (blue-noise jitter + TAA reprojection) | Separate concern, needs scene geometry participation                             |
| Opt   | Procedural / volumetric clouds                                       | User chose to skip; would be a real volumetric system, not ported FBM            |

---

## Open questions / risks

1. **TSL fragment → RenderTarget ergonomics on WebGPURenderer:** writing 16-bit float into a `RenderTarget` and sampling it linearly works in the WebGPU backend, but we should confirm `CubeRenderTarget` supports the same format as our LUT targets so PMREM generation on the cube works. Fallback: RGBA8 with exposure-scaled encoding for the cube itself.
2. **Non-linear UV remaps:** getting the exact Bruneton/Hillaire parameterization right the first time is the most likely source of subtle horizon artifacts. Plan to cross-reference the Unreal repo at `/Users/dex/Documents/GitHub/homefig/UnrealEngineSkyAtmosphere` (noted in `resources/links.md`) for the exact mapping functions.
3. **Sun-disc double-count risk:** if the sun disc is drawn during the cube bake, PMREM will bleed an extremely bright highlight across the lower-roughness mips and the mirror sphere will show a suspicious bloom. Default: sun-disc _off_ during the cube bake (so IBL uses the sky luminance only). Because `scene.background` uses the raw non-PMREM cube, if we want the sun visible in the background we need to either bake with sun-disc on and accept the IBL bloom, or render the sky as a direct mesh in the main scene instead of using `scene.background`. **Decision for phase 1:** bake without sun disc → PMREM env is clean → main scene uses `scene.background = baker.texture` without disc, and the demo skips rendering a sharp sun disc. Sun disc comes back in phase 2 alongside main-scene sky-mesh rendering.

---

## Full verification plan

1. `npm run dev`, open `examples/01-legacy-baked.html` (Phase 1a) in a WebGPU-capable browser.
2. Mirror sphere reflects a coherent sky; moving elevation in GUI retints reflection.
3. Swap to `examples/02-hillaire-baked.html` (Phase 1b). Same demo geometry.
4. Golden-path visual checks: daytime zenith, sunset band, twilight residual glow, Mars-params preset.
5. `renderer.info.render.calls` confirms bake fires only on dirty frames.
6. Cross-check Sky-View LUT output against a reference (Shadertoy linked in `resources/links.md`: https://www.shadertoy.com/view/slSXRW).

---

## What the implementation agent(s) will get

Once this plan is approved, work will be chunked into agent-sized tasks in this order:

1. Vite + package.json + legacy example wiring — smoke-test three.js/WebGPU import path.
2. `SkyAtmosphereBaker` v0 + `createDemoScene` + `01-legacy-baked.html` — completes Phase 1a.
3. `atmosphere.tsl.js` helpers + `TransmittanceLUT` with a dev harness page that just displays the LUT — lowest-risk LUT first.
4. `MultiScatterLUT` on top of Transmittance.
5. `SkyViewLUT` on top of both.
6. New `SkyAtmosphereMesh` sampling Sky-View LUT; wire into baker; `02-hillaire-baked.html` — completes Phase 1b.

---

## Phase 1 — Status (shipped)

Both 1a and 1b are functional end-to-end. Verified via Chrome DevTools MCP:
sunset (elev=1°) renders proper warm horizon + cool zenith, daytime (elev=60°)
renders uniform azure overhead, mirror sphere reflects the cube, PBR sphere
picks up IBL correctly, sun motion triggers re-bake within ~50 ms.

Files of record:

- `src/sky/SkyAtmosphereBaker.js` — owns LUT pipeline + cube + PMREM, dirty-flag scheduling
- `src/sky/SkyAtmosphereMesh.js` — visible sky, samples Sky-View LUT, exposes `luminanceScale` (default 40) for the `ILLUMINANCE_IS_ONE` consumer-side scaling
- `src/sky/luts/{Transmittance,MultiScatter,SkyView}LUT.js` — fragment-pass LUT builders
- `src/sky/shaders/atmosphere.tsl.js` — shared TSL helpers (density, phases, ray-sphere, UV remaps)
- `src/sky/AtmosphereParams.js` + `src/sky/AtmosphereUniforms.js` — Earth defaults + live-update uniform bundle
- `examples/{01-legacy-baked,02-hillaire-baked,10-transmittance-lut,11-multiscatter-lut,12-skyview-lut}.html`

### Carried forward as caveats / phase 2 cleanup

- **luminanceScale = 40** is tuned by feel against ACES@0.5 exposure. Should
  eventually be derived from a physically-grounded sun-luminance constant
  (Unreal uses `Atmosphere.GlobalLuminanceScale` × sun-illuminance terms).
- **Example 01** baker v1 dropped the Preetham path, so 01 also renders
  Hillaire and the legacy Preetham sliders are no-ops. If the side-by-side
  comparison is wanted back, add a thin `SkyAtmosphereBakerLegacy` wrapper
  that keeps the original Preetham SkyMesh in its own cube target.
- **Sun-disc angular diameter** is hardcoded `cos(0.004675)` in the mesh.
  Promote to an atmosphere-uniform field for artistic control.
- **`viewHeight` is hardcoded** to `bottomRadius + ε` in both SkyView LUT and
  SkyAtmosphereMesh. Phase 2 must take camera position as input so
  altitude effects (mountain peak, aerial views) are correct.
- **Shader-build-time JS unrolling** is a real trap with TSL. Rule of thumb:
  any loop of ≥ ~30 iterations whose body samples textures or calls a
  multi-line Fn must use TSL `Loop`, not a JS `for`. The MS LUT crash that
  blocked us for a session was 64 × 20 unrolled integrator bodies.
- **`<!DOCTYPE` JSON parse error** in console on every page is benign
  Vite/HMR/extension noise — ignore unless it appears alone.

### Phase 2 entry point

The next milestone is **aerial perspective on in-world geometry**: a 3D
camera-frustum LUT (32×32×32 RGBA16F, X/Y = NDC, Z = depth slice) holding
inscatter (RGB) + transmittance (A). Built every frame because it's
view-dependent. Consumed by a main-scene post-process pass that
reconstructs world-position from depth, samples the volume, and blends
`final = sceneColor * T + inscatter`.

Required sub-tasks (rough):

1. `AerialPerspectiveLUT.js` — TSL compute pass writing to a 3D
   StorageTexture. Each voxel ray-marches from camera through atmosphere
   for `t ∈ [0, frustumZSlice]`, integrating with the same
   `integrateScatteredLuminance` we already have but now with multi-scatter
   feedback (the MS LUT) enabled.
2. Per-frame Sky-View LUT update (the current bake-only model breaks once
   the camera can move altitude).
3. Main-scene post-process node — TSL pass that reads
   `scene.depth` + `scene.color`, samples AP LUT, blends.
4. Demo upgrade to `examples/03-aerial-perspective.html` with a terrain
   mesh in the foreground so the haze is actually visible on something.

---

## Phase 2 / 3 bridge — Status (in progress)

AP and planet-scale support now exist beyond the original phase-2 entry point:

- `src/sky/luts/AerialPerspectiveLUT.js` builds a camera-frustum 3D LUT each
  frame when AP is enabled.
- `src/sky/HazePostProcess.js` applies AP to scene geometry and includes a
  per-pixel raymarch fallback for planet-scale pixels beyond AP coverage.
- `src/sky/hazeScenePassDepth.js` decodes pass depth correctly for both normal
  and logarithmic depth buffers. When `WebGPURenderer({ logarithmicDepthBuffer:
true })` is used, haze consumers must decode with `logarithmicDepthToViewZ`;
  `PassNode.getViewZNode()` assumes perspective depth and corrupts distance
  reconstruction.
- `examples/05-planet-scale.html` is the stable planet-scale integration page.
- `examples/06-planet-scale-debug.html` is the isolated debug harness for
  AP/raymarch diagnostics and should remain free to expose low-level controls.

### Planet-scale cleanup milestone

This milestone aligns the demo and baker math with a true spherical planet:

1. **Camera altitude** — derive altitude from distance to the planet centre,
   not `camera.position.y`. `SkyAtmosphereBaker.setCamera()` and
   `AerialPerspectiveLUT.setCamera()` must receive enough planet-frame context
   to compute camera position in kilometres.
2. **Camera controls** — use `camera-controls` in planet-scale pages for better
   interaction, smoother transitions, and collision / constraint hooks. Keep an
   explicit minimum-altitude clamp so the camera cannot go below the ground.
3. **Spherical demo geometry** — attach mountains to the sphere surface and
   orient them along the local normal instead of placing them on the old flat
   plane.
4. **AP / raymarch policy** — retire `raymarchOnly` as a user-facing concept.
   Stable pages should expose a configurable haze policy:
   - `auto`: default hybrid mode, smoothly blending AP LUT output toward
     per-pixel raymarch at high altitude / poor AP coverage.
   - `ap`: ground-biased fast path; AP in range, raymarch only past coverage.
   - `raymarch`: force per-pixel raymarch for validation and high-quality use.
   - `hybrid-custom`: expose blend thresholds for users who need control.

Debug pages may keep `raymarchOnly` and raw integrator controls as explicit
diagnostic overrides.
