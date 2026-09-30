/**
 * Headless three-way check of 20-reference-compare.html: Bruneton 2017 (his
 * demo.js + precomputed tables), Hillaire 2020 (his HLSL compiled to WGSL,
 * with his path tracer) and @pmndrs/sky — one camera, one sun, one atmosphere,
 * everything in Bruneton's spectral-radiance units. All numbers are linear
 * ratios: Hillaire's and ours read from float targets, Bruneton's recovered by
 * inverting his display curve on his 8-bit output, at an exposure chosen per
 * case so that inversion stays in its accurate range.
 *
 *   1. Gates: Hillaire's Transmittance and Multi-scattering LUTs vs ours,
 *      texel for texel (ported literally; must match to ~0.1 % or the harness
 *      is broken).
 *   2. Views: Bruneton's nine plus free sky views — three-panel and diff
 *      screenshots, and a probe grid (sky points three-way, geometry points
 *      ours vs Bruneton only: Hillaire's panel has no sphere or ground).
 *   3. Sun sweep: zenith / mid / horizon sky, three-way.
 *   4. Hillaire's Sky-View LUT vs ours over a sun and an altitude sweep.
 *   5. Ground truth: Hillaire's path tracer against all three.
 *
 *   pnpm --filter @pmndrs/sky-example-vanilla dev          # note the port
 *   BASE=http://localhost:5173/ node scripts/verify-reference.mjs [--quick] [--strict] [--only bruneton|sebh] [--spp 4096]
 *
 * Exit code 1 if a gate fails, Bruneton's tables never load, or WebGPU reports
 * an error. --strict also fails when a Sky-View LUT sweep channel mean leaves
 * ±3 % of Hillaire's — a check on our port alone. View ratios against Bruneton
 * are reported, not gated: the two references disagree with each other by up
 * to ~10 % (e.g. at the zenith), and that is not ours to fix.
 * Output: scripts/.verify-out/ref-*.png and reference-report.{json,md}.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const OUT = new URL('./.verify-out/', import.meta.url).pathname
fs.mkdirSync(OUT, { recursive: true })
const BASE = process.env.BASE ?? 'http://localhost:5173/'
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']
const BENIGN = /Unexpected token '<'|DOCTYPE/
const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const QUICK = argv.includes('--quick')
const STRICT = argv.includes('--strict')
const ONLY = arg('--only', 'all')
const SPP = +arg('--spp', QUICK ? 1024 : 4096)
const run = (part) => ONLY === 'all' || ONLY === part

const GATE = { lo: 0.99, hi: 1.01 }
const STRICT_LUT = 0.03

const logs = []
async function launch() {
  for (const headless of [true, false]) {
    const browser = await chromium.launch({ headless, args: GPU_ARGS })
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 })
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
    await page.goto(`${BASE}20-reference-compare.html?dpr=1`, { waitUntil: 'networkidle' })
    try {
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 120_000 })
      await page.addStyleTag({ content: '.lil-gui { display: none !important }' })
      return { browser, page, headless }
    } catch {
      await browser.close()
      console.warn(`page never became ready (headless=${headless}) — retrying`)
    }
  }
  throw new Error('WebGPU unavailable or Bruneton tables missing (scripts/fetch-bruneton.mjs)')
}

const { browser, page, headless } = await launch()
const shot = async (name) => fs.writeFileSync(`${OUT}${name}.png`, await page.screenshot({ type: 'png' }))
const saveDataUrl = (name, url) => fs.writeFileSync(`${OUT}${name}.png`, Buffer.from(url.split(',')[1], 'base64'))
const setViewport = async (width, height) => {
  await page.setViewportSize({ width, height })
  await page.waitForFunction((w) => window.innerWidth === w, width)
}

const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : v === Infinity ? 'sat' : 'n/a')
const rgb = (a) => a.map(f3).join(' / ')
const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
const lr = (a, b) => lum(a) / lum(b)
const statMean = (s) => (s?.r ? [s.r.mean, s.g.mean, s.b.mean] : [NaN, NaN, NaN])
const statSpan = (s) =>
  s?.r ? `${f3(Math.min(s.r.p05, s.g.p05, s.b.p05))}–${f3(Math.max(s.r.p95, s.g.p95, s.b.p95))}` : 'n/a'

/**
 * Set up a case and render. The HUD's own readbacks are off; the sun disc is
 * off for numbers (Bruneton's, Hillaire's flat 1e6 and ours differ by design).
 */
