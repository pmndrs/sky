/**
 * Sky-coloured exponential height fog — the budget haze tier.
 *
 * Density falls off exponentially with height above `baseHeight`:
 *
 *   σ(h) = σ₀ · e^(−(h − h₀) / H)
 *
 * so the optical depth along a straight view ray has a closed form, and the
 * in-scattered colour is the baked sky cube sampled along that ray: distant
 * geometry fades into the sky that is actually behind it (sun-side glow,
 * horizon gradient, twilight) instead of a constant colour. Per pixel that is
 * one cube sample and a few ALU, and nothing renders per frame — the cube
 * re-bakes only when the sun or the atmosphere change, like it always does.
 *
 * What it cannot do, next to aerial perspective (`applyHaze`): there is no
 * per-channel transmittance, so distant objects veil but never shift colour
 * through the air, and density is an art knob with no coupling to the
 * atmosphere parameters beyond the cube's colour.
 *
 * Units: metres for heights and distances, `density` per kilometre.
 */
import { Matrix4 } from 'three/webgpu'
import {
  Fn,
  If,
  abs,
  cubeTexture,
  dot,
  exp,
  float,
  length,
  max,
  min,
  mix,
  normalize,
  pmremTexture,
  select,
  smoothstep,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl'

import { createHazeDepthNodes, distanceAlongViewRay, rawDepthIsSky, viewRayFromUv } from './hazeScenePassDepth'

export interface FogOptions {
  /**
   * Extinction at `baseHeight`, per kilometre. Light falls to 1/e after
   * 1/density km of level ray at that height. Meteorological visibility is
   * ≈ 3.9/density km: 0.3 is a hazy day (~13 km), 4+ is fog (under 1 km).
   * Default 0.3. Live.
   */
  density?: number
  /**
   * Scale height in metres: density drops by 1/e for every `heightFalloff`
   * metres above `baseHeight` (and grows the same way below it). Small values
   * give a thin ground fog, large ones an evenly hazy atmosphere. Default
   * 300. Live.
   */
  heightFalloff?: number
  /** Altitude in metres at which density equals `density`. Default 0. Live. */
  baseHeight?: number
  /**
   * Cap on fog opacity (Unreal `FogMaxOpacity`): `1` lets distant geometry
   * vanish into the sky, lower values keep silhouettes, `0` turns the fog
   * off without a rebuild. Default 1. Live.
   */
  maxOpacity?: number
}

/** Floor on the scale height, so a 0 from a slider cannot divide by zero. */
const MIN_FALLOFF_M = 1e-3
/** Below this |x| the closed form is replaced by its series (f32 cancellation). */
const SERIES_LIMIT = 1e-3
/** `e^80` ≈ 5.5e34: far past opaque for any density, still finite in f32. */
const MAX_LOG_DENSITY = 80

export const FOG_DEFAULTS = { density: 0.3, heightFalloff: 300, baseHeight: 0, maxOpacity: 1 } as const

/** Live fog knobs: one uniform per `FogOptions` field. */
export interface FogState {
  density: any
  heightFalloff: any
  baseHeight: any
  maxOpacity: any
}

export function createFogState(options: FogOptions = {}): FogState {
  const state: FogState = {
    density: uniform(FOG_DEFAULTS.density),
    heightFalloff: uniform(FOG_DEFAULTS.heightFalloff),
    baseHeight: uniform(FOG_DEFAULTS.baseHeight),
    maxOpacity: uniform(FOG_DEFAULTS.maxOpacity),
  }
  updateFogState(state, options)
  return state
}

/** Apply the fields present in `options`; everything omitted is left as is. */
export function updateFogState(state: FogState, options: FogOptions = {}): void {
  const { density, heightFalloff, baseHeight, maxOpacity } = options
  if (typeof density === 'number') state.density.value = Math.max(0, density)
  if (typeof heightFalloff === 'number') state.heightFalloff.value = Math.max(MIN_FALLOFF_M, heightFalloff)
  if (typeof baseHeight === 'number') state.baseHeight.value = baseHeight
  if (typeof maxOpacity === 'number') state.maxOpacity.value = Math.min(1, Math.max(0, maxOpacity))
}

/**
 * `(1 − e^(−u)) / u` for u ≥ 0 — the fraction of a straight segment's
 * "densest-point" optical depth that the whole segment accumulates. Goes to 1
 * as the segment levels out (u → 0), where the closed form is 0/0, so small u
 * uses the series `1 − u/2 + u²/6`.
 */
export function segmentFraction(u: number): number {
  return u < SERIES_LIMIT ? 1 - u * (0.5 - u / 6) : -Math.expm1(-u) / u
}

export interface FogRay {
  /** Camera-to-surface distance along the ray, metres. */
  distance: number
  /** Cosine between the ray and local up (`dot(rayDir, up)`), −1..1. */
  rayUp: number
  /** Camera altitude, metres (world `y` on flat ground). */
  cameraHeight: number
}

/**
 * Optical depth of a straight ray through σ(h) = σ₀·e^(−(h − h₀)/H) — the
 * reference for the shader (`createFogOutputNode` evaluates the same
 * expression).
 *
 * With a = (h_cam − h₀)/H and x = distance·rayUp/H, the exact integral is
 * σ₀·distance·(e^(−a) − e^(−(a+x)))/x. Written as
 *
 *   σ₀ · distance · e^(−min(a, a+x)) · (1 − e^(−|x|)) / |x|
 *
 * it never forms a large exponential and divides by zero only at x = 0
 * (handled by `segmentFraction`). e^(−min) is the relative density at the
 * segment's lowest point.
 */
export function fogOpticalDepth(ray: FogRay, fog: FogOptions = {}): number {
  const density = Math.max(0, fog.density ?? FOG_DEFAULTS.density) * 1e-3
  const H = Math.max(MIN_FALLOFF_M, fog.heightFalloff ?? FOG_DEFAULTS.heightFalloff)
  const a = (ray.cameraHeight - (fog.baseHeight ?? FOG_DEFAULTS.baseHeight)) / H
  const x = (ray.distance * ray.rayUp) / H
  const lowest = a + Math.min(x, 0)
  return density * ray.distance * Math.exp(-Math.max(lowest, -MAX_LOG_DENSITY)) * segmentFraction(Math.abs(x))
}

/** Fog opacity, `min(1 − e^(−τ), maxOpacity)` — what the shader blends with. */
export function fogOpacity(ray: FogRay, fog: FogOptions = {}): number {
  const maxOpacity = Math.min(1, Math.max(0, fog.maxOpacity ?? FOG_DEFAULTS.maxOpacity))
  return Math.min(-Math.expm1(-fogOpticalDepth(ray, fog)), maxOpacity)
}

/**
 * Direction the fog colour is read from the sky cube, for a view ray `dir`
 * and local `up` (both unit). The vertical component is replaced by
 * `max(|s|, |horizontal|·minTan)`:
 *
 *  - **Below the horizon, mirrored.** The cube's lower hemisphere is not sky:
 *    without `mirrorBelowHorizon` it holds the in-scatter of the short path
 *    down to the ground (near black at ground level), with it a mirror of the
 *    sky. Mirroring here gives the same answer for both bakes. A plain clamp
 *    to the horizon would be the other option, but every azimuth would then
 *    converge on the nadir and swirl the sun-side and anti-sun colours round
 *    it; the mirror is continuous there (nadir → zenith). Most fogged pixels
 *    are long, near-level rays, where the two agree.
 *  - **Never closer than `minTan` to the horizon,** so filtering doesn't blend
 *    in the dark texels just below it: the shader uses one texel centre
 *    (`1 / cubeSize`, ~0.2° at 256) for the sharp cube and 3° for the blurred
 *    night sample.
 */
export function fogSampleDirection(
  dir: { x: number; y: number; z: number },
  up: { x: number; y: number; z: number },
  minTan: number,
): [number, number, number] {
  const s = dir.x * up.x + dir.y * up.y + dir.z * up.z
  const hx = dir.x - up.x * s
  const hy = dir.y - up.y * s
  const hz = dir.z - up.z * s
  const h = Math.hypot(hx, hy, hz)
  const v = Math.max(Math.abs(s), h * minTan)
  const x = hx + up.x * v
  const y = hy + up.y * v
  const z = hz + up.z * v
  const n = Math.hypot(x, y, z) || 1
  return [x / n, y / n, z / n]
}

/** Sun elevations (degrees) over which the night colour blends in, and its lift. */
const NIGHT_BLEND_START_DEG = -10
const NIGHT_BLEND_END_DEG = -16
const NIGHT_LIFT_DEG = 3
const DEG = Math.PI / 180

/**
 * How much of the blurred night colour the fog uses at sun elevation
 * `elevationDeg`: 0 down to −10°, 1 from −16°, smoothstep (on the sine)
 * between — the shader's weight. The baked Milky Way only shows in that range
 * (it fades in by contrast as twilight darkens); above it the sharp cube keeps
 * the twilight horizon colours.
 */
export function fogNightWeight(elevationDeg: number): number {
  const s0 = Math.sin(NIGHT_BLEND_END_DEG * DEG)
  const s1 = Math.sin(NIGHT_BLEND_START_DEG * DEG)
  const t = Math.min(1, Math.max(0, (Math.sin(elevationDeg * DEG) - s0) / (s1 - s0)))
  return 1 - t * t * (3 - 2 * t)
}

interface CreateFogOutputNodeArgs {
  /** `pass(scene, camera)`. Its camera's matrices drive the ray reconstruction. */
  scenePass: any
  /** Composite base; defaults to `scenePass.getTextureNode('output')`. */
  sceneColorNode?: any
  /** The baked sky cube (`sky.texture` / `baker.texture`). */
  skyCube: any
  /** Face size of `skyCube` in texels (`baker.cubeSize`). */
  cubeSize: number
  /** Live knobs from `createFogState`. */
  fog: FogState
  /** Camera altitude in metres (uniform). */
  cameraHeight: any
  /** Local up, Y-up world space (uniform; `baker.sky.upVector`). Default +Y. */
  upVector?: any
  /**
   * PMREM-filtered sky (`baker.environmentTexture`) for the night colour, or a
   * getter for it — read when the shader is built, i.e. at the first render,
   * by which time the first `sky.update()` has baked it. Without it (or
   * `sunDirection`) the fog always uses the sharp cube.
   */
  environment?: any
  /** Y-up world sun direction (uniform; `baker.sky.sunDirection`). */
  sunDirection?: any
  /** PMREM roughness of the night colour; 0 = always the sharp cube. Default 0.4. */
  nightBlur?: number
  /** Sky depth tolerance below 1.0 (`baker.skyDepthEpsilon`). Default 0. */
  skyDepthEpsilon?: any
  /** Must match `WebGPURenderer({ logarithmicDepthBuffer })`. */
  logarithmicDepthBuffer?: boolean
  /** `'fog-amount'` | `'fog-color'` | `'is-sky'` — diagnostic outputs. */
  debugMode?: string | null
}

/**
 * Build the height-fog output node (a `vec4`). Sky pixels (raw depth 1.0)
 * pass through untouched; geometry is blended toward the sky colour along its
 * ray by `min(1 − e^(−τ), maxOpacity)`.
 */
export function createFogOutputNode({
  scenePass,
  sceneColorNode = null,
  skyCube,
  cubeSize,
  fog,
  cameraHeight,
  upVector = null,
  environment = null,
  sunDirection = null,
  nightBlur = 0.4,
  skyDepthEpsilon = null,
  logarithmicDepthBuffer = false,
  debugMode = null,
}: CreateFogOutputNodeArgs): any {
  if (!skyCube) throw new Error('createFogOutputNode: `skyCube` is required.')
  if (!scenePass?.camera) throw new Error('createFogOutputNode: `scenePass` (with a camera) is required.')

  const sceneColor = sceneColorNode ?? scenePass.getTextureNode('output')
  const { viewZNode } = createHazeDepthNodes(scenePass, logarithmicDepthBuffer)

  // Read the pass camera's matrices at render time, so the fog needs no
  // per-frame call of its own and works without the aerial-perspective LUT
  // (whose camera uniforms the haze pass borrows).
  const invProj = uniform(new Matrix4()).onRenderUpdate(() => scenePass.camera.projectionMatrixInverse)
  const cameraWorld = uniform(new Matrix4()).onRenderUpdate(() => scenePass.camera.matrixWorld)
  const up = upVector ?? vec3(0.0, 1.0, 0.0)
  const skyEps = skyDepthEpsilon ?? uniform(0)
  // One texel centre above the horizon (see fogSampleDirection).
  const minTanSharp = 1 / Math.max(1, cubeSize)
  const minTanNight = Math.tan(NIGHT_LIFT_DEG * DEG)

  return Fn(() => {
    const u = uv()
    // A caller-supplied node is already screen-space; only the fallback
    // texture node needs the explicit sample (same contract as applyHaze).
    const base = sceneColorNode ? sceneColor : sceneColor.sample(u)

    const rayDirView = viewRayFromUv(u, invProj)
    const dir = normalize(cameraWorld.mul(vec4(rayDirView, float(0.0))).xyz).toVar()
    const distance = distanceAlongViewRay(viewZNode, rayDirView)
    const upN = normalize(up)
    const rayUp = dot(dir, upN)

    // Closed-form optical depth — same expression as `fogOpticalDepth`.
    const H = max(fog.heightFalloff, float(MIN_FALLOFF_M))
    const a = cameraHeight.sub(fog.baseHeight).div(H)
    const x = distance.mul(rayUp).div(H)
    const lowest = a.add(min(x, float(0.0)))
    const ux = abs(x)
    const fraction = select(
      ux.lessThan(float(SERIES_LIMIT)),
      float(1.0).sub(ux.mul(float(0.5).sub(ux.div(6.0)))),
      float(1.0)
        .sub(exp(ux.negate()))
        .div(max(ux, float(SERIES_LIMIT))),
    )
    const opticalDepth = fog.density
      .mul(1e-3)
      .mul(distance)
      .mul(exp(max(lowest, float(-MAX_LOG_DENSITY)).negate()))
      .mul(fraction)
    const amount = min(float(1.0).sub(exp(opticalDepth.negate())), fog.maxOpacity)

    // Fog colour: the sky behind the geometry, i.e. the cube along the ray —
    // mirrored below the horizon and kept off it (`fogSampleDirection`).
    // Level 0 explicitly: the cube has no mip chain on three r185, and an
    // implicit level would take screen-space derivatives in a post pass.
    const horizontal = dir.sub(upN.mul(rayUp))
    const horizontalLength = length(horizontal)
    const sharpDir = normalize(horizontal.add(upN.mul(max(abs(rayUp), horizontalLength.mul(minTanSharp)))))
    const color = cubeTexture(skyCube, sharpDir).level(float(0.0)).rgb.toVar()

    // At night the cube holds the baked Milky Way, which the sharp sample
    // would print onto fogged geometry (dust lanes and all). Blend to the
    // PMREM-blurred sky as the sun goes from −10° to −16°; a uniform branch, so
    // daytime pays for one sample. Not used by day: the blur reaches into the
    // dark half below the horizon and dulls the horizon colour.
    const env = typeof environment === 'function' ? environment() : environment
    if (env && sunDirection && nightBlur > 0) {
      const sinSun = dot(normalize(sunDirection), upN)
      const night = float(1.0).sub(
        smoothstep(float(Math.sin(NIGHT_BLEND_END_DEG * DEG)), float(Math.sin(NIGHT_BLEND_START_DEG * DEG)), sinSun),
      )
      If(night.greaterThan(0.0), () => {
        const nightDir = normalize(horizontal.add(upN.mul(max(abs(rayUp), horizontalLength.mul(minTanNight)))))
        color.assign(mix(color, pmremTexture(env, nightDir, float(nightBlur)).rgb, night))
      })
    }

    const isSky = rawDepthIsSky(scenePass, skyEps)

    if (debugMode === 'fog-amount') {
      const shown = isSky.select(float(0.0), amount)
      return vec4(shown, shown, shown, 1.0)
    }
    if (debugMode === 'fog-color') return vec4(color, 1.0)
    if (debugMode === 'is-sky') return vec4(isSky.select(vec3(1.0, 1.0, 1.0), vec3(0.0, 0.0, 0.0)), 1.0)

    const fogged = mix(base.rgb, color, amount)
    return vec4(mix(fogged, base.rgb, isSky.select(1.0, 0.0)), base.a)
  })()
}
