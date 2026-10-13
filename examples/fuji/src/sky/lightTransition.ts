import type { Settings } from '../settings'

export type LightSettings = Pick<
  Settings,
  'timeOfDay' | 'haze' | 'exposure' | 'turbidity' | 'paper' | 'ink' | 'cameraExposure'
>

export function lightSettings(settings: LightSettings): LightSettings {
  const { timeOfDay, haze, exposure, turbidity, paper, ink, cameraExposure } = settings
  return { timeOfDay, haze, exposure, turbidity, paper, ink, cameraExposure }
}

/** Short clock route, including transitions across midnight. */
export function clockDelta(from: number, to: number) {
  return ((to - from + 36) % 24) - 12
}

/** Constant clock speed; retargeting starts from the live time without another
 * preset-specific easing cycle. Small remaining distances finish sooner. */
export function lightTransitionDuration(from: number, to: number) {
  return Math.min(2500, Math.max(150, Math.abs(clockDelta(from, to)) * 2400))
}

/** Lerp the clock and print settings. Sky derives elevation/heading from TOD. */
export function blendLight(from: LightSettings, to: LightSettings, progress: number): LightSettings {
  const t = Math.max(0, Math.min(1, progress))
  if (t === 0) return { ...from }
  if (t === 1) return { ...to }
  const mix = (a: number, b: number) => a + (b - a) * t
  return {
    timeOfDay: (from.timeOfDay + clockDelta(from.timeOfDay, to.timeOfDay) * t + 24) % 24,
    haze: mix(from.haze, to.haze),
    exposure: mix(from.exposure, to.exposure),
    turbidity: mix(from.turbidity, to.turbidity),
    paper: mix(from.paper, to.paper),
    ink: mix(from.ink, to.ink),
    cameraExposure: mix(from.cameraExposure, to.cameraExposure),
  }
}
