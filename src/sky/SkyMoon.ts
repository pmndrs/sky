import { Box3, Color, DirectionalLight, MathUtils, Object3D, Vector3 } from 'three/webgpu'

import { compassToTheta } from './compass'
import { SkyCelestialDisc } from './SkyCelestialDisc'
import { horizonCosZenith, sunDiscVisibleFraction } from '../core/sunTransmittance'

export interface SkyMoonOptions {
  color?: number
  intensity?: number
  distance?: number
  target?: Object3D | null
  followSun?: boolean
  phase?: number
  /** Artistic phase brightness and crescent mask. Default false for compatibility. */
  phaseLighting?: boolean
  /** Automatically wash the disc into the local sky in daylight/haze. Default true. */
  daylightFade?: boolean
  showDisc?: boolean
  discIntensity?: number
  discAngularDiameter?: number
  discColor?: number | Color | Vector3 | null
  castShadow?: boolean
  shadowMapSize?: number
  shadowBias?: number
  shadowNormalBias?: number
  shadowRadius?: number
  shadowCamera?: any
}

/**
 * Owns a `THREE.DirectionalLight` representing moonlight.
 *
 * Two direction sources:
 *
 *  - `followSun: true` (default) — moon direction is derived from the current
 *    sun by rotating the sun vector around the world up axis by the lunar
 *    `phase` × 2π. Phase 0 = new moon (moon at sun position, dark side facing
 *    earth, no moonlight), 0.5 = full moon (anti-sun, max moonlight), 1 = new.
 *    Subscribes to `sky.baker.addSunListener(...)` so it updates automatically
 *    on every `sky.setSunDirection` call.
 *
 *  - `setDirection({ elevation, azimuth })` — manual control, disables
 *    follow-sun and stays where you put it (turning with `sky.setNorth`).
 *    Use for cinematic shots.
 *
 * The moon does not feed the atmosphere LUTs. `phaseLighting: true` adds a
 * crescent mask, scales light intensity by the squared illuminated fraction
 * (an artistic curve), and uses the camera's local planet horizon.
 *
 * Auto-fade: intensity scales by `smoothstep(-2°, 0°, moonElevation)` so the
 * light cleanly switches off as the moon dips below the horizon. The target
 * intensity (what you set via `intensity = X`) is preserved across fades so
 * the moon comes back to full strength when it rises again.
 *
 * Usage:
 * ```js
 * const moon = sky.createMoon( { intensity: 0.15, phase: 0.5 } );
 * moon.attach( scene );
 * moon.fitShadowToObject( scene );
 * moon.setPhase( 0.75 );  // last quarter
 * ```
 */
export class SkyMoon {
  sky: any
  distance: number
  followSun: boolean
  phase: number
  _mesh: any
  light: DirectionalLight
  readonly disc: SkyCelestialDisc
  target: Object3D
  _targetIntensity: number
  _scene: Object3D | null
  _moonVec: Vector3
  _onSunChanged: (sunVec: Vector3) => void
  _unsubscribe: (() => void) | null
  /** Last `setDirection` input, re-placed when the sky's north changes. */
  _manual: { elevation: number; azimuth: number } | null = null
  _onNorthChanged: () => void
  _phaseLighting: boolean
  _changeListeners = new Set<() => void>()
  _unsubscribeBake: (() => void) | null

