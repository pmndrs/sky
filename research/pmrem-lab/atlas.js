// CubeUV atlas writer (three r185 / r186), validated end to end in three.
// Loaded by atlas-r185.html / atlas-r186.html (import map picks the three).
//   1. layout: our pack of the copy level vs three's level-0 tile, texel for
//      texel; what three leaves outside the tiles
//   2. per atlas level: ours vs three (interior and border texels separately)
//   3. sphere grid rendered by three's own material sampling
//      (pmremTexture → textureCubeUV) with three's atlas, then with ours copied
//      into three's atlas texture, vs a truth grid (per-column reference cubes
//      at the column's exact roughness)
//   4. timing: our level prefilter + pack vs three fromCubemap
import * as THREE from 'three/webgpu'
import {
  Fn,
  vec2,
  vec3,
  vec4,
  float,
  floor,
  dot,
  sqrt,
  max,
  cos,
  sin,
  select,
  screenCoordinate,
  pmremTexture,
} from 'three/tsl'
import { Lab, cubeUVLayout, cubeUVLevels, errStats, imageDiff } from './lab.js'

const V = window.__v
const SIZE = 256
const CELL = 48
const W = 11 * CELL
const H = 4 * CELL
const Q = new URLSearchParams(location.search)
const SKIES = Q.has('timing')
  ? []
  : (Q.get('skies')?.split(',') ?? ['noon', 'golden', 'sunset', 'twilight', 'nautical', 'milkyway'])
const VARIANTS = {
  ours: cubeUVLevels(SIZE),
  'ours, 0.305 integ 32²': cubeUVLevels(SIZE, { plan: (_, r) => (r > 0.3 && r < 0.31 ? { integ: 32 } : null) }),
  'ours, unpadded (s² levels)': cubeUVLevels(SIZE, { pad: false }),
  'ours, L1 FIS 96': cubeUVLevels(SIZE, { plan: (i) => (i === 1 ? { fis: 96 } : null) }),
  'ours, L1+L2 FIS 128': cubeUVLevels(SIZE, { plan: (i) => (i === 1 || i === 2 ? { fis: 128 } : null) }),
}
if (Q.has('extra')) {
  VARIANTS['ours, FIS 512'] = cubeUVLevels(SIZE, { fis: 512 })
  VARIANTS['ours, FIS 256 bias +1'] = cubeUVLevels(SIZE, { plan: (_, r) => (r <= 0.25 ? { bias: 1 } : null) })
  VARIANTS['ours, FIS 1024'] = cubeUVLevels(SIZE, { fis: 1024 })
}
if (Q.has('quick'))
  for (const k of Object.keys(VARIANTS)) k !== 'ours' && !(Q.has('extra') && k.includes('FIS')) && delete VARIANTS[k]

const renderer = new THREE.WebGPURenderer({ antialias: false })
renderer.setSize(64, 64)
renderer.toneMapping = THREE.NoToneMapping
document.body.appendChild(renderer.domElement)
await renderer.init()
const device = renderer.backend.device
const lab = new Lab(device)
const gpuTex = (t) => renderer.backend.get(t).texture
const sync = () => device.queue.onSubmittedWorkDone()
const L = cubeUVLayout(SIZE)

const srcRT = new THREE.CubeRenderTarget(SIZE, {
  type: THREE.HalfFloatType,
  generateMipmaps: false,
  minFilter: THREE.LinearFilter,
  depthBuffer: false,
})
new THREE.CubeCamera(0.1, 10, srcRT).update(renderer, new THREE.Scene()) // allocates it
const gen = new THREE.PMREMGenerator(renderer)
let target = null

const loadSky = async (name) => {
  const data = new Uint16Array(await (await fetch(`./captures/${name}.bin`)).arrayBuffer())
  const src = lab.makeSourceFromData(SIZE, data)
  lab.generateMips(src, SIZE)
  const e = device.createCommandEncoder()
  e.copyTextureToTexture({ texture: src }, { texture: gpuTex(srcRT.texture) }, [SIZE, SIZE, 6])
  device.queue.submit([e.finish()])
  return src
}