const setup = (patch) =>
  page.evaluate(async (patch) => {
    const c = window.__cmp
    c.scripted(true)
    if (patch.view) c.setView(patch.view)
    Object.assign(c.state, patch.state ?? {})
    Object.assign(c.ui, patch.ui ?? {})
    if (patch.layout) c.setLayout(patch.layout, patch.layoutOpts ?? {})
    c.ours.sunDisc = patch.sunDisc ?? false
    c.oursSide.applyObjects()
    await c.frames(patch.frames ?? 4)
  }, patch)

/**
 * Probe, then re-probe at an exposure that puts the brightest Bruneton sample
 * near the middle of his curve (L · exposure ≈ 1), where inverting 8 bits is
 * most accurate. Exposure does not change Hillaire's or our linear values.
 */
const probe = async (points, r = 2) =>
  page.evaluate(
    async ({ points, r }) => {
      const c = window.__cmp
      let res = await c.probe(points, r)
      const max = Math.max(...res.flatMap((p) => p.bruneton.filter(Number.isFinite)), 1e-6)
      const exposure = Math.min(2000, Math.max(0.5, 1 / max))
      if (Math.abs(exposure / c.state.exposure - 1) > 0.25) {
        c.state.exposure = exposure
        await c.frames(4)
        res = await c.probe(points, r)
      }
      return res.map((p) => ({ ...p, exposure: c.state.exposure }))
    },
    { points, r },
  )

const report = {
  base: BASE,
  date: new Date().toISOString(),
  headless,
  spp: SPP,
  only: ONLY,
  gates: {},
  views: {},
  sunSweep: [],
  skyViewSweep: [],
  altitudeSweep: [],
  pathTracer: [],
}
const md = ['# Bruneton · Hillaire · @pmndrs/sky — headless report', '']

// ---------------------------------------------------------------------------
// Provenance
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
  return {
    adapter: c.sebh.adapterInfo,
    canPathTrace: c.sebh.canPathTrace,
    manifest,
    diffs,
    albedo: c.state.groundAlbedo,
  }
})
report.adapter = meta.adapter
report.params = meta.diffs
md.push(
  `base: ${BASE} · ${report.date} · headless ${headless} · GPU ${meta.adapter?.vendor ?? '?'} ${meta.adapter?.architecture ?? ''}`,
  meta.manifest
    ? `Hillaire source: ${meta.manifest.source.repo} @ ${meta.manifest.source.commit.slice(0, 12)} · Slang ${meta.manifest.slang} · ${meta.manifest.patches.length} documented source patch(es)`
    : 'Hillaire manifest not readable',
  'Bruneton source: examples/vanilla/public/bruneton/ (demo.js verbatim + precomputed tables)',
  '',
  `All three share one atmosphere. Ground albedo ${meta.albedo} (Bruneton's, baked into his tables) on Hillaire's side and ours.`,
  `Our EARTH vs Hillaire's SetupEarthAtmosphere: ${meta.diffs.length ? meta.diffs.map((d) => `${d.field} ${JSON.stringify(d.ours)} vs ${JSON.stringify(d.his)}`).join('; ') : 'identical'}.`,
  '',
)

// ---------------------------------------------------------------------------
// 1. Gates — Hillaire's camera- and sun-independent LUTs vs ours
// ---------------------------------------------------------------------------
const lutParity = (images = false) => page.evaluate((images) => window.__cmp.lutParity({ images }), images)
const gate = (s) =>
  !!s?.r && ['r', 'g', 'b'].every((c) => s[c].p05 >= GATE.lo && s[c].p95 <= GATE.hi && Number.isFinite(s[c].mean))

await setup({ view: 'sky', state: { groundAlbedo: meta.albedo }, ui: { sebhMethod: 'lut' }, layout: 'three' })
const base = await lutParity(true)
for (const [name, imgs] of Object.entries(base.images)) {
  for (const [k, url] of Object.entries(imgs)) saveDataUrl(`ref-lut-${name}-${k}`, url)
}
report.gates = {
  transmittance: { pass: gate(base.stats.transmittance.all), stats: base.stats.transmittance.all },
  multiScattering: { pass: gate(base.stats.multiScattering.all), stats: base.stats.multiScattering.all },
  rowOrder: base.flipped,
}
md.push(
  '## 1. Gates — Hillaire LUTs that must match ours exactly',
  '',
  `Every channel's p05 ≥ ${GATE.lo} and p95 ≤ ${GATE.hi}. A failure means the harness is wrong, not the sky.`,
  '',
  '| LUT | ours/Hillaire mean (r/g/b) | p05–p95 | gate |',
  '|---|---|---|---|',
  ...['transmittance', 'multiScattering'].map((n) => {
    const s = base.stats[n].all
    return `| ${n} | ${rgb(statMean(s))} | ${statSpan(s)} | ${report.gates[n].pass ? 'PASS' : '**FAIL**'} |`
  }),
  '',
)

