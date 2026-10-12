import { mountEditor } from './shell'
import type { SkyEditor, SkyEditorOptions } from './types'

/** Create a vanilla authoring tool over an existing Sky and WebGPU renderer.
 * Importing this entry has no DOM side effects. */
export function createSkyEditor(options: SkyEditorOptions): SkyEditor {
  if (options.sky.state === 'disposed') throw new Error('Sky editor: sky is disposed')
  return mountEditor(options)
}

export type { SkyEditor, SkyEditorOptions } from './types'