// ---- three's material sampling: sphere grid into a half-float target ----
const gridRT = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false })
gridRT.texture.colorSpace = THREE.LinearSRGBColorSpace
let quad = null
const renderThreeGrid = async () => {
  if (!quad) {
    const mat = new THREE.NodeMaterial()
    mat.blending = THREE.NoBlending
    mat.depthTest = false
    mat.depthWrite = false
    mat.fragmentNode = Fn(() => {
      const pc = screenCoordinate.xy
      const col = floor(pc.x.div(CELL))
      const row = floor(pc.y.div(CELL))
      const local = pc.sub(vec2(col, row).mul(CELL)).div(CELL).mul(2).sub(1)
      const rr = dot(local, local)
      const n = vec3(local.x, local.y.negate(), sqrt(max(float(1).sub(rr), 0)))
      const R = n.mul(n.z.mul(2)).sub(vec3(0, 0, 1))
      const yaw = row.mul(1.5707963)
      const Rw = vec3(
        R.x.mul(cos(yaw)).add(R.z.mul(sin(yaw))),
        R.y,
        R.x
          .negate()
          .mul(sin(yaw))
          .add(R.z.mul(cos(yaw))),
      )
      const c = pmremTexture(target.texture, Rw, col.div(10))
      return vec4(select(rr.lessThan(1), c, vec3(0)), 1)
    })()
    quad = new THREE.QuadMesh(mat)
  }
  renderer.setRenderTarget(gridRT)
  quad.render(renderer)
  renderer.setRenderTarget(null)
  await sync()
  return lab.readTexture2D(gpuTex(gridRT.texture), W, H)
}

// ---- truth: per-column reference cubes at the exact column roughness ----
const REF_OPTS = [
  null, // r = 0: the source itself
  { size: 256, mode: 'is', samples: 16384, split: 4 },
  { size: 128, mode: 'integ', intSize: 128, split: 4 },
  { size: 64, mode: 'integ', intSize: 64 },
  ...Array.from({ length: 7 }, () => ({ size: 64, mode: 'integ', intSize: 64 })),
]
const truthImg = device.createTexture({
  size: [W, H],
  format: 'rgba32float',
  usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
})
const renderTruth = async (src) => {
  let roughest = null
  for (let c = 0; c <= 10; c++) {
    const o = REF_OPTS[c]
    const ref = o ? await lab.referenceLevel(src, SIZE, o.size, c / 10, o) : null
    const view = ref
      ? ref.createView({ dimension: 'cube' })
      : src.createView({ dimension: 'cube', baseMipLevel: 0, mipLevelCount: 1 })
    const e = device.createCommandEncoder()
    lab.encodeSpheresHDR(e, truthImg, view, CELL, [c], 0)
    device.queue.submit([e.finish()])
    await sync()
    if (c === 10) roughest = await lab.readLevel(ref, 0, o.size)
    ref?.destroy()
  }
  const exposure = 0.5 / Math.max(roughest.reduce((a, b) => a + b, 0) / roughest.length, 1e-6)
  return { hdr: await lab.readTexture2D(truthImg, W, H, 'rgba32float'), exposure }
}

