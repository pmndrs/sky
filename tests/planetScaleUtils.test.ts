import assert from 'node:assert/strict';
import test from 'node:test';

import { Object3D, Vector3 } from 'three/webgpu';

import {
	clampCameraToMinAltitude,
	createPlanetSurfacePatchGeometry,
	getPlanetAltitudeM,
	getPlanetCameraFrame,
	getPlanetLookAtTarget,
	placeObjectOnPlanetSurface
} from '../src/demo/planetScaleUtils.js';

test( 'derives altitude from distance to planet center', () => {

	const bottomRadiusM = 6_360_000;
	const planetCenter = new Vector3( 0, - bottomRadiusM, 0 );
	const cameraPosition = new Vector3( 0, 200, 0 );

	assert.equal( getPlanetAltitudeM( cameraPosition, planetCenter, bottomRadiusM ), 200 );

	const frame = getPlanetCameraFrame( cameraPosition, planetCenter, bottomRadiusM );
	assert.equal( frame.altitudeM, 200 );
	assert.equal( frame.viewHeightKm, 6360.2 );
	assert.deepEqual( frame.positionKm.toArray(), [ 0, 6360.2, 0 ] );

} );

test( 'clamps camera and target above the planet surface together', () => {

	const bottomRadiusM = 6_360_000;
	const planetCenter = new Vector3( 0, - bottomRadiusM, 0 );
	const camera = { position: new Vector3( 0, - 50, 0 ) };
	const target = new Vector3( 0, 0, 1000 );

	const altitudeM = clampCameraToMinAltitude( {
		camera,
		target,
		planetCenter,
		bottomRadiusM,
		minAltitudeM: 25
	} );

	assert.equal( altitudeM, 25 );
	assert.equal( camera.position.y, 25 );
	assert.equal( target.y, 75 );

} );

test( 'places objects on the spherical surface and aligns local up to the normal', () => {

	const bottomRadiusM = 6_360_000;
	const planetCenter = new Vector3( 0, - bottomRadiusM, 0 );
	const object = new Object3D();

	const frame = placeObjectOnPlanetSurface( object, {
		planetCenter,
		bottomRadiusM,
		distanceM: 10_000,
		bearingRad: 0,
		heightM: 400,
		baseOffsetM: 200
	} );

	const radialAltitude = object.position.distanceTo( planetCenter ) - bottomRadiusM;
	assert.ok( Math.abs( radialAltitude - 200 ) < 1e-6 );

	const objectUp = new Vector3( 0, 1, 0 ).applyQuaternion( object.quaternion );
	assert.ok( objectUp.distanceTo( frame.normal ) < 1e-6 );

} );

test( 'builds a high-resolution local ground patch on the planet shell', () => {

	const bottomRadiusM = 6_360_000;
	const patchRadiusM = 80_000;
	const patchAltitudeM = 0.5;
	const geometry = createPlanetSurfacePatchGeometry( {
		bottomRadiusM,
		patchRadiusM,
		patchAltitudeM,
		radialSegments: 8,
		angularSegments: 16
	} );

	const positions = geometry.attributes.position;
	const maxTheta = patchRadiusM / bottomRadiusM;
	let minRadius = Infinity;
	let maxRadius = - Infinity;
	let minY = Infinity;

	for ( let i = 0; i < positions.count; i ++ ) {

		const vertex = new Vector3().fromBufferAttribute( positions, i );
		const radius = vertex.length();
		minRadius = Math.min( minRadius, radius );
		maxRadius = Math.max( maxRadius, radius );
		minY = Math.min( minY, vertex.y );

	}

	assert.ok( Math.abs( minRadius - ( bottomRadiusM + patchAltitudeM ) ) < 1.0 );
	assert.ok( Math.abs( maxRadius - ( bottomRadiusM + patchAltitudeM ) ) < 1.0 );
	assert.ok( Math.abs( minY - ( bottomRadiusM + patchAltitudeM ) * Math.cos( maxTheta ) ) < 1.0 );

	geometry.dispose();

} );

test( 'derives a scale-appropriate tangent look target from the camera frame', () => {

	const bottomRadiusM = 6_360_000;
	const planetCenter = new Vector3( 0, - bottomRadiusM, 0 );
	const cameraPosition = new Vector3( 0, 200, 0 );
	const target = getPlanetLookAtTarget( {
		position: cameraPosition,
		planetCenter,
		bottomRadiusM,
		distanceM: 50_000
	} );

	assert.deepEqual( target.toArray(), [ 0, 200, 50_000 ] );
	assert.equal( target.distanceTo( cameraPosition ), 50_000 );

} );
