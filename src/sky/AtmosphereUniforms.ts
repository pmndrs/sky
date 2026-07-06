import { Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';

/**
 * Build a bundle of TSL `uniform(...)` nodes from a plain AtmosphereParams object.
 *
 * Pass the returned object into any helper that takes `params` — it is the bridge
 * between JS-side parameter state and the shader graphs that consume them. The
 * same bundle is safe to share across multiple LUT shaders; updating a uniform
 * value (via `updateAtmosphereUniforms`) propagates to every shader that reads it
 * without re-building graphs.
 *
 * Field shape mirrors Hillaire's `AtmosphereParameters` struct from
 * `SkyAtmosphereCommon.hlsl`.
 */
export function createAtmosphereUniforms( params ) {

	return {
		// Geometry
		bottomRadius: uniform( params.bottomRadius ),
		topRadius: uniform( params.topRadius ),

		// Rayleigh
		rayleighScattering: uniform( params.rayleighScattering.clone() ),
		rayleighDensityExpScale: uniform( params.rayleighDensityExpScale ),

		// Mie
		mieScattering: uniform( params.mieScattering.clone() ),
		mieExtinction: uniform( params.mieExtinction.clone() ),
		mieAbsorption: uniform( params.mieAbsorption.clone() ),
		mieDensityExpScale: uniform( params.mieDensityExpScale ),
		miePhaseG: uniform( params.miePhaseG ),

		// Ozone absorption (Bruneton tent)
		absorptionExtinction: uniform( params.absorptionExtinction.clone() ),
		absorptionDensity0LayerWidth: uniform( params.absorptionDensity0LayerWidth ),
		absorptionDensity0ConstantTerm: uniform( params.absorptionDensity0ConstantTerm ),
		absorptionDensity0LinearTerm: uniform( params.absorptionDensity0LinearTerm ),
		absorptionDensity1ConstantTerm: uniform( params.absorptionDensity1ConstantTerm ),
		absorptionDensity1LinearTerm: uniform( params.absorptionDensity1LinearTerm ),

		// Ground
		groundAlbedo: uniform( params.groundAlbedo.clone() )
	};

}

/**
 * Copy updated values from a fresh AtmosphereParams object into an existing
 * uniform bundle. Does not rebuild shader graphs — the underlying uniform nodes
 * are reused, so any materials that reference them pick up the new values next
 * time the renderer submits.
 */
export function updateAtmosphereUniforms( uniforms, params ) {

	uniforms.bottomRadius.value = params.bottomRadius;
	uniforms.topRadius.value = params.topRadius;

	copyVec3( uniforms.rayleighScattering.value, params.rayleighScattering );
	uniforms.rayleighDensityExpScale.value = params.rayleighDensityExpScale;

	copyVec3( uniforms.mieScattering.value, params.mieScattering );
	copyVec3( uniforms.mieExtinction.value, params.mieExtinction );
	copyVec3( uniforms.mieAbsorption.value, params.mieAbsorption );
	uniforms.mieDensityExpScale.value = params.mieDensityExpScale;
	uniforms.miePhaseG.value = params.miePhaseG;

	copyVec3( uniforms.absorptionExtinction.value, params.absorptionExtinction );
	uniforms.absorptionDensity0LayerWidth.value = params.absorptionDensity0LayerWidth;
	uniforms.absorptionDensity0ConstantTerm.value = params.absorptionDensity0ConstantTerm;
	uniforms.absorptionDensity0LinearTerm.value = params.absorptionDensity0LinearTerm;
	uniforms.absorptionDensity1ConstantTerm.value = params.absorptionDensity1ConstantTerm;
	uniforms.absorptionDensity1LinearTerm.value = params.absorptionDensity1LinearTerm;

	copyVec3( uniforms.groundAlbedo.value, params.groundAlbedo );

}

function copyVec3( dst, src ) {

	if ( src instanceof Vector3 ) dst.copy( src );
	else if ( Array.isArray( src ) ) dst.fromArray( src );
	else if ( src && typeof src === 'object' ) dst.set( src.x ?? dst.x, src.y ?? dst.y, src.z ?? dst.z );

}
