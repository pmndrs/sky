import { describe, it, expect, vi } from 'vitest'
import { Sky } from '../src/Sky'
import { SkyGrade, MAX_GRADE_KEYS } from '../src/grade'
import { SkyEditorController } from '../src/editor/controller'
import { withPreviewTarget } from '../src/editor/preview'

function makeSky() {
  return new Sky(
    {
      compile() {},
      setRenderTarget() {},
      getRenderTarget: () => null,
      render() {},
      compute() {},
      backend: {},
      hasFeature: () => true,
    },
    { sunDirection: { elevation: 5, azimuth: 270 } },
  )
}

describe('sky editor controller', () => {
  it('opening preserves a physical sky; first edit and undo retain the null assignment', () => {
    const sky = makeSky()
    const before = sky.getSettings()
    const commit = vi.fn()
    const c = new SkyEditorController({ sky, onCommit: commit })
    expect(sky.grade).toBeNull()
    expect(sky.getSettings()).toEqual(before)
    c.edit({ exposure: 0.5 }, false)
    c.edit({ exposure: 1 }, true)
    expect(sky.grade?.keys).toHaveLength(1)
    expect(commit).toHaveBeenCalledOnce()
    c.undo()
    expect(sky.grade).toBeNull()
    expect(c.grade.keys).toHaveLength(0)
    c.redo()
    expect(sky.grade).toBe(c.grade)
    expect(c.grade.keys[0].exposure).toBe(1)
    c.dispose()
    sky.dispose()
  })

  it('groups auto-keying and a slider gesture into one history step', () => {
    const sky = makeSky()
    const grade = sky.setGrade([{ elevation: 0 }, { elevation: 10 }])!
    const c = new SkyEditorController({ sky })
    c.edit({ saturation: 0.8 }, false)
    c.edit({ saturation: 0.5 }, false)
    c.edit({ saturation: 0.4 }, true)
    expect(grade.keys).toHaveLength(3)
    c.undo()
    expect(grade.keys).toHaveLength(2)
    expect(c.canUndo).toBe(false)
    c.redo()
    expect(grade.keys[1].saturation).toBe(0.4)
    expect(sky.grade).toBe(grade)
    c.dispose()
    sky.dispose()
  })

  it('keeps a one-key grade fixed until another key is explicitly inserted', () => {
    const sky = makeSky()
    sky.setGrade([{ elevation: 0 }])
    const c = new SkyEditorController({ sky })
    c.edit({ hue: 30 })
    expect(c.grade.keys).toHaveLength(1)
    expect(c.grade.keys[0].elevation).toBe(0)
    c.addKey()
    expect(c.grade.keys).toHaveLength(2)
    c.dispose()
    sky.dispose()
  })

  it('rejects invalid patches before inserting an auto-key and respects key limits', () => {
    const sky = makeSky()
    sky.setGrade([{ elevation: 0 }, { elevation: 10 }])
    const c = new SkyEditorController({ sky })
    expect(() => c.edit({ hue: NaN })).toThrow(/finite/)
    expect(c.grade.keys).toHaveLength(2)
    c.replace(new SkyGrade(Array.from({ length: MAX_GRADE_KEYS }, (_, i) => ({ elevation: i * 4 - 40 }))))
    const before = c.getGradeJSON()
    expect(() => c.addKey(89)).toThrow(/16/)
    expect(c.getGradeJSON()).toEqual(before)
    c.dispose()
    sky.dispose()
  })

  it('preserves the grade reference through import and undo and rejects invalid imports atomically', () => {
    const sky = makeSky()
    const grade = sky.setGrade([{ elevation: 0 }])!
    const c = new SkyEditorController({ sky })
    const next = new SkyGrade({ name: 'custom', keys: [{ elevation: 12, hue: 55 }] }).toJSON()
    c.loadGrade(next)
    expect(sky.grade).toBe(grade)
    expect(grade.name).toBe('custom')
    expect(() => c.loadGrade({ ...next, version: 99 })).toThrow(/Unsupported/)
    expect(c.getGradeJSON()).toEqual(next)
    c.undo()
    expect(sky.grade).toBe(grade)
    expect(grade.name).toBe('')
    c.dispose()
    sky.dispose()
  })

  it('establishes a new undo baseline after an external edit or replacement', () => {
    const sky = makeSky()
    const grade = sky.setGrade([{ elevation: 0 }])!
    const c = new SkyEditorController({ sky })
    c.edit({ exposure: 1 })
    grade.updateKey(0, { exposure: 2 })
    expect(c.canUndo).toBe(false)
    c.undo()
    expect(grade.keys[0].exposure).toBe(2)
    const replacement = sky.setGrade([{ elevation: 20, hue: 40 }])!
    expect(c.grade).toBe(replacement)
    expect(c.canUndo).toBe(false)
    c.dispose()
    sky.dispose()
  })

  it('exports the authored grade during comparison and never restores over a host replacement', () => {
    const sky = makeSky()
    const grade = sky.setGrade([{ elevation: 0, hue: 20 }])!
    const c = new SkyEditorController({ sky })
    c.setBypass(true)
    expect(sky.grade).toBeNull()
    expect(c.getGradeJSON()).toEqual(grade.toJSON())
    grade.updateKey(0, { hue: 25 })
    expect(c.canUndo).toBe(false)
    const replacement = sky.setGrade([{ elevation: 10, hue: 50 }])!
    expect(c.bypass).toBe(false)
    c.dispose()
    expect(sky.grade).toBe(replacement)
    sky.dispose()
  })

  it('restores its own comparison on dispose and releases host sun control exactly once', () => {
    const sky = makeSky()
    const grade = sky.setGrade([{ elevation: 0 }])!
    const release = vi.fn()
    const acquire = vi.fn(() => release)
    const c = new SkyEditorController({ sky, acquireSunControl: acquire })
    c.setTime(12)
    c.setTime(13)
    c.setBypass(true)
    c.dispose()
    c.dispose()
    expect(acquire).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(sky.grade).toBe(grade)
    expect(sky.state).toBe('detached')
    sky.dispose()
  })

  it('does not resurrect a compared grade when the host explicitly clears the physical sky', () => {
    const sky = makeSky()
    sky.setGrade([{ elevation: 0 }])
    const c = new SkyEditorController({ sky })
    c.setBypass(true)
    sky.setGrade(null)
    expect(c.bypass).toBe(false)
    c.dispose()
    expect(sky.grade).toBeNull()
    sky.dispose()
  })

  it('respects refused sun control and stops playback when following the app', () => {
    const sky = makeSky()
    const before = sky.getSettings()
    const refused = new SkyEditorController({ sky, acquireSunControl: () => false })
    expect(() => refused.setTime(4)).toThrow(/application controls/)
    expect(sky.getSettings()).toEqual(before)
    refused.dispose()
    const c = new SkyEditorController({ sky })
    c.togglePlayback()
    c.update(0.1)
    expect(c.settings.sun.mode).toBe('time')
    expect(c.settings.sun.timeOfDay).toBeCloseTo(before.sun.timeOfDay + 0.1)
    c.followApp()
    c.update(0.1)
    expect(c.settings.sun.timeOfDay).toBeCloseTo(before.sun.timeOfDay + 0.1)
    c.dispose()
    sky.dispose()
  })

  it('coalesces physical edits per frame without editing the grade', () => {
    const sky = makeSky()
    const c = new SkyEditorController({ sky })
    const apply = vi.spyOn(sky, 'setTurbidity')
    c.queueSetting('turbidity', () => sky.setTurbidity(2))
    c.queueSetting('turbidity', () => sky.setTurbidity(3))
    c.update(0)
    expect(apply).toHaveBeenCalledOnce()
    expect(c.settings.turbidity).toBe(3)
    expect(sky.grade).toBeNull()
    c.dispose()
    sky.dispose()
  })

  it('handles a disposed sky without reading freed uniforms or disposing host resources twice', () => {
    const sky = makeSky()
    const c = new SkyEditorController({ sky })
    c.queueSetting('exposure', () => sky.setExposure(2))
    sky.dispose()
    expect(() => c.update(0.1)).not.toThrow()
    expect(c.unavailable).toBe(true)
    expect(() => c.dispose()).not.toThrow()
  })
})

