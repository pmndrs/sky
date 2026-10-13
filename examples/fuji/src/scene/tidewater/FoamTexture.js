// Adapted from Tidewater, commit fd6cae6 (user-licensed source).
import * as THREE from 'three/webgpu'
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  uvec2,
  globalId,
  textureStore,
  fract,
  floor,
  sin,
  dot,
  min,
  max,
  length,
  smoothstep,
  mix,
  pow,
  abs,
  clamp,
  saturate,
} from 'three/tsl'

// Tileable procedural foam, generated once on the GPU.
//
// Real sea foam is an irregular bubbly mat: dense rafts with ragged edges, holes of every size,
// thin bubble streaks, and fine bubbles. Thresholding this density field against the local foam
// coverage (in the water shader) makes foam grow, tear into lace and dissolve naturally.
//   R: foam density field (thresholded by coverage)
//   G: fine bubble detail (brightness / normal variation)
//   B: soft large-scale mottling
//   A: streaks
export function createFoamTexture(renderer, size = 1024) {
  const tex = new THREE.StorageTexture(size, size)
  tex.type = THREE.HalfFloatType
  tex.format = THREE.RGBAFormat
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.mipmapsAutoUpdate = true
  tex.anisotropy = 4
  tex.name = 'foamPattern'

  const hash2 = (p) => fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))).mul(43758.5453))

  // periodic worley F1 with jittered cell sizes
  const worley = (uv, cells) => {
    const p = uv.mul(cells)
    const ip = floor(p)
    const fp = fract(p)
    const f1 = float(8).toVar()
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const o = vec2(i, j)
        const cell = ip.add(o).mod(cells)
        const h = hash2(cell)
        const d = length(o.add(h).sub(fp))
        f1.assign(min(f1, d))
      }
    }

    return f1
  }

  const vnoise = (uv, cells) => {
    const p = uv.mul(cells)
    const i = floor(p)
    const f = fract(p)
    const u = f.mul(f).mul(float(3).sub(f.mul(2)))
    const a = hash2(i.mod(cells)).x
    const b = hash2(i.add(vec2(1, 0)).mod(cells)).x
    const c = hash2(i.add(vec2(0, 1)).mod(cells)).x
    const d = hash2(i.add(vec2(1, 1)).mod(cells)).x
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y)
  }

  const fbm = (uv, base, oct) => {
    let s = float(0),
      a = 0.5,
      n = 0
    for (let o = 0; o < oct; o++) {
      s = s.add(vnoise(uv, base * Math.pow(2, o)).mul(a))
      n += a
      a *= 0.5
    }

    return s.div(n)
  }

  const kernel = Fn(() => {
    const px = globalId.xy
    const uv = vec2(px).add(0.5).div(size)

    // domain warp (organic, flowing shapes)
    const w1 = vec2(fbm(uv, 3, 4), fbm(uv.add(0.43), 3, 4))
      .sub(0.5)
      .mul(0.14)
    const wuv = uv.add(w1)

    // density: ragged rafts
    const dens = fbm(wuv, 4, 6).toVar()

    // holes of many sizes punched through the mat (worley, radius varied by noise)
    const holeA = smoothstep(0.28, 0.12, worley(wuv, 7).add(fbm(uv, 16, 3).sub(0.5).mul(0.25)))
    const holeB = smoothstep(0.3, 0.16, worley(wuv.add(0.17), 19).add(fbm(uv, 32, 2).sub(0.5).mul(0.3)))
    const holeC = smoothstep(0.32, 0.18, worley(wuv.add(0.61), 47))
    const holes = saturate(holeA.mul(0.9).add(holeB.mul(0.7)).add(holeC.mul(0.45)))

    // fine bubbles: small bright dots
    const bub = smoothstep(0.24, 0.08, worley(uv.add(0.33), 140))
      .mul(0.8)
      .add(smoothstep(0.2, 0.05, worley(uv.add(0.71), 260)).mul(0.5))

    // streaks (drawn out by flow)
    const streak = fbm(vec2(uv.x.mul(1), uv.y.mul(1)).add(w1.mul(2)), 12, 4)

    const foam = saturate(dens.mul(1.35).sub(holes.mul(0.55)).add(bub.mul(0.08)))
    const mottle = fbm(uv, 2, 3)

    textureStore(tex, uvec2(px), vec4(foam, saturate(bub), mottle, streak))
  })()
    .computeKernel([8, 8, 1])
    .setName('Foam Pattern')

  renderer.compute(kernel, [size / 8, size / 8, 1])
  return tex
}
