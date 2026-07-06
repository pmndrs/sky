import { Vector3 } from 'three/webgpu';

/**
 * Earth-default atmosphere parameters used by the Hillaire LUT pipeline (phase 1b+).
 *
 * Phase 1a does not consume these — the legacy Preetham `SkyMesh` owns its own uniforms.
 * The baker still accepts `setAtmosphereParams(partial)` which merges onto `EARTH`,
 * so we expose the full shape now to keep the public API stable across phases.
 *
 * Units: kilometers for radii / altitudes, 1/km for scattering coefficients.
 * Values come from Hillaire 2020 / Bruneton references.
 */
export const EARTH = {
	// Planet / atmosphere geometry (km)
	bottomRadius: 6360.0,
	topRadius: 6460.0,

	// Rayleigh
	rayleighScattering: new Vector3( 0.005802, 0.013558, 0.033100 ), // 1/km
	rayleighDensityExpScale: -1.0 / 8.0, // 1/km, density = exp(scale * altitude)

	// Mie
	mieScattering: new Vector3( 0.003996, 0.003996, 0.003996 ), // 1/km
	mieExtinction: new Vector3( 0.004440, 0.004440, 0.004440 ), // 1/km
	mieAbsorption: new Vector3( 0.000444, 0.000444, 0.000444 ), // extinction - scattering
	miePhaseG: 0.8,
	mieDensityExpScale: -1.0 / 1.2, // 1/km

	// Ozone absorption — Bruneton tent function, two linear segments around ~25 km.
	// Values taken from Unreal's `SetupEarthAtmosphere` (Application/SkyAtmosphereCommon.cpp)
	// which maps to the HLSL `absorption_density` via `GetAtmosphereParameters`.
	absorptionExtinction: new Vector3( 0.000650, 0.001881, 0.000085 ), // 1/km
	absorptionDensity0LayerWidth: 25.0, // km — tent switches segments at this altitude
	absorptionDensity0ConstantTerm: - 2.0 / 3.0,
	absorptionDensity0LinearTerm: 1.0 / 15.0, // 1/km
	absorptionDensity1ConstantTerm: 8.0 / 3.0,
	absorptionDensity1LinearTerm: - 1.0 / 15.0, // 1/km

	// Back-compat aliases — kept so code written against the original shape still reads;
	// the LUT pipeline uses the absorptionDensity* fields above.
	ozoneAbsorption: new Vector3( 0.000650, 0.001881, 0.000085 ),
	ozoneLayerCenterAltitude: 25.0,
	ozoneLayerHalfWidth: 15.0,

	// Ground albedo used by multi-scattering LUT
	groundAlbedo: new Vector3( 0.3, 0.3, 0.3 ),

	// Sun
	sunAngularRadius: 0.004675, // radians (~0.268 deg)
	sunIlluminance: new Vector3( 1.0, 1.0, 1.0 )
};

/**
 * Shallow-ish merge: overwrite scalars, clone Vector3 when provided as plain {x,y,z} or Vector3.
 */
export function mergeAtmosphereParams( base, partial ) {

	const out = { ...base };

	if ( ! partial ) return out;

	for ( const key of Object.keys( partial ) ) {

		const src = partial[ key ];
		const cur = out[ key ];

		if ( cur instanceof Vector3 ) {

			const next = cur.clone();
			if ( src instanceof Vector3 ) next.copy( src );
			else if ( src && typeof src === 'object' ) next.set( src.x ?? next.x, src.y ?? next.y, src.z ?? next.z );
			else if ( Array.isArray( src ) ) next.fromArray( src );
			out[ key ] = next;

		} else {

			out[ key ] = src;

		}

	}

	return out;

}
