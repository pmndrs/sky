/**
 * Headless WebGPU check for shadowed haze (light shafts), 22-haze-shadows.html.
 *
 * For each scene it renders the same frame with the feature compiled out
 * (`?shadows=0`), compiled in, and as the `shadow-occlusion` debug mask, then
 * checks numerically that:
 *   - every pixel whose ray never meets a shadowed sample is unchanged
 *     between on and off (the deficit is exactly zero there);
 *   - pixels whose rays cross the shadow volume get darker, never brighter;
 *     (pixels that do not are unchanged up to one 8-bit step of shader
 *     codegen noise — see the comment at that check);
 *   - `strength: 0` (the live off switch) matches compiled-out;
 *   - the sample count is live (changing it changes the image);
 *   - nothing on the console looks like an error.
 * It also times back-to-back frames (animation loop paused, waited to GPU
 * completion) with the feature off and on at the default sample count.
 *
 *   pnpm --filter @pmndrs/sky-example-vanilla exec vite --port 5184 --strictPort
 *   BASE=http://localhost:5184/ node scripts/verify-haze-shadows.mjs
 *
 * `SAVE_BASELINE=1` only writes the compiled-out frames (21 page + C2 haze
 * page) to .verify-out/baseline-*.png. Run it once on the code *before* the
 * feature, then run normally: the off frames are compared against it, which is
 * the "off is identical to before" check.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import { PNG } from 'pngjs'

const OUT = new URL('./.verify-out/', import.meta.url).pathname
fs.mkdirSync(OUT, { recursive: true })
const BASE = process.env.BASE ?? 'http://localhost:5184/'
const SAVE_BASELINE = !!process.env.SAVE_BASELINE
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const BENIGN = /Unexpected token '<'|DOCTYPE|\[vite\]/
const ERRORISH = /error|warn|invalid|failed|exception/i

const browser = await chromium.launch({ headless: true, args: GPU_ARGS })
const allLogs = []

async function open(path, viewport = { width: 960, height: 540 }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
  page.on('console', (m) => allLogs.push(`[${m.type()}] ${path}: ${m.text().slice(0, 300)}`))
  page.on('pageerror', (e) => allLogs.push(`[pageerror] ${path}: ${e.message.slice(0, 300)}`))
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__sky, null, { timeout: 60000 })
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
  fs.writeFileSync(`${OUT}${name}.png`, b)
  return PNG.sync.read(b)
}
async function frame(path, name) {
  const page = await open(path)
  const img = await shot(page, name)
  await page.close()
  return img
}
const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
/** Differing pixels (any channel), optionally skipping a rect [x0, y0, x1, y1]. */
function identical(a, b, skip = null) {
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (skip) {
      const x = (i / 4) % a.width
      const y = Math.floor(i / 4 / a.width)
      if (x >= skip[0] && y >= skip[1] && x <= skip[2] && y <= skip[3]) continue
    }
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++
  }
  return n
}
/** Largest per-channel 8-bit difference. */
function maxAbs(a, b) {
  let m = 0
  for (let i = 0; i < a.data.length; i += 4)
    for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a.data[i + c] - b.data[i + c]))
  return m
}

/** on/off/mask analysis. The mask is the shadow-occlusion debug frame: 0 = no shadowed sample. */
function analyse(on, off, mask) {
  const r = {
    pixels: on.width * on.height,
    maskPixels: 0,
    outsideMask: 0,
    outsideMaskChanged: 0,
    outsideMaskChangedOver1: 0,
    outsideMaskMaxAbs: 0,
    insideMaskChanged: 0,
    brighterPixels: 0,
    maxBrighten: 0,
    meanLumDropInMask: 0,
    meanLumDropInStrongMask: 0,
    strongMaskPixels: 0,
    maxLumDrop: 0,
  }
  let dropSum = 0
  let strongSum = 0
  for (let i = 0; i < on.data.length; i += 4) {
    const m = Math.max(mask.data[i], mask.data[i + 1], mask.data[i + 2])
    const changed =
      on.data[i] !== off.data[i] || on.data[i + 1] !== off.data[i + 1] || on.data[i + 2] !== off.data[i + 2]
    const drop = lum(off.data, i) - lum(on.data, i)
    if (drop < 0) {
      r.brighterPixels++
      r.maxBrighten = Math.max(r.maxBrighten, -drop)
    }
    if (m === 0) {
      r.outsideMask++
      if (changed) {
        r.outsideMaskChanged++
        const mx = Math.max(...[0, 1, 2].map((c) => Math.abs(on.data[i + c] - off.data[i + c])))
        r.outsideMaskMaxAbs = Math.max(r.outsideMaskMaxAbs, mx)
        if (mx > 1) r.outsideMaskChangedOver1++
      }
    } else {
      r.maskPixels++
      if (changed) r.insideMaskChanged++
      dropSum += drop
      r.maxLumDrop = Math.max(r.maxLumDrop, drop)
      if (m > 128) {
        r.strongMaskPixels++
        strongSum += drop
      }
    }
  }
  r.meanLumDropInMask = +(dropSum / Math.max(1, r.maskPixels)).toFixed(2)
  r.meanLumDropInStrongMask = +(strongSum / Math.max(1, r.strongMaskPixels)).toFixed(2)
  r.maxLumDrop = +r.maxLumDrop.toFixed(2)
  r.maxBrighten = +r.maxBrighten.toFixed(2)
  return r
}

