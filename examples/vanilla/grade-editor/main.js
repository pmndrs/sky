/**
 * Sky grade editor. Top: the scene, graded live (sky, haze, IBL, ambient).
 * Middle: the time-of-day timeline with the grade's keyframes. Bottom: the
 * whole sky dome flattened (azimuth from the sun × elevation) with zone
 * guides, and the keyframe inspector.
 *
 * Everything here goes through the public API — `SkyGrade` for the data,
 * `sky.setGrade` to apply it, `SkyGradePreview` for the dome view — so a
 * consumer app can build its own version of any panel.
 */

import * as THREE from 'three/webgpu'
import { pass, renderOutput } from 'three/tsl'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import {
  Sky,
  SkyGrade,
  SkyGradePreview,
  ditherOutput,
  grades,
  horizonToZenith,
  resolveGrade,
  resolveGradeKey,
  solarPosition,
  solidSky,
} from '@pmndrs/sky'

import { Timeline } from './timeline.js'
import { Inspector } from './inspector.js'
import { LutOverlay } from './overlay.js'

const STORAGE_KEY = 'pmndrs-sky-grade-editor'
const LATITUDE = 37.7
const DAY_OF_YEAR = 172
/** Within this many degrees of a keyframe, the playhead counts as on it. */
const ON_KEY_TOLERANCE = 0.25

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

// ---- the grade --------------------------------------------------------------

function loadStored() {
  try {
    const text = localStorage.getItem(STORAGE_KEY)
    return text ? SkyGrade.fromJSON(text) : null
  } catch {
    return null
  }
}

const grade = loadStored() ?? resolveGrade('storybook')
sky.setGrade(grade)

// ---- dome preview on its own canvas -----------------------------------------

const preview = new SkyGradePreview(sky, { mode: 'split', elevationRange: [-12, 90] })
const lutCanvas = $('lutGpu')
const lutTarget = new THREE.CanvasTarget(lutCanvas)
lutTarget.setPixelRatio(Math.min(window.devicePixelRatio, 2))
// Resized only while it is the active canvas target: the renderer resizes the
// depth buffer that goes with a canvas target from that target's resize event,
// which it only listens to on the active one.
let lutSize = null
new ResizeObserver(() => (lutSize = [lutCanvas.clientWidth, lutCanvas.clientHeight])).observe(lutCanvas)

const mainTarget = renderer.getCanvasTarget()
const view = $('view')
new ResizeObserver(() => {
  const w = view.clientWidth
  const h = view.clientHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}).observe(view)

// ---- time / elevation -------------------------------------------------------

const solar = (t) => solarPosition({ timeOfDay: t, latitude: LATITUDE, dayOfYear: DAY_OF_YEAR })

/** Solar noon (highest sun) by golden-section search. */
function findNoon() {
  let a = 10
  let b = 14
  for (let i = 0; i < 40; i++) {
    const m1 = b - (b - a) / 1.618
    const m2 = a + (b - a) / 1.618
    if (solar(m1).elevation > solar(m2).elevation) b = m2
    else a = m1
  }
  return (a + b) / 2
}
const NOON = findNoon()
const NOON_ELEVATION = solar(NOON).elevation
const MIDNIGHT_ELEVATION = solar(NOON + 12).elevation

/** Afternoon/evening time at which the sun stands at `elevation` (clamped to the reachable range). */
function timeForElevation(elevation) {
  if (elevation >= NOON_ELEVATION) return NOON
  if (elevation <= MIDNIGHT_ELEVATION) return NOON + 12
  let a = NOON
  let b = NOON + 12
  for (let i = 0; i < 50; i++) {
    const m = (a + b) / 2
    if (solar(m).elevation > elevation) a = m
    else b = m
  }
  return (a + b) / 2
}

const state = { time: 18.9, playing: false, speed: 1, bypass: false, mode: 'split' }

function setTime(t) {
  state.time = ((t % 24) + 24) % 24
  sky.setTimeOfDay(state.time)
  $('time').value = state.time
  $('timeOut').textContent = formatTime(state.time)
  syncSelection()
}

/** Put the sun at `elevation` — through the time of day when reachable, directly otherwise. */
function setElevation(elevation) {
  if (elevation > NOON_ELEVATION + 1e-3 || elevation < MIDNIGHT_ELEVATION - 1e-3) {
    sky.setSunDirection({ elevation, azimuth: sky.sunAzimuth })
    syncSelection()
    return
  }
  setTime(timeForElevation(elevation))
}

