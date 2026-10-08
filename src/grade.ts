import { Color } from 'three/webgpu'

import { toColor } from './color'

import type { ColorInput } from './color'

/**
 * Sky grades — an artist-authored lookup table over the physical sky, keyed on
 * the time of day.
 *
 * A grade never replaces the physical sky. Each keyframe describes how to
 * *grade* it at one sun elevation: global colour controls (exposure, white
 * balance, hue, saturation), colour and brightness per region of the dome
 * (zenith, horizon, the sunward and anti-sunward horizon, a glow around the
 * sun, below the horizon), and a night *fill* that keeps the sky from going
 * black. The bake turns every keyframe into one slice of a small 3D lookup
 * table over (azimuth from the sun, view elevation), and the sky samples the
 * two slices on either side of the current sun elevation.
 *
 * Grading rather than painting is what keeps the result coherent. The sky
 * still responds to altitude, turbidity and exposure, and because the grade is
 * linear in the light it is applied to (fill aside), the aerial-perspective
 * haze on distant geometry is graded by exactly the same operator, so a
 * silhouette never shows a seam against the graded sky behind it.
 *
 * This module is pure data and maths, no TSL and no renderer: GUIs, tests and
 * the editor build against it, and `SkyGradeUniforms` uploads its bake.
 *
 * ## The operator
 *
 * For a physical colour `c` (linear RGB) at one direction:
 *
 *     c1  = max(M · c, 0)                    M: exposure · saturation · hue · white balance
 *     c2  = c1 · (1 − a) + T · avg(c1)       colorize: T premultiplied by its amount a
 *     out = c2 · gain + fill · displayScale  gain = 2^brightness; fill is display-referred
 *
 * `M` comes from the keyframe's global controls; `T`, `a`, `gain` and `fill`
 * vary across the dome and are what the lookup table stores. Colorize keeps the
 * *average* of the three channels, not luminance: a deep blue swapped in at the
 * luminance of a bright sunset needs a blue channel ~14× its luminance, which
 * every tonemapper clips into flat bands (the old looks' sunset banding).
 * Keeping the channel average costs at most 3× on a pure primary.
 *
 * ## Axes
 *
 * Keyframes sit on **sun elevation in degrees**, like look tracks: elevation is
 * what decides how a sky reads, and it is right for any latitude and date.
 * Directions are **elevation** (degrees, −90 nadir … 90 zenith) and **azimuth
 * from the sun** (degrees, 0 toward the sun … 180 away from it; the grade is
 * mirror-symmetric about the sun's vertical, as the sky is).
 */

/** Regions of the dome a keyframe can colour. */
export type GradeZoneName = 'zenith' | 'horizon' | 'sunward' | 'antisun' | 'glow' | 'ground'

/** Zones in the order they composite: `zenith`/`horizon` are the base, the rest layer over it. */
export const GRADE_ZONES: readonly GradeZoneName[] = ['zenith', 'horizon', 'sunward', 'antisun', 'glow', 'ground']

/** Easing of the segment *entering* a keyframe from the previous one. */
export type GradeEase = 'linear' | 'smooth'

export interface GradeZoneInput {
  /** Target colour of the colorize (sRGB hex / number, or linear `[r, g, b]`). */
  color?: ColorInput
  /** 0..1: how far the physical colour is swapped for `color` (hue and saturation; brightness is kept). */
  amount?: number
  /** Brightness offset in stops (EV). 0 leaves it alone. */
  brightness?: number
}

export interface GradeZone {
  color: Color
  amount: number
  brightness: number
}

/** Where the zones sit on the dome. All in degrees. */
export interface GradeShape {
  /** Elevation by which the horizon zone has fully handed over to the zenith zone. */
  horizonHeight: number
  /** Azimuth half-width of the sunward horizon zone. */
  sunwardWidth: number
  /** Azimuth half-width of the anti-sun horizon zone (the Belt of Venus side). */
  antisunWidth: number
  /** Angular radius of the glow around the sun. */
  glowSize: number
}

/**
 * The night fill: light added to the sky, so it reads deep blue instead of
 * black. Display-referred like looks: it reaches the tonemapper at its
 * authored value (the sky divides by `toneMappingExposure`), so `intensity: 1`
 * shows the authored colours on screen. It lands in the cube too, so the
 * environment lighting picks it up.
 */
export interface GradeFill {
  zenith: Color
  horizon: Color
  intensity: number
}

/** Hemisphere ambient light for this time of day (see `SkyAmbient`). */
export interface GradeAmbient {
  /** Light from above. */
  color: Color
  /** Light from below. */
  groundColor: Color
  intensity: number
}

/** Easing of a gradient segment entering a stop: `'linear'`, `'smooth'` (smoothstep) or `n` for `pow(t, n)`. */
export type GradientEase = 'linear' | 'smooth' | number

export interface GradeGradientStopInput {
  /** View elevation in degrees: −90 nadir, 0 horizon, 90 zenith. */
  at: number
  color: ColorInput
  /** Easing of the segment entering this stop. Default `'linear'`. */
  ease?: GradientEase
}

export interface GradeGradientStop {
  at: number
  color: Color
  ease: GradientEase
}

/**
 * A colour gradient over view elevation, applied as a layer of the keyframe.
 * `amount` swaps the physical hue for the gradient's while keeping the
 * physical brightness (the sky still darkens at night, brightens toward the
 * sun). `replace` mixes the gradient in as the sky itself, at its authored,
 * display-referred colour: at 1 the sky *is* the gradient, the same at any
 * time of day — a fixed or solid-colour sky.
 */
export interface GradeGradientInput {
  stops?: GradeGradientStopInput[]
  /** 0..1 hue swap toward the gradient, keeping physical brightness. Default 1. */
  amount?: number
  /** 0..1 mix toward the gradient's own colour and brightness. Default 0. */
  replace?: number
}

export interface GradeGradient {
  stops: GradeGradientStop[]
  amount: number
  replace: number
}

export interface GradeFillInput {
  zenith?: ColorInput
  horizon?: ColorInput
  intensity?: number
}

export interface GradeAmbientInput {
  color?: ColorInput
  groundColor?: ColorInput
  intensity?: number
}

/** What callers pass to create or update a keyframe. Every field but `elevation` is optional. */
export interface SkyGradeKeyInput {
  /** Sun elevation in degrees this keyframe applies at. */
  elevation: number
  ease?: GradeEase
  /** Stops (EV) on the whole sky. */
  exposure?: number
  /** 1 leaves saturation alone, 0 is grey, 2 doubles it. */
  saturation?: number
  /** −1 (cool) … 1 (warm) white-balance shift. */
  temperature?: number
  /** −1 (green) … 1 (magenta) white-balance shift. */
  tint?: number
  /** Hue rotation in degrees. */
  hue?: number
  shape?: Partial<GradeShape>
  zones?: Partial<Record<GradeZoneName, GradeZoneInput>>
  fill?: GradeFillInput
  /** Colour gradient over elevation (see {@link GradeGradientInput}); `null` (default) for none. */
  gradient?: GradeGradientInput | null
  /** Ambient light at this time of day; `null` (default) leaves the ambient to `SkyAmbient`'s own settings. */
  ambient?: GradeAmbientInput | null
}

