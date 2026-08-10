import { Vector3 } from 'three/webgpu'

import { SkyAtmosphereBaker } from './sky/SkyAtmosphereBaker'
import { GroundedSkybox } from './sky/GroundedSkybox'
import { SkyGround } from './sky/SkyGround'
import { SkyMoon } from './sky/SkyMoon'
import { SkyNight } from './sky/SkyNight'
import { SkySun } from './sky/SkySun'
import { mergeAtmosphereParams } from './core/AtmosphereParams'
import { LUT_RESOLUTIONS } from './core/resolutions'
import { presets, resolvePreset } from './presets'
import { applyHaze, policyToHazeMode } from './applyHaze'
import { solarPosition } from './solarPosition'

interface SkyOptions {
  preset?: string
  quality?: string
  cubeSize?: number
  atmosphere?: any
  exposure?: number
  north?: string
  sunDisc?: boolean | { visible?: boolean; angularDiameter?: number; edgeSoftness?: number }
  timeOfDay?: number
  latitude?: number
  dayOfYear?: number
  sunDirection?: any
  turbidity?: number
  groundAlbedo?: any
  enableAerialPerspective?: boolean
  apKmPerSlice?: number
  mirrorBelowHorizon?: boolean
}

const QUALITY_PRESETS: Record<string, any> = {
  low: {
    transmittance: { width: 128, height: 32 },
    multiScatter: { width: 16, height: 16 },
    skyView: { width: 96, height: 54 },
  },
  medium: LUT_RESOLUTIONS,
  high: {
    transmittance: { width: 512, height: 128 },
    multiScatter: { width: 64, height: 64 },
    skyView: { width: 256, height: 144 },
  },
}

/**
 * North axis aliases. Each entry is the world-space direction the user wants
 * to be treated as "geographic north" — solar azimuth (CW-from-N) is rotated
 * onto that axis when computing the sun direction.
 */
const NORTH_AXES: Record<string, { vector: Vector3; offsetDeg: number }> = {
  '+X': { vector: new Vector3(1, 0, 0), offsetDeg: 90 },
  '-X': { vector: new Vector3(-1, 0, 0), offsetDeg: -90 },
  '+Z': { vector: new Vector3(0, 0, 1), offsetDeg: 0 },
  // Three.js default. North = +Z means azimuth=0 (N) maps onto +Z; baker's
  // `setSun(azimuth)` treats theta=0 as +Z (sphericalCoords convention).
  '-Z': { vector: new Vector3(0, 0, -1), offsetDeg: 180 },
}

/**
 * High-level wrapper around `SkyAtmosphereBaker`. Targets the 90% case:
 * pick a preset, set time-of-day + latitude, attach to a scene, call
 * `update(camera)` per frame.
 *
 * Power users still have access to `sky.baker` and can use `applyHaze` for
 * custom post-process chains.
 */
export class Sky {
  baker: any
  _renderer: any
  _scene: any
  _timeOfDay: number
  _latitude: number
  _dayOfYear: number
  _turbidity: number
  _northKey: string
  _elevation!: number
  _azimuth!: number
  _cameraFar?: any
  _hazeStrength?: any
  _hazePolicy?: any
  _hazeRaymarchOnly?: any
  _hazeAltStart?: any
  _hazeAltEnd?: any
  /** Set by `applyHaze` — signals that the AP LUT has a consumer and needs
   *  its per-frame `updateAerialPerspective()` refresh. */
  _hazeApplied?: boolean
  _night?: any

