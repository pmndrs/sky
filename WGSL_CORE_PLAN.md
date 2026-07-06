# WGSL core — architecture & migration plan

Design doc for splitting the atmosphere math out of TSL into an
engine-agnostic WGSL core, while keeping the TSL path alive as the WebGL
fallback. Companion to `PLAN.md` (the physics source of truth) and
`CLAUDE.md` (the trap log).

## Goal in one paragraph

Author Hillaire's math **once in WGSL**, as engine-agnostic source. Feed it
into three.js on the WebGPU backend via `wgslFn`, and — eventually — into a
non-three baker that owns a bare `GPUDevice`. Keep the existing TSL `Fn`
math as the **WebGL fallback** and a synced reference. The WGSL core becomes
the source of truth on WebGPU; the TSL twin is the safety net we hand-sync.

This is a **hybrid-hybrid**: two shader authorings (WGSL + TSL), one physics
spec, three consumers (three-WebGPU via `wgslFn`, three-WebGL via TSL,
future native-WebGPU via raw pipelines).

## Why (recap of the friction)

Almost every entry in `CLAUDE.md`'s trap log is TSL/three friction, not
physics: the `.toVar()`-in-a-JS-loop shader bomb, forcing `.level(0)`,
PMREM API divergence between backends, HMR shader-cache staleness. Authoring
the math in WGSL:

- **Deletes the unroll bomb.** A real WGSL `for` loop with real local
  variables can't blow up the way a JS-unrolled `.toVar()` graph does.
- **Reads 1:1 against SebH's HLSL** — verification becomes transliteration
  diffing, not "did TSL transpile this the way I meant."
- **Emits plain `GPUTexture`s** any WebGPU consumer can read.

The cost we're accepting (explicitly): the math exists twice, and WebGPU-only
features won't reach the WebGL path. The TSL twin is "best-effort in sync."

## Target layout

Extract the agnostic pieces UP and OUT of `src/sky/`; leave `src/sky/` as the
three.js integration layer. Minimal renames — public exports (`.` and
`./react`) are unchanged, so nothing external breaks.

```
src/
├── core/                         # ZERO three imports. Portable.
│   ├── atmosphereParams.ts       # ← moved from sky/AtmosphereParams.ts (plain data)
│   ├── resolutions.ts            # ← moved from sky/luts/resolutions.ts
│   └── wgsl/
│       ├── atmosphere.wgsl.ts    # THE math, as WGSL source chunks + params struct
│       └── index.ts              # assembled-chunk exports (for composition)
│
├── backends/
│   ├── tsl/
│   │   └── atmosphere.tsl.ts     # ← moved from sky/shaders/atmosphere.tsl.ts
│   │                             #   WebGL fallback + hand-sync reference. STAYS TSL.
│   └── wgsl/
│       └── atmosphere.ts         # wgslFn wrappers over core/wgsl → TSL-callable nodes
│                                 #   (WebGPU-via-three path)
│
├── sky/                          # the three.js integration layer (mostly unchanged)
│   ├── RenderContext.ts          # NEW seam: { renderer, device, queue }
│   ├── SkyAtmosphereBaker.ts     # picks backend; owns PMREM/cube (three-only bits)
│   ├── SkyAtmosphereMesh.ts
│   ├── luts/                     # runners gain a backend switch (see below)
│   │   ├── TransmittanceLUT.ts
│   │   ├── MultiScatterLUT.ts
│   │   ├── SkyViewLUT.ts
│   │   └── AerialPerspectiveLUT.ts
│   └── … (Haze, Ground, Moon, Night, GroundedSkybox)
│
├── react/                        # unchanged — sits on sky/
├── demo/                         # unchanged
└── index.ts / react entry        # unchanged public surface
```

## The two seams that make this work

### Seam 1 — backend selection (shader authoring)

The LUT runners today hard-import `../shaders/atmosphere.tsl`. Change them to
receive their math functions from a **backend module** chosen once, by the
baker, from `renderer.backend`:

```ts
// sky/RenderContext.ts
export function pickAtmosphereBackend(renderer) {
  const isWebGPU = renderer.backend?.isWebGPUBackend === true
  return isWebGPU ? wgslBackend : tslBackend // same-shaped exports
}
```

