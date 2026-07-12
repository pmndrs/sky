import {
  Storage3DTexture,
  HalfFloatType,
  RGBAFormat,
  LinearFilter,
  ClampToEdgeWrapping,
  Vector3,
  Matrix4,
} from 'three/webgpu'

import {
  Fn,
  instanceIndex,
  textureStore,
  uniform,
  vec2,
  vec4,
  ivec3,
  float,
  int,
  uint,
  normalize,
  length,
  select,
  fract,
  sin,
  dot,
} from 'three/tsl'

import { integrateScatteredLuminance, moveToTopAtmosphere } from '../../backends/tsl/atmosphere.tsl'
import type { TransmittanceLUT } from './TransmittanceLUT'
import type { MultiScatterLUT } from './MultiScatterLUT'

interface AerialPerspectiveResolution {
  x: number
  y: number
  z: number
}

interface AerialPerspectiveLUTOptions {
  resolution?: AerialPerspectiveResolution
  kmPerSlice?: number
  atmosphereUniforms?: any
  transmittanceLUT?: TransmittanceLUT
  multiScatterLUT?: MultiScatterLUT
  sunDirection?: Vector3
}

interface SetCameraOptions {
  planetCenter?: Vector3 | null
}

/**
 * Hillaire Aerial Perspective LUT (3D froxel volume).
 *
 * Per voxel `(x, y, z)`:
 *  - X/Y are screen-space NDC; the voxel's view ray is reconstructed from the
 *    camera's inverse view-projection.
 *  - Z is a *squared-distributed* depth slice covering 0 → `kmPerSlice * resZ` km
 *    from the camera. Squared distribution packs more detail near the camera
 *    where haze gradients matter most.
 *
 * Each voxel ray-marches from the camera through the atmosphere for exactly its
 * slice's depth, accumulating in-scattered luminance + transmittance. The LUT
 * stores `vec4(L, 1 - mean(transmittance))` so the consumer can blend
 * `final = sceneColor * (1 - AP.a) + AP.rgb`.
 *
 * Built per-frame via a TSL compute shader writing into a `Storage3DTexture`.
 *
 * Port of `RenderCameraVolumePS` (and the geometry-shader-driven slice loop)
 * from `UnrealEngineSkyAtmosphere/Resources/RenderSkyRayMarching.hlsl:645-716`.
 * The Unreal version uses one render-target write per slice (32 slices ×
 * fragment pass each); our compute path writes the whole 32×32×32 volume in
 * one dispatch, which is more idiomatic on WebGPU.
 *
 * Coordinate frame: camera position is given in three.js Y-up world space (m).
 * Ground-level callers can keep the legacy flat convention (`camera.y` =
 * altitude), while planet-scale callers pass a planet centre so the AP volume
 * receives the true planet-centred camera vector. View directions are taken
 * straight from the camera's world-space transform.
 *
 * @typedef {Object} AerialPerspectiveLUTOptions
 * @property {{x:number,y:number,z:number}} [resolution] Voxel grid size. Defaults to 32³.
 * @property {number} [kmPerSlice] Atmospheric thickness per Z slice (km). Default 4. Total range = kmPerSlice * resZ km.
 * @property {object} atmosphereUniforms - Atmosphere uniform bundle (see AtmosphereUniforms.js).
 * @property {TransmittanceLUT} transmittanceLUT
 * @property {MultiScatterLUT} multiScatterLUT
 * @property {Vector3} [sunDirection] Initial sun direction (Y-up world). Default (0,1,0).
 */
export class AerialPerspectiveLUT {
  renderer: any
  resolution: AerialPerspectiveResolution
  kmPerSlice: number
  atmosphereUniforms: any
  transmittanceLUT: TransmittanceLUT
  multiScatterLUT: MultiScatterLUT
  _tex: Storage3DTexture
  _sunDirection: any
  _cameraPosKm: any
  _invProj: any
  _cameraMatrixWorld: any
  _compute: any