const report = { base: BASE, checks: {}, scenes: {}, bench: {}, pass: true }
const check = (name, ok, detail) => {
  report.checks[name] = { ok, ...(detail !== undefined ? { detail } : {}) }
  if (!ok) report.pass = false
}

// [page, name, rect to ignore]. C2 carries the inspector's live FPS counter.
const baselinePairs = [
  ['22-haze-shadows.html?ui=0&shadows=0', 'baseline-22-off', null],
  ['22-haze-shadows.html?ui=0&shadows=0&scene=towers', 'baseline-22-towers-off', null],
  // `dither=0`: the saved baseline predates the demo's output dither.
  ['component-02-haze.html?dither=0', 'baseline-c2-haze', [820, 0, 959, 50]],
]

if (SAVE_BASELINE) {
  // C2 randomises its mountains; pin Math.random so frames are comparable.
  for (const [path, name] of baselinePairs) await frameSeeded(path, name)
  console.log(JSON.stringify({ savedBaseline: baselinePairs.map((p) => p[1]) }, null, 2))
  await browser.close()
  process.exit(0)
}

async function frameSeeded(path, name) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 })
  page.on('console', (m) => allLogs.push(`[${m.type()}] ${path}: ${m.text().slice(0, 300)}`))
  page.on('pageerror', (e) => allLogs.push(`[pageerror] ${path}: ${e.message.slice(0, 300)}`))
  await page.addInitScript(() => {
    let s = 12345
    Math.random = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646
  })
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__sky, null, { timeout: 60000 })
  await settle(page, 90)
  const img = await shot(page, name)
  await page.close()
  return img
}

// --- 1. Off vs before (needs a baseline from the pre-feature code) ---------
for (const [path, name, skip] of baselinePairs) {
  const file = `${OUT}${name}.png`
  if (!fs.existsSync(file)) {
    check(`off-identical-to-before:${name}`, false, 'no baseline (run with SAVE_BASELINE=1 on the old code)')
    continue
  }
  const before = PNG.sync.read(fs.readFileSync(file))
  const now = await frameSeeded(path, name.replace('baseline', 'now'))
  const n = identical(before, now, skip)
  check(`off-identical-to-before:${name}`, n === 0, { differingPixels: n, ignoredRect: skip })
}

