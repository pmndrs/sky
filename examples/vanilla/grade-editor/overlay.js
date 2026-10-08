/**
 * 2D overlay on the sky-dome preview: zone guides for the keyframe being
 * edited, the sun, axis labels, a hover readout, and click-to-pick a zone.
 * Uses the preview's own dome mapping and the library's zone masks, so the
 * guides are exactly where the bake puts the zones.
 */

import { gradeZoneWeights } from '@pmndrs/sky'

import { ZONE_LABELS } from './inspector.js'

const deg = Math.PI / 180

/** The zone a click means: overlays in composite order, then the base. */
export function dominantZone(w) {
  if (w.ground > 0.5) return 'ground'
  const over = [
    ['glow', w.glow],
    ['sunward', w.sunward],
    ['antisun', w.antisun],
  ].sort((a, b) => b[1] - a[1])
  if (over[0][1] > 0.3) return over[0][0]
  return w.zenith > 0.5 ? 'zenith' : 'horizon'
}

export class LutOverlay {
  constructor(canvas, hoverEl, handlers) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.hoverEl = hoverEl
    this.h = handlers
    this.showGuides = true
    this._weights = {}

    canvas.addEventListener('pointermove', (e) => this._hover(e))
    canvas.addEventListener('pointerleave', () => {
      this.hoverEl.style.display = 'none'
    })
    canvas.addEventListener('click', (e) => {
      const d = this._dome(e)
      const zone = dominantZone(gradeZoneWeights(this.h.key(), d.elevation, d.azimuth, this._weights))
      this.h.onPickZone(zone)
    })
    new ResizeObserver(() => this.draw()).observe(canvas)
  }

  _dome(e) {
    const r = this.canvas.getBoundingClientRect()
    return this.h.preview().toDome((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
  }

  _hover(e) {
    const d = this._dome(e)
    const w = gradeZoneWeights(this.h.key(), d.elevation, d.azimuth, this._weights)
    const zone = dominantZone(w)
    const r = this.canvas.getBoundingClientRect()
    this.hoverEl.style.display = 'block'
    this.hoverEl.style.left = `${Math.min(e.clientX - r.left + 12, r.width - 170)}px`
    this.hoverEl.style.top = `${Math.max(e.clientY - r.top - 26, 2)}px`
    this.hoverEl.textContent = `${ZONE_LABELS[zone]} · el ${d.elevation.toFixed(1)}° · az ${Math.abs(d.azimuth).toFixed(0)}°`
  }

  _xy(azimuth, elevation, W, H) {
    const p = this.h.preview().fromDome(azimuth, elevation)
    return [p.x * W, p.y * H]
  }

  draw() {
    const c = this.canvas
    const dpr = window.devicePixelRatio || 1
    const W = c.clientWidth
    const H = c.clientHeight
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr)
      c.height = Math.round(H * dpr)
    }
    const g = this.ctx
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    g.font = '10px system-ui, sans-serif'
    g.textBaseline = 'middle'
    // Labels sit on any sky colour, from black night to the pale grade-only view.
    g.shadowColor = 'rgba(0,0,0,0.9)'
    g.shadowBlur = 3

    const key = this.h.key()
    const sunEl = this.h.sunElevation()
    const mode = this.h.mode()
    const xy = (a, e) => this._xy(a, e, W, H)

    // Axes: elevation ticks left, azimuth labels bottom.
    g.fillStyle = 'rgba(255,255,255,0.55)'
    g.textAlign = 'left'
    for (const e of [0, 30, 60, 90]) {
      const [, y] = xy(0, e)
      g.fillText(`${e}°`, 4, Math.min(H - 6, Math.max(6, y)))
    }
    g.textAlign = 'center'
    for (const [a, label] of [
      [-180, 'away'],
      [-90, '90°'],
      [0, 'sun'],
      [90, '90°'],
      [180, 'away'],
    ]) {
      const [x] = xy(a, 0)
      g.fillText(label, Math.min(W - 16, Math.max(16, x)), H - 7)
    }

    // Horizon.
    const [, yH] = xy(0, 0)
    g.strokeStyle = 'rgba(240,179,90,0.6)'
    g.beginPath()
    g.moveTo(0, yH + 0.5)
    g.lineTo(W, yH + 0.5)
    g.stroke()

    if (mode === 'split') {
      g.strokeStyle = 'rgba(255,255,255,0.7)'
      g.beginPath()
      g.moveTo(W / 2 + 0.5, 0)
      g.lineTo(W / 2 + 0.5, H)
      g.stroke()
      g.fillStyle = 'rgba(0,0,0,0.5)'
      g.fillRect(W / 2 - 64, 4, 128, 16)
      g.fillStyle = '#fff'
      g.fillText('physical  |  graded', W / 2, 12)
    }

    if (this.showGuides && key) {
      const s = key.shape
      g.setLineDash([4, 4])
      g.lineWidth = 1

      // Horizon → zenith hand-over.
      const [, yZ] = xy(0, s.horizonHeight)
      g.strokeStyle = 'rgba(255,255,255,0.45)'
      g.beginPath()
      g.moveTo(0, yZ + 0.5)
      g.lineTo(W, yZ + 0.5)
      g.stroke()
      g.fillStyle = 'rgba(255,255,255,0.7)'
      g.textAlign = 'right'
      g.fillText('zenith ↑  horizon ↓', W - 6, yZ - 8)

      // Sun side / away side widths (in the horizon band).
      const vline = (a, color) => {
        const [x] = xy(a, 0)
        g.strokeStyle = color
        g.beginPath()
        g.moveTo(x + 0.5, yH)
        g.lineTo(x + 0.5, yZ)
        g.stroke()
      }
      for (const sign of [-1, 1]) {
        vline(sign * s.sunwardWidth, 'rgba(255,190,110,0.7)')
        vline(sign * (180 - s.antisunWidth), 'rgba(220,150,220,0.7)')
      }

      // Glow: the circle at glowSize around a sun at the keyframe's elevation.
      const se = key.elevation * deg
      const G = s.glowSize * deg
      const sx = Math.cos(se)
      const sz = Math.sin(se)
      g.strokeStyle = 'rgba(255,230,140,0.8)'
      g.beginPath()
      let prevA = null
      for (let i = 0; i <= 96; i++) {
        const t = (i / 96) * Math.PI * 2
        // Basis around the sun: u toward the zenith, v sideways.
        const px = Math.cos(G) * sx + Math.sin(G) * Math.cos(t) * -sz
        const py = Math.sin(G) * Math.sin(t)
        const pz = Math.cos(G) * sz + Math.sin(G) * Math.cos(t) * sx
        const el = Math.asin(Math.max(-1, Math.min(1, pz))) / deg
        const az = Math.atan2(py, px) / deg
        const [x, y] = xy(az, el)
        if (prevA === null || Math.abs(az - prevA) > 90) g.moveTo(x, y)
        else g.lineTo(x, y)
        prevA = az
      }
      g.stroke()
      g.setLineDash([])
    }

    // Gradient stops: a colour tick at each stop's elevation, on the right edge.
    if (key?.gradient) {
      g.shadowBlur = 0
      for (const st of key.gradient.stops) {
        const [, y] = xy(0, st.at)
        if (y < 0 || y > H) continue
        g.fillStyle = `#${st.color.getHexString()}`
        g.strokeStyle = 'rgba(255,255,255,0.85)'
        g.beginPath()
        g.moveTo(W - 2, y)
        g.lineTo(W - 12, y - 5)
        g.lineTo(W - 12, y + 5)
        g.closePath()
        g.fill()
        g.stroke()
      }
      g.shadowBlur = 3
    }

    // Sun.
    const [sxp, syp] = xy(0, sunEl)
    g.strokeStyle = '#f0b35a'
    g.fillStyle = 'rgba(240,179,90,0.25)'
    g.beginPath()
    g.arc(sxp, syp, 5, 0, Math.PI * 2)
    g.fill()
    g.stroke()
  }
}
