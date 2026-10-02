import { Box3, Color, DirectionalLight, Object3D, Vector3 } from 'three/webgpu'

import { horizonCosZenith, sunDiscVisibleFraction, transmittanceToSun } from '../core/sunTransmittance'

interface SkySunOptions {
  color?: number
  /**
   * Requested daytime intensity, default 4. With `physical: true` it is a
   * multiplier on the sky-derived illuminance instead, default 1.
   */
  intensity?: number
  /** Fade the light out as the sun's disc sets below the horizon. Default `true`. */
  horizonFade?: boolean
  /** Derive the light's intensity and tint from the sky (`luminanceScale × T(sun)`). Default `false`. */
  physical?: boolean
  distance?: number
  target?: Object3D | null
  castShadow?: boolean
  shadowMapSize?: number
  shadowBias?: number
  shadowNormalBias?: number
  shadowRadius?: number
  shadowCamera?: any
}

/**
 * Owns a `THREE.DirectionalLight` whose direction tracks the sky's sun vector.
 *
 * Subscribes to `sky.baker.addSunListener(...)` so any call to
 * `sky.setSunDirection(...)` or `sky.baker.setSun(...)` (e.g. from a GUI)
 * updates the light position automatically — no per-frame plumbing required
 * on the consumer side.
 *
 * Shadow params live on `this.light` for direct mutation. Intensity and colour
 * do not: `sun.intensity` is the requested daytime intensity and
 * `sun.light.intensity` is what the scene gets after the horizon fade (and, in
 * physical mode, the sky-derived illuminance). The light's colour is
 * `baseColor × the sky's sun colour` (× the transmittance tint in physical
 * mode). Both are re-synced on every sun move (`setTimeOfDay`,
 * `setSunDirection`, latitude, date, north), sun-colour change and intensity
 * edit, so a value written straight to `sun.light.intensity` or
 * `sun.light.color` lasts only until the next one. Use `sun.intensity` /
 * `setIntensity` and `setColor`.
 *
 * **Horizon fade** (`horizonFade`, default on). The light scales with the
 * fraction of the sun's disc above the horizon: full while the whole disc is
 * up, half with its centre on the horizon, off once the last of it has set.
 * The band is the disc itself (one angular diameter, ~0.53° by default, read
 * from the sky's disc size), so the light goes out exactly when the visible
 * sun does, and the curve has zero slope at both ends, like a smoothstep.
 * Wider bands either light the scene with no sun in the sky (`SkyMoon`'s
 * −2°..0°) or dim a sun that is still fully up (0°..1°); dimming a low sun is
 * the atmosphere's job, which `physical: true` does. The horizon is the
 * flat-world one, elevation 0 against world +Y, as for `SkyMoon`; in planet
 * mode (`sky.update(camera, { planetCenter })`) it does not follow the camera
 * around the sphere (physical mode does, see below). Pass
 * `horizonFade: false` (or `setHorizonFade(false)`) for deliberate
 * below-horizon lighting.
 *
 * **Physical mode** (`physical: true`, opt-in). The light's illuminance and
 * tint come from the sky: `intensity × luminanceScale × T(sun)`, times the
 * sky's sun colour. `T(sun)` is the transmittance from the top of the
 * atmosphere down to the camera's altitude along the sun direction (measured
 * against the camera's local up, so it is right in planet mode too). A CPU
 * twin of the Transmittance LUT evaluates it, so the light reddens and dims
 * toward the horizon exactly like the sun disc. `intensity` becomes a
 * multiplier (default 1). `light.intensity` takes the brightest channel and
 * `light.color` is normalised to it, so the colour stays displayable.
 *
 * Why the factor is exactly `luminanceScale`: the LUTs store sky radiance for
 * a sun of illuminance 1 at the top of the atmosphere (Hillaire's
 * `ILLUMINANCE_IS_ONE`), and the sky multiplies them by `luminanceScale`. In
 * the units the sky is drawn in, the sun's illuminance is therefore
 * `luminanceScale` above the atmosphere and `luminanceScale × T(sun)` at the
 * camera. three's `DirectionalLight.intensity` is that same quantity (a
 * Lambertian surface of albedo ρ facing the light returns radiance `ρE/π`), so
 * no other constant enters. At the defaults (exposure 40, Earth, noon at
 * 37.7° N in late June: 75.7° elevation) `T(sun)` is (0.947, 0.880, 0.787),
 * luminance 0.887, so the illuminance is 35.5 against the constant mode's
 * default 4: lit surfaces ~9× brighter relative to the sky. Rendered
 * (`examples/vanilla/scripts/verify-sun-light.mjs`), a white horizontal
 * Lambertian plane reads 10.95 from the sun (`35.5 · sin 75.7° / π`, exact)
 * and ~11.9 with the sky's IBL, against 0.75 for the zenith sky and 0.89 at
 * 30° up: 13–16×, within the range of clear-sky daylight, where the constant
 * 4 gives under 2×. Expect to lower `toneMappingExposure` when switching an
 * existing scene over.
 *
 * Physical mode follows the sun immediately, and the exposure
 * (`sky.setExposure`), the atmosphere and the camera altitude on the next
 * `sky.update()`: all of them re-bake the sky, and `baker.addBakeListener`
 * reports that, so frames where nothing changed cost nothing. The horizon fade
 * composes without a double ramp: the transmittance already dims a low sun,
 * and the fade only covers the disc sinking behind the horizon — the
 * flat-world horizon with `horizonFade` on, the planet's true horizon from the
 * camera's altitude with it off.
 *
 * The sun *disc* visibility lives on the sky mesh and stays orthogonal — call
 * `sky.setSunDisc(true)` separately if you want the visible disc as well.
 *
 * Usage:
 * ```js
 * const sun = sky.createSun({ intensity: 4, castShadow: true });
 * sun.attach(scene);
 * sun.fitShadowToObject(scene);  // tighten shadow frustum
 * sun.setColor(0xfff0c0);  // multiplied by the sky's sun colour
 *
 * // Or let the sky set the sunlight's brightness and colour:
 * const physicalSun = sky.createSun({ physical: true });
 * ```
 */