/** A resolved keyframe: colours in linear space, every default filled. */
export interface SkyGradeKey {
  elevation: number
  ease: GradeEase
  exposure: number
  saturation: number
  temperature: number
  tint: number
  hue: number
  shape: GradeShape
  zones: Record<GradeZoneName, GradeZone>
  fill: GradeFill
  gradient: GradeGradient | null
  ambient: GradeAmbient | null
}

export interface SkyGradeInput {
  name?: string
  keys: SkyGradeKeyInput[]
}

/** The saved form (`grade.toJSON()`). Colours are sRGB hex strings. */
export interface SkyGradeJSON {
  format: typeof GRADE_FORMAT
  version: number
  name?: string
  keys: SkyGradeKeyJSON[]
}

export interface SkyGradeKeyJSON {
  elevation: number
  ease?: GradeEase
  exposure?: number
  saturation?: number
  temperature?: number
  tint?: number
  hue?: number
  shape?: Partial<GradeShape>
  zones?: Partial<Record<GradeZoneName, { color: string; amount: number; brightness: number }>>
  fill?: { zenith: string; horizon: string; intensity: number }
  gradient?: { stops: { at: number; color: string; ease?: GradientEase }[]; amount: number; replace: number } | null
  ambient?: { color: string; groundColor: string; intensity: number } | null
}

/** Where the sky is between keyframes, and the global operator there. */
export interface SkyGradeEvaluation {
  /** Lower keyframe of the segment. */
  index: number
  /** 0..1 position toward `index + 1`, eased. */
  fraction: number
  /** Depth coordinate into the baked 3D table. */
  w: number
  /** The interpolated global operator `M`, row-major 3×3. */
  matrix: number[]
  /** Interpolated ambient, or `null` when no keyframe sets one. */
  ambient: GradeAmbient | null
}

/** The per-direction part of the operator, as stored in the table. */
export interface GradeTexel {
  /** Colorize target premultiplied by its amount (channel average of the target = 1 before the premultiply). */
  colorize: [number, number, number]
  /** Colorize amount. */
  amount: number
  /** Linear gain, `2^brightness`. */
  gain: number
  /** Fill, display-referred linear RGB. */
  fill: [number, number, number]
}

export const GRADE_FORMAT = 'pmndrs-sky-grade'
export const GRADE_VERSION = 1

/**
 * Hard cap on keyframes — the depth of the 3D table, fixed so the GPU texture
 * never reallocates (three does not reallocate a resized texture). A full day
 * wants eight to ten.
 */
export const MAX_GRADE_KEYS = 16
/** Table resolution in azimuth from the sun (0..180°). */
export const GRADE_AZIMUTH_RES = 32
/** Table resolution in view elevation (−90..90°, packed toward the horizon). */
export const GRADE_ELEVATION_RES = 64

/** Below-horizon blend width for the ground zone, degrees. */
const GROUND_BLEND_DEG = 3

const DEFAULT_SHAPE: GradeShape = { horizonHeight: 30, sunwardWidth: 70, antisunWidth: 60, glowSize: 25 }
const DEFAULT_FILL_ZENITH = '#0a1530'
const DEFAULT_FILL_HORIZON = '#1d2c52'
const DEFAULT_AMBIENT_COLOR = '#7088c0'
const DEFAULT_AMBIENT_GROUND = '#10141f'

/** Rec. 709 luminance — the weights the hue rotation and saturation preserve. */
const LUM = [0.2126, 0.7152, 0.0722] as const

function finite(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) throw new Error(`Sky grade: \`${name}\` must be a finite number; got ${value}.`)
  return value
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function defaultZone(): GradeZone {
  return { color: new Color(1, 1, 1), amount: 0, brightness: 0 }
}

function resolveZone(input: GradeZoneInput | undefined, base: GradeZone): GradeZone {
  if (!input) return { color: base.color.clone(), amount: base.amount, brightness: base.brightness }
  return {
    color: input.color !== undefined ? toColor(input.color) : base.color.clone(),
    amount: clamp(finite('amount', input.amount, base.amount), 0, 1),
    brightness: finite('brightness', input.brightness, base.brightness),
  }
}

function resolveAmbient(input: GradeAmbientInput | null | undefined, base: GradeAmbient | null): GradeAmbient | null {
  if (input === null) return null
  if (input === undefined) return base ? cloneAmbient(base) : null
  const from = base ?? {
    color: new Color(DEFAULT_AMBIENT_COLOR),
    groundColor: new Color(DEFAULT_AMBIENT_GROUND),
    intensity: 0,
  }
  return {
    color: input.color !== undefined ? toColor(input.color) : from.color.clone(),
    groundColor: input.groundColor !== undefined ? toColor(input.groundColor) : from.groundColor.clone(),
    intensity: Math.max(0, finite('ambient.intensity', input.intensity, from.intensity)),
  }
}

function resolveGradientEase(ease: GradientEase | undefined): GradientEase {
  if (ease === undefined) return 'linear'
  if (ease === 'linear' || ease === 'smooth') return ease
  if (typeof ease === 'number' && Number.isFinite(ease) && ease > 0) return ease
  throw new Error(
    `Sky grade: gradient \`ease\` must be 'linear', 'smooth' or a positive number; got ${JSON.stringify(ease)}.`,
  )
}

function resolveGradient(
  input: GradeGradientInput | null | undefined,
  base: GradeGradient | null,
): GradeGradient | null {
  if (input === null) return null
  if (input === undefined) {
    return base
      ? {
          stops: base.stops.map((st) => ({ at: st.at, color: st.color.clone(), ease: st.ease })),
          amount: base.amount,
          replace: base.replace,
        }
      : null
  }
  let stops: GradeGradientStop[]
  if (input.stops) {
    if (!input.stops.length) throw new Error('Sky grade: a gradient needs at least one stop.')
    stops = input.stops
      .map((st) => {
        if (!Number.isFinite(st.at)) {
          throw new Error(
            `Sky grade: gradient stop \`at\` must be an elevation in degrees; got ${JSON.stringify(st.at)}.`,
          )
        }
        return { at: clamp(st.at, -90, 90), color: toColor(st.color), ease: resolveGradientEase(st.ease) }
      })
      .sort((a, b) => a.at - b.at)
  } else if (base) {
    stops = base.stops.map((st) => ({ at: st.at, color: st.color.clone(), ease: st.ease }))
  } else {
    throw new Error('Sky grade: a gradient needs `stops`.')
  }
  return {
    stops,
    amount: clamp(finite('gradient.amount', input.amount, base?.amount ?? 1), 0, 1),
    replace: clamp(finite('gradient.replace', input.replace, base?.replace ?? 0), 0, 1),
  }
}

