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
| Repo                                                                                           | ✅ live at `pmndrs/sky` — full history pushed 2026-08-10, origin re-pointed, CI green on Actions                                                                                                                               |
| npm                                                                                            | ⚠️ `@pmndrs/sky` unpublished; trusted publisher (`pmndrs/sky` → `publish.yml`) not yet registered on npmjs                                                                                                                     |
| Docs                                                                                           | ✅ live at https://pmndrs.github.io/sky/ — docs.yml verified on real Actions 2026-08-10 (two fixes: pmndrs/docs v3 has no `<Note>`/`<Warning>` MDX components; chown root-owned docker output)                                 |
| Demo site                                                                                      | ✅ live at https://pmndrs.github.io/sky/examples/ (22 demos incl. component-04-city)                                                                                                                                           |

## Known defects

### D1 — Camera-altitude/pitch sky flip (**FIXED — verified in browser 2026-07-12**)

**Root cause found (2026-07-12):** `SkyAtmosphereBaker.setSun` locked the
SkyView LUT's baked sun zenith to the flat-world frame (`z = sin(elevation)`
vs +Y), while `setCamera` (planet mode) gives the mesh a **radial** up for its
sample scalars. The LUT's 2-angle parameterization requires baked-sun-zenith ==
`dot(sunWorld, localUp)`; orbiting the planet changes local up, nobody updated
the LUT → mirrored/rotated atmosphere tracking camera movement. All other
paths (AP LUT, haze raymarch, space fallback) are fully-3D and were already
frame-consistent.

**Fix:** `_syncSkyViewSunFrame()` derives the LUT sun from
`sunVec · cameraUp`, called from both `setSun` and `setCamera`; cube re-bakes
when the effective zenith drifts. Flat mode is bit-identical to the old math
(`sunVec · +Y = sin(elevation)`) — zero regression risk for ground scenes.

Original investigation notes:

Corrected symptom (repro'd in `05-planet-scale`, cameraAltitude ≈ 44 km,
sunElevation 8°): the above-horizon sky is correct, but the **below-horizon
half renders as an inverted/mirrored atmosphere gradient instead of ground**,
and — the key clue — **what renders depends on camera pitch**: raising camera
elevation "reveals the ground", pitching back down brings the atmosphere back.

A frame-invariant Sky-View LUT sample depends only on world view direction and
view height — camera pitch must not change the result for a fixed world
direction. Pitch-dependence implicates the per-pixel view-direction
reconstruction / LUT-V mapping in `SkyAtmosphereMesh` (and/or its
`intersectsGround` branch selection at altitude), not the LUT contents.
Suspects, in order:

1. `SkyAtmosphereMesh._buildColorNode`'s `viewZenithCosAngle` /
   `intersectsGround` computation using the wrong "up" (flat world +Y vs
   planet-radial) or a screen-space-influenced direction at altitude.
2. The horizon-packed V parameterization's ground half (mirrored V) sign flip
   when `viewHeight` ≫ ground — samples sky half mirrored instead of ground.
3. Cube bake vs live mesh disagreement across the same crossing
   (`mirrorBelowHorizon` interplay).

Repro protocol: `pnpm example` → `05-planet-scale.html`, set altitude ~44 km,
fix sun at 8°; screenshot; pitch camera up/down and confirm below-horizon
content changes; then repeat at 2 km / 10 km / 80 km to find onset altitude.
Deliverable: diagnosis + fix + before/after captures.

### D2 — `component-03-planet` camera-altitude feedback instability (**FIXED — verified 2026-07-12**)

Root cause: two owners of `state.cameraAltitude`, made unfixable-by-flag by
the three.js Inspector's `listen()` semantics — it polls the bound property
per rAF and re-dispatches `onChange` **one rAF later** on external change, so
a synchronous guard around the loop's mirror write can't stop the echo. Real
fix (`7675411`): break the loop **by value** — `onChange` only records a
pending request (ignoring echoes of values we mirrored ourselves), the animate
loop is the single writer (no transitions), and the mirror only republishes on
meaningful change. Applied to `05` and `component-03`.

### D3 — Planet-scale demo controls are wrong idiom (**DONE — `PlanetFlightControls`, verified 2026-07-12**)

Implemented in `3b46477`: `src/demo/planetFlightControls.ts` — first-person
look-around (yaw/pitch about the camera-local radial up, roll-free), wheel is
the only movement (radial altitude, exponential ~8%/tick), no orbit target.
Wired into `05` and `component-03`; maintainer verdict: "controls feel much
better". Note: `06-planet-scale-debug` still uses camera-controls — port it
when next touched. The class is demo-infrastructure (`@sky/demo/...`), a
candidate for promotion to the public API if users want it.

### D4 — Concentric "wave" bands in AP haze at 50–100 km altitude (OPEN, deferred)

From ~50–100 km camera altitude, smooth concentric arcs (iso-distance contours
around the nadir) appear in the haze over the planet surface. Clean at ground
level; clean above `blendEndKm` (pure raymarch). Known facts from bisection:

- Bands live in the **AP-LUT branch**: `hazeMode=raymarch` is clean, and
  `blendEndKm` (which scales the AP↔raymarch mix) directly modulates band
  visibility. `?hires=1` (TLUT/MS resolution) has **no effect**.
- **Tried and reverted** (`4827ff0`, reverted in `97e3003`): ±half-texel
  per-pixel dither on the sample `w` + LUT build at 64 samples with per-voxel
  jitter (mirroring the validated raymarch). Result: bands persisted AND the
  haze went visibly noisy — worse overall. The failure is informative: if a
  half-slice W dither doesn't break up the bands, the W-interpolation-kink
  hypothesis is wrong or incomplete. Next suspects: the 32×32 **screen-space
  XY** interpolation (froxel rays diverge strongly at altitude, and the
  underground-froxel correction rewrites ray dir/tMax per voxel → neighbouring
  XY texels store integrals of genuinely different rays); or banding baked
  into the stored values by the correction itself. A `?debug=ap-alpha`
  screenshot at a banding altitude, compared against `?debug=rm-alpha`, would
  discriminate content-vs-addressing before any next fix attempt.
- SebH's reference never exhibits this because its AP coverage is 128 km
  (8 km far-slice spacing) vs our 1024 km in demo 05; his build also scales
  samples per slice (`2*(sliceId+1)`, RenderSkyRayMarching.hlsl:707).
- Workaround available today: at high altitude use `hazeMode=raymarch` (or
  lower `blendEndKm` so the auto ramp hands off earlier).

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

