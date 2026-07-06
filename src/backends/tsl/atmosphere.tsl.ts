/**
 * Shared TSL helpers for the Hillaire atmosphere pipeline.
 *
 * Every export is a TSL `Fn` (or plain JS wrapper of TSL ops) that takes TSL
 * nodes and a plain `params` object whose fields are TSL `uniform(...)` nodes
 * (see `AtmosphereUniforms.js`). No JS-side math, no side effects. LUT shaders
 * call these with whichever params bundle they happen to hold.
 *
 * Ported from Sébastien Hillaire's reference implementation in:
 *   UnrealEngineSkyAtmosphere/Resources/SkyAtmosphereCommon.hlsl
 *   UnrealEngineSkyAtmosphere/Resources/RenderSkyCommon.hlsl
 *   UnrealEngineSkyAtmosphere/Resources/RenderSkyRayMarching.hlsl
 *
 * Units match Hillaire's: kilometers for lengths, 1/km for scattering coefficients.
 */

import {
	Fn,
	Loop,
	PI,
	vec2,
	vec3,
	float,
	max,
	min,
	sqrt,
	exp,
	dot,
	pow,
	saturate,
	clamp,
	length,
	normalize,
	cos,
	sin,
	acos,
	texture,
	select
} from 'three/tsl';

/**
 * Bruneton/Hillaire's UV correction helpers — account for linear-filter bias so
 * the first/last texel centres land exactly on the unit-interval endpoints.
 *
 * Unreal: RenderSkyCommon.hlsl:101-102.
 */
export function fromUnitToSubUvs( u, resolution ) {

	return u.add( float( 0.5 ).div( resolution ) ).mul( resolution.div( resolution.add( float( 1.0 ) ) ) );

}

export function fromSubUvsToUnit( u, resolution ) {

	return u.sub( float( 0.5 ).div( resolution ) ).mul( resolution.div( resolution.sub( float( 1.0 ) ) ) );

}

// Matches Hillaire's PLANET_RADIUS_OFFSET — a tiny offset used to avoid self-intersection
// when clipping rays to the atmosphere boundary.
const PLANET_RADIUS_OFFSET = 0.01;

/**
 * 3 / (16π) · (1 + cos²θ). Rayleigh scattering phase function.
 *
 * Unreal: `RayleighPhase` in RenderSkyCommon.hlsl.
 */
export const rayleighPhase = /*@__PURE__*/ Fn( ( [ cosTheta ] ) => {

	const factor = float( 3.0 ).div( float( 16.0 ).mul( PI ) );
	return factor.mul( float( 1.0 ).add( cosTheta.mul( cosTheta ) ) );

} );

/**
 * Cornette-Shanks Mie phase function — the phase function Hillaire actually uses.
 *
 * Unreal: `CornetteShanksMiePhaseFunction` in RenderSkyCommon.hlsl. Note the
 * `-cosTheta` in the denominator: that sign is part of the original formulation
 * and is intentional.
 */
export const miePhaseCS = /*@__PURE__*/ Fn( ( [ cosTheta, g ] ) => {

	const g2 = g.mul( g );
	const k = float( 3.0 ).div( float( 8.0 ).mul( PI ) )
		.mul( float( 1.0 ).sub( g2 ) )
		.div( float( 2.0 ).add( g2 ) );

	const num = float( 1.0 ).add( cosTheta.mul( cosTheta ) );
	const denomBase = float( 1.0 ).add( g2 ).sub( float( 2.0 ).mul( g ).mul( cosTheta.negate() ) );
	const denom = pow( denomBase, float( 1.5 ) );

	return k.mul( num ).div( denom );

} );

/**
 * Henyey-Greenstein phase function (reference, not Schlick approx).
 *
 * Unreal: the `#else` branch of `hgPhase` in RenderSkyCommon.hlsl. Exposed as an
 * alternative; not used in phase 1b (the sky uses Cornette-Shanks).
 */
export const hgPhase = /*@__PURE__*/ Fn( ( [ cosTheta, g ] ) => {

	const g2 = g.mul( g );
	const numer = float( 1.0 ).sub( g2 );
	const denom = float( 1.0 ).add( g2 ).add( float( 2.0 ).mul( g ).mul( cosTheta ) );
	return numer.div( float( 4.0 ).mul( PI ).mul( denom ).mul( sqrt( denom ) ) );

} );

