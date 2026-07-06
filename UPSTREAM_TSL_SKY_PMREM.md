# Upstream proposal — `tsl-sky` PMREM hot-path

## TL;DR

`SkyAtmosphereBaker.update()` disposes and reallocates `_pmremTarget` on
every sun/atmosphere change, then `Sky.update()` reassigns
`scene.environment` to the new texture. The PMREM convolution itself runs
in sub-ms GPU time — but the texture-identity swap on `scene.environment`
forces three.js's WebGPU TSL backend to invalidate the pipeline cache for
every material in the consumer's scene that references the environment
node. In a consumer app with even a modest TSL material count, this stalls
`renderer.render()` for ~150 ms per slider tick.

Measured against `tsl-sky@0.1.2`, `three@0.184`, WebGPU backend, on
identical hardware where the upstream demo runs at 60 fps with haze PP
enabled — our consumer app (a 3D interior planner with several dozen TSL
node materials) drops to ~7 fps on a `setTimeOfDay` slider drag. The demo
escapes the cost because its scene has essentially no materials to
re-key.

## Repro

`tsl-sky@0.1.2`, `three@0.184`, WebGPU backend, empty scene.

In `SkyAtmosphereBaker.js`:

```js
// 3. PMREM. WebGPU PMREMGenerator exposes `fromCubemap( texture )` (not the
// WebGL-style `fromCubeRenderTarget`). It allocates a new RT each call, so
// dispose the previous one first.
if (this._pmremTarget) this._pmremTarget.dispose()
this._pmremTarget = this.pmremGenerator.fromCubemap(this.cubeRenderTarget.texture)
```

Drag a `setTimeOfDay` slider continuously. `renderer.render(...)` stalls on
device queue for ~150 ms per frame. JS-side timing of `sky.update(camera)`
reports <1 ms — the stall happens at the next `renderer.render()` call
because the WebGPU command queue needs the PMREM work to flush.

## Root cause (confirmed)

`PMREMGenerator.fromCubemap()` constructs a new `RenderTarget` every call,
so `baker.environmentTexture` (== `_pmremTarget.texture`) changes identity
on every bake. `Sky.update()` then reassigns
`scene.environment = this.baker.environmentTexture`. In three.js's WebGPU
TSL backend, that identity change invalidates pipeline-cache entries for
every material in the scene that uses the environment node — causing a
cascade of pipeline rebuilds inside the next `renderer.render(...)` call.

Demo escapes the cost because its scene has essentially nothing that
references the environment, so there's nothing to invalidate.

### How we ruled out the alternatives

Patched the consumer app's `tsl-sky` install to A/B each suspect at runtime
behind `globalThis.__SKY_DEBUG_*__` flags. Drag a `setTimeOfDay` slider for
~5 s in each configuration, log per-tick split.

| Variant                       | cube bake | PMREM regen | `scene.environment` reassigned | result               |
| ----------------------------- | --------- | ----------- | ------------------------------ | -------------------- |
| Baseline                      | ✓         | ✓           | ✓                              | 155 ms, ~7 fps       |
| Skip cube bake + PMREM        | ✗         | ✗           | ✗                              | 0.7 ms, 50 fps       |
| Skip cube camera only         | ✗         | ✓           | ✓                              | 165 ms, ~7 fps       |
| Skip PMREM only               | ✓         | ✗           | ✗ (target not rotated)         | 0.7 ms, 50 fps       |
| **Keep PMREM, skip reassign** | ✓         | ✓           | **✗**                          | **0.81 ms, ~43 fps** |

The last row is the decisive one: PMREM runs full-speed, GPU work happens
every tick, _but_ `scene.environment` keeps pointing at the original
texture object → no pipeline invalidation cascade → smooth.

## Proposed fixes — ranked

### 1. Keep `baker.environmentTexture` identity stable across bakes (best)

The root problem is that `scene.environment` gets a new texture object on
every bake. Two ways to fix:

**1a. Reuse `_pmremTarget`.** PMREM's convolution output dimensions are
fixed by the input cubemap size, so a single output RT can be reused
indefinitely. The current dispose+realloc pattern is comment-flagged in
the source as a WebGPU-renderer workaround:

> // PMREMGenerator.fromCubemap returns a new RT each call

Investigate whether `pmremGenerator.fromCubemap()` can be coaxed into
rendering into a caller-provided target. If three.js doesn't expose this
today, file a parallel issue on `mrdoob/three.js` requesting a
target-arg overload — or vendor a tiny in-package PMREM convolution that
writes into a stable RT.

```js
// In SkyAtmosphereBaker.update():
if (!this._pmremTarget) {
  this._pmremTarget = this.pmremGenerator.fromCubemap(this.cubeRenderTarget.texture)
} else {
  // Pseudo: render the convolution into the existing target.
  this.pmremGenerator.fromCubemap(this.cubeRenderTarget.texture, this._pmremTarget)
}
```

**1b. Don't reassign `scene.environment`.** Set it once on `attach()`.
Since `_pmremTarget.texture` _would_ keep its identity under (1a), and
the `_scene.environment !== this.baker.environmentTexture` guard in
`Sky.update()` would naturally become a no-op, this falls out of 1a for
free. Worth dropping the guarded reassign anyway — the comment in
`Sky.update()` implies it's defensive against external code overwriting
`scene.environment`, which is a worse trap than the perf cliff.

### 2. Expose a PMREM refresh policy (good interim, no three.js dep)

Add a constructor option / setter that decouples PMREM refresh from
cube refresh:

```js
new Sky(renderer, {
  pmremRefreshMs: 100, // throttle PMREM regen to once per 100 ms
})

// or
sky.setPMREMRefreshMs(0) // eager (current behaviour, default)
sky.setPMREMRefreshMs(100) // throttled
sky.setPMREMRefreshMs(-1) // manual — caller invokes sky.refreshPMREM()
```

Cube re-bake continues at full rate; PMREM (and therefore the
`scene.environment` identity swap) is gated to once per N ms. Visually,
IBL lags slightly behind the sun, which is invisible on most materials.
This is a symptom fix, not a root-cause fix — under (1) it's not
needed — but it gives consumers an immediate throttle they can flip on
without waiting for the three.js side to land.

### 3. Reduce default PMREM cost (smaller fix)

If 1 and 2 are out of scope, lowering the default `cubeSize` reduces
PMREM cost proportionally — though it doesn't fix the identity-swap
cascade, only shrinks the per-rebuild cost.

## Measurements

`tsl-sky@0.1.2`, `three@0.184`, M-series Mac, blank-ish consumer scene
(no user content, but framework-level helpers, sky mesh, and PP materials
present), WebGPU backend, continuous `setTimeOfDay` slider drag.

| Variant                                           | render time |   tick rate |
| ------------------------------------------------- | ----------: | ----------: |
| Default                                           |      155 ms |      ~7 fps |
| Skip cube + PMREM entirely                        |      0.7 ms |      50 fps |
| Skip cube camera only (PMREM still runs)          |      165 ms |      ~7 fps |
| Skip PMREM only (cube bake still runs)            |      0.7 ms |      50 fps |
| **Keep PMREM, skip `scene.environment` reassign** | **0.81 ms** | **~43 fps** |

The last row isolates the cause. PMREM is running every frame; the only
thing skipped is the identity reassignment.

## Notes for whoever picks this up

- Patches gating the cube/PMREM/scene.environment paths behind
  `globalThis.__SKY_DEBUG_*__` flags are in the local
  `node_modules/tsl-sky` for reproducing the timings above. They aren't
  intended to ship — `yarn install` will wipe them.
- The `scene.environment` reassignment in `Sky.update()` (line 327–331)
  also changes texture identity per bake; under fix 1 this becomes a
  no-op naturally. Under fix 2 it stays a no-op while throttled.
