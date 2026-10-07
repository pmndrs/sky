<h1 align="center">@pmndrs/sky</h1>
<p align="center">A hyper-efficient WebGPU sky system for three.js.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@pmndrs/sky"><img src="https://img.shields.io/npm/v/@pmndrs/sky.svg?style=flat&colorA=000000&colorB=000000" alt="npm version" /></a>
  <a href="https://github.com/pmndrs/sky/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/pmndrs/sky/ci.yml?branch=main&style=flat&colorA=000000&colorB=000000" alt="CI" /></a>
  <a href="https://github.com/pmndrs/sky/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@pmndrs/sky.svg?style=flat&colorA=000000&colorB=000000" alt="License" /></a>
  <a href="https://discord.gg/poimandres"><img src="https://img.shields.io/discord/740090768164651029?style=flat&colorA=000000&colorB=000000&label=discord&logo=discord&logoColor=ffffff" alt="Discord" /></a>
</p>

`@pmndrs/sky` is a physically based sky, lighting and atmosphere system for
three.js on the WebGPU renderer. Attach it to a scene and you get a sky driven
by real solar position, correct from ground level to orbit, whose image-based
lighting follows every move of the sun.

It is built for frame budgets. The sky is baked into a cube only when
something changes, so a frame where nothing moved costs next to nothing; the
environment lighting is re-filtered in one compute pass (about 1 ms, several
times faster than three's `PMREMGenerator`), so time-of-day can animate every
frame; and the per-pixel work is a handful of texture lookups.

The atmosphere itself builds on Sébastien Hillaire's
[_A Scalable and Production Ready Sky and Atmosphere Rendering Technique_](https://sebh.github.io/publications/egsr2020.pdf)
(EGSR 2020), and is checked against his reference code and Bruneton's
precomputed scattering. Around it you also get aerial-perspective haze for
distant geometry (with optional light shafts) or a cheaper sky-coloured height
fog, a night sky with pixel-sharp stars and the Milky Way, and stylized looks.
Vanilla and React (R3F) entry points, one `update()` call per frame.

**[Full docs →](https://sky.docs.pmnd.rs)** · **[Demo gallery →](https://sky.docs.pmnd.rs/examples/)**

## Install

```bash
npm install @pmndrs/sky
# or
pnpm add @pmndrs/sky
```

Peer-deps: `three` (≥0.186.0 — CI tests 0.186.x; the library also runs on
r187-dev), and optionally `react` + `@react-three/fiber`
(≥10.0.0-alpha.4 — earlier 10.x canaries import a WebGL-only class from
`three/webgpu` and fail to load) if you use the React bindings. Requires the WebGPU
renderer — see [Installation](https://sky.docs.pmnd.rs/getting-started/installation)
for details.

## Quick start

```js
import * as THREE from 'three/webgpu'
import { Sky } from '@pmndrs/sky'

const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)
await renderer.init()

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2000)
camera.position.set(0, 2, 10)

const sky = new Sky(renderer, {
  preset: 'earth', // 'earth' | 'mars' | 'titan'
  timeOfDay: 14.5, // 0..24
  latitude: 37.7,
  exposure: 40,
})

const scene = new THREE.Scene()
sky.attach(scene) // sets scene.environment + scene.background ({ environment: false } keeps your own IBL)
await sky.compileAsync() // the sky's shaders compile in the background; this has them ready for frame one

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

On a tight budget, `sky.applyFog(scenePass.getTextureNode(), { scenePass, density, heightFalloff })`
is exponential height fog coloured by the baked sky behind the geometry: one
texture sample per pixel and no per-frame LUT (no `updateAerialPerspective()`,
and `enableAerialPerspective` can be `false`). See
[Height fog](https://sky.docs.pmnd.rs/guides/haze#height-fog:-the-budget-tier).

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
depends on is only pulled into bundles that actually need it.

`<Sky>` props mirror the facade: construction options (`preset`, `quality`,
…) rebuild the instance, the rest (`timeOfDay`, `exposure`, `sunColor`,
`look` / `lookTrack`, haze knobs, …) go through the setters live. See the
[React reference](https://sky.docs.pmnd.rs/api/react) for the full props table.

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
- **[Haze guide](https://sky.docs.pmnd.rs/guides/haze)** — aerial perspective, policies, known issues, height fog
- **[Planet-scale guide](https://sky.docs.pmnd.rs/guides/planet-scale)** — `planetCenter`, radial frames, flight controls
- **[Tuning the atmosphere](https://sky.docs.pmnd.rs/guides/tuning-atmosphere)** — `AtmosphereParams`, presets
- **[Stylized looks](https://sky.docs.pmnd.rs/guides/looks)** — colour ramps over the physical sky, elevation-keyed tracks
- **[Night sky](https://sky.docs.pmnd.rs/guides/night-sky)** — star sprites and the baked Milky Way
- **[React reference](https://sky.docs.pmnd.rs/api/react)** — `<Sky>` props, `<AutoHaze>`, `useSky()`
- **[Upgrading](https://sky.docs.pmnd.rs/guides/upgrading)** — what changed in 0.5 (three r186, background shader compiles) and 0.4

A condensed method table for the `Sky` facade:

| Method                                                                                       | Description                                                                                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `setTimeOfDay(hours)`                                                                        | NOAA solar position; combined with `latitude` + `dayOfYear`                                                                    |
| `setLatitude(deg)` / `setDayOfYear(day)`                                                     | Solar position inputs                                                                                                          |
| `setSunDirection({ elevation, azimuth })`                                                    | Direct override; `azimuth` is a compass azimuth, clockwise from north (90 = east, on your right facing north)                  |
| `setNorth('+X' \| '-X' \| '+Z' \| '-Z' \| degrees)`                                          | Where geographic north points: an axis, or a heading clockwise from +Z seen from above                                         |
| `setExposure(n)`                                                                             | Sky luminance scale (default 40)                                                                                               |
| `setSunDisc(boolean \| { angularDiameter })`                                                 | Disc visibility + size in radians                                                                                              |
| `setSunColor(color)`                                                                         | Colour of the sun as a light (`'neutral'`, `'bruneton'`, hex, `Color`, `[r,g,b]`)                                              |
| `setLook(look)` / `setLookTrack(track)`                                                      | Stylized colour ramp over the physical sky, fixed or following sun elevation                                                   |
| `setTurbidity(n)`                                                                            | Mie scattering scalar (1 = Earth)                                                                                              |
| `setGroundAlbedo(n \| Vector3)`                                                              | Multi-scatter LUT input                                                                                                        |
| `setMirrorBelowHorizon(boolean)`                                                             | Bake a Y-mirrored sky on the cube's lower hemisphere instead of lit-ground albedo (clean sky HDRI for reflective-floor scenes) |
| `setPreset('earth' \| 'mars' \| 'titan')`                                                    | Swap atmosphere defaults                                                                                                       |
| `setAtmosphere(partial)`                                                                     | Direct atmosphere-params override                                                                                              |
| `setHazeStrength(n)` / `setHazePolicy(p)` / `setHazeAltitudeBlend({startKm, endKm})`         | Live haze knobs                                                                                                                |
| `setHazeShadows(opts)`                                                                       | Live light-shaft knobs (shadowed haze)                                                                                         |
| `update(camera, { planetCenter? })`                                                          | Per-frame; planet-frame altitude when `planetCenter` is set                                                                    |
| `updateAerialPerspective()`                                                                  | Per-frame; required when `applyHaze` is wired                                                                                  |
| `flushEnvironment()`                                                                         | Finish any pending IBL refresh now (screenshots, hard cuts)                                                                    |
| `applyHaze(sceneColorNode, options)`                                                         | Returns a `vec4` TSL output node; pass `shadows: { light }` for light shafts                                                   |
| `applyFog(sceneColorNode, options)` / `setFog(opts)`                                         | Sky-coloured height fog (no per-frame LUT) and its live knobs                                                                  |
| `createSun(opts)` / `createGround(opts)` / `createGroundedSkybox(opts)` / `createMoon(opts)` | Factories for the optional helper objects                                                                                      |
| `enableStars(opts)` / `disableStars()`                                                       | Night sky: star sprites + Milky Way (async on first enable)                                                                    |
| `attach(scene, { background?, environment? })` / `detach()` / `dispose()`                    | Lifecycle; `attach` claims both scene slots unless told otherwise                                                              |

The `pmrem` constructor option picks the IBL prefilter: by default
`environmentTexture` is re-filtered on every sky change with WebGPU compute
(~1 ms), falling back to three's throttled `PMREMGenerator` on the WebGL2 backend.

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

Baked sky, aerial-perspective haze with light shafts, sky-coloured height fog,
planet-scale (ground→orbit) rendering, the night sky, and stylized looks are
all functional. Volumetric clouds are out of scope.

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

Changes land through pull requests, which are squash-merged. **PR titles must
be [Conventional Commits](https://www.conventionalcommits.org/)**, because they
become the commit on `main` that the changelog and version bump are generated
from: `feat(haze): light shafts`, `fix(react): …`, `docs: …`, `examples: …`.
`feat` bumps the minor version (pre-1.0, breaking changes do too, marked
`feat!:`), `fix`/`perf` bump the patch. A check on every PR enforces the format.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md). Releases are cut by release-please from
merged pull requests; [RELEASING.md](./RELEASING.md) has the details.

## License

MIT © Dennis Smolek
