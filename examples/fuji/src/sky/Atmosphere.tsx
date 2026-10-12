import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import * as fiber from '@react-three/fiber/webgpu'
import { setRenderOverride, useStore } from '@react-three/fiber'
import { Sky, useSky } from '@pmndrs/sky/react'
import type { SkySun } from '@pmndrs/sky'
import { Box3, RenderPipeline, Vector3, type Node } from 'three/webgpu'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import {
  abs,
  dot,
  float,
  fract,
  pass,
  renderOutput,
  screenCoordinate,
  sign,
  sqrt,
  uniform,
  vec2,
  vec4,
} from 'three/tsl'
import { paperFinish } from '../print/paper'
import type { Settings } from '../settings'
import { createPrintGrade } from './grade'
import { terrainSunVisibility } from '../scene/terrainSunVisibility.js'

function PrintPipeline({ settings, sun }: { settings: Settings; sun: SkySun }) {
  const sky = useSky()
  const store = useStore()
  const renderer = fiber.useThree((state) => state.renderer)
  const scene = fiber.useThree((state) => state.scene)
  const camera = fiber.useThree((state) => state.camera)
  const paper = useMemo(() => uniform(settings.paper), [])
  const ink = useMemo(() => uniform(settings.ink), [])
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
    const antialiased = fxaa(renderOutput(fogged))
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
      antialiased.textureNode.dispose()
      antialiased.dispose()
      scenePass.dispose()
    }
  }, [sky, renderer, scene, camera, store, paper, ink, sun, settings.shadowHaze])
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
    // The scene disc attaches with SkySun. Give this pale, exposed print a
    // warm visible source instead of clipping the disc into its cream sky.
    // Disc radiance is independent of the light driving the water highlight.
    sky.setSunDisc({ intensity: 2 })
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
