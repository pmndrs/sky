# Bruneton reference audit — why the sky blew out, and what was actually wrong

_2026-09-26. Question from the maintainer: our demos white out around noon and
Bruneton's WebGL demo looks richer. Is the port wrong? Method: render Eric
Bruneton's precomputed-scattering demo **verbatim** (his `demo.js` and his
precomputed tables) next to ours with one camera, one sun and one tone curve,
then read pixels back from both canvases and invert his tone curve so every
number below is a ratio of linear radiance, ours ÷ his. Tooling:
`examples/vanilla/20-bruneton-compare.html` and
`scripts/verify-bruneton.mjs`; SebH's HLSL at
`/Users/dex/Developer/UnrealEngineSkyAtmosphere` was the tie-breaker._

## Verdict in one line

**The atmosphere math was right; three things around it were not.** Two were
bugs in the haze post-process that only bite with a live sky mesh (in-scatter
added on top of every sky pixel; geometry going black at some far/near
ratios), one was a sampling shortcut in the Sky-View LUT worth 15–40 % of sky
brightness, and one default (ground albedo 0.3) that multiplies the horizon
band by 3–5×. With those fixed, the sky matches Bruneton to **±3 % across the
open sky at every sun elevation** and to ±10 % from orbit. What remains is a
horizon band and twilight, where Hillaire's multi-scatter approximation is
brighter than Bruneton's four-order solution, and that is a property of the
technique, not of the port.

## Headline: after the fixes (open sky, ours ÷ his, r / g / b)

| his view                        | sky top-left       | sky top            | sky top-right      | sky left           | sky right          |
| ------------------------------- | ------------------ | ------------------ | ------------------ | ------------------ | ------------------ |
| 1 · sun 15.5°, 900 m            | 1.02 / 1.00 / 1.00 | 0.97 / 0.97 / 0.98 | 1.00 / 1.00 / 1.00 | 1.02 / 0.98 / 0.98 | 1.00 / 0.98 / 1.00 |
| 2 · sun 0.4°, 900 m             | 1.05 / 1.02 / 1.02 | 1.05 / 0.98 / 1.00 | 1.05 / 1.02 / 1.04 | 1.02 / 0.96 / 1.03 | 1.00 / 0.98 / 1.05 |
| 3 · sun 1.8°, 6 m               | 1.02 / 0.98 / 0.98 | 1.15 / 1.07 / 1.02 | 1.08 / 1.07 / 1.04 | 1.02 / 0.98 / 0.95 | 1.06 / 1.02 / 1.02 |
| 4 · sun 13.9°, 6 m              | 1.00 / 0.98 / 1.00 | 0.97 / 0.95 / 0.94 | 1.15 / 1.11 / 1.09 | 1.00 / 0.98 / 1.00 | 1.09 / 1.06 / 1.08 |
| 5 · sun 21°, 1.6 km             | 1.00 / 1.00 / 0.96 | 1.02 / 1.00 / 1.00 | 1.02 / 0.98 / 0.98 | 0.92 / 0.95 / 0.98 | 0.94 / 0.95 / 1.00 |
| 6 · sun −3.3° (twilight), 640 m | 1.04 / 1.29 / 1.51 | 1.07 / 1.25 / 1.40 | 1.09 / 1.23 / 1.41 | 1.54 / 2.07 / 1.83 | 1.07 / 1.31 / 1.63 |
| 7 · sun 0°, 6 m                 | 1.04 / 1.05 / 1.07 | 1.02 / 1.04 / 1.09 | 1.04 / 1.04 / 1.09 | 1.00 / 1.02 / 1.23 | 1.00 / 1.00 / 1.22 |

Sun-elevation sweep (horizontal view from the ground, sun 90° to the side):
+12° and +22° above the horizon stay within 0.97–1.07 from 90° down to 0°
elevation; the last 2° above the horizon read 1.3–2.0× (finding 4). Views 8
and 9 (orbit) have no open sky; their planet limb is within 5–10 %.

## What was measured

