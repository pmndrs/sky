import { describe, expect, it } from 'vitest'

import { PerspectiveCamera, Scene, Vector3 } from 'three/webgpu'
import { pass } from 'three/tsl'

import { Sky } from '../src/Sky'
import { applyFog } from '../src/applyFog'
import {
  FOG_DEFAULTS,
  createFogState,
  fogNightWeight,
  fogOpacity,
  fogOpticalDepth,
  fogSampleDirection,
  segmentFraction,
  updateFogState,
} from '../src/sky/FogPostProcess'

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

/** Optical depth by brute force: Simpson's rule over the density along the ray. */
function integrate(
  { distance, rayUp, cameraHeight }: { distance: number; rayUp: number; cameraHeight: number },
  { density, heightFalloff, baseHeight }: { density: number; heightFalloff: number; baseHeight: number },
  n = 20000,
): number {
  const sigma = (t: number) => (density / 1000) * Math.exp(-(cameraHeight + t * rayUp - baseHeight) / heightFalloff)
  const h = distance / n
  let sum = sigma(0) + sigma(distance)
  for (let i = 1; i < n; i++) sum += sigma(i * h) * (i % 2 ? 4 : 2)
  return (sum * h) / 3
}

describe('fog optical depth', () => {
  const fog = { density: 0.8, heightFalloff: 250, baseHeight: 30 }

  it('matches a numerical integral for rays up, down, level and nearly level', () => {
    const cases = [
      { distance: 5000, rayUp: 0, cameraHeight: 40 },
      { distance: 5000, rayUp: 1e-9, cameraHeight: 40 },
      { distance: 5000, rayUp: -1e-7, cameraHeight: 40 },
      { distance: 5000, rayUp: 2e-5, cameraHeight: 40 },
      { distance: 8000, rayUp: 0.05, cameraHeight: 40 },
      { distance: 2000, rayUp: -0.2, cameraHeight: 600 },
      { distance: 900, rayUp: 1, cameraHeight: -100 },
      { distance: 12000, rayUp: -0.03, cameraHeight: 400 },
    ]
    for (const ray of cases) {
      const exact = integrate(ray, fog)
      expect(fogOpticalDepth(ray, fog)).toBeCloseTo(exact, 9)
      expect(Math.abs(fogOpticalDepth(ray, fog) / exact - 1)).toBeLessThan(1e-6)
    }
  })

  it('reduces to σ·d·e^(−(h−h₀)/H) for a level ray', () => {
    const tau = fogOpticalDepth({ distance: 3000, rayUp: 0, cameraHeight: 280 }, fog)
    expect(tau).toBeCloseTo(0.8e-3 * 3000 * Math.exp(-(280 - 30) / 250), 12)
  })

  it('is continuous across the series / closed-form switch', () => {
    const below = segmentFraction(1e-3 * (1 - 1e-9))
    const above = segmentFraction(1e-3 * (1 + 1e-9))
    expect(Math.abs(below - above)).toBeLessThan(1e-9)
    expect(segmentFraction(0)).toBe(1)
    expect(segmentFraction(50)).toBeCloseTo(1 / 50, 12)
  })

  it('stays finite for extreme rays and is exactly 0 at zero density', () => {
    const deep = { distance: 1e6, rayUp: -1, cameraHeight: 0 }
    const tau = fogOpticalDepth(deep, { heightFalloff: 1, density: 1 })
    expect(Number.isFinite(tau)).toBe(true)
    expect(fogOpacity(deep, { heightFalloff: 1 })).toBe(1)
    expect(fogOpticalDepth(deep, { heightFalloff: 1, density: 0 })).toBe(0)
    expect(fogOpticalDepth({ distance: 1e6, rayUp: 1, cameraHeight: 1e5 }, { heightFalloff: 1 })).toBe(0)
    // A zero scale height is floored, not divided by.
    expect(Number.isFinite(fogOpticalDepth({ distance: 10, rayUp: 0.5, cameraHeight: 2 }, { heightFalloff: 0 }))).toBe(
      true,
    )
  })

  it('opacity is 1 − e^(−τ), capped by maxOpacity', () => {
    const ray = { distance: 4000, rayUp: 0, cameraHeight: 0 }
    const tau = fogOpticalDepth(ray)
    expect(tau).toBeCloseTo(FOG_DEFAULTS.density * 4, 12)
    expect(fogOpacity(ray)).toBeCloseTo(1 - Math.exp(-tau), 12)
    expect(fogOpacity(ray, { maxOpacity: 0.25 })).toBe(0.25)
    expect(fogOpacity(ray, { maxOpacity: 0 })).toBe(0)
  })
})