// ---------------------------------------------------------------------------
// 2. Views
// ---------------------------------------------------------------------------
const GRID = [
  { name: 'high-L', x: 0.12, y: 0.08 },
  { name: 'high-C', x: 0.5, y: 0.06 },
  { name: 'high-R', x: 0.88, y: 0.08 },
  { name: 'mid-L', x: 0.12, y: 0.25 },
  { name: 'mid-R', x: 0.88, y: 0.25 },
  { name: 'low-L', x: 0.2, y: 0.4 },
  { name: 'low-R', x: 0.8, y: 0.4 },
  { name: 'centre', x: 0.5, y: 0.38 },
  { name: 'ground', x: 0.3, y: 0.62 },
]
if (run('bruneton')) {
  const viewKeys = await page.evaluate(() => Object.keys(window.__cmp.VIEWS))
  md.push(
    '## 2. Views',
    '',
    'Screenshots: `ref-view-<v>-three.png` (Bruneton | Hillaire | ours), `ref-view-<v>-diff-{bruneton,sebh}.png`',
    '(|reference − ours| × 4 on display values). Cells: luminance ratios; sky points show ours/B · ours/H · H/B,',
    'geometry points (marked ◼) ours/B only.',
    '',
    `| view | ${GRID.map((g) => g.name).join(' | ')} |`,
    `|---|${GRID.map(() => '---').join('|')}|`,
  )
  for (const v of QUICK ? ['1', '5', 'sky', 'zenith'] : viewKeys) {
    await setup({
      view: v,
      state: { groundAlbedo: meta.albedo },
      ui: { sebhMethod: v === '8' || v === '9' ? 'raymarch' : 'lut' },
      layout: 'three',
      sunDisc: true,
    })
    await shot(`ref-view-${v}-three`)
    for (const ref of ['bruneton', 'sebh']) {
      await setup({ layout: 'diff', layoutOpts: { diffA: ref, diffB: 'ours' }, sunDisc: true, frames: 2 })
      await shot(`ref-view-${v}-diff-${ref}`)
    }
    await setup({ layout: 'three' })
    const grid = await probe(GRID, 2)
    report.views[v] = grid
    const cell = (g) =>
      g.sky
        ? `${f3(lr(g.ours, g.bruneton))} · ${f3(lr(g.ours, g.sebh))} · ${f3(lr(g.sebh, g.bruneton))}`
        : `◼ ${f3(lr(g.ours, g.bruneton))}`
    md.push(`| ${v} | ${grid.map(cell).join(' | ')} |`)
    console.log(`view ${v}: ${grid.map((g) => `${g.name} ${cell(g)}`).join(' | ')}`)
  }
  md.push('')

  // -------------------------------------------------------------------------
  // 3. Sun sweep, three-way
  // -------------------------------------------------------------------------
  const TAN_HALF = Math.tan((50 / 2) * (Math.PI / 180))
  const PITCH = 12
  const yAt = (e) => (1 - Math.tan(((e - PITCH) * Math.PI) / 180) / TAN_HALF) / 2
  const SWEEP_POINTS = [
    { name: '+30°', x: 0.5, y: yAt(30) },
    { name: '+12°', x: 0.5, y: yAt(12) },
    { name: '+2°', x: 0.5, y: yAt(2) },
    { name: '+12° left', x: 0.1, y: yAt(12) },
  ]
  md.push(
    '## 3. Sun sweep — sky 90° to the side of the sun, three-way (r / g / b)',
    '',
    `Free camera at 500 m, pitch ${PITCH}°, sun 90° to the right.`,
    '',
    '| sun | point | ours / Bruneton | ours / Hillaire | Hillaire / Bruneton |',
    '|---|---|---|---|---|',
  )
  for (const el of QUICK ? [45, 5, -2] : [90, 60, 40, 25.78, 15, 8, 4, 2, 0, -2, -4]) {
    await setup({
      state: {
        cameraMode: 'free',
        heightM: 500,
        pitch: PITCH,
        sunZenith: ((90 - el) * Math.PI) / 180,
        sunAzimuth: 0,
        yaw: 90,
        groundAlbedo: meta.albedo,
      },
      ui: { sebhMethod: 'lut' },
      layout: 'three',
    })
    const pts = await probe(SWEEP_POINTS, 3)
    report.sunSweep.push({ sunElevation: el, pts })
    for (const p of pts) {
      md.push(
        `| ${el}° | ${p.name} | ${rgb(p.oursOverBruneton)} | ${rgb(p.oursOverSebh)} | ${rgb(p.sebhOverBruneton)} |`,
      )
    }
    console.log(
      `sun ${String(el).padStart(5)}°: ${pts.map((p) => `${p.name} O/B ${f3(lr(p.ours, p.bruneton))} O/H ${f3(lr(p.ours, p.sebh))}`).join(' | ')}`,
    )
  }
  md.push('')
}

