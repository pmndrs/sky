/**
 * Engine-agnostic WGSL core — Hillaire atmosphere math as source strings.
 *
 * ZERO three.js imports. These chunks are the source of truth for the WebGPU
 * path. Two consumers assemble them:
 *   - `backends/wgsl/atmosphere.ts` feeds individual chunks straight into
 *     three's `wgslFn(code, includes)` so the LUT graphs call this exact source
 *     on the WebGPU backend. (No duplication — the wrappers import these
 *     strings.)
 *   - (eventual) a native baker concatenates the chunks it needs into a raw
 *     `GPUShaderModule`.
 *
 * The TSL twin (`backends/tsl/atmosphere.tsl.ts`) is the WebGL fallback and is
 * hand-synced against this file. See WGSL_CORE_PLAN.md.
 *
 * DESIGN RULE: every chunk that is meant to be wrapped by `wgslFn` on its own
 * must be **self-contained** — it may only depend on functions passed to it via
 * `includes`, never on a shared module-scope `const`. That's why `PI` is
 * inlined as a literal rather than referenced from a shared constant: a
 * `wgslFn(RAYLEIGH_PHASE)` in isolation has no PRELUDE in scope. Structs and
 * shared leaf helpers (the sub-UV pair) are the only cross-chunk dependencies,
 * and those travel through `includes`.
 *
 * Ported from Hillaire's HLSL:
 *   SkyAtmosphereCommon.hlsl, RenderSkyCommon.hlsl, RenderSkyRayMarching.hlsl
 * Units: kilometers, 1/km — identical to the reference and the TSL twin.
 */

/**
 * Shared struct + constant declarations for the STRUCT-based (native-blob)
 * assembly. The `wgslFn` path does NOT rely on this — it passes flat args and
 * carries structs on the individual entry points that need them.
 */
export const PRELUDE = /* wgsl */ `
struct AtmosphereParams {
  bottomRadius: f32,
  topRadius: f32,
  rayleighDensityExpScale: f32,
  mieDensityExpScale: f32,
  miePhaseG: f32,
  absorptionDensity0LayerWidth: f32,
  absorptionDensity0ConstantTerm: f32,
  absorptionDensity0LinearTerm: f32,
  absorptionDensity1ConstantTerm: f32,
  absorptionDensity1LinearTerm: f32,
  rayleighScattering: vec3<f32>,
  mieScattering: vec3<f32>,
  mieExtinction: vec3<f32>,
  mieAbsorption: vec3<f32>,
  absorptionExtinction: vec3<f32>,
  groundAlbedo: vec3<f32>,
};

// Matches Hillaire's PLANET_RADIUS_OFFSET — tiny back-off used when clipping
// rays to a shell to avoid self-intersection.
const PLANET_RADIUS_OFFSET: f32 = 0.01;
`

// ---------------------------------------------------------------------------
// Sub-UV correction (RenderSkyCommon.hlsl:101-102). Kept as two single-function
// chunks so each can be an independent `wgslFn` include.
// ---------------------------------------------------------------------------

export const FROM_UNIT_TO_SUB_UVS = /* wgsl */ `
fn fromUnitToSubUvs(u: f32, resolution: f32) -> f32 {
  return (u + 0.5 / resolution) * (resolution / (resolution + 1.0));
}
`

export const FROM_SUB_UVS_TO_UNIT = /* wgsl */ `
fn fromSubUvsToUnit(u: f32, resolution: f32) -> f32 {
  return (u - 0.5 / resolution) * (resolution / (resolution - 1.0));
}
`

/** Both sub-UV helpers — for native-blob assembly. */
export const UV_HELPERS = FROM_UNIT_TO_SUB_UVS + FROM_SUB_UVS_TO_UNIT

// ---------------------------------------------------------------------------
// Phase functions. PI inlined (self-contained for standalone wgslFn).
// ---------------------------------------------------------------------------

