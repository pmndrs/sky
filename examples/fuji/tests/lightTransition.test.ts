import { describe, expect, it } from 'vitest'
import { blendLight, lightSettings, lightTransitionDuration } from '../src/sky/lightTransition'
import { presets } from '../src/settings'

describe('coastal light transitions', () => {
  it('starts and ends at the exact edition settings', () => {
    const from = lightSettings(presets.haze),
      to = lightSettings(presets.night)
    expect(blendLight(from, to, 0)).toEqual(from)
    expect(blendLight(from, to, 1)).toEqual(to)
    const middle = blendLight(from, to, 0.5)
    expect(middle.timeOfDay).toBeCloseTo((from.timeOfDay + to.timeOfDay) / 2)
    expect(middle.exposure).toBe((from.exposure + to.exposure) / 2)
    expect(middle.haze).toBe((from.haze + to.haze) / 2)
  })

  it('takes the short clock route and can restart from the current time', () => {
    const from = { ...lightSettings(presets.haze), timeOfDay: 23 }
    const to = { ...lightSettings(presets.night), timeOfDay: 1 }
    expect(blendLight(from, to, 0.5).timeOfDay).toBe(0)
    const current = blendLight(from, to, 0.35)
    expect(blendLight(current, lightSettings(presets.dusk), 0)).toEqual(current)
  })

  it('lerps time at a steady rate and finishes sooner after a partial transition', () => {
    const from = lightSettings(presets.haze),
      to = lightSettings(presets.night)
    expect(blendLight(from, to, 0.25).timeOfDay).toBeCloseTo(from.timeOfDay + (to.timeOfDay - from.timeOfDay) * 0.25)
    const current = blendLight(from, to, 0.6)
    expect(lightTransitionDuration(current.timeOfDay, to.timeOfDay)).toBeLessThan(
      lightTransitionDuration(from.timeOfDay, to.timeOfDay),
    )
    expect(blendLight(current, lightSettings(presets.dusk), 0).timeOfDay).toBe(current.timeOfDay)
  })
})
