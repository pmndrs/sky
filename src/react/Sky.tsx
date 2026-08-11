import type { ReactNode } from 'react'
import { useEffect, useMemo } from 'react'
// The WebGPU entry, not the root one. This package is WebGPU-only, and R3F's
// root entry is a separate ~670 KB bundle that imports three's WebGL build for
// `WebGLRenderer` / `WebGLCubeRenderTarget`. Importing it here dragged the whole
// WebGL path into WebGPU-only consumers, and outright broke them when this
// package was consumed from a linked checkout: the root entry resolved against a
// `three` that maps to `three.webgpu.js`, which has no `WebGLCubeRenderTarget`.
//
// Safe for consumers on either entry: both share one context object via
// `globalThis[Symbol.for('@react-three/fiber.context')]`, so `useThree()` here
// still sees a Canvas created from the root entry.
import { useFrame, useThree } from '@react-three/fiber/webgpu'

import { Sky as VanillaSky } from '../Sky'
import { SkyContext } from './SkyContext'

/**
 * StrictMode-safe disposal bookkeeping (see the attach effect). One pending
 * timer per instance: scheduled on effect cleanup, canceled if the same
 * instance re-attaches within the tick (the StrictMode remount), fired for
 * real unmounts and instance swaps.
 */
const pendingDisposal = new Map<VanillaSky, ReturnType<typeof setTimeout>>()

function cancelScheduledDispose(sky: VanillaSky) {
  const timer = pendingDisposal.get(sky)
  if (timer !== undefined) {
    clearTimeout(timer)
    pendingDisposal.delete(sky)
  }
}

function scheduleDispose(sky: VanillaSky) {
  cancelScheduledDispose(sky)
  pendingDisposal.set(
    sky,
    setTimeout(() => {
      pendingDisposal.delete(sky)
      sky.dispose()
    }, 0),
  )
}

export interface SkyProps {
  preset?: string
  quality?: string
  cubeSize?: number
  atmosphere?: any
  enableAerialPerspective?: boolean
  apKmPerSlice?: number
  mirrorBelowHorizon?: boolean
  exposure?: number
  north?: any
  sunDisc?: boolean
  timeOfDay?: number
  latitude?: number
  dayOfYear?: number
  sunDirection?: any
  turbidity?: number
  groundAlbedo?: any
  hazeStrength?: number
  hazePolicy?: any
  hazeAltitudeBlend?: any
  children?: ReactNode
}

/**
 * `<Sky>` — mounts a vanilla `Sky` instance against the active R3F renderer
 * and scene, drives `update(camera)` per frame, and publishes the instance
 * via context for `useSky()` consumers.
 *
 * Construction-time options (cause a remount when changed):
 *   `preset`, `quality`, `cubeSize`, `enableAerialPerspective`, `apKmPerSlice`
 *
 * Imperative props (applied via setters; no remount):
 *   `timeOfDay`, `latitude`, `dayOfYear`, `sunDirection`, `north`,
 *   `exposure`, `sunDisc`, `turbidity`, `groundAlbedo`, `atmosphere`,
 *   `hazeStrength`, `hazePolicy`, `hazeAltitudeBlend`, `mirrorBelowHorizon`
 *
 * Aerial-perspective haze post-process: render an `<AutoHaze />` child
 * (imported from `tsl-sky/react/auto-haze`). It calls `useRenderPipeline`
 * and assigns the haze composite to `renderPipeline.outputNode`. The
 * separate sub-export keeps `useRenderPipeline` out of this module's
 * import graph, so `<Sky>` works on R3F builds where the hook hasn't
 * shipped yet (e.g. `10.0.0-alpha.2`). For custom pipelines, skip
 * `<AutoHaze />` and call `sky.applyHaze` from your own
 * `useRenderPipeline` callback (use `useSky()` to grab the instance).
 */
