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
export function solarPosition( { timeOfDay = 12, dayOfYear = 172, latitude = 0 } = {} ) {

	const deg2rad = Math.PI / 180;
	const rad2deg = 180 / Math.PI;
	const latRad = latitude * deg2rad;

	// Fractional year (radians).
	const gamma = ( 2 * Math.PI / 365 ) * ( dayOfYear - 1 + ( timeOfDay - 12 ) / 24 );

	// Equation of time (minutes).
	const eqtime = 229.18 * (
		0.000075 +
		0.001868 * Math.cos( gamma ) -
		0.032077 * Math.sin( gamma ) -
		0.014615 * Math.cos( 2 * gamma ) -
		0.040849 * Math.sin( 2 * gamma )
	);

	// Solar declination (radians).
	const decl =
		0.006918 -
		0.399912 * Math.cos( gamma ) +
		0.070257 * Math.sin( gamma ) -
		0.006758 * Math.cos( 2 * gamma ) +
		0.000907 * Math.sin( 2 * gamma ) -
		0.002697 * Math.cos( 3 * gamma ) +
		0.00148 * Math.sin( 3 * gamma );

	// True solar time (minutes), assuming local longitude = solar reference.
	// The user feeds local-solar hours, so we just add the equation of time.
	const tst = ( timeOfDay * 60 ) + eqtime;

	// Solar hour angle (degrees → radians). Negative before noon.
	const haDeg = ( tst / 4 ) - 180;
	const ha = haDeg * deg2rad;

	// Solar zenith.
	const cosZenith =
		Math.sin( latRad ) * Math.sin( decl ) +
		Math.cos( latRad ) * Math.cos( decl ) * Math.cos( ha );
	const zenith = Math.acos( Math.max( - 1, Math.min( 1, cosZenith ) ) );
	const elevation = 90 - zenith * rad2deg;

	// Solar azimuth (clockwise from north).
	const cosAz = ( Math.sin( decl ) - Math.sin( latRad ) * Math.cos( zenith ) ) /
		( Math.cos( latRad ) * Math.sin( zenith ) || 1e-9 );
	let azimuth = Math.acos( Math.max( - 1, Math.min( 1, cosAz ) ) ) * rad2deg;
	if ( ha > 0 ) azimuth = 360 - azimuth;

	return { elevation, azimuth };

}