  constructor(
    renderer: any,
    {
      resolution = { x: 32, y: 32, z: 32 },
      // 8 km/slice × 32 slices = 256 km coverage. Hillaire's reference uses
      // 4 km/slice (128 km), but at horizon-grazing rays the full atmosphere
      // extends well beyond that, leaving a brightness gap where AP under-
      // integrates relative to the Sky-View LUT — visible as a residual dark
      // fringe on distant silhouettes. 256 km closes the gap for ground-based
      // scenes; further coverage starts losing near-camera precision.
      kmPerSlice = 8.0,
      atmosphereUniforms,
      transmittanceLUT,
      multiScatterLUT,
      sunDirection,
    }: AerialPerspectiveLUTOptions = {},
  ) {
    if (!atmosphereUniforms) throw new Error('AerialPerspectiveLUT: atmosphereUniforms is required')
    if (!transmittanceLUT) throw new Error('AerialPerspectiveLUT: transmittanceLUT is required')
    if (!multiScatterLUT) throw new Error('AerialPerspectiveLUT: multiScatterLUT is required')

    this.renderer = renderer
    this.resolution = { ...resolution }
    this.kmPerSlice = kmPerSlice
    this.atmosphereUniforms = atmosphereUniforms
    this.transmittanceLUT = transmittanceLUT
    this.multiScatterLUT = multiScatterLUT

    // --- Storage texture (3D, RGBA16F) ---
    this._tex = new Storage3DTexture(resolution.x, resolution.y, resolution.z)
    this._tex.type = HalfFloatType
    this._tex.format = RGBAFormat
    this._tex.minFilter = LinearFilter
    this._tex.magFilter = LinearFilter
    this._tex.wrapS = ClampToEdgeWrapping
    this._tex.wrapT = ClampToEdgeWrapping
    this._tex.wrapR = ClampToEdgeWrapping
    this._tex.name = 'AerialPerspectiveLUT'

    // --- Per-frame uniforms ---
    this._sunDirection = uniform(sunDirection instanceof Vector3 ? sunDirection.clone() : new Vector3(0.0, 1.0, 0.0))

    /** Camera position in km, planet-centred Y-up frame. */
    this._cameraPosKm = uniform(new Vector3(0.0, atmosphereUniforms.bottomRadius.value + 0.001, 0.0))

    /** Camera inverse projection matrix. */
    this._invProj = uniform(new Matrix4())
    /** Camera world matrix (object → world). For ray-direction reconstruction
     *  we only need its rotation; we read its 3×3 implicitly via mat3(mat). */
    this._cameraMatrixWorld = uniform(new Matrix4())

    // --- Build the compute kernel ---
    this._compute = this._buildCompute()
  }

  /** The 3D storage texture; bind as `texture( ap.texture, vec3 uvw )`
   * (NDC.xy + sqrt(slice/resZ) on Z) at consume time. */
  get texture() {
    return this._tex
  }

  /** Camera inverse-projection uniform — kept in sync by `setCamera()`. */
  get invProjUniform() {
    return this._invProj
  }

  /** Camera world-matrix uniform — kept in sync by `setCamera()`. */
  get cameraWorldUniform() {
    return this._cameraMatrixWorld
  }

  /** Camera position (km, planet-centred) uniform — kept in sync by `setCamera()`. */
  get cameraPositionKmUniform() {
    return this._cameraPosKm
  }

  /**
   * Set the sun direction (Y-up world space, normalized). The same vector you
   * pass to `SkyAtmosphereBaker.setSun(...)` works here.
   */
  setSunDirection(v: any) {
    if (v instanceof Vector3) this._sunDirection.value.copy(v)
    else if (Array.isArray(v)) this._sunDirection.value.fromArray(v)
  }

