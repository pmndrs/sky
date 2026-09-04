import { it, expect, describe } from 'vitest'

import { EARTH, mergeAtmosphereParams } from '../src/core/AtmosphereParams'
import { presets } from '../src/presets'
import { createAtmosphereUniforms, updateAtmosphereUniforms } from '../src/sky/AtmosphereUniforms'

describe('multiScatteringFactor (Unreal parity, tier 1)', () => {
  it('defaults to 1 — physical — on Earth and every preset built from it', () => {
    expect(EARTH.multiScatteringFactor).toBe(1)
    for (const name of Object.keys(presets)) expect(presets[name].multiScatteringFactor).toBe(1)
  })

  it('merges like any other scalar param', () => {
    const p = mergeAtmosphereParams(EARTH, { multiScatteringFactor: 1.6 })
    expect(p.multiScatteringFactor).toBe(1.6)
    // and does not leak back into the base
    expect(EARTH.multiScatteringFactor).toBe(1)
  })

  it('is carried into the uniform bundle and updated in place', () => {
    const u = createAtmosphereUniforms(EARTH)
    expect(u.multiScatteringFactor.value).toBe(1)

    const node = u.multiScatteringFactor
    updateAtmosphereUniforms(u, mergeAtmosphereParams(EARTH, { multiScatteringFactor: 2.5 }))

    expect(u.multiScatteringFactor).toBe(node) // same node — no graph rebuild
    expect(u.multiScatteringFactor.value).toBe(2.5)
  })

  it('tolerates params objects that predate the field', () => {
    const legacy = { ...EARTH } as any
    delete legacy.multiScatteringFactor
    expect(createAtmosphereUniforms(legacy).multiScatteringFactor.value).toBe(1)
  })
})
