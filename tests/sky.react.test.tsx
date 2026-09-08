// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Activity, StrictMode, Suspense, act, useEffect, useLayoutEffect } from 'react'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'

// The vanilla `Sky` needs a WebGPU renderer, so the binding is exercised
// against a stand-in that records what a consumer can observe: which scene
// it is attached to, whether it has been disposed, and setter calls.
const instances: FakeSky[] = []

class FakeSky {
  options: any
  scene: any = null
  disposed = false
  calls: string[] = []
  constructor(_renderer: any, options: any) {
    this.options = options
    instances.push(this)
  }
  attach(scene: any) {
    if (this.disposed) throw new Error('attach() after dispose()')
    this.scene = scene
    return this
  }
  dispose() {
    this.disposed = true
    this.scene = null
  }
  update() {}
}
for (const m of [
  'setTimeOfDay',
  'setLatitude',
  'setDayOfYear',
  'setSunDirection',
  'setExposure',
  'setSunDisc',
  'setNorth',
  'setTurbidity',
  'setGroundAlbedo',
  'setAtmosphere',
  'setMirrorBelowHorizon',
  'setHazeStrength',
  'setHazePolicy',
  'setHazeAltitudeBlend',
]) {
  ;(FakeSky.prototype as any)[m] = function (this: FakeSky, ...args: any[]) {
    if (this.disposed) throw new Error(`${m}() after dispose()`)
    this.calls.push(`${m}:${JSON.stringify(args)}`)
    return this
  }
}

vi.mock('../src/Sky', () => ({ Sky: FakeSky }))

const fakeRenderer = {}
const fakeScene = { isScene: true }
vi.mock('@react-three/fiber/webgpu', () => ({
  useThree: (selector: (s: any) => any) => selector({ gl: fakeRenderer, scene: fakeScene }),
  useFrame: () => {},
}))

const { Sky } = await import('../src/react/Sky')
const { useSky } = await import('../src/react/SkyContext')

// A child that uses the sky, as a consumer would.
let probeMounts = 0
let probeSeen: any[] = []
function Probe() {
  probeSeen.push(useSky())
  useEffect(() => {
    probeMounts++
  }, [])
  return null
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  instances.length = 0
  probeMounts = 0
  probeSeen = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const live = () => instances.filter((s) => !s.disposed)
const render = (ui: React.ReactNode) => act(() => root.render(ui))

describe('<Sky>', () => {
  it('keeps resources live when suspended children reveal in StrictMode', async () => {
    let ready = false
    let resolve!: () => void
    const loaded = new Promise<void>((done) => {
      resolve = done
    })
    const observed: boolean[] = []
    function Consumer() {
      const sky = useSky() as unknown as FakeSky
      useLayoutEffect(() => {
        observed.push(sky.disposed)
      }, [sky])
      useEffect(() => {
        observed.push(sky.disposed)
      }, [sky])
      if (!ready) throw loaded
      observed.push(sky.disposed)
      return null
    }
    await act(async () => {
      root.render(
        <StrictMode>
          <Suspense fallback={null}>
            <Sky>
              <Consumer />
            </Sky>
          </Suspense>
        </StrictMode>,
      )
    })
    await act(async () => {
      ready = true
      resolve()
      await loaded
    })
    expect(observed.length).toBeGreaterThan(0)
    expect(observed).not.toContain(true)
    expect(live()).toHaveLength(1)
  })

  it('mounts one sky attached to the scene and gives children a live instance (StrictMode)', () => {
    render(
      <StrictMode>
        <Sky timeOfDay={12}>
          <Probe />
        </Sky>
      </StrictMode>,
    )
    expect(live()).toHaveLength(1)
    expect(live()[0].scene).toBe(fakeScene)
    expect(probeSeen.length).toBeGreaterThan(0)
    for (const seen of probeSeen) expect(seen?.disposed).toBe(false)
    expect(probeSeen.at(-1)).toBe(live()[0])
  })

  it('applies prop changes to the same instance', () => {
    render(
      <StrictMode>
        <Sky timeOfDay={12} />
      </StrictMode>,
    )
    const [sky] = live()
    render(
      <StrictMode>
        <Sky timeOfDay={18} />
      </StrictMode>,
    )
    expect(live()).toEqual([sky])
    expect(sky.calls).toContain('setTimeOfDay:[18]')
  })

  it('rebuilds on a construction prop and remounts children against the new instance', () => {
    render(
      <StrictMode>
        <Sky quality="medium">
          <Probe />
        </Sky>
      </StrictMode>,
    )
    const [old] = live()
    const mountsBefore = probeMounts
    render(
      <StrictMode>
        <Sky quality="high">
          <Probe />
        </Sky>
      </StrictMode>,
    )
    expect(old.disposed).toBe(true)
    expect(live()).toHaveLength(1)
    expect(live()[0].options.quality).toBe('high')
    expect(probeMounts).toBeGreaterThan(mountsBefore)
    expect(probeSeen.at(-1)).toBe(live()[0])
  })

  it('rebuilds cleanly when construction and imperative props change together', () => {
    render(
      <StrictMode>
        <Sky quality="medium" timeOfDay={12}>
          <Probe />
        </Sky>
      </StrictMode>,
    )
    const [old] = live()
    expect(() =>
      render(
        <StrictMode>
          <Sky quality="high" timeOfDay={18}>
            <Probe />
          </Sky>
        </StrictMode>,
      ),
    ).not.toThrow()
    expect(old.disposed).toBe(true)
    expect(live()).toHaveLength(1)
    expect(live()[0].options.timeOfDay).toBe(18)
    expect(probeSeen.at(-1)).toBe(live()[0])
  })

  it('disposes on unmount without waiting on a timer', () => {
    vi.useFakeTimers()
    try {
      render(
        <StrictMode>
          <Sky />
        </StrictMode>,
      )
      const [sky] = live()
      act(() => root.render(null))
      expect(sky.disposed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('disposes when hidden by <Activity> and comes back live when shown', () => {
    const ui = (mode: 'visible' | 'hidden') => (
      <StrictMode>
        <Activity mode={mode}>
          <Sky>
            <Probe />
          </Sky>
        </Activity>
      </StrictMode>
    )
    render(ui('visible'))
    const [first] = live()
    render(ui('hidden'))
    expect(first.disposed).toBe(true)
    expect(live()).toHaveLength(0)
    render(ui('visible'))
    expect(live()).toHaveLength(1)
    expect(live()[0].scene).toBe(fakeScene)
    expect(probeSeen.at(-1)).toBe(live()[0])
  })
})
