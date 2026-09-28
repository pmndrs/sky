/**
 * Star catalog for `SkyStars`: a seeded procedural field with a realistic
 * magnitude distribution, plus real positions for the brightest stars so the
 * familiar constellations are where they belong.
 */
import { galacticToEquatorial, equatorialDirection } from './celestial'
import { Vector3 } from 'three/webgpu'

export interface StarCatalog {
  /** Unit equatorial directions, xyz per star. */
  directions: Float32Array
  /** Apparent visual magnitude per star (lower is brighter). */
  magnitudes: Float32Array
  /** Colour temperature per star: 0 = warm (K/M), 1 = hot (B/A). */
  tones: Float32Array
  count: number
}

export interface StarCatalogOptions {
  /** Procedural stars (the bright named stars are added on top). Default 9000 ≈ naked eye. */
  count?: number
  seed?: number
  /** Faintest magnitude generated. Default 6.5 (naked-eye limit). */
  limitingMagnitude?: number
}

/** [RA hours, Dec degrees, magnitude, tone] */
// prettier-ignore
const BRIGHT_STARS: [number, number, number, number][] = [
  [6.7525, -16.7161, -1.46, 0.92], // Sirius
  [6.3992, -52.6957, -0.74, 0.8], // Canopus
  [14.261, 19.1824, -0.05, 0.12], // Arcturus
  [18.6156, 38.7837, 0.03, 0.82], // Vega
  [5.2782, 45.998, 0.08, 0.35], // Capella
  [5.2423, -8.2016, 0.13, 0.95], // Rigel
  [7.655, 5.225, 0.34, 0.5], // Procyon
  [5.9195, 7.4071, 0.5, 0.05], // Betelgeuse
  [1.6286, -57.2368, 0.46, 0.95], // Achernar
  [19.8464, 8.8683, 0.77, 0.88], // Altair
  [4.5987, 16.5093, 0.85, 0.1], // Aldebaran
  [13.4199, -11.1613, 0.98, 0.9], // Spica
  [16.4901, -26.432, 1.06, 0.02], // Antares
  [7.7553, 28.0262, 1.14, 0.24], // Pollux
  [22.9608, -29.6222, 1.16, 0.78], // Fomalhaut
  [20.6905, 45.2803, 1.25, 0.72], // Deneb
  [10.1395, 11.9672, 1.35, 0.86], // Regulus
  [7.5767, 31.8883, 1.58, 0.72], // Castor
  [11.0621, 61.7508, 1.79, 0.28], // Dubhe
  [11.0307, 56.3824, 2.37, 0.75], // Merak
  [11.8972, 53.6948, 2.41, 0.7], // Phecda
  [12.2571, 57.0326, 3.31, 0.72], // Megrez
  [12.9005, 55.9598, 1.77, 0.88], // Alioth
  [13.3987, 54.9254, 2.23, 0.74], // Mizar
  [13.7923, 49.3133, 1.86, 0.88], // Alkaid
  [0.1529, 59.1498, 2.27, 0.66], // Caph
  [0.6751, 56.5373, 2.24, 0.18], // Schedar
  [0.9451, 60.7167, 2.47, 0.8], // Gamma Cas
  [1.4303, 60.2353, 2.68, 0.78], // Ruchbah
  [1.9066, 63.67, 3.35, 0.85], // Segin
  [2.5303, 89.2641, 1.98, 0.48], // Polaris
  [5.6036, -1.2019, 1.69, 0.95], // Alnilam
  [5.6793, -1.9426, 1.77, 0.95], // Alnitak
  [5.5334, -0.2991, 2.23, 0.95], // Mintaka
]

function makeRandom(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * Whole-sky star counts follow roughly N(<m) ∝ 10^(0.5·m) (≈15 stars
 * brighter than m = 1, ≈5000 brighter than m = 6), so magnitudes are drawn
 * from the inverse of that CDF. Fainter stars are increasingly concentrated
 * toward the galactic plane, which is what makes the Milky Way band visible
 * in the resolved stars too.
 */
export function generateStarCatalog({
  count = 9000,
  seed = 0x5eed,
  limitingMagnitude = 6.5,
}: StarCatalogOptions = {}): StarCatalog {
  const random = makeRandom(seed)
  const total = count + BRIGHT_STARS.length
  const directions = new Float32Array(total * 3)
  const magnitudes = new Float32Array(total)
  const tones = new Float32Array(total)
  const dir = new Vector3()

  for (let i = 0; i < count; i++) {
    // F(m) = 10^(0.5 (m − mLimit)); keep the procedural field fainter than the
    // real bright stars.
    const m = Math.max(1.0, limitingMagnitude + 2 * Math.log10(Math.max(1e-6, random())))
    const planeBias = Math.min(1, Math.max(0, (m - 2) / 4.5)) * 0.45
    if (random() < planeBias) {
      const l = random() * Math.PI * 2
      const b = (random() + random() + random() + random() - 2) * 0.16
      galacticToEquatorial(l, b, dir)
    } else {
      const y = random() * 2 - 1
      const r = Math.sqrt(Math.max(0, 1 - y * y))
      const a = random() * Math.PI * 2
      dir.set(Math.cos(a) * r, y, Math.sin(a) * r)
    }
    directions[i * 3] = dir.x
    directions[i * 3 + 1] = dir.y
    directions[i * 3 + 2] = dir.z
    magnitudes[i] = m
    tones[i] = random()
  }

  BRIGHT_STARS.forEach(([ra, dec, m, tone], j) => {
    const i = count + j
    equatorialDirection(ra, dec, dir)
    directions[i * 3] = dir.x
    directions[i * 3 + 1] = dir.y
    directions[i * 3 + 2] = dir.z
    magnitudes[i] = m
    tones[i] = tone
  })

  return { directions, magnitudes, tones, count: total }
}
