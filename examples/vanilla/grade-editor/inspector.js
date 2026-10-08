/**
 * Keyframe inspector. Built once; `show()` only refreshes values, so a slider
 * keeps focus while it is dragged. Between keyframes it shows the settings the
 * grade interpolates there ("ghost"), and the first edit adds a keyframe at the
 * playhead (auto-key).
 */

import { GRADE_ZONES } from '@pmndrs/sky'

export const ZONE_LABELS = {
  zenith: 'Zenith',
  horizon: 'Horizon',
  sunward: 'Sun side',
  antisun: 'Away side',
  glow: 'Sun glow',
  ground: 'Below',
}

const GLOBALS = [
  { path: 'exposure', label: 'Exposure', min: -3, max: 3, step: 0.01, unit: 'EV' },
  { path: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01 },
  { path: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.01 },
  { path: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01 },
  { path: 'hue', label: 'Hue', min: -180, max: 180, step: 1, unit: '°' },
]

const SHAPE = [
  { path: 'shape.horizonHeight', label: 'Horizon height', min: 2, max: 90, step: 0.5, unit: '°' },
  { path: 'shape.sunwardWidth', label: 'Sun side width', min: 5, max: 180, step: 1, unit: '°' },
  { path: 'shape.antisunWidth', label: 'Away side width', min: 5, max: 180, step: 1, unit: '°' },
  { path: 'shape.glowSize', label: 'Glow size', min: 1, max: 90, step: 0.5, unit: '°' },
]

const hex = (c) => `#${c.getHexString()}`

/** `'shape.glowSize'`, 3 → `{ shape: { glowSize: 3 } }` */
function patchFor(path, value) {
  const parts = path.split('.')
  const out = {}
  let o = out
  parts.forEach((p, i) => {
    if (i === parts.length - 1) o[p] = value
    else o = o[p] = {}
  })
  return out
}

function read(key, path) {
  return path.split('.').reduce((o, p) => o?.[p], key)
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else n.setAttribute(k, v)
  }
  for (const c of children) if (c != null) n.append(c)
  return n
}

export class Inspector {
  constructor(root, handlers) {
    this.root = root
    this.h = handlers
    this.controls = []
    this.key = null
    this._build()
  }

  _edit(patch, commit) {
    this.h.onEdit(patch, { commit })
  }

  _slider(def) {
    const range = el('input', { type: 'range', min: def.min, max: def.max, step: def.step })
    const num = el('input', { type: 'number', min: def.min, max: def.max, step: def.step })
    const fmt = (v) => (def.step >= 1 ? String(Math.round(v)) : (+v).toFixed(2))
    range.addEventListener('input', () => {
      num.value = fmt(range.value)
      this._edit(patchFor(def.path, +range.value), false)
    })
    range.addEventListener('change', () => this._edit(patchFor(def.path, +range.value), true))
    num.addEventListener('change', () => this._edit(patchFor(def.path, +num.value), true))
    range.addEventListener('dblclick', () => {
      // Double-click resets to the neutral value.
      const neutral = def.neutral ?? (def.path === 'saturation' ? 1 : 0)
      if (def.noReset) return
      this._edit(patchFor(def.path, neutral), true)
    })
    const row = el('div', { class: 'row', title: def.title ?? '' }, el('label', {}, def.label), range, num)
    this.controls.push({
      set: (key) => {
        const v = read(key, def.path)
        if (v === undefined) return // e.g. ambient fields on a keyframe without one
        if (document.activeElement !== range) range.value = v
        if (document.activeElement !== num) num.value = fmt(v)
      },
    })
    return row
  }

  _color(path, title) {
    const input = el('input', { type: 'color', title })
    input.addEventListener('input', () => this._edit(patchFor(path, input.value), false))
    input.addEventListener('change', () => this._edit(patchFor(path, input.value), true))
    this.controls.push({
      set: (key) => {
        const c = read(key, path)
        if (c && document.activeElement !== input) input.value = hex(c)
      },
    })
    return input
  }