function formatTime(t) {
  const h = Math.floor(t)
  const m = Math.floor((t - h) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// ---- selection: the inspector edits what the playhead is on -----------------

let selected = null
/** The settings shown and edited: the selected keyframe, or the interpolated ones. */
let viewKey = null
let inspectorStamp = ''

function syncSelection() {
  const e = sky.sunElevation
  // A one-keyframe grade holds all day (a fixed sky), so it is edited
  // wherever the playhead is; auto-keying would quietly make it time-varying.
  selected = grade.keys.length === 1 ? grade.keys[0] : grade.keyAt(e, ON_KEY_TOLERANCE)
  refreshInspector()
}

function refreshInspector(force = false) {
  const e = sky.sunElevation
  const stamp = `${grade.revision}|${selected ? grade.keys.indexOf(selected) : 'g' + e.toFixed(2)}`
  if (!force && stamp === inspectorStamp) return
  inspectorStamp = stamp
  if (selected) {
    viewKey = selected
    inspector.show({
      key: selected,
      ghost: false,
      elevation: e,
      index: grade.keys.indexOf(selected),
      count: grade.keys.length,
    })
  } else {
    viewKey = resolveGradeKey(grade.interpolatedKeyInput(e))
    inspector.show({ key: viewKey, ghost: true, elevation: e, count: grade.keys.length })
  }
}

// ---- undo -------------------------------------------------------------------

const history = { stack: [JSON.stringify(grade)], index: 0 }

function commit() {
  const snap = JSON.stringify(grade)
  if (snap === history.stack[history.index]) return
  history.stack.length = history.index + 1
  history.stack.push(snap)
  if (history.stack.length > 200) history.stack.shift()
  history.index = history.stack.length - 1
  updateUndoButtons()
}

function restore(snap) {
  const loaded = SkyGrade.fromJSON(snap)
  grade.name = loaded.name
  $('name').value = grade.name
  grade.setKeys(loaded.keys)
  syncSelection()
}

function undo() {
  if (history.index === 0) return
  history.index--
  restore(history.stack[history.index])
  updateUndoButtons()
}

function redo() {
  if (history.index >= history.stack.length - 1) return
  history.index++
  restore(history.stack[history.index])
  updateUndoButtons()
}

function updateUndoButtons() {
  $('undo').disabled = history.index === 0
  $('redo').disabled = history.index >= history.stack.length - 1
}

// Autosave.
let saveTimer = 0
grade.onChange(() => {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(grade))
    } catch {
      /* private mode: no autosave */
    }
  }, 300)
})

// ---- panels -----------------------------------------------------------------

function editKey(patch, { commit: doCommit }) {
  if (!selected) {
    if (grade.keys.length >= 16) return toast('16 keyframes is the maximum')
    selected = grade.insertKeyAt(Math.round(sky.sunElevation * 10) / 10)
  }
  selected = grade.updateKey(selected, patch)
  refreshInspector()
  if (doCommit) commit()
}

const inspector = new Inspector($('inspector'), {
  onEdit: editKey,
  onAddKey: () => {
    selected = grade.insertKeyAt(Math.round(sky.sunElevation * 10) / 10)
    commit()
    refreshInspector(true)
  },
  onDelete: () => deleteSelected(),
  onElevation: (e) => {
    if (!selected) return
    selected = grade.updateKey(selected, { elevation: e })
    commit()
    setElevation(e)
  },
})

function deleteSelected() {
  if (!selected) return
  grade.removeKey(selected)
  selected = null
  commit()
  syncSelection()
}

const timeline = new Timeline($('timelineCanvas'), {
  grade: () => grade,
  elevation: () => sky.sunElevation,
  selected: () => selected,
  onScrub: (e) => {
    stopPlaying()
    setElevation(e)
  },
  onSelectKey: (key) => {
    stopPlaying()
    setElevation(key.elevation)
  },
  onMoveKey: (key, e) => {
    const moved = grade.updateKey(key, { elevation: e })
    setElevation(e)
    selected = moved
    refreshInspector(true)
    return moved
  },
  onMoveKeyEnd: () => commit(),
  onInsertKey: (e) => {
    if (grade.keys.length >= 16) return toast('16 keyframes is the maximum')
    grade.insertKeyAt(e)
    commit()
    setElevation(e)
  },
})

const overlay = new LutOverlay($('lutOverlay'), $('lutHover'), {
  preview: () => preview,
  key: () => viewKey,
  sunElevation: () => sky.sunElevation,
  mode: () => state.mode,
  onPickZone: (zone) => inspector.flashZone(zone),
})

// ---- toolbar ----------------------------------------------------------------

$('time').addEventListener('input', (e) => {
  stopPlaying()
  setTime(+e.target.value)
})

function stopPlaying() {
  state.playing = false
  $('play').textContent = '▶'
}
$('play').addEventListener('click', () => {
  state.playing = !state.playing
  $('play').textContent = state.playing ? '❚❚' : '▶'
})
$('speed').addEventListener('change', (e) => (state.speed = +e.target.value))

function setBypass(on) {
  state.bypass = on
  sky.setGrade(on ? null : grade)
  const b = $('bypass')
  b.classList.toggle('on', !on)
  b.textContent = on ? 'Physical (bypass)' : 'Grade on'
}
$('bypass').addEventListener('click', () => setBypass(!state.bypass))

