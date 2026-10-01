/**
 * Headless check of the look's sun-tint lobe (issue #18).
 *
 * Opens component-05-looks.html (WebGPU), turns the sun disc and the scene
 * props off, and faces the sun's azimuth with a wide upward camera. Sky
 * directions are given as (elevation, azimuth offset from the sun) and
 * projected through the live camera, so the numbers do not depend on the
 * viewport.
 *
 * 1. Weight readback (the assertions). Under NoToneMapping a full-override
 *    look (chroma 1, value 1) shows its ramp exactly — the contract
 *    verify-looks-ramp.mjs checks. With a flat grey ramp g and a pure red tint
 *    at strength 1, every sky pixel is `mix(g, red, w)`, so the green channel
 *    gives the lobe weight back: `w = 1 − G / g`. That is compared at each
 *    probe with `sunTintWeight`, the JS mirror of the shader, and the lobe's
 *    shape is asserted: at a 50° sun a glow (the horizon below the sun far
 *    under the sky next to it, overhead well under the old full weight); at a
 *    2° sun still the twilight wedge up the sun's azimuth.
 *
 * 2. Looks as shipped. `ghibli-dusk` at 2°, 8° and 50°, and the issue's
 *    day tint (ghibli-day + a pale-yellow lobe) at 50°, each rendered with and
 *    without the tint: frames plus an amplified |tinted − untinted| image.
 *    `BASELINE=<tag>` diffs each frame against an earlier run (e.g. one taken
 *    on main) — how the fix showed the sunset frame unchanged.
 *
 *   cd examples/vanilla && pnpm exec vite --port 5186 --strictPort
 *   BASE=http://localhost:5186/ TAG=fix BASELINE=main node scripts/verify-looks-sun-tint.mjs
 *
 * Output: scripts/.verify-out/sun-tint-<tag>-*.png and sun-tint-<tag>.json.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const OUT = new URL('./.verify-out/', import.meta.url).pathname
fs.mkdirSync(OUT, { recursive: true })
const LOOKS_SRC = new URL('../../../src/looks.ts', import.meta.url).pathname
const BASE = process.env.BASE ?? 'http://localhost:5173/'
const TAG = process.env.TAG ?? 'run'
const BASELINE = process.env.BASELINE ?? null
const TOL = +(process.env.TOL ?? 0.02) // lobe weight, shader vs JS mirror
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const BENIGN = /Unexpected token '<'|DOCTYPE/
const W = 1280
const H = 720
const FOV = 100
const PITCH = 38
const GREY = 0.5

// (elevation, azimuth offset from the sun), degrees. Clear of the horizon so
// no probe reads the planet.
const PROBES = {
  horizonSunward: [4, 0],
  sunward30: [30, 0],
  sunward60: [60, 0],
  sunward80: [80, 0],
  side30at30: [30, 30],
  side45at10: [10, 45],
}
const sunProbes = (elevation) => ({
  ...PROBES,
  // Below the sun, when that is still sky.
  ...(elevation >= 14 ? { sunMinus10: [elevation - 10, 0] } : {}),
})

const WEIGHT_SUNS = [2, 8, 20, 50]

// The day tint from the issue report: a pale-yellow lobe on a day ramp.
const DAY_TINT = { preset: 'ghibli-day', sunTint: { color: '#fff3c4', falloff: 0.3, strength: 0.5 } }
const LOOK_CASES = [
  { name: 'sunset-dusk', elevation: 2, look: 'ghibli-dusk' },
  { name: 'sun8-dusk', elevation: 8, look: 'ghibli-dusk' },
  { name: 'high-dusk', elevation: 50, look: 'ghibli-dusk' },
  { name: 'high-day', elevation: 50, look: DAY_TINT },
]

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
await settle(page, 60)

await page.evaluate(
  async ({ looksSrc, fov }) => {
    for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none'
    window.__sky.setSunDisc(false)
    // The workbench's props (mirror ball, pillars, ground) sit right under the
    // sun from this camera; hide them so every probe reads open sky.
    window.__sky._scene.traverse((o) => {
      if (o.isMesh && o.material?.isMeshStandardMaterial) o.visible = false
    })
    window.__camera.fov = fov
    window.__camera.updateProjectionMatrix()
    window.__looksSrc = await import(/* @vite-ignore */ `/@fs${looksSrc}`)
  },
  { looksSrc: LOOKS_SRC, fov: FOV },
)

