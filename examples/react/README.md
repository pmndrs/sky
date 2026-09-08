# @pmndrs/sky — React (R3F) example

Minimal react-three-fiber + WebGPU demo of `<Sky>` from `@pmndrs/sky/react`.

```bash
pnpm --filter @pmndrs/sky-example-react dev
```

## Status: builds and renders on r3f 10.0.0-alpha.4 ✅

Verified 2026-09-08 (headless Chromium, WebGPU/Metal): `vite build` succeeds,
the page renders the sky with an IBL-lit sphere, console clean apart from one
r3f deprecation warning (below).

History: r3f 10.x canaries before alpha.4 imported `WebGLCubeRenderTarget` from
`three/webgpu`, which does not export it, so `vite build` failed and
`@pmndrs/sky/react` could not load. alpha.4 imports `CubeRenderTarget` instead.
**`@pmndrs/sky/react` therefore requires `@react-three/fiber >= 10.0.0-alpha.4`.**

Open items:

1. This example imports `Canvas` from the default `@react-three/fiber` entry,
   which alpha.4 logs as deprecated in favour of `@react-three/fiber/webgpu`
   (the entry `<Sky>` itself uses). A first attempt at switching the example's
   `Canvas` to `/webgpu` rendered black in a headless run and was not pursued —
   alpha.4's WebGPU `Canvas` treats a function-valued `gl` prop differently
   (see `isRenderer` / `is.fun(glConfig)` in its `dist/webgpu/index.mjs`).
   Needs a small investigation; the current code works.
2. `<AutoHaze>` is omitted to keep this minimal. `useRenderPipeline` is present
   in alpha.4, so it can be added — see the haze guide.