/** Gradient colour at an elevation (degrees), clamped outside the stops. Linear RGB into `out`. */
export function sampleGradient(
  stops: readonly GradeGradientStop[],
  elevationDeg: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const first = stops[0]
  const last = stops[stops.length - 1]
  let c0 = first.color
  let c1 = first.color
  let t = 0
  if (elevationDeg >= last.at) {
    c0 = c1 = last.color
  } else if (elevationDeg > first.at) {
    for (let i = 1; i < stops.length; i++) {
      const b = stops[i]
      if (elevationDeg > b.at) continue
      const a = stops[i - 1]
      const span = b.at - a.at
      const raw = span <= 0 ? 1 : (elevationDeg - a.at) / span
      t =
        b.ease === 'linear' ? raw : b.ease === 'smooth' ? raw * raw * (3 - 2 * raw) : Math.pow(clamp(raw, 0, 1), b.ease)
      c0 = a.color
      c1 = b.color
      break
    }
  }
  out[0] = lerp(c0.r, c1.r, t)
  out[1] = lerp(c0.g, c1.g, t)
  out[2] = lerp(c0.b, c1.b, t)
  return out
}

function cloneAmbient(a: GradeAmbient): GradeAmbient {
  return { color: a.color.clone(), groundColor: a.groundColor.clone(), intensity: a.intensity }
}

/** The identity keyframe at `elevation`: grades nothing. */
function identityKey(elevation: number): SkyGradeKey {
  const zones = {} as Record<GradeZoneName, GradeZone>
  for (const z of GRADE_ZONES) zones[z] = defaultZone()
  return {
    elevation,
    ease: 'linear',
    exposure: 0,
    saturation: 1,
    temperature: 0,
    tint: 0,
    hue: 0,
    shape: { ...DEFAULT_SHAPE },
    zones,
    fill: { zenith: new Color(DEFAULT_FILL_ZENITH), horizon: new Color(DEFAULT_FILL_HORIZON), intensity: 0 },
    gradient: null,
    ambient: null,
  }
}

/**
 * Resolve a keyframe input on top of `base` (the identity keyframe when
 * omitted). Fields the input leaves out keep the base's values, nested ones
 * (`shape`, each zone, `fill`, `ambient`) field by field.
 */
export function resolveGradeKey(input: Partial<SkyGradeKeyInput>, base?: SkyGradeKey): SkyGradeKey {
  const elevation = input.elevation ?? base?.elevation
  if (elevation === undefined || !Number.isFinite(elevation)) {
    throw new Error(`Sky grade: a keyframe needs a finite \`elevation\` (sun elevation in degrees).`)
  }
  const from = base ?? identityKey(elevation)

  if (input.ease !== undefined && input.ease !== 'linear' && input.ease !== 'smooth') {
    throw new Error(`Sky grade: \`ease\` must be 'linear' or 'smooth'; got ${JSON.stringify(input.ease)}.`)
  }

  const shape: GradeShape = { ...from.shape }
  if (input.shape) {
    for (const k of Object.keys(DEFAULT_SHAPE) as (keyof GradeShape)[]) {
      const v = finite(`shape.${k}`, input.shape[k], shape[k])
      shape[k] = Math.max(0.1, v)
    }
  }

  const zones = {} as Record<GradeZoneName, GradeZone>
  for (const z of GRADE_ZONES) zones[z] = resolveZone(input.zones?.[z], from.zones[z])

  const fill: GradeFill = {
    zenith: input.fill?.zenith !== undefined ? toColor(input.fill.zenith) : from.fill.zenith.clone(),
    horizon: input.fill?.horizon !== undefined ? toColor(input.fill.horizon) : from.fill.horizon.clone(),
    intensity: Math.max(0, finite('fill.intensity', input.fill?.intensity, from.fill.intensity)),
  }

  return {
    elevation: clamp(elevation, -90, 90),
    ease: input.ease ?? from.ease,
    exposure: finite('exposure', input.exposure, from.exposure),
    saturation: Math.max(0, finite('saturation', input.saturation, from.saturation)),
    temperature: clamp(finite('temperature', input.temperature, from.temperature), -1, 1),
    tint: clamp(finite('tint', input.tint, from.tint), -1, 1),
    hue: finite('hue', input.hue, from.hue),
    shape,
    zones,
    fill,
    gradient: resolveGradient(input.gradient, from.gradient),
    ambient: resolveAmbient(input.ambient, from.ambient),
  }
}

/** Deep copy of a resolved keyframe. */
export function cloneGradeKey(key: SkyGradeKey): SkyGradeKey {
  return resolveGradeKey({}, key)
}

// ---------------------------------------------------------------------------
// Global operator

/** Row-major 3×3 multiply, `a · b`. */
function mul3(a: number[], b: number[]): number[] {
  const out = new Array(9)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
  return out
}

/**
 * The keyframe's global operator `M` (row-major): white balance, then hue,
 * then saturation, then exposure. Linear, so it grades haze exactly like sky.
 */
export function gradeKeyMatrix(key: SkyGradeKey): number[] {
  // White balance: warm raises red and lowers blue, magenta lowers green;
  // normalised so white keeps its luminance.
  const wr = 1 + 0.3 * key.temperature
  const wg = 1 - 0.3 * key.tint
  const wb = 1 - 0.3 * key.temperature
  const wl = LUM[0] * wr + LUM[1] * wg + LUM[2] * wb
  const balance = [wr / wl, 0, 0, 0, wg / wl, 0, 0, 0, wb / wl]

  // Hue rotation about the grey axis, luminance-preserving (the CSS
  // `hue-rotate` matrix, with Rec. 709 weights).
  const h = (key.hue * Math.PI) / 180
  const c = Math.cos(h)
  const s = Math.sin(h)
  const [lr, lg, lb] = LUM
  const hue = [
    lr + c * (1 - lr) - s * lr,
    lg - c * lg - s * lg,
    lb - c * lb + s * (1 - lb),
    lr - c * lr + s * 0.143,
    lg + c * (1 - lg) + s * 0.14,
    lb - c * lb - s * 0.283,
    lr - c * lr - s * (1 - lr),
    lg - c * lg + s * lg,
    lb + c * (1 - lb) + s * lb,
  ]

  // Saturation: pull toward (or push away from) luminance.
  const k = key.saturation
  const sat = [
    lr + k * (1 - lr),
    lg - k * lg,
    lb - k * lb,
    lr - k * lr,
    lg + k * (1 - lg),
    lb - k * lb,
    lr - k * lr,
    lg - k * lg,
    lb + k * (1 - lb),
  ]

  const e = Math.pow(2, key.exposure)
  const m = mul3(sat, mul3(hue, balance))
  for (let i = 0; i < 9; i++) m[i] *= e
  return m
}

