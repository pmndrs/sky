# Hillaire's reference sky, running in the browser

Sébastien Hillaire's [UnrealEngineSkyAtmosphere](https://github.com/sebh/UnrealEngineSkyAtmosphere)
(EGSR 2020, MIT, © Epic Games) is the demo this library ports. It only runs on Windows, but that's because
of its D3D11 host, not its shaders. This folder runs **his HLSL, compiled to WGSL** on WebGPU, so
`20-reference-compare.html` can put it next to Bruneton's demo and `@pmndrs/sky` with one camera and one
sun, and compare the three numerically.

| File                        | What it is                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `generated/*.wgsl`          | His entry points, compiled by Slang. **Generated — do not edit.**                                                                               |
| `generated/manifest.json`   | Per-entry bindings, both constant-buffer layouts (from Slang reflection), source commit, Slang version, and the source patches.                 |
| `generated/bluenoise64.bin` | The 64×64 tile of his `bluenoise.exr` that the path tracer reads, as r32f.                                                                      |
| `CameraVolumeSlice.slang`   | Wrapper that draws his AP volume one slice at a time; WebGPU has no geometry shaders.                                                           |
| `SebhReference.js`          | The host, standing in for his `Game.cpp` / `RenderSky.cpp`: his constant buffers, his LUT formats, his pass order. Runs on its own `GPUDevice`. |
| `compare.js`                | Readback and ratio statistics used by the page (`../reference/` holds the Bruneton and ours panels).                                            |

## Running it

```sh
pnpm --filter @pmndrs/sky-example-vanilla dev        # open /20-reference-compare.html
BASE=http://localhost:5173/ pnpm --filter @pmndrs/sky-example-vanilla ref:verify   # headless report
```

His panel has three methods: `lut` (his real-time default: Sky-View LUT plus AP
volume), `raymarch` (the same shader with both LUT shortcuts off), and `pathtrace` (his spectral path
tracer, with no multi-scattering approximation). The path tracer is the ground truth, and it needs the
`float32-blendable` feature.

`scripts/verify-reference.mjs` writes `scripts/.verify-out/reference-report.md` (`--only sebh` for just his
sections). It exits non-zero if the
Transmittance or Multi-scattering LUT stop matching his to within 1%, or if WebGPU reports an error. Those
two LUTs are ported literally and don't depend on the camera or the sun, so a failure there means the
harness broke, not the sky. `--strict` also fails when the Sky-View LUT drifts past ±3%.

## Rebuilding the WGSL

```sh
pnpm --filter @pmndrs/sky-example-vanilla sebh:build
# or with local copies:
SEBH_REPO=~/src/UnrealEngineSkyAtmosphere SLANGC=/path/to/slangc node scripts/build-sebh-wgsl.mjs
```

The script pins his commit and the Slang release. By default it clones and downloads both into
`examples/vanilla/.cache/` (gitignored). Rebuild only on purpose: bump a pin, then re-run the verify.

## What differs from running his .exe

Everything below is mechanical, and each item is justified where the code does it:

- **Bindings.** D3D's separate b/t/s/u register spaces are shifted into one WGSL group (b 0+, t 10+,
  s 30+, u 40+).
- **Matrices.** The build compiles with `-matrix-layout-row-major`, and the host uploads column-vector
  matrices row by row.
- **AP volume.** It's filled with 32 passes instead of one instanced geometry-shader draw.
- **Transmittance pass.** His shader declares the LUT it is writing as an input. D3D left that slot as a
  null SRV (reads 0); WebGPU forbids binding the attachment itself, so an explicit 1×1 zero texture is
  bound instead.
- **Formats.** The multi-scattering LUT is a write-only `rgba16float` storage texture, as in his
  `Game.cpp`. The Sky-View LUT is `rgba16float` rather than his `R11G11B10_FLOAT`, which gives more
  precision on this side. Path-tracer accumulation uses `rgba32float` with additive blending.
- **Two source patches** (`PATCHES` in the build script, recorded in `manifest.json`). They clamp two
  `sqrt(1 − x²)` calls in `SkyViewLutPS`. Through Slang and Metal, the Sky-View LUT's last column rounds
  to `lightViewCosAngle = −(1+ε)`, the square root goes NaN, and bilinear filtering spreads that across the
  anti-sun sky. Both patches are no-ops wherever his code is well defined.
- **A Slang WGSL-emitter bug.** Slang leaves IO attributes on internal structs; the build strips them.

Settings are his defaults unless noted:

- `gSunIlluminance` 1, which is the only thing his `IllumScale` slider changes
- ground albedo 0
- 4–14 variable samples per pixel
- fast sky and fast AP on
- coloured transmittance off
- transmittance method = LUT
- path-tracer depth 12 (his UI default is 4)

His "forward" camera offset moves back along the view ray, vertical component included. The page clamps
the camera to at least 10 m above the ground: underground, his shaders return a flat colour.
