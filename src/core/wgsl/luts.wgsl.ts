/**
 * Engine-agnostic WGSL — whole-pixel LUT shader bodies.
 *
 * Where `atmosphere.wgsl.ts` holds reusable helpers, this file holds the
 * per-LUT fragment programs: one WGSL function per LUT that computes a single
 * output texel. Each is wrapped by a single `wgslFn` in `backends/wgsl/luts.ts`
 * and becomes the LUT material's `colorNode` on the WebGPU backend. The helper
 * dependencies travel through the `wgslFn` `includes` array.
 *
 * This is where the WGSL port pays off most: the ray-march is a real WGSL
 * `for` loop with real locals, so the `.toVar()`-in-a-JS-loop shader-size bomb
 * (see CLAUDE.md) simply cannot happen.
 *
 * ZERO three imports. See WGSL_CORE_PLAN.md.
 */

/**
 * Transmittance LUT — one texel.
 *
 * Faithful port of `RenderTransmittanceLutPS`: un-map the Bruneton
 * (viewHeight, viewZenithCosAngle) from UV, ray-march 40 fixed steps to the
 * atmosphere/ground boundary accumulating optical depth, return
 * `exp(-opticalDepth)`. No in-scatter, no transmittance-to-sun sample (the
 * `ground=false` specialization of the integrator).
 *
 * Depends (via includes) on: `raySphereIntersectNearest` (returns f32) and
 * `uvToTransmittanceLutParams` (returns vec2). The medium **extinction** is
 * inlined per step rather than pulled from a shared `computeScatteringAbsorption`
 * helper, because three's `wgslFn` parser cannot map a custom struct return type
 * (`-> MediumSample`) to a TSL node — only scalar/vector returns survive. See
 * the note on `COMPUTE_SCATTERING_ABSORPTION` in `atmosphere.wgsl.ts`. For the
 * transmittance LUT only extinction is needed, so the inline block is small.
 *
 * Arg order: uv, radii, then the extinction-relevant medium fields.
 * `transmittanceLutArgs()` in `backends/wgsl/luts.ts` maps a uniform bundle
 * onto these names.
 */
export const TRANSMITTANCE_LUT_PIXEL = /* wgsl */ `
fn transmittanceLutPixel(
  uv: vec2<f32>,
  bottomRadius: f32,
  topRadius: f32,
  mieDensityExpScale: f32,
  rayleighDensityExpScale: f32,
  absorptionDensity0LayerWidth: f32,
  absorptionDensity0LinearTerm: f32,
  absorptionDensity0ConstantTerm: f32,
  absorptionDensity1LinearTerm: f32,
  absorptionDensity1ConstantTerm: f32,
  mieExtinction: vec3<f32>,
  rayleighScattering: vec3<f32>,
  absorptionExtinction: vec3<f32>
) -> vec3<f32> {
  let params = uvToTransmittanceLutParams(uv, bottomRadius, topRadius);
  let viewHeight = params.x;
  let viewZenithCosAngle = params.y;

  // World pos on +Y, ray in the YZ plane (matches the TSL twin's layout).
  let worldPos = vec3<f32>(0.0, viewHeight, 0.0);
  let sinZ = sqrt(max(0.0, 1.0 - viewZenithCosAngle * viewZenithCosAngle));
  let worldDir = vec3<f32>(sinZ, viewZenithCosAngle, 0.0);
  let earthO = vec3<f32>(0.0, 0.0, 0.0);

  let tBottom = raySphereIntersectNearest(worldPos, worldDir, earthO, bottomRadius);
  let tTop = raySphereIntersectNearest(worldPos, worldDir, earthO, topRadius);

  // tMax: 0 if miss/miss; else min of the two positive hits (ground shortcut
  // when pointing down); else just tTop.
  var tMax: f32;
  if (tBottom < 0.0) {
    if (tTop < 0.0) { tMax = 0.0; } else { tMax = tTop; }
  } else {
    if (tTop > 0.0) { tMax = min(tTop, tBottom); } else { tMax = tBottom; }
  }

  let sampleCount = 40.0;
  let segmentT = 0.3; // Hillaire mid-segment offset
  var opticalDepth = vec3<f32>(0.0, 0.0, 0.0);
  var tPrev = 0.0;

  for (var s = 0.0; s < sampleCount; s = s + 1.0) {
    let newT = tMax * ((s + segmentT) / sampleCount);
    let dt = newT - tPrev;
    let P = worldPos + worldDir * newT;
    let height = length(P) - bottomRadius;

    // --- inline extinction (mirrors computeScatteringAbsorption's extinction) ---
    let densityMie = exp(mieDensityExpScale * height);
    let densityRay = exp(rayleighDensityExpScale * height);
    let ozo0 = absorptionDensity0LinearTerm * height + absorptionDensity0ConstantTerm;
    let ozo1 = absorptionDensity1LinearTerm * height + absorptionDensity1ConstantTerm;
    let densityOzo = saturate(select(ozo1, ozo0, height < absorptionDensity0LayerWidth));
    // extinction = mieExtinction + rayleighScattering (Rayleigh absorption=0) + ozone absorption
    let extinction = mieExtinction * densityMie + rayleighScattering * densityRay + absorptionExtinction * densityOzo;

    opticalDepth = opticalDepth + extinction * dt;
    tPrev = newT;
  }

  return exp(-opticalDepth);
}
`

