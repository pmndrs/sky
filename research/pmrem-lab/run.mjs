// Playwright runner for the lab pages. Serve this folder first:
//   python3 -m http.server 5218 --directory research/pmrem-lab
//   node research/pmrem-lab/run.mjs timing.html         (Phase 1 timing)
//   node research/pmrem-lab/run.mjs quality.html        (Phase 2 quality vs reference)
//   node research/pmrem-lab/run.mjs bench               (Phase 0: three r185 / r186 / dev)
import { chromium } from '../../examples/vanilla/node_modules/playwright/index.mjs'

const BASE = process.env.BASE ?? 'http://localhost:5218/'
const GPU = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const target = process.argv[2] ?? 'timing.html'
const pages = target === 'bench' ? ['bench-r185.html', 'bench-r186.html', 'bench-dev.html'] : [target]

const browser = await chromium.launch({ headless: true, args: GPU })
for (const page of pages) {
  const p = await browser.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.text()))
  await p.goto(BASE + page)
  try {
    await p.waitForFunction(() => window.__result, null, { timeout: 600000 })
    const r = await p.evaluate(() => window.__result)
    if (Array.isArray(r)) console.table(r)
    else if (r && Object.values(r).every(Array.isArray))
      for (const [k, v] of Object.entries(r)) v.length && (console.log(k), console.table(v))
    else console.log(page, JSON.stringify(r))
  } catch (e) {
    console.log(page, 'FAILED', String(e).split('\n')[0])
  }
  if (errs.length) console.log(errs.slice(0, 6).join('\n'))
  await p.close()
}
await browser.close()
