import {
  BackSide,
  BoxGeometry,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  Mesh,
  RGBAFormat,
  RepeatWrapping,
  Vector3,
  NodeMaterial,
} from 'three/webgpu'

import {
  Fn,
  If,
  abs,
  cos,
  sin,
  float,
  vec3,
  vec4,
  dot,
  normalize,
  max,
  clamp,
  mix,
  smoothstep,
  texture,
  equirectUV,
  modelViewProjection,
  positionWorld,
  cameraPosition,
  uniform,
} from 'three/tsl'

import {
  integrateScatteredLuminance,
  moveToTopAtmosphere,
  raySphereIntersectNearest,
  computeLightViewCosAngle,
  skyViewLutParamsToUv,
  transmittanceLutParamsToUv,
} from '../backends/tsl/atmosphere.tsl'
import { proceduralStars } from './shaders/proceduralStars.tsl'
import { applyLook } from '../backends/tsl/look.tsl'
import { clearLookUniforms, createLookUniforms, updateLookUniforms } from './LookUniforms'

import type { Look } from '../looks'

interface SkyAtmosphereMeshOptions {
  atmosphereUniforms?: any
  skyViewLUT?: any
  transmittanceLUT?: any
  multiScatterLUT?: any
  sunDirection?: Vector3
  upVector?: Vector3
}

// 1×1 black HalfFloat placeholder used when no star texture is wired. Sized to
// match the EXR replacement format so swapping `texNode.value` later doesn't
// trip a format-mismatch reupload.
function _makeStarsPlaceholder(): DataTexture {
  // Half-float "0" is the bit pattern 0x0000.
  const data = new Uint16Array(4)
  const tex = new DataTexture(data, 1, 1, RGBAFormat, HalfFloatType)
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.needsUpdate = true
  tex.name = 'SkyAtmosphereMesh.starsPlaceholder'
  return tex
}

/**
 * Phase 1b visible sky — Hillaire LUT-sampled box mesh.
 *
 * Matches the shape of the legacy Preetham `SkyMesh` exactly: `BoxGeometry(1,1,1)`
 * with `BackSide` + `depthWrite=false` + the `z = w` vertex trick so the cube
 * always sits at the far plane. Only the fragment path changes — for each view
 * direction we un-map the Hillaire (viewZenithCos, lightViewCos) parameterization
 * and sample the Sky-View LUT.
 *
 * Port of the final-compose pass `RenderSkyWithLutsPS` in
 * `UnrealEngineSkyAtmosphere/Resources/RenderSkyRayMarching.hlsl:333`. Uses
 * `skyViewLutParamsToUv` (forward map) from `atmosphere.tsl.js`.
 *
 * Sun disc is rendered on top as a smoothstep against the angular diameter,
 * gated by `showSunDisc` (default 0 — off during bake to keep PMREM clean).
 *
 * Sun direction and up vector live in three.js-world Y-up coordinates (baked sky
 * scene uses the main scene's conventions). The Sky-View LUT itself is built in
 * a Z-up local frame, but the *UV parameterization* is frame-independent: it
 * only depends on (viewZenithCos, lightViewCos, viewHeight, intersectsGround),
 * which we compute here from the Y-up world vectors directly.
 */
export class SkyAtmosphereMesh extends Mesh {
  atmosphereUniforms: any
  skyViewLUT: any
  transmittanceLUT: any
  multiScatterLUT: any
  sunDirection: any
  upVector: any
  showSunDisc: any
  mirrorBelowHorizon: any
  sunDiscIntensity: any
  sunDiscCos: any
  sunDiscCosInner: any
  moonDirection: any
  showMoonDisc: any
  moonIntensity: any
  moonDiscCos: any
  moonColor: any
  viewHeight: any
  luminanceScale: any
  lookUniforms: ReturnType<typeof createLookUniforms>
  _starsTexturePlaceholder: DataTexture
  starsTextureNode: any
  starsIntensity: any
  starsMode: any
  starsDensity: any
  starsBrightnessScale: any
  starsRotation: any
  isSkyAtmosphereMesh: boolean

