import { createContext, useContext } from 'react'

/**
 * Shape of the value published on `SkyContext` — the active vanilla `Sky`
 * instance. Only the surface used by React consumers is typed here; TSL /
 * three objects are left as `any`.
 */
export interface SkyContextValue {
  attach(scene: any): void
  detach(): void
  dispose(): void
  update(camera: any): void
  setTimeOfDay(timeOfDay: number): void
  setLatitude(latitude: number): void
  setDayOfYear(dayOfYear: number): void
  setSunDirection(sunDirection: any): void
  setExposure(exposure: number): void
  setSunDisc(sunDisc: boolean): void
  setNorth(north: any): void
  setTurbidity(turbidity: number): void
  setGroundAlbedo(groundAlbedo: any): void
  setAtmosphere(atmosphere: any): void
  setMirrorBelowHorizon(mirrorBelowHorizon: boolean): void
  setHazeStrength(hazeStrength: number): void
  setHazePolicy(hazePolicy: any): void
  setHazeAltitudeBlend(hazeAltitudeBlend: any): void
  setLook(look: any): void
  setLookTrack(track: any): void
  setSkyLuminanceFactor(factor: any): void
  setAerialPerspectiveDistanceScale(value: number): void
  setMultiScatteringFactor(value: number): void
  applyHaze(sceneTexture: any, options?: any): any
  [key: string]: any
}

export const SkyContext = createContext<SkyContextValue | null>(null)

/**
 * Returns the active `Sky` instance, or `null` if no `<Sky>` is mounted.
 *
 * Use this to reach the underlying instance from a child component — for
 * example to call `applyHaze` from a `useRenderPipeline` callback:
 *
 *   const sky = useSky();
 *   useRenderPipeline(({ renderPipeline, passes }) => {
 *     if (!sky) return;
 *     renderPipeline.outputNode = sky.applyHaze(
 *       passes.scenePass.getTextureNode(),
 *       { scenePass: passes.scenePass }
 *     );
 *   });
 */
export function useSky() {
  return useContext(SkyContext)
}