// ---- helpers ----
const toImg = (hdr, exposure) => {
  const data = new Uint8Array(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    for (let k = 0; k < 3; k++) {
      const x = Math.max(hdr[i * 4 + k], 0) * exposure
      data[i * 4 + k] = Math.round(255 * Math.pow(x / (1 + x), 1 / 2.2))
    }
    data[i * 4 + 3] = 255
  }
  return { data, w: W, h: H, cell: CELL }
}
// Sphere pixels whose reflection direction lies within 10% of a cube face edge.
const seamMask = (() => {
  const m = new Uint8Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const lx = (((x % CELL) + 0.5) / CELL) * 2 - 1
      const ly = (((y % CELL) + 0.5) / CELL) * 2 - 1
      const rr = lx * lx + ly * ly
      if (rr >= 1) continue
      const n = [lx, -ly, Math.sqrt(1 - rr)]
      const R = [2 * n[2] * n[0], 2 * n[2] * n[1], 2 * n[2] * n[2] - 1]
      const yaw = Math.floor(y / CELL) * 1.5707963
      const d = [R[0] * Math.cos(yaw) + R[2] * Math.sin(yaw), R[1], -R[0] * Math.sin(yaw) + R[2] * Math.cos(yaw)]
      const a = d.map(Math.abs).sort((p, q) => q - p)
      m[y * W + x] = a[1] / a[0] > 0.9 ? 2 : 1
    }
  return m
})()
const diffBy = (a, b, want) => {
  const v = []
  for (let i = 0; i < W * H; i++) {
    if (seamMask[i] !== want) continue
    v.push(Math.max(...[0, 1, 2].map((k) => Math.abs(a.data[i * 4 + k] - b.data[i * 4 + k]))))
  }
  v.sort((p, q) => p - q)
  return {
    mean: +(v.reduce((s, q) => s + q, 0) / v.length).toFixed(2),
    p99: v[Math.floor(v.length * 0.99)],
    max: v[v.length - 1],
  }
}
const fmt = (s) => `${s.mean} / ${s.p99} / ${s.max}`
const lum = (a, i) => 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2]
// Luminance of one atlas level's texels, split into interior and 1-texel border.
const tileLum = (atlas, t) => {
  const inner = []
  const border = []
  for (let y = 0; y < 2 * t.size; y++)
    for (let x = 0; x < 3 * t.size; x++) {
      const p = x % t.size
      const q = y % t.size
      const v = lum(atlas, ((t.y + y) * L.width + t.x + x) * 4)
      ;(p === 0 || q === 0 || p === t.size - 1 || q === t.size - 1 ? border : inner).push(v)
    }
  return { inner: Float32Array.from(inner), border: Float32Array.from(border) }
}
const inTile = (() => {
  const m = new Uint8Array(L.width * L.height)
  for (const t of L.levels)
    for (let y = 0; y < 2 * t.size; y++) m.fill(1, (t.y + y) * L.width + t.x, (t.y + y) * L.width + t.x + 3 * t.size)
  return m
})()

const out = { layout: [], levels: [], spheres: [], seams: [], timing: [], notes: [] }
out.layout = L.levels.map((t) => ({
  level: t.level,
  tile: `${t.size}²`,
  'x, y': `${t.x}, ${t.y}`,
  'w×h': `${3 * t.size}×${2 * t.size}`,
  'sampler mip': t.mip,
  roughness: +t.roughness.toFixed(4),
  'ours (plan)': (() => {
    const lv = VARIANTS.ours[t.level]
    return t.level === 0
      ? 'source (bilinear)'
      : `${lv.size}², ${lv.integ ? `integ ${lv.integ}²` : `FIS ${lv.fis} mirror`}`
  })(),
}))