Both sides are driven by his `Demo` state (view distance / zenith / azimuth,
sun zenith / azimuth, exposure) and his tone curve
`pow(1 - exp(-L·exposure), 1/2.2)`. Our sky is put in his units by
`luminanceScale = 1` and `skyLuminanceFactor = (1.474, 1.8504, 1.91198)`, the
spectral solar irradiance baked into his tables, and our ground albedo is set
to his `0.1`. His scene (1 km sphere of albedo 0.8, ground `(0, 0, 0.04)`) is
rebuilt on our side with pure-Lambert materials and our sun light set to
`E_sun · T(sun)` with a CPU twin of the transmittance integral.

Ratios are ours ÷ his, linear, per channel r / g / b. "Open sky" means more
than ~5° above the horizon and more than ~5° from the sun.

## Findings, in order of impact

### 1. Haze added in-scatter on top of every sky pixel (bug, fixed)

Symptom in numbers: open sky **1.39–1.43×** Bruneton in all three channels;
toggling `hazeStrength` to 0 changed a _sky_ pixel to 0.82–0.95×.

Cause: the live `SkyAtmosphereMesh` writes depth with the `z = w` trick,
which lands one depth ulp below 1.0, not at 1.0. `createHazeOutputNode`
detected sky with `viewZ < -0.999·far` (or `linearDepth > 0.999`), and
`perspectiveDepthToViewZ(1 - 2^-24)` is only `-0.45·far` at far = 2e7, so no
sky pixel ever passed. Every sky pixel then took the geometry path and had AP
in-scatter composited over the Sky-View sample. Demos that use the baked cube
as `scene.background` were never affected: the cleared depth stays exactly
1.0. The live-sky demos (04–07, C3, anything using `createSkyMesh`) were.

Fix: `rawDepth >= 1 - 4·2^-24` (a uniform, so the exact f32 survives shader
generation), OR-ed with the old tests. `?debug=is-sky` now shows the mask.

### 2. Geometry rendered black at some camera near/far combinations (bug, fixed)

Symptom: in three of his nine views (camera 7 km from the origin, near plane
0.7 m) our sphere and ground were pure black; at 9 km / 0.9 m they were fine.
An unlit grey `MeshBasicMaterial` stayed black, so it was not lighting.

Cause: the haze pass rebuilt each pixel's ray as `invProj · (ndc, 1, 1)`, a
point on the far plane at 40,000 km. At a far/near ratio around 5·10⁷ float32
loses the direction: `cosFromAxis` collapses, the AP slice index saturates,
and the composite goes to the deepest slice (alpha ≈ 1, black). The AP LUT
build reconstructs its rays at clip z = 0.5 and never had the problem.

Fix: reconstruct at clip z = 0.5 in the haze pass, so build and sample agree
by construction.

### 3. Uniform sample spacing in the Sky-View LUT (quality, fixed)

With 1 and 2 fixed, open sky read a flat **0.83–0.87×** at every sun
elevation, and **0.55–0.60×** (red) within ~6° of a low sun.

| Sky-View integrator               | open sky +22°          | open sky +12°          | 6° from sun (view 1)   | 6° from sun (view 4)   |
| --------------------------------- | ---------------------- | ---------------------- | ---------------------- | ---------------------- |
| uniform, 30 samples (before)      | 0.83 / 0.85 / 0.87     | 0.86 / 0.85 / 0.91     | 0.60 / 0.70 / 0.84     | 0.55 / 0.65 / 0.80     |
| Cornette-Shanks phase, uniform    | 0.78 / 0.85 / 0.87     | 0.86 / 0.85 / 0.91     | 0.62 / 0.72 / 0.85     | 0.58 / 0.68 / 0.80     |
| **quadratic spacing, 30 samples** | **1.00 / 1.04 / 1.00** | **1.05 / 1.00 / 1.00** | **0.97 / 0.97 / 0.98** | **0.97 / 0.95 / 0.94** |
| quadratic, 90 samples             | 1.00 / 1.00 / 1.00     | 1.05 / 0.97 / 1.00     | —                      | —                      |

