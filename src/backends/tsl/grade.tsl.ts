/**
 * TSL node for sky grades (`src/grade.ts`).
 *
 * Samples the baked tables at the view direction and the sun's place between
 * keyframes, then applies the operator documented in `src/grade.ts`:
 *
 *     c1  = max(M · c, 0)
 *     c2  = c1 · (1 − a) + T · avg(c1)
 *     out = c2 · gain + fill · displayScale · fillWeight
 *
 * Linear in `c` up to the clamp, which is why the same node grades the full
 * sky and the aerial-perspective inscatter: haze passes its opacity as
 * `fillWeight`, so a fully hazed surface lands on exactly the graded sky.
 *
 * The table addressing mirrors `gradeAzimuthToU` / `gradeElevationToV`; change
 * them together. Two texture taps and a little ALU.
 */

import { abs, acos, asin, clamp, dot, float, max, sign, sqrt, texture3D, vec3 } from 'three/tsl'

import { GRADE_AZIMUTH_RES, GRADE_ELEVATION_RES } from '../../grade'

import type { GradeUniforms } from '../../sky/GradeUniforms'

export interface ApplyGradeOptions {
  /** Linear colour to grade (post-`luminanceScale`, post-sun-colour). */
  color: any
  /** `dot(viewDir, up)`. */
  viewZenithCosAngle: any
  /** Cosine of the azimuth from the sun (`computeLightViewCosAngle`). */
  lightViewCosAngle: any
  grade: GradeUniforms
  /** Weight on the fill: 1 for sky, the haze opacity for aerial perspective, 0 for none. */
  fillWeight?: any
}

/** Table coordinate for a view direction, at the uniforms' current sun position. */
export function gradeTableUvw(viewZenithCosAngle: any, lightViewCosAngle: any, grade: GradeUniforms): any {
  // Elevation / 90°, square-root packed toward the horizon.
  const e = asin(clamp(viewZenithCosAngle, float(-1.0), float(1.0))).mul(float(2.0 / Math.PI))
  const s = sign(e).mul(sqrt(abs(e)))
  const x = s.add(1.0).mul(0.5)
  const v = x
    .mul(float(GRADE_ELEVATION_RES - 1))
    .add(0.5)
    .div(float(GRADE_ELEVATION_RES))

  const az = acos(clamp(lightViewCosAngle, float(-1.0), float(1.0))).mul(float(1.0 / Math.PI))
  const u = az
    .mul(float(GRADE_AZIMUTH_RES - 1))
    .add(0.5)
    .div(float(GRADE_AZIMUTH_RES))

  return vec3(u, v, grade.w)
}

export function applyGrade({
  color,
  viewZenithCosAngle,
  lightViewCosAngle,
  grade,
  fillWeight = float(1.0),
}: ApplyGradeOptions): any {
  const uvw = gradeTableUvw(viewZenithCosAngle, lightViewCosAngle, grade)
  // level(0): the tables have no mips, and on the haze pass the direction jumps
  // at silhouettes, where implicit derivatives would pick garbage.
  const colorize = texture3D(grade.colorizeTexture, uvw).level(0)
  const fillGain = texture3D(grade.fillGainTexture, uvw).level(0)

  const c1 = max(grade.matrix.mul(color), vec3(0.0))
  const avg = dot(c1, vec3(1.0 / 3.0))
  const c2 = c1.mul(float(1.0).sub(colorize.a)).add(colorize.rgb.mul(avg))
  return c2.mul(fillGain.a).add(fillGain.rgb.mul(grade.displayScale).mul(fillWeight))
}
