import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BoxGeometry, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three/webgpu'
import { terrainSunVisibility } from '../src/scene/terrainSunVisibility.js'

test('terrain blocks the solar disc, with a partial transition at the ridge', () => {
  const scene = new Scene()
  const direction = new Vector3(0, 0.02, -1).normalize()
  const originalDirection = direction.clone()
  assert.equal(terrainSunVisibility(scene, direction), 1)
  assert(direction.equals(originalDirection), 'solar-disc sampling must not modify the caller direction')
  const ridge = new Mesh(new BoxGeometry(100, 10, 10), new MeshBasicMaterial())
  ridge.position.set(0, 5, -100)
  ridge.userData.sunOccluder = true
  ridge.userData.excludeFromWaterReflection = true
  scene.add(ridge)
  assert.equal(terrainSunVisibility(scene, direction), 0, 'terrain excluded from reflection still blocks the sun')
  assert(direction.equals(originalDirection), 'terrain occlusion must not drift the live sun direction')
  assert.equal(terrainSunVisibility(scene, new Vector3(0, 0.2, -1).normalize()), 1)
  // Aim at the upper edge of the ridge's front face, 95m from the bay.
  const partial = terrainSunVisibility(scene, new Vector3(0, 9 / 95, -1).normalize())
  assert(partial > 0 && partial < 1)
  ridge.visible = false
  assert.equal(terrainSunVisibility(scene, direction), 1)
  ridge.visible = true
  ridge.userData.sunOccluder = false
  assert.equal(
    terrainSunVisibility(scene, direction),
    1,
    'local docks must not extinguish sunlight across the entire bay',
  )
  ridge.geometry.dispose()
  ridge.material.dispose()
})
