/**
 * Shadowed haze ("light shafts") for the aerial-perspective post-process.
 *
 * The AP LUT and the Sky-View LUT integrate in-scatter as if every point in
 * the air saw the sun. SebH's reference multiplies the *single-scattered sun
 * term* by an opaque shadow-map lookup inside `IntegrateScatteredLuminance`
 * (`getShadow`, RenderSkyCommon.hlsl:419; applied at RenderSkyRayMarching.hlsl
 * :197 — the multi-scattered term stays unshadowed). Doing that for real would
 * mean re-integrating every pixel. Instead this module computes only the
 * **shadow deficit**:
 *
 *   D = ∫ T(cam→t) · T(t→sun) · σₛ·p(θ) · (1 − V(t)) dt
 *
 * over the part of the view ray that lies inside the light's shadow frustum
 * (an oriented box for a `DirectionalLight`), in a separate, by default
 * half-resolution pass. The haze pass then removes it: sky pixels lose D
 * itself; geometry loses the fraction D / L_full of its AP in-scatter, where
 * L_full is the same model's unshadowed in-scatter over the whole path (see
 * `buildFullPathInscatter` for why not D). Outside the box V = 1 by
 * definition, so a ray that misses the box removes exactly zero. Same idea as
 * Bruneton's `shadow_length`, but against an arbitrary shadow map instead of
 * one analytic sphere.
 *
 * Units: the march runs in scene metres (shadow-map space), every atmosphere
 * quantity is in km like the rest of the library, and D is per unit sun
 * illuminance (the LUT convention), scaled by `luminanceScale` in the pass.
 */
import { DepthTexture, HalfFloatType, Matrix4, NearestFilter, Vector2 } from 'three/webgpu'
import {
  Fn,
  If,
  Loop,
  dot,
  exp,
  float,
  floor,
  fract,
  int,
  ivec2,
  length,
  log,
  max,
  min,
  pow,
  rtt,
  screenCoordinate,
  texture,
  textureLoad,
  textureSize,
  uniform,
  vec2,
  vec3,
  vec4,
  clamp,
  abs,
  select,
} from 'three/tsl'

import {
  computeScatteringAbsorption,
  hgPhase,
  multiScatterLutParamsToUv,
  rayleighPhase,
  raySphereIntersectNearest,
  transmittanceLutParamsToUv,
} from '../backends/tsl/atmosphere.tsl'
import { lutTextureSize } from '../core/resolutions'

/** Anything with a three `DirectionalLight` shadow: the light itself or a `SkySun`. */
export type HazeShadowLightInput = any

export interface HazeShadowOptions {
  /**
   * The shadow-casting `DirectionalLight` (or a `SkySun`, whose `.light` is
   * used). Needs `castShadow = true`, `renderer.shadowMap.enabled = true` and
   * at least one lit material in the scene so three allocates the shadow map.
   */
  light?: HazeShadowLightInput
  /** March steps per pixel inside the shadow frustum. Default 32. Live. */
  samples?: number
  /** Cap on the marched distance from the camera, in metres. Default 20000. Live. */
  maxDistance?: number
  /** Multiplier on the removed in-scatter. 0 skips the march entirely. Default 1. Live. */
  strength?: number
  /**
   * Resolution of the march relative to the drawing buffer. Default 0.5 (a
   * quarter of the pixels), joint-bilateral upsampled against scene depth so
   * silhouettes stay sharp. 1 marches every pixel. Live.
   */
  resolution?: number
}

export const HAZE_SHADOW_DEFAULTS = { samples: 32, maxDistance: 20000, strength: 1, resolution: 0.5 } as const

/**
 * Uniform bundle + late-binding state for one shadow-casting light. Created by
 * `createHazeShadowState`; `applyHaze` stores it on the `Sky` as
 * `sky._hazeShadow` so `sky.setHazeShadows()` can drive it live.
 */
export interface HazeShadowState {
  light: any
  samples: any
  maxDistance: any
  strength: any
  /** World → shadow-texture matrix (`light.shadow.matrix`), copied each render. */
  matrix: any
  mapSize: any
  bias: any
  /** 1 once the light's real shadow depth texture is bound, else 0. Drives the swap. */
  ready: any
  placeholder: DepthTexture
  /** Every texture node built against the shadow map; the swap retargets each. */
  textureNodes: Set<any>
  resolution: number
  /** The march passes (RTT nodes) built from this state, resized by `resolution`. */
  passes: Set<any>
}