/**
 * Manual bilinear sample of a 2D texture (vec3 return). three's `wgslFn` binds a
 * texture handle but NO sampler, so LUT sampling inside a WGSL integrator must
 * filter by hand via `textureLoad`. Matches hardware bilinear to ~7e-4 (see
 * examples/parity/11-texture-sample.html). `uv` is the raw [0,1] coordinate;
 * resolution is read from the texture, so callers apply any sub-UV correction to
 * `uv` themselves before calling (matching how the TSL twin corrects then
 * hardware-samples). The native path (Phase 5) will use a real sampler instead.
 */
export const BILINEAR_SAMPLE_2D = /* wgsl */ `
fn bilinearSample2D(map: texture_2d<f32>, uvc: vec2<f32>) -> vec3<f32> {
  let dims = vec2<i32>(textureDimensions(map, 0));
  let p = uvc * vec2<f32>(dims) - 0.5;
  let fl = floor(p);
  let f = p - fl;
  let maxc = dims - vec2<i32>(1, 1);
  let i0 = clamp(vec2<i32>(fl), vec2<i32>(0, 0), maxc);
  let i1 = clamp(vec2<i32>(fl) + vec2<i32>(1, 1), vec2<i32>(0, 0), maxc);
  let c00 = textureLoad(map, vec2<i32>(i0.x, i0.y), 0).rgb;
  let c10 = textureLoad(map, vec2<i32>(i1.x, i0.y), 0).rgb;
  let c01 = textureLoad(map, vec2<i32>(i0.x, i1.y), 0).rgb;
  let c11 = textureLoad(map, vec2<i32>(i1.x, i1.y), 0).rgb;
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}
`

/** 3 / (16π) · (1 + cos²θ). Rayleigh phase. */
export const RAYLEIGH_PHASE = /* wgsl */ `
fn rayleighPhase(cosTheta: f32) -> f32 {
  let factor = 3.0 / (16.0 * 3.1415926535897932);
  return factor * (1.0 + cosTheta * cosTheta);
}
`

/**
 * Cornette-Shanks Mie phase. Note the `-cosTheta` in the denominator — part of
 * Hillaire's original formulation, intentional (RenderSkyCommon.hlsl).
 */
export const MIE_PHASE_CS = /* wgsl */ `
fn miePhaseCS(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let k = (3.0 / (8.0 * 3.1415926535897932)) * (1.0 - g2) / (2.0 + g2);
  let num = 1.0 + cosTheta * cosTheta;
  let denomBase = 1.0 + g2 - 2.0 * g * (-cosTheta);
  let denom = pow(denomBase, 1.5);
  return k * num / denom;
}
`

/** Henyey-Greenstein phase (the branch the integrator actually uses for Mie). */
export const HG_PHASE = /* wgsl */ `
fn hgPhase(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let numer = 1.0 - g2;
  let denom = 1.0 + g2 + 2.0 * g * cosTheta;
  return numer / (4.0 * 3.1415926535897932 * denom * sqrt(denom));
}
`

/**
 * Nearest positive ray-sphere intersection, or -1 on miss. Faithful port of
 * `raySphereIntersectNearest`. Real WGSL branching — no `select` chains.
 */
export const RAY_SPHERE = /* wgsl */ `
fn raySphereIntersectNearest(ro: vec3<f32>, rd: vec3<f32>, center: vec3<f32>, radius: f32) -> f32 {
  let a = dot(rd, rd);
  let s0r0 = ro - center;
  let b = 2.0 * dot(rd, s0r0);
  let c = dot(s0r0, s0r0) - radius * radius;
  let delta = b * b - 4.0 * a * c;
  if (delta < 0.0) { return -1.0; }
  let sqrtDelta = sqrt(max(delta, 0.0));
  let denomInv = 1.0 / max(2.0 * a, 1e-20);
  let sol0 = (-b - sqrtDelta) * denomInv;
  let sol1 = (-b + sqrtDelta) * denomInv;
  if (sol0 < 0.0 && sol1 < 0.0) { return -1.0; }
  if (sol0 < 0.0) { return max(0.0, sol1); }
  if (sol1 < 0.0) { return max(0.0, sol0); }
  return max(0.0, min(sol0, sol1));
}
`

