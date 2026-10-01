/**
 * Headless WebGPU check for the sky-coloured height fog, 24-sky-fog.html.
 *
 * Renders the page at noon, sunset and night with the fog off, on, and with
 * aerial-perspective haze instead, then checks numerically that:
 *   - sky pixels are untouched by the fog (bit-identical to fog off, using the
 *     `is-sky` debug mask);
 *   - geometry pixels do change;
 *   - the fog colour is the sky behind the geometry: the `fog-color` debug
 *     frame matches the background over open sky (orientation, azimuth and
 *     the cube lookup all agree with three's background);
 *   - `maxOpacity: 0` (the live off switch) matches the fog off, and
 *     `density` is live (changing it changes the image);
 *   - nothing on the console looks like an error.
 * It also times whole frames (loop paused, waited to GPU completion — the
 * burst method) for off / fog / haze. Other GPU work on the machine inflates
 * these; the minimum over rounds is reported.
 *
 *   pnpm --filter @pmndrs/sky-example-vanilla exec vite --port 5187 --strictPort
 *   BASE=http://localhost:5187/ node scripts/verify-sky-fog.mjs
 *
 * Frames land in scripts/.verify-out/fog-*.png.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import { PNG } from 'pngjs'

const OUT = new URL('./.verify-out/', import.meta.url).pathname
fs.mkdirSync(OUT, { recursive: true })
const BASE = process.env.BASE ?? 'http://localhost:5187/'
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const BENIGN = /Unexpected token '<'|DOCTYPE|\[vite\]/
const ERRORISH = /error|warn|invalid|failed|exception/i

const browser = await chromium.launch({ headless: true, args: GPU_ARGS })
const allLogs = []

async function open(query, viewport = { width: 960, height: 540 }) {
  const path = `24-sky-fog.html?ui=0&${query}`
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
  page.on('console', (m) => allLogs.push(`[${m.type()}] ${path}: ${m.text().slice(0, 300)}`))
  page.on('pageerror', (e) => allLogs.push(`[pageerror] ${path}: ${e.message.slice(0, 300)}`))
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__fog, null, { timeout: 60000 })
  await settle(page, 90)
  return page
}
function settle(page, n = 30) {
  return page.evaluate(
    (n) =>
      new Promise((r) => {
        let i = 0
        const f = () => (++i >= n ? r() : requestAnimationFrame(f))
        requestAnimationFrame(f)
      }),
    n,
  )
}
async function shot(page, name) {
  const b = await page.screenshot({ type: 'png' })
  fs.writeFileSync(`${OUT}fog-${name}.png`, b)
  return PNG.sync.read(b)
}
async function frame(query, name) {
  const page = await open(query)
  const img = await shot(page, name)
  await page.close()
  return img
}
/** Largest per-channel 8-bit difference, over pixels where `keep(i)` holds. */
function maxAbs(a, b, keep = () => true) {
  let m = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (!keep(i)) continue
    for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a.data[i + c] - b.data[i + c]))
  }
  return m
}
function countDiff(a, b, keep = () => true) {
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (!keep(i)) continue
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++
  }
  return n
}
const isWhite = (img) => (i) => img.data[i] > 128

const report = { base: BASE, checks: {}, bench: {}, pass: true }
const check = (name, ok, detail) => {
  report.checks[name] = { ok, ...(detail !== undefined ? { detail } : {}) }
  if (!ok) report.pass = false
}

// The info banner (top left) is HTML over the canvas; skip it in comparisons.
const outsideBanner = (w) => (i) => {
  const x = (i / 4) % w
  const y = Math.floor(i / 4 / w)
  return !(x < 390 && y < 110)
}

// --- 1. off / fog / haze at noon, sunset (facing the sun) and night ----------
const times = {
  noon: 'time=12',
  sunset: 'time=19&yaw=-50',
  // Twinkle off, or the star sprites differ between frames taken seconds apart.
  night: 'time=22&stars=1&twinkle=0&toneExposure=1.5&density=3&falloff=1500',
}
for (const [label, q] of Object.entries(times)) {
  const off = await frame(`mode=off&${q}`, `${label}-off`)
  const fog = await frame(`mode=fog&${q}`, `${label}-fog`)
  await frame(`mode=haze&${q}`, `${label}-haze`)
  const mask = await frame(`mode=fog&${q}&debug=is-sky`, `${label}-is-sky`)
  const keepSky = (i) => isWhite(mask)(i) && outsideBanner(off.width)(i)
  const keepGeometry = (i) => !isWhite(mask)(i) && outsideBanner(off.width)(i)
  check(`${label}:sky-untouched`, countDiff(off, fog, keepSky) === 0, {
    differingSkyPixels: countDiff(off, fog, keepSky),
    maxAbs8bit: maxAbs(off, fog, keepSky),
  })
  check(`${label}:geometry-fogged`, countDiff(off, fog, keepGeometry) > 0, {
    changedGeometryPixels: countDiff(off, fog, keepGeometry),
  })
}

