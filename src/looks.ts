import { Color } from 'three/webgpu'

/**
 * Stylized "looks" — the artist-control layer that sits on top of the physical
 * atmosphere.
 *
 * A look is a colour ramp over view elevation plus two blend strengths. It is
 * applied inside the sky mesh's colourNode (after the SkyView/raymarch branches
 * merge) and again on aerial-perspective inscatter, so background, cube, PMREM
 * IBL and haze all agree. See `research/stylized-ghibli-sky.md`.
 *
 * This module is pure data + math — no TSL, no renderer. It owns the vocabulary
 * (`Look`, stops, easing, tracks) and the packing contract the shader consumes,
 * so both the TSL node and any GUI can be built against it.
 *
 * ## The two blend axes
 *
 * `chroma` swaps the physical chromaticity toward the ramp while keeping the
 * physical luminance. This is what preserves altitude/sun-angle response, and
 * what lets haze stay coherent — the ratio is scale-invariant, so the same
 * remap applies to a partial-path AP inscatter as to the full sky integral.
 *
 * `value` additionally overrides physical luminance with the ramp's own. Needed
 * for artificial moonlight, where the physical night sky is ~0 and no chroma
 * operation can rescue it. Because that axis compares an authored 0..1 ramp
 * against scene luminance, it needs `intensity` to put them in the same units.
 *
 *   physical        chroma 0   value 0
 *   grade           chroma 1   value 0    (default when unspecified)
 *   ghibli          chroma 0.7 value 0.25
 *   full override   chroma 1   value 1
 *
 * Only the chroma axis is scale-invariant, which is why aerial perspective
 * applies the look with `value` forced to 0 — it must keep the magnitude its
 * own partial-path integral produced.
 *
 * ## The elevation axis
 *
 * Stop positions (`at`) are **sin(elevation)**: -1 nadir, 0 horizon, 1 zenith.
 * That is exactly the `viewZenithCosAngle` the sky mesh already computes, so
 * the shader needs no conversion — and sin's curvature spends more of the range
 * near the horizon, which is where ramps want the resolution.
 *
 * Sampling below the first stop or above the last clamps to that stop's colour.
 */

/** Colour inputs. Strings and hex numbers are treated as sRGB and converted to
 *  the linear working space; arrays and `{r,g,b}` objects are taken as already
 *  linear (matching how `groundAlbedo` treats raw numbers). */
export type ColorInput = string | number | Color | { r: number; g: number; b: number } | number[]

/**
 * Easing for the segment *entering* a stop from the previous one.
 * `'linear'` | `'smooth'` (smoothstep) | a number `n` for `pow(t, n)` —
 * `n > 1` holds the earlier colour longer, `n < 1` reaches the later one sooner.
 */
export type LookEase = 'linear' | 'smooth' | number

export interface LookStop {
  /** sin(elevation): -1 nadir, 0 horizon, 1 zenith. */
  at: number
  color: ColorInput
  ease?: LookEase
}

/** Optional sun-relative tint layer, driven by `lightViewCosAngle`. This is
 *  what keeps a ramp from being sun-blind. */
export interface LookSunTint {
  color: ColorInput
  /** Angular width of the tint lobe around the sun, 0..1. Larger = broader. */
  falloff?: number
  /** 0..1 blend of the tint into the ramp colour. */
  strength?: number
}

/** What callers pass to `registerLook` / `setLook`. */
export interface LookInput {
  /** Name of a registered look to use as the base; remaining fields override it. */
  preset?: string
  stops?: LookStop[]
  chroma?: number
  value?: number
  /**
   * Scene luminance corresponding to a ramp value of 1.0, in the same units as
   * the sky mesh's colour after `luminanceScale`. Only the `value` axis reads
   * it. Default 1, which puts a full-range ramp in the ballpark of a physical
   * daytime sky; night looks generally want it raised.
   */
  intensity?: number
  sunTint?: LookSunTint | null
}

export interface ResolvedStop {
  at: number
  color: Color
  /** `pow(t, easeExp)` — 1 is linear. */
  easeExp: number
  /** 0..1 mix toward `smoothstep(0, 1, t)`. */
  easeSmooth: number
}

