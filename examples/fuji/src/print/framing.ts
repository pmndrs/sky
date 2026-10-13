import type { PrintLayout } from '../settings'

/** Preserve responsive framing; the wide print gives the composed sun room. */
export function printFraming(aspect: number, layout: PrintLayout) {
  const horizontal = Math.tan(((layout === 'landscape' ? 78 : 43) * Math.PI) / 360)
  const tangent = Math.max(Math.tan((33 * Math.PI) / 360), horizontal / Math.max(aspect, 0.01))
  return { fov: (Math.atan(tangent) * 360) / Math.PI, aimHeight: 8 + tangent * 0.54 * 2575 }
}
