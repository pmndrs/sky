# Sky PMREM — spec

Our own prefilter for the sky's image-based lighting, replacing three's
`PMREMGenerator` on the WebGPU path. Tracking issue: pmndrs/sky#21.

**Status (2026-09-29):** Phases 0–4 are done for every three version we
support. `SkyPmrem` (`src/sky/pmrem/`) is the baker's IBL path on WebGPU and
re-filters the PMREM in one compute pass on every sky change:

- **three r187+ (cube PMREM):** three's exact algorithm, output identical to
  three's generator. `sky.update()` with the sun moving every frame costs
  1.03 ms mean.
- **three r185/r186 (CubeUV atlas):** each atlas level is prefiltered at the
  roughness three's sampler reads it at, then packed into the atlas. That's
  1.09 ms mean, and 6.6–7.8× closer to the true GGX lobe than three's own
  generator. It is a visible change of look at mid and high roughness (§6,
  Phase 3b). Decided 2026-09-30: ours is the default; `pmrem: { generator:
'three' }` is the opt-out.
- **WebGL backend, unknown layouts:** fall back to three's generator plus
  `PmremScheduler`, unchanged.

Next: the upstream proposal, which continues in Dennis's three.js fork (§6, Phase 4b), then Phase 5.

---

## 1. Why

A sun change re-bakes the sky cube (about 0.3 ms) and then its PMREM. With
three's generator the PMREM is almost the whole cost, and it's latency-bound:
many small passes, each running a long serial sample loop per texel. Shrinking
the cube barely helps.

`PmremScheduler` hides the cost by throttling (at most every 250 ms while the
sky changes) and time-slicing (one level per frame). It works, but the IBL
lags the background. When you scrub the time of day with a slider, shiny
objects update in visible steps while the sky moves smoothly. **The goal is a
prefilter cheap enough to run every frame**, so the IBL updates in the same
frame as the background, with no throttle and no lag.

## 2. Scope

**In scope**

- The sky cube only. Its content is smooth, the sun disc and resolved stars
  are excluded from the bake, and the Milky Way is low-resolution.
- The WebGPU backend, as compute shaders.
- Output in the format the installed three reads (§3), written into a
  persistent texture whose identity never changes.

**Not in scope**

- General HDRI prefiltering. Arbitrary environments with tiny, very bright
  sources are three's job.
- The WebGL backend. three's `WebGPURenderer` falls back to WebGL2, where
  there's no compute, so we fall back to three's generator plus
  `PmremScheduler`.
- Changing how three's materials sample the environment.

## 3. Output contract

Materials read the environment through three's own sampler, so we must
produce exactly the layout, and the roughness-to-level mapping, that the
installed three expects.

