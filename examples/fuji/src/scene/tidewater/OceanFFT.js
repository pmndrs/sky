// Adapted from Tidewater, commit fd6cae6 (user-licensed source).
import * as THREE from 'three/webgpu'
import {
  Fn,
  uniform,
  uniformArray,
  instancedArray,
  workgroupArray,
  workgroupBarrier,
  localId,
  workgroupId,
  globalId,
  float,
  int,
  uint,
  vec2,
  vec4,
  uvec2,
  If,
  select,
  cos,
  sin,
  sqrt,
  exp,
  pow,
  abs,
  atan,
  tanh,
  cosh,
  min,
  max,
  clamp,
  log,
  length,
  storageTexture,
  textureStore,
  texture,
  mix,
  saturate,
} from 'three/tsl'
import { G, GRAVITY } from './Globals.js'

// Multi-cascade FFT ocean (Tessendorf) with a Horvath/JONSWAP spectrum.
//
// Each frame runs exactly two compute dispatches for all cascades:
//   1. row pass: time-evolves the spectrum (h0 -> h(k,t)), builds 4 packed complex
//      fields and performs a 256-point radix-2 IFFT per row in workgroup memory.
//   2. column pass: IFFT per column, sign correction, Jacobian based foam
//      accumulation, and writes displacement / derivative array textures.
//
// Packed complex fields (two real fields per complex IFFT):
//   c0 = Dx  + i Dz        c1 = Dy   + i dDx/dz
//   c2 = dDy/dx + i dDy/dz c3 = dDx/dx + i dDz/dz

export const FFT_SIZE = 256
const N = FFT_SIZE
const LOG2N = 8
const HALF = N / 2

// Non-integer ratios between cascade sizes avoid visible repetition.
export const DEFAULT_CASCADE_SIZES = [733, 157, 33.3, 7.1]

const TWO_PI = Math.PI * 2

function bitReverse8(v) {
  let r = v
  r = r.bitAnd(0x55).shiftLeft(1).bitOr(r.shiftRight(1).bitAnd(0x55))
  r = r.bitAnd(0x33).shiftLeft(2).bitOr(r.shiftRight(2).bitAnd(0x33))
  r = r.bitAnd(0x0f).shiftLeft(4).bitOr(r.shiftRight(4).bitAnd(0x0f))
  return r
}

// complex multiply of two packed complex numbers (v.xy, v.zw) by scalar complex w
const cmul2 = (v, w) =>
  vec4(
    v.x.mul(w.x).sub(v.y.mul(w.y)),
    v.x.mul(w.y).add(v.y.mul(w.x)),
    v.z.mul(w.x).sub(v.w.mul(w.y)),
    v.z.mul(w.y).add(v.w.mul(w.x)),
  )

// PCG hash
const pcg = (v) => {
  const state = v.mul(uint(747796405)).add(uint(2891336453))
  const word = state
    .shiftRight(state.shiftRight(uint(28)).add(uint(4)))
    .bitXor(state)
    .mul(uint(277803737))
  return word.shiftRight(uint(22)).bitXor(word)
}

const toUnit = (h) =>
  float(h.shiftRight(uint(8)))
    .mul(1 / 16777216)
    .add(0.5 / 16777216)

export class WaveSystem {
  constructor(o = {}) {
    this.scale = o.scale ?? 1
    this.windSpeed = o.windSpeed ?? 8 // m/s
    this.windDirection = o.windDirection ?? 20 // degrees
    this.fetch = o.fetch ?? 200 // km
    this.spreadBlend = o.spreadBlend ?? 0.9
    this.swell = o.swell ?? 0.2
    this.peakEnhancement = o.peakEnhancement ?? 3.3
    this.shortWavesFade = o.shortWavesFade ?? 0.01
  }
}

