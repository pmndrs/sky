// Public API for `tsl-sky/react`.
//
// Peer-deps:
//   `react` ≥ 18
//   `@react-three/fiber` ≥ 10.0.0-alpha.X
//
// `<Sky autoHaze>` uses `useRenderPipeline` from `@react-three/fiber/webgpu`,
// which currently lives on the v10 alpha line. Both peers are declared
// optional in package.json so the vanilla entry (`tsl-sky`) remains
// importable without React or r3f installed.
export { Sky } from './Sky.jsx';
export { SkyContext, useSky } from './SkyContext.js';
