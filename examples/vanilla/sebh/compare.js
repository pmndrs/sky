/**
 * Numeric helpers for 21-sebh-compare.html: read our LUTs back, compare two
 * RGBA float images texel by texel, and render ratio heatmaps.
 */

const HALF = new Float32Array(65536)
for (let h = 0; h < 65536; h++) {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const f = h & 0x3ff
  HALF[h] =
    e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024)
}

/**
 * readRenderTargetPixelsAsync → RGBA float32, rows top-down. three returns
 * the raw mapped buffer, rows padded to 256 bytes.
 */
export async function readRenderTarget(renderer, rt, width = rt.width, height = rt.height) {
  const raw = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, width, height)
  const half = raw instanceof Uint16Array
  const bpp = half ? 8 : 16
  const stride = (Math.ceil((width * bpp) / 256) * 256) / (half ? 2 : 4)
  const out = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < width * 4; i++) {
      const v = raw[y * stride + i]
      out[y * width * 4 + i] = half ? HALF[v] : v
    }
  }
  return { width, height, depth: 1, data: out }
}

export function flipY(img) {
  const { width, height, data } = img
  const out = new Float32Array(data.length)
  for (let y = 0; y < height; y++)
    out.set(data.subarray(y * width * 4, (y + 1) * width * 4), (height - 1 - y) * width * 4)
  return { ...img, data: out }
}

const quantile = (sorted, q) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN

/**
 * Per-channel ours/his over the texels selected by `where(x, y)`, skipping
 * texels his side leaves (near) black. Ratios, not differences: the question
 * is always "how many times brighter/darker".
 */
export function ratioStats(his, ours, { where = () => true, floor = 1e-6 } = {}) {
  const { width, height } = his
  const ch = [[], [], []]
  let worst = null
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!where(x, y)) continue
      const i = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        const h = his.data[i + c]
        const o = ours.data[i + c]
        if (!(h > floor) || !Number.isFinite(h) || !Number.isFinite(o)) continue
        const r = o / h
        ch[c].push(r)
        const dev = Math.abs(Math.log(Math.max(r, 1e-9)))
        if (!worst || dev > worst.dev) worst = { dev, x, y, c, his: h, ours: o, ratio: r }
      }
    }
  }
  const per = ch.map((a) => {
    const s = Float64Array.from(a).sort()
    // NaN, not 0, when his side has nothing above the floor (e.g. the zenith rows at 90 km)
    const mean = a.length ? a.reduce((p, v) => p + v, 0) / a.length : NaN
    return {
      n: a.length,
      mean,
      median: quantile(s, 0.5),
      p05: quantile(s, 0.05),
      p95: quantile(s, 0.95),
      min: s[0],
      max: s[s.length - 1],
    }
  })
  if (worst) delete worst.dev
  return { r: per[0], g: per[1], b: per[2], worst }
}

/** Mean relative deviation |ours/his − 1| over all channels — one number for orientation checks. */
export function meanAbsDeviation(his, ours) {
  let s = 0
  let n = 0
  for (let i = 0; i < his.data.length; i++) {
    if (i % 4 === 3) continue
    const h = his.data[i]
    if (!(h > 1e-6)) continue
    s += Math.abs(ours.data[i] / h - 1)
    n++
  }
  return n ? s / n : NaN
}

/** Average RGB over a (2r+1)² window at pixel (x, y). */
export function windowMean(img, x, y, r = 0) {
  const acc = [0, 0, 0]
  let n = 0
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const px = Math.min(img.width - 1, Math.max(0, x + dx))
      const py = Math.min(img.height - 1, Math.max(0, y + dy))
      const i = (py * img.width + px) * 4
      for (let c = 0; c < 3; c++) acc[c] += img.data[i + c]
      n++
    }
  }
  return acc.map((v) => v / n)
}

/**
 * PNG data URLs for eyeballing a LUT comparison: his and ours scaled by a
 * shared factor, and log2(ours/his) on a diverging map (blue darker, red
 * brighter, saturating at ±range stops; black where his is ~0).
 */
export function heatmaps(his, ours, { scale, range = 0.5 } = {}) {
  const { width, height } = his
  let max = 0
  for (let i = 0; i < his.data.length; i++)
    if (i % 4 !== 3 && Number.isFinite(his.data[i])) max = Math.max(max, his.data[i])
  const k = scale ?? 1 / Math.max(max, 1e-9)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const toUrl = (fill) => {
    const img = ctx.createImageData(width, height)
    for (let p = 0; p < width * height; p++) fill(p, img.data)
    ctx.putImageData(img, 0, 0)
    return canvas.toDataURL('image/png')
  }
  const tone = (v) => Math.round(255 * Math.pow(Math.min(1, Math.max(0, v * k)), 1 / 2.2))
  const rgb = (src) => (p, o) => {
    for (let c = 0; c < 3; c++) o[p * 4 + c] = tone(src.data[p * 4 + c])
    o[p * 4 + 3] = 255
  }
  const ratio = (p, o) => {
    // luminance-weighted ratio so one map summarises the three channels
    const w = [0.2126, 0.7152, 0.0722]
    let h = 0
    let m = 0
    for (let c = 0; c < 3; c++) {
      h += w[c] * his.data[p * 4 + c]
      m += w[c] * ours.data[p * 4 + c]
    }
    o[p * 4 + 3] = 255
    if (!(h > 1e-6)) return
    const t = Math.max(-1, Math.min(1, Math.log2(Math.max(m, 1e-9) / h) / range))
    o[p * 4 + 0] = Math.round(255 * (t > 0 ? 1 : 1 + t))
    o[p * 4 + 1] = Math.round(255 * (1 - Math.abs(t)))
    o[p * 4 + 2] = Math.round(255 * (t < 0 ? 1 : 1 - t))
  }
  return { his: toUrl(rgb(his)), ours: toUrl(rgb(ours)), ratio: toUrl(ratio) }
}
