import { useEffect, useMemo, useRef } from 'react'
import { useSky } from '@pmndrs/sky/react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import {
  Fn,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  dot,
  float,
  fwidth,
  length,
  log2,
  max,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  saturate,
  transformDirection,
  uniform,
  varyingProperty,
  vec3,
} from 'three/tsl'
import { OceanFFT } from './tidewater/OceanFFT.js'
import { WaterSurface } from './tidewater/WaterSurface.js'
import { SeaDetail } from './tidewater/SeaDetail.js'
import { createFoamTexture } from './tidewater/FoamTexture.js'
import { G } from './tidewater/Globals.js'
import type { Settings } from '../settings'
import { WaterReflections } from './WaterReflections'

/** Tidewater's actual four-cascade spectral ocean, with its game/world hooks left unused.
 * The poster does not need terrain queries, a ship wake, refraction, or breaking surf.
 * Its FFT displacement, derivatives, capillary detail, gusts, slicks, and foam remain intact.
 */
export function TidewaterOcean({ settings }: { settings: Settings }) {
  const renderer = useThree((s) => s.renderer) as unknown as THREE.WebGPURenderer
  const scene = useThree((s) => s.scene)
  const sky = useSky()
  const mesh = useRef<THREE.Mesh>(null)
  const reflections = useRef<WaterReflections | null>(null)
  const ocean = useMemo(() => {
    const fft = new OceanFFT(renderer, {
      cascades: 4,
      depth: 32,
      choppiness: 0.68,
      local: { windSpeed: 4.5, windDirection: 66, fetch: 35, spreadBlend: 0.85, swell: 0.05, scale: 0.75 },
      swell: {
        scale: 0.26,
        windSpeed: 5.0,
        windDirection: 85,
        fetch: 650,
        spreadBlend: 1,
        swell: 0.9,
        shortWavesFade: 0.1,
      },
    })
    // A sheltered bay: no breaking waves or persistent whitecaps.
    fft.foamBias.value = 0.12
    const detail = new SeaDetail(128)
    detail.streakAmount.value = 0.04
    detail.slickAmount.value = 0
    const foamTexture = createFoamTexture(renderer, 256)
    const grid = waterGrid()
    const cdlod = {
      vertexNodes: () => ({ worldXZ: positionLocal.xz, spacing: attribute('spacing', 'float').mul(1.5) }),
    }
    const surface = new WaterSurface({ fft, cdlod, foamTexture })
    surface.detail = detail
    surface.foamCoverage.value = 0

    const waterColor = uniform(new THREE.Color('#243c3b'))
    const foamColor = uniform(new THREE.Color('#a5b5a7'))
    const microRoughness = uniform(0.035)
    const roughnessScale = uniform(1)
    const material = new THREE.MeshPhysicalNodeMaterial({
      color: '#334945',
      roughness: 0.18,
      metalness: 0,
      ior: 1.333,
      specularIntensity: 1,
      clearcoat: 0,
      side: THREE.FrontSide,
    })
    material.name = 'Tidewater spectral bay / cached scene reflection'
    // The varying stores the undisturbed coordinate, so ripples move through water
    // instead of sliding when the larger displacement changes the surface position.
    const lagXZ = varyingProperty('vec2', 'coastLagXZ')
    const vertexFoam = varyingProperty('float', 'coastVertexFoam')
    material.positionNode = Fn(() => {
      const v = surface.vertex()
      lagXZ.assign(v.lagXZ)
      vertexFoam.assign(v.foam)
      return v.position
    })()
    const sample = () => surface.fragment(lagXZ, max(length(fwidth(lagXZ)), 0.001), float(32), vertexFoam)
    material.normalNode = Fn(() => {
      const ripple = sample().normal
      const normal = normalize(vec3(ripple.x.mul(surface.slopeScale), ripple.y, ripple.z.mul(surface.slopeScale)))
      const view = normalize(cameraPosition.sub(positionWorld))
      // Tidewater WaterMaterial's Nview correction: a high-frequency ripple can
      // face away at this grazing camera angle. Bend it toward grazing instead
      // of letting a back-facing facet flash a bright sky reflection.
      const facing = normalize(normal.add(view.mul(max(dot(normal, view).negate().add(0.03), 0))))
      return transformDirection(facing, cameraViewMatrix)
    })()
    material.colorNode = Fn(() => {
      const surf = sample()
      return mix(waterColor, foamColor, surf.foam.mul(0.32))
    })()
    material.roughnessNode = Fn(() => {
      const surf = sample()
      // Tidewater's unresolved-slope variance, converted to Three's perceptual
      // roughness (Three squares roughness into alpha, GGX uses alpha squared).
      // The old 0.095–0.21 adapter values treated it as alpha, making reflected
      // subpixel ripples far too sharp and visibly unstable at grazing angles.
      const footprint = max(length(fwidth(lagXZ)), 0.001)
      const unresolved = saturate(log2(footprint.mul(110 / Math.PI)).div(9))
      const mss = float(0.003).add(G.windSpeed.mul(0.00512)).mul(surface.slopeScale)
      const alpha2 = microRoughness
        .mul(microRoughness)
        .add(mss.mul(2).mul(unresolved).mul(surf.rough.mul(surf.rough)).mul(roughnessScale))
        .add(surf.foam.mul(0.2))
      return pow(alpha2, 0.25)
    })()
    // Very modest water-body fill preserves blue-green darkness beneath the sky reflection.
    material.envMapIntensity = 1.0
    return {
      fft,
      detail,
      foamTexture,
      grid,
      surface,
      material,
      waterColor,
      foamColor,
      microRoughness,
      roughnessScale,
      needsUpdate: true,
    }
  }, [renderer])

  useEffect(() => {
    if (!sky) return
    const capture = new WaterReflections(renderer, scene, sky)
    reflections.current = capture
    ocean.material.envMap = capture.pmrem.texture
    ocean.material.envNode = capture.envNode
    ocean.material.needsUpdate = true
    return () => {
      reflections.current = null
      ocean.material.envNode = null
      ocean.material.envMap = null
      ocean.material.needsUpdate = true
      capture.dispose()
    }
  }, [renderer, scene, sky, ocean])

  // Sky's bake listener covers lighting changes; fog changes don't bake sky.
  useEffect(() => {
    reflections.current?.invalidate()
  }, [
    settings.haze,
    settings.groundFog,
    settings.fogDensity,
    settings.fogHeight,
    settings.fogBase,
    settings.fogOpacity,
    settings.stars,
    settings.shadowHaze,
  ])

  // Rebuild only the spectrum values in the existing compute buffers. Changing
  // weather never replaces the material, textures, grid, or compute pipelines.
  useEffect(() => {
    Object.assign(ocean.fft.local, {
      windSpeed: settings.waterWindSpeed ?? 4.5,
      windDirection: settings.waterWindDirection ?? 66,
      fetch: settings.waterFetch ?? 35,
      scale: settings.waterWindScale ?? 0.75,
    })
    Object.assign(ocean.fft.swell, {
      windSpeed: settings.waterSwellWindSpeed ?? 5,
      windDirection: settings.waterSwellDirection ?? 85,
      fetch: settings.waterSwellFetch ?? 650,
      scale: settings.waterSwellScale ?? 0.26,
    })
    const angle = THREE.MathUtils.degToRad(settings.waterWindDirection ?? 66)
    G.windDir.value.set(Math.cos(angle), Math.sin(angle))
    G.windSpeed.value = settings.waterWindSpeed ?? 4.5
    ocean.fft.updateSpectrumUniforms()
  }, [
    ocean,
    settings.waterWindSpeed,
    settings.waterWindDirection,
    settings.waterFetch,
    settings.waterWindScale,
    settings.waterSwellWindSpeed,
    settings.waterSwellDirection,
    settings.waterSwellFetch,
    settings.waterSwellScale,
  ])

  useEffect(() => {
    ocean.fft.choppiness.value = settings.waterChoppiness ?? 0.68
    ocean.fft.foamBias.value = settings.waterFoamBias ?? 0.12
    // Even paused, one dispatch lets these compute-side controls take effect.
    ocean.needsUpdate = true
  }, [ocean, settings.waterChoppiness, settings.waterFoamBias])

  useEffect(() => {
    ocean.surface.amplitude.value = settings.waveStrength
    ocean.surface.slopeScale.value = settings.waterSlopeScale ?? 1
    ocean.surface.foamCoverage.value = settings.waterFoam ?? 0
    ocean.detail.gustAmount.value = settings.waterGust ?? 1
    ocean.detail.slickAmount.value = settings.waterSlick ?? 0
    ocean.detail.streakAmount.value = settings.waterStreak ?? 0.04
    ocean.microRoughness.value = settings.waterRoughness ?? 0.035
    ocean.roughnessScale.value = settings.waterRoughnessScale ?? 1
    ocean.waterColor.value.set(settings.waterColor ?? '#243c3b')
    ocean.foamColor.value.set(settings.waterFoamColor ?? '#a5b5a7')
    ocean.material.envMapIntensity = settings.waterReflection ?? 1
    ocean.material.specularIntensity = settings.waterSpecular ?? 1
    ocean.material.ior = settings.waterIor ?? 1.333
  }, [
    ocean,
    settings.waveStrength,
    settings.waterSlopeScale,
    settings.waterFoam,
    settings.waterGust,
    settings.waterSlick,
    settings.waterStreak,
    settings.waterRoughness,
    settings.waterRoughnessScale,
    settings.waterColor,
    settings.waterFoamColor,
    settings.waterReflection,
    settings.waterSpecular,
    settings.waterIor,
  ])

  useFrame(
    (_, delta) => {
      const dt = settings.waterPaused ? 0 : Math.min(delta, 1 / 20) * (settings.waterSpeed ?? 1)
      G.dt.value = dt
      if (dt > 0) {
        G.time.value += dt
        ocean.detail.update(dt)
      }
      if (dt > 0 || ocean.fft.needsSpectrum || ocean.needsUpdate) {
        ocean.fft.update(dt)
        ocean.needsUpdate = false
      }
    },
    { priority: 2 },
  )

  useFrame(
    ({ camera }) => {
      if (mesh.current && camera instanceof THREE.PerspectiveCamera) reflections.current?.update(camera, mesh.current)
    },
    { priority: -1 },
  ) // After the camera and sky update, before the main render.

  useEffect(
    () => () => {
      ocean.material.dispose()
      ocean.grid.dispose()
      ocean.foamTexture.dispose()
      ocean.detail.texture.dispose()
      ocean.fft.displacementTexture.dispose()
      ocean.fft.derivativeTexture.dispose()
      for (const value of Object.values(ocean.fft)) {
        if (value && typeof value === 'object' && 'isComputeNode' in value && 'dispose' in value) {
          ;(value as { dispose: () => void }).dispose()
        }
      }
    },
    [ocean],
  )

  return <mesh ref={mesh} geometry={ocean.grid} material={ocean.material} frustumCulled={false} />
}

