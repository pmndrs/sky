// Shared WebGPU building blocks for the PMREM lab (SKY_PMREM_SPEC.md).
// Plain WebGPU, no three: the goal is to measure the prefilter itself.

export const FMT = 'rgba16float'

export async function initDevice() {
  const adapter = await navigator.gpu.requestAdapter()
  return adapter.requestDevice()
}

// ---------------------------------------------------------------------------
// WGSL
// ---------------------------------------------------------------------------

export const COMMON = /* wgsl */ `
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

// Synthetic sky: variant 0 = gradient + sun glow, 1 = white furnace.
const SKY = /* wgsl */ `${COMMON}
struct SkyP { size: u32, variant: u32, glow: f32, sharp: f32, sun: vec4<f32> }
@group(0) @binding(0) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(1) var<uniform> P: SkyP;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= P.size || id.y >= P.size) { return; }
  let d = faceDir(id.z, vec2<f32>(id.xy), f32(P.size));
  if (P.variant == 1u) { textureStore(dst, id.xy, id.z, vec4(1.0)); return; }
  let sun = normalize(P.sun.xyz);
  let sky = mix(vec3(1.0, 0.85, 0.7), vec3(0.15, 0.35, 0.9), smoothstep(0.0, 0.6, d.y));
  let c0 = max(dot(d, sun), 0.0);
  let glow = pow(c0, P.sharp) * P.glow + pow(c0, 4.0) * P.glow * 0.02;
  let c = mix(vec3(0.08, 0.07, 0.06), sky + glow, smoothstep(-0.02, 0.02, d.y));
  textureStore(dst, id.xy, id.z, vec4(c, 1.0));
}`

const DOWN = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var<uniform> size: u32;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= size || id.y >= size) { return; }
  let p = vec2<i32>(id.xy) * 2; let f = i32(id.z);
  let c = textureLoad(src, p, f, 0) + textureLoad(src, p + vec2(1, 0), f, 0)
        + textureLoad(src, p + vec2(0, 1), f, 0) + textureLoad(src, p + vec2(1, 1), f, 0);
  textureStore(dst, id.xy, id.z, c * 0.25);
}`

// Filtered importance sampling (sharp levels). roughness 0 = straight copy.
const FIS = /* wgsl */ `${COMMON}
struct L { outSize: u32, samples: u32, roughness: f32, lodBias: f32 }
@group(0) @binding(0) var src: texture_cube<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> P: L;
// three's cube textures are x-mirrored relative to world space, so its sample
// frame (and Hammersley pattern) is built in the mirrored frame. MIRROR = true
// reproduces three's exact sample set.
override MIRROR: bool = false;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= P.outSize || id.y >= P.outSize) { return; }
  let Nt = faceDir(id.z, vec2<f32>(id.xy), f32(P.outSize));
  let M = select(vec3(1.0), vec3(-1.0, 1.0, 1.0), MIRROR);
  let N = Nt * M;
  if (P.roughness <= 0.0) { textureStore(dst, id.xy, id.z, textureSampleLevel(src, samp, Nt, 0.0)); return; }
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

// FIS with the sample table in shared memory: every texel uses the same
// Hammersley set, so each sample's tangent-space direction and mip level
// depend only on its index. The workgroup builds the table once (64 threads,
// up to 1024 samples), then each thread only rotates and samples.
const FIS_TABLE = /* wgsl */ `${COMMON}
struct L { outSize: u32, samples: u32, roughness: f32, lodBias: f32 }
@group(0) @binding(0) var src: texture_cube<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> P: L;
override MIRROR: bool = false;
var<workgroup> tab: array<vec4<f32>, 1024>; // (x, y, z = NdotL, lod) in tangent space
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let alpha = P.roughness * P.roughness; let a2 = alpha * alpha;
  for (var i = li; i < P.samples; i += 64u) {
    let xi = hammersley(i, P.samples);
    let invQ = 1.0 / ((1.0 - xi.x) + a2 * xi.x);
    let NdotL = ((1.0 - xi.x) - a2 * xi.x) * invQ;
    let phi = xi.y * 6.283185307;
    let sinT = alpha * 2.0 * sqrt(xi.x * (1.0 - xi.x)) * invQ;
    tab[i] = vec4(cos(phi) * sinT, sin(phi) * sinT, NdotL, max(log2(a2 * invQ) + P.lodBias, 0.0));
  }
  workgroupBarrier();
  if (id.x >= P.outSize || id.y >= P.outSize) { return; }
  let M = select(vec3(1.0), vec3(-1.0, 1.0, 1.0), MIRROR);
  let N = faceDir(id.z, vec2<f32>(id.xy), f32(P.outSize)) * M;
  let up = select(vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), abs(N.z) < 0.999);
  let T = normalize(cross(up, N)); let B = cross(N, T);
  var col = vec3(0.0); var w = 0.0;
  for (var i = 0u; i < P.samples; i++) {
    let t = tab[i];
    if (t.z > 0.0) {
      let Ld = N * t.z + T * t.x + B * t.y;
      col += textureSampleLevel(src, samp, Ld * M, t.w).rgb * t.z; w += t.z;
    }
  }
  textureStore(dst, id.xy, id.z, vec4(col / w, 1.0));
}`

// Exhaustive GGX integration (rough levels), one 64-thread workgroup per
// output texel: threads stride over the source texels, then reduce in
// shared memory. Keeps every GPU core busy even for an 8² output level.
const INTEG = /* wgsl */ `${COMMON}
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

