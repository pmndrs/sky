/**
 * Headless A/B of 21-sebh-compare.html: Hillaire's own HLSL (compiled to WGSL,
 * driven by sebh/SebhReference.js) against @pmndrs/sky, same atmosphere, same
 * camera, same sun. Every number is a linear ratio ours/his read from float
 * render targets — no tone-curve inversion, no 8-bit quantisation.
 *
 *   1. Harness sanity (gates): Transmittance and Multi-scattering LUTs texel for
 *      texel. Both are camera- and sun-independent integrals that we ported
 *      literally, so they must agree to ~0.1 %; if they don't, the harness is
 *      broken and nothing below means anything.
 *   2. Sky-View LUT, texel for texel, over a sun-elevation and an altitude sweep,
 *      split into zenith / toward-sun / away-from-sun / horizon / below-horizon.
 *   3. Seven views, his default composite (Sky-View LUT + AP volume): split and
 *      diff screenshots plus a probe grid.
 *   4. Ground truth: his spectral path tracer (no multi-scattering
 *      approximation) against his LUT path and ours — the "was he wrong or are
 *      we" question, answered per sun elevation.
 *
 *   pnpm --filter @pmndrs/sky-example-vanilla dev          # note the port
 *   BASE=http://localhost:5173/ node scripts/verify-sebh.mjs [--quick] [--strict] [--spp 4096]
 *
 * Exit code: 1 if a sanity gate fails or WebGPU reports an error. With
 * --strict, also 1 when any Sky-View LUT sweep channel mean leaves ±3 %.
 * Output: scripts/.verify-out/sebh-*.png and sebh-report.{json,md}.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const OUT = new URL('./.verify-out/', import.meta.url).pathname
fs.mkdirSync(OUT, { recursive: true })
const BASE = process.env.BASE ?? 'http://localhost:5173/'
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const BENIGN = /Unexpected token '<'|DOCTYPE/
const argv = process.argv.slice(2)
const QUICK = argv.includes('--quick')
const STRICT = argv.includes('--strict')
const SPP = argv.includes('--spp') ? +argv[argv.indexOf('--spp') + 1] : QUICK ? 1024 : 4096

const GATE = { lo: 0.99, hi: 1.01 } // p05 / p95 of every channel
const STRICT_BAND = 0.03

const logs = []
async function launch() {
  for (const headless of [true, false]) {
    const browser = await chromium.launch({ headless, args: GPU_ARGS })
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 })
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
    await page.goto(`${BASE}21-sebh-compare.html?mode=split&view=1`, { waitUntil: 'networkidle' })
    try {
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 120_000 })
      return { browser, page, headless }
    } catch {
      await browser.close()
      console.warn(`page never became ready (headless=${headless}) — retrying`)
    }
  }
  throw new Error('WebGPU unavailable')
}

const { browser, page, headless } = await launch()
const shot = async (name) => fs.writeFileSync(`${OUT}${name}.png`, await page.screenshot({ type: 'png' }))
const saveDataUrl = (name, url) => fs.writeFileSync(`${OUT}${name}.png`, Buffer.from(url.split(',')[1], 'base64'))

const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : 'n/a')
const rgb = (a) => a.map(f3).join(' / ')
const statMean = (s) => (s?.r ? [s.r.mean, s.g.mean, s.b.mean] : [NaN, NaN, NaN])
const statSpan = (s) =>
  s?.r ? `${f3(Math.min(s.r.p05, s.g.p05, s.b.p05))}–${f3(Math.max(s.r.p95, s.g.p95, s.b.p95))}` : 'n/a'

// Everything numeric runs with the loop paused and the sun disc off (his disc
// is a flat 1e6, ours a shaped one — neither belongs in a sky-radiance ratio).
const setup = (patch) =>
  page.evaluate(async (patch) => {
    const c = window.__cmp
    c.pause(true)
    if (patch.view) c.setView(patch.view)
    Object.assign(c.state, { sunDisc: false, ...patch.state })
    Object.assign(c.ui, patch.ui ?? {})
    if (patch.mode) c.setMode(patch.mode)
    await c.renderFrames(patch.frames ?? 2)
  }, patch)

const report = {
  base: BASE,
  date: new Date().toISOString(),
  headless,
  spp: SPP,
  gates: {},
  params: {},
  skyViewSweep: [],
  altitudeSweep: [],
  views: {},
  pathTracer: [],
}
const md = ['# Hillaire reference vs @pmndrs/sky — headless report', '']

// ---------------------------------------------------------------------------
// Provenance + parameters
// ---------------------------------------------------------------------------
const meta = await page.evaluate(async () => {
  const c = window.__cmp
  const manifest = await (
    await fetch(new URL('./sebh/generated/manifest.json', location.href))
  )
    .json()
    .catch(() => null)
  const toArr = (v) => (v && typeof v === 'object' && 'x' in v ? [v.x, v.y, v.z] : v)
  const diffs = []
  for (const [k, his] of Object.entries(c.SEBH_EARTH)) {
    const ours = toArr(c.EARTH[k])
    if (JSON.stringify(ours) !== JSON.stringify(his)) diffs.push({ field: k, ours, his })
  }
  return { adapter: c.sebh.adapterInfo, canPathTrace: c.sebh.canPathTrace, manifest, diffs }
})
report.adapter = meta.adapter
report.params = meta.diffs
md.push(
  `base: ${BASE} · ${report.date} · headless ${headless} · GPU ${meta.adapter?.vendor ?? '?'} ${meta.adapter?.architecture ?? ''}`,
  meta.manifest
    ? `his source: ${meta.manifest.source.repo} @ ${meta.manifest.source.commit.slice(0, 12)} · Slang ${meta.manifest.slang} · ${meta.manifest.patches.length} documented source patch(es)`
    : 'manifest not readable',
  '',
  '## Atmosphere parameters: ours (EARTH) vs his (SetupEarthAtmosphere)',
  '',
  meta.diffs.length
    ? [
        '| field | ours | his |',
        '|---|---|---|',
        ...meta.diffs.map((d) => `| ${d.field} | ${JSON.stringify(d.ours)} | ${JSON.stringify(d.his)} |`),
        '',
        'Every comparison below runs both sides on **his** values (ground albedo 0), so it measures the',
        'integration, not the preset. Our shipped albedo is a separate, deliberate difference.',
      ].join('\n')
    : 'identical',
  '',
)

// ---------------------------------------------------------------------------
// 1 + 2. LUT parity
// ---------------------------------------------------------------------------
const lutParity = (images = false) => page.evaluate((images) => window.__cmp.lutParity({ images }), images)

await setup({ view: '1', ui: { method: 'lut' }, state: { groundAlbedo: 0 } })
const base = await lutParity(true)
for (const [name, imgs] of Object.entries(base.images)) {
  for (const [k, url] of Object.entries(imgs)) saveDataUrl(`sebh-lut-${name}-${k}`, url)
}
const gate = (s) =>
  !!s?.r && ['r', 'g', 'b'].every((c) => s[c].p05 >= GATE.lo && s[c].p95 <= GATE.hi && Number.isFinite(s[c].mean))
report.gates = {
  transmittance: { pass: gate(base.stats.transmittance.all), stats: base.stats.transmittance.all },
  multiScattering: { pass: gate(base.stats.multiScattering.all), stats: base.stats.multiScattering.all },
  rowOrder: base.flipped,
}
md.push(
  '## 1. Harness sanity — LUTs that must match exactly',
  '',
  `Gate: every channel's p05 ≥ ${GATE.lo} and p95 ≤ ${GATE.hi}. These integrals are camera- and sun-independent and were`,
  'ported literally; a failure here means the harness is wrong, not the sky.',
  '',
  '| LUT | ours/his mean (r/g/b) | p05–p95 | min–max | gate |',
  '|---|---|---|---|---|',
)
for (const name of ['transmittance', 'multiScattering']) {
  const s = base.stats[name].all
  md.push(
    `| ${name} | ${rgb(statMean(s))} | ${statSpan(s)} | ${f3(Math.min(s.r.min, s.g.min, s.b.min))}–${f3(Math.max(s.r.max, s.g.max, s.b.max))} | ${report.gates[name].pass ? 'PASS' : '**FAIL**'} |`,
  )
}
md.push(
  '',
  'Heatmaps: `sebh-lut-<name>-{his,ours,ratio}.png` (ratio: log2, blue darker / red brighter, ±0.5 stop).',
  '',
)

const REGIONS = ['all', 'zenithRows', 'towardSun', 'awayFromSun', 'horizonBand', 'belowHorizon']
const regionRow = (label, st) => `| ${label} | ${REGIONS.map((r) => rgb(statMean(st[r]))).join(' | ')} |`
const regionHeader = [`| case | ${REGIONS.join(' | ')} |`, `|---|${REGIONS.map(() => '---').join('|')}|`]

md.push(
  '## 2. Sky-View LUT, texel for texel (ours/his, r / g / b means)',
  '',
  'Camera 0.5 km. Regions: zenith = top 8 rows; toward/away = 24 columns at either end, above the horizon;',
  'horizon band = 6 rows above it; below horizon = the lower half.',
  '',
  ...regionHeader,
)
const SUN_SWEEP = QUICK ? [60, 25.78, 5, -2] : [90, 60, 40, 25.78, 15, 8, 4, 2, 0, -2, -4]
for (const el of SUN_SWEEP) {
  await setup({ view: '1', ui: { method: 'lut' }, state: { groundAlbedo: 0, sunEl: el, height: 0.5 } })
  const r = await lutParity(el === 2)
  if (el === 2) for (const [k, url] of Object.entries(r.images.skyView)) saveDataUrl(`sebh-lut-skyView-sun2-${k}`, url)
  report.skyViewSweep.push({ sunElevation: el, stats: r.stats.skyView })
  md.push(regionRow(`sun ${el}°`, r.stats.skyView))
  console.log(`sky-view sun ${String(el).padStart(5)}°: all ${rgb(statMean(r.stats.skyView.all))}`)
}
md.push('', 'Altitude sweep, sun 25.78°:', '', ...regionHeader)
const ALT_SWEEP = QUICK ? [10] : [2, 10, 30, 60, 90]
for (const h of ALT_SWEEP) {
  await setup({ view: '1', ui: { method: 'lut' }, state: { groundAlbedo: 0, sunEl: 25.78, height: h, forward: 0 } })
  const r = await lutParity(false)
  report.altitudeSweep.push({ heightKm: h, stats: r.stats.skyView })
  md.push(regionRow(`${h} km`, r.stats.skyView))
  console.log(`sky-view height ${String(h).padStart(3)} km: all ${rgb(statMean(r.stats.skyView.all))}`)
}
md.push('')

// ---------------------------------------------------------------------------
// 3. Views — his default composite
// ---------------------------------------------------------------------------
const GRID = [
  { name: 'high-L', x: 0.15, y: 0.1 },
  { name: 'high-C', x: 0.5, y: 0.1 },
  { name: 'high-R', x: 0.85, y: 0.1 },
  { name: 'mid-L', x: 0.15, y: 0.3 },
  { name: 'mid-C', x: 0.5, y: 0.3 },
  { name: 'mid-R', x: 0.85, y: 0.3 },
  { name: 'low-L', x: 0.15, y: 0.45 },
  { name: 'low-C', x: 0.5, y: 0.45 },
  { name: 'low-R', x: 0.85, y: 0.45 },
  { name: 'below', x: 0.5, y: 0.75 },
]
const views = await page.evaluate(() => Object.entries(window.__cmp.VIEWS).map(([k, v]) => [k, v.label]))
md.push(
  '## 3. Views — his default composite (Sky-View LUT + AP volume) vs ours',
  '',
  'Probe = 5×5 mean. Screenshots: `sebh-view<N>-split.png` (his left), `sebh-view<N>-diff.png` (|his − ours| × 4 after',
  "each side's display curve — his PostProcessPS on both).",
  '',
  `| view | ${GRID.map((g) => g.name).join(' | ')} |`,
  `|---|${GRID.map(() => '---').join('|')}|`,
)
for (const [n, label] of QUICK ? views.slice(0, 2) : views) {
  // The space view is past his Sky-View LUT's range; his demo shows the AP
  // volume there, which only covers 128 km — the per-pixel raymarch is the
  // meaningful reference.
  const method = n === '7' ? 'raymarch' : 'lut'
  await setup({ view: n, ui: { method }, state: { groundAlbedo: 0 }, mode: 'split' })
  await shot(`sebh-view${n}-split`)
  await setup({ mode: 'diff', frames: 1 })
  await shot(`sebh-view${n}-diff`)
  await setup({ mode: 'split', frames: 1 })
  const grid = await page.evaluate((g) => window.__cmp.probeHdr(g, 2), GRID)
  report.views[n] = { label, method, grid }
  const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
  md.push(
    `| ${n} ${label}${method !== 'lut' ? ` (his ${method})` : ''} | ${grid.map((g) => f3(lum(g.ours) / lum(g.his))).join(' | ')} |`,
  )
  console.log(`view ${n}: ${grid.map((g) => `${g.name} ${f3(g.ratio[1])}`).join(' ')}`)
}
md.push('', 'Cells are luminance ratios ours/his (Rec. 709 weights); per-channel values are in the JSON.', '')

// ---------------------------------------------------------------------------
// 4. Ground truth — his path tracer
// ---------------------------------------------------------------------------
if (meta.canPathTrace) {
  await page.setViewportSize({ width: 480, height: 270 })
  await page.waitForFunction(() => window.innerWidth === 480)
  const TAN_HALF = Math.tan((66.6 / 2) * (Math.PI / 180))
  const yAt = (elevDeg) => (1 - Math.tan((elevDeg * Math.PI) / 180) / TAN_HALF) / 2
  const POINTS = [
    { name: '+2°', x: 0.5, y: yAt(2), elev: 2, az: 0 },
    { name: '+12°', x: 0.5, y: yAt(12), elev: 12, az: 0 },
    { name: '+30°', x: 0.5, y: yAt(30), elev: 30, az: 0 },
    { name: '+12° side', x: 0.12, y: yAt(12), elev: 12, az: -40 },
  ]
  md.push(
    '## 4. Ground truth — his path tracer',
    '',
    `${SPP} spp per case at 480×270, 13×13-pixel means, camera 0.5 km looking horizontally. "his LUT / PT" is the error of`,
    'his real-time method against his own ground truth; "ours / PT" is ours against the same truth. Points within 5° of',
    'the sun are skipped.',
    '',
    '| sun | facing | point | his LUT / PT (r / g / b) | ours / PT (r / g / b) | ours / his LUT |',
    '|---|---|---|---|---|---|',
  )
  const SUNS = QUICK ? [25.78, 2] : [60, 25.78, 10, 2, -2]
  for (const el of SUNS) {
    for (const facing of ['sun', 'away']) {
      const yaw = facing === 'sun' ? 0 : 180
      // Skip probes that sit on the sun: angle between probe direction and sun.
      const pts = POINTS.filter((p) => {
        if (facing !== 'sun') return true
        const d = (e, a) => [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)]
        const rad = Math.PI / 180
        const u = d(p.elev * rad, p.az * rad)
        const s = d(el * rad, 0)
        return Math.acos(Math.min(1, u[0] * s[0] + u[1] * s[1] + u[2] * s[2])) > 5 * rad
      })
      const state = { groundAlbedo: 0, sunEl: el, sunAz: 0, height: 0.5, forward: 0, pitch: 0, yaw }
      await setup({ ui: { method: 'lut' }, state })
      const lut = await page.evaluate((p) => window.__cmp.probeHdr(p, 6), pts)
      await setup({ ui: { method: 'pathtrace' }, state, frames: SPP })
      const pt = await page.evaluate((p) => window.__cmp.probeHdr(p, 6), pts)
      if (el === 25.78 || el === 2) await shot(`sebh-pt-sun${el}-${facing}`)
      for (let i = 0; i < pts.length; i++) {
        const ptHis = pt[i].his
        const hisLut = lut[i].his.map((v, c) => v / ptHis[c])
        const ours = pt[i].ours.map((v, c) => v / ptHis[c])
        const oursVsLut = lut[i].ours.map((v, c) => v / lut[i].his[c])
        report.pathTracer.push({
          sunElevation: el,
          facing,
          point: pts[i].name,
          pt: ptHis,
          hisLut: lut[i].his,
          ours: pt[i].ours,
        })
        md.push(`| ${el}° | ${facing} | ${pts[i].name} | ${rgb(hisLut)} | ${rgb(ours)} | ${rgb(oursVsLut)} |`)
      }
      console.log(`path tracer sun ${el}° facing ${facing}: done`)
    }
  }
  md.push('')
  await page.setViewportSize({ width: 960, height: 540 })
  await page.waitForFunction(() => window.innerWidth === 960)
} else {
  md.push('## 4. Ground truth — skipped', '', 'This adapter lacks `float32-blendable`; his path tracer needs it.', '')
}

// ---------------------------------------------------------------------------
// Display: what the shipped demo defaults do to the same sky
// ---------------------------------------------------------------------------
await setup({ view: '1', ui: { method: 'lut' }, state: { groundAlbedo: 0, sunDisc: true }, mode: 'split' })
await shot('sebh-display-his-curve')
await page.evaluate(() => window.__cmp.setDisplay('shipped demo (LS 40, ACES 0.5)'))
await setup({ frames: 2 })
await shot('sebh-display-shipped-demo')
await page.evaluate(() => window.__cmp.setDisplay('his curve'))
md.push(
  '## Display',
  '',
  '`sebh-display-his-curve.png`: both sides through his PostProcessPS (exposure 10, white point (1.082, 0.968, 0.950)).',
  '`sebh-display-shipped-demo.png`: ours with the demo defaults (luminanceScale 40, ACES at 0.5) next to his curve —',
  'the radiance is the same as in the first image; only the display mapping differs.',
  '',
)

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
const gpuErrors = await page.evaluate(() => window.__cmp.errors)
const consoleErrors = logs.filter((l) => /\[error\]|pageerror/i.test(l) && !BENIGN.test(l))
const strictFailures = STRICT
  ? report.skyViewSweep.flatMap((s) =>
      statMean(s.stats.all)
        .map((m, c) => (Math.abs(m - 1) > STRICT_BAND ? `sky-view sun ${s.sunElevation}° ${'rgb'[c]} ${f3(m)}` : null))
        .filter(Boolean),
    )
  : []
const failures = [
  ...Object.entries(report.gates)
    .filter(([, g]) => g.pass === false)
    .map(([k]) => `${k} LUT gate`),
  ...gpuErrors.map((e) => `WebGPU: ${e.split('\n')[0]}`),
  ...strictFailures,
]
report.failures = failures
md.push('## Console', '', consoleErrors.length ? consoleErrors.map((e) => `- ${e}`).join('\n') : 'no errors', '')
md.push(
  '## Verdict',
  '',
  failures.length ? failures.map((f) => `- FAIL ${f}`).join('\n') : `PASS${STRICT ? ' (strict)' : ''}`,
  '',
)

fs.writeFileSync(`${OUT}sebh-report.json`, JSON.stringify(report, null, 2))
fs.writeFileSync(`${OUT}sebh-report.md`, md.join('\n'))
console.log(`\nwrote ${OUT}sebh-report.md`)
console.log(failures.length ? `FAIL:\n  ${failures.join('\n  ')}` : `PASS${STRICT ? ' (strict)' : ''}`)
await browser.close()
process.exit(failures.length ? 1 : 0)
