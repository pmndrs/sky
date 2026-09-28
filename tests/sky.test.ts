import { describe, expect, it, vi } from 'vitest'

import { Color, Scene } from 'three/webgpu'

import { Sky } from '../src/Sky'
import { looks } from '../src/looks'

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

  it('throws on use after dispose()', () => {
    const sky = new Sky(mockRenderer())
    sky.dispose()
    expect(() => sky.attach(new Scene())).toThrow(/disposed/)
    expect(() => sky.update(null)).toThrow(/disposed/)
    expect(() => sky.setTimeOfDay(6)).toThrow(/disposed/)
    expect(() => sky.baker).toThrow(/disposed/)
    expect(() => sky.createGroundedSkybox()).toThrow(/disposed/)
    return expect(sky.enableStars()).rejects.toThrow(/disposed/)
  })

  it('setTurbidity is absolute: 0 then 1 restores the Mie coefficients', () => {
    const sky = new Sky(mockRenderer())
    const base = sky.baker.atmosphereParams.mieScattering.clone()

    sky.setTurbidity(0)
    expect(sky.baker.atmosphereParams.mieScattering.length()).toBe(0)
    sky.setTurbidity(1)
    expect(sky.baker.atmosphereParams.mieScattering.x).toBeCloseTo(base.x, 12)
    sky.setTurbidity(2)
    expect(sky.baker.atmosphereParams.mieScattering.x).toBeCloseTo(base.x * 2, 12)

    sky.dispose()
  })

  it('setPreset resets the turbidity baseline so a later setTurbidity scales the preset, not stale values', () => {
    const sky = new Sky(mockRenderer())
    sky.setTurbidity(2)
    sky.setPreset('earth')
    const earthMie = sky.baker.atmosphereParams.mieScattering.clone()
    sky.setTurbidity(1)
    expect(sky.baker.atmosphereParams.mieScattering.x).toBeCloseTo(earthMie.x, 12)
    sky.dispose()
  })

  it('setNorth keeps a raw sun direction raw', () => {
    const sky = new Sky(mockRenderer())
    sky.setSunDirection({ elevation: 20, azimuth: 45, raw: true })
    const before = sky.baker._sunVec.clone()
    sky.setNorth('-Z') // offset 180° — must not be applied to a raw azimuth
    expect(sky.baker._sunVec.x).toBeCloseTo(before.x, 9)
    expect(sky.baker._sunVec.z).toBeCloseTo(before.z, 9)
    sky.dispose()
  })

  it('haze setters work before applyHaze by creating the uniforms', () => {
    const sky = new Sky(mockRenderer())
    sky.setHazeStrength(0.4)
    sky.setHazePolicy('raymarch')
    sky.setHazeAltitudeBlend({ startKm: 5, endKm: 9 })
    expect(sky._hazeStrength.value).toBe(0.4)
    expect(sky._hazeRaymarchOnly.value).toBe(1)
    expect(sky._hazeAltStart.value).toBe(5)
    expect(sky._hazeAltEnd.value).toBe(9)
    sky.dispose()
  })

  it('SkyMoon.setDiscColor accepts a Color without producing NaN', () => {
    const sky = new Sky(mockRenderer())
    const moon = sky.createMoon()
    moon.setDiscColor(new Color(0.2, 0.4, 0.6))
    const v = sky.mesh.moonColor.value
    expect([v.x, v.y, v.z]).toEqual([0.2, 0.4, 0.6])
    sky.dispose()
  })

  it('setAtmosphereParams updates sunAngularRadius on the sky mesh', () => {
    const sky = new Sky(mockRenderer())
    const testRadius = 0.01
    const expectedCos = Math.cos(testRadius)

    sky.baker.setAtmosphereParams({ sunAngularRadius: testRadius })

    expect(sky.baker.sky.sunDiscCos.value).toBeCloseTo(expectedCos, 5)

    sky.dispose()
  })

  it('setPreset keeps a caller-configured sun disc and rim softness', () => {
    const sky = new Sky(mockRenderer())
    sky.setSunDisc({ angularDiameter: 0.02, edgeSoftness: 0.4 })
    const cosOuter = sky.baker.sky.sunDiscCos.value
    const cosInner = sky.baker.sky.sunDiscCosInner.value
    // The preset carries the unchanged default radius; it must not reset the disc.
    sky.setPreset('earth')
    expect(sky.baker.sky.sunDiscCos.value).toBe(cosOuter)
    expect(sky.baker.sky.sunDiscCosInner.value).toBe(cosInner)
    // A radius-only change keeps the configured softness.
    sky.baker.setAtmosphereParams({ sunAngularRadius: 0.01 })
    expect(sky.baker.sky.sunDiscCosInner.value).toBeCloseTo(Math.cos(0.01 * 0.6), 12)
    sky.dispose()
  })

  it('setLookTrack overrides survive sun changes and leave the registry untouched', () => {
    const sky = new Sky(mockRenderer())
    sky.setLookTrack('ghibli', { chroma: 0.2, value: 0.9 })
    const u = sky.mesh.lookUniforms
    expect(u.chroma.value).toBeCloseTo(0.2, 9)
    expect(u.value.value).toBeCloseTo(0.9, 9)
    sky.setTimeOfDay(19) // re-samples the track
    expect(u.chroma.value).toBeCloseTo(0.2, 9)
    expect(u.value.value).toBeCloseTo(0.9, 9)
    // the built-in look objects the track references are not mutated
    expect(looks['ghibli-day'].chroma).toBe(0.7)
    sky.setLookTrack('ghibli') // no overrides → keyframe values again
    expect(u.chroma.value).toBeCloseTo(0.7, 9)
    sky.dispose()
  })
})
