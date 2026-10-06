import { PmremScheduler } from '../PmremScheduler'
import { cubeUVLayout } from './cubeUV'
import { DOWNSAMPLE_WGSL, FIS_WGSL, INTEG_TILED_WGSL, INTEG_WGSL, PACK_CUBEUV_WGSL } from './kernels'

import {
  CubeRenderTarget,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  REVISION,
  RGBAFormat,
  RenderTarget,
} from 'three/webgpu'

import type { PMREMGenerator, Texture } from 'three/webgpu'
import type { PmremSchedulerOptions } from '../PmremScheduler'

export interface SkyPmremOptions extends PmremSchedulerOptions {
  /**
   * `'sky'` (default): on the WebGPU backend, re-filter the IBL with our
   * compute prefilter on every sky change (~0.9 ms at 256 on three r187+,
   * ~1.1 ms on r185/r186), so it updates in the same frame as the background.
   * Falls back to `'three'` where it can't run (WebGL backend, an unknown
   * PMREM layout).
   * `'three'`: three's `PMREMGenerator`, throttled and time-sliced by
   * `PmremScheduler` (`minInterval`, `levelsPerFrame`).
   */
  generator?: 'sky' | 'three'
  /**
   * `'three'` (default): on r187+, three's exact algorithm and output (256
   * GGX samples on the sharp levels, exhaustive integration on the rough
   * ones). `'fast'`: 96 samples on the sharpest level, ~35% cheaper on r187+,
   * slightly noisier highlights on dark skies (on r185/r186 it saves little:
   * the atlas path already uses 128 samples where they measured the same).
   */
  quality?: 'three' | 'fast'
}

/** Rough levels integrate every texel of this source mip (three r187 uses the same). */
const INTEGRATION_SIZE = 16
const INTEGRATION_LEVELS = 3
/** CubeUV atlas: levels up to this roughness use importance sampling, rougher ones integration. */
const ATLAS_FIS_MAX_ROUGHNESS = 0.25

// WebGPU usage flags (fixed by the spec; the TS DOM lib doesn't declare the globals).
const TEXTURE_COPY_SRC = 0x01
const TEXTURE_COPY_DST = 0x02
const TEXTURE_BINDING = 0x04
const TEXTURE_STORAGE_BINDING = 0x08
const BUFFER_COPY_DST = 0x08
const BUFFER_UNIFORM = 0x40

type Step = { fis: number } | { integ: number }

/**
 * Per-level plan for a cube PMREM (three r187+) with levels `0 … maxLod` (face
 * sizes down to 8²). Level 0 is a copy (`fis: 0`), the last three levels
 * integrate a 16² source mip, and the rest use filtered importance sampling.
 * SKY_PMREM_SPEC.md §6.
 */
export function skyPmremPlan(maxLod: number, quality: 'three' | 'fast' = 'three'): Step[] {
  const plan: Step[] = []
  for (let lod = 0; lod <= maxLod; lod++) {
    if (lod === 0) plan.push({ fis: 0 })
    else if (lod > maxLod - INTEGRATION_LEVELS) plan.push({ integ: INTEGRATION_SIZE })
    else plan.push({ fis: quality === 'fast' && lod === 1 ? 96 : 256 })
  }
  return plan
}

/** Roughness three r187 prefilters mip `lod` for (`PMREMGenerator.lodToRoughness`). */
export const lodToRoughness = (lod: number, maxLod: number) => (maxLod > 0 ? 1 - Math.sqrt(1 - lod / maxLod) : 0)

