import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Resolve @pmndrs/sky and @pmndrs/sky/react to the repo source for live editing.
const repoSrc = resolve(__dirname, '../../src')

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, open: false },
  resolve: {
    alias: [
      { find: '@pmndrs/sky/react', replacement: resolve(repoSrc, 'react/index.ts') },
      { find: '@pmndrs/sky', replacement: resolve(repoSrc, 'index.ts') },
      { find: /^@sky\//, replacement: `${repoSrc}/` },
    ],
    dedupe: ['react', 'react-dom', 'three'],
  },
  build: { target: 'esnext' },
})
