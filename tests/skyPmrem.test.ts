import { describe, expect, it, vi } from 'vitest'

import { cubeUVLayout } from '../src/sky/pmrem/cubeUV'
import { SkyPmrem, lodToRoughness, skyPmremPlan } from '../src/sky/pmrem/SkyPmrem'

describe('skyPmremPlan', () => {
  it('matches three r187 for a 256 cube: copy, 256-sample FIS, then 16² integration', () => {
    expect(skyPmremPlan(5)).toEqual([
      { fis: 0 },
      { fis: 256 },
      { fis: 256 },
      { integ: 16 },
      { integ: 16 },
      { integ: 16 },
    ])
  })

  it('fast drops only the sharpest filtered level to 96 samples', () => {
    expect(skyPmremPlan(5, 'fast')[1]).toEqual({ fis: 96 })
    expect(skyPmremPlan(5, 'fast').slice(2)).toEqual(skyPmremPlan(5).slice(2))
  })

  it('uses three r187 roughness per level', () => {
    expect(lodToRoughness(0, 5)).toBe(0)
    expect(lodToRoughness(5, 5)).toBe(1)
    expect(lodToRoughness(1, 5)).toBeCloseTo(0.1056, 4)
  })
})

function make(backend: any, texture: any, options = {}) {
  const target = { width: 256, height: 256, texture, dispose: vi.fn() }
  const gen: any = { fromCubemap: vi.fn(() => target) }
  const renderer = { backend, copyTextureToTexture() {}, getRenderTarget: () => null }
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const p = new SkyPmrem(renderer, gen, {} as any, { minInterval: 0, ...options })
  return { p, gen, warn }
}

describe('cubeUVLayout (three r185/r186 atlas)', () => {
  const L = cubeUVLayout(256)

  it('is 768×1024 with 11 levels for a 256 cube', () => {
    expect([L.width, L.height, L.tiles.length]).toEqual([768, 1024, 11])
    expect(L.tiles.map((t) => t.size)).toEqual([256, 128, 64, 32, 16, 16, 16, 16, 16, 16, 16])
  })

  it('places tiles like three’s _applyGGXFilter viewports', () => {
    expect(L.tiles[0]).toMatchObject({ x: 0, y: 0 })
    expect(L.tiles[1]).toMatchObject({ x: 0, y: 512 })
    expect(L.tiles[4]).toMatchObject({ x: 0, y: 960 })
    expect(L.tiles[5]).toMatchObject({ x: 48, y: 960 })
    expect(L.tiles[10]).toMatchObject({ x: 288, y: 960 })
  })

  it('reads each level at the roughness three’s sampler maps to it', () => {
    const r = L.tiles.map((t) => +t.roughness.toFixed(4))
    expect(r).toEqual([0, 0.0762, 0.1078, 0.1524, 0.21, 0.305, 0.4, 0.5333, 0.6667, 0.8, 1])
  })
})

describe('SkyPmrem fallback', () => {
  it('keeps three’s generator on the WebGL backend', () => {
    const { p, gen, warn } = make({ isWebGPUBackend: false }, { isPMREMTexture: true, mipmaps: [{}, {}] })
    p.markDirty()
    p.tick(0)
    p.markDirty()
    p.tick(1)
    expect(p.mode).toBe('three')
    expect(gen.fromCubemap).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('probes the r185/r186 CubeUV atlas, and keeps three’s generator when it can’t set up', () => {
    const get = vi.fn(() => undefined) // no GPU texture for the sky cube
    const { p, warn } = make({ isWebGPUBackend: true, get }, { mapping: 306, mipmaps: [] })
    p.markDirty()
    p.tick(0)
    expect(get).toHaveBeenCalled()
    expect(p.mode).toBe('three')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('honours generator: three', () => {
    const get = vi.fn()
    const { p, warn } = make(
      { isWebGPUBackend: true, get },
      { isPMREMTexture: true, mipmaps: [{}] },
      { generator: 'three' },
    )
    p.markDirty()
    p.tick(0)
    expect(get).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('exposes the first bake’s texture straight away', () => {
    const tex = { isPMREMTexture: true, mipmaps: [] }
    const { p, warn } = make({ isWebGPUBackend: false }, tex)
    expect(p.texture).toBeNull()
    p.markDirty()
    p.tick(0)
    expect(p.texture).toBe(tex)
    warn.mockRestore()
  })
})
