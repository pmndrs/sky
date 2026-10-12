// Adapted from Tidewater, commit fd6cae6 (user-licensed source).
import * as THREE from 'three/webgpu'
import {
  Fn,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  normalize,
  max,
  min,
  log2,
  clamp,
  saturate,
  texture,
  smoothstep,
  mix,
  length,
  exp,
  abs,
  fract,
  sin,
  cos,
  dot,
  select,
  pow,
  If,
} from 'three/tsl'
import { G } from './Globals.js'
import { FFT_SIZE } from './OceanFFT.js'

// Combines every contribution to the water surface: FFT cascades (deep water),
// shoreline waves, and the interactive wake. Provides the TSL used by the ocean
// vertex/fragment shaders and by compute passes that query the surface.
export class WaterSurface {
  constructor({ fft, cdlod, foamTexture }) {
    this.fft = fft
    this.cdlod = cdlod
    this.foamTexture = foamTexture
    this.shore = null // ShoreWaves (optional)
    this.wake = null // WakeSim (optional)
    this.terrain = null // TerrainGPU (optional)
    this.detail = null // SeaDetail: gusts, slicks, windrows (optional)

    this.amplitude = uniform(1).setName('wAmp')
    this.slopeScale = uniform(1).setName('wSlopeScale')
    this.foamCoverage = uniform(1).setName('wFoamCov')
    this.foamSharpness = uniform(2.2).setName('wFoamSharp')
    this.foamScale = uniform(0.09).setName('wFoamScale') // pattern repeats per meter
    // per-cascade contribution to the foam coverage
    this.foamWeights = [0.35, 0.45, 0.5, 0.25]
    // shared base nodes: repeated lookups reuse one texture + sampler binding
    this.dispTex = texture(fft.displacementTexture)
    this.derivTex = texture(fft.derivativeTexture)
    this.foamTex = texture(foamTexture)
  }

  // depth of the sea floor below mean sea level at xz (m)
  seaDepth(xz) {
    if (this.terrain) return G.seaLevel.sub(this.terrain.heightAt(xz))
    return float(500)
  }

  // per-cascade amplitude attenuation in shallow water (long waves feel the bottom first)
  cascadeAttenuation(c, depth) {
    const L = this.fft.sizes[c]
    // long cascades vanish in shallow water, short ones persist until very shallow
    const d0 = Math.min(40, L * 0.08)
    const a = smoothstep(0.0, d0, depth)
    const floorAmt = [0.0, 0.05, 0.25, 0.5][c] ?? 0.5
    return mix(float(floorAmt).mul(smoothstep(0.0, 0.6, depth)), float(1), a)
  }

  // ------------------------------------------------------------------ vertex

  vertex() {
    const fft = this.fft
    const { worldXZ, spacing } = this.cdlod.vertexNodes()
    const depth = this.seaDepth(worldXZ).toVar()

    const disp = vec3(0).toVar()
    const foam = float(0).toVar()
    for (let c = 0; c < fft.cascades; c++) {
      const L = fft.sizes[c]
      const texel = L / FFT_SIZE
      // band-limit to the mesh spacing to avoid aliasing / swimming
      const level = max(log2(spacing.div(texel)).add(0.7), 0)
      const att = this.cascadeAttenuation(c, depth)
      const s = this.dispTex.sample(worldXZ.div(L)).depth(c).level(level)
      disp.addAssign(s.xyz.mul(att))
      // foam coverage is smooth enough to evaluate per vertex (sampled at a fixed detail level)
      const fs = this.dispTex.sample(worldXZ.div(L)).depth(c).level(max(level, 1.5)).w
      foam.addAssign(fs.mul(this.foamWeights[c]).mul(att))
    }

    disp.mulAssign(this.amplitude)

    const extra = vec3(0).toVar()
    const shoreN = vec3(0, 1, 0).toVar()
    const shoreFoam = float(0).toVar()
    const swash = float(0).toVar()
    const surfMask = vec2(0).toVar() // clear plunging face, whitewater roller relief (m)
    const ground = this.terrain ? this.terrain.heightAt(worldXZ).toVar() : float(-500)
    let swashLevel = null

    if (this.shore) {
      const sw = this.shore.evaluate(worldXZ, depth, ground)
      extra.addAssign(sw.disp)
      shoreN.assign(clamp(sw.nShore, vec3(-1), vec3(1)))
      shoreFoam.assign(sw.foam.add(sw.swashFoam.mul(smoothstep(0.4, -0.2, depth))))
      surfMask.assign(vec2(sw.face, sw.roller))
      swashLevel = sw.swashLevel
    }

    if (this.wake) extra.addAssign(this.wake.displacement(worldXZ, depth))

    const total = disp.add(extra).toVar()
    const y = G.seaLevel.add(total.y).toVar()

    if (swashLevel) {
      // thin run-up sheet on the sand: take whichever surface is higher (smooth max)
      const k = 0.04
      // no run-up sheet on steep rock (cliffs, sea stacks): waves break against it instead
      const nr = this.terrain ? this.terrain.normalRock(worldXZ, 0).toVar() : vec4(0)
      const gentle = this.terrain ? smoothstep(0.45, 0.25, length(nr.xy)) : float(1)
      const hmx = saturate(swashLevel.sub(y).div(k).mul(0.5).add(0.5)).mul(gentle).toVar()
      const smax = mix(y, swashLevel, hmx).add(hmx.mul(float(1).sub(hmx)).mul(k))
      swash.assign(smoothstep(-0.02, 0.03, swashLevel.sub(y)))
      y.assign(smax)
      // Where the sheet is the surface it is the sheet that is seen, not the wave below it: the sheet
      // lies on the sand (the sand's slope, no horizontal wave motion, no plunging face / roller).
      // Otherwise the backwash sheet over the lower beach face, exposed by the trough of the next
      // wave, keeps the trough's tilted normal and motion and reads as a separate dark strip
      // between the sea and the thin film further up.
      shoreN.assign(normalize(mix(shoreN, vec3(nr.x, 1, nr.y), hmx)))
      const still = float(1).sub(hmx)
      total.assign(vec3(total.x.mul(still), total.y, total.z.mul(still)))
      surfMask.mulAssign(still)
    }

    if (this.terrain) {
      // hide the water sheet below dry land (beyond the swash zone)
      const below = select(depth.lessThan(-3), min(ground.sub(2.0), G.seaLevel.sub(1.0)), ground.sub(0.06))
      y.assign(select(y.lessThan(ground), min(y, below), y))
    }

    const position = vec3(worldXZ.x.add(total.x), y, worldXZ.y.add(total.z))

    return { position, lagXZ: worldXZ, height: total.y, depth, foam, shoreN, shoreFoam, swash, surfMask }
  }

