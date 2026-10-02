/**
 * Where geographic north points in the world: a world axis, or a heading in
 * degrees, turning **clockwise seen from above** (looking down −Y) from +Z.
 * `0` is `'+Z'` (the default), `90` is `'-X'`, `180` is `'-Z'`, `270` is `'+X'`.
 *
 * East is always 90° clockwise from north, as on a map: facing north, east is
 * on your right. With the default `'+Z'` north, east is −X.
 */
export type SkyNorth = '+X' | '-X' | '+Z' | '-Z' | number

/** The axis aliases as headings (degrees clockwise from +Z, seen from above). */
const NORTH_AXES: Record<string, number> = { '+Z': 0, '-X': 90, '-Z': 180, '+X': 270 }

/** Heading in degrees for a `north` value, or `null` if it isn't one. */
export function northHeading(north: SkyNorth): number | null {
  if (typeof north === 'number') return Number.isFinite(north) ? north : null
  return NORTH_AXES[north] ?? null
}

/**
 * The baker's spherical-coordinate theta (degrees, from +Z toward +X — i.e.
 * counter-clockwise seen from above) for a compass azimuth (clockwise from
 * north) under a north heading (clockwise from +Z). Both angles turn
 * clockwise, three's theta turns the other way, hence the sign.
 */
export function compassToTheta(azimuth: number, northHeadingDeg: number) {
  return -(northHeadingDeg + azimuth)
}
