import { Box3, DirectionalLight, Object3D, Vector3 } from 'three/webgpu';

/**
 * Owns a `THREE.DirectionalLight` whose direction tracks the sky's sun vector.
 *
 * Subscribes to `sky.baker.addSunListener(...)` so any call to
 * `sky.setSunDirection(...)` or `sky.baker.setSun(...)` (e.g. from a GUI)
 * updates the light position automatically — no per-frame plumbing required
 * on the consumer side.
 *
 * The light's intensity, colour, and shadow params live on `this.light` for
 * direct mutation. The sun *disc* visibility lives on the sky mesh and stays
 * orthogonal — call `sky.setSunDisc(true)` separately if you want the visible
 * disc as well.
 *
 * Usage:
 * ```js
 * const sun = sky.createSun({ intensity: 4, castShadow: true });
 * sun.attach(scene);
 * sun.fitShadowToObject(scene);  // tighten shadow frustum
 * sun.light.color.setHex(0xfff0c0);  // mutate freely
 * ```
 */
export class SkySun {

	constructor( sky, {
		color = 0xffffff,
		intensity = 4.0,
		distance = 50000,
		target = null,

		castShadow = true,
		shadowMapSize = 2048,
		shadowBias = - 0.0001,
		shadowNormalBias = 0.05,
		shadowRadius = 1.0,
		shadowCamera = null
	} = {} ) {

		this.sky = sky;
		this.distance = distance;

		this.light = new DirectionalLight( color, intensity );
		this.light.castShadow = castShadow;
		this.light.shadow.mapSize.width = shadowMapSize;
		this.light.shadow.mapSize.height = shadowMapSize;
		this.light.shadow.bias = shadowBias;
		this.light.shadow.normalBias = shadowNormalBias;
		this.light.shadow.radius = shadowRadius;

		const cam = this.light.shadow.camera;
		const sc = shadowCamera || {};
		cam.left = sc.left ?? - 50;
		cam.right = sc.right ?? 50;
		cam.top = sc.top ?? 50;
		cam.bottom = sc.bottom ?? - 50;
		cam.near = sc.near ?? 1;
		cam.far = sc.far ?? 200000;
		cam.updateProjectionMatrix();

		this.target = target || new Object3D();
		this.light.target = this.target;

		this._scene = null;
		this._onSunChanged = ( sunVec ) => this._syncFromSunVec( sunVec );
		this._unsubscribe = sky.baker.addSunListener( this._onSunChanged );

		// Prime the light position from the baker's current sun vector so the
		// first attach already has a valid transform.
		this._syncFromSunVec( sky.baker._sunVec );

	}

	get castShadow() {

		return this.light.castShadow;

	}

	set castShadow( value ) {

		this.light.castShadow = value;

	}

	get intensity() {

		return this.light.intensity;

	}

	set intensity( value ) {

		this.light.intensity = value;

	}

	setDistance( value ) {

		this.distance = value;
		this._syncFromSunVec( this.sky.baker._sunVec );
		return this;

	}

	attach( scene ) {

		this._scene = scene;
		scene.add( this.light );
		scene.add( this.target );
		return this;

	}

	detach() {

		if ( this._scene ) {

			this._scene.remove( this.light );
			this._scene.remove( this.target );
			this._scene = null;

		}

		return this;

	}

	/**
	 * Tighten the directional light's orthographic shadow frustum to enclose
	 * the given world-space Box3. The light's `target` (or origin if no target
	 * was customised) is used as the centre of the shadow's local frame.
	 */
	fitShadowToBox( box3 ) {

		if ( box3.isEmpty() ) return this;

		const cam = this.light.shadow.camera;
		this.light.target.updateMatrixWorld();
		this.light.updateMatrixWorld();
		cam.updateMatrixWorld();

		const corners = [
			new Vector3( box3.min.x, box3.min.y, box3.min.z ),
			new Vector3( box3.min.x, box3.min.y, box3.max.z ),
			new Vector3( box3.min.x, box3.max.y, box3.min.z ),
			new Vector3( box3.min.x, box3.max.y, box3.max.z ),
			new Vector3( box3.max.x, box3.min.y, box3.min.z ),
			new Vector3( box3.max.x, box3.min.y, box3.max.z ),
			new Vector3( box3.max.x, box3.max.y, box3.min.z ),
			new Vector3( box3.max.x, box3.max.y, box3.max.z )
		];

		const inv = cam.matrixWorldInverse;
		let minX = Infinity, maxX = - Infinity;
		let minY = Infinity, maxY = - Infinity;
		let minZ = Infinity, maxZ = - Infinity;

		for ( const c of corners ) {

			c.applyMatrix4( inv );
			if ( c.x < minX ) minX = c.x;
			if ( c.x > maxX ) maxX = c.x;
			if ( c.y < minY ) minY = c.y;
			if ( c.y > maxY ) maxY = c.y;
			if ( c.z < minZ ) minZ = c.z;
			if ( c.z > maxZ ) maxZ = c.z;

		}

		cam.left = minX;
		cam.right = maxX;
		cam.bottom = minY;
		cam.top = maxY;
		// Camera looks down -Z, so near = -maxZ, far = -minZ (with a small pad).
		cam.near = Math.max( 0.1, - maxZ - 1 );
		cam.far = - minZ + 1;
		cam.updateProjectionMatrix();
		return this;

	}

	fitShadowToObject( object3D ) {

		const box = new Box3().setFromObject( object3D );
		return this.fitShadowToBox( box );

	}

	dispose() {

		if ( this._unsubscribe ) {

			this._unsubscribe();
			this._unsubscribe = null;

		}

		this.detach();
		this.light.dispose();

	}

	_syncFromSunVec( sunVec ) {

		// Place the directional light along the sun ray so its forward vector
		// (light.position → light.target.position) matches the sun direction.
		this.light.position.copy( sunVec ).multiplyScalar( this.distance );
		this.light.target.updateMatrixWorld();

	}

}
