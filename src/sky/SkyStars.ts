/**
 * Resolved stars as point-spread-function sprites in the MAIN scene.
 *
 * Stars are deliberately not part of the cube bake: at 256² a star smears into
 * a multi-pixel blob. Instead each star is an instanced quad (WebGPU
 * `point-list` is 1 px only, so sized points are always quads) drawing an
 * energy-normalised Gaussian PSF:
 *
 *   pixel = tint · S · exp(−r² / 2σ²) / (2πσ²)        (r, σ in device px)
 *
 * The summed light of a star is S wherever it lands on the pixel grid, so
 * sub-pixel motion doesn't shimmer and faint stars are faint rather than
 * small. Brightness follows magnitude (S ∝ 10^(−0.4·m)); only stars whose
 * core would clip grow σ, the way bright stars look bigger in photographs.
 *
 * Atmosphere coupling is per STAR, in the vertex stage (the fragment shader
 * is only the Gaussian):
 *  - transmittance to space from the Transmittance LUT — extinction and
 *    reddening toward the horizon, the same source as the sun disc;
 *  - planet occlusion by ray/sphere test — the sky mesh's `skyMask`;
 *  - twilight fade by contrast against the SkyView LUT luminance behind the
 *    star, ramped over ±2 stops, so bright stars emerge first and the dark
 *    side of the sky fills in before the twilight side;
 *  - scintillation that grows toward the horizon.
 * Stars with nothing visible collapse their quad to zero size, so daytime
 * costs close to nothing. Measured cost at night: ~0.01 ms/frame at 1080p for
 * 9k stars on an M5 Pro, ~0.05 ms for 50k.
 *
 * Normally owned by `SkyNight` (`sky.enableStars()`), which keeps the
 * orientation in step with the sky's time and location.
 */
