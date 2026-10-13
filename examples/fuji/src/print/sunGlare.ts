import { Vector4, type PerspectiveCamera, type Vector3 } from 'three/webgpu'

/** Camera projection of an infinite source, including a small offscreen margin.
 * Translation has no parallax; a source behind the camera contributes nothing.
 */
export function projectSunGlare(
  camera: PerspectiveCamera,
  direction: Vector3,
  radiusDegrees: number,
  offscreenPercent = 20,
) {
  const clip = new Vector4(direction.x, direction.y, direction.z, 0)
    .applyMatrix4(camera.matrixWorldInverse)
    .applyMatrix4(camera.projectionMatrix)
  if (clip.w <= 0.00001) return { x: 0, y: 0, radius: 0.01, visibility: 0 }
  const x = clip.x / clip.w
  const y = clip.y / clip.w
  const radius = Math.tan((radiusDegrees * Math.PI) / 180) * camera.projectionMatrix.elements[5] * 0.5
  // Soft acceptance beyond the image edge. A distant off-axis sun does not
  // wash the whole view; a sun just out of shot can still scatter in the lens.
  const margin = Math.max(Math.abs(x) - 1, Math.abs(y) - 1, 0)
  const t = Math.min(1, margin / Math.max(0.00001, offscreenPercent * 0.02))
  return { x: x * 0.5 + 0.5, y: 0.5 - y * 0.5, radius, visibility: 1 - t * t * (3 - 2 * t) }
}
