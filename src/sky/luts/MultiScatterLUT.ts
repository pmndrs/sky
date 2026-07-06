import {
	RenderTarget,
	HalfFloatType,
	LinearFilter,
	ClampToEdgeWrapping,
	NodeMaterial,
	QuadMesh,
	RendererUtils
} from 'three/webgpu';
import {
	Fn,
	Loop,
	uv,
	vec2,
	vec3,
	vec4,
	float,
	floor,
	dot,
	length,
	exp,
	PI,
	sqrt,
	saturate,
	max,
	select,
	texture,
	normalize
} from 'three/tsl';

import {
	getSphericalDir,
	raySphereIntersectNearest,
	computeScatteringAbsorption,
	transmittanceLutParamsToUv
} from '../shaders/atmosphere.tsl.js';
import { LUT_RESOLUTIONS } from './resolutions.js';

const _quadMesh = /*@__PURE__*/ new QuadMesh();
let _rendererState;

// Match RenderSkyRayMarching.hlsl:448. 8x8 stratified samples -> 64 directions.
const SQRT_SAMPLE_COUNT = 8;
// HLSL uses 20 ray-march steps for the MS LUT (line 438). A minimum set is
// required for accuracy.
const RAYMARCH_SAMPLE_COUNT = 20;

/**
 * Hillaire Multiple-Scattering LUT.
 *
 * 32×32 RGBA16F. Parameterised by (cosSunZenith, viewHeight). Each texel
 * integrates over 64 stratified spherical directions, for each direction
 * ray-marches 20 steps through the atmosphere reading the Transmittance LUT,
 * then finalises via Hillaire's closed-form geometric-series sum
 *   L_psi_ms = L_2ndOrder / (1 − f_ms)
 * where `f_ms` is the atmosphere's "if every bounce were uniform-phase"
 * transfer factor (the `MultiScatAs1` field in the reference code).
 *
 * Port of `NewMultiScattCS` from RenderSkyRayMarching.hlsl:418-537. The Unreal
 * reference uses a compute shader with 64 threads per pixel + groupshared
 * reduction; we flatten the reduction into a per-pixel nested loop because
 * we chose a fragment pipeline in PLAN.md. Output is identical modulo
 * floating-point associativity.
 *
 * Finalisation math:
 *   Equation 5 (Hillaire 2020):  L_2ndOrder = Σ_directions L * 4π / N  · (1/4π)
 *   Equation 7:                  f_ms       = Σ_directions MSA · 4π / N  · (1/4π)
 *   Equation 10:                 L          = L_2ndOrder · 1/(1 − f_ms)
 * The `4π / N` is the per-sample solid-angle weight; the outer `1/(4π)` is
 * the isotropic phase. Algebraically the 4π cancels with 1/(4π), so the sum
 * reduces to `(1/N) Σ …`. We keep the factored form to match the HLSL
 * line-for-line.
 */
export class MultiScatterLUT {

	constructor( renderer, {
		resolution = LUT_RESOLUTIONS.multiScatter,
		atmosphereUniforms,
		transmittanceLUT,
		debugMode = null
	} = {} ) {

		if ( ! atmosphereUniforms ) throw new Error( 'MultiScatterLUT: atmosphereUniforms is required' );
		if ( ! transmittanceLUT ) throw new Error( 'MultiScatterLUT: transmittanceLUT is required' );

		this.renderer = renderer;
		this.resolution = { ...resolution };
		this.atmosphereUniforms = atmosphereUniforms;
		this.transmittanceLUT = transmittanceLUT;
		this.debugMode = debugMode;

		this.renderTarget = new RenderTarget( resolution.width, resolution.height, {
			type: HalfFloatType,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			wrapS: ClampToEdgeWrapping,
			wrapT: ClampToEdgeWrapping,
			generateMipmaps: false,
			depthBuffer: false
		} );
		this.renderTarget.texture.name = 'MultiScatterLUT';

		this.material = new NodeMaterial();
		this.material.name = 'MultiScatterLUT';
		this.material.colorNode = this._buildColorNode();

	}