/**
 * Nearest positive ray-sphere intersection distance, or -1 if no hit.
 *
 * Faithful port of `raySphereIntersectNearest` in SkyAtmosphereCommon.hlsl.
 * `rd` should be normalized (the HLSL relaxes this, but all our callers do).
 */
export const raySphereIntersectNearest = /*@__PURE__*/ Fn( ( [ ro, rd, center, radius ] ) => {

	const a = dot( rd, rd );
	const s0_r0 = ro.sub( center );
	const b = float( 2.0 ).mul( dot( rd, s0_r0 ) );
	const c = dot( s0_r0, s0_r0 ).sub( radius.mul( radius ) );
	const delta = b.mul( b ).sub( float( 4.0 ).mul( a ).mul( c ) );

	const noHit = delta.lessThan( 0.0 );

	const sqrtDelta = sqrt( max( delta, float( 0.0 ) ) );
	const denomInv = float( 1.0 ).div( max( float( 2.0 ).mul( a ), float( 1e-20 ) ) );
	const sol0 = b.negate().sub( sqrtDelta ).mul( denomInv );
	const sol1 = b.negate().add( sqrtDelta ).mul( denomInv );

	// Mirror the HLSL branching exactly:
	//   both < 0          -> -1
	//   sol0 < 0          -> max(0, sol1)
	//   sol1 < 0          -> max(0, sol0)
	//   otherwise         -> max(0, min(sol0, sol1))
	const bothNegative = sol0.lessThan( 0.0 ).and( sol1.lessThan( 0.0 ) );
	const onlySol0Neg = sol0.lessThan( 0.0 );
	const onlySol1Neg = sol1.lessThan( 0.0 );

	const candidate = select(
		bothNegative,
		float( - 1.0 ),
		select(
			onlySol0Neg,
			max( float( 0.0 ), sol1 ),
			select(
				onlySol1Neg,
				max( float( 0.0 ), sol0 ),
				max( float( 0.0 ), min( sol0, sol1 ) )
			)
		)
	);

	return select( noHit, float( - 1.0 ), candidate );

} );

/**
 * Evaluates per-component scattering / absorption / extinction at an altitude
 * above the planet surface. Mirrors Unreal's `sampleMediumRGB`.
 *
 * NOTE: HLSL passes a full `WorldPos` and computes `viewHeight` inside. To keep
 * the TSL helpers composable, we accept `height` (altitude above `bottomRadius`)
 * directly — callers do the `length(worldPos) - bottomRadius` themselves. This
 * matches the substance of `sampleMediumRGB` exactly.
 *
 * Returns a plain JS object of TSL vec3 nodes. Individual fields are regular
 * TSL vec3s so callers can pull whichever terms they need without incurring
 * a full struct.
 */
export function computeScatteringAbsorption( height, params ) {

	const densityMie = exp( params.mieDensityExpScale.mul( height ) );
	const densityRay = exp( params.rayleighDensityExpScale.mul( height ) );

	// Ozone tent: linear within layer 0, different linear past layer 0 width.
	// Unreal: saturate(viewHeight < AbsorptionDensity0LayerWidth ?
	//    AbsorptionDensity0LinearTerm*viewHeight + AbsorptionDensity0ConstantTerm :
	//    AbsorptionDensity1LinearTerm*viewHeight + AbsorptionDensity1ConstantTerm)
	const ozoneLayer0 = params.absorptionDensity0LinearTerm.mul( height )
		.add( params.absorptionDensity0ConstantTerm );
	const ozoneLayer1 = params.absorptionDensity1LinearTerm.mul( height )
		.add( params.absorptionDensity1ConstantTerm );
	const densityOzo = saturate( select(
		height.lessThan( params.absorptionDensity0LayerWidth ),
		ozoneLayer0,
		ozoneLayer1
	) );

	// Per-component split
	const scatteringMie = params.mieScattering.mul( densityMie );
	const absorptionMie = params.mieAbsorption.mul( densityMie );
	const extinctionMie = params.mieExtinction.mul( densityMie );

	const scatteringRay = params.rayleighScattering.mul( densityRay );
	// Rayleigh absorption is zero in this model
	const extinctionRay = scatteringRay;

	const scatteringOzo = vec3( 0.0, 0.0, 0.0 );
	const absorptionOzo = params.absorptionExtinction.mul( densityOzo );
	const extinctionOzo = absorptionOzo;

	const scattering = scatteringMie.add( scatteringRay ).add( scatteringOzo );
	const extinction = extinctionMie.add( extinctionRay ).add( extinctionOzo );

	return {
		rayleighScattering: scatteringRay,
		mieScattering: scatteringMie,
		mieExtinction: extinctionMie,
		mieAbsorption: absorptionMie,
		absorptionExtinction: absorptionOzo,
		scattering,
		extinction
	};

}