| three                         | Format                                                                                            | Levels                                                              | Roughness per level                               | Sampler mapping                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| r185, r186                    | CubeUV **atlas**, `CubeUVReflectionMapping`, 768×1024 half-float for a 256 cube                   | `lodMax − LOD_MIN(4) + 1` levels plus 6 "extra sigma" levels at 16² | r185: incremental GGX chain; r186: 256-sample GGX | `textureCubeUV` (atlas lookup, `getUV`, per-level padding texels)                        |
| r187 (`dev`, #34585 / #34645) | **Cube render target with mips**, `texture.isPMREMTexture = true`, `mipmaps[]` listing each level | mips `0 … log2(size) − 3` (six levels for 256, 256² down to 8²)     | `r(lod) = 1 − √(1 − lod / maxLod)`                | `roughnessToMip(r) = maxLod · r · (2 − r)`; material roughness clamped to at least 0.045 |

Design consequence: **the prefilter is layout-agnostic**. It writes a cube
with mips (the r187 layout) into our own storage texture. A small **writer**
stage then delivers it:

- **r187:** a per-mip GPU copy into three's cube render target.
- **r185/r186:** a pack pass that writes the atlas layout, including the
  extra-sigma levels, by resampling our levels at the atlas's roughness per
  level.

Detect the layout from the three revision, or from what `PMREMGenerator`
produces on first bake. An unknown layout falls back to three's generator,
with one warning.

## 4. Algorithm

One compute pass per bake, one dispatch per level (WGSL can't bind an array
of storage textures), recorded in a single command encoder.

1. **Source mips.** A 2×2 box downsample of the sky cube, all six faces per
   dispatch, down to 1².
2. **Level 0.** A straight copy (roughness 0). r187's material clamp means
   level 0 is only reached at roughness 0.045.
3. **Sharp levels.** GGX filtered importance sampling (Křivánek & Colbert
   2007), the same estimator as three `dev`. V = N, samples weighted by N·L,
   each sample reading the source mip that matches its solid angle via
   `lodBias`. Hammersley points are deterministic, so there's no temporal
   noise. Sample count is set per level (§6).
4. **Rough levels.** Exhaustive GGX integration over a small source mip (16²
   or 32²): weight = D(h) · N·L · dω. This is noise-free, and the output
   levels are tiny. The kernel must tile the source through workgroup shared
   memory; the naive version is the current bottleneck (§6).
5. **Cache everything.** Pipelines, bind groups, uniform buffers and views are
   created once per size. A bake records dispatches and nothing else, with no
   per-frame allocation.

## 5. Pass/fail criteria

A criterion is met only when the named harness measures it. Hardware
reference is headless Chromium on Apple M-series with the `--use-angle=metal`
flags from `scripts/verify-looks.mjs`. Timings are **burst wall-clock**: N
bakes, one `onSubmittedWorkDone`, divided by N. WebGPU timestamps are
unreliable on Apple for many small passes. Cube size is 256, source mip
generation included.

### Performance

| ID  | Criterion                                                                                  | Pass                        | Stretch       |
| --- | ------------------------------------------------------------------------------------------ | --------------------------- | ------------- |
| P1  | Full prefilter (source mips + all levels + writer)                                         | ≤ 1.0 ms                    | ≤ 0.5 ms      |
| P2  | CPU encode per bake; allocations per bake                                                  | ≤ 0.1 ms; zero              |               |
| P3  | `sky.update()` with the sun moving every frame, IBL refreshed **every frame**, no throttle | mean ≤ 1.5 ms, max ≤ 2.5 ms | mean ≤ 1.0 ms |

For comparison, today's scheduler is mean 1.03 ms and max 3.1 ms, but the IBL
lags by up to about 250 ms plus 10 frames.

### Quality

**Error metric.** Per level, on luminance, against a brute-force reference:
16,384 unbiased importance samples at mip 0 for roughness below 0.4, and
exhaustive integration over a 64² mip above. Each texel's error is
|ours − ref| / max(ref, 5% of the level's mean reference luminance). The floor
keeps near-black texels, such as ground beside a twilight horizon or a night
sky, from dominating with errors nobody can see. The first version used a
fixed 1e-4 floor, which reported nonsense on dark skies. We report mean and
p99 per level.

| ID  | Criterion                                                                                                                               | Pass                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | White furnace (uniform 1.0 sky)                                                                                                         | every level within 0.1% of 1.0                                                                                                                                                            |
| Q2  | **Real sky captures** from the baker: noon, golden hour, sunset, civil twilight, nautical twilight, Milky Way night (`capture-sky.mjs`) | per level: mean ≤ 1.5% and p99 ≤ 10%, **or** Q3                                                                                                                                           |
| Q3  | Parity with three, for cases where the absolute bars can't be met                                                                       | no level worse than the three-`dev`-equivalent plan (256-sample FIS + 16² integration) by more than 1.25× on mean or p99                                                                  |
| Q4  | Fireflies                                                                                                                               | per-level max ≤ 1.05× the reference max                                                                                                                                                   |
| Q5  | Temporal stability: (a) sun swept 0.1° per frame; (b) any discontinuity the generator adds (plan or tier switch)                        | (a) per-texel jitter (relative second difference) p99 within 1.25× of a 2048-sample plan; (b) sphere-grid jump ≤ 1/255 mean, ≤ 6/255 p99                                                  |
| Q6  | Visual parity: a roughness grid (0 … 1.0) lit by our IBL vs three's, same sky, tonemapped 8-bit                                         | ours vs three: mean diff ≤ 2/255, p99 ≤ 6/255. Proxy until Phase 3: each plan's distance to the **reference** within 0.25/255 mean and 2/255 p99 of three's own distance (`spheres.html`) |

Why Q2 has an "or": on real sunset and twilight skies, **no** filtered
importance sampler meets the absolute bars on L1 and L2, three's included.
The sharp horizon and the Milky Way band defeat mip-biased sampling. The
absolute bars still apply wherever they are achievable. Elsewhere the bar is
parity with three.

Why Q5 changed: the first version tested steps in each level's mean
luminance, which only reflects the sky's content (every plan, the smooth one
included, scored the same). With deterministic sample sets and linear
filtering, the output is a continuous function of the sun position, so no
plan can flicker under a sweep. An undersampled control (16 samples, mip bias
−3) still showed only 0.25% jitter. The real temporal hazard is a
discontinuity the generator introduces itself, such as switching plans when
the sky settles, so Q5(b) measures that jump.

### Integration

| ID  | Criterion                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | `environmentTexture` keeps the same object from the first bake to `dispose()`                                                                                       |
| I2  | Auto-detects r185/r186 (atlas) and r187 (cube mips); an unknown layout or the WebGL backend falls back to three's generator plus `PmremScheduler`, with one warning |
| I3  | Scrubbing a slider: after `setTimeOfDay()` plus one `update()`, the IBL equals a flushed bake of that state (pixel diff 0 at 0.04 threshold)                        |
| I4  | `dispose()` frees every GPU resource; no per-frame allocations (heap snapshot stable over 600 frames)                                                               |
| I5  | `pnpm run ci`, `scripts/verify-looks.mjs` and `scripts/verify-looks-ramp.mjs` pass unchanged                                                                        |

### Kill / fallback criteria

- **P1 missed with Q2 met, after the shared-memory integration kernel:** ship
  a two-tier mode. A cheap FIS-only bake (about 0.5 ms, Q2 relaxed for rough
  levels) runs every frame while the sky is changing, and a full-quality bake
  runs once it settles.
- **Neither tier meets Q2 within 2 ms:** stop, keep `PmremScheduler`, and
  pursue the upstream per-level API in #21.

## 6. Results so far

All numbers below come from `research/pmrem-lab/`.

### Phase 0 — three's generator on the same input

Sky-like synthetic cube, three loaded from unbundled source. Minimum of 7
bursts of 20 bakes, idle machine (median within 1%). The first run had the
desktop Chrome GPU process busy and read about 2× higher (r185 11.6, r186
6.6, dev 8.0 ms at 256).

| three                 | 64 cube | 128 cube | 256 cube | CPU encode |
| --------------------- | ------- | -------- | -------- | ---------- |
| r185                  | 3.63 ms | 4.74 ms  | 6.33 ms  | 0.15 ms    |
| r186.1 (npm `latest`) | 1.84 ms | 2.41 ms  | 3.25 ms  | 0.16 ms    |
| r187-dev (`0b6ec15`)  | 4.47 ms | 4.47 ms  | 4.47 ms  | 0.38 ms    |

No three version comes close to 1 ms, and `dev`'s rewrite is slower than
r186. `dev` always works at 256 whatever the input size, and its CPU encode
doubles from 6 face passes per level.

### Phase 1 — raw compute prefilter, FIS on every level (timing only)

| Cube | Samples per texel | GPU wall | CPU encode |
| ---- | ----------------- | -------- | ---------- |
| 256  | 32                | 0.26 ms  | ~0.005 ms  |
| 256  | 64                | 0.47 ms  | ~0.005 ms  |
| 256  | 256               | 1.58 ms  | ~0.005 ms  |
| 128  | 64                | 0.20 ms  | ~0 ms      |

At three-`dev`'s own sample count, a single compute pass is about 5× faster
(1.58 vs 8.0 ms). The cost is pass structure, not arithmetic.

### Phase 2 — quality against the reference

Level roughness for a 256 cube: L1 0.11, L2 0.23, L3 0.37, L4 0.55, L5 1.00.
Each cell is mean relative error / p99. Time is noon. These timings include
per-call bind-group creation, so they overstate the cost.

| Plan                                      | L1          | L2          | L3          | L4          | L5          | ms   |
| ----------------------------------------- | ----------- | ----------- | ----------- | ----------- | ----------- | ---- |
| FIS 64 on all levels, noon                | 0.51 / 3.6  | 1.87 / 7.6  | 2.54 / 10.7 | 2.85 / 13.0 | 8.15 / 23.7 | 0.53 |
| D: FIS 64/128/256 + integ 16², noon       | 0.51 / 3.6  | 1.17 / 4.7  | 0.75 / 3.2  | 0.18 / 0.6  | 0.16 / 0.3  | 1.46 |
| three-dev-like: FIS 256 + integ 16², noon | 0.26 / 1.4  | 0.70 / 3.2  | 0.21 / 1.0  | 0.18 / 0.6  | 0.16 / 0.3  | 3.10 |
| D, sunset stress                          | 0.78 / 12.5 | 3.17 / 28.0 | 2.67 / 22.5 | 0.34 / 1.5  | 0.29 / 1.5  |      |
| three-dev-like, sunset stress             | 0.64 / 5.2  | 2.09 / 22.3 | 0.36 / 2.4  | 0.34 / 1.5  | 0.29 / 1.5  |      |

Furnace: every plan within 0.05% (Q1 passes).

Findings:

- FIS alone is poor on rough levels at any affordable count (L5 is 8% mean
  at 64 samples). Exhaustive integration fixes it: 0.03–0.3%.
- Naive integration dominates the time. Integrating L3 over 32² made plan A
  3.9 ms; a variant reading precomputed directions from a storage buffer was
  slower still (5.0 ms). The next step is the shared-memory tiled kernel.
- Plan D meets Q2-style bars on the noon synthetic sky at 1.46 ms. That's
  already about 5× faster than three `dev` at comparable quality, but not
  yet under P1.

### Phase 2b — kernels and honest timing

- **Integration kernel.** One 64-thread workgroup per output texel, with the
  threads striding the source and reducing in shared memory, is best for the
  tiny levels (L4, L5). A tiled kernel (8×8 outputs per workgroup, source
  staged through shared memory 64 texels at a time) is best for L3.
  Integrating L3 over 32² is inherently about 1.5 ms of work; over 16² it
  costs about 0.18 ms.
- **Per-level cost, D3** (min of bursts): source mips 0.06, L0 copy 0.05, L1
  0.37, L2 0.23, L3 0.18, L4 0.13, L5 0.07 ms. L1 is the lever.
- **Timing method.** Single-page, sequential timing drifts upward with page
  order (thermal, and other GPU work on the machine). `timing-rr.html` times
  plans round-robin and reports min / median / max. Minimums are the best
  estimate of uncontended cost.

Round-robin, golden-hour capture, 256 cube, 15 rounds × 30 bakes, idle
machine (2d re-time; the first run was contended and read 1.7–2× higher):

| Plan                                                    | min         | median  |
| ------------------------------------------------------- | ----------- | ------- |
| FIS 64 on every level                                   | 0.22 ms     | 0.22 ms |
| **D2**: FIS 64 / 128, integration 16² on L3–L5          | **0.42 ms** | 0.42 ms |
| **D3-96**: FIS 96 / 256, integration 16² on L3–L5       | **0.56 ms** | 0.56 ms |
| D3: FIS 128 / 256, integration 16² on L3–L5             | 0.62 ms     | 0.63 ms |
| three-dev-like: FIS 256 / 256, integration 16² on L3–L5 | 0.87 ms     | 0.88 ms |

three's own `dev` generator runs the three-dev-like algorithm in 4.47 ms; the
same algorithm in one compute pass takes 0.87 ms (5.1×).

### Phase 2c — real skies

Six captures of the library's own baked cube (`capture-sky.mjs`). Below about
−11° the scattered sky underflows half-float and bakes to black, so the night
case uses the Milky Way.

- **L3–L5 (integration):** ≤ 1.9% mean on every sky, identical to three.
- **L1–L2 (FIS):** on sunset, civil and nautical twilight and the Milky Way,
  every plan exceeds the absolute Q2 bars, three's included (for example,
  nautical L2 is 6.6% mean / 53% p99 for three-dev-like). A lower mip bias
  trades mean error against p99, with no setting winning everywhere, so we
  keep three's bias.

