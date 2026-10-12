/** BASE=http://localhost:5173/ node scripts/verify-moonlight.mjs */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from 'playwright'

const base = process.env.BASE ?? 'http://localhost:5173/'
const out = new URL('./.verify-out/', import.meta.url).pathname
fs.mkdirSync(out, { recursive: true })
const args = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
let browser = await chromium.launch({ headless: true, args })
let page = await browser.newPage({ viewport: { width: 1000, height: 650 }, deviceScaleFactor: 1 })
await page.goto(base + '14-night-sky.html', { waitUntil: 'networkidle' })
if (!(await page.evaluate(async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter()))))) {
  await browser.close()
  browser = await chromium.launch({ headless: false, args })
  page = await browser.newPage({ viewport: { width: 1000, height: 650 }, deviceScaleFactor: 1 })
  await page.goto(base + '14-night-sky.html', { waitUntil: 'networkidle' })
}
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
try {
  await page.getByRole('button', { name: 'Start night-sky demo' }).click()
  await page.waitForFunction(() => window.moonlight, null, { timeout: 60000 })
  await page.evaluate(() => {
    window.renderer.setAnimationLoop(null)
    window.stars.setTwinkle(0)
    for (const element of document.body.children) {
      if (element.tagName !== 'CANVAS' && element.tagName !== 'SCRIPT') element.style.display = 'none'
    }
  })
  const report = { cases: {} }
  report.orbit = await page.evaluate(() => {
    const automatic = window.moon.followSun
    const initial = window.moon._moonVec.clone()
    window.sky.setTimeOfDay(4)
    const moved = window.moon._moonVec.distanceTo(initial)
    // Keep the phase-comparison captures at their original sidereal frame.
    window.sky.setTimeOfDay(22.5)
    return { automatic, moved }
  })
  for (const [name, phase, elevation, sunElevation] of [
    ['full', 0.5, 35, -20],
    ['quarter', 0.25, 35, -20],
    ['crescent', 0.1, 35, -20],
    ['new', 0, 35, -20],
    ['moonset', 0.5, -2, -20],
    ['day', 0.5, 35, 20],
    ['day-quarter', 0.25, 35, 45],
  ]) {
    report.cases[name] = await page.evaluate(
      async ({ phase, elevation, sunElevation }) => {
        const urls = performance.getEntriesByType('resource').map((e) => e.name)
        const THREE = await import(urls.find((u) => /three_webgpu\.js/.test(u)))
        const { sky, moonlight: rig, renderer, scene, camera } = window
        sky.setSunDirection({ elevation: sunElevation, azimuth: 0 })
        rig.setPhase(phase).setDirection({ elevation, azimuth: 180 })
        sky.update(camera)
        sky.update(camera)
        sky.flushEnvironment()
        const rt = new THREE.RenderTarget(640, 416, { type: THREE.FloatType })
        renderer.toneMapping = THREE.NoToneMapping
        renderer.setRenderTarget(rt)
        renderer.render(scene, camera)
        const raw = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, 640, 416)
        renderer.setRenderTarget(null)
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.render(scene, camera)
        function mean(y0, y1, x0 = 64, x1 = 576) {
          let sum = 0,
            n = 0
          for (let y = Math.floor(y0 * 416); y < Math.floor(y1 * 416); y++) {
            for (let x = x0; x < x1; x++) {
              const k = (y * 640 + x) * 4
              sum += raw[k] * 0.2126 + raw[k + 1] * 0.7152 + raw[k + 2] * 0.0722
              n++
            }
          }
          return sum / n
        }
        rt.dispose()
        return {
          ground: mean(0.82, 0.96),
          // Keep the Milky Way and moon out of the sky-fill sample: the
          // galaxy naturally emerges as the moonlight dims.
          sky: mean(0.1, 0.4, 32, 128),
          moon: rig.moon.light.intensity,
          ambient: rig.ambient.light.intensity,
          fill: sky.mesh.gradeUniforms.fillScale.value,
          exposure: renderer.toneMappingExposure,
        }
      },
      { phase, elevation, sunElevation },
    )
    await page
      .locator('canvas')
      .first()
      .screenshot({ path: `${out}moonlight-${name}.png` })
  }

  report.shadowPixels = await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((e) => e.name)
    const THREE = await import(urls.find((u) => /three_webgpu\.js/.test(u)))
    const { sky, moonlight: rig, renderer, scene, camera } = window
    sky.setSunDirection({ elevation: -20, azimuth: 0 })
    rig.setPhase(0.5).setDirection({ elevation: 35, azimuth: 180 })
    sky.update(camera)
    sky.flushEnvironment()
    const rt = new THREE.RenderTarget(640, 416, { type: THREE.FloatType })
    renderer.toneMapping = THREE.NoToneMapping
    async function read() {
      renderer.setRenderTarget(rt)
      renderer.render(scene, camera)
      return renderer.readRenderTargetPixelsAsync(rt, 0, 0, 640, 416)
    }
    const shadowed = await read()
    rig.moon.castShadow = false
    const unshadowed = await read()
    rig.moon.castShadow = true
    let count = 0
    for (let i = 0; i < shadowed.length; i += 4) {
      if (unshadowed[i + 2] - shadowed[i + 2] > 0.001) count++
    }
    renderer.setRenderTarget(null)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    rt.dispose()
    return count
  })

  // Isolate the moon on black to measure its actual projected phase area.
  report.disc = await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((e) => e.name)
    const THREE = await import(urls.find((u) => /three_webgpu\.js/.test(u)))
    const { sky, moonlight: rig, renderer } = window
    rig.setDirection({ elevation: 35, azimuth: 180 })
    rig.moon.setDiscAngularDiameter(THREE.MathUtils.degToRad(2))
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0)
    scene.add(new THREE.Mesh(rig.moon.disc.geometry, rig.moon.disc.material))
    const camera = new THREE.PerspectiveCamera(6, 1, 0.1, 10)
    camera.lookAt(rig.moon._moonVec)
    const rt = new THREE.RenderTarget(128, 128, { type: THREE.FloatType })
    renderer.toneMapping = THREE.NoToneMapping
    const counts = {}
    for (const phase of [0.5, 0.25, 0.1, 0.75, 0]) {
      rig.setPhase(phase)
      sky.update(camera)
      renderer.setRenderTarget(rt)
      renderer.render(scene, camera)
      const raw = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, 128, 128)
      let count = 0
      for (let i = 0; i < raw.length; i += 4) if (Math.max(raw[i], raw[i + 1], raw[i + 2]) > 0.05) count++
      counts[phase] = count
    }
    renderer.setRenderTarget(null)
    rt.dispose()
    rig.moon.setDiscAngularDiameter(THREE.MathUtils.degToRad(1.2))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    return counts
  })
  report.daylight = await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((e) => e.name)
    const THREE = await import(urls.find((u) => /three_webgpu\.js/.test(u)))
    const { sky, moonlight: rig, renderer } = window
    rig.setPhase(0.25).setDirection({ elevation: 35, azimuth: 180 })
    const scene = new THREE.Scene()
    scene.background = sky.texture
    const disc = new THREE.Mesh(rig.moon.disc.geometry, rig.moon.disc.material)
    scene.add(disc)
    const camera = new THREE.PerspectiveCamera(6, 1, 0.1, 10)
    camera.lookAt(rig.moon._moonVec)
    const rt = new THREE.RenderTarget(128, 128, { type: THREE.FloatType })
    renderer.toneMapping = THREE.NoToneMapping
    async function read() {
      renderer.setRenderTarget(rt)
      renderer.render(scene, camera)
      return renderer.readRenderTargetPixelsAsync(rt, 0, 0, 128, 128)
    }
    async function contrast(elevation, turbidity, fade) {
      sky.setSunDirection({ elevation, azimuth: 90 })
      sky.setTurbidity(turbidity)
      rig.moon.setDaylightFade(fade)
      sky.update(camera)
      sky.update(camera)
      disc.visible = false
      const background = await read()
      disc.visible = true
      const moon = await read()
      let peak = 0
      for (let i = 0; i < moon.length; i += 4) {
        const excess =
          (moon[i] - background[i]) * 0.2126 +
          (moon[i + 1] - background[i + 1]) * 0.7152 +
          (moon[i + 2] - background[i + 2]) * 0.0722
        peak = Math.max(peak, excess)
      }
      renderer.setRenderTarget(null)
      return peak
    }
    const result = {
      night: await contrast(-20, 1, true),
      clearDay: await contrast(45, 1, true),
      forcedDay: await contrast(45, 1, false),
      hazyDay: await contrast(45, 50, true),
    }
    sky.setTurbidity(1)
    rig.moon.setDaylightFade(true)
    rt.dispose()
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    return result
  })
  await page.evaluate(() => {
    window.sky.setSunDirection({ elevation: -20, azimuth: 0 })
    window.moonlight.setPhase(0.5).setDirection({ elevation: 35, azimuth: 180 })
    window.sky.update(window.camera)
    window.renderer.render(window.scene, window.camera)
  })
  report.errors = errors
  console.log(JSON.stringify(report, null, 2))
  assert.equal(errors.length, 0, 'no shader or page errors')
  assert.equal(report.orbit.automatic, true, 'demo defaults to automatic lunar movement')
  assert(report.orbit.moved > 0.1, 'moon moves when time changes')
  const { full, quarter, crescent, new: moonless, moonset, day } = report.cases
  assert(
    full.ground > quarter.ground && quarter.ground > crescent.ground && crescent.ground > moonless.ground,
    'ground lighting follows phase',
  )
  assert(full.sky > quarter.sky && quarter.sky > moonless.sky, 'sky fill follows phase')
  assert(moonless.ground > 0, 'ambient floor keeps moonless ground readable')
  assert.equal(moonless.moon, 0)
  assert.equal(moonset.moon, 0)
  assert.equal(day.moon, 0)
  assert.equal(day.ambient, 0)
  assert.equal(full.exposure, moonless.exposure, 'comparison uses fixed exposure')
  assert(report.shadowPixels > 100, 'moon casts visible shadows on the landscape')
  const disc = report.disc
  assert(disc[0.5] > 1100, 'full moon is visible')
  assert(disc[0.25] / disc[0.5] > 0.45 && disc[0.25] / disc[0.5] < 0.55, 'quarter is half a disc')
  assert(disc[0.1] / disc[0.5] > 0.05 && disc[0.1] / disc[0.5] < 0.15, 'crescent has the expected area')
  assert.equal(disc[0.25], disc[0.75], 'waxing and waning quarters have equal area')
  assert.equal(disc[0], 0, 'new moon is dark')
  assert(report.daylight.clearDay > 0.001, 'daytime quarter moon can remain visible')
  assert(report.daylight.night > report.daylight.clearDay * 3, 'daytime moon loses its night radiance boost')
  assert(
    report.daylight.forcedDay > report.daylight.clearDay * 2,
    'automatic visibility is subtler than a forced glowing disc',
  )
  assert(report.daylight.hazyDay < report.daylight.clearDay, 'haze washes out the moon')
} finally {
  await browser.close()
}
