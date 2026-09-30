/**
 * Step-driven prober for 20-bruneton-compare.html — the tool every number in
 * research/bruneton-audit-2026-09-26.md came from.
 *
 * STEPS is a JSON array; each step may `js` (evaluated in the page, with
 * `window.__cmp` exposed), `wait` N frames (default 40), `shot` a screenshot
 * (to scripts/.verify-out/<name>.png) and `probe` a list of `[x, y, name]`
 * normalised screen points. Each probe prints both canvases' rgb8, the linear
 * radiance recovered by inverting his tone curve, and the ratio ours/his.
 *
 *   STEPS='[{"js":"window.__cmp.setView(3)","wait":50,"probe":[[0.5,0.08,"sky-T"]]}]' \
 *   URL=http://localhost:5183/20-bruneton-compare.html?mode=ours node scripts/probe-bruneton.mjs
 *
 * LOGLEN caps console lines (default 400 chars). See the page's `?dbg=` /
 * `?debug=` / `?bypass=` / `?near=` / `?far=` params for what to point it at.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
const OUT = new URL('./.verify-out/', import.meta.url).pathname
import('node:fs').then((m) => m.mkdirSync(OUT, { recursive: true }))
const url = process.env.URL || 'http://localhost:5183/20-bruneton-compare.html?mode=split&view=1'
const steps = JSON.parse(process.env.STEPS || '[]') // [{js, shot, probe:[[x,y,name]...]}]
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const browser = await chromium.launch({ headless: true, args: GPU_ARGS })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, +(process.env.LOGLEN || 400))}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message.slice(0, 600)}`))
const settle = (n) =>
  page.evaluate(
    (n) =>
      new Promise((r) => {
        let i = 0
        const f = () => (++i >= n ? r() : requestAnimationFrame(f))
        requestAnimationFrame(f)
      }),
    n,
  )
await page.goto(url, { waitUntil: 'networkidle' })
try {
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 })
} catch (e) {
  logs.push('[timeout] __ready never set')
}
await settle(60)
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : v === Infinity ? 'sat' : 'nan')
for (const s of steps) {
  if (s.js) await page.evaluate(s.js)
  await settle(s.wait ?? 40)
  if (s.shot) fs.writeFileSync(OUT + s.shot + '.png', await page.screenshot({ type: 'png' }))
  if (s.probe) {
    const r = await page.evaluate(async (pts) => {
      const out = []
      for (const [x, y, name] of pts) {
        const p = await window.__cmp.probeAsync(x, y)
        out.push({ name, his: p.his, mine: p.mine, hisLin: p.hisLin, mineLin: p.mineLin, ratio: p.ratio })
      }
      return out
    }, s.probe)
    console.log(`--- ${s.label || s.js || ''}`)
    for (const p of r)
      console.log(
        `${p.name.padEnd(14)} his ${p.his.join(',').padEnd(12)} ours ${p.mine.join(',').padEnd(12)} hisLin ${p.hisLin.map(f3).join(' ')}  oursLin ${p.mineLin.map(f3).join(' ')}  ratio ${p.ratio.map(f3).join(' ')}`,
      )
  }
}
console.log(logs.filter((l) => !/Unexpected token '<'|\[vite\]/.test(l)).join('\n'))
await browser.close()
