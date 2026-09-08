import { it, expect, describe } from 'vitest'

import { Color } from 'three/webgpu'

import {
  MAX_LOOK_STOPS,
  applyEase,
  createLookTrack,
  evaluatePackedRamp,
  lerpLooks,
  looks,
  lookTracks,
  packLook,
  registerLook,
  registerLookTrack,
  resolveLook,
  resolveLookTrack,
  sampleLook,
  sampleLookTrack,
} from '../src/looks'

const RAMP = [
  { at: 0, color: [0, 0, 0] },
  { at: 1, color: [1, 1, 1] },
]

describe('resolveLook', () => {
  it('normalizes stops, sorting them by elevation and filling defaults', () => {
    const look = resolveLook({
      stops: [
        { at: 1, color: [0.2, 0.4, 0.6] },
        { at: -1, color: [0, 0, 0] },
      ],
    })

    expect(look.stops.map((s) => s.at)).toEqual([-1, 1])
    // Default is a pure chroma grade: swap hue, keep physical luminance.
    expect(look.chroma).toBe(1)
    expect(look.value).toBe(0)
    expect(look.sunTint).toBeNull()
  })

  it('treats string and hex colors as sRGB but component forms as linear', () => {
    const fromHex = resolveLook({ stops: [{ at: 0, color: '#808080' }] })
    const fromArray = resolveLook({ stops: [{ at: 0, color: [0.5, 0.5, 0.5] }] })

    expect(fromArray.stops[0].color.r).toBe(0.5)
    expect(fromHex.stops[0].color.r).toBe(new Color('#808080').r)
  })

  it('inherits from a registered preset and applies field overrides', () => {
    registerLook('test-base', { stops: RAMP, chroma: 0.5, value: 0.25 })

    const derived = resolveLook({ preset: 'test-base', chroma: 0.9 })

    expect(derived.chroma).toBe(0.9)
    expect(derived.value).toBe(0.25)
    expect(derived.stops).toHaveLength(2)
  })

  it('round-trips an already-resolved look without re-converting colors', () => {
    const once = resolveLook({ stops: [{ at: 0, color: '#808080' }] })
    const twice = resolveLook(once)

    expect(twice).toBe(once)
    expect(twice.stops[0].color.r).toBe(once.stops[0].color.r)
  })

  it('rejects unknown names, missing stops, and bad easing', () => {
    expect(() => resolveLook('nope')).toThrow(/Unknown look: "nope"/)
    expect(() => resolveLook({ chroma: 1 })).toThrow(/needs `stops`/)
    expect(() => resolveLook({ stops: [{ at: 0, color: 'red', ease: -2 }] })).toThrow(/Invalid look ease/)
    expect(() => resolveLook({ stops: [{ at: NaN, color: 'red' }] })).toThrow(/must be a number/)
  })

  it('rejects more stops than the shader can hold', () => {
    const tooMany = Array.from({ length: MAX_LOOK_STOPS + 1 }, (_, i) => ({ at: i / 8, color: [0, 0, 0] }))
    expect(() => resolveLook({ stops: tooMany })).toThrow(/at most 8 stops/)
  })
})

describe('sampleLook', () => {
  const look = resolveLook({ stops: RAMP })

  it('clamps outside the stop range rather than extrapolating', () => {
    expect(sampleLook(look, -5).r).toBe(0)
    expect(sampleLook(look, 5).r).toBe(1)
  })

  it('interpolates linearly between stops by default', () => {
    expect(sampleLook(look, 0.25).r).toBeCloseTo(0.25, 6)
    expect(sampleLook(look, 0.5).r).toBeCloseTo(0.5, 6)
  })

  it('applies per-stop easing to the segment entering that stop', () => {
    const smooth = resolveLook({
      stops: [
        { at: 0, color: [0, 0, 0] },
        { at: 1, color: [1, 1, 1], ease: 'smooth' },
      ],
    })
    const powered = resolveLook({
      stops: [
        { at: 0, color: [0, 0, 0] },
        { at: 1, color: [1, 1, 1], ease: 2 },
      ],
    })

    // smoothstep(0.25) = 0.15625; pow(0.25, 2) = 0.0625
    expect(sampleLook(smooth, 0.25).r).toBeCloseTo(0.15625, 6)
    expect(sampleLook(powered, 0.25).r).toBeCloseTo(0.0625, 6)
    // Midpoint is a fixed point of smoothstep but not of the power curve.
    expect(sampleLook(smooth, 0.5).r).toBeCloseTo(0.5, 6)
    expect(sampleLook(powered, 0.5).r).toBeCloseTo(0.25, 6)
  })

  it('matches applyEase, which the TSL node mirrors', () => {
    expect(applyEase(0.25, 1, 0)).toBeCloseTo(0.25, 6)
    expect(applyEase(0.25, 1, 1)).toBeCloseTo(0.15625, 6)
    expect(applyEase(0.25, 2, 0)).toBeCloseTo(0.0625, 6)
    expect(applyEase(-1, 1, 0)).toBe(0)
    expect(applyEase(2, 1, 0)).toBe(1)
  })

  it('writes into a caller-supplied target to avoid per-frame allocation', () => {
    const target = new Color()
    expect(sampleLook(look, 0.5, target)).toBe(target)
  })
})