/**
 * Put the sun at `elevation`, face its azimuth, and return each probe's pixel
 * plus the scalars the shader sees there (from the live sun vector).
 */
const aim = (elevation, probes) =>
  page.evaluate(
    ({ elevation, pitch, probes }) => {
      const sky = window.__sky
      sky.setSunDirection({ elevation, azimuth: 200 })
      const s = sky.baker.sky.sunDirection.value.clone().normalize()
      window.__lookToward(s, pitch)
      const cam = window.__camera
      cam.updateMatrixWorld()
      const T = window.__THREE
      const up = new T.Vector3(0, 1, 0)
      const sunAz = Math.atan2(s.z, s.x)
      const out = {}
      for (const [k, [el, daz]] of Object.entries(probes)) {
        const a = sunAz + (daz * Math.PI) / 180
        const e = (el * Math.PI) / 180
        const v = new T.Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a))
        const p = cam.position.clone().add(v.clone().multiplyScalar(10)).project(cam)
        // computeLightViewCosAngle: both onto the horizontal plane.
        const vh = new T.Vector3(v.x, 0, v.z).normalize()
        const sh = new T.Vector3(s.x, 0, s.z).normalize()
        out[k] = {
          px: [Math.round(((p.x + 1) / 2) * innerWidth - 0.5), Math.round(((1 - p.y) / 2) * innerHeight - 0.5)],
          lightViewCos: vh.dot(sh),
          sunViewCos: v.dot(s),
          sunZenithCos: s.dot(up),
        }
      }
      return out
    },
    { elevation, pitch: PITCH, probes },
  )

const sumAbs = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
const inFrame = ([x, y]) => x >= 1 && x < W - 1 && y >= 1 && y < H - 1

