# pmndrs/upscaler × @pmndrs/sky — fit assessment (research, 2026-07-12)

_Agent-researched; feeds ROADMAP Track 4.6._

## What upscaler is

FSR3-style **temporal** upscaling: jitter-aware history accumulation over
motion vectors. WebGPU + three r184+; accepts scene/camera or explicit
color/depth/velocity textures; outputs display-res sRGB. Has a spatial-only
`upscaleSpatial` fallback for motion-free content.

## Verdicts

| Candidate                                | Verdict                                | Why                                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) Half-res scene+haze → FSR3 to native | **needs-prototype** (the one to build) | Matches upscaler's own demo pattern (post-effects at reduced res). Must verify: haze quality at half-res vs temporal reconstruction gain; depth+velocity at reduced res; jittered camera (`setViewOffset`) flowing through our camera-matrix-reading passes. |
| (b) Low-res cube bake upscaled pre-PMREM | **no-fit**                             | FSR3 is temporal — needs jitter history + motion vectors; static bakes have neither. Spatial-only path is generic upsampling, not compelling.                                                                                                                |
| (c) README-suggested use                 | covered by (a)                         | Upscaler demo 06 = spatial effects at reduced res + FSR3 final pass.                                                                                                                                                                                         |

## Recommendation

Build one demo (examples/vanilla): existing haze scene with a toggle between
native full-res and half-res + FSR3, showing frame-time delta + visual
comparison. **No changes to the sky library are required** — the AP LUT/cube
bakes are resolution-indifferent; integration lives entirely in the demo.
Watch item: our sky mesh + haze read camera matrices each frame, so the
upscaler's camera jitter should flow through automatically — verify, don't assume.
