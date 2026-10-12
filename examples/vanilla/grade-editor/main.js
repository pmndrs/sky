/**
 * The demo owns its scene, haze, lighting and camera. The same optional
 * Sky Editor that consumer apps import supplies the floating authoring UI.
 */

import * as THREE from 'three/webgpu'
import { pass, renderOutput } from 'three/tsl'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import { Sky, SkyGradePreview, ditherOutput } from '@pmndrs/sky'
import { createSkyEditor } from '@pmndrs/sky/editor'

const LATITUDE = 37.7
const DAY_OF_YEAR = 172

const $ = (id) => document.getElementById(id)

// ---- renderer + sky ---------------------------------------------------------

const mainCanvas = $('main')
const renderer = new THREE.WebGPURenderer({ canvas: mainCanvas, antialias: false })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.5
renderer.shadowMap.enabled = true
await renderer.init()

const sky = new Sky(renderer, {
  timeOfDay: 18.9,
  latitude: LATITUDE,
  dayOfYear: DAY_OF_YEAR,
  exposure: 40,
  sunDisc: true,
})
await sky.compileAsync()

const scene = new THREE.Scene()
sky.attach(scene)

const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 120000)
camera.position.set(0, 1.7, 0)

// ---- scene: ground, props near the camera, mountains for the haze -----------

{
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(240000, 240000),
    new THREE.MeshStandardMaterial({ color: 0x737d5c, roughness: 1 }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)

  // A ring of props around the camera, so any look direction has something lit.
  const props = [
    { geo: new THREE.SphereGeometry(1.1, 64, 32), mat: { color: 0xffffff, metalness: 1, roughness: 0.02 } },
    { geo: new THREE.SphereGeometry(1.1, 64, 32), mat: { color: 0xe6e6e6, roughness: 0.85 } },
    { geo: new THREE.BoxGeometry(1.8, 2.4, 1.8), mat: { color: 0xc96f4a, roughness: 0.7 } },
    { geo: new THREE.CylinderGeometry(0.8, 0.8, 3, 32), mat: { color: 0x4f7fbf, roughness: 0.5 } },
    { geo: new THREE.TorusKnotGeometry(0.8, 0.28, 128, 24), mat: { color: 0xf2d08a, roughness: 0.35, metalness: 0.2 } },
    { geo: new THREE.SphereGeometry(1.1, 64, 32), mat: { color: 0x7a9a5a, roughness: 0.6 } },
  ]
  props.forEach((p, i) => {
    const a = (i / props.length) * Math.PI * 2 + 0.3
    const r = 9 + (i % 2) * 3
    const m = new THREE.Mesh(p.geo, new THREE.MeshStandardMaterial(p.mat))
    p.geo.computeBoundingBox()
    m.position.set(Math.cos(a) * r, -p.geo.boundingBox.min.y, Math.sin(a) * r)
    m.castShadow = m.receiveShadow = true
    scene.add(m)
  })

  // Mountains 3–45 km out, all the way round: distant silhouettes for the haze.
  const mountainMat = new THREE.MeshStandardMaterial({ color: 0x6b6f6a, roughness: 1 })
  const cone = new THREE.ConeGeometry(1, 1, 7)
  let seed = 7
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (const d of [3000, 7000, 14000, 26000, 45000]) {
    const n = 26
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand() * 0.2
      const h = d * (0.04 + rand() * 0.05)
      const m = new THREE.Mesh(cone, mountainMat)
      m.scale.set(h * 1.8, h, h * 1.8)
      m.position.set(Math.cos(a) * d, h / 2, Math.sin(a) * d)
      scene.add(m)
    }
  }
}

const sun = sky.createSun({ intensity: 4, castShadow: true })
sun.attach(scene)
sun.fitShadowToBox(new THREE.Box3(new THREE.Vector3(-16, 0, -16), new THREE.Vector3(16, 6, 16)))
const ambient = sky.createAmbient()
ambient.attach(scene)
await sky.enableStars()

// First-person look-around: orbit a point just in front of the eye.
const controls = new OrbitControls(camera, mainCanvas)
controls.enableZoom = false
controls.enablePan = false
controls.rotateSpeed = -0.35
controls.minDistance = controls.maxDistance = 0.5
const lookToward = (azimuthOffset, pitchDeg) => {
  const s = sky.baker.sky.sunDirection.value
  const base = Math.atan2(s.z, s.x) + azimuthOffset
  const pitch = THREE.MathUtils.degToRad(pitchDeg)
  const dir = new THREE.Vector3(Math.cos(base) * Math.cos(pitch), Math.sin(pitch), Math.sin(base) * Math.cos(pitch))
  controls.target.copy(camera.position).addScaledVector(dir, 0.5)
  controls.update()
}

// Haze + dither: the grade's fill and colorize reach distant geometry too, and
// the dither keeps dark dusk gradients from banding at 8 bits.
const scenePass = pass(scene, camera)
const pipeline = new THREE.RenderPipeline(renderer)
pipeline.outputColorTransform = false
const hazed = sky.applyHaze(scenePass.getTextureNode(), { scenePass })
pipeline.outputNode = ditherOutput(hazed)
/** Debug A/B for the dither (window.__editor.setDither). */
function setDither(on) {
  pipeline.outputNode = on ? ditherOutput(hazed) : renderOutput(hazed)
  pipeline.needsUpdate = true
}

// The app supplies its scene, helpers and output pipeline. All authoring UI
// comes from the optional editor entry, the same tool consumer apps import.
sky.setGrade('storybook')
const view = $('view')
const editor = createSkyEditor({
  sky,
  renderer,
  container: view,
  storageKey: 'pmndrs-sky-grade-editor',
  capabilities: { ambient: true, haze: true },
  onFocusChange: (focused) => {
    controls.enabled = !focused
  },
})
$('edit').addEventListener('click', () => editor.toggle())
for (const button of $('camera').querySelectorAll('button[data-look]')) {
  const looks = { sun: [0, 12], away: [Math.PI, 12], up: [0, 70], down: [0, -25] }
  button.addEventListener('click', () => lookToward(...looks[button.dataset.look]))
}
new ResizeObserver(() => {
  const width = view.clientWidth
  const height = view.clientHeight
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}).observe(view)
lookToward(0, 12)

// Numeric grading checks use the same preview mapping as the packaged tool.
Object.assign(window, {
  __sky: sky,
  __renderer: renderer,
  __THREE: THREE,
  __tool: editor,
  __SkyGradePreview: SkyGradePreview,
})
Object.defineProperty(window, '__grade', { get: () => sky.grade })
window.__editor = {
  setElevation: (elevation) => sky.setSunDirection({ elevation, azimuth: sky.sunAzimuth }),
  setTime: (time) => sky.setTimeOfDay(time),
  setDither,
  lookToward,
}
let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  editor.update(dt)
  sky.update(camera)
  sky.updateAerialPerspective()
  controls.update()
  pipeline.render()
  editor.render()
})
addEventListener(
  'pagehide',
  () => {
    editor.dispose()
    controls.dispose()
    ambient.dispose()
    sun.dispose()
    sky.dispose()
    renderer.dispose()
  },
  { once: true },
)
