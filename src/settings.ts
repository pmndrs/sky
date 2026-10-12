import type { AtmosphereParams } from './core/AtmosphereParams'
import type { Vector3 } from 'three/webgpu'

export type SkyAtmosphereSettings = {
  [K in keyof AtmosphereParams]: AtmosphereParams[K] extends Vector3 ? [number, number, number] : AtmosphereParams[K]
}

/** Detached readback of the live sky. Atmosphere coefficients are the effective
 * values; baseMie is the unscaled baseline used by setTurbidity. */
export interface SkySettings {
  preset: string | null
  quality: string
  cubeSize: number
  exposure: number
  turbidity: number
  atmosphere: SkyAtmosphereSettings
  baseMie: {
    scattering: [number, number, number]
    extinction: [number, number, number]
    absorption: [number, number, number]
  }
  mirrorBelowHorizon: boolean
  sun: {
    mode: 'time' | 'manual'
    timeOfDay: number
    latitude: number
    dayOfYear: number
    north: number
    elevation: number
    azimuth: number
    raw: boolean
    color: [number, number, number]
    disc: { visible: boolean; angularDiameter: number; edgeSoftness: number; intensity: number }
  }
  evaluatedElevation: number
  planetFrame: boolean
  viewHeightKm: number
}
