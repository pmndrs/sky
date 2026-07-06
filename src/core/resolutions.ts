/**
 * Single source of truth for Hillaire LUT texture sizes. Defaults match the paper.
 *
 * Overridable per-construction via `new SkyAtmosphereBaker(renderer, { lutResolutions })`.
 */
export const LUT_RESOLUTIONS = {
	transmittance: { width: 256, height: 64 },
	multiScatter: { width: 32, height: 32 },
	skyView: { width: 192, height: 108 },
	// 3D froxel volume covering the camera frustum for Phase 2 aerial perspective.
	// kmPerSlice × z = total depth covered. Hillaire defaults to 4 km × 32 slices
	// (128 km); we use 8 km × 32 slices (256 km) so grazing rays don't truncate
	// significantly short of the atmosphere boundary, which would create a dark
	// fringe at distant silhouettes.
	aerialPerspective: { x: 32, y: 32, z: 32, kmPerSlice: 8.0 }
};
