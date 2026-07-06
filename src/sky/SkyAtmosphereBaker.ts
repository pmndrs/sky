import {
	Mesh,
	Scene,
	CubeCamera,
	CubeRenderTarget,
	PMREMGenerator,
	HalfFloatType,
	LinearFilter,
	LinearMipmapLinearFilter,
	Vector3,
	MathUtils
} from 'three/webgpu';

import { EARTH, mergeAtmosphereParams } from './AtmosphereParams.js';
import { createAtmosphereUniforms, updateAtmosphereUniforms } from './AtmosphereUniforms.js';
import { LUT_RESOLUTIONS } from './luts/resolutions.js';
import { TransmittanceLUT } from './luts/TransmittanceLUT.js';
import { MultiScatterLUT } from './luts/MultiScatterLUT.js';
import { SkyViewLUT } from './luts/SkyViewLUT.js';
import { AerialPerspectiveLUT } from './luts/AerialPerspectiveLUT.js';
import { SkyAtmosphereMesh } from './SkyAtmosphereMesh.js';

/**
 * Phase 1b baker.
 *
 * Owns the three-LUT Hillaire pipeline (Transmittance → MultiScatter → SkyView)
 * and a visible `SkyAtmosphereMesh` that samples the Sky-View LUT. The mesh is
 * rendered into a CubeRenderTarget by a CubeCamera, then PMREM-filtered for
 * `scene.environment`.
 *
 * Public API is stable from phase 1a:
 *  - constructor(renderer, { cubeSize = 256, atmosphere?, lutResolutions? })
 *  - setSun({ elevation, azimuth })        — degrees
 *  - setAtmosphereParams(partial)          — merges onto current params
 *  - markCubeDirty()                       — force next update() to re-bake
 *  - update()                              — caller-driven; re-runs only dirty stages
 *  - .texture                              — raw cube (for scene.background)
 *  - .environmentTexture                   — PMREM-filtered (for scene.environment)
 *  - .sky                                  — the SkyAtmosphereMesh (for GUI access)
 *  - dispose()
 *
 * Dirty-flag semantics:
 *   atmosDirty  → Transmittance + MultiScatter + SkyView + cube + PMREM
 *   sunDirty    → SkyView + cube + PMREM          (T and MS do not depend on sun)
 *   cubeDirty   → cube + PMREM                    (e.g. markCubeDirty after direct mutation)
 *   cameraDirty → SkyView + AP                    (camera moved; only LUTs that read
 *                                                  viewHeight / camera matrices refresh)
 *
 * Phase 2 additions:
 *   - `setCamera(camera)`: feeds the main camera's height into SkyView LUT and
 *     mesh, and matrices into the AP LUT.
 *   - `updateAerialPerspective()`: renders just the AP LUT (per-frame), since
 *     it depends on camera position/orientation that change every frame.
 *   - `aerialPerspectiveTexture`: 3D texture consumers (the haze post-process)
 *     read to apply atmospheric haze on opaque scene geometry.
 */
export class SkyAtmosphereBaker {

