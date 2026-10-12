import { useEffect, useMemo } from 'react'
import * as THREE from 'three/webgpu'
import { color, mix, mx_noise_float, positionWorld, smoothstep, vec3 } from 'three/tsl'
import { TidewaterOcean } from './TidewaterOcean'
import type { Settings } from '../settings'

type CoastProps = { settings: Settings }

/** A shallow stage facing west from the Shonan coast. All shapes occupy real metres,
 * leaving the sky's aerial perspective to separate their distances naturally.
 */
export function Coast({ settings }: CoastProps) {
  const assets = useMemo(makeCoast, [])
  const waterline = useMemo(() => [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)], [])
  useEffect(() => () => assets.disposables.forEach((asset) => asset.dispose()), [assets])
  return (
    <clippingGroup name="Shonan / Fuji coastal stage" clippingPlanes={waterline} enabled={false}>
      <TidewaterOcean settings={settings} />
      <mesh
        geometry={assets.fuji}
        material={assets.fujiMaterial}
        userData={{ sunOccluder: true, excludeFromWaterReflection: true }}
        castShadow={settings.shadowHaze}
        receiveShadow={settings.shadowHaze}
      />
      {assets.ridges.map((ridge, i) => (
        <mesh
          key={i}
          geometry={ridge.geometry}
          material={ridge.material}
          userData={{ sunOccluder: true, excludeFromWaterReflection: true }}
          castShadow={settings.shadowHaze}
          receiveShadow={settings.shadowHaze}
        />
      ))}
      <mesh
        geometry={assets.enoshima}
        material={assets.islandMaterial}
        userData={{ sunOccluder: true, excludeFromWaterReflection: true }}
        castShadow={settings.shadowHaze}
        receiveShadow={settings.shadowHaze}
      />
      <mesh
        geometry={assets.breakwaterBase}
        material={assets.rockMaterial}
        castShadow={settings.shadowHaze}
        receiveShadow={settings.shadowHaze}
      />
      <group position={[1220, 74, -3880]} name="Enoshima Sea Candle">
        <mesh
          position={[0, 25, 0]}
          material={assets.concrete}
          castShadow={settings.shadowHaze}
          receiveShadow={settings.shadowHaze}>
          <cylinderGeometry args={[2.2, 4.2, 50, 8]} />
        </mesh>
        <mesh
          position={[0, 48, 0]}
          material={assets.concrete}
          castShadow={settings.shadowHaze}
          receiveShadow={settings.shadowHaze}>
          <cylinderGeometry args={[8, 7, 8, 12]} />
        </mesh>
        <mesh position={[0, 54, 0]} material={assets.light}>
          <sphereGeometry args={[3.2, 10, 8]} />
        </mesh>
      </group>
      <instancedMesh
        args={[assets.lightGeometry, assets.light, assets.lights.length]}
        ref={(mesh) => {
          if (!mesh) return
          assets.lights.forEach((m, i) => mesh.setMatrixAt(i, m))
          mesh.instanceMatrix.needsUpdate = true
        }}
      />
      <instancedMesh
        castShadow={settings.shadowHaze}
        receiveShadow={settings.shadowHaze}
        args={[assets.breakerGeometry, assets.concrete, assets.breakers.length]}
        ref={(mesh) => {
          if (!mesh) return
          assets.breakers.forEach((m, i) => mesh.setMatrixAt(i, m))
          mesh.instanceMatrix.needsUpdate = true
        }}
      />
      <instancedMesh
        castShadow={settings.shadowHaze}
        receiveShadow={settings.shadowHaze}
        args={[assets.rockGeometry, assets.rockMaterial, assets.rocks.length]}
        ref={(mesh) => {
          if (!mesh) return
          assets.rocks.forEach((m, i) => mesh.setMatrixAt(i, m))
          mesh.instanceMatrix.needsUpdate = true
        }}
      />
      <mesh
        position={[41, 0.95, -57]}
        rotation={[0.02, -0.17, -0.04]}
        material={assets.concrete}
        castShadow={settings.shadowHaze}
        receiveShadow={settings.shadowHaze}>
        <boxGeometry args={[19, 3.8, 8]} />
      </mesh>
    </clippingGroup>
  )
}