  _build() {
    const r = this.root
    r.innerHTML = ''

    // Header: which keyframe, or the ghost banner.
    this.banner = el('div', { class: 'banner' })
    this.addBtn = el('button', { onclick: () => this.h.onAddKey() }, 'Add keyframe here')
    this.title = el('span', { class: 'title' })
    this.elevationInput = el('input', { type: 'number', step: '0.1', style: 'width:64px', title: 'Sun elevation (°)' })
    this.elevationInput.addEventListener('change', () => this.h.onElevation(+this.elevationInput.value))
    this.ease = el(
      'select',
      { title: 'Easing of the segment entering this keyframe' },
      el('option', { value: 'linear' }, 'linear in'),
      el('option', { value: 'smooth' }, 'smooth in'),
    )
    this.ease.addEventListener('change', () => this._edit({ ease: this.ease.value }, true))
    this.del = el(
      'button',
      { class: 'danger', onclick: () => this.h.onDelete(), title: 'Delete keyframe (⌫)' },
      'Delete',
    )
    this.keyhead = el('div', { class: 'keyhead' }, this.title, this.elevationInput, this.ease, this.del)
    r.append(this.banner, this.keyhead)

    this.body = el('div')
    r.append(this.body)

    this.body.append(el('h4', {}, 'Whole sky'))
    for (const def of GLOBALS) this.body.append(this._slider(def))

    this._buildGradient()

    this.body.append(el('h4', {}, 'Zones — colour · amount · brightness'))
    this.zoneRows = {}
    for (const z of GRADE_ZONES) {
      const amount = el('input', { type: 'range', min: 0, max: 1, step: 0.01 })
      const bright = el('input', { type: 'range', min: -3, max: 3, step: 0.01 })
      const amountLbl = el('b')
      const brightLbl = el('b')
      const onAmount = (commit) => () => {
        amountLbl.textContent = `${Math.round(amount.value * 100)}%`
        this._edit({ zones: { [z]: { amount: +amount.value } } }, commit)
      }
      const onBright = (commit) => () => {
        brightLbl.textContent = `${(+bright.value).toFixed(2)} EV`
        this._edit({ zones: { [z]: { brightness: +bright.value } } }, commit)
      }
      amount.addEventListener('input', onAmount(false))
      amount.addEventListener('change', onAmount(true))
      bright.addEventListener('input', onBright(false))
      bright.addEventListener('change', onBright(true))
      bright.addEventListener('dblclick', () => this._edit({ zones: { [z]: { brightness: 0 } } }, true))
      amount.addEventListener('dblclick', () => this._edit({ zones: { [z]: { amount: 0 } } }, true))
      const color = this._color(`zones.${z}.color`, `${ZONE_LABELS[z]} colour`)
      const row = el(
        'div',
        { class: 'zone' },
        el('span', { class: 'zname' }, ZONE_LABELS[z]),
        color,
        el('div', { class: 'slider' }, el('span', {}, 'amount', amountLbl), amount),
        el('div', { class: 'slider' }, el('span', {}, 'brightness', brightLbl), bright),
      )
      this.controls.push({
        set: (key) => {
          const zone = key.zones[z]
          if (document.activeElement !== amount) amount.value = zone.amount
          if (document.activeElement !== bright) bright.value = zone.brightness
          amountLbl.textContent = `${Math.round(zone.amount * 100)}%`
          brightLbl.textContent = `${zone.brightness.toFixed(2)} EV`
        },
      })
      this.zoneRows[z] = row
      this.body.append(row)
    }

    this.body.append(el('h4', {}, 'Zone shape'))
    for (const def of SHAPE) this.body.append(this._slider({ ...def, noReset: true }))

    this.body.append(el('h4', {}, 'Night fill (added light)'))
    this.body.append(
      el(
        'div',
        { class: 'row' },
        el('label', {}, 'Colours'),
        el(
          'div',
          { class: 'colorpair' },
          this._color('fill.zenith', 'Fill at the zenith'),
          el('span', { class: 'zname' }, 'zenith'),
          this._color('fill.horizon', 'Fill at the horizon'),
          el('span', { class: 'zname' }, 'horizon'),
        ),
        el('span'),
      ),
    )
    this.body.append(
      this._slider({
        path: 'fill.intensity',
        label: 'Intensity',
        min: 0,
        max: 3,
        step: 0.01,
        title: 'Display-referred: at 1 the sky shows the fill colours on screen',
      }),
    )

    this.body.append(el('h4', {}, 'Ambient light'))
    this.ambientOn = el('input', { type: 'checkbox' })
    this.ambientOn.addEventListener('change', () =>
      this._edit({ ambient: this.ambientOn.checked ? { intensity: 0.5 } : null }, true),
    )
    this.body.append(
      el(
        'div',
        { class: 'row' },
        el('label', {}, 'Keyed here'),
        el('label', { class: 'check' }, this.ambientOn, 'drives SkyAmbient'),
        el('span'),
      ),
    )
    this.ambientBody = el('div')
    this.ambientBody.append(
      el(
        'div',
        { class: 'row' },
        el('label', {}, 'Colours'),
        el(
          'div',
          { class: 'colorpair' },
          this._color('ambient.color', 'Light from above'),
          el('span', { class: 'zname' }, 'sky'),
          this._color('ambient.groundColor', 'Light from below'),
          el('span', { class: 'zname' }, 'ground'),
        ),
        el('span'),
      ),
      this._slider({ path: 'ambient.intensity', label: 'Intensity', min: 0, max: 3, step: 0.01 }),
    )
    this.body.append(this.ambientBody)

    this.body.append(
      el(
        'div',
        { class: 'hint' },
        'Click a region of the sky view below to jump to its zone. Double-click a slider to reset it. ',
        el('kbd', {}, 'K'),
        ' key at playhead · ',
        el('kbd', {}, '⌫'),
        ' delete · ',
        el('kbd', {}, 'B'),
        ' bypass · ',
        el('kbd', {}, 'Space'),
        ' play · shift-drag snaps keys to whole degrees',
      ),
    )
  }