  constructor(
    sky: any,
    {
      color = 0xb0c8e0,
      intensity = 0.15,
      distance = 50000,
      target = null,

      followSun = true,
      phase = 0.5,
      phaseLighting = false,
      daylightFade = true,

      // Visible moon mesh outside the cube bake.
      // Default ON because the moon's disc is its main visual feature.
      // Legacy default is full; phaseLighting opts into crescent shading.
      showDisc = true,
      discIntensity = 1.0,
      discAngularDiameter = 0.00935, // ~0.535° matches Earth-Moon
      discColor = null, // null → use mesh default cool-white

      castShadow = false,
      shadowMapSize = 1024,
      shadowBias = -0.0001,
      shadowNormalBias = 0.05,
      shadowRadius = 1.0,
      shadowCamera = null,
    }: SkyMoonOptions = {},
  ) {
    this.sky = sky
    this.distance = distance
    this.followSun = followSun
    this.phase = phase - Math.floor(phase)
    this._phaseLighting = phaseLighting

    this._mesh = sky.baker.sky

    this.light = new DirectionalLight(color, intensity)
    this.disc = new SkyCelestialDisc(sky.baker, 'moon')
    this.light.add(this.disc)
    this._mesh.moonDiscOnSky.value = 0
    this._mesh.moonPhase.value = this.phase
    this._mesh.moonPhaseShading.value = phaseLighting ? 1 : 0
    this._mesh.moonDaylightFade.value = daylightFade ? 1 : 0
    this.light.castShadow = castShadow
    this.light.shadow.mapSize.width = shadowMapSize
    this.light.shadow.mapSize.height = shadowMapSize
    this.light.shadow.bias = shadowBias
    this.light.shadow.normalBias = shadowNormalBias
    this.light.shadow.radius = shadowRadius

    const cam = this.light.shadow.camera
    const sc = shadowCamera || {}
    cam.left = sc.left ?? -50
    cam.right = sc.right ?? 50
    cam.top = sc.top ?? 50
    cam.bottom = sc.bottom ?? -50
    cam.near = sc.near ?? 1
    cam.far = sc.far ?? 200000
    cam.updateProjectionMatrix()

    this.target = target || new Object3D()
    this.light.target = this.target

    // `_targetIntensity` is the user-facing intensity. `light.intensity`
    // is the actual scene value, which gets multiplied by the
    // horizon-fade factor each time we sync.
    this._targetIntensity = intensity
    this._scene = null
    this._moonVec = new Vector3(0.0, 1.0, 0.0)

    // Initial disc state on the sky mesh.
    this._mesh.showMoonDisc.value = showDisc ? 1.0 : 0.0
    this._mesh.moonIntensity.value = discIntensity
    this._mesh.moonDiscCos.value = Math.cos(discAngularDiameter * 0.5)
    if (discColor != null) this.setDiscColor(discColor)

    // Subscribe to sun changes for follow-sun mode. Even when followSun
    // is false we keep the listener attached but ignore the sun vector,
    // so toggling back on picks up immediately on the next setSunDirection.
    this._onSunChanged = (sunVec: Vector3) => this._syncFromSun(sunVec)
    this._unsubscribe = sky.baker.addSunListener(this._onSunChanged)
    this._unsubscribeBake = sky.baker.addBakeListener?.(() => this._applyHorizonFade()) ?? null
    this._onNorthChanged = () => {
      if (!this.followSun && this._manual) this.setDirection(this._manual)
    }
    sky._northListeners?.add(this._onNorthChanged)

    // Prime from the current sun vector so the first attach already has
    // a valid moon direction.
    this._syncFromSun(sky.baker._sunVec)
  }

  get castShadow() {
    return this.light.castShadow
  }

  set castShadow(value) {
    this.light.castShadow = value
  }

  get color() {
    return this.light.color
  }

  get intensity() {
    return this._targetIntensity
  }

  set intensity(value) {
    this._targetIntensity = value
    this._applyHorizonFade()
  }

  setIntensity(value: number) {
    this.intensity = value
    return this
  }

  setDistance(value: number) {
    this.distance = value
    this._placeLight()
    return this
  }

  /**
   * Set the lunar phase. 0 = new moon (moon co-located with sun, no
   * visible moonlight with phaseLighting), 0.5 = full (anti-sun), 1 = new
   * again. Wraps modulo 1. Legacy mode changes only the direction.
   */
  setPhase(phase: number) {
    this.phase = phase - Math.floor(phase)
    this._mesh.moonPhase.value = this.phase
    if (this.followSun) {
      this._syncFromSun(this.sky.baker._sunVec)
    } else {
      this._applyHorizonFade()
      this._notifyChange()
    }
    return this
  }

  /** Squared illuminated fraction: full = 1, quarter = 0.25, new = 0. */
  get phaseBrightness() {
    return this._phaseLighting ? Math.pow((1 - Math.cos(this.phase * Math.PI * 2)) * 0.5, 2) : 1
  }

