import { Vector2, Vector3 } from 'three/webgpu'

import { uniform, uniformArray } from 'three/tsl'

import { MAX_LOOK_STOPS, packLook } from '../looks'

import type { Look, PackedLook } from '../looks'

/**
 * TSL uniform bundle for a stylized look, mirroring `AtmosphereUniforms` in
 * shape and intent.
 *
 * Every field is a uniform, deliberately: changing a look must never rebuild
 * the LUT chain or recompile the node graph, only mark the cube dirty. That is
 * what keeps artist sliders live — see the two-tier split in
 * `research/stylized-ghibli-sky.md`.
 *
 * The three arrays are fixed at `MAX_LOOK_STOPS` and padded by {@link packLook},
 * so stop count changes are just new uniform values.
 */
export interface LookUniforms {
  /** Stop positions (sin elevation). `uniformArray` of float. */
  positions: any
  /** Stop colours, linear. `uniformArray` of vec3. */
  colors: any
  /** Per-stop `(easeExp, easeSmooth)`. `uniformArray` of vec2. */
  eases: any
  chroma: any
  value: any
  intensity: any
  sunTintColor: any
  sunTintFalloff: any
  sunTintStrength: any
  /** Reused packing scratch, so per-frame updates don't allocate. */
  packed: PackedLook
}

export function createLookUniforms(): LookUniforms {
  return {
    positions: uniformArray(new Array(MAX_LOOK_STOPS).fill(0)),
    colors: uniformArray(Array.from({ length: MAX_LOOK_STOPS }, () => new Vector3())),
    eases: uniformArray(Array.from({ length: MAX_LOOK_STOPS }, () => new Vector2(1, 0))),
    // Identity by default: chroma 0 + value 0 returns the physical colour
    // untouched, so a mesh with no look assigned is bit-identical to before.
    chroma: uniform(0),
    value: uniform(0),
    intensity: uniform(1),
    sunTintColor: uniform(new Vector3()),
    sunTintFalloff: uniform(0.3),
    sunTintStrength: uniform(0),
    packed: null as unknown as PackedLook,
  }
}

/**
 * Push a look into its uniform bundle. `UniformArrayNode` has
 * `updateType = RENDER`, so mutating the backing arrays in place is enough —
 * three re-uploads them each render with no `needsUpdate` flag.
 */
export function updateLookUniforms(uniforms: LookUniforms, look: Look): void {
  const packed = packLook(look, uniforms.packed ?? undefined)
  uniforms.packed = packed

  const positions = uniforms.positions.array as number[]
  const colors = uniforms.colors.array as Vector3[]
  const eases = uniforms.eases.array as Vector2[]

  for (let i = 0; i < MAX_LOOK_STOPS; i++) {
    positions[i] = packed.positions[i]
    colors[i].set(packed.colors[i * 3], packed.colors[i * 3 + 1], packed.colors[i * 3 + 2])
    eases[i].set(packed.eases[i * 2], packed.eases[i * 2 + 1])
  }

  uniforms.chroma.value = packed.chroma
  uniforms.value.value = packed.value
  uniforms.intensity.value = packed.intensity
  uniforms.sunTintColor.value.set(packed.sunTintColor[0], packed.sunTintColor[1], packed.sunTintColor[2])
  uniforms.sunTintFalloff.value = packed.sunTintFalloff
  uniforms.sunTintStrength.value = packed.sunTintStrength
}

/** Reset a bundle to the identity transform (physical colour passes through). */
export function clearLookUniforms(uniforms: LookUniforms): void {
  uniforms.chroma.value = 0
  uniforms.value.value = 0
  uniforms.sunTintStrength.value = 0
}