	constructor( renderer, {
		cubeSize = 256,
		atmosphere,
		lutResolutions,
		enableAerialPerspective = true,
		// AP coverage knobs — exposed at the baker level so callers can opt
		// into orbit-friendly long-range AP without reaching into the LUT.
		// Default 8 km/slice × 32 slices = 256 km, matching SebH's reference
		// for a ground-level demo. For planet-scale views (camera at 100 km+
		// altitude looking down at a globe) bump kmPerSlice to ~32 for
		// ~1024 km coverage at the cost of close-range slice resolution.
		// Whatever value lands here MUST match the `kmPerSlice` passed to
		// `createHazeOutputNode` so the LUT and the consumer agree.
		apKmPerSlice = 8.0,
		// Optional AP volume resolution override for diagnostics / high-cost
		// quality tests. Default stays inside AerialPerspectiveLUT (32³).
		apResolution = undefined,
		// When true, the cube bake folds the sky mesh's below-horizon view
		// rays to above-horizon before the LUT sample — the lower hemisphere
		// of `texture` and `environmentTexture` becomes a clean Y-mirror of
		// the upper hemisphere instead of the LUT's lit-ground-albedo
		// content. Useful when the consumer scene has reflective floors or
		// uses `GroundedSkybox` in reflective mode, so PBR IBL doesn't pick
		// up a coloured ground tint from below.
		//
		// Implementation: toggles the sky mesh's `mirrorBelowHorizon`
		// uniform on for the cube bake only (live mesh in main scene
		// continues to show real below-horizon LUT content). Zero extra
		// render passes — the cube bake itself is unchanged in cost.
		//
		// Off by default; callers must opt in.
		mirrorBelowHorizon = false
	} = {} ) {

		this.renderer = renderer;
		this.cubeSize = cubeSize;
		this.lutResolutions = { ...LUT_RESOLUTIONS, ...( lutResolutions || {} ) };

		// --- atmosphere params + TSL uniform bundle ---
		this.atmosphereParams = mergeAtmosphereParams( EARTH, atmosphere );
		this.atmosphereUniforms = createAtmosphereUniforms( this.atmosphereParams );

		// --- LUT pipeline ---
		this.transmittanceLUT = new TransmittanceLUT( renderer, {
			resolution: this.lutResolutions.transmittance,
			atmosphereUniforms: this.atmosphereUniforms
		} );

		this.multiScatterLUT = new MultiScatterLUT( renderer, {
			resolution: this.lutResolutions.multiScatter,
			atmosphereUniforms: this.atmosphereUniforms,
			transmittanceLUT: this.transmittanceLUT
		} );

		this.skyViewLUT = new SkyViewLUT( renderer, {
			resolution: this.lutResolutions.skyView,
			atmosphereUniforms: this.atmosphereUniforms,
			transmittanceLUT: this.transmittanceLUT,
			multiScatterLUT: this.multiScatterLUT
		} );

		// --- aerial perspective LUT (phase 2; optional — caller may opt out) ---
		if ( enableAerialPerspective ) {

			this.aerialPerspectiveLUT = new AerialPerspectiveLUT( renderer, {
				resolution: apResolution,
				atmosphereUniforms: this.atmosphereUniforms,
				transmittanceLUT: this.transmittanceLUT,
				multiScatterLUT: this.multiScatterLUT,
				kmPerSlice: apKmPerSlice
			} );
			this.apKmPerSlice = apKmPerSlice;

		} else {

			this.aerialPerspectiveLUT = null;
			this.apKmPerSlice = apKmPerSlice;

		}

		// --- sky scene + Hillaire mesh ---
		// Pass T+MS LUTs so the mesh's space-view raymarch fallback is wired.
		this.skyScene = new Scene();
		this.sky = new SkyAtmosphereMesh( {
			atmosphereUniforms: this.atmosphereUniforms,
			skyViewLUT: this.skyViewLUT,
			transmittanceLUT: this.transmittanceLUT,
			multiScatterLUT: this.multiScatterLUT
		} );
		this.sky.scale.setScalar( 450000 );
		this.skyScene.add( this.sky );

		// --- cube render target ---
		this.cubeRenderTarget = new CubeRenderTarget( cubeSize, {
			type: HalfFloatType,
			minFilter: LinearMipmapLinearFilter,
			magFilter: LinearFilter,
			generateMipmaps: true
		} );

		// --- cube camera ---
		// near/far chosen so the sky box (scaled 450000) is fully enclosed
		this.cubeCamera = new CubeCamera( 1, 1_000_000, this.cubeRenderTarget );
		this.skyScene.add( this.cubeCamera );

		// --- mirror-below-horizon flag (toggled per bake in update()) ---
		this._mirrorBelowHorizon = mirrorBelowHorizon;

		// --- PMREM ---
		this.pmremGenerator = new PMREMGenerator( renderer );
		this.pmremGenerator.compileCubemapShader();
		// Allocated lazily on first bake; reused across subsequent bakes so
		// `environmentTexture` keeps stable identity (see update() for why).
		this._pmremTarget = null;

		// --- dirty flags (all true on construction → first update() does a full bake) ---
		this.sunDirty = true;
		this.atmosDirty = true;
		this.cubeDirty = true;
		this.cameraDirty = true;

		// Y-up world-space sun vector; assigned on setSun().
		this._sunVec = new Vector3( 0.0, 1.0, 0.0 );

		// Observers fired at the end of setSun(). SkySun uses this to keep a
		// DirectionalLight in lockstep without per-frame polling.
		this._sunListeners = new Set();

		// Camera handle, set by setCamera(). Used to refresh per-frame uniforms
		// (viewHeight on SkyView/mesh; matrices on AP LUT).
		this._camera = null;
		this._cameraPositionKm = new Vector3( 0.0, this.atmosphereUniforms.bottomRadius.value + 0.001, 0.0 );
		this._cameraUp = new Vector3( 0.0, 1.0, 0.0 );
		this._cameraAltitudeM = 1.0;

	}

