// Public API for `@pmndrs/sky/react`.
//
// Peer-deps:
//   `react` ≥ 18
//   `@react-three/fiber` ≥ 10.0.0-alpha.4 (earlier 10.x canaries import a
//   WebGL-only class from `three/webgpu` and fail to load)
//
// Haze lives in the separate `@pmndrs/sky/react/auto-haze` entry (`<AutoHaze />`),
// which uses `useRenderPipeline` from `@react-three/fiber/webgpu`. Both peers
// are declared optional in package.json so the vanilla entry (`@pmndrs/sky`)
// stays importable without React or r3f installed.
export { Sky } from './Sky'
export type { SkyProps } from './Sky'
export { SkyContext, useSky } from './SkyContext'
export type { SkyContextValue } from './SkyContext'