/** Accept a `DirectionalLight` or anything that wraps one as `.light` (SkySun). */
export function resolveShadowLight(input: HazeShadowLightInput): any {
  if (!input) return null
  if (input.isDirectionalLight) return input
  if (input.light && input.light.isDirectionalLight) return input.light
  throw new Error('haze shadows: `light` must be a DirectionalLight (or a SkySun).')
}

export function createHazeShadowState(options: HazeShadowOptions = {}): HazeShadowState {
  // A private 1×1 placeholder. The shadow map only exists after three's
  // ShadowNode has been set up by a lit material — usually during the first
  // scene-pass render, i.e. *after* this post node is built — so the texture
  // node starts here and is retargeted in the `ready` update below. Nearest +
  // no compare function keeps the binding a plain `texture_depth_2d` without a
  // sampler, which stays layout-compatible with the real (PCF, compare) map
  // because we only ever `textureLoad` it. Each state owns its placeholder: a
  // placeholder shared between texture nodes breaks late swaps (see the stars
  // notes in CLAUDE.md's memory).
  const placeholder = new DepthTexture(1, 1)
  placeholder.name = 'HazeShadowPlaceholder'
  placeholder.minFilter = NearestFilter
  placeholder.magFilter = NearestFilter
  placeholder.compareFunction = null

  const state: HazeShadowState = {
    light: resolveShadowLight(options.light),
    samples: uniform(Math.max(1, Math.round(options.samples ?? HAZE_SHADOW_DEFAULTS.samples)), 'int'),
    maxDistance: uniform(options.maxDistance ?? HAZE_SHADOW_DEFAULTS.maxDistance),
    strength: uniform(options.strength ?? HAZE_SHADOW_DEFAULTS.strength),
    matrix: uniform(new Matrix4()),
    mapSize: uniform(new Vector2(1, 1)),
    bias: uniform(0),
    ready: null,
    placeholder,
    textureNodes: new Set(),
    resolution: clampResolution(options.resolution ?? HAZE_SHADOW_DEFAULTS.resolution),
    passes: new Set(),
  }

  // Runs once per render of the march pass, after that pass's `updateBefore`
  // (the scene pass, which renders the shadow map and refreshes
  // `light.shadow.matrix`) and before bindings are updated — so the frame that
  // first creates the shadow map already reads it.
  state.ready = uniform(0).onRenderUpdate(() => {
    const light = state.light
    const depthTexture = light && light.castShadow ? light.shadow?.map?.depthTexture : null
    const target = depthTexture ?? state.placeholder
    for (const node of state.textureNodes) if (node.value !== target) node.value = target
    if (!depthTexture) return 0
    state.matrix.value.copy(light.shadow.matrix)
    state.mapSize.value.set(depthTexture.image.width, depthTexture.image.height)
    state.bias.value = light.shadow.bias
    return 1
  })

  return state
}

/** Apply a partial options object to an existing state (the live setter path). */
export function updateHazeShadowState(state: HazeShadowState, options: HazeShadowOptions) {
  if (options.light !== undefined) state.light = resolveShadowLight(options.light)
  if (typeof options.samples === 'number') state.samples.value = Math.max(1, Math.round(options.samples))
  if (typeof options.maxDistance === 'number') state.maxDistance.value = Math.max(0, options.maxDistance)
  if (typeof options.strength === 'number') state.strength.value = options.strength
  if (typeof options.resolution === 'number') {
    state.resolution = clampResolution(options.resolution)
    for (const pass of state.passes) pass.setResolutionScale(state.resolution)
  }
}

function clampResolution(value: number) {
  return Math.min(1, Math.max(0.125, value))
}

/** Free the render targets of march passes built from this state so far. */
export function releaseHazeShadowPasses(state: HazeShadowState) {
  for (const pass of state.passes) pass.renderTarget.dispose()
  state.passes.clear()
  // Their texture nodes go with them; the next pass registers its own on build.
  state.textureNodes.clear()
}

