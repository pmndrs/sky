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
The LUT values themselves are physical: at `luminanceScale = 1` with
Bruneton's solar spectrum the open sky matches his reference within ±5%
(research/bruneton-audit-2026-09-26.md, finding 5). So 40 is a display
convention, i.e. an exposure knob, not a missing physical constant; deriving it
from ~120 000 lux would only move the scale into `toneMappingExposure`.

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

Above the atmosphere, also shorten the march by the distance
`moveToTopAtmosphere` skipped (his `tMaxMax -= LengthToAtmosphere`,
:685-701), and store no haze when the voxel ends before the ray enters
(he returns opacity 1 there, which would black out geometry in front of the
atmosphere). Until 2026-10-02 each voxel marched its full camera distance
from the entry point, so every slice past the entry held roughly the
whole-path value. That over-hazed `'ap'` above 100 km (mean 8-bit error vs the
raymarch 15–31) but flattened each froxel ray's profile, which hid the D4
slice bands there. With the correct profile the refinement brings the error
to 2–6, but slice bands remain: 0.0076 in alpha at 150 km and 0.011 at
300 km with the refinement's steps packed toward the surface end
(`'quadraticEnd'`; equal steps gave 0.009 / 0.014). They are not just
step spacing: 8 steps give 0.0046 / 0.0069 and 12 give 0.0036 / 0.0054, and
anchoring one slice further back made them worse. Without the refinement (`apRefineSteps: 0`) `'ap'` above 100 km reads worse
than before (3 → 9). `'auto'` raymarches up there and never reads the AP.

The haze raymarch fallback had the same mistake: it started at the
atmosphere top but marched the camera-relative distance, so anything
standing above the ground got the air behind it (a 15 km cone from 150 km:
alpha 0.248 instead of 0.148). It now subtracts the skipped length, as his
`tDepth` is measured from the moved `WorldPos` (:67, :377). Ground pixels never
showed it because the march stops at the ground sphere — and that overshoot
had also been hiding depth-buffer precision: with the plain subtraction,
Bruneton's 2,700 / 12,000 km views (standard depth) lost 11–12 % of their
ground haze. Above the atmosphere a surface within 0.2 % of the ground
sphere's distance is taken to be the ground, which restores them exactly.

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

### Haze sky mask: test the raw depth, never `viewZ`/`linearDepth` against `far` (2026-09-26)

