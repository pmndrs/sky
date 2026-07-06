import {
	Fn,
	uv,
	vec2,
	vec3,
	vec4,
	float,
	sqrt,
	clamp,
	length,
	texture3D,
	cubeTexture,
	mix,
	abs,
	max,
	If,
	dot,
	fract,
	sin,
	smoothstep,
	normalize as tslNormalize
} from 'three/tsl';

import { integrateScatteredLuminance, moveToTopAtmosphere } from './shaders/atmosphere.tsl.js';
import { createHazeDepthNodes } from './hazeScenePassDepth.js';

/**
 * Build the TSL output node for the Aerial Perspective haze post-process.
 *
 * Per-pixel:
 *   1. Reads the scene's NDC depth.
 *   2. Reconstructs the view-space hit position via the camera inverse projection.
 *   3. Computes distance from camera in km.
 *   4. Maps to AP LUT W axis: `w = sqrt(slice / resZ)` (inverse of the LUT's
 *      squared distribution), where `slice = distKm / kmPerSlice`.
 *   5. Samples the 3D AP LUT (`texture3D`) at `(uv.x, uv.y, w)`.
 *   6. Sky pixels (depth == 1.0) keep their original colour — they're the cube
 *      background, which already contains atmospheric scattering. Geometry
 *      pixels get composited as `sceneColor * (1 - AP.a) + AP.rgb * luminanceScale`.
 *
 * The `luminanceScale` matches `SkyAtmosphereMesh.luminanceScale` (default 40)
 * so haze brightness is consistent with the sky.
 *
 * @param {Object} args
 * @param {THREE.PassNode} args.scenePass - `pass(scene, camera)` result.
 * @param {THREE.Storage3DTexture} args.aerialPerspectiveTexture - the AP LUT 3D texture.
 * @param {THREE.UniformNode<float>} args.luminanceScale - typically the same uniform
 *   the sky mesh uses; pass `baker.sky.luminanceScale` or a wrapped uniform.
 * @param {THREE.UniformNode<mat4>} args.invProjUniform - camera inverse
 *   projection matrix (uniform). Driven by the demo's per-frame setCamera().
 * @param {number} args.resZ - AP LUT Z resolution. Default 32.
 * @param {number} args.kmPerSlice - AP LUT km per slice. Default 4.
 * @param {THREE.UniformNode<float>} [args.hazeStrength] - optional 0..1 multiplier
 *   on the inscatter contribution. Useful as a GUI slider for before/after
 *   comparison without rebuilding the LUT. Default unscaled (1.0).
 * @param {THREE.CubeTexture} [args.skyCube] - optional cube texture (typically
 *   `baker.texture`). When provided, fully-attenuated geometry pixels (heavy
 *   AP alpha) are blended toward the cube's color in their world ray
 *   direction. This closes the AP-coverage / Sky-View boundary mismatch:
 *   without it, a flat ground extending toward the horizon shows AP haze that
 *   stops abruptly at the cube-sky boundary because AP integrates only ~256
 *   km while Sky-View covers the full atmosphere (often 1000+ km of optical
 *   path on grazing rays).
 * @param {THREE.UniformNode<mat4>} [args.cameraWorldUniform] - camera world
 *   matrix. Required when skyCube is provided so we can transform view-space
 *   ray directions into world space for the cube sample. Also required when
 *   `enableRaymarchFallback` is on (raymarch needs Y-up world ray direction).
 *
 * Per-pixel raymarch fallback (planet-scale support):
 *
 * @param {boolean} [args.enableRaymarchFallback=false] - when true, geometry
 *   whose distance from the camera exceeds the AP LUT's coverage cap
 *   (`kmPerSlice * resZ` km) falls back to a per-pixel
 *   `integrateScatteredLuminance` ray-march so the planet surface from
 *   altitude integrates the *actual* atmospheric optical path instead of
 *   being clamped to slice 31 of the LUT. Required for orbit / high-altitude
 *   demos where surface pixels can be 1000+ km away. Below the cap the LUT
 *   is used unchanged.
 *
 *   Requires the following extra inputs to be supplied:
 * @param {object} [args.atmosphereUniforms] - the same uniform bundle that
 *   feeds the rest of the pipeline (`baker.atmosphereUniforms`).
 * @param {THREE.UniformNode<vec3>} [args.sunDirection] - Y-up world-space
 *   sun direction uniform (`baker.sky.sunDirection`).
 * @param {THREE.UniformNode<float>} [args.viewHeightKm] - camera altitude
 *   from planet centre, in km (`baker.sky.viewHeight`). Updated per-frame
 *   via `baker.setCamera()`.
 * @param {THREE.UniformNode<vec3>} [args.cameraPositionKm] - optional true
 *   planet-centred camera position in km. When omitted the legacy
 *   `(0, viewHeightKm, 0)` convention is used.
 * @param {*} [args.transmittanceLUT] - the Transmittance LUT texture node
 *   (`baker.transmittanceLUT.texture`).
 * @param {*} [args.multiScatterLUT] - the Multi-Scatter LUT texture node
 *   (`baker.multiScatterLUT.texture`).
 * @param {THREE.UniformNode<float>} [args.raymarchOnlyUniform] - optional
 *   0/1 float uniform. When set to 1, every geometry pixel goes through
 *   the per-pixel raymarch path instead of the AP LUT — bypassing the
 *   LUT entirely. Useful at orbit altitude where the LUT's
 *   camera-frustum-aligned voxel parameterization breaks down: off-axis
 *   views compress the slice distribution in screen space and start
 *   producing direction-sensitive coverage holes. Mid-term this should
 *   flip on automatically when camera altitude exceeds some threshold;
 *   for now it's a manual toggle so we can A/B. Requires
 *   `enableRaymarchFallback = true`.
 *
 * @param {boolean} [args.logarithmicDepthBuffer=false] - Must match
 *   `WebGPURenderer.logarithmicDepthBuffer`. When true, viewZ/linear depth are
 *   built with `logarithmicDepthToViewZ` (PassNode’s default assumes perspective
 *   depth and breaks haze if this is set wrong).
 * @returns {THREE.Node<vec4>} The output node — feed this to
 *   `RenderPipeline.outputNode = ...` (or the deprecated `PostProcessing`).
 */