export class OceanFFT {
  constructor(renderer, options = {}) {
    this.renderer = renderer
    this.cascades = options.cascades ?? 4
    this.sizes = (options.sizes ?? DEFAULT_CASCADE_SIZES).slice(0, this.cascades)
    this.depth = options.depth ?? 500

    this.local = new WaveSystem(
      options.local ?? { windSpeed: 7, windDirection: 25, fetch: 120, spreadBlend: 0.85, swell: 0.05 },
    )
    this.swell = new WaveSystem(
      options.swell ?? {
        scale: 0.48,
        windSpeed: 6,
        windDirection: 5,
        fetch: 1200,
        spreadBlend: 1.0,
        swell: 0.9,
        shortWavesFade: 0.1,
      },
    )

    this.choppiness = uniform(options.choppiness ?? 0.9).setName('fftChop')
    // foam starts where a cascade compresses the surface below this Jacobian (per-cascade J
    // stays close to 1: 0.85 gives ~0.3% whitecap cover at 7 m/s, 0.9 several % in fresh wind)
    this.foamBias = uniform(0.58).setName('foamBias')
    this.foamGain = uniform(3.0).setName('foamGain')
    this.foamDecay = uniform(0.35).setName('foamDecay')
    this.foamAdd = uniform(2.5).setName('foamAdd')
    this.timeScale = 1
    this.time = uniform(0).setName('fftTime')

    const C = this.cascades
    const total = N * N * C

    this.h0 = instancedArray(total, 'vec4').setName('fftH0')
    this.waveData = instancedArray(total, 'vec4').setName('fftWave')
    this.tmp = instancedArray(total * 2, 'vec4').setName('fftTmp')
    this.foam = instancedArray(total, 'float').setName('fftFoam')
    // level 0 of both textures (interleaved) for the compute mip chain, and the 8x8 level 5
    this.mipSrc = instancedArray(total * 2, 'vec4').setName('fftMipSrc')
    this.mipMid = instancedArray(64 * C * 2, 'vec4').setName('fftMipMid')

    const makeTex = (name) => {
      const t = new THREE.StorageArrayTexture(N, N, C)
      t.name = name
      t.type = THREE.HalfFloatType
      t.format = THREE.RGBAFormat
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.magFilter = THREE.LinearFilter
      t.minFilter = THREE.LinearMipmapLinearFilter
      t.generateMipmaps = true // allocate the full chain; filled by the compute mip kernels
      t.mipmapsAutoUpdate = false
      t.anisotropy = 4
      return t
    }

    this.displacementTexture = makeTex('oceanDisplacement') // (Dx, Dy, Dz, foam)
    this.derivativeTexture = makeTex('oceanDerivatives') // (dDy/dx, dDy/dz, dDx/dx, dDz/dz)

    // spectrum uniforms
    this.uSizes = uniformArray(this.sizes.slice(), 'float').setName('fftSizes')
    this.uCutLow = uniformArray(new Array(C).fill(0), 'float').setName('fftCutLow')
    this.uCutHigh = uniformArray(new Array(C).fill(0), 'float').setName('fftCutHigh')
    this.uDepth = uniform(this.depth).setName('fftDepth')
    this.uSeed = uniform(1337, 'uint').setName('fftSeed')
    // per system: [scale, angle, spreadBlend, swell] [alpha, peakOmega, gamma, shortWavesFade]
    this.uSysA = uniformArray([new THREE.Vector4(), new THREE.Vector4()], 'vec4').setName('fftSysA')
    this.uSysB = uniformArray([new THREE.Vector4(), new THREE.Vector4()], 'vec4').setName('fftSysB')

    this._buildKernels()
    this.updateSpectrumUniforms()
    this.needsSpectrum = true
  }

  setCascadeSizes(sizes) {
    this.sizes = sizes.slice(0, this.cascades)
    this.uSizes.array = this.sizes.slice()
    this.needsSpectrum = true
  }