  // ------------------------------------------------------------------ fragment

  // extraFoam: foam carried by the water (ShoreSim); opts: simState (ShoreSim.sample() here),
  // surfMask (vec2: clear face of a plunging wave, whitewater roller relief, from vertex())
  fragment(
    lagXZ,
    footprint,
    depth,
    vertexFoam,
    shoreN = null,
    shoreFoam = null,
    extraFoam = null,
    { simState = null, surfMask = null } = {},
  ) {
    const fft = this.fft
    const d = vec4(0).toVar()
    const foamSum = float(0).toVar()
    // the clear concave face of a plunging wave overhangs the trough: the foam carried by the
    // (depth-averaged, world-space) shore simulation below it is not on the face
    const face = surfMask ? saturate(surfMask.x) : float(0)
    // (some of it stays: the lace of the previous wave is drawn up the face)
    const simFoam = extraFoam ? extraFoam.mul(float(1).sub(face.mul(0.72))).toVar() : float(0)
    if (extraFoam) foamSum.addAssign(simFoam)
    // bubbles mixed into the water (milky, turquoise, hides the bottom): surf and wake
    const aeration = float(0).toVar()

    // world-space gusts / slicks modulate the short wind waves (non-repeating dark and bright patches)
    const det = this.detail ? this.detail.sample(lagXZ) : null
    const rough = det ? det.rough.toVar() : float(1)

    for (let c = 0; c < fft.cascades; c++) {
      const L = fft.sizes[c]
      const uv = lagXZ.div(L)
      let att = this.cascadeAttenuation(c, depth)
      if (det && c >= fft.cascades - 2) att = att.mul(rough)
      else if (det && c === fft.cascades - 3) att = att.mul(mix(float(1), rough, 0.4))
      d.addAssign(this.derivTex.sample(uv).depth(c).mul(att))
    }

    d.mulAssign(vec4(this.amplitude, this.amplitude, this.amplitude, this.amplitude))
    const slopes = vec2(d.x.div(max(d.z.add(1), 0.2)), d.y.div(max(d.w.add(1), 0.2))).toVar()

    // Near-field capillary ripples. Within a few metres of the camera a pixel covers less than
    // the finest cascade's texel (~3 cm), so the surface looks glassy. Re-sample that cascade at
    // ~1 m and ~2.3 m tiles (rotated, so they never line up with it) wherever the footprint is
    // small. Damped in slicks with the short wind waves. Explicit LOD: this runs in a branch.
    const cN = fft.cascades - 1
    const near = smoothstep(0.04, 0.01, footprint).mul(rough).toVar()
    If(near.greaterThan(0.002), () => {
      const Lf = fft.sizes[cN]
      const rot = (v, a) =>
        vec2(v.x.mul(Math.cos(a)).sub(v.y.mul(Math.sin(a))), v.x.mul(Math.sin(a)).add(v.y.mul(Math.cos(a))))
      const k1 = 7.3,
        k2 = 3.1
      const texel1 = Lf / k1 / FFT_SIZE,
        texel2 = Lf / k2 / FFT_SIZE
      const c1 = this.derivTex
        .sample(rot(lagXZ, 0.63).mul(k1 / Lf))
        .depth(cN)
        .level(max(log2(footprint.div(texel1)), 0))
      const c2 = this.derivTex
        .sample(rot(lagXZ, 2.14).mul(k2 / Lf))
        .depth(cN)
        .level(max(log2(footprint.div(texel2)), 0))
      // gradients back into world axes (transpose of the rotation)
      const g = rot(c1.xy, -0.63).mul(0.55).add(rot(c2.xy, -2.14).mul(0.35))
      slopes.addAssign(g.mul(near))
    })
    const jac = d.z.add(1).mul(d.w.add(1))

    if (this.wake) {
      const w = this.wake.fragment(lagXZ, depth)
      slopes.addAssign(w.slopes)
      foamSum.addAssign(w.foam)
      if (w.aeration) aeration.addAssign(w.aeration)
    }

    // base normal: large shoreline waves (per-vertex, can overhang) perturbed by FFT detail
    let normal
    let baseNormal = null
    if (shoreN) {
      // On a coarse mesh the shore normal can flip between the vertices of a folding crest: the
      // interpolated vector then cancels out (or is NaN). Keep it finite and facing up; NaN
      // would otherwise surface as a white-hot cell after the output clamp.
      const sn = clamp(shoreN, vec3(-1), vec3(1)).add(vec3(0, 1e-3, 0))
      const Ns0 = sn.div(max(length(sn), 1e-4))
      const Ns = normalize(vec3(Ns0.x, max(Ns0.y, 0.12), Ns0.z)).toVar()
      baseNormal = Ns
      // the ripples and chop ride on the wave: the detail normal is rotated onto the tilted face
      // (reoriented normal mapping) instead of being flattened by it, so a steep face keeps the
      // full texture of the sea surface rather than turning into smooth plastic
      const nd = normalize(vec3(slopes.x.negate(), 1, slopes.y.negate()))
      const tq = Ns.add(vec3(0, 1, 0))
      const uq = vec3(slopes.x, 1, slopes.y).mul(nd.y)
      normal = normalize(tq.mul(dot(tq, uq).div(tq.y)).sub(uq))
      foamSum.addAssign(shoreFoam.mul(this.shoreSim ? 0.55 : 1.0))
      // the roller and the water behind the plunge point are full of bubbles, decaying behind the
      // bore with the foam it sheds; the clear face of a plunging wave is not
      aeration.addAssign(
        saturate(shoreFoam.mul(1.2).add(simFoam.mul(0.7)))
          .mul(float(1).sub(face))
          .mul(smoothstep(-0.1, 0.3, depth)),
      )
    } else {
      normal = normalize(vec3(slopes.x.negate(), 1, slopes.y.negate()))
    }

    // evaluated once here: the foam hook reads it inside a branch, and a node first built inside
    // a branch would be unassigned (zero) everywhere else
    normal = normal.toVar()

    // whitecaps: persistent (per vertex) + fresh where the surface is compressed right now;
    // more of them inside gusts, plus windrow lines in fresh wind
    const fresh = saturate(this.fft.foamBias.sub(0.15).sub(jac).mul(2.0))
    let whitecaps = float(vertexFoam).add(fresh)
    if (det) whitecaps = whitecaps.mul(mix(float(0.5), float(1.5), det.gust)).add(det.streak.mul(0.5))
    const coverage = saturate(foamSum.add(whitecaps).mul(this.foamCoverage)).toVar()

    // foam pattern: an irregular bubbly mat thresholded by coverage, so foam grows, tears into
    // lace and dissolves naturally
    const ft = this.foamTex
    const fuv = lagXZ.mul(this.foamScale)
    const p1 = ft.sample(fuv)
    // second layer at another scale, rotated, to break repetition
    const r2 = vec2(fuv.x.mul(0.8).sub(fuv.y.mul(0.6)), fuv.x.mul(0.6).add(fuv.y.mul(0.8)))
    const p2 = ft.sample(r2.mul(2.37).add(vec2(0.31, 0.77)))
    const pattern = p1.x.mul(0.62).add(p2.x.mul(0.38)).toVar()
    const thresh = float(1.05).sub(coverage.mul(1.1))
    const soft = float(0.06).add(footprint.mul(0.1))
    const detail = smoothstep(thresh.sub(soft), thresh.add(soft), pattern).mul(p1.y.mul(0.25).add(0.8))
    // at distance the pattern averages out -> use coverage directly
    const far = smoothstep(0.15, 1.2, footprint)
    let foam = mix(detail, coverage.mul(0.85), far)
    // optional foam look (surf zone whitewater / lace, see SurfFoam)
    const foamInfo = this.foamShading
      ? this.foamShading({
          coverage,
          foam,
          footprint,
          depth,
          bubbles: p1.y,
          lagXZ,
          normal,
          baseNormal,
          fresh: shoreFoam || float(0),
          sim: simFoam,
          simState,
          roller: surfMask ? surfMask.y : float(0),
        })
      : null
    if (foamInfo) foam = foamInfo.foam

    return {
      normal,
      foam,
      foamInfo,
      coverage,
      slopes,
      jacobian: jac,
      rough,
      aeration: saturate(aeration),
      gust: det ? det.gust : float(0.5),
      slick: det ? det.slick : float(0),
    }
  }
}