// ---------------------------------------------------------------------------
// Table parameterisation — the TSL sampler mirrors these. Change both together.

/** Azimuth from the sun (deg, 0..180) → table u (texel centres at the ends). */
export function gradeAzimuthToU(azimuthDeg: number): number {
  const x = clamp(Math.abs(azimuthDeg), 0, 180) / 180
  return (x * (GRADE_AZIMUTH_RES - 1) + 0.5) / GRADE_AZIMUTH_RES
}

/**
 * View elevation (deg) → table v. Square-root packed toward the horizon, as
 * Hillaire's Sky-View LUT: the first row off the horizon is ~0.1° up, the
 * zenith rows ~5° apart. Horizon bands want the resolution; the zenith is smooth.
 */
export function gradeElevationToV(elevationDeg: number): number {
  const e = clamp(elevationDeg, -90, 90) / 90
  const s = Math.sign(e) * Math.sqrt(Math.abs(e))
  const x = (s + 1) / 2
  return (x * (GRADE_ELEVATION_RES - 1) + 0.5) / GRADE_ELEVATION_RES
}

/** Row `j` of the table → its view elevation in degrees. */
export function gradeRowElevation(j: number): number {
  const s = (j / (GRADE_ELEVATION_RES - 1)) * 2 - 1
  return Math.sign(s) * s * s * 90
}

/** Column `i` of the table → its azimuth from the sun in degrees. */
export function gradeColumnAzimuth(i: number): number {
  return (i / (GRADE_AZIMUTH_RES - 1)) * 180
}

/** How much each zone covers one direction (0..1). `zenith` + `horizon` = 1; the rest are overlays. */
export type GradeZoneWeights = Record<GradeZoneName, number>

/**
 * Zone coverage at a direction for one keyframe: the masks the bake composites
 * with, exported for editors (hit-testing, guides). The glow is placed for a
 * sun at the keyframe's own elevation.
 */
export function gradeZoneWeights(
  key: SkyGradeKey,
  viewElevationDeg: number,
  azimuthDeg: number,
  target?: GradeZoneWeights,
): GradeZoneWeights {
  const out = target ?? ({} as GradeZoneWeights)
  const { shape } = key
  const e = viewElevationDeg
  const az = clamp(Math.abs(azimuthDeg), 0, 180)
  const wz = smoothstep(0, shape.horizonHeight, e)
  const band = 1 - wz
  const er = (e * Math.PI) / 180
  const sr = (key.elevation * Math.PI) / 180
  const cosGamma = Math.sin(er) * Math.sin(sr) + Math.cos(er) * Math.cos(sr) * Math.cos((az * Math.PI) / 180)
  const gamma = (Math.acos(clamp(cosGamma, -1, 1)) * 180) / Math.PI
  out.zenith = wz
  out.horizon = band
  out.sunward = smoothstep(shape.sunwardWidth, 0, az) * band
  out.antisun = smoothstep(180 - shape.antisunWidth, 180, az) * band
  out.glow = smoothstep(shape.glowSize, 0, gamma)
  out.ground = e < 0 ? smoothstep(0, -GROUND_BLEND_DEG, e) : 0
  return out
}

const _weights = {} as GradeZoneWeights

/**
 * The per-direction operator of one keyframe — what one texel of its table
 * slice holds.
 */
export function evaluateGradeTexel(
  key: SkyGradeKey,
  viewElevationDeg: number,
  azimuthDeg: number,
  target?: GradeTexel,
): GradeTexel {
  const out = target ?? { colorize: [0, 0, 0], amount: 0, gain: 1, fill: [0, 0, 0] }
  const { zones } = key
  const w = gradeZoneWeights(key, viewElevationDeg, azimuthDeg, _weights)
  const wz = w.zenith
  const wSun = w.sunward
  const wAnti = w.antisun
  const wGlow = w.glow
  const wGround = w.ground

  // Base layer: horizon ↔ zenith, premultiplied so an untouched zone (amount 0)
  // pulls nothing toward its colour.
  const zh = zones.horizon
  const zz = zones.zenith
  const nh = normalizedTarget(zh.color)
  const nz = normalizedTarget(zz.color)
  let pr = lerp(nh[0] * zh.amount, nz[0] * zz.amount, wz)
  let pg = lerp(nh[1] * zh.amount, nz[1] * zz.amount, wz)
  let pb = lerp(nh[2] * zh.amount, nz[2] * zz.amount, wz)
  let a = lerp(zh.amount, zz.amount, wz)
  let ev = lerp(zh.brightness, zz.brightness, wz)

  // Gradient layer: its colorize composites over the base like a layer of
  // opacity `amount`; its `replace` share is taken out of the gain and added
  // back as fill (below), so the operator stays affine.
  const grad = key.gradient
  let replace = 0
  if (grad) {
    const g = sampleGradient(grad.stops, viewElevationDeg, _gradientRgb)
    const alpha = grad.amount
    if (alpha > 0) {
      const n = normalizedRgb(g[0], g[1], g[2])
      pr = pr * (1 - alpha) + n[0] * alpha
      pg = pg * (1 - alpha) + n[1] * alpha
      pb = pb * (1 - alpha) + n[2] * alpha
      a = a * (1 - alpha) + alpha
    }
    replace = grad.replace
  }

  // Overlays composite over the base like layers: alpha = mask × amount, so a
  // zone left at amount 0 is transparent. Brightness offsets add, by mask.
  const over = (zone: GradeZone, mask: number) => {
    if (mask <= 0) return
    const alpha = mask * zone.amount
    if (alpha > 0) {
      const n = normalizedTarget(zone.color)
      pr = pr * (1 - alpha) + n[0] * alpha
      pg = pg * (1 - alpha) + n[1] * alpha
      pb = pb * (1 - alpha) + n[2] * alpha
      a = a * (1 - alpha) + alpha
    }
    ev += mask * zone.brightness
  }
  over(zones.sunward, wSun)
  over(zones.antisun, wAnti)
  over(zones.glow, wGlow)
  over(zones.ground, wGround)

  out.colorize[0] = pr
  out.colorize[1] = pg
  out.colorize[2] = pb
  out.amount = a
  // Brightness scales the physical part and the replaced gradient alike, so a
  // glow's brightness still lights up a fixed-colour sky.
  const gain = Math.pow(2, ev)
  out.gain = gain * (1 - replace)

  const f = key.fill
  const rg = replace * gain
  out.fill[0] = lerp(f.horizon.r, f.zenith.r, wz) * f.intensity + (grad ? _gradientRgb[0] * rg : 0)
  out.fill[1] = lerp(f.horizon.g, f.zenith.g, wz) * f.intensity + (grad ? _gradientRgb[1] * rg : 0)
  out.fill[2] = lerp(f.horizon.b, f.zenith.b, wz) * f.intensity + (grad ? _gradientRgb[2] * rg : 0)
  return out
}