import {
  AdditiveBlending,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  PlaneGeometry,
  SpriteNodeMaterial,
} from 'three/webgpu'
import {
  Fn,
  cameraProjectionMatrix,
  clamp,
  dot,
  exp,
  float,
  instancedBufferAttribute,
  log2,
  luminance,
  max,
  mix,
  modelWorldMatrix,
  normalize,
  pow,
  screenSize,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl'

import {
  computeLightViewCosAngle,
  raySphereIntersectNearest,
  skyViewLutParamsToUv,
  transmittanceLutParamsToUv,
} from '../backends/tsl/atmosphere.tsl'
import { generateStarCatalog } from './stars/catalog'

import type { StarCatalog } from './stars/catalog'

export interface SkyStarsOptions {
  /** Procedural stars on top of the named bright stars. Default 9000 ≈ naked eye. */
  count?: number
  seed?: number
  /** Provide your own catalog instead (e.g. from a real star list). */
  catalog?: StarCatalog
  /** Brightness multiplier. Default 1. */
  intensity?: number
  /** PSF σ in CSS pixels. Default 0.7 (≈1.6 px FWHM). */
  size?: number
  /** Exponent on flux: 1 = physical magnitude ratios, < 1 compresses the range. Default 0.75. */
  magnitudeContrast?: number
  /**
   * Star peak : sky luminance ratio at the midpoint of the twilight fade.
   * Raise to hold stars back until later in twilight. Default 40.
   */
  contrast?: number
  /** Scintillation depth 0..1. Default 0.25. */
  twinkle?: number
}

// Linear energy of a magnitude-0 star at intensity 1 (tuned for exposure 40).
const ENERGY_SCALE = 10

export class SkyStars extends Group {
  readonly uniforms: {
    intensity: any
    size: any
    magnitudeContrast: any
    contrast: any
    twinkle: any
    time: any
    radius: any
    pixelRatio: any
  }
  readonly mesh: Mesh
  readonly count: number
  /** Equatorial → world rotation; see `celestialOrientation`. */
  readonly orientation = new Matrix4()

  constructor(
    baker: any,
    {
      count = 9000,
      seed,
      catalog,
      intensity = 1,
      size = 0.7,
      magnitudeContrast = 0.75,
      contrast = 40,
      twinkle = 0.25,
    }: SkyStarsOptions = {},
  ) {
    super()
    this.name = 'SkyStars'
    this.matrixAutoUpdate = false
    const u = (this.uniforms = {
      intensity: uniform(intensity),
      size: uniform(size),
      magnitudeContrast: uniform(magnitudeContrast),
      contrast: uniform(contrast),
      twinkle: uniform(twinkle),
      time: uniform(0),
      radius: uniform(1000),
      pixelRatio: uniform(1),
    })

    // --- catalog → instance buffers ---
    const stars = catalog ?? generateStarCatalog({ count, seed })
    this.count = stars.count
    // flux, tone, twinkle phase, twinkle speed
    const traits = new Float32Array(stars.count * 4)
    let s = 0x9e3779b9
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
    for (let i = 0; i < stars.count; i++) {
      traits[i * 4] = Math.pow(10, -0.4 * stars.magnitudes[i])
      traits[i * 4 + 1] = stars.tones[i]
      traits[i * 4 + 2] = rnd() * Math.PI * 2
      traits[i * 4 + 3] = 1.5 + rnd() * 2.5
    }
    const quad = new PlaneGeometry(1, 1)
    const geometry = new InstancedBufferGeometry()
    geometry.index = quad.index
    geometry.setAttribute('position', quad.attributes.position)
    geometry.setAttribute('uv', quad.attributes.uv)
    geometry.instanceCount = stars.count
    quad.dispose()
    const dirAttr = new InstancedBufferAttribute(stars.directions, 3)
    const traitAttr = new InstancedBufferAttribute(traits, 4)
    geometry.setAttribute('aStarDir', dirAttr)
    geometry.setAttribute('aStarTrait', traitAttr)

    // --- per-star (vertex-stage) terms ---
    const params = baker.atmosphereUniforms
    const sky = baker.sky
    const dirEq = instancedBufferAttribute(dirAttr) as any
    const trait = instancedBufferAttribute(traitAttr) as any
    const flux = trait.x
    const phase = trait.z
    const speed = trait.w

    // vec4(energy.rgb, σ in device px)
    const perStar = Fn(() => {
      const dir = normalize(modelWorldMatrix.mul(vec4(dirEq, 0)).xyz)
      const up = normalize(sky.upVector)
      const viewHeight = max(sky.viewHeight, params.bottomRadius.add(0.01))
      const cz = clamp(dot(dir, up), -1, 1)

      const hitsGround = raySphereIntersectNearest(
        up.mul(viewHeight),
        dir,
        vec3(0),
        params.bottomRadius,
      ).greaterThanEqual(0)
      const open = hitsGround.select(float(0), float(1))

      const T = texture(baker.transmittanceLUT.texture, transmittanceLutParamsToUv(viewHeight, cz, params)).level(0).rgb
      const lightViewCos = computeLightViewCosAngle(dir, up, normalize(sky.sunDirection))
      const skyUv = skyViewLutParamsToUv(params, hitsGround, cz, lightViewCos, viewHeight)
      const skyL = luminance(texture(baker.skyViewLUT.texture, skyUv).level(0).rgb.mul(sky.luminanceScale))

      const S = pow(flux, u.magnitudeContrast).mul(u.intensity).mul(ENERGY_SCALE)
      const sigmaPx = u.size.mul(u.pixelRatio)
      const peak = S.mul(luminance(T)).div(sigmaPx.mul(sigmaPx).mul(2 * Math.PI))

      // Local contrast fade: stops of headroom over the sky behind the star.
      const ratio = peak.div(u.contrast.mul(skyL).add(1e-12))
      const visible = smoothstep(-2, 2, log2(max(ratio, 1e-12)))

      // Scintillation: stronger with more air in the way.
      const air = pow(float(1).sub(max(cz, 0)), 2)
      const t = u.time.mul(speed)
      const shimmer = sin(t.add(phase)).mul(sin(t.mul(0.61).add(phase.mul(1.7))))
      const scint = float(1).add(shimmer.mul(u.twinkle).mul(mix(0.3, 1, air)))

      const energy = T.mul(S).mul(open).mul(visible).mul(scint)
      // Bloom only stars whose core would clip: σ grows as peak^¼ (capped).
      const sigmaEff = sigmaPx.mul(clamp(pow(max(peak, 1), 0.25), 1, 4))
      return vec4(energy, sigmaEff)
    })()

    const star = varying(perStar, 'vSkyStar')
    const sigma = star.w

    const material = new SpriteNodeMaterial()
    material.positionNode = dirEq.mul(u.radius)
    material.sizeAttenuation = false
    // Quad covers ±3σ (in device px). Invisible stars collapse to zero size.
    const pxToScale = float(2).div((cameraProjectionMatrix as any)[1].y.mul(screenSize.y))
    const alive = max(perStar.x, max(perStar.y, perStar.z)).greaterThan(1e-4)
    material.scaleNode = alive.select(perStar.w.mul(6).mul(pxToScale), float(0))

    const d = uv().sub(0.5).mul(sigma.mul(6))
    const s2 = sigma.mul(sigma)
    const psf = exp(dot(d, d).negate().div(s2.mul(2))).div(s2.mul(2 * Math.PI))
    const tint = mix(vec3(1.0, 0.8, 0.6), vec3(0.78, 0.86, 1.0), varying(trait.y, 'vSkyStarTone'))
    material.colorNode = vec4(tint.mul(star.xyz).mul(psf), 1)
    material.transparent = true
    material.blending = AdditiveBlending
    material.depthTest = true
    material.depthWrite = false
    material.fog = false

    this.mesh = new Mesh(geometry, material)
    this.mesh.name = 'SkyStars.sprites'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -1
    this.add(this.mesh)
  }

  /**
   * Per frame: follow the camera (no parallax), keep the dome inside the far
   * plane so terrain still occludes it through the depth test, and advance
   * the twinkle clock.
   */
  update(camera: any, pixelRatio = 1, timeSeconds = performance.now() / 1000) {
    this.matrix.copy(this.orientation).setPosition(camera.position)
    this.matrixWorldNeedsUpdate = true
    this.uniforms.radius.value = (camera.far ?? 2000) * 0.5
    this.uniforms.pixelRatio.value = pixelRatio
    this.uniforms.time.value = timeSeconds
    return this
  }

  dispose() {
    this.removeFromParent()
    this.mesh.geometry.dispose()
    ;(this.mesh.material as SpriteNodeMaterial).dispose()
  }
}
