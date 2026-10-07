import { describe, expect, it, vi } from 'vitest'

import { SkyAtmosphereBaker } from '../src/sky/SkyAtmosphereBaker'

// Minimal renderer surface for constructing a baker in node — mirrors the
// helper in tests/sky.test.ts (the same shape already proven sufficient to
// construct `Sky`, which constructs the same `SkyAtmosphereBaker`).
// Stateful for the MRT / render-target bookkeeping the internal draws do.
function mockRenderer(): any {
  const r = {
    mrt: null as any,
    target: null as any,
    face: 0,
    mip: 0,
    xr: { enabled: true },
    compile() {},
    setRenderTarget: vi.fn((target: any, face = 0, mip = 0) => {
      r.target = target
      r.face = face
      r.mip = mip
    }),
    getRenderTarget: () => r.target,
    getActiveCubeFace: () => r.face,
    getActiveMipmapLevel: () => r.mip,
    setMRT: vi.fn((mrt: any) => {
      r.mrt = mrt
    }),
    getMRT: () => r.mrt,
    render() {},
    compute() {},
    backend: {},
    hasFeature() {
      return true
    },
  }
  return r
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

describe('SkyAtmosphereBaker renderer-state isolation (issue #36)', () => {
  // Stand-ins for a caller mid-frame: a G-buffer MRT and its own target.
  const callerMRT = { isMRTNode: true, name: 'beauty+normal' }
  const callerTarget = { name: 'caller target' }

  function bakerUnderCallerState() {
    const renderer = mockRenderer()
    const baker = new SkyAtmosphereBaker(renderer)
    stubRenderStages(baker)
    renderer.setMRT(callerMRT)
    renderer.setRenderTarget(callerTarget, 2, 1)
    renderer.setMRT.mockClear()
    renderer.setRenderTarget.mockClear()
    return { renderer, baker }
  }

  function expectCallerStateRestored(renderer: any) {
    expect(renderer.getMRT()).toBe(callerMRT)
    expect(renderer.getRenderTarget()).toBe(callerTarget)
    expect(renderer.getActiveCubeFace()).toBe(2)
    expect(renderer.getActiveMipmapLevel()).toBe(1)
  }

  it('a dirty update captures the cube and filters the PMREM with no MRT, then restores the caller state', () => {
    const { renderer, baker } = bakerUnderCallerState()
    const seen: Record<string, any> = {}
    vi.mocked(baker.cubeCamera.update).mockImplementation(() => {
      seen.cubeMRT = renderer.getMRT()
      renderer.setRenderTarget(baker.cubeRenderTarget, 5, 0) // as a capture leaves it mid-way
    })
    vi.mocked(baker.pmremGenerator.fromCubemap).mockImplementation(() => {
      seen.pmremMRT = renderer.getMRT()
      return { texture: {}, dispose() {} } as any
    })

    baker.setSun({ elevation: 30, azimuth: 120 })
    baker.update()

    expect(baker.cubeCamera.update).toHaveBeenCalledTimes(1)
    expect(baker.pmremGenerator.fromCubemap).toHaveBeenCalledTimes(1)
    expect(seen.cubeMRT).toBeNull()
    expect(seen.pmremMRT).toBeNull()
    expectCallerStateRestored(renderer)
    expect(baker.cubeDirty).toBe(false)
  })

  it('an idle update leaves the caller MRT and render target untouched', () => {
    const { renderer, baker } = bakerUnderCallerState()
    baker.update() // construction-time bake
    renderer.setMRT.mockClear()
    renderer.setRenderTarget.mockClear()
    vi.mocked(baker.cubeCamera.update).mockClear()

    baker.update()

    expect(baker.cubeCamera.update).not.toHaveBeenCalled()
    expect(renderer.setMRT).not.toHaveBeenCalled()
    expect(renderer.setRenderTarget).not.toHaveBeenCalled()
    expectCallerStateRestored(renderer)
  })

  it('a throwing cube capture restores renderer state and sky uniforms, stays dirty, and retries', () => {
    const { renderer, baker } = bakerUnderCallerState()
    baker.update() // construction-time bake

    const sky = baker.sky
    sky.showSunDisc.value = 1
    sky.showMoonDisc.value = 1
    sky.mirrorBelowHorizon.value = 0
    baker.setMirrorBelowHorizon(true)
    baker.setSun({ elevation: 10, azimuth: 200 })

    const capture = vi.mocked(baker.cubeCamera.update)
    capture.mockImplementationOnce(() => {
      // What a CubeCamera.update that throws on its fourth face leaves behind.
      renderer.xr.enabled = false
      baker.cubeRenderTarget.texture.generateMipmaps = false
      renderer.setRenderTarget(baker.cubeRenderTarget, 3, 0)
      throw new Error('device lost')
    })

    expect(() => baker.update()).toThrow('device lost')

    expectCallerStateRestored(renderer)
    expect(renderer.xr.enabled).toBe(true)
    expect(baker.cubeRenderTarget.texture.generateMipmaps).toBe(true)
    expect(sky.showSunDisc.value).toBe(1)
    expect(sky.showMoonDisc.value).toBe(1)
    expect(sky.mirrorBelowHorizon.value).toBe(0)
    expect(baker.sunDirty).toBe(true)
    expect(baker.cubeDirty).toBe(true)

    // The retry runs the capture again, with the bake-only overrides in force.
    let bakeState: number[] = []
    capture.mockImplementation(() => {
      bakeState = [sky.showSunDisc.value, sky.showMoonDisc.value, sky.mirrorBelowHorizon.value]
    })
    capture.mockClear()

    baker.update()

    expect(capture).toHaveBeenCalledTimes(1)
    expect(bakeState).toEqual([0, 0, 1])
    expect(baker.sunDirty).toBe(false)
    expect(baker.cubeDirty).toBe(false)
    expectCallerStateRestored(renderer)
    expect(sky.showSunDisc.value).toBe(1)
  })
})

describe('SkyAtmosphereBaker.compileAsync (issue #49)', () => {
  /** The mock above, plus what three's state save/restore and compileAsync touch. */
  function compilingRenderer() {
    const r: any = mockRenderer()
    Object.assign(r, {
      depth: true,
      stencil: false,
      toneMapping: 0,
      toneMappingExposure: 1,
      outputColorSpace: 'srgb',
      autoClear: true,
      getRenderObjectFunction: () => null,
      setRenderObjectFunction() {},
      getPixelRatio: () => 1,
      setPixelRatio() {},
      getClearColor: (c: any) => c,
      getClearAlpha: () => 1,
      setClearColor() {},
      getScissorTest: () => false,
      setScissorTest() {},
      init: vi.fn(async () => {}),
      compiled: [] as any[],
      compileAsync: vi.fn(async (object: any) => {
        r.compiled.push({ object, target: r.target, depth: r.depth, stencil: r.stencil, mrt: r.mrt })
      }),
    })
    return r
  }

  it('compiles each LUT pass and the cube capture against its own target, keyed by that target', async () => {
    const r = compilingRenderer()
    const baker = new SkyAtmosphereBaker(r, { enableAerialPerspective: false })
    const callerMrt = { mrt: true }
    const callerTarget = { caller: true }
    r.mrt = callerMrt
    r.target = callerTarget

    await baker.compileAsync()

    expect(r.init).toHaveBeenCalled()
    const targets = r.compiled.map((c: any) => c.target)
    expect(targets).toEqual([
      baker.transmittanceLUT.renderTarget,
      baker.multiScatterLUT.renderTarget,
      baker.skyViewLUT.renderTarget,
      baker.cubeRenderTarget,
    ])
    for (const c of r.compiled) {
      // three's compileAsync reads renderer.depth / .stencil where render()
      // reads the target's; they must agree or the draw recompiles.
      expect(c.depth).toBe(c.target.depthBuffer)
      expect(c.stencil).toBe(c.target.stencilBuffer)
      // Never under the caller's MRT.
      expect(c.mrt).toBeNull()
    }
    expect(r.compiled[3].object).toBe(baker.skyScene)
    // The caller's state is back.
    expect(r.mrt).toBe(callerMrt)
    expect(r.target).toBe(callerTarget)
    expect(r.depth).toBe(true)
    expect(r.stencil).toBe(false)
  })

  it('compiles the aerial-perspective compute pass too', async () => {
    const r = compilingRenderer()
    r.compileComputeAsync = vi.fn(async () => {})
    const baker = new SkyAtmosphereBaker(r, { enableAerialPerspective: true })
    await baker.compileAsync()
    expect(r.compileComputeAsync).toHaveBeenCalledWith((baker.aerialPerspectiveLUT as any)._compute)
  })
})