  /**
   * @param {object} args
   * @param {object} args.atmosphereUniforms  bundle from createAtmosphereUniforms
   * @param {SkyViewLUT} args.skyViewLUT      already-constructed Sky-View LUT
   * @param {TransmittanceLUT} [args.transmittanceLUT]  required for the
   *   space-view raymarch fallback (camera viewHeight > topRadius). Optional
   *   for ground-only callers; without it, the mesh stays in pure SkyView mode.
   * @param {MultiScatterLUT} [args.multiScatterLUT]  paired with transmittanceLUT.
   * @param {THREE.Vector3} [args.sunDirection]  initial Y-up world-space sun dir
   * @param {THREE.Vector3} [args.upVector]      initial Y-up world-space up dir
   */
  constructor({
    atmosphereUniforms,
    skyViewLUT,
    transmittanceLUT = null,
    multiScatterLUT = null,
    sunDirection,
    upVector,
  }: SkyAtmosphereMeshOptions = {}) {
    if (!atmosphereUniforms) throw new Error('SkyAtmosphereMesh: atmosphereUniforms is required')
    if (!skyViewLUT) throw new Error('SkyAtmosphereMesh: skyViewLUT is required')

    const material = new NodeMaterial()

    super(new BoxGeometry(1, 1, 1), material)

    this.atmosphereUniforms = atmosphereUniforms
    this.skyViewLUT = skyViewLUT
    this.transmittanceLUT = transmittanceLUT
    this.multiScatterLUT = multiScatterLUT

    /**
     * Sun direction in Y-up world space (same frame as the main scene).
     * Mutate in place or re-assign via `.sunDirection = vec`; the uniform
     * tracks the Vector3 instance by reference.
     *
     * @type {UniformNode<vec3>}
     */
    this.sunDirection = uniform(sunDirection instanceof Vector3 ? sunDirection.clone() : new Vector3(0.0, 1.0, 0.0))

    /**
     * Up vector in Y-up world space.
     *
     * @type {UniformNode<vec3>}
     */
    this.upVector = uniform(upVector instanceof Vector3 ? upVector.clone() : new Vector3(0.0, 1.0, 0.0))

    /**
     * Whether to render the solar disc (float 0/1). Default 0 — the baker
     * flips this on after the cube bake completes so main-scene renders can
     * still see a sharp sun disc in the background.
     *
     * @type {UniformNode<float>}
     */
    this.showSunDisc = uniform(0.0)

    /**
     * Below-horizon Y-mirror (float 0/1). When 1, view rays pointing
     * downward (against `upVector`) get their up-component flipped to
     * positive before the Sky-View LUT sample. The result is a clean
     * Y-mirror of the sky on the lower hemisphere instead of the LUT's
     * `ground: true` lit-albedo content. The baker toggles this on
     * during the cube bake (when `mirrorBelowHorizon` is enabled at
     * construction) so `environmentTexture` becomes a complete sky
     * HDRI with no ground tint in the lower mips — handy when the
     * consumer scene has reflective floors or uses `GroundedSkybox` in
     * reflective mode and doesn't want ground colour bleeding into
     * PBR IBL. Live mesh in the main scene keeps this at 0 so the
     * direct sky view continues to show real below-horizon LUT content.
     *
     * @type {UniformNode<float>}
     */
    this.mirrorBelowHorizon = uniform(0.0)

    /**
     * Sun-disc intensity multiplier, applied *after* the transmittance tint
     * (see `_buildColorNode`'s sun-disc term). Deliberately NOT multiplied
     * by `luminanceScale` — the sky LUT sample and the disc are on
     * different scales (LUT is "per unit sun illuminance", the disc is a
     * direct luminaire term), and stacking both scales would blow the disc
     * out to a flat white disc at every elevation, defeating the point of
     * the transmittance tint.
     *
     * Derivation of the default (20.0), assuming the demo defaults of
     * `luminanceScale = 40` and `renderer.toneMappingExposure = 0.5`:
     * composite = `sunDiscIntensity * transmittance`, and the ACES filmic
     * curve is effectively saturated (reads as flat white) for any input
     * above roughly 2–3 post-exposure. At zenith, camera→space
     * transmittance is close to 1 (clear air overhead), so
     * `20 * 1.0 * 0.5(exposure) = 10` — comfortably into the saturated
     * region, giving the expected bright-white high-sun disc. Near the
     * horizon transmittance drops sharply (Rayleigh + Mie extinction over
     * a long grazing path) — by T ≈ 0.2 the composite is
     * `20 * 0.2 * 0.5 = 2`, right at the edge of saturation, so the disc
     * starts reading as colour instead of flat white; by T ≈ 0.05 it's
     * `20 * 0.05 * 0.5 = 0.5`, a dim reddened ember that fades into the
     * horizon glow just before `intersectsGround` clips it entirely. This
     * headroom (≈40x between "just saturated" and "just visible") is what
     * produces the white→red→gone falloff described in the elevation
     * sweep verification script.
     *
     * @type {UniformNode<float>}
     */
    this.sunDiscIntensity = uniform(20.0)

    /**
     * Sun-disc angular *half-angle* in radians, stored as `cos(halfAngle)`
     * (the outer edge of the smoothstep soft rim — see `sunDiscCosInner`).
     * Default 0.004675 rad ≈ 0.268°, i.e. an angular *diameter* of ≈0.535°,
     * matching the real Sun seen from Earth. Update both bounds together
     * via `setSunAngularRadius(halfAngleRad, edgeSoftness)` rather than
     * poking this uniform directly, so the soft-edge inner bound stays in
     * sync.
     *
     * @type {UniformNode<float>}
     */
    this.sunDiscCos = uniform(Math.cos(0.004675))

    /**
     * Inner bound of the sun disc's soft edge, stored as `cos(innerAngle)`
     * where `innerAngle = halfAngle * (1 - edgeSoftness)`. The disc mask is
     * `smoothstep(sunDiscCos, sunDiscCosInner, dot(viewDir, sunDir))` — 1.0
     * inside `innerAngle`, ramping to 0.0 at `halfAngle`. Doing the ramp in
     * `cos`-space with precomputed bounds (rather than an `acos` per pixel)
     * keeps the shader cheap; only `setSunAngularRadius` pays the trig cost,
     * on the JS side, once per call. Default edge softness is 10% of the
     * half-angle — enough to anti-alias the disc rim at typical demo
     * resolutions/FOVs without visibly blurring it.
     *
     * @type {UniformNode<float>}
     */
    this.sunDiscCosInner = uniform(Math.cos(0.004675 * (1 - 0.1)))

    /**
     * Moon direction in Y-up world space. Mirrors `sunDirection`. Pushed
     * by `SkyMoon` on every direction sync. Defaults to a placeholder
     * pointing up; the disc is hidden by default so this never matters
     * unless `showMoonDisc` is raised.
     *
     * @type {UniformNode<vec3>}
     */
    this.moonDirection = uniform(new Vector3(0.0, 1.0, 0.0))

    /**
     * Whether to render the moon disc (float 0/1). Default 0 — `SkyMoon`
     * flips this on at construction. The baker temporarily forces it off
     * during the cube bake (parallels sun-disc handling) so PMREM stays
     * clean.
     *
     * @type {UniformNode<float>}
     */
    this.showMoonDisc = uniform(0.0)

    /**
     * Moon-disc intensity multiplier. Tuned much lower than the sun
     * (~1.0 vs sun's 20.0): the real moon is ~6 orders of magnitude
     * dimmer than the sun, but visually we cheat to make it readable.
     *
     * @type {UniformNode<float>}
     */
    this.moonIntensity = uniform(1.0)

    /**
     * Moon-disc angular diameter in radians. Stored as `cos(diameter)`
     * for the smoothstep test. Default ~0.535° matches the Moon seen
     * from Earth (essentially identical to the Sun's angular diameter
     * — that's why eclipses are clean).
     *
     * @type {UniformNode<float>}
     */
    this.moonDiscCos = uniform(Math.cos(0.004675))

    /**
     * Moon-disc colour. Cool-white default mimicking reflected sunlight.
     * Stored on the mesh so callers can tint without rebuilding the
     * material.
     *
     * @type {UniformNode<vec3>}
     */
    this.moonColor = uniform(new Vector3(0.85, 0.9, 1.0))

    /**
     * Camera viewHeight (km, planet-centred). Drives the SkyView LUT UV
     * un-map AND the ground-intersect ray origin. Defaults to ground+ε;
     * the baker's `setCamera()` updates this each frame for phase 2.
     *
     * @type {UniformNode<float>}
     */
    this.viewHeight = uniform(atmosphereUniforms.bottomRadius.value + 0.01)

    /**
     * Global luminance multiplier applied to the Sky-View LUT sample.
     *
     * The LUTs are computed with Hillaire's `ILLUMINANCE_IS_ONE` convention
     * — the integrator's `globalL = 1.0` means the LUT stores sky response
     * *per unit sun illuminance*. Raw values are tiny (~1e-3 to 5e-2) and
     * read as black on a linear-light display. The consumer is expected to
     * multiply by the actual sun luminance at composite time
     * (`RenderSkyWithLutsPS` in the Unreal reference does this via
     * `Atmosphere.GlobalLuminanceScale` × sun terms).
     *
     * Default 40.0: produces a visibly bright sky under ACES with exposure
     * 0.5, matching the legacy Preetham SkyMesh's perceived brightness.
     * Tunable via the GUI.
     *
     * @type {UniformNode<float>}
     */
    this.luminanceScale = uniform(40.0)

    /**
     * Stylized look uniforms. Created in the identity state (chroma 0,
     * value 0), so a mesh with no look assigned renders exactly as before.
     * Populated by `setLook`; every field is a uniform, so look changes
     * never rebuild the LUT chain or recompile the node graph.
     */
    this.lookUniforms = createLookUniforms()

    /**
     * Stars equirect HDR texture (HalfFloat, RGBA). Bound by
     * `SkyNight.enable({ source: 'hdri' | 'texture' })`; until then holds
     * a 1×1 black placeholder so the shader stays well-formed. Swapping
     * `node.value` later picks up the new texture without a material
     * rebuild — keep the format (HalfFloat / RGBA) consistent.
     *
     * @type {TextureNode}
     */
    this._starsTexturePlaceholder = _makeStarsPlaceholder()
    this.starsTextureNode = texture(this._starsTexturePlaceholder)

    /**
     * Stars intensity multiplier (linear). Default 0 — keeps the stars
     * code path silent until `SkyNight.enable()` raises it. ~1.0 is a
     * good visual default for both procedural and HDR sources.
     *
     * @type {UniformNode<float>}
     */
    this.starsIntensity = uniform(0.0)

    /**
     * Stars source mode. 0 = procedural starfield (no asset cost,
     * shader-generated), 1 = sample `starsTextureNode` (user-provided
     * HDR, e.g. a Milky Way capture). Both paths run every frame; the
     * mix is a single lerp on the cheap procedural and a near-free
     * texture sample, so toggling at runtime has no recompile cost.
     *
     * @type {UniformNode<float>}
     */
    this.starsMode = uniform(0.0)

    /**
     * Procedural starfield density: fraction of the 400×200 cell grid
     * that hosts a star. 0.3 ≈ 24k stars over the full sphere — looks
     * like a clear-sky countryside. Lower for a sparse alien world,
     * higher for sci-fi nebula skies.
     *
     * @type {UniformNode<float>}
     */
    this.starsDensity = uniform(0.3)

    /**
     * Procedural starfield brightness multiplier. Tuned so the brightest
     * stars sit slightly above the dim sky scattering at night; raise for
     * supernova-bright look, lower for subtle.
     *
     * @type {UniformNode<float>}
     */
    this.starsBrightnessScale = uniform(1.0)

    /**
     * Stars rotation around the up axis in radians. Applies to both
     * procedural and HDR sources (so binding it to time-of-day rotates
     * either layer consistently).
     *
     * @type {UniformNode<float>}
     */
    this.starsRotation = uniform(0.0)

    /**
     * Flag for type testing.
     *
     * @type {boolean}
     */
    this.isSkyAtmosphereMesh = true

    // --- vertex: same z=w trick as the legacy SkyMesh (keeps the cube at far plane) ---
    const vertexNode = /*@__PURE__*/ Fn(() => {
      const position = modelViewProjection
      position.z.assign(position.w)
      return position
    })()

    // --- fragment: Sky-View LUT sample + sun disc ---
    const colorNode = this._buildColorNode()

    material.side = BackSide
    // `depthWrite = true` so sky pixels stamp the far-plane value into the
    // scene depth buffer (the `z = w` vertex trick gives them NDC.z = 1).
    // The post-process haze pass uses scene depth to discriminate sky vs
    // geometry; with depthWrite off, sky pixels read the cleared depth
    // value which `getViewZNode` / `getLinearDepthNode` then interpret as
    // "at the camera" rather than "at the far plane" — breaking every
    // depth-based sky test. Writing real far-plane depth makes both tests
    // reliable. Geometry still wins the depth test (it's closer than far)
    // so this doesn't occlude anything.
    material.depthWrite = true
    material.vertexNode = vertexNode
    material.colorNode = colorNode
  }

