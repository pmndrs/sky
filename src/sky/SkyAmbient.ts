import { Color, HemisphereLight, MathUtils, Vector3 } from 'three/webgpu'

import { toColor } from '../color'

import type { Object3D } from 'three/webgpu'
import type { ColorInput } from '../color'
import type { SkyGrade } from '../grade'

/** One end of the day/night fade. */
export interface SkyAmbientLevel {
  /** Light from above (sRGB hex / number, or linear `[r, g, b]`). */
  color?: ColorInput
  /** Light from below. */
  groundColor?: ColorInput
  /** three light intensity (a Lambertian surface of albedo ρ returns `ρ · intensity · color / π`). */
  intensity?: number
}

export interface SkyAmbientOptions {
  /** Night light from above. Default `'#7088c0'`, a moonlit blue soft enough to light non-blue surfaces. */
  color?: ColorInput
  /** Night light from below. Default `'#121a2c'`. */
  groundColor?: ColorInput
  /** Night intensity. Default `1`. */
  intensity?: number
  /** Daytime light from above. Default white. */
  dayColor?: ColorInput
  /** Daytime light from below. Default `'#6b6b6b'`. */
  dayGroundColor?: ColorInput
  /** Daytime intensity. Default `0`: in daylight the sky's environment lighting does this job. */
  dayIntensity?: number
  /** Sun elevation (degrees) at and below which the night light is at full strength. Default `-6` (civil dusk). */
  nightBelow?: number
  /** Sun elevation (degrees) at and above which the day values hold. Default `3`. */
  dayAbove?: number
  /**
   * Follow the sky grade's keyframed ambient when the assigned grade has one
   * (`sky.setGrade`), instead of the day/night values above. Default `true`.
   */
  followGrade?: boolean
}

function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 === e0) return x < e0 ? 0 : 1
  const t = MathUtils.clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Night fill light: a `THREE.HemisphereLight` that fades in as the sun goes
 * down, so a night scene is lit a dim blue instead of going black.
 *
 * Physically the night is near black: the moon is ~400,000× dimmer than the
 * sun and its light is not blue (the "blue" of moonlight is the eye's rod
 * vision, not the light). Films and games light night scenes blue anyway, and
 * that is what this does — a stylised fill, off in daylight by default, where
 * the sky's environment lighting does the job.
 *
 * Driven by the sun: it re-evaluates on every sun move (and on every cube
 * re-bake, which covers the camera moving around a planet), with no per-frame
 * work. When the sky has a grade whose keyframes set an ambient light
 * (`ambient` on a `SkyGradeKeyInput`), it follows the grade instead, so an
 * artist authors the night light on the same timeline as the sky.
 *
 * Colour and intensity are interpolated as their product (the light that
 * actually arrives), then split back into a normalised colour and an
 * intensity, so a fade from a blue night to a white day does not pass through
 * a dim grey.
 *
 * ```js
 * const ambient = sky.createAmbient({ intensity: 1, color: '#7088c0' })
 * ambient.attach(scene)
 * ```
 */
export class SkyAmbient {
  sky: any
  light: HemisphereLight
  night: { color: Color; groundColor: Color; intensity: number }
  day: { color: Color; groundColor: Color; intensity: number }
  nightBelow: number
  dayAbove: number
  followGrade: boolean
  _scene: Object3D | null = null
  _elevation = 90
  _unsubscribers: (() => void)[] = []
  _sky = new Color()
  _ground = new Color()
  _up = new Vector3(0, 1, 0)

