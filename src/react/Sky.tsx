import type { ReactNode } from 'react'
import { Suspense, useEffect, useRef, useState } from 'react'
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
import type { SkyPmremOptions } from '../sky/pmrem/SkyPmrem'
import type { FogOptions } from '../sky/FogPostProcess'
import type { LookTrackOverrides, SkyNorth } from '../Sky'
import { SkyContext } from './SkyContext'
import { useStableValue } from './useStableValue'

export interface SkyProps {
  preset?: string
  quality?: string
  cubeSize?: number
  atmosphere?: any
  enableAerialPerspective?: boolean
  apKmPerSlice?: number
  /** IBL prefilter options (`generator`, `quality`, `minInterval`, `levelsPerFrame`). Construction-only: a change (by value) rebuilds. */
  pmrem?: SkyPmremOptions
  mirrorBelowHorizon?: boolean
  /** Claim `scene.background` (the raw sky cube). Default `true`. See `Sky.attach`. */
  background?: boolean
  /** Claim `scene.environment` (the PMREM-filtered IBL). `false` keeps your own environment map. Default `true`. */
  environment?: boolean
  exposure?: number
  /** Where geographic north points: a world axis or a heading in degrees clockwise from +Z (see `SkyNorth`). */
  north?: SkyNorth
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
  /**
   * Height-fog knobs `{ density, heightFalloff, baseHeight, maxOpacity }`, applied
   * with `sky.setFog` (compared by value). They take effect once
   * `<AutoHaze mode="fog" />` (or your own `applyFog`) is wired.
   */
  fog?: FogOptions
  /** Stylized look: a registered name, an inline definition, or `null` for physical. See the looks guide. */
  look?: string | Record<string, any> | null
  /** Keyframed look that follows sun elevation (e.g. `'ghibli'`). Overrides `look` while set. */
  lookTrack?: string | any[] | null
  /**
   * Pins `chroma` / `value` / `intensity` across the whole `lookTrack`. Omit to keep
   * overrides set on the instance; `null` clears them.
   */
  lookTrackOverrides?: LookTrackOverrides | null
  /** Unreal `SkyLuminanceFactor`: per-channel grade after the look. Hex string, Color, Vector3 or [r,g,b]. */
  skyLuminanceFactor?: any
  /** Colour of the sun as a light: tints sky, haze, sun disc and `createSun` lights. `'neutral'`, `'bruneton'`, hex string, Color, Vector3 or [r,g,b]. */
  sunColor?: any
  /** Unreal `AerialPerspectiveViewDistanceScale`: haze per metre. 1 = physical. */
  apDistanceScale?: number
  /** Unreal `MultiScatteringFactor`: gain on multiple scattering. 1 = physical. Rebakes LUTs. */
  multiScatteringFactor?: number
  children?: ReactNode
}

/** Construction inputs; changing any of them rebuilds the instance. */
interface SkyConfig {
  renderer: any
  scene: any
  preset: string
  quality: string
  cubeSize: number
  enableAerialPerspective: boolean
  apKmPerSlice: number
  /** Value-stable (`useStableValue`), so reference equality is value equality. */
  pmrem: SkyPmremOptions | undefined
}

/** The live instance and the config it was built from. */
interface SkyResource {
  sky: VanillaSky
  config: SkyConfig
}

function sameConfig(a: SkyConfig, b: SkyConfig) {
  return (
    a.renderer === b.renderer &&
    a.scene === b.scene &&
    a.preset === b.preset &&
    a.quality === b.quality &&
    a.cubeSize === b.cubeSize &&
    a.enableAerialPerspective === b.enableAerialPerspective &&
    a.apKmPerSlice === b.apKmPerSlice &&
    a.pmrem === b.pmrem
  )
}