export interface ResolvedSunTint {
  color: Color
  falloff: number
  strength: number
}

/** A fully normalized look — colours in linear space, stops sorted, defaults filled. */
export interface Look {
  stops: ResolvedStop[]
  chroma: number
  value: number
  intensity: number
  sunTint: ResolvedSunTint | null
}

/**
 * Hard cap on ramp stops. Fixed so the TSL node graph stays static — a variable
 * stop count would recompile the shader on every edit, which defeats the whole
 * point of keeping look params as uniforms. Deliberately generous: a sky ramp
 * wants three or four stops, and exceeding this is a sign the ramp is doing
 * work that belongs in the physical parameters instead.
 */
export const MAX_LOOK_STOPS = 8

/** Stop positions closer than this are treated as the same position when
 *  unioning a track's keyframes. */
const POSITION_EPSILON = 1e-6

/**
 * Floor on a ramp segment's width. Padded slots are zero-width, and this is
 * what collapses them to a hard step that lands outside the sampled range —
 * see {@link evaluatePackedRamp}. The TSL node uses the same value.
 */
export const RAMP_SPAN_EPSILON = 1e-6

const DEFAULT_CHROMA = 1
const DEFAULT_VALUE = 0
const DEFAULT_INTENSITY = 1
const DEFAULT_SUN_FALLOFF = 0.3
const DEFAULT_SUN_STRENGTH = 1

function toColor(input: ColorInput): Color {
  // `new Color(string | number)` runs the sRGB → working-space conversion via
  // three's ColorManagement. Component forms bypass it deliberately.
  if (input instanceof Color) return input.clone()
  if (typeof input === 'string' || typeof input === 'number') return new Color(input)
  if (Array.isArray(input)) return new Color().setRGB(input[0] ?? 0, input[1] ?? 0, input[2] ?? 0)
  return new Color().setRGB(input.r ?? 0, input.g ?? 0, input.b ?? 0)
}