	get texture() {

		return this.cubeRenderTarget.texture;

	}

	get environmentTexture() {

		return this._pmremTarget ? this._pmremTarget.texture : null;

	}

	/** 3D Aerial Perspective LUT texture (phase 2). `null` if AP was disabled. */
	get aerialPerspectiveTexture() {

		return this.aerialPerspectiveLUT ? this.aerialPerspectiveLUT.texture : null;

	}

	get cameraPositionKm() {

		return this._cameraPositionKm;

	}

	get cameraAltitudeM() {

		return this._cameraAltitudeM;

	}

	get cameraUp() {

		return this._cameraUp;

	}

	/**
	 * Phase 2: bind the main scene camera. Updates viewHeight on the
	 * Sky-View LUT and mesh (so altitude is reflected in the sky), and
	 * matrices on the AP LUT (so haze depth volume is camera-aligned).
	 *
	 * Should be called every frame the camera moves. Sets `cameraDirty` so
	 * the next `update()` refreshes Sky-View. The AP LUT is updated by the
	 * separate `updateAerialPerspective()` since it needs to fire every frame
	 * regardless of any flags.
	 */
	setCamera( camera, { planetCenter = null } = {} ) {

		this._camera = camera;
		camera.updateMatrixWorld();

		const bottomR = this.atmosphereUniforms.bottomRadius.value;
		const bottomRadiusM = bottomR * 1000.0;
		let viewHeightKm;

		if ( planetCenter ) {

			const cameraFromCenterM = camera.position.clone().sub( planetCenter );
			const cameraRadiusM = cameraFromCenterM.length();
			viewHeightKm = cameraRadiusM * 0.001;
			this._cameraAltitudeM = cameraRadiusM - bottomRadiusM;
			this._cameraUp.copy( cameraFromCenterM ).normalize();
			this._cameraPositionKm.copy( cameraFromCenterM ).multiplyScalar( 0.001 );

		} else {

			// Backwards-compatible flat-ground convention: y = altitude in metres.
			viewHeightKm = bottomR + camera.position.y * 0.001;
			this._cameraAltitudeM = camera.position.y;
			this._cameraUp.set( 0.0, 1.0, 0.0 );
			this._cameraPositionKm.set( 0.0, viewHeightKm, 0.0 );

		}

		this.skyViewLUT.viewHeight = viewHeightKm;
		this.sky.viewHeight.value = viewHeightKm;
		this.sky.upVector.value.copy( this._cameraUp );

		if ( this.aerialPerspectiveLUT ) {

			this.aerialPerspectiveLUT.setCamera( camera, { planetCenter } );

		}

		this.cameraDirty = true;

	}

