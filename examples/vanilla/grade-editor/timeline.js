/**
 * Time-of-day timeline, keyed on sun elevation (what a grade's keyframes sit
 * on). Draws a ruler with the twilight marks, a "whole day" strip of what the
 * grade does at every elevation (applied to a flat grey sky, so it shows the
 * grade itself, not the physics), the keyframes, and the playhead.
 *
 * Pointer: drag empty space to scrub, click a keyframe to select it (and jump
 * to it), drag a keyframe to move it, double-click empty space to add one.
 */

const PAD = 14
const RULER_H = 16
const STRIP_ROWS = [
  { label: 'zenith', elevation: 70, azimuth: 90 },
  { label: 'sun side', elevation: 4, azimuth: 0 },
  { label: 'away', elevation: 4, azimuth: 180 },
]
const ROW_H = 10
const KEY_Y_OFFSET = 9 // below the strip

const TWILIGHT = [
  { at: 0, label: 'horizon' },
  { at: -6, label: 'civil' },
  { at: -12, label: 'nautical' },
  { at: -18, label: 'astro' },
]

const srgb = (c) => {
  const v = Math.min(1, Math.max(0, c))
  return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055))
}

export class Timeline {
  constructor(canvas, handlers) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.h = handlers
    this.min = -24
    this.max = 80
    this._strip = null
    this._stripKey = ''
    this._drag = null
    this._hoverKey = null

