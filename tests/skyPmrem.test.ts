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

/** A mock GPUDevice: enough surface for SkyPmrem to compile, build and bake. */
function mockDevice({ failCompile = false } = {}) {
  const obj = (): any => ({ createView: () => ({}), getBindGroupLayout: () => ({}), destroy: vi.fn() })
  const encoder = {
    copyTextureToTexture: vi.fn(),
    beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
    finish: () => ({}),
  }
  return {
    encoder,
    createShaderModule: vi.fn(() => ({})),
    createComputePipelineAsync: vi.fn(async () => {
      if (failCompile) throw new Error('compile failed')
      return obj()
    }),
    createTexture: vi.fn(obj),
    createSampler: vi.fn(() => ({})),
    createBuffer: vi.fn(obj),
    createBindGroup: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(() => encoder),
    queue: { writeBuffer: vi.fn(), submit: vi.fn() },
  }
}

/** A 256² sky cube as `CubeRenderTarget` makes it. */
function skyCube(size = 256): any {
  const image = { width: size, height: size, depth: 1 }
  return { isCubeTexture: true, image: [image, image, image, image, image, image], mipmaps: [], generateMipmaps: true }
}

function make({ webgpu = true, options = {}, device = mockDevice(), source = skyCube() } = {}) {
  const firstBake = { width: 768, height: 1024, texture: { isPMREMTexture: true }, dispose: vi.fn() }
  const gen: any = { fromCubemap: vi.fn((_src: any, target: any) => target ?? firstBake) }
  const factory = vi.fn(() => gen)
  const gpu = new Map<any, any>()
  const renderer: any = {
    backend: webgpu
      ? { isWebGPUBackend: true, device, get: (t: any) => gpu.get(t) }
      : { isWebGPUBackend: false, get: () => undefined },
    initTexture: vi.fn((t: any) => gpu.set(t, { texture: { mipLevelCount: 1 } })),
    getRenderTarget: () => null,
    setRenderTarget() {},
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getMRT: () => null,
    setMRT() {},
  }
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const p = new SkyPmrem(renderer, factory, source, { minInterval: 0, ...options })
  /** What three does on the cube's first render: allocate it, with the mips it lists. */
  const captureCube = () => gpu.set(source, { texture: { mipLevelCount: source.mipmaps.length + 1 } })
  return { p, gen, factory, renderer, device, source, warn, captureCube }
}

describe('SkyPmrem on WebGPU (no three generator)', () => {
  it('allocates three r186’s CubeUV atlas up front, without three’s generator', () => {
    const { p, factory, renderer, warn } = make()
    const tex: any = p.texture
    expect(p.mode).toBe('sky')
    expect(p.layout).toBe('atlas')
    expect(tex.mapping).toBe(306)
    expect(tex.isPMREMTexture).toBe(true)
    expect([p.target!.width, p.target!.height]).toEqual([768, 1024])
    expect(renderer.initTexture).toHaveBeenCalledWith(tex)
    expect(factory).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('takes over the sky cube’s mip chain, so three never generates it', () => {
    const { source, warn } = make()
    expect(source.mipmaps.map((m: any) => m.width)).toEqual([128, 64, 32, 16, 8, 4, 2, 1])
    expect(source.generateMipmaps).toBe(false)
    warn.mockRestore()
  })

  it('compiles asynchronously, waits for the cube, then bakes and copies the mips back', async () => {
    const { p, device, captureCube, warn } = make()
    p.markDirty()
    p.tick(0) // pipelines still compiling: nothing to run, nothing synchronous
    expect(device.createCommandEncoder).not.toHaveBeenCalled()
    await p.ready
    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(5)
    p.tick(1) // the cube hasn't been captured yet
    expect(device.queue.submit).not.toHaveBeenCalled()
    captureCube()
    p.tick(2)
    expect(device.queue.submit).toHaveBeenCalledTimes(1)
    // mip 0 of the cube in, the atlas out, mips 1–8 back into the cube
    expect(device.encoder.copyTextureToTexture).toHaveBeenCalledTimes(1 + 1 + 8)
    p.tick(3) // nothing dirty
    expect(device.queue.submit).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('runs a bake requested while compiling as soon as the pipelines are ready, without a tick', async () => {
    const { p, device, captureCube, warn } = make()
    captureCube()
    p.markDirty()
    await p.ready
    expect(device.queue.submit).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('falls back to three’s generator, writing into the same target, if the compile fails', async () => {
    const { p, gen, factory, source, warn } = make({ device: mockDevice({ failCompile: true }) })
    const target = p.target
    p.markDirty()
    await p.ready
    expect(p.mode).toBe('three')
    expect(factory).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    expect(source.generateMipmaps).toBe(true) // three fills the cube's mips again
    p.tick(0)
    expect(gen.fromCubemap).toHaveBeenCalledWith(source, target)
    expect(p.target).toBe(target)
    warn.mockRestore()
  })
})

describe('SkyPmrem with three’s generator', () => {
  it('keeps three’s generator on the WebGL backend', () => {
    const { p, gen, source, warn } = make({ webgpu: false })
    p.markDirty()
    p.tick(0)
    p.markDirty()
    p.tick(1)
    expect(p.mode).toBe('three')
    expect(gen.fromCubemap).toHaveBeenCalledTimes(2)
    expect(source.generateMipmaps).toBe(true)
    warn.mockRestore()
  })

  it('honours generator: three', () => {
    const { p, renderer, warn } = make({ options: { generator: 'three' } })
    expect(p.mode).toBe('three')
    expect(renderer.initTexture).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('uses three’s generator for a sky cube it can’t filter', () => {
    const { p, warn } = make({ source: skyCube(200) })
    expect(p.mode).toBe('three')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('exposes three’s first bake once it exists', () => {
    const { p, warn } = make({ webgpu: false })
    expect(p.texture).toBeNull()
    p.markDirty()
    p.tick(0)
    expect(p.texture).toMatchObject({ isPMREMTexture: true })
    warn.mockRestore()
  })
})
