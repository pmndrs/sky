/**
 * Celestial-sphere frames for the night sky.
 *
 *  - equatorial: x = cosδ·cosα, y = sinδ, z = cosδ·sinα  (y = celestial pole)
 *  - world:      three's Y-up scene frame. With north = +Z the horizon basis is
 *                +X east, +Y up, +Z north — the same frame `Sky.setSunDirection`
 *                builds the sun in, so stars and sun stay registered.
 *  - galactic:   x → galactic centre, y → galactic north pole, z → l = 90°
 *                (Cygnus).
 */
import { Matrix3, Matrix4, Vector3 } from 'three/webgpu'

const DEG = Math.PI / 180

/** Unit equatorial vector for right ascension / declination in radians. */
export function equatorialVector(rightAscension: number, declination: number, target = new Vector3()) {
  const c = Math.cos(declination)
  return target.set(c * Math.cos(rightAscension), Math.sin(declination), c * Math.sin(rightAscension))
}

/** Unit equatorial vector for RA in hours and declination in degrees (catalog units). */
export function equatorialDirection(raHours: number, decDegrees: number, target = new Vector3()) {
  return equatorialVector(raHours * 15 * DEG, decDegrees * DEG, target)
}

export interface CelestialOrientationOptions {
  /** Observer latitude, degrees (+N). */
  latitude: number
  /** Local sidereal time, radians — see `localSiderealTime`. */
  siderealTime: number
  /** Rotation of geographic north about +Y, degrees (Sky's `north` axis offset). */
  northOffsetDeg?: number
}

/**
 * Equatorial → world rotation for an observer. Rows are the observer's east,
 * up and north expressed in equatorial coordinates (standard hour-angle
 * transform with H = θ − α), then rotated about +Y so that north lands on the
 * configured north axis.
 */
export function celestialOrientation(
  { latitude, siderealTime, northOffsetDeg = 0 }: CelestialOrientationOptions,
  target = new Matrix4(),
) {
  const sT = Math.sin(siderealTime)
  const cT = Math.cos(siderealTime)
  const sL = Math.sin(latitude * DEG)
  const cL = Math.cos(latitude * DEG)
  // prettier-ignore
  const horizon = new Matrix4().set(
    -sT,      0,  cT,      0, // east
    cL * cT,  sL, cL * sT, 0, // up
    -sL * cT, cL, -sL * sT, 0, // north
    0,        0,  0,       1,
  )
  return target.makeRotationY(northOffsetDeg * DEG).multiply(horizon)
}

// Galactic frame in equatorial coordinates (IAU north galactic pole + centre).
const GAL_Y = equatorialDirection(12.8595, 27.1284)
const GAL_X = (() => {
  const centre = equatorialDirection(17.7611, -29.0078)
  return centre.addScaledVector(GAL_Y, -centre.dot(GAL_Y)).normalize()
})()
const GAL_Z = new Vector3().crossVectors(GAL_X, GAL_Y).normalize()

/** Galactic (l, b) in radians → unit equatorial vector. */
export function galacticToEquatorial(l: number, b: number, target = new Vector3()) {
  const cb = Math.cos(b)
  return target
    .set(0, 0, 0)
    .addScaledVector(GAL_X, cb * Math.cos(l))
    .addScaledVector(GAL_Y, Math.sin(b))
    .addScaledVector(GAL_Z, cb * Math.sin(l))
}

/**
 * World → galactic rotation for an equatorial → world orientation. This is
 * the matrix the sky mesh samples the Milky Way map through.
 */
export function worldToGalactic(orientation: Matrix4, target = new Matrix3()) {
  // prettier-ignore
  const eqToGal = new Matrix3().set(
    GAL_X.x, GAL_X.y, GAL_X.z,
    GAL_Y.x, GAL_Y.y, GAL_Y.z,
    GAL_Z.x, GAL_Z.y, GAL_Z.z,
  )
  const worldToEq = new Matrix3().setFromMatrix4(orientation).transpose()
  return target.multiplyMatrices(eqToGal, worldToEq)
}