function makeCoast() {
  const disposables: { dispose: () => void }[] = []
  const keep = <T extends { dispose: () => void }>(v: T) => {
    disposables.push(v)
    return v
  }
  const mountain = (base: string) => keep(new THREE.MeshStandardNodeMaterial({ color: base, roughness: 1 }))
  const fujiMaterial = mountain('#333c42')
  // Long radial folds, subtle enough to read as ink on the volcanic flanks.
  const mineral = mx_noise_float(positionWorld.mul(vec3(0.0014, 0.0004, 0.0014)))
  fujiMaterial.colorNode = mix(color('#313b42'), color('#48505a'), mineral.mul(0.5).add(0.5).mul(0.34))
  const fuji = keep(
    heightField(-18000, 18000, -76000, -44000, 240, 120, (x, z) => {
      const dz = (z + 60000) * 1.12
      const angle = Math.atan2(dz, x)
      const r = Math.hypot(x * (x < 0 ? 0.98 : 1.025), dz)
      const warped = r * (1 + 0.017 * Math.sin(angle * 9) + 0.008 * Math.sin(angle * 17 + 1.2))
      const crater = 450 + 55 * Math.sin(angle * 5) + 40 * Math.sin(angle * 9)
      const t = Math.max(0, (warped - crater) / 15400)
      let h = 3760 * Math.pow(Math.max(0, 1 - t), 1.85)
      if (r < crater) h = 3760 - 28 * (1 - r / crater) + 8 * Math.sin(angle * 5)
      h += Math.sin(angle * 31 + r * 0.00012) * Math.min(32, r * 0.007) * Math.max(0, 1 - t)
      return Math.max(-30, h - 8)
    }),
  )
  // Three continuous ranges cross in front of Fuji; they hide the lower apron
  // rather than opening a symmetrical valley down to the sea. Profiles are
  // specified by horizontal viewing angle (x / distance), independently at each
  // depth, so the staggered shoulders remain legible from the poster camera.
  const ridgeSpecs = [
    {
      z: -30200,
      h: 1150,
      phase: 1.4,
      color: '#56616a',
      profile: [
        [-1.1, 0.72],
        [-0.72, 0.87],
        [-0.52, 1],
        [-0.34, 0.75],
        [-0.16, 0.58],
        [0, 0.54],
        [0.1, 0.61],
        [0.25, 0.43],
        [0.42, 0.3],
        [0.67, 0.57],
        [1.1, 0.88],
      ],
    },
    {
      z: -18800,
      h: 530,
      phase: 5.4,
      color: '#37464c',
      profile: [
        [-1.1, 0.45],
        [-0.7, 0.38],
        [-0.43, 0.55],
        [-0.22, 0.72],
        [-0.05, 0.57],
        [0.09, 0.67],
        [0.23, 0.88],
        [0.39, 0.68],
        [0.6, 0.43],
        [0.85, 0.74],
        [1.1, 0.92],
      ],
    },
    {
      z: -8800,
      h: 145,
      phase: 3.1,
      color: '#243738',
      profile: [
        [-1.1, 0.39],
        [-0.72, 0.52],
        [-0.46, 0.71],
        [-0.25, 0.59],
        [-0.08, 0.79],
        [0.14, 0.62],
        [0.35, 0.85],
        [0.55, 0.57],
        [0.78, 0.76],
        [1.1, 0.5],
      ],
    },
  ]
  const ridges = ridgeSpecs.map((p) => {
    const distance = -p.z
    const geometry = keep(
      heightField(-distance * 1.12, distance * 1.12, p.z - 1900, p.z + 1400, 420, 18, (x, z) => {
        const bearing = x / distance
        const shoulder = ridgeProfile(bearing, p.profile)
        const detail =
          0.025 * Math.sin(bearing * 67 + p.phase) +
          0.014 * Math.sin(bearing * 137 + p.phase * 2) +
          0.007 * Math.sin(bearing * 283 + p.phase)
        const cross = Math.max(0, 1 - Math.abs(z - p.z) / (z < p.z ? 1900 : 1400))
        return -18 + p.h * (shoulder + detail) * Math.pow(cross, 0.62)
      }),
    )
    return { geometry, material: mountain(p.color) }
  })
  const islandMaterial = mountain('#1d302f')
  const enoshima = keep(
    heightField(850, 1760, -4370, -3500, 70, 45, (x, z) => {
      const r = Math.hypot((x - 1300) / 470, (z + 3930) / 420)
      return (
        -12 +
        Math.pow(Math.max(0, 1 - r * r), 0.55) * 94 +
        Math.sin(x * 0.07) * Math.sin(z * 0.055) * Math.max(0, 1 - r) * 4
      )
    }),
  )
  const concrete = mountain('#3c413a')
  const patina = mx_noise_float(positionWorld.mul(2.9)).mul(0.5).add(0.5)
  concrete.colorNode = mix(color('#29322e'), color('#686b5c'), patina.mul(0.7))
  concrete.roughnessNode = smoothstep(-0.3, 1.6, positionWorld.y).mul(0.35).add(0.55)
  const rockMaterial = mountain('#252e2b')
  rockMaterial.colorNode = mix(
    color('#1c2624'),
    color('#404a3f'),
    mx_noise_float(positionWorld.mul(2)).mul(0.18).add(0.15),
  )
  const breakwaterBase = keep(
    heightField(-130, -17, -134, -86, 85, 24, (x, z) => {
      const centre = -112 - Math.sin((x + 107) * 0.045) * 9
      const r = Math.abs(z - centre) / 17
      const end = Math.min(1, Math.max(0, (-17 - x) / 18))
      const shoulder = Math.max(0, 1 - r * r)
      return -1.3 + shoulder * end * (2.2 + Math.sin(x * 0.8) * 0.24 + Math.sin(x * 1.7 + z * 0.5) * 0.15)
    }),
  )
  const breakerGeometry = keep(tetrapod())
  const rockGeometry = keep(new THREE.IcosahedronGeometry(1, 3))
  // Rough stone, without a repeating low-poly icosahedron silhouette.
  const pa = rockGeometry.getAttribute('position')
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i),
      y = pa.getY(i),
      z = pa.getZ(i)
    const warp = 0.94 + Math.sin(x * 8.3 + y * 3.4 + z * 7.1) * 0.1
    pa.setXYZ(i, x * warp, y * warp, z * warp)
  }
  rockGeometry.computeVertexNormals()
  const rng = random(83261)
  const breakers: THREE.Matrix4[] = [],
    rocks: THREE.Matrix4[] = []
  for (let i = 0; i < 28; i++) {
    const x = -107 + i * 3.15
    const z = -107 - Math.sin(i * 0.14) * 12 + (rng() - 0.5) * 10
    const size = 1.5 + rng() * 0.9
    breakers.push(matrix([x, -0.2 + rng() * 0.45, z], [rng() * 2, rng() * 6, rng() * 2], [size, size, size]))
  }
  for (let i = 0; i < 43; i++) {
    const left = i < 25
    const x = left ? -95 + rng() * 69 : 3 + rng() * 49
    const z = left ? -89 - rng() * 35 : -80 - rng() * 47
    const s = 1.2 + rng() * 2.6
    rocks.push(matrix([x, -0.7 + rng() * 0.8, z], [rng(), rng() * 6.28, rng()], [s * 2.0, s * 0.34, s * 1.1]))
  }
  // Tiny, sparse shore lights; denser on the inhabited Enoshima waterfront.
  const light = keep(new THREE.MeshBasicNodeMaterial({ color: new THREE.Color('#fff1c2').multiplyScalar(1.15) }))
  const lightGeometry = keep(new THREE.SphereGeometry(1, 6, 4))
  const lights: THREE.Matrix4[] = []
  for (let i = 0; i < 76; i++) {
    const island = i > 34
    const x = island ? 1050 + rng() * 1700 : -3200 + rng() * 7200
    const z = island ? -3515 - rng() * 70 : -5100 - rng() * 330
    const s = 1.15 + rng() * 1.15
    lights.push(matrix([x, 5 + rng() * 5, z], [0, 0, 0], [s, s * 0.65, s]))
  }
  return {
    disposables,
    breakwaterBase,
    fuji,
    fujiMaterial,
    ridges,
    enoshima,
    islandMaterial,
    concrete,
    rockMaterial,
    breakerGeometry,
    rockGeometry,
    breakers,
    rocks,
    light,
    lightGeometry,
    lights,
  }
}

