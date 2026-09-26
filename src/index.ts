// Public API for `tsl-sky` (vanilla).
//
// The 90% surface — most users only need these:
export { Sky } from './Sky'
export type { SkyState } from './Sky'
export { SkySun } from './sky/SkySun'
export { SkyMoon } from './sky/SkyMoon'
export { SkyGround } from './sky/SkyGround'
export { GroundedSkybox } from './sky/GroundedSkybox'
export { SkyNight } from './sky/SkyNight'
export { applyHaze } from './applyHaze'
export { presets, resolvePreset } from './presets'
export {
  looks,
  lookTracks,
  registerLook,
  registerLookTrack,
  resolveLook,
  resolveLookTrack,
  sampleLook,
  sampleLookTrack,
  createLookTrack,
  lerpLooks,
  packLook,
  applyEase,
  MAX_LOOK_STOPS,
} from './looks'
export type {
  Look,
  LookInput,
  LookStop,
  LookEase,
  LookSunTint,
  LookKeyframe,
  LookTrack,
  PackedLook,
  ColorInput,
} from './looks'
export { solarPosition } from './solarPosition'
export { EARTH, mergeAtmosphereParams } from './core/AtmosphereParams'

// Power-user surface — kept exported so callers can swap pieces without
// vendoring the package.
export { SkyAtmosphereBaker } from './sky/SkyAtmosphereBaker'
export { SkyAtmosphereMesh } from './sky/SkyAtmosphereMesh'
export { SkyHelper } from './sky/SkyHelper'
export { createHazeOutputNode } from './sky/HazePostProcess'
export { LUT_RESOLUTIONS } from './core/resolutions'
export { TransmittanceLUT } from './sky/luts/TransmittanceLUT'
export { MultiScatterLUT } from './sky/luts/MultiScatterLUT'
export { SkyViewLUT } from './sky/luts/SkyViewLUT'
export { AerialPerspectiveLUT } from './sky/luts/AerialPerspectiveLUT'
