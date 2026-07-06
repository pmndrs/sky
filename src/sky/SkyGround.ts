import {
	Color,
	Mesh,
	MeshStandardMaterial,
	NodeMaterial,
	PlaneGeometry,
	SphereGeometry
} from 'three/webgpu';

import { mix, reflector, vec4 } from 'three/tsl';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';

/**
 * Optional ground / floor mesh for tsl-sky scenes.
 *
 * The sky atmosphere returns black for any view ray below the horizon, so a
 * scene with no ground geometry shows a black bottom hemisphere. `SkyGround`
 * makes the floor a one-liner and supports two geometry modes:
 *
 *  - `'plane'` — a finite flat square at y=0. Suitable for ground-level demos.
 *  - `'sphere'` — a planet-sized sphere whose surface tangent sits at y=0,
 *    auto-sized from `sky.baker.atmosphereParams.bottomRadius`. Suitable for
 *    high-altitude / orbital views — the sphere wraps the lower hemisphere
 *    so there's no visible black band when looking out toward the horizon.
 *
 * Reflection is opt-in on plane mode only (`{ reflective: true }`). The
 * reflective floor uses a `NodeMaterial` with `mix(reflector, baseColor,
 * roughness)` matching the three.js `webgpu_reflection_blurred` recipe — it
 * is NOT a full PBR shading pipeline. Roughness controls how much base color
 * is blended over the mirror; `blur > 0` runs a gaussian blur on the
 * reflection texture for a frosted look.
 *
 * Usage:
 * ```js
 * const ground = sky.createGround({ mode: 'plane', size: 200, reflective: true, blur: 4 });
 * ground.attach(scene);
 * ground.mesh.receiveShadow = true;
 * ```
 */
export class SkyGround {

	constructor( sky, {
		mode = 'plane',

		// plane mode
		size = 200000,
		segments = 1,

		// sphere mode (radius defaults to baker.atmosphereParams.bottomRadius * 1000)
		radius = null,
		widthSegments = 128,
		heightSegments = 64,

		// material shortcuts (used when `material` is null)
		color = 0x6a6055,
		roughness = 0.95,
		metalness = 0.0,
		material = null,

		// reflection (plane mode only)
		reflective = false,
		blur = 0.0,
		reflectorOptions = {
			resolutionScale: 0.5,
			generateMipmaps: false,
			bounces: false
		},

		receiveShadow = true
	} = {} ) {

		this.sky = sky;
		this.mode = mode;
		this.reflector = null;
		this._scene = null;

		// --- geometry ---
		if ( mode === 'sphere' ) {

			const r = radius ?? sky.baker.atmosphereParams.bottomRadius * 1000;
			this.geometry = new SphereGeometry( r, widthSegments, heightSegments );
			this._sphereRadius = r;

		} else {

			this.geometry = new PlaneGeometry( size, size, segments, segments );

		}

		// --- material ---
		const wantsReflection = reflective && mode === 'plane' && material === null;

		if ( reflective && mode === 'sphere' ) {

			console.warn( '[SkyGround] reflective is not supported in sphere mode — falling back to non-reflective.' );

		}

		if ( material ) {

			this.material = material;

		} else if ( wantsReflection ) {

			this.material = this._buildReflectiveMaterial( { color, roughness, blur, reflectorOptions } );

		} else {

			this.material = new MeshStandardMaterial( { color, roughness, metalness } );

		}

		// --- mesh ---
		this.mesh = new Mesh( this.geometry, this.material );
		this.mesh.receiveShadow = receiveShadow;

		if ( mode === 'sphere' ) {

			this.mesh.position.y = - this._sphereRadius;

		} else {

			this.mesh.rotation.x = - Math.PI / 2;
			this.mesh.position.y = 0;

		}

		// Attach the reflector's target as a child of the mesh so it inherits
		// the floor's world transform — the reflector uses target's world +Z
		// as the mirror plane normal, which now correctly aligns with world +Y.
		if ( this.reflector ) this.mesh.add( this.reflector.target );

	}

	setVisible( visible ) {

		this.mesh.visible = visible;
		return this;

	}

	attach( scene ) {

		this._scene = scene;
		scene.add( this.mesh );
		return this;

	}

	detach() {

		if ( this._scene ) {

			this._scene.remove( this.mesh );
			this._scene = null;

		}

		return this;

	}

	dispose() {

		this.detach();
		this.geometry.dispose();
		if ( this.material && this.material.dispose ) this.material.dispose();

	}

	_buildReflectiveMaterial( { color, roughness, blur, reflectorOptions } ) {

		const reflectorNode = reflector( reflectorOptions );
		this.reflector = reflectorNode;

		const baseColorNode = vec4( new Color( color ), 1.0 );
		const sampledReflection = blur > 0
			? gaussianBlur( reflectorNode, null, blur )
			: reflectorNode;

		const mat = new NodeMaterial();
		mat.colorNode = mix( sampledReflection, baseColorNode, roughness );
		return mat;

	}

}