Both backend modules expose the **same named functions** with node-compatible
I/O (`raySphereIntersectNearest`, `computeScatteringAbsorption`,
`uvToTransmittanceLutParams`, …). The LUT's `_buildColorNode()` calls
`backend.computeScatteringAbsorption(height, params)` and doesn't care which
authoring produced it.

**Honest caveat:** the swap is _not_ perfectly 1:1 for multi-return helpers.
TSL `computeScatteringAbsorption` returns a JS object of nodes; the WGSL twin
returns a WGSL `struct` you read as `.scattering`. Field access lines up, but
the WGSL wrappers must declare structs and the leaf entry points must take
textures/samplers as explicit params. The **pure algebraic helpers** (phases,
ray-sphere, density, UV param maps) port cleanly and are the first wins; the
**`integrateScatteredLuminance` integrator** (texture sampling + loop inside)
is the hard one and lands last.

### Seam 2 — device-first render context (pipeline ownership)

Today the baker takes a three `renderer`. Introduce a `RenderContext` that
today is derived from it but tomorrow can be constructed from a bare device:

```ts
// today (three-hosted)
const ctx = RenderContext.fromRenderer(renderer)
//   → { renderer, device: renderer.backend.device, queue: … }

// eventually (native)
const ctx = RenderContext.fromDevice(device)
//   → { renderer: null, device, queue }
```

LUT runners take `ctx`, not `renderer`. On WebGPU they should encode passes
against `ctx.device` / `ctx.queue` where practical; they fall back to
`ctx.renderer` only for bits not yet ported (PMREM, CubeCamera). The AP LUT
already runs on `renderer.computeAsync` — it's the closest to device-native
and the natural first runner to move onto raw compute.

**What stays three-only (deliberately):** PMREMGenerator and CubeCamera. The
native baker emits the raw cube + LUT textures; a caller who wants prefiltered
IBL runs PMREM on their side. Reimplementing PMREM in the core is explicitly
out of scope (it's a project unto itself — see the perf note in
`UPSTREAM_TSL_SKY_PMREM.md`).

## Keeping the twins in sync

Two authorings of one spec rots without a guardrail. Plan:

1. **Parity examples** (see below): every LUT renders under both cores; a
   diff view flags divergence visually. This is the day-to-day check.
2. **Shared constants live in `core/` only** — resolutions, `PLANET_RADIUS_OFFSET`,
   `SAMPLE_SEGMENT_T`, sample counts. Neither authoring hard-codes them
   independently. (Today `192/108` is hard-coded in the SkyView UV remap AND
   flagged as fragile in a comment — this is exactly the smell to kill.)
3. **A `?core=` query convention** so any page flips backend without a rebuild.

## Migration phases (each ships green)

**Phase 0 — spike. ✅ DONE.** Pure leaf helpers authored in WGSL
(`core/wgsl/atmosphere.wgsl.ts`) + `wgslFn` wrappers
(`backends/wgsl/atmosphere.ts`). Parity page `examples/parity/00-leaf-helpers.html`
renders `rayleighPhase` / `miePhaseCS` / `hgPhase` / `raySphereIntersectNearest`
from both cores and reads the raw per-pixel diff back from a float target.
**Result: PASS, maxDiff = 1.43e-5** (threshold 1e-4), worst on `hgPhase` —
pure float op-ordering divergence between hand-WGSL and TSL-transpiled-WGSL.
This validates `wgslFn(code, includes)` round-trips into a TSL node graph and
matches the twin numerically. Nothing in the shipping path changed.

Notes for next session:

- `vite` was missing from devDependencies (config + CLAUDE.md dev-loop both
  assumed it); added it back. Examples run with `npx vite` (NOT `npm run dev`,
  which is `unbuild --stub`). Dev server picks the first free port ≥5173.
- A NodeMaterial forces opaque **alpha = 1.0** on its color output — you cannot
  smuggle readback data through the alpha channel. The parity page parks raw
  diff in **blue**. Remember this for any future GPU-readback harness.
- `three/tsl` has no type declarations (TS7016) — pre-existing across all 16
  importing files. A one-line `declare module 'three/tsl'` shim would silence
  all of them; deferred.

**Phase 1 — extract the agnostic core. ✅ DONE.** `git mv` of
`AtmosphereParams.ts` + `resolutions.ts` → `core/`, `atmosphere.tsl.ts` →
`backends/tsl/`. Imports fixed across src + the examples that deep-import.
Verified: typecheck clean, tests 5/5, both parity pages PASS, `04-live-sky`
scene renders identically (full atmosphere + AP haze + IBL). Behaviour identical.

