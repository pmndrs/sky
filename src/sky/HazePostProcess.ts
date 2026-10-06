import {
  Fn,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  float,
  sqrt,
  clamp,
  length,
  texture3D,
  cubeTexture,
  mix,
  abs,
  max,
  min,
  If,
  Loop,
  dot,
  fract,
  sin,
  smoothstep,
  normalize as tslNormalize,
  floor,
} from 'three/tsl'

import {
  computeLightViewCosAngle,
  integrateScatteredLuminance,
  moveToTopAtmosphere,
  raySphereIntersectNearest,
} from '../backends/tsl/atmosphere.tsl'
import { applyLook } from '../backends/tsl/look.tsl'
import { createHazeDepthNodes, distanceAlongViewRay, rawDepthIsSky, viewRayFromUv } from './hazeScenePassDepth'
import { createShadowDeficitPass, upsampleShadowDeficit } from './hazeShadows'
import type { HazeShadowState } from './hazeShadows'

interface CreateHazeOutputNodeArgs {
  scenePass: any
  /**
   * Scene-color node to composite the haze over. Optional; falls back to
   * `scenePass.getTextureNode('output')`. Pass a composed graph (bloom, AO,
   * grading…) so the haze goes on top of it instead of the raw scene pass —
   * without this, every effect composed before the haze is silently discarded.
   */
  sceneColorNode?: any
  aerialPerspectiveTexture: any
  luminanceScale: any
  invProjUniform: any
  resZ?: number
  kmPerSlice?: number
  hazeStrength?: any
  skyCube?: any
  cameraWorldUniform?: any
  cameraFarUniform?: any
  logarithmicDepthBuffer?: boolean
  hazeModeUniform?: any
  raymarchBlendStartKm?: any
  raymarchBlendEndKm?: any
  raymarchCoverageBlendKm?: any
  enableRaymarchFallback?: boolean
  /**
   * Sample count for the per-pixel raymarch fallback. Default 64 — chosen to
   * keep 1000+ km grazing rays band-free at orbit altitude (see the comment at
   * the integrator call). Ground-level scenes whose raymarch rays stay short
   * can drop this to 32 (or SebH's production-equivalent ~14) for a cheaper
   * shader. Build-time constant: changing it requires rebuilding the node.
   */
  raymarchSampleCount?: number
  /**
   * Steps per march for the AP slice refinement at altitude (two marches per
   * pixel; see the comment at the refinement). It removes the concentric
   * bands that depth-slice interpolation leaves on the ground seen from
   * above. Ramps in between 1 and 3 km camera altitude and is skipped below.
   * Compiled in only with `enableRaymarchFallback`, whose inputs it needs.
   * 0 turns it off. Build-time constant.
   */
  apRefineSteps?: number
  atmosphereUniforms?: any
  sunDirection?: any
  /** Stylized look uniforms (`baker.sky.lookUniforms`). Retints AP inscatter
   *  so haze agrees with the styled sky instead of staying physical. */
  lookUniforms?: any
  /** Y-up world-space up vector (`baker.sky.upVector`). Required with
   *  `lookUniforms`. */
  upVector?: any
  /** Sun colour applied to AP inscatter before the look
   *  (`baker.sky.sunColor`), so haze is lit by the same sun as the sky. */
  sunColor?: any
  /** Uniform: how far below 1.0 a depth value still counts as sky
   *  (`baker.skyDepthEpsilon`). 0 by default: backgrounds and the live sky
   *  mesh leave the cleared 1.0. */
  skyDepthEpsilon?: any
  /** Per-channel grade applied to AP inscatter after the look
   *  (`baker.sky.skyLuminanceFactor`), so haze matches the graded sky. */
  skyLuminanceFactor?: any
  /** Unreal `AerialPerspectiveViewDistanceScale`: scales the distance fed
   *  into the AP lookup. >1 = more haze per metre. Pure sample-time scale —
   *  no LUT rebuild, no dirty flag. */
  apDistanceScale?: any
  viewHeightKm?: any
  cameraPositionKm?: any
  transmittanceLUT?: any
  multiScatterLUT?: any
  raymarchOnlyUniform?: any
  /**
   * Opt-in shadowed haze (light shafts): the state from
   * `createHazeShadowState({ light })`. When supplied, the in-scatter the
   * light's shadow map occludes is removed from both geometry and sky pixels.
   * Omit it and nothing is compiled — the shader is unchanged. Requires
   * `atmosphereUniforms`, `sunDirection`, `transmittanceLUT`,
   * `multiScatterLUT`, `cameraWorldUniform` and `cameraPositionKm` (or
   * `viewHeightKm`).
   */
  shadow?: HazeShadowState | null
  debugMode?: string | null
}

/**
 * Camera altitude (km) over which the AP slice refinement ramps in. Measured
 * on the planet demo (32 km/slice): the band amplitude in AP alpha is at the
 * measurement floor (~0.002) at 1 km, 0.0045 at 3 km, 0.010 at 10 km and
 * 0.015–0.03 from 25 to 90 km.
 */
const AP_REFINE_ALTITUDE_KM: [number, number] = [1.0, 3.0]

