const v = window.__v
const THREE = await import('three/webgpu')
const { positionWorld, normalize, vec3, mix, pow, max, dot, smoothstep, float } = await import('three/tsl')
const renderer = new THREE.WebGPURenderer({ antialias: false })
renderer.setSize(64, 64)
document.body.appendChild(renderer.domElement)
await renderer.init()
const device = renderer.backend.device
const sync = () => device.queue.onSubmittedWorkDone()
// Sky-like source: horizon→zenith gradient, a bright sun glow, dark ground.
const dir = normalize(positionWorld)
const sun = vec3(0.3, 0.25, 0.92).normalize()
const skyCol = mix(vec3(1.0, 0.95, 0.85), vec3(0.15, 0.35, 0.9), smoothstep(0.0, 0.6, dir.y))
const glow = pow(max(dot(dir, sun), 0.0), float(64)).mul(20.0)
const ground = vec3(0.08, 0.07, 0.06)
const col = mix(ground, skyCol.add(glow), smoothstep(-0.02, 0.02, dir.y))
const scene = new THREE.Scene()
const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide })
mat.colorNode = col
scene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), mat))
const out = { version: v, three: THREE.REVISION }
for (const size of [64, 128, 256]) {
  const rt = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType })
  const cam = new THREE.CubeCamera(0.1, 1000, rt)
  cam.update(renderer, scene)
  const gen = new THREE.PMREMGenerator(renderer)
  const target = gen.fromCubemap(rt.texture)
  await sync()
  for (let i = 0; i < 3; i++) gen.fromCubemap(rt.texture, target)
  await sync()
  // same method as Lab.time(): min and median of several bursts
  const N = 20
  const walls = []
  let cpu = Infinity
  for (let b = 0; b < 7; b++) {
    const t0 = performance.now()
    for (let i = 0; i < N; i++) gen.fromCubemap(rt.texture, target)
    cpu = Math.min(cpu, (performance.now() - t0) / N)
    await sync()
    walls.push((performance.now() - t0) / N)
  }
  walls.sort((a, b) => a - b)
  const wall = walls[0]
  const median = walls[3]
  out[size] = {
    wallMs: +wall.toFixed(2),
    medianMs: +median.toFixed(2),
    cpuMs: +cpu.toFixed(2),
    target: `${target.width}x${target.height}${target.texture.mipmaps?.length ? ' mips ' + target.texture.mipmaps.length : ''}`,
  }
  gen.dispose()
  rt.dispose()
  target.dispose()
}
window.__result = out
