/**
 * Procedural Milky Way glow map — the unresolved-star light plus dust that a
 * texture is good at (resolved stars are sprites, see `SkyStars`).
 *
 * Layout (the format `SkyNight`'s `milkyWayTexture` option expects, so a real
 * all-sky map in galactic coordinates can be dropped in instead):
 *   equirectangular, u = galactic longitude with l = 0 (the centre) at
 *   u = 0.5 and l increasing with u; v = galactic latitude, b = −90° at v = 0.
 *   Linear RGB, peak ≈ 1 at the bulge.
 */
import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  RepeatWrapping,
} from 'three/webgpu'

const DEG = Math.PI / 180

function hash3(x: number, y: number, z: number) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function valueNoise3(x: number, y: number, z: number) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const xf = x - xi
  const yf = y - yi
  const zf = z - zi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const w = zf * zf * (3 - 2 * zf)
  const l = (a: number, b: number, t: number) => a + (b - a) * t
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz)
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  )
}

function fbm3(x: number, y: number, z: number, octaves: number) {
  let sum = 0
  let amp = 0.5
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(x, y, z)
    norm += amp
    x *= 2.03
    y *= 2.03
    z *= 2.03
    amp *= 0.5
  }
  return sum / norm
}

export interface MilkyWayTextureOptions {
  /** Default 1024 (≈0.35°/texel — matches a 256² cube face). */
  width?: number
  /** Default width / 2. */
  height?: number
}

/**
 * Generate the glow map on the CPU (~120 ms at 1024×512). Noise is evaluated
 * on the unit sphere, so there is no seam at l = ±180° and no pole pinching.
 */
export function generateMilkyWayTexture({ width = 1024, height = width / 2 }: MilkyWayTextureOptions = {}) {
  const data = new Uint16Array(width * height * 4)
  const toHalf = DataUtils.toHalfFloat
  for (let j = 0; j < height; j++) {
    const b = ((j + 0.5) / height - 0.5) * Math.PI
    const bDeg = b / DEG
    const cb = Math.cos(b)
    const y = Math.sin(b)
    for (let i = 0; i < width; i++) {
      const l = ((i + 0.5) / width - 0.5) * Math.PI * 2
      const lDeg = l / DEG
      const x = cb * Math.cos(l)
      const z = cb * Math.sin(l)

      // Disk: exponential in |b|, slightly thicker and brighter inward.
      const inward = Math.exp(-((lDeg / 70) ** 2))
      const disk = Math.exp(-Math.abs(bDeg) / (3.5 + 3.5 * inward)) * (0.3 + 0.7 * inward)
      // Bulge around the galactic centre.
      const bulge = 1.1 * Math.exp(-((lDeg / 13) ** 2 + (bDeg / 9) ** 2))

      // Star-cloud mottling.
      const mottle = 0.45 + 1.1 * fbm3(x * 9 + 11, y * 9, z * 9, 4)
      const clumps = fbm3(x * 26, y * 26 + 7, z * 26, 3)

      // Dust: a thin mid-plane lane everywhere + the Great Rift (l ≈ 0..70°)
      // wandering slightly north of the plane.
      const lane = fbm3(x * 14 + 3, y * 14, z * 14 - 5, 4)
      const riftCentre = 1.2 + 2.5 * Math.sin(lDeg * 0.05)
      const riftWindow = lDeg > -15 && lDeg < 75 ? Math.exp(-(((lDeg - 30) / 35) ** 2)) : 0
      const dust =
        1.3 * Math.exp(-((bDeg / 1.6) ** 2)) * lane +
        2.2 * riftWindow * Math.exp(-(((bDeg - riftCentre) / 2.2) ** 2)) * (0.4 + lane)

      const glow = (disk * mottle * (0.75 + 0.5 * clumps) + bulge * (0.8 + 0.4 * clumps)) * 0.6
      // Bulge warm, disk cool-white; dust reddens as well as dims.
      const warm = Math.min(1, bulge / (disk * 0.6 + bulge + 1e-4))
      const idx = (j * width + i) * 4
      data[idx] = toHalf(glow * (0.78 + 0.22 * warm) * Math.exp(-dust * 0.9))
      data[idx + 1] = toHalf(glow * (0.82 + 0.02 * warm) * Math.exp(-dust * 1.15))
      data[idx + 2] = toHalf(glow * (1.0 - 0.3 * warm) * Math.exp(-dust * 1.5))
      data[idx + 3] = toHalf(1)
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, HalfFloatType)
  texture.wrapS = RepeatWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  texture.name = 'SkyNight.milkyWay'
  texture.needsUpdate = true
  return texture
}