/** Fixed world-space grid, with 1.25m rows across the entire foreground and
 * smoothly increasing spacing offshore. No per-frame snapping or re-projection.
 * The original power curve wasted tiny rows behind the camera while giving the
 * visible foreground 4–11m long triangles. This grid spends detail where seen.
 */
function waterGrid() {
  const nx = 256
  const rows: number[] = []
  let z = 112,
    step = 1.25
  while (z > -17000) {
    rows.push(z)
    z -= step
    if (z < -208) step *= 1.045
  }
  rows.push(-17000)
  const nz = rows.length - 1
  const positions: number[] = [],
    spacing: number[] = [],
    indices: number[] = []
  const widthAt = (wz: number) => 160 + Math.max(0, -wz) * 0.72
  for (let row = 0; row <= nz; row++) {
    const wz = rows[row],
      halfWidth = widthAt(wz)
    // Filter against the longest incident edge, including both neighbouring
    // rows and the outward widening at the sides of this trapezoidal grid.
    const previous = rows[Math.max(0, row - 1)],
      next = rows[Math.min(nz, row + 1)]
    const rowStep = Math.max(Math.abs(wz - previous), Math.abs(next - wz))
    const widthStep = Math.max(Math.abs(halfWidth - widthAt(previous)), Math.abs(widthAt(next) - halfWidth))
    const filterSpacing = Math.max((halfWidth * 2) / nx, Math.hypot(rowStep, widthStep))
    for (let x = 0; x <= nx; x++) {
      positions.push(((x / nx) * 2 - 1) * halfWidth, 0, wz)
      spacing.push(filterSpacing)
      if (x < nx && row < nz) {
        const a = row * (nx + 1) + x,
          b = a + 1,
          c = a + nx + 1,
          d = c + 1
        indices.push(a, b, c, b, d, c)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('spacing', new THREE.Float32BufferAttribute(spacing, 1))
  g.setIndex(indices)
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}