  /**
   * @param {object} s
   * @param {object} s.key  resolved keyframe (or interpolated settings when ghost)
   * @param {boolean} s.ghost  not on a keyframe
   * @param {number} s.elevation  playhead elevation
   * @param {number} s.index  keyframe index (when not ghost)
   * @param {number} s.count  keyframe count
   */
  show({ key, ghost, elevation, index, count }) {
    this.key = key
    this.root.classList.toggle('ghost', ghost)
    this.banner.style.display = ghost ? '' : 'none'
    this.keyhead.style.display = ghost ? 'none' : ''
    if (ghost) {
      this.banner.replaceChildren(
        count === 0
          ? 'No keyframes yet: the sky is physical. '
          : `Between keyframes at ${elevation.toFixed(1)}° — showing what the grade does here. `,
        el('b', {}, 'Editing adds a keyframe. '),
        this.addBtn,
      )
    } else {
      this.title.textContent = count === 1 ? 'Keyframe 1/1 · all day' : `Keyframe ${index + 1} / ${count}`
      if (document.activeElement !== this.elevationInput) this.elevationInput.value = key.elevation.toFixed(1)
      this.ease.value = key.ease
    }
    const hasAmbient = !!key.ambient
    this.ambientOn.checked = hasAmbient
    this.ambientBody.style.display = hasAmbient ? '' : 'none'
    for (const c of this.controls) c.set(key)
    this._showGradient(key)
  }

  /** Gradient over elevation: on/off, amount, replace, and a list of stops. */
  _buildGradient() {
    this.body.append(el('h4', {}, 'Gradient — colour stops by elevation'))
    this.gradientOn = el('input', { type: 'checkbox' })
    this.gradientOn.addEventListener('change', () =>
      this._edit(
        {
          gradient: this.gradientOn.checked
            ? {
                stops: [
                  { at: 0, color: '#f3c98f' },
                  { at: 90, color: '#4f8fdb', ease: 'smooth' },
                ],
                amount: 1,
                replace: 0,
              }
            : null,
        },
        true,
      ),
    )
    this.body.append(
      el(
        'div',
        { class: 'row' },
        el('label', {}, 'Use gradient'),
        el('label', { class: 'check' }, this.gradientOn, 'amount keeps brightness, replace sets it'),
        el('span'),
      ),
    )
    this.gradientBody = el('div')
    this.gradientBody.append(
      this._slider({
        path: 'gradient.amount',
        label: 'Amount',
        min: 0,
        max: 1,
        step: 0.01,
        noReset: true,
        title: 'Swap the physical hue for the gradient’s, keeping the physical brightness',
      }),
      this._slider({
        path: 'gradient.replace',
        label: 'Replace',
        min: 0,
        max: 1,
        step: 0.01,
        noReset: true,
        title: 'Mix in the gradient’s own colour and brightness — 1 is a fixed sky, the same all day',
      }),
    )
    this.stopList = el('div')
    this.addStop = el('button', { onclick: () => this._addStop() }, '+ stop')
    this.gradientBody.append(this.stopList, el('div', { class: 'row' }, el('span'), this.addStop, el('span')))
    this.body.append(this.gradientBody)
    this._stopsShape = ''
  }