The live `SkyAtmosphereMesh` writes depth with the `z = w` trick, which lands
**one depth ulp below 1.0**, not at 1.0. Every viewZ-based sky test then fails
for any real far plane: `perspectiveDepthToViewZ` turns `1 - 2^-24` into
`-near·far / (near + far·2^-24)`, i.e. only `-0.45·far` at far = 2e7, so
`viewZ < -0.999·far` / `linearDepth > 0.999` both say "geometry", and the haze
pass adds AP inscatter on top of the Sky-View sample for every sky pixel
(measured +40 % sky luminance against Bruneton's reference; the "blown-out
noon" of the live-sky demos). Demos that use the baked cube as
`scene.background` were never affected — the cleared depth stays exactly 1.0.
`createHazeOutputNode` now tests the raw depth (a uniform tolerance, so the
f32 survives codegen), OR-ed with the old tests. Verify with `?debug=is-sky`.

No tolerance works, so the sky mesh does not write depth at all and the test
is exact (`>= 1.0`): it is drawn like a game-engine sky, **after** the opaque
geometry (`SKY_RENDER_ORDER`), depth-tested, `depthWrite = false`, so its
pixels keep the cleared 1.0. History, so nobody re-adds an epsilon: 4 ulps
swallowed geometry past 191 km at near 1 m / far 200 km (unhazed one-pixel
black line along the horizon, flickering with camera motion); 1.25 ulps
(2026-09-29) then let **whole sky-mesh triangles** fall 2+ ulps below 1.0 at
some view orientations, so mid-drag they were hazed — triangles and hard seams
across the live sky, gone the moment the camera stops. The rounding varies per
triangle and per frame, so a static `?debug=is-sky` looks clean; capture it
every few frames _during_ a camera drag. `baker.skyDepthEpsilon` stays (0) for
a custom sky that writes a far-plane depth of its own.

Don't "fix" it by writing depth 1.0 from the fragment (`depthNode`): that was
the 2026-09-30 stopgap, and a shader depth write disables early-Z and Apple's
hidden-surface removal for the whole draw, so a sky hidden behind geometry is
shaded anyway. `scripts/bench-sky-draw.mjs` (`17-sky-draw-bench.html`) at
3200×1800 on an M-series Mac: camera in a closed room at 300 km, where the sky
raymarches, 3.1–5.2 ms/frame with the fragment depth write vs 0.5–0.75 drawn
after opaques; indoors at ground level 0.8 vs 0.5. The pre-2026-09-30 setup
(drawn _first_, writing its plain `z = w` depth, no `depthNode`) measures the
same as _after_ there, because Apple's HSR ignores draw order; on desktop
(immediate-mode) GPUs only the after-opaques order lets early-Z skip the
hidden sky.

### Never inverse-project a far-plane point for a ray direction (2026-09-26)

The haze pass rebuilt each pixel's ray as `invProj · (ndc, 1, 1)`. With the
far/near ratios planet demos use (far 4e7 m, near < 1 m) that point is at
40,000 km and float32 loses the direction; `cosFromAxis` collapses, the AP
slice index explodes and **every geometry pixel renders black** — but only for
some near values (fine at 0.9 m, black at 0.7 m), so it looks like a scene
bug. Use a mid-depth clip point (`z = 0.5`), which is what the AP LUT build
already does; the two reconstructions now agree by construction.

### Sky-View LUT sample spacing is quadratic — measured, not a nicety (2026-09-26)

SebH's `VariableSampleCount = true` spaces steps as `t = (s/N)²·tMax`. The
port had kept his 30-step count with uniform spacing and a JSDoc saying the
difference was imperceptible. Against Bruneton's tables it was 15 % across
the whole sky and 40 % in the sun's aureole; 90 uniform samples change
nothing, so it is the distribution. Both twins now use quadratic spacing for
the Sky-View LUT and the two per-pixel raymarch fallbacks
(`sampleDistribution: 'quadratic'` on the TSL integrator); Transmittance,
Multi-Scatter and AP LUTs stay uniform like the reference (the AP LUT as
full-ray segments, see below). Parity pages still pass. Numbers:
`research/bruneton-audit-2026-09-26.md`.

### Per-slice AP steps: his uniform stepping drops 0.7/N of the ray (2026-10-01)

SebH's AP volume marches `2·(slice+1)` steps (RenderSkyRayMarching.hlsl:707),
and his uniform stepping (`VariableSampleCount = false`, :138-144) ends each
step at its sample, `(s + 0.3)/N·tMax`, so only `(N − 0.7)/N` of the ray is
integrated. At 30 steps that is a 2.3 % bias nobody noticed; with his 2-step
nearest slice it is 35 %. A verbatim port measured 35 / 18 / 12 % low in
slices 0–2 against a 2048-step integral. The AP LUT therefore runs his counts
as equal segments over the whole ray (`sampleDistribution: 'uniformSegments'`):
mean in-scatter error 0.5 % vs 3 % for the old fixed 30. The Transmittance
and Multi-Scatter LUTs keep his stepping, which the reference gate checks
texel for texel.

Two more traps from the same change:

- **three linearises a 3-D workgroup size across the whole dispatch.** With
  `compute(total, [4, 4, 4])` and a flat `instanceIndex`, one SIMD group held
  slices z, z+2, … z+14, so per-slice loop counts diverged inside it (+50 %
  build time). `[64]` keeps a group on one slice (+15 %, ~+0.01 ms).
- **A runtime `Loop` bound costs ~5 % by itself.** The same 64 steps with the
  bound in a uniform instead of a JS constant measured +4–7 % on the haze
  raymarch. That is why SebH's variable step count for the haze fallback
  (#1) was not adopted: rays past 100 km always get the max, so the
  planet-altitude case paid the 5 % for nothing (numbers in
  `research/sebh-parity-audit.md`).

### AP bands at altitude were W interpolation, not XY (2026-10-01, #5)

The D4 concentric bands from 10–100 km: a ray to the ground gathers its haze
in its last few km, inside one depth slice, and lerping between slices misses
the rise by an amount locked to slice phase. The discriminator that settled
it: render `AP alpha − raymarch alpha` and `fract(w·resZ − 0.5)` with
`NoToneMapping`, then bin the difference by W, X and Y froxel phase (W p-p
0.016, X 0.0002, Y 0.0024 at 75 km). Dithering W can't fix this (it averages
the same biased interpolant), and neither do more build steps (they only
shift the bias). The fix refines per pixel (`apRefineSteps`). Two traps on
the way:

- **A residual march from a single slice centre jumps at every slice** by
  the LUT's own error there; blend two anchors (z0 and z0 − 1) by phase.
- **Demo 05's planet is a 128×64 `SphereGeometry`**: its facets sit up to
  ~1.9 km under the analytic sphere, so a slice centre can be inside the
  planet while the rendered surface is still farther. Cap the surface
  distance at the analytic ground hit or the march integrates nothing (thin
  lines one slice apart). The cap also removed the seam the old AP output
  showed at the local ground patch's edge (140 km), where the rendered
  surface steps down onto the coarse sphere.

### Ground albedo feeds an isotropic bounce that glows the horizon

Hillaire's multi-scatter LUT treats second-order light as isotropic, and at
low altitude the sunlit ground below dominates it, so a horizontal ray
accumulates the bounce over hundreds of km. Measured against Bruneton (sun at
zenith): last 2° above the horizon read 2× at albedo 0.1 and 3–5× at 0.3, with
the whole sky 30–40 % too bright at 0.3. `EARTH.groundAlbedo` is now 0.1
(Bruneton's value); SebH's demo uses 0. Any preset with a high albedo will
show a bright horizon band — that is the technique, not a bug.

### Reading debug values through the compare page: know what the tone curve wraps

`20-reference-compare.html` tone-maps whatever the haze node returns, so the
library's `?debug=` modes (`w`, `ap-alpha`, `ap-rgb`, `is-sky`, `beyond`) come
out **through the Bruneton curve**, while the page-local `?dbg=` modes (`depth`,
`depthenc`, `viewz`, `viewzkm`, `issky`) return **before** it. Decoding a
page-local mode as if it were tone-mapped produced a 300× wrong "viewZ" and an
hour of chasing a depth bug that did not exist. `?dbg=depthenc` packs
`1 - depth` into three fractional channels for an exact readback.

### `toneMappingExposure` is ignored under `NoToneMapping` — don't use it to read HDR values

three applies `renderer.toneMappingExposure` only inside a tone-mapping
operator. With `NoToneMapping` the exposure does nothing, so "set
NoToneMapping + a tiny exposure, read the pixel back and divide by the
exposure" returns clipped garbage ×(1/exposure). That exact trick produced a
20× wrong measurement of the noon sky (read ~10.5, really ~0.5–1) and PR #10
recalibrated look `intensity` against it, which pushed every `value > 0` look
to white (fixed 2026-09-26: looks are now display-referred, ramp ÷
toneMappingExposure). To read linear HDR values, scale the source instead
(e.g. `sky.setExposure(40 * k)` with a small k and NoToneMapping), or read a
render target directly. Sanity-check any readback against a tonemapped render
of the same pixel before trusting it.

### Shadowed haze (light shafts): four traps (2026-09-28)

`applyHaze({ shadows: { light } })` marches the view ray through the sun's
shadow map (`src/sky/hazeShadows.ts`). What cost time:

- **`SkySun.fitShadowToBox` fitted in a stale frame.** three's shadow camera is
  not parented to the light; it is only placed (position + `lookAt`) inside
  `LightShadow.updateMatrices`, at shadow-render time. The fit read
  `camera.matrixWorldInverse` before that ever ran, so the first fit (and any
  fit after the sun moved) enclosed the box in the wrong frame and the scene
  had no shadows at all. It now calls `shadow.updateMatrices(light)` first;
  `tests/hazeShadows.test.ts` fails without it.
- **The shadow map does not exist when the haze node is built.** `ShadowNode`
  creates `light.shadow.map` while compiling the first lit material, i.e.
  during the first scene-pass render, after the post node is set up. The march
  samples a private 1×1 `DepthTexture` placeholder (nearest, no compare) and a
  `uniform().onRenderUpdate` swaps every registered texture node's `.value`
  to `light.shadow.map.depthTexture` — it runs after the pass's
  `updateBefore` (which renders the scene) and before bindings update, so the
  first frame already reads the real map. Sample it with `textureLoad`: it is
  legal inside a non-uniform `Loop`, needs no sampler, and so stays
  layout-compatible with the real map's comparison sampler.
- **Subtracting an exact deficit from the AP LUT striped the ground.** Where a
  ray is shadowed end to end the march's deficit is ~the whole single-scatter
  term, while the LUT's value is interpolated between depth slices (off by a
  few %); `max(AP − D, 0)` then flips across slices into horizontal bands (sun
  4°, towers scene). Geometry now gets the _fraction_ `D / L_full` (L_full: the
  same model's single + multi-scatter over the whole path) applied to the AP
  value; only sky pixels take the absolute deficit.
- **A per-pixel earth-shadow test on surface points streaks the ground.**
  Points rebuilt from the depth buffer (or lying on a flat ground plane) sit a
  few metres either side of the ground sphere; the ones below it read "in the
  planet's shadow", so the full-path in-scatter flipped between two values
  along depth steps: horizontal dark-blue streaks at the base of the sphere,
  mostly while the camera moved. `sunLightAt` now lifts the test point to at
  least 10 m above the sphere. The occlusion debug view stays smooth through
  this; split the fraction into deficit and full path to see it.
- **Sky and geometry texels of the march pass hold different quantities**
  (absolute deficit vs fraction). The upsample never mixes them, not even as
  a fallback weight.
- **The cost is the march, not the shader.** Inline in the haze shader or in
  its own full-resolution pass: the same +2.1–2.8 ms at 1080p/32 samples.
  Dropping the per-step medium evaluation (geometric interpolation of the
  smooth part) saved almost nothing; half resolution + a depth-aware
  upsample is what brought it to +0.6–1.1 ms. Verify with
  `examples/vanilla/scripts/verify-haze-shadows.mjs` (baseline, mask, bench).

### Internal draws inherit the caller's MRT — `setMRT` is sticky (issue #36, 2026-10-01)

`renderer.setMRT(mrt({ output, normal }))` stays active until the caller
clears it, and three r185's `CubeCamera.update` and `PMREMGenerator` save the
render target / cube face / mip but **not** the MRT (nor anything at all if a
draw throws). A sky bake run inside a G-buffer frame then compiled the sky
material under the MRT: `structures must have at least one member` on its
fragment `OutputType`, then an invalid pipeline every frame. Any new internal
draw goes through `beginSkyDraw` / `endSkyDraw` (`src/sky/drawState.ts`) with
the restore in a `finally`, or `RendererUtils.resetRendererState` like the LUT
passes. `examples/vanilla/scripts/verify-mrt-isolation.mjs` reproduces it
(fails without the guard; three's generator happened not to error under the
MRT, the cube capture did).

### three r186: a TSL Fn's arguments become variables — pin shared ones before branching (2026-10-06)

r186 assigns each argument of a (non-layout) TSL `Fn` call to a `var` at the
call site. When the same argument node is passed to calls in different
`If`/`select` branches, the var is assigned in the first branch that builds it
and read unassigned (0) in the others — no error, just wrong numbers. It
surfaced as a 2.87 "parity failure" in `parity/00-leaf-helpers` on the r186
bump (cosT shared by the Mie and HG bands); r185 passed. Our shaders rendered
the same on r185 and r186 page for page, but any new code that hands one node
to Fns in several branches must `.toVar()` it **before** the branch — the same
rule as for loops (see "Shader size and synchronous compiles").

### Shader size and synchronous compiles — Windows pays for both (#49, 2026-10-06)

Chrome compiles WebGPU shaders in its GPU process; on Windows that is WGSL →
HLSL → DXC (FXC on old drivers), ~0.1 s under 20 KB, ~1.8 s at 100–200 KB
with DXC, and a cliff past ~60 KB with FXC (HomeFig's measurements). Two
levers, both checked with `examples/vanilla/scripts/probe-shaders.mjs` (wraps
`GPUDevice`: every pipeline's shader size, sync vs async, and whether the WGSL
is byte-identical across reloads, which Chrome's shader cache needs — it is):

- **Every TSL call site is inlined.** A JS `for` around a helper, or the same
  helper called twice, emits it that many times. The haze slice refinement's
  two marches made the planet-scale haze shader 60.6 KB (now 46.5 KB, one
  `Loop` over both); the shafts' full-path integrand over five JS-loop points
  made that pass 50 KB (now 24.5 KB). Route repeats through one TSL `Loop` and
  pin what the loop reads with `.toVar()` _before_ it — a node first built
  inside the loop body is declared in that scope and is out of scope after it.
- **Off-scene draws compile synchronously on first use.** `sky.compileAsync()`
  / `baker.compileAsync()` compile the LUT passes and the cube capture ahead
  (and the AP compute, through r186's `compileComputeAsync`).
  three r185–r186's `renderer.compileAsync` keys the render context from
  `renderer.depth/stencil`, while `render()` uses the target's
  `depthBuffer/stencilBuffer`; for a depth-less target (every LUT) the keys
  differ and the draw recompiles synchronously. Compile through
  `compileIntoTarget` (`src/sky/compileAsync.ts`), and confirm with the probe:
  a warmed pipeline must show up once, as `async`. From r186 `QuadMesh.render()`
  swaps in its own vertex shader, so LUT quads compile _through_ it (a stand-in
  renderer whose `render` calls `compileAsync`). three's PMREM generator and
  the sky cube's mipmap pass are gone on WebGPU: `SkyPmrem` allocates the
  PMREM target itself and fills the cube's listed mips from its own chain.

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

### Night sky: stars are sprites, the Milky Way is baked (2026-09-26)

Resolved stars must never go into the cube bake — at 256² a star is a
blurry multi-pixel blob, and a bigger cube doesn't fix it (~2048/face to match
screen density, ~200 MB). `SkyStars` draws them as energy-normalised PSF
sprites in the main scene (all atmosphere terms per star in the vertex stage);
only the low-frequency Milky Way glow is sampled by `SkyAtmosphereMesh` and
baked. A live per-pixel sky background + procedural stars was measured and
rejected: +1.4–1.7 ms at 4K vs ~0.05 ms for sprites.

Twilight fade is **local** contrast (star/glow vs the sky behind it) ramped in
log2 stops. A linear ramp "shutter-closes" across the Milky Way; a global
zenith-driven fade was tried and rejected by the maintainer (whole band dims
at once). Star orientation comes from `localSiderealTime`, derived from the
same hour angle as `solarPosition` — `tests/stars.test.ts` asserts the sun's
catalog position lands on the baker's sun (<0.5°); don't break that coupling.

### Each swappable texture node needs its own placeholder texture

Two `texture()` nodes in one material sharing the SAME placeholder texture
object: swapping one node's `.value` after the material compiled is never
picked up by the cube bake (the live mesh, compiled later, does see it;
`material.needsUpdate` doesn't help). Cost a debugging detour as "the Milky
Way is missing from the cube". Give every swappable node its own
`_makeBlackPlaceholder()`. Related: resizing a texture via `image` +
`needsUpdate` does NOT reallocate in r185 — it writes into the old-size GPU
texture.

### Measuring GPU cost: burst wall-clock, not timestamp totals

WebGPU timestamp-query frame totals are unreliable on Apple GPUs for frames
with many small passes — a PMREM re-bake frame reported ~85–140 ms while the
page ran at 120 fps. Use the burst method in `examples/vanilla/16-stars-bench.html`
(`__bench.burst()`: pause the loop, submit N frames, `onSubmittedWorkDone`,
divide). And the number that matters for time-of-day animation: a sun-change
re-bake is ~9 ms, ~95% of it PMREM — not the LUTs, not the cube faces.

### His code runs here now — check against it before arguing about brightness (2026-09-28)

`examples/vanilla/20-reference-compare.html` runs both references next to ours
in up to three panels (two draggable seams, any source in any panel, solo, or
a diff of any two): Bruneton's demo.js verbatim, and Hillaire's HLSL compiled
to WGSL by Slang (`scripts/build-sebh-wgsl.mjs`, output committed under
`sebh/generated/`, host `sebh/SebhReference.js` on its own `GPUDevice`),
including **his path tracer** as ground truth (a method on his panel; cheap,
~0.3 ms per sample at 640×360). One camera and sun (Bruneton's frame and
orbit views; a free camera for looking up, swapped into his `model_from_view`
at the GL call — demo.js stays verbatim), one set of units (his spectral
radiance), one curve (his) — or `display: shipped` for each author's own.
`pnpm --filter @pmndrs/sky-example-vanilla ref:verify` writes the three-way
report and gates on Hillaire's Transmittance and Multi-scattering LUTs matching
ours texel for texel (1.000 / 0.999); if those fail, the harness is broken, not
the sky. `scripts/probe-reference.mjs` is the step-driven prober. Findings:
`research/sebh-reference-2026-09-28.md`.

Traps hit while building it:

- **His Sky-View LUT goes NaN on Metal.** `sqrt(1 − lightViewCosAngle²)` in
  `SkyViewLutPS` is unclamped, and the last column rounds to |cos| > 1, so
  bilinear filtering smears NaN across the anti-sun sky. The build patches
  it (listed in `manifest.json`). Our port always had the clamp.
- **His transmittance pass declares the LUT it writes as an input.** D3D
  leaves a null SRV there; WebGPU rejects the usage conflict. Bind a zero
  texture.
- **His "forward" camera offset includes the vertical component**, so a steep
  pitch puts the camera underground: his shaders return one flat colour
  and ours clamp. That looked like a 2× mismatch.
- **`readRenderTargetPixelsAsync` returns rows padded to 256 bytes.**
  `sebh/compare.js#readRenderTarget` handles the stride.
- **Compare his path tracer at 4096 spp.** It converges there (within 1% of
  8192); his comment that its RNG "goes super wrong after a while" didn't
  show up at these counts.

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

- `/Users/dex/Developer/UnrealEngineSkyAtmosphere/Resources/` is Hillaire's
  authoritative HLSL (the old `~/Documents/GitHub/homefig/...` path is gone).
  When porting any new helper, search there first —
  `RenderSkyRayMarching.hlsl`, `RenderSkyCommon.hlsl`,
  `SkyAtmosphereCommon.hlsl` are the load-bearing files.
- Bruneton's precomputed-scattering demo is vendored verbatim under
  `examples/vanilla/public/bruneton/` (his `demo.js` + dumped shaders; the
  16 MB `.dat` tables are gitignored, `scripts/fetch-bruneton.mjs` downloads
  them). `20-reference-compare.html` renders it, Hillaire's own code and ours
  with one camera, one sun and one tone curve; `scripts/verify-reference.mjs`
  writes a per-pixel three-way radiance report. Use it before trusting any
  brightness or colour change. Findings live in
  `research/bruneton-audit-2026-09-26.md` and
  `research/sebh-reference-2026-09-28.md`.