/**
 * If `worldPos` is above the atmosphere, clip the ray origin to the atmosphere
 * boundary (with the standard small `PLANET_RADIUS_OFFSET` back-off). If the
 * ray misses the atmosphere entirely, `valid` is false.
 *
 * Port of `MoveToTopAtmosphere` in RenderSkyCommon.hlsl.
 *
 * Returns `{ newPos: vec3, valid: bool }` as TSL nodes.
 */
export function moveToTopAtmosphere( worldPos, worldDir, params ) {

	const center = vec3( 0.0, 0.0, 0.0 );
	const viewHeight = length( worldPos );

	const tTop = raySphereIntersectNearest( worldPos, worldDir, center, params.topRadius );

	const upVector = worldPos.div( max( viewHeight, float( 1e-6 ) ) );
	const offset = upVector.mul( float( - PLANET_RADIUS_OFFSET ) );
	const clippedPos = worldPos.add( worldDir.mul( tTop ) ).add( offset );

	const aboveAtmo = viewHeight.greaterThan( params.topRadius );
	const missed = aboveAtmo.and( tTop.lessThan( 0.0 ) );

	const newPos = select( aboveAtmo, clippedPos, worldPos );
	const valid = missed.not();

	return { newPos, valid };

}

/**
 * Bruneton-parameterization UV → (viewHeight, viewZenithCosAngle) un-map used
 * by the Transmittance LUT. Port of `UvToLutTransmittanceParams`.
 *
 * Returns `{ viewHeight, viewZenithCosAngle }` as TSL float nodes.
 */
export function uvToTransmittanceLutParams( uvNode, params ) {

	const x_mu = uvNode.x;
	const x_r = uvNode.y;

	const topR2 = params.topRadius.mul( params.topRadius );
	const botR2 = params.bottomRadius.mul( params.bottomRadius );

	const H = sqrt( max( float( 0.0 ), topR2.sub( botR2 ) ) );
	const rho = H.mul( x_r );

	const viewHeight = sqrt( rho.mul( rho ).add( botR2 ) );

	const d_min = params.topRadius.sub( viewHeight );
	const d_max = rho.add( H );
	const d = d_min.add( x_mu.mul( d_max.sub( d_min ) ) );

	const viewZenithCosAngleRaw = select(
		d.lessThanEqual( float( 0.0 ) ),
		float( 1.0 ),
		H.mul( H ).sub( rho.mul( rho ) ).sub( d.mul( d ) )
			.div( max( float( 2.0 ).mul( viewHeight ).mul( d ), float( 1e-20 ) ) )
	);
	const viewZenithCosAngle = clamp( viewZenithCosAngleRaw, float( - 1.0 ), float( 1.0 ) );

	return { viewHeight, viewZenithCosAngle };

}

/**
 * (viewHeight, viewZenithCosAngle) → Bruneton UV used to sample the Transmittance LUT.
 * Port of `LutTransmittanceParamsToUv`. Exposed because the Multi-Scatter and
 * Sky-View LUTs need it when sampling transmittance along the marched ray.
 */
