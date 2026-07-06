# @pmndrs/sky — React (R3F) example

Minimal react-three-fiber + WebGPU demo of `<Sky>` from `@pmndrs/sky/react`.

```bash
pnpm --filter @pmndrs/sky-example-react dev
```

## Status: needs browser verification ⚠️

This app is written against the documented `<Sky>` API and the r3f v10 WebGPU
`gl` factory, but it is **not yet runtime-verified**, for two reasons:

1. **`vite build` (rollup) currently fails** on an upstream mismatch: the
   installed `@react-three/fiber@10.0.0-canary` imports `WebGLCubeRenderTarget`
   from bare `three`, which resolves to the WebGPU build (`three/webgpu`) that
   does not export it. This is an r3f-v10-canary ↔ three-WebGPU interop issue,
   not a `@pmndrs/sky` bug. `vite dev` (esbuild) may still serve the app since
   it does not enforce named-export checks the way the production build does.

2. **`<AutoHaze>` is intentionally omitted** — `useRenderPipeline` is not
   present in every r3f canary build.

To finish: pin/upgrade to an r3f v10 build whose WebGPU renderer path is stable,
confirm the `gl` factory boots `WebGPURenderer`, then re-enable the production
build. The vanilla examples (`examples/vanilla`) exercise the same underlying
`Sky` engine and are fully working today.
