# @pmndrs/sky — status & roadmap

_Last audited: 2026-07-12, branch `feat/pmndrs-monorepo`._

## Status

**Stable and publish-ready at the library level.**

| Area                                                                                           | State                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Library CI (`pnpm run ci`: build + typecheck + lint + test + format)                           | ✅ green                                                                                                                                                                                                                       |
| Published artifact (`dist/` — `.`, `./react`, `./react/auto-haze`, each `.mjs`/`.cjs`/`.d.ts`) | ✅ builds                                                                                                                                                                                                                      |
| three                                                                                          | ✅ 0.185.1 (`@types/three` 0.185)                                                                                                                                                                                              |
| Vanilla examples (21 demos incl. parity harness)                                               | ✅ vite-build verified; browser smoke test still pending                                                                                                                                                                       |
| React example                                                                                  | ⛔ blocked upstream — r3f canary imports `WebGLCubeRenderTarget` from `three/webgpu` (not exported there; fix is to use `CubeRenderTarget`). Not fixed as of `10.0.0-canary.2c50459`. One-line bump here once the alpha ships. |
| Repo                                                                                           | ⚠️ 3 commits on `feat/pmndrs-monorepo`, unpushed; remote still `DennisSmolek/SebH-TSL-Sky`                                                                                                                                     |
| npm                                                                                            | ⚠️ `@pmndrs/sky` unpublished; trusted publisher (`pmndrs/sky` → `publish.yml`) not yet registered on npmjs                                                                                                                     |
| Docs                                                                                           | ⛔ none (`README` only)                                                                                                                                                                                                        |
| Demo site                                                                                      | ⛔ none                                                                                                                                                                                                                        |

## Known defects

### D1 — Elevation color flip (P0, investigate before demo work)

Symptom (from practical usage): background and atmosphere appear to swap/flip
colorings when sun elevation changes. Suspects, in order:

1. The Y-up world / Z-up LUT frame dance (`SkyAtmosphereMesh` /
   `SkyViewLUT.setSun` synthesizing `z = sin(elevation)`) — CLAUDE.md flags this
   as the first place to look for horizon/orientation artifacts.
2. Cube bake (background) vs live sky mesh / haze disagreeing across the
   horizon crossing (`mirrorBelowHorizon`, sky-view V packing near horizon).
3. Sun-listener ordering: SkyView LUT vs AP LUT receiving different sun frames.

Repro protocol: `pnpm example` → `component-02-haze.html` (and `04-live-sky`),
sweep elevation +90° → −10° in ~10° steps via GUI, screenshot each; compare
`scene.background` (cube) against the live mesh & haze at each step; then binary
search the first bad step. Deliverable: diagnosis + fix + before/after captures.

## Workstreams

Model tiers chosen for token economy: **[H]** Haiku (mechanical), **[S]** Sonnet
(standard build), **[F]** Fable/Opus (architecture, debugging, design).

### Track 0 — Ship (this week, mostly human actions)

| #   | Task                                                                                               | Who                   |
| --- | -------------------------------------------------------------------------------------------------- | --------------------- |
| 0.1 | Create `pmndrs/sky` repo, add remote, push branch, open PR                                         | Dennis + main session |
| 0.2 | Register npm trusted publisher (`@pmndrs/sky` ← `pmndrs/sky` / `publish.yml`)                      | Dennis (npmjs)        |
| 0.3 | Browser smoke test all vanilla demos (chrome-devtools, screenshots)                                | main session          |
| 0.4 | Bump r3f in `examples/react` when the alpha with the `CubeRenderTarget` fix ships; flip its README | [H]                   |

### Track 1 — Sky correctness (P0, before demo/feature work amplifies it)

| #   | Task                                                                                                             | Who           |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------- |
| 1.1 | D1 elevation color-flip: repro, bisect, fix (see protocol above)                                                 | [F] + browser |
| 1.2 | Regression captures: scripted screenshot sweep (elevation × azimuth) checked against goldens, runnable on demand | [S] after 1.1 |

### Track 2 — Docs + site