/** Smooth shoulders with independent fine notches, never periodic whole hills. */
function ridgeProfile(x: number, points: number[][]) {
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1],
        [x1, y1] = points[i]
      const t = THREE.MathUtils.clamp((x - x0) / (x1 - x0), 0, 1)
      const ease = t * t * (3 - 2 * t)
      return y0 + (y1 - y0) * ease
    }
  }
  return points[points.length - 1][1]
}

function heightField(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  nx: number,
  nz: number,
  height: (x: number, z: number) => number,
) {
  const vertices: number[] = [],
    indices: number[] = []
  for (let z = 0; z <= nz; z++)
    for (let x = 0; x <= nx; x++) {
      const wx = x0 + ((x1 - x0) * x) / nx,
        wz = z0 + ((z1 - z0) * z) / nz
      vertices.push(wx, height(wx, wz), wz)
      if (x < nx && z < nz) {
        const a = z * (nx + 1) + x,
          b = a + 1,
          c = a + nx + 1,
          d = c + 1
        indices.push(a, c, b, b, c, d)
      }
    }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  g.setIndex(indices)
  g.computeVertexNormals()
  return g
}

function matrix(position: number[], rotation: number[], scale: number[]) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...(position as [number, number, number])),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(rotation as [number, number, number]))),
    new THREE.Vector3(...(scale as [number, number, number])),
  )
}
function random(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
}

/** Four tapered concrete arms, merged once and instanced along the breakwater. */
function tetrapod() {
  const directions = [
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0.94, -0.33, 0),
    new THREE.Vector3(-0.47, -0.33, 0.814),
    new THREE.Vector3(-0.47, -0.33, -0.814),
  ]
  const p: number[] = [],
    n: number[] = []
  for (const direction of directions) {
    const part = new THREE.CylinderGeometry(0.37, 0.67, 1.8, 6).toNonIndexed()
    part.applyQuaternion(
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize()),
    )
    part.translate(direction.x * 0.54, direction.y * 0.54, direction.z * 0.54)
    p.push(...part.getAttribute('position').array)
    n.push(...part.getAttribute('normal').array)
    part.dispose()
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3))
  return geometry
}
