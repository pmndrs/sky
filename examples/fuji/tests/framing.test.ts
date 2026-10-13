import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three/webgpu'
import { printFraming } from '../src/print/framing'

describe('print layout framing', () => {
  it('preserves responsive framing in auto and portrait', () => {
    expect(printFraming(2.4, 'auto').fov).toBeCloseTo(33)
    const tall = printFraming(0.65, 'auto')
    const horizontal = (Math.atan(Math.tan((tall.fov * Math.PI) / 360) * 0.65) * 360) / Math.PI
    expect(horizontal).toBeCloseTo(43)
    expect(printFraming(0.65, 'portrait')).toEqual(tall)
  })

  it('gives the composed sun at least ten percent horizontal padding in landscape', () => {
    const frame = printFraming(2.4, 'landscape')
    const camera = new PerspectiveCamera(frame.fov, 2.4, 0.5, 110000)
    camera.position.set(0, 8, 75)
    camera.lookAt(0, frame.aimHeight, -2500)
    camera.updateMatrixWorld()
    const elevation = (4 * Math.PI) / 180
    const direction = new Vector3(
      -0.5 * Math.cos(elevation),
      Math.sin(elevation),
      -Math.sqrt(0.75) * Math.cos(elevation),
    )
    const sun = camera.position.clone().addScaledVector(direction, 10000).project(camera)
    expect(sun.x).toBeGreaterThan(-0.8)
    expect(sun.x).toBeLessThan(0)
    expect(Math.abs(sun.y)).toBeLessThan(1)
  })
})
