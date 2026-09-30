# Hillaire's own code as the reference — 2026-09-28

_The question: colours and readings kept disagreeing, and with his repo being Windows-only there was no way
to tell whether SebH was wrong or our port was. This builds a way to run his code on macOS and answers the
question with numbers._

## Tool

His HLSL is compiled to WGSL with Slang (`examples/vanilla/scripts/build-sebh-wgsl.mjs`) and driven by a
small WebGPU host that reproduces his `Game.cpp` frame (`examples/vanilla/sebh/`).
It first ran as `21-sebh-compare.html` / `scripts/verify-sebh.mjs` (the numbers below); since 2026-09-30
it is a panel of `20-reference-compare.html`, next to Bruneton's demo, and `scripts/verify-reference.mjs`
writes the three-way report. His side offers three methods: his real-time LUT path, a
per-pixel raymarch, and his **spectral path tracer**, the ground truth his paper validates against.

All ratios are linear, read from float render targets, and per unit sun illuminance. Both sides run
**his** atmosphere: our `EARTH` matches his `SetupEarthAtmosphere` field for field, except that our
ground albedo is 0.3 and his is 0.

## Results on main (e0f11ed)

**The core matches.** The Transmittance LUT is 1.000 texel for texel and Multi-scattering is 0.999. The
harness gates on both.

**The Sky-View LUT does not match.** Ours ÷ his, r / g / b, camera at 0.5 km:

| sun   | all texels            | zenith rows           | toward sun            |
| ----- | --------------------- | --------------------- | --------------------- |
| 90°   | 0.900 / 0.911 / 0.932 | 0.553 / 0.642 / 0.732 | 0.789 / 0.824 / 0.874 |
| 25.8° | 0.915 / 0.922 / 0.943 | 0.764 / 0.782 / 0.813 | 0.705 / 0.779 / 0.864 |
| 2°    | 0.933 / 0.959 / 1.012 | 0.811 / 0.863 / 0.935 | 0.756 / 0.877 / 1.058 |

**Against his path tracer, he is right and we are dark.** Range over probe points and channels:

| sun   | his LUT ÷ path tracer | ours ÷ path tracer             |
| ----- | --------------------- | ------------------------------ |
| 60°   | 0.97–1.11             | 0.81–1.00                      |
| 25.8° | 0.95–1.12             | 0.68–0.99                      |
| 10°   | 0.95–1.11             | 0.71–1.02                      |
| 2°    | 0.97–1.12             | 0.69–1.17 (red low, blue high) |

The visible symptom is a dim, washed-out sky with a weak aureole, bluer near sunset. In his default view
(ground level, facing a 25.8° sun) the sky around the sun comes out at 0.57–0.67 of his brightness.

## Cause: already fixed on `feat/bruneton-compare`, not yet on main

The Bruneton audit (2026-09-26) found that the Sky-View LUT used uniform sample spacing where SebH uses
quadratic spacing. It fixed that together with the haze sky mask, the ray precision and the albedo default.
That branch was never merged. Running this harness against it:

|                               | on main   | with the fix |
| ----------------------------- | --------- | ------------ |
| Sky-View LUT, all texels      | 0.90–0.94 | 0.995–1.012  |
| Sky-View LUT, zenith rows     | 0.55–0.81 | 0.90–0.98    |
| Ours ÷ path tracer, daytime   | 0.68–1.17 | 0.93–1.07    |
| View 1 probe grid (luminance) | 0.57–1.01 | 0.89–1.03    |

With the fix, ours is **closer to the path tracer than his own LUT path is**. The remaining 3–5% gap to his
LUT comes from his 4–14 variable sample count, not an error on our side. Two independent references now
point at the same change, so merging the Sky-View part of `feat/bruneton-compare` is the fix for the
"everything reads dim" reports.

## Where SebH's technique is wrong

At **twilight** (sun −2°) his LUT path is 1.08–1.85× the path tracer, worst in blue and in the direction
away from the sun. Ours inherits that (1.07–1.86× with or without the fix). This is the known limit of the
paper's multi-scattering approximation, which is isotropic and assumes a lit column. It is the same
"twilight 1.3–2×" the Bruneton audit left open, and the path tracer confirms it isn't ours to fix inside
this technique.

His source also produces **NaNs** in the Sky-View LUT's anti-sun column once compiled through Slang and
Metal, from an unclamped `sqrt(1 − lightViewCosAngle²)` where float rounding makes |cos| exceed 1. The
harness clamps it (a documented source patch). Our port already had the `max(0, …)`.

## Still open

- Space view (400 km): ours reads 1.09–1.34× his per-pixel raymarch. Both are raymarches, so the likely
  cause is sample count or distribution in our above-atmosphere fallback. Not investigated.
- Near 90 km the Sky-View LUT's horizon packing degenerates for both sides (known, see CLAUDE.md). Ratios
  there are not meaningful.
- The display side (tone curve, `luminanceScale` 40, ACES 0.5 vs his exposure 10 on
  `1 − exp(−L/white)`) is a separate question from radiance. The page shows both side by side
  (`ours display`).