// --- 2. On vs off vs mask, per scene ----------------------------------------
for (const [scene, extra] of [
  ['sphere', ''],
  ['towers', ''],
  ['sphere-fullres', '&resolution=1'],
]) {
  const q = `22-haze-shadows.html?ui=0&scene=${scene.replace('-fullres', '')}${extra}`
  const off = await frame(`${q}&shadows=0`, `${scene}-off`)
  const on = await frame(q, `${scene}-on`)
  const mask = await frame(`${q}&debug=shadow-occlusion`, `${scene}-occlusion`)
  await frame(`${q}&debug=shadow-deficit`, `${scene}-deficit`)
  const a = analyse(on, off, mask)
  report.scenes[scene] = a
  // "Unchanged" = within one 8-bit step. The deficit is exactly 0 there, but
  // the shadow-enabled shader is a different program and the compiler may
  // contract the unchanged composite into FMAs differently (measured: a few
  // pixels flip by 1 LSB, scattered, the same as `strength: 0` vs compiled out).
  check(`${scene}:rays-missing-shadow-unchanged`, a.outsideMaskChangedOver1 === 0, {
    outsideMask: a.outsideMask,
    changedAtAll: a.outsideMaskChanged,
    changedByMoreThan1: a.outsideMaskChangedOver1,
    maxAbs8bit: a.outsideMaskMaxAbs,
  })
  check(`${scene}:shadowed-rays-darken`, a.insideMaskChanged > 0 && a.meanLumDropInMask > 0, {
    changed: a.insideMaskChanged,
    of: a.maskPixels,
    meanLumDrop8bit: a.meanLumDropInMask,
    meanLumDropStrong: a.meanLumDropInStrongMask,
  })
  check(`${scene}:never-brighter`, a.maxBrighten <= 1, { brighterPixels: a.brighterPixels, max: a.maxBrighten })

  // Diff visualisation: red = darker with shafts on (×8).
  const vis = new PNG({ width: on.width, height: on.height })
  for (let i = 0; i < on.data.length; i += 4) {
    const d = lum(off.data, i) - lum(on.data, i)
    vis.data[i] = Math.min(255, Math.max(0, d * 8))
    vis.data[i + 1] = Math.min(255, Math.max(0, -d * 8))
    vis.data[i + 2] = 0
    vis.data[i + 3] = 255
  }
  fs.writeFileSync(`${OUT}${scene}-diff-x8.png`, PNG.sync.write(vis))
}

// --- 3. Live knobs on one page: strength 0 == off, samples change the image --
{
  const off = PNG.sync.read(fs.readFileSync(`${OUT}sphere-off.png`))
  const page = await open('22-haze-shadows.html?ui=0')
  await page.evaluate(() => window.__hazeShadows.setShadowParams({ strength: 0 }))
  await settle(page, 20)
  const s0 = await shot(page, 'sphere-strength0')
  check('strength-0-matches-compiled-out', maxAbs(s0, off) <= 1, {
    differingPixels: identical(s0, off),
    maxAbs8bit: maxAbs(s0, off),
  })
  await page.evaluate(() => window.__hazeShadows.setShadowParams({ strength: 1, samples: 4 }))
  await settle(page, 20)
  const s4 = await shot(page, 'sphere-samples4')
  await page.evaluate(() => window.__hazeShadows.setShadowParams({ samples: 32 }))
  await settle(page, 20)
  const s32 = await shot(page, 'sphere-samples32')
  check('samples-are-live', identical(s4, s32) > 0, { differingPixels4vs32: identical(s4, s32) })
  await page.close()
}

// --- 4. Frame time, 1920×1080, default sample count --------------------------
{
  const page = await open('22-haze-shadows.html?ui=0', { width: 1920, height: 1080 })
  const configs = {
    off: () => window.__hazeShadows.setShadows(false),
    on: () => {
      window.__hazeShadows.setShadows(true)
      window.__sky.setHazeShadows({ resolution: 0.5, samples: 32 })
    },
    onFullRes: () => window.__sky.setHazeShadows({ resolution: 1 }),
    onStrength0: () => window.__sky.setHazeShadows({ resolution: 0.5, strength: 0 }),
  }
  const times = {}
  for (let round = 0; round < 4; round++) {
    for (const [name, fn] of Object.entries(configs)) {
      await page.evaluate(`(${fn.toString()})()`)
      await settle(page, 30) // compile + settle
      ;(times[name] ??= []).push(await page.evaluate(() => window.__hazeShadows.bench(300)))
    }
    await page.evaluate(() => window.__sky.setHazeShadows({ strength: 1 }))
  }
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  report.bench = { viewport: '1920x1080', samples: 32, note: 'ms per whole frame, median of 4 × 300 frames' }
  for (const [name, xs] of Object.entries(times)) report.bench[name] = +med(xs).toFixed(3)
  report.bench.deltaOnMs = +(report.bench.on - report.bench.off).toFixed(3)
  report.bench.deltaFullResMs = +(report.bench.onFullRes - report.bench.off).toFixed(3)
  await page.close()
}

// --- 5. Console ---------------------------------------------------------------
const bad = allLogs.filter((l) => !BENIGN.test(l) && (ERRORISH.test(l) || l.startsWith('[pageerror]')))
check('no-console-errors', bad.length === 0, bad.slice(0, 20))

console.log(JSON.stringify(report, null, 2))
await browser.close()
process.exit(report.pass ? 0 : 1)
