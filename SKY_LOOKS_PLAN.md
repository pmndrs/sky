# Stylized looks — handoff (`feat/sky-looks`)

ROADMAP track 4.4, which supersedes the old 4.4 "gradient mode" + 4.5 "Ghibli
LUTs" rows. Research: [`research/stylized-ghibli-sky.md`](research/stylized-ghibli-sky.md).

**State:** all five slices done and **verified on a real WebGPU adapter**
(headless Chromium, Metal). `pnpm run ci` green. Branch `feat/sky-looks` off
`main`. Ready for review / PR.

---

## 1. Verification — done

Verified 2026-09-04 with a headless-WebGPU Playwright script, now in the repo:

```
pnpm --filter @pmndrs/sky-example-vanilla dev      # note the port Vite prints
cd examples/vanilla && BASE=http://localhost:<port>/ node scripts/verify-looks.mjs
```

Both demos expose `window.__sky` for this. Results (960×540, pixelmatch
threshold 0.04, fraction of pixels changed):

| Check                                         | Result                          | Verdict                         |
| --------------------------------------------- | ------------------------------- | ------------------------------- |
| console errors/warnings, both demos           | 0                               | ✅                              |
| identity look (chroma 0, value 0) vs physical | 0.0003                          | ✅ identity holds in the shader |
| `setLook(null)` vs physical                   | 0.0002                          | ✅                              |
| ghibli-day chroma-only, mean luminance        | 97.8 → 98.4                     | ✅ chroma preserves luminance   |
| ghibli-day value=1, mean luminance            | 97.8 → 78.2                     | ✅ value moves it               |
| `ghibli` track at +17° vs +4.5° vs −27°       | day / dusk / night bands chosen | ✅ elevation keying             |
| haze demo, ghibli-dusk vs physical            | 0.67                            | ✅ AP retints                   |
| haze demo, cleared vs physical                | 0.0002                          | ✅                              |

Eyeballed frames (contact sheet was sent to the maintainer): dusk palette reads
warm peach; night look lifts the sky from black — the moonlight case; haze on
the mountains matches the sky with no visible silhouette fringe.

### Caveats from the run

- **Sun tint not visually confirmed.** `ghibli-dusk` with and without `sunTint`
  rendered near-identically from the demo camera — the sun sits behind/beside
  it, so `lightViewCosAngle ≤ 0` over most visible sky and the lobe weight is
  ~0. The path compiles and runs; its look needs a camera facing the sun.
- **`ghibli-day` reads flat grey-white at low camera elevation.** That is the
  memo's `#e8f3f7` horizon stop doing exactly what it says. Art-direction
  question, not a bug: a lower horizon stop (`at: -0.1`) or a more saturated
  horizon colour would bring the cerulean in sooner.
- Two process notes for whoever reads the earlier session log: an earlier
  "Vite transforms all modules" check hit port 5173, which belonged to an
  unrelated project — it proved nothing. And a frame labelled "dawn" at 06:18
  was actually a +17° sun (June, lat 37.7°) — the track correctly chose the day
  look, which is the elevation-vs-clock-time point made in the design.

## 2. Commits

- `5c4cbc7` — slices 1–4, labelled unverified at the time.
- `3dea0c2` — verification script, `window.__sky` exposure in both demos.
- (next) — slice 5: Unreal knobs, React props, looks guide, CLAUDE.md gotcha.

## 3. Design decisions — settled, don't re-litigate

- **No `mode` field.** A look is orthogonal to the atmosphere `preset`. A pure
  gradient sky is a look at `chroma 1, value 1`; Ghibli is `0.7 / 0.25`.
- **Named `look`, not `style`** — avoids the React `style` prop and the already
  taken `Sky.setPreset` (atmosphere presets: earth/mars/titan).
- **Two blend axes, not one `styleStrength`.** `chroma` swaps hue keeping
  physical luminance and is scale-invariant, which is the only reason haze can
  share it. `value` overrides luminance too, needed for artificial moonlight
  where physical night is ~0.
- **`Look.intensity`** maps the authored 0..1 ramp into post-`luminanceScale`
  scene units. Without it the `value` axis is unusable (physical night ≈ 4e-4
  vs a ~0.1 night ramp).
- **Tracks key on sun elevation, not clock time.** `setLatitude`/`setDayOfYear`
  exist, so `time: 6` is night at latitude 65° in December and mid-morning
  there in June. `by: 'time'` exists for fictional scenes.
- **Applied after the LUT/raymarch merge** in `_buildColorNode`, before
  stars/sun/moon are added — so it covers both sky paths and excludes the discs
  by construction. The cube camera renders the same mesh, so background and
  PMREM IBL inherit it free.
- **Look changes set `cubeDirty` only.** No new dirty flag was needed; the
  existing `cubeDirty → cube + PMREM` already had exactly these semantics.
- **The cube shim is NOT needed for haze coherence.** An earlier design note
  claimed it was. Sharing the uniform bundle between mesh and haze is exact;
  `skyCube` stays independent and optional.
- **`MAX_LOOK_STOPS = 8` is a hard cap both ways** — authoring more throws, and
  a track whose union of positions exceeds it throws. No decimation.

Answers to the research memo's 6 open questions: (1) preset not a third mode —
modes multiply, presets compose; (2) standalone helper, forced by (4); (3) hex
stops as uniform **defaults**, not shader literals; (4) retint haze in v1;
(5) don't clamp exposure — value compression belongs in the look, since clamping
renderer exposure fights the tonemapper and breaks bloom composition; (6) no
banding in v1 — posterized bands through cube → PMREM produce ring artifacts as
the mip chain blurs step edges, which is not merely a dithering problem.