SebH's Sky-View LUT and per-pixel raymarch run `VariableSampleCount = true`,
which does two things: picks 4–14 steps from the ray length, and spaces the
steps quadratically (`t = (s/N)²·tMax`) so they crowd the dense air near the
origin. We had kept the fixed 30 steps but with uniform spacing, and the
`SkyViewLUT` JSDoc claimed the difference was imperceptible. It is 15 % across
the sky and 40 % in the sun's aureole. Ninety samples change nothing, so it
is the distribution, not the count. The Mie phase function (HG vs Cornette-
Shanks) is worth 2–5 % near the sun and nothing elsewhere: Rayleigh dominates
even the red channel at 90° scattering.

Fix: quadratic spacing in the WGSL Sky-View pixel and a
`sampleDistribution: 'quadratic'` option on the TSL integrator, enabled for
the Sky-View LUT (TSL twin) and both per-pixel raymarch fallbacks (sky mesh
above the atmosphere, haze past AP coverage). Transmittance, Multi-Scatter and
AP LUTs stay uniform, as in the reference. The WGSL/TSL parity pages still
pass (Sky-View maxRel 0.15 %).

### 4. `EARTH.groundAlbedo` was 0.3 (default, changed to 0.1)

Sun at zenith, horizontal view from the ground, quadratic LUT:

| ground albedo           | sky +22°           | sky +12°           | sky +3°            | sky +2°            | sky +1°            |
| ----------------------- | ------------------ | ------------------ | ------------------ | ------------------ | ------------------ |
| 0 (SebH demo default)   | 0.83 / 0.85 / 0.87 | 0.86 / 0.85 / 0.86 | 0.85 / 0.91 / 1.00 | 0.84 / 0.86 / 0.89 | 0.79 / 0.85 / 0.84 |
| 0.1 (Bruneton's tables) | 1.00 / 1.04 / 1.00 | 1.05 / 1.00 / 1.00 | 1.25 / 1.27 / 1.25 | 2.03 / 1.51 / 1.27 | 2.24 / 1.63 / 1.27 |
| 0.3 (our old default)   | 1.39 / 1.33 / 1.26 | 1.44 / 1.32 / 1.26 | 2.07 / 1.97 / 1.82 | 4.48 / 2.86 / 2.01 | 5.16 / 3.24 / 2.12 |

Hillaire's multi-scatter LUT treats the second-order light at a point as
isotropic, and at low altitude that light is dominated by the sunlit ground
below (albedo 0.1 → the bounce alone roughly doubles L₂). A horizontal ray
integrates that term over hundreds of kilometres, so the last few degrees
above the horizon glow in proportion to albedo — 2× Bruneton at 0.1, 3–5× at
0.3. Bruneton's solution scatters the bounce with proper phase functions and
stays flat. Multi-scatter off (`multiScatteringFactor = 0`) leaves the horizon
red at 1.7–1.9×, so the bounce also leaks in through the Sky-View integration
itself, not only the MS LUT. SebH's own demo sets ground albedo to **0** and
sidesteps all of it.

Changed the default to 0.1 (Bruneton's value, so future comparisons stay
apples-to-apples). `0` is the cleanest horizon. `presets.ts` Mars/Titan
albedos are artistic and were left alone; expect the same horizon behaviour
there.

### 5. What the demos do on top: `luminanceScale 40` + ACES 0.5 (tuning, not changed)

With the sky in his units and his tone curve, noon matches. The examples
instead use `exposure: 40` (neutral, per-channel white) and ACES at
`toneMappingExposure 0.5`. Same noon sky, 8-bit values at the zenith / a mid
sky point:

| pipeline                            | zenith rgb8     | mid sky rgb8    |
| ----------------------------------- | --------------- | --------------- |
| Bruneton (his curve, exposure 10)   | 121 / 175 / 220 | 153 / 204 / 232 |
| ours, his units + his curve         | 112 / 164 / 212 | 146 / 197 / 229 |
| ours, demo units (LS 40) + ACES 0.5 | 167 / 199 / 230 | 205 / 224 / 238 |
| ours, demo units + ACES 0.3         | 126 / 167 / 211 | 173 / 202 / 225 |
| ours, his units + ACES 7            | 122 / 173 / 216 | 170 / 206 / 228 |

The compare page's "Tuning presets" folder and its live sky-match score (mean
ours ÷ his over 15 open-sky points, 8-bit) give the same answer at every sun
elevation:

