import { describe, expect, it, vi } from 'vitest'

import { PerspectiveCamera } from 'three/webgpu'

import { Sky } from '../src/Sky'
import { EARTH } from '../src/core/AtmosphereParams'
import { sunDiscVisibleFraction, transmittanceToSun } from '../src/core/sunTransmittance'

// Minimal renderer surface for constructing a Sky in node (as in sky.test.ts).
function mockRenderer(): any {
  return {
    compile() {},
    setRenderTarget() {},
    getRenderTarget() {
      return null
    },
    getActiveCubeFace() {
      return 0
    },
    getActiveMipmapLevel() {
      return 0
    },
    getMRT() {
      return null
    },
    setMRT() {},
    render() {},
    compute() {},
    backend: {},
    hasFeature() {
      return true
    },
  }
}

/** Let `sky.update()` run its dirty-flag flow without the GPU work (as in skyAtmosphereBaker.test.ts). */
function stubRenderStages(sky: Sky) {
  const baker = sky.baker
  vi.spyOn(baker.transmittanceLUT, 'render').mockImplementation(() => {})
  vi.spyOn(baker.multiScatterLUT, 'render').mockImplementation(() => {})
  vi.spyOn(baker.skyViewLUT, 'render').mockImplementation(() => {})
  vi.spyOn(baker.cubeCamera, 'update').mockImplementation(() => {})
  vi.spyOn(baker.pmrem, 'markDirty').mockImplementation(() => {})
  vi.spyOn(baker.pmrem, 'tick').mockImplementation(() => {})
}

const DISC_RADIUS_DEG = (EARTH.sunAngularRadius * 180) / Math.PI // ~0.268°

