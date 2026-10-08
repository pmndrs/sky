import { Color } from 'three/webgpu'

/**
 * Colour inputs. Strings and hex numbers are sRGB and are converted to the
 * linear working space; arrays and `{ r, g, b }` objects are taken as already
 * linear (matching how `groundAlbedo` treats raw numbers).
 */
export type ColorInput = string | number | Color | { r: number; g: number; b: number } | number[]

/** A fresh linear `Color` from any {@link ColorInput}. */
export function toColor(input: ColorInput): Color {
  // `new Color(string | number)` runs the sRGB → working-space conversion via
  // three's ColorManagement. Component forms bypass it deliberately.
  if (input instanceof Color) return input.clone()
  if (typeof input === 'string' || typeof input === 'number') return new Color(input)
  if (Array.isArray(input)) return new Color().setRGB(input[0] ?? 0, input[1] ?? 0, input[2] ?? 0)
  return new Color().setRGB(input.r ?? 0, input.g ?? 0, input.b ?? 0)
}
