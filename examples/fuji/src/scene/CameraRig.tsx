import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber/webgpu'
import { Vector3, PerspectiveCamera } from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Settings, PrintLayout } from '../settings'
import { printFraming } from '../print/framing'

const home = new Vector3(0, 8, 75)
export function CameraRig({ settings, layout }: { settings: Settings; layout: PrintLayout }) {
  const { camera, renderer: gl, size } = useThree()
  const aim = useMemo(() => {
    const aspect = size.width / Math.max(size.height, 1)
    // Preserve the full bay in a portrait print, rather than cropping to Fuji alone.
    return new Vector3(0, printFraming(aspect, layout).aimHeight, -2500)
  }, [size.width, size.height, layout])
  useEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return
    const aspect = size.width / Math.max(size.height, 1)
    camera.fov = printFraming(aspect, layout).fov
    camera.updateProjectionMatrix()
  }, [camera, size.width, size.height, layout])
  const pointer = useRef({ x: 0, y: 0 })
  const manual = useRef<OrbitControls | null>(null)
  const target = useRef(aim.clone())
  useEffect(() => {
    camera.position.copy(home)
    camera.lookAt(aim)
    const el = gl.domElement
    const move = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      pointer.current = {
        x: ((event.clientX - rect.left) / rect.width - 0.5) * 2,
        y: ((event.clientY - rect.top) / rect.height - 0.5) * 2,
      }
    }
    const leave = () => {
      pointer.current = { x: 0, y: 0 }
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    return () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
    }
  }, [camera, gl, aim])
  useEffect(() => {
    if (settings.manualCamera) {
      const controls = new OrbitControls(camera, gl.domElement)
      controls.target.copy(aim)
      controls.enableDamping = true
      controls.dampingFactor = 0.06
      controls.minDistance = 100
      controls.maxDistance = 6500
      controls.maxPolarAngle = Math.PI * 0.95
      manual.current = controls
      return () => {
        controls.dispose()
        manual.current = null
      }
    }
    camera.position.copy(home)
    target.current.copy(aim)
    camera.lookAt(aim)
  }, [settings.manualCamera, camera, gl, aim])
  useFrame((_, delta) => {
    if (manual.current) {
      manual.current.update()
      return
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const x = settings.drift && !reduced ? pointer.current.x * 28 : 0
    const y = settings.drift && !reduced ? -pointer.current.y * 14 : 0
    target.current.lerp(new Vector3(aim.x + x, aim.y + y, aim.z), 1 - Math.exp(-delta * 2.5))
    camera.lookAt(target.current)
  })
  return null
}