Sphere-grid proxy for Q6 (`spheres.html`), 8-bit mean / p99 / max against the
reference, each sky auto-exposed so its roughest level is mid-grey (which
amplifies differences on dark skies):

| Sky            | D2             | D3-96          | D3             | three-dev-like | FIS 64 on all levels |
| -------------- | -------------- | -------------- | -------------- | -------------- | -------------------- |
| noon           | 0.17 / 1 / 2   | –              | 0.14 / 1 / 1   | 0.14 / 1 / 1   | 1.3 / 7 / 11         |
| golden         | 0.49 / 2 / 8   | 0.43 / 2 / 6   | 0.42 / 2 / 5   | 0.41 / 1 / 4   | 2.7 / 9 / 14         |
| sunset         | 1.00 / 10 / 21 | 0.83 / 7 / 19  | 0.82 / 7 / 21  | 0.81 / 7 / 14  | 4.9 / 20 / 29        |
| civil twilight | 1.05 / 12 / 20 | 0.87 / 10 / 19 | 0.85 / 9 / 20  | 0.79 / 9 / 14  | 4.5 / 22 / 31        |
| nautical       | 2.03 / 21 / 45 | 1.82 / 19 / 42 | 1.78 / 18 / 43 | 1.66 / 16 / 33 | 8.6 / 35 / 50        |
| Milky Way      | 1.79 / 15 / 28 | –              | 1.57 / 12 / 20 | 1.59 / 12 / 16 | 10.0 / 44 / 65       |

