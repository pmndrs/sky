// WGSL for SkyPmrem. Ported from research/pmrem-lab/lab.js, where each kernel
// was measured and validated against three's own output (SKY_PMREM_SPEC.md).

const COMMON = /* wgsl */ `
fn faceDirUV(face: u32, u: f32, v: f32) -> vec3<f32> {
  switch face {
    case 0u: { return vec3( 1.0, -v, -u); }
    case 1u: { return vec3(-1.0, -v,  u); }
    case 2u: { return vec3( u,  1.0,  v); }
    case 3u: { return vec3( u, -1.0, -v); }
    case 4u: { return vec3( u, -v,  1.0); }
    default: { return vec3(-u, -v, -1.0); }
  }
}
fn faceDir(face: u32, px: vec2<f32>, size: f32) -> vec3<f32> {
  let uv = (px + 0.5) / size * 2.0 - 1.0;
  return normalize(faceDirUV(face, uv.x, uv.y));
}
fn hammersley(i: u32, n: u32) -> vec2<f32> {
  return vec2(f32(i) / f32(n), f32(reverseBits(i)) * 2.3283064365386963e-10);
}
// GGX D for V = N, up to a constant: NdotH^2 = (1 + NdotL) / 2.
fn ggxWeight(NdotL: f32, a2: f32) -> f32 {
  let dd = (1.0 + NdotL) * 0.5 * (a2 - 1.0) + 1.0;
  return NdotL / (dd * dd);
}`

/**
 * Filtered importance sampling (Křivánek & Colbert 2007), the sharp levels.
 * Identical to three r187's `ggxConvolution`: V = N, Hammersley points, N·L
 * weights, each sample reading the source mip that matches its solid angle.
 * Roughness 0 is a straight copy. `MIRROR` builds the sample frame in three's
 * x-mirrored cube space, which reproduces three's exact sample set.
 */
export const FIS_WGSL = /* wgsl */ `${COMMON}
struct L { outSize: u32, samples: u32, roughness: f32, lodBias: f32 }
@group(0) @binding(0) var src: texture_cube<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> P: L;
override MIRROR: bool = true;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= P.outSize || id.y >= P.outSize) { return; }
  let Nt = faceDir(id.z, vec2<f32>(id.xy), f32(P.outSize));
  if (P.roughness <= 0.0) { textureStore(dst, id.xy, id.z, textureSampleLevel(src, samp, Nt, 0.0)); return; }
  let M = select(vec3(1.0), vec3(-1.0, 1.0, 1.0), MIRROR);
  let N = Nt * M;
  let alpha = P.roughness * P.roughness; let a2 = alpha * alpha;
  let up = select(vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), abs(N.z) < 0.999);
  let T = normalize(cross(up, N)); let B = cross(N, T);
  var col = vec3(0.0); var w = 0.0;
  for (var i = 0u; i < P.samples; i++) {
    let xi = hammersley(i, P.samples);
    let invQ = 1.0 / ((1.0 - xi.x) + a2 * xi.x);
    let NdotL = ((1.0 - xi.x) - a2 * xi.x) * invQ;
    if (NdotL > 0.0) {
      let phi = xi.y * 6.283185307;
      let sinT = alpha * 2.0 * sqrt(xi.x * (1.0 - xi.x)) * invQ;
      let Ld = N * NdotL + (T * cos(phi) + B * sin(phi)) * sinT;
      let lod = max(log2(a2 * invQ) + P.lodBias, 0.0);
      col += textureSampleLevel(src, samp, Ld * M, lod).rgb * NdotL; w += NdotL;
    }
  }
  textureStore(dst, id.xy, id.z, vec4(col / w, 1.0));
}`

/**
 * Exhaustive GGX integration over a small source mip, for the tiny rough
 * levels: one 64-thread workgroup per output texel, threads striding the
 * source and reducing in shared memory. The one-thread-per-texel version is
 * latency-bound (an 8² level is 384 threads each looping 1,536 texels).
 */
export const INTEG_WGSL = /* wgsl */ `${COMMON}
struct I { outSize: u32, srcSize: u32, roughness: f32, pad: f32 }
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var<uniform> P: I;
var<workgroup> sCol: array<vec4<f32>, 64>;
@compute @workgroup_size(64, 1, 1)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let ox = wg.x % P.outSize; let oy = wg.x / P.outSize;
  let N = faceDir(wg.y, vec2(f32(ox), f32(oy)), f32(P.outSize));
  let alpha = P.roughness * P.roughness; let a2 = alpha * alpha;
  let n = P.srcSize; let per = n * n; let total = 6u * per;
  let inv = 2.0 / f32(n);
  var acc = vec4(0.0);
  for (var k = li; k < total; k += 64u) {
    let f = k / per; let r = k - f * per;
    let x = r % n; let y = r / n;
    let u = (f32(x) + 0.5) * inv - 1.0; let v = (f32(y) + 0.5) * inv - 1.0;
    let rl = inverseSqrt(1.0 + u * u + v * v);
    let Ld = faceDirUV(f, u, v) * rl;
    let NdotL = dot(N, Ld);
    if (NdotL > 0.0) {
      let wt = ggxWeight(NdotL, a2) * rl * rl * rl; // dOmega ∝ (1 + u² + v²)^-3/2
      acc += vec4(textureLoad(src, vec2<i32>(i32(x), i32(y)), i32(f), 0).rgb * wt, wt);
    }
  }
  sCol[li] = acc;
  workgroupBarrier();
  for (var s = 32u; s > 0u; s >>= 1u) {
    if (li < s) { sCol[li] += sCol[li + s]; }
    workgroupBarrier();
  }
  if (li == 0u) {
    let t = sCol[0];
    textureStore(dst, vec2(ox, oy), wg.y, vec4(t.rgb / t.w, 1.0));
  }
}`

