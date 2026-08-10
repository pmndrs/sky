# SebH reference parity audit — sample counts, techniques, architecture

_2026-08-10. Reference: `/Users/dex/Developer/UnrealEngineSkyAtmosphere`
(Hillaire's EGSR 2020 demo, the basis of Unreal's SkyAtmosphere).
Question from the maintainer: did we drift too simple and sacrifice
quality — or the reverse? And how does our cube-bake + haze-post
architecture compare to SebH's single-pass sky+AP composite?_

## Verdict in one line

**We did not drift too simple — on every integration knob we match or
exceed the reference.** The performance risks are the opposite direction:
fixed-high sample counts where SebH scales them per-ray, and (fixed
2026-08-10, commit `01cfac1`) sky pixels leaking into the raymarch branch
that SebH's depth gate excludes.

## Stage-by-stage comparison

| Stage                                        | SebH reference                                                                                                                                                                                         | Ours                                                                                               | Verdict                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transmittance LUT                            | 256×64, 40 samples (`RenderTransmittanceLutPS`, RenderSkyRayMarching.hlsl:563)                                                                                                                         | 256×64, 40 samples                                                                                 | ✅ parity                                                                                                                                                         |
| MultiScatter LUT                             | 32×32, 8² = 64 directions × 20-sample march, groupshared reduction (`NewMultiScattCS`, :438-470)                                                                                                       | 32×32, 8² × 20                                                                                     | ✅ parity (we loop 64 dirs per thread instead of a 64-thread reduction — irrelevant, rebuilt only on atmosphere change)                                           |
| Sky-View LUT                                 | 192×108, **variable SPP**: `lerp(RayMarchMinMaxSPP.x, .y, saturate(tMax*0.01))`, demo defaults **4–14** (Game.h:341) — the `SampleCountIni = 30` at :626 is overridden by `VariableSampleCount = true` | 192×108, **fixed 30**                                                                              | ⚠️ we use 2–7× more samples than the reference. Quality headroom, small absolute cost (20k texels; and post-`01cfac1` only rebuilt when height/sun-frame changes) |
| AP froxel volume                             | 32×32×32, per-slice SPP = `max(1, 2·(slice+1))` → 2…64, mean ≈ 33 (:707)                                                                                                                               | 32×32×32, fixed 30                                                                                 | ✅ rough parity on mean; his near slices are cheaper, far slices costlier. Optional refinement: scale SPP with `fz`                                               |
| Sky pixels (fast path)                       | `FASTSKY`: depth == 1 → single Sky-View LUT sample, early return (:318-341)                                                                                                                            | Sky mesh samples Sky-View LUT per pixel; haze pass passes sky through (isSky gate since `01cfac1`) | ✅ parity                                                                                                                                                         |
| Geometry haze (fast path)                    | `FASTAERIALPERSPECTIVE`: one AP volume sample, `w = sqrt(slice/32)` (:345-373)                                                                                                                         | Same LUT sample + `.level(0)` (needed on WebGPU, see CLAUDE.md)                                    | ✅ parity                                                                                                                                                         |
| Per-pixel raymarch (ground truth / fallback) | Variable **4–14 SPP** + per-pixel noise                                                                                                                                                                | **64 fixed** + uv-hash jitter (haze fallback); 30 fixed (mesh space-view fallback)                 | ⚠️ we spend 4–16× the reference. Deliberate (kills banding on 1000 km grazing rays at 1024 km coverage vs his 128 km) — now tunable via `raymarchSampleCount`     |
| Transmittance in composite                   | Mean (scalar alpha) in fast path; per-channel behind `COLORED_TRANSMITTANCE` (off by default)                                                                                                          | Mean (scalar alpha)                                                                                | ✅ parity with his shipping config                                                                                                                                |
| Underground froxel correction                | Yes (:668-680)                                                                                                                                                                                         | Yes (ported)                                                                                       | ✅                                                                                                                                                                |
| Illuminance                                  | `globalL = 1` in LUTs, scaled at composite                                                                                                                                                             | Same (`luminanceScale`, default 40, eye-tuned)                                                     | ✅ structural parity; deriving from a physical sun-illuminance constant is still an open polish task                                                              |

### Take-aways

1. **Nothing needs to be made "more physical"** — the integrator, LUT
   parameterizations, and composite math are the reference's, at reference
   or better sample counts.
