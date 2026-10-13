import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber/webgpu'
import { useSky } from '@pmndrs/sky/react'
import { createSkyEditor, type SkyEditor } from '@pmndrs/sky/editor'
import type { Sky, SkySettings } from '@pmndrs/sky'

export type EditorSession = { sky: Sky; editor: SkyEditor }

type Props = {
  container: HTMLElement | null
  active: boolean
  onReady: (session: EditorSession | null) => void
  onClose: () => void
  onFocus: (focused: boolean) => void
  onSunControl: () => void
  onSettingsCommit: (settings: SkySettings) => void
}

/** The public vanilla editor, mounted into the print's floating studio. */
export function GradeEditor(props: Props) {
  const sky = useSky() as Sky | null
  const renderer = useThree((state) => state.renderer)
  const session = useRef<EditorSession | null>(null)
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    if (!sky || !props.container) return
    const editor = createSkyEditor({
      sky,
      renderer,
      container: props.container,
      layout: 'embedded',
      open: false,
      capabilities: { ambient: true, haze: true },
      storageKey: 'pmndrs-sky:fuji-grade:0.6',
      acquireSunControl: () => {
        latest.current.onSunControl()
        return () => {}
      },
      onSettingsCommit: ({ settings }) => latest.current.onSettingsCommit(settings),
      onFocusChange: (focused) => latest.current.onFocus(focused),
    })
    // Theme the packaged editor and respond to the studio's width, so resizing
    // keeps the inspector readable without recreating the editor or its grade.
    Object.assign(editor.element.style, {
      height: '100%',
      colorScheme: 'light',
      containerType: 'inline-size',
      font: '11px/1.5 "DM Mono", monospace',
    })
    for (const [name, value] of Object.entries({
      bg: '#f2eedf',
      panel: '#e9e3d2',
      line: '#d0c8b5',
      text: '#494739',
      accent: '#934a36',
    }))
      editor.element.style.setProperty(`--sky-editor-${name}`, value)
    const style = document.createElement('style')
    style.textContent = `.header{display:none}.window{border:0;border-radius:0;box-shadow:none}.body{display:block;overflow:auto}.preview-area{height:220px;min-height:220px}.inspector{overflow:visible;border-left:0;border-top:1px solid var(--sky-editor-line)}.row label,.zname,h4,.banner,.hint,.notice{color:#817965}.toolbar,.solar,.tabs,.preview-tabs{padding:8px 10px}@container(min-width:760px){.body{display:grid;grid-template-columns:minmax(0,1fr) 420px}.preview-area{height:auto;min-height:0}.inspector{overflow:auto;border-top:0;border-left:1px solid var(--sky-editor-line)}}`
    editor.element.shadowRoot?.append(style)
    const observer = new MutationObserver(() => {
      if (!editor.isOpen && latest.current.active) latest.current.onClose()
    })
    observer.observe(editor.element, { attributes: true, attributeFilter: ['hidden'] })
    session.current = { sky, editor }
    latest.current.onReady(session.current)
    if (latest.current.active) editor.open()
    return () => {
      observer.disconnect()
      latest.current.onReady(null)
      session.current = null
      editor.dispose()
    }
  }, [sky, renderer, props.container])

  useEffect(() => {
    if (props.active) session.current?.editor.open()
    else session.current?.editor.close()
  }, [props.active])

  // The editor can own sun navigation. Run its clock before Sky's bake,
  // then draw its separate preview after the app has drawn the coastal print.
  useFrame(
    (_, delta) => {
      if (session.current?.editor.isOpen) session.current.editor.update(delta)
    },
    { priority: 1 },
  )
  useFrame(() => session.current?.editor.render(), { phase: 'after' })
  return null
}
