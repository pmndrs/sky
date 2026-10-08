import { Color, Matrix4, NoToneMapping, Vector3 } from 'three/webgpu'
import { uniform } from 'three/tsl'

import { SkyAtmosphereBaker } from './sky/SkyAtmosphereBaker'
import { GroundedSkybox } from './sky/GroundedSkybox'
import { SkyGround } from './sky/SkyGround'
import { SkyMoon } from './sky/SkyMoon'
import { SkyNight } from './sky/SkyNight'
import { celestialOrientation } from './sky/stars/celestial'
import { SkySun } from './sky/SkySun'
import { compassToTheta, northHeading } from './sky/compass'
import { mergeAtmosphereParams } from './core/AtmosphereParams'
import { LUT_RESOLUTIONS } from './core/resolutions'
import { presets, resolvePreset } from './presets'
import { resolveGrade } from './grade'
import { SkyAmbient } from './sky/SkyAmbient'

import type { SkyGrade, SkyGradeInput, SkyGradeJSON, SkyGradeKeyInput } from './grade'
import type { SkyAmbientOptions } from './sky/SkyAmbient'
import type { SkyPmremOptions } from './sky/pmrem/SkyPmrem'
import { applyHaze, policyToHazeMode } from './applyHaze'
import { createHazeShadowState, disposeHazeShadowState, updateHazeShadowState } from './sky/hazeShadows'
import type { HazeShadowOptions, HazeShadowState } from './sky/hazeShadows'
import { localSiderealTime, solarPosition } from './solarPosition'
import { applyFog } from './applyFog'
import type { ApplyFogOptions } from './applyFog'
import { createFogState, updateFogState } from './sky/FogPostProcess'
import type { FogOptions, FogState } from './sky/FogPostProcess'

import type { SkyNightOptions } from './sky/SkyNight'
import type { SkyNorth } from './sky/compass'

export type { SkyNorth }

/**
 * Which scene slots `Sky.attach` claims. Both default to `true`. The star
 * sprites (`enableStars`) join the attached scene whatever the roles.
 */
export interface SkyAttachOptions {
  /** Assign the raw sky cube to `scene.background`. */
  background?: boolean
  /** Assign the PMREM-filtered sky to `scene.environment` (IBL). */
  environment?: boolean
}

interface SkyOptions {
  preset?: string
  quality?: string
  cubeSize?: number
  atmosphere?: any
  exposure?: number
  north?: SkyNorth
  sunDisc?: boolean | { visible?: boolean; angularDiameter?: number; edgeSoftness?: number }
  timeOfDay?: number
  latitude?: number
  dayOfYear?: number
  sunDirection?: any
  turbidity?: number
  groundAlbedo?: any
  sunColor?: string | number | Color | Vector3 | number[]
  enableAerialPerspective?: boolean
  apKmPerSlice?: number
  mirrorBelowHorizon?: boolean
  /**
   * IBL prefilter. `{ generator: 'sky' }` (default) re-filters every sky
   * change with WebGPU compute where the installed three allows it; otherwise
   * three's generator runs throttled (`{ minInterval, levelsPerFrame }`).
   */
  pmrem?: SkyPmremOptions
}

/**
 * Named sun colours for `sunColor` / `setSunColor`, linear RGB normalised to
 * green. `neutral` is a white sun (Hillaire's reference). `bruneton` is the
 * solar irradiance Bruneton's model uses at 680 / 550 / 440 nm
 * (1.474, 1.8504, 1.91198): slightly less red, which reads as a more cyan sky.
 */
