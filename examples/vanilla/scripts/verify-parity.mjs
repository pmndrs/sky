/**
 * Runs the WGSL-core vs TSL-twin parity pages headless and prints each page's
 * PARITY line. Use after touching anything in src/core/wgsl or
 * src/backends/tsl — CLAUDE.md asks for this check and this is the automation.
 *
 *   BASE=http://localhost:5183/ node scripts/verify-parity.mjs [parity/12-skyview-lut.html ...]
 */
import { chromium } from 'playwright'
const BASE = process.env.BASE ?? 'http://localhost:5183/'
const DEFAULT_PAGES = [
  'parity/00-leaf-helpers.html',
  'parity/01-uv-maps.html',
  'parity/10-transmittance-lut.html',
  'parity/11-texture-sample.html',
  'parity/12-skyview-lut.html',
  'parity/13-multiscatter-lut.html',
]
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const browser = await chromium.launch({ headless: true, args: GPU_ARGS })
const pages = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PAGES
for (const path of pages) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 })
  const logs = []
  page.on('console', (m) => logs.push(m.text()))
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message))
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.querySelector('button')?.click())
  await new Promise((r) => setTimeout(r, 12000))
  const dom = await page.evaluate(() =>
    document.body.innerText
      .split('\n')
      .filter((l) => /PARITY|maxAbs|FAIL|PASS/.test(l))
      .join(' | '),
  )
  console.log(
    path,
    '=>',
    logs.filter((l) => /PARITY|FAIL|error/i.test(l) && !/Unexpected token/.test(l)).join(' | ') ||
      dom ||
      '(no parity line found)',
  )
  await page.close()
}
await browser.close()
