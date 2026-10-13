import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as fiber from '@react-three/fiber/webgpu'
import { setRenderOverride, useStore } from '@react-three/fiber'
import { Sky, useSky } from '@pmndrs/sky/react'
import type { SkySun } from '@pmndrs/sky'
import {
  AdditiveBlending,
  Box3,
  RenderPipeline,
  Vector2,
  Vector3,
  type Node,
  type PerspectiveCamera,
} from 'three/webgpu'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import {
  abs,
  dot,
  exp,
  float,
  fract,
  pass,
  renderOutput,
  screenCoordinate,
  sign,
  sqrt,
  uniform,
  screenUV,
  vec2,
  vec4,
} from 'three/tsl'
import { paperFinish } from '../print/paper'
import type { Settings } from '../settings'
import { createPrintGrade } from './grade'
import { terrainSunVisibility } from '../scene/terrainSunVisibility.js'
import { projectSunGlare } from '../print/sunGlare'

function PrintPipeline({ settings, sun }: { settings: Settings; sun: SkySun }) {
  const sky = useSky()
  const store = useStore()
  const renderer = fiber.useThree((state) => state.renderer)
  const scene = fiber.useThree((state) => state.scene)
  const camera = fiber.useThree((state) => state.camera)
  const paper = useMemo(() => uniform(settings.paper), [])
  const ink = useMemo(() => uniform(settings.ink), [])
  const lens = useMemo(
    () => ({
      strength: uniform(settings.bloomStrength),
      radius: uniform(settings.bloomRadius),
      threshold: uniform(settings.bloomThreshold),
      source: uniform(new Vector2()),
      sourceColor: uniform(new Vector3()),
      aspect: uniform(1),
      glareRadius: uniform(0.01),
      glareStrength: uniform(settings.glareStrength),
      veil: uniform(settings.glareVeil),
    }),
    [],
  )
  const latest = useRef(settings)
  latest.current = settings
  const visibility = useMemo(
    () => ({
      eye: new Vector3(NaN, NaN, NaN),
      direction: new Vector3(),
      radius: NaN,
      fraction: 0,
    }),
    [],
  )
  useEffect(() => {
    lens.strength.value = settings.bloomStrength
    lens.radius.value = settings.bloomRadius
    lens.threshold.value = settings.bloomThreshold
    lens.glareStrength.value = settings.glareStrength
    lens.veil.value = settings.glareVeil
  }, [
    lens,
    settings.bloomStrength,
    settings.bloomRadius,
    settings.bloomThreshold,
    settings.glareStrength,
    settings.glareVeil,
  ])
  fiber.useFrame(
    () => {
      if (!sky) return
      const settings = latest.current
      const direction = sky.baker.sky.sunDirection.value
      camera.updateMatrixWorld()
      const projected = projectSunGlare(
        camera as PerspectiveCamera,
        direction,
        settings.glareRadius,
        settings.glareOffscreen,
      )
      // Camera optics use source visibility from this eye, rather than the
      // bay-level visibility that gates illumination of the water.
      const radius = Math.acos(sky.baker.sky.sunDiscCos.value)
      if (
        settings.glareEnabled &&
        projected.visibility > 0 &&
        sun.light.intensity > 0 &&
        (!visibility.eye.equals(camera.position) ||
          !visibility.direction.equals(direction) ||
          visibility.radius !== radius)
      ) {
        visibility.fraction = terrainSunVisibility(scene, direction, camera.position, radius)
        visibility.eye.copy(camera.position)
        visibility.direction.copy(direction)
        visibility.radius = radius
      }
      const visible =
        settings.glareEnabled && sun.light.intensity > 0 && sky.baker.sky.showSunDisc.value > 0
          ? visibility.fraction
          : 0
      const requested = sun.intensity
      const exposure = sky.baker.sky.luminanceScale.value
      const transmission = requested > 0 ? sun.light.intensity / (requested * Math.max(exposure, 1e-6)) : 0
      const energy = sky.baker.sky.sunDiscIntensity.value * transmission * visible * projected.visibility
      lens.source.value.set(projected.x, projected.y)
      lens.glareRadius.value = projected.radius
      lens.aspect.value = (camera as PerspectiveCamera).aspect
      lens.sourceColor.value.set(sun.light.color.r, sun.light.color.g, sun.light.color.b).multiplyScalar(energy)
      renderer.domElement.dataset.sunGlareVisibility = String(visible * projected.visibility)
    },
    { priority: -2 },
  )
  useEffect(() => {
    paper.value = settings.paper
    ink.value = settings.ink
  }, [paper, ink, settings.paper, settings.ink])

  useLayoutEffect(() => {
    if (!sky || !settings.shadowHaze) return
    sky.setHazeShadows({
      light: sun,
      strength: settings.shadowStrength,
      samples: settings.shadowSamples,
      resolution: settings.shadowResolution,
      maxDistance: settings.shadowDistance,
    })
  }, [
    sky,
    sun,
    settings.shadowHaze,
    settings.shadowStrength,
    settings.shadowSamples,
    settings.shadowResolution,
    settings.shadowDistance,
  ])

  useLayoutEffect(() => {
    if (!sky) return
    // Canary 5140ac8 exposes setRenderOverride instead of useRenderPipeline.
    // Register with its scheduler so throttling, errors and teardown stay native.
    const renderPipeline = new RenderPipeline(renderer)
    // Resolve silhouette coverage after depth haze: MSAA color + resolved depth
    // disagree at mountain edges and leave an unhazed one-pixel fringe.
    const scenePass = pass(scene, camera, { samples: 0 })
    const haze = sky.applyHaze(scenePass.getTextureNode(), {
      scenePass,
      logarithmicDepthBuffer: renderer.logarithmicDepthBuffer,
      useCameraFar: true,
      // All scene geometry is inside the 128km AP volume. No costly per-pixel march.
      raymarchFallback: false,
      // Explicit false prevents an old sky-owned shadow state being adopted
      // when the experiment is switched off. The library releases its old RTT.
      shadows: settings.shadowHaze ? { light: sun } : false,
    })
    // The addon typings omit its vec4 result; the runtime node returns RGBA.
    const fogged = sky.applyFog(haze, {
      scenePass,
      logarithmicDepthBuffer: renderer.logarithmicDepthBuffer,
    })
    // Preserve HDR headroom for the solar core and bright water reflections.
    // Lens glare is camera-only: never added to atmosphere LUTs or water IBL.
    const offset = screenUV.sub(lens.source).mul(vec2(lens.aspect, 1))
    const d2 = dot(offset, offset).div(lens.glareRadius.mul(lens.glareRadius))
    const halo = exp(d2.negate()).mul(lens.glareStrength)
    const veil = exp(d2.mul(-0.04)).mul(lens.veil)
    const glare = lens.sourceColor.mul(halo.add(veil))
    const hdr = vec4(fogged.rgb.add(glare), fogged.a)
    const bloomPass = settings.bloomEnabled ? bloom(hdr, 1, 0, 2) : null
    if (bloomPass) {
      bloomPass.strength = lens.strength
      bloomPass.radius = lens.radius
      bloomPass.threshold = lens.threshold
    }
    const developed = bloomPass ? vec4(hdr.rgb.add(bloomPass.rgb), hdr.a) : hdr
    const antialiased = fxaa(renderOutput(developed))
    const printed = paperFinish(antialiased as unknown as Node<'vec4'>, paper, ink)
    // Same triangular 8-bit dither as sky.ditherOutput, split around the paper
    // pass so grain is applied in display space and dither remains the final step.
    const noise = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715)))))
    const signed = noise.mul(2).sub(1)
    const triangular = sign(signed).mul(float(1).sub(sqrt(float(1).sub(abs(signed)))))
    renderPipeline.outputColorTransform = false
    renderPipeline.outputNode = vec4(printed.rgb.add(triangular.div(255)), printed.a)
    const render = () => renderPipeline.render()
    setRenderOverride(store, render)
    return () => {
      if (store.getState().internal.renderOverride === render) setRenderOverride(store, null)
      renderPipeline.dispose()
      bloomPass?.dispose()
      antialiased.textureNode.dispose()
      antialiased.dispose()
      scenePass.dispose()
    }
  }, [sky, renderer, scene, camera, store, paper, ink, lens, sun, settings.shadowHaze, settings.bloomEnabled])
  return null
}

