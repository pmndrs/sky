/**
 * @pmndrs/sky as one panel of 20-reference-compare.html: his reference scene
 * (a 1 km sphere of albedo 0.8 on a planet of albedo (0, 0, 0.04)), the live
 * per-pixel sky, haze, and a set of display curves. Moved here from the
 * Bruneton compare page; the tuning knobs are unchanged.
 */
import * as THREE from 'three/webgpu'
import {
  pass,
  uniform,
  float,
  vec3,
  vec4,
  exp,
  pow,
  mix,
  abs,
  uv,
  renderOutput,
  Fn,
  pmremTexture,
  normalWorld,
  positionWorld,
  materialColor,
} from 'three/tsl'
import { Sky } from '@pmndrs/sky'
import { SOLAR_IRRADIANCE, SOLAR_RADIANCE_G, BRUNETON_GROUND_ALBEDO } from './bruneton-side.js'

const KM = 1000
export const TONE_MODES = { bruneton: 0, aces: 1, agx: 2, neutral: 3 }

// Z-up (Bruneton's frame) → Y-up (three): (x, y, z) ↦ (x, z, −y). A proper
// rotation, applied to camera, up vector and sun alike, so nothing is mirrored.
export const zupToYup = ([x, y, z], s = 1) => new THREE.Vector3(x * s, z * s, -y * s)

// CPU twin of the Transmittance LUT integration (40 steps, 0.3 offset) — sun-ray
// transmittance from the surface, for the DirectionalLight tint.
export function transmittanceToSun(altKm, cosZenith, p) {
  const r0 = p.bottomRadius + altKm
  const b = 2 * r0 * cosZenith
  const discTop = b * b - 4 * (r0 * r0 - p.topRadius * p.topRadius)
  if (discTop < 0) return [0, 0, 0]
  const discGround = b * b - 4 * (r0 * r0 - p.bottomRadius * p.bottomRadius)
  if (discGround >= 0 && (-b - Math.sqrt(discGround)) / 2 > 0) return [0, 0, 0]
  const tTop = (-b + Math.sqrt(discTop)) / 2
  const sinZ = Math.sqrt(Math.max(0, 1 - cosZenith * cosZenith))
  const od = [0, 0, 0]
  let tPrev = 0
  for (let i = 0; i < 40; i++) {
    const t = (tTop * (i + 0.3)) / 40
    const dt = t - tPrev
    tPrev = t
    const h = Math.hypot(t * sinZ, r0 + t * cosZenith) - p.bottomRadius
    const dm = Math.exp(p.mieDensityExpScale * h)
    const dr = Math.exp(p.rayleighDensityExpScale * h)
    const o =
      h < p.absorptionDensity0LayerWidth
        ? p.absorptionDensity0LinearTerm * h + p.absorptionDensity0ConstantTerm
        : p.absorptionDensity1LinearTerm * h + p.absorptionDensity1ConstantTerm
    const dz = Math.min(1, Math.max(0, o))
    for (let k = 0; k < 3; k++) {
      const key = 'xyz'[k]
      od[k] += (p.mieExtinction[key] * dm + p.rayleighScattering[key] * dr + p.absorptionExtinction[key] * dz) * dt
    }
  }
  return od.map((v) => Math.exp(-v))
}

/**
 * @param {THREE.WebGPURenderer} renderer initialised
 * @param {{ debug?: string | null, dbg?: string | null, bypassHaze?: boolean, far?: number }} [opts]
 *   debug: the library's haze ?debug= modes; dbg: page-local depth views (tone curve bypassed)
 */
