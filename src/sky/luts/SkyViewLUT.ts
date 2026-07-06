import {
	RenderTarget,
	HalfFloatType,
	LinearFilter,
	ClampToEdgeWrapping,
	NodeMaterial,
	QuadMesh,
	RendererUtils,
	Vector3
} from 'three/webgpu';
import {
	Fn,
	uv,
	vec3,
	vec4,
	float,
	sqrt,
	max,
	dot,
	normalize,
	length,
	uniform
} from 'three/tsl';

import {
	integrateScatteredLuminance,
	uvToSkyViewLutParams,
	moveToTopAtmosphere
} from '../shaders/atmosphere.tsl.js';
import { LUT_RESOLUTIONS } from './resolutions.js';

const _quadMesh = /*@__PURE__*/ new QuadMesh();
let _rendererState;

// HLSL:626. Unreal uses VariableSampleCount=true with RayMarchMinMaxSPP; we
// simplify to a fixed 30-step inner loop (flagged in the constructor JSDoc).
const SAMPLE_COUNT = 30;

/**
 * Hillaire Sky-View LUT.
 *
 * 192×108 RGBA16F. Pre-integrated view-ray radiance from the camera, indexed by
 * the horizon-packed (azimuth, zenith) parameterization from RenderSkyCommon.hlsl:122.
 *
 * Port of `SkyViewLutPS` in RenderSkyRayMarching.hlsl:581-635. Reads the
 * Transmittance LUT for sun-direction extinction and the Multi-Scatter LUT for
 * higher-order bounces. Invokes `integrateScatteredLuminance` with
 * `mieRayPhase=true` and the MS LUT attached, matching the HLSL's
 * `MULTISCATAPPROX_ENABLED` + `MieRayPhase=true` path.
 *
 * View position assumption (phase 1b): viewer sits at ground level,
 * `viewHeight = bottomRadius + PLANET_RADIUS_OFFSET`. Phase 2 will promote this
 * to a camera-world-position uniform when we support non-ground views.
 *
 * Simplification vs. Unreal: the HLSL uses `VariableSampleCount=true`
 * (interpolates between RayMarchMinMaxSPP.x and .y based on distance). We use a
 * fixed 30-step loop — the HLSL's SampleCountIni default is 30 and a constant
 * step count lets `integrateScatteredLuminance` unroll cleanly. Quality
 * difference at the defaults is imperceptible.
 */
export class SkyViewLUT {

	constructor( renderer, {
		resolution = LUT_RESOLUTIONS.skyView,
		atmosphereUniforms,
		transmittanceLUT,
		multiScatterLUT,
		sunDirection
	} = {} ) {

		if ( ! atmosphereUniforms ) throw new Error( 'SkyViewLUT: atmosphereUniforms is required' );
		if ( ! transmittanceLUT ) throw new Error( 'SkyViewLUT: transmittanceLUT is required' );
		if ( ! multiScatterLUT ) throw new Error( 'SkyViewLUT: multiScatterLUT is required' );

		this.renderer = renderer;
		this.resolution = { ...resolution };
		this.atmosphereUniforms = atmosphereUniforms;
		this.transmittanceLUT = transmittanceLUT;
		this.multiScatterLUT = multiScatterLUT;

		// Own the sun-direction uniform internally. Accept either a Vector3
		// starting value or nothing (defaults to straight up). If the caller
		// passes a uniform node we accept that too, but the simple happy path
		// is "LUT owns a Vector3 uniform".
		const initialSun = sunDirection instanceof Vector3
			? sunDirection.clone()
			: new Vector3( 0.0, 0.0, 1.0 );
		this._sunDirectionUniform = uniform( initialSun );

		/**
		 * Camera viewHeight (km, planet-centred — i.e. distance from planet
		 * centre to the camera). Default = ground+ε. Phase 2 callers update
		 * this every frame so the LUT reflects the actual camera altitude.
		 */
		this._viewHeightUniform = uniform(
			atmosphereUniforms.bottomRadius.value + 0.01
		);

		this.renderTarget = new RenderTarget( resolution.width, resolution.height, {
			type: HalfFloatType,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			wrapS: ClampToEdgeWrapping,
			wrapT: ClampToEdgeWrapping,
			generateMipmaps: false,
			depthBuffer: false
		} );
		this.renderTarget.texture.name = 'SkyViewLUT';

		this.material = new NodeMaterial();
		this.material.name = 'SkyViewLUT';
		this.material.colorNode = this._buildColorNode();

	}

	get texture() {

		return this.renderTarget.texture;

	}

	/** Current sun direction as a Vector3 (returned by reference — mutate in place
	 * or go through the setter to re-copy). */
	get sunDirection() {

		return this._sunDirectionUniform.value;

	}