export class SkySun {
  sky: any
  distance: number
  light: DirectionalLight
  baseColor: Color
  target: Object3D
  /** Requested intensity (`sun.intensity`); `light.intensity` is the effective value. */
  _targetIntensity: number
  _horizonFade: boolean
  _physical: boolean
  _scene: Object3D | null
  _onSunChanged: (sunVec: Vector3) => void
  _unsubscribe: (() => void) | null
  _onSunColorChanged: () => void
  _unsubscribeColor: (() => void) | null
  _onBake: () => void
  _unsubscribeBake: (() => void) | null
  /** Scratch transmittance, so a sync allocates nothing. */
  _transmittance: [number, number, number]

  constructor(
    sky: any,
    {
      color = 0xffffff,
      physical = false,
      intensity = physical ? 1.0 : 4.0,
      horizonFade = true,
      distance = 50000,
      target = null,

      castShadow = true,
      shadowMapSize = 2048,
      shadowBias = -0.0001,
      shadowNormalBias = 0.05,
      shadowRadius = 1.0,
      shadowCamera = null,
    }: SkySunOptions = {},
  ) {
    this.sky = sky
    this.distance = distance

    this.baseColor = new Color(color)
    this._targetIntensity = intensity
    this._horizonFade = horizonFade
    this._physical = physical
    this._transmittance = [1, 1, 1]
    this.light = new DirectionalLight(color, intensity)
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

    this._scene = null
    this._onSunChanged = (sunVec: Vector3) => this._syncFromSunVec(sunVec)
    this._unsubscribe = sky.baker.addSunListener(this._onSunChanged)

    this._onSunColorChanged = () => this._syncLight()
    this._unsubscribeColor = sky.baker.addSunColorListener?.(this._onSunColorChanged) ?? null

    // Exposure, atmosphere and camera-altitude changes all re-bake the sky;
    // only physical mode reads them.
    this._onBake = () => {
      if (this._physical) this._syncLight()
    }
    this._unsubscribeBake = sky.baker.addBakeListener?.(this._onBake) ?? null

    // Prime position, intensity and colour from the baker's current sun, so
    // the first attach is already right (and dark if the sun is down).
    this._syncFromSunVec(sky.baker._sunVec)
  }

  get castShadow() {
    return this.light.castShadow
  }

  set castShadow(value) {
    this.light.castShadow = value
  }

  /**
   * Requested daytime intensity (in physical mode, a multiplier on the
   * sky-derived illuminance). Kept while the horizon fade dims the light, so
   * the sun comes back at this strength when it rises; `light.intensity` is
   * the effective value.
   */
  get intensity() {
    return this._targetIntensity
  }

  set intensity(value) {
    this._targetIntensity = value
    this._syncLight()
  }

  setIntensity(value: number) {
    this.intensity = value
    return this
  }

  /** Whether the light fades out as the sun's disc sets. */
  get horizonFade() {
    return this._horizonFade
  }

  set horizonFade(enabled) {
    this._horizonFade = enabled
    this._syncLight()
  }

  /** `false` keeps the light on below the horizon, for deliberate cinematic lighting. */
  setHorizonFade(enabled: boolean) {
    this.horizonFade = enabled
    return this
  }

