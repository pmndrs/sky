// Phase 4 end to end (SKY_PMREM_SPEC.md P3, I1, I3): the library's SkyPmrem in
// the real Sky, against three from source. Needs the examples dev server with
// THREE_SRC pointing at a three checkout that has the cube-mip PMREM (r187+):
//   THREE_SRC=$PWD/research/pmrem-lab/three/dev-repo \
//     pnpm --filter @pmndrs/sky-example-vanilla dev --port 5220 &
//   node research/pmrem-lab/sky-pmrem-e2e.mjs
import { chromium } from '../../examples/vanilla/node_modules/playwright/index.mjs'

const BASE = process.env.BASE ?? 'http://localhost:5220/'
const GPU = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const browser = await chromium.launch({ headless: true, args: GPU })
const rows = []

for (const pmrem of ['sky', 'three']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.text()))
  await page.goto(`${BASE}16-stars-bench.html?inspector=0&dpr=1&mode=cube&sun=10&pmrem=${pmrem}`)
  await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 120000 })
  await page.waitForTimeout(1500) // let the async pipeline compile land

  const res = await page.evaluate(async () => {
    const { sky, renderer } = window.__bench
    const baker = sky.baker
    const backend = renderer.backend
    const device = backend.device
    const drain = () => device.queue.onSubmittedWorkDone()
    const envBefore = baker.environmentTexture
    let el = 10
    const step = () => {
      el = el > 2 ? el - 0.1 : 10
      sky.setSunDirection({ elevation: el, azimuth: 30 })
      sky.update()
    }
    renderer.setAnimationLoop(null)
    // P3: burst mean (sky.update only), and per-frame max with a drain after each frame
    for (let i = 0; i < 20; i++) step()
    await drain()
    const means = []
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now()
      for (let i = 0; i < 120; i++) step()
      await drain()
      means.push((performance.now() - t0) / 120)
    }
    means.sort((a, b) => a - b)
    const per = []
    for (let i = 0; i < 120; i++) {
      const t0 = performance.now()
      step()
      await drain()
      per.push(performance.now() - t0)
    }
    per.sort((a, b) => a - b)

    // I3: after one update, the IBL equals a fresh three bake of the same cube
    sky.setSunDirection({ elevation: 3.7, azimuth: 30 })
    sky.update()
    await drain()
    const half = (h) => {
      const e = (h >> 10) & 0x1f
      const m = h & 0x3ff
      return (h & 0x8000 ? -1 : 1) * (e === 0 ? 2 ** -14 * (m / 1024) : 2 ** (e - 15) * (1 + m / 1024))
    }
    const readLevel = async (tex, lod) => {
      const s = tex.width >> lod
      const bpr = Math.ceil((s * 8) / 256) * 256
      const buf = device.createBuffer({ size: bpr * s * 6, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      const e = device.createCommandEncoder()
      e.copyTextureToBuffer({ texture: tex, mipLevel: lod }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: s }, [
        s,
        s,
        6,
      ])
      device.queue.submit([e.finish()])
      await buf.mapAsync(GPUMapMode.READ)
      const u = new Uint16Array(buf.getMappedRange().slice(0))
      buf.destroy()
      const lum = []
      for (let f = 0; f < 6; f++)
        for (let y = 0; y < s; y++)
          for (let x = 0; x < s; x++) {
            const o = (f * s * bpr + y * bpr) / 2 + x * 4
            lum.push(0.2126 * half(u[o]) + 0.7152 * half(u[o + 1]) + 0.0722 * half(u[o + 2]))
          }
      return lum
    }
    const ours = backend.get(baker.environmentTexture).texture
    const fresh = baker.pmremGenerator.fromCubemap(baker.cubeRenderTarget.texture)
    await drain()
    const theirs = backend.get(fresh.texture).texture
    const levels = []
    const cmp = (a, b) => {
      const mean = b.reduce((p, q) => p + q, 0) / b.length
      let sum = 0
      let worst = 0
      for (let i = 0; i < a.length; i++) {
        const r = Math.abs(a[i] - b[i]) / Math.max(b[i], mean * 0.05)
        sum += r
        worst = Math.max(worst, r)
      }
      return `${((100 * sum) / a.length).toFixed(2)}/${(100 * worst).toFixed(1)}`
    }
    if (ours.depthOrArrayLayers === 6) {
      for (let lod = 0; lod < ours.mipLevelCount; lod++)
        levels.push(cmp(await readLevel(ours, lod), await readLevel(theirs, lod)))
    } else {
      // r185/r186 CubeUV atlas: the level-0 tile is a copy of the cube (must match:
      // fresh + same layout); the filtered tiles are a different, more accurate filter.
      const readRegion = async (tex, x, y, w, h) => {
        const bpr = Math.ceil((w * 8) / 256) * 256
        const buf = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        const e = device.createCommandEncoder()
        e.copyTextureToBuffer({ texture: tex, origin: [x, y, 0] }, { buffer: buf, bytesPerRow: bpr }, [w, h, 1])
        device.queue.submit([e.finish()])
        await buf.mapAsync(GPUMapMode.READ)
        const u = new Uint16Array(buf.getMappedRange().slice(0))
        buf.destroy()
        const lum = []
        for (let yy = 0; yy < h; yy++)
          for (let xx = 0; xx < w; xx++) {
            const o = (yy * bpr) / 2 + xx * 4
            lum.push(0.2126 * half(u[o]) + 0.7152 * half(u[o + 1]) + 0.0722 * half(u[o + 2]))
          }
        return lum
      }
      const cs = ours.height / 4
      levels.push(
        'L0 tile ' + cmp(await readRegion(ours, 0, 0, 3 * cs, 2 * cs), await readRegion(theirs, 0, 0, 3 * cs, 2 * cs)),
      )
      const rest = [0, 2 * cs, ours.width, 2 * cs]
      levels.push('filtered tiles ' + cmp(await readRegion(ours, ...rest), await readRegion(theirs, ...rest)))
    }
    fresh.dispose()
    return {
      mode: `${baker.pmrem.mode}${baker.pmrem.layout ? ' / ' + baker.pmrem.layout : ''}`,
      'update mean ms (min of 5)': +means[0].toFixed(3),
      'update median ms': +means[2].toFixed(3),
      'per-frame p50 / max ms': `${per[60].toFixed(2)} / ${per[per.length - 1].toFixed(2)}`,
      'I1 same texture': baker.environmentTexture === envBefore,
      'vs fresh three bake, per level mean/max %': levels.join('  '),
    }
  })
  rows.push({ pmrem, ...res })
  if (errs.length) console.log(pmrem, errs.slice(0, 5).join('\n'))
  await page.close()
}
console.table(rows)
await browser.close()