  updateSpectrumUniforms() {
    const C = this.cascades
    const cutLow = [],
      cutHigh = []

    for (let i = 0; i < C; i++) {
      const low = i === 0 ? 0.0001 : (TWO_PI / this.sizes[i]) * 6
      const high = i === C - 1 ? 9999 : (TWO_PI / this.sizes[i + 1]) * 6
      cutLow.push(low)
      cutHigh.push(high)
    }

    this.uCutLow.array = cutLow
    this.uCutHigh.array = cutHigh
    this.uSizes.array = this.sizes.slice()
    this.uDepth.value = this.depth

    const sys = [this.local, this.swell]

    for (let i = 0; i < 2; i++) {
      const s = sys[i]
      const fetchM = Math.max(1, s.fetch) * 1000
      const U = Math.max(0.1, s.windSpeed)
      const alpha = 0.076 * Math.pow((GRAVITY * fetchM) / (U * U), -0.22)
      const peakOmega = 22 * Math.pow((U * fetchM) / (GRAVITY * GRAVITY), -0.33)
      this.uSysA.array[i].set(s.scale, THREE.MathUtils.degToRad(s.windDirection), s.spreadBlend, s.swell)
      this.uSysB.array[i].set(alpha, peakOmega, s.peakEnhancement, s.shortWavesFade)
    }

    this.needsSpectrum = true
  }