/**
 * Sky-View LUT — one texel. Port of `SkyViewLutPS` with the
 * `integrateScatteredLuminance` inner loop inlined for its config
 * (`ground=true, mieRayPhase=true, MULTISCATAPPROX_ENABLED, 30 steps`). This is
 * the representative integrator LUT: it samples both the Transmittance LUT (sun
 * extinction) and the Multi-Scatter LUT (higher-order bounces) per step.
 *
 * Everything is inlined (medium sample, uvToSkyViewLutParams, moveToTopAtmosphere,
 * transmittanceLutParamsToUv, the MS sub-UV correction) because none of those can
 * be `wgslFn` helpers — struct returns don't survive, and inlining keeps them in
 * one module scope. Includes are only the scalar/vector helpers:
 * `raySphereIntersectNearest` (f32), `rayleighPhase` (f32), `hgPhase` (f32),
 * `bilinearSample2D` (vec3).
 *
 * LUT sampling is manual bilinear (three's wgslFn gives no sampler), matching the
 * TSL twin's hardware sampling to ~1e-3 — visually identical. The native baker
 * (Phase 5) will use a real sampler for exactness.
 *
 * Frame: LUT-local Z-up (matches HLSL). `sunDirWorld` is used only for its
 * z-component (the sun zenith cosine); azimuth is folded into `lightViewCosAngle`.
 */
