import type { AtmosphereParams } from './AtmosphereParams'

/** Steps and mid-segment offset of `transmittanceLutPixel` (Hillaire's `RenderTransmittanceLutPS`). */
const SAMPLE_COUNT = 40
const SEGMENT_T = 0.3

/**
 * CPU twin of the Transmittance LUT: the fraction of sunlight, per channel,
 * that reaches a point at `altitudeKm` from a sun whose direction makes
 * `cosZenith` with the local up. No GPU readback, so a light can follow the
 * sky synchronously.
 *
 * Mirrors `transmittanceLutPixel` (`core/wgsl/luts.wgsl.ts`) exactly: the same
 * medium (Rayleigh and Mie exponential profiles, the ozone tent clamped to
 * 0..1), the same 40-step march to the top of the atmosphere with Hillaire's
 * 0.3 segment offset. The GPU LUT stores this on a 256×64 grid and filters
 * bilinearly; this evaluates the exact point, so the two agree to the LUT's
 * half-float precision away from the horizon and to its interpolation error at
 * grazing angles.
 *
 * One deliberate difference: a ray that hits the planet returns 0 (the planet
 * blocks the sun), where the LUT integrates up to the ground. The altitude is
 * clamped to the atmosphere shell `[0, topRadius − bottomRadius]`, as the LUT's
 * UV mapping clamps it.
 *
 * @param altitudeKm  height above the planet surface, km
 * @param cosZenith   cosine between the sun direction and the local up
 * @param params      atmosphere parameters (`baker.atmosphereParams`)
 * @param out         optional `[r, g, b]` to write into
 * @returns `[r, g, b]` transmittance, each in 0..1
 */
export function transmittanceToSun(
  altitudeKm: number,
  cosZenith: number,
  params: AtmosphereParams,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const bottom = params.bottomRadius
  const top = params.topRadius
  const r = Math.min(Math.max(bottom + altitudeKm, bottom), top)
  const mu = Math.min(Math.max(cosZenith, -1), 1)

  if (mu < horizonCosZenith(r, bottom)) {
    out[0] = out[1] = out[2] = 0
    return out
  }

  // From inside the shell the ray always leaves through the top sphere.
  const tMax = Math.max(0, -r * mu + Math.sqrt(Math.max(0, r * r * (mu * mu - 1) + top * top)))
  const sinZ = Math.sqrt(Math.max(0, 1 - mu * mu))

  const { rayleighScattering: ray, mieExtinction: mie, absorptionExtinction: ozo } = params
  let odR = 0
  let odG = 0
  let odB = 0
  let tPrev = 0
  for (let s = 0; s < SAMPLE_COUNT; s++) {
    const t = (tMax * (s + SEGMENT_T)) / SAMPLE_COUNT
    const dt = t - tPrev
    tPrev = t
    // Ray in the plane of the up axis: P = (t·sinZ, r + t·mu).
    const height = Math.hypot(t * sinZ, r + t * mu) - bottom

    const densityMie = Math.exp(params.mieDensityExpScale * height)
    const densityRay = Math.exp(params.rayleighDensityExpScale * height)
    const ozoneTent =
      height < params.absorptionDensity0LayerWidth
        ? params.absorptionDensity0LinearTerm * height + params.absorptionDensity0ConstantTerm
        : params.absorptionDensity1LinearTerm * height + params.absorptionDensity1ConstantTerm
    const densityOzo = Math.min(Math.max(ozoneTent, 0), 1)

    odR += (mie.x * densityMie + ray.x * densityRay + ozo.x * densityOzo) * dt
    odG += (mie.y * densityMie + ray.y * densityRay + ozo.y * densityOzo) * dt
    odB += (mie.z * densityMie + ray.z * densityRay + ozo.z * densityOzo) * dt
  }

  out[0] = Math.exp(-odR)
  out[1] = Math.exp(-odG)
  out[2] = Math.exp(-odB)
  return out
}

/**
 * Cosine of the zenith angle of the planet's geometric horizon, seen from
 * radius `r`: 0 on the ground, negative (the horizon dips) above it.
 */
export function horizonCosZenith(r: number, bottomRadius: number): number {
  const k = bottomRadius / Math.max(r, bottomRadius)
  return -Math.sqrt(Math.max(0, 1 - k * k))
}

/**
 * Fraction of the sun's disc above a horizon: 0 once the whole disc is below
 * it, ½ with the centre on it, 1 once the whole disc is above it. It is the
 * area of the circular segment, so it rises smoothly (zero slope at both ends,
 * like a smoothstep) over one disc diameter.
 *
 * @param elevation       angle of the disc centre above the horizon, radians
 * @param angularRadius   the disc's angular radius, radians
 */
export function sunDiscVisibleFraction(elevation: number, angularRadius: number): number {
  if (!(angularRadius > 0)) return elevation >= 0 ? 1 : 0
  const x = Math.min(Math.max(elevation / angularRadius, -1), 1)
  return (Math.acos(-x) + x * Math.sqrt(1 - x * x)) / Math.PI
}