for (const sky of SKIES) {
  const src = await loadSky(sky)
  target = gen.fromCubemap(srcRT.texture, target)
  await sync()
  if (target.width !== L.width || target.height !== L.height) throw new Error(`atlas ${target.width}×${target.height}`)
  const threeAtlasTex = gpuTex(target.texture)
  const threeAtlas = await lab.readTexture2D(threeAtlasTex, L.width, L.height)
  const threeHDR = await renderThreeGrid()

  const { hdr: truthHDR, exposure } = await renderTruth(src)
  const truth = toImg(truthHDR, exposure)
  const threeImg = toImg(threeHDR, exposure)
  const tt = imageDiff(threeImg, truth)

  // outside-tile texels (first sky only)
  if (sky === SKIES[0]) {
    const vals = new Map()
    let n = 0
    for (let i = 0; i < L.width * L.height; i++) {
      if (inTile[i]) continue
      n++
      const k = [0, 1, 2, 3].map((c) => threeAtlas[i * 4 + c]).join(',')
      vals.set(k, (vals.get(k) ?? 0) + 1)
    }
    out.notes.push({
      what: 'three atlas texels outside tiles',
      value: `${n} texels, values ${[...vals.keys()].join(' | ')}`,
    })
    out.notes.push({
      what: 'three atlas GPU texture',
      value: `${threeAtlasTex.width}×${threeAtlasTex.height} ${threeAtlasTex.format} mips ${threeAtlasTex.mipLevelCount}`,
    })
  }

  for (const [variant, levels] of Object.entries(VARIANTS)) {
    const pf = lab.prefilterLevels(src, SIZE, levels)
    const pk = lab.packCubeUV(pf.levels, SIZE)
    {
      const e = device.createCommandEncoder()
      pf.encode(e)
      pk.encode(e)
      device.queue.submit([e.finish()])
      await sync()
    }
    const ours = await lab.readTexture2D(pk.atlas, L.width, L.height)

    if (variant === 'ours') {
      // level 0 is the same bilinear read of the same source at the same direction as three's
      let maxAbs = 0
      let maxRel = 0
      let diffTexels = 0
      const t0 = L.levels[0]
      for (let y = 0; y < 2 * t0.size; y++)
        for (let x = 0; x < 3 * t0.size; x++)
          for (let c = 0; c < 4; c++) {
            const i = (y * L.width + x) * 4 + c
            const d = Math.abs(ours[i] - threeAtlas[i])
            if (d > 0) diffTexels++
            maxAbs = Math.max(maxAbs, d)
            maxRel = Math.max(maxRel, d / Math.max(Math.abs(threeAtlas[i]), 1e-6))
          }
      out.notes.push({
        what: `${sky}: level-0 tile, ours vs three`,
        value: `max |Δ| ${maxAbs.toExponential(2)}, max rel ${maxRel.toExponential(2)}, ${diffTexels} differing channels of ${3 * t0.size * 2 * t0.size * 4}`,
      })
      const row = { sky }
      for (const t of L.levels.slice(1)) {
        const a = tileLum(ours, t)
        const b = tileLum(threeAtlas, t)
        const si = errStats(a.inner, b.inner)
        const sb = errStats(a.border, b.border)
        row[`L${t.level} r${t.roughness.toFixed(2)}`] = `${si.mean} / ${sb.mean}`
      }
      out.levels.push(row)
    }

    // ours through three's own sampler: copy into three's atlas texture, render the grid
    {
      const e = device.createCommandEncoder()
      e.copyTextureToTexture({ texture: pk.atlas }, { texture: threeAtlasTex }, [L.width, L.height])
      device.queue.submit([e.finish()])
    }
    const oursImg = toImg(await renderThreeGrid(), exposure)
    const ot = imageDiff(oursImg, truth)
    const oh = imageDiff(oursImg, threeImg)
    const worst = (d) => d.perCol.reduce((b, c, i) => (c.p99 > d.perCol[b].p99 ? i : b), 0)
    const row = {
      version: V,
      sky,
      variant,
      'ours vs truth': fmt(ot),
      'three vs truth': fmt(tt),
      'ours vs three': fmt(oh),
      'ours worst col (r, p99/max)': `${worst(ot) / 10}: ${ot.perCol[worst(ot)].p99}/${ot.perCol[worst(ot)].max}`,
      'three worst col (r, p99/max)': `${worst(tt) / 10}: ${tt.perCol[worst(tt)].p99}/${tt.perCol[worst(tt)].max}`,
    }
    out.spheres.push(row)
    if (variant === 'ours') {
      out.spheres.push({
        version: V,
        sky,
        variant: 'per-column p99 (ours | three) vs truth',
        'ours vs truth': ot.perCol.map((c) => c.p99).join(' '),
        'three vs truth': tt.perCol.map((c) => c.p99).join(' '),
        'ours vs three': oh.perCol.map((c) => c.p99).join(' '),
      })
      out.seams.push({
        sky,
        'ours vs truth, near face edge': fmt(diffBy(oursImg, truth, 2)),
        'ours vs truth, elsewhere': fmt(diffBy(oursImg, truth, 1)),
        'three vs truth, near face edge': fmt(diffBy(threeImg, truth, 2)),
        'three vs truth, elsewhere': fmt(diffBy(threeImg, truth, 1)),
      })
      if (Q.has('png')) {
        // truth / three / ours, then |three − truth| and |ours − truth| ×4
        const cv = document.createElement('canvas')
        cv.width = W
        cv.height = H * 5
        const cx = cv.getContext('2d')
        const diff = (a, b) => {
          const d = new Uint8ClampedArray(W * H * 4)
          for (let i = 0; i < W * H * 4; i++) d[i] = (i & 3) === 3 ? 255 : 4 * Math.abs(a.data[i] - b.data[i])
          return d
        }
        ;[truth.data, threeImg.data, oursImg.data, diff(threeImg, truth), diff(oursImg, truth)].forEach((d, k) =>
          cx.putImageData(new ImageData(new Uint8ClampedArray(d), W, H), 0, k * H),
        )
        ;(window.__png ??= {})[sky] = cv.toDataURL('image/png')
      }
    }
    pf.destroy()
    pk.atlas.destroy()
  }
  // Floor of the format: reference-quality levels packed the same way, read by three's sampler.
  {
    const refs = []
    const levels = []
    for (const t of L.levels) {
      if (t.level === 0) {
        levels.push({ view: src.createView({ dimension: 'cube', baseMipLevel: 0, mipLevelCount: 1 }) })
        continue
      }
      const r = t.roughness
      const o =
        r <= 0.16
          ? { mode: 'is', samples: 16384 }
          : r < 0.35
            ? { mode: 'integ', intSize: 128 }
            : { mode: 'integ', intSize: 64 }
      const ref = await lab.referenceLevel(src, SIZE, t.size - 2, r, o)
      refs.push(ref)
      levels.push({ view: ref.createView({ dimension: 'cube' }) })
    }
    const pk = lab.packCubeUV(levels, SIZE)
    const e = device.createCommandEncoder()
    pk.encode(e)
    e.copyTextureToTexture({ texture: pk.atlas }, { texture: threeAtlasTex }, [L.width, L.height])
    device.queue.submit([e.finish()])
    const idealImg = toImg(await renderThreeGrid(), exposure)
    const it = imageDiff(idealImg, truth)
    out.spheres.push({
      version: V,
      sky,
      variant: 'ideal atlas (reference levels): vs truth | per-column p99',
      'ours vs truth': fmt(it),
      'three vs truth': it.perCol.map((c) => c.p99).join(' '),
    })
    refs.forEach((r) => r.destroy())
    pk.atlas.destroy()
  }
  src.destroy()
}

