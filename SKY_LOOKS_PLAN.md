# Stylized looks — handoff (`feat/sky-looks`)

ROADMAP track 4.4, which supersedes the old 4.4 "gradient mode" + 4.5 "Ghibli
LUTs" rows. Research: [`research/stylized-ghibli-sky.md`](research/stylized-ghibli-sky.md).

**State:** slices 1–4 written, `pnpm run ci` green, **zero shader code verified
on a GPU**. Branch is `feat/sky-looks` off `main` (`c31d74a`), everything
uncommitted.

---

## 1. Start here — the verification gate

Slices 2, 3 and 4 are all shader code. None of it has compiled. The session that
wrote it had no `chrome-devtools-mcp` and the repo has no playwright, so the
CLAUDE.md browser loop could not be run. `pnpm run ci` passing means it builds
and typechecks — nothing more.

```
pnpm --filter @pmndrs/sky-example-vanilla dev
# http://localhost:5173/component-01-baked.html → "Look" GUI folder
```

| #   | Check                                                       | What it proves                                                             |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | Console clean on load (ignore the benign `<!DOCTYPE` error) | WGSL compiles at all                                                       |
| 2   | `look: physical` is **pixel-identical to before**           | the `chroma 0, value 0` identity holds in the shader, not just the algebra |
| 3   | `ghibli-day`, drag `chroma`                                 | hue shifts, brightness roughly holds                                       |
| 4   | same, drag `value` / `intensity`                            | brightness moves                                                           |
| 5   | `ghibli (track)`, scrub `timeOfDay` through dawn            | cross-fade around −6°..15° elevation                                       |
| 6   | mirror sphere + ground pick up the look                     | cube → PMREM → IBL path works                                              |
| 7   | `component-02-haze.html`                                    | haze hue follows the sky, no silhouette fringe                             |

Check 2 is the important one. If it fails, `applyLook` is not an identity at
zero and everything downstream is suspect.

Likely failure modes, in order: `.element(i)` index typing inside the TSL
`Loop`; `luminance()` overload resolution; `uniformArray` element type
inference (positions are `float`, colors `vec3`, eases `vec2`).

---

## 2. Uncommitted

16 files, nothing committed. `git status` is the inventory. Committing before
further work is recommended — a fresh session doing `git diff` gets nothing
useful right now.

New: `src/looks.ts`, `src/backends/tsl/look.tsl.ts`, `src/sky/LookUniforms.ts`,
`tests/looks.test.ts`, `tests/lookUniforms.test.ts`, this file.

Modified: `src/Sky.ts`, `src/applyHaze.ts`, `src/index.ts`,
`src/backends/tsl/atmosphere.tsl.ts`, `src/sky/HazePostProcess.ts`,
`src/sky/SkyAtmosphereBaker.ts`, `src/sky/SkyAtmosphereMesh.ts`,
`types/three-tsl.d.ts`, `ROADMAP.md`,
`examples/vanilla/component-01-baked.html`.

---

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

| Slice                                  | State                              |
| -------------------------------------- | ---------------------------------- |
| 1 · `src/looks.ts`                     | ✅ 38 tests                        |
| 2 · TSL node + uniforms                | ✅ 7 tests — **unverified on GPU** |
| 3 · mesh/baker/`Sky` wiring + demo GUI | ✅ — **unverified on GPU**         |
| 3b · browser verification              | ⛔ **the gate** (§1)               |
| 4 · haze retint                        | ✅ — **unverified on GPU**         |
| 5 · Unreal knobs, React props, docs    | ⬜ not started                     |

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