  constructor(
    renderer: any,
    {
      preset = 'earth',
      quality = 'medium',
      cubeSize = 256,
      atmosphere,
      exposure = 40,
      north = '+Z',
      sunDisc = true,
      // Solar-position inputs; pass `sunDirection` to bypass.
      timeOfDay = 12,
      latitude = 37.7,
      dayOfYear = 172,
      sunDirection,
      // Optional top-level scalar shortcuts merged onto the preset.
      turbidity,
      groundAlbedo,
      enableAerialPerspective = true,
      apKmPerSlice = 8.0,
      // Fold below-horizon cube-bake rays to above-horizon so the env's
      // lower hemisphere is a Y-mirror of the sky instead of lit ground
      // colour. Useful when the consumer scene has reflective floors and
      // you want a clean sky HDRI for IBL. See `SkyAtmosphereBaker`'s
      // constructor JSDoc.
      mirrorBelowHorizon = false,
    }: SkyOptions = {},
  ) {
    const baseAtmosphere = resolvePreset(preset)
    let merged = atmosphere ? mergeAtmosphereParams(baseAtmosphere, atmosphere) : baseAtmosphere
    merged = applyShortcutScalars(merged, { turbidity, groundAlbedo })

    const lutResolutions = QUALITY_PRESETS[quality] || QUALITY_PRESETS.medium

    this.baker = new SkyAtmosphereBaker(renderer, {
      cubeSize,
      atmosphere: merged,
      lutResolutions,
      enableAerialPerspective,
      apKmPerSlice,
      mirrorBelowHorizon,
    })

    this._renderer = renderer
    this._scene = null
    this._timeOfDay = timeOfDay
    this._latitude = latitude
    this._dayOfYear = dayOfYear
    this._turbidity = turbidity ?? 1.0
    this._northKey = NORTH_AXES[north] ? north : '+Z'

    this.setExposure(exposure)
    this.setSunDisc(sunDisc)

    if (sunDirection) {
      this.setSunDirection(sunDirection)
    } else {
      this._refreshSunFromTime()
    }
  }

  get texture() {
    return this.baker.texture
  }

  get environmentTexture() {
    return this.baker.environmentTexture
  }

  get aerialPerspectiveTexture() {
    return this.baker.aerialPerspectiveTexture
  }

  get mesh() {
    return this.baker.sky
  }

  get sunElevation() {
    return this._elevation
  }

  get sunAzimuth() {
    return this._azimuth
  }

  attach(scene: any) {
    this._scene = scene
    scene.environment = this.baker.environmentTexture
    scene.background = this.baker.texture
    return this
  }

  detach() {
    if (this._scene) {
      if (this._scene.environment === this.baker.environmentTexture) this._scene.environment = null
      if (this._scene.background === this.baker.texture) this._scene.background = null
      this._scene = null
    }

    return this
  }

  setTimeOfDay(hours: number) {
    this._timeOfDay = hours
    this._refreshSunFromTime()
    return this
  }

  setLatitude(latitude: number) {
    this._latitude = latitude
    this._refreshSunFromTime()
    return this
  }

  setDayOfYear(day: number) {
    this._dayOfYear = day
    this._refreshSunFromTime()
    return this
  }

  /**
   * Direct sun control. Bypasses solar-position math; useful for cinematic
   * lighting or alien-planet tuning where civil time is meaningless.
   *
   * `azimuth` is degrees CW from the configured `north` axis. Pass
   * `{ elevation, azimuth, raw: true }` to skip the north-rotation and
   * feed the baker raw spherical-coord theta directly.
   */
  setSunDirection({ elevation, azimuth, raw = false }: { elevation: number; azimuth: number; raw?: boolean }) {
    this._elevation = elevation
    this._azimuth = azimuth
    const theta = raw ? azimuth : azimuth + (NORTH_AXES[this._northKey]?.offsetDeg ?? 0)
    this.baker.setSun({ elevation, azimuth: theta })
    return this
  }

  setNorth(axis: string) {
    if (NORTH_AXES[axis]) {
      this._northKey = axis
      // Re-emit the current azimuth through the new offset.
      this.setSunDirection({ elevation: this._elevation, azimuth: this._azimuth })
    }

    return this
  }

  setExposure(value: number) {
    this.baker.sky.luminanceScale.value = value
    return this
  }

  /**
   * `visible` may be a boolean OR an object
   * `{ visible?, angularDiameter?, edgeSoftness? }`. `angularDiameter` is in
   * radians; default ~0.00935 rad (~0.535°). `edgeSoftness` is the fraction
   * of the disc's angular *radius* the rim ramps over (default 0.1 = 10%);
   * see `SkyAtmosphereMesh.setSunAngularRadius`. The disc itself renders
   * in-shader on the sky mesh, tinted by transmittance-to-space, so it
   * reddens and dims naturally near the horizon and disappears once the
   * view ray intersects the planet — there is no separate sun sprite/mesh
   * to manage.
   */
  setSunDisc(visible: boolean | { visible?: boolean; angularDiameter?: number; edgeSoftness?: number }) {
    if (typeof visible === 'object' && visible !== null) {
      if (typeof visible.angularDiameter === 'number') {
        this.baker.sky.setSunAngularRadius(visible.angularDiameter * 0.5, visible.edgeSoftness)
      }

      if (typeof visible.visible === 'boolean') {
        this.baker.sky.showSunDisc.value = visible.visible ? 1.0 : 0.0
      }
    } else {
      this.baker.sky.showSunDisc.value = visible ? 1.0 : 0.0
    }

    return this
  }