export function createHazeOutputNode( {
	scenePass,
	aerialPerspectiveTexture,
	luminanceScale,
	invProjUniform,
	resZ = 32,
	kmPerSlice = 8.0,  // must match AerialPerspectiveLUT default
	hazeStrength = null,
	skyCube = null,
	cameraWorldUniform = null,
	cameraFarUniform = null,
	logarithmicDepthBuffer = false,
	hazeModeUniform = null,
	raymarchBlendStartKm = null,
	raymarchBlendEndKm = null,
	raymarchCoverageBlendKm = null,
	enableRaymarchFallback = false,
	atmosphereUniforms = null,
	sunDirection = null,
	viewHeightKm = null,
	cameraPositionKm = null,
	transmittanceLUT = null,
	multiScatterLUT = null,
	raymarchOnlyUniform = null,
	// Debug modes for bisecting silhouette artefacts. Pass one of:
	// 'ap-rgb'   — AP inscatter colour only (×40 for visibility)
	// 'ap-alpha' — AP alpha (transmittance loss) only as grayscale
	// 'w'        — slice index w as grayscale; sky→1, foreground→0
	// 'is-sky'   — sky mask: white = sky, black = geometry
	// 'beyond'   — past-coverage mask: white = pixel uses raymarch fallback
	// null       — normal compositing
	debugMode = null
} ) {

	if ( skyCube && ! cameraWorldUniform ) {

		throw new Error( 'createHazeOutputNode: cameraWorldUniform is required when skyCube is provided.' );

	}

	if ( enableRaymarchFallback ) {

		const missing = [];
		if ( ! atmosphereUniforms ) missing.push( 'atmosphereUniforms' );
		if ( ! sunDirection ) missing.push( 'sunDirection' );
		if ( ! viewHeightKm && ! cameraPositionKm ) missing.push( 'viewHeightKm or cameraPositionKm' );
		if ( ! transmittanceLUT ) missing.push( 'transmittanceLUT' );
		if ( ! multiScatterLUT ) missing.push( 'multiScatterLUT' );
		if ( ! cameraWorldUniform ) missing.push( 'cameraWorldUniform' );
		if ( missing.length ) {

			throw new Error( 'createHazeOutputNode: enableRaymarchFallback requires ' + missing.join( ', ' ) + '.' );

		}

	}

	const sceneColor = scenePass.getTextureNode( 'output' );
	// `PassNode` uses `perspectiveDepthToViewZ` for `getViewZNode` — correct for
	// default depth, wrong when `logarithmicDepthBuffer` is on; see hazeScenePassDepth.js
	const { viewZNode, linearDepthNode } = createHazeDepthNodes( scenePass, logarithmicDepthBuffer );

	// AP coverage cap in km — the LUT spans [0, kmPerSlice * resZ]. Geometry
	// whose distance-along-ray exceeds this needs the raymarch fallback.
	const coverageKm = kmPerSlice * resZ;

	return Fn( () => {

		const u = uv();
		const baseColor = sceneColor.sample( u );

		// IMPORTANT — distance metric correctness.
		//
		// The AP LUT was BUILT integrating each ray for `tMax` km *along the ray*.
		// We must therefore sample it using *distance along the ray*, NOT |viewZ|.
		// Using |viewZ| (view-space Z component) under-estimates ray length by a
		// factor of `cos(angle from view axis)` — up to ~14% at the corners of a
		// 60° FOV. The visible symptom: silhouettes pop dark when the camera
		// pitches up/down because more pixels move to oblique angles where the
		// AP slice gets sampled too shallow → less haze applied than the sky's
		// full-atmosphere integration → dark fringe at silhouettes.
		//
		// Fix: reconstruct the per-pixel view-space ray direction via inverse
		// projection, then `distAlongRay = |viewZ| / |rayDir.z|`.
		const viewZ = viewZNode;

		// NDC reconstruction. WebGPU clip space is Y-flipped relative to WebGL —
		// so when we hand-build a clip vector from `uv()`, we need ndc.y =
		// 1 - 2*uv.y, NOT 2*uv.y - 1. Getting this wrong produces a vertically
		// mirrored ray direction: looking up at the sky, the haze pass's
		// raymarch fallback would integrate *downward* through the atmosphere
		// instead of upward into space — yielding a second atmospheric
		// gradient that overlays the sky-mesh's correct gradient. (The slice-W
		// distance computation above is unaffected because it only uses the
		// magnitude / cos-from-axis of the ray, both of which are sign-symmetric.)
		const ndc2 = vec2( u.x.mul( 2.0 ).sub( 1.0 ), float( 1.0 ).sub( u.y.mul( 2.0 ) ) );
		const clipFar = vec4( ndc2.x, ndc2.y, float( 1.0 ), float( 1.0 ) );
		const viewFar = invProjUniform.mul( clipFar );
		const rayDirView = viewFar.xyz.div( viewFar.w );
		const cosFromAxis = max( abs( rayDirView.normalize().z ), float( 1e-6 ) );
		const distAlongRayM = abs( viewZ ).div( cosFromAxis );
		const distKm = distAlongRayM.mul( 0.001 );

		// AP LUT W axis: w = sqrt(slice/resZ) where slice = distKm/kmPerSlice.
		const sliceN = distKm.div( float( kmPerSlice ) ).div( float( resZ ) );
		const w = sqrt( clamp( sliceN, float( 0.0 ), float( 1.0 ) ) );

		// IMPORTANT — force level-0 sampling. `texture3D(...)` defaults to
		// derivative-based mip selection. At silhouette pixels the screen-space
		// derivative of `w` is huge (jumps from surface depth to far-plane in
		// one pixel), so the GPU picks a high "mip" level and returns a
		// garbage averaged sample → 1-pixel dark outlines tracing every
		// silhouette. Bypassing derivative-based selection forces the proper
		// trilinear sample at the actual UVW.
		const ap = texture3D( aerialPerspectiveTexture, vec3( u.x, u.y, w ) ).level( 0 );

		// Sky-pixel detection.
		//
		// Default: `linearDepthNode > 0.999` — works for normal `camera.far`
		// values where the depth buffer's normalization gives sky pixels a
		// linearDepth close to 1.0.
		//
		// Override: when `cameraFarUniform` is supplied (planet-scale demos
		// using `far = 20_000_000`), use `viewZ < -0.999 * far` instead. The
		// sky mesh draws with the `z = w` trick → NDC depth = 1 → viewZ at
		// sky pixels equals exactly `-far`. With huge `far`, geometry —
		// including the planet sphere from low altitude — has |viewZ| many
		// orders of magnitude smaller than far, so the test is unambiguous
		// independent of how the depth buffer normalizes. The linearDepth
		// path stops being reliable once geometry compresses into a thin
		// sliver of [0, 1] near the camera.
		const isSky = cameraFarUniform
			? viewZ.lessThan( cameraFarUniform.mul( - 0.999 ) )
			: linearDepthNode.greaterThan( float( 0.999 ) );

		// Past-coverage mask — geometry whose distance exceeds the AP LUT's
		// total range. Used to gate the raymarch fallback and to make the
		// transition visible in `?debug=beyond`.
		const beyondCoverage = distKm.greaterThan( float( coverageKm ) );

		// Haze policy:
		// 0 = auto hybrid, 1 = AP-first, 2 = force raymarch. Default is 1 to
		// preserve older callers unless they explicitly opt into policy blending.
		const hazeMode = hazeModeUniform || float( 1.0 );
		const blendStartKm = raymarchBlendStartKm || float( 50.0 );
		const blendEndKm = max( raymarchBlendEndKm || float( 100.0 ), blendStartKm.add( 0.001 ) );
		const coverageBlendKm = max( raymarchCoverageBlendKm || float( 128.0 ), float( 0.001 ) );
		const cameraAltitudeKm = atmosphereUniforms
			? ( cameraPositionKm
				? length( cameraPositionKm ).sub( atmosphereUniforms.bottomRadius )
				: ( viewHeightKm ? viewHeightKm.sub( atmosphereUniforms.bottomRadius ) : float( 0.0 ) ) )
			: float( 0.0 );
		const altitudeWeight = smoothstep( blendStartKm, blendEndKm, cameraAltitudeKm );
		const coverageWeight = smoothstep( float( coverageKm ).sub( coverageBlendKm ), float( coverageKm ), distKm );
		const autoWeight = max( altitudeWeight, coverageWeight );
		const apWeight = beyondCoverage.select( float( 1.0 ), float( 0.0 ) );
		const isRaymarchMode = hazeMode.greaterThan( float( 1.5 ) );
		const isApMode = hazeMode.greaterThan( float( 0.5 ) ).and( hazeMode.lessThan( float( 1.5 ) ) );
		const policyWeight = isRaymarchMode.select( float( 1.0 ), isApMode.select( apWeight, autoWeight ) );

		// "Force raymarch for every geometry pixel" — manual orbit-altitude
		// override. The AP LUT's voxel parameterization is keyed to the
		// camera's frustum and assumes the camera sits inside the atmosphere
		// with reasonably ground-perpendicular orientation; off-axis views at
		// altitude expose visible coverage holes / direction-sensitive haze.
		// In raymarch-only mode we skip the LUT entirely and integrate every
		// geometry pixel through the same `integrateScatteredLuminance` call
		// the past-coverage branch already uses. See `raymarchOnlyUniform`
		// docs at the top of this file.
		const forceRaymarch = raymarchOnlyUniform
			? raymarchOnlyUniform.greaterThan( float( 0.5 ) )
			: null;
		const raymarchWeight = forceRaymarch
			? forceRaymarch.select( float( 1.0 ), policyWeight )
			: policyWeight;
		const useRaymarch = raymarchWeight.greaterThan( float( 0.0 ) );

		// Debug bisection — JS-side mode select (compiles to one branch).
		if ( debugMode === 'ap-rgb' ) return vec4( ap.rgb.mul( luminanceScale ).mul( 5.0 ), 1.0 );
		if ( debugMode === 'ap-alpha' ) return vec4( vec3( ap.a ), 1.0 );
		if ( debugMode === 'w' ) return vec4( vec3( w ), 1.0 );
		if ( debugMode === 'is-sky' ) return vec4( vec3( isSky.select( 1.0, 0.0 ) ), 1.0 );
		if ( debugMode === 'beyond' ) return vec4( vec3( beyondCoverage.select( 1.0, 0.0 ) ), 1.0 );
		if ( debugMode === 'lin-depth' ) return vec4( vec3( linearDepthNode ), 1.0 );
		if ( debugMode === 'view-z' && cameraFarUniform ) return vec4( vec3( abs( viewZ ).div( cameraFarUniform ) ), 1.0 );

		// --- LUT-based AP composite (close range) ---
		const apRgbBase = ap.rgb.mul( luminanceScale );
		const apABase = hazeStrength !== null ? ap.a.mul( hazeStrength ) : ap.a;
		const apRgbBaseScaled = hazeStrength !== null ? apRgbBase.mul( hazeStrength ) : apRgbBase;

		// Working accumulators. We start from the LUT path and overwrite for
		// past-coverage geometry when raymarch fallback is wired.
		const apA = apABase.toVar();
		const apRgbScaled = apRgbBaseScaled.toVar();

		// Raw raymarch output, exposed as debug. Set inside the raymarch branch
		// when active so adjacent debug modes show meaningful values.
		const rmDebugRgb = vec3( 0.0, 0.0, 0.0 ).toVar();
		const rmDebugAlpha = float( 0.0 ).toVar();

		if ( enableRaymarchFallback ) {

			// Past-coverage branch — integrate atmosphere from camera through
			// the actual surface distance. We feed the integrator
			// `tMaxOverride = distAlongRayKm`, which makes it march exactly the
			// camera→surface segment, clipped against ground/top spheres so
			// rays that punch into the planet still terminate at the surface
			// shell. The result is a real, finite, non-clamped optical-path
			// answer — what slice 31 of the LUT *would* have stored if it
			// extended that far.
			//
			// World-space ray direction = (cameraWorldMatrix · vec4(viewDir, 0)).xyz.
			// Y-up world == atmosphere frame (planet centre at origin, +Y up),
			// so we can use it directly as the integrator's `worldDir`.
			If( useRaymarch, () => {

				const worldDirRaw = cameraWorldUniform.mul( vec4( rayDirView, float( 0.0 ) ) ).xyz;
				const worldDir = tslNormalize( worldDirRaw ).toVar();

				// Camera position in atmosphere frame: planet centre at origin,
				// camera straight up by viewHeight. Horizontal world position
				// is dropped — at planet scale the difference is invisible
				// (atmosphere is symmetric around the centre) and matches the
				// convention the sky mesh's space-view fallback uses.
				const camPos = cameraPositionKm || vec3( float( 0.0 ), viewHeightKm, float( 0.0 ) );
				const moved = moveToTopAtmosphere( camPos, worldDir, atmosphereUniforms );
				const startPos = moved.newPos.toVar();

				const distKmVar = distKm.toVar();

				// Per-pixel hash in [0, 1] — breaks the coherent
				// sample-position alignment that caused horizontal banding
				// in transmittance (visible at 50–105 km altitude in
				// `?debug=rm-alpha`). Cheap one-line hash off uv; not blue
				// noise but good enough to fully scramble the pattern at
				// the resolutions we use. Replaces the canonical fixed
				// `SAMPLE_SEGMENT_T = 0.3` offset with a per-pixel value
				// so adjacent pixels' samples no longer line up at the
				// same altitudes.
				const hash01 = fract( sin( dot( u, vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) );

				const result = integrateScatteredLuminance( {
					worldPos: startPos,
					worldDir: worldDir,
					sunDir: sunDirection,
					params: atmosphereUniforms,
					transmittanceLUT: transmittanceLUT,
					multiScatterLUT: multiScatterLUT,
					// Grazing rays from 50–100 km altitude can integrate over
					// 1000+ km of atmosphere; at 30 samples that's ~33 km/step,
					// which undersamples the TLUT's near-horizon remap and
					// produces visible rings/banding closer to the planet
					// horizon. 64 samples (~16 km/step on a 1000 km ray) cleans
					// it up at modest cost — geometry pixels only, not sky.
					sampleCount: 64,
					ground: false, // we already have the surface in the scene; don't double-count
					mieRayPhase: true,
					tMaxOverride: distKmVar,
					sampleJitter: hash01
				} );

				// Composite identically to the LUT path: rgb = inscatter,
				// alpha = 1 - mean transmittance. integrateScatteredLuminance
				// returns transmittance as a vec3; collapse to a scalar for AP
				// alpha (matches what the AP LUT bake does).
				const validF = moved.valid.select( float( 1.0 ), float( 0.0 ) );
				const rmRgb = result.L.mul( luminanceScale ).mul( validF );
				const rmTransmittance = result.transmittance;
				const rmAlpha = float( 1.0 ).sub(
					rmTransmittance.x.add( rmTransmittance.y ).add( rmTransmittance.z ).mul( float( 1.0 / 3.0 ) )
				).mul( validF );

				const rmA = hazeStrength !== null ? rmAlpha.mul( hazeStrength ) : rmAlpha;
				const rmRgbScaled = hazeStrength !== null ? rmRgb.mul( hazeStrength ) : rmRgb;

				apA.assign( mix( apA, rmA, raymarchWeight ) );
				apRgbScaled.assign( mix( apRgbScaled, rmRgbScaled, raymarchWeight ) );
				rmDebugRgb.assign( rmRgbScaled );
				rmDebugAlpha.assign( rmA );

			} );

		}

		// Raymarch debug modes — useful at altitude when isolating where
		// chunky/banded artefacts originate. `rm-rgb` shows raw inscatter
		// brightness only (no compositing), `rm-alpha` shows the raymarch's
		// transmittance loss as grayscale. Pixels not routed through the
		// raymarch (LUT path, or sky pixels) read black in these modes.
		if ( debugMode === 'rm-rgb' ) return vec4( rmDebugRgb.mul( 5.0 ), 1.0 );
		if ( debugMode === 'rm-alpha' ) return vec4( vec3( rmDebugAlpha ), 1.0 );

		let composited = baseColor.rgb.mul( float( 1.0 ).sub( apA ) ).add( apRgbScaled );

		// Sky-fallback blend: when AP alpha is high (heavy haze along the ray),
		// the surface is fully attenuated and physically *should* show the sky
		// behind it. Without this blend, AP — which only covers ~256 km — gives
		// a different colour than the Sky-View LUT (which integrates the full
		// atmosphere) at the same direction, producing a sharp horizon line.
		// We sample the scene's background cube at the fragment's world ray
		// direction and lerp toward it weighted by `apA` itself: at apA = 0
		// (no haze) the composite is unchanged; at apA = 1 (fully attenuated)
		// the result equals the cube sample. This is mathematically the same
		// transmittance-driven blend, applied a second time against the
		// "sky behind the surface" instead of the surface's own colour.
		if ( skyCube ) {

			// Transform view-space ray direction → world-space ray direction.
			// Use a vec4 with w=0 so translation is ignored (it's a direction).
			const worldDirRaw = cameraWorldUniform.mul( vec4( rayDirView, float( 0.0 ) ) ).xyz;
			const worldDir = tslNormalize( worldDirRaw );
			const skyAtDir = cubeTexture( skyCube, worldDir ).rgb;
			composited = mix( composited, skyAtDir, apA );

		}

		return vec4( mix( composited, baseColor.rgb, isSky.select( 1.0, 0.0 ) ), baseColor.a );

	} )();

}
