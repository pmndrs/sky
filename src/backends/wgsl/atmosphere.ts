/**
 * WebGPU-via-three backend: `wgslFn` wrappers over the engine-agnostic WGSL
 * core. These expose the atmosphere math as TSL-callable node-functions so the
 * LUT graphs run the *same* source as a future native baker.
 *
 * SINGLE SOURCE: each wrapper is `wgslFn(CHUNK)` where `CHUNK` is imported
 * verbatim from `core/wgsl/atmosphere.wgsl.ts` — the WGSL is authored once.
 * Shared leaf helpers (the sub-UV pair) are passed through the `includes`
 * array, which is why the core chunks are split one-function-per-string.
 *
 * Scope so far: the pure, texture-free helpers (phases, ray-sphere, spherical
 * sample dir, and the Sky-View UV param maps). Validated numerically against
 * the TSL twin by `examples/parity/00-leaf-helpers.html` and `01-uv-maps.html`.
 *
 * NOT YET wrapped (need struct-arg binding or texture/sampler params — deferred
 * to when they're wired into a real LUT, Phase 2/3):
 *   - computeScatteringAbsorption (params struct in, MediumSample struct out)
 *   - the transmittance UV maps (params struct in)
 *   - integrateScatteredLuminance (texture sampling + loop inside)
 *
 * Call convention is `fn({ namedArg, ... })` returning a TSL node, matching the
 * WGSL param names exactly.
 */

import { wgslFn } from 'three/tsl'

import {
  RAY_SPHERE,
  RAYLEIGH_PHASE,
  MIE_PHASE_CS,
  HG_PHASE,
  SPHERICAL_DIR,
  FROM_UNIT_TO_SUB_UVS,
  FROM_SUB_UVS_TO_UNIT,
  UV_TO_SKYVIEW_PARAMS,
  SKYVIEW_PARAMS_TO_UV,
} from '../../core/wgsl/atmosphere.wgsl.js'

// --- shared leaf helpers, wrapped once and threaded via `includes` ---
const fromUnitToSubUvs = /*@__PURE__*/ wgslFn(FROM_UNIT_TO_SUB_UVS)
const fromSubUvsToUnit = /*@__PURE__*/ wgslFn(FROM_SUB_UVS_TO_UNIT)

/** `{ ro: vec3, rd: vec3, center: vec3, radius: f32 }` → `f32`. */
export const raySphereIntersectNearest = /*@__PURE__*/ wgslFn(RAY_SPHERE)

/** `{ cosTheta: f32 }` → `f32`. */
export const rayleighPhase = /*@__PURE__*/ wgslFn(RAYLEIGH_PHASE)

/** `{ cosTheta: f32, g: f32 }` → `f32`. */
export const miePhaseCS = /*@__PURE__*/ wgslFn(MIE_PHASE_CS)

/** `{ cosTheta: f32, g: f32 }` → `f32`. */
export const hgPhase = /*@__PURE__*/ wgslFn(HG_PHASE)

/** `{ iPlusHalf: f32, jPlusHalf: f32, sqrtSampleCount: f32 }` → `vec3`. */
export const getSphericalDir = /*@__PURE__*/ wgslFn(SPHERICAL_DIR)

/**
 * `{ viewHeight: f32, bottomRadius: f32, uv: vec2 }` →
 * `vec2(viewZenithCosAngle, lightViewCosAngle)`. Depends on `fromSubUvsToUnit`.
 */
export const uvToSkyViewLutParams = /*@__PURE__*/ wgslFn(UV_TO_SKYVIEW_PARAMS, [fromSubUvsToUnit])

/**
 * `{ intersectsGround: f32, viewZenithCosAngle: f32, lightViewCosAngle: f32,
 * viewHeight: f32, bottomRadius: f32 }` → `vec2` UV. Depends on `fromUnitToSubUvs`.
 */
export const skyViewLutParamsToUv = /*@__PURE__*/ wgslFn(SKYVIEW_PARAMS_TO_UV, [fromUnitToSubUvs])