/** Mean of `f(pixelIndex)` over a 3×3 block. */
function block(x, y, f) {
  let s = 0
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += f(((y + dy) * W + (x + dx)) * 4)
  return s / 9
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

function deltaImage(a, b, gain = 4) {
  const out = new PNG({ width: W, height: H })
  for (let i = 0; i < a.data.length; i += 4) {
    for (let k = 0; k < 3; k++) out.data[i + k] = Math.min(255, Math.abs(a.data[i + k] - b.data[i + k]) * gain)
    out.data[i + 3] = 255
  }
  return out
}

function frameDiff(a, b) {
  let sum = 0
  let max = 0
  for (let i = 0; i < a.data.length; i += 4) {
    const d = sumAbs(a.data, b.data, i) / 3
    sum += d
    if (d > max) max = d
  }
  const changed = pixelmatch(a.data, b.data, null, W, H, { threshold: 0.04 })
  return {
    meanAbs: +(sum / (W * H)).toFixed(3),
    maxAbs: +max.toFixed(1),
    changedFraction: +(changed / (W * H)).toFixed(5),
  }
}

const report = { weights: {}, looks: {} }
const failures = []
const r3 = (n) => (n === null ? null : +n.toFixed(3))

// ---- 1. weight readback ----------------------------------------------------

await page.evaluate((grey) => {
  const r = window.__renderer
  r.toneMapping = window.__THREE.NoToneMapping
  r.toneMappingExposure = 1
  window.__sky.setLook({
    stops: [
      { at: -1, color: [grey, grey, grey] },
      { at: 1, color: [grey, grey, grey] },
    ],
    chroma: 1,
    value: 1,
    intensity: 1,
    sunTint: { color: [1, 0, 0], falloff: 0.3, strength: 1 },
  })
}, GREY)

let worstErr = 0
for (const elevation of WEIGHT_SUNS) {
  const probes = await aim(elevation, sunProbes(elevation))
  await settle(page, 45)
  const png = PNG.sync.read(await page.screenshot({ type: 'png' }))
  fs.writeFileSync(`${OUT}sun-tint-${TAG}-weight-${elevation}.png`, PNG.sync.write(png))

  // Null on a checkout that predates `sunTintWeight` (a baseline run).
  const expected = await page.evaluate(
    (probes) =>
      Object.fromEntries(
        Object.entries(probes).map(([k, p]) => [
          k,
          window.__looksSrc.sunTintWeight?.(p.lightViewCos, p.sunViewCos, p.sunZenithCos, 0.3, 1) ?? null,
        ]),
      ),
    probes,
  )

  const rows = {}
  for (const [k, p] of Object.entries(probes)) {
    if (!inFrame(p.px)) {
      rows[k] = { shader: null, expected: r3(expected[k]) }
      continue
    }
    const g = block(p.px[0], p.px[1], (i) => srgbToLinear(png.data[i + 1] / 255))
    const shader = 1 - g / GREY
    if (expected[k] !== null) worstErr = Math.max(worstErr, Math.abs(shader - expected[k]))
    rows[k] = {
      shader: r3(shader),
      expected: r3(expected[k]),
      azimuthOnly: r3(Math.max(p.lightViewCos, 0) ** (1 / 0.3)),
    }
  }
  report.weights[elevation] = rows

  const w = (k) => rows[k]?.shader
  if (elevation >= 40) {
    // A glow around the sun, not a horizon-to-zenith wedge.
    if (!(w('horizonSunward') < 0.5 * w('sunMinus10')))
      failures.push(`${elevation}°: horizon below the sun ${w('horizonSunward')} vs 10° below it ${w('sunMinus10')}`)
    if (!(w('sunward80') < 0.75))
      failures.push(`${elevation}°: 80° up the sun's azimuth still at ${w('sunward80')} (wedge)`)
  }
  if (elevation <= 3) {
    // The twilight band: the sunward horizon and the sky above it stay tinted.
    if (!(w('horizonSunward') > 0.95 && w('sunward60') > 0.9))
      failures.push(`${elevation}°: sunset band lost (horizon ${w('horizonSunward')}, 60° up ${w('sunward60')})`)
  }
}
if (worstErr > TOL) failures.push(`shader lobe differs from sunTintWeight by ${worstErr.toFixed(3)} (tol ${TOL})`)
report.worstWeightError = r3(worstErr)

// ---- 2. looks as shipped ---------------------------------------------------

await page.evaluate(() => {
  const r = window.__renderer
  r.toneMapping = window.__THREE.ACESFilmicToneMapping
  r.toneMappingExposure = 1
})

for (const c of LOOK_CASES) {
  await aim(c.elevation, {})
  await page.evaluate((look) => window.__sky.setLook(look), c.look)
  await settle(page, 45)
  const tintedBuf = await page.screenshot({ type: 'png' })
  fs.writeFileSync(`${OUT}sun-tint-${TAG}-${c.name}.png`, tintedBuf)

  await page.evaluate((look) => {
    const base = typeof look === 'string' ? { preset: look } : look
    window.__sky.setLook({ ...base, sunTint: null })
  }, c.look)
  await settle(page, 45)
  const plain = PNG.sync.read(await page.screenshot({ type: 'png' }))
  const tinted = PNG.sync.read(tintedBuf)
  fs.writeFileSync(`${OUT}sun-tint-${TAG}-${c.name}-delta.png`, PNG.sync.write(deltaImage(tinted, plain)))

  const entry = { elevation: c.elevation, tintVsUntinted: frameDiff(tinted, plain) }
  if (BASELINE) {
    const basePath = `${OUT}sun-tint-${BASELINE}-${c.name}.png`
    if (fs.existsSync(basePath)) entry.vsBaseline = frameDiff(tinted, PNG.sync.read(fs.readFileSync(basePath)))
  }
  report.looks[c.name] = entry
}

const errors = logs.filter((l) => /error|warn/i.test(l) && !BENIGN.test(l))
await browser.close()
fs.writeFileSync(`${OUT}sun-tint-${TAG}.json`, JSON.stringify(report, null, 2))
const pass = failures.length === 0 && errors.length === 0
console.log(JSON.stringify({ tag: TAG, baseline: BASELINE, pass, failures, errors, report }, null, 2))
process.exit(pass ? 0 : 1)
