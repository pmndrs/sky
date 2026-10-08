import { NodeMaterial, QuadMesh } from 'three/webgpu'

import { Fn, If, PI, cos, float, mix, screenUV, sin, texture, uniform, vec3, vec4 } from 'three/tsl'

import { raySphereIntersectNearest, skyViewLutParamsToUv } from '../backends/tsl/atmosphere.tsl'
import { applyGrade } from '../backends/tsl/grade.tsl'
import { lutTextureSize } from '../core/resolutions'

/** What the preview shows. */
export type SkyGradePreviewMode = 'graded' | 'physical' | 'split' | 'grade'

const MODES: Record<SkyGradePreviewMode, number> = { graded: 0, physical: 1, split: 2, grade: 3 }

export interface SkyGradePreviewOptions {
  mode?: SkyGradePreviewMode
  /** Elevation range shown, bottom to top, degrees. Default `[-10, 90]`. */
  elevationRange?: [number, number]
}

/**
 * A flat view of the whole sky dome for grading UIs: azimuth from the sun
 * across (−180°…180°, the sun in the middle), elevation up. The same view the
 * grade is authored in, so zone guides drawn over it line up.
 *
 * Modes:
 * - `graded` — the sky as rendered (physical × look × grade).
 * - `physical` — the sky before any look or grade.
 * - `split` — physical on the left half, graded on the right. The sky is
 *   mirror-symmetric about the sun's vertical, so the two halves are a
 *   like-for-like A/B.
 * - `grade` — the grade alone, applied to a flat mid-grey sky: colour targets,
 *   brightness and fill, with no physics in the way.
 *
 * Reads the sky's live Sky-View LUT and grade tables, so it follows every
 * change for the cost of one full-screen quad. Render it into any target —
 * for a second canvas, a three `CanvasTarget`:
 *
 * ```js
 * const preview = new SkyGradePreview(sky, { mode: 'split' })
 * const target = new THREE.CanvasTarget(previewCanvas)
 * // per frame, after the main render:
 * const main = renderer.getCanvasTarget()
 * renderer.setCanvasTarget(target)
 * preview.render(renderer)
 * renderer.setCanvasTarget(main)
 * ```
 *
 * Tone mapping and output colour space follow the renderer, like the main view.
 */
export class SkyGradePreview {
  material: NodeMaterial
  quad: QuadMesh
  /** Uniform: 0 graded, 1 physical, 2 split, 3 grade. */
  modeUniform: any
  elevationMin: any
  elevationMax: any
  _mode: SkyGradePreviewMode

  constructor(sky: any, { mode = 'graded', elevationRange = [-10, 90] }: SkyGradePreviewOptions = {}) {
    // Accepts a `Sky` or a `SkyAtmosphereBaker`.
    const baker = sky.baker ?? sky
    const mesh = baker.sky
    const params = baker.atmosphereUniforms
    const skyViewTex = baker.skyViewLUT.texture
    const skyViewSize = lutTextureSize(skyViewTex)
    const gradeU = mesh.gradeUniforms

    this._mode = mode
    this.modeUniform = uniform(MODES[mode])
    this.elevationMin = uniform(elevationRange[0])
    this.elevationMax = uniform(elevationRange[1])
    const modeU = this.modeUniform
    const elMinU = this.elevationMin
    const elMaxU = this.elevationMax

    const colorNode = Fn(() => {
      const p = screenUV
      const azimuth = p.x.mul(2.0).sub(1.0).mul(PI) // −π … π, sun at the centre
      const elevation = mix(elMaxU, elMinU, p.y).mul(PI.div(180.0))
      const viewZenithCosAngle = sin(elevation).toVar()
      const lightViewCosAngle = cos(azimuth).toVar()

      const viewHeight = mesh.viewHeight
      const ro = vec3(0.0, viewHeight, 0.0)
      const rd = vec3(cos(elevation), sin(elevation), 0.0)
      const intersectsGround = raySphereIntersectNearest(ro, rd, vec3(0.0), params.bottomRadius).greaterThanEqual(0.0)

      const lutUv = skyViewLutParamsToUv(
        params,
        intersectsGround,
        viewZenithCosAngle,
        lightViewCosAngle,
        viewHeight,
        skyViewSize,
      )
      const physical = texture(skyViewTex, lutUv).rgb.mul(mesh.luminanceScale).mul(mesh.sunColor).toVar()

      // Mode 3 grades a flat mid-grey, display-referred like the fill.
      const flat = vec3(0.5).mul(gradeU.displayScale)
      const input = modeU.equal(3).select(flat, physical).toVar()
      const graded = input.toVar()
      If(gradeU.enabled.greaterThan(0.5), () => {
        graded.assign(applyGrade({ color: input, viewZenithCosAngle, lightViewCosAngle, grade: gradeU }))
      })

      const showPhysical = modeU.equal(1).or(modeU.equal(2).and(p.x.lessThan(0.5)))
      const out = showPhysical.select(physical, graded).mul(mesh.skyLuminanceFactor)
      return vec4(out, float(1.0))
    })()

    this.material = new NodeMaterial()
    this.material.colorNode = colorNode
    this.material.depthTest = false
    this.material.depthWrite = false
    this.quad = new QuadMesh(this.material)
  }

  get mode(): SkyGradePreviewMode {
    return this._mode
  }

  setMode(mode: SkyGradePreviewMode): this {
    this._mode = mode
    this.modeUniform.value = MODES[mode]
    return this
  }

  setElevationRange(min: number, max: number): this {
    this.elevationMin.value = min
    this.elevationMax.value = max
    return this
  }

  /** Normalised position (0..1, y down) → `{ azimuth, elevation }` in degrees. */
  toDome(x: number, y: number): { azimuth: number; elevation: number } {
    const min = this.elevationMin.value as number
    const max = this.elevationMax.value as number
    return { azimuth: (x * 2 - 1) * 180, elevation: max + (min - max) * y }
  }

  /** `{ azimuth, elevation }` in degrees → normalised position (0..1, y down). */
  fromDome(azimuth: number, elevation: number): { x: number; y: number } {
    const min = this.elevationMin.value as number
    const max = this.elevationMax.value as number
    return { x: (azimuth / 180 + 1) / 2, y: (max - elevation) / (max - min) }
  }

  /** Draw into the renderer's current target (canvas, canvas target or render target). */
  render(renderer: any): void {
    this.quad.render(renderer)
  }

  dispose(): void {
    this.material.dispose()
  }
}
