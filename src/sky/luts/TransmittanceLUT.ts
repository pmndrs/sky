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
	uv,
	vec3,
	vec4,
	float,
	exp,
	sqrt,
	max
} from 'three/tsl';

import {
	computeScatteringAbsorption,
	raySphereIntersectNearest,
	uvToTransmittanceLutParams
} from '../shaders/atmosphere.tsl.js';
import { LUT_RESOLUTIONS } from './resolutions.js';

const _quadMesh = /*@__PURE__*/ new QuadMesh();
let _rendererState;

/**
 * Bruneton / Hillaire Transmittance LUT.
 *
 * Owns an RGBA16F render target; `render()` runs a single fragment pass that, for
 * each texel, un-maps the Bruneton (viewHeight, viewZenithCosAngle) parameterization
 * from UV, raymarches ~40 steps to the atmosphere boundary accumulating optical
 * depth, and writes `exp(-opticalDepth)`.
 *
 * Faithful port of `RenderTransmittanceLutPS` (with the `IntegrateScatteredLuminance`
 * inner loop specialized to `ground=false, sampleCountIni=40, variableSampleCount=false,
 * MieRayPhase=false`, which makes the integrator collapse to just optical-depth
 * accumulation — no in-scattered luminance, no transmittance-to-sun sample).
 */
export class TransmittanceLUT {

	constructor( renderer, { resolution = LUT_RESOLUTIONS.transmittance, atmosphereUniforms } = {} ) {

		if ( ! atmosphereUniforms ) throw new Error( 'TransmittanceLUT: atmosphereUniforms is required' );

		this.renderer = renderer;
		this.resolution = { ...resolution };
		this.atmosphereUniforms = atmosphereUniforms;

		this.renderTarget = new RenderTarget( resolution.width, resolution.height, {
			type: HalfFloatType,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			wrapS: ClampToEdgeWrapping,
			wrapT: ClampToEdgeWrapping,
			generateMipmaps: false,
			depthBuffer: false
		} );
		this.renderTarget.texture.name = 'TransmittanceLUT';

		this.material = new NodeMaterial();
		this.material.name = 'TransmittanceLUT';
		this.material.colorNode = this._buildColorNode();

	}

	get texture() {

		return this.renderTarget.texture;

	}

	_buildColorNode() {

		const params = this.atmosphereUniforms;
		const SAMPLE_COUNT = 40;
		const SAMPLE_SEGMENT_T = 0.3; // Matches Hillaire: mid-segment offset for accuracy

		return Fn( () => {

			const lutUv = uv();
			const { viewHeight, viewZenithCosAngle } = uvToTransmittanceLutParams( lutUv, params );

			// World position lies on +Y, ray in YZ-plane (matches Hillaire's layout —
			// he uses +Z up but the math is identical; we keep Y up to align with the
			// rest of the three.js scene conventions).
			const worldPos = vec3( float( 0.0 ), viewHeight, float( 0.0 ) );
			const sinZ = sqrt( max( float( 0.0 ), float( 1.0 ).sub( viewZenithCosAngle.mul( viewZenithCosAngle ) ) ) );
			const worldDir = vec3( sinZ, viewZenithCosAngle, float( 0.0 ) );

			const earthO = vec3( 0.0, 0.0, 0.0 );

			// Distance to atmosphere boundary (top sphere) and, if we'd hit the
			// ground first, stop there instead. Mirrors the opening of
			// IntegrateScatteredLuminance.
			const tBottom = raySphereIntersectNearest( worldPos, worldDir, earthO, params.bottomRadius );
			const tTop = raySphereIntersectNearest( worldPos, worldDir, earthO, params.topRadius );

			// tMax: 0 if miss-miss; else min of the two positive hits (ground shortcut
			// when pointing down); else just tTop.
			const tMaxIfNoBottom = tTop.lessThan( 0.0 ).select( float( 0.0 ), tTop );
			const tMaxIfBoth = tTop.greaterThan( 0.0 ).select( tTop.min( tBottom ), tBottom );
			const tMax = tBottom.lessThan( 0.0 ).select( tMaxIfNoBottom, tMaxIfBoth ).toVar();

			const opticalDepth = vec3( 0.0, 0.0, 0.0 ).toVar();
			const tPrev = float( 0.0 ).toVar();
			const tCur = float( 0.0 ).toVar();

			// Hillaire's fixed-step integrator with mid-step (SampleSegmentT = 0.3):
			//     t = tMax * (s + 0.3) / SampleCount
			//     dt = t - tPrev
			//     opticalDepth += extinction(P) * dt
			// Unrolled at shader build time since SAMPLE_COUNT is a JS constant.
			for ( let s = 0; s < SAMPLE_COUNT; s ++ ) {

				const newT = tMax.mul( float( s + SAMPLE_SEGMENT_T ).div( float( SAMPLE_COUNT ) ) );
				const dt = newT.sub( tPrev );
				tCur.assign( newT );

				const P = worldPos.add( worldDir.mul( tCur ) );
				const height = P.length().sub( params.bottomRadius );

				const medium = computeScatteringAbsorption( height, params );
				opticalDepth.addAssign( medium.extinction.mul( dt ) );

				tPrev.assign( newT );

			}

			const transmittance = exp( opticalDepth.negate() );
			return vec4( transmittance, float( 1.0 ) );

		} )();

	}

	/**
	 * Execute the fragment pass into the render target. Cheap to call repeatedly —
	 * the atmosphere uniforms are bound by reference, so each call uses whatever
	 * is currently in `atmosphereUniforms`.
	 */
	render() {

		const renderer = this.renderer;
		_rendererState = RendererUtils.resetRendererState( renderer, _rendererState );

		renderer.setRenderTarget( this.renderTarget );
		_quadMesh.material = this.material;
		_quadMesh.name = 'TransmittanceLUT';
		_quadMesh.render( renderer );

		RendererUtils.restoreRendererState( renderer, _rendererState );

	}

	dispose() {

		this.renderTarget.dispose();
		this.material.dispose();

	}

}

