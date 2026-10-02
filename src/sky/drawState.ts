/**
 * Renderer state an internal sky draw (cube capture, PMREM filter) must not
 * inherit from the caller, nor leak back to it.
 *
 * `renderer.setMRT()` is sticky: a caller that renders a G-buffer pass with
 * `mrt({ output, normal })` keeps that MRT active until it clears it. three
 * r185's `CubeCamera.update()` and `PMREMGenerator` save the render target,
 * cube face and mip level, but not the MRT, so the sky's single-output
 * materials would compile and draw under a multi-attachment MRT — WebGPU
 * validation errors on mismatched fragment outputs. Neither restores anything
 * if a draw throws.
 *
 * Usage: `beginSkyDraw` before the draws, `endSkyDraw` in a `finally`. The
 * state object is reused, so a guarded draw allocates nothing.
 */
export interface SkyDrawState {
  mrt: any
  target: any
  face: number
  mip: number
}

export function createSkyDrawState(): SkyDrawState {
  return { mrt: null, target: null, face: 0, mip: 0 }
}

/** Save the caller's MRT, render target, cube face and mip level, then clear the MRT. */
export function beginSkyDraw(renderer: any, state: SkyDrawState): void {
  state.mrt = renderer.getMRT()
  state.target = renderer.getRenderTarget()
  state.face = renderer.getActiveCubeFace()
  state.mip = renderer.getActiveMipmapLevel()
  renderer.setMRT(null)
}

/** Restore what `beginSkyDraw` saved. Call from a `finally`. */
export function endSkyDraw(renderer: any, state: SkyDrawState): void {
  renderer.setRenderTarget(state.target, state.face, state.mip)
  renderer.setMRT(state.mrt)
  // Don't keep the caller's MRT node or target alive between draws.
  state.mrt = null
  state.target = null
}
