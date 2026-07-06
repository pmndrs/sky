import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

import { Sky as VanillaSky } from '../Sky.js';
import { SkyContext } from './SkyContext.js';

/**
 * `<Sky>` — mounts a vanilla `Sky` instance against the active R3F renderer
 * and scene, drives `update(camera)` per frame, and publishes the instance
 * via context for `useSky()` consumers.
 *
 * Construction-time options (cause a remount when changed):
 *   `preset`, `quality`, `cubeSize`, `enableAerialPerspective`, `apKmPerSlice`
 *
 * Imperative props (applied via setters; no remount):
 *   `timeOfDay`, `latitude`, `dayOfYear`, `sunDirection`, `north`,
 *   `exposure`, `sunDisc`, `turbidity`, `groundAlbedo`, `atmosphere`,
 *   `hazeStrength`, `hazePolicy`, `hazeAltitudeBlend`, `mirrorBelowHorizon`
 *
 * Aerial-perspective haze post-process: render an `<AutoHaze />` child
 * (imported from `tsl-sky/react/auto-haze`). It calls `useRenderPipeline`
 * and assigns the haze composite to `renderPipeline.outputNode`. The
 * separate sub-export keeps `useRenderPipeline` out of this module's
 * import graph, so `<Sky>` works on R3F builds where the hook hasn't
 * shipped yet (e.g. `10.0.0-alpha.2`). For custom pipelines, skip
 * `<AutoHaze />` and call `sky.applyHaze` from your own
 * `useRenderPipeline` callback (use `useSky()` to grab the instance).
 */
export function Sky( {
	preset = 'earth',
	quality = 'medium',
	cubeSize = 256,
	atmosphere,
	enableAerialPerspective = true,
	apKmPerSlice = 8.0,
	mirrorBelowHorizon = false,
	exposure = 40,
	north = '+Z',
	sunDisc = true,
	timeOfDay,
	latitude,
	dayOfYear,
	sunDirection,
	turbidity,
	groundAlbedo,
	hazeStrength,
	hazePolicy,
	hazeAltitudeBlend,
	children
} ) {

	const renderer = useThree( ( s ) => s.gl );
	const scene = useThree( ( s ) => s.scene );

	const sky = useMemo( () => {

		return new VanillaSky( renderer, {
			preset,
			quality,
			cubeSize,
			atmosphere,
			enableAerialPerspective,
			apKmPerSlice,
			mirrorBelowHorizon,
			exposure,
			north,
			sunDisc,
			timeOfDay,
			latitude,
			dayOfYear,
			sunDirection,
			turbidity,
			groundAlbedo
		} );

		// Reconstruct only on options that affect LUT layout / cube target sizing.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ renderer, preset, quality, cubeSize, enableAerialPerspective, apKmPerSlice ] );

	useEffect( () => {

		sky.attach( scene );
		return () => {

			sky.detach();
			sky.dispose();

		};

	}, [ sky, scene ] );

	useEffect( () => {

		if ( typeof timeOfDay === 'number' ) sky.setTimeOfDay( timeOfDay );

	}, [ sky, timeOfDay ] );

	useEffect( () => {

		if ( typeof latitude === 'number' ) sky.setLatitude( latitude );

	}, [ sky, latitude ] );

	useEffect( () => {

		if ( typeof dayOfYear === 'number' ) sky.setDayOfYear( dayOfYear );

	}, [ sky, dayOfYear ] );

	useEffect( () => {

		if ( sunDirection ) sky.setSunDirection( sunDirection );

	}, [ sky, sunDirection ] );

	useEffect( () => {

		sky.setExposure( exposure );

	}, [ sky, exposure ] );

	useEffect( () => {

		sky.setSunDisc( sunDisc );

	}, [ sky, sunDisc ] );

	useEffect( () => {

		sky.setNorth( north );

	}, [ sky, north ] );

	useEffect( () => {

		if ( typeof turbidity === 'number' ) sky.setTurbidity( turbidity );

	}, [ sky, turbidity ] );

	useEffect( () => {

		if ( groundAlbedo != null ) sky.setGroundAlbedo( groundAlbedo );

	}, [ sky, groundAlbedo ] );

	useEffect( () => {

		if ( atmosphere ) sky.setAtmosphere( atmosphere );

	}, [ sky, atmosphere ] );

	useEffect( () => {

		sky.setMirrorBelowHorizon( !! mirrorBelowHorizon );

	}, [ sky, mirrorBelowHorizon ] );

	useEffect( () => {

		if ( typeof hazeStrength === 'number' ) sky.setHazeStrength( hazeStrength );

	}, [ sky, hazeStrength ] );

	useEffect( () => {

		if ( hazePolicy ) sky.setHazePolicy( hazePolicy );

	}, [ sky, hazePolicy ] );

	useEffect( () => {

		if ( hazeAltitudeBlend ) sky.setHazeAltitudeBlend( hazeAltitudeBlend );

	}, [ sky, hazeAltitudeBlend ] );

	useFrame( ( state ) => {

		sky.update( state.camera );

	} );

	return (
		<SkyContext.Provider value={sky}>
			{children}
		</SkyContext.Provider>
	);

}