	/**
	 * Set sun direction from (elevation, azimuth) in degrees. Convention matches
	 * the legacy example:
	 *   phi   = 90 - elevation   (polar angle from +Y)
	 *   theta = azimuth
	 *
	 * The resulting Y-up world vector goes to the sky mesh. The SkyView LUT lives
	 * in a Z-up local frame; we feed it a vector whose z-component equals the
	 * sun's zenith cosine (= sin(elevation) = world.y) so its internal
	 * `dot(up=(0,0,1), sunDir)` lands on the correct value. The LUT does not use
	 * sun azimuth internally — azimuth is consumed by the mesh at sample time via
	 * `lightViewCosAngle`.
	 */
	setSun( { elevation, azimuth } ) {

		const phi = MathUtils.degToRad( 90 - elevation );
		const theta = MathUtils.degToRad( azimuth );

		this._sunVec.setFromSphericalCoords( 1, phi, theta );

		// Y-up world sun → mesh uniform (same Vector3 instance is safe; uniform
		// tracks the internal reference).
		this.sky.sunDirection.value.copy( this._sunVec );

		// Z-up sun for SkyView LUT: only z matters (= sin(elevation)).
		const elevRad = MathUtils.degToRad( elevation );
		const cosE = Math.cos( elevRad );
		const sinE = Math.sin( elevRad );
		this.skyViewLUT.sunDirection = new Vector3( cosE, 0.0, sinE );

		// AP LUT consumes the Y-up world sun directly (matches the integrator's
		// frame-invariant scalar-only consumption).
		if ( this.aerialPerspectiveLUT ) {

			this.aerialPerspectiveLUT.setSunDirection( this._sunVec );

		}

		this.sunDirty = true;
		this.cubeDirty = true;

		for ( const fn of this._sunListeners ) fn( this._sunVec );

	}

	/**
	 * Subscribe to sun-direction changes. The listener fires after every
	 * `setSun()` call with the current Y-up world-space sun vector (passed by
	 * reference — clone in your callback if you need to keep a copy).
	 *
	 * @param {(sunVec: Vector3) => void} fn
	 * @returns {() => void} unsubscribe function
	 */
	addSunListener( fn ) {

		this._sunListeners.add( fn );
		return () => this._sunListeners.delete( fn );

	}

	removeSunListener( fn ) {

		this._sunListeners.delete( fn );

	}

	setAtmosphereParams( partial ) {

		this.atmosphereParams = mergeAtmosphereParams( this.atmosphereParams, partial );
		updateAtmosphereUniforms( this.atmosphereUniforms, this.atmosphereParams );

		this.atmosDirty = true;
		this.cubeDirty = true;

	}

	/**
	 * Mark the cube bake as stale. Useful when something mutated sky uniforms
	 * directly without going through setSun/setAtmosphereParams.
	 */
	markCubeDirty() {

		this.cubeDirty = true;

	}

	/**
	 * Toggle the below-horizon Y-mirror on the cube bake. When `true`, the
	 * next bake fills the cube's lower hemisphere with a clean Y-mirror of
	 * the sky instead of the LUT's lit-ground-albedo content; the live sky
	 * mesh in the main scene is unaffected. Forces a cube re-bake.
	 */
	setMirrorBelowHorizon( flag ) {

		this._mirrorBelowHorizon = !! flag;
		this.cubeDirty = true;

	}

	/**
	 * Mode B factory — return a sky mesh that the caller can add to their main
	 * scene as a far-plane background. Shares the underlying material and
	 * uniforms with the baker's internal `this.sky`, so `setSun` / `setCamera`
	 * propagate automatically to both meshes.
	 *
	 * Use this when you want a *live* sky (per-frame `setCamera`-driven Sky-View
	 * sample, sun-disc visible) instead of using `baker.texture` as a static
	 * `scene.background`. The cube bake still runs on sun-dirty for IBL — the
	 * filtered `baker.environmentTexture` remains the recommended
	 * `scene.environment`.
	 *
	 * Sun disc is enabled by default on the live mesh (cube bake still
	 * temporarily forces it off during the bake to keep PMREM clean).
	 *
	 * @param {object} [opts]
	 * @param {number} [opts.scale=450000] uniform scale of the sky box.
	 * @param {boolean} [opts.showSunDisc=true] flip the disc on for all meshes
	 *   sharing this material; the cube bake still hides it.
	 * @returns {THREE.Mesh}
	 */
	createSkyMesh( { scale = 450000, showSunDisc = true } = {} ) {

		// Shared material → shared uniform nodes → setSun / setCamera updates
		// hit both meshes. Re-using the same geometry is also fine.
		const mesh = new Mesh( this.sky.geometry, this.sky.material );
		mesh.scale.setScalar( scale );
		mesh.frustumCulled = false;
		// Render before opaque geometry so depth writes from the scene cover the
		// far-plane sky correctly. depthWrite is already off on the material.
		mesh.renderOrder = - 1;

		if ( showSunDisc ) this.sky.showSunDisc.value = 1.0;

		return mesh;

	}