export const SUN_COLORS: Record<string, [number, number, number]> = {
  neutral: [1, 1, 1],
  bruneton: [1.474 / 1.8504, 1, 1.91198 / 1.8504],
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

/** Lifecycle state. `detached` ⇄ `attached` while live; `disposed` is terminal. */
export type SkyState = 'detached' | 'attached' | 'disposed'

/**
 * High-level wrapper around `SkyAtmosphereBaker`. Targets the 90% case:
 * pick a preset, set time-of-day + latitude, attach to a scene, call
 * `update(camera)` per frame.
 *
 * Power users still have access to `sky.baker` and can use `applyHaze` for
 * custom post-process chains.
 */
export class Sky {
  _baker: any
  _disposed = false
  _renderer: any
  _scene: any
  /** Slots of `_scene` this sky claimed in `attach()`. */
  _ownsBackground = false
  _ownsEnvironment = false
  /** The value this sky last wrote to `_scene.environment` (null before the first PMREM bake). */
  _assignedEnvironment: any = null
  _timeOfDay: number
  _latitude: number
  _dayOfYear: number
  _turbidity: number
  /** Heading of geographic north, degrees clockwise from +Z seen from above. */
  _north: number
  _elevation!: number
  _azimuth!: number
  /** Whether the last `setSunDirection` bypassed the north rotation. */
  _sunRaw = false
  /** Mie coefficients at turbidity 1, so `setTurbidity` is absolute. */
  _baseMie!: { scattering: Vector3; extinction: Vector3; absorption: Vector3 }
  _apDistanceScale: any = null
  _cameraFar?: any
  _hazeStrength?: any
  _hazePolicy?: any
  _hazeRaymarchOnly?: any
  _hazeAltStart?: any
  _hazeAltEnd?: any
  /** Shadowed-haze state (light + live knobs), created by `applyHaze({ shadows })`
   *  or `setHazeShadows`. */
  _hazeShadow?: HazeShadowState
  /** Set by `applyHaze` — signals that the AP LUT has a consumer and needs
   *  its per-frame `updateAerialPerspective()` refresh. */
  _hazeApplied?: boolean
  /** Height-fog knobs, created by `applyFog` or `setFog`. */
  _fog?: FogState
  _night?: SkyNight
  /** Called after `setNorth` changes the heading (a manual `SkyMoon` re-places itself). */
  _northListeners = new Set<() => void>()

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
      sunColor,
      enableAerialPerspective = true,
      apKmPerSlice = 8.0,
      // Fold below-horizon cube-bake rays to above-horizon so the env's
      // lower hemisphere is a Y-mirror of the sky instead of lit ground
      // colour. Useful when the consumer scene has reflective floors and
      // you want a clean sky HDRI for IBL. See `SkyAtmosphereBaker`'s
      // constructor JSDoc.
      mirrorBelowHorizon = false,
      pmrem,
    }: SkyOptions = {},
  ) {
    const baseAtmosphere = resolvePreset(preset)
    let merged = atmosphere ? mergeAtmosphereParams(baseAtmosphere, atmosphere) : baseAtmosphere
    this._captureBaseMie(merged)
    merged = applyShortcutScalars(merged, { turbidity, groundAlbedo })

    const lutResolutions = QUALITY_PRESETS[quality] || QUALITY_PRESETS.medium

    this._baker = new SkyAtmosphereBaker(renderer, {
      cubeSize,
      atmosphere: merged,
      lutResolutions,
      enableAerialPerspective,
      apKmPerSlice,
      mirrorBelowHorizon,
      pmrem,
    })

    this._renderer = renderer
    this._scene = null
    this._timeOfDay = timeOfDay
    this._latitude = latitude
    this._dayOfYear = dayOfYear
    this._turbidity = turbidity ?? 1.0
    this._north = northHeading(north) ?? 0

    this.setExposure(exposure)
    this.setSunDisc(sunDisc)
    if (sunColor != null) this.setSunColor(sunColor)

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

  /** Heading of geographic north in degrees, clockwise from +Z seen from above (see `SkyNorth`). */
  get north() {
    return this._north
  }

  get state(): SkyState {
    if (this._disposed) return 'disposed'
    return this._scene ? 'attached' : 'detached'
  }

  /** The underlying `SkyAtmosphereBaker`. Throws once the Sky is disposed. */
  get baker() {
    if (this._disposed) throw new Error('Sky: instance is disposed')
    return this._baker
  }

  /** Clear `scene.background` if this sky claimed it and it still holds the sky cube. */
  _releaseBackground(scene: any) {
    if (this._ownsBackground && scene.background === this._baker.texture) scene.background = null
    this._ownsBackground = false
  }

  /** Clear `scene.environment` if this sky claimed it and it still holds the sky's IBL. */
  _releaseEnvironment(scene: any) {
    if (this._ownsEnvironment && scene.environment === this._baker.environmentTexture) scene.environment = null
    this._ownsEnvironment = false
    this._assignedEnvironment = null
  }

  /** Release the slots this sky still owns and take the stars out of the scene. */
  _releaseScene() {
    const scene = this._scene
    if (!scene) return
    this._releaseEnvironment(scene)
    this._releaseBackground(scene)
    this._night?._detachStars()
    this._scene = null
  }

  /**
   * Attach to a scene: claim `scene.background` (raw sky cube) and/or
   * `scene.environment` (PMREM-filtered IBL), and add the night-sky star
   * sprites, which join the scene whatever the roles.
   *
   * `{ environment: false }` keeps your own `scene.environment` (an indoor
   * HDRI, say) under the procedural background; `{ background: false }` lights
   * with the sky while you draw your own backdrop. The sky only ever writes
   * the slots it claims, and `detach()`, `dispose()` or attaching elsewhere
   * clear only claimed slots that still hold this sky's textures.
   *
   * Calling again on the same scene with different roles releases a slot no
   * longer requested and claims a newly requested one. Returns `this`.
   */
  attach(scene: any, { background = true, environment = true }: SkyAttachOptions = {}) {
    // Read through the guarded accessor before changing attachment state.
    const baker = this.baker
    if (this._scene !== scene) {
      this._releaseScene()
    } else {
      // Same scene, new roles: give back the slots no longer requested.
      if (!background) this._releaseBackground(scene)
      if (!environment) this._releaseEnvironment(scene)
    }
    this._scene = scene
    if (environment) {
      scene.environment = this._assignedEnvironment = baker.environmentTexture
      this._ownsEnvironment = true
    }
    if (background) {
      scene.background = baker.texture
      this._ownsBackground = true
    }
    // Stars are sprites in the main scene, not part of the bake.
    this._night?._attachStars()
    return this
  }

  detach() {
    this._releaseScene()
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
   * `azimuth` is a compass azimuth: degrees clockwise from the configured
   * `north` (90 = east). Pass `{ elevation, azimuth, raw: true }` to skip
   * north and feed the baker's raw spherical-coord theta directly (degrees
   * from +Z toward +X).
   */
  setSunDirection({ elevation, azimuth, raw = false }: { elevation: number; azimuth: number; raw?: boolean }) {
    this._elevation = elevation
    this._azimuth = azimuth
    this._sunRaw = raw
    const theta = raw ? azimuth : compassToTheta(azimuth, this._north)
    this.baker.setSun({ elevation, azimuth: theta })
    return this
  }

  /**
   * Assign a sky grade — an authored, per-time-of-day lookup table over the
   * physical sky (see `SkyGrade`). Accepts a `SkyGrade` (kept by reference:
   * editing it updates the sky live), a registered name, a definition, or a
   * saved grade as an object or JSON string. `null` clears it.
   *
   * For a quick gradient, solid colour or fixed sky, see `gradientGrade`,
   * `horizonToZenith` and `solidSky`. Changing or editing a grade re-bakes
   * the cube and its IBL, never the atmosphere LUTs. Returns
   * the assigned `SkyGrade`, so `sky.setGrade(json).updateKey(...)` works.
   */
  setGrade(grade: string | SkyGrade | SkyGradeInput | SkyGradeKeyInput[] | SkyGradeJSON | null): SkyGrade | null {
    const resolved = grade === null ? null : resolveGrade(grade)
    this.baker.setGrade(resolved)
    return resolved
  }

  /** The assigned sky grade, or `null`. */
  get grade(): SkyGrade | null {
    return this.baker.grade
  }

  /**
   * Where geographic north points in the world: `'+X' | '-X' | '+Z' | '-Z'`,
   * or a heading in degrees clockwise from +Z seen from above (see
   * `SkyNorth`). Turns the whole sky — the sun from `setTimeOfDay` or a
   * compass `setSunDirection`, the stars, the Milky Way and a manually placed
   * `SkyMoon` — so it can be set once to match a site plan. A `raw` sun
   * direction stays where it is.
   */
  setNorth(north: SkyNorth) {
    const heading = northHeading(north)
    if (heading === null || heading === this._north) return this
    this._north = heading
    // Re-emit the current azimuth through the new heading — unless the last
    // sun was set `raw`, in which case there is no north to apply.
    this.setSunDirection({ elevation: this._elevation, azimuth: this._azimuth, raw: this._sunRaw })
    this._refreshStarOrientation()
    for (const fn of this._northListeners) fn()
    return this
  }

  /**
   * Sky luminance scale. The cube background and IBL bake the sky mesh with
   * this uniform, so a change re-bakes them; the same value is free.
   */
  setExposure(value: number) {
    const scale = this.baker.sky.luminanceScale
    if (scale.value === value) return this
    scale.value = value
    this.baker.markCubeDirty()
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
    // Absolute, against the Mie triple captured at turbidity 1. The previous
    // relative form (`value / lastTurbidity`) could never recover from 0,
    // drifted under slider scrubbing, and silently rescaled whatever preset
    // had been loaded since.
    this._turbidity = value
    const b = this._baseMie
    this.baker.setAtmosphereParams({
      mieScattering: b.scattering.clone().multiplyScalar(value),
      mieExtinction: b.extinction.clone().multiplyScalar(value),
      mieAbsorption: b.absorption.clone().multiplyScalar(value),
    })
    return this
  }

  /** Record the turbidity-1 Mie coefficients that `setTurbidity` scales. */
  _captureBaseMie(params: { mieScattering: Vector3; mieExtinction: Vector3; mieAbsorption: Vector3 }) {
    this._baseMie = {
      scattering: params.mieScattering.clone(),
      extinction: params.mieExtinction.clone(),
      absorption: params.mieAbsorption.clone(),
    }
  }

  setGroundAlbedo(value: any) {
    const v =
      value instanceof Vector3
        ? value
        : typeof value === 'number'
          ? new Vector3(value, value, value)
          : new Vector3(value.x ?? 0.1, value.y ?? 0.1, value.z ?? 0.1)
    this.baker.setAtmosphereParams({ groundAlbedo: v })
    return this
  }

  setAtmosphere(partial: any) {
    // Explicit Mie values define a new turbidity-1 baseline. Merge them onto
    // the current baseline, not the live (turbidity-scaled) values: otherwise
    // a partial like `{ mieScattering }` keeps extinction/absorption at the
    // old turbidity, and a following `setTurbidity` scales them twice.
    if (partial && (partial.mieScattering || partial.mieExtinction || partial.mieAbsorption)) {
      const b = this._baseMie
      const base = mergeAtmosphereParams(
        {
          ...this.baker.atmosphereParams,
          mieScattering: b.scattering,
          mieExtinction: b.extinction,
          mieAbsorption: b.absorption,
        },
        partial,
      )
      this.baker.setAtmosphereParams({
        ...partial,
        mieScattering: base.mieScattering,
        mieExtinction: base.mieExtinction,
        mieAbsorption: base.mieAbsorption,
      })
      this._captureBaseMie(base)
      this._turbidity = 1.0
    } else {
      this.baker.setAtmosphereParams(partial)
    }
    return this
  }

  /**
   * Unreal's `MultiScatteringFactor` — a gain on the multiple-scattering term.
   * 1 is physical; above that is an openly non-physical "lusher, hazier" knob.
   * Feeds the LUT bake (atmosphere-dirty), so set it at preset-load time
   * rather than scrubbing it per frame.
   */
  setMultiScatteringFactor(value: number) {
    this.baker.setAtmosphereParams({ multiScatteringFactor: value })
    return this
  }

  /**
   * Colour of the sun as a light source. Tints everything the sun lights:
   * the sky (before any grade), AP haze, the sun disc and the light of every
   * `createSun()` helper. Accepts a name from `SUN_COLORS` (`'neutral'`,
   * `'bruneton'`), a hex string / number (sRGB, converted to linear), a
   * `Color`, a `Vector3`, or `[r, g, b]` (linear). Default is `'neutral'`.
   * Cube + PMREM re-bake only. For a grade on the sky alone, use
   * `setSkyLuminanceFactor`.
   */
  setSunColor(color: string | number | Color | Vector3 | number[]) {
    let v: Vector3
    if (typeof color === 'string' && SUN_COLORS[color]) {
      v = new Vector3().fromArray(SUN_COLORS[color])
    } else if (color instanceof Vector3) {
      v = color
    } else if (Array.isArray(color)) {
      v = new Vector3().fromArray(color)
    } else {
      const c = color instanceof Color ? color : new Color(color)
      v = new Vector3(c.r, c.g, c.b)
    }
    this.baker.setSunColor(v)
    return this
  }

  /**
   * Unreal's `SkyLuminanceFactor` — a per-channel tint applied to the sky
   * after any grade, as a final tint. Accepts a hex string / number (sRGB,
   * converted to linear), a `Color`, a `Vector3`, or `[r, g, b]` (linear).
   * Cube + PMREM re-bake only; haze inherits it through the same uniform.
   */
  setSkyLuminanceFactor(factor: string | number | Color | Vector3 | number[]) {
    let v: Vector3
    if (factor instanceof Vector3) {
      v = factor
    } else if (Array.isArray(factor)) {
      v = new Vector3().fromArray(factor)
    } else {
      const c = factor instanceof Color ? factor : new Color(factor)
      v = new Vector3(c.r, c.g, c.b)
    }
    this.baker.setSkyLuminanceFactor(v)
    return this
  }

  /**
   * Unreal's `AerialPerspectiveViewDistanceScale` — stretches the optical path
   * used for haze. 2 = twice the haze per metre. A sample-time scale on the AP
   * lookup: no LUT rebuild, no re-bake, nothing dirty. Works before or after
   * `applyHaze`.
   */
  setAerialPerspectiveDistanceScale(value: number) {
    if (!this._apDistanceScale) {
      this._apDistanceScale = uniform(value)
    } else {
      this._apDistanceScale.value = value
    }
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
    const params = resolvePreset(name)
    this.baker.setAtmosphereParams(params)
    this._captureBaseMie(params)
    this._turbidity = 1.0
    return this
  }

  /**
   * Wait for the sky's internal shaders to compile. The sky starts compiling
   * them in the background when it is constructed, and `update()` holds its
   * bakes until they are ready rather than compiling them synchronously,
   * which on Windows can freeze a frame for a second or more. Await this once
   * before the render loop to have the sky on the first frame; without it the
   * sky appears a few frames late (with a console warning):
   *
   * ```js
   * await renderer.init()
   * await sky.compileAsync()
   * renderer.setAnimationLoop(frame)
   * ```
   *
   * It covers the lookup-table passes, the background cube capture and the
   * aerial-perspective pass. Objects in your own scene (the
   * live sky mesh, stars, haze) are compiled by your
   * `renderer.compileAsync(scene, camera)`.
   */
  compileAsync(): Promise<void> {
    return this.baker.compileAsync()
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

    // Keep the grade's display-referred terms (fill, gradient `replace`)
    // display-referred: they are divided by the renderer's tone-mapping
    // exposure (which three ignores under NoToneMapping), so authored colours
    // survive exposure changes. The cube holds them, so a change re-bakes it.
    const r = this._renderer
    const toneExposure = r && r.toneMapping !== NoToneMapping ? (r.toneMappingExposure ?? 1) : 1
    const displayScale = 1 / Math.max(toneExposure, 1e-4)
    const displayScaleU = this.baker.sky.displayScale
    if (displayScaleU.value !== displayScale) {
      displayScaleU.value = displayScale
      this.baker.cubeDirty = true
    }
    this.baker.update()

    // The IBL is null until the first PMREM bake, so `attach()` may have
    // written null; fill the slot once it exists. Only a slot this sky claimed
    // and that is empty or still holds what it wrote: a texture someone else
    // assigned since is theirs.
    const scene = this._scene
    if (scene && this._ownsEnvironment) {
      const env = this.baker.environmentTexture
      const current = scene.environment
      if (current !== env && (current == null || current === this._assignedEnvironment)) {
        scene.environment = this._assignedEnvironment = env
      }
    }

    if (this._night && camera) this._night.update(camera, this._renderer.getPixelRatio?.() ?? 1)

    return this
  }

  /**
   * Finish any throttled / time-sliced IBL refresh now, so the environment
   * lighting matches the current sky. Useful before a screenshot.
   */
  flushEnvironment() {
    this.baker.flushPmrem()
    return this
  }

  updateAerialPerspective() {
    return this.baker.updateAerialPerspective()
  }

  applyHaze(sceneColorNode: any, options: any = {}) {
    return applyHaze(sceneColorNode, { ...options, sky: this })
  }

  /**
   * Haze strength. Multiplies inscatter colour and AP alpha. 0 = no haze;
   * 1 = physical default. Works before or after `applyHaze`: the uniform is
   * created here if needed and `applyHaze` adopts it (only an explicit
   * `strength` option overrides a value set this way).
   */
  setHazeStrength(value: number) {
    if (!this._hazeStrength) this._hazeStrength = uniform(value)
    else this._hazeStrength.value = value
    return this
  }

  /**
   * Switch policy live. 'auto' blends AP→raymarch by altitude/coverage;
   * 'ap' uses AP-first with raymarch only past coverage; 'raymarch' forces
   * the raymarch fallback for every geometry pixel.
   */
  setHazePolicy(policy: string) {
    const mode = policyToHazeMode(policy)
    const raymarchOnly = policy === 'raymarch' ? 1.0 : 0.0
    if (!this._hazePolicy) this._hazePolicy = uniform(mode)
    else this._hazePolicy.value = mode
    if (!this._hazeRaymarchOnly) this._hazeRaymarchOnly = uniform(raymarchOnly)
    else this._hazeRaymarchOnly.value = raymarchOnly
    return this
  }

  /**
   * Adjust the auto-mode altitude blend window in km. Above `endKm` the
   * raymarch path is fully active; below `startKm` the AP LUT is used.
   */
  setHazeAltitudeBlend({ startKm, endKm }: { startKm?: number; endKm?: number } = {}) {
    if (typeof startKm === 'number') {
      if (!this._hazeAltStart) this._hazeAltStart = uniform(startKm)
      else this._hazeAltStart.value = startKm
    }
    if (typeof endKm === 'number') {
      if (!this._hazeAltEnd) this._hazeAltEnd = uniform(endKm)
      else this._hazeAltEnd.value = endKm
    }
    return this
  }

  /**
   * Shadowed haze (light shafts): live knobs for the in-scatter the sun's
   * shadow map removes. Accepts `{ light, samples, maxDistance, strength,
   * resolution }` (`maxDistance` in metres, `resolution` relative to the
   * drawing buffer); anything omitted is left as is. `strength: 0` skips the
   * march at run time.
   *
   * The feature is compiled into the haze shader only when `applyHaze` is
   * called with `shadows` — or after this setter supplied a `light`, in which
   * case the next `applyHaze` adopts it. Calling this after `applyHaze` without
   * `shadows` changes nothing on screen until `applyHaze` is called again.
   */
  setHazeShadows(options: HazeShadowOptions) {
    if (!this._hazeShadow) this._hazeShadow = createHazeShadowState(options)
    else updateHazeShadowState(this._hazeShadow, options)
    return this
  }

  /**
   * Sky-coloured exponential height fog over `sceneColorNode`: the budget
   * alternative to `applyHaze`, with no per-frame LUT (works with
   * `enableAerialPerspective: false`). Geometry fades toward the baked sky cube
   * along the view ray. Returns a `vec4` node. See `applyFog`.
   */
  applyFog(sceneColorNode: any, options: Omit<ApplyFogOptions, 'sky'> = {}) {
    return applyFog(sceneColorNode, { ...options, sky: this })
  }

  /**
   * Live height-fog knobs: `{ density, heightFalloff, baseHeight, maxOpacity }`
   * (per km, metres, metres, 0..1); omitted fields are left as is. Works before
   * or after `applyFog`: the uniforms are created here if needed and
   * `applyFog` adopts them (only an option passed to it overrides).
   */
  setFog(options: FogOptions) {
    if (!this._fog) this._fog = createFogState(options)
    else updateFogState(this._fog, options)
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
   * Convenience: build a `SkyAmbient` bound to this Sky — a hemisphere fill
   * light that fades in as the sun goes down (a dim blue by default), or
   * follows the grade's keyframed ambient when the grade has one. Call
   * `ambient.attach(scene)`. Caller-owned, like the other helpers.
   */
  createAmbient(opts?: SkyAmbientOptions) {
    return new SkyAmbient(this, opts)
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
   * Opt into the night sky: resolved stars (PSF sprites added to the attached
   * scene) and the Milky Way (a glow map baked into the cube with the rest of
   * the sky). Both are placed from this sky's `timeOfDay`, `dayOfYear`,
   * `latitude` and `north`, dimmed toward the horizon by transmittance, hidden
   * by the planet, and fade in through twilight by contrast against the sky.
   *
   * Needs `sky.update(camera)` each frame (the sprites follow the camera).
   * Idempotent — calling again updates in place. Returns the `SkyNight`
   * instance (`setIntensity`, `setSize`, `setTwinkle`, `setContrast`,
   * `setMagnitudeContrast`, `setMilkyWay`, `setMilkyWayContrast`,
   * `setMilkyWayTexture`, `disable`, `dispose`).
   *
   * Async for API stability; generating the procedural Milky Way map takes
   * ~120 ms on first enable.
   */
  async enableStars(options?: SkyNightOptions) {
    // Read through the guarded accessor so a disposed sky throws.
    void this.baker
    if (!this._night) {
      this._night = new SkyNight(this)
      this._refreshStarOrientation()
    }
    return this._night.enable(options)
  }

  /** Hide stars and the Milky Way. `enableStars()` brings them back. */
  disableStars() {
    if (this._night) this._night.disable()
    return this
  }

  setStarsIntensity(value: number) {
    if (this._night) this._night.setIntensity(value)
    return this
  }

  get stars() {
    return this._night || null
  }

  /** Re-derive the equatorial → world rotation from time, date, latitude and north. */
  _refreshStarOrientation() {
    if (!this._night) return
    const orientation = celestialOrientation(
      {
        latitude: this._latitude,
        siderealTime: localSiderealTime({ timeOfDay: this._timeOfDay, dayOfYear: this._dayOfYear }),
        northHeading: this._north,
      },
      _orientation,
    )
    this._night._setOrientation(orientation)
  }

  /**
   * Detach, remove the stars and free the Milky Way map, dispose the baker and drop the
   * haze uniforms. Idempotent and terminal: afterwards access to `baker` and
   * methods that rely on it throw, while the haze and star setters become
   * no-ops. Helpers from `createSun` / `createGround` /
   * `createGroundedSkybox` / `createMoon` / `createAmbient` are caller-owned and not disposed
   * here.
   */
  dispose() {
    if (this._disposed) return
    this._releaseScene()
    // Mark the instance terminal before resource disposal can emit callbacks.
    this._disposed = true
    if (this._night) {
      this._night.dispose()
      this._night = undefined
    }
    this._baker.dispose()
    this._hazeStrength = this._hazePolicy = this._hazeRaymarchOnly = undefined
    this._hazeAltStart = this._hazeAltEnd = this._cameraFar = undefined
    disposeHazeShadowState(this._hazeShadow)
    this._hazeShadow = undefined
    this._apDistanceScale = null
    this._hazeApplied = false
    this._fog = undefined
    this._northListeners.clear()
  }

  _refreshSunFromTime() {
    const { elevation, azimuth } = solarPosition({
      timeOfDay: this._timeOfDay,
      latitude: this._latitude,
      dayOfYear: this._dayOfYear,
    })
    this.setSunDirection({ elevation, azimuth })
    this._refreshStarOrientation()
  }
}

const _orientation = new Matrix4()

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
          : new Vector3(groundAlbedo.x ?? 0.1, groundAlbedo.y ?? 0.1, groundAlbedo.z ?? 0.1)
  }

  return mergeAtmosphereParams(base, partial)
}

export { presets }
