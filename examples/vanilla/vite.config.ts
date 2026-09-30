import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { readdirSync } from 'node:fs'

// Resolve @pmndrs/sky (and deep `@sky/*` internals used by the LUT-debug and
// parity demos) to the repo source for live editing / HMR — the scheduler
// pattern. Public-API demos import `@pmndrs/sky`; debug/parity demos that reach
// into internals import `@sky/<path>` (extensionless → Vite resolves the .ts).
const repoSrc = resolve(__dirname, '../../src')

// THREE_SRC=<three.js checkout> runs the demos against three from source
// (e.g. an unreleased dev build): `three`, `three/webgpu`, `three/tsl` and
// `three/addons/*` resolve into it instead of node_modules.
const threeSrc = process.env.THREE_SRC ? resolve(process.env.THREE_SRC) : null
const threeAliases = threeSrc
  ? [
      { find: /^three\/webgpu$/, replacement: `${threeSrc}/src/Three.WebGPU.js` },
      { find: /^three\/tsl$/, replacement: `${threeSrc}/src/Three.TSL.js` },
      { find: /^three\/addons\//, replacement: `${threeSrc}/examples/jsm/` },
      { find: /^three$/, replacement: `${threeSrc}/src/Three.WebGPU.js` },
    ]
  : []

// Auto-discover every .html demo (top level + parity/) as a build entry so
// `vite build` type-resolves them all — a no-browser smoke test of imports.
function htmlEntries() {
  const entries: Record<string, string> = {}
  for (const dir of ['.', 'parity']) {
    const abs = resolve(__dirname, dir)
    let files: string[] = []
    try {
      files = readdirSync(abs)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.html')) continue
      const key = dir === '.' ? f.replace('.html', '') : `${dir}/${f.replace('.html', '')}`
      entries[key] = resolve(abs, f)
    }
  }
  return entries
}

export default defineConfig({
  base: process.env.BASE_PATH || '/',
  // A separate pre-bundle cache, so a THREE_SRC server and a normal one don't share deps.
  cacheDir: threeSrc ? 'node_modules/.vite-three-src' : undefined,
  server: { port: 5173, open: false },
  resolve: {
    alias: [
      { find: '@pmndrs/sky', replacement: resolve(repoSrc, 'index.ts') },
      { find: /^@sky\//, replacement: `${repoSrc}/` },
      ...threeAliases,
    ],
  },
  build: {
    target: 'esnext',
    rollupOptions: { input: htmlEntries() },
  },
})
