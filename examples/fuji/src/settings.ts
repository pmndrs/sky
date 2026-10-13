export type Preset = 'dusk' | 'haze' | 'night'
export type PrintLayout = 'auto' | 'landscape' | 'portrait'
export const waterDefaults = {
  waveStrength: 0.65,
  waterChoppiness: 0.68,
  waterSlopeScale: 1,
  waterWindSpeed: 4.5,
  waterWindDirection: 66,
  waterFetch: 35,
  waterWindScale: 0.75,
  waterSwellScale: 0.26,
  waterSwellDirection: 85,
  waterSwellWindSpeed: 5,
  waterSwellFetch: 650,
  waterGust: 1,
  waterSlick: 0,
  waterStreak: 0.04,
  waterFoam: 0,
  waterFoamBias: 0.12,
  waterRoughness: 0.035,
  waterRoughnessScale: 1,
  waterReflection: 1,
  waterSpecular: 1,
  waterIor: 1.333,
  waterColor: '#243c3b',
  waterFoamColor: '#a5b5a7',
  waterSpeed: 1,
  waterPaused: false,
}
export const fogDefaults = { groundFog: false, fogDensity: 0.08, fogHeight: 150, fogBase: 0, fogOpacity: 0.85 }
export const shadowDefaults = {
  shadowHaze: false,
  shadowStrength: 0.5,
  shadowSamples: 32,
  shadowResolution: 0.5,
  shadowDistance: 90000,
}
export const lensDefaults = {
  cameraExposure: 1,
  sunDiscDiameter: 0.535,
  sunDiscBrightness: 100,
  bloomEnabled: true,
  bloomStrength: 0.08,
  bloomRadius: 0.35,
  bloomThreshold: 2,
  bloomSoftness: 1,
  glareEnabled: true,
  glareStrength: 0.04,
  glareRadius: 2,
  glareOffscreen: 20,
  glareVeil: 0.005,
}
type ShadowSettings = typeof shadowDefaults
type WaterSettings = typeof waterDefaults
type FogSettings = typeof fogDefaults
type LensSettings = typeof lensDefaults
export interface Settings extends WaterSettings, FogSettings, ShadowSettings, LensSettings {
  preset: Preset
  timeOfDay: number
  elevation: number
  azimuth: number
  haze: number
  exposure: number
  turbidity: number
  paper: number
  ink: number
  waveStrength: number
  drift: boolean
  manualCamera: boolean
  stars: boolean
}
export const presets: Record<Preset, Settings> = {
  dusk: {
    ...waterDefaults,
    ...fogDefaults,
    ...shadowDefaults,
    ...lensDefaults,
    preset: 'dusk',
    timeOfDay: 17.575,
    elevation: -1.5,
    azimuth: 256,
    haze: 0.7,
    exposure: 24,
    turbidity: 2.2,
    paper: 0.25,
    ink: 0.15,
    waveStrength: 0.65,
    drift: true,
    manualCamera: false,
    stars: true,
  },
  haze: {
    ...waterDefaults,
    ...fogDefaults,
    ...shadowDefaults,
    ...lensDefaults,
    cameraExposure: 0.2,
    preset: 'haze',
    timeOfDay: 17.12,
    elevation: 4,
    azimuth: 256,
    haze: 1.1,
    exposure: 22,
    turbidity: 2.8,
    paper: 0.25,
    ink: 0.12,
    waveStrength: 0.5,
    drift: true,
    manualCamera: false,
    stars: true,
  },
  night: {
    ...waterDefaults,
    ...fogDefaults,
    ...shadowDefaults,
    ...lensDefaults,
    preset: 'night',
    timeOfDay: 18.026,
    elevation: -7,
    azimuth: 280,
    haze: 1.1,
    exposure: 32,
    turbidity: 2,
    paper: 0.2,
    ink: 0.12,
    waveStrength: 0.55,
    drift: true,
    manualCamera: false,
    stars: true,
  },
}
