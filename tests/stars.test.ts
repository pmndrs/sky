import { describe, expect, it } from 'vitest'

import { DataUtils, Matrix3, PerspectiveCamera, Scene, Vector3 } from 'three/webgpu'

import { Sky } from '../src/Sky'
import { SkyStars } from '../src/sky/SkyStars'
import { generateStarCatalog } from '../src/sky/stars/catalog'
import {
  celestialOrientation,
  equatorialVector,
  galacticToEquatorial,
  worldToGalactic,
} from '../src/sky/stars/celestial'
import { generateMilkyWayTexture } from '../src/sky/stars/milkyWay'
import { localSiderealTime, solarEquatorial, solarPosition } from '../src/solarPosition'

const DEG = Math.PI / 180

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
    getPixelRatio() {
      return 2
    },
  }
}

// The sun as the baker builds it: azimuth clockwise from north, rotated onto
// the configured north axis.
function sunWorld(elevation: number, azimuth: number, northOffsetDeg: number) {
  return new Vector3().setFromSphericalCoords(1, (90 - elevation) * DEG, (azimuth + northOffsetDeg) * DEG)
}

describe('celestial frames', () => {
  it('galactic longitude 90° points at Cygnus (right-handed galactic frame)', () => {
    const v = galacticToEquatorial(90 * DEG, 0)
    const raHours = (((Math.atan2(v.z, v.x) / DEG / 15) % 24) + 24) % 24
    const decDeg = Math.asin(v.y) / DEG
    expect(raHours).toBeCloseTo(21.2, 1)
    expect(decDeg).toBeCloseTo(48.3, 0)
  })

  it('worldToGalactic inverts the orientation for the galactic centre', () => {
    const orientation = celestialOrientation({ latitude: 30, siderealTime: 1.3, northOffsetDeg: 90 })
    const centreWorld = galacticToEquatorial(0, 0).applyMatrix4(orientation)
    const g = centreWorld.applyMatrix3(worldToGalactic(orientation, new Matrix3()))
    expect(g.x).toBeCloseTo(1, 6)
    expect(g.y).toBeCloseTo(0, 6)
    expect(g.z).toBeCloseTo(0, 6)
  })

  // Registration: the stars' orientation must put the sun's catalog position
  // exactly where Sky puts the sun, or constellations drift against the
  // sunset through the year.
  const cases = [
    { latitude: 48.9, dayOfYear: 176, timeOfDay: 20.5, north: 0 },
    { latitude: 37.7, dayOfYear: 45, timeOfDay: 8.25, north: 0 },
    { latitude: -33.9, dayOfYear: 300, timeOfDay: 17, north: 180 },
    { latitude: 64, dayOfYear: 355, timeOfDay: 12.5, north: 90 },
    { latitude: 5, dayOfYear: 80, timeOfDay: 6.2, north: -90 },
  ]
  for (const c of cases) {
    it(`registers the sun (lat ${c.latitude}, day ${c.dayOfYear}, ${c.timeOfDay}h, north ${c.north})`, () => {
      const { elevation, azimuth } = solarPosition(c)
      const { rightAscension, declination } = solarEquatorial(c)
      const orientation = celestialOrientation({
        latitude: c.latitude,
        siderealTime: localSiderealTime(c),
        northOffsetDeg: c.north,
      })
      const fromStars = equatorialVector(rightAscension, declination).applyMatrix4(orientation)
      const errDeg = fromStars.angleTo(sunWorld(elevation, azimuth, c.north)) / DEG
      expect(errDeg).toBeLessThan(0.5)
    })
  }
})

describe('star catalog', () => {
  const catalog = generateStarCatalog({ count: 9000 })

  it('returns unit directions for the procedural and named stars', () => {
    expect(catalog.count).toBeGreaterThan(9000)
    for (let i = 0; i < catalog.count; i += 97) {
      const d = catalog.directions
      expect(Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2])).toBeCloseTo(1, 5)
    }
  })

  it('follows the naked-eye magnitude distribution N(<m) ∝ 10^(0.5 m)', () => {
    const below = (m: number) => catalog.magnitudes.filter((x) => x < m).length
    // 9000 · 10^(0.5·(4 − 6.5)) ≈ 506 procedural stars brighter than m = 4.
    expect(below(4)).toBeGreaterThan(400)
    expect(below(4)).toBeLessThan(640)
    expect(below(0)).toBeGreaterThanOrEqual(3) // Sirius, Canopus, Arcturus
  })

  it('concentrates faint stars toward the galactic plane', () => {
    const pole = galacticToEquatorial(0, Math.PI / 2)
    let near = 0
    let faint = 0
    for (let i = 0; i < catalog.count; i++) {
      if (catalog.magnitudes[i] < 5.5) continue
      faint++
      const d = new Vector3(catalog.directions[i * 3], catalog.directions[i * 3 + 1], catalog.directions[i * 3 + 2])
      if (Math.abs(d.dot(pole)) < Math.sin(10 * DEG)) near++
    }
    // A uniform sky puts sin(10°) ≈ 17% within ±10° of the plane.
    expect(near / faint).toBeGreaterThan(0.3)
  })
})

