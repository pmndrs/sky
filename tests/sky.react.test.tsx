// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Activity, StrictMode, Suspense, act, useEffect, useLayoutEffect } from 'react'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'

// The vanilla `Sky` needs a WebGPU renderer, so the binding is exercised
// against a stand-in that records what a consumer can observe: which scene
// it is attached to, whether it has been disposed, and setter calls.
const instances: FakeSky[] = []
/** When set, every FakeSky's compileAsync() waits on it. */
let compileGate: Promise<void> | null = null
/** The latest useFrame callback, so a test can step a frame. */
let frame: ((state: any) => void) | null = null

class FakeSky {
  options: any
  scene: any = null
  disposed = false
  calls: string[] = []
  constructor(_renderer: any, options: any) {
    this.options = options
    instances.push(this)
  }
  attaches: any[] = []
  _ownsBackground = false
  _ownsEnvironment = false
  get _scene() {
    return this.scene
  }
  attach(scene: any, { background = true, environment = true }: any = {}) {
    if (this.disposed) throw new Error('attach() after dispose()')
    this.scene = scene
    this._ownsBackground = background
    this._ownsEnvironment = environment
    this.attaches.push({ background, environment })
    return this
  }
  dispose() {
    this.disposed = true
    this.scene = null
  }
  compileAsync() {
    return compileGate ?? Promise.resolve()
  }
  updates = 0
  update() {
    this.updates++
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
  'setGrade',
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
  useFrame: (cb: (state: any) => void) => {
    frame = cb
  },
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
  compileGate = null
  frame = null
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
  it('bakes only once compileAsync has settled (issue #49)', async () => {
    let finish!: () => void
    compileGate = new Promise<void>((done) => (finish = done))
    render(<Sky />)
    const [sky] = live()
    frame!({ camera: {} })
    expect(sky.updates).toBe(0)
    await act(async () => finish())
    frame!({ camera: {} })
    expect(sky.updates).toBe(1)
  })

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

  it('attaches with the background / environment roles and re-attaches the same instance when they change', () => {
    render(
      <StrictMode>
        <Sky environment={false}>
          <Probe />
        </Sky>
      </StrictMode>,
    )
    const [sky] = live()
    // Attached once with the requested roles: never claims the environment first.
    expect(sky.attaches).toEqual([{ background: true, environment: false }])

    // An unchanged pair (every parent render) does not re-attach.
    render(
      <StrictMode>
        <Sky environment={false}>
          <Probe />
        </Sky>
      </StrictMode>,
    )
    expect(sky.attaches).toHaveLength(1)

    const mountsBefore = probeMounts
    render(
      <StrictMode>
        <Sky background={false}>
          <Probe />
        </Sky>
      </StrictMode>,
    )
    expect(live()).toEqual([sky])
    expect(probeMounts).toBe(mountsBefore)
    expect(sky.attaches.at(-1)).toEqual({ background: false, environment: true })
    expect(sky.scene).toBe(fakeScene)
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

  it('applies a grade prop, clears it when removed, and ignores a re-created equal one', () => {
    const def = { keys: [{ elevation: -12, fill: { intensity: 0.5 } }] }
    render(
      <StrictMode>
        <Sky grade="storybook" />
      </StrictMode>,
    )
    const [sky] = live()
    expect(live()).toHaveLength(1)
    expect(sky.calls.at(-1)).toBe('setGrade:["storybook"]')

    // An inline definition re-created every render is applied once.
    render(
      <StrictMode>
        <Sky grade={{ ...def }} />
      </StrictMode>,
    )
    let mark = sky.calls.length
    render(
      <StrictMode>
        <Sky grade={{ ...def, keys: [...def.keys] }} />
      </StrictMode>,
    )
    expect(sky.calls.slice(mark).filter((c) => c.startsWith('setGrade'))).toEqual([])

    // Removing the prop clears the grade it set.
    render(
      <StrictMode>
        <Sky />
      </StrictMode>,
    )
    expect(sky.calls.at(-1)).toBe('setGrade:[null]')

    // Without a grade prop ever set, nothing is cleared (an imperative grade stays).
    mark = sky.calls.length
    render(
      <StrictMode>
        <Sky timeOfDay={9} />
      </StrictMode>,
    )
    expect(sky.calls.slice(mark).filter((c) => c.startsWith('setGrade'))).toEqual([])
    expect(live()).toEqual([sky])
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