// Exhaustive GGX integration, tiled: 8×8 output texels per workgroup; each
// step the 64 threads cooperatively load 64 source texels (direction, solid
// angle, radiance) into shared memory, then every thread accumulates all 64.
// Better than one-workgroup-per-texel once a level has thousands of texels.
const INTEG_TILED = /* wgsl */ `${COMMON}
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

// Q6 proxy: a grid of mirror-metal spheres lit only by a prefiltered cube,
// sampled with r187's mapping (mip = maxLod·r·(2−r), r ≥ 0.045), tonemapped
// x/(1+x) and sRGB-encoded into an 8-bit image. 11 roughness columns
// (0 … 1), 4 rows looking along world yaw 0/90/180/270°.
const SPHERES = /* wgsl */ `
struct S { cell: u32, maxLod: f32, exposure: f32, pad: f32 }
@group(0) @binding(0) var env: texture_cube<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> P: S;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let col = id.x / P.cell; let row = id.y / P.cell;
  if (col >= 11u || row >= 4u) { return; }
  let local = (vec2<f32>(id.xy % vec2(P.cell)) + 0.5) / f32(P.cell) * 2.0 - 1.0;
  let rr = dot(local, local);
  if (rr >= 1.0) { textureStore(dst, id.xy, vec4(0.0, 0.0, 0.0, 1.0)); return; }
  let n = vec3(local.x, -local.y, sqrt(1.0 - rr));
  let R = 2.0 * n.z * n - vec3(0.0, 0.0, 1.0); // reflect view (0,0,1) about n
  let yaw = f32(row) * 1.5707963;
  let Rw = vec3(R.x * cos(yaw) + R.z * sin(yaw), R.y, -R.x * sin(yaw) + R.z * cos(yaw));
  let r = max(f32(col) / 10.0, 0.045);
  let mip = P.maxLod * r * (2.0 - r);
  let c = textureSampleLevel(env, samp, Rw, mip).rgb * P.exposure;
  let t = c / (1.0 + c);
  textureStore(dst, id.xy, vec4(pow(t, vec3(1.0 / 2.2)), 1.0));
}`

// Brute-force reference: unbiased IS at mip 0 (narrow lobes) or exhaustive
// integration over a 64² mip (wide lobes). One face per dispatch.
const REF = /* wgsl */ `${COMMON}
struct R { outSize: u32, samples: u32, roughness: f32, mode: u32, face: u32, intMip: f32, intSize: u32, pad: u32 }
@group(0) @binding(0) var src: texture_cube<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> P: R;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= P.outSize || id.y >= P.outSize) { return; }
  let N = faceDir(P.face, vec2<f32>(id.xy), f32(P.outSize));
  let alpha = P.roughness * P.roughness; let a2 = alpha * alpha;
  var col = vec3(0.0); var w = 0.0;
  if (P.mode == 0u) {
    let up = select(vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), abs(N.z) < 0.999);
    let T = normalize(cross(up, N)); let B = cross(N, T);
    for (var i = 0u; i < P.samples; i++) {
      let xi = hammersley(i, P.samples);
      let invQ = 1.0 / ((1.0 - xi.x) + a2 * xi.x);
      let NdotL = ((1.0 - xi.x) - a2 * xi.x) * invQ;
      if (NdotL > 0.0) {
        let phi = xi.y * 6.283185307;
        let sinT = alpha * 2.0 * sqrt(xi.x * (1.0 - xi.x)) * invQ;
        let Ld = N * NdotL + (T * cos(phi) + B * sin(phi)) * sinT;
        col += textureSampleLevel(src, samp, Ld, 0.0).rgb * NdotL; w += NdotL;
      }
    }
  } else {
    let s = f32(P.intSize);
    for (var f = 0u; f < 6u; f++) { for (var y = 0u; y < P.intSize; y++) { for (var x = 0u; x < P.intSize; x++) {
      let uv = (vec2(f32(x), f32(y)) + 0.5) / s * 2.0 - 1.0;
      let dOmega = 1.0 / pow(1.0 + dot(uv, uv), 1.5);
      let Ld = faceDir(f, vec2(f32(x), f32(y)), s);
      let NdotL = dot(N, Ld);
      if (NdotL > 0.0) {
        let wt = ggxWeight(NdotL, a2) * dOmega;
        col += textureSampleLevel(src, samp, Ld, P.intMip).rgb * wt; w += wt;
      }
    }}}
  }
  textureStore(dst, id.xy, P.face, vec4(col / w, 1.0));
}`

// REF with a tile offset, so one face can be split over several submits.
const REF_TILE = /* wgsl */ `${COMMON}
struct R { outSize: u32, samples: u32, roughness: f32, mode: u32, face: u32, intMip: f32, intSize: u32, pad: u32,
           ox: u32, oy: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var src: texture_cube<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> P: R;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.xy + vec2(P.ox, P.oy);
  if (id.x >= P.outSize || id.y >= P.outSize) { return; }
  let N = faceDir(P.face, vec2<f32>(id), f32(P.outSize));
  let alpha = P.roughness * P.roughness; let a2 = alpha * alpha;
  var col = vec3(0.0); var w = 0.0;
  if (P.mode == 0u) {
    let up = select(vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), abs(N.z) < 0.999);
    let T = normalize(cross(up, N)); let B = cross(N, T);
    for (var i = 0u; i < P.samples; i++) {
      let xi = hammersley(i, P.samples);
      let invQ = 1.0 / ((1.0 - xi.x) + a2 * xi.x);
      let NdotL = ((1.0 - xi.x) - a2 * xi.x) * invQ;
      if (NdotL > 0.0) {
        let phi = xi.y * 6.283185307;
        let sinT = alpha * 2.0 * sqrt(xi.x * (1.0 - xi.x)) * invQ;
        let Ld = N * NdotL + (T * cos(phi) + B * sin(phi)) * sinT;
        col += textureSampleLevel(src, samp, Ld, 0.0).rgb * NdotL; w += NdotL;
      }
    }
  } else {
    let s = f32(P.intSize);
    for (var f = 0u; f < 6u; f++) { for (var y = 0u; y < P.intSize; y++) { for (var x = 0u; x < P.intSize; x++) {
      let uv = (vec2(f32(x), f32(y)) + 0.5) / s * 2.0 - 1.0;
      let dOmega = 1.0 / pow(1.0 + dot(uv, uv), 1.5);
      let Ld = faceDir(f, vec2(f32(x), f32(y)), s);
      let NdotL = dot(N, Ld);
      if (NdotL > 0.0) {
        let wt = ggxWeight(NdotL, a2) * dOmega;
        col += textureSampleLevel(src, samp, Ld, P.intMip).rgb * wt; w += wt;
      }
    }}}
  }
  textureStore(dst, id, P.face, vec4(col / w, 1.0));
}`

// HDR sphere grid, one roughness column per dispatch (see renderSpheres for the
// geometry). Rw is a world direction; three's CubeTextureNode samples a cube
// render target at (−x, y, z) on WebGPU, so the raw cube is read there too.
const SPHERES_HDR = /* wgsl */ `
struct S { cell: u32, col: u32, lod: f32, pad: f32 }
@group(0) @binding(0) var env: texture_cube<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var<uniform> P: S;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= P.cell || id.y >= 4u * P.cell) { return; }
  let px = vec2(P.col * P.cell + id.x, id.y);
  let row = id.y / P.cell;
  let local = (vec2<f32>(f32(id.x), f32(id.y % P.cell)) + 0.5) / f32(P.cell) * 2.0 - 1.0;
  let rr = dot(local, local);
  if (rr >= 1.0) { textureStore(dst, px, vec4(0.0)); return; }
  let n = vec3(local.x, -local.y, sqrt(1.0 - rr));
  let R = 2.0 * n.z * n - vec3(0.0, 0.0, 1.0);
  let yaw = f32(row) * 1.5707963;
  let Rw = vec3(R.x * cos(yaw) + R.z * sin(yaw), R.y, -R.x * sin(yaw) + R.z * cos(yaw));
  let c = textureSampleLevel(env, samp, vec3(-Rw.x, Rw.y, Rw.z), P.lod).rgb;
  textureStore(dst, px, vec4(c, 1.0));
}`

// CubeUV atlas writer (three r185/r186, CubeUVReflectionMapping). One dispatch
// per atlas level, over its 3s × 2s tile at (x0, y0). Replicates what three's
// PMREMGenerator rasterizes into each texel (WebGPU: viewport y and texel row 0
// are the top):
//   - _createPlanes: face slot k (column k % 3; k > 2 → NDC y ∈ [0, 1], the top
//     half of the viewport) holds cube face _faceLib[k] = [3, 1, 5, 0, 4, 2][k];
//     uv runs from −1/(s−2) to 1 + 1/(s−2) across the s texels, v up in NDC.
//   - getDirection(uv, face) (PMREMUtils) gives the direction G (world space).
//   - the source cube is read through CubeTextureNode, which on WebGPU samples
//     at (−G.x, G.y, G.z). Our levels live in the same raw cube frame.
// Texel (p, q) inside a slot: uv = ((p − 0.5) / (s − 2), (s − 1.5 − q) / (s − 2)),
// so the inner (s−2)² texels are exactly the texel centres of an (s−2)² face and
// the 1-texel border is the direction just past the face edge.
const PACK_CUBEUV = /* wgsl */ `
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

