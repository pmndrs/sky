import { describe, expect, it } from 'vitest'

import { RenderTarget, Texture, Vector3 } from 'three/webgpu'
import { texture, uniform, uv } from 'three/tsl'

import { Sky } from '../src/Sky'
import { SkyAtmosphereBaker } from '../src/sky/SkyAtmosphereBaker'
import { EARTH } from '../src/core/AtmosphereParams'
import { LUT_RESOLUTIONS, lutTextureSize } from '../src/core/resolutions'
import { createAtmosphereUniforms } from '../src/sky/AtmosphereUniforms'
import { MULTISCATTER_LUT_PIXEL, SKYVIEW_LUT_PIXEL } from '../src/core/wgsl/luts.wgsl'
import { multiScatterLutColorNode, skyViewLutColorNode } from '../src/backends/wgsl/luts'

// Minimal renderer surface for constructing a Sky in node (as in tests/sky.test.ts).
function mockRenderer(): any {
  return {
    compile() {},
    setRenderTarget() {},
    getRenderTarget() {
      return null
    },
    render() {},
    compute() {},
    backend: {},
    hasFeature() {
      return true
    },
  }
}

// The tiers documented in docs/api/sky.mdx (`quality`).
const TIERS = {
  low: {
    transmittance: { width: 128, height: 32 },
    multiScatter: { width: 16, height: 16 },
    skyView: { width: 96, height: 54 },
  },
  medium: {
    transmittance: LUT_RESOLUTIONS.transmittance,
    multiScatter: LUT_RESOLUTIONS.multiScatter,
    skyView: LUT_RESOLUTIONS.skyView,
  },
  high: {
    transmittance: { width: 512, height: 128 },
    multiScatter: { width: 64, height: 64 },
    skyView: { width: 256, height: 144 },
  },
} as const

function lutSizes(baker: SkyAtmosphereBaker) {
  return {
    transmittance: lutTextureSize(baker.transmittanceLUT.texture),
    multiScatter: lutTextureSize(baker.multiScatterLUT.texture),
    skyView: lutTextureSize(baker.skyViewLUT.texture),
  }
}

/** Parameter names of the first `fn name(...)` in a WGSL chunk. */
function wgslParamNames(code: string, name: string): string[] {
  const m = new RegExp(`fn\\s+${name}\\s*\\(([^)]*)\\)`).exec(code)
  if (!m) throw new Error(`no fn ${name}`)
  return [...m[1].matchAll(/(\w+)\s*:/g)].map((p) => p[1])
}

describe('lutTextureSize', () => {
  it('reads a render-target texture, a plain texture and a texture node', () => {
    const rt = new RenderTarget(96, 54)
    expect(lutTextureSize(rt.texture)).toEqual({ width: 96, height: 54 })
    expect(lutTextureSize(new Texture({ width: 16, height: 8 } as any))).toEqual({ width: 16, height: 8 })
    expect(lutTextureSize(texture(rt.texture))).toEqual({ width: 96, height: 54 })
    rt.dispose()
  })

  it('throws instead of guessing when the size is unusable', () => {
    expect(() => lutTextureSize(null)).toThrow(/no usable size/)
    expect(() => lutTextureSize(new Texture())).toThrow(/no usable size/)
    // One texel: the inverse sub-UV map divides by (resolution - 1).
    expect(() => lutTextureSize(new Texture({ width: 1, height: 1 } as any))).toThrow(/no usable size/)
  })
})

describe('quality presets resize every LUT (issue #13)', () => {
  for (const [quality, want] of Object.entries(TIERS)) {
    it(`'${quality}' allocates the tier's sizes, and the consumers read them back`, () => {
      const sky = new Sky(mockRenderer(), { quality })
      const baker = sky.baker
      expect(lutSizes(baker)).toEqual(want)
      // The producers' un-map uses `resolution`; it must be the allocated size.
      expect(baker.multiScatterLUT.resolution).toEqual(want.multiScatter)
      expect(baker.skyViewLUT.resolution).toEqual(want.skyView)
      sky.dispose()
    })
  }

  it('an unknown tier falls back to medium', () => {
    const sky = new Sky(mockRenderer(), { quality: 'ultra' })
    expect(lutSizes(sky.baker)).toEqual(TIERS.medium)
    sky.dispose()
  })

  it('a partial lutResolutions override keeps the other defaults', () => {
    const baker = new SkyAtmosphereBaker(mockRenderer(), { lutResolutions: { skyView: { width: 128, height: 72 } } })
    expect(lutSizes(baker)).toEqual({ ...TIERS.medium, skyView: { width: 128, height: 72 } })
    baker.dispose()
  })
})

describe('WGSL LUT wrappers bind every pixel-shader argument by name', () => {
  // wgslFn binds by name: a key the wrapper forgets only logs "Input not found"
  // and binds 0 — the trap behind CLAUDE.md's "two shader backends" note.
  const params = createAtmosphereUniforms(EARTH)
  const tex = (w: number, h: number) => new RenderTarget(w, h).texture

  it('skyViewLutPixel gets this LUT size and the sampled Multi-Scatter LUT size', () => {
    const node: any = skyViewLutColorNode(
      uv(),
      params,
      tex(64, 16),
      tex(16, 16),
      uniform(new Vector3(0, 0, 1)),
      uniform(6361),
      { width: 96, height: 54 },
    )
    const bound = Object.keys(node.parameters)
    for (const name of wgslParamNames(SKYVIEW_LUT_PIXEL, 'skyViewLutPixel')) expect(bound).toContain(name)
    expect(bound).toContain('lutSize')
    expect(bound).toContain('multiScatterLutSize')
  })

  it('multiScatterLutPixel gets its own LUT size', () => {
    const node: any = multiScatterLutColorNode(uv(), params, tex(64, 16), { width: 16, height: 16 })
    const bound = Object.keys(node.parameters)
    for (const name of wgslParamNames(MULTISCATTER_LUT_PIXEL, 'multiScatterLutPixel')) expect(bound).toContain(name)
    expect(bound).toContain('lutSize')
  })
})
