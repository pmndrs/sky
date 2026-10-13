import type { Node } from 'three/webgpu'
import { dot, float, floor, fract, mix, screenCoordinate, sin, smoothstep, vec2, vec3, vec4 } from 'three/tsl'

// Static, screen-anchored texture: the artwork moves over paper, not with it.
function paperNoise(point: Node<'vec2'>) {
  return fract(sin(dot(point, vec2(127.1, 311.7))).mul(43758.5453))
}

// Smooth interpolation keeps enlarged pulp and stretched fibres organic. Raw
// cell noise would reveal a rectangular grid as soon as the slider is raised.
function paperField(point: Node<'vec2'>) {
  const cell = floor(point)
  const fraction = fract(point)
  const blend = fraction.mul(fraction).mul(float(3).sub(fraction.mul(2)))
  return mix(
    mix(paperNoise(cell), paperNoise(cell.add(vec2(1, 0))), blend.x),
    mix(paperNoise(cell.add(vec2(0, 1))), paperNoise(cell.add(vec2(1, 1))), blend.x),
    blend.y,
  )
}

/**
 * A single-pass paper/ink finish for display-referred RGBA, after renderOutput.
 * No time, textures, extra targets or colour quantization. Input alpha survives.
 * Both controls are independent [0, 1]; both at zero return unchanged RGB.
 */
export function paperFinish(inputNode: Node<'vec4'>, paperUniform: Node<'float'>, inkUniform: Node<'float'>) {
  const pixel = screenCoordinate.xy
  const grain = paperNoise(floor(pixel)).sub(0.5)
  const tooth = paperField(pixel.mul(0.42)).sub(0.5)
  const pulp = paperField(pixel.mul(0.022)).sub(0.5)

  // Sparse, 15–40px-long strands cross at two shallow angles. These have soft
  // boundaries rather than a repeated woven fabric or sharp scratch overlay.
  const diagonal = vec2(pixel.x.add(pixel.y.mul(0.27)), pixel.y.sub(pixel.x.mul(0.27)))
  const crossing = vec2(pixel.x.sub(pixel.y.mul(0.41)), pixel.y.add(pixel.x.mul(0.41)))
  const fibreA = smoothstep(0.61, 0.88, paperField(diagonal.mul(vec2(0.035, 0.65))))
  const fibreB = smoothstep(0.64, 0.9, paperField(crossing.mul(vec2(0.06, 0.5)).add(91.7)))
  const fibres = fibreA.mul(0.7).add(fibreB.mul(0.3)).sub(0.13)
  const texture = grain.mul(0.055).add(tooth.mul(0.14)).add(pulp.mul(0.07)).add(fibres.mul(0.11))
  const rgb = inputNode.rgb
  const luminance = dot(rgb, vec3(0.2126, 0.7152, 0.0722))
  // Pigment pools into the same tooth and fibres. It is a continuous modulation
  // of the image, never posterization, so atmospheric gradients remain smooth.
  const highlights = smoothstep(0.12, 0.95, luminance)
  const stock = vec3(1.018, 1.001, 0.951)
  const absorption = tooth.mul(0.16).add(pulp.mul(0.11)).sub(fibres.mul(0.1))
  const pigment = rgb.mul(mix(vec3(0.88, 0.94, 0.98), stock, highlights))
  const inkColor = pigment.mul(float(1).add(absorption))
  const printed = mix(rgb, inkColor, inkUniform)
  // Texture remains legible through the dark blue sea without washing out true
  // blacks or adding a fog overlay. A slight stock tint keeps fibres paper-like.
  const textureWeight = smoothstep(0, 0.055, luminance).mul(mix(float(0.58), float(1), highlights))
  const textured = printed.add(vec3(1, 0.965, 0.89).mul(texture).mul(paperUniform).mul(textureWeight))
  return vec4(textured, inputNode.a)
}