Caveat (honest): `core/` is not literally zero-three — `AtmosphereParams.ts`
imports `Vector3` from `three/webgpu` for its coefficient fields. The import
source was left untouched during the move (behaviour-identical rule). Swapping
to plain-data vec3 (or `three` core math) so `core/` is truly renderer-free is a
Phase-5 cleanup for the native path, not a blocker now.

**Phase 2 — backend seam on one LUT. ✅ DONE.** `TransmittanceLUT` gained a
`backend: 'auto' | 'tsl' | 'wgsl'` option (default `'auto'` → WGSL on WebGPU,
TSL on WebGL; also the `?core=` guardrail). The whole LUT pixel is one WGSL
`wgslFn` (`core/wgsl/luts.wgsl.ts` → `backends/wgsl/luts.ts`) with a real
`for`-loop. `examples/parity/10-transmittance-lut.html` renders both authorings
into float targets and diffs: **PASS, maxDiff 6.2e-6**. `04-live-sky` renders
identically through the auto path (WGSL LUT → MS → SkyView → cube → IBL+haze).

**LOAD-BEARING CONSTRAINT discovered here (critical for Phase 3):** three's
`wgslFn` parser **cannot map a custom struct RETURN type** to a TSL node —
wrapping `fn f(...) -> MyStruct` throws `FunctionNode: Function is not a WGSL
code` at parse time. Only scalar/vector returns (`f32`, `vec2/3/4`) survive.
Consequences for the design:

- Shared helpers wrapped by `wgslFn` must return scalars/vectors. `raySphere`
  (f32) and the UV maps (vec2) are fine as `includes`.
- `computeScatteringAbsorption` / `integrateScatteredLuminance` return structs,
  so they CANNOT be `wgslFn` helpers. The medium sample is **inlined** into each
  LUT pixel body instead (see `TRANSMITTANCE_LUT_PIXEL`). The struct forms stay
  in `atmosphere.wgsl.ts` marked native-blob-only (raw WGSL compilers are fine
  with struct returns).
- Whole-LUT pixel functions return `vec3`/`vec4`, so they're always wrappable.
  The pattern for Phase 3: **one `wgslFn` per LUT, integrator logic inlined,
  texture params passed as args** (texture-in-wgslFn still to be validated).

**Phase 3 — port the integrator + remaining LUTs. 🟩 3 of 4 LUTs DONE.**
The full integrator is ported to WGSL and shipping on WebGPU for the three
fragment LUTs. Each has a `backend: 'auto'|'tsl'|'wgsl'` option (auto → WGSL on
WebGPU) and a parity page:

| LUT           | parity                 | notes                                                                 |
| ------------- | ---------------------- | --------------------------------------------------------------------- |
| Transmittance | 6.2e-6 abs             | no texture sampling — transparent                                     |
| Sky-View      | 4.8e-5 abs / 0.15% rel | full integrator: sun-T + MS-LUT sampling, earth shadow, ground bounce |
| Multi-Scatter | 8.6e-6 abs / 0.02% rel | 64×20 nested integrator + geometric-series finalize                   |

`04-live-sky` renders identically with all three on WGSL. The residuals are
manual-vs-hardware bilinear (see below) — imperceptible.

Two mechanisms proven en route (both in `examples/parity/11-texture-sample.html`):

- **Texture params work in `wgslFn`** (`texture_2d → 'texture'` in three's type
  lib; pass `texture(tex)` as the arg). But three binds NO sampler, so LUT
  sampling uses **manual bilinear via `textureLoad`** (`BILINEAR_SAMPLE_2D`),
  matching hardware to ~7e-4. This is why integrator LUTs aren't bit-identical
  to TSL (~1e-3) — visually identical though.
- The whole integrator is **inlined** per LUT pixel (medium sample, moveToTop,
  UV maps) since none can be struct-returning `wgslFn` helpers. Only
  scalar/vector helpers are includes: `raySphere` (f32), phases (f32),
  `getSphericalDir` (vec3), `bilinearSample2D` (vec3).