| #   | Task                                                                                    | Who                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | **Moonlight**                                                                           | design [F] → impl [S]        | Options: (a) fake — bump ambient + blue-shift sky post-scale; (b) semi-physical — run the existing pipeline with moon as a second "sun" (illuminance ≈ 1/400k sun, blue-tinted) and blend by sun depression angle. Hillaire's model already parameterizes sun illuminance, so (b) may be one extra SkyView bake, not new math. Decide in design doc.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 4.2 | **Sun disc rework** (**DONE — verified via `pnpm run ci` + vanilla build, 2026-07-12**) | [S]                          | Inventory correction: there was no separate `SkySun` _mesh_ to replace — `SkySun` (`src/sky/SkySun.ts`) only owns a `THREE.DirectionalLight`; the sun disc was already rendered in-shader in `SkyAtmosphereMesh._buildColorNode`, just as a flat-white hard-edged circle with no transmittance tint or ground occlusion (a leftover Preetham-era `SkyMesh` in `sky/legacy/` has its own disc too, but it's dead code — not exported, not imported by any demo). Implemented: transmittance-to-space tint (reuses the same TLUT sample now shared with the stars fade → free limb reddening), ground-intersection occlusion (`skyMask`, shared with stars), a real soft rim via `sunDiscCos`/`sunDiscCosInner` cos-space bounds set through `setSunAngularRadius(halfAngleRad, edgeSoftness)`, and a renamed/documented `sunDiscIntensity` uniform with the exposure-math derivation in its JSDoc. `Sky.setSunDisc({ angularDiameter, edgeSoftness })` wires through. No deprecation needed — nothing public pointed at a disc-mesh API. |
| 4.3 | **Helpers**                                                                             | [H]                          | `SkyHelper` (three.js-helper idiom): sun direction arrow, azimuth compass rose, elevation arc, north indicator. Pure Object3D/Line work, no shader. GUI-toggleable in demos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4.4 | **Gradient mode**                                                                       | [S]                          | Stylized non-physical sky: ramp colorNode (2–4 stops + sun tint) swapped in place of the SkyView sample on the same mesh, so cube bake → PMREM → IBL pipeline still works. `new Sky(renderer, { mode: 'gradient', stops: [...] })`. No LUTs needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 4.5 | **Anime / Ghibli LUTs**                                                                 | research [S] → prototype [S] | Two candidate approaches: (a) style presets — exaggerated Rayleigh, tinted Mie, boosted saturation (cheap, still physical-ish); (b) a color-grade LUT/ramp applied after the physical sky (true "Ghibli" quantized gradients, painterly clouds out of scope). Research memo picks one, prototype behind `preset: 'ghibli'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4.6 | **FSR3 upscaler (pmndrs/upscaler)**                                                     | research [H] → demo [S]      | Honest assessment first: LUTs are tiny (192×108, 32³) — upscaling them is pointless. Plausible fits: (a) render main scene at half-res with haze, FSR3 to full — a joint demo; (b) low-res cube bake (128) upscaled to 256 before PMREM for cheaper bakes. Research memo decides; demo only if it earns it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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

## Status log

**2026-07-12 — agent wave 1 complete:**

- ✅ 2.1 pmndrs docs conventions researched → `research/pmndrs-docs-conventions.md`
  (key finding: docs workflow + examples deploy both target the ONE Pages site —
  merge into a single artifact before wiring docs; see memo)
- ✅ 2.3 Pages deploy implemented → `.github/workflows/deploy-pages.yml`
  (base path derived from repo name; verified `/sky/` + default builds)
- ✅ 4.3 `SkyHelper` implemented (compass ring, north tick, sun arrow,
  elevation arc; exported from `@pmndrs/sky`; toggle in component-02) —
  pending visual check
- ✅ 4.5 research → `research/stylized-ghibli-sky.md` (v1: in-mesh post-LUT
  color remap + light param preset, `preset: 'ghibli'` + `styleStrength`;
  6 open questions for maintainer)
- ✅ 4.6 research → `research/upscaler-integration.md` (verdict: half-res+FSR3
  joint demo only; cube-bake upscaling is a no-fit; zero library changes)
- ⏳ D1/D2 browser verification: in progress — blocked on the automation
  window being visible (Chrome throttles rAF when hidden)

**2026-07-12 (evening) — interactive verification + fix wave 2 complete:**

- ✅ D1 verified fixed in browser (maintainer): sky coherent at altitude, sun
  sets/rises as the camera moves over the planet
- ✅ D2 re-fixed properly (`7675411` — Inspector `listen()` echoes onChange
  async; broke the loop by value) and verified
- ✅ D3 done (`3b46477` — `PlanetFlightControls`), verified: "controls feel
  much better"
- ✅ component-02-haze rescaled (`c61cb8a`): haze was invisible because the
  scene was sub-km; now 1.5–50 km geometry — verified "looks better"
- ✅ **AP LUT Y-flip fixed** (`a069e61`): LUT build filled rows bottom-up while
  the post-process samples v-down → froxel field mirrored about screen
  centre; caused pitch-tracking under-haze at altitude. Found via the
  maintainer's ap/raymarch A/B; gotcha recorded in CLAUDE.md
- ⛔ D4 opened (AP wave banding 50–100 km): dither+jitter attempt failed
  (reverted `97e3003`), deferred with full bisection notes — see D4 above
- ✅ 4.3 SkyHelper verified visible in the rescaled component-02
- ⏳ 0.3 partial: 05 / component-02 / component-03 interactively verified by
  the maintainer; full scripted sweep (1.2) still open

**2026-07-12 (later) — 2.2/2.4 docs + Pages-merge complete:**

- ✅ 2.2 `docs/` folder scaffolded (`getting-started/{introduction,installation,your-first-sky}`,
  `api/{sky,baker,luts}`, `guides/{haze,planet-scale,tuning-atmosphere}`) —
  every code sample sourced from current `src/*.ts` + `examples/vanilla/*.html`,
  not invented. Fixed a stale `peerDependencies.three` (`>=0.184.0` →
  `>=0.185.0`) found while writing installation.mdx — the devDependency was
  bumped in `abe1207` but the peer range was missed.
- ✅ 2.4 README rewritten for the pmndrs launch (badges, pitch, quick start,
  docs/gallery links, contributor section); dropped the `tsl-sky-starters`
  personal-repo section per the "remove stale personal-repo references"
  instruction.
- ✅ 2.3 **superseded** — `.github/workflows/deploy-pages.yml` deleted,
  replaced by `.github/workflows/docs.yml`: builds the pmndrs/docs site AND
  `examples/vanilla`, merges the examples build into the docs output under
  `/examples/`, uploads one Pages artifact. Could not use
  `uses: pmndrs/docs/.github/workflows/build.yml@v3` as documented in the
  research memo — inspecting that workflow directly showed its single job
  ends with its own `upload-pages-artifact` call inside an isolated
  Docker-build job, so there's no seam to inject the examples merge.
  Fallback: inline the same docker invocation as a step in our own job
  instead of calling the reusable workflow — see the long comment at the
  top of `docs.yml` for the full limitation writeup. Linted clean with
  `actionlint`; **not executed on GitHub Actions** — unverified beyond
  static analysis.

**2026-08-10 — pmndrs launch push + haze perf wave:**

- ✅ 0.1 done differently than planned: `pmndrs/sky` was a README stub, full
  history force-pushed over it (push needed `http.postBuffer` bump — HTTP 400
  on chunked transfer), origin re-pointed. CI green on first Actions run.
- ✅ 2.3-verify: docs.yml green on run 3 (fix 1: `<Note>`/`<Warning>` →
  blockquotes, memo corrected; fix 2: chown docker-owned `docs/out`). Site +
  examples gallery verified serving.
- ✅ Haze perf: sky-pixel raymarch gate + SkyView rebuild gating (`01cfac1`),
  `raymarchFallback`/`raymarchSampleCount` options, React `<Sky>` now drives
  the per-frame AP update (`a100229`). SebH parity audit:
  `research/sebh-parity-audit.md` — verdict: no quality drift, headroom is
  scaling counts down. Follow-ups filed as pmndrs/sky issues #1–5.
- ✅ component-04-city: vanilla Paris-rotation demo (haze A/B bench + FPS).
- ⏳ Still open before v0.2.0: react example r3f-alpha.3 bump (0.4), browser
  verification of `01cfac1` + component-04 (0.3/1.2), npm trusted publisher
  (0.2), then tag.