describe('settings readback', () => {
  it('returns detached coefficients and distinguishes solar time from manual direction', () => {
    const sky = makeSky()
    sky.setTurbidity(3)
    const settings = sky.getSettings()
    expect(settings.sun.mode).toBe('manual')
    expect(settings.atmosphere.mieScattering[0]).toBeCloseTo(settings.baseMie.scattering[0] * 3)
    settings.atmosphere.mieScattering[0] = 999
    settings.baseMie.scattering[0] = 888
    expect(sky.getSettings().atmosphere.mieScattering[0]).not.toBe(999)
    expect(sky.getSettings().baseMie.scattering[0]).not.toBe(888)
    sky.setTimeOfDay(14)
    expect(sky.getSettings().sun.mode).toBe('time')
    sky.setNorth(90)
    expect(sky.getSettings().sun.mode).toBe('time')
    sky.setSunDirection({ elevation: 10, azimuth: 20, raw: true })
    sky.setNorth(180)
    expect(sky.getSettings().sun.mode).toBe('manual')
    expect(sky.getSettings().sun.raw).toBe(true)
    sky.dispose()
  })
})

describe('editor rendering guard', () => {
  it('restores canvas, render target, MRT and clear flags even when the draw fails', () => {
    let canvas: any = { name: 'host' }
    let target: any = { name: 'host-target' }
    let mrt: any = { name: 'gbuffer' }
    const host = canvas,
      hostTarget = target,
      hostMRT = mrt
    const renderer = {
      autoClear: false,
      autoClearColor: false,
      autoClearDepth: false,
      autoClearStencil: false,
      getCanvasTarget: () => canvas,
      setCanvasTarget: (value: any) => {
        canvas = value
      },
      getRenderTarget: () => target,
      setRenderTarget: vi.fn((value: any) => {
        target = value
      }),
      getMRT: () => mrt,
      setMRT: (value: any) => {
        mrt = value
      },
      getActiveCubeFace: () => 2,
      getActiveMipmapLevel: () => 3,
    }
    expect(() =>
      withPreviewTarget(renderer, {}, () => {
        expect(target).toBeNull()
        expect(mrt).toBeNull()
        throw new Error('draw failed')
      }),
    ).toThrow('draw failed')
    expect(canvas).toBe(host)
    expect(target).toBe(hostTarget)
    expect(mrt).toBe(hostMRT)
    expect(renderer.autoClear).toBe(false)
    expect(renderer.autoClearColor).toBe(false)
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(hostTarget, 2, 3)
  })
})