  /**
   * Set the sun disc's angular size and rim softness. `halfAngleRad` is
   * half the disc's angular *diameter* (the physical Sun is ≈0.535°
   * diameter → ≈0.00465 rad half-angle). `edgeSoftness` is the fraction of
   * `halfAngleRad` over which the disc ramps from opaque to transparent at
   * its rim (0 = perfectly hard/aliased edge, 1 = the whole disc is a soft
   * gradient with no flat core). Both `sunDiscCos` (outer bound) and
   * `sunDiscCosInner` (inner bound) are recomputed here in one JS-side call
   * so the shader never needs a per-pixel `acos`.
   */
  setSunAngularRadius(halfAngleRad: number, edgeSoftness: number = 0.1): this {
    this.sunDiscCos.value = Math.cos(halfAngleRad)
    this.sunDiscCosInner.value = Math.cos(halfAngleRad * (1 - edgeSoftness))
    return this
  }

  /**
   * Assign (or clear) the stylized look. Pure uniform writes — no material
   * rebuild, no LUT invalidation. Callers that bake to a cube must still mark
   * the cube dirty; `SkyAtmosphereBaker.setLook` does that.
   */
  setLook(look: Look | null): this {
    if (look) updateLookUniforms(this.lookUniforms, look)
    else clearLookUniforms(this.lookUniforms)
    return this
  }

