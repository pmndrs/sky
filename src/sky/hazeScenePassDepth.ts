import { abs, float, logarithmicDepthToViewZ, max, vec2, vec4, viewZToOrthographicDepth } from 'three/tsl'

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
export function createHazeDepthNodes(
  scenePass: any,
  logarithmicDepthBuffer: boolean,
): { viewZNode: any; linearDepthNode: any } {
  if (logarithmicDepthBuffer) {
    const depthTex = scenePass.getTextureNode('depth')
    const near = scenePass._cameraNear
    const far = scenePass._cameraFar
    const viewZNode = logarithmicDepthToViewZ(depthTex, near, far)
    const linearDepthNode = viewZToOrthographicDepth(viewZNode, near, far)
    return { viewZNode, linearDepthNode }
  }

  return {
    viewZNode: scenePass.getViewZNode(),
    linearDepthNode: scenePass.getLinearDepthNode(),
  }
}

/**
 * View-space direction (not normalised) of the ray through screen uv `u`.
 *
 * WebGPU screen uv is v-down, so `ndc.y = 1 - 2·uv.y`; the other sign gives a
 * vertically mirrored ray. The clip point is at mid depth (z = 0.5), never on
 * the far plane: with the far/near ratios planet scenes use (far 4e7 m, near
 * < 1 m) a far-plane point inverse-projects to 40,000 km and float32 loses the
 * direction (every geometry pixel renders black, 2026-09-26). The AP LUT build
 * uses the same mid-depth point, so build and sample agree by construction.
 */
export function viewRayFromUv(u: any, invProj: any): any {
  const ndc = vec2(u.x.mul(2.0).sub(1.0), float(1.0).sub(u.y.mul(2.0)))
  const viewMid = invProj.mul(vec4(ndc.x, ndc.y, float(0.5), float(1.0)))
  return viewMid.xyz.div(viewMid.w)
}

/**
 * Camera-to-surface distance **along the ray**, from the view-space depth and
 * the pixel's view ray. `|viewZ|` alone under-reads off-axis pixels by
 * `cos(angle from the view axis)` (~14 % in the corners of a 60° FOV), which
 * shows as a silhouette fringe that changes as the camera pitches.
 */
export function distanceAlongViewRay(viewZ: any, rayDirView: any): any {
  return abs(viewZ).div(max(abs(rayDirView.normalize().z), float(1e-6)))
}

/**
 * Sky-pixel test on the raw depth buffer: nothing sky-like writes depth (a
 * background and the live sky mesh both leave the cleared 1.0), so the test is
 * exact. Never compare `viewZ` / linear depth against the far plane instead —
 * one depth ulp below 1.0 is only ≈ −0.45·far at far = 2e7. `skyDepthEpsilon`
 * (a uniform, so the f32 survives codegen) is for a custom sky that writes a
 * far-plane depth of its own; it is 0 otherwise.
 */
export function rawDepthIsSky(scenePass: any, skyDepthEpsilon: any): any {
  return scenePass.getTextureNode('depth').x.greaterThanEqual(float(1.0).sub(skyDepthEpsilon))
}