/**
 * The sky's PMREM (image-based lighting), prefiltered with WebGPU compute.
 *
 * three's `PMREMGenerator` renders every level as six face passes of a long
 * per-texel loop; at 256 it costs ~3–6 ms depending on the three version,
 * too much to run on every sun change. This runs in one compute pass
 * (~0.9–1.1 ms), so a moving sun or a scrubbed time-of-day slider updates the
 * IBL in the same frame as the background, with no throttle.
 *
 * On WebGPU it replaces three's generator entirely. It allocates the PMREM
 * target itself, in the layout the installed three samples, so
 * `texture` exists (and never changes identity) from construction:
 *
 * - r187+ cube PMREM (`isPMREMTexture`, one mip per roughness): three r187's
 *   algorithm, identical output.
 * - r186 CubeUV atlas: each atlas level prefiltered at the roughness three's
 *   sampler reads it at, packed into the atlas layout. Closer to the true GGX
 *   lobe than three's own incremental chain, so rough reflections look
 *   slightly different from three's generator.
 *
 * Its compute pipelines compile asynchronously from construction (`ready`);
 * nothing it does compiles a shader synchronously. Until they are ready the
 * texture is black, so await `ready` (or the sky's `compileAsync()`) before
 * the first frame to have IBL on it. It also takes over the source cube's mip
 * chain: the mips it builds for its own sampling are copied into the cube, and
 * three's mipmap pass for it never runs.
 *
 * The WebGL backend (no compute), `generator: 'three'`, a source it can't
 * filter and a failed compile fall back to three's generator via
 * `PmremScheduler`, which is only created then.
 */
export class SkyPmrem {
  /** Which path is live: ours (`'sky'`) or three's generator. */
  mode: 'three' | 'sky' = 'three'
  /** The PMREM layout our path writes. */
  layout: 'cube' | 'atlas' | null = null
  /** Resolves once the compute pipelines are compiled (or the three fallback is in place). Never rejects. */
  readonly ready: Promise<void>

  private _renderer: any
  private _source: Texture
  private _generator: PMREMGenerator | (() => PMREMGenerator) | null
  private _options: SkyPmremOptions
  private _fallback: PmremScheduler | null = null
  private _quality: 'three' | 'fast'
  private _target: any = null
  private _sourceMips = 0
  private _pending = false
  private _gpu: GpuState | null = null
  private _disposed = false

  /**
   * @param generator three's `PMREMGenerator`, a function returning one, or
   *   `null`. Only used for the fallback, so on WebGPU it is usually never
   *   created.
   */
  constructor(
    renderer: any,
    generator: PMREMGenerator | (() => PMREMGenerator) | null,
    source: Texture,
    options: SkyPmremOptions = {},
  ) {
    this._renderer = renderer
    this._source = source
    this._generator = generator
    this._options = options
    this._quality = options.quality ?? 'three'

    const backend = renderer.backend
    const srcSize = sourceSize(source)
    const intMip = Math.log2(srcSize / INTEGRATION_SIZE)
    const canFilter = Number.isInteger(intMip) && intMip >= 0
    if ((options.generator ?? 'sky') !== 'sky' || backend?.isWebGPUBackend !== true) {
      this._useThree()
      this.ready = Promise.resolve()
    } else if (!canFilter) {
      console.warn('SkyPmrem: the sky cube is not a power of two of at least 16; using three’s PMREMGenerator.')
      this._useThree()
      this.ready = Promise.resolve()
    } else {
      this.mode = 'sky'
      this.layout = Number(REVISION) >= 187 ? 'cube' : 'atlas'
      this._target = allocateTarget(this.layout, cubeSizeFor(srcSize))
      renderer.initTexture(this._target.texture)
      this._takeOverSourceMips(srcSize)
      this.ready = this._compile(srcSize)
    }
  }

  /** The PMREM texture: ours from construction on WebGPU, three's after its first bake otherwise. */
  get texture(): Texture | null {
    return this._fallback ? this._fallback.texture : this._target.texture
  }

  get target(): RenderTarget | null {
    return this._fallback ? this._fallback.target : this._target
  }

  /** The source cube changed; schedule a refresh. */
  markDirty(): void {
    if (this._fallback) this._fallback.markDirty()
    else this._pending = true
  }

