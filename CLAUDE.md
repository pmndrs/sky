# Project notes for Claude Code

This project ports Sebastien Hillaire's atmospheric sky (EGSR 2020) to
Three.js TSL on the WebGPU backend. PLAN.md is the design source of truth;
this file captures repeated traps so future sessions don't relearn them.

## Architecture in one paragraph

A **split-scene bake-first** design. `SkyAtmosphereBaker` owns a private sky
scene containing a single `SkyAtmosphereMesh`, plus three LUTs
(Transmittance → MultiScatter → SkyView), a `CubeRenderTarget`, a
`CubeCamera`, and a `PMREMGenerator`. Caller invokes `baker.update()` per
frame; it cascades dirty flags (atmos→full chain, sun→SkyView+cube+PMREM).
The main scene uses `baker.environmentTexture` (PMREM-filtered) for IBL and
`baker.texture` (raw cube) for `scene.background`.

## Gotchas that have already burned a session each

### TSL `.toVar()` inside a JS-unrolled loop produces a giant shader

If a loop body calls `integrateScatteredLuminance` (or any function with
`.toVar()` declarations and texture samples), unrolling 64 × 20 iterations
produces a shader large enough to lock up WebGPU drivers (browser crash
plus brief OS hang). **Always wrap such loops in TSL `Loop({...}, ...)`**
rather than JS `for`. The accumulator pattern (declare `.toVar()` outside
the Loop, `.assign(reset)` at the start of each iter, `.addAssign` inside)
is the correct way to handle per-iteration state.

### `PMREMGenerator` API differs between WebGL and WebGPU

WebGL has `fromCubeRenderTarget(rt)`. **WebGPU has `fromCubemap(texture)`** —
pass `cubeRenderTarget.texture`, not the RT itself. Each call allocates a
fresh output RT, so dispose the previous one before reassigning.

### LUTs use `ILLUMINANCE_IS_ONE` — consumer must scale

Hillaire's integrator passes `globalL = 1.0`, so the LUTs store sky response
_per unit sun illuminance_ — raw values are 0.001-0.04 and render as black
without scaling. `SkyAtmosphereMesh.luminanceScale` (default 40) multiplies
the SkyView sample at composite time. The standalone LUT debug pages
(`examples/11`, `12`) apply the same 40× factor in their display shaders.
This scale is currently tuned by eye; eventually it should be derived from
a physical sun-illuminance constant.

### Y-up world / Z-up LUT-frame coordinate dance