export function transmittanceLutParamsToUv( viewHeight, viewZenithCosAngle, params ) {

	const topR2 = params.topRadius.mul( params.topRadius );
	const botR2 = params.bottomRadius.mul( params.bottomRadius );

	const H = sqrt( max( float( 0.0 ), topR2.sub( botR2 ) ) );
	const rho = sqrt( max( float( 0.0 ), viewHeight.mul( viewHeight ).sub( botR2 ) ) );

	const discriminant = viewHeight.mul( viewHeight )
		.mul( viewZenithCosAngle.mul( viewZenithCosAngle ).sub( 1.0 ) )
		.add( topR2 );
	const d = max(
		float( 0.0 ),
		viewHeight.negate().mul( viewZenithCosAngle ).add( sqrt( max( discriminant, float( 0.0 ) ) ) )
	);

	const d_min = params.topRadius.sub( viewHeight );
	const d_max = rho.add( H );
	const x_mu = d.sub( d_min ).div( max( d_max.sub( d_min ), float( 1e-20 ) ) );
	const x_r = rho.div( max( H, float( 1e-20 ) ) );

	return vec2( x_mu, x_r );

}

/**
 * Hillaire's horizon-packed UV → (viewZenithCosAngle, lightViewCosAngle)
 * parameterization for the Sky-View LUT.
 *
 * Faithful port of `UvToSkyViewLutParams` in RenderSkyCommon.hlsl:122-154.
 * The clever bit is the non-linear V mapping that gives the horizon extra
 * texel density:
 *   - V ∈ [0, 0.5]   maps above the horizon. coord = 1 − 2V, then coord² then
 *                    1 − coord, so coord increases away from the horizon.
 *   - V ∈ [0.5, 1]   maps below the horizon. coord = 2V − 1, then coord².
 * The NONLINEARSKYVIEWLUT path (enabled in Unreal by default) applies the
 * squaring; we always use it.
 *
 * @param {object}     atmosphere     atmosphere-uniform bundle
 * @param {THREE.Node} viewHeight     float — length of ray origin from planet centre
 * @param {THREE.Node} uvNode         vec2 — the raw [0,1] UV being un-mapped
 * @returns {{ viewZenithCosAngle: THREE.Node, lightViewCosAngle: THREE.Node }}
 */
export function uvToSkyViewLutParams( atmosphere, viewHeight, uvNode ) {

	// Sub-UV correction (HLSL:125). Width/height hard-coded to 192/108 to match
	// the LUT_RESOLUTIONS.skyView defaults. If the LUT resolution is changed at
	// construction time, these constants need to follow — flagged in SkyViewLUT.js.
	const resX = float( 192.0 );
	const resY = float( 108.0 );
	const uCorr = fromSubUvsToUnit( uvNode.x, resX );
	const vCorr = fromSubUvsToUnit( uvNode.y, resY );

	const botR2 = atmosphere.bottomRadius.mul( atmosphere.bottomRadius );
	const vh2 = viewHeight.mul( viewHeight );
	// V_horizon = √(r² − R²) — horizon tangent length from the camera (HLSL:127).
	const vHorizon = sqrt( max( vh2.sub( botR2 ), float( 0.0 ) ) );
	const cosBeta = vHorizon.div( max( viewHeight, float( 1e-6 ) ) );
	const beta = acos( clamp( cosBeta, float( - 1.0 ), float( 1.0 ) ) );
	const zenithHorizonAngle = float( PI ).sub( beta );

	// ---- Above horizon branch (v < 0.5) ----
	const coordAbove0 = float( 2.0 ).mul( vCorr );
	const coordAbove1 = float( 1.0 ).sub( coordAbove0 );
	const coordAbove2 = coordAbove1.mul( coordAbove1 ); // NONLINEARSKYVIEWLUT
	const coordAbove3 = float( 1.0 ).sub( coordAbove2 );
	const vzAbove = cos( zenithHorizonAngle.mul( coordAbove3 ) );

	// ---- Below horizon branch (v >= 0.5) ----
	const coordBelow0 = vCorr.mul( 2.0 ).sub( 1.0 );
	const coordBelow1 = coordBelow0.mul( coordBelow0 ); // NONLINEARSKYVIEWLUT
	const vzBelow = cos( zenithHorizonAngle.add( beta.mul( coordBelow1 ) ) );

	const viewZenithCosAngle = select( vCorr.lessThan( 0.5 ), vzAbove, vzBelow );

	// Light-view cos: U is squared before being shifted to [-1,1] (HLSL:151-153).
	// Note the outer negation: U=0 → cos=+1 (sun in view dir), U=1 → cos=-1.
	const uSq = uCorr.mul( uCorr );
	const lightViewCosAngle = uSq.mul( 2.0 ).sub( 1.0 ).negate();

	return { viewZenithCosAngle, lightViewCosAngle };

}

