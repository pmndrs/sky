import { describe, expect, it, vi } from 'vitest'
import { Box3, PerspectiveCamera, Scene, Vector3 } from 'three/webgpu'

import { Sky } from '../src/Sky'
import { SkyGrade } from '../src/grade'

function makeSky() {
  const sky = new Sky(
    {
      compile() {},
      setRenderTarget() {},
      getRenderTarget: () => null,
      getActiveCubeFace: () => 0,
      getActiveMipmapLevel: () => 0,
      getMRT: () => null,
      setMRT() {},
      render() {},
      compute() {},
      backend: {},
      hasFeature: () => true,
    },
    { sunDirection: { elevation: -20, azimuth: 0 } },
  )
  for (const lut of [sky.baker.transmittanceLUT, sky.baker.multiScatterLUT, sky.baker.skyViewLUT]) {
    vi.spyOn(lut, 'render').mockImplementation(() => {})
  }
  vi.spyOn(sky.baker.cubeCamera, 'update').mockImplementation(() => {})
  vi.spyOn(sky.baker.pmrem, 'markDirty').mockImplementation(() => {})
  vi.spyOn(sky.baker.pmrem, 'tick').mockImplementation(() => {})
  return sky
}

describe('artistic moonlight', () => {
  it('adapts daytime moon visibility by default and allows an artistic override', () => {
    const sky = makeSky()
    const moon = sky.createMoon()
    expect(sky.mesh.moonDaylightFade.value).toBe(1)
    expect(moon.setDaylightFade(false)).toBe(moon)
    expect(sky.mesh.moonDaylightFade.value).toBe(0)
    moon.setDaylightFade(true)
    expect(sky.mesh.moonDaylightFade.value).toBe(1)
    moon.dispose()
    sky.dispose()
  })

  it('moves with time, date, latitude, north and phase unless explicitly placed by hand', () => {
    const sky = makeSky()
    const rig = sky.createMoonlight().attach(new Scene())
    expect(rig.moon.followSun).toBe(true)
    const movedBy = (change: () => void) => {
      const before = rig.moon._moonVec.clone()
      change()
      expect(rig.moon._moonVec.distanceTo(before)).toBeGreaterThan(0.01)
      expect(rig.moon._moonVec.distanceTo(sky.baker._sunVec.clone().negate())).toBeLessThan(1e-12)
    }
    movedBy(() => sky.setTimeOfDay(0))
    movedBy(() => sky.setTimeOfDay(4))
    movedBy(() => sky.setDayOfYear(355))
    movedBy(() => sky.setLatitude(-33))
    movedBy(() => sky.setNorth(90))
    rig.setPhase(0.25)
    expect(rig.moon._moonVec.dot(sky.baker._sunVec)).toBeCloseTo(0, 12)
    rig.setDirection({ elevation: 35, azimuth: 180 })
    const manual = rig.moon._moonVec.clone()
    sky.setTimeOfDay(12)
    expect(rig.moon._moonVec.equals(manual)).toBe(true)
    rig.setFollowSun(true)
    expect(rig.moon._moonVec.equals(manual)).toBe(false)
    expect(rig.moon._moonVec.dot(sky.baker._sunVec)).toBeCloseTo(0, 12)
    rig.dispose()
    sky.dispose()
  })

  it('is opt-in and restores the prior grade without changing exposure', () => {
    const sky = makeSky()
    const previous = sky.setGrade('storybook')
    const rig = sky.createMoonlight()
    expect(sky.grade).toBe(previous)
    const scene = new Scene()
    rig.attach(scene)
    expect(sky.grade).toBe(rig.grade)
    expect(scene.children).toContain(rig.moon.light)
    expect(scene.children).toContain(rig.ambient.light)
    rig.attach(scene) // must not save its own grade as the previous grade
    rig.detach()
    expect(sky.grade).toBe(previous)
    expect(sky.mesh.gradeUniforms.fillScale.value).toBe(1)
    expect(scene.children).not.toContain(rig.moon.light)
    expect(scene.children).not.toContain(rig.ambient.light)
    rig.dispose()
    sky.dispose()
  })

  it('ties moon, fill and sky strength to phase and leaves a moonless floor', () => {
    const sky = makeSky()
    const rig = sky
      .createMoonlight({ moonIntensity: 2, ambientIntensity: 1, moonlessFloor: 0.1 })
      .setDirection({ elevation: 30, azimuth: 180 })
      .attach(new Scene())
    const fullFill = rig.ambient.light.intensity
    expect(rig.moon.light.intensity).toBe(2)
    expect(sky.mesh.gradeUniforms.fillScale.value).toBe(1)
    rig.setPhase(0.25)
    expect(rig.moon.light.intensity).toBeCloseTo(0.5)
    expect(rig.ambient.light.intensity).toBeCloseTo(fullFill * 0.325)
    expect(sky.mesh.gradeUniforms.fillScale.value).toBeCloseTo(0.325)
    rig.setPhase(0)
    expect(rig.moon.light.intensity).toBe(0)
    expect(rig.ambient.light.intensity).toBeCloseTo(fullFill * 0.1)
    expect(sky.mesh.moonPhase.value).toBe(0)
    expect(sky.mesh.moonPhaseShading.value).toBe(1)
    rig.setIntensity(0)
    expect(rig.ambient.light.intensity).toBe(0)
    expect(sky.mesh.gradeUniforms.fillScale.value).toBe(0)
    rig.dispose()
    sky.dispose()
  })

  it('fades out in daytime and retains the requested settings for night', () => {
    const sky = makeSky()
    const rig = sky.createMoonlight().setDirection({ elevation: 35, azimuth: 180 }).attach(new Scene())
    const atNight = rig.moon.light.intensity
    sky.setSunDirection({ elevation: -4, azimuth: 0 })
    expect(rig.moon.light.intensity).toBeCloseTo(atNight * 0.5)
    sky.setSunDirection({ elevation: 20, azimuth: 0 })
    expect(rig.moon.light.intensity).toBe(0)
    expect(rig.ambient.light.intensity).toBe(0)
    expect(rig.grade.evaluate(20).ambient).toBeNull()
    expect(rig.grade.apply([1, 1, 1], 20, 30, 0)).toEqual([1, 1, 1])
    sky.setSunDirection({ elevation: -20, azimuth: 0 })
    expect(rig.moon.light.intensity).toBe(atNight)
    rig.dispose()
    sky.dispose()
  })

  it('removes direct light at moonset and uses the camera-local planet horizon', () => {
    const sky = makeSky()
    const rig = sky.createMoonlight().setDirection({ elevation: 35, azimuth: 90 }).attach(new Scene())
    rig.setDirection({ elevation: -2, azimuth: 90 })
    expect(rig.moon.visibility).toBe(0)
    expect(rig.moon.light.intensity).toBe(0)
    expect(sky.mesh.gradeUniforms.fillScale.value).toBe(0.15)
    rig.setDirection({ elevation: 35, azimuth: 90 })
    expect(rig.moon.visibility).toBe(1)
    const camera = new PerspectiveCamera()
    camera.position.set(sky.baker.atmosphereParams.bottomRadius * 1000 + 2, 0, 0)
    sky.update(camera, { planetCenter: new Vector3() })
    expect(rig.moon.visibility).toBe(0)
    expect(rig.moon.light.intensity).toBe(0)
    rig.dispose()
    sky.dispose()
  })

  it('changes a fill uniform without rebuilding grade tables or atmosphere LUTs', () => {
    const sky = makeSky()
    const rig = sky.createMoonlight().setDirection({ elevation: 35, azimuth: 180 }).attach(new Scene())
    sky.baker.atmosDirty = false
    sky.baker.sunDirty = false
    sky.baker.cubeDirty = false
    const revision = rig.grade.revision
    const version = sky.mesh.gradeUniforms.fillGainTexture.version
    rig.setSkyBrightness(0.4).setMoonIntensity(1.2).setAmbientIntensity(0.2)
    expect(rig.grade.revision).toBe(revision)
    expect(sky.mesh.gradeUniforms.fillGainTexture.version).toBe(version)
    expect(sky.baker.atmosDirty).toBe(false)
    expect(sky.baker.sunDirty).toBe(false)
    expect(sky.baker.cubeDirty).toBe(true)
    expect(sky.mesh.gradeUniforms.fillScale.value).toBe(0.4)
    expect(rig.moon.light.intensity).toBe(1.2)
    rig.dispose()
    sky.dispose()
  })

  it('preserves explicit user grade changes and supports lights-only usage', () => {
    const sky = makeSky()
    const rig = sky.createMoonlight().attach(new Scene())
    const custom = sky.setGrade('storybook')
    rig.setPhase(0.2).setIntensity(2)
    expect(sky.grade).toBe(custom)
    expect(sky.mesh.gradeUniforms.fillScale.value).toBe(1)
    rig.detach()
    expect(sky.grade).toBe(custom)
    rig.dispose()
    const lightsOnly = sky.createMoonlight({ skyFill: false }).attach(new Scene())
    expect(sky.grade).toBe(custom)
    lightsOnly.dispose()
    sky.dispose()
  })

  it('keeps existing SkyMoon behavior until phase lighting is opted in', () => {
    const sky = makeSky()
    const moon = sky.createMoon({ intensity: 2 }).setDirection({ elevation: 30, azimuth: 180 })
    moon.setPhase(0)
    expect(moon.light.intensity).toBe(2)
    expect(sky.mesh.moonPhaseShading.value).toBe(0)
    moon.setPhaseLighting(true)
    expect(moon.light.intensity).toBe(0)
    moon.setPhase(0.5)
    expect(moon.light.intensity).toBe(2)
    moon.setPhase(-0.25)
    expect(moon.phase).toBe(0.75)
    expect(moon.light.intensity).toBeCloseTo(0.5)
    moon.dispose()
    sky.dispose()
  })

  it('fits the moon shadow camera in the actual light frame before its first render', () => {
    const sky = makeSky()
    const rig = sky.createMoonlight().setDirection({ elevation: 35, azimuth: 180 }).attach(new Scene())
    const box = new Box3(new Vector3(-5, 0, -10), new Vector3(5, 8, 10))
    rig.fitShadowToBox(box)
    const camera = rig.moon.light.shadow.camera
    const center = box.getCenter(new Vector3()).applyMatrix4(camera.matrixWorldInverse)
    expect(center.x).toBeGreaterThan(camera.left)
    expect(center.x).toBeLessThan(camera.right)
    expect(center.y).toBeGreaterThan(camera.bottom)
    expect(center.y).toBeLessThan(camera.top)
    expect(-center.z).toBeGreaterThan(camera.near)
    expect(-center.z).toBeLessThan(camera.far)
    rig.setDirection({ elevation: 65, azimuth: 60 })
    const moved = box.getCenter(new Vector3()).applyMatrix4(camera.matrixWorldInverse)
    expect(moved.x).toBeGreaterThan(camera.left)
    expect(moved.x).toBeLessThan(camera.right)
    expect(moved.y).toBeGreaterThan(camera.bottom)
    expect(moved.y).toBeLessThan(camera.top)
    expect(-moved.z).toBeGreaterThan(camera.near)
    expect(-moved.z).toBeLessThan(camera.far)
    rig.dispose()
    sky.dispose()
  })

  it('disposes listeners, restores its grade and allows sky-first disposal', () => {
    const sky = makeSky()
    const prior = new SkyGrade([{ elevation: 0 }])
    sky.setGrade(prior)
    const rig = sky.createMoonlight().attach(new Scene())
    const dispose = vi.spyOn(rig.moon.disc.material, 'dispose')
    rig.dispose()
    rig.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    expect(sky.grade).toBe(prior)
    expect(rig.moon._changeListeners.size).toBe(0)
    const other = sky.createMoonlight().attach(new Scene())
    sky.dispose()
    expect(() => other.dispose()).not.toThrow()
    expect(() => other.attach(new Scene())).toThrow(/disposed/)
  })
})