const _gradientRgb: [number, number, number] = [0, 0, 0]

function normalizedRgb(r: number, g: number, b: number): [number, number, number] {
  const avg = (r + g + b) / 3
  if (avg < 1e-5) return [1, 1, 1]
  return [r / avg, g / avg, b / avg]
}

/** A colorize target scaled so its channel average is 1 (grey for black). */
function normalizedTarget(c: Color): [number, number, number] {
  const avg = (c.r + c.g + c.b) / 3
  if (avg < 1e-5) return [1, 1, 1]
  return [c.r / avg, c.g / avg, c.b / avg]
}

/**
 * Apply an operator to a linear colour, in place — the CPU twin of the TSL
 * node. `fillWeight` is 1 for sky, the haze opacity for aerial perspective;
 * `displayScale` is `1 / toneMappingExposure`.
 */
export function applyGradeOperator(
  rgb: [number, number, number],
  matrix: number[],
  texel: GradeTexel,
  { fillWeight = 1, displayScale = 1 }: { fillWeight?: number; displayScale?: number } = {},
): [number, number, number] {
  const [r, g, b] = rgb
  const c1r = Math.max(0, matrix[0] * r + matrix[1] * g + matrix[2] * b)
  const c1g = Math.max(0, matrix[3] * r + matrix[4] * g + matrix[5] * b)
  const c1b = Math.max(0, matrix[6] * r + matrix[7] * g + matrix[8] * b)
  const avg = (c1r + c1g + c1b) / 3
  const keep = 1 - texel.amount
  rgb[0] = (c1r * keep + texel.colorize[0] * avg) * texel.gain + texel.fill[0] * displayScale * fillWeight
  rgb[1] = (c1g * keep + texel.colorize[1] * avg) * texel.gain + texel.fill[1] * displayScale * fillWeight
  rgb[2] = (c1b * keep + texel.colorize[2] * avg) * texel.gain + texel.fill[2] * displayScale * fillWeight
  return rgb
}

function lerpTexel(a: GradeTexel, b: GradeTexel, t: number, out: GradeTexel): GradeTexel {
  for (let i = 0; i < 3; i++) {
    out.colorize[i] = lerp(a.colorize[i], b.colorize[i], t)
    out.fill[i] = lerp(a.fill[i], b.fill[i], t)
  }
  out.amount = lerp(a.amount, b.amount, t)
  out.gain = lerp(a.gain, b.gain, t)
  return out
}

function lerpColor(a: Color, b: Color, t: number): Color {
  return a.clone().lerp(b, t)
}

/** The table, as float arrays in texture order (`((k · EL + j) · AZ + i) · 4`). */
export interface SkyGradeBake {
  /** RGB = colorize (premultiplied), A = amount. */
  colorize: Float32Array
  /** RGB = fill, A = gain. */
  fillGain: Float32Array
  /** Keyframes baked (slices past this are left as identity). */
  keyCount: number
}

type Listener = (grade: SkyGrade) => void

/**
 * An authored grade: a sorted list of keyframes, the bake into a lookup
 * table, and save/load. Mutate it with the methods below; every change
 * notifies `onChange` listeners, which is how a sky using it re-bakes (its
 * cube only, never the atmosphere LUTs).
 *
 * ```js
 * const grade = new SkyGrade({ keys: [
 *   { elevation: -12, fill: { intensity: 0.6 }, ambient: { intensity: 0.5 } },
 *   { elevation: 2, zones: { antisun: { color: '#e9a3c9', amount: 0.6 } } },
 *   { elevation: 30 },
 * ] })
 * sky.setGrade(grade)
 * grade.updateKey(1, { zones: { horizon: { color: '#ffb27a', amount: 0.4 } } }) // live
 * localStorage.grade = JSON.stringify(grade)
 * ```
 */
export class SkyGrade {
  name: string
  /** Sorted by elevation. Do not mutate in place — use `updateKey`. */
  keys: SkyGradeKey[] = []
  /** Bumped on every change. */
  revision = 0
  _listeners = new Set<Listener>()
  /** Global operator per keyframe, cached for `evaluate`. */
  _matrices: number[][] = []

  constructor(input: SkyGradeInput | SkyGradeKeyInput[] | SkyGradeJSON = { keys: [] }) {
    const keys = Array.isArray(input) ? input : input.keys
    this.name = Array.isArray(input) ? '' : (input.name ?? '')
    this._setKeysSilently(keys.map((k) => resolveGradeKey(k)))
  }

  /** Load a saved grade (`toJSON()` output, or the parsed object). */
  static fromJSON(json: SkyGradeJSON | string): SkyGrade {
    const data = typeof json === 'string' ? (JSON.parse(json) as SkyGradeJSON) : json
    if (!data || data.format !== GRADE_FORMAT) {
      throw new Error(`Sky grade: not a saved grade (expected format "${GRADE_FORMAT}").`)
    }
    if (data.version > GRADE_VERSION) {
      throw new Error(`Sky grade: saved with format version ${data.version}; this build reads up to ${GRADE_VERSION}.`)
    }
    return new SkyGrade({ name: data.name, keys: data.keys })
  }

  toJSON(): SkyGradeJSON {
    const hex = (c: Color) => `#${c.getHexString()}`
    return {
      format: GRADE_FORMAT,
      version: GRADE_VERSION,
      ...(this.name ? { name: this.name } : {}),
      keys: this.keys.map((k) => {
        const zones: SkyGradeKeyJSON['zones'] = {}
        for (const z of GRADE_ZONES) {
          const zone = k.zones[z]
          if (zone.amount === 0 && zone.brightness === 0) continue
          zones[z] = { color: hex(zone.color), amount: zone.amount, brightness: zone.brightness }
        }
        return {
          elevation: k.elevation,
          ease: k.ease,
          exposure: k.exposure,
          saturation: k.saturation,
          temperature: k.temperature,
          tint: k.tint,
          hue: k.hue,
          shape: { ...k.shape },
          zones,
          fill: { zenith: hex(k.fill.zenith), horizon: hex(k.fill.horizon), intensity: k.fill.intensity },
          gradient: k.gradient
            ? {
                stops: k.gradient.stops.map((st) => ({ at: st.at, color: hex(st.color), ease: st.ease })),
                amount: k.gradient.amount,
                replace: k.gradient.replace,
              }
            : null,
          ambient: k.ambient
            ? { color: hex(k.ambient.color), groundColor: hex(k.ambient.groundColor), intensity: k.ambient.intensity }
            : null,
        }
      }),
    }
  }

