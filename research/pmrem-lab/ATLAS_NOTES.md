# CubeUV atlas writer (three r185 / r186)

On r185 and r186, materials read PMREMs from a **CubeUV atlas**
(`CubeUVReflectionMapping`) through `textureCubeUV`. The writer packs our own
prefilter into that atlas. It has two stages, both in `lab.js`:

1. `Lab.prefilterLevels(src, srcSize, levels)`: one single-mip cube per atlas
   level, at that level's roughness (the existing FIS / INTEG kernels).
2. `Lab.packCubeUV(levels, cubeSize, atlas?)`: the `PACK_CUBEUV` WGSL kernel.
   For every tile texel it works out the direction three rasterizes there,
   samples that level's cube, and writes the rgba16float atlas.

Pages: `atlas-r185.html` and `atlas-r186.html`, both driving `atlas.js`.

## Layout: verified against source and output

These facts come from the r185 and r186 source, `PMREMGenerator._createPlanes`,
`_applyGGXFilter`, `_setViewport`, `PMREMUtils.bilinearCubeUV`,
`getUV` / `getFace` / `getDirection` and `PMREMNode`, plus a WebGPU readback.

- **Atlas size** `3·max(cs, 112) × 4·cs`, where `cs = 2^floor(log2 size)`.
  That gives 768×1024 rgba16float for a 256 cube, with 1 mip. The sampler
  derives everything from the height: `CUBEUV_MAX_MIP = log2(H) − 2 = lodMax`.
- **Levels:** `lodMax − 4 + 1 + 6`, which is 11 for a 256 cube. Tile size is
  `2^max(lodMax − i, 4)`. Tile i covers `3s × 2s` texels at
  `x = 3s·max(i − (lodMax − 4), 0)`, `y = 4·(cs − s)`. On WebGPU the viewport y
  and texel row 0 are both at the top. `isFlipY()` is false for WGSL, so there
  is no uv flip anywhere.
- **Slots inside a tile:** slot k sits in column `k % 3`. Slots 0–2 fill the
  bottom half (NDC y from −1 to 0) and slots 3–5 the top half. Slot k holds
  cube face `_faceLib[k] = [3, 1, 5, 0, 4, 2][k]` in `getDirection` numbering
  (0 +X, 1 +Y, 2 +Z, 3 −X, 4 −Y, 5 −Z). So the top row is (+X, −Y, +Z) and the
  bottom row is (−X, +Y, −Z). The sampler flips y on the way in (see below), so
  it sees faces 0/1/2 on top and 3/4/5 below.