  /** Whether intensity and tint come from the sky (`luminanceScale × T(sun)`). */
  get physical() {
    return this._physical
  }

  set physical(enabled) {
    this._physical = enabled
    this._syncLight()
  }

  /**
   * Switch physical mode. `intensity` keeps its value and changes meaning
   * (requested intensity ↔ multiplier), so set it as well when toggling.
   */
  setPhysical(enabled: boolean) {
    this.physical = enabled
    return this
  }

  /** Base light colour, multiplied by the sky's sun colour. */
  setColor(color: Color | string | number) {
    this.baseColor.set(color)
    this._syncLight()
    return this
  }

  setDistance(value: number) {
    this.distance = value
    this._syncFromSunVec(this.sky.baker._sunVec)
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
   * the given world-space Box3. The light's `target` (or origin if no target
   * was customised) is used as the centre of the shadow's local frame.
   */
  fitShadowToBox(box3: Box3) {
    if (box3.isEmpty()) return this

    const cam = this.light.shadow.camera
    this.light.target.updateMatrixWorld()
    this.light.updateMatrixWorld()
    // The shadow camera is not parented to the light: three only places it
    // (position + lookAt the target) inside `updateMatrices`, at shadow render
    // time. Without this call the first fit — and any fit after the sun moved —
    // measures the box in a stale light frame and the frustum misses the scene.
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
    // Camera looks down -Z, so near = -maxZ, far = -minZ (with a small pad).
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

    if (this._unsubscribeColor) {
      this._unsubscribeColor()
      this._unsubscribeColor = null
    }

    if (this._unsubscribeBake) {
      this._unsubscribeBake()
      this._unsubscribeBake = null
    }

    this.detach()
    this.light.dispose()
  }

  _syncFromSunVec(sunVec: Vector3) {
    // Place the directional light along the sun ray so its forward vector
    // (light.position → light.target.position) matches the sun direction.
    this.light.position.copy(sunVec).multiplyScalar(this.distance)
    this.light.target.updateMatrixWorld()
    this._syncLight()
  }

  /** Recompute `light.intensity` and `light.color` from the sun, the sky and the requested values. */
  _syncLight() {
    const baker = this.sky.baker
    const sunVec: Vector3 = baker._sunVec
    const discRadius = this._discAngularRadius()

    // Flat-world horizon: elevation against world +Y.
    const flatFade = this._horizonFade ? sunDiscVisibleFraction(Math.asin(clamp1(sunVec.y)), discRadius) : 1

    let fade = flatFade
    let scale = 1
    let r = 1
    let g = 1
    let b = 1

    if (this._physical) {
      const params = baker.atmosphereParams
      const up: Vector3 | undefined = baker.cameraUp
      const elevation = Math.asin(clamp1(up ? sunVec.dot(up) : sunVec.y))
      const altitudeKm = Math.max(0, (baker.cameraAltitudeM ?? 0) * 0.001)

      // The planet's true horizon from this altitude: it dips below 0 as the
      // camera climbs. While the disc is setting behind it, light the scene
      // along the grazing ray, which is the part of the disc still visible.
      const radius = Math.min(params.bottomRadius + altitudeKm, params.topRadius)
      const horizon = Math.asin(horizonCosZenith(radius, params.bottomRadius))
      const planetFade = sunDiscVisibleFraction(elevation - horizon, discRadius)
      fade = this._horizonFade ? Math.min(flatFade, planetFade) : planetFade

      const T = this._transmittance
      if (fade > 0) transmittanceToSun(altitudeKm, Math.sin(Math.max(elevation, horizon + 1e-4)), params, T)
      else T[0] = T[1] = T[2] = 0
      const peak = Math.max(T[0], T[1], T[2])
      if (peak > 0) {
        r = T[0] / peak
        g = T[1] / peak
        b = T[2] / peak
      }
      scale = (baker.sky?.luminanceScale?.value ?? 1) * peak
    }

    this.light.intensity = this._targetIntensity * scale * fade

    const sunColor: Vector3 | undefined = baker.sky?.sunColor?.value
    this.light.color.setRGB(
      this.baseColor.r * r * (sunColor ? sunColor.x : 1),
      this.baseColor.g * g * (sunColor ? sunColor.y : 1),
      this.baseColor.b * b * (sunColor ? sunColor.z : 1),
    )
  }

  /** Angular radius of the sky's visible sun disc, radians. */
  _discAngularRadius(): number {
    const discCos = this.sky.baker.sky?.sunDiscCos?.value
    if (typeof discCos === 'number') return Math.acos(clamp1(discCos))
    return this.sky.baker.atmosphereParams?.sunAngularRadius ?? 0.004675
  }
}

function clamp1(x: number) {
  return Math.min(Math.max(x, -1), 1)
}
