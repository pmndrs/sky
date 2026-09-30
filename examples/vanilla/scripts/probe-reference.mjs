/**
 * Step-driven prober for 20-reference-compare.html (formerly probe-bruneton.mjs,
 * the tool every number in research/bruneton-audit-2026-09-26.md came from).
 *
 * STEPS is a JSON array; each step may `js` (evaluated in the page, with
 * `window.__cmp` exposed), `wait` N frames (default 40), `shot` a screenshot
 * (to scripts/.verify-out/<name>.png) and `probe` a list of `[x, y, name]`
 * normalised screen points. Each probe prints linear radiance in Bruneton's
 * units for all three renderers (his by inverting his curve on 8 bits) and the
 * ratios ours/Bruneton, ours/Hillaire and Hillaire/Bruneton.
 *
 *   STEPS='[{"js":"window.__cmp.setView(3)","wait":50,"probe":[[0.5,0.08,"sky-T"]]}]' \
 *   URL=http://localhost:5173/20-reference-compare.html?layout=solo&solo=ours node scripts/probe-reference.mjs
 *
 * LOGLEN caps console lines (default 400 chars). See the page's `?dbg=` /
 * `?debug=` / `?bypass=` / `?near=` / `?far=` params for what to point it at.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
const OUT = new URL('./.verify-out/', import.meta.url).pathname
import('node:fs').then((m) => m.mkdirSync(OUT, { recursive: true }))
const url = process.env.URL || 'http://localhost:5173/20-reference-compare.html?view=1'
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
    const r = await page.evaluate(
      ({ pts, radius }) =>
        window.__cmp.probe(
          pts.map(([x, y, name]) => ({ x, y, name })),
          radius,
        ),
      { pts: s.probe, radius: +(s.radius ?? 1) },
    )
    const fe = (a) => a.map((v) => (Number.isFinite(v) ? v.toExponential(3) : f3(v))).join(' ')
    console.log(`--- ${s.label || s.js || ''}`)
    for (const p of r)
      console.log(
        `${p.name.padEnd(14)}${p.sky ? '' : ' [geometry]'} B ${fe(p.bruneton)}  H ${fe(p.sebh)}  O ${fe(p.ours)}` +
          `  O/B ${p.oursOverBruneton.map(f3).join(' ')}  O/H ${p.oursOverSebh.map(f3).join(' ')}  H/B ${p.sebhOverBruneton.map(f3).join(' ')}`,
      )
  }
}
console.log(logs.filter((l) => !/Unexpected token '<'|\[vite\]/.test(l)).join('\n'))
await browser.close()
