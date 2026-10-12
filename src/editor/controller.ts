import { SkyGrade, MAX_GRADE_KEYS, resolveGradeKey } from '../grade'
import type { Sky } from '../Sky'
import type { SkySettings } from '../settings'
import type { SkyGradeJSON, SkyGradeKey, SkyGradeKeyInput } from '../grade'

export interface SkyEditorControllerOptions {
  sky: Sky
  requestRender?: () => void
  onCommit?: (event: { grade: SkyGradeJSON }) => void
  onSettingsCommit?: (event: { settings: SkySettings }) => void
  acquireSunControl?: () => (() => void) | false
}

interface Snapshot {
  grade: SkyGradeJSON
  attached: boolean
}

/** Authoring commands and history, independent of DOM or rendering. */
export class SkyEditorController {
  readonly sky: Sky
  grade: SkyGrade
  settings: SkySettings
  selected: SkyGradeKey | null = null
  bypass = false
  playing = false
  speed = 1
  controllingSun = false
  disposed = false
  unavailable = false
  revision = 0
  private attached: boolean
  private ownCommand = 0
  private listeners = new Set<() => void>()
  private unsubscribeSky: () => void
  private unsubscribeGrade: () => void = () => {}
  private releaseSun: (() => void) | null = null
  private history: Snapshot[] = []
  private historyIndex = 0
  private settingsStamp: string
  private queuedSettings = new Map<string, () => void>()