D3 and D3-96 pass the Q6 proxy on every sky. D2 is close, missing by up to
3/255 p99 on the hardest skies. Integrating L5 over 8² ("D3-lite") visibly
raised mean error on every sky and was dropped.

### Phase 2d — fireflies, temporal stability, idle re-time

`stability.html`.

- **Q4 fireflies: pass.** Per-level max(ours) / max(reference) is
  0.983–1.015 on all six captures for D2, D3-96 and three-dev-like (bar
  1.05). The worst is L3 at golden hour and sunset (1.014–1.015), identical
  across plans, so it comes from the 16² integration source rather than the
  sampler.
- **Q5(a) sweep: pass.** Synthetic sky, sun 8° → −2° at 0.1° per frame, glow
  lobes of exponent 64 and 512. Per-texel jitter p99 is 0.08–0.13% for
  every plan, the 2048-sample plan included, which is half-float
  quantization. See §5 for why this can't fail.
- **Q5(b) tier switch: pass**, measured before the tiers were dropped.
  Sphere-grid jump from D2 to D3-96, 8-bit mean / p99 / max: noon 0.05 / 1 /
  1, golden 0.11 / 1 / 3, sunset 0.26 / 4 / 7, civil twilight 0.28 / 4 / 10,
  nautical 0.43 / 6 / 18, Milky Way 0.48 / 5 / 11. That is the same size as
  D3-96's own distance from three-dev-like.