describe('fog colour direction', () => {
  const up = { x: 0, y: 1, z: 0 }
  const minTan = 1 / 256
  const unit = (v: number[]) => Math.hypot(v[0], v[1], v[2])

  it('leaves rays well above the horizon alone', () => {
    const d = new Vector3(0.3, 0.5, -0.8).normalize()
    const s = fogSampleDirection(d, up, minTan)
    expect(s[0]).toBeCloseTo(d.x, 12)
    expect(s[1]).toBeCloseTo(d.y, 12)
    expect(s[2]).toBeCloseTo(d.z, 12)
  })

  it('mirrors rays below the horizon, keeping azimuth, and maps the nadir to the zenith', () => {
    const d = new Vector3(0.3, -0.5, -0.8).normalize()
    const s = fogSampleDirection(d, up, minTan)
    expect(s[0]).toBeCloseTo(d.x, 12)
    expect(s[1]).toBeCloseTo(-d.y, 12)
    expect(s[2]).toBeCloseTo(d.z, 12)
    const nadir = fogSampleDirection({ x: 0, y: -1, z: 0 }, up, minTan)
    expect(nadir[1]).toBeCloseTo(1, 12)
  })

  it('keeps near-level rays one texel centre above the horizon', () => {
    for (const y of [0, 1e-6, -1e-6, -1e-3]) {
      const d = new Vector3(1, y, 0.4).normalize()
      const s = fogSampleDirection(d, up, minTan)
      const horizontal = Math.hypot(s[0], s[2])
      expect(s[1] / horizontal).toBeGreaterThanOrEqual(minTan - 1e-12)
      expect(unit(s)).toBeCloseTo(1, 12)
      expect(Math.atan2(s[2], s[0])).toBeCloseTo(Math.atan2(d.z, d.x), 12)
    }
  })

  it('works about a tilted (planet-frame) up', () => {
    const tilted = new Vector3(0.2, 1, 0.1).normalize()
    const d = new Vector3(0.4, -0.6, 0.2).normalize()
    const s = fogSampleDirection(d, tilted, minTan)
    expect(s[0] * tilted.x + s[1] * tilted.y + s[2] * tilted.z).toBeCloseTo(-d.dot(tilted), 12)
  })
})

describe('fog night weight', () => {
  it('is 0 through civil twilight, 1 in full night, monotonic between', () => {
    expect(fogNightWeight(20)).toBe(0)
    expect(fogNightWeight(-10)).toBe(0)
    expect(fogNightWeight(-16)).toBe(1)
    expect(fogNightWeight(-40)).toBe(1)
    let prev = 0
    for (let e = -10; e >= -16; e -= 0.5) {
      const w = fogNightWeight(e)
      expect(w).toBeGreaterThanOrEqual(prev)
      prev = w
    }
  })
})

describe('fog state', () => {
  it('seeds the defaults and clamps partial updates', () => {
    const state = createFogState()
    expect(state.density.value).toBe(FOG_DEFAULTS.density)
    expect(state.heightFalloff.value).toBe(FOG_DEFAULTS.heightFalloff)
    expect(state.baseHeight.value).toBe(FOG_DEFAULTS.baseHeight)
    expect(state.maxOpacity.value).toBe(FOG_DEFAULTS.maxOpacity)
    updateFogState(state, { density: -1, maxOpacity: 3, heightFalloff: 0 })
    expect(state.density.value).toBe(0)
    expect(state.maxOpacity.value).toBe(1)
    expect(state.heightFalloff.value).toBeGreaterThan(0)
    expect(state.baseHeight.value).toBe(FOG_DEFAULTS.baseHeight)
  })
})

describe('Sky.setFog / applyFog', () => {
  const makePass = () => pass(new Scene(), new PerspectiveCamera(60, 16 / 9, 1, 100000))

  it('setFog works before applyFog, which adopts it; explicit options override', () => {
    const sky = new Sky(mockRenderer())
    sky.setFog({ density: 2, baseHeight: 50 })
    const state = sky._fog!
    expect(state.density.value).toBe(2)
    expect(state.heightFalloff.value).toBe(FOG_DEFAULTS.heightFalloff)

    const node = sky.applyFog(null, { scenePass: makePass(), heightFalloff: 80 })
    expect(node).toBeTruthy()
    expect(sky._fog).toBe(state) // same uniforms, so later setters stay live
    expect(state.density.value).toBe(2) // adopted
    expect(state.baseHeight.value).toBe(50) // adopted
    expect(state.heightFalloff.value).toBe(80) // explicit

    sky.setFog({ maxOpacity: 0.5 })
    expect(state.maxOpacity.value).toBe(0.5)
    expect(state.density.value).toBe(2)
    sky.dispose()
    expect(sky._fog).toBeUndefined()
  })

  it('applyFog creates the uniforms with defaults and needs no aerial-perspective LUT', () => {
    const sky = new Sky(mockRenderer(), { enableAerialPerspective: false })
    expect(() => sky.applyHaze(null, { scenePass: makePass() })).toThrow(/enableAerialPerspective/)
    sky.applyFog(null, { scenePass: makePass() })
    expect(sky._fog!.density.value).toBe(FOG_DEFAULTS.density)
    // Fog alone must not ask a frame driver for per-frame AP updates.
    expect(sky._hazeApplied).toBeFalsy()
    sky.dispose()
  })

  it('requires sky and scenePass', () => {
    const sky = new Sky(mockRenderer())
    expect(() => applyFog(null, { scenePass: makePass() })).toThrow(/sky/)
    expect(() => applyFog(null, { sky })).toThrow(/scenePass/)
    sky.dispose()
  })
})
