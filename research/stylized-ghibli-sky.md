# Stylized "Ghibli" sky — design memo (research, 2026-07-12)

_Agent-researched; feeds ROADMAP Track 4.5 (and interacts with 4.4 gradient mode)._

## Survey (condensed)

Production stylized skies are almost never a single hand-painted gradient OR a
pure simulation — they're a physical/procedural base pushed through a curated
color remap:

- **Genshin Impact** (GDC 2021): layered skybox + fog + bloom, with per-time-of-day
  "soft color grading" doing the stylistic work on top of a simulated stack.
- **Zelda BotW**: real-time Rayleigh/Mie kept physical; stylization comes from
  art-directed parameter restraint, not post-remap.
- **Ghibli palette analysis**: desaturated cerulean→periwinkle zeniths, warm
  never-fully-saturated horizon tints at dawn/dusk, soft airbrushed horizon bands.
- **Gooch shading** (SIGGRAPH '98): the generic luminance→cool/warm-hue remap.
- **Unreal SkyAtmosphere** (same Hillaire model we port) ships artistic multiplier
  knobs on the physical integrator; Hillaire's paper frames dynamic artistic
  atmospheres as a first-class use case.

## Options mapped to our architecture

| Approach                                                       | Plugs in at                                         | Cost                | IBL/PMREM coherent?                                                      |
| -------------------------------------------------------------- | --------------------------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| (a) Exaggerated AtmosphereParams preset                        | params → existing LUT chain                         | bake-time only      | ✅ by construction, but bounded by what scattering can produce           |
| (b) Post-SkyView color remap node **inside SkyAtmosphereMesh** | `_buildColorNode` after LUT sample × luminanceScale | ~free per-pixel ALU | ✅ **only if baked into the mesh shader** — cube + PMREM inherit it free |
| (c) Gradient-mode ramp (4.4) reused                            | replaces SkyView sample                             | cheapest, no LUTs   | ✅ but loses all physical response; clashes with physical haze           |
| (d) Screen-space grade LUT post-process                        | after composite                                     | +1 pass             | ❌ never touches cube/PMREM → IBL desync                                 |

## v1 recommendation

**(b) + a light layer of (a)**, exposed as `preset: 'ghibli'` with
`styleStrength` (0 = physical, 1 = full remap, default 0.7). The remap MUST
live inside the sky mesh's colorNode (pre-cube-bake) so background, IBL, and
reflections stay consistent — applying it as a post-process would recreate the
AP/SkyView mismatch bug class.

Param layer: rayleigh ×1.15, warm mie tint `#ffe9d6`, phase-g −15%, ozone +10%.

Remap: 3 elevation bands lerped by sunElevation and zenith→horizon:

| Band      | sunElev | Zenith    | Mid       | Horizon   |
| --------- | ------- | --------- | --------- | --------- |
| Night     | ≤ −6°   | `#0b1330` | —         | `#26365e` |
| Dawn/Dusk | −6°..8° | `#6fa3d8` | `#f3c98f` | `#ff9d6c` |
| Day       | > 8°    | `#4f8fdb` | —         | `#e8f3f7` |

Blend with the physical sample at `styleStrength` (keeps altitude/haze response).

v2 (deferred): posterize/banding toggle (needs dithering), data-driven ramp
asset, retinting AP/haze to match, interaction with sun-disc rework (4.2).

## Open questions for maintainer

1. Is `ghibli` a preset on physical mode (recommended) or a third `mode`?
2. Remap node mesh-only, or also exported as a standalone TSL helper?
3. Hardcoded hex stops v1 vs data-driven ramp?
4. Retint haze to match, or leave haze physical in v1? (highest-risk follow-up)
5. Should stylized mode clamp exposure response (anime skies don't blow out)?
6. Any banding in v1, or smooth-remap only?
