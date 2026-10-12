import { Raycaster, Vector3 } from 'three/webgpu'

/** Disc visibility from the bay, independent of the photographer's eye height.
 * Nine equal-area samples soften the transition as the sun crosses a ridge.
 * Only distant terrain participates: a nearby block must not darken the bay.
 */
export function terrainSunVisibility(scene, direction, origin = new Vector3(0, 1, 0), radius = 0.004675) {
  scene.updateMatrixWorld(true)
  const terrain = []
  scene.traverseVisible((object) => {
    if (object.isMesh && object.userData.sunOccluder) terrain.push(object)
  })
  const axis = Math.abs(direction.y) < 0.99 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)
  const right = axis.cross(direction).normalize()
  const up = new Vector3().crossVectors(direction, right).normalize()
  // Raycaster retains its direction by reference. Its sampling scratch must
  // never alias the sky's live uniform (or accumulate offsets between rays).
  const ray = new Raycaster(origin, direction.clone(), 0.1, 110000)
  let visible = 0
  for (let i = 0; i < 9; i++) {
    const r = Math.sqrt((i + 0.5) / 9) * Math.tan(radius)
    const angle = i * Math.PI * (3 - Math.sqrt(5))
    ray.ray.direction
      .copy(direction)
      .addScaledVector(right, r * Math.cos(angle))
      .addScaledVector(up, r * Math.sin(angle))
      .normalize()
    if (ray.intersectObjects(terrain, false).length === 0) visible++
  }
  return visible / 9
}
