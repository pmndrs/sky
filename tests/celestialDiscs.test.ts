import { describe, expect, it, vi } from 'vitest'
import { Scene } from 'three/webgpu'

import { Sky } from '../src/Sky'

function makeSky() {
  const renderer = {
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
  }
  return new Sky(renderer)
}

describe('scene celestial discs', () => {
  it('gives live skies a sun mesh and selects one disc across background, live sky and light', () => {
    const sky = makeSky()
    const scene = new Scene()
    sky.attach(scene)
    const live = sky.baker.createSkyMesh()
    const disc = live.getObjectByName('SkySun.disc')!
    scene.add(live)
    expect(sky.sunDisc.parent).toBeNull()
    expect(disc.visible).toBe(true)
    const sun = sky.createSun().attach(scene)
    expect(disc.visible).toBe(false)
    expect(sun.disc.visible).toBe(true)
    sun.dispose()
    expect(disc.visible).toBe(true)
    live.removeFromParent()
    expect(sky.sunDisc.parent).toBe(scene)
    sky.dispose()
    expect(disc.parent).toBeNull()
  })

  it('adds the standalone sun only when claiming a background and releases it on detach', () => {
    const sky = makeSky()
    const a = new Scene()
    const b = new Scene()
    sky.attach(a)
    expect(sky.sunDisc.parent).toBe(a)
    expect(sky.sunDisc.frustumCulled).toBe(false)
    expect(sky.sunDisc.material.depthWrite).toBe(false)
    expect(sky.sunDisc.castShadow).toBe(false)
    expect(sky.baker.skyScene.getObjectByName('SkySun.disc')).toBeUndefined()
    expect(sky.mesh.sunDiscOnSky.value).toBe(0)

    sky.attach(a, { background: false })
    expect(sky.sunDisc.parent).toBeNull()
    sky.attach(b)
    expect(sky.sunDisc.parent).toBe(b)
    expect(a.children).not.toContain(sky.sunDisc)
    sky.detach()
    expect(sky.sunDisc.parent).toBeNull()
    sky.dispose()
  })

  it('parents the sun mesh to its light, replacing the background disc in the same scene', () => {
    const sky = makeSky()
    const scene = new Scene()
    const other = new Scene()
    sky.attach(scene)
    const sun = sky.createSun({ physical: true })
    expect(sun.disc.parent).toBe(sun.light)
    sun.attach(other)
    expect(sky.sunDisc.parent).toBe(scene)
    sun.attach(scene)
    expect(sky.sunDisc.parent).toBeNull()
    sun.detach()
    expect(sky.sunDisc.parent).toBe(scene)
    sun.attach(scene)
    const disposeGeometry = vi.spyOn(sun.disc.geometry, 'dispose')
    const disposeMaterial = vi.spyOn(sun.disc.material, 'dispose')
    sun.dispose()
    expect(disposeGeometry).toHaveBeenCalledOnce()
    expect(disposeMaterial).toHaveBeenCalledOnce()
    expect(sky.sunDisc.parent).toBe(scene)
    sky.dispose()
  })

  it('updates sun visibility, size, radiance and tint without requiring a cube bake', () => {
    const sky = makeSky()
    const sun = sky.createSun()
    const markDirty = vi.spyOn(sky.baker, 'markCubeDirty')
    sky.setSunDisc({ visible: false, angularDiameter: 0.02, edgeSoftness: 0.2, intensity: 30 })
    expect(sky.mesh.showSunDisc.value).toBe(0)
    expect(sky.mesh.sunDiscCos.value).toBe(Math.cos(0.01))
    expect(sky.mesh.sunDiscCosInner.value).toBe(Math.cos(0.008))
    expect(sky.mesh.sunDiscIntensity.value).toBe(30)
    expect(markDirty).not.toHaveBeenCalled()
    sky.setSunDisc(true)
    sky.setSunDirection({ elevation: 4, azimuth: 90 })
    expect(sun.light.position.clone().normalize().distanceTo(sky.mesh.sunDirection.value)).toBeLessThan(1e-12)
    sky.setSunColor([1, 0.5, 0.2])
    expect(sun.light.color.g).toBe(0.5)
    expect(sky.mesh.sunColor.value.y).toBe(0.5)
    sun.dispose()
    sky.dispose()
  })

  it('parents the moon disc to its light and preserves the existing disc controls', () => {
    const sky = makeSky()
    const scene = new Scene()
    const moon = sky.createMoon({ showDisc: true, discIntensity: 2 }).attach(scene)
    expect(moon.disc.parent).toBe(moon.light)
    expect(scene.getObjectByName('SkyMoon.disc')).toBe(moon.disc)
    expect(sky.mesh.moonDiscOnSky.value).toBe(0)
    moon.setDirection({ elevation: 20, azimuth: 50 })
    expect(moon.light.position.clone().normalize().distanceTo(sky.mesh.moonDirection.value)).toBeLessThan(1e-12)
    moon.setDiscVisible(false).setDiscAngularDiameter(0.02).setDiscColor(0xffaa33)
    expect(sky.mesh.showMoonDisc.value).toBe(0)
    expect(sky.mesh.moonDiscCos.value).toBe(Math.cos(0.01))
    moon.detach()
    expect(scene.getObjectByName('SkyMoon.disc')).toBeUndefined()
    moon.attach(scene)
    moon.dispose()
    expect(moon.disc.parent).toBeNull()
    expect(scene.children).not.toContain(moon.light)
    sky.dispose()
  })

  it('disposes the standalone disc once and allows caller-owned helpers to dispose afterwards', () => {
    const sky = makeSky()
    const sun = sky.createSun().attach(new Scene())
    const moon = sky.createMoon()
    const disposeGeometry = vi.spyOn(sky.sunDisc.geometry, 'dispose')
    const disposeMaterial = vi.spyOn(sky.sunDisc.material, 'dispose')
    sky.dispose()
    sky.dispose()
    expect(disposeGeometry).toHaveBeenCalledOnce()
    expect(disposeMaterial).toHaveBeenCalledOnce()
    expect(() => sun.dispose()).not.toThrow()
    expect(() => moon.dispose()).not.toThrow()
  })
})
