import * as fiberWebGPU from '@react-three/fiber/webgpu'

import { ditherOutput } from '../dither'
import { useSky } from './SkyContext'

// `useRenderPipeline` lives on the R3F v10 alpha/canary line; the installed
// canary's published types don't declare it yet, so read it off the namespace.
const useRenderPipeline: (...args: any[]) => any = (fiberWebGPU as any).useRenderPipeline

export interface AutoHazeProps {
  /**
   * `'haze'` (default): aerial perspective, `sky.applyHaze`. `'fog'`: the
   * sky-coloured height fog, `sky.applyFog` — no per-frame LUT, so `<Sky>`
   * skips `updateAerialPerspective()`. Read once, like the other props.
   */
  mode?: 'haze' | 'fog'
  /**
   * Dither the 8-bit output (default `true`): `ditherOutput` tone-maps and
   * encodes the result, then adds ±1 level of noise, which removes the
   * contour bands in dusk, night and stylized gradients. The pipeline's own
   * output transform is turned off while it is on. `false` restores three's
   * plain output. Read once, like the other props.
   */
  dither?: boolean
  [key: string]: any
}

/**
 * Aerial-perspective haze post-process for `<Sky>`. Renders nothing; calls
 * `useRenderPipeline` and assigns `sky.applyHaze(scenePass)` to
 * `renderPipeline.outputNode`.
 *
 * Lives in its own sub-export (`@pmndrs/sky/react/auto-haze`) so the
 * `useRenderPipeline` import is only pulled into bundles that actually
 * need it; the plain `<Sky>` from `@pmndrs/sky/react` doesn't import it.
 *
 * Mutually exclusive with a user-owned `useRenderPipeline` — the docs
 * warn against multiple init callsites racing for `outputNode`. For
 * custom pipelines, skip `<AutoHaze />` and call `sky.applyHaze` from
 * your own `useRenderPipeline` callback (use `useSky()` to grab the
 * instance).
 *
 * Props are forwarded to `sky.applyHaze` as the options bag (e.g.
 * `policy`, `strength`, `altitudeBlend`, `raymarchFallback`, `apRefineSteps`,
 * `shadows`); `scenePass` is supplied. With
 * `mode="fog"` they go to `sky.applyFog` instead (`density`,
 * `heightFalloff`, `baseHeight`, `maxOpacity`, `nightBlur`). `dither` (default
 * on) dithers the final 8-bit output; see {@link AutoHazeProps.dither}.
 *
 * `useRenderPipeline` does not currently support reactive callback
 * bodies — the callback closes over its initial deps. The `sky`
 * instance is stable across renders (Sky owns the haze uniforms, so
 * prop changes still take effect through `sky.setHaze*` setters even
 * without rebuilding the callback).
 */
export function AutoHaze({ mode = 'haze', dither = true, ...options }: AutoHazeProps = {}) {
  const sky = useSky()

  useRenderPipeline(({ renderPipeline, passes }: any) => {
    if (!sky) return
    const color = passes.scenePass.getTextureNode()
    const opts = { ...options, scenePass: passes.scenePass }
    const node = mode === 'fog' ? sky.applyFog(color, opts) : sky.applyHaze(color, opts)
    renderPipeline.outputColorTransform = !dither
    renderPipeline.outputNode = dither ? ditherOutput(node) : node
  })

  return null
}

export default AutoHaze
