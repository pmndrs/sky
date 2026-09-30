// Captures the library's baked sky cube (256², rgba16f, all six faces) at a
// few sun elevations into captures/<name>.bin, for the real-sky quality runs
// (SKY_PMREM_SPEC.md Q2). Needs the examples dev server:
//   pnpm --filter @pmndrs/sky-example-vanilla dev --port 5219
//   node research/pmrem-lab/capture-sky.mjs
import { chromium } from '../../examples/vanilla/node_modules/playwright/index.mjs'
import fs from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:5219/'
const OUT = new URL('./captures/', import.meta.url).pathname
fs.mkdirSync(OUT, { recursive: true })
const GPU = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const SHOTS = [
  ['noon', 60],
  ['golden', 6],
  ['sunset', 0.5],
  ['twilight', -3],
  ['nautical', -8],
  // Below about −11° the scattered sky underflows half-float and bakes to
  // black, so the only night content in the cube is the Milky Way.
  ['milkyway', -25, { stars: true }],
]

const browser = await chromium.launch({ headless: true, args: GPU })
const page = await browser.newPage()
await page.goto(BASE + 'component-01-baked.html', { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__sky && window.__renderer, null, { timeout: 60000 })
await page.waitForTimeout(2000)
for (const [name, elev, opts = {}] of SHOTS) {
  const b64 = await page.evaluate(
    async ({ elev, stars }) => {
      const sky = window.__sky
      if (stars) await sky.enableStars()
      sky.setSunDirection({ elevation: elev, azimuth: 135 })
      sky.update(window.__camera ?? null)
      sky.flushEnvironment?.()
      const r = window.__renderer
      const rt = sky.baker.cubeRenderTarget
      const size = rt.width
      const faces = []
      for (let f = 0; f < 6; f++) faces.push(await r.readRenderTargetPixelsAsync(rt, 0, 0, size, size, 0, f))
      const total = new Uint16Array(faces.reduce((a, f) => a + f.length, 0))
      let o = 0
      for (const f of faces) {
        total.set(new Uint16Array(f.buffer, f.byteOffset, f.length), o)
        o += f.length
      }
      let s = ''
      const bytes = new Uint8Array(total.buffer)
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return { size, b64: btoa(s), perFace: faces[0].length, type: faces[0].constructor.name }
    },
    { elev, stars: !!opts.stars },
  )
  const buf = Buffer.from(b64.b64, 'base64')
  fs.writeFileSync(`${OUT}${name}.bin`, buf)
  console.log(name, `elev ${elev}°`, `${b64.size}²`, b64.type, `${(buf.length / 1e6).toFixed(2)} MB`)
}
await browser.close()