	set sunDirection( v ) {

		if ( v instanceof Vector3 ) this._sunDirectionUniform.value.copy( v );
		else if ( Array.isArray( v ) ) this._sunDirectionUniform.value.fromArray( v );
		else if ( v && typeof v === 'object' ) this._sunDirectionUniform.value.set( v.x, v.y, v.z );

	}

	/** Planet-centred camera height in km. Setter for phase 2 per-frame updates. */
	get viewHeight() {

		return this._viewHeightUniform.value;

	}

	set viewHeight( km ) {

		this._viewHeightUniform.value = km;

	}

	_buildColorNode() {

		const params = this.atmosphereUniforms;
		const transmittanceTex = this.transmittanceLUT.texture;
		const multiScatterTex = this.multiScatterLUT.texture;
		const sunDirU = this._sunDirectionUniform;
		const viewHeightU = this._viewHeightUniform;

		return Fn( () => {

			const lutUv = uv();

			// Camera viewHeight (km, distance from planet centre). Driven by
			// the per-frame uniform — caller writes via `setCamera()` upstream.
			// Clamp to never go below `bottomRadius + ε` so the ground-intersect
			// math stays well-defined even if the caller hands us something
			// physically below the planet surface.
			const viewHeight = max( viewHeightU, params.bottomRadius.add( float( 0.01 ) ) );

			// Un-map UV → view angles using the Hillaire horizon-packed scheme.
			const { viewZenithCosAngle, lightViewCosAngle } = uvToSkyViewLutParams( params, viewHeight, lutUv );

			// Reconstruct the sun direction relative to the camera's up (Z-up
			// in this LUT's local frame, matching HLSL:600-605). The actual sun
			// azimuth is folded into lightViewCosAngle; SunDir lives in the YZ
			// plane so dot(sunDir, worldDir) reproduces lightViewCosAngle by
			// construction (see derivation in Hillaire's paper §5.3).
			const upVector = vec3( 0.0, 0.0, 1.0 );
			const sunZenithCosAngle = dot( upVector, normalize( sunDirU ) );
			const sunDirSinZ = sqrt( max( float( 1.0 ).sub( sunZenithCosAngle.mul( sunZenithCosAngle ) ), float( 0.0 ) ) );
			const sunDir = vec3( sunDirSinZ, float( 0.0 ), sunZenithCosAngle );

			// World position at the camera's height on +Z.
			const worldPos = vec3( float( 0.0 ), float( 0.0 ), viewHeight ).toVar();

			// Build the view direction (HLSL:611-615).
			const vzSin = sqrt( max( float( 1.0 ).sub( viewZenithCosAngle.mul( viewZenithCosAngle ) ), float( 0.0 ) ) );
			const worldDir = vec3(
				vzSin.mul( lightViewCosAngle ),
				vzSin.mul( sqrt( max( float( 1.0 ).sub( lightViewCosAngle.mul( lightViewCosAngle ) ), float( 0.0 ) ) ) ),
				viewZenithCosAngle
			).toVar();

			// Clip to the atmosphere boundary if the camera happens to be above
			// TopRadius. In phase 1b this is always false (camera = ground), but
			// keeping the call makes the shader behave correctly if viewHeight
			// is promoted to a uniform in phase 2.
			const clipped = moveToTopAtmosphere( worldPos, worldDir, params );
			worldPos.assign( clipped.newPos );

			// Integrate with ground=true so below-horizon texels pick up the
			// sky-illuminated ground albedo. SebH's HLSL:625 sets this false
			// because his consumer scenes always have explicit ground geometry
			// that shades itself — adding it in the LUT there would double-
			// count. Our baker's cube camera sees no ground geometry, so the
			// lower hemisphere of the env map is black without this. In the
			// main scene the live sky mesh's below-horizon pixels are still
			// occluded by actual ground geometry (if any) via depth — no
			// double-count.
			const ss = integrateScatteredLuminance( {
				worldPos,
				worldDir,
				sunDir,
				params,
				transmittanceLUT: transmittanceTex,
				multiScatterLUT: multiScatterTex,
				sampleCount: SAMPLE_COUNT,
				ground: true,
				mieRayPhase: true
			} );

			return vec4( ss.L, float( 1.0 ) );

		} )();

	}

	render() {

		const renderer = this.renderer;
		_rendererState = RendererUtils.resetRendererState( renderer, _rendererState );

		renderer.setRenderTarget( this.renderTarget );
		_quadMesh.material = this.material;
		_quadMesh.name = 'SkyViewLUT';
		_quadMesh.render( renderer );

		RendererUtils.restoreRendererState( renderer, _rendererState );

	}

	dispose() {

		this.renderTarget.dispose();
		this.material.dispose();

	}

}