	get texture() {

		return this.renderTarget.texture;

	}

	_buildColorNode() {

		const params = this.atmosphereUniforms;
		const transmittanceTex = this.transmittanceLUT.texture;
		const lutWidth = this.resolution.width;
		const lutHeight = this.resolution.height;
		const debugMode = this.debugMode;

		return Fn( () => {

			// HLSL:421-424 — remap [0,1] UV to its "sub-uv" corrected form so
			// the first/last texel centres land exactly on the boundary values
			// (0 and 1) after bilinear filtering. fromSubUvsToUnit(u, N) =
			// (u - 0.5/N) * (N / (N - 1)).
			const rawUv = uv();
			const corrU = rawUv.x.sub( float( 0.5 / lutWidth ) ).mul( float( lutWidth / ( lutWidth - 1 ) ) );
			const corrV = rawUv.y.sub( float( 0.5 / lutHeight ) ).mul( float( lutHeight / ( lutHeight - 1 ) ) );

			// --- DEBUG BISECTION ---
			// 'uv'          : raw UV. Proves the shader runs + sees its UV.
			// 'params'      : cosSunZenith in R, viewHeight fraction in G. Proves
			//                 the parameterization un-map works.
			// 'trans-sample': sample the Transmittance LUT from inside this shader
			//                 at the un-mapped (cosSunZenith, viewHeight) point —
			//                 proves cross-texture sampling works here.
			// 'first-dir'   : worldDir for (i=0, j=0). Proves getSphericalDir works.
			// 'loop-count'  : outer Loop runs 64 times and each iter adds 1/64 to R.
			//                 Final R should be ~1.0 → yellow-green. If R=0, Loop
			//                 isn't executing.
			// 'inner-loop'  : inner ray-march Loop runs 20 times per pixel (outer
			//                 loop disabled). R accumulates 1/20 each iter → 1.
			// 'totalL-raw'  : the pre-finalization sum (skips geometric-series).
			// null          : normal output.
			if ( debugMode === 'uv' ) return vec4( rawUv.x, rawUv.y, 0.0, 1.0 );
			if ( debugMode === 'params' ) {

				const cSZ = corrU.mul( 2.0 ).sub( 1.0 ).mul( 0.5 ).add( 0.5 );
				return vec4( cSZ, corrV, 0.0, 1.0 );

			}

			// HLSL:428 — cosSunZenith = uv.x*2 - 1, sun placed in the YZ plane
			// with Z up (matches the HLSL's +Z-up convention for *this* LUT).
			// The TransmittanceLUT/SkyView LUT later use Y-up; that's fine —
			// the MS LUT is frame-independent: we're just choosing *some*
			// consistent axis so samples map to the same (cosSunZenith, altitude)
			// point across shaders.
			const cosSunZenith = corrU.mul( 2.0 ).sub( 1.0 );
			const sunDir = vec3(
				float( 0.0 ),
				sqrt( saturate( float( 1.0 ).sub( cosSunZenith.mul( cosSunZenith ) ) ) ),
				cosSunZenith
			);

			// HLSL:431 — viewHeight = Bottom + saturate(v + PLANET_RADIUS_OFFSET) * (Top-Bottom-PLANET_RADIUS_OFFSET)
			// The saturate+offset trick keeps the first texel strictly above the
			// ground (otherwise `pHeight` would equal `bottomRadius` and the
			// altitude lookup would land exactly at height=0, which is fine, but
			// the ground-ray intersection becomes degenerate). PLANET_RADIUS_OFFSET
			// is 0.01 (km) — the same constant used elsewhere.
			const PRO = float( 0.01 );
			const atmosphereThickness = params.topRadius.sub( params.bottomRadius ).sub( PRO );
			const viewHeight = params.bottomRadius.add(
				saturate( corrV.add( PRO ) ).mul( atmosphereThickness )
			);

			const worldPos = vec3( float( 0.0 ), float( 0.0 ), viewHeight );

			// More debug modes that need viewHeight / cosSunZenith:
			if ( debugMode === 'trans-sample' ) {

				// Sample Transmittance LUT at (cosSunZenith-like, corrV-like) — NOT
				// through the real Bruneton un-map (that'd put us outside the LUT).
				// Just a simple linear mapping to prove cross-texture sampling here.
				const sampleUv = vec2( corrU, corrV );
				return vec4( texture( transmittanceTex, sampleUv ).rgb, 1.0 );

			}
			if ( debugMode === 'first-dir' ) {

				const sqrtN_ = float( SQRT_SAMPLE_COUNT );
				const dir = getSphericalDir( float( 0.5 ), float( 0.5 ), sqrtN_ );
				return vec4( dir.mul( 0.5 ).add( 0.5 ), 1.0 );

			}

			// Accumulate L and MultiScatAs1 across 64 stratified spherical
			// directions. See HLSL:448-469. We mirror the HLSL's (i, j) indexing
			// exactly: i = 0.5 + ThreadId.z/N, j = 0.5 + (ThreadId.z mod N) — but
			// since we are in a fragment (no thread id), we loop over both.
			const sqrtN = float( SQRT_SAMPLE_COUNT );
			const sphereSolidAngle = float( 4.0 ).mul( PI );
			const sampleWeight = sphereSolidAngle.div( sqrtN.mul( sqrtN ) );
			// = 4π / 64. Each spherical sample contributes this times its result.

			const totalL = vec3( 0.0, 0.0, 0.0 ).toVar();
			const totalMSA = vec3( 0.0, 0.0, 0.0 ).toVar();

			// Integrator accumulators — declared OUTSIDE the outer Loop so
			// their `.toVar()` decls live at shader scope, but explicitly
			// `.assign(...)` to their reset values INSIDE each outer iteration
			// so every direction starts fresh. This is the lesson learned from
			// the previous "call a plain JS function inside a Loop" approach:
			// the inner accumulators' init-to-zero was ambiguously scoped and
			// state bled across directions (throughput decayed to 0 on the
			// first direction and every subsequent direction contributed
			// nothing → LUT output was all black).
			const L = vec3( 0.0, 0.0, 0.0 ).toVar();
			const throughput = vec3( 1.0, 1.0, 1.0 ).toVar();
			const multiScatAs1 = vec3( 0.0, 0.0, 0.0 ).toVar();
			const tPrev = float( 0.0 ).toVar();
			const tMax = float( 0.0 ).toVar();

			const earthO = vec3( 0.0, 0.0, 0.0 );
			const SAMPLE_SEGMENT_T = 0.3;
			const PRO_BIAS = float( 0.01 ); // matches PLANET_RADIUS_OFFSET
			const extEps = float( 1e-6 );
			const uniformPhase = float( 1.0 ).div( float( 4.0 ).mul( PI ) );

			// Loop-counter test: just count iterations. If R ≈ 1 when done,
			// the outer Loop executed 64 times. If R = 0, Loop didn't run.
			if ( debugMode === 'loop-count' ) {

				const counter = float( 0.0 ).toVar();
				Loop( { start: 0, end: SQRT_SAMPLE_COUNT * SQRT_SAMPLE_COUNT, type: 'int' }, () => {

					counter.addAssign( float( 1.0 / ( SQRT_SAMPLE_COUNT * SQRT_SAMPLE_COUNT ) ) );

				} );
				return vec4( counter, 0.0, 0.0, 1.0 );

			}

			// Inner-loop counter test: one pixel = one inner ray-march loop.
			// R should accumulate to 1.0 over 20 steps.
			if ( debugMode === 'inner-loop' ) {

				const counter = float( 0.0 ).toVar();
				Loop( { start: 0, end: RAYMARCH_SAMPLE_COUNT, type: 'int' }, () => {

					counter.addAssign( float( 1.0 / RAYMARCH_SAMPLE_COUNT ) );

				} );
				return vec4( counter, 0.0, 0.0, 1.0 );

			}
			// Same structure as inner-loop but with literal 20 directly (not the
			// imported const) — rules out any weirdness around the constant.
			if ( debugMode === 'lit-20' ) {

				const counter = float( 0.0 ).toVar();
				Loop( { start: 0, end: 20, type: 'int' }, () => {

					counter.addAssign( float( 0.05 ) );

				} );
				return vec4( counter, 0.0, 0.0, 1.0 );

			}
			// Minimal TSL Loop using the bare form — no options object.
			if ( debugMode === 'loop-simple' ) {

				const counter = float( 0.0 ).toVar();
				Loop( 20, () => {

					counter.addAssign( float( 0.05 ) );

				} );
				return vec4( counter, 0.0, 0.0, 1.0 );

			}
			// Nested loop like the real integrator: 2 outer × 5 inner = 10 adds of 0.1.
			if ( debugMode === 'nested' ) {

				const counter = float( 0.0 ).toVar();
				Loop( 2, () => {

					Loop( 5, () => {

						counter.addAssign( float( 0.1 ) );

					} );

				} );
				return vec4( counter, 0.0, 0.0, 1.0 );

			}

			// 8×8 stratified sphere sampling flattened to a single on-GPU Loop
			// of 64 iterations. See RenderSkyRayMarching.hlsl:448-469.
			Loop( { start: 0, end: SQRT_SAMPLE_COUNT * SQRT_SAMPLE_COUNT, type: 'int' }, ( { i: idx } ) => {

				const idxF = float( idx );
				const iF = floor( idxF.div( sqrtN ) );
				const jF = idxF.sub( iF.mul( sqrtN ) );
				const iPlusHalf = iF.add( float( 0.5 ) );
				const jPlusHalf = jF.add( float( 0.5 ) );
				const worldDir = getSphericalDir( iPlusHalf, jPlusHalf, sqrtN );

				// Reset accumulators for this direction.
				L.assign( vec3( 0.0, 0.0, 0.0 ) );
				throughput.assign( vec3( 1.0, 1.0, 1.0 ) );
				multiScatAs1.assign( vec3( 0.0, 0.0, 0.0 ) );
				tPrev.assign( float( 0.0 ) );

				// tMax: intersect with ground/top, mirroring the HLSL branching.
				const tBottom = raySphereIntersectNearest( worldPos, worldDir, earthO, params.bottomRadius );
				const tTop = raySphereIntersectNearest( worldPos, worldDir, earthO, params.topRadius );
				const tMaxIfNoBottom = tTop.lessThan( 0.0 ).select( float( 0.0 ), tTop );
				const tMaxIfBoth = tTop.greaterThan( 0.0 ).select( tTop.min( tBottom ), tBottom );
				tMax.assign( tBottom.lessThan( 0.0 ).select( tMaxIfNoBottom, tMaxIfBoth ) );

				// Inner ray-march. MS LUT uses: ground=true, mieRayPhase=false,
				// no multi-scatter feedback (we are *building* the MS LUT).
				// globalL = 1 (ILLUMINANCE_IS_ONE).
				Loop( { start: 0, end: RAYMARCH_SAMPLE_COUNT, type: 'int' }, ( { i: s } ) => {

					const newT = tMax.mul( float( s ).add( float( SAMPLE_SEGMENT_T ) ).div( float( RAYMARCH_SAMPLE_COUNT ) ) );
					const dt = newT.sub( tPrev );

					const P = worldPos.add( worldDir.mul( newT ) );
					const pHeight = length( P );
					const altitude = pHeight.sub( params.bottomRadius );
					const upVector = P.div( max( pHeight, float( 1e-6 ) ) );

					const medium = computeScatteringAbsorption( altitude, params );
					const extSafe = max( medium.extinction, vec3( extEps, extEps, extEps ) );
					const sampleOpticalDepth = medium.extinction.mul( dt );
					const sampleTransmittance = exp( sampleOpticalDepth.negate() );

					// Transmittance to sun via Transmittance LUT.
					const sunZenithCos = dot( sunDir, upVector );
					const tLutUv = transmittanceLutParamsToUv( pHeight, sunZenithCos, params );
					const transmittanceToSun = texture( transmittanceTex, tLutUv ).rgb;

					// MS LUT: isotropic phase (uniform) × scattering.
					const phaseTimesScattering = medium.scattering.mul( uniformPhase );

					// Earth shadow for sun ray.
					const shadowOrigin = P.add( upVector.mul( PRO_BIAS ) );
					const tEarth = raySphereIntersectNearest( shadowOrigin, sunDir, earthO, params.bottomRadius );
					const earthShadow = select( tEarth.greaterThanEqual( 0.0 ), float( 0.0 ), float( 1.0 ) );

					const S = earthShadow.mul( transmittanceToSun ).mul( phaseTimesScattering );
					const Sint = S.sub( S.mul( sampleTransmittance ) ).div( extSafe );
					L.addAssign( throughput.mul( Sint ) );

					// f_ms accumulator: scattering with uniform phase = 1.
					const MSv = medium.scattering;
					const MSint = MSv.sub( MSv.mul( sampleTransmittance ) ).div( extSafe );
					multiScatAs1.addAssign( throughput.mul( MSint ) );

					throughput.assign( throughput.mul( sampleTransmittance ) );
					tPrev.assign( newT );

				} );

				// Ground-bounce contribution for directions that hit the planet.
				const hitGround = tBottom.greaterThan( 0.0 ).and( tMax.equal( tBottom ) );
				const Pg = worldPos.add( worldDir.mul( tBottom ) );
				const pHeightG = length( Pg );
				const upG = Pg.div( max( pHeightG, float( 1e-6 ) ) );
				const sunZenithCosG = dot( sunDir, upG );
				const tLutUvG = transmittanceLutParamsToUv( pHeightG, sunZenithCosG, params );
				const transmittanceToSunG = texture( transmittanceTex, tLutUvG ).rgb;
				const NdotL = saturate( dot( normalize( upG ), normalize( sunDir ) ) );
				const groundL = transmittanceToSunG.mul( throughput ).mul( NdotL )
					.mul( params.groundAlbedo ).div( PI );

				L.assign( select( hitGround, L.add( groundL ), L ) );

				totalL.addAssign( L.mul( sampleWeight ) );
				totalMSA.addAssign( multiScatAs1.mul( sampleWeight ) );

			} );

			// Debug: the raw per-texel outer-loop sums before finalization. If
			// these are non-zero but the final output is black, the bug is in
			// the closed-form finalize step (1 - MultiScatAs1 clamping blowing up).
			if ( debugMode === 'totalL-raw' ) return vec4( totalL, 1.0 );
			if ( debugMode === 'totalMSA-raw' ) return vec4( totalMSA, 1.0 );

			// HLSL:518-519 — multiply by isotropic phase 1/(4π).
			const isotropicPhase = float( 1.0 ).div( sphereSolidAngle );
			const inScatteredLuminance = totalL.mul( isotropicPhase );
			const multiScatAs1Final = totalMSA.mul( isotropicPhase );

			// HLSL:530-533 — closed-form geometric series (Equation 10):
			//     L = InScatteredLuminance * 1/(1 - MultiScatAs1)
			// Clamp the denominator away from 0 so extreme coefficients can't
			// explode to inf. The reference code notes this can happen under
			// pathological params.
			const oneMinusR = max( float( 1.0 ).sub( multiScatAs1Final ), vec3( 1e-6, 1e-6, 1e-6 ) );
			const Lfinal = inScatteredLuminance.div( oneMinusR );

			// `MultipleScatteringFactor` (HLSL:75, applied at line 536) is 1.0
			// in Unreal's default setup — omitted here. Easy to add later if
			// we want per-atmosphere artistic control.
			return vec4( Lfinal, float( 1.0 ) );

		} )();

	}

	render() {

		const renderer = this.renderer;
		_rendererState = RendererUtils.resetRendererState( renderer, _rendererState );

		renderer.setRenderTarget( this.renderTarget );
		_quadMesh.material = this.material;
		_quadMesh.name = 'MultiScatterLUT';
		_quadMesh.render( renderer );

		RendererUtils.restoreRendererState( renderer, _rendererState );

	}

	dispose() {

		this.renderTarget.dispose();
		this.material.dispose();

	}

}
