import {
	HalfFloatType,
	LinearFilter,
	RepeatWrapping
} from 'three/webgpu';

/**
 * Opt-in night-sky stars layer for `tsl-sky`.
 *
 * Two source modes, both attenuated by camera→space transmittance (so they
 * fade naturally through twilight) and occluded by the planet:
 *
 *  - `'procedural'` (default) — shader-generated hash-grid starfield. Zero
 *    asset cost, zero load time. Ideal for the 80% case: games, viz,
 *    real-time tooling. No Milky Way / constellations.
 *
 *  - `'hdri'` — sample an equirectangular HDR cube the caller provides. Ideal
 *    for photoreal night scenes. Caller MUST pass `{ url }` or
 *    `{ texture }` — the bundled `examples/hdri/NightSkyHDRI001_1K_HDR.exr`
 *    is for the demo only and is not included in the published package.
 *
 * Stars also flow into the IBL automatically via the cube re-bake (`enable`,
 * `setSource`, `setIntensity`, etc. all call `markCubeDirty`), so PBR
 * objects pick up a soft star ambient with no extra plumbing.
 *
 * Usage:
 * ```js
 * await sky.enableStars();                                    // procedural
 * await sky.enableStars({ density: 0.5, brightness: 1.5 });   // procedural, tuned
 * await sky.enableStars({ source: 'hdri', url: '/stars.exr' });
 * await sky.enableStars({ source: 'hdri', texture: myTex });
 * ```
 */
export class SkyNight {

	constructor( sky ) {

		this.sky = sky;
		this.mesh = sky.baker.sky;
		this.texture = null;
		this.source = 'procedural';
		this._enabled = false;

	}

	get intensity() {

		return this.mesh.starsIntensity.value;

	}

	set intensity( value ) {

		this.mesh.starsIntensity.value = value;
		this.sky.baker.markCubeDirty();

	}

	get rotation() {

		return this.mesh.starsRotation.value;

	}

	set rotation( value ) {

		this.mesh.starsRotation.value = value;
		this.sky.baker.markCubeDirty();

	}

	get density() {

		return this.mesh.starsDensity.value;

	}

	set density( value ) {

		this.mesh.starsDensity.value = value;
		this.sky.baker.markCubeDirty();

	}

	get brightness() {

		return this.mesh.starsBrightnessScale.value;

	}

	set brightness( value ) {

		this.mesh.starsBrightnessScale.value = value;
		this.sky.baker.markCubeDirty();

	}

	setIntensity( value ) {

		this.intensity = value;
		return this;

	}

	setRotation( radians ) {

		this.rotation = radians;
		return this;

	}

	setDensity( value ) {

		this.density = value;
		return this;

	}

	setBrightness( value ) {

		this.brightness = value;
		return this;

	}

	/**
	 * Switch source live. Procedural keeps any HDR loaded but stops sampling
	 * it; HDR requires the texture to already be bound (call `enable` with a
	 * `url` or `texture` first, then `setSource('hdri')` is a no-op).
	 *
	 * @param {'procedural'|'hdri'} source
	 */
	setSource( source ) {

		if ( source !== 'procedural' && source !== 'hdri' ) {

			throw new Error( `SkyNight: unknown source "${ source }". Use 'procedural' or 'hdri'.` );

		}

		if ( source === 'hdri' && ! this.texture ) {

			console.warn(
				'[SkyNight] setSource(\'hdri\') called but no texture is bound. Call enable({ source: \'hdri\', url }) first.'
			);

		}

		this.source = source;
		this.mesh.starsMode.value = source === 'hdri' ? 1.0 : 0.0;
		this.sky.baker.markCubeDirty();
		return this;

	}