/**
 * Forward map (viewZenithCosAngle, lightViewCosAngle, viewHeight, intersectsGround)
 * → Sky-View LUT UV. Mirror of `SkyViewLutParamsToUv` in RenderSkyCommon.hlsl:156-190.
 * The sky mesh in phase 2 will call this to sample the LUT for a given view ray.
 *
 * Inputs are TSL nodes for the three scalars plus a bool node (`intersectsGround`)
 * the caller computes by testing whether the view ray hits the planet.
 */
export function skyViewLutParamsToUv( atmosphere, intersectsGround, viewZenithCosAngle, lightViewCosAngle, viewHeight ) {

	const botR2 = atmosphere.bottomRadius.mul( atmosphere.bottomRadius );
	const vh2 = viewHeight.mul( viewHeight );
	const vHorizon = sqrt( max( vh2.sub( botR2 ), float( 0.0 ) ) );
	const cosBeta = vHorizon.div( max( viewHeight, float( 1e-6 ) ) );
	const beta = acos( clamp( cosBeta, float( - 1.0 ), float( 1.0 ) ) );
	const zenithHorizonAngle = float( PI ).sub( beta );

	const vzAcos = acos( clamp( viewZenithCosAngle, float( - 1.0 ), float( 1.0 ) ) );

	// ---- Sky branch (no ground intersection) ----
	const coordSky0 = vzAcos.div( max( zenithHorizonAngle, float( 1e-6 ) ) );
	const coordSky1 = float( 1.0 ).sub( coordSky0 );
	const coordSky2 = sqrt( max( coordSky1, float( 0.0 ) ) ); // NONLINEARSKYVIEWLUT
	const coordSky3 = float( 1.0 ).sub( coordSky2 );
	const uvY_sky = coordSky3.mul( 0.5 );

	// ---- Ground branch (view ray hits the planet) ----
	const coordGnd0 = vzAcos.sub( zenithHorizonAngle ).div( max( beta, float( 1e-6 ) ) );
	const coordGnd1 = sqrt( max( coordGnd0, float( 0.0 ) ) ); // NONLINEARSKYVIEWLUT
	const uvY_gnd = coordGnd1.mul( 0.5 ).add( 0.5 );

	const uvY = select( intersectsGround, uvY_gnd, uvY_sky );

	// X: sqrt((−lightView + 1)/2) (HLSL:183-186).
	const uvXraw = sqrt( saturate( lightViewCosAngle.negate().mul( 0.5 ).add( 0.5 ) ) );

	// Sub-UV correction.
	const resX = float( 192.0 );
	const resY = float( 108.0 );
	const uv = vec2(
		fromUnitToSubUvs( uvXraw, resX ),
		fromUnitToSubUvs( uvY, resY )
	);
	return uv;

}

/**
 * Stratified spherical sample direction used by the Multi-Scatter LUT builder.
 *
 * Port of the sample-direction math in RenderSkyRayMarching.hlsl:449-464. The
 * Unreal compute shader uses a 64-thread reduction, each thread picking one
 * (i, j) pair; we flatten that loop into the fragment shader but keep the
 * stratified sphere-point-picking identical:
 *   randA = (i + 0.5) / sqrtN
 *   randB = (j + 0.5) / sqrtN
 *   theta = 2π · randA           — azimuth
 *   phi   = acos(1 − 2 · randB)  — zenith (uniform sphere sampling)
 *
 * Caller passes `i`, `j` as float TSL nodes already offset by +0.5 (matches
 * the HLSL, which computes `float i = 0.5f + ThreadId.z / SQRTSAMPLECOUNT`).
 */
