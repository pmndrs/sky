/**
 * Keyframe inspector. Built once; `show()` only refreshes values, so a slider
 * keeps focus while it is dragged. Between keyframes it shows the settings the
 * grade interpolates there ("ghost"), and the first edit adds a keyframe at the
 * playhead (auto-key).
 */

import { GRADE_ZONES } from '../grade'

export const ZONE_LABELS: Record<string, string> = {
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

const hex = (c: any) => `#${c.getHexString()}`

/** `'shape.glowSize'`, 3 → `{ shape: { glowSize: 3 } }` */
function patchFor(path: string, value: any) {
  const parts = path.split('.')
  const out: any = {}
  let o = out
  parts.forEach((p, i) => {
    if (i === parts.length - 1) o[p] = value
    else o = o[p] = {}
  })
  return out
}

function read(key: any, path: string) {
  return path.split('.').reduce((o: any, p: string) => o?.[p], key)
}

function el(tag: string, attrs: Record<string, any> = {}, ...children: any[]): any {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v, { signal: attrs.__signal })
    else if (k === '__signal') continue
    else n.setAttribute(k, v)
  }
  for (const c of children) if (c != null) n.append(c)
  return n
}

export class Inspector {
  _stopsShape: any
  addBtn: any
  addStop: any
  ambientBody: any
  ambientOn: any
  banner: any
  body: any
  controls: any
  del: any
  ease: any
  elevationInput: any
  gradientBody: any
  gradientOn: any
  h: any
  key: any
  keyhead: any
  root: any
  stopList: any
  title: any
  zoneRows: any
  private abort = new AbortController()
  private observer?: ResizeObserver
  private flashTimer: ReturnType<typeof setTimeout> | undefined
  private flashRow: HTMLElement | undefined
  dispose() {
    this.abort.abort()
    this.observer?.disconnect()
    clearTimeout(this.flashTimer)
    this.root.replaceChildren()
    this.controls = []
  }
  private el(tag: string, attrs: Record<string, any> = {}, ...children: any[]) {
    return el(tag, { ...attrs, __signal: this.abort.signal }, ...children)
  }
  private listen(node: any, type: string, handler: any) {
    node.addEventListener(type, handler, { signal: this.abort.signal })
  }

  constructor(root: HTMLElement, handlers: any) {
    this.root = root
    this.h = handlers
    this.controls = []
    this.key = null
    this._build()
  }

  _edit(patch: any, commit: boolean) {
    this.h.onEdit(patch, { commit })
  }

  _slider(def: any) {
    const range = this.el('input', {
      type: 'range',
      min: def.min,
      max: def.max,
      step: def.step,
      'aria-label': def.label,
    })
    const num = this.el('input', {
      type: 'number',
      min: def.min,
      max: def.max,
      step: def.step,
      'aria-label': def.label + ' value',
    })
    const fmt = (v: any) => (def.step >= 1 ? String(Math.round(v)) : (+v).toFixed(2))
    this.listen(range, 'input', () => {
      num.value = fmt(range.value)
      this._edit(patchFor(def.path, +range.value), false)
    })
    this.listen(range, 'change', () => this._edit(patchFor(def.path, +range.value), true))
    this.listen(num, 'change', () => this._edit(patchFor(def.path, +num.value), true))
    this.listen(range, 'dblclick', () => {
      // Double-click resets to the neutral value.
      const neutral = def.neutral ?? (def.path === 'saturation' ? 1 : 0)
      if (def.noReset) return
      this._edit(patchFor(def.path, neutral), true)
    })
    const row = this.el(
      'div',
      { class: 'row', title: def.title ?? '' },
      this.el('label', {}, def.label + (def.unit ? ` (${def.unit})` : '')),
      range,
      num,
    )
    this.controls.push({
      set: (key: any) => {
        const v = read(key, def.path)
        if (v === undefined) return // e.g. ambient fields on a keyframe without one
        if ((this.root.getRootNode() as ShadowRoot).activeElement !== range) range.value = v
        if ((this.root.getRootNode() as ShadowRoot).activeElement !== num) num.value = fmt(v)
      },
    })
    return row
  }