  /**
   * Bind the AP LUT to a Three.js camera. Must be called every frame the
   * camera moves (or its projection changes). The LUT does NOT internally
   * cache `camera` — it only reads matrices at this call.
   *
   * Internally:
   *  - cameraPosKm = true planet-centred camera vector when `planetCenter` is supplied.
   *    Otherwise the legacy flat convention is used:
   *    (0, bottomRadius + camera.y_world_meters · 0.001, 0)
   *  - invProj = camera.projectionMatrixInverse
   *  - cameraMatrixWorld = camera.matrixWorld
   */
  setCamera(camera: any, { planetCenter = null }: SetCameraOptions = {}) {
    camera.updateMatrixWorld()
    camera.updateProjectionMatrix()

    const bottomR = this.atmosphereUniforms.bottomRadius.value // km
    if (planetCenter) {
      this._cameraPosKm.value.copy(camera.position).sub(planetCenter).multiplyScalar(0.001)
    } else {
      this._cameraPosKm.value.set(0.0, bottomR + camera.position.y * 0.001, 0.0)
    }

    this._invProj.value.copy(camera.projectionMatrixInverse)
    this._cameraMatrixWorld.value.copy(camera.matrixWorld)
  }

  /** Dispatch the compute pass. Cheap (~1ms on a mid-tier GPU). */
  async render() {
    await this.renderer.computeAsync(this._compute)
  }

  dispose() {
    this._tex.dispose()
  }

