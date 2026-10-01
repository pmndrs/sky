/**
 * Headless WebGPU check for `SkySun`'s physical mode and horizon fade.
 *
 *   1. The CPU transmittance twin (`src/core/sunTransmittance.ts`) against the
 *      GPU Transmittance LUT, texel by texel: the LUT is read back and every
 *      texel's (height, zenith cosine) is re-evaluated on the CPU.
 *   2. Units: a white Lambertian plane lit by a physical sun at noon is rendered
 *      into a half-float target (linear radiance, no tone mapping), and its
 *      radiance is compared with `E · sin(elevation) / π` and with the sky's.
 *   3. The horizon fade: effective intensity across sunset.
 *
 *   cd examples/vanilla && pnpm exec vite --port 5183 --strictPort   # any port
 *   BASE=http://localhost:5183/ node scripts/verify-sun-light.mjs
 *
 * Drives component-01-baked through `window.__sky` / `window.__renderer`;
 * three and the library are imported in the page from the URLs the page
 * itself loaded, so they are the same module instances.
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:5173/'
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']

async function open(headless) {
  const browser = await chromium.launch({ headless, args: GPU_ARGS })
  const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 })
  const logs = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await page.goto(BASE + 'component-01-baked.html', { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  const gpu = await page.evaluate(async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())))
  return { browser, page, logs, gpu }
}

let { browser, page, logs, gpu } = await open(true)
if (!gpu) {
  await browser.close()
  ;({ browser, page, logs, gpu } = await open(false))
}
if (!gpu) {
  console.log(JSON.stringify({ fatal: 'no WebGPU adapter in headless or headed' }))
  process.exit(2)
}
await page.waitForFunction(() => window.__sky, null, { timeout: 45000 })
await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)))

const report = await page.evaluate(async () => {
  const urls = performance.getEntriesByType('resource').map((e) => e.name)
  const THREE = await import(urls.find((u) => /three_webgpu\.js/.test(u)))
  const libIndex = urls.find((u) => /\/src\/index\.ts/.test(u))
  const { transmittanceToSun } = await import(libIndex.replace(/index\.ts.*$/, 'core/sunTransmittance.ts'))

  const sky = window.__sky
  const renderer = window.__renderer
  const baker = sky.baker
  const params = baker.atmosphereParams
  const out = {}

  // --- half-float readback (rows padded to 256 bytes) ---
  const HALF = new Float32Array(65536)
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1
    const e = (h >> 10) & 0x1f
    const f = h & 0x3ff
    HALF[h] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? NaN : s * 2 ** (e - 15) * (1 + f / 1024)
  }
  async function read(rt) {
    const { width, height } = rt
    const raw = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, width, height)
    const half = raw instanceof Uint16Array
    const stride = (Math.ceil((width * (half ? 8 : 16)) / 256) * 256) / (half ? 2 : 4)
    const data = new Float32Array(width * height * 4)
    for (let y = 0; y < height; y++)
      for (let i = 0; i < width * 4; i++)
        data[y * width * 4 + i] = half ? HALF[raw[y * stride + i]] : raw[y * stride + i]
    return { width, height, data }
  }

  // --- 1. CPU twin vs GPU Transmittance LUT ---
  const lut = await read(baker.transmittanceLUT.renderTarget)
  const bot = params.bottomRadius
  const top = params.topRadius
  const H = Math.sqrt(top * top - bot * bot)
  function compare(flip) {
    const errs = []
    let worst = null
    for (let j = 0; j < lut.height; j++) {
      for (let i = 0; i < lut.width; i++) {
        const u = (i + 0.5) / lut.width
        const v = (j + 0.5) / lut.height
        const rho = H * (flip ? 1 - v : v)
        const r = Math.sqrt(rho * rho + bot * bot)
        const dMin = top - r
        const dMax = rho + H
        const d = dMin + u * (dMax - dMin)
        const mu = d > 0 ? Math.min(1, Math.max(-1, (H * H - rho * rho - d * d) / (2 * r * d))) : 1
        const cpu = transmittanceToSun(r - bot, mu, params)
        const k = (j * lut.width + i) * 4
        for (let c = 0; c < 3; c++) {
          const gpu = lut.data[k + c]
          if (gpu < 1e-3 && cpu[c] < 1e-3) continue
          const e = Math.abs(cpu[c] - gpu) / Math.max(gpu, 1e-3)
          errs.push(e)
          if (!worst || e > worst.relErr)
            worst = { i, j, c, altKm: +(r - bot).toFixed(3), mu: +mu.toFixed(5), gpu, cpu: cpu[c], relErr: e }
        }
      }
    }
    errs.sort((a, b) => a - b)
    const q = (p) => +errs[Math.min(errs.length - 1, Math.floor(p * errs.length))].toExponential(2)
    return { n: errs.length, median: q(0.5), p99: q(0.99), p999: q(0.999), max: q(1), worst }
  }
  const a = compare(false)
  const b = compare(true)
  out.lut = { rowsBottomUp: a.median < b.median, ...(a.median < b.median ? a : b) }

  // Spot values a test can lock: GPU texel vs CPU at the same (alt, mu).
  out.spot = []
  for (const [i, j] of [
    [0, 0],
    [128, 0],
    [255, 0],
    [200, 32],
    [64, 63],
  ]) {
    const flip = !out.lut.rowsBottomUp
    const u = (i + 0.5) / lut.width
    const v = (j + 0.5) / lut.height
    const rho = H * (flip ? 1 - v : v)
    const r = Math.sqrt(rho * rho + bot * bot)
    const d = top - r + u * (rho + H - (top - r))
    const mu = Math.min(1, Math.max(-1, (H * H - rho * rho - d * d) / (2 * r * d)))
    const k = (j * lut.width + i) * 4
    out.spot.push({
      altKm: r - bot,
      mu,
      gpu: [lut.data[k], lut.data[k + 1], lut.data[k + 2]],
      cpu: transmittanceToSun(r - bot, mu, params),
    })
  }

  // --- 2. Units: white Lambertian plane under a physical noon sun ---
  const prevTone = renderer.toneMapping
  renderer.toneMapping = THREE.NoToneMapping
  sky.setTimeOfDay(12)
  const scene = new THREE.Scene()
  scene.background = sky.texture
  // Pure Lambert for the exact direct-light check; a rough standard material
  // (what scenes use) for the total with the sky's IBL.
  const lambert = new THREE.MeshLambertMaterial({ color: 0xffffff })
  const standard = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 })
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), lambert)
  plane.rotation.x = -Math.PI / 2
  scene.add(plane)
  const sun = sky.createSun({ physical: true, castShadow: false })
  sun.attach(scene)
  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 10000)
  camera.position.set(0, 2, 0)
  camera.lookAt(0, 2, -10)
  sky.update(camera)
  sky.flushEnvironment()
  const rt = new THREE.RenderTarget(256, 128, { type: THREE.HalfFloatType })
  async function shoot(cam) {
    renderer.setRenderTarget(rt)
    renderer.render(scene, cam)
    renderer.setRenderTarget(null)
    return read(rt)
  }
  const lum = (img, x, y) => {
    const k = (y * img.width + x) * 4
    return {
      rgb: [img.data[k], img.data[k + 1], img.data[k + 2]].map((n) => +n.toFixed(4)),
      Y: 0.2126 * img.data[k] + 0.7152 * img.data[k + 1] + 0.0722 * img.data[k + 2],
    }
  }
  scene.environment = null
  const directOnly = await shoot(camera)
  plane.material = standard
  scene.environment = sky.environmentTexture
  const withIbl = await shoot(camera)
  const up = new THREE.PerspectiveCamera(60, 2, 0.1, 10000)
  up.position.set(0, 2, 0)
  up.up.set(0, 0, -1)
  up.lookAt(0, 100, 0)
  const zenith = await shoot(up)

  const rowA = lum(directOnly, 128, 4)
  const rowB = lum(directOnly, 128, 123)
  // Read-back row order: the sunlit plane is the brighter end of the frame.
  const groundRow = rowA.Y > rowB.Y ? 4 : 123
  const skyRow = groundRow === 4 ? 123 : 4
  const elev = (sky.sunElevation * Math.PI) / 180
  const lightY = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  const E = sun.light.intensity * lightY(sun.light.color)
  out.units = {
    sunElevationDeg: +sky.sunElevation.toFixed(2),
    luminanceScale: baker.sky.luminanceScale.value,
    lightIntensity: +sun.light.intensity.toFixed(3),
    lightColor: [sun.light.color.r, sun.light.color.g, sun.light.color.b].map((n) => +n.toFixed(4)),
    illuminanceY: +E.toFixed(3),
    expectedPlaneDirectY: +((E * Math.sin(elev)) / Math.PI).toFixed(3),
    planeDirectLambert: lum(directOnly, 128, groundRow),
    planeStandardWithIbl: lum(withIbl, 128, groundRow),
    skyAboveHorizonTopOfFrame: lum(withIbl, 128, skyRow),
    skyZenith: lum(zenith, 128, 64),
  }
  out.units.planeOverZenith = +(out.units.planeStandardWithIbl.Y / out.units.skyZenith.Y).toFixed(2)
  out.units.planeOverSkyAt30deg = +(out.units.planeStandardWithIbl.Y / out.units.skyAboveHorizonTopOfFrame.Y).toFixed(2)
  const constant = sky.createSun({ castShadow: false })
  out.units.physicalOverConstant = +(E / (constant.light.intensity * lightY(constant.light.color))).toFixed(2)
  constant.dispose()

  // --- 3. Fade across sunset (both modes), on the same sun ---
  out.fade = []
  const fixed = sky.createSun({ castShadow: false, intensity: 4 })
  for (const e of [5, 1, 0.3, 0.1, 0, -0.1, -0.3, -1, -10]) {
    sky.setSunDirection({ elevation: e, azimuth: 180 })
    out.fade.push({
      elevation: e,
      constant: +fixed.light.intensity.toFixed(4),
      requested: fixed.intensity,
      physical: +sun.light.intensity.toFixed(4),
      physicalColor: [sun.light.color.r, sun.light.color.g, sun.light.color.b].map((n) => +n.toFixed(3)),
    })
  }
  fixed.dispose()
  sun.dispose()
  rt.dispose()
  lambert.dispose()
  standard.dispose()
  renderer.toneMapping = prevTone
  sky.setTimeOfDay(14.5)
  return out
})

console.log(JSON.stringify(report, null, 2))
const errors = logs.filter((l) => /error/i.test(l) && !/Unexpected token '<'|DOCTYPE/.test(l))
if (errors.length) console.log('console errors:', errors.slice(0, 20))
await browser.close()
