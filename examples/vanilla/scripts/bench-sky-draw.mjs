/**
 * Live sky draw order A/B (17-sky-draw-bench.html): the library's default
 * (after opaques, no depth write) against drawing it first, with and without
 * a fragment depth write, in open and fully occluded scenes at ground level
 * and at 300 km. Needs a real GPU, so it runs headed Chrome.
 *
 *   pnpm --filter @pmndrs/sky-example-vanilla dev   # then:
 *   BASE=http://localhost:5173/ node scripts/bench-sky-draw.mjs
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:5173/'
const W = Number(process.env.W ?? 1600)
const H = Number(process.env.H ?? 900)
const DPR = Number(process.env.DPR ?? 2)

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR })
await page.goto(`${BASE}17-sky-draw-bench.html?dpr=${DPR}`)
await page.waitForFunction(() => window.__benchReady, null, { timeout: 60000 })
await page.waitForTimeout(1500)

const [w, h] = await page.evaluate(() => __bench.size())
const res = await page.evaluate(() => __bench.burst({ n: 120, rounds: 5 }))
console.log(`${w}×${h}, median ms/frame (burst, 5 rounds × 120 frames)\n`)
const variants = Object.keys(Object.values(res)[0])
console.log('scene'.padEnd(14) + variants.map((v) => v.padStart(13)).join(''))
for (const [scene, r] of Object.entries(res)) {
  console.log(scene.padEnd(14) + variants.map((v) => r[v].median.toFixed(3).padStart(13)).join(''))
}
await browser.close()