/**
 * Build the TSL output node for the Aerial Perspective haze post-process.
 *
 * Per-pixel:
 *   1. Reads the scene's NDC depth.
 *   2. Reconstructs the view-space hit position via the camera inverse projection.
 *   3. Computes distance from camera in km.
 *   4. Maps to AP LUT W axis: `w = sqrt(slice / resZ)` (inverse of the LUT's
 *      squared distribution), where `slice = distKm / kmPerSlice`.
 *   5. Samples the 3D AP LUT (`texture3D`) at `(uv.x, uv.y, w)`.
 *   6. Sky pixels (depth == 1.0) keep their original colour — they're the cube
 *      background, which already contains atmospheric scattering. Geometry
 *      pixels get composited as `sceneColor * (1 - AP.a) + AP.rgb * luminanceScale`.
 *
 * The `luminanceScale` matches `SkyAtmosphereMesh.luminanceScale` (default 40)
 * so haze brightness is consistent with the sky.
 *
 * @param {Object} args
 * @param {THREE.PassNode} args.scenePass - `pass(scene, camera)` result.
 * @param {THREE.Storage3DTexture} args.aerialPerspectiveTexture - the AP LUT 3D texture.
 * @param {THREE.UniformNode<float>} args.luminanceScale - typically the same uniform
 *   the sky mesh uses; pass `baker.sky.luminanceScale` or a wrapped uniform.
 * @param {THREE.UniformNode<mat4>} args.invProjUniform - camera inverse
 *   projection matrix (uniform). Driven by the demo's per-frame setCamera().
 * @param {number} args.resZ - AP LUT Z resolution. Default 32.
 * @param {number} args.kmPerSlice - AP LUT km per slice. Default 4.
 * @param {THREE.UniformNode<float>} [args.hazeStrength] - optional 0..1 multiplier
 *   on the inscatter contribution. Useful as a GUI slider for before/after
 *   comparison without rebuilding the LUT. Default unscaled (1.0).
 * @param {THREE.CubeTexture} [args.skyCube] - optional cube texture (typically
 *   `baker.texture`). When provided, fully-attenuated geometry pixels (heavy
 *   AP alpha) are blended toward the cube's color in their world ray
 *   direction. This closes the AP-coverage / Sky-View boundary mismatch:
 *   without it, a flat ground extending toward the horizon shows AP haze that
 *   stops abruptly at the cube-sky boundary because AP integrates only ~256
 *   km while Sky-View covers the full atmosphere (often 1000+ km of optical
 *   path on grazing rays).
 * @param {THREE.UniformNode<mat4>} [args.cameraWorldUniform] - camera world
 *   matrix. Required when skyCube is provided so we can transform view-space
 *   ray directions into world space for the cube sample. Also required when
 *   `enableRaymarchFallback` is on (raymarch needs Y-up world ray direction).
 *
 * Per-pixel raymarch fallback (planet-scale support):
 *
 * @param {boolean} [args.enableRaymarchFallback=false] - when true, geometry
 *   whose distance from the camera exceeds the AP LUT's coverage cap
 *   (`kmPerSlice * resZ` km) falls back to a per-pixel
 *   `integrateScatteredLuminance` ray-march so the planet surface from
 *   altitude integrates the *actual* atmospheric optical path instead of
 *   being clamped to slice 31 of the LUT. Required for orbit / high-altitude
 *   demos where surface pixels can be 1000+ km away. Below the cap the LUT
 *   is used unchanged.
 *
 *   Requires the following extra inputs to be supplied:
 * @param {object} [args.atmosphereUniforms] - the same uniform bundle that
 *   feeds the rest of the pipeline (`baker.atmosphereUniforms`).
 * @param {THREE.UniformNode<vec3>} [args.sunDirection] - Y-up world-space
 *   sun direction uniform (`baker.sky.sunDirection`).
 * @param {THREE.UniformNode<float>} [args.viewHeightKm] - camera altitude
 *   from planet centre, in km (`baker.sky.viewHeight`). Updated per-frame
 *   via `baker.setCamera()`.
 * @param {THREE.UniformNode<vec3>} [args.cameraPositionKm] - optional true
 *   planet-centred camera position in km. When omitted the legacy
 *   `(0, viewHeightKm, 0)` convention is used.
 * @param {*} [args.transmittanceLUT] - the Transmittance LUT texture node
 *   (`baker.transmittanceLUT.texture`).
 * @param {*} [args.multiScatterLUT] - the Multi-Scatter LUT texture node
 *   (`baker.multiScatterLUT.texture`).
 * @param {THREE.UniformNode<float>} [args.raymarchOnlyUniform] - optional
 *   0/1 float uniform. When set to 1, every geometry pixel goes through
 *   the per-pixel raymarch path instead of the AP LUT — bypassing the
 *   LUT entirely. Useful at orbit altitude where the LUT's
 *   camera-frustum-aligned voxel parameterization breaks down: off-axis
 *   views compress the slice distribution in screen space and start
 *   producing direction-sensitive coverage holes. Mid-term this should
 *   flip on automatically when camera altitude exceeds some threshold;
 *   for now it's a manual toggle so we can A/B. Requires
 *   `enableRaymarchFallback = true`.
 *
 * @param {boolean} [args.logarithmicDepthBuffer=false] - Must match
 *   `WebGPURenderer.logarithmicDepthBuffer`. When true, viewZ/linear depth are
 *   built with `logarithmicDepthToViewZ` (PassNode’s default assumes perspective
 *   depth and breaks haze if this is set wrong).
 * @returns {THREE.Node<vec4>} The output node — feed this to
 *   `RenderPipeline.outputNode = ...` (or the deprecated `PostProcessing`).
 */
