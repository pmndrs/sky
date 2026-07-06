import {
	Fn,
	uv,
	vec2,
	vec3,
	vec4,
	float,
	sqrt,
	clamp,
	texture3D,
	mix,
	abs,
	max,
	min,
	length,
	If,
	dot,
	fract,
	sin,
	smoothstep,
	normalize as tslNormalize
} from 'three/tsl';

import {
	integrateScatteredLuminance,
	moveToTopAtmosphere,
	raySphereIntersectNearest
} from '../shaders/atmosphere.tsl.js';
import { createHazeDepthNodes } from '../hazeScenePassDepth.js';

/**
 * Debug-only version of the haze post-process node.
 *
 * Keep this separate from `HazePostProcess.js` so raymarch diagnostics can be
 * expanded freely without disturbing the stable examples.
 */
export function createHazeDebugOutputNode( {
	scenePass,
	aerialPerspectiveTexture,
	luminanceScale,
	invProjUniform,
	resZ = 32,
	kmPerSlice = 8.0,
	hazeStrength = null,
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
	raymarchSampleCount = 64,
	raymarchJitterMode = 'uv-hash',
	// Real-time integrator tuning (debug page passes uniforms; all optional).
	raymarchExtEpsUniform = null,
	raymarchSegmentTUniform = null,
	raymarchTMaxScaleUniform = null,
	debugMode = null
} ) {

	if ( enableRaymarchFallback ) {

		const missing = [];
		if ( ! atmosphereUniforms ) missing.push( 'atmosphereUniforms' );
		if ( ! sunDirection ) missing.push( 'sunDirection' );
		if ( ! viewHeightKm && ! cameraPositionKm ) missing.push( 'viewHeightKm or cameraPositionKm' );
		if ( ! transmittanceLUT ) missing.push( 'transmittanceLUT' );
		if ( ! multiScatterLUT ) missing.push( 'multiScatterLUT' );
		if ( ! cameraWorldUniform ) missing.push( 'cameraWorldUniform' );
		if ( missing.length ) {

			throw new Error( 'createHazeDebugOutputNode: enableRaymarchFallback requires ' + missing.join( ', ' ) + '.' );

		}

	}

	const sceneColor = scenePass.getTextureNode( 'output' );
	const { viewZNode, linearDepthNode } = createHazeDepthNodes( scenePass, logarithmicDepthBuffer );
	const coverageKm = kmPerSlice * resZ;
	const rmSampleCount = Math.max( 1, Math.floor( raymarchSampleCount ) );

	return Fn( () => {

		const u = uv();
		const baseColor = sceneColor.sample( u );
		const viewZ = viewZNode;

		//* Shared Reconstruction ===========================================

		const ndc2 = vec2( u.x.mul( 2.0 ).sub( 1.0 ), float( 1.0 ).sub( u.y.mul( 2.0 ) ) );
		const clipFar = vec4( ndc2.x, ndc2.y, float( 1.0 ), float( 1.0 ) );
		const viewFar = invProjUniform.mul( clipFar );
		const rayDirView = viewFar.xyz.div( viewFar.w );
		const cosFromAxis = max( abs( rayDirView.normalize().z ), float( 1e-6 ) );
		const distAlongRayM = abs( viewZ ).div( cosFromAxis );
		const distKm = distAlongRayM.mul( 0.001 );

		const sliceN = distKm.div( float( kmPerSlice ) ).div( float( resZ ) );
		const w = sqrt( clamp( sliceN, float( 0.0 ), float( 1.0 ) ) );
		const ap = texture3D( aerialPerspectiveTexture, vec3( u.x, u.y, w ) ).level( 0 );

		const isSky = cameraFarUniform
			? viewZ.lessThan( cameraFarUniform.mul( - 0.999 ) )
			: linearDepthNode.greaterThan( float( 0.999 ) );

		const beyondCoverage = distKm.greaterThan( float( coverageKm ) );
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
		const forceRaymarch = raymarchOnlyUniform
			? raymarchOnlyUniform.greaterThan( float( 0.5 ) )
			: null;
		const raymarchWeight = forceRaymarch
			? forceRaymarch.select( float( 1.0 ), policyWeight )
			: policyWeight;
		const useRaymarch = raymarchWeight.greaterThan( float( 0.0 ) );

		const hash01 = fract( sin( dot( u, vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) );

		//* Early Input Debugs ==============================================

		if ( debugMode === 'screen-grid' ) return vec4( fract( u.x.mul( 64.0 ) ), fract( u.y.mul( 64.0 ) ), 0.0, 1.0 );
		if ( debugMode === 'rm-dist' ) return vec4( vec3( clamp( distKm.div( 2000.0 ), 0.0, 1.0 ) ), 1.0 );
		if ( debugMode === 'rm-dist-frac' ) return vec4( vec3( fract( distKm.div( 10.0 ) ) ), 1.0 );
		if ( debugMode === 'rm-viewz' ) return vec4( vec3( clamp( abs( viewZ ).div( 2000000.0 ), 0.0, 1.0 ) ), 1.0 );
		if ( debugMode === 'rm-cos' ) return vec4( vec3( cosFromAxis ), 1.0 );
		if ( debugMode === 'rm-hash' ) return vec4( vec3( hash01 ), 1.0 );
		if ( debugMode === 'rm-worlddir' && cameraWorldUniform ) {

			const worldDirRaw = cameraWorldUniform.mul( vec4( rayDirView, float( 0.0 ) ) ).xyz;
			const worldDir = tslNormalize( worldDirRaw );
			return vec4( worldDir.mul( 0.5 ).add( 0.5 ), 1.0 );

		}

		//* Existing AP Debugs ==============================================

		if ( debugMode === 'ap-rgb' ) return vec4( ap.rgb.mul( luminanceScale ).mul( 5.0 ), 1.0 );
		if ( debugMode === 'ap-alpha' ) return vec4( vec3( ap.a ), 1.0 );
		if ( debugMode === 'w' ) return vec4( vec3( w ), 1.0 );
		if ( debugMode === 'is-sky' ) return vec4( vec3( isSky.select( 1.0, 0.0 ) ), 1.0 );
		if ( debugMode === 'beyond' ) return vec4( vec3( beyondCoverage.select( 1.0, 0.0 ) ), 1.0 );
		// Normalized linear depth [0,1]. The sky is a BoxGeometry (12 tris) with a
		// far-plane z=w hack — depth is piecewise per face, so the “space” region
		// looks faceted/triangulated, not noisy depth precision (see `lin-depth-geom`).
		if ( debugMode === 'lin-depth' ) return vec4( vec3( linearDepthNode ), 1.0 );
		// Same as lin-depth but masks sky pixels so only planet/mountains show depth.
		if ( debugMode === 'lin-depth-geom' ) {

			const d = vec3( linearDepthNode );
			const skyCol = vec3( 0.35, 0.0, 0.45 );
			return vec4( isSky.select( skyCol, d ), 1.0 );

		}

		if ( debugMode === 'view-z' && cameraFarUniform ) return vec4( vec3( abs( viewZ ).div( cameraFarUniform ) ), 1.0 );

		//* Stable Composite Baseline =======================================

		const apRgbBase = ap.rgb.mul( luminanceScale );
		const apABase = hazeStrength !== null ? ap.a.mul( hazeStrength ) : ap.a;
		const apRgbBaseScaled = hazeStrength !== null ? apRgbBase.mul( hazeStrength ) : apRgbBase;

		const apA = apABase.toVar();
		const apRgbScaled = apRgbBaseScaled.toVar();

		//* Raymarch Diagnostics ===========================================

		const rmDebugRgb = vec3( 0.0, 0.0, 0.0 ).toVar();
		const rmDebugAlpha = float( 0.0 ).toVar();
		const rmDebugTransmittance = float( 1.0 ).toVar();
		const rmDebugOpticalDepth = float( 0.0 ).toVar();
		const rmDebugTMax = float( 0.0 ).toVar();
		const rmDebugValid = float( 0.0 ).toVar();

		if ( enableRaymarchFallback ) {

			If( useRaymarch, () => {

				const worldDirRaw = cameraWorldUniform.mul( vec4( rayDirView, float( 0.0 ) ) ).xyz;
				const worldDir = tslNormalize( worldDirRaw ).toVar();
				const camPos = cameraPositionKm || vec3( float( 0.0 ), viewHeightKm, float( 0.0 ) );
				const moved = moveToTopAtmosphere( camPos, worldDir, atmosphereUniforms );
				const startPos = moved.newPos.toVar();
				const distKmVar = distKm.toVar();
				// `distKm` from depth; optional uniform scales march length (depth error experiments).
				const distForRm = raymarchTMaxScaleUniform
					? distKmVar.mul( raymarchTMaxScaleUniform )
					: distKmVar;

				// Mirror the integrator's clipping so `rm-tmax` shows the actual
				// marching length, not just the depth-buffer distance request.
				const earthO = vec3( 0.0, 0.0, 0.0 );
				const tBottom = raySphereIntersectNearest( startPos, worldDir, earthO, atmosphereUniforms.bottomRadius );
				const tTop = raySphereIntersectNearest( startPos, worldDir, earthO, atmosphereUniforms.topRadius );
				const tMaxIfNoBottom = tTop.lessThan( 0.0 ).select( float( 0.0 ), tTop );
				const tMaxIfBoth = tTop.greaterThan( 0.0 ).select( tTop.min( tBottom ), tBottom );
				const tMaxClipped = tBottom.lessThan( 0.0 ).select( tMaxIfNoBottom, tMaxIfBoth );
				const rmTMax = min( tMaxClipped, distForRm );

				// Hash breaks coherent banding; with segment-T uniforms, non-hash path uses the uniform.
				const sampleJitter = raymarchJitterMode === 'uv-hash'
					? hash01
					: ( raymarchSegmentTUniform
						? raymarchSegmentTUniform
						: ( raymarchJitterMode === 'center' ? float( 0.5 ) : float( 0.3 ) ) );

				const intArgs = {
					worldPos: startPos,
					worldDir: worldDir,
					sunDir: sunDirection,
					params: atmosphereUniforms,
					transmittanceLUT: transmittanceLUT,
					multiScatterLUT: multiScatterLUT,
					sampleCount: rmSampleCount,
					ground: false,
					mieRayPhase: true,
					tMaxOverride: distForRm,
					sampleJitter
				};
				if ( raymarchExtEpsUniform ) intArgs.extEpsNode = raymarchExtEpsUniform;

				const result = integrateScatteredLuminance( intArgs );

				const validF = moved.valid.select( float( 1.0 ), float( 0.0 ) );
				const rmRgb = result.L.mul( luminanceScale ).mul( validF );
				const rmTransmittance = result.transmittance;
				const rmMeanTransmittance = rmTransmittance.x.add( rmTransmittance.y ).add( rmTransmittance.z ).mul( float( 1.0 / 3.0 ) );
				const rmAlpha = float( 1.0 ).sub( rmMeanTransmittance ).mul( validF );
				const rmMeanOpticalDepth = result.opticalDepth.x.add( result.opticalDepth.y ).add( result.opticalDepth.z ).mul( float( 1.0 / 3.0 ) );

				const rmA = hazeStrength !== null ? rmAlpha.mul( hazeStrength ) : rmAlpha;
				const rmRgbScaled = hazeStrength !== null ? rmRgb.mul( hazeStrength ) : rmRgb;

				apA.assign( mix( apA, rmA, raymarchWeight ) );
				apRgbScaled.assign( mix( apRgbScaled, rmRgbScaled, raymarchWeight ) );
				rmDebugRgb.assign( rmRgbScaled );
				rmDebugAlpha.assign( rmA );
				rmDebugTransmittance.assign( rmMeanTransmittance.mul( validF ) );
				rmDebugOpticalDepth.assign( rmMeanOpticalDepth.mul( validF ) );
				rmDebugTMax.assign( rmTMax.mul( validF ) );
				rmDebugValid.assign( validF );

			} );

		}

		if ( debugMode === 'rm-rgb' ) return vec4( rmDebugRgb.mul( 5.0 ), 1.0 );
		if ( debugMode === 'rm-alpha' ) return vec4( vec3( rmDebugAlpha ), 1.0 );
		if ( debugMode === 'rm-transmittance' ) return vec4( vec3( rmDebugTransmittance ), 1.0 );
		if ( debugMode === 'rm-optical-depth' ) return vec4( vec3( clamp( rmDebugOpticalDepth.mul( 0.25 ), 0.0, 1.0 ) ), 1.0 );
		if ( debugMode === 'rm-optical-depth-frac' ) return vec4( vec3( fract( rmDebugOpticalDepth ) ), 1.0 );
		if ( debugMode === 'rm-tmax' ) return vec4( vec3( clamp( rmDebugTMax.div( 2000.0 ), 0.0, 1.0 ) ), 1.0 );
		if ( debugMode === 'rm-tmax-frac' ) return vec4( vec3( fract( rmDebugTMax.div( 10.0 ) ) ), 1.0 );
		if ( debugMode === 'rm-valid' ) return vec4( vec3( rmDebugValid ), 1.0 );

		const composited = baseColor.rgb.mul( float( 1.0 ).sub( apA ) ).add( apRgbScaled );
		return vec4( mix( composited, baseColor.rgb, isSky.select( 1.0, 0.0 ) ), baseColor.a );

	} )();

}
