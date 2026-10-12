/** WebGPU regression: BASE=http://localhost:5173/ node scripts/verify-celestial-discs.mjs */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from 'playwright'

const base = process.env.BASE ?? 'http://localhost:5173/'
const out = new URL('./.verify-out/', import.meta.url).pathname
fs.mkdirSync(out, { recursive: true })
const args = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
let browser = await chromium.launch({ headless: true, args })
let page = await browser.newPage({ viewport: { width: 800, height: 450 } })
await page.goto(base + 'component-01-baked.html', { waitUntil: 'networkidle' })
if (!(await page.evaluate(async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter()))))) {
  await browser.close()
  browser = await chromium.launch({ headless: false, args })
  page = await browser.newPage({ viewport: { width: 800, height: 450 } })
  await page.goto(base + 'component-01-baked.html', { waitUntil: 'networkidle' })
}
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
await page.waitForFunction(() => window.__sky, null, { timeout: 60000 })
// The demo publishes __sky before its scene compile finishes and starts its loop.
await page.waitForTimeout(1500)
const report = await page.evaluate(async () => {
  const urls = performance.getEntriesByType('resource').map((e) => e.name)
  const THREE = await import(urls.find((u) => /three_webgpu\.js/.test(u)))
  const { Sky } = await import(urls.find((u) => /\/src\/index\.ts/.test(u)))
  const renderer = window.__renderer
  renderer.setAnimationLoop(null)
  window.__sky.dispose()
  renderer.toneMapping = THREE.NoToneMapping
  const sky = new Sky(renderer, { cubeSize: 16, quality: 'low', enableAerialPerspective: false })
  await sky.compileAsync()
  const scene = new THREE.Scene()
  sky.attach(scene)
  const camera = new THREE.PerspectiveCamera(6, 1, 0.1, 10)
  const rt = new THREE.RenderTarget(384, 384, { type: THREE.FloatType })
  async function shoot() {
    sky.update(camera)
    renderer.setRenderTarget(rt)
    renderer.render(scene, camera)
    const raw = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, 384, 384)
    renderer.setRenderTarget(null)
    return raw
  }
  function difference(a, b) {
    let count = 0
    for (let i = 0; i < a.length; i += 4) {
      if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 0.03) count++
    }
    return count
  }
  function rgb(a) {
    const k = (192 * 384 + 192) * 4
    return Array.from(a.slice(k, k + 3))
  }
  function pointAt(dir) {
    camera.lookAt(camera.position.clone().add(dir))
    camera.updateMatrixWorld()
  }
  const result = {}
  for (const elevation of [45, 2, 0, -1]) {
    sky.setSunDirection({ elevation, azimuth: 180 })
    pointAt(sky.baker._sunVec)
    sky.setSunDisc(false)
    const off = await shoot()
    sky.setSunDisc(true)
    const on = await shoot()
    result[elevation] = { pixels: difference(on, off), rgb: rgb(on) }
  }
  sky.setSunDirection({ elevation: 45, azimuth: 180 })
  pointAt(sky.baker._sunVec)
  const before = await shoot()
  camera.position.set(1000, 500, -3000)
  pointAt(sky.baker._sunVec)
  camera.far = 2
  camera.updateProjectionMatrix()
  // Hold atmospheric altitude fixed to isolate translation/projection.
  renderer.setRenderTarget(rt)
  renderer.render(scene, camera)
  const translated = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, 384, 384)
  renderer.setRenderTarget(null)
  result.parallaxPixels = difference(before, translated)

  camera.position.set(0, 0, 0)
  camera.far = 10
  camera.updateProjectionMatrix()
  const sun = sky.createSun({ physical: true, castShadow: false }).attach(scene)
  result.lightChild = sun.disc.parent === sun.light && sky.sunDisc.parent === null
  const withLight = await shoot()
  result.helperDifference = difference(before, withLight)
  sun.setColor(0x00ff00)
  result.helperTint = rgb(await shoot())
  sun.setColor(0xffffff)
  // A foreground opaque plane must completely hide the disc.
  const blocker = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0 }))
  blocker.position.copy(sky.baker._sunVec)
  blocker.lookAt(camera.position)
  scene.add(blocker)
  const blocked = await shoot()
  sky.setSunDisc(false)
  result.occludedPixels = difference(blocked, await shoot())
  blocker.removeFromParent()
  blocker.geometry.dispose()
  blocker.material.dispose()
  const live = sky.baker.createSkyMesh({ scale: 10000 })
  scene.add(live)
  const liveDisc = live.getObjectByName('SkySun.disc')
  result.liveWithLight = liveDisc.visible === false
  sun.dispose()
  sky.setSunDisc(true)
  result.liveSun = { visible: liveDisc.visible, rgb: rgb(await shoot()) }
  live.removeFromParent()

  const moon = sky.createMoon({ followSun: false, discIntensity: 2, daylightFade: false }).attach(scene)
  for (const elevation of [30, -1]) {
    moon.setDirection({ elevation, azimuth: 180 })
    pointAt(moon._moonVec)
    moon.setDiscVisible(false)
    const off = await shoot()
    moon.setDiscVisible(true)
    result['moon' + elevation] = { pixels: difference(await shoot(), off) }
  }
  moon.dispose()

  camera.position.set(0, 200000, 0)
  pointAt(sky.baker._sunVec)
  result.orbitalRgb = rgb(await shoot())
  camera.position.set(0, 0, 0)

  // Leave a sunset preview in the canvas for visual inspection.
  sky.setSunDisc({ visible: true, angularDiameter: 0.00935, intensity: 20 })
  sky.setSunDirection({ elevation: 0.8, azimuth: 180 })
  camera.fov = 12
  camera.aspect = 800 / 450
  camera.updateProjectionMatrix()
  camera.lookAt(0, Math.tan((1.8 * Math.PI) / 180), -1)
  sky.update(camera)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.5
  renderer.render(scene, camera)
  for (const element of document.body.children) {
    if (element.tagName !== 'CANVAS' && element.tagName !== 'SCRIPT') element.style.display = 'none'
  }
  rt.dispose()
  return result
})
await page
  .locator('canvas')
  .first()
  .screenshot({ path: out + 'sun-disc-sunset.png' })