export function createHazeOutputNode({
  scenePass,
  sceneColorNode = null,
  aerialPerspectiveTexture,
  luminanceScale,
  invProjUniform,
  resZ = 32,
  kmPerSlice = 8.0, // must match AerialPerspectiveLUT default
  hazeStrength = null,
  skyCube = null,
  cameraWorldUniform = null,
  cameraFarUniform = null,
  logarithmicDepthBuffer = false,
  hazeModeUniform = null,
  raymarchBlendStartKm = null,
  raymarchBlendEndKm = null,
  raymarchCoverageBlendKm = null,
  enableRaymarchFallback = false,
  raymarchSampleCount = 64,
  apRefineSteps = 4,
  atmosphereUniforms = null,
  sunDirection = null,
  lookUniforms = null,
  upVector = null,
  skyLuminanceFactor = null,
  skyDepthEpsilon: skyDepthEpsilonNode = null,
  sunColor = null,
  apDistanceScale = null,
  viewHeightKm = null,
  cameraPositionKm = null,
  transmittanceLUT = null,
  multiScatterLUT = null,
  raymarchOnlyUniform = null,
  shadow = null,
  // Debug modes for bisecting silhouette artefacts. Pass one of:
  // 'ap-rgb'   — AP inscatter colour only (×40 for visibility), refined
  // 'ap-alpha' — AP alpha (transmittance loss) only as grayscale, refined
  // 'w'        — slice index w as grayscale; sky→1, foreground→0
  // 'is-sky'   — sky mask: white = sky, black = geometry
  // 'beyond'   — past-coverage mask: white = pixel uses raymarch fallback
  // 'shadow-occlusion' — fraction of shadow-march samples in shadow (needs `shadow`)
  // 'shadow-deficit'   — removed in-scatter, ×5 (needs `shadow`)
  // null       — normal compositing
  debugMode = null,
}: CreateHazeOutputNodeArgs): any {
  if (skyCube && !cameraWorldUniform) {
    throw new Error('createHazeOutputNode: cameraWorldUniform is required when skyCube is provided.')
  }

  if (lookUniforms) {
    const missing: string[] = []
    if (!cameraWorldUniform) missing.push('cameraWorldUniform')
    if (!sunDirection) missing.push('sunDirection')
    if (!upVector) missing.push('upVector')
    if (missing.length) {
      throw new Error(`createHazeOutputNode: lookUniforms requires ${missing.join(', ')}.`)
    }
  }

  if (enableRaymarchFallback) {
    const missing: string[] = []
    if (!atmosphereUniforms) missing.push('atmosphereUniforms')
    if (!sunDirection) missing.push('sunDirection')
    if (!viewHeightKm && !cameraPositionKm) missing.push('viewHeightKm or cameraPositionKm')
    if (!transmittanceLUT) missing.push('transmittanceLUT')
    if (!multiScatterLUT) missing.push('multiScatterLUT')
    if (!cameraWorldUniform) missing.push('cameraWorldUniform')
    if (missing.length) {
      throw new Error('createHazeOutputNode: enableRaymarchFallback requires ' + missing.join(', ') + '.')
    }
  }

  if (shadow) {
    const missing: string[] = []
    if (!atmosphereUniforms) missing.push('atmosphereUniforms')
    if (!sunDirection) missing.push('sunDirection')
    if (!transmittanceLUT) missing.push('transmittanceLUT')
    if (!multiScatterLUT) missing.push('multiScatterLUT')
    if (!cameraWorldUniform) missing.push('cameraWorldUniform')
    if (!viewHeightKm && !cameraPositionKm) missing.push('viewHeightKm or cameraPositionKm')
    if (missing.length) {
      throw new Error('createHazeOutputNode: shadow requires ' + missing.join(', ') + '.')
    }
  }

  const sceneColor = sceneColorNode ?? scenePass.getTextureNode('output')

  // The AP slice refinement marches the pixel ray, so it needs the raymarch
  // fallback's inputs (validated above) and is compiled with it.
  const refineSteps = enableRaymarchFallback ? Math.max(0, Math.floor(apRefineSteps)) : 0

  // `PassNode` uses `perspectiveDepthToViewZ` for `getViewZNode` — correct for
  // default depth, wrong when `logarithmicDepthBuffer` is on; see hazeScenePassDepth.js
  const { viewZNode, linearDepthNode } = createHazeDepthNodes(scenePass, logarithmicDepthBuffer)

  // AP coverage cap in km — the LUT spans [0, kmPerSlice * resZ]. Geometry
  // whose distance-along-ray exceeds this needs the raymarch fallback.
  const coverageKm = kmPerSlice * resZ

  // Sky-depth tolerance below 1.0 (see the sky-pixel test); 0 unless a caller
  // has a sky that writes a far-plane depth of its own.
  const skyDepthEpsilon = skyDepthEpsilonNode ?? uniform(0)

  // The shadow march runs in its own (by default half-resolution) pass, which
  // rebuilds each pixel's view ray from the same depth + matrices as below.
  const shadowPass = shadow
    ? createShadowDeficitPass({
        state: shadow,
        buildRay: () => {
          const u = uv()
          const { viewZNode: vz, linearDepthNode: ld } = createHazeDepthNodes(scenePass, logarithmicDepthBuffer)
          const dirView = viewRayFromUv(u, invProjUniform)
          const rayDir = tslNormalize(cameraWorldUniform.mul(vec4(dirView, float(0.0))).xyz)
          const distanceM = distanceAlongViewRay(vz, dirView)
          const isSky = rawDepthIsSky(scenePass, skyDepthEpsilon).or(
            cameraFarUniform ? vz.lessThan(cameraFarUniform.mul(-0.999)) : ld.greaterThan(float(0.999)),
          )
          return { rayDir, distanceM, isSky }
        },
        luminanceScale,
        multiScatterLUT,
        outputOcclusion: debugMode === 'shadow-occlusion',
        rayOriginM: cameraWorldUniform.mul(vec4(0.0, 0.0, 0.0, 1.0)).xyz,
        cameraPositionKm: cameraPositionKm || vec3(float(0.0), viewHeightKm, float(0.0)),
        sunDirection,
        params: atmosphereUniforms,
        transmittanceLUT,
        apDistanceScale,
      })
    : null

  return Fn(() => {
    const u = uv()
    // A caller-supplied node is already a screen-space expression (texture
    // nodes auto-sample at the fragment's uv); only the internal fallback
    // texture node needs the explicit sample.
    const baseColor = sceneColorNode ? sceneColor : sceneColor.sample(u)

    // IMPORTANT — distance metric correctness.
    //
    // The AP LUT was BUILT integrating each ray for `tMax` km *along the ray*.
    // We must therefore sample it using *distance along the ray*, NOT |viewZ|.
    // Using |viewZ| (view-space Z component) under-estimates ray length by a
    // factor of `cos(angle from view axis)` — up to ~14% at the corners of a
    // 60° FOV. The visible symptom: silhouettes pop dark when the camera
    // pitches up/down because more pixels move to oblique angles where the
    // AP slice gets sampled too shallow → less haze applied than the sky's
    // full-atmosphere integration → dark fringe at silhouettes.
    //
    // Fix: reconstruct the per-pixel view-space ray direction via inverse
    // projection, then `distAlongRay = |viewZ| / |rayDir.z|`.
    const viewZ = viewZNode

    // NDC reconstruction. WebGPU clip space is Y-flipped relative to WebGL —
    // so when we hand-build a clip vector from `uv()`, we need ndc.y =
    // 1 - 2*uv.y, NOT 2*uv.y - 1. Getting this wrong produces a vertically
    // mirrored ray direction: looking up at the sky, the haze pass's
    // raymarch fallback would integrate *downward* through the atmosphere
    // instead of upward into space — yielding a second atmospheric
    // gradient that overlays the sky-mesh's correct gradient. (The slice-W
    // distance computation above is unaffected because it only uses the
    // magnitude / cos-from-axis of the ray, both of which are sign-symmetric.)
    //
    // Any clip-space point on the pixel's ray gives its direction, so pick a
    // well-conditioned one. The far plane (clip z = 1) is NOT: with the far/near
    // ratios planet-scale scenes use (far 4e7 m, near < 1 m), the inverse
    // projection of a far-plane point loses the ray direction to float32
    // rounding — `cosFromAxis` collapses, `distAlongRay` explodes, every
    // geometry pixel samples the deepest AP slice and renders black. Measured
    // 2026-09-26: fine at near 0.9 m, black at near 0.7 m with far 4e7. Mid
    // depth (0.5) is what the AP LUT build uses for the same reconstruction,
    // so build and sample now agree by construction (`viewRayFromUv`).
    const rayDirView = viewRayFromUv(u, invProjUniform)
    // World-space ray direction, reconstructed once and shared by the raymarch
    // fallback, the look retint and the sky-cube shim (TSL does not CSE
    // distinct node instances). w = 0 so the camera translation is ignored.
    // Every consumer requires `cameraWorldUniform`, checked above.
    const worldRayDir = cameraWorldUniform
      ? tslNormalize(cameraWorldUniform.mul(vec4(rayDirView, float(0.0))).xyz).toVar()
      : null
    const distAlongRayM = distanceAlongViewRay(viewZ, rayDirView)
    // `apDistanceScale` (Unreal AerialPerspectiveViewDistanceScale) stretches
    // the optical path at sample time. Applied here so slice lookup, coverage
    // test and the raymarch fallback's tMax all see the same scaled distance.
    const distKm = apDistanceScale ? distAlongRayM.mul(0.001).mul(apDistanceScale) : distAlongRayM.mul(0.001)

    // AP LUT W axis: w = sqrt(slice/resZ) where slice = distKm/kmPerSlice.
    const sliceN = distKm.div(float(kmPerSlice)).div(float(resZ))
    const w = sqrt(clamp(sliceN, float(0.0), float(1.0)))

    // IMPORTANT — force level-0 sampling. `texture3D(...)` defaults to
    // derivative-based mip selection. At silhouette pixels the screen-space
    // derivative of `w` is huge (jumps from surface depth to far-plane in
    // one pixel), so the GPU picks a high "mip" level and returns a
    // garbage averaged sample → 1-pixel dark outlines tracing every
    // silhouette. Bypassing derivative-based selection forces the proper
    // trilinear sample at the actual UVW.
    const ap = texture3D(aerialPerspectiveTexture, vec3(u.x, u.y, w)).level(0)

    // Sky-pixel detection.
    //
    // Primary test: the raw depth-buffer value, exactly 1.0. Nothing sky-like
    // writes depth: a background (cube or colour) and the live sky mesh (drawn
    // after opaques, depth write off; `SkyAtmosphereMesh`) both leave the
    // cleared 1.0. A written `z = w` depth lands one or more ulps below 1.0
    // depending on the triangle and the view, and no tolerance works: 4 ulps
    // swallowed geometry past 191 km at near 1 m / far 200 km (unhazed black
    // line along the horizon), 1.25 ulps let whole sky triangles through as
    // geometry mid-drag (hazed triangles across the sky).
    //
    // The two older tests are kept (OR-ed in) for callers that relied on
    // them, but both silently failed for any far plane beyond a few km: with
    // the sky one ulp below 1.0, `perspectiveDepthToViewZ` returns
    // `-near·far / (near + ulp·far)` — only ≈ -0.45·far at far = 2e7 — far
    // short of the `-0.999·far` / `linearDepth > 0.999` thresholds. Every sky
    // pixel then took the geometry path and had AP inscatter added on top of
    // the Sky-View LUT (measured +40% sky luminance against Bruneton's
    // reference, 2026-09-26). The `viewZ`/`linearDepth` tests still hold for
    // small far planes (≤ ~2 km) where one depth ulp is negligible.
    const isSkyRaw = rawDepthIsSky(scenePass, skyDepthEpsilon)
    const isSkyLegacy = cameraFarUniform
      ? viewZ.lessThan(cameraFarUniform.mul(-0.999))
      : linearDepthNode.greaterThan(float(0.999))
    const isSky = isSkyRaw.or(isSkyLegacy)

    // Past-coverage mask — geometry whose distance exceeds the AP LUT's
    // total range. Used to gate the raymarch fallback and to make the
    // transition visible in `?debug=beyond`.
    const beyondCoverage = distKm.greaterThan(float(coverageKm))

    // Haze policy:
    // 0 = auto hybrid, 1 = AP-first, 2 = force raymarch. Default is 1 to
    // preserve older callers unless they explicitly opt into policy blending.
    const hazeMode = hazeModeUniform || float(1.0)
    const blendStartKm = raymarchBlendStartKm || float(50.0)
    const blendEndKm = max(raymarchBlendEndKm || float(100.0), blendStartKm.add(0.001))
    const coverageBlendKm = max(raymarchCoverageBlendKm || float(128.0), float(0.001))
    const cameraAltitudeKm = atmosphereUniforms
      ? cameraPositionKm
        ? length(cameraPositionKm).sub(atmosphereUniforms.bottomRadius)
        : viewHeightKm
          ? viewHeightKm.sub(atmosphereUniforms.bottomRadius)
          : float(0.0)
      : float(0.0)
    const altitudeWeight = smoothstep(blendStartKm, blendEndKm, cameraAltitudeKm)
    const coverageWeight = smoothstep(float(coverageKm).sub(coverageBlendKm), float(coverageKm), distKm)
    const autoWeight = max(altitudeWeight, coverageWeight)
    const apWeight = beyondCoverage.select(float(1.0), float(0.0))
    const isRaymarchMode = hazeMode.greaterThan(float(1.5))
    const isApMode = hazeMode.greaterThan(float(0.5)).and(hazeMode.lessThan(float(1.5)))
    const policyWeight = isRaymarchMode.select(float(1.0), isApMode.select(apWeight, autoWeight))

    // "Force raymarch for every geometry pixel" — manual orbit-altitude
    // override. The AP LUT's voxel parameterization is keyed to the
    // camera's frustum and assumes the camera sits inside the atmosphere
    // with reasonably ground-perpendicular orientation; off-axis views at
    // altitude expose visible coverage holes / direction-sensitive haze.
    // In raymarch-only mode we skip the LUT entirely and integrate every
    // geometry pixel through the same `integrateScatteredLuminance` call
    // the past-coverage branch already uses. See `raymarchOnlyUniform`
    // docs at the top of this file.
    const forceRaymarch = raymarchOnlyUniform ? raymarchOnlyUniform.greaterThan(float(0.5)) : null
    const raymarchWeight = forceRaymarch ? forceRaymarch.select(float(1.0), policyWeight) : policyWeight
    // Sky pixels are excluded: their depth sits at the far plane, so with a
    // large `camera.far` (planet demos use 20,000 km) `distKm` puts every sky
    // pixel past AP coverage and into this branch — where the 64-sample
    // integration runs and is then thrown away by the final `isSky` mix.
    // That silently burned more GPU time than everything else in the haze
    // pass combined. SebH's reference does the same exclusion the other way
    // round: `RenderRayMarchingPS` early-outs `DepthBufferValue == 1.0` pixels
    // to a SkyView LUT sample before any per-pixel marching (FASTSKY path,
    // RenderSkyRayMarching.hlsl:318-341). Our sky mesh already IS that LUT
    // sample, so sky pixels have nothing to compute here.
    const useRaymarch = raymarchWeight.greaterThan(float(0.0)).and(isSky.not())

    // Slice refinement at altitude (#5, ROADMAP D4). From a few km up, a
    // ray to the ground gathers nearly all of its haze in its last few km
    // (scale heights: Rayleigh 8 km, Mie 1.2 km), well inside one depth
    // slice (~20 km apart at 100–200 km with 32 km/slice). Linear
    // interpolation between two slices across that rise reads low by an
    // amount that depends on where the surface falls between them: zero at a
    // slice centre, largest half-way. So the error repeats once per slice
    // along every ray, and on a planet seen from above the slices are
    // iso-distance shells, hence concentric bands around the nadir.
    //
    // Instead of interpolating across the rise, take the LUT only at slice
    // centres and integrate the rest of the pixel's own ray: with u the
    // texel-space depth of the surface distance D (capped at the ground
    // sphere, below), za = floor(u) and zb = za − 1 the two slices before it,
    //   Ea = LUT(za) ⊕ march(d(za) → D)
    //   Eb = LUT(zb) ⊕ march(d(zb) → d(za)) ⊕ march(d(za) → D)
    // and blend Eb → Ea by fract(u). Both estimate the same value; the blend
    // keeps the result continuous where the surface crosses a slice centre
    // (Ea alone jumps there by the LUT's own error). ⊕ is front-to-back
    // compositing with the LUT's scalar transmittance.
    const apC = vec4(ap).toVar()
    if (refineSteps > 0) {
      const refineWeight = smoothstep(
        float(AP_REFINE_ALTITUDE_KM[0]),
        float(AP_REFINE_ALTITUDE_KM[1]),
        cameraAltitudeKm,
      )
      If(
        refineWeight
          .greaterThan(float(0.0))
          .and(isSky.not())
          .and(raymarchWeight.lessThan(float(1.0))),
        () => {
          const camPos = cameraPositionKm || vec3(float(0.0), viewHeightKm, float(0.0))
          const sliceKm = (zi: any) => {
            const wi = max(zi, float(0.0)).add(0.5).div(float(resZ))
            return zi.greaterThanEqual(float(0.0)).select(wi.mul(wi).mul(float(resZ * kmPerSlice)), float(0.0))
          }
          // z = −1 is the camera itself: no haze yet.
          const lutAt = (zi: any) => {
            const wi = max(zi, float(0.0)).add(0.5).div(float(resZ))
            const t = texture3D(aerialPerspectiveTexture, vec3(u.x, u.y, wi)).level(0)
            return zi.greaterThanEqual(float(0.0)).select(t, vec4(0.0, 0.0, 0.0, 0.0))
          }
          // Inscatter (rgb) and mean transmittance (a) of the pixel ray over
          // [fromKm, fromKm + lenKm]. Steps packed toward the far end
          // ('quadraticEnd'): seen from above, the dense air sits at the end of
          // the segment, by the surface. Against equal steps at 4 steps, the
          // slice-locked error drops from 0.009 to 0.0076 (150 km) and 0.014
          // to 0.011 (300 km) in AP alpha, same cost; 10–75 km is unchanged
          // or slightly better.
          const march = (fromKm: any, lenKm: any) => {
            const p0 = camPos.add(worldRayDir.mul(fromKm))
            const moved = moveToTopAtmosphere(p0, worldRayDir, atmosphereUniforms)
            const startPos = moved.newPos.toVar()
            const r = integrateScatteredLuminance({
              worldPos: startPos,
              worldDir: worldRayDir,
              sunDir: sunDirection,
              params: atmosphereUniforms,
              transmittanceLUT,
              multiScatterLUT,
              sampleCount: refineSteps,
              sampleDistribution: 'quadraticEnd',
              ground: false,
              mieRayPhase: true,
              tMaxOverride: max(lenKm.sub(length(startPos.sub(p0))), float(0.0)),
            })
            const valid = moved.valid.select(float(1.0), float(0.0))
            const meanT = r.transmittance.x
              .add(r.transmittance.y)
              .add(r.transmittance.z)
              .mul(1.0 / 3.0)
            return vec4(r.L.mul(valid), mix(float(1.0), meanT, valid)).toVar()
          }
          // End the ray at the analytic ground if the surface lies below it
          // (coarse planet tessellation, terrain under the sphere): there is
          // no medium past it, which is also where the raymarch path's
          // integrator stops. Without this a slice centre can fall under the
          // ground, its march starts inside the planet and integrates nothing:
          // thin dark-then-bright lines one slice apart.
          const tGround = raySphereIntersectNearest(
            camPos,
            worldRayDir,
            vec3(0.0, 0.0, 0.0),
            atmosphereUniforms.bottomRadius,
          )
          const surfKm = tGround.greaterThan(float(0.0)).select(min(distKm, tGround), distKm)
          const uTex = sqrt(clamp(surfKm.div(float(coverageKm)), float(0.0), float(1.0)))
            .mul(float(resZ))
            .sub(0.5)
          const za = max(floor(uTex), float(-1.0)).toVar()
          const zb = max(za.sub(1.0), float(-1.0))
          const phase = clamp(uTex.sub(za), float(0.0), float(1.0))
          const da = sliceKm(za).toVar()
          const db = sliceKm(zb).toVar()
          // Both marches run through one loop, so the integrator is emitted
          // once: two inline calls doubled the shader (60 KB at planet scale,
          // where FXC compiles get slow; issue #49). Values the loop reads are
          // pinned above it, or TSL would declare them inside the first
          // iteration's scope.
          const lenA = max(surfKm.sub(da), float(0.0)).toVar()
          const lenB = max(da.sub(db), float(0.0)).toVar()
          const segA = vec4(0.0).toVar()
          const segB = vec4(0.0).toVar()
          Loop({ start: 0, end: 2, type: 'int' }, ({ i }: any) => {
            const first = i.equal(0)
            const seg = march(first.select(da, db), first.select(lenA, lenB))
            If(first, () => {
              segA.assign(seg)
            }).Else(() => {
              segB.assign(seg)
            })
          })
          const lutA = lutAt(za)
          const lutB = lutAt(zb)
          const tA = float(1.0).sub(lutA.a)
          const tB = float(1.0).sub(lutB.a)
          const ea = vec4(lutA.rgb.add(segA.rgb.mul(tA)), float(1.0).sub(tA.mul(segA.a)))
          const eb = vec4(
            lutB.rgb.add(segB.rgb.mul(tB)).add(segA.rgb.mul(tB.mul(segB.a))),
            float(1.0).sub(tB.mul(segB.a).mul(segA.a)),
          )
          apC.assign(mix(ap, mix(eb, ea, phase), refineWeight))
        },
      )
    }

    // Debug bisection — JS-side mode select (compiles to one branch).
    if (debugMode === 'ap-rgb') return vec4(apC.rgb.mul(luminanceScale).mul(5.0), 1.0)
    if (debugMode === 'ap-alpha') return vec4(vec3(apC.a), 1.0)
    if (debugMode === 'w') return vec4(vec3(w), 1.0)
    // Select between vec3s: `vec3(cond.select(1.0, 0.0))` collapses to a bare
    // f32 in the generated WGSL and fails the vec4 constructor.
    const white = vec3(1.0, 1.0, 1.0)
    const black = vec3(0.0, 0.0, 0.0)
    if (debugMode === 'is-sky') return vec4(isSky.select(white, black), 1.0)
    if (debugMode === 'beyond') return vec4(beyondCoverage.select(white, black), 1.0)
    if (debugMode === 'lin-depth') return vec4(vec3(linearDepthNode), 1.0)
    if (debugMode === 'view-z' && cameraFarUniform) return vec4(vec3(abs(viewZ).div(cameraFarUniform)), 1.0)

    // --- LUT-based AP composite (close range) ---
    const apRgbBase = apC.rgb.mul(luminanceScale)
    const apABase = hazeStrength !== null ? apC.a.mul(hazeStrength) : apC.a
    const apRgbBaseScaled = hazeStrength !== null ? apRgbBase.mul(hazeStrength) : apRgbBase

    // Working accumulators. We start from the LUT path and overwrite for
    // past-coverage geometry when raymarch fallback is wired.
    const apA = apABase.toVar()
    const apRgbScaled = apRgbBaseScaled.toVar()

    // Raw raymarch output, exposed as debug. Set inside the raymarch branch
    // when active so adjacent debug modes show meaningful values.
    const rmDebugRgb = vec3(0.0, 0.0, 0.0).toVar()
    const rmDebugAlpha = float(0.0).toVar()

    if (enableRaymarchFallback) {
      // Past-coverage branch — integrate atmosphere from camera through
      // the actual surface distance. We feed the integrator
      // `tMaxOverride = distAlongRayKm`, which makes it march exactly the
      // camera→surface segment, clipped against ground/top spheres so
      // rays that punch into the planet still terminate at the surface
      // shell. The result is a real, finite, non-clamped optical-path
      // answer — what slice 31 of the LUT *would* have stored if it
      // extended that far.
      //
      // World-space ray direction = (cameraWorldMatrix · vec4(viewDir, 0)).xyz.
      // Y-up world == atmosphere frame (planet centre at origin, +Y up),
      // so we can use it directly as the integrator's `worldDir`.
      If(useRaymarch, () => {
        const worldDir = worldRayDir

        // Camera position in atmosphere frame: planet centre at origin,
        // camera straight up by viewHeight. Horizontal world position
        // is dropped — at planet scale the difference is invisible
        // (atmosphere is symmetric around the centre) and matches the
        // convention the sky mesh's space-view fallback uses.
        const camPos = cameraPositionKm || vec3(float(0.0), viewHeightKm, float(0.0))
        const moved = moveToTopAtmosphere(camPos, worldDir, atmosphereUniforms)
        const startPos = moved.newPos.toVar()

        // March length is the surface's depth measured from where the march
        // starts. RenderRayMarchingPS moves WorldPos to the atmosphere top
        // (:377) before IntegrateScatteredLuminance turns the depth buffer
        // into tDepth = |surface − WorldPos| (:67). Passing the camera-relative
        // distance from the moved start ran the ray past the surface by the
        // skipped vacuum; ground pixels hid it (the march stops at the ground
        // sphere) but anything standing above the ground got the air behind
        // it. Inside the atmosphere the start is the camera and this is exact.
        //
        // Depth-buffer distances lose precision far from the camera, and with
        // the march no longer overshooting, an error there now shortens it.
        // From 2,700 and 12,000 km (Bruneton's space views, standard depth)
        // ground pixels read up to 12 % less haze. So from above the
        // atmosphere, a surface within 0.2 % of the ground sphere's distance
        // is taken to be the ground: that is where the march stopped before,
        // and a mountain worth seeing stands well clear of it (0.6 km at
        // 300 km). Inside the atmosphere nothing changes.
        const tGround = raySphereIntersectNearest(
          camPos,
          worldDir,
          vec3(0.0, 0.0, 0.0),
          atmosphereUniforms.bottomRadius,
        )
        const lengthToAtmosphere = length(startPos.sub(camPos))
        const atGround = lengthToAtmosphere
          .greaterThan(float(0.0))
          .and(tGround.greaterThan(float(0.0)))
          .and(distKm.greaterThan(tGround.mul(0.998)))
        const surfKm = atGround.select(max(distKm, tGround), distKm)
        const distKmVar = max(surfKm.sub(lengthToAtmosphere), float(0.0)).toVar()

        // Per-pixel hash in [0, 1] — breaks the coherent
        // sample-position alignment that caused horizontal banding
        // in transmittance (visible at 50–105 km altitude in
        // `?debug=rm-alpha`). Cheap one-line hash off uv; not blue
        // noise but good enough to fully scramble the pattern at
        // the resolutions we use. Replaces the canonical fixed
        // `SAMPLE_SEGMENT_T = 0.3` offset with a per-pixel value
        // so adjacent pixels' samples no longer line up at the
        // same altitudes.
        const hash01 = fract(sin(dot(u, vec2(12.9898, 78.233))).mul(43758.5453))

        const result = integrateScatteredLuminance({
          worldPos: startPos,
          worldDir: worldDir,
          sunDir: sunDirection,
          params: atmosphereUniforms,
          transmittanceLUT: transmittanceLUT,
          multiScatterLUT: multiScatterLUT,
          // Grazing rays from 50–100 km altitude can integrate over
          // 1000+ km of atmosphere; at 30 samples that's ~33 km/step,
          // which undersamples the TLUT's near-horizon remap and
          // produces visible rings/banding closer to the planet
          // horizon. 64 samples (~16 km/step on a 1000 km ray) cleans
          // it up at modest cost — geometry pixels only, not sky.
          sampleCount: raymarchSampleCount,
          ground: false, // we already have the surface in the scene; don't double-count
          mieRayPhase: true,
          tMaxOverride: distKmVar,
          sampleJitter: hash01,
          // Per-pixel raymarch = SebH's RenderRayMarchingPS (VariableSampleCount).
          sampleDistribution: 'quadratic',
        })

        // Composite identically to the LUT path: rgb = inscatter,
        // alpha = 1 - mean transmittance. integrateScatteredLuminance
        // returns transmittance as a vec3; collapse to a scalar for AP
        // alpha (matches what the AP LUT bake does).
        const validF = moved.valid.select(float(1.0), float(0.0))
        const rmRgb = result.L.mul(luminanceScale).mul(validF)
        const rmTransmittance = result.transmittance
        const rmAlpha = float(1.0)
          .sub(
            rmTransmittance.x
              .add(rmTransmittance.y)
              .add(rmTransmittance.z)
              .mul(float(1.0 / 3.0)),
          )
          .mul(validF)

        const rmA = hazeStrength !== null ? rmAlpha.mul(hazeStrength) : rmAlpha
        const rmRgbScaled = hazeStrength !== null ? rmRgb.mul(hazeStrength) : rmRgb

        apA.assign(mix(apA, rmA, raymarchWeight))
        apRgbScaled.assign(mix(apRgbScaled, rmRgbScaled, raymarchWeight))
        rmDebugRgb.assign(rmRgbScaled)
        rmDebugAlpha.assign(rmA)
      })
    }

    // Sun colour, ahead of the look — same order as the sky mesh.
    if (sunColor) apRgbScaled.mulAssign(sunColor)

    // Stylized look retint. Applied to AP inscatter after both the LUT and
    // raymarch paths have merged, so haze agrees with the styled sky rather
    // than staying physical — otherwise the two disagree at exactly the
    // silhouette boundary this file already fights hardest to keep clean.
    //
    // `valueScale: 0` forces the look's value axis off here. Only the chroma
    // axis is scale-invariant, and AP inscatter is a *partial-path* integral —
    // far dimmer than the full sky integral the ramp's `intensity` is
    // calibrated against. Pushing its luminance toward the ramp would blow out
    // near geometry. Chroma replacement keeps the magnitude AP computed and
    // swaps only the hue, which is what makes sky and haze land on the same
    // colour without double-integrating anything.
    if (lookUniforms) {
      const lookWorldDir = worldRayDir
      const lookUp = tslNormalize(upVector)
      const lookSun = tslNormalize(sunDirection)
      apRgbScaled.assign(
        applyLook({
          color: apRgbScaled,
          viewZenithCosAngle: clamp(dot(lookWorldDir, lookUp), float(-1.0), float(1.0)),
          lightViewCosAngle: computeLightViewCosAngle(lookWorldDir, lookUp, lookSun),
          sunViewCosAngle: dot(lookWorldDir, lookSun),
          sunZenithCosAngle: dot(lookSun, lookUp),
          look: lookUniforms,
          valueScale: float(0.0),
        }),
      )
    }

    // Final per-channel grade, same uniform the sky mesh applies after its look.
    if (skyLuminanceFactor) apRgbScaled.mulAssign(skyLuminanceFactor)

    // Raymarch debug modes — useful at altitude when isolating where
    // chunky/banded artefacts originate. `rm-rgb` shows raw inscatter
    // brightness only (no compositing), `rm-alpha` shows the raymarch's
    // transmittance loss as grayscale. Pixels not routed through the
    // raymarch (LUT path, or sky pixels) read black in these modes.
    if (debugMode === 'rm-rgb') return vec4(rmDebugRgb.mul(5.0), 1.0)
    if (debugMode === 'rm-alpha') return vec4(vec3(rmDebugAlpha), 1.0)

    let composited = baseColor.rgb.mul(float(1.0).sub(apA)).add(apRgbScaled)

    // Sky-fallback blend: when AP alpha is high (heavy haze along the ray),
    // the surface is fully attenuated and physically *should* show the sky
    // behind it. Without this blend, AP — which only covers ~256 km — gives
    // a different colour than the Sky-View LUT (which integrates the full
    // atmosphere) at the same direction, producing a sharp horizon line.
    // We sample the scene's background cube at the fragment's world ray
    // direction and lerp toward it weighted by `apA` itself: at apA = 0
    // (no haze) the composite is unchanged; at apA = 1 (fully attenuated)
    // the result equals the cube sample. This is mathematically the same
    // transmittance-driven blend, applied a second time against the
    // "sky behind the surface" instead of the surface's own colour.
    if (skyCube) {
      const skyAtDir = cubeTexture(skyCube, worldRayDir).rgb
      composited = mix(composited, skyAtDir, apA)
    }

    if (shadowPass) {
      // Shadowed haze: remove the single-scattered sun light the shadow map
      // occludes (marched in its own pass, see `createShadowDeficitPass`).
      // Geometry pixels get the in-shadow *fraction* of their path's
      // in-scatter, applied to the AP value itself — already graded, and the
      // fraction is scale-free, so no further grading is needed. Sky pixels
      // get the absolute deficit, graded exactly like AP inscatter
      // (luminanceScale — applied in the pass — strength, look chroma, sky
      // luminance factor, sun colour); with `valueScale: 0` the look is linear in its
      // input, so grading the deficit separately equals grading the
      // difference. Rays that miss the shadow frustum read exactly 0.
      const upsampled = upsampleShadowDeficit({ pass: shadowPass, uvNode: u, distanceM: distAlongRayM, isSky })
      if (debugMode === 'shadow-occlusion') return vec4(upsampled, 1.0)

      let skyShaft = upsampled
      if (hazeStrength !== null) skyShaft = skyShaft.mul(hazeStrength)
      // Same order as AP inscatter: sun colour ahead of the look.
      if (sunColor) skyShaft = skyShaft.mul(sunColor)
      if (lookUniforms) {
        const lookUp = tslNormalize(upVector)
        const lookSun = tslNormalize(sunDirection)
        skyShaft = applyLook({
          color: skyShaft,
          viewZenithCosAngle: clamp(dot(worldRayDir, lookUp), float(-1.0), float(1.0)),
          lightViewCosAngle: computeLightViewCosAngle(worldRayDir, lookUp, lookSun),
          sunViewCosAngle: dot(worldRayDir, lookSun),
          sunZenithCosAngle: dot(lookSun, lookUp),
          look: lookUniforms,
          valueScale: float(0.0),
        })
      }
      if (skyLuminanceFactor) skyShaft = skyShaft.mul(skyLuminanceFactor)
      // Never remove more than was there.
      const skyRemoved = min(skyShaft, max(baseColor.rgb, vec3(0.0)))
      const geometryRemoved = max(apRgbScaled, vec3(0.0)).mul(clamp(upsampled, vec3(0.0), vec3(1.0)))

      if (debugMode === 'shadow-deficit') {
        return vec4(mix(geometryRemoved, skyRemoved, isSky.select(1.0, 0.0)).mul(5.0), 1.0)
      }

      const geometryOut = composited.sub(geometryRemoved)
      const skyOut = baseColor.rgb.sub(skyRemoved)
      return vec4(mix(geometryOut, skyOut, isSky.select(1.0, 0.0)), baseColor.a)
    }

    return vec4(mix(composited, baseColor.rgb, isSky.select(1.0, 0.0)), baseColor.a)
  })()
}