  clone(): SkyGrade {
    const g = new SkyGrade({ name: this.name, keys: [] })
    g._setKeysSilently(this.keys.map(cloneGradeKey))
    return g
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  onChange(fn: Listener): () => void {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  /** Replace every keyframe. */
  setKeys(keys: (SkyGradeKeyInput | SkyGradeKey)[]): this {
    this._setKeysSilently(keys.map((k) => resolveGradeKey(k as Partial<SkyGradeKeyInput>)))
    return this._changed()
  }

  /** Add a keyframe and return it. Throws past {@link MAX_GRADE_KEYS}. */
  addKey(input: SkyGradeKeyInput): SkyGradeKey {
    if (this.keys.length >= MAX_GRADE_KEYS) {
      throw new Error(`Sky grade: at most ${MAX_GRADE_KEYS} keyframes.`)
    }
    const key = resolveGradeKey(input)
    this._setKeysSilently([...this.keys, key])
    this._changed()
    return key
  }

  /**
   * Add a keyframe at `elevation` that starts from what the grade already does
   * there (its neighbours' settings, interpolated), so adding it changes
   * nothing until it is edited. Returns the existing keyframe if one sits there.
   */
  insertKeyAt(elevation: number, tolerance = 0.05): SkyGradeKey {
    const existing = this.keyAt(elevation, tolerance)
    if (existing) return existing
    return this.addKey(this.interpolatedKeyInput(elevation))
  }

  /** Change a keyframe (by index or reference). Nested fields merge. Returns the new keyframe. */
  updateKey(which: number | SkyGradeKey, patch: Partial<SkyGradeKeyInput>): SkyGradeKey {
    const index = this._indexOf(which)
    const key = resolveGradeKey(patch, this.keys[index])
    const keys = this.keys.slice()
    keys[index] = key
    this._setKeysSilently(keys)
    this._changed()
    return key
  }

  removeKey(which: number | SkyGradeKey): this {
    const index = this._indexOf(which)
    this._setKeysSilently(this.keys.filter((_, i) => i !== index))
    return this._changed()
  }

  /** The keyframe within `tolerance` degrees of `elevation`, if any. */
  keyAt(elevation: number, tolerance = 0.05): SkyGradeKey | null {
    let best: SkyGradeKey | null = null
    for (const k of this.keys) {
      const d = Math.abs(k.elevation - elevation)
      if (d <= tolerance && (!best || d < Math.abs(best.elevation - elevation))) best = k
    }
    return best
  }

  /**
   * Keyframe settings interpolated at `elevation` — what {@link insertKeyAt}
   * starts from. Interpolates the settings, not the table, so on a segment
   * whose two ends differ in shape the result is close to, not exactly, the
   * table in between.
   */
  interpolatedKeyInput(elevation: number): SkyGradeKeyInput {
    const n = this.keys.length
    if (n === 0) return { elevation }
    const { index, fraction } = this._segment(elevation)
    const a = this.keys[index]
    const b = this.keys[Math.min(index + 1, n - 1)]
    const t = fraction
    const zones: Partial<Record<GradeZoneName, GradeZoneInput>> = {}
    for (const z of GRADE_ZONES) {
      zones[z] = {
        color: lerpColor(a.zones[z].color, b.zones[z].color, t),
        amount: lerp(a.zones[z].amount, b.zones[z].amount, t),
        brightness: lerp(a.zones[z].brightness, b.zones[z].brightness, t),
      }
    }
    const shape = {} as GradeShape
    for (const k of Object.keys(DEFAULT_SHAPE) as (keyof GradeShape)[]) shape[k] = lerp(a.shape[k], b.shape[k], t)
    const ambient = lerpAmbient(a.ambient, b.ambient, t)
    const gradient = lerpGradient(a.gradient, b.gradient, t)
    return {
      elevation,
      ease: b.ease,
      exposure: lerp(a.exposure, b.exposure, t),
      saturation: lerp(a.saturation, b.saturation, t),
      temperature: lerp(a.temperature, b.temperature, t),
      tint: lerp(a.tint, b.tint, t),
      hue: lerp(a.hue, b.hue, t),
      shape,
      zones,
      fill: {
        zenith: lerpColor(a.fill.zenith, b.fill.zenith, t),
        horizon: lerpColor(a.fill.horizon, b.fill.horizon, t),
        intensity: lerp(a.fill.intensity, b.fill.intensity, t),
      },
      gradient,
      ambient: ambient
        ? { color: ambient.color, groundColor: ambient.groundColor, intensity: ambient.intensity }
        : null,
    }
  }

  /**
   * Where `sunElevationDeg` falls between keyframes, the global operator
   * there, and the ambient. This is all the sky needs per sun move: two
   * uniform writes.
   */
  evaluate(sunElevationDeg: number): SkyGradeEvaluation {
    const n = this.keys.length
    if (n === 0) {
      return { index: 0, fraction: 0, w: 0.5 / MAX_GRADE_KEYS, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], ambient: null }
    }
    const { index, fraction } = this._segment(sunElevationDeg)
    const ma = this._matrices[index]
    const mb = this._matrices[Math.min(index + 1, n - 1)]
    const matrix = ma.map((v, i) => lerp(v, mb[i], fraction))
    const a = this.keys[index]
    const b = this.keys[Math.min(index + 1, n - 1)]
    let ambient = lerpAmbient(a.ambient, b.ambient, fraction)
    // Between two keyframes without one, in a grade that has one elsewhere:
    // off, not "unset" (which would hand the light back to SkyAmbient's own values).
    if (!ambient) {
      const lit = this.keys.find((k) => k.ambient)?.ambient
      if (lit) ambient = { color: lit.color.clone(), groundColor: lit.groundColor.clone(), intensity: 0 }
    }
    return {
      index,
      fraction,
      w: (index + fraction + 0.5) / MAX_GRADE_KEYS,
      matrix,
      ambient,
    }
  }

  /** Whether any keyframe carries an ambient light. */
  get hasAmbient(): boolean {
    return this.keys.some((k) => k.ambient !== null)
  }

  /**
   * The full operator at one sun elevation and view direction — the CPU twin
   * of what the sky shader samples (up to the table's bilinear filtering),
   * for swatches and tests.
   */
  sample(
    sunElevationDeg: number,
    viewElevationDeg: number,
    azimuthDeg: number,
  ): { matrix: number[]; texel: GradeTexel } {
    const ev = this.evaluate(sunElevationDeg)
    const texel: GradeTexel = { colorize: [0, 0, 0], amount: 0, gain: 1, fill: [0, 0, 0] }
    if (this.keys.length === 0) return { matrix: ev.matrix, texel }
    const a = evaluateGradeTexel(this.keys[ev.index], viewElevationDeg, azimuthDeg)
    const b = evaluateGradeTexel(this.keys[Math.min(ev.index + 1, this.keys.length - 1)], viewElevationDeg, azimuthDeg)
    return { matrix: ev.matrix, texel: lerpTexel(a, b, ev.fraction, texel) }
  }

  /** Grade a linear colour on the CPU (see {@link applyGradeOperator}). */
  apply(
    rgb: [number, number, number],
    sunElevationDeg: number,
    viewElevationDeg: number,
    azimuthDeg: number,
    options?: { fillWeight?: number; displayScale?: number },
  ): [number, number, number] {
    const { matrix, texel } = this.sample(sunElevationDeg, viewElevationDeg, azimuthDeg)
    return applyGradeOperator(rgb, matrix, texel, options)
  }

  /**
   * Bake the lookup table: one (azimuth × elevation) slice per keyframe. Pure
   * CPU, ~2k texels a keyframe — cheap enough to run on every slider tick.
   */
  bake(target?: SkyGradeBake): SkyGradeBake {
    const sliceTexels = GRADE_AZIMUTH_RES * GRADE_ELEVATION_RES
    const size = sliceTexels * MAX_GRADE_KEYS * 4
    const out: SkyGradeBake = target ?? {
      colorize: new Float32Array(size),
      fillGain: new Float32Array(size),
      keyCount: 0,
    }
    const texel: GradeTexel = { colorize: [0, 0, 0], amount: 0, gain: 1, fill: [0, 0, 0] }
    const rowElevation = Array.from({ length: GRADE_ELEVATION_RES }, (_, j) => gradeRowElevation(j))
    const colAzimuth = Array.from({ length: GRADE_AZIMUTH_RES }, (_, i) => gradeColumnAzimuth(i))

    for (let k = 0; k < MAX_GRADE_KEYS; k++) {
      const key = this.keys[k]
      for (let j = 0; j < GRADE_ELEVATION_RES; j++) {
        for (let i = 0; i < GRADE_AZIMUTH_RES; i++) {
          const o = ((k * GRADE_ELEVATION_RES + j) * GRADE_AZIMUTH_RES + i) * 4
          if (!key) {
            // Identity: no colorize, gain 1, no fill.
            out.colorize[o] = out.colorize[o + 1] = out.colorize[o + 2] = out.colorize[o + 3] = 0
            out.fillGain[o] = out.fillGain[o + 1] = out.fillGain[o + 2] = 0
            out.fillGain[o + 3] = 1
            continue
          }
          evaluateGradeTexel(key, rowElevation[j], colAzimuth[i], texel)
          out.colorize[o] = texel.colorize[0]
          out.colorize[o + 1] = texel.colorize[1]
          out.colorize[o + 2] = texel.colorize[2]
          out.colorize[o + 3] = texel.amount
          out.fillGain[o] = texel.fill[0]
          out.fillGain[o + 1] = texel.fill[1]
          out.fillGain[o + 2] = texel.fill[2]
          out.fillGain[o + 3] = texel.gain
        }
      }
    }
    out.keyCount = this.keys.length
    return out
  }

  _segment(elevation: number): { index: number; fraction: number } {
    const keys = this.keys
    const n = keys.length
    if (n <= 1 || elevation <= keys[0].elevation) return { index: 0, fraction: 0 }
    if (elevation >= keys[n - 1].elevation) return { index: n - 1, fraction: 0 }
    let i = 0
    while (i < n - 2 && elevation >= keys[i + 1].elevation) i++
    const a = keys[i].elevation
    const b = keys[i + 1].elevation
    const raw = b > a ? (elevation - a) / (b - a) : 1
    const fraction = keys[i + 1].ease === 'smooth' ? raw * raw * (3 - 2 * raw) : raw
    return { index: i, fraction }
  }

  _indexOf(which: number | SkyGradeKey): number {
    const index = typeof which === 'number' ? which : this.keys.indexOf(which)
    if (index < 0 || index >= this.keys.length || !Number.isInteger(index)) {
      throw new Error(`Sky grade: no keyframe ${typeof which === 'number' ? which : '(not in this grade)'}.`)
    }
    return index
  }

  _setKeysSilently(keys: SkyGradeKey[]): void {
    if (keys.length > MAX_GRADE_KEYS) throw new Error(`Sky grade: at most ${MAX_GRADE_KEYS} keyframes.`)
    this.keys = keys.slice().sort((a, b) => a.elevation - b.elevation)
    this._matrices = this.keys.map(gradeKeyMatrix)
  }

  _changed(): this {
    this.revision++
    for (const fn of this._listeners) fn(this)
    return this
  }
}

/**
 * Interpolate gradients for `interpolatedKeyInput`: both are resampled onto
 * the union of their stop positions and blended linearly (eases are baked
 * into the resampled colours). A missing side contributes amount and replace 0.
 */
function lerpGradient(a: GradeGradient | null, b: GradeGradient | null, t: number): GradeGradientInput | null {
  if (!a && !b) return null
  const from = a ?? b!
  const to = b ?? a!
  const positions = [...new Set([...from.stops, ...to.stops].map((st) => st.at))].sort((x, y) => x - y)
  const ca: [number, number, number] = [0, 0, 0]
  const cb: [number, number, number] = [0, 0, 0]
  return {
    stops: positions.map((at) => {
      sampleGradient(from.stops, at, ca)
      sampleGradient(to.stops, at, cb)
      return { at, color: [lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t)] }
    }),
    amount: lerp(a?.amount ?? 0, b?.amount ?? 0, t),
    replace: lerp(a?.replace ?? 0, b?.replace ?? 0, t),
  }
}