function SkyLighting({ settings }: { settings: Settings }) {
  const sky = useSky()
  const scene = fiber.useThree((state) => state.scene)
  const renderer = fiber.useThree((state) => state.renderer)
  const [sun, setSun] = useState<SkySun | null>(null)

  // Resource construction must not synchronously re-enter the R3F commit from
  // a layout effect while its first WebGPU scene is being established.
  useEffect(() => {
    if (!sky) return
    const sun = sky.createSun({ physical: true, intensity: 0.75, castShadow: false })
    // Demo-only compositing: retain the existing atmospheric background under
    // the emissive source, including at low/zero brightness. Terrain depth
    // still clips it. The library's sky and celestial shaders stay unchanged.
    sun.disc.material.blending = AdditiveBlending
    const ambient = sky.createAmbient()
    sun.attach(scene)
    ambient.attach(scene)
    setSun(sun)
    return () => {
      sun.dispose()
      ambient.dispose()
    }
  }, [sky, scene])

  useEffect(() => {
    sky?.setSunDisc({ intensity: settings.sunDiscBrightness })
  }, [sky, settings.sunDiscBrightness])

  useEffect(() => {
    if (!sky || !sun) return
    const updateVisibility = () => {
      const direction = sky.baker.sky.sunDirection.value
      const radius = Math.acos(sky.baker.sky.sunDiscCos.value)
      const fraction = terrainSunVisibility(scene, direction, undefined, radius)
      // Preserve SkySun's atmospheric attenuation and planetary horizon fade.
      // Gate its requested illuminance, rather than overriding the derived light.
      sun.setIntensity(0.75 * fraction)
      renderer.domElement.dataset.terrainSunVisibility = String(fraction)
    }
    updateVisibility()
    const removeSun = sky.baker.addSunListener(updateVisibility)
    const removeBake = sky.baker.addBakeListener(updateVisibility)
    return () => {
      removeSun()
      removeBake()
    }
  }, [sky, sun, scene, renderer])

  useLayoutEffect(() => {
    if (!sky || !sun) return
    const wasEnabled = renderer.shadowMap.enabled
    renderer.shadowMap.enabled = settings.shadowHaze
    sun.light.castShadow = settings.shadowHaze
    if (!settings.shadowHaze) {
      sun.setDistance(50000)
      return () => {
        renderer.shadowMap.enabled = wasEnabled
      }
    }
    // Directional-light position does not change its illumination. Moving it
    // behind the entire stage prevents the far Fuji slope crossing its near plane.
    sun.setDistance(120000)
    sun.light.shadow.mapSize.set(2048, 2048)
    sun.light.shadow.bias = -0.000025
    sun.light.shadow.normalBias = 2
    const stage = new Box3(new Vector3(-35000, 0, -76000), new Vector3(35000, 5000, 100))
    const refit = () => {
      sun.fitShadowToBox(stage)
      sun.light.shadow.needsUpdate = true
    }
    refit()
    // SkySun's listener runs first and moves the light; then fit in its new frame.
    const unsubscribe = sky.baker.addSunListener(refit)
    return () => {
      unsubscribe()
      sun.light.castShadow = false
      sun.setDistance(50000)
      renderer.shadowMap.enabled = wasEnabled
    }
  }, [sky, sun, renderer, settings.shadowHaze])

  useEffect(() => {
    if (!sky) return
    if (settings.stars) {
      sky.enableStars({
        count: 6000,
        seed: 1985,
        intensity: 1.15,
        size: 0.62,
        contrast: 20,
        twinkle: 0.12,
        milkyWay: 0.1,
      })
    } else sky.disableStars()
  }, [sky, settings.stars])
  return sun ? <PrintPipeline settings={settings} sun={sun} /> : null
}

