/**
 * Numeric check that the shader's look ramp matches the JS reference.
 *
 * Opens component-05-looks.html headless (WebGPU), disables tonemapping and
 * every non-ramp contribution (sun disc, sun tint), assigns a full-override
 * look (chroma 1, value 1) with a known ramp, and then reads the centre pixel
 * column of a screenshot. Each row maps to a view elevation from the camera
 * pitch + FOV; the expected colour is `sampleLook()` at sin(elevation), scaled
 * by `intensity` and sRGB-encoded. Looks are display-referred and three
 * applies no exposure under NoToneMapping, so the rendered pixel must equal the
 * authored ramp colour whatever the sky exposure — the WYSIWYG contract. Reports the worst per-channel error and fails above TOL.
 *
 *   pnpm --filter @pmndrs/sky-example-vanilla dev          # note the port
 *   BASE=http://localhost:5173/ node scripts/verify-looks-ramp.mjs
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import { PNG } from 'pngjs'

const OUT = new URL('./.verify-out/', import.meta.url).pathname
fs.mkdirSync(OUT, { recursive: true })
const BASE = process.env.BASE ?? 'http://localhost:5173/'
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const TOL = +(process.env.TOL ?? 8) // 8-bit units per channel
const W = 800
const H = 600
const FOV = 70
const PITCH = 45
const INTENSITY = 0.9
// Sky exposure (luminanceScale). Deliberately far from 1: the ramp must not
// depend on it.
const EXPOSURE = 40

const settle = (page, n = 30) =>
  page.evaluate(
    (n) =>
      new Promise((r) => {
        let i = 0
        const f = () => (++i >= n ? r() : requestAnimationFrame(f))
        requestAnimationFrame(f)
      }),
    n,
  )

const browser = await chromium.launch({ headless: true, args: GPU_ARGS })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await page.goto(BASE + 'component-05-looks.html', { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__sky && window.__looks, null, { timeout: 45000 })
await settle(page, 90)

const ramps = {
  'linear-3': {
    stops: [
      { at: 0.0, color: [0.9, 0.1, 0.1] },
      { at: 0.5, color: [0.1, 0.9, 0.1] },
      { at: 1.0, color: [0.1, 0.1, 0.9] },
    ],
  },
  'smooth-pow-4': {
    stops: [
      { at: -0.2, color: [0.8, 0.5, 0.2] },
      { at: 0.1, color: [0.9, 0.8, 0.5], ease: 'smooth' },
      { at: 0.45, color: [0.3, 0.6, 0.9], ease: 2.2 },
      { at: 1.0, color: [0.1, 0.2, 0.7], ease: 0.6 },
    ],
  },
}

await page.evaluate(
  ({ fov, pitch, exposure }) => {
    const r = window.__renderer
    r.toneMapping = window.__THREE.NoToneMapping
    r.toneMappingExposure = 1
    window.__sky.setSunDisc(false)
    window.__sky.setTimeOfDay(13)
    window.__sky.setExposure(exposure)
    // Hide GUI + overlays so the screenshot is the raw frame.
    for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none'
    window.__camera.fov = fov
    window.__camera.updateProjectionMatrix()
    const s = window.__sky.baker.sky.sunDirection.value
    window.__lookToward({ x: -s.x, z: -s.z }, pitch)
  },
  { fov: FOV, pitch: PITCH, exposure: EXPOSURE },
)
const rampScale = INTENSITY

const srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)
const report = {}
let worst = 0
for (const [name, ramp] of Object.entries(ramps)) {
  await page.evaluate(
    ({ ramp, intensity }) => {
      window.__sky.setLook({ ...ramp, chroma: 1, value: 1, intensity, sunTint: null })
    },
    { ramp, intensity: INTENSITY },
  )
  await settle(page, 60)
  const png = PNG.sync.read(await page.screenshot({ type: 'png' }))
  fs.writeFileSync(`${OUT}ramp-${name}.png`, PNG.sync.write(png))

  const halfTan = Math.tan((FOV / 2) * (Math.PI / 180))
  const rows = []
  for (let y = 8; y < H - 8; y += 12) {
    const ndcY = 1 - (2 * (y + 0.5)) / H
    const elev = PITCH + Math.atan(ndcY * halfTan) * (180 / Math.PI)
    // Stay clear of the pillar silhouettes / ground near the horizon.
    if (elev < 22) continue
    rows.push({ y, elev, at: Math.sin(elev * (Math.PI / 180)) })
  }
  const expected = await page.evaluate(
    ({ ramp, ats }) => {
      const look = window.__looks.resolveLook({ ...ramp, chroma: 1, value: 1 })
      return ats.map((at) => {
        const c = window.__looks.sampleLook(look, at)
        return [c.r, c.g, c.b]
      })
    },
    { ramp, ats: rows.map((r) => r.at) },
  )
  const x = Math.floor(W / 2)
  let rampWorst = 0
  const table = rows.map((r, i) => {
    const idx = (r.y * W + x) * 4
    const actual = [png.data[idx], png.data[idx + 1], png.data[idx + 2]]
    const exp = expected[i].map((c) => Math.round(srgb(Math.min(1, c * rampScale)) * 255))
    const err = Math.max(...exp.map((e, k) => Math.abs(e - actual[k])))
    rampWorst = Math.max(rampWorst, err)
    return { elev: +r.elev.toFixed(1), expected: exp, actual, err }
  })
  worst = Math.max(worst, rampWorst)
  report[name] = { worstChannelError: rampWorst, rows: table }
}

const errors = logs.filter((l) => /error|warn/i.test(l) && !/DOCTYPE|Unexpected token '<'/.test(l))
await browser.close()
console.log(
  JSON.stringify({ tolerance: TOL, worst, pass: worst <= TOL && errors.length === 0, errors, report }, null, 2),
)
process.exit(worst <= TOL && errors.length === 0 ? 0 : 1)