export function disposeHazeShadowState(state: HazeShadowState | null | undefined) {
  if (!state) return
  releaseHazeShadowPasses(state)
  state.placeholder.dispose()
  state.light = null
}

/**
 * ∫₀ᴸ exp(a·h(s)) ds for an altitude that varies linearly from h0 to h1 over
 * the path length L (km) — the exponential-density column along a straight,
 * scene-sized ray. `a` is the layer's (negative) density exponent scale.
 */
function lineDensityIntegral(a: any, h0: any, h1: any, lengthKm: any) {
  const y = a.mul(h1.sub(h0))
  // (eʸ − 1) / y, with its series near 0 where the quotient loses precision.
  const series = float(1.0).add(y.mul(0.5)).add(y.mul(y).div(6.0))
  const quotient = exp(y)
    .sub(1.0)
    .div(select(abs(y).lessThan(1e-3), float(1.0), y))
  const factor = select(abs(y).lessThan(1e-3), series, quotient)
  return lengthKm.mul(exp(a.mul(h0))).mul(factor)
}

/** Per-ray constants shared by the march and the full-path estimate. */
interface RayContext {
  cameraPositionKm: any
  rayDir: any
  params: any
  sunDirection: any
  transmittanceLUT: any
  /** Camera altitude above the ground sphere, km. */
  h0: any
  /** `apDistanceScale` (or 1): stretches optical paths like the AP lookup does. */
  pathScale: any
  miePhase: any
  rayPhase: any
}

function makeRayContext(
  cameraPositionKm: any,
  rayDir: any,
  sunDirection: any,
  params: any,
  transmittanceLUT: any,
  apDistanceScale: any,
): RayContext {
  // Phase is constant along the ray. Same convention as the integrator
  // (`hgPhase(-cosθ)` mirrors SebH's argument order).
  const cosTheta = dot(sunDirection, rayDir)
  return {
    cameraPositionKm,
    rayDir,
    params,
    sunDirection,
    transmittanceLUT,
    h0: length(cameraPositionKm).sub(params.bottomRadius),
    pathScale: apDistanceScale ? apDistanceScale : float(1.0),
    miePhase: hgPhase(cosTheta.negate(), params.miePhaseG),
    rayPhase: rayleighPhase(cosTheta),
  }
}

/**
 * The medium at distance `tM` (metres) along the ray, and the transmittance
 * from the camera to it. The column is integrated in closed form for an
 * altitude that varies linearly along the ray, which holds to a few metres of
 * altitude over the tens of kilometres a haze ray covers.
 */
function samplePath(ctx: RayContext, tM: any) {
  const { params } = ctx
  const lengthKm = tM.mul(0.001)
  const pKm = ctx.cameraPositionKm.add(ctx.rayDir.mul(lengthKm))
  const radius = length(pKm)
  const h1 = radius.sub(params.bottomRadius)
  // Ozone only exists well above scene altitudes in the tent profile; a
  // midpoint density is plenty for its share of the transmittance.
  const hMid = length(ctx.cameraPositionKm.add(ctx.rayDir.mul(lengthKm.mul(0.5)))).sub(params.bottomRadius)
  const ozone = computeScatteringAbsorption(hMid, params).absorptionExtinction
  const opticalDepth = params.rayleighScattering
    .mul(lineDensityIntegral(params.rayleighDensityExpScale, ctx.h0, h1, lengthKm))
    .add(params.mieExtinction.mul(lineDensityIntegral(params.mieDensityExpScale, ctx.h0, h1, lengthKm)))
    .add(ozone.mul(lengthKm))
    .mul(ctx.pathScale)
  const medium = computeScatteringAbsorption(h1, params)
  return {
    pKm,
    radius,
    altitude: h1,
    transmittance: exp(opticalDepth.negate()),
    medium,
    phaseTimesScattering: medium.mieScattering.mul(ctx.miePhase).add(medium.rayleighScattering.mul(ctx.rayPhase)),
  }
}

