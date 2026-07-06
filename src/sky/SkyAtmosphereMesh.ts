import {
	BackSide,
	BoxGeometry,
	DataTexture,
	HalfFloatType,
	LinearFilter,
	Mesh,
	RGBAFormat,
	RepeatWrapping,
	Vector3,
	NodeMaterial
} from 'three/webgpu';

import {
	Fn,
	If,
	abs,
	cos,
	sin,
	float,
	vec2,
	vec3,
	vec4,
	dot,
	normalize,
	cross,
	length,
	max,
	clamp,
	mix,
	smoothstep,
	texture,
	equirectUV,
	modelViewProjection,
	positionWorld,
	cameraPosition,
	uniform
} from 'three/tsl';

import {
	integrateScatteredLuminance,
	moveToTopAtmosphere,
	raySphereIntersectNearest,
	skyViewLutParamsToUv,
	transmittanceLutParamsToUv
} from './shaders/atmosphere.tsl.js';
import { proceduralStars } from './shaders/proceduralStars.tsl.js';

// 1×1 black HalfFloat placeholder used when no star texture is wired. Sized to
// match the EXR replacement format so swapping `texNode.value` later doesn't
// trip a format-mismatch reupload.
function _makeStarsPlaceholder() {

	// Half-float "0" is the bit pattern 0x0000.
	const data = new Uint16Array( 4 );
	const tex = new DataTexture( data, 1, 1, RGBAFormat, HalfFloatType );
	tex.minFilter = LinearFilter;
	tex.magFilter = LinearFilter;
	tex.wrapS = RepeatWrapping;
	tex.wrapT = RepeatWrapping;
	tex.needsUpdate = true;
	tex.name = 'SkyAtmosphereMesh.starsPlaceholder';
	return tex;

}

/**
 * Phase 1b visible sky — Hillaire LUT-sampled box mesh.
 *
 * Matches the shape of the legacy Preetham `SkyMesh` exactly: `BoxGeometry(1,1,1)`
 * with `BackSide` + `depthWrite=false` + the `z = w` vertex trick so the cube
 * always sits at the far plane. Only the fragment path changes — for each view
 * direction we un-map the Hillaire (viewZenithCos, lightViewCos) parameterization
 * and sample the Sky-View LUT.
 *
 * Port of the final-compose pass `RenderSkyWithLutsPS` in
 * `UnrealEngineSkyAtmosphere/Resources/RenderSkyRayMarching.hlsl:333`. Uses
 * `skyViewLutParamsToUv` (forward map) from `atmosphere.tsl.js`.
 *
 * Sun disc is rendered on top as a smoothstep against the angular diameter,
 * gated by `showSunDisc` (default 0 — off during bake to keep PMREM clean).
 *
 * Sun direction and up vector live in three.js-world Y-up coordinates (baked sky
 * scene uses the main scene's conventions). The Sky-View LUT itself is built in
 * a Z-up local frame, but the *UV parameterization* is frame-independent: it
 * only depends on (viewZenithCos, lightViewCos, viewHeight, intersectsGround),
 * which we compute here from the Y-up world vectors directly.
 */
export class SkyAtmosphereMesh extends Mesh {