await browser.close()
console.log(JSON.stringify({ report, errors }, null, 2))
assert.equal(errors.length, 0)
assert(report[45].pixels > 700 && report[45].pixels < 1100, 'physical angular diameter at screen resolution')
assert(report[2].rgb[0] > 5 * report[2].rgb[2], 'sunset disc reddens')
assert(report[0].pixels > 200 && report[0].pixels < report[45].pixels, 'partially set disc clips at horizon')
assert.equal(report[-1].pixels, 0, 'sun hidden below planet horizon')
assert.equal(report.parallaxPixels, 0, 'no parallax or far-plane clipping')
assert.equal(report.helperDifference, 0, 'lighting helper replaces standalone sun exactly')
assert(
  report.helperTint[0] < 0.001 && report.helperTint[1] > 10 && report.helperTint[2] < 0.001,
  'light base color tints the mesh',
)
assert.equal(report.lightChild, true)
assert.equal(report.occludedPixels, 0, 'terrain occlusion')
assert.equal(report.liveWithLight, true, 'live sky defers to light mesh')
assert.equal(report.liveSun.visible, true, 'live sky mesh returns when light detaches')
assert.deepEqual(report.liveSun.rgb, report[45].rgb, 'live sky has the same sharp sun core')
assert(report.moon30.pixels > 700, 'moon visible outside bake')
assert.equal(report['moon-1'].pixels, 0, 'moon hidden below planet horizon')
assert.deepEqual(report.orbitalRgb, [20, 20, 20], 'sun is unattenuated above the atmosphere')
