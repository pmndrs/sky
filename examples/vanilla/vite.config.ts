import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { readdirSync } from 'node:fs'

// Resolve @pmndrs/sky (and deep `@sky/*` internals used by the LUT-debug and
// parity demos) to the repo source for live editing / HMR — the scheduler
// pattern. Public-API demos import `@pmndrs/sky`; debug/parity demos that reach
// into internals import `@sky/<path>` (extensionless → Vite resolves the .ts).
const repoSrc = resolve(__dirname, '../../src')

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
  server: { port: 5173, open: false },
  resolve: {
    alias: [
      { find: '@pmndrs/sky', replacement: resolve(repoSrc, 'index.ts') },
      { find: /^@sky\//, replacement: `${repoSrc}/` },
    ],
  },
  build: {
    target: 'esnext',
    rollupOptions: { input: htmlEntries() },
  },
})