/**
 * Sun light reaching a point, per unit illuminance: T(→sun) × earth shadow.
 *
 * The earth-shadow test starts from a point held at least 10 m above the
 * ground sphere. Surface points come from the depth buffer and from scenes
 * whose ground is a flat plane, so they land a few metres either side of the
 * sphere; tested as they are, the ones below it read "in the planet's shadow"
 * and the in-scatter estimate flips between two values along depth-buffer
 * steps (horizontal streaks on the ground, worst while the camera moves).
 * Held above the sphere, the test only fails when the sun is below the local
 * horizon, which is what it is for.
 */
function sunLightAt(ctx: RayContext, pKm: any, radius: any) {
  const up = pKm.div(max(radius, float(1e-6)))
  const sunCos = dot(ctx.sunDirection, up)
  const tSun = texture(ctx.transmittanceLUT, transmittanceLutParamsToUv(radius, sunCos, ctx.params)).level(0).rgb
  const liftedKm = up.mul(max(radius, ctx.params.bottomRadius).add(0.01))
  const tEarth = raySphereIntersectNearest(liftedKm, ctx.sunDirection, vec3(0.0), ctx.params.bottomRadius)
  return { light: tSun.mul(select(tEarth.greaterThanEqual(0.0), float(0.0), float(1.0))), sunCos }
}

interface ShadowDeficitArgs {
  state: HazeShadowState
  /** Camera world position, metres. */
  rayOriginM: any
  /** Normalized world-space view ray (Y-up world == atmosphere frame). */
  rayDir: any
  /** End of the camera ray in metres: surface distance, or +∞ for sky pixels. */
  rayEndM: any
  /** Planet-centred camera position, km. */
  cameraPositionKm: any
  sunDirection: any
  params: any
  transmittanceLUT: any
  /** Optional AP distance scale — stretches the optical path like the AP lookup. */
  apDistanceScale?: any
  /** `renderer.reversedDepthBuffer` flips the depth comparison. */
  reversedDepth?: boolean
}

/**
 * Build the per-pixel deficit march. Must be called inside a TSL `Fn` body.
 * Returns `.toVar()` nodes: `deficit` (vec3, per unit sun illuminance) and
 * `occlusion` (fraction of marched samples in shadow, for debug views).
 */
