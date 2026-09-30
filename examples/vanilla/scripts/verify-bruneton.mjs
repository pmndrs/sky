/**
 * Headless A/B of 20-bruneton-compare.html: Bruneton's WebGL demo (verbatim)
 * against @pmndrs/sky, same camera, same sun, same tone curve.
 *
 * For each of his 9 views it captures a split screenshot and a diff screenshot,
 * then probes a grid of sky pixels on both canvases and inverts his tone curve
 * to recover linear radiance, so the report is a per-channel ratio ours/his —
 * not a tone-mapped impression. A sun-elevation sweep at a fixed sky-only view
 * closes with the zenith / horizon ratios that decide the "whiteout" question.
 *
 *   pnpm --filter @pmndrs/sky-example-vanilla dev          # note the port
 *   BASE=http://localhost:5183/ node scripts/verify-bruneton.mjs [--views 1,2,3] [--no-sweep]
 *
 * Output: scripts/.verify-out/bruneton-*.png and bruneton-report.{json,md}.
 * Chromium launches with WebGPU flags (Metal on macOS); retries headed if no
 * adapter is found headless. Same shape as verify-looks.mjs.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const OUT = new URL('./.verify-out/', import.meta.url).pathname
fs.mkdirSync(OUT, { recursive: true })
const BASE = process.env.BASE ?? 'http://localhost:5183/'
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const BENIGN = /Unexpected token '<'|DOCTYPE/
const argv = process.argv.slice(2)
const viewsArg = argv.includes('--views')
  ? argv[argv.indexOf('--views') + 1].split(',')
  : ['1', '2', '3', '4', '5', '6', '7', '8', '9']
const doSweep = !argv.includes('--no-sweep')

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
const shot = async (page, name) => fs.writeFileSync(`${OUT}${name}.png`, await page.screenshot({ type: 'png' }))

// Probe grid. On views 1–7 the sphere sits just above screen centre (its
// screen size varies with view distance) and the ground is below ~50%.
// 'centre' lands on the sphere in every ground view; 'centre-right' is open
// sky beside it on the wide views and sphere on the close ones (3, 4, 7).
const GRID = [
  { name: 'sky-TL', x: 0.15, y: 0.12 },
  { name: 'sky-T', x: 0.5, y: 0.08 },
  { name: 'sky-TR', x: 0.85, y: 0.12 },
  { name: 'sky-L', x: 0.12, y: 0.35 },
  { name: 'sky-R', x: 0.88, y: 0.35 },
  { name: 'below-hzn-L', x: 0.2, y: 0.5 },
  { name: 'below-hzn-R', x: 0.8, y: 0.5 },
  { name: 'centre (sphere)', x: 0.5, y: 0.38 },
  { name: 'centre-right', x: 0.62, y: 0.3 },
  { name: 'ground', x: 0.3, y: 0.62 },
]

// probeAsync resolves inside the frame that drew the pixel — a plain readback
// between frames returns black from the WebGPU canvas.
const probeGrid = (page, grid = GRID) =>
  page.evaluate(async (grid) => {
    const out = []
    for (const g of grid) {
      const p = await window.__cmp.probeAsync(g.x, g.y)
      out.push({ ...g, his: p.his, mine: p.mine, hisLin: p.hisLin, mineLin: p.mineLin, ratio: p.ratio })
    }
    return out
  }, grid)

const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : v === Infinity ? 'sat' : 'nan')
const fmtRatio = (r) => r.map(f3).join(' / ')

// The adapter can't be probed on about:blank in headless Chromium, so readiness
// is judged on the real page: if it never reports ready headless, retry headed.
const logs = []
async function launch() {
  for (const headless of [true, false]) {
    const browser = await chromium.launch({ headless, args: GPU_ARGS })
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
    await page.goto(`${BASE}20-bruneton-compare.html?mode=split&view=1`, { waitUntil: 'networkidle' })
    try {
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 120_000 })
      return { browser, page }
    } catch {
      await browser.close()
      console.warn(`page never became ready (headless=${headless}) — retrying`)
    }
  }
  throw new Error('WebGPU unavailable')
}

const { browser, page } = await launch()
const report = { base: BASE, views: {}, sweep: [] }
const md = ['# Bruneton vs @pmndrs/sky — headless report', '', `base: ${BASE}`, '']
await settle(page, 60)

for (const v of viewsArg) {
  await page.evaluate((n) => {
    window.__cmp.setView(n)
    window.__cmp.setMode('split')
  }, v)
  await settle(page, 60)
  await shot(page, `bruneton-view${v}-split`)
  await page.evaluate(() => window.__cmp.setMode('diff'))
  await settle(page, 10)
  await shot(page, `bruneton-view${v}-diff`)
  await page.evaluate(() => window.__cmp.setMode('split'))
  await settle(page, 5)
  const grid = await probeGrid(page)
  const state = await page.evaluate(() => ({ ...window.__cmp.state }))
  report.views[v] = { state, grid }
  md.push(`## View ${v}`, '', `sun zenith ${state.sunZenith.toFixed(3)} rad · exposure ${state.exposure}`, '')
  md.push('| point | his rgb8 | ours rgb8 | his linear | ours linear | ours/his |', '|---|---|---|---|---|---|')
  for (const g of grid) {
    md.push(
      `| ${g.name} | ${g.his.join(' ')} | ${g.mine.join(' ')} | ${g.hisLin.map(f3).join(' ')} | ${g.mineLin.map(f3).join(' ')} | ${fmtRatio(g.ratio)} |`,
    )
  }
  md.push('')
  console.log(
    `view ${v}: ` +
      grid
        .slice(0, 5)
        .map((g) => `${g.name} ${fmtRatio(g.ratio)}`)
        .join(' | '),
  )
}

if (doSweep) {
  // Sky sweep. His camera always looks at the origin from above, so the most
  // sky it can show is the top 25° of a horizontal view: zenith π/2 with the
  // camera 20 km out (sphere shrinks to ~3° at frame centre — probes avoid it),
  // sun 90° to the side so no probe lands in the disc, exposure 1 so only the
  // disc saturates. Probe elevations: +22°, +12°, +2° and +12° toward the sun.
  await page.evaluate(() => {
    const s = window.__cmp.state
    s.viewDistanceMeters = 20000
    s.viewZenith = Math.PI / 2
    s.viewAzimuth = Math.PI
    s.sunAzimuth = Math.PI / 2
    s.exposure = 1
    window.__cmp.setMode('split')
  })
  const SWEEP_POINTS = [
    { name: 'sky+22°', x: 0.5, y: 0.05 },
    { name: 'sky+12°', x: 0.5, y: 0.25 },
    { name: 'sky+2°', x: 0.5, y: 0.46 },
    { name: 'sky+12°→sun', x: 0.9, y: 0.25 },
  ]
  md.push('## Sun-elevation sweep (sky only, exposure 1, horizontal view, sun 90° to the right)', '')
  md.push(
    '| sun elev | ' + SWEEP_POINTS.map((p) => `${p.name} ours/his (r/g/b)`).join(' | ') + ' |',
    '|---|' + SWEEP_POINTS.map(() => '---').join('|') + '|',
  )
  for (const elev of [90, 75, 60, 45, 30, 15, 5, 0]) {
    await page.evaluate((e) => {
      window.__cmp.state.sunZenith = ((90 - e) * Math.PI) / 180
    }, elev)
    await settle(page, 40)
    if ([90, 45, 5].includes(elev)) await shot(page, `bruneton-sweep-elev${elev}`)
    const pts = await probeGrid(page, SWEEP_POINTS)
    report.sweep.push({ elev, pts })
    md.push(`| ${elev}° | ` + pts.map((p) => fmtRatio(p.ratio)).join(' | ') + ' |')
    console.log(`elev ${elev}: ` + pts.map((p) => `${p.name} ${fmtRatio(p.ratio)}`).join(' | '))
  }
  md.push('')
}

const errors = logs.filter((l) => /error|pageerror/i.test(l) && !BENIGN.test(l))
md.push('## Console', '', errors.length ? errors.map((e) => `- ${e}`).join('\n') : 'no errors', '')
fs.writeFileSync(`${OUT}bruneton-report.json`, JSON.stringify(report, null, 2))
fs.writeFileSync(`${OUT}bruneton-report.md`, md.join('\n'))
console.log(
  `\nwrote ${OUT}bruneton-report.md${errors.length ? `\n${errors.length} console error(s):\n${errors.join('\n')}` : ''}`,
)
await browser.close()
