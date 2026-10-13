import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber/webgpu'
import { WebGPUCanvas } from './WebGPUCanvas'
import { Leva, useControls, folder, button } from 'leva'
import { Atmosphere } from './sky/Atmosphere'
import { Coast } from './scene/Coast'
import { CameraRig } from './scene/CameraRig'
import { PrintFrame } from './print/PrintFrame'
import { PrintStudio } from './print/PrintStudio'
import {
  waterDefaults,
  fogDefaults,
  shadowDefaults,
  lensDefaults,
  presets,
  type Preset,
  type Settings,
  type PrintLayout,
} from './settings'
import type { SkySettings } from '@pmndrs/sky'
import { GradeEditor, type EditorSession } from './sky/GradeEditor'
import { SceneSkyControls } from './sky/SceneSkyControls'
import { blendLight, lightSettings, lightTransitionDuration, type LightSettings } from './sky/lightTransition'
import { createPrintGrade } from './sky/grade'

const fixedWaterKeys = new Set(['waterSlick', 'waterFoam', 'waterFoamBias', 'waterFoamColor'])
const editableWaterDefaults = Object.fromEntries(
  Object.entries(waterDefaults).filter(([key]) => !fixedWaterKeys.has(key)),
)

class SceneBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  render() {
    return this.state.error ? (
      <div className="scene-message">
        <span>THE PRINT COULD NOT DEVELOP</span>
        <p>{this.state.error}</p>
        <button onClick={() => window.location.reload()}>Try again</button>
      </div>
    ) : (
      this.props.children
    )
  }
}

function FrameMeter() {
  const gl = useThree((s) => s.renderer)
  const meter = useRef({ elapsed: 0, frames: 0 })
  useEffect(() => {
    const canvas = gl.domElement
    canvas.setAttribute('aria-label', 'Animated view of Mount Fuji across Sagami Bay')
    canvas.setAttribute('role', 'img')
  }, [gl])
  useFrame((_, delta) => {
    meter.current.elapsed += delta
    meter.current.frames++
    if (meter.current.elapsed >= 1) {
      const element = document.getElementById('frame-meter')
      if (element) element.textContent = `${Math.round(meter.current.frames / meter.current.elapsed)} FPS · WEBGPU`
      meter.current.elapsed = 0
      meter.current.frames = 0
    }
  })
  return null
}