/**
 * Stratified spherical sample direction used by the Multi-Scatter LUT builder.
 * Port of the sample-direction math in RenderSkyRayMarching.hlsl:449-464.
 * Self-contained. Args `{ iPlusHalf, jPlusHalf, sqrtSampleCount }` → `vec3`.
 */
export const SPHERICAL_DIR = /* wgsl */ `
fn getSphericalDir(iPlusHalf: f32, jPlusHalf: f32, sqrtSampleCount: f32) -> vec3<f32> {
  let randA = iPlusHalf / sqrtSampleCount;
  let randB = jPlusHalf / sqrtSampleCount;
  let theta = 2.0 * 3.1415926535897932 * randA;
  let phi = acos(1.0 - 2.0 * randB);
  let cosPhi = cos(phi);
  let sinPhi = sin(phi);
  let cosTheta = cos(theta);
  let sinTheta = sin(theta);
  return vec3<f32>(cosTheta * sinPhi, sinTheta * sinPhi, cosPhi);
}
`

/**
 * Hillaire's horizon-packed Sky-View LUT parameterization.
 *
 * `UvToSkyViewLutParams` → packed as `vec2(viewZenithCosAngle, lightViewCosAngle)`
 * (the wgslFn path avoids struct returns until they're validated; the two
 * outputs pack cleanly into a vec2). Depends on `fromSubUvsToUnit` (pass via
 * includes). Takes `bottomRadius` flat rather than the full params struct —
 * it's the only field this map uses.
 *
 * The 192/108 constants are the SkyView LUT resolution; today they're hard-coded
 * in BOTH cores (see WGSL_CORE_PLAN.md — the fragility this whole effort kills).
 */
export const UV_TO_SKYVIEW_PARAMS = /* wgsl */ `
fn uvToSkyViewLutParams(viewHeight: f32, bottomRadius: f32, uv: vec2<f32>) -> vec2<f32> {
  let resX = 192.0;
  let resY = 108.0;
  let uCorr = fromSubUvsToUnit(uv.x, resX);
  let vCorr = fromSubUvsToUnit(uv.y, resY);

  let botR2 = bottomRadius * bottomRadius;
  let vh2 = viewHeight * viewHeight;
  let vHorizon = sqrt(max(vh2 - botR2, 0.0));
  let cosBeta = vHorizon / max(viewHeight, 1e-6);
  let beta = acos(clamp(cosBeta, -1.0, 1.0));
  let zenithHorizonAngle = 3.1415926535897932 - beta;

  // Above horizon (v < 0.5).
  let ca0 = 2.0 * vCorr;
  let ca1 = 1.0 - ca0;
  let ca2 = ca1 * ca1;            // NONLINEARSKYVIEWLUT
  let ca3 = 1.0 - ca2;
  let vzAbove = cos(zenithHorizonAngle * ca3);
  // Below horizon (v >= 0.5).
  let cb0 = vCorr * 2.0 - 1.0;
  let cb1 = cb0 * cb0;           // NONLINEARSKYVIEWLUT
  let vzBelow = cos(zenithHorizonAngle + beta * cb1);
  let viewZenithCosAngle = select(vzBelow, vzAbove, vCorr < 0.5);

  let uSq = uCorr * uCorr;
  let lightViewCosAngle = -(uSq * 2.0 - 1.0);
  return vec2<f32>(viewZenithCosAngle, lightViewCosAngle);
}
`

/**
 * Forward map `SkyViewLutParamsToUv` → `vec2` UV. `intersectsGround` is an f32
 * flag (0/1) to keep the wgslFn arg list bool-free. Depends on
 * `fromUnitToSubUvs` (pass via includes).
 */
