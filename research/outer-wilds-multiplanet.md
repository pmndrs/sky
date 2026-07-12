# Outer Wilds multi-planet demo — design memo (research, 2026-07-12)

_Agent-researched; feeds ROADMAP Track 3.2 (design [F] → build [S])._

Goal: 2–3 small planets with visibly distinct atmospheres (thin blue
Earth-like, thick orange Titan-like, near-airless), free-fly between them,
nearest-planet gravity. This memo decides architecture; a Sonnet agent builds.

## Decision 1 — one shared baker with `AtmosphereParams` swap. Not N bakers.

### Cost of a full LUT-chain rebuild (the swap price)

All targets RGBA16F (8 B/px). Work in texel×step units, calibrated against the
AP LUT's documented "~1 ms on mid GPU" for ~1M texel-steps
(`SkyAtmosphereBaker.ts:516-518`):

| Stage          | Size               | Memory  | Rebuild work        | Trigger flag       |
| -------------- | ------------------ | ------- | ------------------- | ------------------ |
| Transmittance  | 256×64 × 40 steps  | 128 KB  | 0.66M               | `atmosDirty`       |
| MultiScatter   | 32×32 × 64dir×20   | 8 KB    | 1.31M               | `atmosDirty`       |
| SkyView        | 192×108 × 30 steps | 162 KB  | 0.62M               | `atmos/sun/camera` |
| Cube bake      | 256²×6 (1 LUT tap) | ~4.2 MB | 0.39M + mips        | `atmos/sun/cube`   |
| PMREM          | cubeUV mip atlas   | ~5–6 MB | ~1M (blur chain)    | with cube          |
| AP (per-frame) | 32³                | 256 KB  | ~1M **every frame** | n/a                |

Full chain ≈ 4M texel-steps ≈ **2–4 ms GPU, once per swap**. Decisive context:
the dirty cascade (`SkyAtmosphereBaker.ts:461-513`) already re-runs
SkyView + cube + PMREM _essentially every frame_ while flying in planet mode —
`setCamera` sets `cubeDirty` whenever the camera-local sun zenith drifts >1e-3
(`SkyAtmosphereBaker.ts:305-309`). A planet swap only adds TLUT+MS (~2M) on top
of a steady-state we already pay. The swap is a non-event.

### Why N resident bakers loses anyway

- **Memory**: ~10–11 MB/baker, dominated by cube+PMREM (the LUTs are only
  ~300 KB). 3 bakers ≈ 33 MB for textures of which only one set can feed the
  scene at a time. Affordable but pure waste.
- **The killer**: switching planets would swap `scene.environment` /
  `scene.background` between different texture identities. The baker goes out
  of its way to keep PMREM output identity stable precisely because a new
  environment texture **invalidates the TSL pipeline cache for every material
  in the scene and stalls the next render badly**
  (`SkyAtmosphereBaker.ts:497-506`, Changelog 0.1.3). One shared baker keeps
  one cube RT + one PMREM target forever; params swap under stable identities.
  N bakers re-trigger that stall on every planet handoff.
- N× NodeMaterial pipeline compiles at startup (each baker owns its own LUT +
  mesh materials).
- Per-planet `bottomRadius`/`topRadius` live _inside_ `AtmosphereParams`
  (`AtmosphereParams.ts:9-10`), so planet size swaps with the same call —
  nothing about the baker assumes a fixed radius between bakes.

Verdict: **one `Sky`/baker; planet switch = `setAtmosphereParams(planet.params)`

- new `planetCenter` in `update()`.** Everything needed already exists in
  `setCamera(camera, { planetCenter })` (`SkyAtmosphereBaker.ts:272-316`) — the
  frame-invariant-scalar design (camera-local up, D1 fix) means per-planet sun
  elevation emerges automatically.

## Decision 2 — switch on normalized nearest distance, 20% hysteresis, only in space

Influence metric: `d_i / topRadius_i` (distance to center over atmosphere
radius — scale-invariant, so a small thick-atmosphere planet competes fairly).
Policy:

- Switch active planet when `d_new/R_new < 0.8 × d_active/R_active`
  (20% hysteresis kills midpoint thrash; evaluate once per frame, cheap).
- **Never switch while inside an atmosphere**: require
  `viewHeight > topRadius_active` (camera in the mesh's raymarch-fallback
  space branch). The demo layout must guarantee this is always satisfiable:
  inter-planet spacing > ~2.5× max `topRadius`.

This is the design's core insight: **the handoff happens in vacuum, where both
atmospheres render as black-plus-stars, so a hard param swap is visually
invisible.** Climbing out of A physically fades A's sky (real integration →
zero density); the swap occurs in space; descending into B physically fades
B's sky in. No crossfade machinery needed for correctness.

## Decision 3 — mid-flight blending: nearest-planet-wins, no dual meshes

- **Rejected: two `SkyAtmosphereMesh`es with opacity blend.** They _can_
  coexist technically (each samples its own SkyView LUT via its own material),
  but: only one PMREM can be `scene.environment`; alpha-blending two HDR
  full-sky integrals is not physical (double horizon, two sun discs, luminance
  sums wrong); and it forces the N-baker architecture rejected above.
