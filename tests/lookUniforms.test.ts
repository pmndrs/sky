import { it, expect, describe } from 'vitest'

import { clearLookUniforms, createLookUniforms, updateLookUniforms } from '../src/sky/LookUniforms'
import { MAX_LOOK_STOPS, looks, packLook, resolveLook } from '../src/looks'

describe('createLookUniforms', () => {
  it('starts as the identity transform, so an unassigned look changes nothing', () => {
    const u = createLookUniforms()

    expect(u.chroma.value).toBe(0)
    expect(u.value.value).toBe(0)
    expect(u.sunTintStrength.value).toBe(0)
  })

  it('allocates fixed-length arrays so the node graph never recompiles', () => {
    const u = createLookUniforms()

    expect(u.positions.array).toHaveLength(MAX_LOOK_STOPS)
    expect(u.colors.array).toHaveLength(MAX_LOOK_STOPS)
    expect(u.eases.array).toHaveLength(MAX_LOOK_STOPS)
  })
})

describe('updateLookUniforms', () => {
  it('mirrors the packed look into the uniform arrays', () => {
    const u = createLookUniforms()
    const look = looks['ghibli-dusk']
    const packed = packLook(look)

    updateLookUniforms(u, look)

    expect(u.chroma.value).toBe(look.chroma)
    expect(u.value.value).toBe(look.value)
    expect(u.intensity.value).toBe(look.intensity)
    expect(u.sunTintStrength.value).toBe(look.sunTint?.strength)

    for (let i = 0; i < MAX_LOOK_STOPS; i++) {
      expect(u.positions.array[i]).toBe(packed.positions[i])
      expect(u.colors.array[i].x).toBeCloseTo(packed.colors[i * 3], 6)
      expect(u.eases.array[i].x).toBe(packed.eases[i * 2])
      expect(u.eases.array[i].y).toBe(packed.eases[i * 2 + 1])
    }
  })

  it('mutates the backing objects in place — UniformArrayNode holds the reference', () => {
    const u = createLookUniforms()
    const positions = u.positions.array
    const firstColor = u.colors.array[0]
    const firstEase = u.eases.array[0]

    updateLookUniforms(u, looks['ghibli-day'])

    // Replacing any of these instead of mutating would silently stop uploading.
    expect(u.positions.array).toBe(positions)
    expect(u.colors.array[0]).toBe(firstColor)
    expect(u.eases.array[0]).toBe(firstEase)
  })

  it('reuses one packing scratch buffer across updates', () => {
    const u = createLookUniforms()

    updateLookUniforms(u, looks['ghibli-day'])
    const scratch = u.packed
    updateLookUniforms(u, looks['ghibli-night'])

    expect(u.packed).toBe(scratch)
    expect(u.value.value).toBe(looks['ghibli-night'].value)
  })

  it('zeroes sun-tint strength for a look without one, so stale tint cannot leak', () => {
    const u = createLookUniforms()

    updateLookUniforms(u, looks['ghibli-dusk'])
    expect(u.sunTintStrength.value).toBeGreaterThan(0)

    updateLookUniforms(u, resolveLook({ stops: [{ at: 0, color: [1, 1, 1] }] }))
    expect(u.sunTintStrength.value).toBe(0)
  })
})

describe('clearLookUniforms', () => {
  it('returns the bundle to the identity transform', () => {
    const u = createLookUniforms()
    updateLookUniforms(u, looks['ghibli-dusk'])

    clearLookUniforms(u)

    expect(u.chroma.value).toBe(0)
    expect(u.value.value).toBe(0)
    expect(u.sunTintStrength.value).toBe(0)
  })
})