/**
 * Interpolate ambients. A keyframe without one counts as off (intensity 0)
 * with its neighbour's colours, so the light fades instead of popping.
 */
function lerpAmbient(a: GradeAmbient | null, b: GradeAmbient | null, t: number): GradeAmbient | null {
  if (!a && !b) return null
  const from = a ?? { color: b!.color, groundColor: b!.groundColor, intensity: 0 }
  const to = b ?? { color: a!.color, groundColor: a!.groundColor, intensity: 0 }
  return {
    color: lerpColor(from.color, to.color, t),
    groundColor: lerpColor(from.groundColor, to.groundColor, t),
    intensity: lerp(from.intensity, to.intensity, t),
  }
}

/** Registered grades, keyed by name. */
export const grades: Record<string, SkyGradeInput> = {}

/** Register a grade definition under `name` (each `resolveGrade(name)` builds a fresh, independent `SkyGrade`). */
export function registerGrade(name: string, input: SkyGradeInput | SkyGradeKeyInput[]): void {
  grades[name] = Array.isArray(input) ? { name, keys: input } : { name, ...input }
}

/** A registered name, a definition, a saved grade (object or JSON string) or a `SkyGrade` → a `SkyGrade`. */
export function resolveGrade(input: string | SkyGrade | SkyGradeInput | SkyGradeKeyInput[] | SkyGradeJSON): SkyGrade {
  if (input instanceof SkyGrade) return input
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (trimmed.startsWith('{')) return SkyGrade.fromJSON(trimmed)
    const found = grades[input]
    if (!found) {
      throw new Error(`Unknown grade: "${input}". Available: ${Object.keys(grades).join(', ') || '(none registered)'}`)
    }
    return new SkyGrade(found)
  }
  if (!Array.isArray(input) && (input as SkyGradeJSON).format !== undefined) {
    return SkyGrade.fromJSON(input as SkyGradeJSON)
  }
  return new SkyGrade(input as SkyGradeInput | SkyGradeKeyInput[])
}

