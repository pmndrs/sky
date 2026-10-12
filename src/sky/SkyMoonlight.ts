import { Box3, MathUtils } from 'three/webgpu'

import { SkyGrade } from '../grade'
import { SkyAmbient } from './SkyAmbient'
import { SkyMoon } from './SkyMoon'

import type { Object3D } from 'three/webgpu'
import type { Sky } from '../Sky'
import type { SkyMoonOptions } from './SkyMoon'

export interface SkyMoonlightOptions extends Omit<SkyMoonOptions, 'intensity' | 'phaseLighting'> {
  /** Overall artistic strength. Default 1. */
  intensity?: number
  /** Directional-light strength at full moon and full night. Default 1.2. */
  moonIntensity?: number
  /** Hemisphere fill at full moon. Default 0.65. */
  ambientIntensity?: number
  /** Fraction of fill retained with no visible moon, 0..1. Default 0.15. */
  moonlessFloor?: number
  /** Night sky fill strength. Default 1. */
  skyBrightness?: number
  /** Install a temporary night grade. False preserves the current grade. Default true. */
  skyFill?: boolean
}

/**
 * Opt-in artistic night: shadowed moonlight, gentle hemisphere fill and a
 * display-referred blue sky fill. No extra atmosphere LUT or automatic
 * exposure change. Caller-owned, like SkySun and SkyAmbient.
 */
export class SkyMoonlight {
  readonly sky: Sky
  readonly moon: SkyMoon
  readonly ambient: SkyAmbient
  readonly grade: SkyGrade
  readonly skyFill: boolean
  private _intensity: number
  private _moonIntensity: number
  private _ambientIntensity: number
  private _moonlessFloor: number
  private _skyBrightness: number
  private _scene: Object3D | null = null
  private _previousGrade: SkyGrade | null = null
  private _disposed = false
  private _shadowBox: Box3 | null = null
  private _unsubscribers: (() => void)[]

  constructor(
    sky: Sky,
    {
      intensity = 1,
      moonIntensity = 1.2,
      ambientIntensity = 0.65,
      moonlessFloor = 0.15,
      skyBrightness = 1,
      skyFill = true,
      castShadow = true,
      discIntensity = 3,
      ...moonOptions
    }: SkyMoonlightOptions = {},
  ) {
    this.sky = sky
    this._intensity = Math.max(0, intensity)
    this._moonIntensity = Math.max(0, moonIntensity)
    this._ambientIntensity = Math.max(0, ambientIntensity)
    this._moonlessFloor = MathUtils.clamp(moonlessFloor, 0, 1)
    this._skyBrightness = Math.max(0, skyBrightness)
    this.skyFill = skyFill
    this.moon = new SkyMoon(sky, {
      ...moonOptions,
      intensity: moonIntensity,
      castShadow,
      discIntensity,
      phaseLighting: true,
    })
    this.ambient = new SkyAmbient(sky, {
      color: '#7f95bc',
      groundColor: '#111822',
      intensity: ambientIntensity,
      nightBelow: -8,
      dayAbove: 0,
      followGrade: false,
    })
    this.grade = new SkyGrade({
      name: 'moonlight',
      keys: [
        { elevation: -8, fill: { zenith: '#0b1836', horizon: '#243e67', intensity: 1 } },
        { elevation: 0, fill: { intensity: 0 } },
      ],
    })
    const sync = () => this._sync()
    this._unsubscribers = [
      sky.baker.addSunListener(sync),
      sky.baker.addBakeListener(sync),
      this.moon.addChangeListener(sync),
    ]
  }

  get intensity() {
    return this._intensity
  }

  set intensity(value: number) {
    this._intensity = Math.max(0, value)
    this._sync()
  }

  setIntensity(value: number) {
    this.intensity = value
    return this
  }

  setMoonIntensity(value: number) {
    this._moonIntensity = Math.max(0, value)
    this._sync()
    return this
  }

  setAmbientIntensity(value: number) {
    this._ambientIntensity = Math.max(0, value)
    this._sync()
    return this
  }

  setMoonlessFloor(value: number) {
    this._moonlessFloor = MathUtils.clamp(value, 0, 1)
    this._sync()
    return this
  }

  setSkyBrightness(value: number) {
    this._skyBrightness = Math.max(0, value)
    this._sync()
    return this
  }

  setPhase(value: number) {
    this.moon.setPhase(value)
    return this
  }

  setDirection(direction: { elevation: number; azimuth: number }) {
    this.moon.setDirection(direction)
    return this
  }

  setFollowSun(enabled: boolean) {
    this.moon.setFollowSun(enabled)
    return this
  }

  fitShadowToBox(box: Box3) {
    this._shadowBox = box.clone()
    this.moon.fitShadowToBox(box)
    return this
  }

  fitShadowToObject(object: Object3D) {
    return this.fitShadowToBox(new Box3().setFromObject(object))
  }

  attach(scene: Object3D) {
    if (this._disposed) throw new Error('SkyMoonlight: instance is disposed')
    if (this._scene === scene) return this
    this.detach()
    this._scene = scene
    if (this.skyFill) {
      this._previousGrade = this.sky.baker.grade
      this.sky.setGrade(this.grade)
    }
    this.moon.attach(scene)
    this.ambient.attach(scene)
    this._sync()
    return this
  }

  detach() {
    this.moon.detach()
    this.ambient.detach()
    if (this._scene && this.sky.state !== 'disposed' && this.sky.baker.grade === this.grade) {
      this.sky.setGrade(this._previousGrade)
    }
    this._scene = null
    this._previousGrade = null
    return this
  }

  dispose() {
    if (this._disposed) return
    this.detach()
    this._disposed = true
    for (const unsubscribe of this._unsubscribers) unsubscribe()
    this._unsubscribers.length = 0
    this.moon.dispose()
    this.ambient.dispose()
  }

  private _sync() {
    if (this._disposed || !this._scene || this.sky.state === 'disposed') return
    const baker = this.sky.baker
    const elevation = MathUtils.radToDeg(Math.asin(MathUtils.clamp(baker._sunVec.dot(baker.cameraUp), -1, 1)))
    const night = 1 - MathUtils.smoothstep(elevation, -8, 0)
    const moon = this.moon.phaseBrightness * this.moon.visibility
    const fill = this._intensity * (this._moonlessFloor + (1 - this._moonlessFloor) * moon)
    this.moon.intensity = this._moonIntensity * this._intensity * night
    if (this._shadowBox) this.moon.fitShadowToBox(this._shadowBox)
    this.ambient.setNight({ intensity: this._ambientIntensity * fill })
    if (baker.grade === this.grade) {
      const scale = baker.sky.gradeUniforms.fillScale
      const next = this._skyBrightness * fill
      if (scale.value !== next) {
        scale.value = next
        baker.markCubeDirty()
      }
    }
  }
}