/**
 * Exhaustive GGX integration, tiled: 8×8 output texels per workgroup, the
 * source staged through shared memory 64 texels at a time. Faster than the
 * reduction kernel once a level has thousands of texels (32² and up).
 */
export const INTEG_TILED_WGSL = /* wgsl */ `${COMMON}
struct I { outSize: u32, srcSize: u32, roughness: f32, pad: f32 }
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var<uniform> P: I;
var<workgroup> tDir: array<vec4<f32>, 64>;
var<workgroup> tCol: array<vec4<f32>, 64>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let inside = id.x < P.outSize && id.y < P.outSize;
  let N = faceDir(id.z, vec2<f32>(id.xy), f32(P.outSize));
  let alpha = P.roughness * P.roughness; let a2 = alpha * alpha;
  let n = P.srcSize; let per = n * n; let total = 6u * per;
  let inv = 2.0 / f32(n);
  var acc = vec4(0.0);
  for (var base = 0u; base < total; base += 64u) {
    let k = base + li;
    if (k < total) {
      let f = k / per; let r = k - f * per;
      let x = r % n; let y = r / n;
      let u = (f32(x) + 0.5) * inv - 1.0; let v = (f32(y) + 0.5) * inv - 1.0;
      let rl = inverseSqrt(1.0 + u * u + v * v);
      tDir[li] = vec4(faceDirUV(f, u, v) * rl, rl * rl * rl);
      tCol[li] = textureLoad(src, vec2<i32>(i32(x), i32(y)), i32(f), 0);
    } else {
      tDir[li] = vec4(0.0); tCol[li] = vec4(0.0);
    }
    workgroupBarrier();
    for (var j = 0u; j < 64u; j++) {
      let d = tDir[j];
      let NdotL = dot(N, d.xyz);
      if (NdotL > 0.0) {
        let wt = ggxWeight(NdotL, a2) * d.w;
        acc += vec4(tCol[j].rgb * wt, wt);
      }
    }
    workgroupBarrier();
  }
  if (inside) { textureStore(dst, id.xy, id.z, vec4(acc.rgb / acc.w, 1.0)); }
}`

/**
 * Packs one prefiltered level into three r185/r186's CubeUV atlas tile at
 * (x0, y0) of face size `size`: slot k (column k % 3, top row = slots 3–5)
 * holds face [3, 1, 5, 0, 4, 2][k], the inner (size − 2)² texels are the
 * face's texel centres, the 1-texel border is the direction just past the
 * edge, and directions come from three's `getDirection`. Our cubes live in
 * three's x-mirrored cube frame, hence the (−G.x, G.y, G.z) read.
 */
export const PACK_CUBEUV_WGSL = /* wgsl */ `
struct K { x0: u32, y0: u32, size: u32, pad: u32 }
@group(0) @binding(0) var env: texture_cube<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> P: K;
fn getDirection(uv: vec2<f32>, face: u32) -> vec3<f32> {
  let u = 2.0 * uv.x - 1.0; let v = 2.0 * uv.y - 1.0;
  switch face {
    case 0u: { return vec3( 1.0, v, u); }
    case 1u: { return vec3(-u, 1.0, -v); }
    case 2u: { return vec3(-u, v, 1.0); }
    case 3u: { return vec3(-1.0, v, -u); }
    case 4u: { return vec3(-u, -1.0, v); }
    default: { return vec3(u, v, -1.0); }
  }
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = P.size;
  if (id.x >= 3u * s || id.y >= 2u * s) { return; }
  var faceLib = array<u32, 6>(3u, 1u, 5u, 0u, 4u, 2u);
  let col = id.x / s;
  let slot = select(col, col + 3u, id.y < s);
  let p = f32(id.x - col * s); let q = f32(id.y % s);
  let fs = f32(s) - 2.0;
  let G = getDirection(vec2((p - 0.5) / fs, (f32(s) - 1.5 - q) / fs), faceLib[slot]);
  textureStore(dst, vec2(P.x0 + id.x, P.y0 + id.y), textureSampleLevel(env, samp, vec3(-G.x, G.y, G.z), 0.0));
}`

/** 2×2 box downsample of one mip into the next, all six faces per dispatch. */
export const DOWNSAMPLE_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var<uniform> size: vec4<u32>; // x = dst size
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= size.x || id.y >= size.x) { return; }
  let p = vec2<i32>(id.xy) * 2; let f = i32(id.z);
  let c = textureLoad(src, p, f, 0) + textureLoad(src, p + vec2(1, 0), f, 0)
        + textureLoad(src, p + vec2(0, 1), f, 0) + textureLoad(src, p + vec2(1, 1), f, 0);
  textureStore(dst, id.xy, id.z, c * 0.25);
}`
