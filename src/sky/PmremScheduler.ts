import {
  CubeUVReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  RGBAFormat,
  RenderTarget,
} from 'three/webgpu'

import type { PMREMGenerator, Texture } from 'three/webgpu'

export interface PmremSchedulerOptions {
  /**
   * Minimum milliseconds between IBL refreshes while the sky keeps changing
   * (an animated sun, a scrubbed slider). Once the sky stops changing, the
   * final state is refreshed on the next frame regardless, so the IBL never
   * stays stale. `0` refreshes on every change. Default 250.
   */
  minInterval?: number
  /**
   * Roughness levels filtered per frame. A refresh has 10 levels (for a
   * 256 cube); `1` spreads it over ~10 frames at ≤ ~2 ms each, `Infinity`
   * does it in one frame (the old behaviour, ~7 ms on Apple M-series).
   * Default 1.
   */
  levelsPerFrame?: number
}

/**
 * Throttled, time-sliced PMREM for the sky cube.
 *
 * three r185's `PMREMGenerator` prefilters with GGX importance sampling at a
 * fixed 512 samples per texel over ~10 roughness levels. It is latency-bound:
 * a 16² level costs nearly as much as a 64² one, so shrinking the cube barely
 * helps, and a full bake is most of a sun-change re-bake. Sky lighting changes
 * slowly, so this refreshes the IBL less often and spreads each refresh over
 * several frames instead.
 *
 * A sliced refresh renders into a scratch target and copies into the
 * persistent `target` only when complete. The persistent texture's identity
 * never changes — swapping `scene.environment` to a new texture invalidates
 * every material's pipeline cache.
 *
 * Slicing drives the generator's private per-level methods. If they are
 * missing (a future three), it falls back to whole bakes.
 */
export class PmremScheduler {
  target: RenderTarget | null = null
  minInterval: number
  levelsPerFrame: number

  private _renderer: any
  private _gen: any
  private _source: Texture
  private _scratch: RenderTarget | null = null
  private _pending = false
  private _changedThisFrame = false
  private _lastStart = -Infinity
  /** Next level to filter in the active sliced refresh; 0 = none active. */
  private _nextLevel = 0
  private _canSlice: boolean

  constructor(renderer: any, generator: PMREMGenerator, source: Texture, options: PmremSchedulerOptions = {}) {
    this._renderer = renderer
    this._gen = generator
    this._source = source
    this.minInterval = options.minInterval ?? 250
    this.levelsPerFrame = options.levelsPerFrame ?? 1
    const g = this._gen
    this._canSlice =
      typeof g._setSizeFromTexture === 'function' &&
      typeof g._init === 'function' &&
      typeof g._textureToCubeUV === 'function' &&
      typeof g._applyGGXFilter === 'function'
    if (!this._canSlice) {
      console.warn('PmremScheduler: PMREMGenerator internals changed; falling back to whole-frame bakes.')
    }
  }

  get texture(): Texture | null {
    return this.target ? this.target.texture : null
  }

  /** The source cube changed; schedule a refresh. */
  markDirty(): void {
    this._pending = true
    this._changedThisFrame = true
  }

  /** Call once per frame, after the cube bake. */
  tick(now: number = performance.now()): void {
    const changedThisFrame = this._changedThisFrame
    this._changedThisFrame = false

    // First bake: synchronous, so the scene has IBL from frame one.
    if (this.target === null) {
      if (this._pending) {
        this._pending = false
        this._lastStart = now
        this._bakeWhole()
      }
      return
    }

    if (this._nextLevel > 0) {
      this._runSlice()
      return
    }

    if (!this._pending) return
    // Throttle while changes keep arriving; refresh at once when they stop.
    const settled = !changedThisFrame
    if (!settled && now - this._lastStart < this.minInterval) return

    this._pending = false
    this._lastStart = now
    if (!this._canSlice || !(this.levelsPerFrame < this._levelCount())) {
      this._bakeWhole()
    } else {
      this._startSliced()
      this._runSlice()
    }
  }

  /** Finish any in-flight or pending refresh now (screenshots, tests). */
  flush(): void {
    while (this._nextLevel > 0) this._runSlice(Infinity)
    if (this._pending) {
      this._pending = false
      this._lastStart = performance.now()
      this._bakeWhole()
    }
  }

  dispose(): void {
    this.target?.dispose()
    this._scratch?.dispose()
    this.target = this._scratch = null
  }

  // ---------------------------------------------------------------------

  private _bakeWhole(): void {
    this._nextLevel = 0
    if (this.target === null) this.target = this._gen.fromCubemap(this._source)
    else this._gen.fromCubemap(this._source, this.target)
  }

  private _levelCount(): number {
    // Before the first sliced run `_lodMeshes` may be unset; 10 is the 256-cube count.
    const meshes = this._gen._lodMeshes
    return meshes && meshes.length ? meshes.length - 1 : 10
  }

  private _startSliced(): void {
    const target = this.target!
    if (!this._scratch || this._scratch.width !== target.width || this._scratch.height !== target.height) {
      this._scratch?.dispose()
      this._scratch = new RenderTarget(target.width, target.height, {
        magFilter: LinearFilter,
        minFilter: LinearFilter,
        generateMipmaps: false,
        type: HalfFloatType,
        format: RGBAFormat,
        colorSpace: LinearSRGBColorSpace,
        depthBuffer: false,
      })
      this._scratch.texture.mapping = CubeUVReflectionMapping
      this._scratch.texture.name = 'PMREM.cubeUv.scratch'
      this._scratch.scissorTest = true
    }
    this._nextLevel = 1
  }

  /** Filter the next `levels` roughness levels into the scratch target. */
  private _runSlice(levels: number = this.levelsPerFrame): void {
    const r = this._renderer
    const g = this._gen
    const scratch = this._scratch!
    const prevTarget = r.getRenderTarget()
    const prevFace = r.getActiveCubeFace()
    const prevMip = r.getActiveMipmapLevel()
    const prevAutoClear = r.autoClear

    g._setSizeFromTexture(this._source)
    g._init(scratch)
    scratch.scissorTest = true
    // Level 0 is a straight copy of the cube into the cube-UV layout; it
    // always happens with level 1 so a slice never re-reads a changed cube.
    if (this._nextLevel === 1) g._textureToCubeUV(this._source, scratch)

    r.autoClear = false
    const last = g._lodMeshes.length - 1
    let done = 0
    while (this._nextLevel <= last && done < levels) {
      g._applyGGXFilter(scratch, this._nextLevel - 1, this._nextLevel)
      this._nextLevel++
      done++
    }
    r.autoClear = prevAutoClear

    r.setRenderTarget(prevTarget, prevFace, prevMip)
    scratch.scissorTest = false
    scratch.viewport.set(0, 0, scratch.width, scratch.height)
    scratch.scissor.set(0, 0, scratch.width, scratch.height)

    if (this._nextLevel > last) {
      this._nextLevel = 0
      r.copyTextureToTexture(scratch.texture, this.target!.texture)
    }
  }
}