export const SKYVIEW_LUT_PIXEL = /* wgsl */ `
fn skyViewLutPixel(
  uv: vec2<f32>,
  transmittanceLut: texture_2d<f32>,
  multiScatterLut: texture_2d<f32>,
  sunDirWorld: vec3<f32>,
  viewHeightIn: f32,
  bottomRadius: f32,
  topRadius: f32,
  mieDensityExpScale: f32,
  rayleighDensityExpScale: f32,
  absorptionDensity0LayerWidth: f32,
  absorptionDensity0LinearTerm: f32,
  absorptionDensity0ConstantTerm: f32,
  absorptionDensity1LinearTerm: f32,
  absorptionDensity1ConstantTerm: f32,
  mieScattering: vec3<f32>,
  mieExtinction: vec3<f32>,
  rayleighScattering: vec3<f32>,
  absorptionExtinction: vec3<f32>,
  miePhaseG: f32,
  groundAlbedo: vec3<f32>
) -> vec3<f32> {
  let PI = 3.1415926535897932;
  let OFFSET = 0.01;
  let viewHeight = max(viewHeightIn, bottomRadius + 0.01);
  let botR2 = bottomRadius * bottomRadius;
  let topR2 = topRadius * topRadius;
  let earthO = vec3<f32>(0.0, 0.0, 0.0);

  // --- unmap uv -> (viewZenithCosAngle, lightViewCosAngle) [uvToSkyViewLutParams] ---
  let resX = 192.0;
  let resY = 108.0;
  let uCorr = (uv.x - 0.5 / resX) * (resX / (resX - 1.0));
  let vCorr = (uv.y - 0.5 / resY) * (resY / (resY - 1.0));
  let vHorizon = sqrt(max(viewHeight * viewHeight - botR2, 0.0));
  let cosBeta = vHorizon / max(viewHeight, 1e-6);
  let beta = acos(clamp(cosBeta, -1.0, 1.0));
  let zenithHorizonAngle = PI - beta;
  var viewZenithCosAngle: f32;
  if (vCorr < 0.5) {
    let ca1 = 1.0 - 2.0 * vCorr;
    let ca3 = 1.0 - ca1 * ca1;
    viewZenithCosAngle = cos(zenithHorizonAngle * ca3);
  } else {
    let cb0 = vCorr * 2.0 - 1.0;
    viewZenithCosAngle = cos(zenithHorizonAngle + beta * (cb0 * cb0));
  }
  let uSq = uCorr * uCorr;
  let lightViewCosAngle = -(uSq * 2.0 - 1.0);

  // --- sun dir in LUT Z-up frame (only z-component of the world sun matters) ---
  let sunZenithCosAngle = dot(vec3<f32>(0.0, 0.0, 1.0), normalize(sunDirWorld));
  let sunDirSinZ = sqrt(max(1.0 - sunZenithCosAngle * sunZenithCosAngle, 0.0));
  let sunDir = vec3<f32>(sunDirSinZ, 0.0, sunZenithCosAngle);

  // --- world pos + view dir ---
  var worldPos = vec3<f32>(0.0, 0.0, viewHeight);
  let vzSin = sqrt(max(1.0 - viewZenithCosAngle * viewZenithCosAngle, 0.0));
  let worldDir = vec3<f32>(
    vzSin * lightViewCosAngle,
    vzSin * sqrt(max(1.0 - lightViewCosAngle * lightViewCosAngle, 0.0)),
    viewZenithCosAngle
  );

  // --- moveToTopAtmosphere (no-op unless camera above topRadius) ---
  if (viewHeight > topRadius) {
    let tTopClip = raySphereIntersectNearest(worldPos, worldDir, earthO, topRadius);
    if (tTopClip < 0.0) { return vec3<f32>(0.0, 0.0, 0.0); }
    let up0 = worldPos / viewHeight;
    worldPos = worldPos + worldDir * tTopClip - up0 * OFFSET;
  }

  // --- tMax ---
  let tBottom = raySphereIntersectNearest(worldPos, worldDir, earthO, bottomRadius);
  let tTop = raySphereIntersectNearest(worldPos, worldDir, earthO, topRadius);
  var tMax: f32;
  if (tBottom < 0.0) {
    if (tTop < 0.0) { tMax = 0.0; } else { tMax = tTop; }
  } else {
    if (tTop > 0.0) { tMax = min(tTop, tBottom); } else { tMax = tBottom; }
  }

  // --- phases (constant per ray) ---
  let cosTheta = dot(sunDir, worldDir);
  let miePhaseValue = hgPhase(-cosTheta, miePhaseG);
  let rayleighPhaseValue = rayleighPhase(cosTheta);

  let sampleCount = 30.0;
  let segmentT = 0.3;
  let atmosphereThickness = topRadius - bottomRadius;

  var L = vec3<f32>(0.0, 0.0, 0.0);
  var throughput = vec3<f32>(1.0, 1.0, 1.0);
  var tPrev = 0.0;

  for (var s = 0.0; s < sampleCount; s = s + 1.0) {
    let newT = tMax * ((s + segmentT) / sampleCount);
    let dt = newT - tPrev;
    let P = worldPos + worldDir * newT;
    let pHeight = length(P);
    let altitude = pHeight - bottomRadius;
    let up = P / max(pHeight, 1e-6);

    // medium sample
    let densityMie = exp(mieDensityExpScale * altitude);
    let densityRay = exp(rayleighDensityExpScale * altitude);
    let ozo0 = absorptionDensity0LinearTerm * altitude + absorptionDensity0ConstantTerm;
    let ozo1 = absorptionDensity1LinearTerm * altitude + absorptionDensity1ConstantTerm;
    let densityOzo = saturate(select(ozo1, ozo0, altitude < absorptionDensity0LayerWidth));
    let scatteringMie = mieScattering * densityMie;
    let scatteringRay = rayleighScattering * densityRay;
    let scattering = scatteringMie + scatteringRay;
    let extinction = mieExtinction * densityMie + scatteringRay + absorptionExtinction * densityOzo;
    let extSafe = max(extinction, vec3<f32>(1e-6, 1e-6, 1e-6));

    let sampleOpticalDepth = extinction * dt;
    let sampleTransmittance = exp(-sampleOpticalDepth);

    // transmittance to sun (transmittanceLutParamsToUv, then manual bilinear)
    let sunZenithCos = dot(sunDir, up);
    let H = sqrt(max(0.0, topR2 - botR2));
    let rho = sqrt(max(0.0, pHeight * pHeight - botR2));
    let disc = pHeight * pHeight * (sunZenithCos * sunZenithCos - 1.0) + topR2;
    let dSun = max(0.0, -pHeight * sunZenithCos + sqrt(max(disc, 0.0)));
    let tU = vec2<f32>((dSun - (topRadius - pHeight)) / max((rho + H) - (topRadius - pHeight), 1e-20), rho / max(H, 1e-20));
    let transmittanceToSun = bilinearSample2D(transmittanceLut, tU);

    // phase * scattering (Mie + Rayleigh)
    let phaseTimesScattering = scatteringMie * miePhaseValue + scatteringRay * rayleighPhaseValue;

    // earth shadow
    let shadowOrigin = P + up * OFFSET;
    let tEarth = raySphereIntersectNearest(shadowOrigin, sunDir, earthO, bottomRadius);
    let earthShadow = select(1.0, 0.0, tEarth >= 0.0);

    let directInScatter = earthShadow * transmittanceToSun * phaseTimesScattering;

    // multi-scatter LUT feedback (sub-UV corrected, 32x32)
    let altitude01 = saturate(altitude / max(atmosphereThickness, 1e-6));
    let msRes = 32.0;
    let msUvX = (sunZenithCos * 0.5 + 0.5 + 0.5 / msRes) * (msRes / (msRes + 1.0));
    let msUvY = (altitude01 + 0.5 / msRes) * (msRes / (msRes + 1.0));
    let multiScatteredLuminance = bilinearSample2D(multiScatterLut, vec2<f32>(msUvX, msUvY));

    let S = directInScatter + multiScatteredLuminance * scattering;
    let Sint = (S - S * sampleTransmittance) / extSafe;
    L = L + throughput * Sint;

    throughput = throughput * sampleTransmittance;
    tPrev = newT;
  }

  // ground bounce (ground = true)
  if (tBottom > 0.0 && tMax == tBottom) {
    let P = worldPos + worldDir * tBottom;
    let pHeight = length(P);
    let up = P / max(pHeight, 1e-6);
    let sunZenithCos = dot(sunDir, up);
    let H = sqrt(max(0.0, topR2 - botR2));
    let rho = sqrt(max(0.0, pHeight * pHeight - botR2));
    let disc = pHeight * pHeight * (sunZenithCos * sunZenithCos - 1.0) + topR2;
    let dSun = max(0.0, -pHeight * sunZenithCos + sqrt(max(disc, 0.0)));
    let tU = vec2<f32>((dSun - (topRadius - pHeight)) / max((rho + H) - (topRadius - pHeight), 1e-20), rho / max(H, 1e-20));
    let transmittanceToSun = bilinearSample2D(transmittanceLut, tU);
    let NdotL = saturate(dot(normalize(up), normalize(sunDir)));
    L = L + transmittanceToSun * throughput * NdotL * groundAlbedo / PI;
  }

  return L;
}
`

