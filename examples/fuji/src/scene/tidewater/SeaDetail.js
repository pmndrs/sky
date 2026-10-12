// Adapted from Tidewater, commit fd6cae6 (user-licensed source).
import * as THREE from 'three/webgpu'
import {
  texture,
  textureLoad,
  uniform,
  vec2,
  float,
  smoothstep,
  mix,
  dot,
  saturate,
  floor,
  fract,
  ivec2,
} from 'three/tsl'
import { G } from './Globals.js'
import { mulberry32 } from './Noise.js'

// Large-scale variation of the sea surface in world space (never repeats with the FFT tiles):
//  - gusts ("cat's paws"): patches of rougher water drifting downwind. Rough water reflects less
//    of the bright horizon sky, so from a low viewpoint gusts read as irregular dark patches.
//  - slicks: long calm bands along the wind (surfactant films) where capillary waves are damped;
//    mirror-like and bright, mostly in light to moderate wind.
//  - windrows: thin wavy foam lines along the wind in fresh wind (Langmuir circulation).
export class SeaDetail {
  constructor(size = 256) {
    this.texture = makeNoiseTexture(size)
    this.size = size
    // read with textureLoad + manual bilinear filtering: no sampler binding at all (these lookups
    // end up in scene materials that are close to WebGPU's 16-sampler limit). The noise is smooth
    // and low frequency, so no mipmaps are needed.
    this.tex = texture(this.texture)
    this.gustAmount = uniform(1).setName('sdGust')
    this.slickAmount = uniform(1).setName('sdSlick')
    this.streakAmount = uniform(0.3).setName('sdStreak')
    this.offset = uniform(new THREE.Vector2()).setName('sdOffset') // accumulated wind drift (m)
  }

  update(dt) {
    // gust patterns travel with the wind at roughly its speed near the surface
    const w = G.windDir.value,
      s = G.windSpeed.value * 0.7 * dt
    this.offset.value.x += w.x * s
    this.offset.value.y += w.y * s
  }

  // bilinear, repeat-wrapped lookup without a sampler (uv in texture repeats)
  _load(uv) {
    const n = this.size
    const p = uv.mul(n).sub(0.5)
    const i = floor(p)
    const f = fract(p)
    const at = (dx, dy) => textureLoad(this.tex, ivec2(i.add(vec2(dx, dy)).mod(n).add(n).mod(n)))
    return mix(mix(at(0, 0), at(1, 0), f.x), mix(at(0, 1), at(1, 1), f.x), f.y)
  }

  // { rough: short-wave slope multiplier, gust 0..1, slick 0..1, streak 0..1 }
  sample(xz) {
    const tex = { sample: (uv) => this._load(uv) }
    const p = xz.sub(this.offset)

    // gusts: two octaves (~600 m and ~230 m features), the second slowly morphing
    const g1 = tex.sample(p.div(620)).x
    const g2 = tex.sample(p.div(230).add(vec2(G.time.mul(0.0009), 0.37))).y
    const gustRaw = g1.mul(0.62).add(g2.mul(0.38))
    const gust = saturate(gustRaw.sub(0.5).mul(2.4).mul(this.gustAmount).add(0.5)).toVar()

    // wind-aligned frame, lightly domain-warped so bands meander
    const w = G.windDir
    const along = dot(xz, w)
    const across = dot(xz, vec2(w.y.negate(), w.x)).add(g2.sub(0.5).mul(26))

    // slicks: long bands, strongest in light wind, torn apart by gusts
    const sl = tex.sample(vec2(along.div(1100), across.div(70))).z
    const calmWind = smoothstep(13, 4, G.windSpeed)
    const slick = smoothstep(0.64, 0.76, sl)
      .mul(float(1).sub(gust.mul(0.8)))
      .mul(calmWind)
      .mul(this.slickAmount)
      .toVar()

    // windrows: thin foam lines ~10 m apart that come and go along their length
    const st = tex.sample(vec2(along.div(380), across.div(11)).add(vec2(0.13, 0.71))).w
    const breakUp = tex.sample(vec2(along.div(140), across.div(40)).add(vec2(0.51, 0.29))).x
    const freshWind = smoothstep(6, 12, G.windSpeed)
    const streak = smoothstep(0.68, 0.82, st)
      .mul(smoothstep(0.4, 0.62, breakUp))
      .mul(freshWind)
      .mul(this.streakAmount)

    // windrows show mostly as smooth lanes (surfactant and debris collect in the convergence lines
    // and damp the ripples), with only a trace of foam
    const rough = mix(float(0.5), float(1.5), gust)
      .mul(float(1).sub(slick.mul(0.8)))
      .mul(float(1).sub(streak.div(this.streakAmount.max(1e-3)).mul(0.45)))
    return { rough, gust, slick, streak }
  }
}

// Tileable smooth fbm in 4 channels (different seeds / base frequencies).
function makeNoiseTexture(size) {
  const data = new Uint16Array(size * size * 4)
  const channels = [
    { seed: 11, freq: 4, oct: 4 },
    { seed: 23, freq: 5, oct: 4 },
    { seed: 37, freq: 4, oct: 3 },
    { seed: 53, freq: 6, oct: 3 },
  ]

  for (let c = 0; c < 4; c++) {
    const { seed, freq, oct } = channels[c]
    const rand = mulberry32(seed)
    // gradient tables per octave (periodic lattice)
    const tables = []
    for (let o = 0; o < oct; o++) {
      const n = freq << o
      const g = new Float32Array(n * n * 2)
      for (let i = 0; i < n * n; i++) {
        const a = rand() * Math.PI * 2
        g[i * 2] = Math.cos(a)
        g[i * 2 + 1] = Math.sin(a)
      }

      tables.push({ n, g })
    }

    let mn = Infinity,
      mx = -Infinity
    const vals = new Float32Array(size * size)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let v = 0,
          amp = 1,
          norm = 0
        for (let o = 0; o < oct; o++) {
          const { n, g } = tables[o]
          const fx = (x / size) * n,
            fy = (y / size) * n
          const xi = Math.floor(fx),
            yi = Math.floor(fy)
          const xf = fx - xi,
            yf = fy - yi
          const grad = (ix, iy, dx, dy) => {
            const k = (((iy % n) + n) % n) * n + (((ix % n) + n) % n)
            return g[k * 2] * dx + g[k * 2 + 1] * dy
          }

          const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10)
          const w = yf * yf * yf * (yf * (yf * 6 - 15) + 10)
          const a0 = grad(xi, yi, xf, yf),
            a1 = grad(xi + 1, yi, xf - 1, yf)
          const b0 = grad(xi, yi + 1, xf, yf - 1),
            b1 = grad(xi + 1, yi + 1, xf - 1, yf - 1)
          const nv = a0 + (a1 - a0) * u + (b0 + (b1 - b0) * u - (a0 + (a1 - a0) * u)) * w
          v += nv * amp
          norm += amp
          amp *= 0.5
        }

        v /= norm
        vals[y * size + x] = v
        mn = Math.min(mn, v)
        mx = Math.max(mx, v)
      }

    for (let i = 0; i < size * size; i++) data[i * 4 + c] = THREE.DataUtils.toHalfFloat((vals[i] - mn) / (mx - mn))
  }

  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.HalfFloatType)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  // nearest + no mips: three only binds a sampler for filterable textures, and this one is read
  // with textureLoad (manual bilinear) to keep scene materials under the 16-sampler limit
  t.magFilter = THREE.NearestFilter
  t.minFilter = THREE.NearestFilter
  t.generateMipmaps = false
  t.name = 'seaDetailNoise'
  t.needsUpdate = true
  return t
}
