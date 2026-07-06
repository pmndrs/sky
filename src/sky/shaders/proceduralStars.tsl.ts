import {
	Fn,
	float,
	vec2,
	vec3,
	dot,
	floor,
	fract,
	length,
	mix,
	pow,
	sin,
	smoothstep,
	step
} from 'three/tsl';

/**
 * Procedural starfield in TSL — zero asset cost.
 *
 * Tiles the equirect UV into a 400×200 grid (~80k potential star slots over
 * the full sphere); each cell either contains one star (gated by `density`,
 * default 0.3 → ~24k stars) or is empty. Position, size, brightness, and
 * colour temperature are derived from independent 2D hashes of the cell index.
 *
 * Magnitude follows a `pow(h, 2)` curve — a noticeable minority of cells
 * produce visibly bright stars while the majority sit at faint pinpoints,
 * mimicking the visual hierarchy of real night skies (a few "named" bright
 * stars over a dim background).
 *
 * Equirect distortion crowds extra stars near the poles; visually this reads
 * as "more stars overhead and underfoot." Not astronomically accurate — no
 * Milky Way, no constellations, just a stylised sprinkle.
 *
 * @returns {Node<vec3>} linear RGB stars colour, ready to multiply by an
 *   intensity uniform and the per-fragment camera→space transmittance.
 */
export const proceduralStars = /*@__PURE__*/ Fn( ( [ uvNode, densityNode, brightnessScaleNode ] ) => {

	const GRID_U = float( 400.0 );
	const GRID_V = float( 200.0 );

	const scaledUv = vec2( uvNode.x.mul( GRID_U ), uvNode.y.mul( GRID_V ) );
	const cell = floor( scaledUv );
	const local = fract( scaledUv );

	// Five independent hash channels — each with a distinct seed so position,
	// size, brightness, and colour stay decorrelated. (Re-using h2 for both
	// position-Y and colour was the original visible bug — bright stars all
	// landed warm because the same hash drove both.)
	const h0 = _hash21( cell, vec2( 12.9898, 78.233 ) );  // presence
	const h1 = _hash21( cell, vec2( 39.346, 11.135 ) );   // posX
	const h2 = _hash21( cell, vec2( 73.156, 52.235 ) );   // posY
	const h3 = _hash21( cell, vec2( 26.782, 91.453 ) );   // brightness/size
	const h4 = _hash21( cell, vec2( 51.937, 21.118 ) );   // colour temperature

	// Star presence: cells with h0 < density host a star.
	const present = step( h0, densityNode );

	// Star centre within cell; spread away from the cell border so soft
	// edges don't get clipped between cells.
	const margin = float( 0.2 );
	const span = float( 1.0 ).sub( margin.mul( 2.0 ) );
	const centre = vec2(
		margin.add( h1.mul( span ) ),
		margin.add( h2.mul( span ) )
	);

	// Radius — much smaller than v1 so points stay sub-pixel-ish at typical
	// viewport resolutions. Bigger stars are correlated with brightness (real
	// bright stars also occupy more pixels via point-spread).
	const radius = float( 0.012 ).add( h3.mul( 0.025 ) );

	// Soft disc with a tight inner falloff for a true point feel.
	const dist = length( local.sub( centre ) );
	const shape = smoothstep( radius, radius.mul( 0.2 ), dist );

	// Magnitude curve: pow(h3, 2.0) gives a smooth distribution where the
	// brightest ~10% are clearly visible, the next ~30% are faint, and the
	// rest fade to background.
	const magnitude = pow( h3, float( 2.0 ) ).mul( brightnessScaleNode );

	// Colour temperature — independent hash, balanced ramp. Warm (yellow-red
	// giants) and cool (blue O/B stars) both pre-normalised to similar
	// luminance so neither swamps the other.
	const warm = vec3( 1.0, 0.85, 0.65 );
	const cool = vec3( 0.7, 0.85, 1.0 );
	const colour = mix( warm, cool, h4 );

	return colour.mul( shape ).mul( magnitude ).mul( present );

} );

// 2D → scalar hash. `seed` decorrelates output channels when called multiple
// times with the same cell.
function _hash21( p, seed ) {

	const k = dot( p, seed );
	return fract( sin( k ).mul( 43758.5453 ) );

}
