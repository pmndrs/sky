import { CanvasTarget } from 'three/webgpu'
import { SkyGradePreview } from '../sky/SkyGradePreview'
import type { SkyGradePreviewMode } from '../sky/SkyGradePreview'
import type { Sky } from '../Sky'

/** CanvasTarget owns its viewport/scissor. Switching back preserves the host
 * target's values, including WebGPU viewport depth bounds. */
export function withPreviewTarget(renderer: any, target: any, draw: () => void): void {
  const canvas = renderer.getCanvasTarget()
  const renderTarget = renderer.getRenderTarget()
  const face = renderer.getActiveCubeFace()
  const mip = renderer.getActiveMipmapLevel()
  const mrt = renderer.getMRT()
  const autoClear = renderer.autoClear
  const autoClearColor = renderer.autoClearColor
  const autoClearDepth = renderer.autoClearDepth
  const autoClearStencil = renderer.autoClearStencil
  try {
    renderer.setMRT(null)
    renderer.setRenderTarget(null)
    renderer.setCanvasTarget(target)
    renderer.autoClear = renderer.autoClearColor = renderer.autoClearDepth = renderer.autoClearStencil = true
    draw()
  } finally {
    renderer.setCanvasTarget(canvas)
    renderer.setRenderTarget(renderTarget, face, mip)
    renderer.setMRT(mrt)
    renderer.autoClear = autoClear
    renderer.autoClearColor = autoClearColor
    renderer.autoClearDepth = autoClearDepth
    renderer.autoClearStencil = autoClearStencil
  }
}

export class EditorPreview {
  readonly preview: SkyGradePreview
  readonly target: CanvasTarget
  private stamp = ''
  private sizeStamp = ''
  constructor(
    private sky: Sky,
    private renderer: any,
    private canvas: HTMLCanvasElement,
  ) {
    this.preview = new SkyGradePreview(sky, { mode: 'split', elevationRange: [-12, 90] })
    this.target = new CanvasTarget(canvas)
  }

  render(mode: SkyGradePreviewMode): void {
    if (this.sky.state === 'disposed') return
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    if (!width || !height) return
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2, 1024 / width, 512 / height)
    const stamp = JSON.stringify([
      this.sky.getSettings(),
      this.sky.grade?.revision,
      mode,
      width,
      height,
      ratio,
      this.renderer.toneMapping,
      this.renderer.toneMappingExposure,
      this.renderer.outputColorSpace,
    ])
    if (stamp === this.stamp) return
    this.preview.setMode(mode)
    withPreviewTarget(this.renderer, this.target, () => {
      const sizeStamp = `${width}|${height}|${ratio}`
      if (sizeStamp !== this.sizeStamp) {
        this.target.setDrawingBufferSize(width, height, ratio)
        this.sizeStamp = sizeStamp
      }
      this.preview.render(this.renderer)
    })
    this.stamp = stamp
  }

  dispose() {
    this.preview.dispose()
    this.target.dispose()
  }
}