| #   | Task                                                                                                                                                          | Who               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 2.1 | Verify current pmndrs/docs conventions (docs/*.mdx frontmatter, nav, how drei/r3f wire in) — short research memo                                              | [H] + web         |
| 2.2 | `docs/` folder: getting-started, Sky facade API, haze/aerial-perspective guide, planet-scale guide, LUT architecture (from README + CLAUDE.md + source JSDoc) | [S], scaffold [H] |
| 2.3 | GitHub Pages workflow: build `examples/vanilla` (needs vite `base` for subpath) + deploy; gallery is the landing page                                         | [H]               |
| 2.4 | README polish for pmndrs (badges, banner, links to docs/site; drop `tsl-sky-starters` links or migrate the starters)                                          | [S]               |

### Track 3 — Flagship demos

| #   | Task                                                                                                                                                                                                             | Who                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 3.1 | **Space-to-ground**: cinematic descent from orbit to surface (builds on `05-planet-scale` + `component-03`; exercises raymarch→LUT handoff, AP, exposure)                                                        | [S]                    |
| 3.2 | **Outer Wilds**: 2–3 small planets with distinct atmospheres, free-fly between them. Needs design first: multiple bakers/LUT sets, per-planet `AtmosphereParams`, proximity-based mode/LUT switching, cross-fade | design [F] → build [S] |

3.2's design doc should answer: one baker per planet vs shared baker with param
swap? When does the active planet's LUT chain rebuild? How do we blend two
atmospheres mid-flight (probably: nearest-planet wins + exposure crossfade)?

### Track 4 — Features from practical usage

| #   | Task                                | Who                          | Notes                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | **Moonlight**                       | design [F] → impl [S]        | Options: (a) fake — bump ambient + blue-shift sky post-scale; (b) semi-physical — run the existing pipeline with moon as a second "sun" (illuminance ≈ 1/400k sun, blue-tinted) and blend by sun depression angle. Hillaire's model already parameterizes sun illuminance, so (b) may be one extra SkyView bake, not new math. Decide in design doc. |
| 4.2 | **Sun disc rework**                 | [S]                          | Replace the separate `SkySun` mesh with an in-shader disc in `SkyAtmosphereMesh` (Hillaire reference renders the disc in the sky shader, tinted by transmittance → free limb darkening + horizon reddening). Keep `SkySun` as deprecated alias.                                                                                                      |
| 4.3 | **Helpers**                         | [H]                          | `SkyHelper` (three.js-helper idiom): sun direction arrow, azimuth compass rose, elevation arc, north indicator. Pure Object3D/Line work, no shader. GUI-toggleable in demos.                                                                                                                                                                         |
| 4.4 | **Gradient mode**                   | [S]                          | Stylized non-physical sky: ramp colorNode (2–4 stops + sun tint) swapped in place of the SkyView sample on the same mesh, so cube bake → PMREM → IBL pipeline still works. `new Sky(renderer, { mode: 'gradient', stops: [...] })`. No LUTs needed.                                                                                                  |
| 4.5 | **Anime / Ghibli LUTs**             | research [S] → prototype [S] | Two candidate approaches: (a) style presets — exaggerated Rayleigh, tinted Mie, boosted saturation (cheap, still physical-ish); (b) a color-grade LUT/ramp applied after the physical sky (true "Ghibli" quantized gradients, painterly clouds out of scope). Research memo picks one, prototype behind `preset: 'ghibli'`.                          |
| 4.6 | **FSR3 upscaler (pmndrs/upscaler)** | research [H] → demo [S]      | Honest assessment first: LUTs are tiny (192×108, 32³) — upscaling them is pointless. Plausible fits: (a) render main scene at half-res with haze, FSR3 to full — a joint demo; (b) low-res cube bake (128) upscaled to 256 before PMREM for cheaper bakes. Research memo decides; demo only if it earns it.                                          |

### Sequencing

```
Track 0 ──────────► publish v0.2.0
Track 1 (D1 fix) ──► before Tracks 3/4 land anything visual
Track 2 ───────────► parallel, doesn't touch src/
Track 3.1 ─────────► after 1.1
Track 3.2 design ──► parallel with 3.1; build after
Track 4.3 helpers ─► anytime (also aids D1 debugging — do early)
Track 4.x rest ────► after 1.1
```

Suggested batching to save tokens: run 2.1 + 4.6-research + 4.5-research as one
cheap parallel research wave; 4.3 helpers as the first code task (it directly
helps debugging D1 by visualizing the sun frame).