/**
 * `<Sky>` — resource boundary around one vanilla `Sky` instance. A single
 * effect constructs, attaches and disposes it; `children` render only once
 * it exists, so `useSky()` is never `null` inside the boundary.
 * Suspended children show a null fallback while their assets load.
 *
 * Construction-time options (rebuild the instance and remount `children`):
 *   `preset`, `quality`, `cubeSize`, `enableAerialPerspective`, `apKmPerSlice`,
 *   `pmrem` (compared by value)
 *
 * Imperative props (applied via setters; no rebuild):
 *   `background`, `environment` (attach roles; see `Sky.attach`),
 *   `timeOfDay`, `latitude`, `dayOfYear`, `sunDirection`, `north`,
 *   `exposure`, `sunDisc`, `turbidity`, `groundAlbedo`, `atmosphere`,
 *   `hazeStrength`, `hazePolicy`, `hazeAltitudeBlend`, `fog`, `mirrorBelowHorizon`,
 *   `look`, `lookTrack`, `lookTrackOverrides`, `skyLuminanceFactor`, `sunColor`,
 *   `apDistanceScale`, `multiScatteringFactor`
 *
 * Aerial-perspective haze post-process: render an `<AutoHaze />` child
 * (imported from `@pmndrs/sky/react/auto-haze`). It calls `useRenderPipeline`
 * and assigns the haze composite to `renderPipeline.outputNode`. The
 * separate sub-export keeps `useRenderPipeline` out of this module's
 * import graph, so apps that don't use haze never pull it in. For custom pipelines, skip
 * `<AutoHaze />` and call `sky.applyHaze` from your own
 * `useRenderPipeline` callback (use `useSky()` to grab the instance).
 */
