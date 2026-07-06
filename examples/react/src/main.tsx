import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas } from '@react-three/fiber'
import * as THREE from 'three/webgpu'

import { Sky } from '@pmndrs/sky/react'

/**
 * Minimal R3F + WebGPU demo of `<Sky>` from `@pmndrs/sky/react`.
 *
 * The `gl` factory returns an async-initialised `WebGPURenderer`, which is how
 * react-three-fiber v10 boots the WebGPU backend. `<Sky>` attaches to that
 * renderer + scene and drives itself per frame; a lit sphere sits in front so
 * the sky's IBL contribution is visible.
 *
 * NOTE: WebGPU + the r3f v10 alpha/canary line are moving targets — this demo
 * is structured against the documented API but should be eyeballed in a
 * WebGPU-capable browser. `<AutoHaze>` is intentionally omitted here because
 * `useRenderPipeline` is not present in every canary build.
 */
function App() {
  const [hour, setHour] = useState(15)

  return (
    <>
      <Canvas
        camera={{ position: [0, 1.5, 6], fov: 55 }}
        gl={async (props) => {
          const renderer = new THREE.WebGPURenderer(props as any)
          await renderer.init()
          return renderer
        }}>
        <Sky preset="earth" timeOfDay={hour} latitude={37.7} />
        <mesh position={[0, 1, 0]}>
          <sphereGeometry args={[1, 64, 32]} />
          <meshStandardMaterial metalness={0.1} roughness={0.4} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[50, 50]} />
          <meshStandardMaterial color="#556" roughness={1} />
        </mesh>
      </Canvas>

      <div style={{ position: 'absolute', top: 12, left: 12, color: '#eee', font: '13px system-ui' }}>
        <label>
          time of day: {hour.toFixed(1)}h{' '}
          <input type="range" min={0} max={24} step={0.5} value={hour} onChange={(e) => setHour(+e.target.value)} />
        </label>
      </div>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