describe('SkySun horizon fade (#33)', () => {
  it('turns the light off below the horizon and keeps the requested intensity', () => {
    const sky = new Sky(mockRenderer())
    const sun = sky.createSun({ intensity: 4 })

    sky.setSunDirection({ elevation: 30, azimuth: 180 })
    expect(sun.light.intensity).toBe(4)

    sky.setSunDirection({ elevation: -10, azimuth: 180 })
    expect(sun.light.intensity).toBe(0)
    expect(sun.intensity).toBe(4)

    sky.setSunDirection({ elevation: 30, azimuth: 180 })
    expect(sun.light.intensity).toBe(4)
    sun.dispose()
    sky.dispose()
  })

  it('an intensity set at night is applied at sunrise', () => {
    const sky = new Sky(mockRenderer(), { sunDirection: { elevation: -10, azimuth: 90 } })
    const sun = sky.createSun()
    sun.intensity = 7
    expect(sun.light.intensity).toBe(0)
    expect(sun.setIntensity(8)).toBe(sun)
    expect(sun.intensity).toBe(8)
    expect(sun.light.intensity).toBe(0)

    sky.setSunDirection({ elevation: 20, azimuth: 90 })
    expect(sun.light.intensity).toBe(8)
    sun.dispose()
    sky.dispose()
  })

  it('is dark when created while the sun is down', () => {
    const sky = new Sky(mockRenderer(), { timeOfDay: 0, latitude: 37.7, dayOfYear: 172 })
    expect(sky.sunElevation).toBeLessThan(-10)
    const sun = sky.createSun({ intensity: 4 })
    expect(sun.light.intensity).toBe(0)
    expect(sun.intensity).toBe(4)
    sun.dispose()
    sky.dispose()
  })

  it('follows every sun path: time of day, latitude, date and north', () => {
    const sky = new Sky(mockRenderer(), { timeOfDay: 12, latitude: 37.7, dayOfYear: 172 })
    const sun = sky.createSun({ intensity: 4 })
    expect(sun.light.intensity).toBe(4)

    sky.setTimeOfDay(23)
    expect(sun.light.intensity).toBe(0)
    sky.setTimeOfDay(12)
    expect(sun.light.intensity).toBe(4)

    // Polar night at 80° N in December.
    sky.setDayOfYear(355)
    sky.setLatitude(80)
    expect(sky.sunElevation).toBeLessThan(0)
    expect(sun.light.intensity).toBe(0)
    sky.setNorth('-X')
    expect(sun.light.intensity).toBe(0)
    sky.setLatitude(37.7)
    expect(sun.light.intensity).toBe(4)
    sun.dispose()
    sky.dispose()
  })

  it('fades over the disc: full with the disc up, half on the horizon, off once it has set', () => {
    const sky = new Sky(mockRenderer())
    const sun = sky.createSun({ intensity: 4 })
    const at = (elevation: number) => {
      sky.setSunDirection({ elevation, azimuth: 180 })
      return sun.light.intensity
    }
    expect(at(DISC_RADIUS_DEG + 1e-3)).toBe(4)
    expect(at(0)).toBeCloseTo(2, 6)
    expect(at(-DISC_RADIUS_DEG - 1e-3)).toBe(0)
    // Monotonic in between.
    let prev = -1
    for (let e = -0.3; e <= 0.3; e += 0.02) {
      const v = at(e)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
    sun.dispose()
    sky.dispose()
  })

  it('the band follows the visible disc size', () => {
    const sky = new Sky(mockRenderer())
    const sun = sky.createSun({ intensity: 4 })
    sky.setSunDisc({ angularDiameter: (4 * Math.PI) / 180 }) // 2° radius
    sky.setSunDirection({ elevation: 1, azimuth: 180 })
    expect(sun.light.intensity).toBeGreaterThan(2)
    expect(sun.light.intensity).toBeLessThan(4)
    sun.dispose()
    sky.dispose()
  })

  it('horizonFade: false keeps the light on below the horizon', () => {
    const sky = new Sky(mockRenderer(), { sunDirection: { elevation: -10, azimuth: 0 } })
    const sun = sky.createSun({ intensity: 4, horizonFade: false })
    expect(sun.light.intensity).toBe(4)

    expect(sun.setHorizonFade(true)).toBe(sun)
    expect(sun.light.intensity).toBe(0)
    sun.horizonFade = false
    expect(sun.light.intensity).toBe(4)
    sun.dispose()
    sky.dispose()
  })

  it('a direct write to light.intensity lasts until the next sun change', () => {
    const sky = new Sky(mockRenderer())
    const sun = sky.createSun({ intensity: 4 })
    sun.light.intensity = 100
    sky.setSunDirection({ elevation: 40, azimuth: 10 })
    expect(sun.light.intensity).toBe(4)
    sun.dispose()
    sky.dispose()
  })
})

describe('SkySun physical mode (#4)', () => {
  const noon = { timeOfDay: 12, latitude: 37.7, dayOfYear: 172 }

  it('illuminance is luminanceScale × T(sun), tinted by T', () => {
    const sky = new Sky(mockRenderer(), { ...noon, exposure: 40 })
    const sun = sky.createSun({ physical: true })
    expect(sun.intensity).toBe(1)
    expect(sun.physical).toBe(true)

    const T = transmittanceToSun(0.001, Math.sin((sky.sunElevation * Math.PI) / 180), sky.baker.atmosphereParams)
    expect(sun.light.intensity).toBeCloseTo(40 * Math.max(...T), 6)
    const c = sun.light.color
    expect(c.r).toBeCloseTo(T[0] / T[0], 6)
    expect(c.g).toBeCloseTo(T[1] / T[0], 6)
    expect(c.b).toBeCloseTo(T[2] / T[0], 6)

    // Luminance of the light: ~35.5 at the default noon, ~9× the constant default 4.
    const Y = sun.light.intensity * (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b)
    expect(Y).toBeGreaterThan(35)
    expect(Y).toBeLessThan(36)

    // `intensity` is a multiplier; the sky's sun colour still tints.
    sun.intensity = 0.5
    expect(sun.light.intensity).toBeCloseTo(20 * Math.max(...T), 6)
    sky.setSunColor([1, 0.5, 0.25])
    expect(sun.light.color.g).toBeCloseTo((0.5 * T[1]) / T[0], 6)
    sun.dispose()
    sky.dispose()
  })

  it('reddens and dims toward the horizon and is dark below it', () => {
    const sky = new Sky(mockRenderer())
    const sun = sky.createSun({ physical: true })
    sky.setSunDirection({ elevation: 45, azimuth: 0 })
    const high = sun.light.intensity
    const highBlue = sun.light.color.b
    sky.setSunDirection({ elevation: 3, azimuth: 0 })
    expect(sun.light.intensity).toBeLessThan(high)
    expect(sun.light.color.b).toBeLessThan(highBlue)
    sky.setSunDirection({ elevation: -1, azimuth: 0 })
    expect(sun.light.intensity).toBe(0)
    sun.dispose()
    sky.dispose()
  })

  it('composes with the horizon fade without a double ramp', () => {
    const sky = new Sky(mockRenderer(), { sunDirection: { elevation: 0, azimuth: 0 } })
    const physical = sky.createSun({ physical: true })
    const T = transmittanceToSun(0.001, 0, sky.baker.atmosphereParams)
    // Centre on the horizon: half the disc, lit along the horizontal ray.
    expect(physical.light.intensity).toBeCloseTo(0.5 * 40 * Math.max(...T), 3)

    // With the flat fade off, the planet's own horizon (it dips with altitude) decides.
    physical.setHorizonFade(false)
    expect(physical.light.intensity).toBeGreaterThan(0.5 * 40 * Math.max(...T) * 0.99)
    sky.setSunDirection({ elevation: -0.5, azimuth: 0 })
    expect(physical.light.intensity).toBe(0)
    physical.dispose()
    sky.dispose()
  })

  it('follows exposure, atmosphere and altitude on the next update, not before', () => {
    const sky = new Sky(mockRenderer(), { ...noon, exposure: 40 })
    stubRenderStages(sky)
    const camera = new PerspectiveCamera()
    camera.position.set(0, 2, 0)
    sky.update(camera)

    const sun = sky.createSun({ physical: true })
    const base = sun.light.intensity

    sky.setExposure(20)
    expect(sun.light.intensity).toBe(base)
    sky.update(camera)
    expect(sun.light.intensity).toBeCloseTo(base / 2, 6)

    sky.setTurbidity(5)
    sky.update(camera)
    const hazy = sun.light.intensity
    expect(hazy).toBeLessThan(base / 2)

    // Climbing 8 km leaves most of the air below.
    camera.position.y = 8000
    sky.update(camera)
    expect(sun.light.intensity).toBeGreaterThan(hazy)

    // A constant-mode sun ignores all of it.
    const constant = sky.createSun({ intensity: 4 })
    sky.setExposure(80)
    sky.update(camera)
    expect(constant.light.intensity).toBe(4)

    sun.dispose()
    constant.dispose()
    sky.dispose()
  })

  it('setPhysical switches mode in place', () => {
    const sky = new Sky(mockRenderer(), noon)
    const sun = sky.createSun({ intensity: 1 })
    expect(sun.light.intensity).toBe(1)
    expect(sun.setPhysical(true)).toBe(sun)
    expect(sun.light.intensity).toBeGreaterThan(30)
    sun.physical = false
    expect(sun.light.intensity).toBe(1)
    expect(sun.light.color.getHex()).toBe(0xffffff)
    sun.dispose()
    sky.dispose()
  })

  it('stops following the sky once disposed', () => {
    const sky = new Sky(mockRenderer(), noon)
    stubRenderStages(sky)
    const sun = sky.createSun({ physical: true })
    const before = sun.light.intensity
    sun.dispose()
    sky.setExposure(10)
    sky.update(new PerspectiveCamera())
    sky.setSunDirection({ elevation: -20, azimuth: 0 })
    expect(sun.light.intensity).toBe(before)
    sky.dispose()
  })
})

describe('transmittanceToSun (CPU twin of the Transmittance LUT)', () => {
  // GPU Transmittance LUT texels read back on WebGPU (examples/vanilla/scripts/
  // verify-sun-light.mjs, Earth, 256×64 half-float), at each texel's exact
  // (altitude, zenith cosine). Over all 47 459 channel-texels above 1e-3 the
  // twin matches to a median 3.1e-4 and max 1.3e-3 relative: half-float rounding.
  const GPU_TEXELS: [number, number, [number, number, number]][] = [
    [0.0061514962635556, 0.9797533949064936, [0.94775390625, 0.880859375, 0.7890625]],
    [0.0061514962635556, 0.11292958595661595, [0.64892578125, 0.36328125, 0.140869140625]],
    [0.0061514962635556, -0.0010733170039289178, [0.114990234375, 0.0109710693359375, 0.00006902217864990234]],
    [25.93719606373179, -0.05089809488727265, [0.50634765625, 0.16796875, 0.145263671875]],
  ]

  it('matches GPU LUT texels to half-float precision', () => {
    for (const [altKm, mu, gpu] of GPU_TEXELS) {
      const cpu = transmittanceToSun(altKm, mu, EARTH)
      for (let c = 0; c < 3; c++) expect(Math.abs(cpu[c] - gpu[c]) / gpu[c]).toBeLessThan(2e-3)
    }
  })

  it('is 0 below the geometric horizon, which dips with altitude', () => {
    expect(transmittanceToSun(0, -0.001, EARTH)).toEqual([0, 0, 0])
    // From 10 km the horizon is ~3.2° down: a sun at −2° is still visible.
    const dip = Math.sin((-2 * Math.PI) / 180)
    expect(transmittanceToSun(10, dip, EARTH)[0]).toBeGreaterThan(0)
    expect(transmittanceToSun(10, Math.sin((-4 * Math.PI) / 180), EARTH)).toEqual([0, 0, 0])
  })

  it('is 1 at the top of the atmosphere and clamps the altitude to the shell', () => {
    expect(transmittanceToSun(100, 1, EARTH)).toEqual([1, 1, 1])
    expect(transmittanceToSun(500, 1, EARTH)).toEqual([1, 1, 1])
    expect(transmittanceToSun(-1, 1, EARTH)).toEqual(transmittanceToSun(0, 1, EARTH))
  })

  it('writes into `out` without allocating', () => {
    const out: [number, number, number] = [0, 0, 0]
    expect(transmittanceToSun(0, 1, EARTH, out)).toBe(out)
    expect(out[2]).toBeLessThan(out[1])
    expect(out[1]).toBeLessThan(out[0])
  })
})

describe('sunDiscVisibleFraction', () => {
  it('is the area of the disc above the horizon', () => {
    const r = 0.01
    expect(sunDiscVisibleFraction(-r, r)).toBe(0)
    expect(sunDiscVisibleFraction(0, r)).toBeCloseTo(0.5, 12)
    expect(sunDiscVisibleFraction(r, r)).toBe(1)
    // Centre half a radius below: a cap of height r/2, (π/3 − √3/4) / π of the disc.
    expect(sunDiscVisibleFraction(-r / 2, r)).toBeCloseTo((Math.PI / 3 - Math.sqrt(3) / 4) / Math.PI, 12)
    expect(sunDiscVisibleFraction(r / 2, r) + sunDiscVisibleFraction(-r / 2, r)).toBeCloseTo(1, 12)
    expect(sunDiscVisibleFraction(0.1, 0)).toBe(1)
    expect(sunDiscVisibleFraction(-0.1, 0)).toBe(0)
  })
})
