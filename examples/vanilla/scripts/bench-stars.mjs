/**
 * Headless A/B for 16-stars-bench.html: ms per frame for each sky background /
 * night-sky design at 1× and 2× pixel ratio, by day and night, plus the cost
 * of a sun-change re-bake split by stage.
 *
 *   pnpm --filter @pmndrs/sky-example-vanilla dev          # note the port
 *   BASE=http://localhost:5173/ node scripts/bench-stars.mjs
 *
 * Timing is `__bench.burst()`: back-to-back frames drained with
 * onSubmittedWorkDone, so each figure is ~max(CPU, GPU) per frame. Compare
 * modes against each other (and `none`) rather than reading absolutes.
 * HEADED=1 runs a visible window. Results + screenshots land in
 * scripts/.verify-out/.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:5173/'
const OUT = new URL('./.verify-out/', import.meta.url).pathname
fs.mkdirSync(OUT, { recursive: true })
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const W = Number(process.env.W ?? 1920)
const H = Number(process.env.H ?? 1080)

const browser = await chromium.launch({ headless: !process.env.HEADED, args: GPU_ARGS })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

await page.goto(`${BASE}16-stars-bench.html?inspector=0&dpr=1`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 60_000 })
const bench = (fn, arg) => page.evaluate(fn, arg)

const results = []
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : '-').padStart(8)
function record(label, res) {
  results.push({ label, res })
  console.log(`\n## ${label}`)
  console.log('mode          median     Δ none     Δ cube   spread')
  const none = res.none?.median
  const cube = res.cube?.median
  for (const [m, s] of Object.entries(res)) {
    console.log(
      `${m.padEnd(12)} ${fmt(s.median)}   ${fmt(none != null ? s.median - none : NaN)}   ${fmt(
        cube != null ? s.median - cube : NaN,
      )}   min ${s.min.toFixed(3)} ×${s.rounds}`,
    )
  }
}

for (const dpr of [1, 2]) {
  await bench((d) => window.__bench.setDpr(d), dpr)
  const [w, h] = await bench(() => window.__bench.size())
  const tag = `${w}×${h} (${((w * h) / 1e6).toFixed(1)} Mpx)`

  for (const m of ['cube', 'stars+mw']) {
    await bench((mode) => window.__bench.applyMode(mode), m)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${OUT}stars-bench-${m.replace(/\+/g, '_')}-dpr${dpr}.png` })
  }

  record(`ms/frame, night (sun −16°), ${tag}`, await bench(() => window.__bench.burst({ rounds: 5 })))

  await bench(() => window.__bench.setStarCount(50000))
  record(
    `ms/frame, 50k stars, ${tag}`,
    await bench(() => window.__bench.burst({ modes: ['none', 'cube', 'stars'], rounds: 5 })),
  )
  await bench(() => window.__bench.setStarCount(9000))

  // Daytime: the contrast fade collapses every star quad to zero size.
  await bench(() => window.__bench.setSun(20))
  record(
    `ms/frame, DAY (sun +20°) — stars should cost ~0, ${tag}`,
    await bench(() => window.__bench.burst({ modes: ['cube', 'stars+mw'], rounds: 5 })),
  )
  await bench(() => window.__bench.setSun(-16))

  record(
    `ms/frame, sun moving EVERY frame (SkyView + cube + PMREM + render), ${tag}`,
    await bench(() => window.__bench.burst({ modes: ['cube', 'stars+mw'], sunAnim: true, n: 60 })),
  )
}

const breakdown = await bench(() => window.__bench.bakeBreakdown())
results.push({ label: 'bake breakdown', res: breakdown })
console.log('\n## re-bake stage breakdown (ms per call; wall = drained, cpuSubmit = encode only)')
for (const [k, v] of Object.entries(breakdown))
  console.log(`${k.padEnd(12)} wall ${fmt(v.wall)}   cpuSubmit ${fmt(v.cpuSubmit)}`)

fs.writeFileSync(`${OUT}stars-bench.json`, JSON.stringify(results, null, 2))
const errors = logs.filter((l) => /error|pageerror/i.test(l) && !/Unexpected token '<'|DOCTYPE/.test(l))
if (errors.length) console.log('\nconsole errors:\n' + errors.join('\n'))
console.log(`\nscreenshots + json in ${OUT}`)
await browser.close()