// ---------------------------------------------------------------------------
// CubeUV atlas (three r185 / r186)
// ---------------------------------------------------------------------------

export const CUBEUV_LOD_MIN = 4
export const CUBEUV_EXTRA_LODS = 6

/**
 * Inverse of PMREMUtils' `roughnessToMip`: the roughness at which three's
 * sampler reads atlas mip `m` alone (m = lodMax − level; −2 … lodMax).
 * The r < 0.21 log branch and the linear branches meet with a small jump at
 * 0.21 (log branch: mip 4.07); mip 4 is only reached exactly at r = 0.21.
 */
export function cubeUVRoughness(m) {
  if (m >= 4.07) return Math.pow(2, -m / 2) / 1.16 // log branch, r < 0.21
  if (m >= 3) return 0.305 - (m - 3) * 0.095 // [0.21, 0.305)
  if (m >= 2) return 0.4 - (m - 2) * 0.095 // [0.305, 0.4)
  if (m >= -1) return 0.8 - ((m + 1) * 0.4) / 3 // [0.4, 0.8)
  return 1 - (m + 2) * 0.2 // [0.8, 1]
}

/** three's CubeUV layout for a cube of `cubeSize` (PMREMGenerator._createPlanes / _applyGGXFilter viewports). */
export function cubeUVLayout(cubeSize) {
  const lodMax = Math.floor(Math.log2(cubeSize))
  const cs = Math.pow(2, lodMax)
  const n = lodMax - CUBEUV_LOD_MIN + 1 + CUBEUV_EXTRA_LODS
  const levels = []
  for (let i = 0; i < n; i++) {
    const size = Math.pow(2, Math.max(lodMax - i, CUBEUV_LOD_MIN))
    const x = 3 * size * (i > lodMax - CUBEUV_LOD_MIN ? i - lodMax + CUBEUV_LOD_MIN : 0)
    const y = 4 * (cs - size)
    const mip = lodMax - i
    levels.push({ level: i, size, x, y, mip, roughness: i === 0 ? 0 : cubeUVRoughness(mip) })
  }
  return { lodMax, cubeSize: cs, width: 3 * Math.max(cs, 16 * 7), height: 4 * cs, levels }
}