export function buildShadowDeficit({
  state,
  rayOriginM,
  rayDir,
  rayEndM,
  cameraPositionKm,
  sunDirection,
  params,
  transmittanceLUT,
  apDistanceScale = null,
  reversedDepth = false,
}: ShadowDeficitArgs): { deficit: any; occlusion: any; segmentM: any } {
  const deficit = vec3(0.0, 0.0, 0.0).toVar()
  const occlusion = float(0.0).toVar()
  const segmentM = float(0.0).toVar()

  // Ray in shadow-texture space. For an orthographic shadow camera the matrix
  // is affine, so the ray stays a ray: s(t) = o + t·d with t in world metres,
  // and the shadow frustum is the unit cube. (xy ∈ [0,1] is the map, y not yet
  // flipped; z ∈ [0,1] is WebGPU depth.)
  const o = state.matrix.mul(vec4(rayOriginM, 1.0)).xyz.toVar()
  const dRaw = state.matrix.mul(vec4(rayDir, 0.0)).xyz
  // Slab test. Nudge exact-zero components off zero so the division stays
  // finite (WGSL leaves float division by zero indeterminate).
  const tiny = float(1e-12)
  const d = select(abs(dRaw).lessThan(vec3(tiny)), vec3(tiny), dRaw)
  const tA = o.negate().div(d)
  const tB = vec3(1.0).sub(o).div(d)
  const tNear = min(tA, tB)
  const tFar = max(tA, tB)
  const tEnter = max(max(tNear.x, tNear.y), max(tNear.z, float(0.0)))
  const tExit = min(min(tFar.x, tFar.y), min(tFar.z, min(rayEndM, state.maxDistance)))

  const active = tExit
    .greaterThan(tEnter)
    .and(state.strength.greaterThan(float(0.0)))
    .and(state.ready.greaterThan(float(0.5)))

  If(active, () => {
    const tIn = tEnter.toVar()
    const segLen = tExit.sub(tEnter)
    segmentM.assign(segLen)
    const n = state.samples
    const dtM = segLen.div(float(n))
    const kmPerM = apDistanceScale ? float(0.001).mul(apDistanceScale) : float(0.001)
    const dtKm = dtM.mul(kmPerM)

    // Interleaved gradient noise (Jimenez 2014) on the pixel grid: a stable
    // per-pixel offset for the stratified samples. Without it every pixel steps
    // the same distances and the shadow edges alias into bands.
    const pix = floor(screenCoordinate.xy)
    const jitter = fract(float(52.9829189).mul(fract(dot(pix, vec2(0.06711056, 0.00583715)))))

    const ctx = makeRayContext(cameraPositionKm, rayDir, sunDirection, params, transmittanceLUT, apDistanceScale)

    // Earth shadow and transmittance-to-sun change on the scale of kilometres
    // of altitude; the shadow segment is scene-sized. Evaluate once at the
    // segment midpoint.
    const mid = samplePath(ctx, tIn.add(segLen.mul(0.5)))
    const sunLight = sunLightAt(ctx, mid.pKm, mid.radius).light

    // Everything in the integrand except the visibility is smooth along the
    // ray: f(t) = T(cam→t) · (σₛᴹ(h)·pᴹ + σₛᴿ(h)·pᴿ). Over a scene-sized
    // segment f is a product of exponentials in t (exponential density on a
    // near-straight altitude profile, and its integral in the transmittance),
    // so it is evaluated exactly at the first and last sample and
    // interpolated geometrically in between — one multiply per step instead
    // of a medium evaluation and three `exp`s. The loop is left with the
    // shadow-map fetch, which is the only thing that is not smooth.
    const evalF = (tM: any) => {
      const sp = samplePath(ctx, tM)
      return sp.transmittance.mul(sp.phaseTimesScattering)
    }
    const nF = float(n)
    const tFirst = tIn.add(jitter.mul(dtM))
    const tLast = tIn.add(nF.sub(1.0).add(jitter).mul(dtM))
    const fFirst = max(evalF(tFirst), vec3(1e-30))
    const fLast = max(evalF(tLast), vec3(1e-30))
    const ratio = pow(fLast.div(fFirst), vec3(float(1.0).div(max(nF.sub(1.0), float(1.0)))))
    const f = fFirst.toVar()

    const shadowSize = state.mapSize
    const maxTexel = ivec2(shadowSize.sub(1.0))
    const occluded = float(0.0).toVar()

    Loop({ start: int(0), end: n, type: 'int', condition: '<' }, ({ i }: any) => {
      const t = tIn.add(float(i).add(jitter).mul(dtM))

      // Shadow-map visibility. `textureLoad` (no sampler, no derivatives) is
      // legal in this non-uniform loop; nearest texels are fine because the
      // jittered march already averages many of them per pixel.
      const s = o.add(d.mul(t))
      const texel = clamp(ivec2(floor(vec2(s.x, float(1.0).sub(s.y)).mul(shadowSize))), ivec2(0, 0), maxTexel)
      const loadNode = textureLoad(state.placeholder, texel)
      state.textureNodes.add(loadNode)
      const stored = loadNode.x
      const ref = reversedDepth ? s.z.sub(state.bias) : s.z.add(state.bias)
      const isOccluded = reversedDepth ? ref.lessThan(stored) : ref.greaterThan(stored)
      occluded.assign(select(isOccluded, float(1.0), float(0.0)))

      deficit.addAssign(f.mul(occluded))
      occlusion.addAssign(occluded)
      f.mulAssign(ratio)
    })

    deficit.assign(deficit.mul(sunLight).mul(dtKm).mul(state.strength))
    occlusion.assign(occlusion.div(float(n)))
  })

  return { deficit, occlusion, segmentM }
}

/**
 * In-scatter the unshadowed atmosphere adds between the camera and a surface
 * `endM` metres away, per unit sun illuminance: single scattering plus the
 * multiple-scattering term, the same model the AP LUT integrates. Used to turn
 * the absolute deficit into the *fraction* of in-scatter in shadow, which the
 * haze pass then applies to the AP LUT's own value. Subtracting the absolute
 * deficit instead left stripes along the AP LUT's depth slices wherever a ray
 * was shadowed end to end (the LUT's interpolated value and the march's exact
 * one disagree by a few percent, and the clamp at zero flips across slices).
 *
 * Integrated over four intervals, each exactly for an exponential integrand
 * (∫ = h·(g₁ − g₀)/ln(g₁/g₀)), which is what T·σ is along a straight ray.
 */