  _buildColorNode(): any {
    const params = this.atmosphereUniforms
    const skyViewTex = this.skyViewLUT.texture
    const transmittanceTex = this.transmittanceLUT ? this.transmittanceLUT.texture : null
    const multiScatterTex = this.multiScatterLUT ? this.multiScatterLUT.texture : null
    const enableSpaceFallback = transmittanceTex !== null && multiScatterTex !== null
    const sunDirU = this.sunDirection
    const upU = this.upVector
    const showSunDiscU = this.showSunDisc
    const sunDiscIntensityU = this.sunDiscIntensity
    const sunDiscCosU = this.sunDiscCos
    const sunDiscCosInnerU = this.sunDiscCosInner
    const luminanceScaleU = this.luminanceScale
    const viewHeightU = this.viewHeight
    const starsTexNode = this.starsTextureNode
    const starsIntensityU = this.starsIntensity
    const starsModeU = this.starsMode
    const starsDensityU = this.starsDensity
    const starsBrightnessU = this.starsBrightnessScale
    const starsRotationU = this.starsRotation
    const moonDirU = this.moonDirection
    const showMoonDiscU = this.showMoonDisc
    const moonIntensityU = this.moonIntensity
    const moonDiscCosU = this.moonDiscCos
    const moonColorU = this.moonColor
    const mirrorBelowHorizonU = this.mirrorBelowHorizon
    const lookU = this.lookUniforms

    return Fn(() => {
      // View direction from the camera to this fragment's world position.
      const viewDirRaw = normalize(positionWorld.sub(cameraPosition))
      const upVec = normalize(upU)
      const sunDir = normalize(sunDirU)

      // Optional below-horizon Y-mirror. When `mirrorBelowHorizon` is 1,
      // fold the up-axis component of viewDir to be positive (i.e.
      // reflect downward rays about the local horizon plane). All
      // downstream math (intersectsGround, viewZenithCosAngle, LUT
      // sample) automatically produces above-horizon sky content for
      // what would otherwise be ground-direction rays — giving a clean
      // Y-mirrored sky on the cube's lower hemisphere. The horizontal
      // component is untouched so azimuth-relative-to-sun is preserved.
      const vAlongUp = dot(viewDirRaw, upVec)
      const vAlongUpEffective = mix(vAlongUp, abs(vAlongUp), mirrorBelowHorizonU)
      const viewDirHorizontal = viewDirRaw.sub(upVec.mul(vAlongUp))
      const viewDir = normalize(viewDirHorizontal.add(upVec.mul(vAlongUpEffective)))

      // Camera viewHeight (km, distance from planet centre) — driven by the
      // per-frame uniform. Clamp to never fall below `bottomRadius + ε` so
      // the ground-intersect math stays well-defined.
      const viewHeight = max(viewHeightU, params.bottomRadius.add(float(0.01)))

      // View-zenith cosine.
      const viewZenithCosAngle = clamp(dot(viewDir, upVec), float(-1.0), float(1.0))

      // Sun azimuth relative to the view direction. Shared with the haze
      // pass so the look's sun tint lands identically on sky and on haze.
      const lightViewCosAngle = computeLightViewCosAngle(viewDir, upVec, sunDir)

      // Ground intersection test (planet at origin, camera along local up).
      const earthO = vec3(0.0, 0.0, 0.0)
      const ro = upVec.mul(viewHeight)
      const tPlanet = raySphereIntersectNearest(ro, viewDir, earthO, params.bottomRadius)
      const intersectsGround = tPlanet.greaterThanEqual(float(0.0))
      // Shared by stars and the sun disc: both need "is this ray looking at
      // open sky, not the planet" and both need camera→space transmittance.
      const skyMask = intersectsGround.select(float(0.0), float(1.0))

      // Sky color accumulator. Either populated by the SkyView LUT
      // (camera inside / near atmosphere) or by a per-pixel raymarch
      // (camera in space — the LUT's horizon-packed UV layout misallocates
      // texels once the planet stops dominating the view).
      const skyColor = vec3(0.0, 0.0, 0.0).toVar()

      if (enableSpaceFallback) {
        // Smooth transition between LUT and raymarch around topRadius.
        // Below blendStart: pure LUT (cheap, raymarch skipped via If).
        // blendStart..blendEnd: smoothstep blend (both paths contribute).
        // Above blendEnd: pure raymarch (LUT contribution lerped out).
        const BLEND_HALF_WIDTH_KM = float(20.0)
        const blendStart = params.topRadius.sub(BLEND_HALF_WIDTH_KM)
        const blendEnd = params.topRadius.add(BLEND_HALF_WIDTH_KM)

        // LUT path always runs — it's a single texture sample, near-free.
        const lutUv = skyViewLutParamsToUv(params, intersectsGround, viewZenithCosAngle, lightViewCosAngle, viewHeight)
        const lutColor = texture(skyViewTex, lutUv).rgb.mul(luminanceScaleU)

        // Raymarch only when needed: above blendStart. Low-altitude users
        // (the common case) skip the 30-sample integration entirely.
        const rayColor = vec3(0.0, 0.0, 0.0).toVar()
        If(viewHeight.greaterThan(blendStart), () => {
          // Camera position in planet-centred frame; clip the ray origin
          // to the atmosphere boundary, and if the ray misses entirely
          // the result stays at zero.
          const camPos = upVec.mul(viewHeight)
          const moved = moveToTopAtmosphere(camPos, viewDir, params)
          const startPos = moved.newPos.toVar()

          const result = integrateScatteredLuminance({
            worldPos: startPos,
            worldDir: viewDir,
            sunDir: sunDir,
            params: params,
            transmittanceLUT: transmittanceTex,
            multiScatterLUT: multiScatterTex,
            sampleCount: 30,
            ground: true,
            mieRayPhase: true,
          })

          const validF = moved.valid.select(float(1.0), float(0.0))
          rayColor.assign(result.L.mul(luminanceScaleU).mul(validF))
        })

        const blendT = smoothstep(blendStart, blendEnd, viewHeight)
        skyColor.assign(mix(lutColor, rayColor, blendT))
      } else {
        // No fallback wired — pure SkyView LUT path (Phase 1b behaviour).
        const lutUv = skyViewLutParamsToUv(params, intersectsGround, viewZenithCosAngle, lightViewCosAngle, viewHeight)
        skyColor.assign(texture(skyViewTex, lutUv).rgb.mul(luminanceScaleU))
      }

      // Stylized look remap. Applied here — after the LUT/raymarch branches
      // have merged, and before stars/sun/moon are added — so it covers both
      // sky paths and excludes the discs by construction. Identity while no
      // look is assigned. The cube camera renders this same mesh, so the cube
      // background and its PMREM'd IBL inherit the look for free.
      skyColor.assign(
        applyLook({
          color: skyColor,
          viewZenithCosAngle,
          lightViewCosAngle,
          look: lookU,
        }),
      )

      // Camera→space transmittance along this view ray. Shared by the stars
      // fade and the sun-disc tint below. Defaults to white (no attenuation)
      // when the transmittance LUT isn't wired (stand-alone Phase 1b mesh);
      // both consumers degrade gracefully to their pre-tint behaviour in
      // that case.
      const tToSpace = vec3(1.0, 1.0, 1.0).toVar()
      if (transmittanceTex !== null) {
        const tToSpaceUv = transmittanceLutParamsToUv(viewHeight, viewZenithCosAngle, params)
        tToSpace.assign(texture(transmittanceTex, tToSpaceUv).rgb)
      }

      // Stars contribution. Two source paths run in parallel and are
      // lerp-mixed by `starsMode` (0 = procedural shader-only, 1 = HDR
      // texture sample). Both paths are cheap; the runtime mix lets
      // callers swap source without a material rebuild.
      //
      // Whichever source produces the raw colour, we attenuate by
      // camera→space transmittance (so stars fade through twilight
      // without a manual fade curve) and zero out below-horizon rays.
      //
      // Skipped entirely if the transmittance LUT isn't wired (the
      // stand-alone Phase 1b mesh case); without `tToSpace` stars look
      // wrong at dawn/dusk.
      const starsContribution = vec3(0.0, 0.0, 0.0).toVar()
      if (transmittanceTex !== null) {
        // Rotate viewDir around the world Y axis. We use world-Y rather
        // than the `upVec` uniform because the stars ride the world
        // celestial sphere, not the local-up frame (relevant for
        // spherical-planet setups where local-up tilts as the camera
        // orbits the planet).
        const cosR = cos(starsRotationU)
        const sinR = sin(starsRotationU)
        const starsDir = vec3(
          viewDir.x.mul(cosR).add(viewDir.z.mul(sinR)),
          viewDir.y,
          viewDir.x.mul(sinR).negate().add(viewDir.z.mul(cosR)),
        )

        const starsUv = equirectUV(starsDir)
        const proceduralRaw = proceduralStars(starsUv, starsDensityU, starsBrightnessU)
        const textureRaw = starsTexNode.sample(starsUv).rgb
        const starsRaw = mix(proceduralRaw, textureRaw, starsModeU)

        starsContribution.assign(starsRaw.mul(tToSpace).mul(starsIntensityU).mul(skyMask))
      }

      // Sun disc, rendered in-shader (not a separate mesh) so it composites
      // with the same LUT / raymarch sky colour and shares the exact view
      // ray — this is what gives the disc free limb reddening at the
      // horizon "for free" instead of needing a hand-authored gradient.
      // Port of Hillaire's `GetSunLuminance` (RenderSkyCommon.hlsl): if the
      // view ray falls within the sun's angular radius AND doesn't hit the
      // planet, output sun luminance tinted by transmittance-to-space along
      // the view ray.
      //
      // Angular test done entirely in cos-space (no per-pixel acos): the
      // mask ramps from 0 at the outer bound (`sunDiscCos`,
      // cos(halfAngle)) to 1 at the inner bound (`sunDiscCosInner`,
      // cos(halfAngle * (1 - edgeSoftness))) — see `setSunAngularRadius`.
      const cosSun = dot(viewDir, sunDir)
      const sunAngularMask = smoothstep(sunDiscCosU, sunDiscCosInnerU, cosSun)
      // Ground occlusion: the sun must set behind the horizon rather than
      // shine through the planet — reuse the same `intersectsGround` test
      // the sky colour and stars already use (`skyMask` = 1 above horizon).
      const sunDiscMask = sunAngularMask.mul(showSunDiscU).mul(skyMask)

      // Transmittance tint IS the limb-reddening effect: near the horizon
      // the long grazing path through the atmosphere absorbs/scatters blue
      // light far more than red, so `tToSpace` skews red and drops in
      // magnitude — see `sunDiscIntensity`'s doc comment for the exposure
      // math this relies on.
      const sunContribution = tToSpace.mul(sunDiscMask).mul(sunDiscIntensityU)

      // Moon disc — same shape as the sun disc, separate uniforms so the
      // sun stays unaffected. Constantly "full" — no phase-shaded
      // terminator (intentional v1 simplification: the disc is just a
      // circle that tracks the moon direction).
      const moonDir = normalize(moonDirU)
      const cosMoon = dot(viewDir, moonDir)
      const moonDiscMask = smoothstep(moonDiscCosU, moonDiscCosU.add(float(0.00002)), cosMoon).mul(showMoonDiscU)

      const moonContribution = moonColorU.mul(moonDiscMask).mul(moonIntensityU)

      return vec4(skyColor.add(starsContribution).add(sunContribution).add(moonContribution), float(1.0))
    })()
  }
}
