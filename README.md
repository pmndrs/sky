<h1 align="center">@pmndrs/sky</h1>
<p align="center">Production-quality Hillaire atmospheric sky for Three.js / TSL, on the WebGPU renderer.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@pmndrs/sky"><img src="https://img.shields.io/npm/v/@pmndrs/sky.svg?style=flat&colorA=000000&colorB=000000" alt="npm version" /></a>
  <a href="https://github.com/pmndrs/sky/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/pmndrs/sky/ci.yml?branch=main&style=flat&colorA=000000&colorB=000000" alt="CI" /></a>
  <a href="https://github.com/pmndrs/sky/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@pmndrs/sky.svg?style=flat&colorA=000000&colorB=000000" alt="License" /></a>
  <a href="https://discord.gg/poimandres"><img src="https://img.shields.io/discord/740090768164651029?style=flat&colorA=000000&colorB=000000&label=discord&logo=discord&logoColor=ffffff" alt="Discord" /></a>
</p>

`@pmndrs/sky` ports Sébastien Hillaire's [_A Scalable and Production Ready
Sky and Atmosphere Rendering Technique_](https://sebh.github.io/publications/egsr2020.pdf)
(EGSR 2020) to Three.js TSL. Attach it to a scene and you get a
physically-based sky driven by real solar position, correct at any camera
altitude from ground level to orbit, with an opt-in aerial-perspective haze
post-process for distant geometry — vanilla and React (R3F) entry points,
one `update()` call per frame.

**[Full docs →](https://sky.docs.pmnd.rs)** · **[Demo gallery →](https://sky.docs.pmnd.rs/examples/)**

## Install

```bash
npm install @pmndrs/sky
# or
pnpm add @pmndrs/sky
```

Peer-deps: `three` (≥0.185), and optionally `react` + `@react-three/fiber`
(≥10.0.0-alpha.4 — earlier 10.x canaries import a WebGL-only class from
`three/webgpu` and fail to load) if you use the React bindings. Requires the WebGPU
renderer — see [Installation](https://sky.docs.pmnd.rs/getting-started/installation)
for details.

## Quick start

```js
import * as THREE from 'three/webgpu'
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

See [Your First Sky](https://sky.docs.pmnd.rs/getting-started/your-first-sky)
for the full walkthrough, or jump straight to
[`examples/vanilla`](./examples/vanilla) to run it locally.

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

Full explanation of the AP-LUT/raymarch policies and known limitations:
[Haze guide](https://sky.docs.pmnd.rs/guides/haze).

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

## Docs

- **[Getting started](https://sky.docs.pmnd.rs/getting-started/introduction)** — install, requirements, first sky
- **[API reference](https://sky.docs.pmnd.rs/api/sky)** — `Sky`, `SkyAtmosphereBaker`, the LUT classes
- **[Haze guide](https://sky.docs.pmnd.rs/guides/haze)** — aerial perspective, policies, known issues
- **[Planet-scale guide](https://sky.docs.pmnd.rs/guides/planet-scale)** — `planetCenter`, radial frames, flight controls
- **[Tuning the atmosphere](https://sky.docs.pmnd.rs/guides/tuning-atmosphere)** — `AtmosphereParams`, presets

A condensed method table for the `Sky` facade:

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

See the [full `Sky` API reference](https://sky.docs.pmnd.rs/api/sky) for every option and setter.

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

## Demo gallery

Every example lives in [`examples/vanilla`](./examples/vanilla) and is
published at **[sky.docs.pmnd.rs/examples](https://sky.docs.pmnd.rs/examples/)** —
baked sky, aerial-perspective haze, planet-scale ground-to-orbit, individual
LUT debug views, and the numbered scratch demos used during development.

## Status

Baked sky, aerial-perspective haze, and planet-scale (ground→orbit) rendering
are all functional. Volumetric clouds and god-rays are out of scope.

## Contributing

```bash
git clone https://github.com/pmndrs/sky.git
cd sky
pnpm install
pnpm run ci          # build + typecheck + lint + test + format check
pnpm example:vanilla  # Vite dev server on :5173 for examples/vanilla
```

The library itself builds via `unbuild` (`pnpm dev` runs `unbuild --stub`
for library dev — that's _not_ the examples server). See
[`CLAUDE.md`](./CLAUDE.md) for the architecture write-up and a running list
of hard-won implementation gotchas, and [`ROADMAP.md`](./ROADMAP.md) for
current status and open work.

## Changelog

- **0.3.0**
  - **Fix React Suspense disposal.** Keep the `<Sky>` resource owner mounted while children load assets, preventing `Sky: instance is disposed` errors when StrictMode replays effects. Suspended children now render a null fallback inside `<Sky>`.
  - Add a regression test covering suspended child rendering, layout effects, and passive effects in StrictMode.
- **0.2.0** — first npm release.
  - **Stylized looks.** An artist-control layer over the physical sky: a colour ramp over view elevation plus a sun-relative tint, blended on two axes — `chroma` (swap hue, keep physical luminance) and `value` (override luminance too, for artificial moonlight). `sky.setLook('ghibli-day')`, `sky.setLookTrack('ghibli')` (follows sun elevation), `registerLook(...)`. Built-in `ghibli-night/dusk/day`. Background, PMREM IBL and aerial-perspective haze all inherit the look. See `docs/guides/looks.mdx`.
  - **Unreal-parity knobs.** `setMultiScatteringFactor(n)` (feeds the LUT bake), `setSkyLuminanceFactor(color)` and `setAerialPerspectiveDistanceScale(n)` (uniforms, no rebake).
  - **React:** `look`, `lookTrack`, `skyLuminanceFactor`, `apDistanceScale`, `multiScatteringFactor` props on `<Sky>`. `<Sky>` is now an effect-owned resource with an explicit disposal contract (StrictMode-safe).
  - **React bindings require `@react-three/fiber >= 10.0.0-alpha.4`** — earlier 10.x canaries import a WebGL-only class from `three/webgpu` and fail to load.
  - Headless-WebGPU verification script for the looks layer: `examples/vanilla/scripts/verify-looks.mjs`.
  - Known: the built-in Ghibli palette is a first pass and will be re-tuned.
- **0.1.4**
  - **New `GroundedSkybox`.** Ground-projected skybox mesh that reprojects the cube's lower hemisphere onto a flat disc at world `y=0`. Optional `reflective` mode for wet-pavement / mirror-floor looks. Use `sky.createGroundedSkybox({ height, radius, reflective })`. See `examples/vanilla/15-grounded-skybox.html` for dial-in.
  - **New `mirrorBelowHorizon`** constructor option + `sky.setMirrorBelowHorizon(flag)` runtime setter. When enabled, the cube bake fills the lower hemisphere with a clean Y-mirror of the sky instead of the LUT's lit-ground-albedo content. Pair with reflective-floor scenes so PBR IBL doesn't pick up a coloured ground tint from below.
  - **Sky-View LUT now bakes the ground-albedo bounce by default.** `environmentTexture`'s lower hemisphere is lit ground colour instead of black/dim, so matte materials' downward IBL picks up the ground tint correctly without needing an explicit `SkyGround` plane. Flip back to the previous behaviour any time by toggling `mirrorBelowHorizon` on (which bypasses the ground branch entirely).
- **0.1.3** — Reuse the PMREM render target across bakes so `environmentTexture` keeps stable identity. Prior versions reallocated per sun/atmosphere change, which invalidated the WebGPU TSL pipeline cache for every material referencing `scene.environment` and stalled `renderer.render()` (~150 ms per slider tick in consumer scenes with many TSL materials).

## License

MIT © Dennis Smolek