export function Atmosphere({ settings, children }: { settings: Settings; children: ReactNode }) {
  // One authored grade across every light. Editor edits and imported grades
  // persist when the visitor switches editions or adjusts scene controls.
  const grade = useMemo(() => createPrintGrade(0.5), [])
  return (
    <Sky
      preset="earth"
      quality="medium"
      cubeSize={256}
      enableAerialPerspective
      apKmPerSlice={4}
      pmrem={{ generator: 'sky', quality: 'fast' }}
      // Geographic west-northwest is the composed view toward Fuji. The solar
      // azimuth slider retains compass degrees while the geometry faces -Z.
      north={254}
      latitude={35.3}
      dayOfYear={284}
      timeOfDay={18.5}
      sunDirection={{ elevation: settings.elevation, azimuth: settings.azimuth }}
      sunDisc
      exposure={settings.exposure}
      turbidity={settings.turbidity}
      hazeStrength={1}
      apDistanceScale={settings.haze}
      hazePolicy="ap"
      fog={{
        density: settings.fogDensity,
        heightFalloff: settings.fogHeight,
        baseHeight: settings.fogBase,
        maxOpacity: settings.groundFog ? settings.fogOpacity : 0,
      }}
      grade={grade}
      groundAlbedo="#333f40">
      <SkyLighting settings={settings} />
      {children}
    </Sky>
  )
}