The Three.js scene is Y-up (sun direction in Y-up world space). The Sky-View
LUT internals use Z-up (matches Hillaire's HLSL convention). The
`SkyAtmosphereMesh` resolves this by computing the **frame-invariant scalars**
`viewZenithCosAngle` and `lightViewCosAngle` directly from Y-up vectors and
feeding them to `skyViewLutParamsToUv` — the LUT doesn't care which frame
generated those scalars. When `setSun` updates the LUT's sun uniform, it
synthesizes a Z-up vector with `z = sin(elevation)` so the LUT's internal
`dot(up=(0,0,1), sunDir)` lands on the correct value. **If the horizon ever
appears tilted on the mirror sphere, this is the first place to look.**

### Dev workflow with chrome-devtools-mcp

`chrome-devtools-mcp` is wired up at user scope. The standard loop is:

1. `pnpm --filter @pmndrs/sky-example-vanilla dev` (background) — Vite on port 5173
2. `mcp__chrome-devtools__navigate_page` to the example URL
   (e.g. `http://localhost:5173/03-aerial-perspective.html`)
3. `mcp__chrome-devtools__evaluate_script` with `() => document.querySelector('button')?.click()` to trigger the start gate
4. `mcp__chrome-devtools__wait_for` on a known text marker (`"MS :"`,
   `"FPS"`, etc.) to know when render finished
5. `take_screenshot` for visual verification, `list_console_messages` for
   logs, `evaluate_script` to mutate GUI sliders
6. The HF16 readback values in the info banner / console are **raw uint16
   bitpatterns**, not floats — decode by hand if you need the actual value
   (`exp = bits[14:10] - 15; mantissa_frac = bits[9:0]/1024; value = (1 + mantissa_frac) * 2^exp`)

### Force `.level(0)` when sampling a 3D LUT through a depth-aware post-process

When the AP LUT (or any 3D texture whose UVW depends on scene depth) is
sampled in a post-process, you'll see **a 1-pixel dark outline tracing
every silhouette** in the output. Cause: WebGPU's default `textureSample`
uses screen-space derivatives (`ddx`/`ddy`) for mip-level selection. At
a silhouette, the W coordinate jumps from surface-depth to far-plane-w
across one pixel → derivatives explode → GPU picks an extreme "mip"
level and returns a garbage averaged value. This shows up identically
in the AP RGB even before any compositing happens.

**Fix:** force level-0 sampling explicitly:

```js
const ap = texture3D(apTex, vec3(u, w)).level(0)
```

Bisecting this took multiple wrong turns (MSAA, ray-distance metric,
coverage limits) before adding `?debug=ap-rgb` showed the dark outline
appearing in the raw LUT sample, before compositing — at which point
the derivatives explanation was the only fit. **For any post-process
sampling a texture with depth-dependent UVs, default to `.level(0)`.**

### AP haze sampling — distance-along-ray, not |viewZ|

The AP LUT is BUILT integrating each voxel's ray for `tMax` km **along
the ray direction**. The post-process must therefore sample using
**distance-along-ray**, NOT `|viewZ|` (the view-space Z component).
Using `|viewZ|` underestimates ray length at off-axis pixels by
`1/cos(angle from view axis)` — up to ~14% at the corners of a 60° FOV.

**Symptom:** dark fringe along distant geometry silhouettes that gets
WORSE when the camera pitches up/down. At one specific orientation
(rays nearly aligned with view axis at the silhouette) the fringe
disappears, then comes back at other rotations. This is the easiest
test: if rotation changes the fringe, you have a distance-metric bug.

**Fix:** reconstruct per-pixel ray direction from the inverse projection
matrix and divide:

```js
const ndc2 = vec2(uv.x * 2 - 1, uv.y * 2 - 1)
const clipFar = vec4(ndc2, 1, 1)
const rayDirView = (invProj * clipFar).xyz / w
const cosFromAxis = abs(rayDirView.normalize().z)
const distAlongRayM = abs(viewZ) / cosFromAxis
```

### Screen-space LUT builds must match the consumer's UV convention (AP Y-flip)

The haze post-process reconstructs rays with `ndc.y = 1 - 2*uv.y` (WebGPU
v-down screen UV) and samples the AP LUT at that same uv. The LUT build
originally filled rows bottom-up (row 0 = ndc.y −1) — a perfect mirror of
the froxel field about screen centre. **Symptom:** in AP mode, haze on the
lower screen _clears_ below a line that moves opposite to camera pitch,
increasingly wrong with altitude; invisible at ground level (view is
horizon-symmetric); raymarch mode looks correct. The raymarch/AP A/B is
the discriminator: both modes share the distance reconstruction, so
"raymarch right, AP wrong" isolates LUT content/addressing. Fixed by
building rows top-down (`ndcY = 1 - 2*(y+0.5)/resY`,
`AerialPerspectiveLUT.ts`). For any new screen-space LUT, assert build and
sample agree on the V direction before debugging anything else.

### AP underground-froxel correction (the real fix for the horizon cliff)

SebH's `RenderCameraVolumePS` (RenderSkyRayMarching.hlsl ~668-680) does
something the obvious port skips: when a froxel's endpoint falls below
the planet surface, push it back up onto the ground shell, recompute
`worldDir`, and recompute `tMax`. **Without this**, voxels that point
behind the horizon integrate through _invalid medium_ (rock), producing
a hard alpha cliff at the horizon and a visible black band in
`?debug=ap-alpha`.

**Fix in `AerialPerspectiveLUT.js`:**

```js
const newWorldPos = camPosKm.add(worldDir * tMax)
const belowGround = length(newWorldPos) <= bottomR + PLANET_RADIUS_OFFSET
const groundedPos = normalize(newWorldPos) * (bottomR + PLANET_RADIUS_OFFSET + 0.001)
worldDir.assign(select(belowGround, normalize(groundedPos - camPosKm), worldDir))
tMax.assign(select(belowGround, length(groundedPos - camPosKm), tMax))
```

Then pass the corrected `worldDir` and `tMax` into both
`moveToTopAtmosphere` and `integrateScatteredLuminance`. With this
applied, the AP / Sky-View boundary matches well enough that the
sky-fallback blend below becomes unnecessary in canonical mode.

### AP coverage limit vs sky integration — sky-fallback blend (legacy / opt-in)

Historical context: before the underground-froxel correction was ported,
the AP LUT under-covered grazing rays (coverage cap at 256 km vs the
Sky-View LUT's full-atmosphere integration on grazing rays), producing a
sharp horizon line where AP-affected geometry met the cube background.

A workaround was added in `HazePostProcess.js`: when `skyCube` is
supplied, the post-process samples the cube background at the fragment's
world ray direction and blends the composite toward it weighted by
`apA`:

```js
composited = mix(composited, skyAtDirection, apA)
```

This closes any residual AP/Sky-View mismatch by leaning on the cube as
"the sky behind this surface."

**Status:** opt-in only. The canonical SebH-aligned path drops `skyCube`
from the `createHazeOutputNode` arg bag. The shim is retained for
skybox-only callers who can't afford a per-frame AP rebuild and need
flat-ground horizon to colour-match the cube without the underground-
froxel fix.

If you wire the shim, use `baker.texture` (raw cube), not
`environmentTexture` (PMREM-filtered) — the latter over-blurs.

### Dark silhouette fringe at AP / sky boundaries — surface lighting, not MSAA

A dark fringe appears along distant geometry silhouettes when the AP
haze post-process is on, and disappears with the post-process off. This
looked like an MSAA / depth-mismatch problem at first (we initially
disabled `antialias: true` on this hypothesis) but **it's actually a
fundamental mismatch between two different integrations**:

- AP LUT integrates atmospheric scattering over the **camera-to-surface
  finite path** (e.g. 30 km).
- The Sky-View LUT (and thus the cube background) integrates over the
  **camera-to-infinity full atmosphere**.

At a silhouette pixel the surface side computes
`surfaceColor × T_30km + L_inscatter_30km`, while the adjacent sky pixel
computes the full sky integral. With unlit dark surfaces (low albedo,
IBL-only), `surfaceColor × T_30km` is far below the sky brightness, so
the surface side reads as a darker fringe — physically correct but
visually wrong unless something brings the surface color up to
sky-comparable luminance.

**Fix: directly illuminate the surfaces** — typically a
`DirectionalLight` matching the sun direction, with intensity tuned for
the renderer's exposure × the sky `luminanceScale`. With direct sun
illumination the lit-face brightness sits in the same range as the sky
behind it and the fringe vanishes naturally. This matches real-world
photography of distant peaks.

(Original MSAA hypothesis kept here for posterity: MSAA + a
post-process that reads single-sample depth _can_ produce edge
artifacts, but it wasn't this case. If you re-enable MSAA, you may
still want FXAA after the haze composite to avoid that distinct issue.)

### SkyView LUT degrades near top of atmosphere — raymarch fallback above topRadius

The Sky-View LUT's horizon-packed V parameterization assumes the camera is
_inside_ the atmosphere and the planet horizon dominates the view. As the
camera approaches `topRadius` (atmosphere boundary at ~100 km altitude),
the horizon angle collapses — most V texels get crammed into a thin
equatorial band. Visible symptom: concentric rings / banding on the sky
mesh between roughly 80 km altitude and `topRadius`. This is inherent to
the LUT's UV layout, not a bug.

**Phase 3 fix in `SkyAtmosphereMesh._buildColorNode()`:** when
`viewHeight > topRadius`, take the raymarch branch instead of the LUT
sample. We `moveToTopAtmosphere` to clip the ray origin to the
atmosphere boundary then call `integrateScatteredLuminance` per pixel
(30 samples, full multi-scatter feedback). This requires the mesh to
hold references to the Transmittance + MultiScatter LUTs — `baker`
forwards them when constructing the mesh.

The transition is a hard switch at `viewHeight == topRadius`. There's a
visible step between ~99 km (LUT artifacts) and ~101 km (clean raymarch).
SebH's reference handles this the same way (`RenderSkyAtmosphereInternalCs`
checks `WorldHeight < AtmosphereParams.TopRadius`); a smooth blend across
a transition band is a polish task, not a correctness one.

### Two shader backends — the LUTs are built by WGSL, not the TSL twin

`src/backends/tsl/atmosphere.tsl.ts` and `src/core/wgsl/*.wgsl.ts` are hand-
synced twins, but they do not run in the same places. **Transmittance,
MultiScatter and SkyView LUTs are built by the WGSL path** (`backends/wgsl/
luts.ts` → `core/wgsl/luts.wgsl.ts`). The TSL `integrateScatteredLuminance`
runs only in the AP LUT and in the two raymarch fallbacks (sky mesh above
`topRadius`, haze past AP coverage). So a parameter threaded into the TSL
side alone compiles, typechecks, passes unit tests — and has **zero visible
effect at ground level**, because nothing on screen reads it.

This bit `multiScatteringFactor` (2026-09-04): added to the TSL integrator,
verified "no change" in the browser, root cause was the missing WGSL half.
WGSL params are **positional fn args**, so adding one means (a) the fn
signature in `luts.wgsl.ts`, (b) the multiply site, (c) the named key in the
`backends/wgsl/luts.ts` wrapper call. The headless verify script
(`examples/vanilla/scripts/verify-looks.mjs`) is what caught it — a diff of
~0.0003 where >0 was expected. For any new atmosphere param: edit both twins,
then check `examples/vanilla/parity/` still agrees.

### Vite HMR + WebGPU shader edits

Editing a TSL helper while a page is open often leaves the previous shader
binary cached. After non-trivial shader edits, **hard-reload**
(`navigate_page` with `ignoreCache: true`) before drawing conclusions about
shader behavior. The MS LUT "black" mystery during phase 1b debugging was
partly stale build cache.

### `applyHaze` now really composites over its first argument (2026-08-09)

`applyHaze(sceneColorNode, opts)` used to `void sceneColorNode` and let
`createHazeOutputNode` read `scenePass.getTextureNode('output')` directly —
so a consumer composing bloom/AO before haze had that work silently
discarded (found by the Paris hero demo, where haze-on made bloom vanish
with no error). `createHazeOutputNode` now takes an optional
`sceneColorNode` used as the composite base; `applyHaze` passes its first
argument through. A caller-supplied node is used **directly** (screen-space
TSL expressions and texture nodes both evaluate at the fragment's UV); only
the internal fallback texture node gets an explicit `.sample(u)`. Don't
"simplify" this back to sampling the scenePass — that re-introduces the bug.
Docs: `docs/guides/haze.mdx` § "Composing with other effects".

Same session also confirmed two React-bindings fixes that predate it
(esbuild `jsx: 'automatic'` in build.config.ts; `@react-three/fiber/webgpu`
import in src/react/Sky.tsx) — both were required for the `./react` entry to
work at all in a consumer.

### The benign `<!DOCTYPE` JSON parse error

Every page logs `Uncaught (in promise) SyntaxError: Unexpected token '<'`
once on load. It's a Vite or browser-extension probe hitting an asset path
that returns the index HTML. **Ignore unless it appears alone without other
errors.**

## File map

Three-layer split (see WGSL_CORE_PLAN.md). `core/` is renderer-agnostic,
`backends/` holds the two shader authorings, `sky/` is the three integration.

```
src/
├── core/                       renderer-agnostic (no TSL/renderer logic; still
│   │                           references three's Vector3 type — see plan doc)
│   ├── AtmosphereParams.js     EARTH defaults + mergeAtmosphereParams
│   ├── resolutions.js          LUT_RESOLUTIONS (override-able defaults)
│   └── wgsl/atmosphere.wgsl.js WGSL math source chunks (source of truth on WebGPU)
├── backends/
│   ├── tsl/atmosphere.tsl.js   TSL math — WebGL fallback + hand-sync reference
│   └── wgsl/atmosphere.js      wgslFn wrappers over core/wgsl (WebGPU-via-three)
├── sky/
│   ├── SkyAtmosphereBaker.js   public API (setSun, setAtmosphereParams, update)
│   ├── SkyAtmosphereMesh.js    visible sky, samples SkyView LUT
│   ├── AtmosphereUniforms.js   create/updateAtmosphereUniforms (TSL uniform bundle)
│   ├── luts/
│   │   ├── TransmittanceLUT.js 256×64, on atmos change
│   │   ├── MultiScatterLUT.js  32×32, on atmos change
│   │   └── SkyViewLUT.js       192×108, on sun OR atmos change
│   └── legacy/SkyMesh.js       Preetham (unused by baker v1, kept for reference)

examples/
├── 01-legacy-baked.html    full demo scene (mirror + ground + PBR sphere)
├── 02-hillaire-baked.html  same scene, separate page (currently identical)
├── 10-transmittance-lut.html  fullscreen TLUT view + readback
├── 11-multiscatter-lut.html   TLUT|MS split + ?debug=<mode> bisection
├── 12-skyview-lut.html        fullscreen SkyView LUT view (40× scaled)
└── parity/                    WGSL-core vs TSL-twin numeric parity harness
    ├── 00-leaf-helpers.html   phases, ray-sphere
    └── 01-uv-maps.html        SkyView UV maps, spherical dir
```

Dev server: the demos are now a workspace app under `examples/vanilla/` — run
`pnpm --filter @pmndrs/sky-example-vanilla dev` (Vite on 5173). Root `pnpm dev`
is `unbuild --stub` (library dev), NOT the examples. Demos import the library
via the `@pmndrs/sky` (public) and `@sky/*` (deep internals) Vite aliases →
`src/`. The React demo lives in `examples/react/` (see its README — currently
blocked on r3f-canary/three-webgpu build interop).

## Reference repos

- `/Users/dex/Documents/GitHub/homefig/UnrealEngineSkyAtmosphere/Resources/`
  is Hillaire's authoritative HLSL. When porting any new helper, search
  there first — `RenderSkyRayMarching.hlsl`, `RenderSkyCommon.hlsl`,
  `SkyAtmosphereCommon.hlsl` are the load-bearing files.
