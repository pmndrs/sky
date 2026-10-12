export type Preset = 'dusk' | 'haze' | 'night'
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
type ShadowSettings = typeof shadowDefaults
type WaterSettings = typeof waterDefaults
type FogSettings = typeof fogDefaults
export interface Settings extends WaterSettings, FogSettings, ShadowSettings {
  preset: Preset
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
    preset: 'dusk',
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
    preset: 'haze',
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
    preset: 'night',
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
