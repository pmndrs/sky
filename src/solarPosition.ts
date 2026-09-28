/**
 * NOAA solar-position calculator (simplified).
 *
 * Inputs:
 *   - timeOfDay: 0..24 (local solar hours; pass UTC + offset yourself if you
 *     care about civil time)
 *   - dayOfYear: 1..365
 *   - latitude:  degrees, +N
 *
 * Returns: { elevation, azimuth } in degrees, where azimuth is measured
 * clockwise from geographic north (0 = N, 90 = E, 180 = S, 270 = W).
 *
 * Accuracy is ~0.1° — plenty for visual sky placement. The model does NOT
 * include atmospheric refraction; the real sun is ~0.5° higher than the
 * geometric sun near the horizon, but the renderer's atmospheric scattering
 * makes that visually invisible.
 *
 * Reference: https://gml.noaa.gov/grad/solcalc/solareqns.PDF
 */
export interface SolarPositionOptions {
  timeOfDay?: number
  dayOfYear?: number
  latitude?: number
}

export interface SolarPositionResult {
  elevation: number
  azimuth: number
}

/** NOAA fractional year (radians). */
function fractionalYear(dayOfYear: number, timeOfDay: number) {
  return ((2 * Math.PI) / 365) * (dayOfYear - 1 + (timeOfDay - 12) / 24)
}

/** NOAA equation of time (minutes). */
function equationOfTime(gamma: number) {
  return (
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma))
  )
}

/** Sun's hour angle in degrees for local solar hours (negative before noon). */
function solarHourAngleDeg(timeOfDay: number, dayOfYear: number) {
  // True solar time (minutes), assuming local longitude = solar reference.
  // The user feeds local-solar hours, so we just add the equation of time.
  const tst = timeOfDay * 60 + equationOfTime(fractionalYear(dayOfYear, timeOfDay))
  return tst / 4 - 180
}

export function solarPosition({
  timeOfDay = 12,
  dayOfYear = 172,
  latitude = 0,
}: SolarPositionOptions = {}): SolarPositionResult {
  const deg2rad = Math.PI / 180
  const rad2deg = 180 / Math.PI
  const latRad = latitude * deg2rad

  // Fractional year (radians).
  const gamma = fractionalYear(dayOfYear, timeOfDay)

  // Solar declination (radians).
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma)

  // Solar hour angle (degrees → radians). Negative before noon.
  const ha = solarHourAngleDeg(timeOfDay, dayOfYear) * deg2rad

  // Solar zenith.
  const cosZenith = Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(ha)
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith)))
  const elevation = 90 - zenith * rad2deg

  // Solar azimuth (clockwise from north).
  const cosAz = (Math.sin(decl) - Math.sin(latRad) * Math.cos(zenith)) / (Math.cos(latRad) * Math.sin(zenith) || 1e-9)
  let azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz))) * rad2deg
  if (ha > 0) azimuth = 360 - azimuth

  return { elevation, azimuth }
}

const OBLIQUITY_RAD = 23.439 * (Math.PI / 180)

/**
 * The sun's apparent right ascension and declination (radians), from the
 * low-precision ecliptic model (Astronomical Almanac, ~0.01° over a century)
 * for the same `dayOfYear` / `timeOfDay` inputs as `solarPosition`.
 */
export function solarEquatorial({ timeOfDay = 12, dayOfYear = 172 }: SolarPositionOptions = {}) {
  const deg2rad = Math.PI / 180
  // Days from J2000.0 (2000-01-01 12:00), taking the calendar year as 2000.
  const n = dayOfYear - 1 + (timeOfDay - 12) / 24
  const meanLongitude = (280.46 + 0.9856474 * n) * deg2rad
  const meanAnomaly = (357.528 + 0.9856003 * n) * deg2rad
  const eclipticLongitude = meanLongitude + (1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * deg2rad
  const rightAscension = Math.atan2(Math.cos(OBLIQUITY_RAD) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude))
  const declination = Math.asin(Math.sin(OBLIQUITY_RAD) * Math.sin(eclipticLongitude))
  return { rightAscension, declination }
}

/**
 * Local sidereal time (radians) for the observer `solarPosition` models: the
 * right ascension currently on the meridian. Derived as the sun's right
 * ascension plus the sun's hour angle — the SAME hour angle (equation of time
 * included) `solarPosition` uses, so stars placed with it stay registered to
 * the sun rather than drifting by up to ~4° across the year.
 */
export function localSiderealTime({ timeOfDay = 12, dayOfYear = 172 }: SolarPositionOptions = {}) {
  const hourAngle = solarHourAngleDeg(timeOfDay, dayOfYear) * (Math.PI / 180)
  return solarEquatorial({ timeOfDay, dayOfYear }).rightAscension + hourAngle
}