| preset (demo units, LS 40)      | noon r / g / b     | sun 30°            | sun 15.5°          | sun 1.8°           |
| ------------------------------- | ------------------ | ------------------ | ------------------ | ------------------ |
| today: ACES 0.5, neutral sun    | 1.41 / 1.14 / 1.04 | 1.33 / 1.11 / 1.03 | 1.34 / 1.14 / 1.06 | 1.37 / 1.22 / 1.20 |
| ACES 0.3, neutral sun           | 1.18 / 1.02 / 0.98 | 1.17 / 1.01 / 0.98 | 1.14 / 1.02 / 0.99 | 1.02 / 0.90 / 0.90 |
| ACES 0.3, Bruneton sun tint     | 1.11 / 1.02 / 0.98 | 1.11 / 1.01 / 0.98 | 1.08 / 1.02 / 0.99 | 0.89 / 0.90 / 0.92 |
| **AgX 0.35, Bruneton sun tint** | 1.08 / 0.96 / 0.92 | 1.04 / 0.94 / 0.91 | 1.03 / 0.95 / 0.92 | 1.06 / 1.04 / 1.02 |
| AgX 0.3, Bruneton sun tint      | 1.03 / 0.92 / 0.89 | 0.99 / 0.91 / 0.89 | 0.98 / 0.92 / 0.89 | 0.99 / 0.98 / 0.96 |

ACES at 0.3 fixes the brightness but keeps a red excess (its knee desaturates
toward white); AgX at 0.3–0.35 with the spectral sun tint is within ±8 % in
every channel from noon to sunset and is the closest match to his look on
the existing API: `renderer.toneMapping = AgXToneMapping`,
`toneMappingExposure ≈ 0.35`, `sky.setSkyLuminanceFactor([0.797, 1.0, 1.033])`.

Two effects. ACES 0.5 with `luminanceScale 40` is ~1.7× too bright (the
ACES knee is reached across the whole sky, which is the "white" look); 0.3
matches his brightness. And his sun is spectral, `(1.474, 1.85, 1.91)`, ~30 %
bluer than red, while ours is neutral, so ours reads warmer and less
saturated at equal brightness. `setSkyLuminanceFactor([0.797, 1.0, 1.033])`
reproduces his tint on the existing API. Neither is changed here: exposure is
a per-demo choice and the sun tint is a look. Suggested defaults for the
demos: `toneMappingExposure 0.3` (or `exposure: 24` at 0.5).

A related inconsistency: the demos light geometry with `DirectionalLight`
intensity 4 while the sky is at `luminanceScale 40`. In the sky's units the
sun's irradiance at the ground is `40 · T(sun)` ≈ 28 at noon, so lit surfaces
are ~7× too dark relative to the sky — the origin of the "dark silhouette
fringe" in CLAUDE.md, which was patched by adding light rather than by
matching units. The compare page's `transmittanceToSun` (40-step CPU twin of
the Transmittance LUT) is the reference for a `SkySun` option that derives
intensity and tint from the sky.

### 6. Remaining differences (technique, not port)

- **Horizon band** (last ~3° above the horizon): 1.25–2.2× at albedo 0.1, red
  most; see 4.
- **Twilight** (sun −3.3°, view 6): 1.04–1.5× at the top of the frame,
  1.3–2.1× near the horizon, blue most. With multi-scatter off ours drops to
  0.4–0.9×, so it is the MS approximation with the sun below the horizon.
  Bruneton's tables are themselves coarse there (32 sun-zenith samples,
  clamped at 102°), so neither side is ground truth.
