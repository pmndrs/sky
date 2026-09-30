// three r185/r186's CubeUV PMREM atlas (`CubeUVReflectionMapping`): layout and
// the roughness its sampler reads each level at. Verified against three's
// generator and sampler in research/pmrem-lab/ATLAS_NOTES.md.

export const CUBEUV_LOD_MIN = 4
export const CUBEUV_EXTRA_LODS = 6

/**
 * Inverse of three's `roughnessToMip` (PMREMUtils): the roughness at which the
 * sampler reads atlas mip `m` alone (m = lodMax − level, from −2 to lodMax).
 * The log branch (r < 0.21) meets the linear ones with a small jump, so mip 4
 * is reached exactly at r = 0.21.
 */
export function cubeUVRoughness(m: number): number {
  if (m >= 4.07) return Math.pow(2, -m / 2) / 1.16
  if (m >= 3) return 0.305 - (m - 3) * 0.095
  if (m >= 2) return 0.4 - (m - 2) * 0.095
  if (m >= -1) return 0.8 - ((m + 1) * 0.4) / 3
  return 1 - (m + 2) * 0.2
}

export interface CubeUVTile {
  level: number
  /** Tile face size in texels; the inner (size − 2)² cover the face, plus a 1-texel border. */
  size: number
  x: number
  y: number
  roughness: number
}

/** Tile positions (`_createPlanes` + `_applyGGXFilter` viewports) for a cube of `cubeSize`. */
export function cubeUVLayout(cubeSize: number) {
  const lodMax = Math.floor(Math.log2(cubeSize))
  const cs = Math.pow(2, lodMax)
  const n = lodMax - CUBEUV_LOD_MIN + 1 + CUBEUV_EXTRA_LODS
  const tiles: CubeUVTile[] = []
  for (let i = 0; i < n; i++) {
    const size = Math.pow(2, Math.max(lodMax - i, CUBEUV_LOD_MIN))
    const x = 3 * size * (i > lodMax - CUBEUV_LOD_MIN ? i - lodMax + CUBEUV_LOD_MIN : 0)
    tiles.push({ level: i, size, x, y: 4 * (cs - size), roughness: i === 0 ? 0 : cubeUVRoughness(lodMax - i) })
  }
  return { lodMax, cubeSize: cs, width: 3 * Math.max(cs, 16 * 7), height: 4 * cs, tiles }
}
