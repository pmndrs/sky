import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

const source = (path: string) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url))

export default defineConfig({
  base: process.env.BASE_PATH || '/',
  resolve: {
    alias: [
      { find: '@pmndrs/sky/react/auto-haze', replacement: source('react/AutoHaze.tsx') },
      { find: '@pmndrs/sky/react', replacement: source('react/index.ts') },
      { find: '@pmndrs/sky/editor', replacement: source('editor/index.ts') },
      { find: '@pmndrs/sky', replacement: source('index.ts') },
    ],
    dedupe: ['react', 'react-dom', 'three', '@react-three/fiber'],
  },
  build: { target: 'esnext', chunkSizeWarningLimit: 2000 },
})