  /**
   * Convenience scalar 0..1+ — multiplies Mie scattering/extinction. 1.0 is
   * Earth-default; >1 makes the air look hazier; 0 turns Mie off entirely.
   */
  setTurbidity(value: number) {
    const factor = value / Math.max(this._turbidity, 1e-6)
    this._turbidity = value
    const params = this.baker.atmosphereParams
    this.baker.setAtmosphereParams({
      mieScattering: params.mieScattering.clone().multiplyScalar(factor),
      mieExtinction: params.mieExtinction.clone().multiplyScalar(factor),
      mieAbsorption: params.mieAbsorption.clone().multiplyScalar(factor),
    })
    return this
  }

  setGroundAlbedo(value: any) {
    const v =
      value instanceof Vector3
        ? value
        : typeof value === 'number'
          ? new Vector3(value, value, value)
          : new Vector3(value.x ?? 0.3, value.y ?? 0.3, value.z ?? 0.3)
    this.baker.setAtmosphereParams({ groundAlbedo: v })
    return this
  }

  setAtmosphere(partial: any) {
    this.baker.setAtmosphereParams(partial)
    return this
  }

  /**
   * Toggle Y-mirror of the sky on the cube's lower hemisphere (a clean
   * sky HDRI for IBL with no ground tint). Forces a cube re-bake on the
   * next `update()`.
   */
  setMirrorBelowHorizon(flag: boolean) {
    this.baker.setMirrorBelowHorizon(flag)
    return this
  }

  setPreset(name: string) {
    this.baker.setAtmosphereParams(resolvePreset(name))
    return this
  }

  /**
   * Per-frame entry point.
   *
   * @param {THREE.Camera} camera          active main camera
   * @param {object} [opts]
   * @param {THREE.Vector3} [opts.planetCenter]  for spherical-planet demos:
   *   distance to this point gives true altitude. When omitted the legacy
   *   flat-ground convention (`y` == altitude) is used.
   */
  update(camera: any, opts: any = {}) {
    if (camera) {
      this.baker.setCamera(camera, opts)

      if (this._cameraFar) this._cameraFar.value = camera.far
    }

    this.baker.update()

    if (this._scene && this._scene.environment !== this.baker.environmentTexture) {
      this._scene.environment = this.baker.environmentTexture
    }

    return this
  }

  updateAerialPerspective() {
    return this.baker.updateAerialPerspective()
  }

  applyHaze(sceneColorNode: any, options: any = {}) {
    return applyHaze(sceneColorNode, { ...options, sky: this })
  }

  /**
   * Update haze strength after `applyHaze` has been wired. Multiplies
   * inscatter colour and AP alpha. 0 = no haze; 1 = physical default.
   * No-op if haze hasn't been applied yet (we'd just be priming a uniform
   * that the next applyHaze would re-seed anyway).
   */
  setHazeStrength(value: number) {
    if (this._hazeStrength) this._hazeStrength.value = value
    return this
  }

  /**
   * Switch policy live. 'auto' blends AP→raymarch by altitude/coverage;
   * 'ap' uses AP-first with raymarch only past coverage; 'raymarch' forces
   * the raymarch fallback for every geometry pixel.
   */
  setHazePolicy(policy: string) {
    if (this._hazePolicy) this._hazePolicy.value = policyToHazeMode(policy)
    if (this._hazeRaymarchOnly) this._hazeRaymarchOnly.value = policy === 'raymarch' ? 1.0 : 0.0
    return this
  }

  /**
   * Adjust the auto-mode altitude blend window in km. Above `endKm` the
   * raymarch path is fully active; below `startKm` the AP LUT is used.
   */
  setHazeAltitudeBlend({ startKm, endKm }: { startKm?: number; endKm?: number } = {}) {
    if (typeof startKm === 'number' && this._hazeAltStart) this._hazeAltStart.value = startKm
    if (typeof endKm === 'number' && this._hazeAltEnd) this._hazeAltEnd.value = endKm
    return this
  }

  /**
   * Convenience: build a `SkySun` bound to this Sky. The returned instance
   * owns a `THREE.DirectionalLight` that auto-tracks every `setSunDirection`
   * / `baker.setSun` via the baker's listener hook. Call `sun.attach(scene)`.
   */
  createSun(opts?: any) {
    return new SkySun(this, opts)
  }

