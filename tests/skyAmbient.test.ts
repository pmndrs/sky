import { describe, expect, it } from 'vitest'

import { Color, Vector3 } from 'three/webgpu'

import { SkyGrade } from '../src/grade'
import { SkyAmbient } from '../src/sky/SkyAmbient'

/** The slice of a baker SkyAmbient reads: sun vector, camera up, listeners, grade. */
function fakeSky() {
  const sun = new Set<() => void>()
  const bake = new Set<() => void>()
  const gradeL = new Set<(g: SkyGrade | null) => void>()
  const baker = {
    _sunVec: new Vector3(0, 1, 0),
    _cameraUp: new Vector3(0, 1, 0),
    grade: null as SkyGrade | null,
    addSunListener: (fn: () => void) => (sun.add(fn), () => sun.delete(fn)),
    addBakeListener: (fn: () => void) => (bake.add(fn), () => bake.delete(fn)),
    addGradeListener: (fn: (g: SkyGrade | null) => void) => (gradeL.add(fn), () => gradeL.delete(fn)),
  }
  return {
    baker,
    listeners: { sun, bake, gradeL },
    setSunElevation(deg: number) {
      const r = (deg * Math.PI) / 180
      baker._sunVec.set(Math.cos(r), Math.sin(r), 0)
      for (const fn of sun) fn()
    },
    setGrade(g: SkyGrade | null) {
      baker.grade = g
      for (const fn of gradeL) fn(g)
    },
  }
}

describe('SkyAmbient', () => {
  it('is off in daylight and at full night strength after dusk', () => {
    const sky = fakeSky()
    const amb = new SkyAmbient(sky, { color: [0, 0, 1], groundColor: [0, 0, 0.1], intensity: 0.8 })
    sky.setSunElevation(40)
    expect(amb.light.intensity).toBe(0)
    expect(amb.light.visible).toBe(false)
    sky.setSunElevation(-20)
    expect(amb.light.intensity).toBeCloseTo(0.8)
    expect(amb.light.color.b).toBeCloseTo(1)
    expect(amb.light.groundColor.b).toBeCloseTo(0.1)
    // Halfway through the default −6°…3° fade.
    sky.setSunElevation(-1.5)
    expect(amb.light.intensity).toBeCloseTo(0.4)
  })

  it('interpolates the light that arrives, not colour and intensity separately', () => {
    const sky = fakeSky()
    const amb = new SkyAmbient(sky, {
      color: [0, 0, 1],
      intensity: 1,
      dayColor: [1, 1, 1],
      dayIntensity: 1,
      nightBelow: 0,
      dayAbove: 10,
    })
    sky.setSunElevation(5)
    // (0,0,1)·0.5 + (1,1,1)·0.5 = (0.5,0.5,1): peak 1, colour normalised to it.
    expect(amb.light.intensity).toBeCloseTo(1)
    expect(amb.light.color.r).toBeCloseTo(0.5)
    expect(amb.light.color.b).toBeCloseTo(1)
  })

  it('follows the grade’s keyframed ambient, and its own values again once cleared', () => {
    const sky = fakeSky()
    const amb = new SkyAmbient(sky, { intensity: 0.3 })
    sky.setSunElevation(-20)
    // Its own night values: intensity × the default colour's brightest linear channel.
    const peak = Math.max(...new Color('#7088c0').toArray())
    expect(amb.light.intensity).toBeCloseTo(0.3 * peak)

    const grade = new SkyGrade([
      { elevation: -18, ambient: { color: [1, 0, 0], groundColor: [0, 0, 0], intensity: 2 } },
      { elevation: 0 },
    ])
    sky.setGrade(grade)
    expect(amb.light.intensity).toBeCloseTo(2)
    expect(amb.light.color.r).toBeCloseTo(1)

    // Live edits reach it through the grade listener.
    grade.updateKey(0, { ambient: { intensity: 1 } })
    sky.setGrade(grade)
    expect(amb.light.intensity).toBeCloseTo(1)

    amb.setFollowGrade(false)
    expect(amb.light.color.r).not.toBeCloseTo(1)
    amb.setFollowGrade(true)

    sky.setGrade(null)
    expect(amb.light.color.r).not.toBeCloseTo(1)
  })

  it('ignores a grade without ambient keyframes', () => {
    const sky = fakeSky()
    const amb = new SkyAmbient(sky, { color: [0, 0, 1], intensity: 0.5 })
    sky.setSunElevation(-30)
    sky.setGrade(new SkyGrade([{ elevation: -10, fill: { intensity: 1 } }]))
    expect(amb.light.intensity).toBeCloseTo(0.5)
  })

  it('dispose() unsubscribes and detaches', () => {
    const sky = fakeSky()
    const amb = new SkyAmbient(sky)
    const scene = { add: () => {}, remove: () => {} } as any
    amb.attach(scene)
    amb.dispose()
    expect(sky.listeners.sun.size + sky.listeners.bake.size + sky.listeners.gradeL.size).toBe(0)
  })
})
