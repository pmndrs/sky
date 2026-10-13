import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three/webgpu'
import { projectSunGlare } from '../src/print/sunGlare'

function camera() {
  const camera = new PerspectiveCamera(60, 2, 0.5, 100000)
  camera.updateMatrixWorld()
  return camera
}

describe('sun glare camera projection', () => {
  it('keeps an infinite source fixed when the camera translates', () => {
    const view = camera()
    const direction = new Vector3(-0.2, 0.1, -1).normalize()
    const before = projectSunGlare(view, direction, 2)
    view.position.set(3000, 100, -2000)
    view.updateMatrixWorld()
    expect(projectSunGlare(view, direction, 2)).toEqual(before)
    expect(before.x).toBeLessThan(0.5)
    expect(before.y).toBeLessThan(0.5)
  })

  it('retains glare just beyond the frame and fades away farther off-axis', () => {
    const view = camera()
    const edge = Math.tan(Math.PI / 6) * view.aspect
    const inside = projectSunGlare(view, new Vector3(edge * 0.9, 0, -1).normalize(), 2)
    const outside = projectSunGlare(view, new Vector3(edge * 1.2, 0, -1).normalize(), 2)
    const far = projectSunGlare(view, new Vector3(edge * 1.5, 0, -1).normalize(), 2)
    expect(inside.visibility).toBe(1)
    expect(outside.x).toBeGreaterThan(1)
    expect(outside.visibility).toBeGreaterThan(0)
    expect(outside.visibility).toBeLessThan(1)
    expect(far.visibility).toBe(0)
    const outsideDirection = new Vector3(edge * 1.2, 0, -1).normalize()
    expect(projectSunGlare(view, outsideDirection, 2, 0).visibility).toBe(0)
    expect(projectSunGlare(view, outsideDirection, 2, 40).visibility).toBeGreaterThan(outside.visibility)
  })

  it('rejects sources behind or perpendicular to the camera without singularities', () => {
    for (const direction of [new Vector3(0, 0, 1), new Vector3(1, 0, 0)]) {
      const projected = projectSunGlare(camera(), direction, 2)
      expect(projected.visibility).toBe(0)
      expect(Object.values(projected).every(Number.isFinite)).toBe(true)
    }
  })

  it('keeps the glow circular in angular space as field of view changes', () => {
    const view = camera()
    const wide = projectSunGlare(view, new Vector3(0, 0, -1), 2)
    view.fov = 30
    view.updateProjectionMatrix()
    const zoomed = projectSunGlare(view, new Vector3(0, 0, -1), 2)
    expect(zoomed.radius / wide.radius).toBeCloseTo(Math.tan(Math.PI / 6) / Math.tan(Math.PI / 12))
    expect(projectSunGlare(view, new Vector3(0, 0, -1), 4).radius).toBeGreaterThan(zoomed.radius)
  })
})