	/**
	 * Caller-driven. Does nothing unless something is dirty. Re-runs only the
	 * stages of the pipeline whose inputs changed.
	 */
	update() {

		const skyDirty = this.atmosDirty || this.sunDirty || this.cameraDirty;
		if ( ! this.cubeDirty && ! skyDirty ) return;

		// 1. LUTs
		if ( this.atmosDirty ) {

			this.transmittanceLUT.render();
			this.multiScatterLUT.render();
			this.skyViewLUT.render();

		} else if ( this.sunDirty || this.cameraDirty ) {

			// T and MS are sun-/camera-independent; only SkyView needs a refresh.
			this.skyViewLUT.render();

		}

		// 2. Cube bake — sun disc OFF to keep PMREM clean (see PLAN.md risk #3).
		// Skip the cube re-bake if only camera moved without other state change
		// (the IBL doesn't care about main-camera position).
		const skyContentChanged = this.atmosDirty || this.sunDirty || this.cubeDirty;
		if ( skyContentChanged ) {

			const prevShowSunDisc = this.sky.showSunDisc.value;
			const prevShowMoonDisc = this.sky.showMoonDisc.value;
			const prevMirror = this.sky.mirrorBelowHorizon.value;
			this.sky.showSunDisc.value = 0;
			this.sky.showMoonDisc.value = 0;
			// Opt-in: fold below-horizon view rays to above-horizon so the
			// cube's lower hemisphere bakes a clean Y-mirror of the sky
			// instead of the LUT's lit-ground-albedo colour.
			this.sky.mirrorBelowHorizon.value = this._mirrorBelowHorizon ? 1.0 : 0.0;

			this.cubeCamera.update( this.renderer, this.skyScene );

			this.sky.showSunDisc.value = prevShowSunDisc;
			this.sky.showMoonDisc.value = prevShowMoonDisc;
			this.sky.mirrorBelowHorizon.value = prevMirror;

			// 3. PMREM. WebGPU PMREMGenerator exposes `fromCubemap( texture, target? )`
			// (not the WebGL-style `fromCubeRenderTarget`). Pass our persistent
			// target so the output texture identity stays stable across bakes —
			// otherwise `scene.environment` gets a new texture object every tick,
			// which invalidates the TSL pipeline cache for every material that
			// references the environment node and stalls the next render() badly
			// (see Changelog 0.1.3).
			if ( this._pmremTarget === null ) {

				this._pmremTarget = this.pmremGenerator.fromCubemap( this.cubeRenderTarget.texture );

			} else {

				this.pmremGenerator.fromCubemap( this.cubeRenderTarget.texture, this._pmremTarget );

			}

		}

		this.sunDirty = false;
		this.atmosDirty = false;
		this.cubeDirty = false;
		this.cameraDirty = false;

	}

	/**
	 * Run the per-frame Aerial Perspective LUT compute pass. Caller invokes
	 * each frame after `setCamera()` has been called. Cheap (~1ms on mid GPU).
	 *
	 * Separated from `update()` because AP must refresh per frame regardless
	 * of dirty flags, while `update()` is dirty-driven.
	 */
	async updateAerialPerspective() {

		if ( ! this.aerialPerspectiveLUT ) return;
		await this.aerialPerspectiveLUT.render();

	}

	dispose() {

		this.transmittanceLUT.dispose();
		this.multiScatterLUT.dispose();
		this.skyViewLUT.dispose();
		if ( this.aerialPerspectiveLUT ) this.aerialPerspectiveLUT.dispose();

		this.cubeRenderTarget.dispose();
		if ( this._pmremTarget ) this._pmremTarget.dispose();
		this.pmremGenerator.dispose();

		if ( this.sky.material ) this.sky.material.dispose();
		if ( this.sky.geometry ) this.sky.geometry.dispose();

		this.skyScene.remove( this.sky );
		this.skyScene.remove( this.cubeCamera );

	}

}