- **Idle re-time:** Phase 0 and 2b tables above, both now min-of-bursts.

### Phase 3 (r187) — against three `dev`'s real output

`dev-compare.html` loads three `dev` from source, runs
`PMREMGenerator.fromCubemap` on each capture, and compares its texture with
ours texel by texel.

- **Handedness.** three's cube textures are x-mirrored relative to world
  space, so three builds each texel's tangent frame, and so its Hammersley
  pattern, in the mirrored frame. Ours was an equally valid but different
  sample set, which differed from three by 1–2.8% on L1/L2 on dark skies:
  that is the FIS noise floor. With `MIRROR` (a WGSL override constant) the
  sample sets are identical.
- **Parity plan, mirrored, vs three `dev`:** L0 exact; L1–L5 ≤ 0.15% mean,
  ≤ 0.7% p99 on all six skies (half-float rounding). Sphere grid ≤ 0.13/255
  mean, p99 1/255. **Same algorithm, same output.**
- **D3-96, mirrored, vs three `dev`:** L2 exact, and L1 (96 against 256
  samples) differs by up to 3.3% mean. Sphere-grid p99 is 1/255 by day but
  8–11/255 on nautical twilight and the Milky Way, failing Q6's 6/255.
- **Writer (r187):** a `copyTextureToTexture` per mip into the
  `CubeRenderTarget` that three's `PMREMGenerator` allocates. It reads back
  bit-identical (max difference 0 on all skies) and adds about 0.05 ms.
- **Where three's time goes** (min of bursts, 256): `fromCubemap` 4.55 ms,
  of which the source copy and mip generation are 0.68 ms. The levels cost
  L1 0.93, L2 1.05, L3 1.03, L4 0.57 and L5 0.57 ms. L5 costs the same as L4
  with a quarter of the texels: the integration levels are latency-bound,
  384 threads each running a serial 1,536-texel loop, which leaves the GPU
  mostly idle. The workgroup reduction removes exactly that (L5 0.57 → 0.07
  ms).
- **Tried and dropped:** a shared-memory sample table for FIS (the tangent
  directions and mip levels depend only on the sample index). It was slower,
  1.05 against 0.88 ms: the kernel is bound by texture sampling, and 16 KB
  of shared memory costs occupancy.

### Phase 4b — upstream: compute inside three's `PMREMGenerator`

The work lives in Dennis's three.js fork (`~/Developer/three.js/three.js`), on
branch `pmrem-compute` (one commit on `upstream/dev`). Its working notes,
evidence harness and PR draft are in `.notes/pmrem-compute/` there (start at
`HANDOFF.md`). Nothing is pushed yet.

- **TSL, no new public API:** 4 files, +278 / −28. The GGX levels call the
  existing `ggxConvolution()`, one thread per texel. The integration levels
  are a 64-thread workgroup reduction (`workgroupArray` +
  `workgroupBarrier`), sharing a new `ggxIntegrationTexel()` helper with the
  fragment path. Everything goes in one `renderer.compute([...])` call.
- **Writes straight into the PMREM's mips, with no extra memory.** On WebGPU,
  generator-allocated targets get `isStorageTexture` (so `STORAGE_BINDING`
  usage) and `mipmapsAutoUpdate = false`. Cube textures used as storage are
  bound as 2D arrays (+5 lines in `WGSLNodeBuilder`, +4 in
  `WebGPUBindingUtils`). User-supplied targets and WebGL 2 keep the fragment
  path.
- **Identical output:** the compute path against the fragment path of the
  same build is below 0.01% mean on every level, sky and size, with 99–100%
  of texels bit-identical, and sphere grids 0/0/1. The branch's fragment
  path is bit-identical to unmodified `dev`.
- **Speed:** `fromCubemap` 4.52 → **0.88 ms** at 256 (levels 6.0×), 6.5 →
  2.7 ms at 512, and 12.2 → 8.8 ms at 1024. At 1024 the 512² GGX level is 83% of
  the total, throughput-bound, and 15% slower in compute than as a render pass
  (7.27 vs 6.33 ms), while every other level gets faster (7.2 → 2.1 ms). The
  handoff lists what to try. Equirect 1K → 256 goes from 4.44 to 0.90 ms.
