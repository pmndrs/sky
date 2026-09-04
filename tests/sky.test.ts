import { describe, expect, it, vi } from 'vitest'

import { Scene } from 'three/webgpu'

import { Sky } from '../src/Sky'

// Controllable stand-in for the HDR loader `enableStars({ url })` imports lazily.
const loader = vi.hoisted(() => ({ onLoad: undefined as undefined | ((tex: any) => void) }))
vi.mock('three/addons/loaders/RGBELoader.js', () => ({
  RGBELoader: class {
    setDataType() {}
    load(_url: string, onLoad: (tex: any) => void) {
      loader.onLoad = onLoad
    }
  },
}))

// Minimal renderer surface for constructing and disposing a Sky in node.
function mockRenderer(): any {
  return {
    compile() {},
    setRenderTarget() {},
    getRenderTarget() {
      return null
    },
    render() {},
    compute() {},
    backend: {},
    hasFeature() {
      return true
    },
  }
}

describe('Sky', () => {
  it('derives detached and attached state from the current scene', () => {
    const sky = new Sky(mockRenderer())
    const scene = new Scene()

    expect(sky.state).toBe('detached')
    sky.attach(scene)
    expect(sky.state).toBe('attached')
    sky.detach()
    expect(sky.state).toBe('detached')

    sky.dispose()
  })

  it('dispose() detaches from the scene and can be called more than once', () => {
    const sky = new Sky(mockRenderer())
    const scene = new Scene()
    sky.attach(scene)
    expect(scene.background).toBe(sky.texture)

    sky.dispose()
    expect(sky.state).toBe('disposed')
    expect(scene.background).toBeNull()
    expect(scene.environment).toBeNull()
    expect(() => sky.dispose()).not.toThrow()
  })

  it('enters the terminal state before disposing GPU resources', () => {
    const sky = new Sky(mockRenderer())
    const disposeBaker = vi.spyOn(sky._baker, 'dispose').mockImplementation(() => {
      expect(sky.state).toBe('disposed')
      expect(() => sky.dispose()).not.toThrow()
    })

    sky.dispose()
    expect(disposeBaker).toHaveBeenCalledOnce()
  })

  it('frees an HDR that finishes loading after dispose() and resolves quietly', async () => {
    const sky = new Sky(mockRenderer())
    const pending = sky.enableStars({ url: 'stars.hdr' })
    await vi.waitFor(() => expect(loader.onLoad).toBeDefined(), { timeout: 5000 })
    sky.dispose()

    const texture = { dispose: vi.fn() }
    loader.onLoad!(texture)
    await expect(pending).resolves.toBeDefined()
    expect(texture.dispose).toHaveBeenCalledOnce()
  })

  it('throws on use after dispose()', () => {
    const sky = new Sky(mockRenderer())
    sky.dispose()
    expect(() => sky.attach(new Scene())).toThrow(/disposed/)
    expect(() => sky.update(null)).toThrow(/disposed/)
    expect(() => sky.setTimeOfDay(6)).toThrow(/disposed/)
    expect(() => sky.baker).toThrow(/disposed/)
    expect(() => sky.createGroundedSkybox()).toThrow(/disposed/)
  })
})