export const SKYVIEW_PARAMS_TO_UV = /* wgsl */ `
fn skyViewLutParamsToUv(intersectsGround: f32, viewZenithCosAngle: f32, lightViewCosAngle: f32, viewHeight: f32, bottomRadius: f32) -> vec2<f32> {
  let botR2 = bottomRadius * bottomRadius;
  let vh2 = viewHeight * viewHeight;
  let vHorizon = sqrt(max(vh2 - botR2, 0.0));
  let cosBeta = vHorizon / max(viewHeight, 1e-6);
  let beta = acos(clamp(cosBeta, -1.0, 1.0));
  let zenithHorizonAngle = 3.1415926535897932 - beta;
  let vzAcos = acos(clamp(viewZenithCosAngle, -1.0, 1.0));

  // Sky branch (no ground intersection).
  let cs0 = vzAcos / max(zenithHorizonAngle, 1e-6);
  let cs1 = 1.0 - cs0;
  let cs2 = sqrt(max(cs1, 0.0));  // NONLINEARSKYVIEWLUT
  let cs3 = 1.0 - cs2;
  let uvYSky = cs3 * 0.5;
  // Ground branch.
  let cg0 = (vzAcos - zenithHorizonAngle) / max(beta, 1e-6);
  let cg1 = sqrt(max(cg0, 0.0));  // NONLINEARSKYVIEWLUT
  let uvYGnd = cg1 * 0.5 + 0.5;
  let uvY = select(uvYSky, uvYGnd, intersectsGround > 0.5);

  let uvXraw = sqrt(saturate(-lightViewCosAngle * 0.5 + 0.5));
  let resX = 192.0;
  let resY = 108.0;
  return vec2<f32>(fromUnitToSubUvs(uvXraw, resX), fromUnitToSubUvs(uvY, resY));
}
`

/**
 * Per-component scattering/absorption/extinction at an altitude above the
 * surface (flat-arg). Mirrors `sampleMediumRGB`. Returns a `MediumSample` struct.
 *
 * ⚠️ NATIVE-BLOB ONLY — do NOT wrap this with `wgslFn`. three's `wgslFn` parser
 * cannot map a custom struct RETURN type to a TSL node; wrapping it throws
 * "FunctionNode: Function is not a WGSL code" at parse time. Only scalar/vector
 * returns survive `wgslFn`. LUT pixel shaders that need the medium therefore
 * **inline** the density/extinction/scattering computation (see
 * `luts.wgsl.ts`). This struct form is kept for the future native baker, whose
 * raw WGSL compiler handles struct returns fine.
 *
 * The arg list mirrors the `AtmosphereParams` field order (radii excluded).
 */
export const COMPUTE_SCATTERING_ABSORPTION = /* wgsl */ `
struct MediumSample {
  rayleighScattering: vec3<f32>,
  mieScattering: vec3<f32>,
  mieExtinction: vec3<f32>,
  mieAbsorption: vec3<f32>,
  absorptionExtinction: vec3<f32>,
  scattering: vec3<f32>,
  extinction: vec3<f32>,
};

fn computeScatteringAbsorption(
  height: f32,
  mieDensityExpScale: f32,
  rayleighDensityExpScale: f32,
  absorptionDensity0LayerWidth: f32,
  absorptionDensity0LinearTerm: f32,
  absorptionDensity0ConstantTerm: f32,
  absorptionDensity1LinearTerm: f32,
  absorptionDensity1ConstantTerm: f32,
  mieScattering: vec3<f32>,
  mieAbsorption: vec3<f32>,
  mieExtinction: vec3<f32>,
  rayleighScattering: vec3<f32>,
  absorptionExtinction: vec3<f32>
) -> MediumSample {
  let densityMie = exp(mieDensityExpScale * height);
  let densityRay = exp(rayleighDensityExpScale * height);

  // Ozone tent: two linear regimes split at absorptionDensity0LayerWidth.
  let ozo0 = absorptionDensity0LinearTerm * height + absorptionDensity0ConstantTerm;
  let ozo1 = absorptionDensity1LinearTerm * height + absorptionDensity1ConstantTerm;
  let densityOzo = saturate(select(ozo1, ozo0, height < absorptionDensity0LayerWidth));

  let scatteringMie = mieScattering * densityMie;
  let absorptionMie = mieAbsorption * densityMie;
  let extinctionMie = mieExtinction * densityMie;
  let scatteringRay = rayleighScattering * densityRay;
  let extinctionRay = scatteringRay; // Rayleigh absorption is zero in this model
  let absorptionOzo = absorptionExtinction * densityOzo;

  var m: MediumSample;
  m.rayleighScattering = scatteringRay;
  m.mieScattering = scatteringMie;
  m.mieExtinction = extinctionMie;
  m.mieAbsorption = absorptionMie;
  m.absorptionExtinction = absorptionOzo;
  m.scattering = scatteringMie + scatteringRay;
  m.extinction = extinctionMie + extinctionRay + absorptionOzo;
  return m;
}
`