  /** Call once per frame, after the cube bake. */
  tick(now: number = performance.now()): void {
    if (this._fallback) this._fallback.tick(now)
    else if (this._pending && this._gpu) this._bake()
  }

  /** Finish any pending refresh now (screenshots, tests). Before `ready`, ours has nothing to run yet. */
  flush(): void {
    if (this._fallback) this._fallback.flush()
    else if (this._pending && this._gpu) this._bake()
  }

  dispose(): void {
    this._disposed = true
    if (this._gpu) for (const r of this._gpu.owned) r.destroy()
    this._gpu = null
    this._fallback?.dispose()
    // A fallback writes into our target (see `_useThree`), so it is ours to free either way.
    this._target?.dispose()
  }

  // ---------------------------------------------------------------------

  /** Compile every pipeline asynchronously, then build the GPU state; on failure fall back to three. */
  private async _compile(srcSize: number): Promise<void> {
    const device = this._renderer.backend.device
    const make = (code: string, constants?: Record<string, number>) =>
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main', constants },
      })
    try {
      const [down, fis, integ, tiled, pack] = await Promise.all([
        make(DOWNSAMPLE_WGSL),
        make(FIS_WGSL, { MIRROR: 1 }),
        make(INTEG_WGSL),
        make(INTEG_TILED_WGSL),
        this.layout === 'atlas' ? make(PACK_CUBEUV_WGSL) : null,
      ])
      if (this._disposed) return
      const pipes = { down, fis, integ, tiled, pack }
      const t = this._target
      this._gpu =
        this.layout === 'cube'
          ? buildCube(device, pipes, srcSize, t.width, t.texture.mipmaps.length - 1, this._quality)
          : buildAtlas(device, pipes, srcSize, t.height / 4, this._quality)
      // A bake requested while compiling runs now, not at the next tick():
      // callers that only call update() on a change would otherwise keep a
      // black IBL until the sky next changes. Our own encoder and queue, so
      // this doesn't depend on three's frame.
      if (this._pending) this._bake()
    } catch (err) {
      if (this._disposed) return
      console.warn('SkyPmrem: pipeline compile failed; using three’s PMREMGenerator.', err)
      this._restoreSourceMips()
      this._useThree(this._target)
    }
  }

  /** Switch to three's generator, throttled by `PmremScheduler`, optionally writing into `target`. */
  private _useThree(target: any = null): void {
    this.mode = 'three'
    const gen = typeof this._generator === 'function' ? this._generator() : this._generator
    if (!gen) throw new Error('SkyPmrem: three’s PMREMGenerator is needed here but none was given.')
    this._fallback = new PmremScheduler(this._renderer, gen, this._source, this._options)
    if (target) this._fallback.target = target
    if (this._pending) this._fallback.markDirty()
  }

  /**
   * Allocate the source cube's mips without three generating them: a cube
   * texture listing its mips gets them allocated, and three only fills render
   * target mips when `generateMipmaps` is set. `_bake` copies ours in. Must
   * run before the cube's first render, which allocates it.
   */
  private _takeOverSourceMips(srcSize: number): void {
    const src: any = this._source
    if (src.isCubeTexture !== true || src.mipmaps?.length) return
    const levels = Math.log2(srcSize)
    src.mipmaps = Array.from({ length: levels }, (_, i) => ({ width: srcSize >> (i + 1), height: srcSize >> (i + 1) }))
    src.generateMipmaps = false
    this._sourceMips = levels
  }

  private _restoreSourceMips(): void {
    if (!this._sourceMips) return
    // The levels stay allocated; three fills them again after each capture.
    ;(this._source as any).generateMipmaps = true
    this._sourceMips = 0
  }

  private _bake(): void {
    this._pending = false
    const g = this._gpu!
    const backend = this._renderer.backend
    // Looked up every bake: three may recreate either GPU texture (resize, context loss).
    const srcGpu = backend.get(this._source)?.texture
    const dstGpu = backend.get(this._target.texture)?.texture
    if (!srcGpu || !dstGpu) {
      // The cube hasn't been captured yet; try again after it is.
      this._pending = true
      return
    }

    const encoder = g.device.createCommandEncoder({ label: 'SkyPmrem' })
    const n = g.srcSize
    encoder.copyTextureToTexture({ texture: srcGpu, mipLevel: 0 }, { texture: g.src, mipLevel: 0 }, [n, n, 6])
    const pass = encoder.beginComputePass()
    for (const st of g.passes) {
      pass.setPipeline(st.pipe)
      pass.setBindGroup(0, st.bindGroup)
      pass.dispatchWorkgroups(st.wg[0], st.wg[1], st.wg[2])
    }
    pass.end()
    g.write(encoder, dstGpu)
    // The source cube's mips, from the chain built above (see `_takeOverSourceMips`).
    const mips = Math.min(this._sourceMips + 1, srcGpu.mipLevelCount)
    for (let m = 1; m < mips; m++) {
      const s = n >> m
      encoder.copyTextureToTexture({ texture: g.src, mipLevel: m }, { texture: srcGpu, mipLevel: m }, [s, s, 6])
    }
    g.device.queue.submit([encoder.finish()])
  }
}