- **Accepted: nearest-planet-wins for sky mesh + IBL + background**, with the
  physical altitude fade doing the "crossfade" for free (Decision 2). If a
  future scenario ever needs overlapping atmospheres, the right tool is
  lerping `AtmosphereParams` themselves across the transition (the LUT chain
  is continuous in its params; `mergeAtmosphereParams` makes this trivial) —
  explicitly out of scope for the demo.
- **Haze/AP between planets: no special casing.** The AP LUT is per-frame and
  camera-relative; fed the active planet's `planetCenter`
  (`AerialPerspectiveLUT.ts:197-203`), its froxels integrate near-zero density
  above `topRadius` → haze alpha self-fades physically. Keep haze wired to the
  active planet only. One knob to note: `apKmPerSlice` is constructor-fixed
  (`SkyAtmosphereBaker.ts:117`); pick one coverage value for all planets in v1
  (a setter is a trivial follow-up if planet scales diverge wildly).

## Decision 4 — frames: what generalizes, what changes

Already generalized (no code change): `setCamera({planetCenter})` per-call —
passing a different center each frame works today; SkyView sun-frame sync,
cube re-bake on up-drift, AP camera-relative positions are all planet-relative
already. One sun (directional, at infinity) serves all planets — no change.

Minimal **library** additions (all on the `Sky` facade, none in the baker):

```ts
interface PlanetDef {
  name: string
  center: Vector3                    // world-space, metres
  atmosphere: AtmosphereParamsInput  // includes bottomRadius/topRadius (km)
}
sky.setActivePlanet(planet: PlanetDef): this
// → baker.setAtmosphereParams(planet.atmosphere) + stores center
sky.activePlanet: PlanetDef | null   // getter, for GUI/debug
// sky.update(camera) uses the stored center when opts.planetCenter is omitted
// (Sky.ts:316-330 — one-line change in the opts plumbing)
```

Demo-level (in `src/demo/`, NOT library): nearest-planet selection with
hysteresis; a new `SystemFlightControls` — `PlanetFlightControls`
(`src/demo/planetFlightControls.ts`) is radial-only (wheel = altitude, v1
explicitly has no lateral movement, :41-44) and pins `planetCenter` at
construction (:49-50). The new controls need pointer-look + WASD thrust with
`camera.up` slerped toward the nearest planet's radial up as altitude drops
below ~1.5× `topRadius` (free orientation in space, gravity-up near ground).

Demo tuning note for small planets: optical depth ∝ coefficient × path
length, so a planet 50× smaller than Earth needs scattering/extinction
coefficients ~50× larger (and scale heights ÷50) to read as "an atmosphere."
Start from `presets.ts` (earth/mars/titan exist) and rescale. Keep
`bottomRadius ≥ ~60 km` until precision at small radii is verified
(`PLANET_RADIUS_OFFSET` is 0.01 km).

## Staged build plan (Sonnet-sized)

| Stage | Deliverable                                                                                                                                                         | Acceptance                                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Library: `setActivePlanet` + stored-center `update()` (≤40 LOC in `Sky.ts`)                                                                                         | Existing demos unchanged (screenshot parity on 05 + component-03); new unit of API documented in JSDoc                                                                                          |
| 1     | Demo scaffold: 3 planets (spheres, distinct materials/params from rescaled presets), one `Sky`, GUI dropdown for active planet, existing-style camera               | Standing on each planet (GUI-switched): correct horizon, sun sets flying around planet, distinct sky colours in screenshots                                                                     |
| 2     | Auto-switch: normalized-distance nearest + 0.8 hysteresis, space-only switching                                                                                     | Fly A→B: no visible pop at handoff (screenshot pair ±1 frame around switch); switch log shows exactly one switch crossing the midpoint back-and-forth; no frame >10 ms attributable to the swap |
| 3     | `SystemFlightControls`: look + thrust + up-alignment blend                                                                                                          | Takeoff from A, cruise, land on B without camera roll glitches; up realigns smoothly below 1.5× topRadius                                                                                       |
| 4     | Polish: haze on active planet verified in-flight, exposure GUI, optional distant-planet limb-glow (fresnel shell billboard — demo hack, not library), gallery entry | Full A→B→C tour screenshot set; haze fades to zero in space (`?debug=ap-alpha` black between planets)                                                                                           |

## Open questions for maintainer

1. Distant-planet atmosphere limbs (seeing B's halo from A) are out of scope
   for the library — is the stage-4 fresnel-shell hack wanted in the demo, or
   ship without any distant halo?
2. Planet scale taste: true Outer Wilds toy scale (~hundreds of metres, needs
   aggressive param rescale + precision risk) vs "small moon" scale
   (60–300 km, safe)? Memo assumes small-moon.
3. Should `setActivePlanet` debounce/amortize the rebuild over 2 frames (LUTs
   then cube+PMREM), or is a single 2–4 ms frame acceptable? Memo assumes
   single-frame.