  /** Fraction visible above the horizon used by the light. */
  get visibility() {
    if (!this._phaseLighting) return _smoothstep(-2, 0, MathUtils.radToDeg(Math.asin(clamp1(this._moonVec.y))))
    const params = this.sky.baker.atmosphereParams
    const height = Math.max(this._mesh.viewHeight.value, params.bottomRadius + 0.01)
    const elevation = Math.asin(clamp1(this._moonVec.dot(this._mesh.upVector.value)))
    const horizon = Math.asin(horizonCosZenith(height, params.bottomRadius))
    return sunDiscVisibleFraction(elevation - horizon, Math.acos(clamp1(this._mesh.moonDiscCos.value)))
  }

  setPhaseLighting(enabled: boolean) {
    this._phaseLighting = enabled
    this._mesh.moonPhaseShading.value = enabled ? 1 : 0
    this._applyHorizonFade()
    this._notifyChange()
    return this
  }

  /** Direction/phase changes, including manual placement and north rotation. */
  addChangeListener(listener: () => void) {
    this._changeListeners.add(listener)
    return () => this._changeListeners.delete(listener)
  }

  _notifyChange() {
    for (const listener of this._changeListeners) listener()
  }

  /**
   * Manual moon direction. Disables `followSun` automatically — the moon
   * stays where you put it until you call `setFollowSun(true)` again.
   *
   * `azimuth` is a compass azimuth, degrees clockwise from the sky's
   * `north` (matches `sky.setSunDirection`).
   */
  setDirection({ elevation, azimuth }: { elevation: number; azimuth: number }) {
    this.followSun = false
    this._manual = { elevation, azimuth }

    // Same frame as the sun: spherical coords, phi from +Y, theta from +Z.
    const phi = MathUtils.degToRad(90 - elevation)
    const theta = MathUtils.degToRad(compassToTheta(azimuth, this.sky.north ?? 0))
    this._moonVec.setFromSphericalCoords(1, phi, theta)
    this._placeLight()
    return this
  }

  setFollowSun(enabled: boolean) {
    this.followSun = enabled
    if (enabled) this._syncFromSun(this.sky.baker._sunVec)
    return this
  }

  attach(scene: Object3D) {
    this._scene = scene
    scene.add(this.light)
    scene.add(this.target)
    return this
  }

  detach() {
    if (this._scene) {
      this._scene.remove(this.light)
      this._scene.remove(this.target)
      this._scene = null
    }

    return this
  }

  /**
   * Tighten the directional light's orthographic shadow frustum to enclose
   * the given world-space Box3. Identical math to `SkySun.fitShadowToBox`.
   */
  fitShadowToBox(box3: Box3) {
    if (box3.isEmpty()) return this

    const cam = this.light.shadow.camera
    this.light.target.updateMatrixWorld()
    this.light.updateMatrixWorld()
    this.light.shadow.updateMatrices(this.light)

    const corners = [
      new Vector3(box3.min.x, box3.min.y, box3.min.z),
      new Vector3(box3.min.x, box3.min.y, box3.max.z),
      new Vector3(box3.min.x, box3.max.y, box3.min.z),
      new Vector3(box3.min.x, box3.max.y, box3.max.z),
      new Vector3(box3.max.x, box3.min.y, box3.min.z),
      new Vector3(box3.max.x, box3.min.y, box3.max.z),
      new Vector3(box3.max.x, box3.max.y, box3.min.z),
      new Vector3(box3.max.x, box3.max.y, box3.max.z),
    ]

    const inv = cam.matrixWorldInverse
    let minX = Infinity,
      maxX = -Infinity
    let minY = Infinity,
      maxY = -Infinity
    let minZ = Infinity,
      maxZ = -Infinity

    for (const c of corners) {
      c.applyMatrix4(inv)
      if (c.x < minX) minX = c.x
      if (c.x > maxX) maxX = c.x
      if (c.y < minY) minY = c.y
      if (c.y > maxY) maxY = c.y
      if (c.z < minZ) minZ = c.z
      if (c.z > maxZ) maxZ = c.z
    }

    cam.left = minX
    cam.right = maxX
    cam.bottom = minY
    cam.top = maxY
    cam.near = Math.max(0.1, -maxZ - 1)
    cam.far = -minZ + 1
    cam.updateProjectionMatrix()
    return this
  }