// ---------------------------------------------------------------------------
// Gradient helpers: the quick ways to a grade. Each returns an editable
// one-keyframe `SkyGrade`, which holds at every time of day.

export interface GradientGradeOptions {
  /** 0..1 hue swap toward the gradient, keeping physical brightness. Default 1. */
  amount?: number
  /**
   * 0..1 mix toward the gradient's own colour and brightness. Default 1: the
   * sky shows exactly the authored colours, the same all day. Lower it to
   * keep some of the physical sky's brightness (and its sun, night and haze
   * response) under the gradient.
   */
  replace?: number
  name?: string
}

/**
 * A grade that paints the sky with a gradient over elevation (degrees).
 *
 * ```js
 * sky.setGrade(gradientGrade([
 *   { at: -10, color: '#2a2438' },
 *   { at: 0, color: '#ffb27a' },
 *   { at: 20, color: '#8f7fc8', ease: 'smooth' },
 *   { at: 90, color: '#28306a' },
 * ]))
 * ```
 */
export function gradientGrade(
  stops: GradeGradientStopInput[],
  { amount = 1, replace = 1, name = '' }: GradientGradeOptions = {},
): SkyGrade {
  return new SkyGrade({ name, keys: [{ elevation: 0, gradient: { stops, amount, replace } }] })
}

export interface HorizonToZenithOptions extends GradientGradeOptions {
  /** Easing from horizon to zenith colour. Default `'smooth'`. */
  ease?: GradientEase
  /** Elevation (degrees) where the zenith colour is reached. Default 90. */
  height?: number
  /** Colour below the horizon. Default: the horizon colour continues. */
  ground?: ColorInput
}

/**
 * Two-colour sky: `horizon` at the horizon to `zenith` overhead.
 *
 * ```js
 * sky.setGrade(horizonToZenith('#f3c98f', '#4f8fdb'))                    // fixed colours
 * sky.setGrade(horizonToZenith('#f3c98f', '#4f8fdb', { replace: 0 }))    // hue only, physical brightness
 * ```
 */
export function horizonToZenith(
  horizon: ColorInput,
  zenith: ColorInput,
  { ease = 'smooth', height = 90, ground, ...options }: HorizonToZenithOptions = {},
): SkyGrade {
  const stops: GradeGradientStopInput[] = []
  if (ground !== undefined) stops.push({ at: -GROUND_BLEND_DEG, color: ground })
  stops.push({ at: 0, color: horizon }, { at: height, color: zenith, ease })
  return gradientGrade(stops, options)
}

/** One colour over the whole sky (`replace: 1` by default: exactly that colour, all day). */
export function solidSky(color: ColorInput, options: GradientGradeOptions = {}): SkyGrade {
  return gradientGrade([{ at: 0, color }], options)
}

// ---------------------------------------------------------------------------
// Built-in grades. Starting points for the editor as much as finished looks.

/** A blue night instead of a black one: fill and ambient light only, the day stays physical. */
registerGrade('blue-night', [
  {
    elevation: -18,
    fill: { zenith: '#0b1836', horizon: '#1e2f58', intensity: 0.9 },
    ambient: { color: '#7088c0', groundColor: '#121a2c', intensity: 1 },
  },
  {
    elevation: -8,
    fill: { zenith: '#0b1836', horizon: '#26386a', intensity: 0.45 },
    ambient: { color: '#7890c4', groundColor: '#141c2e', intensity: 0.6 },
  },
  { elevation: 2, ambient: { color: '#8aa0d0', groundColor: '#1a1e28', intensity: 0 } },
])

/**
 * Storybook: soft cerulean days, a peach-and-lilac dusk with a pink anti-sun
 * belt, and a deep periwinkle night with a blue fill light.
 */
registerGrade('storybook', [
  {
    elevation: -18,
    saturation: 0.9,
    zones: { zenith: { color: '#2a3f8f', amount: 0.6 }, horizon: { color: '#4a5aa8', amount: 0.5 } },
    fill: { zenith: '#0d1a3d', horizon: '#24346a', intensity: 1 },
    ambient: { color: '#6c84c4', groundColor: '#131b30', intensity: 1 },
  },
  {
    elevation: -7,
    ease: 'smooth',
    zones: {
      zenith: { color: '#3d4fa8', amount: 0.55 },
      horizon: { color: '#8a78c8', amount: 0.5 },
      sunward: { color: '#e89a7a', amount: 0.55, brightness: 0.3 },
      antisun: { color: '#7a6ab0', amount: 0.4 },
    },
    fill: { zenith: '#101d44', horizon: '#2a3570', intensity: 0.55 },
    ambient: { color: '#7a86c4', groundColor: '#18192c', intensity: 0.6 },
  },
  {
    elevation: 0,
    shape: { horizonHeight: 25, sunwardWidth: 80, antisunWidth: 70, glowSize: 22 },
    zones: {
      zenith: { color: '#6a8fd8', amount: 0.45 },
      horizon: { color: '#f2b98f', amount: 0.35 },
      sunward: { color: '#ff9e6e', amount: 0.55, brightness: 0.2 },
      antisun: { color: '#e9a3c9', amount: 0.6, brightness: 0.15 },
      glow: { color: '#ffd59a', amount: 0.5 },
    },
    ambient: { color: '#8a86c0', groundColor: '#20182a', intensity: 0.15 },
  },
  {
    elevation: 8,
    ease: 'smooth',
    shape: { horizonHeight: 30, glowSize: 25 },
    zones: {
      zenith: { color: '#5d8fdc', amount: 0.4 },
      horizon: { color: '#f3d2a8', amount: 0.35 },
      sunward: { color: '#ffc58a', amount: 0.45 },
      antisun: { color: '#b8c4ea', amount: 0.3 },
      glow: { color: '#ffe2b0', amount: 0.4 },
    },
    ambient: { color: '#ffffff', groundColor: '#404040', intensity: 0 },
  },
  {
    elevation: 25,
    saturation: 0.9,
    zones: {
      zenith: { color: '#4f8fdb', amount: 0.4 },
      horizon: { color: '#d8ecf4', amount: 0.35 },
      glow: { color: '#fff4dc', amount: 0.25 },
    },
  },
])
