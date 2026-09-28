// Public API for `tsl-sky` (vanilla).
//
// The 90% surface — most users only need these:
export { Sky } from './Sky'
export type { SkyState, LookTrackOverrides } from './Sky'
export { SkySun } from './sky/SkySun'
export { SkyMoon } from './sky/SkyMoon'
export { SkyGround } from './sky/SkyGround'
export { GroundedSkybox } from './sky/GroundedSkybox'
export { SkyNight } from './sky/SkyNight'
export type { SkyNightOptions } from './sky/SkyNight'
export { SkyStars } from './sky/SkyStars'
export type { SkyStarsOptions } from './sky/SkyStars'
export { generateMilkyWayTexture } from './sky/stars/milkyWay'
export type { MilkyWayTextureOptions } from './sky/stars/milkyWay'
export { generateStarCatalog } from './sky/stars/catalog'
export type { StarCatalog, StarCatalogOptions } from './sky/stars/catalog'
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
export { solarPosition, solarEquatorial, localSiderealTime } from './solarPosition'
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
