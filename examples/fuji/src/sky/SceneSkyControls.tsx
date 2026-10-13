import { useEffect, useState } from 'react'
import type { SkySettings } from '@pmndrs/sky'
import type { EditorSession } from './GradeEditor'

/** Basic scene controls use the public Sky API; the packaged editor remains
 * available for grades and detailed atmosphere settings. */
export function SceneSkyControls({
  session,
  active,
  onNavigate,
  onPreview,
  onSettingsCommit,
}: {
  session: EditorSession | null
  active: boolean
  onNavigate: () => void
  onPreview: () => void
  onSettingsCommit: (settings: SkySettings) => void
}) {
  const [settings, setSettings] = useState<SkySettings | null>(null)
  useEffect(() => {
    if (!session || !active) return
    const refresh = () => {
      if (session.sky.state !== 'disposed') setSettings(session.sky.getSettings())
    }
    refresh()
    const timer = window.setInterval(refresh, 150)
    return () => window.clearInterval(timer)
  }, [session, active])

  function solar(apply: (session: EditorSession) => void) {
    if (!session || session.sky.state === 'disposed') return
    onNavigate()
    session.editor.followApp()
    apply(session)
    setSettings(session.sky.getSettings())
  }

  function physical(apply: (session: EditorSession) => void) {
    if (!session || session.sky.state === 'disposed') return
    apply(session)
    const next = session.sky.getSettings()
    onSettingsCommit(next)
    setSettings(next)
  }

  const hours = settings?.sun.timeOfDay ?? 18.5
  const minutes = Math.round(hours * 60)
  const clock = `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  return (
    <section className="scene-sky-controls" aria-label="Sky and atmosphere">
      <h3>Sky & atmosphere</h3>
      <label>
        <span>Time of day</span>
        <input
          aria-label="Time of day"
          type="range"
          min="0"
          max="24"
          step="0.01"
          value={hours}
          disabled={!settings}
          onChange={(e) => solar(({ sky }) => sky.setTimeOfDay(+e.target.value))}
        />
        <output>{clock}</output>
      </label>
      <label>
        <span>Sun elevation</span>
        <input
          aria-label="Sun elevation"
          type="range"
          min="-90"
          max="90"
          step="0.1"
          value={settings?.sun.elevation ?? -1.5}
          disabled={!settings}
          onChange={(e) =>
            solar(({ sky }) =>
              sky.setSunDirection({ elevation: +e.target.value, azimuth: sky.getSettings().sun.azimuth }),
            )
          }
        />
        <output>{settings?.sun.elevation.toFixed(1)}°</output>
      </label>
      <label>
        <span>Sun heading</span>
        <input
          aria-label="Sun heading"
          type="range"
          min="0"
          max="360"
          step="1"
          value={settings?.sun.azimuth ?? 256}
          disabled={!settings}
          onChange={(e) =>
            solar(({ sky }) =>
              sky.setSunDirection({ elevation: sky.getSettings().sun.elevation, azimuth: +e.target.value }),
            )
          }
        />
        <output>{settings?.sun.azimuth.toFixed(0)}°</output>
      </label>
      <label>
        <span>Sky brightness</span>
        <input
          aria-label="Sky brightness"
          type="range"
          min="1"
          max="60"
          step="0.5"
          value={settings?.exposure ?? 24}
          disabled={!settings}
          onChange={(e) => physical(({ sky }) => sky.setExposure(+e.target.value))}
        />
        <output>{settings?.exposure.toFixed(1)}</output>
      </label>
      <label>
        <span>Haze / turbidity</span>
        <input
          aria-label="Haze / turbidity"
          type="range"
          min="1"
          max="10"
          step="0.1"
          value={settings?.turbidity ?? 2.2}
          disabled={!settings}
          onChange={(e) => physical(({ sky }) => sky.setTurbidity(+e.target.value))}
        />
        <output>{settings?.turbidity.toFixed(1)}</output>
      </label>
      <p>
        {settings?.sun.mode === 'time'
          ? 'Following the solar clock.'
          : 'Manual sun position. Move Time of day to follow the clock.'}
      </p>
      <button type="button" disabled={!settings} onClick={onPreview}>
        Preview visible sun
      </button>
    </section>
  )
}