export function buildFullPathInscatter({
  endM,
  rayDir,
  cameraPositionKm,
  sunDirection,
  params,
  transmittanceLUT,
  multiScatterLUT,
  apDistanceScale = null,
}: {
  endM: any
  rayDir: any
  cameraPositionKm: any
  sunDirection: any
  params: any
  transmittanceLUT: any
  multiScatterLUT: any
  apDistanceScale?: any
}): any {
  const ctx = makeRayContext(cameraPositionKm, rayDir, sunDirection, params, transmittanceLUT, apDistanceScale)
  const multiScatterSize = lutTextureSize(multiScatterLUT)
  const integrand = (tM: any) => {
    const sp = samplePath(ctx, tM)
    const sun = sunLightAt(ctx, sp.pKm, sp.radius)
    // Multi-scatter LUT lookup, as in `integrateScatteredLuminance`
    // (sub-texel corrected at the LUT's own size).
    const atmosphereThickness = params.topRadius.sub(params.bottomRadius)
    const altitude01 = clamp(sp.altitude.div(max(atmosphereThickness, float(1e-6))), float(0.0), float(1.0))
    const msUv = multiScatterLutParamsToUv(sun.sunCos, altitude01, multiScatterSize)
    const ms = texture(multiScatterLUT, msUv).level(0).rgb
    const single = sp.phaseTimesScattering.mul(sun.light)
    const multiple = ms.mul(sp.medium.scattering).mul(params.multiScatteringFactor)
    return max(sp.transmittance.mul(single.add(multiple)), vec3(1e-30))
  }
  const intervals = 4
  const hKm = endM.mul(0.001).mul(ctx.pathScale).div(float(intervals))
  const total = vec3(0.0).toVar()
  let g0 = integrand(float(0.0))
  for (let k = 1; k <= intervals; k++) {
    const g1 = integrand(endM.mul(k / intervals))
    const logRatio = log(g1.div(g0))
    const expFit = g1.sub(g0).div(select(abs(logRatio).lessThan(vec3(1e-4)), vec3(1.0), logRatio))
    const trapezoid = g0.add(g1).mul(0.5)
    total.addAssign(select(abs(logRatio).lessThan(vec3(1e-4)), trapezoid, expFit).mul(hKm))
    g0 = g1
  }
  return total
}

/** Per-pixel view ray for the march pass, rebuilt inside that pass's shader. */
export interface ShadowPassRay {
  /** Normalized world-space direction. */
  rayDir: any
  /** Camera → surface distance along the ray, metres (ignored for sky). */
  distanceM: any
  /** True for background pixels. */
  isSky: any
}

interface ShadowPassArgs extends Omit<ShadowDeficitArgs, 'rayDir' | 'rayEndM'> {
  /** Builds the view ray from `uv()`; called inside the pass's own shader. */
  buildRay: () => ShadowPassRay
  /** `luminanceScale` — applied in the pass so the half-float target keeps precision. */
  luminanceScale: any
  /** Multi-Scatter LUT texture, for the full-path in-scatter estimate. */
  multiScatterLUT: any
  /** Store the occluded-sample fraction instead of the deficit (debug view). */
  outputOcclusion?: boolean
}

/**
 * The march as its own full-screen pass (an `RTTNode`), at
 * `state.resolution` × the drawing buffer. Output rgb: for sky pixels the
 * deficit × `luminanceScale`; for geometry the in-shadow fraction of the
 * path's in-scatter (0–1). Output a: surface distance in km (−1 for sky),
 * which the upsample uses to keep silhouettes sharp and to keep the two
 * encodings apart.
 *
 * Why a separate pass: the march is the cost (measured at 1080p, 32 samples,
 * most of the frame inside the shadow frustum: +2.1–2.8 ms whether inline in
 * the haze shader or in its own full-resolution pass), so the lever is the
 * pixel count. At the default half resolution it is +0.6–1.1 ms, and the
 * deficit is smooth enough that the depth-aware upsample loses nothing
 * visible except at shaft edges (softer by a pixel).
 */
