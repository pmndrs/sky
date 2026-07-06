import { defineBuildConfig } from 'unbuild'

/**
 * Unbuild configuration for @pmndrs/sky
 *
 * Three entry points:
 * - `.`                 → src/index.ts   (vanilla core, samples the TSL LUTs)
 * - `./react`           → src/react/     (R3F <Sky> component + hooks)
 * - `./react/auto-haze` → src/react/AutoHaze  (kept separate so its
 *                         `useRenderPipeline` import stays out of the main
 *                         `./react` bundle — <Sky> then works on r3f builds
 *                         that don't yet export the hook)
 *
 * Each entry emits .mjs, .cjs and .d.ts. Three.js, React and R3F are
 * externalized (they are peer deps) so the published bundle carries none of
 * them — including their sub-path entries (`three/tsl`, `three/webgpu`,
 * `three/addons/*`, `@react-three/fiber/webgpu`).
 */
export default defineBuildConfig({
  entries: ['src/index', 'src/react', 'src/react/AutoHaze'],
  outDir: 'dist',
  clean: true,
  declaration: true,
  failOnWarn: false,
  externals: [/^three($|\/)/, /^react($|\/)/, 'react-dom', /^@react-three\//],
  rollup: {
    emitCJS: true,
    esbuild: {
      target: 'es2020',
    },
  },
})
