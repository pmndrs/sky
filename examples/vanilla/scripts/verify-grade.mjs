/**
 * Numeric check that the GPU sky grade matches its CPU twin.
 *
 * Opens the grade editor headless (WebGPU), turns tone mapping off, assigns a
 * test grade with distinct zones, and renders the dome preview in `grade` mode
 * (the grade applied to a flat 0.5 grey). Every sampled pixel maps to an
 * (azimuth, elevation) through `SkyGradePreview.toDome`; the expected colour is
 * `grade.apply([0.5, 0.5, 0.5], sunElevation, elevation, azimuth)`,
 * sRGB-encoded. This exercises the table addressing (azimuth, square-root
 * elevation packing, the keyframe slice), the bake, the half-float upload and
 * the shader operator together. Points within a couple of degrees of a zone
 * boundary are skipped: the table is bilinear there and the twin is analytic.
 *
 * Runs at a keyframe and halfway between two, and reports the worst error.
 *
 *   pnpm --filter @pmndrs/sky-example-vanilla dev          # note the port
 *   BASE=http://localhost:5173/ node scripts/verify-grade.mjs
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import { PNG } from 'pngjs'

const OUT = new URL('./.verify-out/', import.meta.url).pathname
fs.mkdirSync(OUT, { recursive: true })
const BASE = process.env.BASE ?? 'http://localhost:5173/'
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const TOL = +(process.env.TOL ?? 4) // 8-bit units per channel

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

const TEST_GRADE = {
  name: 'verify',
  keys: [
    {
      elevation: 0,
      exposure: 0.3,
      saturation: 1.1,
      temperature: 0.3,
      shape: { horizonHeight: 30, sunwardWidth: 60, antisunWidth: 60, glowSize: 20 },
      zones: {
        zenith: { color: '#2050d0', amount: 0.8 },
        horizon: { color: '#f0a060', amount: 0.6, brightness: 0.5 },
        antisun: { color: '#d070c0', amount: 0.7 },
        glow: { color: '#ffe080', amount: 0.5, brightness: 0.4 },
        ground: { color: '#406030', amount: 0.9, brightness: -1 },
      },
      fill: { zenith: '#000814', horizon: '#081020', intensity: 1 },
    },
    {
      elevation: 20,
      hue: 25,
      zones: { zenith: { color: '#60c0f0', amount: 0.5 }, horizon: { color: '#ffffff', amount: 0.3 } },
    },
  ],
}

const browser = await chromium.launch({ headless: true, args: GPU_ARGS })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await page.goto(BASE + '25-sky-grade-editor.html', { waitUntil: 'networkidle' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__editor, null, { timeout: 60000 })
await settle(page, 30)

await page.evaluate((def) => {
  window.__renderer.toneMapping = window.__THREE.NoToneMapping
  window.__grade.setKeys(def.keys)
  document.querySelector('#lutTabs button[data-mode=grade]').click()
  document.getElementById('guides').click() // hide the guides
  document.getElementById('lutOverlay').style.display = 'none'
}, TEST_GRADE)

const srgb = (c) => {
  const v = Math.min(1, Math.max(0, c))
  return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)
}

const report = { cases: {}, pass: true }
for (const sunElevation of [0, 10]) {
  await page.evaluate((e) => window.__editor.setElevation(e), sunElevation)
  await settle(page, 40)
  const actualSun = await page.evaluate(() => window.__sky.sunElevation)
  const el = await page.$('#lutGpu')
  const box = await el.boundingBox()
  const png = PNG.sync.read(await el.screenshot())
  fs.writeFileSync(`${OUT}grade-dome-${sunElevation}.png`, PNG.sync.write(png))

  // Sample a grid, skipping the edges of zones (bilinear table vs analytic twin).
  const samples = []
  for (let gy = 0.04; gy < 0.97; gy += 0.035) {
    for (let gx = 0.02; gx < 0.99; gx += 0.04) samples.push([gx, gy])
  }
  const expected = await page.evaluate(
    ({ samples, sun }) => {
      const grade = window.__grade
      const preview = window.__preview
      return samples.map(([x, y]) => {
        const { azimuth, elevation } = preview.toDome(x, y)
        const rgb = grade.apply([0.5, 0.5, 0.5], sun, elevation, azimuth)
        return { azimuth, elevation, rgb }
      })
    },
    { samples, sun: actualSun },
  )

  let worst = 0
  let worstAt = null
  let used = 0
  for (let i = 0; i < samples.length; i++) {
    const [x, y] = samples[i]
    const e = expected[i]
    // Zone boundaries of TEST_GRADE (horizon, horizonHeight 30°, sun/away
    // side widths 60°): the table interpolates across them.
    const az = Math.abs(e.azimuth)
    const nearEdge =
      Math.abs(e.elevation) < 3 || Math.abs(e.elevation - 30) < 3 || Math.abs(az - 60) < 6 || Math.abs(az - 120) < 6
    if (nearEdge) continue
    const px = Math.min(png.width - 1, Math.round(x * png.width))
    const py = Math.min(png.height - 1, Math.round(y * png.height))
    const o = (py * png.width + px) * 4
    for (let c = 0; c < 3; c++) {
      const err = Math.abs(png.data[o + c] - srgb(e.rgb[c]))
      if (err > worst) {
        worst = err
        worstAt = {
          az: +e.azimuth.toFixed(1),
          el: +e.elevation.toFixed(1),
          channel: c,
          got: png.data[o + c],
          want: +srgb(e.rgb[c]).toFixed(1),
        }
      }
    }
    used++
  }
  const ok = worst <= TOL
  report.cases[`sun ${sunElevation}°`] = {
    ok,
    worst: +worst.toFixed(2),
    worstAt,
    samples: used,
    canvas: `${box.width}×${box.height}`,
  }
  if (!ok) report.pass = false
}

const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'))
report.consoleErrors = errors
if (errors.length) report.pass = false
console.log(JSON.stringify(report, null, 2))
await browser.close()
process.exit(report.pass ? 0 : 1)