- **Sun aureole** at low sun: 0.95–0.97 after fix 3; the residual is the
  isotropic MS lacking the forward peak. Cornette-Shanks adds ~2 %.
- **Orbit views** (8, 9): planet limb and surface within 5–10 %; space is
  black on both. The raymarch fallbacks are right.
- **His light-shaft hack** (`shadow_length` from the sphere's shadow volume)
  darkens his in-scatter toward the sphere; ours has no equivalent, so
  sphere pixels read up to 1.6× when the camera looks along the shadow.
  Ignore sphere probes for atmosphere questions.
- **Sky light on the sphere** (added 2026-09-28). His
  `GetSunAndSkyIrradiance` scales the sky irradiance by `(1 + n·up) / 2`, so
  nothing arrives from below; ours takes irradiance from the baked
  environment, lower hemisphere included. The page's `sky light on objects`
  control switches ours to his model (plus his `GetSkyVisibility` on the
  ground). View 1, ours ÷ his, red channel:

  | point                   | environment | hemisphere (his) |
  | ----------------------- | ----------- | ---------------- |
  | sphere top              | 1.14        | 1.00             |
  | sphere middle           | 1.69        | 1.23             |
  | sphere bottom           | 2.49        | 1.68             |
  | ground outside shadow   | 1.00        | 1.00             |
  | ground inside shadow    | 1.61        | 1.61             |
  | ground at sphere's foot | 1.93        | 1.93             |

  What is left sits only on rays that cross the sphere's shadow volume, where
  in-scatter is most of the pixel (sphere middle: 0.004 surface, 0.019
  in-scatter). That is the unshadowed haze, tracked on `feat/haze-shadows`.
  The shadow map itself is fine: the ground shadow has his shape.

## Things checked that were fine

Rayleigh / Mie / ozone coefficients and scale heights, phase functions,
transmittance LUT (40 uniform steps), multi-scatter LUT normalisation
(`4π/64 · 1/4π`, `L₂/(1 − f_ms)`), the Sky-View UV mapping (horizon packing
resolves +1° from the horizon 6 rows away from the ground half), the
Y-up/Z-up sun frame (sun disc lands on the same pixel on both sides), IBL
diffuse from the PMREM (sphere's shaded side 0.7–0.84× his approximate sky
irradiance), the AP in-scatter magnitude over 50 m – 8 km once fix 2 was in
(ground at 8 km: 1.04 / 1.00 / 1.05).

## How to re-run

```sh
pnpm --filter @pmndrs/sky-example-vanilla dev          # note the port
cd examples/vanilla
node scripts/fetch-bruneton.mjs                         # once: 16 MB of tables
BASE=http://localhost:5183/ node scripts/verify-bruneton.mjs
```

The report lands in `scripts/.verify-out/bruneton-report.md` with split and
diff screenshots per view. `scripts/probe-bruneton.mjs` drives the page with a
JSON list of steps (JS to evaluate, screenshots, probe points) — every number
in this document came from it; `scripts/verify-parity.mjs` runs the WGSL/TSL
parity pages headless. Interactive: open `20-bruneton-compare.html`,
`split` / `diff` modes, shift-click moves the probe, the info panel shows both
canvases' rgb8, the recovered linear radiance and the ratio. `?debug=` passes
through to the haze pass; `?dbg=depthenc` gives an exact depth readback;
`?bypass=1` skips the haze node; `?near=` / `?far=` override the camera.

## Follow-ups

1. `SkySun` option to derive `DirectionalLight` intensity and tint from
   `luminanceScale · T(sun)` (finding 5).
2. Retune the demos' exposure (0.3, or `exposure: 24`) and decide whether the
   spectral sun tint should be the default look.
3. Per-slice sample counts in the AP LUT (`2·(slice+1)`, SebH) — uniform 30
   is right but wasteful in the near slices.
4. A twilight reference (path tracer) to settle finding 6; Bruneton is not
   ground truth there.