- **Texel → direction:** in a slot of size s, texel (p, q) (q = 0 at the
  slot's top row) has `uv = ((p − 0.5)/(s − 2), (s − 1.5 − q)/(s − 2))` and
  `G = getDirection(uv, face)`. The inner (s−2)² texels are exactly the texel
  centres of an (s−2)² cube face. The 1-texel border is the direction just
  past the face edge, which the sampler's bilinear taps need.
- **Frames:** G is the world direction. `PMREMNode` samples
  `textureCubeUV(atlas, (x, −y, z))` because the atlas is a render-target
  texture, and `getFace` / `getUV` then land exactly on the texel that holds G.
  The generator fills level 0 through `CubeTextureNode`, which on WebGPU reads
  the source cube at `(−G.x, G.y, G.z)`. Our levels are in the same raw cube
  frame as the source, so the pack samples them at `(−G.x, G.y, G.z)` too.
  **Gotcha:** the y flip only applies when `texture.isRenderTargetTexture` is
  true. A hand-made texture that isn't a render-target texture gets no flip, so
  the pack would need `G.y` negated.
- **Outside the tiles:** three leaves 253,440 texels at (0, 0, 0, 0). A fresh
  WebGPU texture is zero-initialised and the pack never writes there, so ours
  matches. The sampler never reads those texels anyway.
- **Check:** we packed the copy level (source mip 0, bilinear) and compared it
  with three's level-0 tile texel for texel. On every sky and both versions,
  about 0.01–0.07% of channels differ, by at most 1 half-float ulp
  (relative 1e-3; milkyway's larger relative values are subnormals around
  1e-5). The geometry, frames and border handling therefore match three's.

### Level ↔ roughness (inverse of `roughnessToMip`)

The sampler blends `floor(mip)` and `floor(mip) + 1`, where
`mip = clamp(roughnessToMip(r), −2, lodMax)`. Level i is sampler mip
`m = lodMax − i`. `cubeUVRoughness(m)` below is the roughness at which the
sampler reads level i alone.

| Level (256 cube) | Tile | Sampler mip | Roughness                | Our plan (default `cubeUVLevels`)    |
| ---------------- | ---- | ----------- | ------------------------ | ------------------------------------ |
| 0                | 256² | 8           | 0 (used alone r ≤ 0.054) | source mip 0, bilinear (as three)    |
| 1                | 128² | 7           | 0.0762                   | 126², FIS 256, mirror frame          |
| 2                | 64²  | 6           | 0.1078                   | 62², FIS 256, mirror                 |
| 3                | 32²  | 5           | 0.1524                   | 30², FIS 256, mirror                 |
| 4                | 16²  | 4           | **0.21** (not 0.2155)    | 14², FIS 256, mirror                 |
| 5                | 16²  | 3           | 0.305                    | 14², exhaustive integration over 16² |
| 6                | 16²  | 2           | 0.4                      | 14², integ 16²                       |
| 7                | 16²  | 1           | 0.5333                   | 14², integ 16²                       |
| 8                | 16²  | 0           | 0.6667                   | 14², integ 16²                       |
| 9                | 16²  | −1          | 0.8                      | 14², integ 16²                       |
| 10               | 16²  | −2          | 1.0                      | 14², integ 16²                       |

`roughnessToMip` has a jump at r = 0.21: the log branch gives mip 4.07 just
below it, and the linear branch gives 4.0 at 0.21. So mip 4 is only reached
exactly at 0.21. The log-branch inverse (0.2155) is never used by the sampler.

## r185 vs r186

- The **atlas layout and the sampler are identical.** `textureCubeUV`,
  `bilinearCubeUV`, `getUV`, `getFace`, `roughnessToMip`, the viewports and
  `_createPlanes` geometry, and `CubeTextureNode` do not change. `PMREMNode`
  only adds a `_pmrem === null` guard.
- r186 computes the output direction per vertex (an `outputDirection`
  attribute) instead of per fragment (`getDirection(uv, faceIndex)`). It is
  linear in uv, so the result is identical.
- r186 halves `GGX_SAMPLES` (512 → 256) and replaces the `fromScene` sigma blur
  with a spiral Gaussian, which `fromCubemap` doesn't use. Its incremental GGX
  chain is otherwise the same, so the r185 and r186 atlases are nearly
  identical (see below).
- **One writer covers both versions.** Our atlas, and its error against truth,
  are bit-for-bit the same on both.

## Validation (six real-sky captures, 256 cube)

**Sphere grid:** 11 roughness columns (0 … 1) × 4 yaw rows, 48 px cells.
Three's own material sampling renders it: a `NodeMaterial` whose fragment is
`pmremTexture(atlas, R_world, col/10)`, NoToneMapping, into a half-float
target. We render it once with three's atlas and once after copying ours into
three's atlas GPU texture (`copyTextureToTexture`). Both are tonemapped
`x/(1+x)`, gamma 2.2, into 8 bits, with exposure set so the r = 1 reference
averages mid-grey.

**Truth:** one reference cube per column at the column's exact roughness,
sampled at the pixel's direction: `Lab.referenceLevel`, GGX split-sum with
NdotL weighting and α = r².

- r = 0: the source.
- r = 0.1: unbiased IS, 16,384 samples, from mip 0, into 256².
- r = 0.2: exhaustive integration over the 128² mip, into 128².
- r ≥ 0.3: exhaustive integration over the 64² mip, into 64².

Each reference texel is smaller than the lobe's full width at half maximum
(FWHM). The truth doesn't depend on the atlas, and it is independent of our
plan's sampling.

**Ideal atlas:** reference-quality levels (same modes) packed by the same pack
kernel and read by three's sampler. This is the floor of the format itself:
blending between levels, and the 14² interiors at r ≥ 0.21.

8-bit error over sphere pixels, mean / p99 / max. Ours is identical on r185
and r186.

| Sky      | ours vs truth  | three r185 vs truth | three r186 vs truth | ours vs three (r186) | ideal atlas vs truth |
| -------- | -------------- | ------------------- | ------------------- | -------------------- | -------------------- |
| noon     | 0.27 / 2 / 4   | 2.04 / 11 / 16      | 2.06 / 11 / 16      | 2.17 / 11 / 15       | 0.21 / 2 / 4         |
| golden   | 0.59 / 4 / 12  | 4.61 / 21 / 52      | 4.66 / 21 / 53      | 4.90 / 23 / 56       | 0.44 / 4 / 12        |
| sunset   | 1.01 / 9 / 17  | 6.94 / 34 / 94      | 7.07 / 36 / 86      | 7.55 / 36 / 91       | 0.64 / 6 / 19        |
| twilight | 1.01 / 10 / 20 | 7.66 / 44 / 128     | 7.85 / 46 / 116     | 8.24 / 45 / 119      | 0.67 / 6 / 22        |
| nautical | 1.60 / 15 / 31 | 11.24 / 59 / 160    | 11.53 / 63 / 187    | 11.74 / 58 / 185     | 0.92 / 9 / 23        |
| milkyway | 1.98 / 13 / 22 | 13.01 / 47 / 96     | 13.41 / 49 / 99     | 14.23 / 50 / 112     | 1.04 / 6 / 22        |

p99 per roughness column (0, 0.1, …, 1) against truth:

| Sky      | ours                    | three r186                       | ideal atlas             |
| -------- | ----------------------- | -------------------------------- | ----------------------- |
| noon     | 0 1 3 2 1 1 1 1 1 1 1   | 0 3 4 8 10 11 11 8 4 9 13        | 0 1 3 2 1 1 1 1 1 1 1   |
| golden   | 1 8 10 4 2 2 1 1 1 1 1  | 1 30 22 25 22 20 18 13 11 19 26  | 1 8 10 5 2 1 1 1 1 1 1  |
| sunset   | 1 12 14 6 3 2 2 2 2 3 3 | 1 70 36 40 34 31 26 20 28 40 49  | 1 13 16 6 2 2 2 2 2 2 3 |
| twilight | 1 11 15 6 2 2 2 2 3 3 3 | 1 92 52 52 41 38 31 24 34 48 57  | 1 11 16 6 2 3 3 3 3 3 4 |
| nautical | 1 17 22 6 3 3 3 3 4 4 4 | 1 121 75 68 54 47 37 29 42 59 70 | 1 15 16 6 3 3 4 4 4 5 5 |
| milkyway | 1 18 14 7 3 3 4 4 4 5 5 | 1 48 42 52 46 40 33 26 38 53 64  | 1 6 13 6 3 3 3 3 4 4 4  |

Reading these tables:

- **Ours has 6.6–7.8× lower mean error against truth than three's own
  generator, on every sky and both versions.** It is within 0.06–0.94 mean of
  the ideal atlas.
- The r 0.1–0.2 columns carry our largest error (p99 8–22), but the ideal
  atlas has the same error there. It is the format's floor: level blending,
  plus a 0.21 lobe (FWHM about 6.5°) on a 14² grid (about 6.4° per texel).
  The one gap we could close is milkyway r 0.1 (18 vs 6): FIS noise on point
  stars. FIS 512 brings milkyway to 1.78 / 10 / 22, FIS 1024 to 1.59 / 8 / 22,
  at 2× and 5× the cost.
- **Three's atlas doesn't match its own sampler.** `_applyGGXFilter` builds
  level i as an incremental chain aimed at roughness i/10, scaled by
  1.25·i/10 per step. The sampler instead reads level i at
  `cubeUVRoughness(lodMax − i)`: 0.076, 0.108, …, 0.305 for level 5, 0.533
  for level 7. Visually, three keeps the horizon too sharp at r 0.4–0.6 and
  loses the ground-reflection falloff at r ≥ 0.8 that truth and ours keep.
  **Ours will therefore look different from stock r185/r186 at mid and high
  roughness.** It isn't a regression, because it is much closer to truth, but
  it is a visible look change for existing users of those versions.

Per level, atlas texels ours vs three (r186), luminance relative error in %,
interior / border. This shows the same algorithm gap. Borders track interiors,
with no border-specific blow-up:

| Sky      | L1 .076     | L2 .108     | L3 .152     | L4 .21      | L5 .305     | L6 .4       | L7 .533     | L8 .667     | L9 .8       | L10 1       |
| -------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- |
| noon     | 0.25 / 0.18 | 0.63 / 0.53 | 1.31 / 1.21 | 2.35 / 2.27 | 4.13 / 4.32 | 5.57 / 6.44 | 7.27 / 8.68 | 5.88 / 6.94 | 2.42 / 2.82 | 1.48 / 1.00 |
| golden   | 1.99 / 1.38 | 3.54 / 2.46 | 5.07 / 3.64 | 6.30 / 4.68 | 9.09 / 8.15 | 10.7 / 10.8 | 12.8 / 13.8 | 10.0 / 10.8 | 5.25 / 5.50 | 3.03 / 2.67 |
| sunset   | 11.7 / 6.82 | 19.7 / 12.8 | 26.1 / 18.2 | 29.2 / 20.9 | 43.0 / 40.6 | 44.7 / 56.0 | 43.2 / 55.5 | 24.4 / 28.6 | 9.65 / 10.2 | 5.57 / 3.35 |
| milkyway | 4.36 / 2.87 | 13.1 / 9.85 | 28.6 / 23.3 | 47.2 / 37.9 | 71.1 / 55.2 | 70.8 / 62.2 | 72.0 / 79.5 | 41.9 / 49.5 | 20.9 / 19.3 | 19.2 / 13.6 |

### Seams and borders

Sphere pixels whose reflection direction lies within 10% of a cube face edge
(minor/major > 0.9) exercise the tile borders and the cross-face bilinear
taps. Mean / p99 / max against truth:

| Sky      | ours, near face edge | ours, elsewhere | three r185, near edge | three r185, elsewhere |
| -------- | -------------------- | --------------- | --------------------- | --------------------- |
| noon     | 0.21 / 1 / 2         | 0.28 / 2 / 4    | 2.25 / 11 / 12        | 2.01 / 11 / 16        |
| golden   | 0.46 / 2 / 10        | 0.61 / 4 / 12   | 4.91 / 20 / 46        | 4.57 / 21 / 52        |
| sunset   | 0.84 / 6 / 13        | 1.03 / 9 / 17   | 7.26 / 32 / 92        | 6.89 / 35 / 94        |
| twilight | 0.83 / 8 / 12        | 1.04 / 10 / 20  | 7.98 / 39 / 128       | 7.62 / 44 / 127       |
| nautical | 1.37 / 12 / 27       | 1.54 / 15 / 31  | 11.39 / 54 / 141      | 10.41 / 58 / 160      |
| milkyway | 1.62 / 12 / 17       | 1.90 / 13 / 22  | 11.62 / 43 / 72       | 12.00 / 47 / 96       |

Near-edge error is no worse than elsewhere, so there is no seam or border
artefact. Our border texels are a hardware (seamless) cube sample just past
the face edge. Three's are a bilinear re-read of the neighbouring face in its
copy-back pass. They agree to the same degree as the interiors.

### Plan variants (sphere grid vs truth, mean / p99 / max)

| Variant                                          | noon         | golden        | sunset        | twilight       | nautical       | milkyway       |
| ------------------------------------------------ | ------------ | ------------- | ------------- | -------------- | -------------- | -------------- |
| default                                          | 0.27 / 2 / 4 | 0.59 / 4 / 12 | 1.01 / 9 / 17 | 1.01 / 10 / 20 | 1.60 / 15 / 31 | 1.98 / 13 / 22 |
| L5 (0.305) integ over 32²                        | 0.27 / 2 / 4 | 0.58 / 4 / 12 | 1.00 / 9 / 17 | 1.01 / 10 / 20 | 1.58 / 15 / 31 | 1.96 / 13 / 22 |
| unpadded: levels at s², pack resamples to (s−2)² | 0.35 / 2 / 5 | 0.69 / 5 / 14 | 1.15 / 9 / 21 | 1.17 / 10 / 24 | 1.73 / 15 / 29 | 2.30 / 14 / 24 |
| L1 FIS 96                                        | 0.27 / 2 / 4 | 0.59 / 4 / 12 | 1.01 / 9 / 17 | 1.01 / 10 / 20 | 1.60 / 15 / 29 | 1.98 / 13 / 22 |
| L1 + L2 FIS 128                                  | 0.27 / 2 / 4 | 0.60 / 4 / 12 | 1.00 / 9 / 17 | 1.00 / 10 / 20 | 1.57 / 15 / 34 | 1.98 / 14 / 23 |

- **Prefilter on the (s−2)² interior grid.** Packing is then an exact
  texel-centre read, which is both better and cheaper than s².
- **Integrating L5 over 32² buys nothing.** 16² is enough at r = 0.305.
- **Dropping to FIS 96–128 on L1/L2 costs no measurable quality** and saves
  about 0.3–0.4 ms. It is the cheaper default to consider.

## Timing (256 cube, Apple Metal, headless Chromium)

Minimum of bursts of 20 bakes. The quiet run was single-candidate bursts on an
idle machine. The round-robin run put every candidate through one burst per
round, 9 rounds, with other GPU work on the machine, so its absolute numbers
read high.

| What                                             | quiet r185 | quiet r186 | round-robin r185 | round-robin r186 |
| ------------------------------------------------ | ---------- | ---------- | ---------------- | ---------------- |
| three `fromCubemap`                              | 6.35       | 3.26       | 6.42             | 4.11             |
| ours: source mips + 10 levels + pack             | 1.44       | 1.44       | 1.46             | 1.72             |
| ours + `copyTextureToTexture` into three's atlas | 1.46       | 1.45       | 1.46             | 1.75             |
| pack only (11 dispatches)                        | 0.035      | 0.040      | 0.045            | 0.045            |
| ours, L1 + L2 FIS 128                            | –          | –          | 1.07             | 1.29             |

Breakdown from the r185 round-robin run (min, level alone minus mips): source
mip chain 0.04; L1 (126², FIS 256) 0.50; L2 0.33; L3 0.15; L4 0.07; each of
the six integrated levels 0.045–0.05; pack 0.045. FIS on L1–L2 is about 57% of
the cost. The six 14² integration levels could run as one dispatch, since they
share the 16² source.

**Ours is 4.4× faster than r185 and 2.3× faster than r186, and much closer to
truth.**

## Gotchas

- Three's atlas render target texture has no `STORAGE_BINDING` usage (only
  when `isStorageTexture`). Pack into our own texture and
  `copyTextureToTexture` it (about 0.01–0.03 ms), or allocate the three
  `RenderTarget` with a storage texture.
- Keep `isRenderTargetTexture = true` on the texture materials read, or flip G.y
  in the pack (see Frames above). Also keep `isPMREMTexture = true` and
  `mapping = CubeUVReflectionMapping`, so `PMREMNode` uses the texture as is
  instead of running three's generator on it.
- Level 0 alpha is the source alpha; every other level writes 1.0. Both match
  three.
- `Lab.referenceLevel` and the INTEG kernels read source mips. Call
  `lab.generateMips(src, size)` before any reference work that runs ahead of a
  prefilter. Without it the first truth run was all NaN.
- Timing drifts a lot when other GPU work shares the machine: r186
  `fromCubemap` read 3.2 to 4.5 ms across runs. Compare candidates round-robin
  within one page.
- Possible optimisation, not implemented: fuse the prefilter into the pack.
  Evaluate the filter directly at each atlas texel's G. This removes the
  intermediate cubes and the pack pass, and makes the border texels exact
  filter values rather than bilinear.