/**
 * Multi-Scatter LUT — one texel. Port of `NewMultiScattCS`. For each texel
 * (cosSunZenith, viewHeight), integrate over 64 stratified spherical directions;
 * each direction ray-marches 20 steps reading the Transmittance LUT, accumulating
 * both second-order in-scatter `L` and the uniform-transfer factor `f_ms`
 * (`multiScatAs1`). Finalize with the closed-form geometric series
 * `L = L2nd / (1 - f_ms)`.
 *
 * Integrator config: `ground=true, mieRayPhase=false (uniform phase), no MS
 * feedback` (we're building the MS LUT). Everything inlined; includes are
 * `getSphericalDir` (vec3), `raySphereIntersectNearest` (f32),
 * `bilinearSample2D` (vec3). Samples only the Transmittance LUT.
 *
 * Nested `for` loops (64×20) — trivial in real WGSL; this is precisely the shape
 * that would detonate as a JS-unrolled `.toVar()` graph (CLAUDE.md).
 */
export const MULTISCATTER_LUT_PIXEL = /* wgsl */ `
fn multiScatterLutPixel(
  uv: vec2<f32>,
  transmittanceLut: texture_2d<f32>,
  bottomRadius: f32,
  topRadius: f32,
  mieDensityExpScale: f32,
  rayleighDensityExpScale: f32,
  absorptionDensity0LayerWidth: f32,
  absorptionDensity0LinearTerm: f32,
  absorptionDensity0ConstantTerm: f32,
  absorptionDensity1LinearTerm: f32,
  absorptionDensity1ConstantTerm: f32,
  mieScattering: vec3<f32>,
  mieExtinction: vec3<f32>,
  rayleighScattering: vec3<f32>,
  absorptionExtinction: vec3<f32>,
  groundAlbedo: vec3<f32>
) -> vec3<f32> {
  let PI = 3.1415926535897932;
  let OFFSET = 0.01;
  let botR2 = bottomRadius * bottomRadius;
  let topR2 = topRadius * topRadius;
  let H = sqrt(max(0.0, topR2 - botR2));
  let earthO = vec3<f32>(0.0, 0.0, 0.0);

  // sub-UV correct (32x32).
  let res = 32.0;
  let corrU = (uv.x - 0.5 / res) * (res / (res - 1.0));
  let corrV = (uv.y - 0.5 / res) * (res / (res - 1.0));

  let cosSunZenith = corrU * 2.0 - 1.0;
  let sunDir = vec3<f32>(0.0, sqrt(saturate(1.0 - cosSunZenith * cosSunZenith)), cosSunZenith);

  let atmosphereThickness = topRadius - bottomRadius - OFFSET;
  let viewHeight = bottomRadius + saturate(corrV + OFFSET) * atmosphereThickness;
  let worldPos = vec3<f32>(0.0, 0.0, viewHeight);

  let sqrtN = 8.0;
  let sampleWeight = (4.0 * PI) / (sqrtN * sqrtN);
  let uniformPhase = 1.0 / (4.0 * PI);
  let sampleCount = 20.0;
  let segmentT = 0.3;

  var totalL = vec3<f32>(0.0, 0.0, 0.0);
  var totalMSA = vec3<f32>(0.0, 0.0, 0.0);

  for (var d = 0; d < 64; d = d + 1) {
    let iF = floor(f32(d) / sqrtN);
    let jF = f32(d) - iF * sqrtN;
    let worldDir = getSphericalDir(iF + 0.5, jF + 0.5, sqrtN);

    var L = vec3<f32>(0.0, 0.0, 0.0);
    var throughput = vec3<f32>(1.0, 1.0, 1.0);
    var multiScatAs1 = vec3<f32>(0.0, 0.0, 0.0);
    var tPrev = 0.0;

    let tBottom = raySphereIntersectNearest(worldPos, worldDir, earthO, bottomRadius);
    let tTop = raySphereIntersectNearest(worldPos, worldDir, earthO, topRadius);
    var tMax: f32;
    if (tBottom < 0.0) {
      if (tTop < 0.0) { tMax = 0.0; } else { tMax = tTop; }
    } else {
      if (tTop > 0.0) { tMax = min(tTop, tBottom); } else { tMax = tBottom; }
    }

    for (var s = 0.0; s < sampleCount; s = s + 1.0) {
      let newT = tMax * ((s + segmentT) / sampleCount);
      let dt = newT - tPrev;
      let P = worldPos + worldDir * newT;
      let pHeight = length(P);
      let altitude = pHeight - bottomRadius;
      let up = P / max(pHeight, 1e-6);

      // medium
      let densityMie = exp(mieDensityExpScale * altitude);
      let densityRay = exp(rayleighDensityExpScale * altitude);
      let ozo0 = absorptionDensity0LinearTerm * altitude + absorptionDensity0ConstantTerm;
      let ozo1 = absorptionDensity1LinearTerm * altitude + absorptionDensity1ConstantTerm;
      let densityOzo = saturate(select(ozo1, ozo0, altitude < absorptionDensity0LayerWidth));
      let scattering = mieScattering * densityMie + rayleighScattering * densityRay;
      let extinction = mieExtinction * densityMie + rayleighScattering * densityRay + absorptionExtinction * densityOzo;
      let extSafe = max(extinction, vec3<f32>(1e-6, 1e-6, 1e-6));

      let sampleTransmittance = exp(-extinction * dt);

      // transmittance to sun (Bruneton uv, manual bilinear)
      let sunZenithCos = dot(sunDir, up);
      let rho = sqrt(max(0.0, pHeight * pHeight - botR2));
      let disc = pHeight * pHeight * (sunZenithCos * sunZenithCos - 1.0) + topR2;
      let dSun = max(0.0, -pHeight * sunZenithCos + sqrt(max(disc, 0.0)));
      let tU = vec2<f32>((dSun - (topRadius - pHeight)) / max((rho + H) - (topRadius - pHeight), 1e-20), rho / max(H, 1e-20));
      let transmittanceToSun = bilinearSample2D(transmittanceLut, tU);

      let phaseTimesScattering = scattering * uniformPhase;

      let shadowOrigin = P + up * OFFSET;
      let tEarth = raySphereIntersectNearest(shadowOrigin, sunDir, earthO, bottomRadius);
      let earthShadow = select(1.0, 0.0, tEarth >= 0.0);

      let S = earthShadow * transmittanceToSun * phaseTimesScattering;
      let Sint = (S - S * sampleTransmittance) / extSafe;
      L = L + throughput * Sint;

      let MSint = (scattering - scattering * sampleTransmittance) / extSafe;
      multiScatAs1 = multiScatAs1 + throughput * MSint;

      throughput = throughput * sampleTransmittance;
      tPrev = newT;
    }

    // ground bounce
    if (tBottom > 0.0 && tMax == tBottom) {
      let Pg = worldPos + worldDir * tBottom;
      let pHeightG = length(Pg);
      let upG = Pg / max(pHeightG, 1e-6);
      let sunZenithCosG = dot(sunDir, upG);
      let rhoG = sqrt(max(0.0, pHeightG * pHeightG - botR2));
      let discG = pHeightG * pHeightG * (sunZenithCosG * sunZenithCosG - 1.0) + topR2;
      let dSunG = max(0.0, -pHeightG * sunZenithCosG + sqrt(max(discG, 0.0)));
      let tUG = vec2<f32>((dSunG - (topRadius - pHeightG)) / max((rhoG + H) - (topRadius - pHeightG), 1e-20), rhoG / max(H, 1e-20));
      let transmittanceToSunG = bilinearSample2D(transmittanceLut, tUG);
      let NdotL = saturate(dot(normalize(upG), normalize(sunDir)));
      L = L + transmittanceToSunG * throughput * NdotL * groundAlbedo / PI;
    }

    totalL = totalL + L * sampleWeight;
    totalMSA = totalMSA + multiScatAs1 * sampleWeight;
  }

  let isotropicPhase = 1.0 / (4.0 * PI);
  let inScattered = totalL * isotropicPhase;
  let msaFinal = totalMSA * isotropicPhase;
  let oneMinusR = max(vec3<f32>(1.0, 1.0, 1.0) - msaFinal, vec3<f32>(1e-6, 1e-6, 1e-6));
  return inScattered / oneMinusR;
}
`
