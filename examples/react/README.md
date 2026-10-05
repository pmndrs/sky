# @pmndrs/sky — React (R3F) example

Minimal react-three-fiber + WebGPU demo of `<Sky>` from `@pmndrs/sky/react`.

```bash
pnpm --filter @pmndrs/sky-example-react dev
```

## Status: builds and renders on r3f 10.0.0-alpha.4 ✅

Verified 2026-10-05 (headless Chromium, WebGPU/Metal): `vite build` succeeds,
the page renders the sky with an IBL-lit sphere, and the console is clean.

`Canvas` is imported from `@react-three/fiber/webgpu`, the same entry `<Sky>`
uses; it creates and initialises the `WebGPURenderer` itself, so the example
passes no `gl`/`renderer` prop. (The default `@react-three/fiber` entry with a
`gl` factory also works but logs a WebGL-deprecation warning.)

History: r3f 10.x canaries before alpha.4 imported `WebGLCubeRenderTarget` from
`three/webgpu`, which does not export it, so `vite build` failed and
`@pmndrs/sky/react` could not load. alpha.4 imports `CubeRenderTarget` instead.
**`@pmndrs/sky/react` therefore requires `@react-three/fiber >= 10.0.0-alpha.4`.**

`<AutoHaze>` is omitted to keep this minimal. `useRenderPipeline` is present
in alpha.4, so it can be added — see the haze guide.