/**
 * `prefilterLevels` input for the CubeUV atlas: one level per tile at the
 * tile's roughness, prefiltered on the tile's inner (s−2)² grid (so packing
 * the interior is an exact texel-centre read). Level 0 reads the source.
 * Default plan: FIS `fis` samples (mirror frame) up to `fisMax` roughness,
 * exhaustive integration over the `integ`² source mip above.
 * `plan(level, roughness)` can override any level's step.
 */
export function cubeUVLevels(cubeSize, { fis = 256, fisMax = 0.25, integ = 16, pad = true, plan = null } = {}) {
  return cubeUVLayout(cubeSize).levels.map(({ level, size, roughness }) => {
    const s = pad ? size - 2 : size
    const step = roughness <= fisMax ? { fis, mirror: true } : { integ }
    return { size: s, roughness, ...step, ...(plan?.(level, roughness) ?? {}) }
  })
}

// ---------------------------------------------------------------------------
// Lab
// ---------------------------------------------------------------------------

export class Lab {
  constructor(device) {
    this.device = device
    const pipe = (code, constants) =>
      device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main', constants },
      })
    this.pipes = {
      sky: pipe(SKY),
      down: pipe(DOWN),
      fis: pipe(FIS),
      fisMirror: pipe(FIS, { MIRROR: 1 }),
      fisTable: pipe(FIS_TABLE),
      fisTableMirror: pipe(FIS_TABLE, { MIRROR: 1 }),
      integ: pipe(INTEG),
      tiled: pipe(INTEG_TILED),
      ref: pipe(REF),
      refTile: pipe(REF_TILE),
      spheres: pipe(SPHERES),
      spheresHDR: pipe(SPHERES_HDR),
      pack: pipe(PACK_CUBEUV),
    }
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })
  }

  ubuf(bytes) {
    const b = this.device.createBuffer({
      size: Math.max(16, bytes.byteLength),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(b, 0, bytes)
    return b
  }

  view2d(t, mip) {
    return t.createView({ dimension: '2d-array', baseMipLevel: mip, mipLevelCount: 1 })
  }

  bg(pipe, entries) {
    return this.device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: entries.map((resource, binding) => ({ binding, resource })),
    })
  }

  /** Source cube with a full mip chain; mip 0 from the synthetic sky shader. */
  makeSource(size, opts = {}) {
    const tex = this.device.createTexture({
      size: [size, size, 6],
      format: FMT,
      mipLevelCount: Math.log2(size) + 1,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    this.fillSky(tex, size, opts)
    return tex
  }

  /** (Re)write mip 0 of `tex` with the synthetic sky. `sharp` is the glow lobe exponent. */
  fillSky(tex, size, { variant = 0, sun = [0.3, 0.9, 0.3], glow = 20, sharp = 64 } = {}) {
    const d = this.device
    const u = new ArrayBuffer(32)
    new Uint32Array(u, 0, 2).set([size, variant])
    new Float32Array(u, 8, 6).set([glow, sharp, ...sun, 0])
    const buf = this.ubuf(new Uint8Array(u))
    const e = d.createCommandEncoder()
    const p = e.beginComputePass()
    p.setPipeline(this.pipes.sky)
    p.setBindGroup(0, this.bg(this.pipes.sky, [this.view2d(tex, 0), { buffer: buf }]))
    p.dispatchWorkgroups(size / 8, size / 8, 6)
    p.end()
    d.queue.submit([e.finish()])
    buf.destroy()
  }

  /** Source cube from raw rgba16f face data (six faces, row-major), e.g. a capture. */
  makeSourceFromData(size, u16) {
    const d = this.device
    const tex = d.createTexture({
      size: [size, size, 6],
      format: FMT,
      mipLevelCount: Math.log2(size) + 1,
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC,
    })
    d.queue.writeTexture({ texture: tex }, u16, { bytesPerRow: size * 8, rowsPerImage: size }, [size, size, 6])
    return tex
  }

  /** Build the source's mip chain now (what every prefilter's first steps do). */
  generateMips(src, srcSize) {
    const e = this.device.createCommandEncoder()
    const p = e.beginComputePass()
    for (const st of this._mipSteps(src, srcSize)) {
      p.setPipeline(st.pipe)
      p.setBindGroup(0, st.bg)
      p.dispatchWorkgroups(...st.wg)
    }
    p.end()
    this.device.queue.submit([e.finish()])
  }

  /** Box-filter steps that build the source's mip chain (mip 1 … log2(srcSize)). */
  _mipSteps(src, srcSize) {
    const steps = []
    for (let m = 1; m <= Math.log2(srcSize); m++) {
      const s = srcSize >> m
      steps.push({
        pipe: this.pipes.down,
        bg: this.bg(this.pipes.down, [
          this.view2d(src, m - 1),
          this.view2d(src, m),
          { buffer: this.ubuf(new Uint32Array([s])) },
        ]),
        wg: [Math.ceil(s / 8), Math.ceil(s / 8), 6],
      })
    }
    return steps
  }

  /**
   * One prefiltered level of size `s` at roughness `r` into the 2d-array view `dst`.
   * `step`: `{ integ: sourceMipSize, tiled? }` or `{ fis: samples, mirror?, table?, bias? }`;
   * r = 0 is a straight (bilinear) copy of source mip 0.
   */
  _levelStep(src, cube, srcSize, dst, s, r, step) {
    if (step.integ) {
      const u = new ArrayBuffer(16)
      new Uint32Array(u, 0, 2).set([s, step.integ])
      new Float32Array(u, 8, 1).set([r])
      const mip = Math.log2(srcSize / step.integ)
      // Tiled kernel for levels with many texels, reduction kernel for tiny ones.
      const tiled = step.tiled ?? s >= 32
      const pipe = tiled ? this.pipes.tiled : this.pipes.integ
      return {
        pipe,
        bg: this.bg(pipe, [this.view2d(src, mip), dst, { buffer: this.ubuf(new Uint8Array(u)) }]),
        wg: tiled ? [Math.ceil(s / 8), Math.ceil(s / 8), 6] : [s * s, 6, 1],
      }
    }
    const n = r > 0 ? (step.fis ?? 64) : 1
    // three dev's filtered-importance-sampling bias, plus an optional per-level offset
    const lodBias = r > 0 ? Math.log2(srcSize) + 0.5 * Math.log2(6 / (n * Math.pow(r, 4))) + 0.5 + (step.bias ?? 0) : 0
    const u = new ArrayBuffer(16)
    new Uint32Array(u, 0, 2).set([s, n])
    new Float32Array(u, 8, 2).set([r, lodBias])
    const fp =
      step.table && r > 0
        ? step.mirror
          ? this.pipes.fisTableMirror
          : this.pipes.fisTable
        : step.mirror
          ? this.pipes.fisMirror
          : this.pipes.fis
    return {
      pipe: fp,
      bg: this.bg(fp, [cube, this.sampler, dst, { buffer: this.ubuf(new Uint8Array(u)) }]),
      wg: [Math.ceil(s / 8), Math.ceil(s / 8), 6],
    }
  }

  /**
   * Prefilter arbitrary (size, roughness) levels, each into its own single-mip
   * cube texture. `levels[i]` is `{ size, roughness, fis?, mirror?, integ?, tiled?, bias? }`
   * (`integ` = source mip size to integrate over exhaustively, else FIS with
   * `fis` samples). A roughness-0 level without `copy: true` is not computed:
   * it points at source mip 0 (`tex = src`), which a consumer samples directly.
   * Returns `{ levels: [{ tex, size, roughness, view }], encode(encoder), mipSteps, stepCount }`;
   * `encode` records the source mip chain + every level into one compute pass.
   */
  prefilterLevels(src, srcSize, levels) {
    const d = this.device
    const cube = src.createView({ dimension: 'cube' })
    const steps = this._mipSteps(src, srcSize)
    const out = levels.map((lv) => {
      if (lv.roughness <= 0 && !lv.copy) {
        return {
          tex: src,
          size: srcSize,
          roughness: 0,
          view: src.createView({ dimension: 'cube', baseMipLevel: 0, mipLevelCount: 1 }),
        }
      }
      const tex = d.createTexture({
        size: [lv.size, lv.size, 6],
        format: FMT,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      })
      steps.push(this._levelStep(src, cube, srcSize, this.view2d(tex, 0), lv.size, lv.roughness, lv))
      return { tex, size: lv.size, roughness: lv.roughness, view: tex.createView({ dimension: 'cube' }) }
    })
    const encode = (encoder) => {
      const p = encoder.beginComputePass()
      for (const st of steps) {
        p.setPipeline(st.pipe)
        p.setBindGroup(0, st.bg)
        p.dispatchWorkgroups(...st.wg)
      }
      p.end()
    }
    const destroy = () => out.forEach((l) => l.tex !== src && l.tex.destroy())
    return { levels: out, encode, destroy, stepCount: steps.length, mipSteps: Math.log2(srcSize) }
  }

  /**
   * Pack prefiltered levels into three r185/r186's CubeUV atlas
   * (`CubeUVReflectionMapping`). `levels` comes from `prefilterLevels` with one
   * entry per atlas level (see `cubeUVLevels`). Every tile texel gets the
   * direction three's `_createPlanes` + `getDirection` give it (1-texel border
   * included) and samples its level there. Returns `{ atlas, width, height, encode }`;
   * pass `atlas` to write into an existing rgba16float texture of that size.
   */
  packCubeUV(levels, cubeSize, atlas = null) {
    const d = this.device
    const L = cubeUVLayout(cubeSize)
    if (levels.length !== L.levels.length) throw new Error(`packCubeUV: need ${L.levels.length} levels`)
    atlas ??= d.createTexture({
      size: [L.width, L.height],
      format: FMT,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    })
    const view = atlas.createView()
    const steps = L.levels.map((t, i) => ({
      bg: this.bg(this.pipes.pack, [
        levels[i].view,
        this.sampler,
        view,
        { buffer: this.ubuf(new Uint32Array([t.x, t.y, t.size, 0])) },
      ]),
      wg: [Math.ceil((3 * t.size) / 8), Math.ceil((2 * t.size) / 8), 1],
    }))
    const encode = (encoder) => {
      const p = encoder.beginComputePass()
      p.setPipeline(this.pipes.pack)
      for (const st of steps) {
        p.setBindGroup(0, st.bg)
        p.dispatchWorkgroups(...st.wg)
      }
      p.end()
    }
    return { atlas, width: L.width, height: L.height, layout: L, encode }
  }

  /**
   * Brute-force reference cube (one mip) at an arbitrary size and roughness,
   * Lab.reference-style: unbiased IS (`samples`) at source mip 0, or exhaustive
   * integration over the `intSize`² source mip. `mode` 'is' | 'integ'; default
   * IS below roughness 0.4, integration above.
   * Needs the source mip chain (`generateMips`, or run any prefilter on `src` first).
   * Splits each face into `split`² dispatches to stay under GPU watchdogs.
   */
  async referenceLevel(src, srcSize, size, roughness, { samples = 16384, split = 1, mode = null, intSize = 64 } = {}) {
    const integ = mode ? mode === 'integ' : roughness >= 0.4
    const d = this.device
    const out = d.createTexture({
      size: [size, size, 6],
      format: FMT,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    })
    const cube = src.createView({ dimension: 'cube' })
    for (let face = 0; face < 6; face++) {
      for (let sy = 0; sy < split; sy++)
        for (let sx = 0; sx < split; sx++) {
          const u = new ArrayBuffer(48)
          new Uint32Array(u, 0, 2).set([size, samples])
          new Float32Array(u, 8, 1).set([roughness])
          new Uint32Array(u, 12, 2).set([integ ? 1 : 0, face])
          new Float32Array(u, 20, 1).set([Math.log2(srcSize / intSize)])
          new Uint32Array(u, 24, 1).set([intSize])
          const tile = Math.ceil(size / split)
          new Uint32Array(u, 32, 2).set([sx * tile, sy * tile])
          const e = d.createCommandEncoder()
          const p = e.beginComputePass()
          p.setPipeline(this.pipes.refTile)
          p.setBindGroup(
            0,
            this.bg(this.pipes.refTile, [
              cube,
              this.sampler,
              this.view2d(out, 0),
              { buffer: this.ubuf(new Uint8Array(u)) },
            ]),
          )
          p.dispatchWorkgroups(Math.ceil(tile / 8), Math.ceil(tile / 8), 1)
          p.end()
          d.queue.submit([e.finish()])
          await d.queue.onSubmittedWorkDone()
        }
    }
    return out
  }

  /**
   * HDR sphere grid (same geometry as `renderSpheres`) for the columns in
   * `cols`, sampling `tex` (a cube) at mip `lod`, into `img` (rgba32float
   * storage texture of 11·cell × 4·cell). Directions are world space; the
   * cube is sampled at (−x, y, z) like three's CubeTextureNode on WebGPU.
   */
  encodeSpheresHDR(encoder, img, cubeView, cell, cols, lod = 0) {
    const p = encoder.beginComputePass()
    p.setPipeline(this.pipes.spheresHDR)
    for (const c of cols) {
      const u = new ArrayBuffer(16)
      new Uint32Array(u, 0, 2).set([cell, c])
      new Float32Array(u, 8, 1).set([lod])
      p.setBindGroup(
        0,
        this.bg(this.pipes.spheresHDR, [
          cubeView,
          this.sampler,
          img.createView(),
          { buffer: this.ubuf(new Uint8Array(u)) },
        ]),
      )
      p.dispatchWorkgroups(Math.ceil(cell / 8), Math.ceil((cell * 4) / 8), 1)
    }
    p.end()
  }

  /** Read a 2D texture (rgba16float or rgba32float) back as Float32Array RGBA. */
  async readTexture2D(tex, w, h, format = FMT) {
    const d = this.device
    const bpp = format === 'rgba32float' ? 16 : 8
    const bpr = Math.ceil((w * bpp) / 256) * 256
    const buf = d.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const e = d.createCommandEncoder()
    e.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h])
    d.queue.submit([e.finish()])
    await buf.mapAsync(GPUMapMode.READ)
    const raw = buf.getMappedRange().slice(0)
    buf.unmap()
    buf.destroy()
    const out = new Float32Array(w * h * 4)
    if (bpp === 16) {
      const f = new Float32Array(raw)
      for (let y = 0; y < h; y++) out.set(f.subarray((y * bpr) / 4, (y * bpr) / 4 + w * 4), y * w * 4)
    } else {
      const u16 = new Uint16Array(raw)
      for (let y = 0; y < h; y++) for (let i = 0; i < w * 4; i++) out[y * w * 4 + i] = half(u16[(y * bpr) / 2 + i])
    }
    return out
  }

  /**
   * A prefilter with every GPU object built once. `plan[lod]` is `{}` (copy,
   * level 0), `{ fis: samples }` or `{ integ: sourceMipSize }`. `encode()`
   * records the source mip chain + all levels into one compute pass.
   */
  prefilter(src, srcSize, outSize, plan) {
    const d = this.device
    const maxLod = Math.log2(outSize) - 3
    const out = d.createTexture({
      size: [outSize, outSize, 6],
      format: FMT,
      mipLevelCount: maxLod + 1,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    })
    const cube = src.createView({ dimension: 'cube' })
    const steps = this._mipSteps(src, srcSize)
    for (let lod = 0; lod <= maxLod; lod++) {
      const s = outSize >> lod
      const r = lod === 0 ? 0 : roughnessOf(lod, maxLod)
      steps.push(this._levelStep(src, cube, srcSize, this.view2d(out, lod), s, r, plan[lod] ?? {}))
    }
    const encode = (encoder, only = null) => {
      const p = encoder.beginComputePass()
      for (const st of only ? steps.filter((_, i) => only.includes(i)) : steps) {
        p.setPipeline(st.pipe)
        p.setBindGroup(0, st.bg)
        p.dispatchWorkgroups(...st.wg)
      }
      p.end()
    }
    // steps: source mips first (log2(srcSize) of them), then one per level
    return { out, maxLod, encode, stepCount: steps.length, mipSteps: Math.log2(srcSize) }
  }

  run(pf) {
    const e = this.device.createCommandEncoder()
    pf.encode(e)
    this.device.queue.submit([e.finish()])
  }

  /**
   * Burst wall-clock: N submits, one completion wait, repeated `bursts` times.
   * Reports the minimum (least disturbed by other GPU work on the machine)
   * and the median.
   */
  async time(pf, n = 40, bursts = 7) {
    for (let i = 0; i < 5; i++) this.run(pf)
    await this.device.queue.onSubmittedWorkDone()
    const ms = []
    let cpu = Infinity
    for (let b = 0; b < bursts; b++) {
      const t0 = performance.now()
      for (let i = 0; i < n; i++) this.run(pf)
      cpu = Math.min(cpu, (performance.now() - t0) / n)
      await this.device.queue.onSubmittedWorkDone()
      ms.push((performance.now() - t0) / n)
    }
    ms.sort((a, b) => a - b)
    return { ms: ms[0], medianMs: ms[Math.floor(bursts / 2)], cpuMs: cpu }
  }

  /** Brute-force reference for levels 1..maxLod (one face per submit, to stay under GPU watchdogs). */
  async reference(src, srcSize, outSize) {
    const d = this.device
    const maxLod = Math.log2(outSize) - 3
    const out = d.createTexture({
      size: [outSize, outSize, 6],
      format: FMT,
      mipLevelCount: maxLod + 1,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    })
    const cube = src.createView({ dimension: 'cube' })
    // level 0: straight copy, same as the prefilter
    {
      const u = new ArrayBuffer(16)
      new Uint32Array(u, 0, 2).set([outSize, 1])
      const e = d.createCommandEncoder()
      const p = e.beginComputePass()
      p.setPipeline(this.pipes.fis)
      p.setBindGroup(
        0,
        this.bg(this.pipes.fis, [cube, this.sampler, this.view2d(out, 0), { buffer: this.ubuf(new Uint8Array(u)) }]),
      )
      p.dispatchWorkgroups(outSize / 8, outSize / 8, 6)
      p.end()
      d.queue.submit([e.finish()])
    }
    for (let lod = 1; lod <= maxLod; lod++) {
      const s = outSize >> lod
      const r = roughnessOf(lod, maxLod)
      for (let face = 0; face < 6; face++) {
        const u = new ArrayBuffer(32)
        new Uint32Array(u, 0, 2).set([s, 16384])
        new Float32Array(u, 8, 1).set([r])
        new Uint32Array(u, 12, 2).set([r < 0.4 ? 0 : 1, face])
        new Float32Array(u, 20, 1).set([Math.log2(srcSize / 64)])
        new Uint32Array(u, 24, 1).set([64])
        const e = d.createCommandEncoder()
        const p = e.beginComputePass()
        p.setPipeline(this.pipes.ref)
        p.setBindGroup(
          0,
          this.bg(this.pipes.ref, [
            cube,
            this.sampler,
            this.view2d(out, lod),
            { buffer: this.ubuf(new Uint8Array(u)) },
          ]),
        )
        p.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), 1)
        p.end()
        d.queue.submit([e.finish()])
        await d.queue.onSubmittedWorkDone()
      }
    }
    return out
  }

  /** Render the sphere grid lit by `tex` (a prefiltered cube); returns RGBA8 bytes and size. */
  async renderSpheres(tex, maxLod, exposure, cell = 48) {
    const d = this.device
    const w = cell * 11
    const h = cell * 4
    const img = d.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    })
    const u = new ArrayBuffer(16)
    new Uint32Array(u, 0, 1).set([cell])
    new Float32Array(u, 4, 2).set([maxLod, exposure])
    const e = d.createCommandEncoder()
    const p = e.beginComputePass()
    p.setPipeline(this.pipes.spheres)
    p.setBindGroup(
      0,
      this.bg(this.pipes.spheres, [
        tex.createView({ dimension: 'cube' }),
        this.sampler,
        img.createView(),
        { buffer: this.ubuf(new Uint8Array(u)) },
      ]),
    )
    p.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8), 1)
    p.end()
    const bpr = Math.ceil((w * 4) / 256) * 256
    const buf = d.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    e.copyTextureToBuffer({ texture: img }, { buffer: buf, bytesPerRow: bpr }, [w, h])
    d.queue.submit([e.finish()])
    await buf.mapAsync(GPUMapMode.READ)
    const raw = new Uint8Array(buf.getMappedRange().slice(0))
    buf.unmap()
    buf.destroy()
    img.destroy()
    const out = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) out.set(raw.subarray(y * bpr, y * bpr + w * 4), y * w * 4)
    return { data: out, w, h, cell }
  }

  /** Luminance of every texel of one mip level, all six faces. */
  async readLevel(tex, lod, outSize) {
    const d = this.device
    const s = outSize >> lod
    const bpr = Math.ceil((s * 8) / 256) * 256
    const buf = d.createBuffer({ size: bpr * s * 6, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const e = d.createCommandEncoder()
    e.copyTextureToBuffer({ texture: tex, mipLevel: lod }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: s }, [
      s,
      s,
      6,
    ])
    d.queue.submit([e.finish()])
    await buf.mapAsync(GPUMapMode.READ)
    const u16 = new Uint16Array(buf.getMappedRange().slice(0))
    buf.unmap()
    buf.destroy()
    const lum = new Float32Array(s * s * 6)
    let k = 0
    for (let f = 0; f < 6; f++)
      for (let y = 0; y < s; y++)
        for (let x = 0; x < s; x++) {
          const o = (f * s * bpr + y * bpr) / 2 + x * 4
          lum[k++] = 0.2126 * half(u16[o]) + 0.7152 * half(u16[o + 1]) + 0.0722 * half(u16[o + 2])
        }
    return lum
  }
}