/** Face size of a cube texture (`CubeTexture.image` is one entry per face). */
function sourceSize(source: any): number {
  const image = Array.isArray(source?.image) ? source.image[0] : source?.image
  return image?.width ?? 0
}

/** three's PMREM cube size for a source cube: the largest power of two ≤ its face size (`_setSize`). */
function cubeSizeFor(srcSize: number): number {
  return Math.pow(2, Math.floor(Math.log2(srcSize)))
}

/** Smallest face three r187's cube PMREM keeps (`LOD_MIN`): 8². */
const CUBE_LOD_MIN = 3

/**
 * The PMREM target three's own generator would allocate for this layout, so
 * three's environment nodes sample it as one of theirs: r186's CubeUV atlas
 * (`_createRenderTarget`) or r187's cube with a listed mip chain
 * (`_allocateTarget`).
 */
function allocateTarget(layout: 'cube' | 'atlas', cubeSize: number): any {
  if (layout === 'cube') {
    const target = new CubeRenderTarget(cubeSize, {
      minFilter: LinearMipmapLinearFilter,
      generateMipmaps: false,
      type: HalfFloatType,
      colorSpace: LinearSRGBColorSpace,
      depthBuffer: false,
    })
    const maxLod = Math.log2(cubeSize) - CUBE_LOD_MIN
    for (let lod = 0; lod <= maxLod; lod++)
      target.texture.mipmaps.push({ width: cubeSize >> lod, height: cubeSize >> lod } as any)
    target.texture.name = 'PMREM'
    ;(target.texture as any).isPMREMTexture = true
    return target
  }
  const L = cubeUVLayout(cubeSize)
  const target = new RenderTarget(L.width, L.height, {
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    generateMipmaps: false,
    type: HalfFloatType,
    format: RGBAFormat,
    colorSpace: LinearSRGBColorSpace,
    depthBuffer: false,
  })
  target.texture.mapping = CUBEUV_REFLECTION_MAPPING as any
  target.texture.name = 'PMREM.cubeUv'
  ;(target.texture as any).isPMREMTexture = true
  target.scissorTest = true
  return target
}

/** three's `CubeUVReflectionMapping` (r185/r186; the export is gone in r187). */
const CUBEUV_REFLECTION_MAPPING = 306

// ---------------------------------------------------------------------------

interface Pipes {
  down: any
  fis: any
  integ: any
  tiled: any
  pack: any
}

interface GpuPass {
  pipe: any
  wg: [number, number, number]
  bindGroup: any
}

