import { uniform } from 'three/tsl'

import { createHazeOutputNode } from './sky/HazePostProcess'
import { createHazeShadowState, releaseHazeShadowPasses, updateHazeShadowState } from './sky/hazeShadows'
import type { HazeShadowOptions } from './sky/hazeShadows'

interface ApplyHazeOptions {
  sky?: any
  scenePass?: any
  policy?: string
  strength?: number
  altitudeBlend?: { startKm: number; endKm: number }
  logarithmicDepthBuffer?: boolean
  useCameraFar?: boolean
  includeSkyCubeBlend?: boolean
  raymarchFallback?: boolean
  raymarchSampleCount?: number
  apRefineSteps?: number
  shadows?: HazeShadowOptions | false
  debugMode?: string | null
}

/**
 * Build a haze TSL output node from a `Sky` instance and a scene-color node.
 *
 * Returns a `vec4` node. Caller assigns it (or composes it with bloom etc.)
 * onto their pipeline's outputNode.
 *
 * Vanilla:
 *   const post = new RenderPipeline(renderer);
 *   const scenePass = pass(scene, camera);
 *   post.outputNode = applyHaze(scenePass.getTextureNode(), { scenePass, sky });
 *
 * R3F (useRenderPipeline):
 *   useRenderPipeline(({ renderPipeline, passes }) => {
 *     renderPipeline.outputNode = applyHaze(
 *       passes.scenePass.getTextureNode(),
 *       { scenePass: passes.scenePass, sky }
 *     );
 *   });
 *
 * Uniform ownership: this function lazily attaches `hazeStrength`,
 * `hazePolicy`, altitude-blend, and `cameraFar` uniforms onto the supplied
 * `sky` instance. Callers can mutate the haze knobs after the fact via
 * `sky.setHazeStrength(value)` / `sky.setHazePolicy(name)` /
 * `sky.setHazeAltitudeBlend({startKm, endKm})` without rebuilding the
 * pipeline. The build-time `policy` / `strength` / `altitudeBlend` args
 * just seed initial values.
 *
 * @param {THREE.Node} sceneColorNode  scene-color node — typically `scenePass.getTextureNode()`
 * @param {object} options
 * @param {Sky} options.sky                              the `Sky` instance
 * @param {THREE.PassNode} options.scenePass             the `pass(scene, camera)` result
 * @param {'auto'|'ap'|'raymarch'} [options.policy='auto']
 * @param {number} [options.strength=1.0]                multiplies inscatter + AP alpha
 * @param {{startKm:number,endKm:number}} [options.altitudeBlend]   auto-mode altitude blend window
 * @param {boolean} [options.logarithmicDepthBuffer=false]  must match `WebGPURenderer({ logarithmicDepthBuffer })`
 * @param {boolean} [options.useCameraFar]               opt-in to viewZ-based sky detection.
 *   Required for planet-scale demos where `camera.far` is huge (10⁷ m+);
 *   the default linear-depth test fails when geometry compresses into a
 *   thin sliver of [0, 1] near the camera. When enabled the `Sky` lazily
 *   creates a `cameraFar` uniform refreshed each frame in `sky.update`.
 *   Defaults to `true` when `camera.far > 1e6`, else `false`.
 * @param {boolean} [options.includeSkyCubeBlend=false]  legacy shim — see HazePostProcess.js
 * @param {boolean} [options.raymarchFallback=true]      compile the per-pixel
 *   raymarch fallback into the shader. Default on so live policy switching
 *   works. Pass `false` for scenes whose geometry never exceeds AP coverage
 *   (a city under the default 256 km cap): the haze shader shrinks to a LUT
 *   sample + composite — much smaller WGSL, dramatically faster pipeline
 *   compile. With it off, `policy: 'raymarch'` and altitude blending are
 *   inert (geometry past coverage clamps to the LUT's last slice).
 * @param {number} [options.raymarchSampleCount=64]      samples per pixel on the
 *   raymarch fallback path (geometry past AP coverage / raymarch policy). 64
 *   keeps orbit-altitude grazing rays band-free; ground-level scenes can use
 *   32 or lower for a cheaper shader. Build-time constant — rebuild the node
 *   (call `applyHaze` again) to change it.
 * @param {number} [options.apRefineSteps=4]           steps per
 *   march of the AP slice refinement: above ~1–3 km camera altitude each
 *   geometry pixel on the AP path takes the LUT at the two slice centres
 *   before its surface and integrates the rest of its own ray (two marches),
 *   which removes the concentric bands of interpolating between slices.
 *   Costs nothing below 1 km. Needs `raymarchFallback` (off with it). 0 turns
 *   it off. Build-time constant.
 * @param {object|false} [options.shadows]               opt-in shadowed haze (light
 *   shafts). `{ light, samples = 32, maxDistance = 20000, strength = 1,
 *   resolution = 0.5 }`: `light` is the shadow-casting `DirectionalLight` (or
 *   a `SkySun`); `maxDistance` is in metres; `resolution` scales the march
 *   pass against the drawing buffer. The in-scatter the light's shadow map
 *   occludes is removed from geometry and sky pixels. Omitted (or `false`)
 *   compiles nothing — the haze shader is unchanged. If `sky.setHazeShadows()`
 *   was called first with a `light`, that configuration is adopted. The
 *   numeric knobs stay live through `sky.setHazeShadows()`; adding or removing
 *   the feature needs a new `applyHaze` call.
 * @param {string} [options.debugMode]                   AP debug mode passthrough
 * @returns {THREE.Node} vec4 output node
 */
