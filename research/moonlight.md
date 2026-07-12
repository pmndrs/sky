# Moonlight — design memo (research, 2026-07-12)

_Agent-researched; feeds ROADMAP Track 4.1 (design [F] → impl [S])._

## What exists today (build on this, don't reinvent)

- `SkyMoon` (`src/sky/SkyMoon.ts`): DirectionalLight + flat moon disc on the
  sky mesh (`showMoonDisc`/`moonDirection`/`moonIntensity`/`moonDiscCos`
  uniforms already exist on `SkyAtmosphereMesh`), follow-sun phase model
  (Rodrigues rotation, phase 0.5 = anti-sun), horizon fade. Explicitly does
  **not** feed the LUTs (`SkyMoon.ts:37-40`).
- `SkyNight` stars (`src/sky/SkyNight.ts`): procedural/HDRI starfield in the
  mesh colorNode, attenuated by camera→space transmittance, flows into IBL via
  `markCubeDirty()` (:195-196).
- `examples/vanilla/14-night-sky.html`: wires both with full GUI — the
  verification page for this track.

The `SkyMoon.ts:37-40` "sub-perceptible" claim is only true at _daytime_
exposure. Night scenes crank exposure ~10⁵× — at that operating point the
moonlit sky gradient is exactly what the eye/camera sees. Moonlit skies are
_blue for the same Rayleigh reason day skies are_; that part is free physics.

## Simulate vs stylize — stated explicitly

