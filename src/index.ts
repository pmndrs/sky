// Public API for `tsl-sky` (vanilla).
//
// The 90% surface — most users only need these:
export { Sky, SUN_COLORS } from './Sky'
export type { SkyState, SkyAttachOptions, SkyNorth } from './Sky'
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
export { applyFog } from './applyFog'
export { ditherOutput } from './dither'
export type { DitherOutputOptions } from './dither'
export type { ApplyFogOptions } from './applyFog'
export { presets, resolvePreset } from './presets'
export type { ColorInput } from './color'
export {
  SkyGrade,
  grades,
  registerGrade,
  resolveGrade,
  resolveGradeKey,
  gradientGrade,
  horizonToZenith,
  solidSky,
  sampleGradient,
  evaluateGradeTexel,
  gradeZoneWeights,
  applyGradeOperator,
  gradeKeyMatrix,
  gradeAzimuthToU,
  gradeElevationToV,
  GRADE_ZONES,
  GRADE_FORMAT,
  GRADE_VERSION,
  MAX_GRADE_KEYS,
  GRADE_AZIMUTH_RES,
  GRADE_ELEVATION_RES,
} from './grade'
export type {
  SkyGradeInput,
  SkyGradeKeyInput,
  SkyGradeKey,
  SkyGradeJSON,
  SkyGradeKeyJSON,
  SkyGradeEvaluation,
  SkyGradeBake,
  GradeZoneName,
  GradeZoneWeights,
  GradeZoneInput,
  GradeZone,
  GradeShape,
  GradeFill,
  GradeFillInput,
  GradeAmbient,
  GradeAmbientInput,
  GradeEase,
  GradientEase,
  GradeGradient,
  GradeGradientInput,
  GradeGradientStop,
  GradeGradientStopInput,
  GradientGradeOptions,
  HorizonToZenithOptions,
  GradeTexel,
} from './grade'
export { SkyAmbient } from './sky/SkyAmbient'
export { SkyGradePreview } from './sky/SkyGradePreview'
export type { SkyGradePreviewMode, SkyGradePreviewOptions } from './sky/SkyGradePreview'
export type { SkyAmbientOptions, SkyAmbientLevel } from './sky/SkyAmbient'
export { solarPosition, solarEquatorial, localSiderealTime } from './solarPosition'
export { EARTH, mergeAtmosphereParams } from './core/AtmosphereParams'

// Power-user surface — kept exported so callers can swap pieces without
// vendoring the package.
export { SkyAtmosphereBaker } from './sky/SkyAtmosphereBaker'
export { SKY_RENDER_ORDER, SkyAtmosphereMesh } from './sky/SkyAtmosphereMesh'
export { SkyHelper } from './sky/SkyHelper'
export { PmremScheduler } from './sky/PmremScheduler'
export type { PmremSchedulerOptions } from './sky/PmremScheduler'
export { SkyPmrem, skyPmremPlan } from './sky/pmrem/SkyPmrem'
export type { SkyPmremOptions } from './sky/pmrem/SkyPmrem'
export { createHazeOutputNode } from './sky/HazePostProcess'
export {
  createFogOutputNode,
  createFogState,
  updateFogState,
  fogOpticalDepth,
  fogOpacity,
  FOG_DEFAULTS,
} from './sky/FogPostProcess'
export type { FogOptions, FogState, FogRay } from './sky/FogPostProcess'
export { createHazeShadowState, updateHazeShadowState, HAZE_SHADOW_DEFAULTS } from './sky/hazeShadows'
export type { HazeShadowOptions, HazeShadowState } from './sky/hazeShadows'
export { LUT_RESOLUTIONS } from './core/resolutions'
export { TransmittanceLUT } from './sky/luts/TransmittanceLUT'
export { MultiScatterLUT } from './sky/luts/MultiScatterLUT'
export { SkyViewLUT } from './sky/luts/SkyViewLUT'
export { AerialPerspectiveLUT } from './sky/luts/AerialPerspectiveLUT'