describe('lerpLooks', () => {
  const a = resolveLook({ stops: RAMP, chroma: 0, value: 0 })
  const b = resolveLook({ stops: RAMP, chroma: 1, value: 1 })

  it('interpolates both blend axes independently', () => {
    const mid = lerpLooks(a, b, 0.25)
    expect(mid.chroma).toBeCloseTo(0.25, 6)
    expect(mid.value).toBeCloseTo(0.25, 6)
  })

  it('short-circuits at the endpoints', () => {
    expect(lerpLooks(a, b, 0)).toBe(a)
    expect(lerpLooks(a, b, 1)).toBe(b)
  })

  it('fades a missing sun tint through zero strength instead of popping', () => {
    const tinted = resolveLook({ stops: RAMP, sunTint: { color: [1, 0, 0], strength: 1 } })
    const mid = lerpLooks(a, tinted, 0.5)

    expect(mid.sunTint?.strength).toBeCloseTo(0.5, 6)
    expect(mid.sunTint?.color.r).toBeCloseTo(1, 6)
  })

  it('refuses to pair stops across differently-sized ramps', () => {
    const three = resolveLook({
      stops: [
        { at: 0, color: [0, 0, 0] },
        { at: 0.5, color: [0, 0, 0] },
        { at: 1, color: [1, 1, 1] },
      ],
    })

    expect(() => lerpLooks(a, three, 0.5)).toThrow(/different stop counts \(2 vs 3\)/)
  })
})