  /**
   * Convenience: build a `SkyGround` bound to this Sky. Sphere mode auto-sizes
   * from `baker.atmosphereParams.bottomRadius`. Call `ground.attach(scene)`.
   */
  createGround(opts?: any) {
    return new SkyGround(this, opts)
  }

  /**
   * Convenience: build a `GroundedSkybox` bound to this Sky. The skybox
   * supplies a "floor" via cube-content reprojection — usually replaces an
   * explicit `SkyGround` plane. Add the returned mesh to your scene and
   * call `mesh.followCamera(camera)` each frame.
   */
  createGroundedSkybox(opts?: any) {
    return new GroundedSkybox(this.baker.texture, opts)
  }

  /**
   * Convenience: build a `SkyMoon` bound to this Sky. Owns a
   * `THREE.DirectionalLight` representing moonlight; auto-tracks the sun
   * (anti-sun + lunar phase offset) by default. Does not feed the
   * atmosphere LUTs. Call `moon.attach(scene)`.
   */
  createMoon(opts?: any) {
    return new SkyMoon(this, opts)
  }

  /**
   * Opt into the night-sky stars layer. Default source is `'procedural'` —
   * a shader-generated starfield with zero asset cost. Pass
   * `{ source: 'hdri', url }` (or `{ texture }`) to use a real HDR sky
   * map for a photoreal Milky Way look.
   *
   * Stars fade naturally with twilight (attenuated by camera→space
   * transmittance) and flow into the IBL automatically via the cube bake.
   *
   * Returns the `SkyNight` instance for further control (`setIntensity`,
   * `setSource`, `setDensity`, `setBrightness`, `setRotation`, `disable`,
   * `dispose`). Idempotent — calling again updates in place.
   *
   * @param {object} [opts] see `SkyNight.enable` for full schema.
   * @returns {Promise<SkyNight>}
   */
  async enableStars(opts?: any) {
    if (!this._night) this._night = new SkyNight(this)
    await this._night.enable(opts)
    return this._night
  }

  /**
   * Hide stars without unloading the texture. Re-show via `enableStars()`
   * (cheap — texture stays bound) or `setStarsIntensity( > 0 )`.
   */
  disableStars() {
    if (this._night) this._night.disable()
    return this
  }

  setStarsIntensity(value: number) {
    if (this._night) this._night.setIntensity(value)
    return this
  }

  setStarsRotation(radians: number) {
    if (this._night) this._night.setRotation(radians)
    return this
  }

  setStarsDensity(value: number) {
    if (this._night) this._night.setDensity(value)
    return this
  }

  setStarsBrightness(value: number) {
    if (this._night) this._night.setBrightness(value)
    return this
  }

  setStarsSource(source: string) {
    if (this._night) this._night.setSource(source)
    return this
  }

  get stars() {
    return this._night || null
  }

  dispose() {
    this.detach()
    this.baker.dispose()
  }

  _refreshSunFromTime() {
    const { elevation, azimuth } = solarPosition({
      timeOfDay: this._timeOfDay,
      latitude: this._latitude,
      dayOfYear: this._dayOfYear,
    })
    this.setSunDirection({ elevation, azimuth })
  }
}

function applyShortcutScalars(base: any, { turbidity, groundAlbedo }: { turbidity?: number; groundAlbedo?: any }) {
  if (turbidity == null && groundAlbedo == null) return base

  const partial: any = {}

  if (typeof turbidity === 'number' && turbidity !== 1) {
    partial.mieScattering = base.mieScattering.clone().multiplyScalar(turbidity)
    partial.mieExtinction = base.mieExtinction.clone().multiplyScalar(turbidity)
    partial.mieAbsorption = base.mieAbsorption.clone().multiplyScalar(turbidity)
  }

  if (groundAlbedo != null) {
    partial.groundAlbedo =
      groundAlbedo instanceof Vector3
        ? groundAlbedo.clone()
        : typeof groundAlbedo === 'number'
          ? new Vector3(groundAlbedo, groundAlbedo, groundAlbedo)
          : new Vector3(groundAlbedo.x ?? 0.3, groundAlbedo.y ?? 0.3, groundAlbedo.z ?? 0.3)
  }

  return mergeAtmosphereParams(base, partial)
}

export { presets }
