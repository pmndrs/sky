import { describe, expect, it } from 'vitest'

import { Box3, DirectionalLight, Vector3 } from 'three/webgpu'

import { Sky } from '../src/Sky'
import {
  HAZE_SHADOW_DEFAULTS,
  createHazeShadowState,
  disposeHazeShadowState,
  resolveShadowLight,
  updateHazeShadowState,
} from '../src/sky/hazeShadows'

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

describe('haze shadows state', () => {
  it('seeds the documented defaults', () => {
    const state = createHazeShadowState({ light: new DirectionalLight() })
    expect(state.samples.value).toBe(HAZE_SHADOW_DEFAULTS.samples)
    expect(state.maxDistance.value).toBe(HAZE_SHADOW_DEFAULTS.maxDistance)
    expect(state.strength.value).toBe(HAZE_SHADOW_DEFAULTS.strength)
    expect(state.resolution).toBe(HAZE_SHADOW_DEFAULTS.resolution)
    disposeHazeShadowState(state)
  })

  it('accepts a DirectionalLight or anything wrapping one as .light, and rejects the rest', () => {
    const light = new DirectionalLight()
    expect(resolveShadowLight(light)).toBe(light)
    expect(resolveShadowLight({ light })).toBe(light)
    expect(resolveShadowLight(null)).toBeNull()
    expect(() => resolveShadowLight({})).toThrow(/DirectionalLight/)
  })

  it('applies partial updates and clamps samples / resolution', () => {
    const state = createHazeShadowState({ light: new DirectionalLight() })
    updateHazeShadowState(state, { samples: 7.6, strength: 2 })
    expect(state.samples.value).toBe(8)
    expect(state.strength.value).toBe(2)
    expect(state.maxDistance.value).toBe(HAZE_SHADOW_DEFAULTS.maxDistance)
    updateHazeShadowState(state, { samples: 0, resolution: 4 })
    expect(state.samples.value).toBe(1)
    expect(state.resolution).toBe(1)
    updateHazeShadowState(state, { resolution: 0 })
    expect(state.resolution).toBe(0.125)
    disposeHazeShadowState(state)
  })
})

describe('Sky.setHazeShadows', () => {
  it('creates the state before applyHaze, takes a SkySun, and is dropped on dispose', () => {
    const sky = new Sky(mockRenderer())
    const sun = sky.createSun()
    sky.setHazeShadows({ light: sun, samples: 16, maxDistance: 5000 })
    expect(sky._hazeShadow?.light).toBe(sun.light)
    expect(sky._hazeShadow?.samples.value).toBe(16)
    expect(sky._hazeShadow?.maxDistance.value).toBe(5000)
    sky.setHazeShadows({ strength: 0 })
    expect(sky._hazeShadow?.strength.value).toBe(0)
    expect(sky._hazeShadow?.samples.value).toBe(16)
    sun.dispose()
    sky.dispose()
    expect(sky._hazeShadow).toBeUndefined()
  })
})

describe('SkySun.fitShadowToBox', () => {
  it('encloses the box in the light frame on the first call, before any shadow render', () => {
    const sky = new Sky(mockRenderer(), { sunDirection: { elevation: 15, azimuth: 262 } })
    const sun = sky.createSun()
    const box = new Box3(new Vector3(-4000, 0, -5000), new Vector3(12000, 2400, 5000))
    sun.fitShadowToBox(box)

    // Every corner must land inside the orthographic frustum the fit produced.
    const cam = sun.light.shadow.camera
    cam.updateMatrixWorld()
    const corners = [box.min, box.max].flatMap((a) =>
      [box.min, box.max].flatMap((b) => [box.min, box.max].map((c) => new Vector3(a.x, b.y, c.z))),
    )
    for (const corner of corners) {
      const p = corner.clone().applyMatrix4(cam.matrixWorldInverse)
      expect(p.x).toBeGreaterThanOrEqual(cam.left - 1e-3)
      expect(p.x).toBeLessThanOrEqual(cam.right + 1e-3)
      expect(p.y).toBeGreaterThanOrEqual(cam.bottom - 1e-3)
      expect(p.y).toBeLessThanOrEqual(cam.top + 1e-3)
      expect(-p.z).toBeGreaterThanOrEqual(cam.near - 1e-3)
      expect(-p.z).toBeLessThanOrEqual(cam.far + 1e-3)
    }
    sun.dispose()
    sky.dispose()
  })
})