function resolveEase(ease: LookEase | undefined): { easeExp: number; easeSmooth: number } {
  if (ease === undefined || ease === 'linear') return { easeExp: 1, easeSmooth: 0 }
  if (ease === 'smooth') return { easeExp: 1, easeSmooth: 1 }
  if (typeof ease === 'number' && Number.isFinite(ease) && ease > 0) {
    return { easeExp: ease, easeSmooth: 0 }
  }
  throw new Error(`Invalid look ease: ${JSON.stringify(ease)}. Expected 'linear', 'smooth', or a positive number.`)
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** Shared easing curve. The TSL node mirrors this exactly — change both together. */
export function applyEase(t: number, easeExp: number, easeSmooth: number): number {
  const c = clamp01(t)
  const powed = easeExp === 1 ? c : Math.pow(c, easeExp)
  const smoothed = c * c * (3 - 2 * c)
  return powed + (smoothed - powed) * easeSmooth
}

/** Registered looks, keyed by name. Mirrors `presets` in `./presets`. */
export const looks: Record<string, Look> = {}

/** Registered tracks, keyed by name. See {@link registerLookTrack}. */
export const lookTracks: Record<string, LookTrack> = {}

/**
 * Normalize a look input into a {@link Look}. Accepts a registered name, or an
 * object which may name a `preset` to inherit from.
 */
export function resolveLook(input: string | LookInput | Look): Look {
  if (typeof input === 'string') {
    const found = looks[input]
    if (!found) {
      throw new Error(`Unknown look: "${input}". Available: ${Object.keys(looks).join(', ') || '(none registered)'}`)
    }
    return found
  }

  // Already normalized (came back out of the registry).
  if (isResolvedLook(input)) return input

  const base = input.preset ? resolveLook(input.preset) : null

  const stops = input.stops
    ? normalizeStops(input.stops)
    : base
      ? base.stops
      : (() => {
          throw new Error('A look needs `stops`, or a `preset` to inherit them from.')
        })()

  const sunTint =
    input.sunTint === undefined
      ? (base?.sunTint ?? null)
      : input.sunTint === null
        ? null
        : resolveSunTint(input.sunTint)

  return {
    stops,
    chroma: input.chroma ?? base?.chroma ?? DEFAULT_CHROMA,
    value: input.value ?? base?.value ?? DEFAULT_VALUE,
    intensity: input.intensity ?? base?.intensity ?? DEFAULT_INTENSITY,
    sunTint,
  }
}

function isResolvedLook(input: LookInput | Look): input is Look {
  const stops = (input as Look).stops
  return Array.isArray(stops) && stops.length > 0 && stops[0].color instanceof Color && 'easeExp' in stops[0]
}

function resolveSunTint(tint: LookSunTint): ResolvedSunTint {
  return {
    color: toColor(tint.color),
    falloff: tint.falloff ?? DEFAULT_SUN_FALLOFF,
    strength: tint.strength ?? DEFAULT_SUN_STRENGTH,
  }
}

function normalizeStops(stops: LookStop[]): ResolvedStop[] {
  if (!stops.length) throw new Error('A look needs at least one stop.')
  if (stops.length > MAX_LOOK_STOPS) {
    throw new Error(`A look may have at most ${MAX_LOOK_STOPS} stops (got ${stops.length}).`)
  }

  return stops
    .map((stop) => {
      if (!Number.isFinite(stop.at)) {
        throw new Error(`Look stop \`at\` must be a number (sin of elevation, -1..1); got ${JSON.stringify(stop.at)}.`)
      }
      return { at: stop.at, color: toColor(stop.color), ...resolveEase(stop.ease) }
    })
    .sort((a, b) => a.at - b.at)
}

/** Register a look under `name`, replacing any existing entry. Returns the resolved look. */
export function registerLook(name: string, look: string | LookInput | Look): Look {
  const resolved = resolveLook(look)
  looks[name] = resolved
  return resolved
}

/**
 * Evaluate the ramp at a given elevation position (`at` = sin(elevation)).
 * Clamps outside the stop range. The TSL node mirrors this — kept here so
 * tracks, tests and GUI previews all agree with the shader.
 */
export function sampleLook(look: Look, at: number, target = new Color()): Color {
  const stops = look.stops
  if (at <= stops[0].at) return target.copy(stops[0].color)

  const last = stops[stops.length - 1]
  if (at >= last.at) return target.copy(last.color)

  for (let i = 1; i < stops.length; i++) {
    const b = stops[i]
    if (at > b.at) continue

    const a = stops[i - 1]
    const span = b.at - a.at
    const raw = span <= 0 ? 1 : (at - a.at) / span
    const t = applyEase(raw, b.easeExp, b.easeSmooth)
    return target.copy(a.color).lerp(b.color, t)
  }

  return target.copy(last.color)
}

/**
 * Interpolate between two looks by pairing stops by index, so both must have the
 * same stop count. Tracks guarantee this by resampling onto a shared position
 * set at authoring time (see {@link createLookTrack}) — this is the fast path
 * they call per evaluation, which is why it stays a plain pairwise lerp.
 */
export function lerpLooks(a: Look, b: Look, t: number): Look {
  if (t <= 0) return a
  if (t >= 1) return b

  if (a.stops.length !== b.stops.length) {
    throw new Error(
      `Cannot interpolate looks with different stop counts (${a.stops.length} vs ${b.stops.length}). ` +
        'Build a track with createLookTrack(), which resamples keyframes onto a shared position set.',
    )
  }

  return {
    stops: a.stops.map((sa, i) => {
      const sb = b.stops[i]
      return {
        at: sa.at + (sb.at - sa.at) * t,
        color: sa.color.clone().lerp(sb.color, t),
        easeExp: sa.easeExp + (sb.easeExp - sa.easeExp) * t,
        easeSmooth: sa.easeSmooth + (sb.easeSmooth - sa.easeSmooth) * t,
      }
    }),
    chroma: a.chroma + (b.chroma - a.chroma) * t,
    value: a.value + (b.value - a.value) * t,
    intensity: a.intensity + (b.intensity - a.intensity) * t,
    sunTint: lerpSunTint(a.sunTint, b.sunTint, t),
  }
}

function lerpSunTint(a: ResolvedSunTint | null, b: ResolvedSunTint | null, t: number): ResolvedSunTint | null {
  if (!a && !b) return null
  // A missing tint on one side fades to/from zero strength rather than popping.
  const from = a ?? { color: b!.color, falloff: b!.falloff, strength: 0 }
  const to = b ?? { color: a!.color, falloff: a!.falloff, strength: 0 }
  return {
    color: from.color.clone().lerp(to.color, t),
    falloff: from.falloff + (to.falloff - from.falloff) * t,
    strength: from.strength + (to.strength - from.strength) * t,
  }
}

/**
 * A keyframe in a {@link LookTrack}. Keyed on **sun elevation in degrees** by
 * default rather than clock time, because elevation is what actually determines
 * how the sky reads: `time: 6` is full night at latitude 65° in December and
 * three hours into daylight there in June. Use `time` (hours, 0..24) only for
 * fictional scenes where the sun position is arbitrary anyway.
 */
export interface LookKeyframe {
  /** Sun elevation in degrees. Civil twilight is -6°. */
  elevation?: number
  /** Local solar hours, 0..24. Only used when the track's axis is `'time'`. */
  time?: number
  look: string | LookInput
}

export interface LookTrack {
  axis: 'elevation' | 'time'
  keys: { at: number; look: Look }[]
}

/** Sorted, deduplicated union of every look's stop positions. */
function unionStopPositions(looksToMerge: Look[]): number[] {
  const all = looksToMerge.flatMap((look) => look.stops.map((s) => s.at)).sort((a, b) => a - b)

  const out: number[] = []
  for (const at of all) {
    if (!out.length || at - out[out.length - 1] > POSITION_EPSILON) out.push(at)
  }
  return out
}

/**
 * Re-express a look on a given set of stop positions. A look already sitting on
 * those exact positions is returned untouched, so it keeps its easing.
 *
 * Otherwise the new stops take their colours from {@link sampleLook}, which
 * bakes the original easing into the sampled values — but the segments *between*
 * the new stops become linear. In practice a resampled look is being densified
 * with positions borrowed from its neighbours, so the curve is captured at more
 * points than it was authored with, not fewer.
 */
function resampleLook(look: Look, positions: number[]): Look {
  const stops = look.stops
  const alreadyMatches =
    stops.length === positions.length && stops.every((s, i) => Math.abs(s.at - positions[i]) <= POSITION_EPSILON)
  if (alreadyMatches) return look

  return {
    ...look,
    stops: positions.map((at) => ({ at, color: sampleLook(look, at), easeExp: 1, easeSmooth: 0 })),
  }
}

/**
 * Build a track from keyframes. Keys are sorted, then every keyframe's look is
 * resampled onto the union of all their stop positions, so looks of different
 * stop counts compose freely — a 2-stop night and a 3-stop dusk can share a
 * track without the author padding either by hand.
 *
 * Resampling happens once, here, so per-frame track evaluation stays a plain
 * pairwise lerp with no allocation beyond the blended look itself.
 */
export function createLookTrack(keyframes: LookKeyframe[], options: { by?: 'elevation' | 'time' } = {}): LookTrack {
  if (!keyframes.length) throw new Error('A look track needs at least one keyframe.')

  const axis = options.by ?? 'elevation'
  const keys = keyframes
    .map((kf, i) => {
      const at = axis === 'time' ? kf.time : kf.elevation
      if (!Number.isFinite(at)) {
        throw new Error(`Look track keyframe ${i} is missing a numeric \`${axis}\` value.`)
      }
      return { at: at as number, look: resolveLook(kf.look) }
    })
    .sort((a, b) => a.at - b.at)

  const positions = unionStopPositions(keys.map((k) => k.look))
  if (positions.length > MAX_LOOK_STOPS) {
    throw new Error(
      `Look track keyframes span ${positions.length} distinct stop positions, over the ${MAX_LOOK_STOPS}-stop cap. ` +
        'Align the keyframe ramps onto shared positions so their union fits.',
    )
  }

  return { axis, keys: keys.map((k) => ({ at: k.at, look: resampleLook(k.look, positions) })) }
}

/** Register a track under `name`, replacing any existing entry. */
export function registerLookTrack(
  name: string,
  keyframes: LookKeyframe[] | LookTrack,
  options?: { by?: 'elevation' | 'time' },
): LookTrack {
  const track = Array.isArray(keyframes) ? createLookTrack(keyframes, options) : keyframes
  lookTracks[name] = track
  return track
}

/** Resolve a track by name or value. */
export function resolveLookTrack(track: string | LookKeyframe[] | LookTrack): LookTrack {
  if (typeof track === 'string') {
    const found = lookTracks[track]
    if (!found) {
      throw new Error(
        `Unknown look track: "${track}". Available: ${Object.keys(lookTracks).join(', ') || '(none registered)'}`,
      )
    }
    return found
  }
  return Array.isArray(track) ? createLookTrack(track) : track
}

/**
 * Evaluate a track at the current sun position. Clamps outside the keyed range.
 * Cheap enough to call from every `setTimeOfDay` / `setLatitude` / `setDayOfYear`
 * — it is plain JS over a handful of keys and only ends up writing uniforms.
 */
export function sampleLookTrack(track: LookTrack, sun: { elevation?: number; time?: number }): Look {
  const at = track.axis === 'time' ? sun.time : sun.elevation
  if (!Number.isFinite(at)) {
    throw new Error(`Look track is keyed on \`${track.axis}\` but no ${track.axis} was supplied.`)
  }

  const keys = track.keys
  const x = at as number
  if (x <= keys[0].at) return keys[0].look

  const last = keys[keys.length - 1]
  if (x >= last.at) return last.look

  for (let i = 1; i < keys.length; i++) {
    if (x > keys[i].at) continue
    const a = keys[i - 1]
    const b = keys[i]
    const span = b.at - a.at
    return lerpLooks(a.look, b.look, span <= 0 ? 1 : (x - a.at) / span)
  }

  return last.look
}

/**
 * Uniform-ready flattening of a look. This is the contract the TSL node binds
 * against: fixed-length arrays so the node graph never recompiles, and unused
 * slots padded with the last stop so the ramp clamps correctly regardless of
 * `stopCount`.
 */
export interface PackedLook {
  /** `MAX_LOOK_STOPS` positions (sin elevation). */
  positions: Float32Array
  /** `MAX_LOOK_STOPS * 3` linear RGB. */
  colors: Float32Array
  /** `MAX_LOOK_STOPS * 2` — `(easeExp, easeSmooth)` per stop. */
  eases: Float32Array
  stopCount: number
  chroma: number
  value: number
  intensity: number
  /** Linear RGB; zero when there is no tint. */
  sunTintColor: Float32Array
  sunTintFalloff: number
  /** 0 when there is no tint, so the shader needs no branch. */
  sunTintStrength: number
}

export function packLook(look: Look, target?: PackedLook): PackedLook {
  const out: PackedLook = target ?? {
    positions: new Float32Array(MAX_LOOK_STOPS),
    colors: new Float32Array(MAX_LOOK_STOPS * 3),
    eases: new Float32Array(MAX_LOOK_STOPS * 2),
    stopCount: 0,
    chroma: 0,
    value: 0,
    intensity: 1,
    sunTintColor: new Float32Array(3),
    sunTintFalloff: DEFAULT_SUN_FALLOFF,
    sunTintStrength: 0,
  }

  const stops = look.stops
  for (let i = 0; i < MAX_LOOK_STOPS; i++) {
    const stop = stops[Math.min(i, stops.length - 1)]
    out.positions[i] = stop.at
    out.colors[i * 3 + 0] = stop.color.r
    out.colors[i * 3 + 1] = stop.color.g
    out.colors[i * 3 + 2] = stop.color.b
    out.eases[i * 2 + 0] = stop.easeExp
    out.eases[i * 2 + 1] = stop.easeSmooth
  }

  out.stopCount = stops.length
  out.chroma = look.chroma
  out.value = look.value
  out.intensity = look.intensity

  const tint = look.sunTint
  out.sunTintColor[0] = tint ? tint.color.r : 0
  out.sunTintColor[1] = tint ? tint.color.g : 0
  out.sunTintColor[2] = tint ? tint.color.b : 0
  out.sunTintFalloff = tint ? tint.falloff : DEFAULT_SUN_FALLOFF
  out.sunTintStrength = tint ? tint.strength : 0

  return out
}

/**
 * JS mirror of the ramp evaluation the TSL node performs, and the reference the
 * node is transliterated from.
 *
 * The shader cannot use {@link sampleLook}'s find-the-segment approach — dynamic
 * early-exit costs more than it saves. Instead it walks all {@link MAX_LOOK_STOPS}
 * segments unconditionally and accumulates: each segment either leaves the colour
 * alone (`t = 0`, sampling before it), completes it (`t = 1`, sampling after it),
 * or blends (sampling inside it). Padded slots are zero-width, so
 * {@link RAMP_SPAN_EPSILON} turns them into steps that always land at `t = 0` or
 * `t = 1` on a colour already held — inert regardless of stop count.
 *
 * Because of that, the node needs no `stopCount` and takes no branch.
 */
export function evaluatePackedRamp(packed: PackedLook, at: number, target = new Color()): Color {
  target.setRGB(packed.colors[0], packed.colors[1], packed.colors[2])

  const stop = new Color()
  for (let i = 1; i < MAX_LOOK_STOPS; i++) {
    const aAt = packed.positions[i - 1]
    const bAt = packed.positions[i]
    const span = Math.max(bAt - aAt, RAMP_SPAN_EPSILON)
    const raw = clamp01((at - aAt) / span)
    const t = applyEase(raw, packed.eases[i * 2], packed.eases[i * 2 + 1])

    stop.setRGB(packed.colors[i * 3], packed.colors[i * 3 + 1], packed.colors[i * 3 + 2])
    target.lerp(stop, t)
  }

  return target
}

// ---------------------------------------------------------------------------
// Built-in looks
// ---------------------------------------------------------------------------
//
// Palette from `research/stylized-ghibli-sky.md`, verbatim: desaturated
// cerulean → periwinkle zeniths, warm never-fully-saturated horizon tints at
// dawn/dusk. Night and day are the memo's 2-stop ramps and dusk its 3-stop one;
// the `ghibli` track resamples them onto a shared position set, so no stop here
// is invented to make the counts line up.

registerLook('ghibli-night', {
  stops: [
    { at: 0.0, color: '#26365e' },
    { at: 1.0, color: '#0b1330' },
  ],
  chroma: 0.7,
  // Night needs value authority — the physical night sky is near zero, so a
  // chroma-only remap has nothing to tint.
  value: 0.5,
})

registerLook('ghibli-dusk', {
  stops: [
    { at: 0.0, color: '#ff9d6c' },
    { at: 0.35, color: '#f3c98f', ease: 'smooth' },
    { at: 1.0, color: '#6fa3d8' },
  ],
  chroma: 0.7,
  value: 0.25,
  sunTint: { color: '#ffd9a0', falloff: 0.3, strength: 0.6 },
})

registerLook('ghibli-day', {
  stops: [
    { at: 0.0, color: '#e8f3f7' },
    { at: 1.0, color: '#4f8fdb' },
  ],
  chroma: 0.7,
  value: 0.25,
})

// Civil twilight (-6°) and the memo's day threshold (+8°) are the band edges;
// the extra key at +15° gives the dusk → day handoff somewhere to happen.
registerLookTrack('ghibli', [
  { elevation: -18, look: 'ghibli-night' },
  { elevation: -6, look: 'ghibli-dusk' },
  { elevation: 8, look: 'ghibli-dusk' },
  { elevation: 15, look: 'ghibli-day' },
])
