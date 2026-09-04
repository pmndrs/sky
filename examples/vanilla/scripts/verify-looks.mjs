/**
 * Headless WebGPU smoke test for the stylized-look layer (SKY_LOOKS_PLAN.md §1).
 *
 * Drives component-01-baked + component-02-haze through `window.__sky`, and
 * checks the properties the design promises, numerically:
 *   - an explicit identity look (chroma 0, value 0) renders pixel-identical
 *   - chroma-only preserves mean luminance; value=1 moves it
 *   - setLook(null) returns to the physical render
 *   - the `ghibli` track responds to time of day
 *   - the haze demo retints and clears with no console errors
 *
 *   pnpm --filter @pmndrs/sky-example-vanilla dev          # note the port Vite prints
 *   BASE=http://localhost:5174/ node scripts/verify-looks.mjs
 *
 * Screenshots land in scripts/.verify-out/. Chromium is launched with WebGPU
 * flags (Metal on macOS); if no adapter is found headless it retries headed.
 * Exists because chrome-devtools-mcp isn't always available to an agent
 * session; this is the fallback loop.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const OUT = new URL('./.verify-out/', import.meta.url).pathname
import('node:fs').then((m) => m.mkdirSync(OUT, { recursive: true }))
const BASE = process.env.BASE ?? 'http://localhost:5173/'
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const BENIGN = /Unexpected token '<'|DOCTYPE/

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
const shot = async (page, name) => {
  const b = await page.screenshot({ type: 'png' })
  fs.writeFileSync(`${OUT}${name}.png`, b)
  return PNG.sync.read(b)
}
const diff = (a, b) => {
  const n = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.04 })
  return +(n / (a.width * a.height)).toFixed(5)
}
const lum = (p) => {
  let s = 0
  const d = p.data
  for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
  return +(s / (d.length / 4)).toFixed(2)
}
const setLook = (page, arg) =>
  page.evaluate((a) => {
    window.__sky.setLook(a)
  }, arg)

async function open(browser, path) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 })
  const logs = []
  __logs = logs
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  let gpu = false
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.waitForTimeout(700) // let any Vite HMR reload settle
      gpu = await page.evaluate(async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())))
      break
    } catch (e) {
      if (!/Execution context was destroyed/.test(String(e)) || attempt === 3) throw e
      await page.waitForLoadState('networkidle')
    }
  }
  return { page, logs, gpu }
}

const report = { headless: null, gpu: null, baked: {}, haze: {}, logs: {} }
let __logs = []
process.on('uncaughtException', (e) => {
  console.log(JSON.stringify({ FAILED: String(e).split('\n')[0], report, console: __logs.slice(-60) }, null, 2))
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.log(JSON.stringify({ FAILED: String(e).split('\n')[0], report, console: __logs.slice(-60) }, null, 2))
  process.exit(1)
})
let browser = await chromium.launch({ headless: true, args: GPU_ARGS })
let { page, logs, gpu } = await open(browser, 'component-01-baked.html')
if (!gpu) {
  await browser.close()
  browser = await chromium.launch({ headless: false, args: GPU_ARGS })
  ;({ page, logs, gpu } = await open(browser, 'component-01-baked.html'))
  report.headless = false
} else report.headless = true
report.gpu = gpu
if (!gpu) {
  console.log(JSON.stringify({ ...report, fatal: 'no WebGPU adapter in headless or headed' }, null, 2))
  await browser.close()
  process.exit(2)
}

report.diag = await page.evaluate(() => ({
  readyState: document.readyState,
  hasGpu: !!navigator.gpu,
  hasSky: !!window.__sky,
  hasRenderer: !!window.__renderer,
  canvases: document.querySelectorAll('canvas').length,
}))
await page.waitForFunction(() => window.__sky, null, { timeout: 45000 })
await settle(page, 120) // first bake + shader compile

const A = await shot(page, '01-physical')
await setLook(page, { stops: [{ at: 0, color: [1, 1, 1] }], chroma: 0, value: 0 })
await settle(page, 60)
const B = await shot(page, '02-identity-look')
await setLook(page, { preset: 'ghibli-day', chroma: 1, value: 0 })
await settle(page, 60)
const C = await shot(page, '03-ghibli-day-chroma-only')
await setLook(page, { preset: 'ghibli-day', chroma: 1, value: 1, intensity: 1 })
await settle(page, 60)
const D = await shot(page, '04-ghibli-day-value-1')
await setLook(page, null)
await settle(page, 60)
const E = await shot(page, '05-cleared')
await page.evaluate(() => {
  window.__sky.setLookTrack('ghibli')
  window.__sky.setTimeOfDay(6.3)
})
await settle(page, 60)
const F = await shot(page, '06-track-dawn')
await page.evaluate(() => {
  window.__sky.setTimeOfDay(14.5)
})
await settle(page, 60)
const G = await shot(page, '07-track-day')

report.baked = {
  'identity vs physical (want ~0)': diff(A, B),
  'ghibli chroma-only vs physical (want >0)': diff(A, C),
  'cleared vs physical (want ~0)': diff(A, E),
  'meanLum physical': lum(A),
  'meanLum chroma-only (want ≈ physical)': lum(C),
  'meanLum value=1 (want ≠ physical)': lum(D),
  'track dawn vs track day (want >0)': diff(F, G),
}
report.logs.baked = logs.filter((l) => /error|warn/i.test(l) && !BENIGN.test(l))
await page.close()

// --- haze demo ---
;({ page, logs } = await open(browser, 'component-02-haze.html'))
await page.waitForFunction(() => window.__sky, null, { timeout: 30000 })
await settle(page, 120)
const H0 = await shot(page, '10-haze-physical')
await setLook(page, { preset: 'ghibli-dusk', chroma: 1, value: 0 })
await settle(page, 60)
const H1 = await shot(page, '11-haze-ghibli-dusk')
await setLook(page, null)
await settle(page, 60)
const H2 = await shot(page, '12-haze-cleared')
report.haze = { 'look vs physical (want >0)': diff(H0, H1), 'cleared vs physical (want ~0)': diff(H0, H2) }
report.logs.haze = logs.filter((l) => /error|warn/i.test(l) && !BENIGN.test(l))

await browser.close()
console.log(JSON.stringify(report, null, 2))