export function createOursSide(renderer, { debug = null, dbg = null, bypassHaze = false, far = 4e7 } = {}) {
  // Knobs. `units` decides what the sky is multiplied by before the display
  // curve: 'bruneton' puts it in his spectral-radiance units so comparisons are
  // physical; 'demo' reproduces what the other examples ship (luminanceScale 40).
  const ours = {
    atmospherePreset: 'earth',
    units: 'bruneton',
    luminanceScale: 40,
    // Sun spectrum (demo units only): 'neutral' is what the library ships;
    // 'bruneton' is his (1.474, 1.85, 1.91) normalised to green.
    sunTint: 'neutral', // neutral | bruneton | custom
    tintR: 1.0,
    tintG: 1.0,
    tintB: 1.0,
    tone: 'bruneton', // bruneton | aces | agx | neutral
    toneExposure: 0.5,
    // Multiplier on the physically consistent DirectionalLight (E_sun · T).
    // The demos use a fixed intensity 4, which is ~1/7 of this at noon.
    sunLightScale: 1.0,
    hazeStrength: 1.0,
    // Sky light on the sphere and ground: 'environment' is the library's way
    // (irradiance from the baked sky, which includes light from below the
    // horizon); 'hemisphere (his)' is his GetSunAndSkyIrradiance model.
    skyLight: 'environment',
    groundAlbedo: BRUNETON_GROUND_ALBEDO,
    multiScatteringFactor: 1.0,
    turbidity: 1.0,
    sunDisc: true,
    sunLight: true,
    showSphere: true,
    showGround: true,
  }

  const sky = new Sky(renderer, {
    preset: 'earth',
    sunDirection: { elevation: 45, azimuth: 0, raw: true },
    exposure: 1,
    sunDisc: true,
    groundAlbedo: BRUNETON_GROUND_ALBEDO,
    enableAerialPerspective: true,
  })
  const bottomRadiusM = sky.baker.atmosphereParams.bottomRadius * KM
  const planetCenter = new THREE.Vector3(0, -bottomRadiusM, 0)

  const scene = new THREE.Scene()
  sky.attach(scene)
  // Live per-pixel sky instead of the baked cube background — no cube
  // resolution in the way of the comparison. IBL still comes from the cube.
  scene.background = null
  const skyMesh = sky.baker.createSkyMesh()
  scene.add(skyMesh)

  const camera = new THREE.PerspectiveCamera(50, 1, 1, far)

  // Pure Lambert, like his `albedo / π · (sun_irradiance + sky_irradiance)`:
  // MeshLambertMaterial for the direct sun (no specular lobe — MeshStandard
  // keeps a grazing F90 = 1 term even with specularIntensity 0), plus the sky
  // irradiance as an emissive term sampled from the sky's PMREM at roughness 1.
  const lambert = (r, g, b) =>
    new THREE.MeshLambertMaterial({
      color: new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace),
      reflectivity: 0,
      side: THREE.DoubleSide,
    })
  // 'hemisphere (his)': sky irradiance of a horizontal surface scaled by
  // (1 + n·up) / 2, so nothing arrives from below, and on the ground his
  // closed-form occlusion of the sky by the sphere (GetSkyVisibility).
  const lambertMaterials = []
  const hisSkyLightU = uniform(0)
  const planetCenterU = uniform(planetCenter.clone())
  const sphereCenterU = uniform(new THREE.Vector3(0, 1 * KM, 0))
  const wireSkyIrradiance = () => {
    const env = sky.baker.environmentTexture
    if (!env) return
    for (const m of lambertMaterials) {
      if (m.userData.envWired === env) continue
      const envLight = pmremTexture(env, normalWorld, float(1.0))
      const up = positionWorld.sub(planetCenterU).normalize()
      const hemisphere = pmremTexture(env, vec3(0, 1, 0), float(1.0)).mul(normalWorld.dot(up).add(1).mul(0.5))
      let hisLight = hemisphere
      if (m.userData.skyOccluder) {
        const p = positionWorld.sub(sphereCenterU)
        const d = p.length()
        hisLight = hemisphere.mul(
          p.y
            .div(d)
            .mul(float(KM * KM).div(d.mul(d)))
            .add(1),
        )
      }
      m.emissiveNode = materialColor.mul(mix(envLight, hisLight, hisSkyLightU))
      m.userData.envWired = env
      m.needsUpdate = true
    }
  }

  // His scene: a 1 km sphere (albedo 0.8) resting on the ground at the origin…
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1 * KM, 96, 64), lambert(0.8, 0.8, 0.8))
  lambertMaterials.push(sphere.material)
  sphere.position.set(0, 1 * KM, 0)
  sphere.castShadow = true
  sphere.receiveShadow = true
  scene.add(sphere)

  // …and the planet (albedo (0, 0, 0.04)). A local spherical cap with geometric
  // ring spacing puts the true horizon exactly where the sky LUT expects it; a
  // coarse whole-planet sphere underneath covers the space views.
  const buildCap = (R, dMin, dMax, rings, segs) => {
    const positions = [0, 0, 0]
    const normals = [0, 1, 0]
    const indices = []
    for (let i = 0; i < rings; i++) {
      const d = dMin * Math.pow(dMax / dMin, i / (rings - 1))
      const th = d / R
      const st = Math.sin(th)
      const ct = Math.cos(th)
      for (let j = 0; j < segs; j++) {
        const ph = (j / segs) * Math.PI * 2
        positions.push(R * st * Math.cos(ph), R * ct - R, R * st * Math.sin(ph))
        normals.push(st * Math.cos(ph), ct, st * Math.sin(ph))
      }
    }
    const base = (i) => 1 + i * segs
    for (let j = 0; j < segs; j++) indices.push(0, base(0) + ((j + 1) % segs), base(0) + j)
    for (let i = 0; i < rings - 1; i++) {
      for (let j = 0; j < segs; j++) {
        const a = base(i) + j
        const b = base(i) + ((j + 1) % segs)
        const c = base(i + 1) + j
        const d = base(i + 1) + ((j + 1) % segs)
        indices.push(a, d, c, a, b, d)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    g.setIndex(indices)
    return g
  }
  const groundMat = lambert(0, 0, 0.04)
  groundMat.userData.skyOccluder = true
  lambertMaterials.push(groundMat)
  const groundCap = new THREE.Mesh(buildCap(bottomRadiusM, 5, 1500 * KM, 200, 128), groundMat)
  groundCap.receiveShadow = true
  groundCap.frustumCulled = false
  scene.add(groundCap)
  const groundSphere = new THREE.Mesh(new THREE.SphereGeometry(bottomRadiusM, 256, 128), groundMat)
  groundSphere.position.copy(planetCenter)
  scene.add(groundSphere)

  // Direct sun: colour and intensity set per frame to E_sun · T(sun) in the
  // active units, which is what his GetSunAndSkyIrradiance returns.
  const sun = sky.createSun({ intensity: 1, castShadow: true, shadowMapSize: 2048, distance: 50 * KM })
  const shadowCam = sun.light.shadow.camera
  shadowCam.left = shadowCam.bottom = -2.5 * KM
  shadowCam.right = shadowCam.top = 2.5 * KM
  shadowCam.near = 1
  shadowCam.far = 100 * KM
  shadowCam.updateProjectionMatrix()
  sun.light.shadow.bias = -0.0005
  sun.light.shadow.normalBias = 4
  sun.attach(scene)

  // ---- post: haze, then the display curve ----
  const scenePass = pass(scene, camera)
  const post = new THREE.RenderPipeline(renderer)
  post.outputColorTransform = false
  // ?debug=is-sky | w | ap-rgb | ap-alpha | beyond | lin-depth | view-z (see HazePostProcess)
  const hazed = sky.applyHaze(scenePass.getTextureNode(), {
    scenePass,
    policy: 'auto',
    strength: 1.0,
    debugMode: debug,
  })

  const toneU = uniform(0) // TONE_MODES; 1–3 use renderer.toneMappingExposure
  const exposureU = uniform(10)
  // 1 while rendering into `linearTarget` for readback: linear radiance out.
  const linearOutU = uniform(0)
  const cameraFarU = sky._cameraFar
  const nearU = uniform(camera.near)
  const farU = uniform(camera.far)
  post.outputNode = Fn(() => {
    // Page-local depth debug (?dbg=), independent of the library's ?debug= modes
    // and returned before the tone curve.
    if (dbg === 'depth') return vec4(vec3(scenePass.getTextureNode('depth').sample(uv()).x), 1.0)
    if (dbg === 'viewz') return vec4(vec3(abs(scenePass.getViewZNode()).div(cameraFarU)), 1.0)
    // |viewZ| in units of 100 km (6 km → 0.06)
    if (dbg === 'viewzkm') return vec4(vec3(abs(scenePass.getViewZNode()).div(1e5)), 1.0)
    // (1 - depth) encoded as fract(×1e2), fract(×1e4), fract(×1e6) in r, g, b
    if (dbg === 'depthenc') {
      const od = float(1.0).sub(scenePass.getTextureNode('depth').x)
      return vec4(od.mul(1e2).fract(), od.mul(1e4).fract(), od.mul(1e6).fract(), 1.0)
    }
    if (dbg === 'depth1m') return vec4(vec3(float(1.0).sub(scenePass.getTextureNode('depth').x).mul(1e3)), 1.0)
    if (dbg === 'viewzmine') {
      const dep = scenePass.getTextureNode('depth').x
      const vz = nearU.mul(farU).div(farU.sub(nearU).mul(dep).sub(farU))
      return vec4(vec3(abs(vz).div(1e5)), 1.0)
    }
    if (dbg === 'issky')
      return vec4(vec3(scenePass.getViewZNode().lessThan(cameraFarU.mul(-0.999)).select(float(1.0), float(0.0))), 1.0)
    // ?bypass=1 skips the haze node entirely (a `select`, not a `mix`, so a NaN
    // in the unused branch cannot leak through).
    const lin = bypassHaze ? scenePass.getTextureNode().rgb : hazed.rgb
    // His demo: color = pow(1 - exp(-radiance / white_point * exposure), 1/2.2), white_point = 1.
    const bruneton = pow(float(1.0).sub(exp(lin.mul(exposureU).negate())), float(1.0 / 2.2))
    const aces = renderOutput(vec4(lin, 1.0), THREE.ACESFilmicToneMapping, THREE.SRGBColorSpace).rgb
    const agx = renderOutput(vec4(lin, 1.0), THREE.AgXToneMapping, THREE.SRGBColorSpace).rgb
    const neutral = renderOutput(vec4(lin, 1.0), THREE.NeutralToneMapping, THREE.SRGBColorSpace).rgb
    const out = toneU
      .lessThan(0.5)
      .select(bruneton, toneU.lessThan(1.5).select(aces, toneU.lessThan(2.5).select(agx, neutral)))
    return vec4(linearOutU.greaterThan(0.5).select(lin, out), 1.0)
  })()

  // ---- knob application ----
  let sunScale = SOLAR_IRRADIANCE
  const BRUNETON_TINT = SOLAR_IRRADIANCE.map((v) => v / SOLAR_IRRADIANCE[1])
  const currentTint = () =>
    ours.sunTint === 'bruneton'
      ? BRUNETON_TINT
      : ours.sunTint === 'custom'
        ? [ours.tintR, ours.tintG, ours.tintB]
        : [1, 1, 1]
  const applyUnits = () => {
    if (ours.units === 'bruneton') {
      sky.setExposure(1)
      sky.setSunColor('neutral')
      sky.setSkyLuminanceFactor(SOLAR_IRRADIANCE)
      sky.mesh.sunDiscIntensity.value = SOLAR_RADIANCE_G
      sunScale = SOLAR_IRRADIANCE
    } else {
      const L = ours.luminanceScale
      const tint = currentTint()
      sky.setExposure(L)
      sky.setSunColor(tint)
      sky.setSkyLuminanceFactor([1, 1, 1])
      sky.mesh.sunDiscIntensity.value = 20 // SkyAtmosphereMesh default
      sunScale = tint.map((t) => L * t)
    }
  }
  const applyTone = () => {
    toneU.value = TONE_MODES[ours.tone] ?? 0
    renderer.toneMappingExposure = ours.toneExposure
  }
  const applyAtmosphere = () => {
    sky.setPreset(ours.atmospherePreset)
    sky.setGroundAlbedo(ours.groundAlbedo)
    sky.setMultiScatteringFactor(ours.multiScatteringFactor)
    sky.setTurbidity(ours.turbidity)
  }
  const applySkyLight = () => (hisSkyLightU.value = ours.skyLight === 'environment' ? 0 : 1)
  const applyObjects = () => {
    sphere.visible = ours.showSphere
    groundCap.visible = groundSphere.visible = ours.showGround
    sun.light.visible = ours.sunLight
    sky.setSunDisc(ours.sunDisc)
  }
  const applyAll = () => {
    applyUnits()
    applyTone()
    applySkyLight()
    applyObjects()
    sky.setHazeStrength(ours.hazeStrength)
  }
  // One-click starting points for "what should the demos ship?"
  const tuningPresets = {
    'bruneton units + his curve': { units: 'bruneton', tone: 'bruneton', sunTint: 'neutral' },
    'demo today (LS 40, ACES 0.5)': {
      units: 'demo',
      luminanceScale: 40,
      tone: 'aces',
      toneExposure: 0.5,
      sunTint: 'neutral',
    },
    'proposed (LS 40, ACES 0.3)': {
      units: 'demo',
      luminanceScale: 40,
      tone: 'aces',
      toneExposure: 0.3,
      sunTint: 'neutral',
    },
    'proposed + bruneton tint': {
      units: 'demo',
      luminanceScale: 40,
      tone: 'aces',
      toneExposure: 0.3,
      sunTint: 'bruneton',
    },
    'AgX 0.3 + bruneton tint': {
      units: 'demo',
      luminanceScale: 40,
      tone: 'agx',
      toneExposure: 0.3,
      sunTint: 'bruneton',
    },
  }
  applyAll()

  const linearTarget = new THREE.RenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false })

  return {
    ours,
    sky,
    scene,
    camera,
    sphere,
    groundCap,
    groundSphere,
    sun,
    post,
    scenePass,
    planetCenter,
    tuningPresets,
    applyUnits,
    applyTone,
    applyAtmosphere,
    applySkyLight,
    applyObjects,
    applyAll,
    applyPreset(name) {
      Object.assign(ours, tuningPresets[name])
      applyAll()
    },
    /** Per-channel factor from our linear output to Bruneton's units. */
    toBrunetonUnits: () => SOLAR_IRRADIANCE.map((s, i) => s / sunScale[i]),
    /**
     * Push the shared camera and sun. `basis` = { right, up, back, position }
     * in Bruneton's frame (Z-up, km); `near` in metres.
     */
    sync(state, basis, near) {
      exposureU.value = state.exposure
      camera.position.copy(zupToYup(basis.position, KM))
      camera.up.copy(zupToYup(basis.up))
      camera.lookAt(camera.position.clone().sub(zupToYup(basis.back)))
      camera.near = near
      camera.updateProjectionMatrix()
      nearU.value = camera.near
      farU.value = camera.far
      skyMesh.position.copy(camera.position)

      // Baker azimuth θ such that setFromSphericalCoords reproduces zupToYup(sun):
      // x = sinφ sinθ = cosA sinZ, z = sinφ cosθ = −sinA sinZ ⇒ θ = atan2(cosA, −sinA).
      const elevation = 90 - THREE.MathUtils.radToDeg(state.sunZenith)
      const azimuth = THREE.MathUtils.radToDeg(Math.atan2(Math.cos(state.sunAzimuth), -Math.sin(state.sunAzimuth)))
      sky.setSunDirection({ elevation, azimuth, raw: true })
      const T = transmittanceToSun(0, Math.cos(state.sunZenith), sky.baker.atmosphereParams)
      const e = [0, 1, 2].map((i) => sunScale[i] * T[i] * ours.sunLightScale)
      const eMax = Math.max(e[0], e[1], e[2], 1e-6)
      sun.light.color.setRGB(e[0] / eMax, e[1] / eMax, e[2] / eMax, THREE.LinearSRGBColorSpace)
      sun.light.intensity = eMax

      sky.update(camera, { planetCenter })
      wireSkyIrradiance() // PMREM exists only after the first bake; identity is stable afterwards
      sky.updateAerialPerspective()
    },
    render() {
      post.render()
    },
    resize(width, height) {
      renderer.setSize(width, height)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    },
    /**
     * Re-render the current frame's output as linear radiance into a float
     * target (same haze, no display curve) and read it back, rows top-down.
     * Call right after render() so both see the same frame.
     */
    renderLinear() {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2())
      if (linearTarget.width !== size.x || linearTarget.height !== size.y) linearTarget.setSize(size.x, size.y)
      linearOutU.value = 1
      renderer.setRenderTarget(linearTarget)
      post.render()
      renderer.setRenderTarget(null)
      linearOutU.value = 0
      return linearTarget
    },
  }
}
