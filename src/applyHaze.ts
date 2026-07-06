import { uniform } from 'three/tsl';

import { createHazeOutputNode } from './sky/HazePostProcess.js';

/**
 * Build a haze TSL output node from a `Sky` instance and a scene-color node.
 *
 * Returns a `vec4` node. Caller assigns it (or composes it with bloom etc.)
 * onto their pipeline's outputNode.
 *
 * Vanilla:
 *   const post = new PostProcessing(renderer);
 *   const scenePass = pass(scene, camera);
 *   post.outputNode = applyHaze(scenePass.getTextureNode(), { scenePass, sky });
 *
 * R3F (useRenderPipeline):
 *   useRenderPipeline(({ renderPipeline, passes }) => {
 *     renderPipeline.outputNode = applyHaze(
 *       passes.scenePass.getTextureNode(),
 *       { scenePass: passes.scenePass, sky }
 *     );
 *   });
 *
 * Uniform ownership: this function lazily attaches `hazeStrength`,
 * `hazePolicy`, altitude-blend, and `cameraFar` uniforms onto the supplied
 * `sky` instance. Callers can mutate the haze knobs after the fact via
 * `sky.setHazeStrength(value)` / `sky.setHazePolicy(name)` /
 * `sky.setHazeAltitudeBlend({startKm, endKm})` without rebuilding the
 * pipeline. The build-time `policy` / `strength` / `altitudeBlend` args
 * just seed initial values.
 *
 * @param {THREE.Node} sceneColorNode  scene-color node — typically `scenePass.getTextureNode()`
 * @param {object} options
 * @param {Sky} options.sky                              the `Sky` instance
 * @param {THREE.PassNode} options.scenePass             the `pass(scene, camera)` result
 * @param {'auto'|'ap'|'raymarch'} [options.policy='auto']
 * @param {number} [options.strength=1.0]                multiplies inscatter + AP alpha
 * @param {{startKm:number,endKm:number}} [options.altitudeBlend]   auto-mode altitude blend window
 * @param {boolean} [options.logarithmicDepthBuffer=false]  must match `WebGPURenderer({ logarithmicDepthBuffer })`
 * @param {boolean} [options.useCameraFar]               opt-in to viewZ-based sky detection.
 *   Required for planet-scale demos where `camera.far` is huge (10⁷ m+);
 *   the default linear-depth test fails when geometry compresses into a
 *   thin sliver of [0, 1] near the camera. When enabled the `Sky` lazily
 *   creates a `cameraFar` uniform refreshed each frame in `sky.update`.
 *   Defaults to `true` when `camera.far > 1e6`, else `false`.
 * @param {boolean} [options.includeSkyCubeBlend=false]  legacy shim — see HazePostProcess.js
 * @param {string} [options.debugMode]                   AP debug mode passthrough
 * @returns {THREE.Node} vec4 output node
 */
export function applyHaze( sceneColorNode, {
	sky,
	scenePass,
	policy = 'auto',
	strength = 1.0,
	altitudeBlend,
	logarithmicDepthBuffer = false,
	useCameraFar,
	includeSkyCubeBlend = false,
	debugMode = null
} = {} ) {

	if ( ! sky ) throw new Error( 'applyHaze: `sky` is required.' );
	if ( ! scenePass ) throw new Error( 'applyHaze: `scenePass` is required.' );

	const baker = sky.baker;
	const ap = baker.aerialPerspectiveLUT;

	if ( ! ap ) {

		throw new Error( 'applyHaze: Sky was constructed with `enableAerialPerspective: false`.' );

	}

	// --- Sky-owned uniforms (lazy + reseed on every applyHaze() call) ---
	if ( ! sky._hazeStrength ) sky._hazeStrength = uniform( strength );
	else sky._hazeStrength.value = strength;

	if ( ! sky._hazePolicy ) sky._hazePolicy = uniform( policyToHazeMode( policy ) );
	else sky._hazePolicy.value = policyToHazeMode( policy );

	if ( ! sky._hazeRaymarchOnly ) sky._hazeRaymarchOnly = uniform( policy === 'raymarch' ? 1.0 : 0.0 );
	else sky._hazeRaymarchOnly.value = policy === 'raymarch' ? 1.0 : 0.0;

	const seedStartKm = altitudeBlend?.startKm ?? 50.0;
	const seedEndKm = altitudeBlend?.endKm ?? 100.0;

	if ( ! sky._hazeAltStart ) sky._hazeAltStart = uniform( seedStartKm );
	else if ( altitudeBlend ) sky._hazeAltStart.value = seedStartKm;

	if ( ! sky._hazeAltEnd ) sky._hazeAltEnd = uniform( seedEndKm );
	else if ( altitudeBlend ) sky._hazeAltEnd.value = seedEndKm;

	const seedFar = scenePass.camera?.far ?? 1e6;
	if ( useCameraFar === undefined ) useCameraFar = seedFar > 1e6;
	if ( useCameraFar && ! sky._cameraFar ) sky._cameraFar = uniform( seedFar );

	// `sceneColorNode` is accepted for API symmetry with future operators
	// (bloom-then-haze, etc.). Today's `createHazeOutputNode` reads colour
	// off the scenePass directly; future revisions will accept the node.
	void sceneColorNode;

	return createHazeOutputNode( {
		scenePass,
		aerialPerspectiveTexture: ap.texture,
		luminanceScale: baker.sky.luminanceScale,
		invProjUniform: ap.invProjUniform,
		resZ: ap.resolution?.z ?? ap.resolution?.depth ?? 32,
		kmPerSlice: baker.apKmPerSlice,
		hazeStrength: sky._hazeStrength,
		hazeModeUniform: sky._hazePolicy,
		raymarchBlendStartKm: sky._hazeAltStart,
		raymarchBlendEndKm: sky._hazeAltEnd,
		raymarchOnlyUniform: sky._hazeRaymarchOnly,
		cameraWorldUniform: ap.cameraWorldUniform,
		cameraFarUniform: useCameraFar ? sky._cameraFar : null,
		logarithmicDepthBuffer,
		// Always wire the raymarch path so live policy switching works without
		// rebuild. Users wanting the smaller AP-only shader can call
		// `createHazeOutputNode` directly.
		enableRaymarchFallback: true,
		atmosphereUniforms: baker.atmosphereUniforms,
		sunDirection: baker.sky.sunDirection,
		viewHeightKm: baker.sky.viewHeight,
		// Planet-frame camera position — already updated each frame by
		// AerialPerspectiveLUT.setCamera (called via baker.setCamera). When
		// the user isn't passing `planetCenter`, this defaults to
		// (0, viewHeight, 0) which matches the flat-ground convention.
		cameraPositionKm: ap.cameraPositionKmUniform,
		transmittanceLUT: baker.transmittanceLUT.texture,
		multiScatterLUT: baker.multiScatterLUT.texture,
		skyCube: includeSkyCubeBlend ? baker.texture : null,
		debugMode
	} );

}

function policyToHazeMode( policy ) {

	switch ( policy ) {

		case 'auto': return 0.0;
		case 'ap': return 1.0;
		case 'raymarch': return 2.0;
		default: throw new Error( `applyHaze: unknown policy "${policy}". Use 'auto' | 'ap' | 'raymarch'.` );

	}

}

export { policyToHazeMode };
