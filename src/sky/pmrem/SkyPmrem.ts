import { PmremScheduler } from '../PmremScheduler'
import { cubeUVLayout } from './cubeUV'
import { DOWNSAMPLE_WGSL, FIS_WGSL, INTEG_TILED_WGSL, INTEG_WGSL, PACK_CUBEUV_WGSL } from './kernels'

import type { PMREMGenerator, RenderTarget, Texture } from 'three/webgpu'
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
 * The sky's PMREM (image-based lighting), re-filtered with WebGPU compute.
 *
 * three's `PMREMGenerator` renders every level as six face passes of a long
 * per-texel loop; at 256 it costs ~3–6 ms depending on the three version,
 * too much to run on every sun change. This runs in one compute pass
 * (~0.9–1.1 ms), so a moving sun or a scrubbed time-of-day slider updates the
 * IBL in the same frame as the background, with no throttle.
 *
 * three still allocates the target (its first bake), so the texture has the
 * exact layout the installed three samples, and its identity never changes.
 * Each later bake prefilters the sky cube (whose mips three already built)
 * into private storage textures and copies the result into that target:
 *
 * - r187+ cube PMREM (`texture.isPMREMTexture`, one mip per roughness): three
 *   r187's algorithm, identical output, copied mip by mip.
 * - r185/r186 CubeUV atlas: each atlas level prefiltered at the roughness
 *   three's sampler reads it at, packed into the atlas layout. Closer to the
 *   true GGX lobe than three's own incremental chain, so rough reflections
 *   look slightly different from three's generator.
 *
 * The WebGL backend (no compute) and unknown layouts keep three's generator
 * via `PmremScheduler`.
 */
export class SkyPmrem {
  /** Which path is live: three's generator (always, until our pipelines are ready) or ours. */
  mode: 'three' | 'sky' = 'three'
  /** The PMREM layout our path writes, once detected. */
  layout: 'cube' | 'atlas' | null = null

  private _renderer: any
  private _source: Texture
  private _fallback: PmremScheduler
  private _want: boolean
  private _quality: 'three' | 'fast'
  private _pending = false
  /** Set once the first three bake has allocated the target and we tried to set up. */
  private _probed = false
  private _gpu: GpuState | null = null
  private _disposed = false

  constructor(renderer: any, generator: PMREMGenerator, source: Texture, options: SkyPmremOptions = {}) {
    this._renderer = renderer
    this._source = source
    this._want = (options.generator ?? 'sky') === 'sky'
    this._quality = options.quality ?? 'three'
    this._fallback = new PmremScheduler(renderer, generator, source, options)
  }

  get texture(): Texture | null {
    return this._fallback.texture
  }

  get target(): RenderTarget | null {
    return this._fallback.target
  }

  /** The source cube changed; schedule a refresh. */
  markDirty(): void {
    if (this.mode === 'sky') this._pending = true
    else this._fallback.markDirty()
  }

  /** Call once per frame, after the cube bake. */
  tick(now: number = performance.now()): void {
    if (this.mode === 'sky') {
      if (this._pending) this._bake()
      return
    }
    this._fallback.tick(now)
    if (this._want && !this._probed && this._fallback.target) {
      this._probed = true
      this._setup()
    }
  }

  /** Finish any pending refresh now (screenshots, tests). */
  flush(): void {
    if (this.mode === 'sky') {
      if (this._pending) this._bake()
    } else {
      this._fallback.flush()
    }
  }

  dispose(): void {
    this._disposed = true
    if (this._gpu) for (const r of this._gpu.owned) r.destroy()
    this._gpu = null
    this._fallback.dispose()
  }

  // ---------------------------------------------------------------------

  /** Detect the layout and build every GPU object once; switch over when the pipelines are compiled. */
  private _setup(): void {
    const backend = this._renderer.backend
    if (backend?.isWebGPUBackend !== true) return
    const tex = (this._fallback.target as any)?.texture
    const target = this._fallback.target as any
    const srcGpu = backend.get(this._source)?.texture
    const dstGpu = tex ? backend.get(tex)?.texture : null
    const srcSize: number = srcGpu?.width ?? 0
    const intMip = Math.log2(srcSize / INTEGRATION_SIZE)
    // We build our own source mips (r185 allocates the sky cube without any), so only mip 0 matters.
    const srcOk = srcGpu && Number.isInteger(intMip) && intMip >= 0
    if (!srcOk || !dstGpu || dstGpu.format !== 'rgba16float') return this._unsupported()

    let layout: 'cube' | 'atlas'
    if (tex.isPMREMTexture === true && tex.mipmaps?.length) {
      layout = 'cube'
      if (target.width >> (tex.mipmaps.length - 1) !== 8) return this._unsupported()
    } else if (tex.mapping === CUBEUV_REFLECTION_MAPPING) {
      layout = 'atlas'
      const L = cubeUVLayout(target.height / 4)
      if (target.width !== L.width || target.height !== L.height) return this._unsupported()
    } else {
      return this._unsupported()
    }

    const device = backend.device
    const make = (code: string, constants?: Record<string, number>) =>
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main', constants },
      })
    Promise.all([
      make(DOWNSAMPLE_WGSL),
      make(FIS_WGSL, { MIRROR: 1 }),
      make(INTEG_WGSL),
      make(INTEG_TILED_WGSL),
      layout === 'atlas' ? make(PACK_CUBEUV_WGSL) : null,
    ]).then(
      ([down, fis, integ, tiled, pack]) => {
        if (this._disposed) return
        const pipes = { down, fis, integ, tiled, pack }
        this._gpu =
          layout === 'cube'
            ? buildCube(device, pipes, srcSize, target.width, tex.mipmaps.length - 1, this._quality)
            : buildAtlas(device, pipes, srcSize, target.height / 4, this._quality)
        this.layout = layout
        this.mode = 'sky'
        this._pending = true // re-filter at the next tick in case the sky moved while compiling
      },
      (err: unknown) => console.warn('SkyPmrem: pipeline compile failed; using three’s PMREMGenerator.', err),
    )
  }

  private _unsupported(): void {
    console.warn('SkyPmrem: unexpected PMREM or sky cube layout; using three’s PMREMGenerator.')
  }

  private _bake(): void {
    this._pending = false
    const g = this._gpu!
    const backend = this._renderer.backend
    // Looked up every bake: three may recreate either GPU texture (resize, context loss).
    const srcGpu = backend.get(this._source).texture
    const dstGpu = backend.get((this._fallback.target as any).texture).texture

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
    g.device.queue.submit([encoder.finish()])
  }
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
    usage: TEXTURE_STORAGE_BINDING | TEXTURE_BINDING | TEXTURE_COPY_DST,
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
