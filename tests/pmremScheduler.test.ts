import { describe, expect, it, vi } from 'vitest'

import { PmremScheduler } from '../src/sky/PmremScheduler'

const LEVELS = 10

function fakeRenderer() {
  return {
    autoClear: true,
    copies: 0,
    mrt: null as any,
    getRenderTarget: () => null,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget: vi.fn(),
    getMRT() {
      return this.mrt
    },
    setMRT(mrt: any) {
      this.mrt = mrt
    },
    copyTextureToTexture() {
      this.copies++
    },
  }
}

function fakeGenerator({ sliceable = true } = {}) {
  const target = { width: 768, height: 1024, texture: { id: 'env' }, dispose: vi.fn() }
  const gen: any = {
    whole: 0,
    filtered: [] as number[],
    fromCubemap: vi.fn(() => {
      gen.whole++
      return target
    }),
  }
  if (sliceable) {
    Object.assign(gen, {
      _lodMeshes: Array.from({ length: LEVELS + 1 }, () => ({})),
      _setSizeFromTexture() {},
      _init() {},
      _textureToCubeUV() {},
      _applyGGXFilter(_t: unknown, _in: number, out: number) {
        gen.filtered.push(out)
      },
    })
  }
  return { gen, target }
}

function make(opts = {}, genOpts = {}) {
  const renderer = fakeRenderer()
  const { gen, target } = fakeGenerator(genOpts)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const s = new PmremScheduler(renderer, gen, {} as any, opts)
  warn.mockRestore()
  return { s, renderer, gen, target }
}

describe('PmremScheduler', () => {
  it('bakes the first environment synchronously and keeps one target', () => {
    const { s, gen, target } = make()
    expect(s.texture).toBeNull()
    s.markDirty()
    s.tick(0)
    expect(gen.whole).toBe(1)
    expect(s.texture).toBe(target.texture)
  })

  it('slices a refresh one level per frame and copies only when complete', () => {
    const { s, gen, renderer } = make({ minInterval: 0, levelsPerFrame: 1 })
    s.markDirty()
    s.tick(0) // first bake, synchronous
    s.markDirty()
    s.tick(1) // starts the sliced refresh: level 1
    expect(gen.filtered).toEqual([1])
    expect(renderer.copies).toBe(0)
    for (let f = 2; f <= LEVELS; f++) s.tick(f)
    expect(gen.filtered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(renderer.copies).toBe(1)
    expect(gen.whole).toBe(1) // the sliced path never calls fromCubemap
  })

  it('throttles while the sky keeps changing, then catches up once it settles', () => {
    const { s, gen } = make({ minInterval: 250, levelsPerFrame: Infinity })
    s.markDirty()
    s.tick(0) // first bake
    // continuous change every 16 ms for 200 ms: inside the interval, no refresh
    for (let t = 16; t < 250; t += 16) {
      s.markDirty()
      s.tick(t)
    }
    expect(gen.whole).toBe(1)
    s.markDirty()
    s.tick(256) // interval elapsed while still changing → refresh
    expect(gen.whole).toBe(2)
    s.markDirty()
    s.tick(272) // changing again, throttled
    expect(gen.whole).toBe(2)
    s.tick(288) // no change this frame → settled → catch-up refresh
    expect(gen.whole).toBe(3)
    s.tick(304) // nothing pending
    expect(gen.whole).toBe(3)
  })

  it('flush() completes an in-flight slice and any pending change', () => {
    const { s, gen, renderer } = make({ minInterval: 0, levelsPerFrame: 1 })
    s.markDirty()
    s.tick(0)
    s.markDirty()
    s.tick(1) // level 1 of a sliced refresh
    s.markDirty() // a further change arrives mid-refresh
    s.flush()
    expect(gen.filtered).toHaveLength(LEVELS)
    expect(renderer.copies).toBe(1)
    expect(gen.whole).toBe(2) // the pending change was baked whole
  })

  it('filters with the caller MRT cleared and restores it (issue #36)', () => {
    const { s, gen, renderer } = make({ minInterval: 0, levelsPerFrame: 1 })
    const callerMRT = { isMRTNode: true }
    renderer.mrt = callerMRT
    const seen: any[] = []
    gen.fromCubemap.mockImplementation(() => {
      seen.push(renderer.mrt)
      return { width: 768, height: 1024, texture: {}, dispose() {} }
    })
    gen._applyGGXFilter = () => seen.push(renderer.mrt)
    s.markDirty()
    s.tick(0) // whole first bake
    s.markDirty()
    s.tick(1) // one slice
    expect(seen).toEqual([null, null])
    expect(renderer.mrt).toBe(callerMRT)
  })

  it('a throwing slice restores the renderer and restarts the refresh', () => {
    const { s, gen, renderer } = make({ minInterval: 0, levelsPerFrame: 1 })
    const callerMRT = { isMRTNode: true }
    renderer.mrt = callerMRT
    s.markDirty()
    s.tick(0)
    s.markDirty()
    s.tick(1) // level 1
    const filter = gen._applyGGXFilter
    gen._applyGGXFilter = () => {
      throw new Error('lost')
    }
    expect(() => s.tick(2)).toThrow('lost')
    expect(renderer.mrt).toBe(callerMRT)
    expect(renderer.autoClear).toBe(true)
    gen._applyGGXFilter = filter
    gen.filtered.length = 0
    for (let f = 3; f <= 3 + LEVELS; f++) s.tick(f)
    expect(gen.filtered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) // from level 1 again
    expect(renderer.copies).toBe(1)
  })

  it('falls back to whole bakes when generator internals are missing', () => {
    const { s, gen } = make({ minInterval: 0, levelsPerFrame: 1 }, { sliceable: false })
    s.markDirty()
    s.tick(0)
    s.markDirty()
    s.tick(1)
    expect(gen.whole).toBe(2)
  })
})