  _buildKernels() {
    const C = this.cascades
    const { h0, waveData, tmp, foam } = this
    const { uSizes, uCutLow, uCutHigh, uDepth, uSeed, uSysA, uSysB } = this

    // ---------- spectrum helpers ----------

    const dispersion = (k) => sqrt(k.mul(GRAVITY).mul(tanh(min(k.mul(uDepth), 20))))

    const dispersionDerivative = (k) => {
      const kd = min(k.mul(uDepth), 20)
      const th = tanh(kd)
      const ch = cosh(kd)
      return float(GRAVITY)
        .mul(uDepth.mul(k).div(ch.mul(ch)).add(th))
        .div(dispersion(k))
        .mul(0.5)
    }

    const tmaCorrection = (omega) => {
      const omegaH = omega.mul(sqrt(uDepth.div(GRAVITY)))
      const a = omegaH.mul(omegaH).mul(0.5)
      const b = float(1).sub(float(2).sub(omegaH).pow(2).mul(0.5))
      return select(omegaH.lessThanEqual(1), a, select(omegaH.lessThan(2), b, float(1)))
    }

    const jonswap = (omega, sysA, sysB) => {
      const alpha = sysB.x,
        peakOmega = sysB.y,
        gamma = sysB.z
      const sigma = select(omega.lessThanEqual(peakOmega), float(0.07), float(0.09))
      const d = omega.sub(peakOmega)
      const r = exp(d.mul(d).negate().div(sigma.mul(sigma).mul(peakOmega).mul(peakOmega).mul(2)))
      const inv = float(1).div(omega)
      const po = peakOmega.mul(inv)
      return sysA.x
        .mul(tmaCorrection(omega))
        .mul(alpha)
        .mul(GRAVITY * GRAVITY)
        .mul(inv.pow(5))
        .mul(exp(po.pow(4).mul(-1.25)))
        .mul(pow(abs(gamma), r))
    }

    const normalisationFactor = (s) => {
      const s2 = s.mul(s),
        s3 = s2.mul(s),
        s4 = s3.mul(s)
      const lo = s4.mul(-0.000564).add(s3.mul(0.00776)).sub(s2.mul(0.044)).add(s.mul(0.192)).add(0.163)
      const hi = s4.mul(-4.8e-8).add(s3.mul(1.07e-5)).sub(s2.mul(9.53e-4)).add(s.mul(5.9e-2)).add(3.93e-1)
      return select(s.lessThan(5), lo, hi)
    }

    const directionSpectrum = (theta, omega, sysA, sysB) => {
      const peakOmega = sysB.y
      const ratio = omega.div(peakOmega)
      const spreadPower = select(
        omega.greaterThan(peakOmega),
        pow(abs(ratio), -2.5).mul(9.77),
        pow(abs(ratio), 5).mul(6.97),
      )
      const s = spreadPower.add(tanh(min(ratio, 20)).mul(16).mul(sysA.w).mul(sysA.w))
      const dTheta = theta.sub(sysA.y)
      const cos2s = normalisationFactor(s).mul(pow(abs(cos(dTheta.mul(0.5))), s.mul(2)))
      const cosT = cos(dTheta)
      const base = cosT
        .mul(cosT)
        .mul(2 / Math.PI)
        .mul(select(cosT.greaterThan(0), float(1), float(0.0)))
      return mix(base, cos2s, sysA.z)
    }

    const shortWavesFade = (k, sysB) => exp(sysB.w.mul(sysB.w).mul(k).mul(k).negate())

    // ---------- init spectrum ----------

    this.initSpectrumKernel = Fn(() => {
      const x = int(globalId.x),
        y = int(globalId.y),
        c = int(globalId.z)
      const idx = c
        .mul(N * N)
        .add(y.mul(N))
        .add(x)

      const L = uSizes.element(c)
      const dk = float(TWO_PI).div(L)
      const kx = float(x.sub(HALF)).mul(dk)
      const kz = float(y.sub(HALF)).mul(dk)
      const kLen = length(vec2(kx, kz)).toVar()

      const outH = vec4(0).toVar()
      const outW = vec4(kx, kz, 0, 0).toVar()

      If(kLen.greaterThanEqual(uCutLow.element(c)).and(kLen.lessThanEqual(uCutHigh.element(c))), () => {
        const omega = dispersion(kLen).toVar()
        const dOmega = dispersionDerivative(kLen)
        const theta = atan(kz, kx)

        const sa0 = uSysA.element(0),
          sb0 = uSysB.element(0)
        const sa1 = uSysA.element(1),
          sb1 = uSysB.element(1)

        const S0 = jonswap(omega, sa0, sb0)
          .mul(directionSpectrum(theta, omega, sa0, sb0))
          .mul(shortWavesFade(kLen, sb0))
        const S1 = jonswap(omega, sa1, sb1)
          .mul(directionSpectrum(theta, omega, sa1, sb1))
          .mul(shortWavesFade(kLen, sb1))
        const S = max(S0.add(S1), 0)

        // E|h0|^2 = S(k) dk^2 / 2 so that var(height) = sum S(k) dk^2 (h has both +k and -k terms)
        const amp = sqrt(S.mul(abs(dOmega)).div(kLen).mul(dk).mul(dk)).mul(0.5)

        // gaussian random pair (Box-Muller)
        const seed = uint(idx)
          .mul(uint(4))
          .add(uSeed.mul(uint(7919)))
        const u1 = toUnit(pcg(seed))
        const u2 = toUnit(pcg(seed.add(uint(1))))
        const r = sqrt(log(u1).mul(-2))
        const g0 = r.mul(cos(u2.mul(TWO_PI)))
        const g1 = r.mul(sin(u2.mul(TWO_PI)))

        outH.assign(vec4(g0.mul(amp), g1.mul(amp), 0, 0))
        outW.assign(vec4(kx, kz, float(1).div(kLen), omega))
      })

      h0.element(idx).assign(outH)
      waveData.element(idx).assign(outW)
    })()
      .computeKernel([16, 16, 1])
      .setName('Ocean Init Spectrum')

    this.conjugateKernel = Fn(() => {
      const x = int(globalId.x),
        y = int(globalId.y),
        c = int(globalId.z)
      const base = c.mul(N * N)
      const idx = base.add(y.mul(N)).add(x)
      const xm = int(N).sub(x).mod(N)
      const ym = int(N).sub(y).mod(N)
      const idxm = base.add(ym.mul(N)).add(xm)
      const hm = h0.element(idxm).xy
      const cur = h0.element(idx).xy
      tmp.element(idx).assign(vec4(cur.x, cur.y, hm.x, hm.y.negate()))
    })()
      .computeKernel([16, 16, 1])
      .setName('Ocean Conjugate')

    this.copyH0Kernel = Fn(() => {
      const x = int(globalId.x),
        y = int(globalId.y),
        c = int(globalId.z)
      const idx = c
        .mul(N * N)
        .add(y.mul(N))
        .add(x)
      h0.element(idx).assign(tmp.element(idx))
      foam.element(idx).assign(0)
    })()
      .computeKernel([16, 16, 1])
      .setName('Ocean Copy H0')

    // ---------- IFFT ----------

    const shared = workgroupArray('vec4', N * 2)

    const fftStages = (t) => {
      for (let s = 0; s < LOG2N; s++) {
        const half = 1 << s
        const pos = t.bitAnd(uint(half - 1))
        const i = t
          .shiftRight(uint(s))
          .shiftLeft(uint(s + 1))
          .bitOr(pos)
        const j = i.add(uint(half))
        const ang = float(pos).mul(Math.PI / half)
        const w = vec2(cos(ang), sin(ang)).toVar()
        const i2 = i.mul(uint(2)).toVar()
        const j2 = j.mul(uint(2)).toVar()
        const a0 = shared.element(i2).toVar()
        const a1 = shared.element(i2.add(uint(1))).toVar()
        const b0 = cmul2(shared.element(j2).toVar(), w).toVar()
        const b1 = cmul2(shared.element(j2.add(uint(1))).toVar(), w).toVar()
        shared.element(i2).assign(a0.add(b0))
        shared.element(i2.add(uint(1))).assign(a1.add(b1))
        shared.element(j2).assign(a0.sub(b0))
        shared.element(j2.add(uint(1))).assign(a1.sub(b1))
        workgroupBarrier()
      }
    }

    const time = this.time

    this.rowKernel = Fn(() => {
      const t = localId.x
      const row = workgroupId.x
      const c = workgroupId.y
      const base = c
        .mul(uint(N * N))
        .add(row.mul(uint(N)))
        .toVar()

      for (let e = 0; e < 2; e++) {
        const x = t.add(uint(e * HALF))
        const idx = base.add(x)
        const w = waveData.element(idx).toVar()
        const hv = h0.element(idx).toVar()
        const ph = w.w.mul(time)
        const cs = cos(ph).toVar(),
          sn = sin(ph).toVar()

        // h = h0 * e^{i w t} + conj(h0(-k)) * e^{-i w t}
        const hr = hv.x.mul(cs).sub(hv.y.mul(sn)).add(hv.z.mul(cs)).add(hv.w.mul(sn)).toVar()
        const hi = hv.x.mul(sn).add(hv.y.mul(cs)).sub(hv.z.mul(sn)).add(hv.w.mul(cs)).toVar()

        const kx = w.x,
          kz = w.y,
          ik = w.z
        const fx = kx.mul(ik),
          fz = kz.mul(ik)

        // Dx_hat = i kx/k h, Dz_hat = i kz/k h  ->  c0 = Dx + i Dz
        const c0 = vec2(fx.mul(hi).add(fz.mul(hr)).negate(), fx.mul(hr).sub(fz.mul(hi)))
        // c1 = Dy + i dDx/dz,  dDx/dz_hat = -kx kz / k h
        const q = kx.mul(kz).mul(ik).negate()
        const c1 = vec2(hr.sub(q.mul(hi)), hi.add(q.mul(hr)))
        // c2 = dDy/dx + i dDy/dz
        const c2 = vec2(kx.mul(hi).add(kz.mul(hr)).negate(), kx.mul(hr).sub(kz.mul(hi)))
        // c3 = dDx/dx + i dDz/dz
        const a = kx.mul(kx).mul(ik).negate(),
          b = kz.mul(kz).mul(ik).negate()
        const c3 = vec2(a.mul(hr).sub(b.mul(hi)), a.mul(hi).add(b.mul(hr)))

        const r = bitReverse8(x).mul(uint(2))
        shared.element(r).assign(vec4(c0, c1))
        shared.element(r.add(uint(1))).assign(vec4(c2, c3))
      }

      workgroupBarrier()
      fftStages(t)

      for (let e = 0; e < 2; e++) {
        const x = t.add(uint(e * HALF))
        const o = base.add(x).mul(uint(2))
        tmp.element(o).assign(shared.element(x.mul(uint(2))))
        tmp.element(o.add(uint(1))).assign(shared.element(x.mul(uint(2)).add(uint(1))))
      }
    })()
      .computeKernel([HALF, 1, 1])
      .setName('Ocean FFT Rows')

    const dispTex = this.displacementTexture
    const derivTex = this.derivativeTexture
    const mipSrc = this.mipSrc
    const lambda = this.choppiness
    const { foamBias, foamGain, foamDecay, foamAdd } = this

    this.columnKernel = Fn(() => {
      const t = localId.x
      const col = workgroupId.x
      const c = workgroupId.y
      const base = c.mul(uint(N * N)).toVar()

      for (let e = 0; e < 2; e++) {
        const y = t.add(uint(e * HALF))
        const idx = base.add(y.mul(uint(N))).add(col)
        const r = bitReverse8(y).mul(uint(2))
        shared.element(r).assign(tmp.element(idx.mul(uint(2))))
        shared.element(r.add(uint(1))).assign(tmp.element(idx.mul(uint(2)).add(uint(1))))
      }

      workgroupBarrier()
      fftStages(t)

      for (let e = 0; e < 2; e++) {
        const y = t.add(uint(e * HALF))
        const idx = base.add(y.mul(uint(N))).add(col)
        const sign = select(col.add(y).bitAnd(uint(1)).equal(uint(0)), float(1), float(-1))
        const A = shared
          .element(y.mul(uint(2)))
          .mul(sign)
          .toVar()
        const B = shared
          .element(y.mul(uint(2)).add(uint(1)))
          .mul(sign)
          .toVar()

        const Dx = A.x,
          Dz = A.y,
          Dy = A.z,
          Dxz = A.w
        const Dyx = B.x,
          Dyz = B.y,
          Dxx = B.z,
          Dzz = B.w

        const jxx = lambda.mul(Dxx).add(1)
        const jzz = lambda.mul(Dzz).add(1)
        const jxz = lambda.mul(Dxz)
        const J = jxx.mul(jzz).sub(jxz.mul(jxz))

        // Persistent foam: generated where the surface compresses (J < bias),
        // then slowly decays so whitecaps leave trailing foam patches.
        const prev = foam.element(idx)
        const gen = saturate(foamBias.sub(J).mul(foamGain))
        const f = prev.mul(exp(foamDecay.mul(G.dt).negate())).add(gen.mul(foamAdd).mul(G.dt))
        const fNew = clamp(max(f, gen.mul(0.5)), 0, 1.5).toVar()
        prev.assign(fNew)

        const uv = uvec2(col, y)
        const vDisp = vec4(lambda.mul(Dx), Dy, lambda.mul(Dz), fNew).toVar()
        const vDeriv = vec4(Dyx, Dyz, lambda.mul(Dxx), lambda.mul(Dzz)).toVar()
        textureStore(storageTexture(dispTex).depth(int(c)), uv, vDisp)
        textureStore(storageTexture(derivTex).depth(int(c)), uv, vDeriv)
        mipSrc.element(idx.mul(uint(2))).assign(vDisp)
        mipSrc.element(idx.mul(uint(2)).add(uint(1))).assign(vDeriv)
      }
    })()
      .computeKernel([HALF, 1, 1])
      .setName('Ocean FFT Columns')

    // ---- mip chains in compute (instead of 2 textures x 4 layers x 8 levels of render passes)
    // A: 16x16 threads per 32x32 texel tile of level 0 -> levels 1..5 through workgroup memory
    // B: one 8x8 workgroup per layer -> levels 6..8
    const mipMid = this.mipMid
    const avg4 = (a, b, c, d) => a.add(b).add(c).add(d).mul(0.25)
    const store = (tex, level, layer, x, y, v) =>
      textureStore(storageTexture(tex).setMipLevel(level).depth(int(layer)), uvec2(x, y), v)
    const reduce = (tex, from, to, width, level, layer, ox, oy, lx, ly) => {
      // threads (lx, ly) < width reduce a 2x2 block of `from` (row length 2*width) into `to`
      If(lx.lessThan(uint(width)).and(ly.lessThan(uint(width))), () => {
        const w2 = width * 2
        const i = ly.mul(uint(2 * w2)).add(lx.mul(uint(2)))
        const v = avg4(
          from.element(i),
          from.element(i.add(uint(1))),
          from.element(i.add(uint(w2))),
          from.element(i.add(uint(w2 + 1))),
        ).toVar()
        store(tex, level, layer, ox.mul(uint(width)).add(lx), oy.mul(uint(width)).add(ly), v)
        if (to) to.element(ly.mul(uint(width)).add(lx)).assign(v)
        else
          mipMid
            .element(
              layer
                .mul(uint(64))
                .add(oy.mul(uint(8)))
                .add(ox)
                .mul(uint(2))
                .add(uint(tex === dispTex ? 0 : 1)),
            )
            .assign(v)
      })
    }

    const mipA = (tex, t) =>
      Fn(() => {
        const lx = localId.x,
          ly = localId.y
        const gx = workgroupId.x,
          gy = workgroupId.y,
          c = workgroupId.z
        const s1 = workgroupArray('vec4', 256)
        const s2 = workgroupArray('vec4', 64)
        const s3 = workgroupArray('vec4', 16)
        const s4 = workgroupArray('vec4', 4)
        const x1 = gx.mul(uint(16)).add(lx),
          y1 = gy.mul(uint(16)).add(ly)
        const src = (x, y) =>
          mipSrc.element(
            c
              .mul(uint(N * N))
              .add(y.mul(uint(N)))
              .add(x)
              .mul(uint(2))
              .add(uint(t)),
          )
        const x0 = x1.mul(uint(2)),
          y0 = y1.mul(uint(2))
        const v1 = avg4(
          src(x0, y0),
          src(x0.add(uint(1)), y0),
          src(x0, y0.add(uint(1))),
          src(x0.add(uint(1)), y0.add(uint(1))),
        ).toVar()
        store(tex, 1, c, x1, y1, v1)
        s1.element(ly.mul(uint(16)).add(lx)).assign(v1)
        workgroupBarrier()
        reduce(tex, s1, s2, 8, 2, c, gx, gy, lx, ly)
        workgroupBarrier()
        reduce(tex, s2, s3, 4, 3, c, gx, gy, lx, ly)
        workgroupBarrier()
        reduce(tex, s3, s4, 2, 4, c, gx, gy, lx, ly)
        workgroupBarrier()
        reduce(tex, s4, null, 1, 5, c, gx, gy, lx, ly)
      })()
        .computeKernel([16, 16, 1])
        .setName('Ocean Mips A')

    const mipB = (tex, t) =>
      Fn(() => {
        const lx = localId.x,
          ly = localId.y,
          c = workgroupId.z
        const zero = uint(0)
        const s5 = workgroupArray('vec4', 64)
        const s6 = workgroupArray('vec4', 16)
        const s7 = workgroupArray('vec4', 4)
        s5.element(ly.mul(uint(8)).add(lx)).assign(
          mipMid.element(
            c
              .mul(uint(64))
              .add(ly.mul(uint(8)))
              .add(lx)
              .mul(uint(2))
              .add(uint(t)),
          ),
        )
        workgroupBarrier()
        reduce(tex, s5, s6, 4, 6, c, zero, zero, lx, ly)
        workgroupBarrier()
        reduce(tex, s6, s7, 2, 7, c, zero, zero, lx, ly)
        workgroupBarrier()
        reduce(tex, s7, s7, 1, 8, c, zero, zero, lx, ly)
      })()
        .computeKernel([8, 8, 1])
        .setName('Ocean Mips B')

    this.mipKernelsA = [mipA(dispTex, 0), mipA(derivTex, 1)]
    this.mipKernelsB = [mipB(dispTex, 0), mipB(derivTex, 1)]
  }

  update(dt) {
    const renderer = this.renderer
    const C = this.cascades

    if (this.needsSpectrum) {
      this.needsSpectrum = false
      const d = [N / 16, N / 16, C]
      renderer.compute(this.initSpectrumKernel, d)
      renderer.compute(this.conjugateKernel, d)
      renderer.compute(this.copyH0Kernel, d)
    }

    this.time.value += dt * this.timeScale
    renderer.compute([this.rowKernel, this.columnKernel], [N, C, 1])
    renderer.compute(this.mipKernelsA, [N / 32, N / 32, C])
    renderer.compute(this.mipKernelsB, [1, 1, C])
  }

  // ---------- sampling helpers (TSL) ----------

  // Sample all cascades' displacement at world xz. `weights` optional per cascade (array of nodes).
  sampleDisplacement(worldXZ, level = null, weights = null) {
    let sum = null
    for (let c = 0; c < this.cascades; c++) {
      const uv = worldXZ.div(this.uSizes.element(c))
      let s = texture(this.displacementTexture, uv).depth(c)
      if (level !== null) s = s.level(level)
      let v = s.xyz
      if (weights) v = v.mul(weights[c])
      sum = sum ? sum.add(v) : v
    }

    return sum
  }
}
