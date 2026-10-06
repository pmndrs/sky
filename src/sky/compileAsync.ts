import { QuadMesh, RendererUtils } from 'three/webgpu'

import type { Material, RenderTarget } from 'three/webgpu'

/**
 * Asynchronous pipeline warm-up for the sky's internal draws.
 *
 * Chrome compiles WebGPU shaders in its GPU process (on Windows: WGSL → HLSL →
 * DXC, or FXC on old drivers). A pipeline three first meets inside `render()`
 * is created synchronously, which blocks that process until the compile is
 * done; an asynchronous one compiles on worker threads. The sky's LUT passes
 * and cube capture are off-scene draws, so an app's own
 * `renderer.compileAsync(scene, camera)` never reaches them (issue #49).
 *
 * three caches pipelines by shader and render state, not by object, so
 * compiling a material on this quad against the same render target is enough
 * for the LUT's own quad to hit the cache later.
 */
const _quad = /*@__PURE__*/ new QuadMesh(null as any) // material is assigned per compile
let _state: any

/**
 * Start compiling `material` as a full-screen pass into `target`. Everything
 * three needs from the renderer state is read before this returns, so the
 * caller's state is already restored while the compile runs.
 */
export function compileQuadAsync(renderer: any, material: Material, target: RenderTarget): Promise<void> {
  _state = RendererUtils.resetRendererState(renderer, _state)
  try {
    _quad.material = material
    return compileIntoTarget(renderer, _quad, _quad.camera, target)
  } finally {
    RendererUtils.restoreRendererState(renderer, _state)
  }
}

/**
 * `renderer.compileAsync(object, camera)` into `target`, keyed the way
 * `render()` will key it. three r185–r186 build the compile's render context
 * from `renderer.depth` / `renderer.stencil`, where `render()` uses the
 * target's own `depthBuffer` / `stencilBuffer`; for a target without depth
 * (every LUT) the two pipeline keys differ, and the draw compiles the same
 * shaders again, synchronously.
 */
export function compileIntoTarget(renderer: any, object: any, camera: any, target: RenderTarget): Promise<void> {
  const depth = renderer.depth
  const stencil = renderer.stencil
  const prevTarget = renderer.getRenderTarget()
  try {
    renderer.depth = target.depthBuffer
    renderer.stencil = target.stencilBuffer
    renderer.setRenderTarget(target)
    return renderer.compileAsync(object, camera)
  } finally {
    renderer.depth = depth
    renderer.stencil = stencil
    renderer.setRenderTarget(prevTarget)
  }
}