- Moonlight is **not** blue at the source: full-moon illuminance ≈ 0.25–0.32 lux
  (≈ 1/400,000 of sun's ~120k lux), CCT ≈ 4100 K — _warmer_ than sunlight
  (lunar regolith reddens the reflection). "Blue moonlight" is the **Purkinje
  effect** — human scotopic vision, a property of the observer, not the light.
- **We simulate**: radiometric second source — warm-tinted illuminance at
  ~2.5×10⁻⁶ of the sun, run through the unmodified Hillaire pipeline (the
  atmosphere then makes the _sky_ blue, correctly).
- **We stylize**: nothing by default. Purkinje belongs in tonemapping, not in
  the light transport; if a movie-blue look is wanted, that's a v2 post-scale
  knob, off by default. Say this in the docs so nobody "fixes" the warm moon.

## Feasibility check: moon as a second sun (option b) — grounded in code

The LUTs are built with `globalL = 1` (`ILLUMINANCE_IS_ONE`); the RTE is
linear per-channel in source illuminance, so
`L_total = skyView_sun(dir) × E_sun + skyView_moon(dir) × E_moon` is **exact**,
not an approximation. What a second source actually touches:

| Piece                                             | Change needed                                                                                                                                                                                          | Cost                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| TransmittanceLUT                                  | none — sun-independent (`TransmittanceLUT.ts`)                                                                                                                                                         | 0                                                |
| MultiScatterLUT                                   | none — 2D table over (cosSunZenith, viewHeight), indexed per-source at sample time (`MultiScatterLUT.ts:68`)                                                                                           | 0                                                |
| SkyViewLUT                                        | **second instance**, `sunDirection` = moon dir, sharing TLUT+MS refs (ctor already takes them, `SkyViewLUT.ts:80-99`)                                                                                  | +162 KB; +0.62M texel-steps per moon-dirty frame |
| `SkyAtmosphereMesh._buildColorNode`               | second LUT sample with moon-derived scalars (`viewZenithCos`, `lightViewCos` vs `moonDirection`), × `moonIlluminance` uniform, added before `luminanceScale`                                           | ~free ALU + 1 texture tap                        |
| Baker dirty flags                                 | new `moonDirty` → moon-SkyView + cube + PMREM (mirrors `sunDirty`, `SkyAtmosphereBaker.ts:57-62`); `_syncSkyViewSunFrame` duplicated for the moon frame (:329-334)                                     | trivial                                          |
| Cube bake / PMREM                                 | **no structural change** — the mesh sums both terms, so the existing bake captures moonlight into background + IBL automatically                                                                       | 0                                                |
| AP LUT / haze                                     | **skip in v1** — would double the only genuinely per-frame cost (~1 ms, `SkyAtmosphereBaker.ts:516-518`) for haze that is barely readable at night exposure. Same additive trick works later if wanted | deferred                                         |
| Space-view raymarch fallback (camera > topRadius) | moon term omitted in v1 (sun-only raymarch), documented                                                                                                                                                | deferred                                         |

Total steady-state: one extra 192×108×30 pass on moon/camera-dirty frames.
This is cheap enough that option (a) "fake ambient bump" has no cost argument
left — and (a) can never put the moon's inscatter gradient in the sky or the
IBL. **Recommendation: (b), semi-physical second bake.**

## v1 API

Extend `SkyMoon` (it already owns direction, phase, disc, light — keep one
source of truth) plus a thin baker API:

```ts
// Baker (new):
baker.setMoon({ direction: Vector3, illuminance: Vector3 }): void  // sets moonDirty
baker.setMoonEnabled(flag: boolean): void                          // gates the mesh term

// SkyMoon (extended): new ctor opt + setter
sky.createMoon({ atmosphere: true, illuminance: 2.5e-6 })  // relative to sunIlluminance
moon.setPhase(p)   // now also scales atmospheric illuminance (see below)
```

`sky.setMoon({elevation, azimuth, phase?})` as a facade one-liner is sugar over
`createMoon` + `setDirection` — add it only if the 14-night-sky GUI wants it.

**Phase → intensity**: use Allen's lunar phase law,
`Δm = 0.026·|α| + 4×10⁻⁹·α⁴` (α = phase angle, degrees; brightness
= 10^(−0.4Δm)). Quarter moon (α=90°) → ~9% of full, not 50% — the nonlinearity
is the whole point of using the formula. Map existing `phase` (0..1, 0.5=full)
to α = |phase − 0.5| × 360°. Drives both the atmospheric `illuminance` and the
DirectionalLight via the existing `_targetIntensity` path.

**Disc**: keep the existing flat disc unchanged in v1. Transmittance-tinted
disc (horizon reddening) rides along with the 4.2 sun-disc rework, not here.

## Explicitly NOT attempted

- Earthshine (dark-side glow) — orders of magnitude below even moon inscatter.
- Phase-shaded crescent / physically correct limb on the disc — the disc is
  4 px at default FOV; a crescent mask is v2 cosmetics at most.
- Lunar distance/parallax variation, eclipses.
- Scotopic (Purkinje) vision simulation in the pipeline — tonemapper's job;
  optional stylize knob is v2.
- Moon-driven AP/haze and moon term in the space-view raymarch branch (both
  deferred above with reasons).

## Staged build plan (Sonnet-sized)

| Stage | Deliverable                                                                                                                                                                                             | Acceptance                                                                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Baker: `moonSkyViewLUT` (second `SkyViewLUT`, shared TLUT/MS), `setMoon`, `moonDirty` cascade; mesh: additive moon sample gated by `moonAtmosphereEnabled` uniform                                      | With moon disabled: pixel-identical screenshots on examples 02/04/14 (regression). Enabled, sun at −15°, moon at +40°, exposure ~10⁵: visible blue gradient brightest toward moon; IBL on the demo sphere picks it up with zero extra wiring |
| 2     | `SkyMoon` integration: `atmosphere: true` opt, Allen phase curve driving illuminance + light intensity, warm default tint (~4100 K), `_syncSkyViewSunFrame` twin for moon so planet-mode local-up works | Phase slider in 14-night-sky: full→quarter visibly ~10× dimmer sky; new moon = stars only; flying around a planet (component-03) sets/rises the moon-lit sky correctly                                                                       |
| 3     | Docs + example polish: 14-night-sky GUI gains atmosphere toggle + phase-linked exposure preset; docs page states simulate-vs-stylize policy                                                             | Screenshot set: moonless night / full moon / quarter / moonrise at horizon; CHANGELOG entry                                                                                                                                                  |

## Open questions for maintainer

1. Default state: ship `createMoon({ atmosphere: true })` as the default once
   stable, or opt-in for one release? (Perf cost is negligible; the question
   is purely look-change surprise for existing users.)
2. Warm physical moon tint vs neutral white default — physically it's ~4100 K,
   but neutral reads "cleaner" against expectations. Memo assumes warm.
3. Is the v2 Purkinje/stylize knob (`sky.setNightTint(strength)`?) wanted at
   all, or do we declare tonemapping out of scope permanently?
