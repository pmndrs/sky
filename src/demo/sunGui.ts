import { EARTH } from '../sky/AtmosphereParams.js';

/**
 * Phase 1a GUI — written for the Preetham `SkyMesh`. Pokes its per-mesh
 * uniforms (turbidity, rayleigh, mieCoefficient, mieDirectionalG) plus the
 * shared elevation/azimuth/exposure controls.
 *
 * The per-mesh pokes are guarded so this GUI can still be wired to a Hillaire
 * baker without throwing — the Preetham-specific sliders become inert in that
 * case, but elevation / azimuth / exposure still drive the baker correctly.
 */
export function createSunGui( { renderer, baker, scene } ) {

	const state = {
		turbidity: 10,
		rayleigh: 3,
		mieCoefficient: 0.005,
		mieDirectionalG: 0.7,
		elevation: 15,
		azimuth: 180,
		exposure: renderer.toneMappingExposure
	};

	function apply() {

		const sky = baker.sky;
		// Preetham-only uniforms — guarded so the same GUI can be attached to a
		// Hillaire baker without throwing (sliders become inert in that case).
		if ( sky.turbidity ) sky.turbidity.value = state.turbidity;
		if ( sky.rayleigh ) sky.rayleigh.value = state.rayleigh;
		if ( sky.mieCoefficient ) sky.mieCoefficient.value = state.mieCoefficient;
		if ( sky.mieDirectionalG ) sky.mieDirectionalG.value = state.mieDirectionalG;

		baker.setSun( { elevation: state.elevation, azimuth: state.azimuth } );

		renderer.toneMappingExposure = state.exposure;

		// Any slider change means the cube bake is stale
		baker.markCubeDirty();

		// Rebind background/environment in case PMREM target instance changed
		if ( scene ) {

			scene.background = baker.texture;
			// environment will be refreshed on next update(); expose a hook for main loop to re-set

		}

	}

	const gui = renderer.inspector.createParameters( 'Sky' );

	gui.add( state, 'turbidity', 0.0, 20.0, 0.1 ).onChange( apply );
	gui.add( state, 'rayleigh', 0.0, 4.0, 0.001 ).onChange( apply );
	gui.add( state, 'mieCoefficient', 0.0, 0.1, 0.001 ).onChange( apply );
	gui.add( state, 'mieDirectionalG', 0.0, 1.0, 0.001 ).onChange( apply );
	gui.add( state, 'elevation', 0, 90, 0.1 ).onChange( apply );
	gui.add( state, 'azimuth', - 180, 180, 0.1 ).onChange( apply );
	gui.add( state, 'exposure', 0, 1, 0.0001 ).onChange( apply );

	// Apply initial state so the baker has a sun vector on first update()
	apply();

	return { state, apply };

}

/**
 * Phase 1b GUI — wires sliders to the Hillaire pipeline via
 * `baker.setAtmosphereParams`. Does not poke Preetham uniforms.
 *
 * Sliders:
 *   - elevation, azimuth      — sun direction (degrees)
 *   - exposure                — renderer.toneMappingExposure
 *   - rayleighScale           — multiplier on `rayleighScattering` (1/km)
 *   - mieScale                — multiplier on `mieScattering`, `mieExtinction`,
 *                               and `mieAbsorption` (1/km). Kept coherent so
 *                               turning off Mie doesn't leave absorption on.
 *
 * The "scale" sliders multiply against the *EARTH* defaults, not the most
 * recent value, so moving a slider from 1→0→1 restores the original.
 */
export function createAtmosphereGui( { renderer, baker, scene } ) {

	const state = {
		elevation: 15,
		azimuth: 180,
		exposure: renderer.toneMappingExposure,
		rayleighScale: 1.0,
		mieScale: 1.0
	};

	function apply() {

		baker.setSun( { elevation: state.elevation, azimuth: state.azimuth } );

		baker.setAtmosphereParams( {
			rayleighScattering: EARTH.rayleighScattering.clone().multiplyScalar( state.rayleighScale ),
			mieScattering: EARTH.mieScattering.clone().multiplyScalar( state.mieScale ),
			mieExtinction: EARTH.mieExtinction.clone().multiplyScalar( state.mieScale ),
			mieAbsorption: EARTH.mieAbsorption.clone().multiplyScalar( state.mieScale )
		} );

		renderer.toneMappingExposure = state.exposure;

		baker.markCubeDirty();

		if ( scene ) {

			scene.background = baker.texture;

		}

	}

	const gui = renderer.inspector.createParameters( 'Atmosphere' );

	gui.add( state, 'elevation', - 5, 90, 0.1 ).onChange( apply );
	gui.add( state, 'azimuth', - 180, 180, 0.1 ).onChange( apply );
	gui.add( state, 'exposure', 0, 2, 0.001 ).onChange( apply );
	gui.add( state, 'rayleighScale', 0, 4, 0.01 ).onChange( apply );
	gui.add( state, 'mieScale', 0, 4, 0.01 ).onChange( apply );

	apply();

	return { state, apply };

}
