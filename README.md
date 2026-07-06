# @pmndrs/sky

Production-quality atmospheric sky for Three.js / TSL on the WebGPU renderer.
Port of Sébastien Hillaire's [_A Scalable and Production Ready Sky and
Atmosphere Rendering Technique_](https://sebh.github.io/publications/egsr2020.pdf)
(EGSR 2020), with vanilla and React (R3F) entry points.

## Install

```bash
npm install @pmndrs/sky
# or
pnpm add @pmndrs/sky
```

Peer-deps: `three` (≥0.184), and optionally `react` + `@react-three/fiber`
(≥10.0.0-alpha) if you use the React bindings. Requires the WebGPU renderer.

## Vanilla

```js
import * as THREE from 'three/webgpu'
import { pass } from 'three/tsl'
import { Sky } from '@pmndrs/sky'

const renderer = new THREE.WebGPURenderer({ antialias: true })
await renderer.init()

const sky = new Sky(renderer, {
  preset: 'earth', // 'earth' | 'mars' | 'titan'
  timeOfDay: 14.5, // 0..24
  latitude: 37.7,
  exposure: 40,
})

const scene = new THREE.Scene()
sky.attach(scene) // sets scene.environment + scene.background

renderer.setAnimationLoop(() => {
  sky.update(camera)
  renderer.render(scene, camera)
})
```

### Aerial-perspective haze

```js
import { pass } from 'three/tsl'

const scenePass = pass(scene, camera)
const post = new THREE.RenderPipeline(renderer)
post.outputNode = sky.applyHaze(scenePass.getTextureNode(), {
  scenePass,
  policy: 'auto', // 'auto' | 'ap' | 'raymarch'
})

renderer.setAnimationLoop(() => {
  sky.update(camera)
  sky.updateAerialPerspective()
  post.render()
})
```

## React (R3F)

```jsx
import { Sky } from '@pmndrs/sky/react'
import { AutoHaze } from '@pmndrs/sky/react/auto-haze'

function Scene() {
  return (
    <>
      <Sky preset="earth" timeOfDay={14.5}>
        <AutoHaze />
      </Sky>
      <Mountains />
    </>
  )
}
```

`<AutoHaze>` lives in its own sub-export so the `useRenderPipeline` hook it
depends on is only pulled into bundles that actually need it. R3F builds
that don't yet export `useRenderPipeline` (e.g. `@react-three/fiber@10.0.0-alpha.2`)
can still use the plain `<Sky>`; haze becomes available once your R3F build
includes the hook.

To compose with your own pipeline, skip `<AutoHaze />` and grab the instance
via `useSky()`:

```jsx
import { useSky } from '@pmndrs/sky/react'
import { useRenderPipeline } from '@react-three/fiber/webgpu'

function CustomPipeline() {
  const sky = useSky()
  useRenderPipeline(({ renderPipeline, passes }) => {
    if (!sky) return
    renderPipeline.outputNode = sky.applyHaze(passes.scenePass.getTextureNode(), {
      scenePass: passes.scenePass,
      policy: 'auto',
    })
  })
  return null
}
```

## API

The `Sky` class:

| Method                                                                                       | Description                                                                                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `setTimeOfDay(hours)`                                                                        | NOAA solar position; combined with `latitude` + `dayOfYear`                                                                    |
| `setLatitude(deg)` / `setDayOfYear(day)`                                                     | Solar position inputs                                                                                                          |
| `setSunDirection({ elevation, azimuth })`                                                    | Direct override                                                                                                                |
| `setNorth('+X' \| '-X' \| '+Z' \| '-Z')`                                                     | Which world axis is geographic north                                                                                           |
| `setExposure(n)`                                                                             | Sky luminance scale (default 40)                                                                                               |
| `setSunDisc(boolean \| { angularDiameter })`                                                 | Disc visibility + size in radians                                                                                              |
| `setTurbidity(n)`                                                                            | Mie scattering scalar (1 = Earth)                                                                                              |
| `setGroundAlbedo(n \| Vector3)`                                                              | Multi-scatter LUT input                                                                                                        |
| `setMirrorBelowHorizon(boolean)`                                                             | Bake a Y-mirrored sky on the cube's lower hemisphere instead of lit-ground albedo (clean sky HDRI for reflective-floor scenes) |
| `setPreset('earth' \| 'mars' \| 'titan')`                                                    | Swap atmosphere defaults                                                                                                       |
| `setAtmosphere(partial)`                                                                     | Direct atmosphere-params override                                                                                              |
| `setHazeStrength(n)` / `setHazePolicy(p)` / `setHazeAltitudeBlend({startKm, endKm})`         | Live haze knobs                                                                                                                |
| `update(camera, { planetCenter? })`                                                          | Per-frame; planet-frame altitude when `planetCenter` is set                                                                    |
| `updateAerialPerspective()`                                                                  | Per-frame; required when `applyHaze` is wired                                                                                  |
| `applyHaze(sceneColorNode, options)`                                                         | Returns a `vec4` TSL output node                                                                                               |
| `createSun(opts)` / `createGround(opts)` / `createGroundedSkybox(opts)` / `createMoon(opts)` | Factories for the optional helper objects                                                                                      |
| `attach(scene)` / `detach()` / `dispose()`                                                   | Lifecycle                                                                                                                      |

### `GroundedSkybox` (optional)

A ground-projected skybox mesh — the lower hemisphere of the cube is reprojected
onto a flat disc at world `y=0`, so the cube content acts as a "floor" without
needing an explicit ground plane. Pass `reflective: true` for a mirror-floor /
wet-pavement look (disc samples the cube via `reflect(viewDir, +Y)`). Pair with
`sky.setMirrorBelowHorizon(true)` if you want PBR materials' downward IBL to
match the visible floor.

```js
const skybox = sky.createGroundedSkybox({ height: 4, radius: 200, reflective: false })
scene.add(skybox)

// per frame, so the disc stays anchored under the camera:
skybox.followCamera(camera)
```

## Starters

Self-contained Vite projects you can clone and run:

- [`tsl-sky-starters/vanilla`](https://github.com/DennisSmolek/tsl-sky-starters/tree/main/vanilla) — Three.js + Vite
- [`tsl-sky-starters/r3f`](https://github.com/DennisSmolek/tsl-sky-starters/tree/main/r3f) — React Three Fiber + Vite

```bash
npx degit DennisSmolek/tsl-sky-starters/vanilla my-sky-app
# or
npx degit DennisSmolek/tsl-sky-starters/r3f my-sky-app
```

## Status

Baked sky, aerial-perspective haze, and planet-scale (ground→orbit) rendering
are all functional. Volumetric clouds and god-rays are out of scope.

## Changelog

- **0.1.4**
  - **New `GroundedSkybox`.** Ground-projected skybox mesh that reprojects the cube's lower hemisphere onto a flat disc at world `y=0`. Optional `reflective` mode for wet-pavement / mirror-floor looks. Use `sky.createGroundedSkybox({ height, radius, reflective })`. See `examples/15-grounded-skybox.html` for dial-in.
  - **New `mirrorBelowHorizon`** constructor option + `sky.setMirrorBelowHorizon(flag)` runtime setter. When enabled, the cube bake fills the lower hemisphere with a clean Y-mirror of the sky instead of the LUT's lit-ground-albedo content. Pair with reflective-floor scenes so PBR IBL doesn't pick up a coloured ground tint from below.
  - **Sky-View LUT now bakes the ground-albedo bounce by default.** `environmentTexture`'s lower hemisphere is lit ground colour instead of black/dim, so matte materials' downward IBL picks up the ground tint correctly without needing an explicit `SkyGround` plane. Flip back to the previous behaviour any time by toggling `mirrorBelowHorizon` on (which bypasses the ground branch entirely).
- **0.1.3** — Reuse the PMREM render target across bakes so `environmentTexture` keeps stable identity. Prior versions reallocated per sun/atmosphere change, which invalidated the WebGPU TSL pipeline cache for every material referencing `scene.environment` and stalled `renderer.render()` (~150 ms per slider tick in consumer scenes with many TSL materials).

## License

MIT © Dennis Smolek