export function Sky({
  preset = 'earth',
  quality = 'medium',
  cubeSize = 256,
  atmosphere,
  enableAerialPerspective = true,
  apKmPerSlice = 8.0,
  mirrorBelowHorizon = false,
  exposure = 40,
  north = '+Z',
  sunDisc = true,
  timeOfDay,
  latitude,
  dayOfYear,
  sunDirection,
  turbidity,
  groundAlbedo,
  hazeStrength,
  hazePolicy,
  hazeAltitudeBlend,
  children,
}: SkyProps) {
  const renderer = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)

  const sky = useMemo(() => {
    return new VanillaSky(renderer, {
      preset,
      quality,
      cubeSize,
      atmosphere,
      enableAerialPerspective,
      apKmPerSlice,
      mirrorBelowHorizon,
      exposure,
      north,
      sunDisc,
      timeOfDay,
      latitude,
      dayOfYear,
      sunDirection,
      turbidity,
      groundAlbedo,
    })

    // Reconstruct only on options that affect LUT layout / cube target sizing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer, preset, quality, cubeSize, enableAerialPerspective, apKmPerSlice])

  useEffect(() => {
    cancelScheduledDispose(sky)
    sky.attach(scene)
    return () => {
      sky.detach()
      // Disposal is DEFERRED one tick and cancelable, never synchronous.
      // React StrictMode runs every effect as mount → cleanup → mount in
      // dev; a synchronous `sky.dispose()` here destroyed the memoized
      // instance's internals (dome mesh, LUT/cube targets) and then
      // re-attached the husk. Symptom: the sky renders its first bake
      // forever — every live setter (time of day, turbidity, latitude…)
      // silently re-bakes an EMPTY sky scene into a texture no pipeline
      // samples, with zero errors. The StrictMode remount re-runs this
      // effect synchronously after cleanup, which cancels the pending
      // disposal; a real unmount (or instance swap) lets it fire.
      scheduleDispose(sky)
    }
  }, [sky, scene])

  useEffect(() => {
    if (typeof timeOfDay === 'number') sky.setTimeOfDay(timeOfDay)
  }, [sky, timeOfDay])

  useEffect(() => {
    if (typeof latitude === 'number') sky.setLatitude(latitude)
  }, [sky, latitude])

  useEffect(() => {
    if (typeof dayOfYear === 'number') sky.setDayOfYear(dayOfYear)
  }, [sky, dayOfYear])

  useEffect(() => {
    if (sunDirection) sky.setSunDirection(sunDirection)
  }, [sky, sunDirection])

  useEffect(() => {
    sky.setExposure(exposure)
  }, [sky, exposure])

  useEffect(() => {
    sky.setSunDisc(sunDisc)
  }, [sky, sunDisc])

  useEffect(() => {
    sky.setNorth(north)
  }, [sky, north])

  useEffect(() => {
    if (typeof turbidity === 'number') sky.setTurbidity(turbidity)
  }, [sky, turbidity])

  useEffect(() => {
    if (groundAlbedo != null) sky.setGroundAlbedo(groundAlbedo)
  }, [sky, groundAlbedo])

  useEffect(() => {
    if (atmosphere) sky.setAtmosphere(atmosphere)
  }, [sky, atmosphere])

  useEffect(() => {
    sky.setMirrorBelowHorizon(!!mirrorBelowHorizon)
  }, [sky, mirrorBelowHorizon])

  useEffect(() => {
    if (typeof hazeStrength === 'number') sky.setHazeStrength(hazeStrength)
  }, [sky, hazeStrength])

  useEffect(() => {
    if (hazePolicy) sky.setHazePolicy(hazePolicy)
  }, [sky, hazePolicy])

  useEffect(() => {
    if (hazeAltitudeBlend) sky.setHazeAltitudeBlend(hazeAltitudeBlend)
  }, [sky, hazeAltitudeBlend])

  useFrame((state) => {
    sky.update(state.camera)
    // The AP LUT is camera-relative and must refresh per frame — but only
    // once haze actually has a consumer (`applyHaze` sets `_hazeApplied`).
    // Without this, haze on the React path sampled a stale LUT that never
    // tracked the camera; every consumer had to drive the update themselves.
    if (sky._hazeApplied) void sky.updateAerialPerspective()
  })

  return <SkyContext.Provider value={sky}>{children}</SkyContext.Provider>
}
