/**
 * Shader-compile probe: which pipelines a page creates, how big their shaders
 * are, whether they were created synchronously (blocking the GPU process on a
 * cold cache — Chrome on Windows compiles WGSL → HLSL → DXC/FXC there), and
 * whether the generated WGSL is byte-identical across reloads (Chrome only
 * reuses a compiled shader for identical text).
 *
 *   pnpm --filter @pmndrs/sky-example-vanilla dev          # note the port
 *   BASE=http://localhost:5173/ node scripts/probe-shaders.mjs [page.html ...] [--runs 2] [--json out.json]
 *
 * Wall times are from macOS / Metal and only rank the programs; Windows
 * compile cost scales with shader size (see issue #49).
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(name)
  if (i < 0) return dflt
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const RUNS = Number(flag('--runs', 2))
const JSON_OUT = flag('--json', null)
const WAIT = Number(flag('--wait', 5000))
const BASE = process.env.BASE ?? 'http://localhost:5173/'
const pages = args.length
  ? args
  : ['04-live-sky.html', 'component-01-baked.html', '22-haze-shadows.html', '24-sky-fog.html']

const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal']

// Runs in the page before any script: wraps the GPUDevice entry points.
function instrument() {
  const log = { modules: [], pipelines: [], t0: performance.now() }
  window.__shaderProbe = log
  const modInfo = new WeakMap()
  const fnv = (s) => {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
    return h.toString(16).padStart(8, '0')
  }
  const where = () => {
    const lines = (new Error().stack || '').split('\n').slice(3)
    const ours = lines.filter((l) => /\/src\//.test(l) && !/node_modules/.test(l))
    return ours
      .slice(0, 3)
      .map((l) => (l.match(/\/src\/([^?:]+)[^:]*:(\d+)/) || []).slice(1, 3).join(':'))
      .filter(Boolean)
  }
  const P = GPUDevice.prototype
  const cSM = P.createShaderModule
  P.createShaderModule = function (desc) {
    const m = cSM.call(this, desc)
    const info = { label: desc.label || '', size: desc.code.length, hash: fnv(desc.code), code: desc.code }
    modInfo.set(m, info)
    log.modules.push(info)
    return m
  }
  const stagesOf = (desc) =>
    ['vertex', 'fragment', 'compute']
      .filter((s) => desc[s]?.module)
      .map((s) => {
        const i = modInfo.get(desc[s].module) || {}
        return { stage: s, size: i.size, hash: i.hash }
      })
  const wrap = (name, isAsync) => {
    const orig = P[name]
    P[name] = function (desc) {
      const rec = {
        kind: name.includes('Compute') ? 'compute' : 'render',
        sync: !isAsync,
        label: desc.label || '',
        stages: stagesOf(desc),
        at: performance.now() - log.t0,
        where: where(),
      }
      log.pipelines.push(rec)
      const t = performance.now()
      const out = orig.call(this, desc)
      if (isAsync) out.then(() => (rec.ms = performance.now() - t)).catch(() => (rec.error = true))
      else rec.ms = performance.now() - t
      return out
    }
  }
  wrap('createRenderPipeline', false)
  wrap('createComputePipeline', false)
  wrap('createRenderPipelineAsync', true)
  wrap('createComputePipelineAsync', true)
}

async function runPage(browser, page) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('console', (m) => m.type() === 'error' && !/Unexpected token '<'/.test(m.text()) && errors.push(m.text()))
  await p.addInitScript(instrument)
  await p.goto(BASE + page, { waitUntil: 'load', timeout: 60000 })
  await p.waitForTimeout(1000)
  await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => /start/i.test(b.textContent))?.click())
  await p.waitForTimeout(WAIT)
  const log = await p.evaluate(() => {
    const l = window.__shaderProbe
    return { modules: l.modules, pipelines: l.pipelines }
  })
  await ctx.close()
  return { ...log, errors }
}

const kb = (n) => (n / 1024).toFixed(1).padStart(6)
const browser = await chromium.launch({ headless: true, args: GPU_ARGS })
const report = {}
for (const page of pages) {
  const runs = []
  for (let r = 0; r < RUNS; r++) runs.push(await runPage(browser, page))
  const [a] = runs
  const sizeOf = (st) => st.reduce((s, x) => s + (x.size || 0), 0)
  const sync = a.pipelines.filter((x) => x.sync)
  console.log(`\n== ${page}: ${a.modules.length} modules, ${a.pipelines.length} pipelines (${sync.length} sync)`)
  if (a.errors.length) console.log('  errors:', a.errors.slice(0, 3))
  console.log('  sync  kind      ms    KB  label / source')
  for (const x of [...a.pipelines].sort((p, q) => sizeOf(q.stages) - sizeOf(p.stages))) {
    console.log(
      `  ${x.sync ? 'SYNC' : 'async'} ${x.kind.padEnd(7)} ${String(Math.round(x.ms ?? -1)).padStart(5)} ${kb(sizeOf(x.stages))}  ${x.label || '-'}  ${x.where.join(' < ')}`,
    )
  }
  if (runs.length > 1) {
    const key = (l) =>
      l.modules
        .map((m) => m.hash)
        .sort()
        .join(',')
    const same = runs.every((r) => key(r) === key(a))
    const hashes = new Set(a.modules.map((m) => m.hash))
    const drift = runs.slice(1).flatMap((r) => r.modules.filter((m) => !hashes.has(m.hash)))
    console.log(`  deterministic across ${runs.length} loads: ${same ? 'yes' : `NO (${drift.length} modules differ)`}`)
    if (!same) for (const m of drift.slice(0, 5)) console.log(`    differs: ${m.label || '-'} ${kb(m.size)} KB`)
  }
  report[page] = runs.map((r) => ({ ...r, modules: r.modules.map(({ code, ...m }) => m) }))
  if (JSON_OUT) {
    const dir = JSON_OUT.replace(/\.json$/, '') + '-wgsl'
    fs.mkdirSync(dir, { recursive: true })
    for (const m of a.modules)
      fs.writeFileSync(`${dir}/${page.replace('.html', '').replace(/[^A-Za-z0-9_-]/g, '_')}-${m.hash}.wgsl`, m.code)
  }
}
await browser.close()
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2))
