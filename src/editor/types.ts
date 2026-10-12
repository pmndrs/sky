import type { Sky } from '../Sky'
import type { SkyGradeJSON } from '../grade'
import type { SkySettings } from '../settings'

export interface SkyEditorOptions {
  sky: Sky
  /** The initialized renderer used by sky. */
  renderer: any
  container?: HTMLElement
  open?: boolean
  layout?: 'floating' | 'embedded'
  requestRender?: () => void
  onCommit?: (event: { grade: SkyGradeJSON }) => void
  onSettingsCommit?: (event: { settings: SkySettings }) => void
  onFocusChange?: (focused: boolean) => void
  acquireSunControl?: () => (() => void) | false
  /** Opt-in draft storage; cached grades are only loaded by Restore draft. */
  storageKey?: string
  /** Informational bindings; the editor never inserts effects or lights. */
  capabilities?: { ambient?: boolean; haze?: boolean }
}

export interface SkyEditor {
  readonly element: HTMLElement
  readonly isOpen: boolean
  open(): void
  close(): void
  toggle(): void
  followApp(): void
  update(dtSeconds: number): void
  render(): void
  getGradeJSON(): SkyGradeJSON
  loadGrade(json: SkyGradeJSON | string): void
  dispose(): void
}
