import { abs, dot, float, fract, renderOutput, screenCoordinate, sign, sqrt, vec2, vec4 } from 'three/tsl'

export interface DitherOutputOptions {
  /** Bit depth of the canvas, default 8. */
  bits?: number
  /** Noise amplitude in least-significant bits, default 1. */
  strength?: number
}

/**
 * Tone-map and colour-encode `color` for the screen, then dither it.
 *
 * Skies are slow gradients, and a dusk or night sky is a slow gradient in the
 * darkest few dozen 8-bit levels: one level can span 20+ pixels, which reads
 * as contour bands. three's WebGPU output has no dithering, so add it here:
 * triangular noise of ±1 level, added after the tonemapper and the sRGB
 * encode — the only place it is the right size. Static per pixel
 * (interleaved gradient noise), so it does not crawl.
 *
 * Use it as a `RenderPipeline` output with the pipeline's own colour
 * transform turned off (it would run twice otherwise):
 *
 * ```js
 * const pipeline = new THREE.RenderPipeline(renderer)
 * pipeline.outputColorTransform = false
 * pipeline.outputNode = ditherOutput(sky.applyHaze(scenePassColor, { scenePass, camera }))
 * ```
 */
export function ditherOutput(color: any, { bits = 8, strength = 1 }: DitherOutputOptions = {}): any {
  const encoded = renderOutput(color)
  // Interleaved gradient noise (Jimenez 2014) → uniform 0..1 → triangular −1..1.
  const u = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715)))))
  const r = u.mul(2.0).sub(1.0)
  const tri = sign(r).mul(float(1.0).sub(sqrt(float(1.0).sub(abs(r)))))
  const lsb = strength / (Math.pow(2, bits) - 1)
  return vec4(encoded.rgb.add(tri.mul(lsb)), encoded.a)
}
