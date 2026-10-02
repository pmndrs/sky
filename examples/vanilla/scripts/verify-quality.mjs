/**
 * Headless check that `quality: 'low' | 'medium' | 'high'` resizes the LUTs
 * end to end (issue #13). Renders component-01-baked at each tier on the same
 * views (level and pitched, toward / away from a low sun, and a noon side
 * view) and pixel-diffs low and high against medium.
 *
 * What to expect: only resolution differences. They concentrate on the
 * horizon row, where the Sky-View LUT's sky and ground halves meet and a
 * coarser LUT blends them over a wider angle; `rowPeak` (largest per-row mean
 * |Δ|, 8-bit) and `rowPeakAt` (its row relative to the frame's middle row,
 * which is the horizon on the level views) track that. `colPeak` /
 * `colPeakAt` is the same per column, for the U seam through the sun and
 * anti-sun azimuths. Everything else should stay within an 8-bit step or so.
 * Errors and warnings from the page are listed per tier.
 *
 *   cd examples/vanilla && pnpm exec vite --port 5185 --strictPort
 *   BASE=http://localhost:5185/ node scripts/verify-quality.mjs [label]
 *
 * Screenshots land in scripts/.verify-out/quality-<label>-<view>-<tier>.png and
 * the numbers in scripts/.verify-out/quality-<label>.json (label defaults to
 * "run"; use e.g. "before" / "after" to keep both).
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const OUT = new URL('./.verify-out/', import.meta.url).pathname
fs.mkdirSync(OUT, { recursive: true })
const BASE = process.env.BASE ?? 'http://localhost:5185/'
const LABEL = process.argv[2] ?? 'run'
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const BENIGN = /Unexpected token '<'|DOCTYPE/
const W = 960
const H = 540

// Level views put the horizon on the middle row (camera pitch 0).
const VIEWS = [
  { name: 'sun-low', timeOfDay: 18.6, toward: 'sun', pitchDeg: 0 },
  { name: 'antisun-low', timeOfDay: 18.6, toward: 'antisun', pitchDeg: 0 },
  { name: 'sun-up', timeOfDay: 18.6, toward: 'sun', pitchDeg: 35 },
  { name: 'noon-side', timeOfDay: 13.0, toward: 'side', pitchDeg: 5 },
]
const TIERS = ['low', 'medium', 'high']

const settle = (page, n) =>
  page.evaluate(
    (n) =>
      new Promise((r) => {
        let i = 0
        const f = () => (++i >= n ? r() : requestAnimationFrame(f))
        requestAnimationFrame(f)
      }),
    n,
  )

async function render(browser, tier, view) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  const logs = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await page.goto(`${BASE}component-01-baked.html?quality=${tier}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => !!window.__sky, null, { timeout: 30000 })
  await settle(page, 20)
  await page.evaluate(
    ({ view }) => {
      // Hide every overlay (inspector, info banner) so only the canvas is captured.
      for (const el of document.body.children)
        if (el.tagName !== 'CANVAS' && el.tagName !== 'SCRIPT') el.style.display = 'none'
      const sky = window.__sky
      sky.setTimeOfDay(view.timeOfDay)
      sky.update(window.__camera)
      const s = sky.mesh.sunDirection.value
      let hx = s.x
      let hz = s.z
      const hl = Math.hypot(hx, hz) || 1
      hx /= hl
      hz /= hl
      if (view.toward === 'antisun') {
        hx = -hx
        hz = -hz
      } else if (view.toward === 'side') {
        const t = hx
        hx = -hz
        hz = t
      }
      // Stand 40 m out on the side the camera looks toward, so the demo
      // spheres stay behind it and the view is sky + ground plane.
      const cam = window.__camera
      const ctl = window.__controls
      ctl.enabled = false
      ctl.minDistance = 0
      const p = Math.tan((view.pitchDeg * Math.PI) / 180)
      cam.position.set(hx * 40, 2, hz * 40)
      ctl.target.set(hx * 50, 2 + 10 * p, hz * 50)
      cam.lookAt(ctl.target)
      ctl.update()
    },
    { view },
  )
  await settle(page, 40)
  const buf = await page.screenshot({ type: 'png' })
  fs.writeFileSync(`${OUT}quality-${LABEL}-${view.name}-${tier}.png`, buf)
  const errors = logs.filter((l) => /error|warn/i.test(l) && !BENIGN.test(l))
  await page.close()
  return { png: PNG.sync.read(buf), errors }
}

function compare(a, b) {
  const n = a.width * a.height
  const absAll = new Float64Array(n)
  const rowSum = new Float64Array(a.height)
  const colSum = new Float64Array(a.width)
  let sum = 0
  let max = 0
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4
      const d =
        (Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2])) /
        3
      absAll[y * a.width + x] = d
      rowSum[y] += d
      colSum[x] += d
      sum += d
      if (d > max) max = d
    }
  }
  const sorted = Array.from(absAll).sort((p, q) => p - q)
  const p99 = sorted[Math.floor(n * 0.99)]
  let rowPeak = 0
  let rowPeakAt = 0
  for (let y = 0; y < a.height; y++) {
    const m = rowSum[y] / a.width
    if (m > rowPeak) {
      rowPeak = m
      rowPeakAt = y
    }
  }
  let colPeak = 0
  let colPeakAt = 0
  for (let x = 0; x < a.width; x++) {
    const m = colSum[x] / a.height
    if (m > colPeak) {
      colPeak = m
      colPeakAt = x
    }
  }
  const changed = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.04 })
  return {
    meanAbs: +(sum / n).toFixed(3),
    p99Abs: +p99.toFixed(2),
    maxAbs: +max.toFixed(1),
    changedFrac: +(changed / n).toFixed(5),
    rowPeak: +rowPeak.toFixed(3),
    rowPeakAt: rowPeakAt - Math.floor(a.height / 2),
    colPeak: +colPeak.toFixed(3),
    colPeakAt,
  }
}

const browser = await chromium.launch({ headless: true, args: GPU_ARGS })
const report = { label: LABEL, base: BASE, viewport: `${W}x${H}`, views: {} }
for (const view of VIEWS) {
  const shots = {}
  const errors = []
  for (const tier of TIERS) {
    const r = await render(browser, tier, view)
    shots[tier] = r.png
    errors.push(...r.errors.map((e) => `${tier}: ${e}`))
  }
  report.views[view.name] = {
    low: compare(shots.low, shots.medium),
    high: compare(shots.high, shots.medium),
    errors,
  }
  console.log(view.name, JSON.stringify(report.views[view.name]))
}
await browser.close()
fs.writeFileSync(`${OUT}quality-${LABEL}.json`, JSON.stringify(report, null, 2))
console.log(`wrote ${OUT}quality-${LABEL}.json`)