/**
 * Bruneton UV → (viewHeight, viewZenithCosAngle), packed as a vec2 (flat-arg).
 * Port of `UvToLutTransmittanceParams`.
 */
export const UV_TO_TRANSMITTANCE = /* wgsl */ `
fn uvToTransmittanceLutParams(uv: vec2<f32>, bottomRadius: f32, topRadius: f32) -> vec2<f32> {
  let xMu = uv.x;
  let xR = uv.y;
  let topR2 = topRadius * topRadius;
  let botR2 = bottomRadius * bottomRadius;
  let H = sqrt(max(0.0, topR2 - botR2));
  let rho = H * xR;
  let viewHeight = sqrt(rho * rho + botR2);
  let dMin = topRadius - viewHeight;
  let dMax = rho + H;
  let d = dMin + xMu * (dMax - dMin);
  var vzca: f32 = 1.0;
  if (d > 0.0) {
    vzca = (H * H - rho * rho - d * d) / max(2.0 * viewHeight * d, 1e-20);
  }
  return vec2<f32>(viewHeight, clamp(vzca, -1.0, 1.0));
}
`

/**
 * (viewHeight, viewZenithCosAngle) → Bruneton UV (flat-arg). Port of
 * `LutTransmittanceParamsToUv`. Used by MS/SkyView/AP when sampling the
 * Transmittance LUT along a marched ray.
 */
export const TRANSMITTANCE_PARAMS_TO_UV = /* wgsl */ `
fn transmittanceLutParamsToUv(viewHeight: f32, viewZenithCosAngle: f32, bottomRadius: f32, topRadius: f32) -> vec2<f32> {
  let topR2 = topRadius * topRadius;
  let botR2 = bottomRadius * bottomRadius;
  let H = sqrt(max(0.0, topR2 - botR2));
  let rho = sqrt(max(0.0, viewHeight * viewHeight - botR2));
  let disc = viewHeight * viewHeight * (viewZenithCosAngle * viewZenithCosAngle - 1.0) + topR2;
  let d = max(0.0, -viewHeight * viewZenithCosAngle + sqrt(max(disc, 0.0)));
  let dMin = topRadius - viewHeight;
  let dMax = rho + H;
  let xMu = (d - dMin) / max(dMax - dMin, 1e-20);
  let xR = rho / max(H, 1e-20);
  return vec2<f32>(xMu, xR);
}
`

/**
 * Every helper, in dependency order — for native consumers that want one blob.
 * (These are all flat-arg; a native baker binding a UBO would add a thin struct
 * wrapper. PRELUDE's struct is exported for that future path but unused here.)
 */
export const ATMOSPHERE_WGSL = [
  UV_HELPERS,
  RAYLEIGH_PHASE,
  MIE_PHASE_CS,
  HG_PHASE,
  RAY_SPHERE,
  SPHERICAL_DIR,
  UV_TO_SKYVIEW_PARAMS,
  SKYVIEW_PARAMS_TO_UV,
  COMPUTE_SCATTERING_ABSORPTION,
  UV_TO_TRANSMITTANCE,
  TRANSMITTANCE_PARAMS_TO_UV,
].join('\n')