  /** The current stops as plain inputs, for a patch that replaces them all. */
  _stops() {
    return this.key.gradient.stops.map((st) => ({ at: st.at, color: hex(st.color), ease: st.ease }))
  }

  _editStops(mutate, commit) {
    const stops = this._stops()
    mutate(stops)
    this._edit({ gradient: { stops } }, commit)
  }

  _addStop() {
    this._editStops((stops) => {
      const last = stops[stops.length - 1]
      const prev = stops[stops.length - 2] ?? { at: last.at - 20 }
      const at = Math.round(Math.min(90, (prev.at + last.at) / 2))
      stops.push({ at, color: last.color, ease: 'smooth' })
      stops.sort((a, b) => a.at - b.at)
    }, true)
  }

  _showGradient(key) {
    const g = key.gradient
    this.gradientOn.checked = !!g
    this.gradientBody.style.display = g ? '' : 'none'
    if (!g) return
    // Rebuild the rows only when their number changes (or a numeric ease
    // appears), so a focused input survives edits.
    const shape = g.stops.map((st) => (typeof st.ease === 'number' ? 'n' : 's')).join('')
    if (shape !== this._stopsShape) {
      this._stopsShape = shape
      this.stopList.replaceChildren(...g.stops.map((_, i) => this._stopRow(i)))
    }
    g.stops.forEach((st, i) => {
      const row = this.stopList.children[i]
      const [color, at, ease] = row.querySelectorAll('input[type=color], input[type=number], select')
      if (document.activeElement !== color) color.value = hex(st.color)
      if (document.activeElement !== at) at.value = st.at.toFixed(1)
      if (document.activeElement !== ease) ease.value = String(st.ease)
      row.querySelector('button').disabled = g.stops.length <= 1
    })
  }

  _stopRow(i) {
    const st = this.key.gradient.stops[i]
    const color = el('input', { type: 'color', title: 'Stop colour' })
    const at = el('input', { type: 'number', min: -90, max: 90, step: 1, title: 'Elevation (°)', style: 'width:52px' })
    const ease = el(
      'select',
      { title: 'Easing into this stop' },
      el('option', { value: 'linear' }, 'linear'),
      el('option', { value: 'smooth' }, 'smooth'),
    )
    if (typeof st.ease === 'number') ease.append(el('option', { value: String(st.ease) }, `pow ${st.ease}`))
    const remove = el('button', { title: 'Remove stop' }, '×')
    color.addEventListener('input', () => this._editStops((s) => (s[i].color = color.value), false))
    color.addEventListener('change', () => this._editStops((s) => (s[i].color = color.value), true))
    at.addEventListener('change', () =>
      this._editStops((s) => {
        s[i].at = Math.max(-90, Math.min(90, +at.value))
        s.sort((a, b) => a.at - b.at)
      }, true),
    )
    ease.addEventListener('change', () =>
      this._editStops((s) => (s[i].ease = isNaN(+ease.value) ? ease.value : +ease.value), true),
    )
    remove.addEventListener('click', () => this._editStops((s) => s.splice(i, 1), true))
    return el(
      'div',
      { class: 'stop' },
      color,
      el('span', { class: 'zname' }, 'at'),
      at,
      el('span', { class: 'zname' }, '°'),
      ease,
      remove,
    )
  }

  flashZone(zone) {
    const row = this.zoneRows[zone]
    if (!row) return
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    row.classList.add('flash')
    setTimeout(() => row.classList.remove('flash'), 700)
  }
}