export function Sky(props: SkyProps) {
  const {
    preset = 'earth',
    quality = 'medium',
    cubeSize = 256,
    atmosphere,
    enableAerialPerspective = true,
    apKmPerSlice = 8.0,
    mirrorBelowHorizon = false,
    background = true,
    environment = true,
    exposure = 40,
    north = '+Z',
    sunDisc = true,
    timeOfDay,
    latitude,
    dayOfYear,
    sunDirection,
    turbidity,
    groundAlbedo,
    children,
  } = props

  const renderer = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  // By value: an inline `pmrem={{ ... }}` must not rebuild every render.
  const pmrem = useStableValue(props.pmrem)

  const config: SkyConfig = { renderer, scene, preset, quality, cubeSize, enableAerialPerspective, apKmPerSlice, pmrem }
  const [resource, setResource] = useState<SkyResource | null>(null)

  useEffect(() => {
    // Imperative props seed the first bake; `SkyController` re-applies them
    // once mounted, so they are not deps of this effect.
    const sky = new VanillaSky(renderer, {
      preset,
      quality,
      cubeSize,
      atmosphere,
      enableAerialPerspective,
      apKmPerSlice,
      pmrem,
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
    // Attach with the current roles straight away: attaching with both and
    // narrowing later would overwrite (and then clear) the caller's own slot.
    sky.attach(scene, { background, environment })
    setResource({
      sky,
      config: { renderer, scene, preset, quality, cubeSize, enableAerialPerspective, apKmPerSlice, pmrem },
    })

    return () => {
      sky.dispose()
      setResource((current) => (current?.sky === sky ? null : current))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer, scene, preset, quality, cubeSize, enableAerialPerspective, apKmPerSlice, pmrem])

  // Nothing renders against an instance whose config no longer matches: it is
  // disposed and replaced by the effect in this same commit.
  if (!resource || !sameConfig(resource.config, config)) return null

  return (
    <SkyContext.Provider value={resource.sky}>
      {/* Keep asset loading from suspending and replaying the resource owner. */}
      <Suspense fallback={null}>
        <SkyController sky={resource.sky} {...props} />
        {children}
      </Suspense>
    </SkyContext.Provider>
  )
}

/** Applies the imperative props to the live instance and drives `update()` per frame. */
function SkyController({
  sky,
  mirrorBelowHorizon = false,
  background = true,
  environment = true,
  exposure = 40,
  north = '+Z',
  sunDisc = true,
  timeOfDay,
  latitude,
  dayOfYear,
  sunDirection: sunDirectionProp,
  turbidity,
  groundAlbedo: groundAlbedoProp,
  atmosphere: atmosphereProp,
  hazeStrength,
  hazePolicy,
  hazeAltitudeBlend: hazeAltitudeBlendProp,
  fog: fogProp,
  look: lookProp,
  lookTrack: lookTrackProp,
  lookTrackOverrides: lookTrackOverridesProp,
  skyLuminanceFactor: skyLuminanceFactorProp,
  sunColor: sunColorProp,
  apDistanceScale,
  multiScatteringFactor,
}: SkyProps & { sky: VanillaSky }) {
  // Object-valued props keyed by structural equality, not reference — an
  // inline `atmosphere={{...}}` / `sunDirection={{...}}` re-created every
  // parent render must not re-run the effect below (each re-run calls a
  // baker setter that marks LUT stages dirty; see issue #12). The baker
  // itself also early-outs on an unchanged value (belt & suspenders for
  // vanilla callers that set per frame), but stabilizing here avoids the
  // setter call — and its dirty-flag bookkeeping — entirely.
  const sunDirection = useStableValue(sunDirectionProp)
  const groundAlbedo = useStableValue(groundAlbedoProp)
  const atmosphere = useStableValue(atmosphereProp)
  const look = useStableValue(lookProp)
  const lookTrack = useStableValue(lookTrackProp)
  const lookTrackOverrides = useStableValue(lookTrackOverridesProp)
  const skyLuminanceFactor = useStableValue(skyLuminanceFactorProp)
  const sunColor = useStableValue(sunColorProp)
  const hazeAltitudeBlend = useStableValue(hazeAltitudeBlendProp)
  const fog = useStableValue(fogProp)

  // Roles changed after mount: re-attach to the same scene, which releases a
  // slot no longer requested and claims a new one. The mount already attached
  // with the initial roles, so an unchanged pair is skipped.
  useEffect(() => {
    const scene = sky._scene
    if (scene && (sky._ownsBackground !== background || sky._ownsEnvironment !== environment)) {
      sky.attach(scene, { background, environment })
    }
  }, [sky, background, environment])

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
    if (groundAlbedo != null) sky.setGroundAlbedo(groundAlbedo)
  }, [sky, groundAlbedo])

  useEffect(() => {
    if (atmosphere) sky.setAtmosphere(atmosphere)
  }, [sky, atmosphere])

  // After `atmosphere`, and re-run when it changes: Mie fields in
  // `setAtmosphere` reset the turbidity-1 baseline (and turbidity to 1), so
  // turbidity has to be re-applied on top whichever prop changed.
  useEffect(() => {
    if (typeof turbidity === 'number') sky.setTurbidity(turbidity)
  }, [sky, turbidity, atmosphere])

  useEffect(() => {
    sky.setMirrorBelowHorizon(!!mirrorBelowHorizon)
  }, [sky, mirrorBelowHorizon])

  useEffect(() => {
    if (typeof hazeStrength === 'number') sky.setHazeStrength(hazeStrength)
  }, [sky, hazeStrength])

  useEffect(() => {
    if (hazePolicy) sky.setHazePolicy(hazePolicy)
  }, [sky, hazePolicy])

  // A track wins over a single look while set. Removing `lookTrack` falls back
  // to `look`, or to the physical sky when `look` is unset. An absent
  // `lookTrackOverrides` keeps the instance's own (`useSky().setLookTrack(t, o)`);
  // removing the prop clears the overrides it had set.
  const lookPropsSet = useRef({ track: false, overrides: false })
  useEffect(() => {
    const prev = lookPropsSet.current
    if (lookTrack != null) {
      const overrides =
        lookTrackOverrides !== undefined ? lookTrackOverrides : prev.overrides ? null : sky._lookTrackOverrides
      sky.setLookTrack(lookTrack, overrides)
    } else if (look !== undefined) {
      sky.setLook(look)
    } else if (prev.track) {
      sky.setLookTrack(null)
    }
    lookPropsSet.current = { track: lookTrack != null, overrides: lookTrackOverrides != null }
  }, [sky, look, lookTrack, lookTrackOverrides])

  useEffect(() => {
    if (skyLuminanceFactor != null) sky.setSkyLuminanceFactor(skyLuminanceFactor)
  }, [sky, skyLuminanceFactor])

  useEffect(() => {
    if (sunColor != null) sky.setSunColor(sunColor)
  }, [sky, sunColor])

  useEffect(() => {
    if (typeof apDistanceScale === 'number') sky.setAerialPerspectiveDistanceScale(apDistanceScale)
  }, [sky, apDistanceScale])

  useEffect(() => {
    if (typeof multiScatteringFactor === 'number') sky.setMultiScatteringFactor(multiScatteringFactor)
  }, [sky, multiScatteringFactor])

  useEffect(() => {
    if (hazeAltitudeBlend) sky.setHazeAltitudeBlend(hazeAltitudeBlend)
  }, [sky, hazeAltitudeBlend])

  useEffect(() => {
    if (fog) sky.setFog(fog)
  }, [sky, fog])

  useFrame((state) => {
    sky.update(state.camera)
    // The AP LUT is camera-relative and must refresh per frame — but only
    // once haze actually has a consumer (`applyHaze` sets `_hazeApplied`).
    // Without this, haze on the React path sampled a stale LUT that never
    // tracked the camera; every consumer had to drive the update themselves.
    if (sky._hazeApplied) void sky.updateAerialPerspective()
  })

  return null
}
