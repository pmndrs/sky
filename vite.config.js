import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        legacy: resolve(__dirname, 'examples/01-legacy-baked.html'),
        hillaire: resolve(__dirname, 'examples/02-hillaire-baked.html'),
        ap_demo: resolve(__dirname, 'examples/03-aerial-perspective.html'),
        live_sky: resolve(__dirname, 'examples/04-live-sky.html'),
        planet_scale: resolve(__dirname, 'examples/05-planet-scale.html'),
        planet_scale_debug: resolve(__dirname, 'examples/06-planet-scale-debug.html'),
        transmittance: resolve(__dirname, 'examples/10-transmittance-lut.html'),
        multiscatter: resolve(__dirname, 'examples/11-multiscatter-lut.html'),
        skyview: resolve(__dirname, 'examples/12-skyview-lut.html'),
        aerial: resolve(__dirname, 'examples/13-aerial-perspective-lut.html'),
        parity_leaf: resolve(__dirname, 'examples/parity/00-leaf-helpers.html'),
        parity_uv: resolve(__dirname, 'examples/parity/01-uv-maps.html'),
        parity_tlut: resolve(__dirname, 'examples/parity/10-transmittance-lut.html'),
        parity_texsample: resolve(__dirname, 'examples/parity/11-texture-sample.html'),
        parity_svlut: resolve(__dirname, 'examples/parity/12-skyview-lut.html'),
        parity_mslut: resolve(__dirname, 'examples/parity/13-multiscatter-lut.html'),
      },
    },
  },
})