    canvas.addEventListener('pointerdown', (e) => this._down(e))
    canvas.addEventListener('pointermove', (e) => this._move(e))
    canvas.addEventListener('pointerup', (e) => this._up(e))
    canvas.addEventListener('pointercancel', (e) => this._up(e))
    canvas.addEventListener('dblclick', (e) => {
      if (this._keyAt(e)) return
      this.h.onInsertKey(this._snap(this.xToElevation(this._localX(e)), e))
    })
    new ResizeObserver(() => this.draw()).observe(canvas)
  }

  setRange(min, max) {
    if (min === this.min && max === this.max) return
    this.min = min
    this.max = max
    this._stripKey = ''
    this.draw()
  }

  elevationToX(e) {
    const w = this.canvas.clientWidth
    return PAD + ((e - this.min) / (this.max - this.min)) * (w - 2 * PAD)
  }

  xToElevation(x) {
    const w = this.canvas.clientWidth
    const t = (x - PAD) / (w - 2 * PAD)
    return Math.min(this.max, Math.max(this.min, this.min + t * (this.max - this.min)))
  }

  _localX(e) {
    return e.clientX - this.canvas.getBoundingClientRect().left
  }

  /** Shift snaps to whole degrees. */
  _snap(elevation, e) {
    return e.shiftKey ? Math.round(elevation) : Math.round(elevation * 10) / 10
  }

  _keyRowY() {
    return RULER_H + STRIP_ROWS.length * ROW_H + KEY_Y_OFFSET + 6
  }

  _keyAt(e) {
    const x = this._localX(e)
    const y = e.clientY - this.canvas.getBoundingClientRect().top
    if (Math.abs(y - this._keyRowY()) > 12) return null
    let best = null
    let bestD = 8
    for (const key of this.h.grade().keys) {
      const d = Math.abs(this.elevationToX(key.elevation) - x)
      if (d < bestD) {
        best = key
        bestD = d
      }
    }
    return best
  }

  _down(e) {
    this.canvas.setPointerCapture(e.pointerId)
    const key = this._keyAt(e)
    this._drag = key ? { key, x0: this._localX(e), moved: false } : { scrub: true }
    if (!key) this.h.onScrub(this.xToElevation(this._localX(e)))
  }

  _move(e) {
    if (!this._drag) {
      const k = this._keyAt(e)
      if (k !== this._hoverKey) {
        this._hoverKey = k
        this.canvas.style.cursor = k ? 'grab' : 'ew-resize'
        this.draw()
      }
      return
    }
    const x = this._localX(e)
    if (this._drag.scrub) {
      this.h.onScrub(this.xToElevation(x))
    } else if (this._drag.moved || Math.abs(x - this._drag.x0) > 3) {
      this._drag.moved = true
      this.canvas.style.cursor = 'grabbing'
      this._drag.key = this.h.onMoveKey(this._drag.key, this._snap(this.xToElevation(x), e)) ?? this._drag.key
    }
  }

  _up(e) {
    const drag = this._drag
    this._drag = null
    if (!drag) return
    if (drag.key) {
      if (drag.moved) this.h.onMoveKeyEnd?.(drag.key)
      else this.h.onSelectKey(drag.key)
    }
    this.canvas.style.cursor = this._keyAt(e) ? 'grab' : 'ew-resize'
  }

  /** Rebuild the day strip when the grade or the range changed. */
  _stripImage(width) {
    const grade = this.h.grade()
    const key = `${grade.revision}|${grade.keys.length}|${width}|${this.min}|${this.max}`
    if (key === this._stripKey && this._strip) return this._strip
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(width * dpr))
    const img = new ImageData(w, STRIP_ROWS.length)
    const rgb = [0, 0, 0]
    for (let x = 0; x < w; x++) {
      const e = this.xToElevation(x / dpr)
      STRIP_ROWS.forEach((row, r) => {
        rgb[0] = rgb[1] = rgb[2] = 0.45
        if (grade.keys.length) grade.apply(rgb, e, row.elevation, row.azimuth, { displayScale: 1 })
        const o = (r * w + x) * 4
        img.data[o] = srgb(rgb[0])
        img.data[o + 1] = srgb(rgb[1])
        img.data[o + 2] = srgb(rgb[2])
        img.data[o + 3] = 255
      })
    }
    const off = new OffscreenCanvas(w, STRIP_ROWS.length)
    off.getContext('2d').putImageData(img, 0, 0)
    this._strip = off
    this._stripKey = key
    return off
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

    const x0 = this.elevationToX(this.min)
    const x1 = this.elevationToX(this.max)

    // Night side shading.
    g.fillStyle = 'rgba(80, 100, 160, 0.08)'
    g.fillRect(x0, 0, this.elevationToX(0) - x0, H)

    // Ruler.
    g.strokeStyle = '#2b3038'
    g.fillStyle = '#8b93a1'
    g.textAlign = 'center'
    for (let e = Math.ceil(this.min / 10) * 10; e <= this.max; e += 10) {
      const x = this.elevationToX(e)
      g.beginPath()
      g.moveTo(x + 0.5, RULER_H - 4)
      g.lineTo(x + 0.5, H)
      g.stroke()
      g.fillText(`${e}°`, x, 7)
    }
    for (const t of TWILIGHT) {
      if (t.at < this.min || t.at > this.max) continue
      const x = this.elevationToX(t.at)
      g.strokeStyle = t.at === 0 ? '#f0b35a88' : '#6aa8ff55'
      g.setLineDash([2, 3])
      g.beginPath()
      g.moveTo(x + 0.5, RULER_H)
      g.lineTo(x + 0.5, H)
      g.stroke()
      g.setLineDash([])
      if (t.at !== 0) {
        // Along the bottom edge, clear of the degree labels.
        g.fillStyle = '#6aa8ffaa'
        g.textAlign = 'left'
        g.fillText(t.label, x + 3, H - 7)
        g.textAlign = 'center'
      }
    }

    // Day strip.
    const stripY = RULER_H
    const strip = this._stripImage(W)
    g.imageSmoothingEnabled = false
    g.drawImage(strip, 0, 0, strip.width, STRIP_ROWS.length, 0, stripY, W, STRIP_ROWS.length * ROW_H)
    g.fillStyle = 'rgba(0,0,0,0.55)'
    g.textAlign = 'left'
    STRIP_ROWS.forEach((row, r) => {
      const y = stripY + r * ROW_H + ROW_H / 2
      g.fillStyle = 'rgba(0,0,0,0.45)'
      g.fillRect(2, y - 5, 44, 10)
      g.fillStyle = '#d8dce3'
      g.fillText(row.label, 4, y + 0.5)
    })

    // Segments between keys.
    const grade = this.h.grade()
    const keyY = this._keyRowY()
    if (grade.keys.length > 1) {
      g.strokeStyle = '#3d4450'
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(this.elevationToX(grade.keys[0].elevation), keyY)
      g.lineTo(this.elevationToX(grade.keys[grade.keys.length - 1].elevation), keyY)
      g.stroke()
      g.lineWidth = 1
    }

    // Keyframes.
    const selected = this.h.selected()
    for (const key of grade.keys) {
      const x = this.elevationToX(key.elevation)
      const isSel = key === selected
      const isHover = key === this._hoverKey
      g.save()
      g.translate(x, keyY)
      g.rotate(Math.PI / 4)
      g.fillStyle = isSel ? '#f0b35a' : isHover ? '#c9cfd8' : '#8b93a1'
      g.strokeStyle = '#111317'
      g.lineWidth = 1.5
      const s = isSel ? 6 : 5
      g.fillRect(-s, -s, 2 * s, 2 * s)
      g.strokeRect(-s, -s, 2 * s, 2 * s)
      g.restore()
      if (key.ambient && key.ambient.intensity > 0) {
        g.fillStyle = '#6aa8ff'
        g.beginPath()
        g.arc(x, keyY + 10, 2, 0, Math.PI * 2)
        g.fill()
      }
      if (isSel || isHover) {
        g.fillStyle = '#d8dce3'
        g.textAlign = 'center'
        g.fillText(`${key.elevation.toFixed(1)}°`, x, keyY + 18)
      }
    }

    // Playhead.
    const e = this.h.elevation()
    const px = this.elevationToX(Math.min(this.max, Math.max(this.min, e)))
    g.strokeStyle = '#f0b35a'
    g.beginPath()
    g.moveTo(px + 0.5, RULER_H - 2)
    g.lineTo(px + 0.5, H)
    g.stroke()
    g.fillStyle = '#f0b35a'
    g.beginPath()
    g.moveTo(px - 5, 0)
    g.lineTo(px + 5, 0)
    g.lineTo(px, 6)
    g.closePath()
    g.fill()
    // Readout on the strip, clear of the keyframe labels.
    const label = `${e.toFixed(1)}°`
    const right = px > x1 - 60
    const tw = g.measureText(label).width + 8
    const lx = right ? px - 4 - tw : px + 4
    const ly = RULER_H + (STRIP_ROWS.length * ROW_H) / 2
    g.fillStyle = 'rgba(17,19,23,0.85)'
    g.fillRect(lx, ly - 7, tw, 14)
    g.fillStyle = '#f0b35a'
    g.textAlign = 'left'
    g.fillText(label, lx + 4, ly + 0.5)
  }
}