interface GpuState {
  device: any
  sampler: any
  /** Our copy of the sky cube, with a full mip chain. */
  src: any
  srcSize: number
  /** Cube view of `src` (FIS reads every mip; copy and pack passes read mip 0). */
  srcCube: any
  /** The 16² mip of `src` that the rough levels integrate. */
  srcInteg: any
  passes: GpuPass[]
  /** Textures and buffers we own, destroyed on dispose. */
  owned: any[]
  /** Copy the result into three's target. */
  write: (encoder: any, dstGpu: any) => void
}

const levelView = (tex: any, mip: number) =>
  tex.createView({ dimension: '2d-array', baseMipLevel: mip, mipLevelCount: 1 })

function uniform(g: GpuState, u: ArrayBuffer): any {
  const buf = g.device.createBuffer({ size: 16, usage: BUFFER_UNIFORM | BUFFER_COPY_DST })
  g.device.queue.writeBuffer(buf, 0, u)
  g.owned.push(buf)
  return buf
}

function addPass(g: GpuState, pipe: any, wg: [number, number, number], resources: any[]): void {
  const bindGroup = g.device.createBindGroup({
    layout: pipe.getBindGroupLayout(0),
    entries: resources.map((resource, binding) => ({ binding, resource })),
  })
  g.passes.push({ pipe, wg, bindGroup })
}

/** Our source cube and the passes that build its mip chain from mip 0 (copied in each bake). */
function newState(device: any, pipes: Pipes, srcSize: number): GpuState {
  const mips = Math.log2(srcSize) + 1
  const src = device.createTexture({
    label: 'SkyPmrem.source',
    size: [srcSize, srcSize, 6],
    format: 'rgba16float',
    mipLevelCount: mips,
    usage: TEXTURE_STORAGE_BINDING | TEXTURE_BINDING | TEXTURE_COPY_DST | TEXTURE_COPY_SRC,
  })
  const g: GpuState = {
    device,
    sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' }),
    src,
    srcSize,
    srcCube: src.createView({ dimension: 'cube' }),
    srcInteg: levelView(src, Math.log2(srcSize / INTEGRATION_SIZE)),
    passes: [],
    owned: [src],
    write: () => {},
  }
  for (let m = 1; m < mips; m++) {
    const s = srcSize >> m
    const buf = uniform(g, new Uint32Array([s, 0, 0, 0]).buffer)
    addPass(
      g,
      pipes.down,
      [Math.ceil(s / 8), Math.ceil(s / 8), 6],
      [levelView(src, m - 1), levelView(src, m), { buffer: buf }],
    )
  }
  return g
}

/** One prefiltered level of face size `s` at roughness `r`, written to the 2d-array view `dst`. */
function addLevel(g: GpuState, pipes: Pipes, dst: any, s: number, r: number, step: Step): void {
  const u = new ArrayBuffer(16)
  if ('integ' in step) {
    new Uint32Array(u, 0, 2).set([s, step.integ])
    new Float32Array(u, 8, 1).set([r])
    // Tiled kernel once a level has thousands of texels, reduction kernel for tiny ones.
    const tiled = s >= 32
    addPass(g, tiled ? pipes.tiled : pipes.integ, tiled ? [Math.ceil(s / 8), Math.ceil(s / 8), 6] : [s * s, 6, 1], [
      g.srcInteg,
      dst,
      { buffer: uniform(g, u) },
    ])
  } else {
    // three r187's bias: match each sample's solid angle, plus half a mip against noise.
    const lodBias = r > 0 ? Math.log2(g.srcSize) + 0.5 * Math.log2(6 / (step.fis * Math.pow(r, 4))) + 0.5 : 0
    new Uint32Array(u, 0, 2).set([s, Math.max(step.fis, 1)])
    new Float32Array(u, 8, 2).set([r, lodBias])
    addPass(
      g,
      pipes.fis,
      [Math.ceil(s / 8), Math.ceil(s / 8), 6],
      [g.srcCube, g.sampler, dst, { buffer: uniform(g, u) }],
    )
  }
}