export const roughnessOf = (lod, maxLod) => (maxLod > 0 ? 1 - Math.sqrt(1 - lod / maxLod) : 0)

export function half(h) {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return s * Math.pow(2, -14) * (m / 1024)
  if (e === 31) return m ? NaN : s * Infinity
  return s * Math.pow(2, e - 15) * (1 + m / 1024)
}

/**
 * Luminance error, percent: mean, p99, and max(ours) / max(ref).
 *
 * Each texel's error is relative to its reference value, floored at
 * `floorFrac` × the level's mean reference luminance — so texels far darker
 * than their surroundings (ground beside a twilight horizon, a night sky)
 * don't dominate with relative errors nobody can see. SKY_PMREM_SPEC.md §5.
 */
export function errStats(a, ref, floorFrac = 0.05) {
  let meanRef = 0
  for (let i = 0; i < ref.length; i++) meanRef += ref[i]
  meanRef /= ref.length
  const floor = Math.max(meanRef * floorFrac, 1e-12)
  const rel = new Float32Array(a.length)
  let sum = 0
  let aMax = 0
  let rMax = 0
  for (let i = 0; i < a.length; i++) {
    rel[i] = Math.abs(a[i] - ref[i]) / Math.max(ref[i], floor)
    sum += rel[i]
    aMax = Math.max(aMax, a[i])
    rMax = Math.max(rMax, ref[i])
  }
  rel.sort()
  return {
    mean: +((100 * sum) / a.length).toFixed(2),
    p99: +(100 * rel[Math.floor(rel.length * 0.99)]).toFixed(2),
    maxRatio: +(aMax / rMax).toFixed(3),
  }
}

/**
 * 8-bit difference between two sphere renders, over sphere pixels only:
 * mean, p99 and max of the per-pixel max channel difference, overall and per
 * roughness column.
 */
export function imageDiff(a, b) {
  const all = []
  const perCol = Array.from({ length: 11 }, () => [])
  for (let y = 0; y < a.h; y++)
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 4
      if (a.data[i] === 0 && a.data[i + 1] === 0 && a.data[i + 2] === 0 && b.data[i] === 0) continue
      const dd = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]),
      )
      all.push(dd)
      perCol[Math.floor(x / a.cell)].push(dd)
    }
  const stats = (v) => {
    if (!v.length) return { mean: 0, p99: 0, max: 0 }
    const s = [...v].sort((p, q) => p - q)
    return {
      mean: +(s.reduce((m, q) => m + q, 0) / s.length).toFixed(2),
      p99: s[Math.floor(s.length * 0.99)],
      max: s[s.length - 1],
    }
  }
  return { ...stats(all), perCol: perCol.map(stats) }
}
