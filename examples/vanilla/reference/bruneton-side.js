/**
 * Bruneton's precomputed-scattering demo (demo.js, BSD-3), unmodified, as one
 * panel of 20-reference-compare.html. The page loads demo.js as a classic
 * script first (it defines the globals `Demo` and `Utils`).
 *
 * Two seams, neither touching his code:
 *   - his two static loaders on `Utils` resolve from public/bruneton/ (or his
 *     GitHub Pages site when the 16 MB .dat tables were never fetched)
 *   - the camera. His onRender rebuilds `model_from_view` from orbit angles
 *     every frame; for a free camera the page swaps that matrix (and the
 *     `camera` uniform, its translation) at the GL call that uploads it. In
 *     orbit mode nothing is swapped.
 */

// ATMOSPHERE.solar_irradiance (W/m²/nm at 680 / 550 / 440 nm). His sky is in
// spectral radiance; multiplying a per-unit-illuminance sky by this puts it in
// the same units.
export const SOLAR_IRRADIANCE = [1.474, 1.8504, 1.91198]
export const SUN_ANGULAR_RADIUS = 0.004675
// GetSolarRadiance() = solar_irradiance / (π r²) — what his sun disc adds.
export const SOLAR_RADIANCE_G = SOLAR_IRRADIANCE[1] / (Math.PI * SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS)
// Baked into his precomputed tables.
export const BRUNETON_GROUND_ALBEDO = 0.1
export const BRUNETON_FOV_Y_DEG = 50

const LOCAL = './bruneton/'
const REMOTE = 'https://ebruneton.github.io/precomputed_atmospheric_scattering/'

async function fetchWithFallback(name, kind) {
  for (const base of [LOCAL, REMOTE]) {
    try {
      const r = await fetch(base + name)
      if (!r.ok) continue
      if ((r.headers.get('content-type') || '').includes('text/html')) continue
      return kind === 'text' ? await r.text() : await r.arrayBuffer()
    } catch {
      /* try the next base */
    }
  }
  throw new Error(`bruneton: could not load ${name} (run scripts/fetch-bruneton.mjs)`)
}

/**
 * @param {HTMLElement} root   the element his Demo takes as its root (holds #glcanvas and #help)
 * @param {HTMLCanvasElement} canvas  #glcanvas
 */
export function createBrunetonSide(root, canvas) {
  // Top-level `class` declarations in a classic script are global bindings,
  // not properties of `window` — reach them by name.
  /* global Demo, Utils */
  if (typeof Demo === 'undefined' || typeof Utils === 'undefined') {
    throw new Error('bruneton: demo.js must be loaded before this module')
  }
  Utils.loadShaderSource = (name, cb) => fetchWithFallback(name, 'text').then((s) => cb(s.trim()))
  Utils.loadTextureData = (name, cb) =>
    fetchWithFallback(name, 'buffer').then((buf) => {
      // Same little-endian float32 unpack as his original loader.
      const data = new DataView(buf)
      const arr = new Float32Array(buf.byteLength / 4)
      for (let i = 0; i < arr.length; i++) arr[i] = data.getFloat32(i * 4, true)
      cb(arr)
    })

  // Create the context first so the drawing buffer is kept for readback and
  // for the diff view; his getContext('webgl2') then returns this one.
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false })

  // Camera seam. Uniform locations are fresh objects per getUniformLocation
  // call, so tag them with their name on the way out.
  let override = null // { modelFromView: Float32Array(16) row-major, camera: [x, y, z] } in km
  const getUniformLocation = gl.getUniformLocation.bind(gl)
  gl.getUniformLocation = (program, name) => {
    const loc = getUniformLocation(program, name)
    if (loc) loc.__name = name
    return loc
  }
  const uniformMatrix4fv = gl.uniformMatrix4fv.bind(gl)
  gl.uniformMatrix4fv = (loc, transpose, data, ...rest) =>
    uniformMatrix4fv(
      loc,
      transpose,
      override && loc?.__name === 'model_from_view' ? override.modelFromView : data,
      ...rest,
    )
  const uniform3f = gl.uniform3f.bind(gl)
  gl.uniform3f = (loc, x, y, z) =>
    override && loc?.__name === 'camera' ? uniform3f(loc, ...override.camera) : uniform3f(loc, x, y, z)

  const demo = new Demo(root)

  // Readback: 8-bit pixels, and the linear radiance recovered by inverting
  // his curve (white point 1): L = −ln(1 − c^2.2) / exposure.
  const rcanvas = document.createElement('canvas')
  const rctx = rcanvas.getContext('2d', { willReadFrequently: true })
  const readBlock = (x0, y0, w, h) => {
    if (rcanvas.width !== w || rcanvas.height !== h) {
      rcanvas.width = w
      rcanvas.height = h
    }
    rctx.clearRect(0, 0, w, h)
    rctx.drawImage(canvas, x0, y0, w, h, 0, 0, w, h)
    return rctx.getImageData(0, 0, w, h).data
  }
  const invert = (v, exposure) => {
    const c = v / 255
    return c >= 1 ? Infinity : -Math.log(1 - Math.pow(c, 2.2)) / exposure
  }

  return {
    demo,
    canvas,
    gl,
    ready: () => !!(demo.program && demo.transmittanceTexture && demo.scatteringTexture && demo.irradianceTexture),
    /**
     * Push the shared state. `camera` = { right, up, back, position } in his
     * frame (Z-up, km) for a free camera, or null to let his orbit drive.
     */
    sync(state, camera) {
      demo.viewDistanceMeters = state.viewDistanceMeters
      demo.viewZenithAngleRadians = state.viewZenith
      demo.viewAzimuthAngleRadians = state.viewAzimuth
      demo.sunZenithAngleRadians = state.sunZenith
      demo.sunAzimuthAngleRadians = state.sunAzimuth
      demo.exposure = state.exposure
      override = camera
        ? {
            // his layout: rows (right, up, back, position), uploaded transposed
            modelFromView: new Float32Array([
              camera.right[0], camera.up[0], camera.back[0], camera.position[0],
              camera.right[1], camera.up[1], camera.back[1], camera.position[1],
              camera.right[2], camera.up[2], camera.back[2], camera.position[2],
              0, 0, 0, 1,
            ]), // prettier-ignore
            camera: camera.position,
          }
        : null
    },
    resize(width, height) {
      // his constructor pins the CSS size inline; let the page's layout own it
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      canvas.width = width
      canvas.height = height
      gl.viewport(0, 0, width, height) // his loop never resets the viewport
    },
    /**
     * Mean over a (2r+1)² window at (px, py): 8-bit and linear. Linear is
     * Infinity when any pixel in the window is saturated (the sun disc).
     */
    probe(px, py, r, exposure) {
      const x0 = Math.min(canvas.width - 1, Math.max(0, px - r))
      const y0 = Math.min(canvas.height - 1, Math.max(0, py - r))
      const w = Math.min(canvas.width - x0, 2 * r + 1)
      const h = Math.min(canvas.height - y0, 2 * r + 1)
      const d = readBlock(x0, y0, w, h)
      const rgb8 = [0, 0, 0]
      const linear = [0, 0, 0]
      for (let i = 0; i < w * h; i++) {
        for (let c = 0; c < 3; c++) {
          rgb8[c] += d[i * 4 + c] / (w * h)
          linear[c] += invert(d[i * 4 + c], exposure) / (w * h)
        }
      }
      return { rgb8, linear }
    },
  }
}
