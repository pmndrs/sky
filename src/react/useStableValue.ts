import { useRef } from 'react'

/**
 * Returns the *previous* value when a structural comparison says the new
 * value is equivalent to it, so callers can use the result as a
 * `useEffect`/`useMemo` dependency without re-running for a
 * freshly-allocated-but-equal object — the classic React foot-gun of an
 * inline prop like `<Sky atmosphere={{ miePhaseG: 0.7 }} />` getting a new
 * object identity on every parent render.
 *
 * Comparison is `JSON.stringify` equality, not deep-equality in general:
 * good enough for the plain-data shapes this is used for (`sunDirection`,
 * `groundAlbedo`, `atmosphere`, `look`, `lookTrack`, `skyLuminanceFactor`,
 * `hazeAltitudeBlend`). `three.js` `Vector3` / `Color` instances serialize
 * fine this way — their public fields (`x/y/z` or `r/g/b`) are exactly what
 * `JSON.stringify` picks up — and primitives / `null` / `undefined` compare
 * structurally too since `JSON.stringify` is stable for them.
 *
 * Values that don't round-trip through JSON (functions, Symbols, circular
 * references) fail open: comparison degrades to "always different", i.e.
 * every call returns the newest `value` — the same behaviour as not using
 * this hook at all, so it's never worse than the pre-fix baseline.
 */
export function useStableValue<T>(value: T): T {
  const ref = useRef(value)
  const keyRef = useRef(stringifyKey(value))

  const nextKey = stringifyKey(value)
  // `null` is the "couldn't serialize" sentinel on either side — fail open
  // (always treat as changed) rather than risk freezing on a stale value.
  if (nextKey === null || keyRef.current === null || nextKey !== keyRef.current) {
    keyRef.current = nextKey
    ref.current = value
  }

  return ref.current
}

// `JSON.stringify(undefined)` returns the primitive `undefined`, not a
// string — remap it to a distinct sentinel so it never collides with the
// `null` "serialization failed" sentinel below.
const UNDEFINED_KEY = '\u0000undefined'

function stringifyKey(value: unknown): string | null {
  try {
    const key = JSON.stringify(value)
    return key === undefined ? UNDEFINED_KEY : key
  } catch {
    return null
  }
}