const presetSelect = $('preset')
// Helper-made starting points next to the registered grades.
const HELPER_PRESETS = {
  __gradient: ['Gradient (horizon → zenith)', () => horizonToZenith('#f3c98f', '#4f8fdb', { name: 'gradient' })],
  __tinted: [
    'Tinted gradient (keeps physical light)',
    () => horizonToZenith('#ffc9a0', '#5a7fd0', { replace: 0, name: 'tinted gradient' }),
  ],
  __solid: ['Solid colour', () => solidSky('#7f9fd0', { name: 'solid' })],
}
presetSelect.append(new Option('Start from…', ''), new Option('Physical (no keyframes)', '__empty'))
for (const [value, [label]] of Object.entries(HELPER_PRESETS)) presetSelect.append(new Option(label, value))
for (const name of Object.keys(grades)) presetSelect.append(new Option(name, name))
presetSelect.addEventListener('change', () => {
  const v = presetSelect.value
  presetSelect.value = ''
  if (!v) return
  const src = v === '__empty' ? new SkyGrade() : HELPER_PRESETS[v] ? HELPER_PRESETS[v][1]() : resolveGrade(v)
  grade.name = v === '__empty' ? '' : src.name || v
  $('name').value = grade.name
  grade.setKeys(src.keys)
  commit()
  syncSelection()
  toast(v === '__empty' ? 'Cleared — physical sky' : `Loaded “${grade.name}”`)
})

$('new').addEventListener('click', () => {
  grade.setKeys([])
  commit()
  syncSelection()
})
$('undo').addEventListener('click', undo)
$('redo').addEventListener('click', redo)

$('name').value = grade.name
$('name').addEventListener('change', (e) => {
  grade.name = e.target.value.trim()
  commit()
})

$('save').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(grade, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${(grade.name || 'sky-grade').replace(/[^\w.-]+/g, '-')}.json`
  a.click()
  URL.revokeObjectURL(a.href)
})
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(grade, null, 2))
    toast('Grade JSON copied')
  } catch {
    toast('Clipboard unavailable — use Save')
  }
})
$('load').addEventListener('click', () => $('file').click())
$('file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  try {
    restore(await file.text())
    commit()
    toast(`Loaded ${file.name}`)
  } catch (err) {
    toast(`Not a sky grade: ${err.message}`)
  }
})

for (const b of $('lutTabs').querySelectorAll('button[data-mode]')) {
  b.addEventListener('click', () => {
    state.mode = b.dataset.mode
    preview.setMode(state.mode)
    for (const o of $('lutTabs').querySelectorAll('button[data-mode]')) o.classList.toggle('on', o === b)
  })
}
$('guides').addEventListener('change', (e) => (overlay.showGuides = e.target.checked))

const LOOKS = { sun: [0, 12], away: [Math.PI, 12], up: [0, 70], down: [0, -25] }
for (const b of $('camera').querySelectorAll('button')) {
  b.addEventListener('click', () => lookToward(...LOOKS[b.dataset.look]))
}

let toastTimer = 0
function toast(text) {
  const t = $('toast')
  t.textContent = text
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600)
}

window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName
  const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
    return
  }
  if (typing) return
  if (e.key === ' ') {
    e.preventDefault()
    $('play').click()
  } else if (e.key === 'b' || e.key === 'B') {
    setBypass(!state.bypass)
  } else if (e.key === 'k' || e.key === 'K') {
    inspector.h.onAddKey()
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    deleteSelected()
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    stopPlaying()
    setTime(state.time + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.5 : 0.05))
  }
})

// ---- loop -------------------------------------------------------------------

setTime(state.time)
lookToward(0, 12)
updateUndoButtons()

// Scripted checks / console poking.
Object.assign(window, { __sky: sky, __grade: grade, __renderer: renderer, __preview: preview, __THREE: THREE })
window.__editor = { setTime, setElevation, setBypass, setDither, lookToward, state, ambient }

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  if (state.playing) setTime(state.time + dt * state.speed)

  timeline.setRange(
    Math.floor(Math.min(MIDNIGHT_ELEVATION, ...grade.keys.map((k) => k.elevation)) - 2),
    Math.ceil(Math.max(NOON_ELEVATION, ...grade.keys.map((k) => k.elevation)) + 2),
  )
  refreshInspector()

  sky.update(camera)
  sky.updateAerialPerspective()
  controls.update()
  pipeline.render()

  renderer.setCanvasTarget(lutTarget)
  if (lutSize) {
    lutTarget.setSize(lutSize[0], lutSize[1], false)
    lutSize = null
  }
  preview.render(renderer)
  renderer.setCanvasTarget(mainTarget)

  timeline.draw()
  overlay.draw()

  const k = selected ? `keyframe ${grade.keys.indexOf(selected) + 1}/${grade.keys.length}` : 'between keyframes'
  $('status').textContent =
    `${formatTime(state.time)} · sun ${sky.sunElevation.toFixed(1)}° · ${k}` + (state.bypass ? ' · BYPASS' : '')
})
