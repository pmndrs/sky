# Stylized looks — handoff (`feat/sky-looks`)

ROADMAP track 4.4, which supersedes the old 4.4 "gradient mode" + 4.5 "Ghibli
LUTs" rows. Research: [`research/stylized-ghibli-sky.md`](research/stylized-ghibli-sky.md).

**State:** slices 1–4 written and **verified on a real WebGPU adapter**
(headless Chromium, Metal). `pnpm run ci` green. Branch `feat/sky-looks` off
`main`; first checkpoint commit `5c4cbc7`. Slice 5 not started.

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
- (next) — verification script, `window.__sky` exposure in both demos, this doc.

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
| 5 · Unreal knobs, React props, docs    | ⬜ not started                                    |

---

## 6. Slice 5 — remaining

**Tier 1** (feeds the LUT bake, so rebake — set at preset load, not scrubbed),
into `setAtmosphere` with convenience scalars alongside `setTurbidity`:
`multiScatteringFactor` (Unreal's openly non-physical MS gain), mie absorption
colour/scale, rayleigh colour, ground albedo, density distributions.

**Tier 2** (uniforms, no LUT rebake):

```js
sky.setSkyLuminanceFactor('#ffeedd') // per-channel; cubeDirty only
sky.setAerialPerspectiveDistanceScale(2) // W-coord scale at AP sample; zero dirty flags
sky.setTransmittanceMinSunElevation(-2) // the sunset-goes-black hack
```

Keep `luminanceScale` (the 40× ILLUMINANCE_IS_ONE normalization) separate from
`skyLuminanceFactor` — different jobs, merging them muddles the units story.

**React props:** `look`, `lookTrack` on `SkyProps`, mirroring the flat-prop
convention in `src/react/Sky.tsx`.

**Docs:** a looks guide under `docs/guides/`, and the haze guide needs a note
that AP inherits the look automatically.

Unreal ships tiers 1 and 2 and **no** colour remap. Both its tiers are coherent
across sky/AP/IBL for free because they never leave the physical domain. Our
look layer is the tier Unreal doesn't have, and it's the only one where haze
coherence had to be built rather than inherited.
