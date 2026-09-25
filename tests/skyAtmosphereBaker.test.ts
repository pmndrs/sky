import { describe, expect, it, vi } from 'vitest'

import { SkyAtmosphereBaker } from '../src/sky/SkyAtmosphereBaker'

// Minimal renderer surface for constructing a baker in node — mirrors the
// helper in tests/sky.test.ts (the same shape already proven sufficient to
// construct `Sky`, which constructs the same `SkyAtmosphereBaker`).
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

/**
 * Stub the actual GPU work `update()` would otherwise perform, so these
 * tests exercise only the dirty-flag control flow (what setSun /
 * setAtmosphereParams early-out is about), not the LUT/cube/PMREM render
 * pipeline itself.
 */
function stubRenderStages(baker: SkyAtmosphereBaker) {
  vi.spyOn(baker.transmittanceLUT, 'render').mockImplementation(() => {})
  vi.spyOn(baker.multiScatterLUT, 'render').mockImplementation(() => {})
  vi.spyOn(baker.skyViewLUT, 'render').mockImplementation(() => {})
  vi.spyOn(baker.cubeCamera, 'update').mockImplementation(() => {})
  vi.spyOn(baker.pmremGenerator, 'fromCubemap').mockImplementation(() => ({ texture: {}, dispose() {} }) as any)
}

describe('SkyAtmosphereBaker structural early-outs (issue #12)', () => {
  it('setSun() applies on the first call even though last-applied state starts unset', () => {
    const baker = new SkyAtmosphereBaker(mockRenderer())
    const listener = vi.fn()
    baker.addSunListener(listener)

    baker.setSun({ elevation: 45, azimuth: 180 })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(baker.sunDirty).toBe(true)
  })

  it('setSun() early-outs on a repeated identical value; sunDirty is not re-set after update()', () => {
    const baker = new SkyAtmosphereBaker(mockRenderer())
    stubRenderStages(baker)

    baker.setSun({ elevation: 20, azimuth: 90 })
    expect(baker.sunDirty).toBe(true)

    baker.update()
    expect(baker.sunDirty).toBe(false)

    // A freshly-allocated object with the same values (the React
    // `sunDirection={{...}}` case) must not re-dirty the pipeline.
    const listener = vi.fn()
    baker.addSunListener(listener)
    baker.setSun({ elevation: 20, azimuth: 90 })

    expect(baker.sunDirty).toBe(false)
    expect(baker.cubeDirty).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('setSun() still applies (and re-dirties) a genuinely different value', () => {
    const baker = new SkyAtmosphereBaker(mockRenderer())
    stubRenderStages(baker)

    baker.setSun({ elevation: 20, azimuth: 90 })
    baker.update()
    expect(baker.sunDirty).toBe(false)

    baker.setSun({ elevation: 21, azimuth: 90 })
    expect(baker.sunDirty).toBe(true)
  })

  it('setAtmosphereParams() with identical values leaves atmosDirty false', () => {
    const baker = new SkyAtmosphereBaker(mockRenderer())
    stubRenderStages(baker)

    // Clear the construction-time dirty flags first.
    baker.update()
    expect(baker.atmosDirty).toBe(false)

    const current = baker.atmosphereParams

    // Numbers compared by `===`, and a Vector3 field supplied as a plain
    // `{x,y,z}` (a fresh object every call, as an inline React
    // `atmosphere={{...}}` prop would produce) compared by `.equals()`.
    baker.setAtmosphereParams({
      miePhaseG: current.miePhaseG,
      groundAlbedo: { x: current.groundAlbedo.x, y: current.groundAlbedo.y, z: current.groundAlbedo.z },
    })

    expect(baker.atmosDirty).toBe(false)
    expect(baker.cubeDirty).toBe(false)
    // Identity is allowed to change internally, but the merged value must
    // still compare equal.
    expect(baker.atmosphereParams.miePhaseG).toBe(current.miePhaseG)
    expect(baker.atmosphereParams.groundAlbedo.equals(current.groundAlbedo)).toBe(true)
  })

  it('setAtmosphereParams() with a genuine change still marks atmosDirty', () => {
    const baker = new SkyAtmosphereBaker(mockRenderer())
    stubRenderStages(baker)
    baker.update()
    expect(baker.atmosDirty).toBe(false)

    baker.setAtmosphereParams({ miePhaseG: baker.atmosphereParams.miePhaseG + 0.1 })

    expect(baker.atmosDirty).toBe(true)
    expect(baker.cubeDirty).toBe(true)
  })
})