  _buildCompute() {
    const params = this.atmosphereUniforms
    const transmittanceTex = this.transmittanceLUT.texture
    const multiScatterTex = this.multiScatterLUT.texture
    const sunDirU = this._sunDirection
    const cameraPosKmU = this._cameraPosKm
    const invProjU = this._invProj
    const cameraWorldU = this._cameraMatrixWorld
    const tex = this._tex
    const resX = this.resolution.x
    const resY = this.resolution.y
    const resZ = this.resolution.z
    const kmPerSlice = this.kmPerSlice

    const total = resX * resY * resZ

    const fn = Fn(() => {
      // --- decode (x, y, z) from flat instanceIndex ---
      const idx = instanceIndex
      const x = idx.mod(uint(resX))
      const y = idx.div(uint(resX)).mod(uint(resY))
      const z = idx.div(uint(resX * resY))

      const fx = float(x)
      const fy = float(y)
      const fz = float(z)

      // --- screen-space NDC (centre of texel) ---
      // Row y is sampled by the haze post-process at v = uv().y, whose ray
      // reconstruction uses ndc.y = 1 - 2*uv.y (WebGPU v-down screen UV; see
      // the ndc2 comment in HazePostProcess). Row 0 must therefore hold the
      // TOP-of-frustum ray (ndc.y = +1). Building rows bottom-up instead
      // mirrors the whole froxel field about screen centre: bottom-of-screen
      // pixels read upward-tilted rays that integrate through exponentially
      // thinner air, so near-ground haze vanishes and the error tracks
      // camera pitch (invisible at ground level where the view is roughly
      // horizon-symmetric, obvious from altitude).
      const ndcX = fx.add(0.5).div(float(resX)).mul(2.0).sub(1.0)
      const ndcY = float(1.0).sub(fy.add(0.5).div(float(resY)).mul(2.0))

      // --- view-space ray (z = -1 in three.js view space, but we use
      // homogeneous reconstruction via inverse projection at clip-z 0.5) ---
      const clip = vec4(ndcX, ndcY, float(0.5), float(1.0))
      const viewH = invProjU.mul(clip)
      const viewPos = viewH.xyz.div(viewH.w)

      // --- world-space ray direction (rotation only — translation is
      // irrelevant for a direction). mat3(mat4) on a vec3 works in TSL. ---
      const worldDirRaw = cameraWorldU.mul(vec4(viewPos, float(0.0))).xyz
      const worldDir = normalize(worldDirRaw)

      // --- depth slice → tMax (km). Squared distribution: w = (z+0.5)/resZ;
      // slice = w² * resZ; tMax = slice * kmPerSlice. ---
      const w = fz.add(0.5).div(float(resZ))
      const sliceLin = w.mul(w).mul(float(resZ))
      const tMax = sliceLin.mul(float(kmPerSlice)).toVar()

      // --- camera position (already in planet-centred km Y-up) ---
      const camPosKm = cameraPosKmU.toVar()

      // --- SebH RenderCameraVolumePS underground-froxel correction:
      // when a voxel endpoint falls below the planet surface, push it back
      // up onto the ground shell, then recompute worldDir and tMax.
      // HLSL ref: RenderSkyRayMarching.hlsl ~lines 668-680.
      // Without this, voxels behind the horizon integrate through *rock*
      // and produce a hard alpha cliff at the horizon (visible in
      // ?debug=ap-alpha as a sharp black band). ---
      const PLANET_RADIUS_OFFSET = 0.01
      const minHeight = params.bottomRadius.add(float(PLANET_RADIUS_OFFSET))

      const worldDirV = worldDir.toVar()
      const newWorldPos = camPosKm.add(worldDirV.mul(tMax)).toVar()
      const newViewHeight = length(newWorldPos)
      const belowGround = newViewHeight.lessThanEqual(minHeight)

      // Push the endpoint onto the ground shell (slightly above, matching SebH).
      const groundShellHeight = minHeight.add(float(0.001))
      const groundedPos = normalize(newWorldPos).mul(groundShellHeight)
      const correctedDir = normalize(groundedPos.sub(camPosKm))
      const correctedT = length(groundedPos.sub(camPosKm))

      worldDirV.assign(select(belowGround, correctedDir, worldDirV))
      tMax.assign(select(belowGround, correctedT, tMax))

      // --- move ray-march start onto atmosphere boundary if camera is in space ---
      const moved = moveToTopAtmosphere(camPosKm, worldDirV, params)
      const startPos = moved.newPos.toVar()

      // Per-voxel jitter — same rationale as the post-process raymarch
      // (HazePostProcess): a fixed sample-segment offset makes every voxel's
      // quadrature error coherent, and because dt varies per slice the error
      // aligns into slice-frequency bands (concentric iso-distance arcs when
      // viewed from altitude). A voxel-index hash decorrelates it.
      const hash01 = fract(sin(dot(vec2(fx.add(fz.mul(37.0)), fy), vec2(12.9898, 78.233))).mul(43758.5453))

      // --- integrate (with multi-scatter feedback this time) ---
      const result = integrateScatteredLuminance({
        worldPos: startPos,
        worldDir: worldDirV,
        sunDir: normalize(sunDirU),
        params: params,
        transmittanceLUT: transmittanceTex,
        multiScatterLUT: multiScatterTex,
        // 30 fixed samples means up to ~33 km steps on the far slices at
        // 32 km/slice coverage, with per-slice-varying quadrature error.
        // 64 matches the haze raymarch fallback the planet demo validates
        // against. (SebH scales per slice — 2*(sliceId+1), RenderSkyRay-
        // Marching.hlsl:707 — worth adopting if Loop gains node bounds.)
        sampleCount: 64,
        ground: false,
        mieRayPhase: true,
        tMaxOverride: tMax,
        sampleJitter: hash01,
      })

      // Mean transmittance (HLSL line 714) → alpha = 1 - meanT so consumer
      // can do `sceneColor * (1 - alpha) + rgb` straightforwardly.
      const meanT = result.transmittance.x.add(result.transmittance.y).add(result.transmittance.z).div(3.0)
      const alpha = float(1.0).sub(meanT)

      // If the ray missed the atmosphere entirely (possible at very high
      // altitudes), zero out — the consumer treats alpha=0 as "no haze".
      const validF = moved.valid.select(float(1.0), float(0.0))

      textureStore(tex, ivec3(int(x), int(y), int(z)), vec4(result.L.mul(validF), alpha.mul(validF)))
    })

    return fn().compute(total, [4, 4, 4])
  }
}
