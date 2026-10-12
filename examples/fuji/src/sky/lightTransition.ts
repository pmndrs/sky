import type { Settings } from '../settings'

export type LightSettings = Pick<
  Settings,
  'elevation' | 'azimuth' | 'haze' | 'exposure' | 'turbidity' | 'paper' | 'ink'
>

export function lightSettings(settings: LightSettings): LightSettings {
  const { elevation, azimuth, haze, exposure, turbidity, paper, ink } = settings
  return { elevation, azimuth, haze, exposure, turbidity, paper, ink }
}

/** Blend the physical light, depth and print finish; keep the authored grade. */
export function blendLight(from: LightSettings, to: LightSettings, progress: number): LightSettings {
  const t = Math.max(0, Math.min(1, progress))
  const ease = t * t * (3 - 2 * t)
  const mix = (a: number, b: number) => a + (b - a) * ease
  const heading = ((to.azimuth - from.azimuth + 540) % 360) - 180
  return {
    elevation: mix(from.elevation, to.elevation),
    azimuth: (from.azimuth + heading * ease + 360) % 360,
    haze: mix(from.haze, to.haze),
    exposure: mix(from.exposure, to.exposure),
    turbidity: mix(from.turbidity, to.turbidity),
    paper: mix(from.paper, to.paper),
    ink: mix(from.ink, to.ink),
  }
}