export const getSphericalDir = /*@__PURE__*/ Fn( ( [ iPlusHalf, jPlusHalf, sqrtSampleCount ] ) => {

	const randA = iPlusHalf.div( sqrtSampleCount );
	const randB = jPlusHalf.div( sqrtSampleCount );

	const theta = float( 2.0 ).mul( PI ).mul( randA );
	const phi = acos( float( 1.0 ).sub( float( 2.0 ).mul( randB ) ) );

	const cosPhi = cos( phi );
	const sinPhi = sin( phi );
	const cosTheta = cos( theta );
	const sinTheta = sin( theta );

	return vec3(
		cosTheta.mul( sinPhi ),
		sinTheta.mul( sinPhi ),
		cosPhi
	);

} );

/**
 * Hillaire's `IntegrateScatteredLuminance` inner loop, ported from
 * RenderSkyRayMarching.hlsl:24-260 for the MS-LUT configuration:
 *   ground = true, MieRayPhase = false, VariableSampleCount = false,
 *   MULTISCATAPPROX_ENABLED = false (we are *building* the MS LUT, so the
 *   feedback term is disabled), MULTI_SCATTERING_POWER_SERIE = 1.
 *
 * Because the MS LUT builder calls this many times per pixel (64 spherical
 * samples), `sampleCount` is fed in as a JS number so the step loop can be
 * unrolled at shader-compile time — same pattern as TransmittanceLUT. `globalL`
 * is fixed to `vec3(1)` (the ILLUMINANCE_IS_ONE path in the HLSL, line 101):
 * the MS LUT represents a light-independent transfer factor, not a radiance,
 * so it must be computed against unit illuminance.
 *
 * Returns a plain JS object of TSL nodes: `{ L, multiScatAs1, transmittance,
 * opticalDepth }` — callers use whichever fields they need.
 *
 * Caller is responsible for ensuring `worldPos` is already inside the atmosphere
 * (invoke `moveToTopAtmosphere` first if not) and that `worldDir` is normalized.
 *
 * @param {object} args
 * @param {THREE.Node} args.worldPos       vec3 — ray origin in planet-centred frame
 * @param {THREE.Node} args.worldDir       vec3 — normalized ray direction
 * @param {THREE.Node} args.sunDir         vec3 — normalized sun direction
 * @param {object}     args.params         atmosphere-uniform bundle
 * @param {THREE.Node} args.transmittanceLUT texture node of the Transmittance LUT
 * @param {number}     [args.sampleCount=20]  number of ray-march steps
 * @param {boolean}    [args.ground=true]     add ground-albedo bounce at tBottom
 * @param {boolean}    [args.mieRayPhase=false] use Mie+Rayleigh phases vs. isotropic
 * @param {THREE.Node} [args.multiScatterLUT] texture node of the Multi-Scatter LUT.
 *        When provided the per-step in-scatter picks up the
 *        `multiScatteredLuminance * medium.scattering` term (MULTISCATAPPROX_ENABLED
 *        branch in `RenderSkyRayMarching.hlsl:187-197`). When omitted, the
 *        MS-LUT-independent build is used — preserves the Transmittance/MS LUT
 *        callers' existing behaviour.
 * @param {THREE.Node} [args.tMaxOverride] optional float TSL node. When
 *        provided, the integrator marches *exactly* this distance instead of
 *        clipping to the ground/atmosphere boundary. Used by the Aerial
 *        Perspective LUT (each voxel marches a fixed depth-slice). Mirrors
 *        the `tMaxMax` parameter on Unreal's
 *        `IntegrateScatteredLuminance(..., tMaxMax)` overload at HLSL line 711.
 *        We still clip against the ground/top to avoid marching into rock or
 *        empty space — `tMax = min(tMaxOverride, sphere-clipped tMax)`.
 */
