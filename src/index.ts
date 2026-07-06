// Public API for `tsl-sky` (vanilla).
//
// The 90% surface — most users only need these:
export { Sky } from './Sky.js';
export { SkySun } from './sky/SkySun.js';
export { SkyMoon } from './sky/SkyMoon.js';
export { SkyGround } from './sky/SkyGround.js';
export { GroundedSkybox } from './sky/GroundedSkybox.js';
export { SkyNight } from './sky/SkyNight.js';
export { applyHaze } from './applyHaze.js';
export { presets, resolvePreset } from './presets.js';
export { solarPosition } from './solarPosition.js';
export { EARTH, mergeAtmosphereParams } from './sky/AtmosphereParams.js';

// Power-user surface — kept exported so callers can swap pieces without
// vendoring the package.
export { SkyAtmosphereBaker } from './sky/SkyAtmosphereBaker.js';
export { SkyAtmosphereMesh } from './sky/SkyAtmosphereMesh.js';
export { createHazeOutputNode } from './sky/HazePostProcess.js';
export { LUT_RESOLUTIONS } from './sky/luts/resolutions.js';
export { TransmittanceLUT } from './sky/luts/TransmittanceLUT.js';
export { MultiScatterLUT } from './sky/luts/MultiScatterLUT.js';
export { SkyViewLUT } from './sky/luts/SkyViewLUT.js';
export { AerialPerspectiveLUT } from './sky/luts/AerialPerspectiveLUT.js';