// ---- timing: round-robin bursts (every candidate one burst per round), min / median ----
{
  const src = await loadSky('golden')
  target = gen.fromCubemap(srcRT.texture, target)
  await sync()
  const C = {} // name → fn submitting one bake
  const sub =
    (...encs) =>
    () => {
      const e = device.createCommandEncoder()
      for (const f of encs) f(e)
      device.queue.submit([e.finish()])
    }
  C['three fromCubemap'] = () => gen.fromCubemap(srcRT.texture, target)
  const keep = []
  for (const [variant, levels] of Object.entries(VARIANTS)) {
    const pf = lab.prefilterLevels(src, SIZE, levels)
    const pk = lab.packCubeUV(pf.levels, SIZE)
    keep.push(pf, pk)
    C[`${variant}: mips + levels + pack`] = sub(pf.encode, pk.encode)
    if (variant === 'ours') {
      C['ours: pack only'] = sub(pk.encode)
      C['ours: + copy into three atlas'] = sub(pf.encode, pk.encode, (e) =>
        e.copyTextureToTexture({ texture: pk.atlas }, { texture: gpuTex(target.texture) }, [L.width, L.height]),
      )
    }
  }
  // breakdown: source mips alone, then mips + one level (reported minus mips)
  const mipsOnly = lab.prefilterLevels(src, SIZE, [])
  keep.push(mipsOnly)
  C['breakdown: source mip chain'] = sub(mipsOnly.encode)
  for (const lv of VARIANTS.ours.slice(1)) {
    const pf = lab.prefilterLevels(src, SIZE, [lv])
    keep.push(pf)
    C[`breakdown: r ${lv.roughness.toFixed(3)} ${lv.size}² ${lv.integ ? `integ ${lv.integ}²` : `FIS ${lv.fis}`}`] = sub(
      pf.encode,
    )
  }
  const names = Object.keys(C)
  const ms = Object.fromEntries(names.map((k) => [k, []]))
  for (const k of names) C[k]()
  await sync()
  const N = 20
  for (let round = 0; round < 9; round++)
    for (const k of names) {
      const t0 = performance.now()
      for (let i = 0; i < N; i++) C[k]()
      await sync()
      ms[k].push((performance.now() - t0) / N)
    }
  const mipMin = Math.min(...ms['breakdown: source mip chain'])
  for (const k of names) {
    const v = [...ms[k]].sort((a, b) => a - b)
    const sub0 = k.startsWith('breakdown: r ') ? mipMin : 0
    out.timing.push({
      version: V,
      what: k,
      'min ms': +(v[0] - sub0).toFixed(3),
      'median ms': +(v[4] - sub0).toFixed(3),
    })
  }
  for (const o of keep) o.destroy?.() ?? o.atlas?.destroy()
  src.destroy()
}
window.__result = out
