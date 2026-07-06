import { logarithmicDepthToViewZ, viewZToOrthographicDepth } from 'three/tsl';

/**
 * ViewZ + linear depth for haze post-processing.
 *
 * When `renderer.logarithmicDepthBuffer` is true, {@link PassNode#getViewZNode}
 * is still implemented with `perspectiveDepthToViewZ` on the depth texture
 * (Three r181) — that assumes non-log depth, so distances and haze collapse.
 * We mirror TRAANode / GTAONode: `logarithmicDepthToViewZ` from the pass depth
 * sample using the pass’s internal near/far uniforms.
 *
 * @param {import('three/webgpu').PassNode} scenePass  `pass(scene, camera)`
 * @param {boolean} logarithmicDepthBuffer  Same flag as `WebGPURenderer`.
 */
export function createHazeDepthNodes( scenePass, logarithmicDepthBuffer ) {

	if ( logarithmicDepthBuffer ) {

		const depthTex = scenePass.getTextureNode( 'depth' );
		const near = scenePass._cameraNear;
		const far = scenePass._cameraFar;
		const viewZNode = logarithmicDepthToViewZ( depthTex, near, far );
		const linearDepthNode = viewZToOrthographicDepth( viewZNode, near, far );
		return { viewZNode, linearDepthNode };

	}

	return {
		viewZNode: scenePass.getViewZNode(),
		linearDepthNode: scenePass.getLinearDepthNode()
	};

}
