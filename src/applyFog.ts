import { uniform } from 'three/tsl'

import { createFogOutputNode, createFogState, updateFogState } from './sky/FogPostProcess'
import type { FogOptions } from './sky/FogPostProcess'

export interface ApplyFogOptions extends FogOptions {
  sky?: any
  scenePass?: any
  /** Must match `WebGPURenderer({ logarithmicDepthBuffer })`. */
  logarithmicDepthBuffer?: boolean
  /**
   * PMREM roughness of the fog colour at night. Once the sun is below −10°
   * the fog blends (fully by −16°) from the sharp sky cube to the blurred
   * environment, so the baked Milky Way glows softly through fog instead of
   * printing its dust lanes on fogged geometry. `0` keeps the sharp cube at
   * all hours. Default 0.4. Build-time.
   */
  nightBlur?: number
  /** `'fog-amount'` | `'fog-color'` | `'is-sky'`. Debug only. */
  debugMode?: string | null
}

/**
 * Sky-coloured exponential height fog over `sceneColorNode` — the budget
 * alternative to `applyHaze`. Returns a `vec4` node.
 *
 *   post.outputNode = applyFog(scenePass.getTextureNode(), { sky, scenePass, density: 0.8 })
 *
 * Geometry fades toward the baked sky cube sampled along the view ray, by an
 * analytic exponential height-fog opacity. Nothing renders per frame — no
 * aerial-perspective LUT (it works with `enableAerialPerspective: false`), no
 * `updateAerialPerspective()` — so the per-pixel cost is one cube sample
 * (plus a blurred PMREM sample at night, see `nightBlur`). Sky pixels pass
 * through. `sky.update(camera)` must run each frame as usual:
 * it supplies the camera altitude the density is evaluated at.
 *
 * Knob ownership follows `applyHaze`: the fog uniforms live on the `Sky`
 * (`sky.setFog({...})` works before or after this call). A knob passed here
 * overrides what a setter stored; one left out adopts it, falling back to
 * `FOG_DEFAULTS`.
 *
 * @param sceneColorNode  composite base — typically `scenePass.getTextureNode()`,
 *   or a graph with bloom/AO composed in (fog goes on top of it)
 */
export function applyFog(
  sceneColorNode: any,
  {
    sky,
    scenePass,
    density,
    heightFalloff,
    baseHeight,
    maxOpacity,
    logarithmicDepthBuffer = false,
    nightBlur,
    debugMode = null,
  }: ApplyFogOptions = {},
): any {
  if (!sky) throw new Error('applyFog: `sky` is required.')
  if (!scenePass) throw new Error('applyFog: `scenePass` is required.')

  const baker = sky.baker
  const explicit: FogOptions = { density, heightFalloff, baseHeight, maxOpacity }
  if (!sky._fog) sky._fog = createFogState(explicit)
  else updateFogState(sky._fog, explicit)

  // The baker keeps the camera's altitude (world y, or distance above the
  // sphere with `planetCenter`) from `sky.update(camera)`; read it per render.
  const cameraHeight = uniform(baker.cameraAltitudeM).onRenderUpdate(() => baker.cameraAltitudeM)

  return createFogOutputNode({
    scenePass,
    sceneColorNode,
    skyCube: baker.texture,
    cubeSize: baker.cubeSize,
    fog: sky._fog,
    cameraHeight,
    upVector: baker.sky.upVector,
    skyDepthEpsilon: baker.skyDepthEpsilon,
    logarithmicDepthBuffer,
    // Resolved at shader build (the first render), after `sky.update()` has
    // baked it; its identity is stable from then on.
    environment: () => baker.environmentTexture,
    sunDirection: baker.sky.sunDirection,
    nightBlur,
    debugMode,
  })
}