	/**
	 * @param {object} args
	 * @param {object} args.atmosphereUniforms  bundle from createAtmosphereUniforms
	 * @param {SkyViewLUT} args.skyViewLUT      already-constructed Sky-View LUT
	 * @param {TransmittanceLUT} [args.transmittanceLUT]  required for the
	 *   space-view raymarch fallback (camera viewHeight > topRadius). Optional
	 *   for ground-only callers; without it, the mesh stays in pure SkyView mode.
	 * @param {MultiScatterLUT} [args.multiScatterLUT]  paired with transmittanceLUT.
	 * @param {THREE.Vector3} [args.sunDirection]  initial Y-up world-space sun dir
	 * @param {THREE.Vector3} [args.upVector]      initial Y-up world-space up dir
	 */
	constructor( { atmosphereUniforms, skyViewLUT, transmittanceLUT = null, multiScatterLUT = null, sunDirection, upVector } = {} ) {

		if ( ! atmosphereUniforms ) throw new Error( 'SkyAtmosphereMesh: atmosphereUniforms is required' );
		if ( ! skyViewLUT ) throw new Error( 'SkyAtmosphereMesh: skyViewLUT is required' );

		const material = new NodeMaterial();

		super( new BoxGeometry( 1, 1, 1 ), material );

		this.atmosphereUniforms = atmosphereUniforms;
		this.skyViewLUT = skyViewLUT;
		this.transmittanceLUT = transmittanceLUT;
		this.multiScatterLUT = multiScatterLUT;

		/**
		 * Sun direction in Y-up world space (same frame as the main scene).
		 * Mutate in place or re-assign via `.sunDirection = vec`; the uniform
		 * tracks the Vector3 instance by reference.
		 *
		 * @type {UniformNode<vec3>}
		 */
		this.sunDirection = uniform(
			sunDirection instanceof Vector3 ? sunDirection.clone() : new Vector3( 0.0, 1.0, 0.0 )
		);

		/**
		 * Up vector in Y-up world space.
		 *
		 * @type {UniformNode<vec3>}
		 */
		this.upVector = uniform(
			upVector instanceof Vector3 ? upVector.clone() : new Vector3( 0.0, 1.0, 0.0 )
		);

		/**
		 * Whether to render the solar disc (float 0/1). Default 0 — the baker
		 * flips this on after the cube bake completes so main-scene renders can
		 * still see a sharp sun disc in the background.
		 *
		 * @type {UniformNode<float>}
		 */
		this.showSunDisc = uniform( 0.0 );

		/**
		 * Below-horizon Y-mirror (float 0/1). When 1, view rays pointing
		 * downward (against `upVector`) get their up-component flipped to
		 * positive before the Sky-View LUT sample. The result is a clean
		 * Y-mirror of the sky on the lower hemisphere instead of the LUT's
		 * `ground: true` lit-albedo content. The baker toggles this on
		 * during the cube bake (when `mirrorBelowHorizon` is enabled at
		 * construction) so `environmentTexture` becomes a complete sky
		 * HDRI with no ground tint in the lower mips — handy when the
		 * consumer scene has reflective floors or uses `GroundedSkybox` in
		 * reflective mode and doesn't want ground colour bleeding into
		 * PBR IBL. Live mesh in the main scene keeps this at 0 so the
		 * direct sky view continues to show real below-horizon LUT content.
		 *
		 * @type {UniformNode<float>}
		 */
		this.mirrorBelowHorizon = uniform( 0.0 );

		/**
		 * Sun-disc intensity multiplier. Tuned to match the Sky-View LUT's
		 * radiance magnitude (which is already in "Mcd/m²"-like units from
		 * Hillaire's integrator). A value of ~20 reads as a bright sun without
		 * blowing out the IBL when this mesh is used outside a bake.
		 *
		 * @type {UniformNode<float>}
		 */
		this.sunIntensity = uniform( 20.0 );

		/**
		 * Sun-disc angular *diameter* in radians. Stored as `cos(diameter)` for
		 * the smoothstep test. Default ~0.535° matches the Sun seen from Earth.
		 * Updated via `setSunAngularDiameter(rad)`.
		 *
		 * @type {UniformNode<float>}
		 */
		this.sunDiscCos = uniform( Math.cos( 0.004675 ) );

		/**
		 * Moon direction in Y-up world space. Mirrors `sunDirection`. Pushed
		 * by `SkyMoon` on every direction sync. Defaults to a placeholder
		 * pointing up; the disc is hidden by default so this never matters
		 * unless `showMoonDisc` is raised.
		 *
		 * @type {UniformNode<vec3>}
		 */
		this.moonDirection = uniform( new Vector3( 0.0, 1.0, 0.0 ) );

		/**
		 * Whether to render the moon disc (float 0/1). Default 0 — `SkyMoon`
		 * flips this on at construction. The baker temporarily forces it off
		 * during the cube bake (parallels sun-disc handling) so PMREM stays
		 * clean.
		 *
		 * @type {UniformNode<float>}
		 */
		this.showMoonDisc = uniform( 0.0 );

		/**
		 * Moon-disc intensity multiplier. Tuned much lower than the sun
		 * (~1.0 vs sun's 20.0): the real moon is ~6 orders of magnitude
		 * dimmer than the sun, but visually we cheat to make it readable.
		 *
		 * @type {UniformNode<float>}
		 */
		this.moonIntensity = uniform( 1.0 );

		/**
		 * Moon-disc angular diameter in radians. Stored as `cos(diameter)`
		 * for the smoothstep test. Default ~0.535° matches the Moon seen
		 * from Earth (essentially identical to the Sun's angular diameter
		 * — that's why eclipses are clean).
		 *
		 * @type {UniformNode<float>}
		 */
		this.moonDiscCos = uniform( Math.cos( 0.004675 ) );

		/**
		 * Moon-disc colour. Cool-white default mimicking reflected sunlight.
		 * Stored on the mesh so callers can tint without rebuilding the
		 * material.
		 *
		 * @type {UniformNode<vec3>}
		 */
		this.moonColor = uniform( new Vector3( 0.85, 0.9, 1.0 ) );

		/**
		 * Camera viewHeight (km, planet-centred). Drives the SkyView LUT UV
		 * un-map AND the ground-intersect ray origin. Defaults to ground+ε;
		 * the baker's `setCamera()` updates this each frame for phase 2.
		 *
		 * @type {UniformNode<float>}
		 */
		this.viewHeight = uniform( atmosphereUniforms.bottomRadius.value + 0.01 );

		/**
		 * Global luminance multiplier applied to the Sky-View LUT sample.
		 *
		 * The LUTs are computed with Hillaire's `ILLUMINANCE_IS_ONE` convention
		 * — the integrator's `globalL = 1.0` means the LUT stores sky response
		 * *per unit sun illuminance*. Raw values are tiny (~1e-3 to 5e-2) and
		 * read as black on a linear-light display. The consumer is expected to
		 * multiply by the actual sun luminance at composite time
		 * (`RenderSkyWithLutsPS` in the Unreal reference does this via
		 * `Atmosphere.GlobalLuminanceScale` × sun terms).
		 *
		 * Default 40.0: produces a visibly bright sky under ACES with exposure
		 * 0.5, matching the legacy Preetham SkyMesh's perceived brightness.
		 * Tunable via the GUI.
		 *
		 * @type {UniformNode<float>}
		 */
		this.luminanceScale = uniform( 40.0 );

		/**
		 * Stars equirect HDR texture (HalfFloat, RGBA). Bound by
		 * `SkyNight.enable({ source: 'hdri' | 'texture' })`; until then holds
		 * a 1×1 black placeholder so the shader stays well-formed. Swapping
		 * `node.value` later picks up the new texture without a material
		 * rebuild — keep the format (HalfFloat / RGBA) consistent.
		 *
		 * @type {TextureNode}
		 */
		this._starsTexturePlaceholder = _makeStarsPlaceholder();
		this.starsTextureNode = texture( this._starsTexturePlaceholder );

		/**
		 * Stars intensity multiplier (linear). Default 0 — keeps the stars
		 * code path silent until `SkyNight.enable()` raises it. ~1.0 is a
		 * good visual default for both procedural and HDR sources.
		 *
		 * @type {UniformNode<float>}
		 */
		this.starsIntensity = uniform( 0.0 );

		/**
		 * Stars source mode. 0 = procedural starfield (no asset cost,
		 * shader-generated), 1 = sample `starsTextureNode` (user-provided
		 * HDR, e.g. a Milky Way capture). Both paths run every frame; the
		 * mix is a single lerp on the cheap procedural and a near-free
		 * texture sample, so toggling at runtime has no recompile cost.
		 *
		 * @type {UniformNode<float>}
		 */
		this.starsMode = uniform( 0.0 );

		/**
		 * Procedural starfield density: fraction of the 400×200 cell grid
		 * that hosts a star. 0.3 ≈ 24k stars over the full sphere — looks
		 * like a clear-sky countryside. Lower for a sparse alien world,
		 * higher for sci-fi nebula skies.
		 *
		 * @type {UniformNode<float>}
		 */
		this.starsDensity = uniform( 0.3 );

		/**
		 * Procedural starfield brightness multiplier. Tuned so the brightest
		 * stars sit slightly above the dim sky scattering at night; raise for
		 * supernova-bright look, lower for subtle.
		 *
		 * @type {UniformNode<float>}
		 */
		this.starsBrightnessScale = uniform( 1.0 );

		/**
		 * Stars rotation around the up axis in radians. Applies to both
		 * procedural and HDR sources (so binding it to time-of-day rotates
		 * either layer consistently).
		 *
		 * @type {UniformNode<float>}
		 */
		this.starsRotation = uniform( 0.0 );

		/**
		 * Flag for type testing.
		 *
		 * @type {boolean}
		 */
		this.isSkyAtmosphereMesh = true;

		// --- vertex: same z=w trick as the legacy SkyMesh (keeps the cube at far plane) ---
		const vertexNode = /*@__PURE__*/ Fn( () => {

			const position = modelViewProjection;
			position.z.assign( position.w );
			return position;

		} )();

		// --- fragment: Sky-View LUT sample + sun disc ---
		const colorNode = this._buildColorNode();

		material.side = BackSide;
		// `depthWrite = true` so sky pixels stamp the far-plane value into the
		// scene depth buffer (the `z = w` vertex trick gives them NDC.z = 1).
		// The post-process haze pass uses scene depth to discriminate sky vs
		// geometry; with depthWrite off, sky pixels read the cleared depth
		// value which `getViewZNode` / `getLinearDepthNode` then interpret as
		// "at the camera" rather than "at the far plane" — breaking every
		// depth-based sky test. Writing real far-plane depth makes both tests
		// reliable. Geometry still wins the depth test (it's closer than far)
		// so this doesn't occlude anything.
		material.depthWrite = true;
		material.vertexNode = vertexNode;
		material.colorNode = colorNode;

	}

