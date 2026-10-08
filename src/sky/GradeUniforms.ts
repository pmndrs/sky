import {
  ClampToEdgeWrapping,
  Data3DTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  Matrix3,
  RGBAFormat,
} from 'three/webgpu'

import { uniform } from 'three/tsl'

import { GRADE_AZIMUTH_RES, GRADE_ELEVATION_RES, MAX_GRADE_KEYS } from '../grade'

import type { SkyGrade, SkyGradeBake, SkyGradeEvaluation } from '../grade'

/**
 * GPU side of a sky grade: the two baked tables and the per-sun-position
 * uniforms, shared by the sky mesh and the haze pass.
 *
 * The tables are allocated once at full size (`MAX_GRADE_KEYS` slices) and
 * never swapped or resized: three does not reallocate a resized texture, and
 * a texture node whose `.value` changes after compile is not reliably picked up
 * by the cube bake. Editing a grade rewrites their data in place.
 */
export interface GradeUniforms {
  /** RGB = colorize target × amount, A = amount. */
  colorizeTexture: Data3DTexture
  /** RGB = fill (display-referred), A = gain. */
  fillGainTexture: Data3DTexture
  /** 1 while a grade with keyframes is assigned. `uniform<float>` */
  enabled: any
  /** Depth coordinate between the two keyframes around the sun. `uniform<float>` */
  w: any
  /** Interpolated global operator. `uniform<mat3>` */
  matrix: any
  /** `1 / toneMappingExposure` — the sky mesh's `displayScale`. `uniform<float>` */
  displayScale: any
  /** Float bake, reused between uploads. */
  bake: SkyGradeBake | null
  /** Slices currently holding keyframe data (the rest are identity). */
  uploadedKeys: number
}

const SLICE_TEXELS = GRADE_AZIMUTH_RES * GRADE_ELEVATION_RES
const HALF_ONE = DataUtils.toHalfFloat(1)

function makeTable(name: string, identityAlpha: number): Data3DTexture {
  const data = new Uint16Array(SLICE_TEXELS * MAX_GRADE_KEYS * 4)
  for (let i = 3; i < data.length; i += 4) data[i] = identityAlpha
  const tex = new Data3DTexture(data, GRADE_AZIMUTH_RES, GRADE_ELEVATION_RES, MAX_GRADE_KEYS)
  tex.format = RGBAFormat
  tex.type = HalfFloatType
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.wrapS = ClampToEdgeWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.wrapR = ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.unpackAlignment = 1
  tex.needsUpdate = true
  tex.name = name
  return tex
}

export function createGradeUniforms(displayScale: any = uniform(1)): GradeUniforms {
  return {
    // Identity everywhere: amount 0, gain 1, no fill.
    colorizeTexture: makeTable('SkyGrade.colorize', 0),
    fillGainTexture: makeTable('SkyGrade.fillGain', HALF_ONE),
    enabled: uniform(0),
    w: uniform(0.5 / MAX_GRADE_KEYS),
    matrix: uniform(new Matrix3()),
    displayScale,
    bake: null,
    uploadedKeys: 0,
  }
}

/**
 * Bake `grade` and upload its tables. Only the slices that hold (or held)
 * keyframes are converted to half floats, so a three-keyframe grade converts
 * three slices, not sixteen.
 */
export function uploadGrade(uniforms: GradeUniforms, grade: SkyGrade | null): void {
  const keyCount = grade ? grade.keys.length : 0
  const slices = Math.max(keyCount, uniforms.uploadedKeys)

  if (grade && keyCount > 0) {
    uniforms.bake = grade.bake(uniforms.bake ?? undefined)
  }

  if (slices > 0) {
    const toHalf = DataUtils.toHalfFloat
    const a = uniforms.colorizeTexture.image.data as Uint16Array
    const b = uniforms.fillGainTexture.image.data as Uint16Array
    const end = slices * SLICE_TEXELS * 4
    const bake = uniforms.bake
    for (let o = 0; o < end; o += 4) {
      const inKey = bake && o < keyCount * SLICE_TEXELS * 4
      if (!inKey) {
        a[o] = a[o + 1] = a[o + 2] = a[o + 3] = 0
        b[o] = b[o + 1] = b[o + 2] = 0
        b[o + 3] = HALF_ONE
        continue
      }
      a[o] = toHalf(bake.colorize[o])
      a[o + 1] = toHalf(bake.colorize[o + 1])
      a[o + 2] = toHalf(bake.colorize[o + 2])
      a[o + 3] = toHalf(bake.colorize[o + 3])
      b[o] = toHalf(bake.fillGain[o])
      b[o + 1] = toHalf(bake.fillGain[o + 1])
      b[o + 2] = toHalf(bake.fillGain[o + 2])
      b[o + 3] = toHalf(bake.fillGain[o + 3])
    }
    uniforms.colorizeTexture.needsUpdate = true
    uniforms.fillGainTexture.needsUpdate = true
  }

  uniforms.uploadedKeys = keyCount
  uniforms.enabled.value = keyCount > 0 ? 1 : 0
}

/** Point the uniforms at the sun's place between keyframes. */
export function applyGradeEvaluation(uniforms: GradeUniforms, evaluation: SkyGradeEvaluation): void {
  uniforms.w.value = evaluation.w
  const m = evaluation.matrix
  ;(uniforms.matrix.value as Matrix3).set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8])
}

export function disposeGradeUniforms(uniforms: GradeUniforms): void {
  uniforms.colorizeTexture.dispose()
  uniforms.fillGainTexture.dispose()
}