  _color(path: string, title: string) {
    const input = this.el('input', { type: 'color', title, 'aria-label': title })
    this.listen(input, 'input', () => this._edit(patchFor(path, input.value), false))
    this.listen(input, 'change', () => this._edit(patchFor(path, input.value), true))
    this.controls.push({
      set: (key: any) => {
        const c = read(key, path)
        if (c && (this.root.getRootNode() as ShadowRoot).activeElement !== input) input.value = hex(c)
      },
    })
    return input
  }

  _build() {
    const r = this.root
    r.innerHTML = ''

    // Header: which keyframe, or the ghost banner.
    this.banner = this.el('div', { class: 'banner' })
    this.addBtn = this.el('button', { onclick: () => this.h.onAddKey() }, 'Add keyframe here')
    this.title = this.el('span', { class: 'title' })
    this.elevationInput = this.el('input', {
      type: 'number',
      step: '0.1',
      min: '-90',
      max: '90',
      'aria-label': 'Keyframe elevation',
      style: 'width:64px',
      title: 'Sun elevation (°)',
    })
    this.listen(this.elevationInput, 'change', () => this.h.onElevation(+this.elevationInput.value))
    this.ease = this.el(
      'select',
      { title: 'Easing of the segment entering this keyframe', 'aria-label': 'Keyframe easing' },
      this.el('option', { value: 'linear' }, 'linear in'),
      this.el('option', { value: 'smooth' }, 'smooth in'),
    )
    this.listen(this.ease, 'change', () => this._edit({ ease: this.ease.value }, true))
    this.del = this.el(
      'button',
      { class: 'danger', onclick: () => this.h.onDelete(), title: 'Delete keyframe (⌫)' },
      'Delete',
    )
    this.keyhead = this.el('div', { class: 'keyhead' }, this.title, this.elevationInput, this.ease, this.del)
    r.append(this.banner, this.keyhead)

    this.body = this.el('div')
    r.append(this.body)

    this.body.append(this.el('h4', {}, 'Whole sky'))
    for (const def of GLOBALS) this.body.append(this._slider(def))

    this._buildGradient()

    this.body.append(this.el('h4', {}, 'Zones — colour · amount · brightness'))
    this.zoneRows = {}
    for (const z of GRADE_ZONES) {
      const amount = this.el('input', {
        type: 'range',
        min: 0,
        max: 1,
        step: 0.01,
        'aria-label': ZONE_LABELS[z] + ' amount',
      })
      const bright = this.el('input', {
        type: 'range',
        min: -3,
        max: 3,
        step: 0.01,
        'aria-label': ZONE_LABELS[z] + ' brightness',
      })
      const amountLbl = this.el('b')
      const brightLbl = this.el('b')
      const onAmount = (commit: boolean) => () => {
        amountLbl.textContent = `${Math.round(amount.value * 100)}%`
        this._edit({ zones: { [z]: { amount: +amount.value } } }, commit)
      }
      const onBright = (commit: boolean) => () => {
        brightLbl.textContent = `${(+bright.value).toFixed(2)} EV`
        this._edit({ zones: { [z]: { brightness: +bright.value } } }, commit)
      }
      this.listen(amount, 'input', onAmount(false))
      this.listen(amount, 'change', onAmount(true))
      this.listen(bright, 'input', onBright(false))
      this.listen(bright, 'change', onBright(true))
      this.listen(bright, 'dblclick', () => this._edit({ zones: { [z]: { brightness: 0 } } }, true))
      this.listen(amount, 'dblclick', () => this._edit({ zones: { [z]: { amount: 0 } } }, true))
      const color = this._color(`zones.${z}.color`, `${ZONE_LABELS[z]} colour`)
      const row = this.el(
        'div',
        { class: 'zone' },
        this.el('span', { class: 'zname' }, ZONE_LABELS[z]),
        color,
        this.el('div', { class: 'slider' }, this.el('span', {}, 'amount', amountLbl), amount),
        this.el('div', { class: 'slider' }, this.el('span', {}, 'brightness', brightLbl), bright),
      )
      this.controls.push({
        set: (key: any) => {
          const zone = key.zones[z]
          if ((this.root.getRootNode() as ShadowRoot).activeElement !== amount) amount.value = zone.amount
          if ((this.root.getRootNode() as ShadowRoot).activeElement !== bright) bright.value = zone.brightness
          amountLbl.textContent = `${Math.round(zone.amount * 100)}%`
          brightLbl.textContent = `${zone.brightness.toFixed(2)} EV`
        },
      })
      this.zoneRows[z] = row
      this.body.append(row)
    }

    this.body.append(this.el('h4', {}, 'Zone shape'))
    for (const def of SHAPE) this.body.append(this._slider({ ...def, noReset: true }))

    this.body.append(this.el('h4', {}, 'Night fill (added light)'))
    this.body.append(
      this.el(
        'div',
        { class: 'row' },
        this.el('label', {}, 'Colours'),
        this.el(
          'div',
          { class: 'colorpair' },
          this._color('fill.zenith', 'Fill at the zenith'),
          this.el('span', { class: 'zname' }, 'zenith'),
          this._color('fill.horizon', 'Fill at the horizon'),
          this.el('span', { class: 'zname' }, 'horizon'),
        ),
        this.el('span'),
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

    this.body.append(this.el('h4', {}, 'Ambient light'))
    this.ambientOn = this.el('input', { type: 'checkbox', 'aria-label': 'Keyed ambient light' })
    this.listen(this.ambientOn, 'change', () =>
      this._edit({ ambient: this.ambientOn.checked ? { intensity: 0.5 } : null }, true),
    )
    this.body.append(
      this.el(
        'div',
        { class: 'row' },
        this.el('label', {}, 'Keyed here'),
        this.el('label', { class: 'check' }, this.ambientOn, 'drives ambient light'),
        this.el('span'),
      ),
    )
    this.ambientBody = this.el('div')
    this.ambientBody.append(
      this.el(
        'div',
        { class: 'row' },
        this.el('label', {}, 'Colours'),
        this.el(
          'div',
          { class: 'colorpair' },
          this._color('ambient.color', 'Light from above'),
          this.el('span', { class: 'zname' }, 'sky'),
          this._color('ambient.groundColor', 'Light from below'),
          this.el('span', { class: 'zname' }, 'ground'),
        ),
        this.el('span'),
      ),
      this._slider({ path: 'ambient.intensity', label: 'Intensity', min: 0, max: 3, step: 0.01 }),
    )
    this.body.append(this.ambientBody)

    this.body.append(
      this.el(
        'div',
        { class: 'hint' },
        'Click a region of the sky view below to jump to its zone. Double-click a slider to reset it. ',
        this.el('kbd', {}, 'K'),
        ' key at playhead · ',
        this.el('kbd', {}, '⌫'),
        ' delete · ',
        this.el('kbd', {}, 'B'),
        ' bypass · ',
        this.el('kbd', {}, 'Space'),
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
  show({ key, ghost, elevation, index, count }: any) {
    this.key = key
    this.root.classList.toggle('ghost', ghost)
    this.banner.style.display = ghost ? '' : 'none'
    this.keyhead.style.display = ghost ? 'none' : ''
    if (ghost) {
      this.banner.replaceChildren(
        count === 0
          ? 'No keyframes yet: the sky is physical. '
          : `Between keyframes at ${elevation.toFixed(1)}° — showing what the grade does here. `,
        this.el('b', {}, 'Editing adds a keyframe. '),
        this.addBtn,
      )
    } else {
      this.title.textContent = count === 1 ? 'Keyframe 1/1 · all day' : `Keyframe ${index + 1} / ${count}`
      if ((this.root.getRootNode() as ShadowRoot).activeElement !== this.elevationInput) {
        this.elevationInput.value = key.elevation.toFixed(1)
      }
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
    this.body.append(this.el('h4', {}, 'Gradient — colour stops by elevation'))
    this.gradientOn = this.el('input', { type: 'checkbox', 'aria-label': 'Use gradient' })
    this.listen(this.gradientOn, 'change', () =>
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
      this.el(
        'div',
        { class: 'row' },
        this.el('label', {}, 'Use gradient'),
        this.el('label', { class: 'check' }, this.gradientOn, 'amount keeps brightness, replace sets it'),
        this.el('span'),
      ),
    )
    this.gradientBody = this.el('div')
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
    this.stopList = this.el('div')
    this.addStop = this.el('button', { onclick: () => this._addStop() }, '+ stop')
    this.gradientBody.append(
      this.stopList,
      this.el('div', { class: 'row' }, this.el('span'), this.addStop, this.el('span')),
    )
    this.body.append(this.gradientBody)
    this._stopsShape = ''
  }

  /** The current stops as plain inputs, for a patch that replaces them all. */
  _stops() {
    return this.key.gradient.stops.map((st: any) => ({ at: st.at, color: hex(st.color), ease: st.ease }))
  }

  _editStops(mutate: (stops: any[]) => void, commit: boolean) {
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

  _showGradient(key: any) {
    const g = key.gradient
    this.gradientOn.checked = !!g
    this.gradientBody.style.display = g ? '' : 'none'
    if (!g) return
    // Rebuild the rows only when their number changes (or a numeric ease
    // appears), so a focused input survives edits.
    const shape = g.stops.map((st: any) => (typeof st.ease === 'number' ? 'n' : 's')).join('')
    if (shape !== this._stopsShape) {
      this._stopsShape = shape
      this.stopList.replaceChildren(...g.stops.map((_: any, i: number) => this._stopRow(i)))
    }
    g.stops.forEach((st: any, i: number) => {
      const row = this.stopList.children[i]
      const [color, at, ease] = row.querySelectorAll('input[type=color], input[type=number], select')
      if ((this.root.getRootNode() as ShadowRoot).activeElement !== color) color.value = hex(st.color)
      if ((this.root.getRootNode() as ShadowRoot).activeElement !== at) at.value = st.at.toFixed(1)
      if ((this.root.getRootNode() as ShadowRoot).activeElement !== ease) ease.value = String(st.ease)
      row.querySelector('button').disabled = g.stops.length <= 1
    })
  }

  _stopRow(i: number) {
    const st = this.key.gradient.stops[i]
    const color = this.el('input', { type: 'color', title: 'Stop colour', 'aria-label': 'Gradient stop color' })
    const at = this.el('input', {
      type: 'number',
      min: -90,
      max: 90,
      step: 1,
      title: 'Elevation (°)',
      'aria-label': 'Gradient stop elevation',
      style: 'width:52px',
    })
    const ease = this.el(
      'select',
      { title: 'Easing into this stop', 'aria-label': 'Gradient stop easing' },
      this.el('option', { value: 'linear' }, 'linear'),
      this.el('option', { value: 'smooth' }, 'smooth'),
    )
    if (typeof st.ease === 'number') ease.append(this.el('option', { value: String(st.ease) }, `pow ${st.ease}`))
    const remove = this.el('button', { title: 'Remove stop' }, '×')
    this.listen(color, 'input', () => this._editStops((s) => (s[i].color = color.value), false))
    this.listen(color, 'change', () => this._editStops((s) => (s[i].color = color.value), true))
    this.listen(at, 'change', () =>
      this._editStops((s) => {
        s[i].at = Math.max(-90, Math.min(90, +at.value))
        s.sort((a, b) => a.at - b.at)
      }, true),
    )
    this.listen(ease, 'change', () =>
      this._editStops((s) => (s[i].ease = isNaN(+ease.value) ? ease.value : +ease.value), true),
    )
    this.listen(remove, 'click', () => this._editStops((s) => s.splice(i, 1), true))
    return this.el(
      'div',
      { class: 'stop' },
      color,
      this.el('span', { class: 'zname' }, 'at'),
      at,
      this.el('span', { class: 'zname' }, '°'),
      ease,
      remove,
    )
  }

  flashZone(zone: string) {
    const row = this.zoneRows[zone]
    if (!row) return
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    this.flashRow?.classList.remove('flash')
    this.flashRow = row
    row.classList.add('flash')
    clearTimeout(this.flashTimer)
    this.flashTimer = setTimeout(() => row.classList.remove('flash'), 700)
  }
}