	_buildColorNode() {

		const params = this.atmosphereUniforms;
		const skyViewTex = this.skyViewLUT.texture;
		const transmittanceTex = this.transmittanceLUT ? this.transmittanceLUT.texture : null;
		const multiScatterTex = this.multiScatterLUT ? this.multiScatterLUT.texture : null;
		const enableSpaceFallback = transmittanceTex !== null && multiScatterTex !== null;
		const sunDirU = this.sunDirection;
		const upU = this.upVector;
		const showSunDiscU = this.showSunDisc;
		const sunIntensityU = this.sunIntensity;
		const sunDiscCosU = this.sunDiscCos;
		const luminanceScaleU = this.luminanceScale;
		const viewHeightU = this.viewHeight;
		const starsTexNode = this.starsTextureNode;
		const starsIntensityU = this.starsIntensity;
		const starsModeU = this.starsMode;
		const starsDensityU = this.starsDensity;
		const starsBrightnessU = this.starsBrightnessScale;
		const starsRotationU = this.starsRotation;
		const moonDirU = this.moonDirection;
		const showMoonDiscU = this.showMoonDisc;
		const moonIntensityU = this.moonIntensity;
		const moonDiscCosU = this.moonDiscCos;
		const moonColorU = this.moonColor;
		const mirrorBelowHorizonU = this.mirrorBelowHorizon;

		return Fn( () => {

			// View direction from the camera to this fragment's world position.
			const viewDirRaw = normalize( positionWorld.sub( cameraPosition ) );
			const upVec = normalize( upU );
			const sunDir = normalize( sunDirU );

			// Optional below-horizon Y-mirror. When `mirrorBelowHorizon` is 1,
			// fold the up-axis component of viewDir to be positive (i.e.
			// reflect downward rays about the local horizon plane). All
			// downstream math (intersectsGround, viewZenithCosAngle, LUT
			// sample) automatically produces above-horizon sky content for
			// what would otherwise be ground-direction rays — giving a clean
			// Y-mirrored sky on the cube's lower hemisphere. The horizontal
			// component is untouched so azimuth-relative-to-sun is preserved.
			const vAlongUp = dot( viewDirRaw, upVec );
			const vAlongUpEffective = mix( vAlongUp, abs( vAlongUp ), mirrorBelowHorizonU );
			const viewDirHorizontal = viewDirRaw.sub( upVec.mul( vAlongUp ) );
			const viewDir = normalize( viewDirHorizontal.add( upVec.mul( vAlongUpEffective ) ) );

			// Camera viewHeight (km, distance from planet centre) — driven by the
			// per-frame uniform. Clamp to never fall below `bottomRadius + ε` so
			// the ground-intersect math stays well-defined.
			const viewHeight = max( viewHeightU, params.bottomRadius.add( float( 0.01 ) ) );

			// View-zenith cosine.
			const viewZenithCosAngle = clamp( dot( viewDir, upVec ), float( - 1.0 ), float( 1.0 ) );

			// Light-view cosine, per Unreal RenderSkyRayMarching.hlsl:325-329.
			// Build a stable on-plane basis perpendicular to up, aligned with the
			// view direction's horizontal component, then project the sun onto it.
			const sideRaw = cross( upVec, viewDir );
			const sideLen = max( length( sideRaw ), float( 1e-6 ) );
			const sideVector = sideRaw.div( sideLen );
			const forwardVector = normalize( cross( sideVector, upVec ) );

			const lightOnPlaneX = dot( sunDir, forwardVector );
			const lightOnPlaneY = dot( sunDir, sideVector );
			const lightOnPlaneLen = max( length( vec2( lightOnPlaneX, lightOnPlaneY ) ), float( 1e-6 ) );
			const lightViewCosAngle = clamp( lightOnPlaneX.div( lightOnPlaneLen ), float( - 1.0 ), float( 1.0 ) );

			// Ground intersection test (planet at origin, camera along local up).
			const earthO = vec3( 0.0, 0.0, 0.0 );
			const ro = upVec.mul( viewHeight );
			const tPlanet = raySphereIntersectNearest( ro, viewDir, earthO, params.bottomRadius );
			const intersectsGround = tPlanet.greaterThanEqual( float( 0.0 ) );

			// Sky color accumulator. Either populated by the SkyView LUT
			// (camera inside / near atmosphere) or by a per-pixel raymarch
			// (camera in space — the LUT's horizon-packed UV layout misallocates
			// texels once the planet stops dominating the view).
			const skyColor = vec3( 0.0, 0.0, 0.0 ).toVar();

			if ( enableSpaceFallback ) {

				// Smooth transition between LUT and raymarch around topRadius.
				// Below blendStart: pure LUT (cheap, raymarch skipped via If).
				// blendStart..blendEnd: smoothstep blend (both paths contribute).
				// Above blendEnd: pure raymarch (LUT contribution lerped out).
				const BLEND_HALF_WIDTH_KM = float( 20.0 );
				const blendStart = params.topRadius.sub( BLEND_HALF_WIDTH_KM );
				const blendEnd = params.topRadius.add( BLEND_HALF_WIDTH_KM );

				// LUT path always runs — it's a single texture sample, near-free.
				const lutUv = skyViewLutParamsToUv(
					params,
					intersectsGround,
					viewZenithCosAngle,
					lightViewCosAngle,
					viewHeight
				);
				const lutColor = texture( skyViewTex, lutUv ).rgb.mul( luminanceScaleU );

				// Raymarch only when needed: above blendStart. Low-altitude users
				// (the common case) skip the 30-sample integration entirely.
				const rayColor = vec3( 0.0, 0.0, 0.0 ).toVar();
				If( viewHeight.greaterThan( blendStart ), () => {

					// Camera position in planet-centred frame; clip the ray origin
					// to the atmosphere boundary, and if the ray misses entirely
					// the result stays at zero.
					const camPos = upVec.mul( viewHeight );
					const moved = moveToTopAtmosphere( camPos, viewDir, params );
					const startPos = moved.newPos.toVar();

					const result = integrateScatteredLuminance( {
						worldPos: startPos,
						worldDir: viewDir,
						sunDir: sunDir,
						params: params,
						transmittanceLUT: transmittanceTex,
						multiScatterLUT: multiScatterTex,
						sampleCount: 30,
						ground: true,
						mieRayPhase: true
					} );

					const validF = moved.valid.select( float( 1.0 ), float( 0.0 ) );
					rayColor.assign( result.L.mul( luminanceScaleU ).mul( validF ) );

				} );

				const blendT = smoothstep( blendStart, blendEnd, viewHeight );
				skyColor.assign( mix( lutColor, rayColor, blendT ) );

			} else {

				// No fallback wired — pure SkyView LUT path (Phase 1b behaviour).
				const lutUv = skyViewLutParamsToUv(
					params,
					intersectsGround,
					viewZenithCosAngle,
					lightViewCosAngle,
					viewHeight
				);
				skyColor.assign( texture( skyViewTex, lutUv ).rgb.mul( luminanceScaleU ) );

			}

			// Stars contribution. Two source paths run in parallel and are
			// lerp-mixed by `starsMode` (0 = procedural shader-only, 1 = HDR
			// texture sample). Both paths are cheap; the runtime mix lets
			// callers swap source without a material rebuild.
			//
			// Whichever source produces the raw colour, we attenuate by
			// camera→space transmittance (so stars fade through twilight
			// without a manual fade curve) and zero out below-horizon rays.
			//
			// Skipped entirely if the transmittance LUT isn't wired (the
			// stand-alone Phase 1b mesh case); without `tToSpace` stars look
			// wrong at dawn/dusk.
			const starsContribution = vec3( 0.0, 0.0, 0.0 ).toVar();
			if ( transmittanceTex !== null ) {

				// Rotate viewDir around the world Y axis. We use world-Y rather
				// than the `upVec` uniform because the stars ride the world
				// celestial sphere, not the local-up frame (relevant for
				// spherical-planet setups where local-up tilts as the camera
				// orbits the planet).
				const cosR = cos( starsRotationU );
				const sinR = sin( starsRotationU );
				const starsDir = vec3(
					viewDir.x.mul( cosR ).add( viewDir.z.mul( sinR ) ),
					viewDir.y,
					viewDir.x.mul( sinR ).negate().add( viewDir.z.mul( cosR ) )
				);

				const starsUv = equirectUV( starsDir );
				const proceduralRaw = proceduralStars( starsUv, starsDensityU, starsBrightnessU );
				const textureRaw = starsTexNode.sample( starsUv ).rgb;
				const starsRaw = mix( proceduralRaw, textureRaw, starsModeU );

				// Camera→space transmittance along this view ray.
				const tToSpaceUv = transmittanceLutParamsToUv(
					viewHeight,
					viewZenithCosAngle,
					params
				);
				const tToSpace = texture( transmittanceTex, tToSpaceUv ).rgb;
				const skyMask = intersectsGround.select( float( 0.0 ), float( 1.0 ) );

				starsContribution.assign(
					starsRaw.mul( tToSpace ).mul( starsIntensityU ).mul( skyMask )
				);

			}

			// Sun disc — same in both paths. cos(angularDiameter) smoothstep,
			// driven by the `sunDiscCos` uniform so callers can size the disc.
			const cosSun = dot( viewDir, sunDir );
			const sunDiscMask = smoothstep(
				sunDiscCosU,
				sunDiscCosU.add( float( 0.00002 ) ),
				cosSun
			).mul( showSunDiscU );

			const sunContribution = vec3( 1.0, 1.0, 1.0 ).mul( sunDiscMask ).mul( sunIntensityU );

			// Moon disc — same shape as the sun disc, separate uniforms so the
			// sun stays unaffected. Constantly "full" — no phase-shaded
			// terminator (intentional v1 simplification: the disc is just a
			// circle that tracks the moon direction).
			const moonDir = normalize( moonDirU );
			const cosMoon = dot( viewDir, moonDir );
			const moonDiscMask = smoothstep(
				moonDiscCosU,
				moonDiscCosU.add( float( 0.00002 ) ),
				cosMoon
			).mul( showMoonDiscU );

			const moonContribution = moonColorU.mul( moonDiscMask ).mul( moonIntensityU );

			return vec4(
				skyColor.add( starsContribution ).add( sunContribution ).add( moonContribution ),
				float( 1.0 )
			);

		} )();

	}

}