describe('look tracks', () => {
  const night = resolveLook({ stops: RAMP, chroma: 0, value: 0 })
  const day = resolveLook({ stops: RAMP, chroma: 1, value: 1 })

  it('keys on sun elevation and clamps beyond the outermost keys', () => {
    const track = createLookTrack([
      { elevation: 0, look: night },
      { elevation: 10, look: day },
    ])

    expect(sampleLookTrack(track, { elevation: -30 }).chroma).toBe(0)
    expect(sampleLookTrack(track, { elevation: 99 }).chroma).toBe(1)
    expect(sampleLookTrack(track, { elevation: 5 }).chroma).toBeCloseTo(0.5, 6)
  })

  it('sorts keyframes given out of order', () => {
    const track = createLookTrack([
      { elevation: 10, look: day },
      { elevation: 0, look: night },
    ])

    expect(track.keys.map((k) => k.at)).toEqual([0, 10])
    expect(sampleLookTrack(track, { elevation: 0 }).chroma).toBe(0)
  })

  it('holds a look across a band when two adjacent keys share it', () => {
    const track = createLookTrack([
      { elevation: -6, look: day },
      { elevation: 8, look: day },
      { elevation: 15, look: night },
    ])

    expect(sampleLookTrack(track, { elevation: 0 }).chroma).toBe(1)
    expect(sampleLookTrack(track, { elevation: 7 }).chroma).toBe(1)
    expect(sampleLookTrack(track, { elevation: 11.5 }).chroma).toBeCloseTo(0.5, 6)
  })

  it('supports a time axis for scenes where sun position is arbitrary', () => {
    const track = createLookTrack(
      [
        { time: 0, look: night },
        { time: 12, look: day },
      ],
      { by: 'time' },
    )

    expect(track.axis).toBe('time')
    expect(sampleLookTrack(track, { time: 6 }).chroma).toBeCloseTo(0.5, 6)
    expect(() => sampleLookTrack(track, { elevation: 6 })).toThrow(/keyed on `time`/)
  })

  it('resamples differently-sized looks onto the union of their positions', () => {
    const three = resolveLook({
      stops: [
        { at: 0, color: [0, 0, 0] },
        { at: 0.5, color: [1, 0, 0] },
        { at: 1, color: [1, 1, 1] },
      ],
    })

    const track = createLookTrack([
      { elevation: 0, look: night },
      { elevation: 10, look: three },
    ])

    expect(track.keys.map((k) => k.look.stops.map((s) => s.at))).toEqual([
      [0, 0.5, 1],
      [0, 0.5, 1],
    ])
    // Blending is now possible at all, and exact at the endpoints.
    expect(sampleLookTrack(track, { elevation: 5 }).stops).toHaveLength(3)
  })

  it('resamples a linear ramp without changing it', () => {
    const twoStop = resolveLook({
      stops: [
        { at: 0, color: [0, 0, 0] },
        { at: 1, color: [1, 1, 1] },
      ],
    })
    const threeStop = resolveLook({
      stops: [
        { at: 0, color: [0, 0, 0] },
        { at: 0.35, color: [0, 0, 0] },
        { at: 1, color: [1, 1, 1] },
      ],
    })

    const track = createLookTrack([
      { elevation: 0, look: twoStop },
      { elevation: 10, look: threeStop },
    ])

    // The inserted stop lands exactly on the original ramp.
    expect(track.keys[0].look.stops[1].at).toBe(0.35)
    expect(track.keys[0].look.stops[1].color.r).toBeCloseTo(0.35, 6)
  })

  it('leaves a look that already sits on the union positions untouched, keeping its easing', () => {
    const eased = resolveLook({
      stops: [
        { at: 0, color: [0, 0, 0] },
        { at: 1, color: [1, 1, 1], ease: 'smooth' },
      ],
    })

    const track = createLookTrack([
      { elevation: 0, look: eased },
      { elevation: 10, look: night },
    ])

    expect(track.keys.find((k) => k.look === eased)).toBeDefined()
    expect(sampleLook(track.keys[0].look, 0.25).r).toBeCloseTo(0.15625, 6)
  })

  it('refuses a union wider than the hard stop cap', () => {
    const ramp = (positions: number[]) => resolveLook({ stops: positions.map((at) => ({ at, color: [0, 0, 0] })) })

    expect(() =>
      createLookTrack([
        { elevation: 0, look: ramp([0, 0.1, 0.2, 0.3, 0.4]) },
        { elevation: 10, look: ramp([0.5, 0.6, 0.7, 0.8, 0.9]) },
      ]),
    ).toThrow(/10 distinct stop positions, over the 8-stop cap/)
  })

  it('rejects keyframes missing the axis value, and empty tracks', () => {
    expect(() => createLookTrack([{ time: 5, look: night }])).toThrow(/missing a numeric `elevation`/)
    expect(() => createLookTrack([])).toThrow(/at least one keyframe/)
    expect(() => resolveLookTrack('nope')).toThrow(/Unknown look track: "nope"/)
  })
})

describe('packLook', () => {
  it('pads unused slots with the last stop so the ramp clamps at any stop count', () => {
    const packed = packLook(resolveLook({ stops: RAMP }))

    expect(packed.stopCount).toBe(2)
    expect(packed.positions).toHaveLength(MAX_LOOK_STOPS)
    expect(packed.colors).toHaveLength(MAX_LOOK_STOPS * 3)
    expect(packed.eases).toHaveLength(MAX_LOOK_STOPS * 2)

    for (let i = 2; i < MAX_LOOK_STOPS; i++) {
      expect(packed.positions[i]).toBe(1)
      expect(packed.colors[i * 3]).toBe(1)
    }
  })

  it('zeroes sun-tint strength when absent so the shader needs no branch', () => {
    const packed = packLook(resolveLook({ stops: RAMP }))
    expect(packed.sunTintStrength).toBe(0)
    expect(Array.from(packed.sunTintColor)).toEqual([0, 0, 0])
  })

  it('reuses a caller-supplied target buffer', () => {
    const target = packLook(resolveLook({ stops: RAMP }))
    const again = packLook(resolveLook({ stops: RAMP, chroma: 0.3 }), target)

    expect(again).toBe(target)
    expect(again.positions).toBe(target.positions)
    expect(again.chroma).toBe(0.3)
  })
})

