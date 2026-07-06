import {
	Scene,
	PerspectiveCamera,
	Mesh,
	MeshStandardMaterial,
	PlaneGeometry,
	SphereGeometry,
	Color
} from 'three/webgpu';

/**
 * Phase 1a demo scene:
 *   - matte ground plane
 *   - mirror sphere (metal, rough 0)
 *   - PBR sphere (metal, rough 0.35)
 *
 * scene.environment = baker.environmentTexture (PMREM filtered)
 * scene.background  = baker.texture (raw cube, sharper background)
 */
export function createDemoScene( baker ) {

	const scene = new Scene();
	scene.background = baker.texture;
	scene.environment = baker.environmentTexture;

	const camera = new PerspectiveCamera( 60, window.innerWidth / window.innerHeight, 0.1, 2_000_000 );
	camera.position.set( 6, 3, 10 );
	camera.lookAt( 0, 1, 0 );

	// Matte ground
	const ground = new Mesh(
		new PlaneGeometry( 200, 200 ),
		new MeshStandardMaterial( { color: new Color( 0x444444 ), roughness: 0.9, metalness: 0.0 } )
	);
	ground.rotation.x = - Math.PI / 2;
	ground.position.y = 0;
	scene.add( ground );

	// Mirror sphere (center-left)
	const mirror = new Mesh(
		new SphereGeometry( 1.5, 64, 64 ),
		new MeshStandardMaterial( { color: new Color( 0xffffff ), metalness: 1.0, roughness: 0.0 } )
	);
	mirror.position.set( - 2.2, 1.5, 0 );
	scene.add( mirror );

	// PBR metal sphere (center-right)
	const pbr = new Mesh(
		new SphereGeometry( 1.5, 64, 64 ),
		new MeshStandardMaterial( { color: new Color( 0xffffff ), metalness: 1.0, roughness: 0.35 } )
	);
	pbr.position.set( 2.2, 1.5, 0 );
	scene.add( pbr );

	return { scene, camera, meshes: { ground, mirror, pbr } };

}