export function App() {
  const [preset, setPreset] = useState<Preset>('dusk')
  const [layout, setLayout] = useState<PrintLayout>('auto')
  const [controlsOpen, setControlsOpen] = useState(false)
  const [studioTab, setStudioTab] = useState<'grade' | 'scene'>('scene')
  const [editorHost, setEditorHost] = useState<HTMLDivElement | null>(null)
  const [editorFocused, setEditorFocused] = useState(false)
  const [editorSession, setEditorSession] = useState<EditorSession | null>(null)
  const [sceneOwnsSun, setSceneOwnsSun] = useState(false)
  const [gpu, setGpu] = useState<boolean | null>(null)
  const session = useRef<EditorSession | null>(null)
  const renderedLight = useRef(lightSettings(presets.dusk))
  const [displayedLight, setDisplayedLight] = useState<LightSettings | null>(null)
  const [transition, setTransition] = useState<{ from: LightSettings; to: LightSettings } | null>(null)
  const onEditorReady = useCallback((value: EditorSession | null) => {
    session.current = value
    setEditorSession(value)
  }, [])
  const [values, set] = useControls(
    () => ({
      // The embedded editor owns these controls. Retain app values for edition
      // transitions without showing a duplicate set of sun/atmosphere sliders.
      elevation: { value: presets.dusk.elevation, render: () => false },
      azimuth: { value: presets.dusk.azimuth, render: () => false },
      exposure: { value: presets.dusk.exposure, render: () => false },
      turbidity: { value: presets.dusk.turbidity, render: () => false },
      timeOfDay: { value: presets.dusk.timeOfDay, render: () => false },
      'Atmospheric depth': folder({
        haze: { value: presets.dusk.haze, min: 0, max: 1.5, step: 0.05, label: 'Distance haze' },
        stars: { value: true, label: 'Stars' },
      }),
      'Sun & lens': folder(
        {
          cameraExposure: {
            value: lensDefaults.cameraExposure,
            min: 0.05,
            max: 2,
            step: 0.01,
            label: 'Camera exposure',
          },
          sunDiscDiameter: {
            value: lensDefaults.sunDiscDiameter,
            min: 0.1,
            max: 3,
            step: 0.01,
            pad: 3,
            label: 'Sun diameter (°)',
          },
          sunDiscBrightness: {
            value: lensDefaults.sunDiscBrightness,
            min: 0,
            max: 500,
            step: 1,
            label: 'Sun disc brightness',
          },
          bloomEnabled: { value: lensDefaults.bloomEnabled, label: 'Bloom' },
          bloomStrength: { value: lensDefaults.bloomStrength, min: 0, max: 1, step: 0.01, label: 'Bloom strength' },
          bloomRadius: { value: lensDefaults.bloomRadius, min: 0, max: 1, step: 0.01, label: 'Bloom spread' },
          bloomThreshold: { value: lensDefaults.bloomThreshold, min: 0, max: 20, step: 0.1, label: 'Bloom threshold' },
          bloomSoftness: { value: lensDefaults.bloomSoftness, min: 0.05, max: 5, step: 0.05, label: 'Bloom softness' },
          glareEnabled: { value: lensDefaults.glareEnabled, label: 'Sun glare / offscreen' },
          glareStrength: {
            value: lensDefaults.glareStrength,
            min: 0,
            max: 0.5,
            step: 0.001,
            pad: 3,
            label: 'Glare strength',
          },
          glareRadius: { value: lensDefaults.glareRadius, min: 0.25, max: 10, step: 0.25, label: 'Glare radius (°)' },
          glareOffscreen: {
            value: lensDefaults.glareOffscreen,
            min: 0,
            max: 50,
            step: 1,
            label: 'Offscreen reach (%)',
          },
          glareVeil: { value: lensDefaults.glareVeil, min: 0, max: 0.2, step: 0.001, pad: 3, label: 'Wide glare veil' },
          'Reset sun & lens': button(() => set(lensDefaults)),
        },
        { collapsed: true },
      ),
      'Shadowed haze': folder(
        {
          shadowHaze: { value: false, label: 'Enable haze shadows' },
          shadowStrength: { value: 0.5, min: 0, max: 2, step: 0.05, label: 'Shadow strength' },
          shadowSamples: { value: 32, min: 8, max: 96, step: 8, label: 'March samples' },
          shadowResolution: { value: 0.5, options: { Quarter: 0.25, Half: 0.5, Full: 1 }, label: 'Resolution' },
          shadowDistance: { value: 90000, min: 1000, max: 110000, step: 1000, label: 'Distance (m)' },
        },
        { collapsed: true },
      ),
      'Ground fog': folder(
        {
          groundFog: { value: fogDefaults.groundFog, label: 'Enable ground fog' },
          fogDensity: { value: fogDefaults.fogDensity, min: 0, max: 2, step: 0.005, label: 'Density / km' },
          fogHeight: { value: fogDefaults.fogHeight, min: 10, max: 2000, step: 10, label: 'Height falloff (m)' },
          fogBase: { value: fogDefaults.fogBase, min: -100, max: 1000, step: 10, label: 'Base height (m)' },
          fogOpacity: { value: fogDefaults.fogOpacity, min: 0, max: 1, step: 0.01, label: 'Opacity limit' },
        },
        { collapsed: true },
      ),
      Print: folder({
        paper: { value: presets.dusk.paper, min: 0, max: 1, step: 0.01, label: 'Paper grain' },
        ink: { value: presets.dusk.ink, min: 0, max: 1, step: 0.01, label: 'Ink absorption' },
      }),
      Water: folder({
        waveStrength: { value: waterDefaults.waveStrength, min: 0, max: 1.5, step: 0.01, label: 'Wave height' },
        waterSlopeScale: { value: waterDefaults.waterSlopeScale, min: 0, max: 2, step: 0.01, label: 'Ripple normals' },
        waterReflection: {
          value: waterDefaults.waterReflection,
          min: 0,
          max: 3,
          step: 0.01,
          label: 'Scene reflection',
        },
        waterPaused: { value: false, label: 'Pause water' },
        'Reflection & color': folder(
          {
            waterRoughness: {
              value: waterDefaults.waterRoughness,
              min: 0.005,
              max: 0.5,
              step: 0.005,
              label: 'Micro roughness',
            },
            waterRoughnessScale: {
              value: waterDefaults.waterRoughnessScale,
              min: 0,
              max: 3,
              step: 0.01,
              label: 'Ripple blur',
            },
            waterSpecular: {
              value: waterDefaults.waterSpecular,
              min: 0,
              max: 2,
              step: 0.01,
              label: 'Specular strength',
            },
            waterIor: { value: waterDefaults.waterIor, min: 1, max: 2, step: 0.001, label: 'IOR' },
            waterColor: { value: waterDefaults.waterColor, label: 'Water color' },
          },
          { collapsed: true },
        ),
        'Wind waves': folder(
          {
            waterWindSpeed: {
              value: waterDefaults.waterWindSpeed,
              min: 0.1,
              max: 15,
              step: 0.1,
              label: 'Wind speed (m/s)',
            },
            waterWindDirection: {
              value: waterDefaults.waterWindDirection,
              min: 0,
              max: 360,
              step: 1,
              label: 'Wind heading',
            },
            waterFetch: { value: waterDefaults.waterFetch, min: 1, max: 500, step: 1, label: 'Wind fetch (km)' },
            waterWindScale: {
              value: waterDefaults.waterWindScale,
              min: 0,
              max: 2,
              step: 0.01,
              label: 'Wind wave energy',
            },
            waterChoppiness: {
              value: waterDefaults.waterChoppiness,
              min: 0,
              max: 1.5,
              step: 0.01,
              label: 'Choppiness',
            },
            waterSpeed: { value: waterDefaults.waterSpeed, min: 0, max: 2, step: 0.01, label: 'Animation speed' },
          },
          { collapsed: true },
        ),
        Swell: folder(
          {
            waterSwellScale: {
              value: waterDefaults.waterSwellScale,
              min: 0,
              max: 2,
              step: 0.01,
              label: 'Swell energy',
            },
            waterSwellDirection: {
              value: waterDefaults.waterSwellDirection,
              min: 0,
              max: 360,
              step: 1,
              label: 'Swell heading',
            },
            waterSwellWindSpeed: {
              value: waterDefaults.waterSwellWindSpeed,
              min: 0.1,
              max: 15,
              step: 0.1,
              label: 'Source wind (m/s)',
            },
            waterSwellFetch: {
              value: waterDefaults.waterSwellFetch,
              min: 1,
              max: 2000,
              step: 1,
              label: 'Swell fetch (km)',
            },
          },
          { collapsed: true },
        ),
        'Surface detail': folder(
          {
            waterGust: { value: waterDefaults.waterGust, min: 0, max: 2, step: 0.01, label: 'Gust patches' },
            waterStreak: { value: waterDefaults.waterStreak, min: 0, max: 1, step: 0.01, label: 'Wind streaks' },
          },
          { collapsed: true },
        ),
        'Reset water': button(() => set(editableWaterDefaults)),
      }),
      Camera: folder({
        drift: { value: true, label: 'Follow cursor' },
        manualCamera: { value: false, label: 'Unlock camera' },
      }),
      'Reset this light': button(() => choosePreset(preset)),
    }),
    [preset],
  )
  function choosePreset(next: Preset) {
    setSceneOwnsSun(false)
    session.current?.editor.followApp()
    const current = session.current?.sky.getSettings()
    const from = {
      ...renderedLight.current,
      ...(current
        ? {
            timeOfDay: current.sun.timeOfDay,
            exposure: current.exposure,
            turbidity: current.turbidity,
          }
        : {}),
    }
    const { preset: _, ...nextValues } = presets[next]
    // Keep the authored grade, water and local fog while comparing light.
    const lightValues = Object.fromEntries(
      Object.entries(nextValues).filter(
        ([key]) =>
          key === 'cameraExposure' ||
          (!(key in waterDefaults) && !(key in fogDefaults) && !(key in shadowDefaults) && !(key in lensDefaults)),
      ),
    )
    set(lightValues)
    setPreset(next)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setTransition(null)
      setDisplayedLight(null)
    } else {
      setDisplayedLight(from)
      setTransition({ from, to: lightSettings(presets[next]) })
    }
  }
  function stopTransition() {
    if (transition) set(renderedLight.current)
    setTransition(null)
    setDisplayedLight(null)
  }
  function onSettingsCommit(settings: SkySettings) {
    stopTransition()
    // Sun navigation stays with the editor until an edition button acquires it.
    set({
      exposure: settings.exposure,
      turbidity: settings.turbidity,
      sunDiscBrightness: settings.sun.disc.intensity,
      sunDiscDiameter: (settings.sun.disc.angularDiameter * 180) / Math.PI,
    })
  }
  useEffect(() => {
    if (!transition) return
    const started = performance.now()
    const duration = lightTransitionDuration(transition.from.timeOfDay, transition.to.timeOfDay)
    let frame = 0
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / duration)
      setDisplayedLight(blendLight(transition.from, transition.to, progress))
      if (progress < 1) frame = requestAnimationFrame(tick)
      else {
        setDisplayedLight(null)
        setTransition(null)
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [transition])
  const settings = {
    ...presets.dusk,
    ...values,
    ...displayedLight,
    preset,
    waterSlick: 0,
    waterFoam: 0,
    drift: values.drift && !editorFocused,
  } as Settings
  renderedLight.current = lightSettings(settings)
  useEffect(() => {
    const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }
    if (!nav.gpu) {
      setGpu(false)
      return
    }
    nav.gpu
      .requestAdapter()
      .then((adapter) => setGpu(!!adapter))
      .catch(() => setGpu(false))
  }, [])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setControlsOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
  return (
    <>
      <PrintFrame
        settings={settings}
        onPreset={choosePreset}
        controlsOpen={controlsOpen}
        layout={layout}
        onLayout={setLayout}
        onToggleControls={() => setControlsOpen((v) => !v)}>
        <SceneBoundary>
          {gpu === true ? (
            <WebGPUCanvas>
              <CameraRig settings={settings} layout={layout} />
              <Atmosphere settings={settings} sceneOwnsSun={sceneOwnsSun}>
                <Coast settings={settings} />
                <GradeEditor
                  container={editorHost}
                  active={controlsOpen && studioTab === 'grade'}
                  onReady={onEditorReady}
                  onClose={() => setControlsOpen(false)}
                  onFocus={setEditorFocused}
                  onSunControl={() => {
                    stopTransition()
                    setSceneOwnsSun(true)
                  }}
                  onSettingsCommit={onSettingsCommit}
                />
              </Atmosphere>
              <FrameMeter />
            </WebGPUCanvas>
          ) : (
            <div className="scene-message">
              <span>{gpu === null ? 'PREPARING THE PRINT' : 'WEBGPU IS REQUIRED'}</span>
              <p>
                {gpu === null ? 'Gathering the evening light…' : 'Open this print in a browser with WebGPU enabled.'}
              </p>
            </div>
          )}
        </SceneBoundary>
      </PrintFrame>
      <PrintStudio open={controlsOpen} onClose={() => setControlsOpen(false)}>
        <div className="studio-tabs" role="tablist" aria-label="Studio panels">
          <button
            id="grade-tab"
            role="tab"
            aria-selected={studioTab === 'grade'}
            aria-controls="grade-panel"
            onClick={() => setStudioTab('grade')}>
            Sky grade
          </button>
          <button
            id="scene-tab"
            role="tab"
            aria-selected={studioTab === 'scene'}
            aria-controls="scene-panel"
            onClick={() => setStudioTab('scene')}>
            Scene & print
          </button>
        </div>
        <div
          id="grade-panel"
          className="studio-grade-panel"
          role="tabpanel"
          aria-labelledby="grade-tab"
          hidden={studioTab !== 'grade'}>
          <div className="studio-grade-host" ref={setEditorHost} />
          <footer className="studio-footer">
            <span>One grade colours the sky, sea and distance.</span>
            <button type="button" onClick={() => session.current?.editor.loadGrade(createPrintGrade(0.5).toJSON())}>
              Restore Fuji grade
            </button>
          </footer>
        </div>
        <div
          id="scene-panel"
          className="studio-scene-panel leva-wrap"
          role="tabpanel"
          aria-labelledby="scene-tab"
          hidden={studioTab !== 'scene'}>
          <SceneSkyControls
            session={editorSession}
            active={controlsOpen && studioTab === 'scene'}
            onNavigate={() => {
              stopTransition()
              setSceneOwnsSun(true)
            }}
            onSettingsCommit={onSettingsCommit}
            onPreview={() => {
              choosePreset('haze')
              set({
                cameraExposure: 0.2,
                sunDiscDiameter: 1.2,
                sunDiscBrightness: 150,
                bloomEnabled: true,
                bloomStrength: 0.12,
                glareEnabled: true,
                glareStrength: 0.04,
                glareVeil: 0.005,
              })
            }}
          />
          <Leva
            fill
            hidden={false}
            collapsed={false}
            titleBar={false}
            theme={{
              colors: {
                elevation1: '#eae3d2',
                elevation2: '#f2eddf',
                elevation3: '#dad2bf',
                accent1: '#7d4333',
                accent2: '#98523d',
                accent3: '#ab674c',
                highlight1: '#746c5b',
                highlight2: '#393d36',
                highlight3: '#262d28',
              },
              sizes: { rootWidth: '100%', controlWidth: '160px', numberInputMinWidth: '54px' },
              radii: { xs: '1px', sm: '2px', lg: '3px' },
            }}
          />
        </div>
      </PrintStudio>
      <output id="frame-meter" className="frame-meter" aria-label="Rendering performance">
        WEBGPU · SKY 0.6
      </output>
    </>
  )
}
