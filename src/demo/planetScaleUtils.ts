import {
	Quaternion,
	SphereGeometry,
	Vector3
} from 'three/webgpu';

const DEFAULT_ORIGIN_NORMAL = new Vector3( 0, 1, 0 );
const DEFAULT_BEARING_REFERENCE = new Vector3( 0, 0, 1 );
const LOCAL_UP = new Vector3( 0, 1, 0 );

/**
 * Altitude above a spherical planet surface in scene metres.
 */
export function getPlanetAltitudeM( position, planetCenter, bottomRadiusM ) {

	return position.distanceTo( planetCenter ) - bottomRadiusM;

}

/**
 * Camera state in the atmosphere frame used by the Hillaire shaders.
 */
export function getPlanetCameraFrame( position, planetCenter, bottomRadiusM ) {

	const relativeM = position.clone().sub( planetCenter );
	const radiusM = relativeM.length();
	const altitudeM = radiusM - bottomRadiusM;
	const up = radiusM > 1e-6 ? relativeM.clone().divideScalar( radiusM ) : DEFAULT_ORIGIN_NORMAL.clone();
	const positionKm = relativeM.multiplyScalar( 0.001 );

	return {
		altitudeM,
		up,
		positionKm,
		viewHeightKm: positionKm.length()
	};

}

/**
 * Tangent-facing target far enough away for planet-scale camera controls.
 */
export function getPlanetLookAtTarget( {
	position,
	planetCenter,
	bottomRadiusM,
	distanceM,
	bearingReference = DEFAULT_BEARING_REFERENCE
} ) {

	const frame = getPlanetCameraFrame( position, planetCenter, bottomRadiusM );
	let forward = bearingReference.clone().projectOnPlane( frame.up );
	if ( forward.lengthSq() < 1e-10 ) forward = new Vector3( 1, 0, 0 ).projectOnPlane( frame.up );
	forward.normalize();

	return position.clone().add( forward.multiplyScalar( distanceM ) );

}

/**
 * Keep the camera above the ground shell and move its target by the same offset
 * so the current view direction is preserved.
 */
export function clampCameraToMinAltitude( {
	camera,
	target = null,
	planetCenter,
	bottomRadiusM,
	minAltitudeM
} ) {

	const frame = getPlanetCameraFrame( camera.position, planetCenter, bottomRadiusM );
	if ( frame.altitudeM >= minAltitudeM ) return frame.altitudeM;

	const correction = frame.up.multiplyScalar( minAltitudeM - frame.altitudeM );
	camera.position.add( correction );
	if ( target ) target.add( correction );

	return minAltitudeM;

}

/**
 * Spherical surface point from a distance/bearing around an origin normal.
 * Distances are metres along the surface, not flat X/Z offsets.
 */
export function getPlanetSurfaceFrame( {
	planetCenter,
	bottomRadiusM,
	distanceM,
	bearingRad,
	altitudeM = 0,
	originNormal = DEFAULT_ORIGIN_NORMAL,
	bearingReference = DEFAULT_BEARING_REFERENCE
} ) {

	const originUp = originNormal.clone().normalize();
	let east = bearingReference.clone().cross( originUp );
	if ( east.lengthSq() < 1e-10 ) east = new Vector3( 1, 0, 0 ).cross( originUp );
	east.normalize();

	const north = originUp.clone().cross( east ).normalize();
	const tangent = north.multiplyScalar( Math.cos( bearingRad ) )
		.add( east.multiplyScalar( Math.sin( bearingRad ) ) )
		.normalize();
	const angularDistance = distanceM / bottomRadiusM;
	const normal = originUp.multiplyScalar( Math.cos( angularDistance ) )
		.add( tangent.multiplyScalar( Math.sin( angularDistance ) ) )
		.normalize();
	const position = planetCenter.clone().add( normal.clone().multiplyScalar( bottomRadiusM + altitudeM ) );

	return { normal, position };

}

/**
 * High-resolution spherical cap for the local surface under nearby demo props.
 *
 * A low-segment full Earth sphere has huge top-cap triangles; props placed on
 * the true sphere then appear to float above the rendered facet. This patch
 * keeps the local visual/collision surface close to the mathematical shell
 * without turning the whole planet into a multi-million-triangle mesh.
 */
export function createPlanetSurfacePatchGeometry( {
	bottomRadiusM,
	patchRadiusM,
	patchAltitudeM = 0,
	radialSegments = 96,
	angularSegments = 192
} ) {

	const thetaLength = Math.min( Math.PI, patchRadiusM / bottomRadiusM );
	return new SphereGeometry(
		bottomRadiusM + patchAltitudeM,
		angularSegments,
		radialSegments,
		0,
		Math.PI * 2,
		0,
		thetaLength
	);

}

/**
 * Place an object on the planet shell and align its local +Y to local up.
 */
export function placeObjectOnPlanetSurface( object, {
	planetCenter,
	bottomRadiusM,
	distanceM,
	bearingRad,
	heightM = 0,
	baseOffsetM = heightM * 0.5,
	originNormal,
	bearingReference
} ) {

	const frame = getPlanetSurfaceFrame( {
		planetCenter,
		bottomRadiusM,
		distanceM,
		bearingRad,
		altitudeM: baseOffsetM,
		originNormal,
		bearingReference
	} );

	object.position.copy( frame.position );
	object.quaternion.copy( new Quaternion().setFromUnitVectors( LOCAL_UP, frame.normal ) );

	return frame;

}