// --- 2. Fog colour == the background over open sky (day: the sharp cube) -----
for (const [label, q] of [
  ['noon', 'time=12'],
  ['sunset', 'time=19&yaw=-50'],
]) {
  const off = PNG.sync.read(fs.readFileSync(`${OUT}fog-${label}-off.png`))
  const mask = PNG.sync.read(fs.readFileSync(`${OUT}fog-${label}-is-sky.png`))
  const color = await frame(`mode=fog&${q}&debug=fog-color`, `${label}-fog-color`)
  // Open sky only, a few rows clear of the horizon (the sample is lifted
  // one texel centre there by design).
  const w = off.width
  const keep = (i) => isWhite(mask)(i) && outsideBanner(w)(i) && Math.floor(i / 4 / w) < off.height * 0.45
  const m = maxAbs(off, color, keep)
  check(`${label}:fog-color-matches-background`, m <= 3, { maxAbs8bit: m })
}

// --- 3. Live knobs on one page --------------------------------------------------
{
  const off = PNG.sync.read(fs.readFileSync(`${OUT}fog-noon-off.png`))
  const page = await open('mode=fog&time=12')
  await page.evaluate(() => window.__fog.setFog({ maxOpacity: 0 }))
  await settle(page, 10)
  const zero = await shot(page, 'noon-maxOpacity0')
  const keep = outsideBanner(off.width)
  check('maxOpacity-0-matches-off', maxAbs(zero, off, keep) <= 1, {
    differingPixels: countDiff(zero, off, keep),
    maxAbs8bit: maxAbs(zero, off, keep),
  })
  await page.evaluate(() => window.__fog.setFog({ maxOpacity: 1, density: 0.1 }))
  await settle(page, 10)
  const thin = await shot(page, 'noon-density0.1')
  await page.evaluate(() => window.__fog.setFog({ density: 2 }))
  await settle(page, 10)
  const thick = await shot(page, 'noon-density2')
  check('density-is-live', countDiff(thin, thick, keep) > 0, { differingPixels: countDiff(thin, thick, keep) })
  await page.close()
}

// --- 4. Frame time, 1920×1080: off / fog / haze, by day and by night ------------
// By night the fog also takes the blurred PMREM sample (a uniform branch that
// is skipped by day), so both are timed.
{
  const rounds = Number(process.env.ROUNDS ?? 5)
  const min = (xs) => Math.min(...xs)
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  report.bench = {
    viewport: '1920x1080',
    note: `ms per whole frame, ${rounds} rounds × 300 frames; min (median). Haze includes its per-frame AP LUT.`,
  }
  for (const [label, q] of [
    ['noon', 'time=12'],
    ['night', 'time=22&stars=1'],
  ]) {
    const page = await open(`mode=off&${q}`, { width: 1920, height: 1080 })
    const results = { off: [], fog: [], haze: [] }
    for (let r = 0; r < rounds; r++) {
      for (const mode of Object.keys(results)) {
        await page.evaluate((m) => window.__fog.setMode(m), mode)
        await settle(page, 30) // compile + settle
        results[mode].push(await page.evaluate(() => window.__fog.bench(300)))
      }
    }
    const b = (report.bench[label] = {})
    for (const [mode, xs] of Object.entries(results)) b[mode] = `${min(xs).toFixed(3)} (${med(xs).toFixed(3)})`
    b.fogMinusOffMs = +(min(results.fog) - min(results.off)).toFixed(3)
    b.hazeMinusOffMs = +(min(results.haze) - min(results.off)).toFixed(3)
    await page.close()
  }
}

// --- 5. Console ------------------------------------------------------------------
const bad = allLogs.filter((l) => !BENIGN.test(l) && (ERRORISH.test(l) || l.startsWith('[pageerror]')))
check('no-console-errors', bad.length === 0, bad.slice(0, 20))

console.log(JSON.stringify(report, null, 2))
await browser.close()
process.exit(report.pass ? 0 : 1)
