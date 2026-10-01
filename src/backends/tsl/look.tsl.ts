/**
 * TSL node for the stylized "look" layer.
 *
 * Takes a physically-integrated sky colour and remaps it toward an authored
 * ramp, in frame-invariant scalars: `viewZenithCosAngle` (elevation) for the
 * ramp, and `lightViewCosAngle` (sun-relative azimuth), `sunViewCosAngle`
 * (angle to the sun) and `sunZenithCosAngle` (sun elevation) for the sun tint.
 * No renderer state, no texture fetches — pure ALU over uniforms.
 *
 * The same node runs on the sky mesh and on aerial-perspective inscatter, which
 * is what keeps background, cube, PMREM IBL and haze from disagreeing. AP passes
 * `valueScale = 0` so only the scale-invariant chroma axis applies there.
 *
 * The ramp walk is a transliteration of `evaluatePackedRamp` in `src/looks.ts`,
 * which is unit-tested against `sampleLook`, and the sun-tint lobe one of
 * `sunTintWeight`. Change them together.
 */

import { Fn, float, max, mix, pow, saturate, smoothstep, vec3, luminance, Loop } from 'three/tsl'

import { MAX_LOOK_STOPS, RAMP_SPAN_EPSILON, SUN_TINT_CONE_SIN } from '../../looks'

import type { LookUniforms } from '../../sky/LookUniforms'

/** Guards the divisions that pull chromaticity out of a colour. */
const LUMINANCE_EPSILON = float(1e-6)

export interface ApplyLookOptions {
  /** Physical sky colour, post-`luminanceScale`. */
  color: any
  /** `dot(viewDir, up)` — the ramp axis. */
  viewZenithCosAngle: any
  /** Sun-relative azimuth cosine; the sun tint's lobe while the sun is low. */
  lightViewCosAngle: any
  /** `dot(viewDir, sunDir)`; the sun tint's lobe once the sun is up. */
  sunViewCosAngle: any
  /** `dot(sunDir, up)`, sin of the sun elevation; picks between the two. */
  sunZenithCosAngle: any
  look: LookUniforms
  /**
   * Multiplier on the look's `value` axis. Aerial perspective passes 0 to keep
   * the magnitude its own partial-path integral produced; the sky mesh leaves
   * it at 1.
   */
  valueScale?: any
}

/**
 * Evaluate the authored ramp at `at` (sin elevation), before the sun tint and
 * before `intensity`.
 *
 * Walks all `MAX_LOOK_STOPS` segments unconditionally and accumulates: each
 * either leaves the colour alone, completes it, or blends. Padded slots are
 * zero-width, so `RAMP_SPAN_EPSILON` turns them into steps that always resolve
 * to a colour already held. No `stopCount`, no branch, constant cost.
 */
export const evaluateLookRamp = /*@__PURE__*/ Fn(([at, positions, colors, eases]: any) => {
  const color = vec3(colors.element(0)).toVar()

  Loop({ start: 1, end: MAX_LOOK_STOPS, type: 'int' }, ({ i }: any) => {
    const aAt = positions.element(i.sub(1))
    const bAt = positions.element(i)
    const span = max(bAt.sub(aAt), float(RAMP_SPAN_EPSILON))
    const raw = saturate(at.sub(aAt).div(span))

    // (easeExp, easeSmooth) — mirrors `applyEase`. pow(t, 1) is the identity,
    // so 'linear' needs no special case here.
    const ease = eases.element(i)
    const t = mix(pow(raw, ease.x), smoothstep(float(0.0), float(1.0), raw), ease.y)

    color.assign(mix(color, colors.element(i), t))
  })

  return color
})

/**
 * Apply a look to a physically-integrated colour.
 *
 * Splits both sides into chromaticity-at-unit-luminance and luminance, blends
 * them on independent axes, and recombines:
 *
 *   chromaP = physical / L(physical)      chromaR = ramp / L(ramp)
 *   out     = mix(chromaP, chromaR, chroma) * mix(L(physical), L(ramp), value)
 *
 * Because `luminance(chromaX) == 1`, the result's luminance is exactly the
 * blended luminance — the two axes never fight. With `chroma = 0, value = 0`
 * this is the identity, so an unassigned look costs correctness nothing.
 *
 * Where the physical colour is black (night), it carries no chromaticity to
 * blend from, so `chromaP` falls back to the ramp's. That is what lets the
 * `value` axis light an artificial moonlit sky out of a physically ~zero one
 * instead of scaling black by a constant.
 */
export function applyLook({
  color,
  viewZenithCosAngle,
  lightViewCosAngle,
  sunViewCosAngle,
  sunZenithCosAngle,
  look,
  valueScale = float(1.0),
}: ApplyLookOptions): any {
  const ramp = evaluateLookRamp(viewZenithCosAngle, look.positions, look.colors, look.eases).toVar()

  // Sun-relative tint lobe (`sunTintWeight` in looks.ts). A low sun takes the
  // azimuth cosine: the whole sunward side of the sky warms, the twilight band.
  // That wedge ignores elevation, so as the sun climbs it would flood a
  // full-height strip from the horizon to the zenith; by SUN_TINT_CONE_SIN the
  // lobe is the true angle to the sun instead, a glow around it. The two agree
  // along the horizon at sunset, so the blend leaves sunset alone. `falloff` is
  // inverted into an exponent, so larger falloff is a broader lobe. Rays facing
  // away from the sun clamp to zero.
  const coneBlend = smoothstep(float(0.0), float(SUN_TINT_CONE_SIN), sunZenithCosAngle)
  const sunFacing = saturate(mix(lightViewCosAngle, sunViewCosAngle, coneBlend))
  const sunWeight = pow(sunFacing, float(1.0).div(max(look.sunTintFalloff, LUMINANCE_EPSILON))).mul(
    look.sunTintStrength,
  )
  ramp.assign(mix(ramp, look.sunTintColor, sunWeight))

  // Display-referred: `displayScale` is 1 / toneMappingExposure, so at
  // `intensity: 1` the ramp enters the tonemapper at its authored value and a
  // `value: 1` look shows the authored colours (exactly, under Neutral or no
  // tonemapping; ACES/AgX add their own contrast). Independent of the sky's
  // `luminanceScale` on purpose — an authored palette should not drift when
  // the physical exposure is tuned.
  const rampScene = ramp.mul(look.intensity).mul(look.displayScale)

  const physicalL = luminance(color)
  const rampL = luminance(rampScene)

  const chromaRamp = rampScene.div(max(rampL, LUMINANCE_EPSILON))
  const chromaPhysical = physicalL
    .greaterThan(LUMINANCE_EPSILON)
    .select(color.div(max(physicalL, LUMINANCE_EPSILON)), chromaRamp)

  const outChroma = mix(chromaPhysical, chromaRamp, look.chroma)
  const outLuminance = mix(physicalL, rampL, look.value.mul(valueScale))

  return outChroma.mul(outLuminance)
}