---

## 4. What exists

| File                                                           | Role                                                                                                                                                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/looks.ts`](src/looks.ts)                                 | Pure data + math. `Look` types, `looks`/`lookTracks` registries, `registerLook`/`resolveLook`, ramp sampling + easing, elevation-keyed tracks, `packLook` (uniform contract). No TSL, no renderer. |
| [`src/backends/tsl/look.tsl.ts`](src/backends/tsl/look.tsl.ts) | `applyLook` + `evaluateLookRamp`. Pure ALU over uniforms, no texture fetches.                                                                                                                      |
| [`src/sky/LookUniforms.ts`](src/sky/LookUniforms.ts)           | Uniform bundle, mirrors `AtmosphereUniforms`.                                                                                                                                                      |
| [`tests/looks.test.ts`](tests/looks.test.ts)                   | 38 tests.                                                                                                                                                                                          |
| [`tests/lookUniforms.test.ts`](tests/lookUniforms.test.ts)     | 7 tests.                                                                                                                                                                                           |

API:

```js
sky.setLook('ghibli-day')                            // registered name
sky.setLook({ preset: 'ghibli-day', chroma: 0.4 })   // inherit + override
sky.setLook(null)                                    // back to physical
sky.setLookTrack('ghibli')                           // follows sun elevation
registerLook('mine', { stops: [...], chroma: 0.8 })
```

Built-ins: `ghibli-night` / `ghibli-dusk` / `ghibli-day` (the memo's palette
verbatim) + a `ghibli` track keyed at −18/−6/8/15°.

### Two invariants worth not breaking

**The ramp walk has no `stopCount` and no branch.** It walks all 8 segments and
accumulates, relying on padded slots being zero-width steps. It was authored as
`evaluatePackedRamp` in JS, swept against `sampleLook` across four ramp shapes,
_then_ transliterated to TSL. **Change both together** — the test is the only
thing keeping them honest.

**`updateLookUniforms` mutates the backing arrays in place.** `UniformArrayNode`
is `updateType = RENDER` and holds the reference; replacing an array instead of
mutating it silently stops uploading. There is a test asserting identity.

### The composite

```
out = mix(chromaP, chromaR, chroma) * mix(L(phys), L(ramp), value)
```

`luminance(chromaX) == 1`, so the result's luminance is exactly the blended
luminance and the axes can't fight. At `chroma 0, value 0` it's the algebraic
identity. Where physical is black it carries no chromaticity, so `chromaP` falls
back to the ramp's — that's what lets `value` light a moonlit sky instead of
scaling black.

Haze passes `valueScale: 0` (chroma only): AP inscatter is a partial-path
integral, far dimmer than the full sky integral `intensity` is calibrated
against, so pushing its luminance toward the ramp would blow out near geometry.

---

## 5. Slice status

| Slice                                  | State                                             |
| -------------------------------------- | ------------------------------------------------- |
| 1 · `src/looks.ts`                     | ✅ 38 tests                                       |
| 2 · TSL node + uniforms                | ✅ 7 tests, verified on GPU                       |
| 3 · mesh/baker/`Sky` wiring + demo GUI | ✅ verified on GPU                                |
| 3b · browser verification              | ✅ §1 — repeatable via `scripts/verify-looks.mjs` |
| 4 · haze retint                        | ✅ verified on GPU                                |
| 5 · Unreal knobs, React props, docs    | ✅ verified on GPU (see §6)                       |

---

## 6. Slice 5 — done

Shipped:

| Knob                                       | Tier               | Cost                         | Where                                                                                                                                                |
| ------------------------------------------ | ------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sky.setMultiScatteringFactor(n)`          | 1 — feeds the bake | atmos-dirty, full LUT rebake | `AtmosphereParams.multiScatteringFactor`; multiplied at the MS sample site in **both** `core/wgsl/luts.wgsl.ts` and `backends/tsl/atmosphere.tsl.ts` |
| `sky.setSkyLuminanceFactor(color)`         | 2 — uniform        | cube + PMREM                 | mesh, after `applyLook`; haze applies the same uniform after its retint                                                                              |
| `sky.setAerialPerspectiveDistanceScale(n)` | 2 — uniform        | nothing dirty                | scales `distKm` in `HazePostProcess` before slice lookup                                                                                             |

React: `look`, `lookTrack`, `skyLuminanceFactor`, `apDistanceScale`,
`multiScatteringFactor` props on `<Sky>`; matching setters on `SkyContext`.
Docs: `docs/guides/looks.mdx` (new), section appended to `docs/guides/haze.mdx`.

**Dropped: `transmittanceMinSunElevation`.** Unreal's
`TransmittanceMinLightElevationAngle` clamps the sun _light's_ transmittance
colour. `SkySun` here is a plain `DirectionalLight` with a fixed colour — it
never samples the transmittance LUT — so there is nothing to clamp. Belongs
with a future "sun colour from atmosphere" feature (adjacent to ROADMAP 4.1),
not here.

**Bug found by the verify script:** `multiScatteringFactor` first shipped
TSL-only and had zero visible effect (diff 0.0003). The LUTs are built by the
WGSL backend; the TSL twin only runs in the raymarch fallbacks. Now recorded
as a CLAUDE.md gotcha. Both twins carry the multiply.

## 7. Next

- Open a PR from `feat/sky-looks`.
- Art-direction pass on `ghibli-day`'s near-white horizon (see §1 caveats).
- Sun-tint lobe: confirm visually from a sun-facing camera.
- Optional: extend `verify-looks.mjs` to the planet-scale demo so the
  above-`topRadius` raymarch branch is exercised with a look assigned.
