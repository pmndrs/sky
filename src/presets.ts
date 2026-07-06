import { Vector3 } from 'three/webgpu';

import { EARTH, mergeAtmosphereParams } from './sky/AtmosphereParams.js';

/**
 * Atmosphere presets. Each preset is a partial `AtmosphereParams` merged onto
 * the Earth defaults. Curated set — fictional looks are produced by tweaking
 * scalars on the chosen base via `Sky({ atmosphere: {...} })` or the
 * top-level `turbidity` / `groundAlbedo` shortcuts.
 *
 * Real-body sources:
 *   - Earth: Hillaire 2020 / Bruneton (already in `EARTH`)
 *   - Mars:  CO2-dominated thin atmosphere; daytime sky butterscotch from
 *     suspended dust (Mie), blue sunsets from forward-scattered Mie. Numbers
 *     tuned to match commonly published renderer references — they are not
 *     scientifically rigorous, but produce a recognisable Mars look.
 *   - Titan: thick orange tholin haze. Real atmosphere extends ~600 km;
 *     clamped here to a renderer-friendly 200 km shell. Heavy Mie, very
 *     forward-scattering, almost no Rayleigh contribution at visible
 *     wavelengths in the lower stack.
 *
 * Coefficients are 1/km. Radii are km.
 */
export const presets = {

	earth: EARTH,

	mars: mergeAtmosphereParams( EARTH, {
		bottomRadius: 3389.5,
		topRadius: 3449.5,                                          // ~60 km shell
		rayleighScattering: new Vector3( 0.0030, 0.0024, 0.0014 ),  // CO2-thin, slightly red-biased
		rayleighDensityExpScale: - 1.0 / 11.0,                       // Mars scale height ~11.1 km
		mieScattering: new Vector3( 0.018, 0.012, 0.006 ),          // dust
		mieExtinction: new Vector3( 0.020, 0.013, 0.007 ),
		mieAbsorption: new Vector3( 0.002, 0.001, 0.001 ),
		miePhaseG: 0.76,                                             // strong forward-scatter
		mieDensityExpScale: - 1.0 / 10.0,
		// Mars has no ozone layer of consequence — zero out the Bruneton tent.
		absorptionExtinction: new Vector3( 0, 0, 0 ),
		ozoneAbsorption: new Vector3( 0, 0, 0 ),
		groundAlbedo: new Vector3( 0.45, 0.30, 0.18 )                // regolith
	} ),

	titan: mergeAtmosphereParams( EARTH, {
		bottomRadius: 2575.0,
		topRadius: 2775.0,                                           // 200 km renderer shell
		rayleighScattering: new Vector3( 0.0008, 0.0010, 0.0014 ),   // negligible at visible
		rayleighDensityExpScale: - 1.0 / 25.0,                       // tall atmosphere
		mieScattering: new Vector3( 0.020, 0.011, 0.004 ),           // tholin orange
		mieExtinction: new Vector3( 0.025, 0.014, 0.006 ),
		mieAbsorption: new Vector3( 0.005, 0.003, 0.002 ),
		miePhaseG: 0.85,                                             // very forward-scattering haze
		mieDensityExpScale: - 1.0 / 40.0,                            // haze layer is high & broad
		absorptionExtinction: new Vector3( 0, 0, 0 ),
		ozoneAbsorption: new Vector3( 0, 0, 0 ),
		groundAlbedo: new Vector3( 0.20, 0.13, 0.06 )
	} )

};

export function resolvePreset( nameOrObject ) {

	if ( typeof nameOrObject === 'string' ) {

		const preset = presets[ nameOrObject ];
		if ( ! preset ) {

			throw new Error( `Unknown sky preset: "${nameOrObject}". Available: ${Object.keys( presets ).join( ', ' )}` );

		}

		return preset;

	}

	return nameOrObject;

}
