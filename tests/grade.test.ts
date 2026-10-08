import { describe, expect, it } from 'vitest'

import {
  GRADE_AZIMUTH_RES,
  GRADE_ELEVATION_RES,
  GRADE_FORMAT,
  MAX_GRADE_KEYS,
  SkyGrade,
  applyGradeOperator,
  evaluateGradeTexel,
  gradeAzimuthToU,
  gradeElevationToV,
  gradeKeyMatrix,
  gradientGrade,
  horizonToZenith,
  sampleGradient,
  solidSky,
  registerGrade,
  resolveGrade,
  resolveGradeKey,
} from '../src/grade'

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** Largest per-component difference — asserted with `expect(...).toBeLessThan(tol)` at each call. */
function maxDiff(a: number[], b: number[]): number {
  expect(a).toHaveLength(b.length)
  return Math.max(...a.map((v, i) => Math.abs(v - b[i])))
}

describe('SkyGrade keyframes', () => {
  it('an empty keyframe is the identity', () => {
    const grade = new SkyGrade([{ elevation: 10 }])
    for (const [e, az] of [
      [0, 0],
      [45, 90],
      [-30, 180],
      [89, 10],
    ]) {
      const rgb: [number, number, number] = [0.3, 0.5, 0.9]
      grade.apply(rgb, 10, e, az)
      expect(maxDiff(rgb, [0.3, 0.5, 0.9])).toBeLessThan(1e-6)
    }
    expect(maxDiff(gradeKeyMatrix(grade.keys[0]), IDENTITY)).toBeLessThan(1e-6)
  })

  it('keeps keyframes sorted and caps their count', () => {
    const grade = new SkyGrade([{ elevation: 30 }, { elevation: -6 }, { elevation: 5 }])
    expect(grade.keys.map((k) => k.elevation)).toEqual([-6, 5, 30])
    expect(() => new SkyGrade(Array.from({ length: MAX_GRADE_KEYS + 1 }, (_, i) => ({ elevation: i })))).toThrow()
  })

  it('evaluate() finds the segment, eases it and clamps outside the keyed range', () => {
    const grade = new SkyGrade([{ elevation: 0 }, { elevation: 10, ease: 'smooth' }, { elevation: 20 }])
    expect(grade.evaluate(-30)).toMatchObject({ index: 0, fraction: 0 })
    expect(grade.evaluate(50)).toMatchObject({ index: 2, fraction: 0 })
    // Linear segment into key 2.
    expect(grade.evaluate(15).index).toBe(1)
    expect(grade.evaluate(15).fraction).toBeCloseTo(0.5)
    // Smooth segment into key 1: smoothstep(0.25) = 0.15625.
    expect(grade.evaluate(2.5).fraction).toBeCloseTo(0.15625)
    // w addresses slice centres of the fixed-depth table.
    expect(grade.evaluate(10).w).toBeCloseTo(1.5 / MAX_GRADE_KEYS)
  })

  it('interpolates the global operator between keyframes', () => {
    const grade = new SkyGrade([
      { elevation: 0, exposure: 0 },
      { elevation: 10, exposure: 1 },
    ])
    const m = grade.evaluate(5).matrix
    // Halfway between ×1 and ×2 (the table interpolates linearly too).
    expect(
      maxDiff(
        m,
        IDENTITY.map((v) => v * 1.5),
      ),
    ).toBeLessThan(1e-6)
  })

  it('updateKey merges nested fields and notifies listeners', () => {
    const grade = new SkyGrade([{ elevation: 0, zones: { zenith: { color: '#ff0000', amount: 0.5 } } }])
    let calls = 0
    grade.onChange(() => calls++)
    grade.updateKey(0, { zones: { zenith: { brightness: 1 } } })
    const z = grade.keys[0].zones.zenith
    expect(z.amount).toBe(0.5)
    expect(z.brightness).toBe(1)
    expect(z.color.r).toBeCloseTo(1)
    expect(calls).toBe(1)
    expect(grade.revision).toBe(1)
  })

  it('insertKeyAt starts from the interpolated settings', () => {
    const grade = new SkyGrade([
      { elevation: 0, exposure: 0, saturation: 1 },
      { elevation: 20, exposure: 2, saturation: 0 },
    ])
    const key = grade.insertKeyAt(10)
    expect(grade.keys).toHaveLength(3)
    expect(key.exposure).toBeCloseTo(1)
    expect(key.saturation).toBeCloseTo(0.5)
    // Existing key returned, not duplicated.
    expect(grade.insertKeyAt(10.01)).toBe(key)
    expect(grade.keys).toHaveLength(3)
  })

  it('rejects bad input', () => {
    expect(() => resolveGradeKey({} as any)).toThrow(/elevation/)
    expect(() => resolveGradeKey({ elevation: 0, exposure: NaN })).toThrow(/exposure/)
    expect(() => resolveGradeKey({ elevation: 0, ease: 'bounce' as any })).toThrow(/ease/)
  })
})

