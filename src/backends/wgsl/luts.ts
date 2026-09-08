/**
 * WebGPU-via-three backend: whole-pixel LUT shaders as TSL-callable nodes.
 *
 * Each LUT's WGSL pixel function (from `core/wgsl/luts.wgsl.ts`) is wrapped by a
 * single `wgslFn`, with its helper dependencies passed through `includes`. The
 * LUT runner calls the exported `*ColorNode(uv, params)` to build its material
 * `colorNode` on the WebGPU backend. The TSL path is untouched (WebGL fallback).
 *
 * `params` is the uniform bundle from `createAtmosphereUniforms` — each field is
 * a TSL `uniform(...)` node. The `*Args` helpers map those onto the flat WGSL
 * arg names so the call sites stay readable.
 */

import { float, texture, wgslFn } from 'three/tsl'

import {
  RAY_SPHERE,
  UV_TO_TRANSMITTANCE,
  RAYLEIGH_PHASE,
  HG_PHASE,
  BILINEAR_SAMPLE_2D,
  SPHERICAL_DIR,
} from '../../core/wgsl/atmosphere.wgsl.js'
import { TRANSMITTANCE_LUT_PIXEL, SKYVIEW_LUT_PIXEL, MULTISCATTER_LUT_PIXEL } from '../../core/wgsl/luts.wgsl.js'

// Helper nodes, wrapped once and threaded through `includes`. Only helpers with
// scalar/vector return types can be wgslFn-wrapped (three's parser can't map a
// custom struct return) — so the medium sample is inlined in the LUT pixel, and
// these (f32 / vec2 / vec3 returns) are the only shared includes.
const raySphereFn = /*@__PURE__*/ wgslFn(RAY_SPHERE)
const uvToTransmittanceLutParamsFn = /*@__PURE__*/ wgslFn(UV_TO_TRANSMITTANCE)
const rayleighPhaseFn = /*@__PURE__*/ wgslFn(RAYLEIGH_PHASE)
const hgPhaseFn = /*@__PURE__*/ wgslFn(HG_PHASE)
const bilinearSample2DFn = /*@__PURE__*/ wgslFn(BILINEAR_SAMPLE_2D)

const transmittanceLutPixelFn = /*@__PURE__*/ wgslFn(TRANSMITTANCE_LUT_PIXEL, [
  raySphereFn,
  uvToTransmittanceLutParamsFn,
])

const getSphericalDirFn = /*@__PURE__*/ wgslFn(SPHERICAL_DIR)

const skyViewLutPixelFn = /*@__PURE__*/ wgslFn(SKYVIEW_LUT_PIXEL, [
  raySphereFn,
  rayleighPhaseFn,
  hgPhaseFn,
  bilinearSample2DFn,
])

const multiScatterLutPixelFn = /*@__PURE__*/ wgslFn(MULTISCATTER_LUT_PIXEL, [
  getSphericalDirFn,
  raySphereFn,
  bilinearSample2DFn,
])

/**
 * Density-scalar medium args shared by every LUT pixel that samples the medium.
 * Field names mirror the WGSL signatures.
 */
export function atmosphereDensityArgs(params: any) {
  return {
    mieDensityExpScale: params.mieDensityExpScale,
    rayleighDensityExpScale: params.rayleighDensityExpScale,
    absorptionDensity0LayerWidth: params.absorptionDensity0LayerWidth,
    absorptionDensity0LinearTerm: params.absorptionDensity0LinearTerm,
    absorptionDensity0ConstantTerm: params.absorptionDensity0ConstantTerm,
    absorptionDensity1LinearTerm: params.absorptionDensity1LinearTerm,
    absorptionDensity1ConstantTerm: params.absorptionDensity1ConstantTerm,
  }
}

/**
 * Transmittance LUT colour (vec3) for a given UV node and uniform bundle.
 * Wrap in `vec4(..., 1.0)` at the material. Only the extinction-relevant medium
 * coefficients are passed (mie/rayleigh scattering-for-mie is not needed for
 * optical depth).
 */
export function transmittanceLutColorNode(uvNode: any, params: any) {
  return transmittanceLutPixelFn({
    uv: uvNode,
    bottomRadius: params.bottomRadius,
    topRadius: params.topRadius,
    ...atmosphereDensityArgs(params),
    mieExtinction: params.mieExtinction,
    rayleighScattering: params.rayleighScattering,
    absorptionExtinction: params.absorptionExtinction,
  })
}

/**
 * Sky-View LUT colour (vec3 radiance) for a UV node, uniform bundle, the
 * Transmittance + Multi-Scatter LUT textures, and the sun-direction / view-height
 * uniform nodes. Wrap in `vec4(..., 1.0)` at the material.
 */
export function skyViewLutColorNode(
  uvNode: any,
  params: any,
  transmittanceTex: any,
  multiScatterTex: any,
  sunDirNode: any,
  viewHeightNode: any,
) {
  return skyViewLutPixelFn({
    uv: uvNode,
    transmittanceLut: texture(transmittanceTex),
    multiScatterLut: texture(multiScatterTex),
    sunDirWorld: sunDirNode,
    viewHeightIn: viewHeightNode,
    bottomRadius: params.bottomRadius,
    topRadius: params.topRadius,
    ...atmosphereDensityArgs(params),
    mieScattering: params.mieScattering,
    mieExtinction: params.mieExtinction,
    rayleighScattering: params.rayleighScattering,
    absorptionExtinction: params.absorptionExtinction,
    miePhaseG: params.miePhaseG,
    groundAlbedo: params.groundAlbedo,
    // Bundles that predate the field (older parity pages) fall back to physical.
    multiScatteringFactor: params.multiScatteringFactor ?? float(1.0),
  })
}

/**
 * Multi-Scatter LUT colour (vec3) for a UV node, uniform bundle, and the
 * Transmittance LUT texture. Wrap in `vec4(..., 1.0)` at the material.
 */
export function multiScatterLutColorNode(uvNode: any, params: any, transmittanceTex: any) {
  return multiScatterLutPixelFn({
    uv: uvNode,
    transmittanceLut: texture(transmittanceTex),
    bottomRadius: params.bottomRadius,
    topRadius: params.topRadius,
    ...atmosphereDensityArgs(params),
    mieScattering: params.mieScattering,
    mieExtinction: params.mieExtinction,
    rayleighScattering: params.rayleighScattering,
    absorptionExtinction: params.absorptionExtinction,
    groundAlbedo: params.groundAlbedo,
  })
}
