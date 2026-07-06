import { BackSide, Mesh, NodeMaterial, SphereGeometry, Vector3 } from 'three/webgpu';
import { cameraPosition, cubeTexture, normalize, positionLocal, positionWorld, reflect, select, vec3 } from 'three/tsl';

/**
 * Ground-projected skybox for tsl-sky.
 *
 * Same geometric trick as three.js's `examples/jsm/objects/GroundedSkybox.js`,
 * ported to a TSL `NodeMaterial` so the cube texture sample can be expressed
 * cleanly for the WebGPU backend. The lower hemisphere of a sphere is pulled
 * radially inward so its vertices sit at `y = -height` locally — a flat disc.
 * The mesh is then placed at `(camX, height, camZ)` per frame so that disc
 * coincides with the world `y = 0` plane and tracks the camera horizontally.
 *
 * The cube sample direction at each fragment is `normalize(positionLocal)`.
 * For un-deformed (upper) vertices that's the original sphere direction →
 * normal sky sample. For deformed (lower) vertices the direction interpolates
 * across the flattened disc → small offsets sample near the cube's nadir
 * (ground colour) and large offsets sample horizon texels (sky touching
 * ground). The result blends from "floor right under the camera" out to
 * "horizon" without an explicit ground plane in the scene.
 *
 * Pair with `SkyViewLUT`'s ground-albedo contribution (the lower hemisphere
 * of the cube must have lit-ground colour, not black) for this to actually
 * look like a floor.
 *
 * Usage:
 * ```js
 * const sb = new GroundedSkybox( baker.texture, { height: 4, radius: 200 } );
 * scene.add( sb );
 * // Per-frame:
 * sb.followCamera( camera );
 * ```
 */
export class GroundedSkybox extends Mesh {

	/**
	 * @param {THREE.CubeTexture} cube — typically `baker.texture`.
	 * @param {object} [opts]
	 * @param {number} [opts.height=4]     camera-eye height above the floor. A
	 *   larger value magnifies the downward part of the image; tune to taste.
	 * @param {number} [opts.radius=200]   sphere radius. Must comfortably
	 *   exceed the camera's working range so it never escapes the dome.
	 * @param {number} [opts.resolution=128]  sphere tessellation; higher =
	 *   smoother projection transition at the horizon, more vertices.
	 * @param {boolean} [opts.reflective=false]  if true, the disc samples the
	 *   cube via the view-direction reflected about the world-up axis — a
	 *   "wet pavement" / mirror floor look. The dome portion still samples
	 *   directly. Floor reflection picks up the *sky*, not lit ground.
	 */
	constructor( cube, { height = 4, radius = 200, resolution = 128, reflective = false } = {} ) {

		if ( height <= 0 || radius <= 0 || resolution <= 0 ) {

			throw new Error( 'GroundedSkybox: height, radius, and resolution must be positive.' );

		}

		const geometry = new SphereGeometry( radius, 2 * resolution, resolution );

		// Deform lower-hemisphere vertices toward `y = -height`. Identical
		// math to three.js's reference impl: vertices well below the floor
		// (`y < y1`) get clamped to `y = -height`; the transition band
		// (`y1 < y < 0`) uses a smooth quadratic so the seam between sphere
		// and disc isn't visible at the horizon.
		const pos = geometry.getAttribute( 'position' );
		const tmp = new Vector3();
		const y1 = - height * 1.5;

		for ( let i = 0; i < pos.count; i ++ ) {

			tmp.fromBufferAttribute( pos, i );

			if ( tmp.y < 0 ) {

				const f = tmp.y < y1
					? - height / tmp.y
					: ( 1 - tmp.y * tmp.y / ( 3 * y1 * y1 ) );

				tmp.multiplyScalar( f );
				tmp.toArray( pos.array, 3 * i );

			}

		}

		pos.needsUpdate = true;

		const material = new NodeMaterial();
		material.side = BackSide;          // viewer is inside the sphere
		material.depthWrite = false;       // don't occlude actual scene geometry

		// Direct projection — samples the cube along the mesh-local direction
		// of each fragment. The dome shows sky; the deformed disc shows the
		// cube's below-horizon (lit ground albedo) content.
		const directDir = normalize( positionLocal );

		// Reflective floor — for fragments on the disc only, replace the sample
		// direction with the view direction reflected about world-up. Cube
		// content sampled at the reflected ray = "what the sky looks like
		// mirrored on this floor point." The dome keeps the direct sample so
		// the sky above is the sky, not a reflection of the floor.
		const viewDir = normalize( positionWorld.sub( cameraPosition ) );
		const reflectedDir = reflect( viewDir, vec3( 0, 1, 0 ) );
		// Disc vs. dome: localPosition.y < 0 means we're on the deformed disc
		// (where deformation pulled the vertex to y = -height locally). The
		// dome keeps localPosition.y >= 0.
		const isDisc = positionLocal.y.lessThan( 0 );
		const sampleDir = reflective
			? select( isDisc, reflectedDir, directDir )
			: directDir;

		// Force mip 0 — the geometry has a discontinuous derivative at the
		// horizon transition (sphere → flat disc), which would otherwise drive
		// `textureSample`'s ddx/ddy mip selection to extreme values and blur
		// the floor unevenly. Same workaround pattern as the AP LUT sample
		// in HazePostProcess (see CLAUDE.md "Force `.level(0)`").
		material.colorNode = cubeTexture( cube, sampleDir, 0 ).rgb;

		super( geometry, material );

		this.frustumCulled = false;
		this.renderOrder = - 1;            // draw before opaque scene geometry
		this.height = height;
		this.radius = radius;

		this.position.y = height;          // lift the flat disc to world y = 0

	}

	/**
	 * Per-frame helper — keep the mesh centered above the camera so the
	 * projected floor stays anchored to world y=0 and the camera never
	 * escapes the dome. Call from your render loop.
	 *
	 * @param {THREE.Camera} camera
	 */
	followCamera( camera ) {

		this.position.x = camera.position.x;
		this.position.z = camera.position.z;
		// y stays at `height` so the disc remains at world y=0.

	}

}
