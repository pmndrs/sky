import { SkyGrade, grades, resolveGrade, horizonToZenith, solidSky, MAX_GRADE_KEYS, GRADE_ZONES } from '../grade'
import { SkyEditorController } from './controller'
import { Inspector, ZONE_LABELS } from './inspector'
import { Timeline } from './timeline'
import { LutOverlay } from './overlay'
import { EditorPreview } from './preview'
import { SettingsPanel } from './settings'
import { styles } from './styles'
import { element, button, select } from './dom'
import type { SkyGradeJSON, SkyGradeKey } from '../grade'
import type { SkyGradePreviewMode } from '../sky/SkyGradePreview'
import type { SkyEditorOptions, SkyEditor } from './types'

export function mountEditor(options: SkyEditorOptions): SkyEditor {
  if (typeof document === 'undefined') throw new Error('Sky editor requires a browser DOM')
  const container = options.container ?? document.body
  const abort = new AbortController()
  const signal = abort.signal
  const host = element('div', { 'data-sky-editor': '', hidden: '' })
  const shadow = host.attachShadow({ mode: 'open' })
  const style = element('style', {}, styles)
  const frame = element('section', { class: 'window', role: 'region', 'aria-label': 'Sky Editor', tabindex: '0' })
  shadow.append(style, frame)
  const floating = (options.layout ?? 'floating') === 'floating'
  Object.assign(
    host.style,
    floating
      ? { position: 'fixed', zIndex: '10000', width: '760px', height: '560px' }
      : { width: '100%', height: '560px' },
  )
  container.append(host)
  let disposed = false
  let collapsed = false
  let shown = false
  let focusBefore: HTMLElement | null = null
  let mode: SkyGradePreviewMode = 'split'
  let error = ''
  let notice = ''
  let lastInspector = ''
  let lastDraw = ''
  let normalHeight = '560px'
  let saved = ''
  let draft = ''
  let focused = false
  const urls = new Set<string>()
  const cleanupURLs = () => {
    for (const url of urls) URL.revokeObjectURL(url)
    urls.clear()
  }
  const controller = new SkyEditorController({
    ...options,
    onCommit: (event) => {
      if (options.storageKey) {
        try {
          localStorage.setItem(options.storageKey, JSON.stringify(event.grade))
        } catch {
          /* storage is optional */
        }
      }
      options.onCommit?.(event)
    },
  })
  saved = JSON.stringify(controller.getGradeJSON())
  if (options.storageKey) {
    try {
      draft = localStorage.getItem(options.storageKey) ?? ''
    } catch {
      /* storage is optional */
    }
    if (draft === saved) draft = ''
  }

  const run = (action: () => void) => {
    if (disposed) return
    error = ''
    notice = ''
    try {
      action()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    refresh()
    options.requestRender?.()
  }
  const actionButton = (label: string, action: () => void) => button(label, () => run(action), signal)
  const focusChanged = (value: boolean) => {
    if (focused === value) return
    focused = value
    options.onFocusChange?.(value)
  }

  const header = element('header', { class: 'header' }, element('strong', {}, 'Sky Editor'))
  const collapse = actionButton('Collapse', () => {
    collapsed = !collapsed
    if (collapsed) {
      normalHeight = host.style.height
      controller.followApp()
      host.style.height = '45px'
    } else {
      host.style.height = normalHeight
    }
    frame.classList.toggle('collapsed', collapsed)
    collapse.textContent = collapsed ? 'Expand' : 'Collapse'
    collapse.setAttribute('aria-expanded', String(!collapsed))
  })
  header.append(
    collapse,
    actionButton('Close', () => close()),
  )
  frame.append(header)

  const preset = select('Start from grade preset', [
    ['', 'Custom grade'],
    ['empty', 'Physical'],
    ['gradient', 'Gradient'],
    ['tinted', 'Tinted gradient'],
    ['solid', 'Solid sky'],
    ...Object.keys(grades).map((key): [string, string] => [
      key,
      key.replace(/[-_]/g, ' ').replace(/^./, (letter) => letter.toUpperCase()),
    ]),
  ])
  preset.title = 'Start from a preset. This replaces the grade settings; Undo restores your edits.'
  const presetKeys = new Map(
    Array.from(preset.options)
      .filter((option) => option.value)
      .map((option) => [option.value, JSON.stringify(startingGrade(option.value).toJSON().keys)]),
  )
  let presetGrade: SkyGrade | null = null
  let presetRevision = -1
  function startingGrade(value: string): SkyGrade {
    return value === 'empty'
      ? new SkyGrade()
      : value === 'gradient'
        ? horizonToZenith('#f3c98f', '#4f8fdb')
        : value === 'tinted'
          ? horizonToZenith('#ffc9a0', '#5a7fd0', { replace: 0 })
          : value === 'solid'
            ? solidSky('#7f9fd0')
            : resolveGrade(value)
  }
  preset.addEventListener(
    'change',
    () =>
      run(() => {
        const value = preset.value
        if (!value) return
        const grade = startingGrade(value)
        controller.replace(grade)
      }),
    { signal },
  )

  const name = element('input', {
    type: 'text',
    placeholder: 'Untitled grade',
    'aria-label': 'Grade name',
    title: 'Name used when saving the grade file',
  })
  name.addEventListener('change', () => run(() => controller.rename(name.value)), { signal })
  const undo = actionButton('Undo', () => controller.undo())
  const redo = actionButton('Redo', () => controller.redo())
  const physical = actionButton('Physical', () => controller.setBypass(!controller.bypass))
  physical.setAttribute('aria-pressed', 'false')
  const fileInput = element('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: '',
    'aria-label': 'Load grade file',
  })
  fileInput.addEventListener(
    'change',
    async () => {
      const file = fileInput.files?.[0]
      fileInput.value = ''
      if (!file) return
      try {
        const text = await file.text()
        run(() => {
          controller.loadGrade(text)
          saved = JSON.stringify(controller.getGradeJSON())
          notice = 'Grade loaded'
        })
      } catch (e) {
        run(() => {
          throw e
        })
      }
    },
    { signal },
  )
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(controller.getGradeJSON(), null, 2)], { type: 'application/json' }),
    )
    urls.add(url)
    const link = element('a', {
      href: url,
      download: (controller.grade.name || 'sky-grade').replace(/[^\w.-]+/g, '-') + '.json',
    })
    link.click()
    saved = JSON.stringify(controller.getGradeJSON())
    notice = 'Grade downloaded; atmosphere settings are saved by the host app'
    setTimeout(() => {
      URL.revokeObjectURL(url)
      urls.delete(url)
    }, 0)
  }
  const copy = actionButton('Copy JSON', () => {
    navigator.clipboard
      ?.writeText(JSON.stringify(controller.getGradeJSON(), null, 2))
      .then(() =>
        run(() => {
          notice = 'Grade JSON copied'
        }),
      )
      .catch(() =>
        run(() => {
          throw new Error('Clipboard unavailable — use Save grade')
        }),
      )
    if (!navigator.clipboard) throw new Error('Clipboard unavailable — use Save grade')
  })
  const toolbar = element(
    'div',
    { class: 'toolbar' },
    element('label', { class: 'grade-preset' }, 'Preset', preset),
    element('label', { class: 'grade-name' }, 'Save as', name),
    undo,
    redo,
    physical,
    actionButton('Load', () => fileInput.click()),
    actionButton('Save grade', download),
    copy,
    fileInput,
  )
  frame.append(toolbar)

  const tabs = element('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Editor panels' })
  const gradeTab = actionButton('Grade', () => setTab('grade'))
  const settingsTab = actionButton('Sun and Atmosphere', () => setTab('settings'))
  const tabID = 'sky-editor-' + Math.random().toString(36).slice(2)
  for (const [node, id] of [
    [gradeTab, 'grade'],
    [settingsTab, 'settings'],
  ] as const) {
    node.setAttribute('role', 'tab')
    node.setAttribute('id', tabID + '-' + id + '-tab')
    node.setAttribute('aria-controls', tabID + '-' + id)
  }
  tabs.append(gradeTab, settingsTab)
  tabs.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        const settings = shadow.activeElement === gradeTab
        setTab(settings ? 'settings' : 'grade')
        ;(settings ? settingsTab : gradeTab).focus()
      }
    },
    { signal },
  )
  frame.append(tabs)

  const solarMode = select('Sun navigation mode', [
    ['time', 'Time'],
    ['manual', 'Elevation'],
  ])
  const time = element('input', { type: 'range', min: '0', max: '24', step: '0.01', 'aria-label': 'Time of day' })
  const timeValue = element('input', {
    type: 'number',
    min: '0',
    max: '24',
    step: '0.01',
    'aria-label': 'Time of day value',
    title: 'Hours',
  })
  const elevation = element('input', {
    type: 'number',
    min: '-90',
    max: '90',
    step: '0.1',
    'aria-label': 'Sun elevation',
    title: 'Degrees',
  })
  const azimuth = element('input', { type: 'number', step: '1', 'aria-label': 'Sun azimuth', title: 'Degrees' })
  solarMode.addEventListener(
    'change',
    () =>
      run(() =>
        solarMode.value === 'time'
          ? controller.setTime(controller.settings.sun.timeOfDay)
          : controller.setElevation(controller.settings.sun.elevation),
      ),
    { signal },
  )
  time.addEventListener('input', () => run(() => controller.setTime(+time.value)), { signal })
  timeValue.addEventListener('change', () => run(() => controller.setTime(+timeValue.value)), { signal })
  elevation.addEventListener('change', () => run(() => controller.setElevation(+elevation.value)), { signal })
  azimuth.addEventListener(
    'change',
    () => run(() => controller.setElevation(controller.settings.sun.elevation, +azimuth.value)),
    { signal },
  )
  const play = actionButton('Play day', () => controller.togglePlayback())
  const speed = select('Playback speed', [
    ['0.25', '¼ h/s'],
    ['1', '1 h/s'],
    ['3', '3 h/s'],
  ])
  speed.value = '1'
  speed.addEventListener(
    'change',
    () => {
      controller.speed = +speed.value
    },
    { signal },
  )
  const solar = element(
    'div',
    { class: 'solar' },
    solarMode,
    time,
    timeValue,
    elevation,
    azimuth,
    play,
    speed,
    actionButton('Follow app', () => controller.followApp()),
  )
  frame.append(solar)

  const timelineCanvas = element('canvas', { class: 'timeline', 'aria-label': 'Grade keyframes by sun elevation' })
  const keySelect = select('Selected keyframe', [['', 'Between keyframes']])
  keySelect.addEventListener(
    'change',
    () =>
      run(() => {
        const key = controller.grade.keys[+keySelect.value]
        if (keySelect.value !== '' && key) controller.selectKey(key)
      }),
    { signal },
  )
  const addKey = actionButton('Add key', () => controller.addKey())
  const deleteKey = actionButton('Delete key', () => controller.deleteKey())
  const restoreDraft = actionButton('Restore draft', () => {
    controller.loadGrade(draft)
    draft = ''
    restoreDraft.hidden = true
  })
  restoreDraft.hidden = !draft
  const keyTools = element(
    'div',
    { class: 'key-tools' },
    actionButton('New', () => controller.replace(new SkyGrade())),
    keySelect,
    addKey,
    deleteKey,
    restoreDraft,
  )
  frame.append(timelineCanvas, keyTools)

  const gradeBody = element('div', {
    class: 'body',
    role: 'tabpanel',
    id: tabID + '-grade',
    'aria-labelledby': tabID + '-grade-tab',
  })
  const previewCanvas = element('canvas', { 'aria-label': 'Sky dome preview' })
  const overlayCanvas = element('canvas', {
    class: 'overlay',
    'aria-label': 'Sky zones; use the zone selector for keyboard access',
  })
  const hover = element('div', { class: 'hover' })
  const modeSelect = select('Dome preview mode', [
    ['split', 'Split'],
    ['graded', 'Graded'],
    ['physical', 'Physical'],
    ['grade', 'Grade only'],
  ])
  modeSelect.addEventListener(
    'change',
    () =>
      run(() => {
        mode = modeSelect.value as SkyGradePreviewMode
        lastDraw = ''
      }),
    { signal },
  )
  const guides = element('input', { type: 'checkbox', checked: '', 'aria-label': 'Zone guides' })
  const zone = select(
    'Select sky zone',
    GRADE_ZONES.map((key) => [key, ZONE_LABELS[key]]),
  )
  const inspectorRoot = element('aside', { class: 'inspector' })
  const previewTabs = element(
    'div',
    { class: 'preview-tabs' },
    modeSelect,
    element('label', { class: 'check' }, guides, 'Guides'),
    zone,
  )
  gradeBody.append(
    element(
      'div',
      { class: 'preview-area' },
      previewTabs,
      element('div', { class: 'preview-stack' }, previewCanvas, overlayCanvas, hover),
    ),
    inspectorRoot,
  )
  const settingsRoot = element('div', {
    class: 'settings',
    role: 'tabpanel',
    id: tabID + '-settings',
    'aria-labelledby': tabID + '-settings-tab',
    hidden: '',
  })
  const status = element('div', { class: 'status', role: 'status', 'aria-live': 'polite' })
  const resizeHandle = element('div', { class: 'resize', 'aria-hidden': 'true' })
  frame.append(gradeBody, settingsRoot, status, resizeHandle)

  const inspector = new Inspector(inspectorRoot, {
    onEdit: (patch: any, { commit }: { commit: boolean }) => run(() => controller.edit(patch, commit)),
    onAddKey: () => run(() => controller.addKey()),
    onDelete: () => run(() => controller.deleteKey()),
    onElevation: (value: number) =>
      run(() => {
        if (controller.selected) controller.moveKey(controller.selected, value, true)
      }),
  })
  if (!options.capabilities?.ambient) {
    inspectorRoot.prepend(
      element(
        'p',
        { class: 'notice' },
        'Ambient light keys are saved in the grade. No ambient light connection was supplied by this app.',
      ),
    )
  }
  zone.addEventListener('change', () => inspector.flashZone(zone.value), { signal })
  const preview = new EditorPreview(options.sky, options.renderer, previewCanvas)
  const overlay = new LutOverlay(overlayCanvas, hover, {
    preview: () => preview.preview,
    key: () => controller.key,
    sunElevation: () => controller.settings.evaluatedElevation,
    mode: () => (controller.bypass ? 'physical' : mode),
    onPickZone: (key: string) => {
      zone.value = key
      inspector.flashZone(key)
    },
  })
  guides.addEventListener(
    'change',
    () => {
      overlay.showGuides = guides.checked
      overlay.draw()
    },
    { signal },
  )
  const timeline = new Timeline(timelineCanvas, {
    grade: () => controller.grade,
    elevation: () => controller.settings.evaluatedElevation,
    selected: () => controller.selected,
    onScrub: (value: number) => run(() => controller.setElevation(value)),
    onSelectKey: (key: SkyGradeKey) => run(() => controller.selectKey(key)),
    onMoveKey: (key: SkyGradeKey, value: number) => {
      let moved = key
      run(() => {
        moved = controller.moveKey(key, value)
      })
      return moved
    },
    onMoveKeyEnd: () => run(() => controller.commit()),
    onInsertKey: (value: number) => run(() => controller.addKey(value)),
  })
  const settings = new SettingsPanel(settingsRoot, controller, run)

  function setTab(tab: 'grade' | 'settings') {
    gradeBody.hidden = tab !== 'grade'
    settingsRoot.hidden = tab !== 'settings'
    timelineCanvas.hidden = keyTools.hidden = tab !== 'grade'
    gradeTab.setAttribute('aria-selected', String(tab === 'grade'))
    settingsTab.setAttribute('aria-selected', String(tab === 'settings'))
    gradeTab.tabIndex = tab === 'grade' ? 0 : -1
    settingsTab.tabIndex = tab === 'settings' ? 0 : -1
    gradeTab.classList.toggle('on', tab === 'grade')
    settingsTab.classList.toggle('on', tab === 'settings')
    lastDraw = ''
    options.requestRender?.()
  }

  function refresh() {
    if (disposed) return
    if (controller.unavailable) {
      status.textContent = 'This sky was disposed. Close the editor and bind a new sky.'
      for (const input of [
        ...shadow.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
          '.toolbar input,.toolbar button,.solar input,.solar button,.solar select,.body input,.body button,.body select,.settings input,.settings select',
        ),
      ]) {
        input.disabled = true
      }
      return
    }
    const s = controller.settings
    const setValue = (input: HTMLInputElement | HTMLSelectElement, value: string) => {
      if (shadow.activeElement !== input) input.value = value
    }
    setValue(name, controller.grade.name)
    if (presetGrade !== controller.grade || presetRevision !== controller.grade.revision) {
      presetGrade = controller.grade
      presetRevision = controller.grade.revision
      const keys = JSON.stringify(controller.getGradeJSON().keys)
      preset.value = [...presetKeys].find(([, definition]) => definition === keys)?.[0] ?? ''
    }
    setValue(solarMode, s.sun.mode)
    setValue(time, String(s.sun.timeOfDay))
    setValue(timeValue, String(+s.sun.timeOfDay.toFixed(2)))
    setValue(elevation, String(+s.sun.elevation.toFixed(1)))
    setValue(azimuth, String(+s.sun.azimuth.toFixed(1)))
    time.hidden = timeValue.hidden = s.sun.mode !== 'time'
    elevation.hidden = azimuth.hidden = s.sun.mode !== 'manual'
    elevation.disabled = azimuth.disabled = s.planetFrame
    play.textContent = controller.playing ? 'Pause day' : 'Play day'
    undo.disabled = !controller.canUndo
    redo.disabled = !controller.canRedo
    physical.classList.toggle('on', controller.bypass)
    physical.setAttribute('aria-pressed', String(controller.bypass))
    modeSelect.disabled = controller.bypass
    modeSelect.value = controller.bypass ? 'physical' : mode
    addKey.disabled = controller.grade.keys.length >= MAX_GRADE_KEYS
    deleteKey.disabled = !controller.selected
    const selectedIndex = controller.selected ? controller.grade.keys.indexOf(controller.selected) : -1
    const keyStamp = controller.grade.revision + '|' + controller.revision + '|' + selectedIndex
    if (keyStamp !== lastInspector) {
      lastInspector = keyStamp
      inspector.show({
        key: controller.key,
        ghost: !controller.selected,
        elevation: s.evaluatedElevation,
        index: selectedIndex,
        count: controller.grade.keys.length,
      })
      const choices = controller.grade.keys.map((key, i) =>
        element('option', { value: String(i) }, `${i + 1}: ${key.elevation.toFixed(1)}°`),
      )
      keySelect.replaceChildren(element('option', { value: '' }, 'Between keyframes'), ...choices)
      keySelect.value = selectedIndex < 0 ? '' : String(selectedIndex)
    }
    settings.refresh()
    const changed = saved !== JSON.stringify(controller.getGradeJSON())
    status.classList.toggle('error', !!error)
    status.textContent =
      error ||
      notice ||
      `Sun ${s.evaluatedElevation.toFixed(1)}° · ${s.sun.mode === 'manual' ? 'Manual pose' : s.sun.timeOfDay.toFixed(2) + ' h'} · ${controller.controllingSun ? 'Editing sun' : 'Following app'}${controller.bypass ? ' · Physical comparison' : ''}${changed ? ' · Unsaved grade changes' : ''}`
  }

  function bounds() {
    const rect =
      container === document.body
        ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
        : container.getBoundingClientRect()
    return {
      left: Math.max(0, rect.left),
      top: Math.max(0, rect.top),
      right: Math.min(innerWidth, rect.right),
      bottom: Math.min(innerHeight, rect.bottom),
    }
  }
  function fit(initial = false) {
    if (!floating) return
    const b = bounds()
    const width = Math.max(220, Math.min(parseFloat(host.style.width) || 760, b.right - b.left - 16))
    const height = collapsed ? 45 : Math.max(200, Math.min(parseFloat(host.style.height) || 560, b.bottom - b.top - 16))
    host.style.width = width + 'px'
    host.style.height = height + 'px'
    host.style.left =
      Math.max(
        b.left,
        Math.min(initial ? b.right - width - 8 : parseFloat(host.style.left) || b.left, b.right - width),
      ) + 'px'
    host.style.top =
      Math.max(
        b.top,
        Math.min(initial ? b.bottom - height - 8 : parseFloat(host.style.top) || b.top, b.bottom - height),
      ) + 'px'
  }
  let drag: {
    pointer: number
    x: number
    y: number
    left: number
    top: number
    width: number
    height: number
    resize: boolean
  } | null = null
  const startDrag = (e: PointerEvent, resize: boolean) => {
    if (!floating || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    frame.focus()
    const rect = host.getBoundingClientRect()
    drag = {
      pointer: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      resize,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  header.addEventListener('pointerdown', (e) => startDrag(e, false), { signal })
  resizeHandle.addEventListener('pointerdown', (e) => startDrag(e, true), { signal })
  frame.addEventListener(
    'pointermove',
    (e) => {
      if (!drag || e.pointerId !== drag.pointer) return
      if (drag.resize) {
        host.style.width = Math.max(320, drag.width + e.clientX - drag.x) + 'px'
        host.style.height = Math.max(300, drag.height + e.clientY - drag.y) + 'px'
      } else {
        host.style.left = drag.left + e.clientX - drag.x + 'px'
        host.style.top = drag.top + e.clientY - drag.y + 'px'
      }
      fit()
      lastDraw = ''
      options.requestRender?.()
    },
    { signal },
  )
  for (const type of ['pointerup', 'pointercancel']) {
    frame.addEventListener(
      type,
      () => {
        drag = null
      },
      { signal },
    )
  }
  const observer = new ResizeObserver(() => {
    fit()
    lastDraw = ''
    options.requestRender?.()
  })
  observer.observe(host)
  window.addEventListener('resize', () => fit(), { signal })
  fit(true)
  resizeHandle.hidden = !floating
  header.style.cursor = floating ? 'move' : 'default'

  shadow.addEventListener('focusin', () => focusChanged(true), { signal })
  shadow.addEventListener(
    'focusout',
    () =>
      queueMicrotask(() => {
        if (!disposed) focusChanged(!!shadow.activeElement)
      }),
    { signal },
  )
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.composedPath().includes(host)) {
        ;(shadow.activeElement as HTMLElement | null)?.blur()
        focusChanged(false)
      }
    },
    { capture: true, signal },
  )
  // The shadow root stops bubble listeners. Hosts using capture/global input
  // handlers can suspend those through onFocusChange.
  for (const type of ['pointerdown', 'pointerup', 'pointermove', 'click', 'wheel', 'keyup']) {
    shadow.addEventListener(type, (e) => e.stopPropagation(), { signal })
  }
  shadow.addEventListener(
    'keydown',
    (event) => {
      const e = event as KeyboardEvent
      e.stopPropagation()
      const target = e.target as HTMLElement
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if (target.matches('textarea,select,input:not([type=range]):not([type=checkbox])') || target.isContentEditable) {
        return
      }
      if (
        target.matches('button,input[type=range],input[type=checkbox]') &&
        [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
      ) {
        return
      }
      const mod = e.ctrlKey || e.metaKey
      let action: (() => void) | null = null
      if (mod && e.key.toLowerCase() === 'z') {
        action = () => (e.shiftKey ? controller.redo() : controller.undo())
      } else if (!mod && e.key === ' ') {
        action = () => controller.togglePlayback()
      } else if (!mod && e.key.toLowerCase() === 'b') {
        action = () => controller.setBypass(!controller.bypass)
      } else if (!mod && e.key.toLowerCase() === 'k') {
        action = () => controller.addKey()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        action = () => controller.deleteKey()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        action = () =>
          controller.setTime(
            controller.settings.sun.timeOfDay + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.5 : 0.05),
          )
      }
      if (action) {
        e.preventDefault()
        run(action)
      }
    },
    { signal },
  )
  const unsubscribe = controller.subscribe(() => {
    if (shown) refresh()
  })

  function open() {
    if (disposed || shown) return
    focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null
    shown = true
    host.hidden = false
    controller.refresh()
    refresh()
    frame.focus()
    fit()
    options.requestRender?.()
  }
  function close() {
    if (disposed || !shown) return
    controller.followApp()
    if (controller.bypass && options.sky.state !== 'disposed') controller.setBypass(false)
    shown = false
    host.hidden = true
    focusChanged(false)
    focusBefore?.focus()
    options.requestRender?.()
  }
  setTab('grade')
  refresh()
  const editor: SkyEditor = {
    element: host,
    get isOpen() {
      return shown
    },
    open,
    close,
    toggle: () => (shown ? close() : open()),
    followApp: () => run(() => controller.followApp()),
    getGradeJSON: () => controller.getGradeJSON(),
    loadGrade: (json: SkyGradeJSON | string) => {
      controller.loadGrade(json)
      refresh()
    },
    update: (dt: number) => {
      if (!disposed) runUpdate(dt)
    },
    render: () => {
      if (disposed || !shown || collapsed) return
      controller.refresh()
      if (controller.unavailable || gradeBody.hidden) return
      try {
        preview.render(controller.bypass ? 'physical' : mode)
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
        refresh()
      }
      const stamp = controller.revision + '|' + mode + '|' + host.clientWidth + '|' + host.clientHeight
      if (stamp !== lastDraw) {
        const elevations = [
          ...controller.grade.keys.map((key) => key.elevation),
          controller.settings.evaluatedElevation,
        ]
        timeline.setRange(
          Math.max(-90, Math.min(-24, Math.floor(Math.min(...elevations) - 2))),
          Math.min(90, Math.max(80, Math.ceil(Math.max(...elevations) + 2))),
        )
        timeline.draw()
        overlay.draw()
        lastDraw = stamp
      }
    },
    dispose: () => {
      if (disposed) return
      close()
      controller.dispose()
      disposed = true
      abort.abort()
      observer.disconnect()
      unsubscribe()
      timeline.dispose()
      overlay.dispose()
      inspector.dispose()
      settings.dispose()
      preview.dispose()
      cleanupURLs()
      host.remove()
    },
  }
  function runUpdate(dt: number) {
    try {
      controller.update(dt)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      if (shown) refresh()
    }
    if (options.sky.state !== 'disposed' && options.sky.needsUpdate) options.requestRender?.()
  }
  if (options.open ?? true) open()
  return editor
}