/** r187+: prefilter into a private cube with mips, then copy each mip into three's target. */
function buildCube(
  device: any,
  pipes: Pipes,
  srcSize: number,
  outSize: number,
  maxLod: number,
  quality: 'three' | 'fast',
): GpuState {
  const g = newState(device, pipes, srcSize)
  const out = device.createTexture({
    label: 'SkyPmrem.cube',
    size: [outSize, outSize, 6],
    format: 'rgba16float',
    mipLevelCount: maxLod + 1,
    usage: TEXTURE_STORAGE_BINDING | TEXTURE_COPY_SRC,
  })
  g.owned.push(out)
  skyPmremPlan(maxLod, quality).forEach((step, lod) => {
    const r = lod === 0 ? 0 : lodToRoughness(lod, maxLod)
    addLevel(g, pipes, levelView(out, lod), outSize >> lod, r, step)
  })
  g.write = (encoder, dstGpu) => {
    for (let lod = 0; lod <= maxLod; lod++) {
      const s = outSize >> lod
      encoder.copyTextureToTexture({ texture: out, mipLevel: lod }, { texture: dstGpu, mipLevel: lod }, [s, s, 6])
    }
  }
  return g
}

/**
 * r185/r186: prefilter each atlas level at the roughness three's sampler reads
 * it at, on the tile's inner (s − 2)² grid, pack all tiles into a private
 * atlas, then copy it into three's target.
 */
function buildAtlas(device: any, pipes: Pipes, srcSize: number, cubeSize: number, quality: 'three' | 'fast'): GpuState {
  const g = newState(device, pipes, srcSize)
  const L = cubeUVLayout(cubeSize)
  const atlas = device.createTexture({
    label: 'SkyPmrem.atlas',
    size: [L.width, L.height],
    format: 'rgba16float',
    usage: TEXTURE_STORAGE_BINDING | TEXTURE_COPY_SRC,
  })
  g.owned.push(atlas)
  const atlasView = atlas.createView()
  const packs: Array<[any, number, number, number]> = []
  for (const t of L.tiles) {
    // Level 0 packs the sky cube itself; the others pack their own prefiltered cube.
    let read = g.srcCube
    if (t.level > 0) {
      const s = t.size - 2
      const tex = device.createTexture({
        label: `SkyPmrem.atlas.L${t.level}`,
        size: [s, s, 6],
        format: 'rgba16float',
        usage: TEXTURE_STORAGE_BINDING | TEXTURE_BINDING,
      })
      g.owned.push(tex)
      // 128 samples on levels 1–2 measured the same as 256 against the reference
      // (research/pmrem-lab/ATLAS_NOTES.md) at ~0.4 ms less; `fast` drops level 1 to 96.
      const fis = t.level === 1 && quality === 'fast' ? 96 : t.level <= 2 ? 128 : 256
      const step: Step = t.roughness <= ATLAS_FIS_MAX_ROUGHNESS ? { fis } : { integ: INTEGRATION_SIZE }
      addLevel(g, pipes, levelView(tex, 0), s, t.roughness, step)
      read = tex.createView({ dimension: 'cube' })
    }
    packs.push([read, t.x, t.y, t.size])
  }
  // All levels first, then every pack (the pass orders them; storage writes are visible to later dispatches).
  for (const [read, x, y, size] of packs) {
    const buf = uniform(g, new Uint32Array([x, y, size, 0]).buffer)
    addPass(
      g,
      pipes.pack,
      [Math.ceil((3 * size) / 8), Math.ceil((2 * size) / 8), 1],
      [read, g.sampler, atlasView, { buffer: buf }],
    )
  }
  g.write = (encoder, dstGpu) => {
    encoder.copyTextureToTexture({ texture: atlas }, { texture: dstGpu }, [L.width, L.height, 1])
  }
  return g
}