  constructor(
    sky: any,
    {
      color = '#7088c0',
      groundColor = '#121a2c',
      intensity = 1,
      dayColor = '#ffffff',
      dayGroundColor = '#6b6b6b',
      dayIntensity = 0,
      nightBelow = -6,
      dayAbove = 3,
      followGrade = true,
    }: SkyAmbientOptions = {},
  ) {
    this.sky = sky
    this.night = { color: toColor(color), groundColor: toColor(groundColor), intensity }
    this.day = { color: toColor(dayColor), groundColor: toColor(dayGroundColor), intensity: dayIntensity }
    this.nightBelow = nightBelow
    this.dayAbove = dayAbove
    this.followGrade = followGrade
    this.light = new HemisphereLight(0xffffff, 0x000000, 0)
    this.light.name = 'SkyAmbient'

    const baker = sky.baker
    const resync = () => this._syncFromSun()
    this._unsubscribers.push(baker.addSunListener(resync))
    this._unsubscribers.push(baker.addBakeListener(resync))
    this._unsubscribers.push(baker.addGradeListener(() => this._sync()))
    this._syncFromSun()
  }

  /** The grade this light follows, if any. */
  get grade(): SkyGrade | null {
    return this.sky.baker.grade ?? null
  }

  /** Night values (any subset). */
  setNight({ color, groundColor, intensity }: SkyAmbientLevel): this {
    if (color !== undefined) this.night.color = toColor(color)
    if (groundColor !== undefined) this.night.groundColor = toColor(groundColor)
    if (intensity !== undefined) this.night.intensity = intensity
    return this._sync()
  }

  /** Daytime values (any subset). */
  setDay({ color, groundColor, intensity }: SkyAmbientLevel): this {
    if (color !== undefined) this.day.color = toColor(color)
    if (groundColor !== undefined) this.day.groundColor = toColor(groundColor)
    if (intensity !== undefined) this.day.intensity = intensity
    return this._sync()
  }

  /** Sun elevations (degrees) of the fade: full night at and below `nightBelow`, full day at and above `dayAbove`. */
  setFade(nightBelow: number, dayAbove: number): this {
    this.nightBelow = nightBelow
    this.dayAbove = dayAbove
    return this._sync()
  }

  setFollowGrade(enabled: boolean): this {
    this.followGrade = enabled
    return this._sync()
  }

  attach(scene: Object3D): this {
    if (this._scene && this._scene !== scene) this._scene.remove(this.light)
    this._scene = scene
    scene.add(this.light)
    return this
  }

  detach(): this {
    this._scene?.remove(this.light)
    this._scene = null
    return this
  }

  dispose(): void {
    this.detach()
    for (const off of this._unsubscribers) off()
    this._unsubscribers.length = 0
    this.light.dispose()
  }

  /** Sun elevation against the camera's local up (world +Y on flat ground). */
  _syncFromSun(): this {
    const baker = this.sky.baker
    const up: Vector3 = baker._cameraUp ?? this._up
    const sinEl = MathUtils.clamp(baker._sunVec.dot(up), -1, 1)
    this._elevation = MathUtils.radToDeg(Math.asin(sinEl))
    // A HemisphereLight's position is its up direction.
    this.light.position.copy(up)
    return this._sync()
  }

  _sync(): this {
    const grade = this.followGrade ? this.grade : null
    const fromGrade = grade && grade.hasAmbient ? grade.evaluate(this._elevation).ambient : null
    if (fromGrade) {
      this._sky.copy(fromGrade.color).multiplyScalar(fromGrade.intensity)
      this._ground.copy(fromGrade.groundColor).multiplyScalar(fromGrade.intensity)
    } else {
      const t = smoothstep(this.nightBelow, this.dayAbove, this._elevation)
      const n = this.night
      const d = this.day
      this._sky
        .copy(n.color)
        .multiplyScalar(n.intensity * (1 - t))
        .add(d.color.clone().multiplyScalar(d.intensity * t))
      this._ground
        .copy(n.groundColor)
        .multiplyScalar(n.intensity * (1 - t))
        .add(d.groundColor.clone().multiplyScalar(d.intensity * t))
    }
    const peak = Math.max(this._sky.r, this._sky.g, this._sky.b, this._ground.r, this._ground.g, this._ground.b)
    this.light.intensity = peak
    this.light.visible = peak > 0
    if (peak > 0) {
      this.light.color.copy(this._sky).multiplyScalar(1 / peak)
      this.light.groundColor.copy(this._ground).multiplyScalar(1 / peak)
    }
    return this
  }
}