2. **The cheap wins are all about scaling counts down, not up**:
   - Variable SPP in the haze raymarch fallback (`lerp(min, max,
saturate(distKm/100))`) is SebH's exact trick and would cut the
     worst-case fallback cost ~4× at short range with zero quality loss.
     Candidate follow-up; `raymarchSampleCount` (2026-08-10) is the manual
     version.
   - Sky-View LUT could take variable SPP too (4–14) if its rebuild ever
     shows up in a profile — post-`01cfac1` it usually doesn't rebuild at
     all in static scenes.

## Architecture: cube-bake + haze post vs SebH's single pass

SebH's frame: lit scene → **one fullscreen pass** (`RenderRayMarchingPS`)
that reads the **depth texture only** and hardware-alpha-blends
`L + sceneColor·T` onto the scene buffer. Sky pixels get the Sky-View LUT
sample, geometry pixels the AP volume sample. No scene-color texture read,
no IBL anywhere in his demo.

Ours: sky LUT chain → cube bake → PMREM (all **amortized behind dirty
flags** — free per frame once sun/atmosphere settle) for
`scene.background` + `scene.environment`; sky visible per frame either as
the baked cube (a cube sample — cheaper than SebH's per-pixel LUT
math+sample) or the live mesh (identical cost to his FASTSKY path); haze
as a post pass reading scene **color + depth** textures.

Cost delta per frame, honestly separated:

| Item                    | SebH                                                                             | Ours                                             | Delta                                                       |
| ----------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| Sky pixels              | SkyView LUT sample in post                                                       | cube sample (baked bg) or LUT sample (live mesh) | ≈ 0, slightly in our favor with the baked cube              |
| Geometry haze           | AP sample, hw blend                                                              | AP sample in post                                | ≈ 0                                                         |
| Scene→texture roundtrip | not needed (blend over scene buffer, depth prepass already exists in his engine) | required (post pass samples scene color)         | **one full-res RT write + read — the real structural cost** |
| AP LUT build            | per frame, 32³, SPP 2–64                                                         | per frame, 32³×30                                | ≈ 0 (both ≪ 1 ms)                                           |
| Cube + PMREM            | n/a                                                                              | on sun/atmos/sun-frame change only               | amortized; buys IBL his demo doesn't have                   |

**Can we offer his single-pass form?** Not literally, and it wouldn't pay:
his blend-over-the-scene-buffer trick requires sampling scene depth while
rasterizing into that same pass — his engine has a depth prepass bound as
an SRV; three.js WebGPU has no prepass idiom, and adding one would re-raster
the whole scene (far worse than the RT roundtrip for a 30k-instance city).
The `PostProcessing`/`RenderPipeline` pass IS the idiomatic three.js
equivalent, and its incremental cost over SebH is that one full-res
roundtrip. Once any other post effect (bloom, AO, TRAA/FSR) is in play the
roundtrip is already paid and haze's marginal cost is just its own shader.

**What the cube buys** (and why the split-scene design stays): IBL via
PMREM, a `scene.background` that costs a cube sample, reflection-correct
`GroundedSkybox`, and a sky that doesn't re-integrate per frame when
nothing changed. SebH's demo has none of these because it doesn't need
them; a three.js library does.

## Paris hero-demo findings folded back upstream (2026-08-10)

- `applyHaze` now takes `raymarchFallback: false` — city-scale scenes drop
  the 64-sample branch from the WGSL entirely (the hero's "multi-minute
  megashader compile" complaint was the raymarch branch inlined into a
  bloom+AO+TRAA graph).
- React `<Sky>` drives `updateAerialPerspective()` per frame once
  `applyHaze` has been wired (`sky._hazeApplied`) — previously every React
  consumer had to discover the stale-LUT bug and drive it themselves
  (hero's FX.tsx has the workaround + a HERO-DEMO-SPEC note asking for
  exactly this).
- The hero's "sky-colored exponential height fog" (baked-cube inscatter,
  no per-frame AP cost, no per-channel transmittance) is a compelling
  budget tier between "no haze" and AP haze — candidate library feature,
  not yet ported.
- `examples/vanilla/component-04-city.html` is the simplified vanilla port
  of the hero (Stage 1 scope): deterministic block city, worldScale 5,
  locked orbit, Paris solar position, haze A/B toggle + FPS readout.