  fitShadowToObject(object3D: Object3D) {
    const box = new Box3().setFromObject(object3D)
    return this.fitShadowToBox(box)
  }

  dispose() {
    if (this._unsubscribe) {
      this._unsubscribe()
      this._unsubscribe = null
    }
    this.sky._northListeners?.delete(this._onNorthChanged)
    this._unsubscribeBake?.()
    this._unsubscribeBake = null
    this._changeListeners.clear()

    this.detach()
    this.disc.dispose()
    this.light.dispose()
  }

  _syncFromSun(sunVec: Vector3) {
    if (!this.followSun) return

    // Rotate sun around the east-ish axis (sun × world-up), which is the
    // only choice that puts moon at -sunDir for phase 0.5 (full moon =
    // anti-sun in the sky) AND lifts the moon above the horizon at
    // phase ≈ 0.25 when the sun is low. Rodrigues rotation; the axis
    // degenerates only when the sun is at zenith/nadir, in which case we
    // fall back to +X (any horizontal axis is equivalent there).
    const angle = this.phase * Math.PI * 2

    let kx = -sunVec.z
    let ky = 0
    let kz = sunVec.x
    const kLen = Math.sqrt(kx * kx + kz * kz)
    if (kLen < 1e-6) {
      kx = 1
      kz = 0
    } else {
      kx /= kLen
      kz /= kLen
    }

    const c = Math.cos(angle)
    const s = Math.sin(angle)
    const oneMinusC = 1 - c

    // k · v (ky is always 0 so the y term drops)
    const kDotV = kx * sunVec.x + kz * sunVec.z
    // k × v
    const crossX = ky * sunVec.z - kz * sunVec.y
    const crossY = kz * sunVec.x - kx * sunVec.z
    const crossZ = kx * sunVec.y - ky * sunVec.x

    this._moonVec.set(
      sunVec.x * c + crossX * s + kx * kDotV * oneMinusC,
      sunVec.y * c + crossY * s + ky * kDotV * oneMinusC,
      sunVec.z * c + crossZ * s + kz * kDotV * oneMinusC,
    )

    this._placeLight()
  }

  setDiscVisible(visible: boolean) {
    this._mesh.showMoonDisc.value = visible ? 1.0 : 0.0
    return this
  }

  /** Artistic contrast adaptation against the local graded sky, without a time cutoff. */
  setDaylightFade(enabled: boolean) {
    this._mesh.moonDaylightFade.value = enabled ? 1 : 0
    return this
  }

  setDiscIntensity(value: number) {
    this._mesh.moonIntensity.value = value
    return this
  }

  setDiscAngularDiameter(radians: number) {
    this._mesh.moonDiscCos.value = Math.cos(radians * 0.5)
    return this
  }

  setDiscColor(color: number | Color | Vector3) {
    // Accept Color, Vector3, or hex number — normalise to vec3 components.
    if (typeof color === 'number') {
      const r = ((color >> 16) & 0xff) / 255
      const g = ((color >> 8) & 0xff) / 255
      const b = (color & 0xff) / 255
      this._mesh.moonColor.value.set(r, g, b)
    } else if ((color as Color).isColor) {
      // `Vector3.copy` reads x/y/z; a Color carries r/g/b and would copy NaN.
      const c = color as Color
      this._mesh.moonColor.value.set(c.r, c.g, c.b)
    } else {
      this._mesh.moonColor.value.copy(color as Vector3)
    }

    return this
  }

  _placeLight() {
    this.light.position.copy(this._moonVec).multiplyScalar(this.distance)
    this.light.target.updateMatrixWorld()
    this._applyHorizonFade()

    // Push the moon direction into the sky mesh so the disc tracks too.
    this._mesh.moonDirection.value.copy(this._moonVec)
    this._notifyChange()
  }

  _applyHorizonFade() {
    // Legacy mode keeps its 2° ramp. Phase lighting follows the visible
    // disc across the camera's local planet horizon instead.
    this.light.intensity = this._targetIntensity * this.visibility * this.phaseBrightness
  }
}

function clamp1(value: number) {
  return Math.max(-1, Math.min(1, value))
}

function _smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}