	/**
	 * Turn stars on. Async because the `'hdri'` path may need to load.
	 *
	 * @param {object} [opts]
	 * @param {'procedural'|'hdri'} [opts.source='procedural']
	 * @param {string} [opts.url] HDR equirect URL (required for `'hdri'` if
	 *   no `texture` is supplied). EXR or HDR formats supported.
	 * @param {THREE.Texture} [opts.texture] pre-loaded equirect texture; skips
	 *   the loader entirely. Implies `source: 'hdri'`.
	 * @param {number} [opts.intensity=1.0] linear stars multiplier.
	 * @param {number} [opts.rotation=0.0] starting rotation in radians.
	 * @param {number} [opts.density=0.3] procedural density (ignored for HDR).
	 * @param {number} [opts.brightness=1.0] procedural brightness (ignored for HDR).
	 * @returns {Promise<SkyNight>}
	 */
	async enable( {
		source,
		url,
		texture: existingTexture,
		intensity = 1.0,
		rotation = 0.0,
		density,
		brightness
	} = {} ) {

		// Infer source: explicit `texture` or `url` implies HDR; otherwise
		// fall back to whatever the caller asked for, defaulting procedural.
		const resolvedSource = source
			|| ( existingTexture || url ? 'hdri' : 'procedural' );

		if ( resolvedSource === 'hdri' ) {

			if ( existingTexture ) {

				this.texture = existingTexture;

			} else if ( url ) {

				this.texture = await _loadEquirectHDR( url );

			} else {

				throw new Error(
					'SkyNight: source: \'hdri\' requires { url } or { texture }. The bundled NightSkyHDRI is an example asset only — see examples/14-night-sky.html for usage.'
				);

			}

			// Match the placeholder's filter/wrap so the swap doesn't trip a
			// format-mismatch reupload.
			this.texture.minFilter = LinearFilter;
			this.texture.magFilter = LinearFilter;
			this.texture.wrapS = RepeatWrapping;
			this.texture.wrapT = RepeatWrapping;
			this.texture.needsUpdate = true;

			this.mesh.starsTextureNode.value = this.texture;
			this.mesh.starsMode.value = 1.0;

		} else {

			this.mesh.starsMode.value = 0.0;

		}

		this.source = resolvedSource;
		this.mesh.starsIntensity.value = intensity;
		this.mesh.starsRotation.value = rotation;
		if ( typeof density === 'number' ) this.mesh.starsDensity.value = density;
		if ( typeof brightness === 'number' ) this.mesh.starsBrightnessScale.value = brightness;
		this._enabled = true;

		// Force a cube re-bake so stars flow into the IBL on the next update().
		this.sky.baker.markCubeDirty();

		return this;

	}

	/**
	 * Hide stars without unloading the texture. Cheap re-enable via
	 * `setIntensity( > 0 )`.
	 */
	disable() {

		this.mesh.starsIntensity.value = 0.0;
		this._enabled = false;
		this.sky.baker.markCubeDirty();
		return this;

	}

	/**
	 * Free any loaded HDR texture and revert to the placeholder. After this,
	 * `enable({ source: 'hdri', ... })` must reload before HDR stars can be
	 * shown again. Procedural mode is unaffected and remains available.
	 */
	dispose() {

		this.disable();
		this.mesh.starsTextureNode.value = this.mesh._starsTexturePlaceholder;
		if ( this.texture ) {

			this.texture.dispose();
			this.texture = null;

		}

	}

}

async function _loadEquirectHDR( url ) {

	const lower = url.toLowerCase().split( '?' )[ 0 ];
	const isExr = lower.endsWith( '.exr' );

	const loaderMod = isExr
		? await import( 'three/addons/loaders/EXRLoader.js' )
		: await import( 'three/addons/loaders/RGBELoader.js' );

	const Loader = isExr ? loaderMod.EXRLoader : loaderMod.RGBELoader;
	const loader = new Loader();
	loader.setDataType( HalfFloatType );

	return new Promise( ( resolve, reject ) => {

		loader.load( url, ( tex ) => resolve( tex ), undefined, ( err ) => reject( err ) );

	} );

}