// ---------------------------------------------------------------------------
// 4. Hillaire's Sky-View LUT vs ours
// ---------------------------------------------------------------------------
if (run('sebh')) {
  const REGIONS = ['all', 'zenithRows', 'towardSun', 'awayFromSun', 'horizonBand', 'belowHorizon']
  const regionRow = (label, st) => `| ${label} | ${REGIONS.map((r) => rgb(statMean(st[r]))).join(' | ')} |`
  const header = [`| case | ${REGIONS.join(' | ')} |`, `|---|${REGIONS.map(() => '---').join('|')}|`]
  md.push(
    '## 4. Sky-View LUT, texel for texel — ours / Hillaire (r / g / b means)',
    '',
    'Ground albedo 0 on both (his default): below the horizon his LUT leaves the ground out (`ground=false`)',
    'and ours adds its lit albedo, so any other value measures that design choice, not the integration.',
    '',
    'Regions: zenith = top 8 rows; toward/away = 24 columns at either end above the horizon; horizon band = 6 rows',
    'above it; below horizon = the lower half.',
    '',
    ...header,
  )
  for (const el of QUICK ? [60, 25.78, 5, -2] : [90, 60, 40, 25.78, 15, 8, 4, 2, 0, -2, -4]) {
    await setup({
      view: 'sky',
      state: { sunZenith: ((90 - el) * Math.PI) / 180, heightM: 500, groundAlbedo: 0 },
      ui: { sebhMethod: 'lut' },
    })
    const r = await lutParity(el === 2)
    if (el === 2) for (const [k, url] of Object.entries(r.images.skyView)) saveDataUrl(`ref-lut-skyView-sun2-${k}`, url)
    report.skyViewSweep.push({ sunElevation: el, stats: r.stats.skyView })
    md.push(regionRow(`sun ${el}°`, r.stats.skyView))
    console.log(`sky-view sun ${String(el).padStart(5)}°: all ${rgb(statMean(r.stats.skyView.all))}`)
  }
  md.push('', 'Altitude sweep, sun 25.78°:', '', ...header)
  for (const h of QUICK ? [10] : [2, 10, 30, 60, 90]) {
    await setup({ view: 'sky', state: { heightM: h * 1000, groundAlbedo: 0 }, ui: { sebhMethod: 'lut' } })
    const r = await lutParity(false)
    report.altitudeSweep.push({ heightKm: h, stats: r.stats.skyView })
    md.push(regionRow(`${h} km`, r.stats.skyView))
    console.log(`sky-view height ${String(h).padStart(3)} km: all ${rgb(statMean(r.stats.skyView.all))}`)
  }
  md.push('')

  // -------------------------------------------------------------------------
  // 5. Ground truth — Hillaire's path tracer
  // -------------------------------------------------------------------------
  if (meta.canPathTrace) {
    await setViewport(480, 270)
    const TAN_HALF = Math.tan((50 / 2) * (Math.PI / 180))
    const PITCH = 12
    const yAt = (e) => (1 - Math.tan(((e - PITCH) * Math.PI) / 180) / TAN_HALF) / 2
    const POINTS = [
      { name: '+2°', x: 0.5, y: yAt(2), elev: 2, az: 0 },
      { name: '+12°', x: 0.5, y: yAt(12), elev: 12, az: 0 },
      { name: '+30°', x: 0.5, y: yAt(30), elev: 30, az: 0 },
      { name: '+12° side', x: 0.1, y: yAt(12), elev: 12, az: 34 },
    ]
    const SAMPLES_PER_FRAME = 32
    md.push(
      '## 5. Ground truth — Hillaire’s path tracer',
      '',
      `${SPP} spp per case at 480×270, 13×13-pixel means, camera 500 m, pitch ${PITCH}°. Points within 5° of the sun`,
      'are skipped. "Hillaire LUT" is his real-time path; the path tracer has no multi-scattering approximation.',
      '',
      '| sun | facing | point | Bruneton / PT | Hillaire LUT / PT | ours / PT |',
      '|---|---|---|---|---|---|',
    )
    for (const el of QUICK ? [25.78, 2] : [60, 25.78, 10, 2, -2]) {
      for (const facing of ['sun', 'away']) {
        const rad = Math.PI / 180
        const dir = (e, a) => [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)]
        const pts = POINTS.filter((p) => {
          if (facing !== 'sun') return true
          const u = dir(p.elev * rad, p.az * rad)
          const s = dir(el * rad, 0)
          return Math.acos(Math.min(1, u[0] * s[0] + u[1] * s[1] + u[2] * s[2])) > 5 * rad
        })
        const state = {
          cameraMode: 'free',
          heightM: 500,
          pitch: PITCH,
          sunZenith: ((90 - el) * Math.PI) / 180,
          sunAzimuth: 0,
          yaw: facing === 'sun' ? 0 : 180,
          groundAlbedo: meta.albedo,
        }
        await setup({ state, ui: { sebhMethod: 'lut' }, layout: 'three' })
        const lut = await probe(pts, 6)
        await setup({
          state: { ...state, exposure: lut[0].exposure },
          ui: { sebhMethod: 'pathtrace', ptSamplesPerFrame: SAMPLES_PER_FRAME },
          frames: Math.ceil(SPP / SAMPLES_PER_FRAME) + 1,
        })
        const pt = await page.evaluate((p) => window.__cmp.probe(p, 6), pts)
        if (el === 25.78 || el === 2) await shot(`ref-pt-sun${el}-${facing}`)
        for (let i = 0; i < pts.length; i++) {
          const truth = pt[i].sebh
          const over = (v) => v.map((x, c) => x / truth[c])
          report.pathTracer.push({
            sunElevation: el,
            facing,
            point: pts[i].name,
            pt: truth,
            bruneton: lut[i].bruneton,
            hisLut: lut[i].sebh,
            ours: lut[i].ours,
          })
          md.push(
            `| ${el}° | ${facing} | ${pts[i].name} | ${rgb(over(lut[i].bruneton))} | ${rgb(over(lut[i].sebh))} | ${rgb(over(lut[i].ours))} |`,
          )
        }
        console.log(`path tracer sun ${el}° facing ${facing}: done`)
      }
    }
    md.push('')
    await setViewport(960, 540)
  } else {
    md.push('## 5. Ground truth — skipped', '', 'This adapter lacks `float32-blendable`; the path tracer needs it.', '')
  }
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------
await setup({
  view: '1',
  state: { groundAlbedo: meta.albedo },
  ui: { sebhMethod: 'lut' },
  layout: 'three',
  sunDisc: true,
})
await shot('ref-display-shared')
await page.evaluate(() => window.__cmp.setDisplay('shipped'))
await setup({ sunDisc: true, frames: 3 })
await shot('ref-display-shipped')
await page.evaluate(() => window.__cmp.setDisplay('shared'))
md.push(
  '## Display',
  '',
  '`ref-display-shared.png`: all three in Bruneton’s units through his curve. `ref-display-shipped.png`: each as its',
  'author ships it — Bruneton’s demo, Hillaire’s PostProcessPS (exposure 10, white point (1.082, 0.968, 0.950),',
  'gSunIlluminance 1), ours with the demo defaults (luminanceScale 40, ACES at 0.5). Same radiance, different mapping.',
  '',
)

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
const gpuErrors = await page.evaluate(() => window.__cmp.errors)
const consoleErrors = logs.filter((l) => /\[error\]|pageerror/i.test(l) && !BENIGN.test(l))
const strictFailures = []
if (STRICT) {
  for (const s of report.skyViewSweep) {
    statMean(s.stats.all).forEach((m, c) => {
      if (Math.abs(m - 1) > STRICT_LUT) strictFailures.push(`sky-view sun ${s.sunElevation}° ${'rgb'[c]} ${f3(m)}`)
    })
  }
}
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

fs.writeFileSync(`${OUT}reference-report.json`, JSON.stringify(report, null, 2))
fs.writeFileSync(`${OUT}reference-report.md`, md.join('\n'))
console.log(`\nwrote ${OUT}reference-report.md`)
console.log(failures.length ? `FAIL:\n  ${failures.join('\n  ')}` : `PASS${STRICT ? ' (strict)' : ''}`)
await browser.close()
process.exit(failures.length ? 1 : 0)
