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
  _lookTrackOverrides: any = null
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
  // Mirrors the vanilla contract: overrides are stored with the track, and a
  // missing second argument resets them.
  setLookTrack(track: any, overrides: any = null) {
    if (this.disposed) throw new Error('setLookTrack() after dispose()')
    this.calls.push(`setLookTrack:${JSON.stringify([track, overrides])}`)
    this._lookTrackOverrides = overrides
    return this
  }
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
  'setFog',
  'setLook',
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

  it('does not re-call the setter for an object prop that is structurally equal but a new reference (issue #12)', () => {
    // Fresh object literals every render — as an inline
    // `<Sky atmosphere={{...}} sunDirection={{...}} />` prop produces.
    const atmosphere = () => ({ miePhaseG: 0.7 })
    const sunDirection = () => ({ elevation: 20, azimuth: 90 })

    render(
      <StrictMode>
        <Sky atmosphere={atmosphere()} sunDirection={sunDirection()} />
      </StrictMode>,
    )
    const [sky] = live()
    const callsAfterMount = sky.calls.filter((c) => c.startsWith('setAtmosphere:') || c.startsWith('setSunDirection:'))
    expect(callsAfterMount.length).toBeGreaterThan(0)
    const countAfterMount = sky.calls.length

    // Re-render with new-but-equal objects — should not call either setter
    // again, and should not touch any other setter either.
    render(
      <StrictMode>
        <Sky atmosphere={atmosphere()} sunDirection={sunDirection()} />
      </StrictMode>,
    )
    expect(live()).toEqual([sky])
    expect(sky.calls).toHaveLength(countAfterMount)

    // A structurally different object still goes through.
    render(
      <StrictMode>
        <Sky atmosphere={{ miePhaseG: 0.9 }} sunDirection={sunDirection()} />
      </StrictMode>,
    )
    expect(sky.calls.length).toBeGreaterThan(countAfterMount)
    expect(sky.calls).toContain('setAtmosphere:[{"miePhaseG":0.9}]')
  })

  it('applies the fog prop through setFog, by value', () => {
    render(<Sky fog={{ density: 2, heightFalloff: 80 }} />)
    const [sky] = live()
    expect(sky.calls).toContain('setFog:[{"density":2,"heightFalloff":80}]')
    const count = sky.calls.length
    render(<Sky fog={{ density: 2, heightFalloff: 80 }} />)
    expect(sky.calls).toHaveLength(count)
    render(<Sky fog={{ density: 3, heightFalloff: 80 }} />)
    expect(sky.calls).toContain('setFog:[{"density":3,"heightFalloff":80}]')
  })

  it('passes pmrem to the constructor and rebuilds only when its value changes', () => {
    render(
      <StrictMode>
        <Sky pmrem={{ generator: 'three', minInterval: 0.5 }}>
          <Probe />
        </Sky>
      </StrictMode>,
    )
    const [sky] = live()
    expect(sky.options.pmrem).toEqual({ generator: 'three', minInterval: 0.5 })

    // A new-but-equal inline object (every parent render) must not rebuild.
    const mountsBefore = probeMounts
    render(
      <StrictMode>
        <Sky pmrem={{ generator: 'three', minInterval: 0.5 }}>
          <Probe />
        </Sky>
      </StrictMode>,
    )
    expect(live()).toEqual([sky])
    expect(sky.disposed).toBe(false)
    expect(probeMounts).toBe(mountsBefore)

    // A different value is a construction change: rebuild against it.
    render(
      <StrictMode>
        <Sky pmrem={{ generator: 'sky', quality: 'fast' }}>
          <Probe />
        </Sky>
      </StrictMode>,
    )
    expect(sky.disposed).toBe(true)
    expect(live()).toHaveLength(1)
    expect(live()[0].options.pmrem).toEqual({ generator: 'sky', quality: 'fast' })
    expect(probeSeen.at(-1)).toBe(live()[0])
  })

  it('applies turbidity on top of atmosphere, whichever prop changes', () => {
    // `setAtmosphere` with Mie fields resets the turbidity-1 baseline, so
    // turbidity must land after it — on mount and on every atmosphere change.
    const ui = (atmosphere: any, turbidity: number) => (
      <StrictMode>
        <Sky atmosphere={atmosphere} turbidity={turbidity} />
      </StrictMode>
    )
    const order = (calls: string[]) =>
      calls.filter((c) => c.startsWith('setAtmosphere:') || c.startsWith('setTurbidity:')).map((c) => c.split(':')[0])

    render(ui({ mieScattering: [0.004, 0.004, 0.004] }, 2))
    const [sky] = live()
    expect(order(sky.calls).at(-1)).toBe('setTurbidity')

    // Only atmosphere changes: turbidity is re-applied after it.
    let mark = sky.calls.length
    render(ui({ mieScattering: [0.008, 0.008, 0.008] }, 2))
    expect(order(sky.calls.slice(mark))).toEqual(['setAtmosphere', 'setTurbidity'])
    expect(sky.calls.at(-1)).toBe('setTurbidity:[2]')

    // Only turbidity changes: the atmosphere setter is not re-called.
    mark = sky.calls.length
    render(ui({ mieScattering: [0.008, 0.008, 0.008] }, 3))
    expect(order(sky.calls.slice(mark))).toEqual(['setTurbidity'])
  })

  it('clears the track when lookTrack is removed', () => {
    render(
      <StrictMode>
        <Sky lookTrack="ghibli" />
      </StrictMode>,
    )
    const [sky] = live()
    expect(sky.calls.at(-1)).toBe('setLookTrack:["ghibli",null]')

    // No `look` to fall back to: back to the physical sky.
    render(
      <StrictMode>
        <Sky />
      </StrictMode>,
    )
    expect(sky.calls.at(-1)).toBe('setLookTrack:[null,null]')

    // With a `look`, removing the track applies it.
    render(
      <StrictMode>
        <Sky look="noir" lookTrack="ghibli" />
      </StrictMode>,
    )
    render(
      <StrictMode>
        <Sky look="noir" />
      </StrictMode>,
    )
    expect(sky.calls.at(-1)).toBe('setLook:["noir"]')
  })

  it('leaves a track set through the instance alone when no look props are given', () => {
    render(
      <StrictMode>
        <Sky exposure={40} />
      </StrictMode>,
    )
    const [sky] = live()
    render(
      <StrictMode>
        <Sky exposure={20} />
      </StrictMode>,
    )
    expect(sky.calls.some((c) => c.startsWith('setLookTrack:') || c.startsWith('setLook:'))).toBe(false)
  })

  it('keeps look-track overrides set through the instance when look props change', () => {
    render(
      <StrictMode>
        <Sky lookTrack="ghibli" />
      </StrictMode>,
    )
    const [sky] = live()
    // A GUI slider pinning chroma through `useSky()`.
    sky.setLookTrack('ghibli', { chroma: 0.2 })

    render(
      <StrictMode>
        <Sky look="noir" lookTrack="ghibli" />
      </StrictMode>,
    )
    expect(sky.calls.at(-1)).toBe('setLookTrack:["ghibli",{"chroma":0.2}]')
    render(
      <StrictMode>
        <Sky lookTrack="ghibli-night" />
      </StrictMode>,
    )
    expect(sky.calls.at(-1)).toBe('setLookTrack:["ghibli-night",{"chroma":0.2}]')
  })

  it('passes lookTrackOverrides through, and clears them when the prop is removed', () => {
    render(
      <StrictMode>
        <Sky lookTrack="ghibli" lookTrackOverrides={{ value: 0.9 }} />
      </StrictMode>,
    )
    const [sky] = live()
    expect(sky.calls.at(-1)).toBe('setLookTrack:["ghibli",{"value":0.9}]')

    // Structurally equal inline object: no re-call.
    const mark = sky.calls.length
    render(
      <StrictMode>
        <Sky lookTrack="ghibli" lookTrackOverrides={{ value: 0.9 }} />
      </StrictMode>,
    )
    expect(sky.calls).toHaveLength(mark)

    render(
      <StrictMode>
        <Sky lookTrack="ghibli" />
      </StrictMode>,
    )
    expect(sky.calls.at(-1)).toBe('setLookTrack:["ghibli",null]')
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