describe('grade operator', () => {
  it('colorize keeps the channel average and never needs more than 3x on a channel', () => {
    // A bright sunset swapped fully to pure blue: the old luminance-preserving
    // chroma swap needs a blue channel ~14x the luminance here.
    const key = resolveGradeKey({ elevation: 2, zones: { horizon: { color: [0, 0, 1], amount: 1 } } })
    const texel = evaluateGradeTexel(key, 0, 90)
    const rgb: [number, number, number] = [3, 1.5, 0.5]
    applyGradeOperator(rgb, IDENTITY, texel)
    const avgIn = (3 + 1.5 + 0.5) / 3
    expect((rgb[0] + rgb[1] + rgb[2]) / 3).toBeCloseTo(avgIn)
    expect(maxDiff(rgb, [0, 0, 3 * avgIn])).toBeLessThan(1e-6)
  })

  it('is linear without fill (haze is graded by the same operator as sky)', () => {
    const grade = new SkyGrade([
      {
        elevation: 0,
        // In gamut for these inputs: the operator is linear up to its clamp at 0.
        saturation: 1.15,
        temperature: 0.4,
        hue: 12,
        zones: { horizon: { color: '#ff8866', amount: 0.6, brightness: 0.5 }, glow: { color: '#ffee88', amount: 0.4 } },
      },
    ])
    const a: [number, number, number] = [0.2, 0.4, 0.8]
    const b: [number, number, number] = [0.5, 0.3, 0.1]
    const sum: [number, number, number] = [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
    const ga = grade.apply([...a] as any, 0, 5, 20)
    const gb = grade.apply([...b] as any, 0, 5, 20)
    const gs = grade.apply(sum, 0, 5, 20)
    expect(maxDiff(gs, [ga[0] + gb[0], ga[1] + gb[1], ga[2] + gb[2]])).toBeLessThan(1e-5)
  })

  it('fill is added, display-referred, and weighted for haze', () => {
    const grade = new SkyGrade([{ elevation: -12, fill: { zenith: [0, 0, 0.2], horizon: [0, 0, 0.2], intensity: 1 } }])
    const sky = grade.apply([0, 0, 0], -12, 40, 90, { displayScale: 2 })
    expect(maxDiff(sky, [0, 0, 0.4])).toBeLessThan(1e-6)
    const haze = grade.apply([0, 0, 0], -12, 40, 90, { displayScale: 2, fillWeight: 0.25 })
    expect(maxDiff(haze, [0, 0, 0.1])).toBeLessThan(1e-6)
  })

  it('an untouched overlay zone is transparent', () => {
    const key = resolveGradeKey({ elevation: 0, zones: { horizon: { color: '#ff0000', amount: 1 } } })
    // Toward the sun the sunward zone covers the horizon band, but at amount 0
    // it must leave the horizon's colorize alone.
    const toward = evaluateGradeTexel(key, 1, 0)
    const away = evaluateGradeTexel(key, 1, 90)
    expect(maxDiff(toward.colorize, away.colorize)).toBeLessThan(1e-6)
    expect(toward.amount).toBeCloseTo(1)
  })

  it('zones fall where the shape says', () => {
    const key = resolveGradeKey({
      elevation: 0,
      shape: { horizonHeight: 20, glowSize: 10 },
      zones: {
        zenith: { brightness: 1 },
        glow: { brightness: 2 },
        ground: { brightness: -1 },
      },
    })
    expect(Math.log2(evaluateGradeTexel(key, 60, 90).gain)).toBeCloseTo(1) // zenith
    expect(Math.log2(evaluateGradeTexel(key, 1, 90).gain)).toBeLessThan(0.05) // horizon
    expect(Math.log2(evaluateGradeTexel(key, 0.5, 0).gain)).toBeGreaterThan(1.9) // on the sun
    expect(Math.log2(evaluateGradeTexel(key, -10, 90).gain)).toBeCloseTo(-1) // below the horizon
  })
})

describe('bake', () => {
  it('writes one slice per keyframe and identity past them', () => {
    const grade = new SkyGrade([
      { elevation: 0, zones: { zenith: { color: '#3366ff', amount: 1 } } },
      { elevation: 10, fill: { intensity: 0.5 } },
    ])
    const bake = grade.bake()
    const slice = GRADE_AZIMUTH_RES * GRADE_ELEVATION_RES * 4
    expect(bake.colorize).toHaveLength(slice * MAX_GRADE_KEYS)
    expect(bake.keyCount).toBe(2)
    // Top row of slice 0 is the zenith: fully colorized.
    const top = (0 * GRADE_ELEVATION_RES + GRADE_ELEVATION_RES - 1) * GRADE_AZIMUTH_RES * 4
    expect(bake.colorize[top + 3]).toBeCloseTo(1)
    // Slice 2 is unused → identity.
    expect(bake.colorize[2 * slice + 3]).toBe(0)
    expect(bake.fillGain[2 * slice + 3]).toBe(1)
  })

  it('table addressing hits texel centres at the ends and packs toward the horizon', () => {
    expect(gradeAzimuthToU(0)).toBeCloseTo(0.5 / GRADE_AZIMUTH_RES)
    expect(gradeAzimuthToU(180)).toBeCloseTo(1 - 0.5 / GRADE_AZIMUTH_RES)
    expect(gradeElevationToV(-90)).toBeCloseTo(0.5 / GRADE_ELEVATION_RES)
    expect(gradeElevationToV(90)).toBeCloseTo(1 - 0.5 / GRADE_ELEVATION_RES)
    expect(gradeElevationToV(0)).toBeCloseTo(0.5)
    // The first 10° above the horizon get a third of the upper half.
    const rows = (gradeElevationToV(10) - gradeElevationToV(0)) * GRADE_ELEVATION_RES
    expect(rows).toBeGreaterThan(GRADE_ELEVATION_RES / 2 / 3 - 1)
  })
})

describe('save / load', () => {
  it('round-trips through JSON', () => {
    const grade = new SkyGrade({
      name: 'test',
      keys: [
        {
          elevation: -8,
          ease: 'smooth',
          exposure: -0.5,
          zones: { antisun: { color: '#e9a3c9', amount: 0.6, brightness: 0.25 } },
          fill: { zenith: '#0a1530', horizon: '#22335a', intensity: 0.7 },
          ambient: { color: '#4f6fb0', groundColor: '#121a2c', intensity: 0.5 },
        },
        { elevation: 30, hue: 10, shape: { glowSize: 12 } },
      ],
    })
    const text = JSON.stringify(grade)
    const parsed = JSON.parse(text)
    expect(parsed.format).toBe(GRADE_FORMAT)
    const loaded = SkyGrade.fromJSON(text)
    expect(loaded.name).toBe('test')
    expect(JSON.stringify(loaded)).toBe(text)
    expect(loaded.keys[0].ambient?.intensity).toBe(0.5)
    expect(loaded.keys[1].ambient).toBeNull()
    for (const [s, e, a] of [
      [-8, 10, 170],
      [12, 3, 20],
    ]) {
      expect(maxDiff(loaded.apply([0.4, 0.5, 0.7], s, e, a), grade.apply([0.4, 0.5, 0.7], s, e, a))).toBeLessThan(1e-2)
    }
  })

  it('rejects other files and newer versions', () => {
    expect(() => SkyGrade.fromJSON({ format: 'nope' } as any)).toThrow(/format/)
    expect(() => SkyGrade.fromJSON({ format: GRADE_FORMAT, version: 99, keys: [] })).toThrow(/version/)
  })

  it('resolveGrade accepts names, definitions, JSON and instances', () => {
    registerGrade('test-grade', [{ elevation: 0, exposure: 1 }])
    const a = resolveGrade('test-grade')
    const b = resolveGrade('test-grade')
    expect(a).not.toBe(b) // independent instances
    expect(a.keys[0].exposure).toBe(1)
    expect(resolveGrade(a)).toBe(a)
    expect(resolveGrade(JSON.stringify(a)).keys[0].exposure).toBe(1)
    expect(resolveGrade(a.toJSON()).keys[0].exposure).toBe(1)
    expect(() => resolveGrade('missing')).toThrow(/Unknown grade/)
  })
})

describe('ambient', () => {
  it('fades between keyframes, treating a keyframe without one as off', () => {
    const grade = new SkyGrade([
      { elevation: -10, ambient: { color: [0, 0, 1], groundColor: [0, 0, 0], intensity: 1 } },
      { elevation: 10 },
    ])
    expect(grade.hasAmbient).toBe(true)
    expect(grade.evaluate(-20).ambient?.intensity).toBeCloseTo(1)
    expect(grade.evaluate(0).ambient?.intensity).toBeCloseTo(0.5)
    expect(grade.evaluate(0).ambient?.color.b).toBeCloseTo(1)
    expect(grade.evaluate(20).ambient?.intensity).toBeCloseTo(0)
    expect(new SkyGrade([{ elevation: 0 }]).evaluate(0).ambient).toBeNull()
  })
})

describe('gradient layer', () => {
  const srgbToLinear = (hex: string) => {
    const c = resolveGradeKey({ elevation: 0, zones: { zenith: { color: hex } } }).zones.zenith.color
    return [c.r, c.g, c.b]
  }

  it('replace 1 paints exactly the gradient, whatever the physical sky and sun', () => {
    const grade = horizonToZenith('#ffaa66', '#3355cc', { ease: 'linear', height: 60 })
    const top = srgbToLinear('#3355cc')
    for (const sun of [-30, 0, 45]) {
      for (const physical of [
        [0, 0, 0],
        [5, 3, 1],
      ] as [number, number, number][]) {
        expect(maxDiff(grade.apply([...physical] as any, sun, 75, 120), top)).toBeLessThan(1e-6)
      }
    }
    // Halfway up the linear ramp.
    const bottom = srgbToLinear('#ffaa66')
    const mid = bottom.map((v, i) => (v + top[i]) / 2)
    expect(maxDiff(grade.apply([1, 1, 1], 10, 30, 90), mid)).toBeLessThan(1e-6)
  })

  it('replace is display-referred and fades into haze by opacity', () => {
    const grade = solidSky([0.2, 0.3, 0.4])
    expect(maxDiff(grade.apply([9, 9, 9], 0, 20, 0, { displayScale: 2 }), [0.4, 0.6, 0.8])).toBeLessThan(1e-6)
    // Haze: inscatter is replaced too, and the colour arrives in proportion to opacity.
    expect(maxDiff(grade.apply([9, 9, 9], 0, 20, 0, { fillWeight: 0.5 }), [0.1, 0.15, 0.2])).toBeLessThan(1e-6)
  })

  it('amount alone swaps hue and keeps the physical brightness', () => {
    const grade = gradientGrade([{ at: 0, color: [0, 0, 1] }], { amount: 1, replace: 0 })
    const out = grade.apply([3, 1.5, 0.5], 0, 40, 90)
    expect((out[0] + out[1] + out[2]) / 3).toBeCloseTo(5 / 3)
    expect(out[0]).toBeCloseTo(0)
  })

  it('zone brightness also scales a replaced gradient (a glow on a fixed sky)', () => {
    const grade = new SkyGrade([
      {
        elevation: 10,
        gradient: { stops: [{ at: 0, color: [0.1, 0.1, 0.1] }], replace: 1 },
        zones: { glow: { brightness: 1 } },
        shape: { glowSize: 10 },
      },
    ])
    expect(maxDiff(grade.apply([0, 0, 0], 10, 10, 0), [0.2, 0.2, 0.2])).toBeLessThan(1e-6)
    expect(maxDiff(grade.apply([0, 0, 0], 10, 60, 180), [0.1, 0.1, 0.1])).toBeLessThan(1e-6)
  })

  it('stops sort, clamp outside the range and ease per segment', () => {
    const key = resolveGradeKey({
      elevation: 0,
      gradient: {
        stops: [
          { at: 40, color: [1, 1, 1], ease: 'smooth' },
          { at: 0, color: [0, 0, 0] },
        ],
      },
    })
    const stops = key.gradient!.stops
    expect(stops.map((st) => st.at)).toEqual([0, 40])
    expect(sampleGradient(stops, -20)[0]).toBe(0)
    expect(sampleGradient(stops, 80)[0]).toBe(1)
    expect(sampleGradient(stops, 10)[0]).toBeCloseTo(0.15625) // smoothstep(0.25)
    expect(() => resolveGradeKey({ elevation: 0, gradient: { stops: [] } })).toThrow(/stop/)
    expect(() => resolveGradeKey({ elevation: 0, gradient: {} })).toThrow(/stops/)
  })

  it('round-trips through JSON and interpolates between keyframes with different stops', () => {
    const grade = new SkyGrade([
      { elevation: -10, gradient: { stops: [{ at: 0, color: '#203060' }], amount: 0.5, replace: 1 } },
      {
        elevation: 10,
        gradient: {
          stops: [
            { at: 0, color: '#ffb070' },
            { at: 45, color: '#4080e0', ease: 1.5 },
          ],
          replace: 0,
        },
      },
      { elevation: 30 },
    ])
    const loaded = SkyGrade.fromJSON(JSON.stringify(grade))
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(grade))
    expect(loaded.keys[1].gradient!.stops[1].ease).toBe(1.5)
    expect(loaded.keys[2].gradient).toBeNull()

    const mid = resolveGradeKey(grade.interpolatedKeyInput(0))
    expect(mid.gradient!.stops.map((st) => st.at)).toEqual([0, 45])
    expect(mid.gradient!.replace).toBeCloseTo(0.5)
    // Toward a keyframe without a gradient, its amount and replace fade to 0.
    expect(resolveGradeKey(grade.interpolatedKeyInput(20)).gradient!.replace).toBeCloseTo(0)
  })
})
