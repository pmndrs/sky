/**
 * Headless WebGPU check for issue #36: the sky's internal draws (cube
 * capture, PMREM) must not inherit a caller's active MRT.
 *
 * Drives 23-mrt-isolation.html, which re-bakes the sky every frame with a
 * two- and a four-attachment MRT left active, with both IBL paths (our
 * compute PMREM and three's time-sliced generator), and fails on any WebGPU
 * validation error, console error, or an MRT the sky did not restore.
 *
 *   pnpm --filter @pmndrs/sky-example-vanilla dev          # note the port Vite prints
 *   BASE=http://localhost:5174/ node scripts/verify-mrt-isolation.mjs
 *
 * Chromium is launched with WebGPU flags; if no adapter is found headless it
 * retries headed.
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:5173/'
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const BENIGN = /Unexpected token '<'|DOCTYPE/

async function open(browser, path) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 })
  const logs = []
  page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }))
  page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: e.message }))
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  const gpu = await page.evaluate(async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())))
  return { page, logs, gpu }
}

async function check(browser, attachments, generator = 'sky') {
  const query = `attachments=${attachments}&generator=${generator}`
  const { page, logs, gpu } = await open(browser, `23-mrt-isolation.html?${query}`)
  if (!gpu) return { gpu }
  await page.waitForFunction(() => window.__mrtReady, null, { timeout: 45000 })
  const result = await page.evaluate(() => window.__mrt.run(30))
  const consoleErrors = logs
    .filter((l) => (l.type === 'error' || l.type === 'warning' || l.type === 'pageerror') && !BENIGN.test(l.text))
    .map((l) => `[${l.type}] ${l.text.split('\n')[0].slice(0, 240)}`)
  await page.close()
  return { gpu, ...result, consoleErrors: consoleErrors.slice(0, 10), consoleErrorCount: consoleErrors.length }
}

let headless = true
let browser = await chromium.launch({ headless, args: GPU_ARGS })
let first = await check(browser, 2)
if (!first.gpu) {
  await browser.close()
  headless = false
  browser = await chromium.launch({ headless, args: GPU_ARGS })
  first = await check(browser, 2)
}
if (!first.gpu) {
  console.log(JSON.stringify({ fatal: 'no WebGPU adapter in headless or headed' }))
  await browser.close()
  process.exit(2)
}
// three's PMREMGenerator, time-sliced: its quad draws run mid-frame too.
const results = [first, await check(browser, 4), await check(browser, 2, 'three'), await check(browser, 4, 'three')]
await browser.close()

const ok = results.every((r) => r.frames > 0 && r.mrtKept && r.errorCount === 0 && r.consoleErrorCount === 0)
console.log(JSON.stringify({ ok, headless, results }, null, 2))
process.exit(ok ? 0 : 1)