**Aerial-Perspective LUT — reframed to the native path (Phase 5), not `wgslFn`.**
AP is a **compute** shader (`instanceIndex` + `textureStore` into a
`Storage3DTexture`) with the underground-froxel correction (CLAUDE.md). three's
`wgslFn` is built for value-returning nodes in a fragment/compute _graph_; a
compute kernel that writes a 3D storage texture as a side effect doesn't fit
that shape (unproven: compute-`wgslFn` + storage-texture writes + 3D
`textureLoad`). Since the native baker (Phase 5) uses raw compute pipelines +
storage textures + real samplers as first-class citizens, AP's WGSL port lands
there — cleanly — rather than being forced through `wgslFn`. **The TSL AP path
is untouched and ships as-is on WebGPU today (it already uses `computeAsync`, no
`.toVar()` bomb).** This is the honest boundary of the `wgslFn` bridge:
**fragment LUTs → WGSL now; the compute LUT → WGSL with the native baker.**

**Phase 4 — device-first `RenderContext`.** LUT runners take `ctx`. AP LUT
moves onto raw `ctx.device` compute first (it's already compute). Prove a LUT
can bake with `renderer` present but unused for the pass encode.

**Phase 5 — native baker (the eventual goal).** `SkyCoreBaker.fromDevice(device)`
emits `{ transmittance, multiScatter, skyView, aerialPerspective, cube }` as
`GPUTexture`s. Three's `SkyAtmosphereBaker` becomes a thin adapter that wraps
those + runs PMREM. Non-three consumers use the core directly.

## Examples reorg

Current examples are a flat numbered pile (`01`–`15`, `component-*`). Restructure
around concern, and make the backend a first-class axis:

```
examples/
├── luts/            # 10–13 → per-LUT debug views (transmittance, MS, skyView, AP)
├── scenes/          # 01–06,14,15 → full demo scenes (baked, live, planet, night, grounded)
├── components/      # component-01..03 → drop-in component demos
└── parity/          # NEW — same LUT/scene rendered TSL vs WGSL side-by-side + diff
```

Conventions:

- **`?core=tsl|wgsl`** on any page selects the backend (default: auto by
  renderer). This is the sync guardrail in daily use.
- **`?debug=<mode>`** stays as-is (the LUT bisection modes).
- The `parity/` harness is the acceptance gate for every phase that touches
  math: if TSL and WGSL diverge on a LUT, the diff panel lights up.

## Phase 0+ — extended coverage (DONE)

After the leaf-helper spike, the remaining **pure, texture-free** helpers were
ported and parity-tested: `getSphericalDir` and the two Sky-View UV maps
(`uvToSkyViewLutParams` / `skyViewLutParamsToUv`).
`examples/parity/01-uv-maps.html` → **PASS, maxDiff = 4.7e-7**. This resolved
two mechanism questions at once:

- **Single-source confirmed.** Each `wgslFn` wrapper is now `wgslFn(CHUNK)`
  importing the core string verbatim — the WGSL is authored exactly once. No
  hand-duplicated shader source. (Cost: core chunks must be self-contained, so
  `PI` is inlined rather than shared via a module const — see the DESIGN RULE
  atop `atmosphere.wgsl.ts`.)
- **`includes` confirmed.** The Sky-View maps pull the sub-UV helper through
  `wgslFn(code, [helperNode])`. Shared leaf helpers are split one-function-per
  string precisely so they can be independent includes.

Still unproven (deliberately deferred — they need a real LUT to test against):
struct-arg / struct-return binding through `wgslFn` (for
`computeScatteringAbsorption` and the transmittance UV maps) and texture/sampler
params (for `integrateScatteredLuminance`). These land with Phase 2/3 wiring.

## Open questions (not blockers)

- Struct-arg and struct-return binding through `wgslFn`: does passing a TSL
  uniform _struct_ as one arg work, or must the params be flattened to N scalar
  args? The flat-arg approach is proven (Sky-View maps take `bottomRadius`
  directly); the struct approach is untested. Phase 2 (first LUT) decides.
- Whether the SkyView UV remap's hard-coded `192/108` should become a WGSL
  `override` constant or a struct field. Leaning struct field (one uniform
  path for both cores).
- Node/CJS build: `unbuild` currently emits `dist/index.{mjs,cjs}`. A
  core-only entry (`@pmndrs/sky/core`) for non-three consumers is a Phase-5
  packaging task.

```

```
