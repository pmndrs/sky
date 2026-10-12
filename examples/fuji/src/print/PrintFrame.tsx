import type { ReactNode } from 'react'
import type { Preset, Settings } from '../settings'

type PrintFrameProps = {
  children: ReactNode
  settings: Settings
  onPreset: (preset: Preset) => void
  controlsOpen: boolean
  onToggleControls: () => void
}

const editions: Record<Preset, { japanese: string; title: string; number: string }> = {
  dusk: { japanese: '夕映え', title: 'The last light', number: '01' },
  haze: { japanese: '春霞', title: 'Through the haze', number: '02' },
  night: { japanese: '星月夜', title: 'A sky of stars', number: '03' },
}

export function PrintFrame({ children, settings, onPreset, controlsOpen, onToggleControls }: PrintFrameProps) {
  const edition = editions[settings.preset]

  return (
    <main className="print-gallery">
      <figure className="coastal-print" aria-label="An animated print of Mount Fuji across Sagami Bay">
        <div className="print-image" data-preset={settings.preset}>
          {children}
          <div className="print-cartouche" aria-label={`Sagami Bay — ${edition.title}`}>
            <div className="cartouche-title" lang="ja">
              <span>相模湾</span>
              <span>{edition.japanese}</span>
            </div>
            <div className="cartouche-seal" aria-hidden="true">
              <span>sky</span>
              <span>0.6</span>
            </div>
          </div>
          <span className="print-side-note" aria-hidden="true">
            相模湾より富士を望む
          </span>
        </div>

        <figcaption className="print-caption">
          <div className="print-title-group">
            <p className="print-eyebrow">
              Thirty-six moments of sky <span>—</span> No. {edition.number}
            </p>
            <h1>
              Sagami Bay<span className="print-title-separator"> / </span>
              <em>{edition.title}</em>
            </h1>
          </div>
          <div className="print-signature">
            <a
              className="print-sky-label"
              href="https://github.com/pmndrs/sky"
              target="_blank"
              rel="noreferrer"
              aria-label="Sky 0.6 on GitHub">
              SKY <span>0.6</span>
            </a>
            <a
              className="pmndrs-wordmark"
              href="https://github.com/pmndrs/sky"
              target="_blank"
              rel="noreferrer"
              aria-label="pmndrs sky on GitHub">
              pmndrs
              {/* Poimandres mark from Discord's official community directory:
                  https://github.com/discord/discord-open-source/blob/master/logos/poimandres.svg */}
              <svg width="16" height="16" viewBox="0 0 72 72" fill="currentColor" aria-hidden="true">
                <path d="M26.1 3H69v42.9H49.2V22.8H26.1V3zM3 26.1h19.8v19.8H3V26.1z" />
                <path d="M45.9 26.1H26.1v19.8h19.8V26.1zm0 23.1H26.1V69h19.8V49.2z" />
              </svg>
            </a>
          </div>
        </figcaption>
      </figure>

      <nav className="print-toolbar" aria-label="Print atmosphere">
        <span className="print-location">35°18′ N &nbsp; 139°29′ E</span>
        <div className="print-presets" aria-label="Time of day">
          {(['haze', 'dusk', 'night'] as const).map((preset) => (
            <button
              type="button"
              key={preset}
              className={settings.preset === preset ? 'is-active' : ''}
              aria-pressed={settings.preset === preset}
              onClick={() => onPreset(preset)}>
              {preset === 'haze' ? 'Haze' : preset === 'dusk' ? 'Dusk' : 'Night'}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="print-adjust"
          aria-expanded={controlsOpen}
          aria-controls="print-studio"
          onClick={onToggleControls}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M1 4h12M1 10h12M4 2v4M10 8v4" stroke="currentColor" strokeWidth="1" />
          </svg>
          {controlsOpen ? 'Close studio' : 'Adjust print'}
        </button>
      </nav>
    </main>
  )
}
