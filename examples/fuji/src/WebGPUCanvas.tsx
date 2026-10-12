import { Component, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPointerEvents, createRoot } from '@react-three/fiber/webgpu'

class SceneErrors extends Component<{ children: ReactNode; report: (error: unknown) => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error) {
    this.props.report(error)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

/**
 * App-owned host for the v10 WebGPU reconciler. It uses the same renderer and
 * scheduler as Canvas, with an explicit asynchronous setup/resize lifecycle.
 * Scene inputs arrive through props; no DOM context/Activity bridge is needed.
 */
export function WebGPUCanvas({ children }: { children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null)
  const latestChildren = useRef(children)
  const renderLatest = useRef<(() => void) | null>(null)
  const [error, setError] = useState<Error | null>(null)
  latestChildren.current = children

  useEffect(() => {
    const host = container.current
    if (!host) return
    // A fresh element per effect also isolates a StrictMode setup/cleanup replay
    // from the previous root's asynchronous renderer disposal.
    const canvas = document.createElement('canvas')
    canvas.className = 'r3f-canvas'
    Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%' })
    host.appendChild(canvas)
    const root = createRoot(canvas)
    let disposed = false
    let configured = false
    let resizeFrame = 0
    let unsubscribe: (() => void) | undefined
    let previousSize = ''

    const report = (cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause : new Error(String(cause)))
    }
    const render = () => {
      if (disposed || !configured) return
      try {
        const store = root.render(
          <SceneErrors report={report}>
            <Suspense fallback={null}>{latestChildren.current}</Suspense>
          </SceneErrors>,
        )
        if (!unsubscribe) {
          const inspectError = () => {
            const current = store.getState().error
            if (current) report(current)
          }
          unsubscribe = store.subscribe(inspectError)
          inspectError()
        }
      } catch (cause) {
        report(cause)
      }
    }
    renderLatest.current = render

    const resize = () => {
      resizeFrame = 0
      if (disposed) return
      const rect = host.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const sizeKey = `${rect.width}:${rect.height}:${rect.top}:${rect.left}:${window.devicePixelRatio}`
      if (sizeKey === previousSize) return
      previousSize = sizeKey
      try {
        // configure serializes with any previous pending configure call. A late
        // completion only renders the latest children, never an old settings snapshot.
        root
          .configure({
            share: false,
            renderer: { antialias: true, logarithmicDepthBuffer: true, alpha: false },
            camera: { position: [0, 8, 75], fov: 33, near: 0.5, far: 110000 },
            dpr: [1, 1.5],
            frameloop: 'always',
            events: createPointerEvents,
            size: { width: rect.width, height: rect.height, top: rect.top, left: rect.left },
            onCreated: (state) => {
              if (disposed) return
              state.events.connect?.(canvas)
            },
          })
          .then(() => {
            if (disposed) return
            configured = true
            render()
          })
          .catch(report)
      } catch (cause) {
        report(cause)
      }
    }
    const scheduleResize = () => {
      if (!disposed && !resizeFrame) resizeFrame = requestAnimationFrame(resize)
    }
    const observer = new ResizeObserver(scheduleResize)
    observer.observe(host)
    window.addEventListener('resize', scheduleResize)
    // Position changes matter to R3F pointer coordinates as well as dimensions.
    window.addEventListener('scroll', scheduleResize, true)
    resize()

    return () => {
      disposed = true
      if (renderLatest.current === render) renderLatest.current = null
      if (resizeFrame) cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      window.removeEventListener('resize', scheduleResize)
      window.removeEventListener('scroll', scheduleResize, true)
      unsubscribe?.()
      root.unmount()
      canvas.remove()
    }
  }, [])

  useEffect(() => {
    renderLatest.current?.()
  }, [children])
  // Forward asynchronous setup, scene, and scheduler failures to SceneBoundary.
  if (error) throw error
  return (
    <div
      ref={container}
      className="r3f-canvas-container"
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}
    />
  )
}
