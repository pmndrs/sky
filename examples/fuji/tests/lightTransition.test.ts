import { describe, expect, it } from 'vitest'
import { blendLight, lightSettings } from '../src/sky/lightTransition'
import { presets } from '../src/settings'

describe('coastal light transitions', () => {
  it('starts and ends at the exact edition settings', () => {
    const from = lightSettings(presets.haze),
      to = lightSettings(presets.night)
    expect(blendLight(from, to, 0)).toEqual(from)
    expect(blendLight(from, to, 1)).toEqual(to)
    const middle = blendLight(from, to, 0.5)
    expect(middle.elevation).toBe((from.elevation + to.elevation) / 2)
    expect(middle.exposure).toBe((from.exposure + to.exposure) / 2)
    expect(middle.haze).toBe((from.haze + to.haze) / 2)
  })

  it('takes the short heading route and can restart from an intermediate frame', () => {
    const from = { ...lightSettings(presets.haze), azimuth: 350 }
    const to = { ...lightSettings(presets.night), azimuth: 10 }
    expect(blendLight(from, to, 0.5).azimuth).toBe(0)
    const current = blendLight(from, to, 0.35)
    expect(blendLight(current, lightSettings(presets.dusk), 0)).toEqual(current)
  })
})
