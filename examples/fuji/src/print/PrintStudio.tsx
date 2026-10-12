import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'

type Bounds = { x: number; y: number; width: number; height: number }

function fit(bounds: Bounds): Bounds {
  const margin = 14
  const width = Math.min(Math.max(560, bounds.width), window.innerWidth - margin * 2)
  const height = Math.min(Math.max(400, bounds.height), window.innerHeight - margin * 2)
  return {
    width,
    height,
    x: Math.max(margin, Math.min(bounds.x, window.innerWidth - width - margin)),
    y: Math.max(margin, Math.min(bounds.y, window.innerHeight - height - margin)),
  }
}

/** A floating studio; moving it leaves the scene and editor mounted. */
export function PrintStudio({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const [bounds, setBounds] = useState(() => fit({ x: window.innerWidth - 984, y: 24, width: 960, height: 780 }))
  const drag = useRef<{ x: number; y: number; bounds: Bounds; resize: boolean } | null>(null)
  const restored = useRef<Bounds | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const resize = () => setBounds((current) => fit(current))
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  function start(event: PointerEvent<HTMLElement>, resize: boolean) {
    if (event.button !== 0 || (!resize && (event.target as HTMLElement).closest('button'))) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, y: event.clientY, bounds, resize }
    setExpanded(false)
  }

  function move(event: PointerEvent<HTMLElement>) {
    const origin = drag.current
    if (!origin) return
    const dx = event.clientX - origin.x
    const dy = event.clientY - origin.y
    setBounds(
      fit(
        origin.resize
          ? { ...origin.bounds, width: origin.bounds.width + dx, height: origin.bounds.height + dy }
          : { ...origin.bounds, x: origin.bounds.x + dx, y: origin.bounds.y + dy },
      ),
    )
  }

  function expand() {
    if (expanded && restored.current) setBounds(fit(restored.current))
    else {
      restored.current = bounds
      setBounds(fit({ x: 14, y: 14, width: window.innerWidth, height: window.innerHeight }))
    }
    setExpanded(!expanded)
  }

  return (
    <aside
      id="print-studio"
      className="print-studio"
      hidden={!open}
      aria-label="Print studio"
      style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}>
      <header
        className="studio-header"
        tabIndex={0}
        aria-label="Move print studio with arrow keys"
        onPointerDown={(event) => start(event, false)}
        onPointerMove={move}
        onLostPointerCapture={() => (drag.current = null)}
        onPointerUp={() => (drag.current = null)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !event.key.startsWith('Arrow')) return
          event.preventDefault()
          const step = event.shiftKey ? 40 : 10
          setBounds((current) =>
            fit({
              ...current,
              x: current.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
              y: current.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0),
            }),
          )
          setExpanded(false)
        }}>
        <div>
          <span className="studio-eyebrow">SAGAMI BAY · SKY 0.6</span>
          <h2>Print studio</h2>
          <span className="studio-hint">Drag to move · resize from the corner</span>
        </div>
        <div className="studio-window-actions">
          <button
            type="button"
            className="studio-expand"
            onClick={expand}
            aria-label={expanded ? 'Restore studio size' : 'Expand print studio'}
            title={expanded ? 'Restore size' : 'Expand'}>
            {expanded ? '↙' : '↗'}
          </button>
          <button type="button" className="studio-close" onClick={onClose} aria-label="Close print studio">
            ×
          </button>
        </div>
      </header>
      {children}
      <button
        type="button"
        className="studio-resize"
        aria-label="Resize print studio"
        title="Drag to resize, or use arrow keys"
        onPointerDown={(event) => start(event, true)}
        onPointerMove={move}
        onLostPointerCapture={() => (drag.current = null)}
        onPointerUp={() => (drag.current = null)}
        onKeyDown={(event) => {
          if (!event.key.startsWith('Arrow')) return
          event.preventDefault()
          const step = event.shiftKey ? 40 : 10
          setBounds((current) =>
            fit({
              ...current,
              width: current.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
              height: current.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0),
            }),
          )
          setExpanded(false)
        }}>
        ◢
      </button>
    </aside>
  )
}