export function integrateScatteredLuminance( {
	worldPos,
	worldDir,
	sunDir,
	params,
	transmittanceLUT,
	sampleCount = 20,
	ground = true,
	mieRayPhase = false,
	multiScatterLUT = null,
	tMaxOverride = null,
	// Optional per-call float TSL node in [0, 1] used as the within-step
	// offset instead of the canonical SebH constant (`0.3`). When every
	// pixel shares the same fixed offset, neighbouring pixels with
	// near-identical `tMax` accumulate optical depth at structurally
	// aligned sample altitudes, producing visible banding in the
	// transmittance (alpha) channel — most obvious from altitude on
	// long horizon-grazing rays. Passing a per-pixel hash here breaks
	// the coherence; the noise then averages out across screen-space
	// neighbours rather than aligning into bands.
	// extEpsNode — optional TSL float: minimum extinction for division; default 1e-6.
	sampleJitter = null,
	extEpsNode = undefined
} ) {

	const earthO = vec3( 0.0, 0.0, 0.0 );
	const SAMPLE_SEGMENT_T = 0.3;
	const segmentT = sampleJitter ? sampleJitter : float( SAMPLE_SEGMENT_T );

	// Epsilon for extinction / power-serie (Frostbite); override via extEpsNode for tuning.
	const extEps = extEpsNode !== undefined && extEpsNode !== null
		? extEpsNode
		: float( 1e-6 );

	// ---- tMax: intersect with ground/top, mirroring the HLSL branching ----
	const tBottom = raySphereIntersectNearest( worldPos, worldDir, earthO, params.bottomRadius );
	const tTop = raySphereIntersectNearest( worldPos, worldDir, earthO, params.topRadius );

	const tMaxIfNoBottom = tTop.lessThan( 0.0 ).select( float( 0.0 ), tTop );
	const tMaxIfBoth = tTop.greaterThan( 0.0 ).select( tTop.min( tBottom ), tBottom );
	const tMaxClipped = tBottom.lessThan( 0.0 ).select( tMaxIfNoBottom, tMaxIfBoth );
	const tMax = ( tMaxOverride ? min( tMaxClipped, tMaxOverride ) : tMaxClipped ).toVar();

	// ---- phase functions (constant per ray) ----
	const uniformPhase = float( 1.0 ).div( float( 4.0 ).mul( PI ) );
	const cosTheta = dot( sunDir, worldDir );
	const miePhaseValue = hgPhase( cosTheta.negate(), params.miePhaseG );
	const rayleighPhaseValue = rayleighPhase( cosTheta );

	// ---- accumulators ----
	const L = vec3( 0.0, 0.0, 0.0 ).toVar();
	const throughput = vec3( 1.0, 1.0, 1.0 ).toVar();
	const opticalDepth = vec3( 0.0, 0.0, 0.0 ).toVar();
	const multiScatAs1 = vec3( 0.0, 0.0, 0.0 ).toVar();

	const tPrev = float( 0.0 ).toVar();

	// Ray-march loop. Runs on-GPU via TSL Loop (not JS-unrolled) so that callers
	// doing per-pixel spherical integration (MS LUT: 64 directions) don't produce
	// catastrophically large shaders. Accumulators above use `.toVar()` and
	// therefore carry state across iterations.
	Loop( { start: 0, end: sampleCount, type: 'int' }, ( { i } ) => {

		const newT = tMax.mul( float( i ).add( segmentT ).div( float( sampleCount ) ) );
		const dt = newT.sub( tPrev );

		const P = worldPos.add( worldDir.mul( newT ) );
		const pHeight = length( P );
		const altitude = pHeight.sub( params.bottomRadius );
		const upVector = P.div( max( pHeight, float( 1e-6 ) ) );

		const medium = computeScatteringAbsorption( altitude, params );
		const extSafe = max( medium.extinction, vec3( extEps, extEps, extEps ) );
		const sampleOpticalDepth = medium.extinction.mul( dt );
		const sampleTransmittance = exp( sampleOpticalDepth.negate() );
		opticalDepth.addAssign( sampleOpticalDepth );

		// Transmittance to sun via the Transmittance LUT.
		const sunZenithCos = dot( sunDir, upVector );
		const tLutUv = transmittanceLutParamsToUv( pHeight, sunZenithCos, params );
		const transmittanceToSun = texture( transmittanceLUT, tLutUv ).rgb;

		// Phase * scattering: isotropic branch (MS LUT) vs. Mie+Rayleigh branch.
		const phaseTimesScattering = mieRayPhase
			? medium.mieScattering.mul( miePhaseValue ).add( medium.rayleighScattering.mul( rayleighPhaseValue ) )
			: medium.scattering.mul( uniformPhase );

		// Earth shadow: block sun if a ground intersection exists along the sun ray.
		// HLSL line 181 biases the sphere centre by PLANET_RADIUS_OFFSET*UpVector;
		// we equivalently bias the ray *origin* outward by the same amount.
		const shadowOrigin = P.add( upVector.mul( float( PLANET_RADIUS_OFFSET ) ) );
		const tEarth = raySphereIntersectNearest( shadowOrigin, sunDir, earthO, params.bottomRadius );
		const earthShadow = select( tEarth.greaterThanEqual( 0.0 ), float( 0.0 ), float( 1.0 ) );

		// Per-step in-scatter. globalL = 1 (ILLUMINANCE_IS_ONE).
		// When a Multi-Scatter LUT is supplied we add its contribution, matching
		// RenderSkyRayMarching.hlsl:197:
		//   S = globalL * (earthShadow * TransmittanceToSun * PhaseTimesScattering
		//                  + multiScatteredLuminance * medium.scattering)
		// The MS LUT is sampled at (cosSunZenith*0.5+0.5, altitude01); see
		// RenderSkyCommon.hlsl:410 (GetMultipleScattering).
		const directInScatter = earthShadow.mul( transmittanceToSun ).mul( phaseTimesScattering );
		let S;
		if ( multiScatterLUT ) {

			const atmosphereThickness = params.topRadius.sub( params.bottomRadius );
			const altitude01 = saturate( altitude.div( max( atmosphereThickness, float( 1e-6 ) ) ) );
			const msUvRaw = vec2( sunZenithCos.mul( 0.5 ).add( 0.5 ), altitude01 );
			// fromUnitToSubUvs with 32×32 — matches HLSL's sample in GetMultipleScattering.
			const msRes = float( 32.0 );
			const msUvX = msUvRaw.x.add( float( 0.5 ).div( msRes ) ).mul( msRes.div( msRes.add( float( 1.0 ) ) ) );
			const msUvY = msUvRaw.y.add( float( 0.5 ).div( msRes ) ).mul( msRes.div( msRes.add( float( 1.0 ) ) ) );
			const multiScatteredLuminance = texture( multiScatterLUT, vec2( msUvX, msUvY ) ).rgb;
			S = directInScatter.add( multiScatteredLuminance.mul( medium.scattering ) );

		} else {

			S = directInScatter;

		}

		// MULTI_SCATTERING_POWER_SERIE=1 integration (Frostbite slide 28):
		//   Sint = (S - S * T_segment) / extinction
		const Sint = S.sub( S.mul( sampleTransmittance ) ).div( extSafe );
		L.addAssign( throughput.mul( Sint ) );

		// f_ms (MultiScatAs1) accumulator — scattering * 1 integrated with the
		// same power-serie trick. Assumes uniform phase = 1; the final isotropic
		// division happens after the outer spherical sum.
		const MS = medium.scattering; // scattering * 1
		const MSint = MS.sub( MS.mul( sampleTransmittance ) ).div( extSafe );
		multiScatAs1.addAssign( throughput.mul( MSint ) );

		throughput.assign( throughput.mul( sampleTransmittance ) );
		tPrev.assign( newT );

	} );

	// Ground-bounce contribution. See HLSL lines 240-254. Only active when
	// tMax equals tBottom (ray actually reaches the ground). We test
	// `tBottom > 0` to avoid firing when the ray missed both spheres.
	if ( ground ) {

		const hitGround = tBottom.greaterThan( 0.0 ).and( tMax.equal( tBottom ) );

		const P = worldPos.add( worldDir.mul( tBottom ) );
		const pHeight = length( P );
		const upVector = P.div( max( pHeight, float( 1e-6 ) ) );
		const sunZenithCos = dot( sunDir, upVector );
		const tLutUv = transmittanceLutParamsToUv( pHeight, sunZenithCos, params );
		const transmittanceToSun = texture( transmittanceLUT, tLutUv ).rgb;
		const NdotL = saturate( dot( normalize( upVector ), normalize( sunDir ) ) );
		const groundL = transmittanceToSun.mul( throughput ).mul( NdotL )
			.mul( params.groundAlbedo ).div( PI );

		L.assign( select( hitGround, L.add( groundL ), L ) );

	}

	return { L, multiScatAs1, transmittance: throughput, opticalDepth };

}