  constructor(private options: SkyEditorControllerOptions) {
    this.sky = options.sky
    this.settings = this.sky.getSettings()
    this.settingsStamp = JSON.stringify(this.settings)
    this.grade = this.sky.grade ?? new SkyGrade()
    this.attached = this.sky.grade !== null
    this.watchGrade()
    this.resetHistory()
    this.unsubscribeSky = this.sky.onGradeChange((grade) => {
      if (this.ownCommand) return
      if (grade !== this.grade || this.bypass) {
        this.bypass = false
        this.grade = grade ?? new SkyGrade()
        this.attached = grade !== null
        this.watchGrade()
      }
      this.resetHistory()
      this.syncSelection()
      this.changed()
    })
    this.syncSelection()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private watchGrade() {
    this.unsubscribeGrade()
    this.unsubscribeGrade = this.grade.onChange(() => {
      // Assigned grades are already observed through the sky. Keep observing
      // a detached draft while physical comparison is active.
      if (this.ownCommand || (!this.bypass && this.attached)) return
      this.resetHistory()
      this.syncSelection()
      this.changed()
    })
  }

  private command(fn: () => void) {
    if (this.disposed || this.sky.state === 'disposed') throw new Error('Sky editor: sky is disposed')
    this.ownCommand++
    try {
      fn()
    } finally {
      this.ownCommand--
    }
  }

  private snapshot(): Snapshot {
    return { grade: this.grade.toJSON(), attached: this.attached }
  }

  private resetHistory() {
    this.history = [this.snapshot()]
    this.historyIndex = 0
  }

  get canUndo() {
    return this.historyIndex > 0
  }
  get canRedo() {
    return this.historyIndex < this.history.length - 1
  }
  get key(): SkyGradeKey {
    return this.selected ?? resolveGradeKey(this.grade.interpolatedKeyInput(this.settings.evaluatedElevation))
  }

  private syncSelection() {
    this.selected =
      this.grade.keys.length === 1 ? this.grade.keys[0] : this.grade.keyAt(this.settings.evaluatedElevation, 0.25)
  }

  private changed() {
    this.revision++
    for (const listener of this.listeners) listener()
    this.options.requestRender?.()
  }

  commit() {
    const next = this.snapshot()
    if (JSON.stringify(next) === JSON.stringify(this.history[this.historyIndex])) return
    this.history.length = this.historyIndex + 1
    this.history.push(next)
    if (this.history.length > 200) this.history.shift()
    this.historyIndex = this.history.length - 1
    this.changed()
    this.options.onCommit?.({ grade: this.grade.toJSON() })
  }

  private attachDraft() {
    this.attached = true
    if (!this.bypass) this.sky.setGrade(this.grade)
  }

  edit(patch: Partial<SkyGradeKeyInput>, commit = true) {
    // Validate the whole patch before auto-keying mutates the document.
    resolveGradeKey(patch, this.key)
    if (!this.selected && this.grade.keys.length >= MAX_GRADE_KEYS) {
      throw new Error(`${MAX_GRADE_KEYS} keyframes is the maximum`)
    }
    this.command(() => {
      this.selected ??= this.grade.insertKeyAt(Math.round(this.settings.evaluatedElevation * 10) / 10)
      this.selected = this.grade.updateKey(this.selected, patch)
      this.attachDraft()
    })
    this.changed()
    if (commit) this.commit()
  }

  addKey(elevation = this.settings.evaluatedElevation) {
    if (!Number.isFinite(elevation) || elevation < -90 || elevation > 90) {
      throw new Error('Elevation must be between -90° and 90°')
    }
    this.command(() => {
      this.selected = this.grade.insertKeyAt(elevation, 0.25)
      this.attachDraft()
    })
    this.commit()
    this.changed()
  }

  deleteKey() {
    if (!this.selected) return
    this.command(() => this.grade.removeKey(this.selected!))
    this.syncSelection()
    this.commit()
    this.changed()
  }

  moveKey(key: SkyGradeKey, elevation: number, commit = false): SkyGradeKey {
    if (!Number.isFinite(elevation) || elevation < -90 || elevation > 90) {
      throw new Error('Elevation must be between -90° and 90°')
    }
    const occupied = this.grade.keyAt(elevation, 0.05)
    if (occupied && occupied !== key) throw new Error('A keyframe already occupies this elevation')
    this.command(() => {
      this.selected = this.grade.updateKey(key, { elevation })
    })
    if (!this.settings.planetFrame) this.setElevation(elevation)
    this.changed()
    if (commit) this.commit()
    return this.selected!
  }

  selectKey(key: SkyGradeKey) {
    if (!this.grade.keys.includes(key)) return
    this.selected = key
    if (!this.settings.planetFrame) this.setElevation(key.elevation)
    this.changed()
  }

  rename(name: string) {
    this.grade.name = name.trim()
    this.commit()
  }

  replace(grade: SkyGrade) {
    this.command(() => {
      this.grade.name = grade.name
      this.grade.setKeys(grade.keys)
      this.attachDraft()
    })
    this.syncSelection()
    this.commit()
    this.changed()
  }

  loadGrade(json: SkyGradeJSON | string) {
    const data = typeof json === 'string' ? JSON.parse(json) : json
    if (!data || data.version !== 1 || !Array.isArray(data.keys)) throw new Error('Unsupported sky grade file')
    this.replace(SkyGrade.fromJSON(data))
  }

  getGradeJSON(): SkyGradeJSON {
    return this.grade.toJSON()
  }

  private restore(snapshot: Snapshot) {
    const grade = SkyGrade.fromJSON(snapshot.grade)
    this.command(() => {
      this.grade.name = grade.name
      this.grade.setKeys(grade.keys)
      this.attached = snapshot.attached
      if (!this.bypass) this.sky.setGrade(this.attached ? this.grade : null)
    })
    this.syncSelection()
    this.changed()
    this.options.onCommit?.({ grade: this.grade.toJSON() })
  }

  undo() {
    if (this.canUndo) this.restore(this.history[--this.historyIndex])
  }
  redo() {
    if (this.canRedo) this.restore(this.history[++this.historyIndex])
  }

  setBypass(on: boolean) {
    if (this.bypass === on) return
    this.command(() => {
      this.bypass = on
      this.sky.setGrade(on ? null : this.attached ? this.grade : null)
    })
    this.changed()
  }

  private acquireSun(): boolean {
    if (this.controllingSun) return true
    const release = this.options.acquireSunControl?.()
    if (release === false) return false
    this.releaseSun = release ?? null
    this.controllingSun = true
    return true
  }

  followApp() {
    this.playing = false
    this.controllingSun = false
    const release = this.releaseSun
    this.releaseSun = null
    release?.()
    this.changed()
  }

  setTime(time: number) {
    if (!Number.isFinite(time)) throw new Error('Time must be finite')
    if (!this.acquireSun()) throw new Error('The application controls the sun')
    this.playing = false
    this.sky.setTimeOfDay(((time % 24) + 24) % 24)
    this.refresh()
  }

  setElevation(elevation: number, azimuth = this.settings.sun.azimuth) {
    if (this.settings.planetFrame) throw new Error('Local sun navigation is unavailable in planet-frame scenes')
    if (!Number.isFinite(elevation) || elevation < -90 || elevation > 90 || !Number.isFinite(azimuth)) {
      throw new Error('Invalid sun direction')
    }
    if (!this.acquireSun()) throw new Error('The application controls the sun')
    this.playing = false
    this.sky.setSunDirection({ elevation, azimuth, raw: this.settings.sun.raw })
    this.refresh()
  }

  togglePlayback() {
    if (this.playing) {
      this.playing = false
      this.changed()
      return
    }
    if (!this.acquireSun()) throw new Error('The application controls the sun')
    this.sky.setTimeOfDay(this.settings.sun.timeOfDay)
    this.playing = true
    this.refresh()
    this.changed()
  }

  /** Coalesce physical sliders before the next host sky update. */
  queueSetting(key: string, apply: () => void) {
    this.queuedSettings.set(key, apply)
    this.options.requestRender?.()
  }

  commitSettings() {
    this.flushSettings()
    this.refresh()
    this.options.onSettingsCommit?.({ settings: this.sky.getSettings() })
  }

  private flushSettings() {
    const edits = [...this.queuedSettings.values()]
    this.queuedSettings.clear()
    for (const apply of edits) apply()
  }

  refresh() {
    if (this.disposed || this.sky.state === 'disposed') {
      if (!this.unavailable) {
        this.unavailable = true
        this.followApp()
      }
      return
    }
    const settings = this.sky.getSettings()
    const stamp = JSON.stringify(settings)
    if (stamp !== this.settingsStamp) {
      this.settings = settings
      this.settingsStamp = stamp
      this.syncSelection()
      this.changed()
    }
  }

  update(dtSeconds: number) {
    if (this.disposed || this.sky.state === 'disposed') {
      this.refresh()
      return
    }
    this.flushSettings()
    this.refresh()
    if (this.playing) {
      this.sky.setTimeOfDay(
        (this.settings.sun.timeOfDay + Math.max(0, Math.min(dtSeconds || 0, 0.1)) * this.speed) % 24,
      )
      this.refresh()
      this.options.requestRender?.()
    }
  }

  dispose() {
    if (this.disposed) return
    if (this.sky.state !== 'disposed') this.flushSettings()
    else this.queuedSettings.clear()
    if (this.bypass && this.sky.state !== 'disposed') this.setBypass(false)
    this.followApp()
    this.unsubscribeSky()
    this.unsubscribeGrade()
    this.listeners.clear()
    this.disposed = true
  }
}