export function createShadowDeficitPass({
  state,
  buildRay,
  luminanceScale,
  multiScatterLUT,
  outputOcclusion = false,
  ...rest
}: ShadowPassArgs): any {
  const node = Fn((builder: any) => {
    const ray = buildRay()
    const rayEndM = ray.isSky.select(float(1e30), ray.distanceM)
    const { deficit, occlusion } = buildShadowDeficit({
      ...rest,
      state,
      rayDir: ray.rayDir,
      rayEndM,
      reversedDepth: builder?.renderer?.reversedDepthBuffer === true,
    })
    const distKm = ray.isSky.select(float(-1.0), ray.distanceM.mul(0.001))
    if (outputOcclusion) return vec4(vec3(occlusion), distKm)

    // Sky pixels: the absolute deficit (× luminanceScale), subtracted from the
    // sky's radiance. Geometry: the fraction of the path's in-scatter that is
    // in shadow, applied to the AP value (see `buildFullPathInscatter`).
    const out = deficit.mul(luminanceScale).toVar()
    If(ray.isSky.not().and(deficit.x.add(deficit.y).add(deficit.z).greaterThan(0.0)), () => {
      const full = buildFullPathInscatter({
        endM: ray.distanceM,
        rayDir: ray.rayDir,
        cameraPositionKm: rest.cameraPositionKm,
        sunDirection: rest.sunDirection,
        params: rest.params,
        transmittanceLUT: rest.transmittanceLUT,
        multiScatterLUT,
        apDistanceScale: rest.apDistanceScale,
      })
      out.assign(min(deficit.div(max(full, vec3(1e-12))), vec3(1.0)))
    })
    return vec4(out, distKm)
  })()
  const pass = rtt(node, null, null, { type: HalfFloatType, depthBuffer: false })
  pass.setResolutionScale(state.resolution)
  pass.name = 'HazeShadowDeficit'
  state.passes.add(pass)
  return pass
}

/**
 * Joint-bilateral upsample of the march pass at the current fragment: the
 * four nearest low-resolution texels, bilinear weights times a depth
 * agreement weight, so shafts do not bleed across silhouettes (sky texels
 * only feed sky pixels, and geometry texels only feed geometry, weighted
 * toward surfaces at a similar distance). At `resolution: 1` it reduces to reading the pixel's own texel.
 */
export function upsampleShadowDeficit({
  pass,
  uvNode,
  distanceM,
  isSky,
}: {
  pass: any
  uvNode: any
  distanceM: any
  isSky: any
}): any {
  const size = vec2(textureSize(pass, int(0)))
  const p = uvNode.mul(size).sub(0.5)
  const base = floor(p)
  const fr = p.sub(base)
  const maxTexel = ivec2(size.sub(1.0))
  const pixelKm = max(distanceM.mul(0.001), float(1e-4))
  const sum = vec3(0.0, 0.0, 0.0).toVar()
  const weightSum = float(0.0).toVar()
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const texel = clamp(ivec2(base.add(vec2(dx, dy))), ivec2(0, 0), maxTexel)
    const tap = pass.load(texel)
    const wx = dx ? fr.x : float(1.0).sub(fr.x)
    const wy = dy ? fr.y : float(1.0).sub(fr.y)
    const tapSky = tap.a.lessThan(0.0)
    // Relative distance mismatch: full weight within ~2 %, none past ~12 %.
    // The small floor keeps a plain bilinear answer when no geometry tap
    // agrees (thin geometry narrower than a low-res texel).
    const mismatch = abs(tap.a.sub(pixelKm)).div(pixelKm)
    const agreement = float(1.0)
      .sub(clamp(mismatch.sub(0.02).mul(10.0), float(0.0), float(1.0)))
      .add(1e-3)
    // Sky and geometry texels hold different quantities (absolute deficit vs
    // fraction), so a tap of the other kind never contributes — not even as a
    // fallback. A pixel with no tap of its own kind removes nothing.
    const sameKind = select(isSky, tapSky, tapSky.not())
    const w = wx.mul(wy).mul(select(sameKind, select(isSky, float(1.0), agreement), float(0.0)))
    sum.addAssign(tap.rgb.mul(w))
    weightSum.addAssign(w)
  }
  return select(weightSum.greaterThan(0.0), sum.div(max(weightSum, float(1e-9))), vec3(0.0))
}
