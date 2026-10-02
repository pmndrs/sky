/**
 * Single source of truth for Hillaire LUT texture sizes. Defaults match the paper.
 *
 * Overridable per-construction via `new SkyAtmosphereBaker(renderer, { lutResolutions })`.
 */
export interface LutResolutions {
  transmittance: { width: number; height: number }
  multiScatter: { width: number; height: number }
  skyView: { width: number; height: number }
  aerialPerspective: { x: number; y: number; z: number; kmPerSlice: number }
}

export const LUT_RESOLUTIONS: LutResolutions = {
  transmittance: { width: 256, height: 64 },
  multiScatter: { width: 32, height: 32 },
  skyView: { width: 192, height: 108 },
  // 3D froxel volume covering the camera frustum for Phase 2 aerial perspective.
  // kmPerSlice × z = total depth covered. Hillaire defaults to 4 km × 32 slices
  // (128 km); we use 8 km × 32 slices (256 km) so grazing rays don't truncate
  // significantly short of the atmosphere boundary, which would create a dark
  // fringe at distant silhouettes.
  aerialPerspective: { x: 32, y: 32, z: 32, kmPerSlice: 8.0 },
}

/** Texel size of a 2D LUT. */
export interface LutSize2D {
  width: number
  height: number
}

/**
 * Texel size of a 2D LUT texture — a three `Texture` (render-target textures
 * carry `image.width/height`) or a texture node holding one — read when a
 * shader graph is built.
 *
 * Every LUT lookup applies Hillaire's sub-UV correction, which depends on the
 * resolution of the texture being sampled. The consumers take it from the
 * texture they are handed rather than from a separate number or a default, so
 * a `quality` tier or a custom `lutResolutions` can't be sampled with another
 * size's remap (issue #13). LUT render targets are never resized after
 * construction, so the value is a constant for the life of the material.
 */
export function lutTextureSize(tex: any): LutSize2D {
  const t = tex?.isTextureNode ? tex.value : tex
  const width = t?.image?.width
  const height = t?.image?.height
  // > 1: the inverse sub-UV map divides by (resolution - 1).
  if (!(width > 1 && height > 1)) {
    throw new Error(
      `lutTextureSize: ${t?.name || 'texture'} has no usable size (${width}×${height}); ` +
        'LUT lookups need the resolution of the texture they sample',
    )
  }
  return { width, height }
}