describe('evaluatePackedRamp — the algorithm the TSL node runs', () => {
  const cases: [string, Parameters<typeof resolveLook>[0]][] = [
    [
      '2-stop linear',
      {
        stops: [
          { at: 0, color: [0, 0, 0] },
          { at: 1, color: [1, 0.5, 0.25] },
        ],
      },
    ],
    [
      '3-stop with easing',
      {
        stops: [
          { at: -0.2, color: [0.1, 0.2, 0.3] },
          { at: 0.35, color: [0.9, 0.4, 0.1], ease: 'smooth' },
          { at: 1, color: [0.2, 0.5, 0.8], ease: 2 },
        ],
      },
    ],
    ['single stop', { stops: [{ at: 0.4, color: [0.3, 0.6, 0.9] }] }],
    ['ghibli-dusk', 'ghibli-dusk'],
  ]

  for (const [name, input] of cases) {
    it(`agrees with sampleLook across the range — ${name}`, () => {
      const look = resolveLook(input)
      const packed = packLook(look)

      for (let at = -1.5; at <= 1.5; at += 0.05) {
        const expected = sampleLook(look, at)
        const actual = evaluatePackedRamp(packed, at)

        expect(actual.r).toBeCloseTo(expected.r, 5)
        expect(actual.g).toBeCloseTo(expected.g, 5)
        expect(actual.b).toBeCloseTo(expected.b, 5)
      }
    })
  }

  it('is inert over padded slots regardless of stop count', () => {
    const packed = packLook(resolveLook({ stops: [{ at: 0.4, color: [0.3, 0.6, 0.9] }] }))

    // A single-stop ramp is a constant colour everywhere, padding included.
    expect(evaluatePackedRamp(packed, -1).r).toBeCloseTo(0.3, 6)
    expect(evaluatePackedRamp(packed, 0.4).r).toBeCloseTo(0.3, 6)
    expect(evaluatePackedRamp(packed, 1).r).toBeCloseTo(0.3, 6)
  })
})

describe('built-in ghibli looks', () => {
  it('registers three looks plus a track keyed on civil twilight', () => {
    expect(Object.keys(looks)).toEqual(expect.arrayContaining(['ghibli-night', 'ghibli-dusk', 'ghibli-day']))
    expect(lookTracks.ghibli.axis).toBe('elevation')
    expect(lookTracks.ghibli.keys.map((k) => k.at)).toEqual([-18, -6, 8, 15])
  })

  it('keeps the memo palette verbatim — 2-stop night/day, 3-stop dusk', () => {
    expect(looks['ghibli-night'].stops).toHaveLength(2)
    expect(looks['ghibli-day'].stops).toHaveLength(2)
    expect(looks['ghibli-dusk'].stops).toHaveLength(3)

    // The track composes them anyway, and blends across the dawn band.
    expect(() => sampleLookTrack(lookTracks.ghibli, { elevation: -12 })).not.toThrow()
  })

  it("derives day's mid stop from its own ramp rather than inventing a colour", () => {
    const dayInTrack = lookTracks.ghibli.keys[lookTracks.ghibli.keys.length - 1].look
    const expected = sampleLook(looks['ghibli-day'], 0.35)

    expect(dayInTrack.stops.map((s) => s.at)).toEqual([0, 0.35, 1])
    expect(dayInTrack.stops[1].color.getHexString()).toBe(expected.getHexString())
    expect(dayInTrack.stops[1].color.getHexString()).toBe('c4d7ee')
  })

  it('leaves dusk untouched, since it already defines the union positions', () => {
    const duskInTrack = lookTracks.ghibli.keys[1].look
    expect(duskInTrack).toBe(looks['ghibli-dusk'])
  })

  it('gives night value authority, since physical night luminance is ~0', () => {
    expect(looks['ghibli-night'].value).toBeGreaterThan(looks['ghibli-day'].value)
  })

  it('registers a track under a name for later use', () => {
    registerLookTrack('test-track', [{ elevation: 0, look: 'ghibli-day' }])
    expect(resolveLookTrack('test-track').keys).toHaveLength(1)
  })
})