describe('Milky Way map', () => {
  const tex = generateMilkyWayTexture({ width: 128 })
  const { data, width, height } = tex.image as { data: Uint16Array; width: number; height: number }
  const at = (u: number, v: number) => {
    const i = (Math.floor(v * (height - 1)) * width + Math.floor(u * (width - 1))) * 4
    return DataUtils.fromHalfFloat(data[i + 1])
  }

  it('is a galactic-frame equirect: bright bulge at the centre, dark poles', () => {
    expect(width).toBe(128)
    expect(height).toBe(64)
    const centre = Math.max(at(0.5, 0.45), at(0.5, 0.55), at(0.52, 0.45))
    expect(centre).toBeGreaterThan(at(0.02, 0.5) * 2) // anti-centre
    expect(centre).toBeGreaterThan(at(0.5, 0.95) * 10) // near the galactic pole
    for (let i = 0; i < data.length; i += 4) expect(Number.isFinite(DataUtils.fromHalfFloat(data[i]))).toBe(true)
  })
})

describe('Sky night', () => {
  it('adds the star sprites to the attached scene and follows attach/detach', async () => {
    const sky = new Sky(mockRenderer())
    const scene = new Scene()
    sky.attach(scene)
    const night = await sky.enableStars({ count: 200 })
    expect(night.stars).toBeInstanceOf(SkyStars)
    expect(night.stars!.parent).toBe(scene)
    expect(sky.mesh.milkyWayIntensity.value).toBeGreaterThan(0)
    expect(sky.mesh.milkyWayTextureNode.value).toBe(night.milkyWayTexture)

    sky.detach()
    expect(night.stars!.parent).toBeNull()
    sky.attach(scene)
    expect(night.stars!.parent).toBe(scene)
    sky.dispose()
  })

  it('attaches stars enabled before the sky was attached', async () => {
    const sky = new Sky(mockRenderer())
    const night = await sky.enableStars({ count: 50 })
    expect(night.stars!.parent).toBeNull()
    const scene = new Scene()
    sky.attach(scene)
    expect(night.stars!.parent).toBe(scene)
    sky.dispose()
  })

  it('disable hides both halves; setters do not re-enable', async () => {
    const sky = new Sky(mockRenderer())
    const scene = new Scene()
    sky.attach(scene)
    const night = await sky.enableStars({ count: 50 })
    sky.disableStars()
    expect(night.stars!.parent).toBeNull()
    expect(sky.mesh.milkyWayIntensity.value).toBe(0)

    sky.setStarsIntensity(2)
    night.setMilkyWay(1.5)
    expect(night.enabled).toBe(false)
    expect(night.stars!.parent).toBeNull()
    expect(sky.mesh.milkyWayIntensity.value).toBe(0)
    expect(night.stars!.uniforms.intensity.value).toBe(2)

    await sky.enableStars()
    expect(night.stars!.parent).toBe(scene)
    expect(sky.mesh.milkyWayIntensity.value).toBe(1.5)
    sky.dispose()
  })

  it('rebuilds the sprites only when the catalog changes', async () => {
    const sky = new Sky(mockRenderer())
    const night = await sky.enableStars({ count: 50 })
    const first = night.stars
    await sky.enableStars({ intensity: 3 })
    expect(night.stars).toBe(first)
    await sky.enableStars({ count: 80 })
    expect(night.stars).not.toBe(first)
    expect(night.stars!.count).toBeGreaterThan(80)
    sky.dispose()
  })

  it('keeps the stars and the Milky Way oriented with time of day', async () => {
    const sky = new Sky(mockRenderer(), { timeOfDay: 21, latitude: 45, dayOfYear: 200 })
    const night = await sky.enableStars({ count: 50 })
    const before = night.stars!.orientation.clone()
    const mwBefore = sky.mesh.milkyWayMatrix.value.clone()
    sky.setTimeOfDay(23)
    expect(night.stars!.orientation.equals(before)).toBe(false)
    expect(sky.mesh.milkyWayMatrix.value.equals(mwBefore)).toBe(false)

    // Registration through the facade: sun's catalog position → baker's sun.
    const { rightAscension, declination } = solarEquatorial({ timeOfDay: 23, dayOfYear: 200 })
    const sun = equatorialVector(rightAscension, declination).applyMatrix4(night.stars!.orientation)
    expect(sun.angleTo(sky.baker._sunVec) / DEG).toBeLessThan(0.5)
    sky.setNorth('+X')
    const sunX = equatorialVector(rightAscension, declination).applyMatrix4(night.stars!.orientation)
    expect(sunX.angleTo(sky.baker._sunVec) / DEG).toBeLessThan(0.5)
    sky.dispose()
  })

  it('moves the sprites with the camera and keeps them inside the far plane', async () => {
    const sky = new Sky(mockRenderer())
    const night = await sky.enableStars({ count: 50 })
    const camera = new PerspectiveCamera(60, 1, 1, 50_000)
    camera.position.set(10, 250, -40)
    night.update(camera, 2)
    const p = new Vector3().setFromMatrixPosition(night.stars!.matrix)
    expect(p.toArray()).toEqual([10, 250, -40])
    expect(night.stars!.uniforms.radius.value).toBeLessThan(camera.far)
    expect(night.stars!.uniforms.pixelRatio.value).toBe(2)
    sky.dispose()
  })

  it('dispose removes the sprites and frees the generated map, not a caller map', async () => {
    const sky = new Sky(mockRenderer())
    const scene = new Scene()
    sky.attach(scene)
    const night = await sky.enableStars({ count: 50 })
    const generated = night.milkyWayTexture
    let freed = 0
    generated.addEventListener('dispose', () => freed++)

    const mine = generateMilkyWayTexture({ width: 16 })
    let mineFreed = 0
    mine.addEventListener('dispose', () => mineFreed++)
    night.setMilkyWayTexture(mine)
    expect(freed).toBe(1)
    expect(sky.mesh.milkyWayTextureNode.value).toBe(mine)

    const stars = night.stars!
    sky.dispose()
    expect(stars.parent).toBeNull()
    expect(mineFreed).toBe(0)
  })
})