- **Open questions for maintainers:** the storage flag on a
  `CubeRenderTarget` (vs an explicit option; relates to #34629); a
  `cubeTexture()` sampled in compute throws for want of a camera (worked
  around with an explicit uv); where the face convention should live; the
  source copy + mips (0.55 of 0.88 ms) as a follow-up.

### Decision

Revised after Phase 3. **The default is the parity plan with the mirrored
frame: three `dev`'s exact algorithm, 0.88 ms plus the 0.05 ms writer.**
It is the only plan that passes Q6 against three on every sky, and it gives
a simple claim: identical output, about 5× faster. **`fast` is D3-96,
mirrored (0.57 ms)**, for weak GPUs, at the cost of Q6 on dark skies.

- P1 passes (≤ 1.0 ms), and so does P3: with the ~0.3 ms cube bake, a moving
  sun costs about 1.2 ms per frame, with the IBL current in the same frame as
  the background.
- There is a single tier, with no settle detection and no pop. Two tiers (D2
  while changing, D3-96 once settled) would save 0.14 ms per changing frame,
  which isn't worth a second pipeline set and a visible pop on dark skies.

### Phase 3b — the r185/r186 CubeUV atlas writer

`atlas-r185.html` / `atlas-r186.html` (+ `atlas.js`); full notes in
`research/pmrem-lab/ATLAS_NOTES.md`.

- **Layout** (verified by readback): `3·max(cs, 112) × 4·cs`, 11 levels for
  a 256 cube. Each tile is a 3×2 grid of faces (slot k holds face
  `[3, 1, 5, 0, 4, 2][k]`); the inner (s−2)² texels are a face's texel
  centres and the 1-texel border is the direction just past the edge.
  Packing our copy level against three's level-0 tile differs by at most 1
  half-float ulp. r185 and r186 share the layout and sampler, so one writer
  serves both.
- **Roughness per level:** three's sampler reads level k at
  `roughnessToMip⁻¹(lodMax − k)`: 0 (copy), 0.0762, 0.1078, 0.1524, 0.21,
  0.305, 0.4, 0.5333, 0.6667, 0.8, 1.0. Our levels are prefiltered at exactly
  those values, on each tile's (s−2)² grid, so packing is an exact
  texel-centre read. FIS for r ≤ 0.25 (128 samples on levels 1–2, which
  measured the same as 256, and 256 on levels 3–4); exhaustive 16²
  integration above.
- **Three doesn't match its own sampler.** `_applyGGXFilter` aims level i at
  roughness i/10 through an incremental chain, but the sampler reads it at
  the values above. Read through three's own material sampler, 8-bit sphere
  grid mean / p99 against truth:

| Sky       | ours      | three r185 | three r186 | ideal atlas (format floor) |
| --------- | --------- | ---------- | ---------- | -------------------------- |
| noon      | 0.27 / 2  | 2.04 / 11  | 2.06 / 11  | 0.21 / 2                   |
| golden    | 0.59 / 4  | 4.61 / 21  | 4.66 / 21  | 0.44 / 4                   |
| sunset    | 1.01 / 9  | 6.94 / 34  | 7.07 / 36  | 0.64 / 6                   |
| twilight  | 1.01 / 10 | 7.66 / 44  | 7.85 / 46  | 0.67 / 6                   |
| nautical  | 1.60 / 15 | 11.24 / 59 | 11.53 / 63 | 0.92 / 9                   |
| Milky Way | 1.98 / 13 | 13.01 / 47 | 13.41 / 49 | 1.04 / 6                   |

Three keeps the horizon too sharp at r 0.4–0.6 and loses the
ground-reflection falloff at r ≥ 0.8. No seam or tile-border artefacts
(face-edge pixels are no worse than the rest).

- **Q6 against three can't be met on r185/r186, by design:** ours is a
  different, more accurate filter. The bar there is "at least as close to
  truth as three", which it passes by 6.6–7.8× on mean.
- **Timing** (256, quiet): ours 1.44 ms with 256 samples, about 1.05 ms with
  128 on levels 1–2, against three r185 6.35 and r186 3.26 ms. Packing is
  0.04 ms; the copy into three's atlas adds 0.01–0.03 ms.

### Phase 4 — in the library

`src/sky/pmrem/SkyPmrem.ts` + `kernels.ts` + `cubeUV.ts`, wired into
`SkyAtmosphereBaker` as `pmrem: { generator: 'sky' | 'three', quality: 'three'
| 'fast' }` (default `'sky'`, `'three'`). Measured with `sky-pmrem-e2e.mjs` on
the real `Sky` in `16-stars-bench.html`, sun moving every frame:

| three, `pmrem.generator` | `sky.update()` mean | per-frame p50 / max (drain after every frame) | IBL vs a fresh three bake of the current cube                                            |
| ------------------------ | ------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| r187-dev, `'sky'` (cube) | **1.03 ms**         | 1.90 / **2.20 ms**                            | ≤ 0.13% per level (our box mips vs three's)                                              |
| r187-dev, `'three'`      | 0.83 ms (throttled) | 1.00 / 6.40 ms                                | 110–213% (stale)                                                                         |
| r185, `'sky'` (atlas)    | **1.09 ms**         | 1.50 / **1.60–2.00 ms**                       | level-0 tile 0.00% (fresh, same layout); filtered tiles 1.44% (the more accurate filter) |
| r185, `'three'`          | 0.24 ms (throttled) | 0.40 / 0.60 ms                                | level-0 tile 254% (stale)                                                                |

- **P3 pass** on both (mean ≤ 1.5, max ≤ 2.5 ms). **I1 pass** (same texture
  object throughout). **I3 pass**: the IBL reflects the current cube after one
  update; on r187 it equals three's bake.
- **I5 pass:** `pnpm run ci` (111 tests), `verify-looks.mjs` and
  `verify-looks-ramp.mjs`.
- **Design:** three's generator still does the first bake, which allocates
  the target in the layout the installed three samples. Our pipelines compile
  asynchronously while the scheduler keeps serving. From then on, each bake
  copies mip 0 of the sky cube into our own storage cube, builds its mips
  (r185 allocates the sky cube without any, even with `generateMipmaps`),
  prefilters, and copies the result into three's target: per mip on r187, one
  atlas copy on r185/r186. All bind groups are built once; the GPU textures
  are looked up each bake in case three recreated them.
- **Found on the way:** the library could not load on r187 at all.
  `PmremScheduler` imported `CubeUVReflectionMapping`, which r187 removed
  along with the atlas. It is now a literal (306). Every other three import
  in `src/` exists in `dev` (checked by script).
- **Tooling:** `THREE_SRC=<three checkout>` in `examples/vanilla/vite.config.ts`
  runs the demos against three from source, with its own pre-bundle cache
  (sharing one silently served the wrong three to a second server).

### Decision

Revised after Phase 3. **The default is the parity plan with the mirrored
frame: three `dev`'s exact algorithm, 0.88 ms plus the 0.05 ms writer.**
It is the only plan that passes Q6 against three on every sky, and it gives
a simple claim: identical output, about 5× faster. **`fast` is D3-96,
mirrored (0.57 ms)**, for weak GPUs, at the cost of Q6 on dark skies.

- P1 passes (≤ 1.0 ms), and so does P3: with the ~0.3 ms cube bake, a moving
  sun costs about 1.2 ms per frame, with the IBL current in the same frame as
  the background.
- There is a single tier, with no settle detection and no pop. Two tiers (D2
  while changing, D3-96 once settled) would save 0.14 ms per changing frame,
  which isn't worth a second pipeline set and a visible pop on dark skies.

### Phase 3b — the r185/r186 CubeUV atlas writer

`atlas-r185.html` / `atlas-r186.html` (+ `atlas.js`); full notes in
`research/pmrem-lab/ATLAS_NOTES.md`.

- **Layout** (verified by readback): `3·max(cs, 112) × 4·cs`, 11 levels for
  a 256 cube. Each tile is a 3×2 grid of faces (slot k holds face
  `[3, 1, 5, 0, 4, 2][k]`); the inner (s−2)² texels are a face's texel
  centres and the 1-texel border is the direction just past the edge.
  Packing our copy level against three's level-0 tile differs by at most 1
  half-float ulp. r185 and r186 share the layout and sampler, so one writer
  serves both.
- **Roughness per level:** three's sampler reads level k at
  `roughnessToMip⁻¹(lodMax − k)`: 0 (copy), 0.0762, 0.1078, 0.1524, 0.21,
  0.305, 0.4, 0.5333, 0.6667, 0.8, 1.0. Our levels are prefiltered at exactly
  those values, on each tile's (s−2)² grid, so packing is an exact
  texel-centre read. FIS for r ≤ 0.25 (128 samples on levels 1–2, which
  measured the same as 256, and 256 on levels 3–4); exhaustive 16²
  integration above.
- **Three doesn't match its own sampler.** `_applyGGXFilter` aims level i at
  roughness i/10 through an incremental chain, but the sampler reads it at
  the values above. Read through three's own material sampler, 8-bit sphere
  grid mean / p99 against truth:

| Sky       | ours      | three r185 | three r186 | ideal atlas (format floor) |
| --------- | --------- | ---------- | ---------- | -------------------------- |
| noon      | 0.27 / 2  | 2.04 / 11  | 2.06 / 11  | 0.21 / 2                   |
| golden    | 0.59 / 4  | 4.61 / 21  | 4.66 / 21  | 0.44 / 4                   |
| sunset    | 1.01 / 9  | 6.94 / 34  | 7.07 / 36  | 0.64 / 6                   |
| twilight  | 1.01 / 10 | 7.66 / 44  | 7.85 / 46  | 0.67 / 6                   |
| nautical  | 1.60 / 15 | 11.24 / 59 | 11.53 / 63 | 0.92 / 9                   |
| Milky Way | 1.98 / 13 | 13.01 / 47 | 13.41 / 49 | 1.04 / 6                   |

Three keeps the horizon too sharp at r 0.4–0.6 and loses the
ground-reflection falloff at r ≥ 0.8. No seam or tile-border artefacts
(face-edge pixels are no worse than the rest).

- **Q6 against three can't be met on r185/r186, by design:** ours is a
  different, more accurate filter. The bar there is "at least as close to
  truth as three", which it passes by 6.6–7.8× on mean.
- **Timing** (256, quiet): ours 1.44 ms with 256 samples, about 1.05 ms with
  128 on levels 1–2, against three r185 6.35 and r186 3.26 ms. Packing is
  0.04 ms; the copy into three's atlas adds 0.01–0.03 ms.

### Phase 4 — in the library

`src/sky/pmrem/SkyPmrem.ts` + `kernels.ts`, wired into `SkyAtmosphereBaker`
as `pmrem: { generator: 'sky' | 'three', quality: 'three' | 'fast' }`
(default `'sky'`, `'three'`). Measured with `sky-pmrem-e2e.mjs` on the real
`Sky` in `16-stars-bench.html`, three `dev` from source (`THREE_SRC`):

| `pmrem.generator`       | `sky.update()` mean, sun moving every frame | per-frame p50 / max (drain after every frame) | IBL vs a fresh three bake of the current cube (per level mean %) |
| ----------------------- | ------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| `'sky'`                 | **1.18 ms**                                 | 1.90 / **2.20 ms**                            | **0.00** on every level (max 0.1%)                               |
| `'three'` (+ scheduler) | 0.85 ms (bakes at most every 250 ms)        | 1.00 / 6.80 ms                                | 33–56 (stale)                                                    |

- **P3 pass** (mean ≤ 1.5, max ≤ 2.5 ms). **I1 pass** (same texture object
  throughout). **I3 pass** (identical to a flushed bake after one update).
- **I5 pass:** `pnpm run ci` (108 tests), `verify-looks.mjs` and
  `verify-looks-ramp.mjs` on r185, and `verify-looks.mjs` on three `dev`
  with the compute path live, with the same values.
- **Design:** three's generator still does the first bake, which allocates
  the target in the layout the installed three samples. Our pipelines compile
  asynchronously (`createComputePipelineAsync`) while the scheduler keeps
  serving, then every change is filtered by us: three's own cube mips as the
  source, a private storage texture, and a per-mip copy into three's target.
  GPU textures are re-fetched each bake and rebound if three recreated them.
- **Found on the way:** the library could not load on r187 at all.
  `PmremScheduler` imported `CubeUVReflectionMapping`, which r187 removed
  along with the atlas. It is now a literal (306). Every other three import
  in `src/` exists in `dev` (checked by script).

## 7. Phases

| Phase | Work                                                                                                              | Status                         |
| ----- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 0     | Baseline three r185 / r186 / r187-dev                                                                             | ✅                             |
| 1     | Timing prototype, FIS                                                                                             | ✅                             |
| 2a    | Reference + error harness, synthetic skies                                                                        | ✅                             |
| 2b    | Integration kernels (reduction + tiled), cached bind groups, round-robin timing                                   | ✅                             |
| 2c    | Real sky captures (Q2), sphere-grid proxy (Q6), two-tier decision                                                 | ✅                             |
| 2d    | Q4 fireflies, Q5 temporal sweep and tier-switch jump; re-time on an idle machine                                  | ✅                             |
| 3a    | r187: cube-mip writer, Q6 against three `dev`'s actual output                                                     | ✅                             |
| 3b    | r185/r186: atlas writer (levels at the atlas's roughness, packed with its padding)                                | ✅                             |
| 4     | `SkyPmrem` in `src/sky/pmrem/`, wired into the baker as `pmrem: { generator, quality }`; I1–I5                    | ✅                             |
| 4b    | Upstream: the compute path inside three's `PMREMGenerator` (TSL), PR draft with evidence                          | ✅ local; PR awaiting go-ahead |
| 5     | Defaults from the measurements; drop throttling on the sky path; docs; close #21 or narrow it to the upstream API |                                |

## 8. Harness

`research/pmrem-lab/` (see its README). Serve it statically and drive it with
the Playwright runner. three sources for the Phase 0 comparison are fetched
into `research/pmrem-lab/three/` and are not committed.