export function applyHaze(
  sceneColorNode: any,
  {
    sky,
    scenePass,
    policy,
    strength,
    altitudeBlend,
    logarithmicDepthBuffer = false,
    useCameraFar,
    includeSkyCubeBlend = false,
    raymarchFallback = true,
    raymarchSampleCount = 64,
    apRefineSteps = 4,
    shadows,
    debugMode = null,
  }: ApplyHazeOptions = {},
): any {
  if (!sky) throw new Error('applyHaze: `sky` is required.')
  if (!scenePass) throw new Error('applyHaze: `scenePass` is required.')

  const baker = sky.baker
  const ap = baker.aerialPerspectiveLUT

  if (!ap) {
    throw new Error('applyHaze: Sky was constructed with `enableAerialPerspective: false`.')
  }

  // A setter on `Sky` may already have created these uniforms (setHazeStrength
  // etc. work before applyHaze). Only an option the caller actually passed
  // overrides them; otherwise the setter's value is adopted, and the defaults
  // below apply only when nothing was set either way.
  const hasStrength = strength !== undefined
  const hasPolicy = policy !== undefined
  const effectivePolicy: string = hasPolicy
    ? (policy as string)
    : sky._hazePolicy
      ? hazeModeToPolicy(sky._hazePolicy.value)
      : 'auto'
  policy = effectivePolicy

  if (!raymarchFallback && policy === 'raymarch') {
    console.warn("applyHaze: policy 'raymarch' has no effect with raymarchFallback: false.")
  }

  // Lets the React <Sky> binding (and any other frame driver) know the AP
  // LUT now has a consumer and needs its per-frame refresh.
  sky._hazeApplied = true

  // --- Sky-owned uniforms (lazy + reseed on every applyHaze() call) ---
  if (!sky._hazeStrength) sky._hazeStrength = uniform(hasStrength ? strength : 1.0)
  else if (hasStrength) sky._hazeStrength.value = strength

  if (!sky._hazePolicy) sky._hazePolicy = uniform(policyToHazeMode(policy))
  else if (hasPolicy) sky._hazePolicy.value = policyToHazeMode(policy)

  if (!sky._hazeRaymarchOnly) sky._hazeRaymarchOnly = uniform(policy === 'raymarch' ? 1.0 : 0.0)
  else if (hasPolicy) sky._hazeRaymarchOnly.value = policy === 'raymarch' ? 1.0 : 0.0

  const seedStartKm = altitudeBlend?.startKm ?? 50.0
  const seedEndKm = altitudeBlend?.endKm ?? 100.0

  if (!sky._hazeAltStart) sky._hazeAltStart = uniform(seedStartKm)
  else if (altitudeBlend) sky._hazeAltStart.value = seedStartKm

  if (!sky._hazeAltEnd) sky._hazeAltEnd = uniform(seedEndKm)
  else if (altitudeBlend) sky._hazeAltEnd.value = seedEndKm

  const seedFar = scenePass.camera?.far ?? 1e6
  if (useCameraFar === undefined) useCameraFar = seedFar > 1e6
  if (useCameraFar && !sky._cameraFar) sky._cameraFar = uniform(seedFar)

  // Created here if the user hasn't touched it yet, so the shader always has
  // a node to bind and `setAerialPerspectiveDistanceScale` works before or
  // after `applyHaze`.
  if (!sky._apDistanceScale) sky._apDistanceScale = uniform(1.0)

  // Shadowed haze. Same adopt-or-seed rule as the uniforms above: an explicit
  // option wins, otherwise a state created by `sky.setHazeShadows()` is used,
  // and `shadows: false` turns the feature off for this node.
  if (shadows) {
    if (!sky._hazeShadow) sky._hazeShadow = createHazeShadowState(shadows)
    else updateHazeShadowState(sky._hazeShadow, shadows)
  }
  // A new haze node gets a new march pass; free the previous node's target.
  if (sky._hazeShadow) releaseHazeShadowPasses(sky._hazeShadow)
  const shadowState = shadows === false ? null : sky._hazeShadow?.light ? sky._hazeShadow : null

  return createHazeOutputNode({
    scenePass,
    sceneColorNode,
    aerialPerspectiveTexture: ap.texture,
    luminanceScale: baker.sky.luminanceScale,
    invProjUniform: ap.invProjUniform,
    resZ: ap.resolution?.z ?? ap.resolution?.depth ?? 32,
    kmPerSlice: baker.apKmPerSlice,
    hazeStrength: sky._hazeStrength,
    hazeModeUniform: sky._hazePolicy,
    raymarchBlendStartKm: sky._hazeAltStart,
    raymarchBlendEndKm: sky._hazeAltEnd,
    raymarchOnlyUniform: sky._hazeRaymarchOnly,
    cameraWorldUniform: ap.cameraWorldUniform,
    cameraFarUniform: useCameraFar ? sky._cameraFar : null,
    logarithmicDepthBuffer,
    // On by default so live policy switching works without rebuild; scenes
    // that never exceed AP coverage can pass `raymarchFallback: false` for a
    // far smaller shader (see the option's JSDoc).
    enableRaymarchFallback: raymarchFallback,
    raymarchSampleCount,
    apRefineSteps,
    atmosphereUniforms: baker.atmosphereUniforms,
    sunDirection: baker.sky.sunDirection,
    // Same uniform bundle the sky mesh binds, so a grade assigned via
    // `sky.setGrade()` reaches AP inscatter with no extra plumbing and no
    // chance of the two drifting out of sync.
    gradeUniforms: baker.sky.gradeUniforms,
    upVector: baker.sky.upVector,
    skyLuminanceFactor: baker.sky.skyLuminanceFactor,
    skyDepthEpsilon: baker.skyDepthEpsilon,
    sunColor: baker.sky.sunColor,
    apDistanceScale: sky._apDistanceScale,
    viewHeightKm: baker.sky.viewHeight,
    // Planet-frame camera position — already updated each frame by
    // AerialPerspectiveLUT.setCamera (called via baker.setCamera). When
    // the user isn't passing `planetCenter`, this defaults to
    // (0, viewHeight, 0) which matches the flat-ground convention.
    cameraPositionKm: ap.cameraPositionKmUniform,
    transmittanceLUT: baker.transmittanceLUT.texture,
    multiScatterLUT: baker.multiScatterLUT.texture,
    skyCube: includeSkyCubeBlend ? baker.texture : null,
    shadow: shadowState,
    debugMode,
  })
}

/** Inverse of `policyToHazeMode`, for adopting a policy a `Sky` setter stored before `applyHaze` ran. */
function hazeModeToPolicy(mode: number): string {
  for (const p of ['auto', 'ap', 'raymarch']) if (policyToHazeMode(p) === mode) return p
  return 'auto'
}

function policyToHazeMode(policy: string): number {
  switch (policy) {
    case 'auto':
      return 0.0
    case 'ap':
      return 1.0
    case 'raymarch':
      return 2.0
    default:
      throw new Error(`applyHaze: unknown policy "${policy}". Use 'auto' | 'ap' | 'raymarch'.`)
  }
}

export { policyToHazeMode }
