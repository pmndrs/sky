/**
 * Host for Sébastien Hillaire's reference sky — the WebGPU stand-in for the
 * D3D11 frame in his Game.cpp / RenderSky.cpp. His shaders run unmodified
 * (compiled to WGSL by scripts/build-sebh-wgsl.mjs); this file only does what
 * his C++ does: fill the two constant buffers, allocate the LUTs in his
 * formats, and issue his passes in his order.
 *
 * It runs on its own GPUDevice so nothing here can disturb three's renderer.
 *
 * Conventions (all his):
 *   - world is Z-up, kilometres, origin on the ground under the camera
 *     (shaders add BottomRadius), view space is left-handed (LookAtLH / FovLH)
 *   - gSunIlluminance scales the Sky-View LUT and the per-pixel integrator;
 *     only the multi-scattering LUT is built with ILLUMINANCE_IS_ONE
 *   - PostProcessPS: pow(1 - exp(-L / whitePoint * 10), 1/2.2)
 *
 * Deviations, each forced by WebGPU and each numerically neutral:
 *   - Sky-View LUT is rgba16float (his R11G11B10_FLOAT: more precision here)
 *   - the AP camera volume is filled one slice per pass (no geometry shader)
 *   - the path tracer accumulates into rgba32float with additive blending,
 *     which needs the `float32-blendable` feature
 */
import manifest from './generated/manifest.json'
import blueNoiseUrl from './generated/bluenoise64.bin?url'

const SOURCES = import.meta.glob('./generated/*.wgsl', { query: '?raw', import: 'default', eager: true })
const source = (name) => SOURCES[`./generated/${manifest.entries[name].file}`]

const TRANSMITTANCE = { width: 256, height: 64 }
const MULTISCAT_RES = 32
const SKYVIEW = { width: 192, height: 108 }
const AP_RES = 32
const HDR_FORMAT = 'rgba16float'
const PT_FORMAT = 'rgba32float'

/**
 * SetupEarthAtmosphere() (SkyAtmosphereCommon.cpp), in the field names
 * @pmndrs/sky uses, so one object can drive both renderers.
 */
export const SEBH_EARTH = Object.freeze({
  bottomRadius: 6360,
  topRadius: 6460,
  rayleighScattering: [0.005802, 0.013558, 0.0331],
  rayleighDensityExpScale: -1 / 8,
  mieScattering: [0.003996, 0.003996, 0.003996],
  mieExtinction: [0.00444, 0.00444, 0.00444],
  miePhaseG: 0.8,
  mieDensityExpScale: -1 / 1.2,
  absorptionExtinction: [0.00065, 0.001881, 0.000085],
  absorptionDensity0LayerWidth: 25,
  absorptionDensity0ConstantTerm: -2 / 3,
  absorptionDensity0LinearTerm: 1 / 15,
  absorptionDensity1ConstantTerm: 8 / 3,
  absorptionDensity1LinearTerm: -1 / 15,
  groundAlbedo: [0, 0, 0],
  multiScatteringFactor: 1,
})

// PostProcess.hlsl — "similar setup to the Bruneton demo".
export const SEBH_WHITE_POINT = [1.08241, 0.96756, 0.95003]
export const SEBH_EXPOSURE = 10

const vec3 = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v.x, v.y, v.z] : [v, v, v])

// ---------------------------------------------------------------------------
// Matrices: column-vector convention, stored row by row (the build compiles
// with -matrix-layout-row-major, so HLSL mul(M, v) sees exactly this M).
// ---------------------------------------------------------------------------
const mat = {
  mul(a, b) {
    const o = new Float64Array(16)
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++) {
        let s = 0
        for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]
        o[r * 4 + c] = s
      }
    return o
  },
  invert(m) {
    const a = Array.from(m)
    const inv = new Float64Array(16)
    for (let i = 0; i < 16; i++) inv[i] = i % 5 === 0 ? 1 : 0
    for (let c = 0; c < 4; c++) {
      let p = c
      for (let r = c + 1; r < 4; r++) if (Math.abs(a[r * 4 + c]) > Math.abs(a[p * 4 + c])) p = r
      for (let k = 0; k < 4; k++) {
        ;[a[c * 4 + k], a[p * 4 + k]] = [a[p * 4 + k], a[c * 4 + k]]
        ;[inv[c * 4 + k], inv[p * 4 + k]] = [inv[p * 4 + k], inv[c * 4 + k]]
      }
      const d = a[c * 4 + c]
      for (let k = 0; k < 4; k++) {
        a[c * 4 + k] /= d
        inv[c * 4 + k] /= d
      }
      for (let r = 0; r < 4; r++) {
        if (r === c) continue
        const f = a[r * 4 + c]
        for (let k = 0; k < 4; k++) {
          a[r * 4 + k] -= f * a[c * 4 + k]
          inv[r * 4 + k] -= f * inv[c * 4 + k]
        }
      }
    }
    return inv
  },
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const normalize = (a) => {
  const l = Math.hypot(a[0], a[1], a[2])
  return [a[0] / l, a[1] / l, a[2] / l]
}

/**
 * His direction convention (Game.cpp: RollPitchYaw(-pitch, yaw, 0).r[2] with
 * y/z swapped): elevation above the horizon, azimuth from +Y toward +X.
 */
export function sebhDirection(elevationDeg, azimuthDeg) {
  const e = (elevationDeg * Math.PI) / 180
  const a = (azimuthDeg * Math.PI) / 180
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)]
}

// IEEE half → float
const HALF = new Float32Array(65536)
for (let h = 0; h < 65536; h++) {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const f = h & 0x3ff
  HALF[h] =
    e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024)
}

export class SebhReference {
  /**
   * @param {{ canvas?: HTMLCanvasElement }} [opts] canvas to present into (optional: headless LUT use)
   */
  static async create({ canvas } = {}) {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('SebhReference: no WebGPU adapter')
    const want = ['float32-blendable', 'float32-filterable'].filter((f) => adapter.features.has(f))
    const device = await adapter.requestDevice({ requiredFeatures: want })
    const noise = await (await fetch(blueNoiseUrl)).arrayBuffer()
    const ref = new SebhReference(device, canvas, new Float32Array(noise))
    const { vendor, architecture, description } = adapter.info ?? {}
    ref.adapterInfo = { vendor, architecture, description }
    return ref
  }

  constructor(device, canvas, blueNoise) {
    this.device = device
    this.canvas = canvas ?? null
    this.canPathTrace = device.features.has('float32-blendable')
    this.errors = []
    device.addEventListener('uncapturederror', (e) => {
      this.errors.push(e.error.message)
      console.error('[sebh]', e.error.message)
    })

    if (canvas) {
      this.context = canvas.getContext('webgpu')
      this.presentFormat = navigator.gpu.getPreferredCanvasFormat()
      this.context.configure({ device, format: this.presentFormat, alphaMode: 'opaque' })
    }

    // Shared state, in his units. Callers mutate through the setters.
    this.atmosphere = { ...SEBH_EARTH }
    this.sunDirection = sebhDirection(25.8, 0) // Game.h: uiSunPitch 0.45 rad
    this.camera = { position: [0, 0, 0.5], viewDir: [0, 1, 0], fovYDeg: 66.6, near: 0.1, far: 20000 }
    this.sunIlluminance = 1 // Game.h: mSunIlluminanceScale
    this.showSunDisc = true
    this.pathMaxDepth = 12 // gScatteringMaxPathDepth; his UI default is 4
    this.rayMarchMinMaxSPP = [4, 14] // Game.h: uiViewRayMarchMin/MaxSPP

    this.width = 0
    this.height = 0
    this._ptFrame = 0
    this._ptKey = ''

    this._createStatic(blueNoise)
    this._createPipelines()
  }

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------
  _createStatic(blueNoise) {
    const d = this.device
    const T = GPUTextureUsage
    const tex2d = (w, h, format, usage, label) => d.createTexture({ size: [w, h], format, usage, label })

    this.transmittance = tex2d(
      TRANSMITTANCE.width,
      TRANSMITTANCE.height,
      'rgba16float',
      T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | T.COPY_SRC,
      'sebh transmittance',
    )
    this.multiScat = tex2d(
      MULTISCAT_RES,
      MULTISCAT_RES,
      'rgba16float',
      T.STORAGE_BINDING | T.TEXTURE_BINDING | T.COPY_SRC,
      'sebh multi-scattering',
    )
    this.skyView = tex2d(
      SKYVIEW.width,
      SKYVIEW.height,
      'rgba16float',
      T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | T.COPY_SRC,
      'sebh sky-view',
    )
    this.apVolume = d.createTexture({
      size: [AP_RES, AP_RES, AP_RES],
      dimension: '3d',
      format: 'rgba16float',
      usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | T.COPY_SRC,
      label: 'sebh AP volume',
    })
    // RenderTransmittanceLutPS declares TransmittanceLutTexture (the integrator
    // samples it for L, which that pass discards) while writing the LUT. His
    // C++ leaves t2 as a null SRV there, which reads as zero; WebGPU forbids
    // binding the attachment itself, so bind an explicit zero texel instead.
    this.nullTexture = tex2d(1, 1, 'rgba16float', T.TEXTURE_BINDING, 'sebh null SRV')
    this.blueNoise = tex2d(64, 64, 'r32float', T.TEXTURE_BINDING | T.COPY_DST, 'sebh blue noise')
    d.queue.writeTexture({ texture: this.blueNoise }, blueNoise, { bytesPerRow: 64 * 4 }, [64, 64])

    // His SamplerLinear: MIN_MAG_MIP_LINEAR, clamp.
    this.sampler = d.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    })

    const cb = (name, label) =>
      d.createBuffer({
        size: manifest.cbuffers[name].size,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label,
      })
    this.cbSky = cb('SKYATMOSPHERE_BUFFER', 'SKYATMOSPHERE_BUFFER')
    // His C++ rewrites CONSTANT_BUFFER.gResolution between passes on an
    // immediate context; a WebGPU submit sees only the last write, so each
    // resolution gets its own buffer.
    this.cbFrame = cb('CONSTANT_BUFFER', 'CONSTANT_BUFFER frame')
    this.cbVolume = cb('CONSTANT_BUFFER', 'CONSTANT_BUFFER AP volume')
    this.sliceCbs = Array.from({ length: AP_RES }, (_, i) => {
      const b = cb('SliceCB', `SliceCB ${i}`)
      d.queue.writeBuffer(b, 0, new Uint32Array([i, 0, 0, 0]))
      return b
    })
  }

  /** (Re)allocate the resolution-dependent targets. */
  resize(width, height) {
    width = Math.max(1, Math.floor(width))
    height = Math.max(1, Math.floor(height))
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    for (const t of [this.hdr, this.depth, this.ptLum, this.ptTrans, this.ldr, this.oursLdr]) t?.destroy()
    const d = this.device
    const T = GPUTextureUsage
    const tex = (format, usage, label) => d.createTexture({ size: [width, height], format, usage, label })
    this.hdr = tex(HDR_FORMAT, T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | T.COPY_SRC, 'sebh HDR back buffer')
    // No geometry in this harness: the depth buffer is cleared to 1 (sky) and
    // read by his shaders as ViewDepthTexture[pixPos].r.
    this.depth = tex('r32float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING, 'sebh view depth')
    this.ptLum = tex(PT_FORMAT, T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | T.COPY_SRC, 'sebh PT luminance')
    this.ptTrans = tex(PT_FORMAT, T.RENDER_ATTACHMENT | T.TEXTURE_BINDING, 'sebh PT transmittance')
    if (this.canvas) {
      this.ldr = tex(this.presentFormat, T.RENDER_ATTACHMENT | T.TEXTURE_BINDING, 'sebh post-processed')
      this.oursLdr = tex('rgba8unorm', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | T.COPY_DST, 'ours (for diff)')
      this.canvas.width = width
      this.canvas.height = height
    }
    this._bindGroups = null
    this._ptKey = ''
  }

  // -------------------------------------------------------------------------
  // Pipelines — layout 'auto'; bind groups are built from the manifest, which
  // lists exactly the bindings Slang kept for each entry.
  // -------------------------------------------------------------------------
  _createPipelines() {
    const d = this.device
    const vs = d.createShaderModule({ code: source('ScreenTriangleVS'), label: 'ScreenTriangleVS' })
    const vertex = { module: vs, entryPoint: manifest.entries.ScreenTriangleVS.entry }
    const frag = (name, targets) => {
      const m = manifest.entries[name]
      return d.createRenderPipeline({
        label: name,
        layout: 'auto',
        vertex,
        fragment: { module: d.createShaderModule({ code: source(name), label: name }), entryPoint: m.entry, targets },
        primitive: { topology: 'triangle-list' },
      })
    }
    // BlendState::initPreMultBlendState with alpha forced to keep dst (Game.cpp:401).
    const premult = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    }
    const add = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    }
    this.pipelines = {
      transmittance: frag('TransmittanceLutPS', [{ format: 'rgba16float' }]),
      skyView: frag('SkyViewLutPS', [{ format: 'rgba16float' }]),
      cameraVolume: frag('CameraVolumeSlicePS', [{ format: 'rgba16float' }]),
      rayMarchFast: frag('RayMarchingFastPS', [{ format: HDR_FORMAT, blend: premult }]),
      rayMarchFull: frag('RayMarchingFullPS', [{ format: HDR_FORMAT, blend: premult }]),
      // SV_TARGET1 (transmittance) feeds a dual-source blend over opaque
      // geometry in his demo; with no geometry it has nowhere to go.
      applyPathTracing: frag('ApplySkyAtmospherePS', [{ format: HDR_FORMAT }]),
      multiScat: d.createComputePipeline({
        label: 'MultiScattCS',
        layout: 'auto',
        compute: {
          module: d.createShaderModule({ code: source('MultiScattCS'), label: 'MultiScattCS' }),
          entryPoint: manifest.entries.MultiScattCS.entry,
        },
      }),
    }
    if (this.canPathTrace) {
      this.pipelines.pathTrace = frag('PathTracingPS', [
        { format: PT_FORMAT, blend: add },
        { format: PT_FORMAT, blend: add },
      ])
      this.pipelines.pathTraceGroundGi = frag('PathTracingGroundGiPS', [
        { format: PT_FORMAT, blend: add },
        { format: PT_FORMAT, blend: add },
      ])
    }
    if (this.canvas) {
      this.pipelines.post = frag('PostProcessPS', [{ format: this.presentFormat }])
      // Page-side presentation (not his code): his post-processed image, or
      // |his − ours| × gain against a copy of our canvas.
      const presentModule = d.createShaderModule({ code: PRESENT_WGSL, label: 'present' })
      this.pipelines.present = d.createRenderPipeline({
        label: 'present',
        layout: 'auto',
        vertex: { module: presentModule, entryPoint: 'vs' },
        fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format: this.presentFormat }] },
      })
      this.presentUniform = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    }
  }

  _resources(cbCommon) {
    return {
      CONSTANT_BUFFER: { buffer: cbCommon },
      SKYATMOSPHERE_BUFFER: { buffer: this.cbSky },
      TransmittanceLutTexture: this.transmittance.createView(),
      MultiScatTexture: this.multiScat.createView(),
      SkyViewLutTexture: this.skyView.createView(),
      ViewDepthTexture: this.depth?.createView(),
      AtmosphereCameraScatteringVolume: this.apVolume.createView({ dimension: '3d' }),
      BlueNoise2dTexture: this.blueNoise.createView(),
      samplerLinearClamp: this.sampler,
      OutputTexture: this.multiScat.createView(),
      PathtracingLuminanceTexture: this.ptLum?.createView(),
      PathtracingTransmittanceTexture: this.ptTrans?.createView(),
      texture2d: this.hdr?.createView(),
    }
  }

  _bindGroup(pipeline, entryName, extra = {}, cbCommon = this.cbFrame) {
    const res = { ...this._resources(cbCommon), ...extra }
    const entries = manifest.entries[entryName].bindings.map((b) => {
      const r = res[b.name]
      if (!r) throw new Error(`sebh: no resource for ${entryName}.${b.name}`)
      return { binding: b.binding, resource: r }
    })
    return this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries, label: entryName })
  }

  _ensureBindGroups() {
    if (this._bindGroups) return this._bindGroups
    const p = this.pipelines
    const g = {
      transmittance: this._bindGroup(p.transmittance, 'TransmittanceLutPS', {
        TransmittanceLutTexture: this.nullTexture.createView(),
      }),
      multiScat: this._bindGroup(p.multiScat, 'MultiScattCS'),
      skyView: this._bindGroup(p.skyView, 'SkyViewLutPS'),
      cameraVolume: this.sliceCbs.map((buffer) =>
        this._bindGroup(p.cameraVolume, 'CameraVolumeSlicePS', { SliceCB: { buffer } }, this.cbVolume),
      ),
      rayMarchFast: this._bindGroup(p.rayMarchFast, 'RayMarchingFastPS'),
      rayMarchFull: this._bindGroup(p.rayMarchFull, 'RayMarchingFullPS'),
      applyPathTracing: this._bindGroup(p.applyPathTracing, 'ApplySkyAtmospherePS'),
    }
    if (p.pathTrace) {
      g.pathTrace = this._bindGroup(p.pathTrace, 'PathTracingPS')
      g.pathTraceGroundGi = this._bindGroup(p.pathTraceGroundGi, 'PathTracingGroundGiPS')
    }
    if (p.post) g.post = this._bindGroup(p.post, 'PostProcessPS')
    this._bindGroups = g
    return g
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  /** Partial atmosphere in @pmndrs/sky field names (arrays, Vector3s or scalars). */
  setAtmosphere(partial) {
    this.atmosphere = { ...this.atmosphere, ...partial }
  }

  setSun(directionZup) {
    this.sunDirection = normalize(directionZup)
  }

  /** @param {{ position?: number[], viewDir?: number[], fovYDeg?: number, near?: number, far?: number }} cam his frame, km */
  setCamera(cam) {
    this.camera = { ...this.camera, ...cam, viewDir: normalize(cam.viewDir ?? this.camera.viewDir) }
  }

  /** Matrices as Game::update builds them (LookAtLH + PerspectiveFovLH, Z-up). */
  _matrices() {
    const { position: eye, viewDir: f, fovYDeg, near, far } = this.camera
    const up = [0, 0, 1]
    const x = normalize(cross(up, f))
    const y = cross(f, x)
    const view = [
      x[0],
      x[1],
      x[2],
      -dot(x, eye),
      y[0],
      y[1],
      y[2],
      -dot(y, eye),
      f[0],
      f[1],
      f[2],
      -dot(f, eye),
      0,
      0,
      0,
      1,
    ]
    const ys = 1 / Math.tan(((fovYDeg * Math.PI) / 180) * 0.5)
    const xs = ys / (this.width / this.height)
    const q = far / (far - near)
    const proj = [xs, 0, 0, 0, 0, ys, 0, 0, 0, 0, q, -near * q, 0, 0, 1, 0]
    const viewProj = mat.mul(proj, view)
    return {
      viewProj,
      invViewProj: mat.invert(viewProj),
      invProj: mat.invert(proj),
      invView: mat.invert(view),
    }
  }

  _writeCb(buffer, layoutName, values) {
    const layout = manifest.cbuffers[layoutName]
    const bytes = new ArrayBuffer(layout.size)
    const f32 = new Float32Array(bytes)
    const u32 = new Uint32Array(bytes)
    const i32 = new Int32Array(bytes)
    for (const [name, v] of Object.entries(values)) {
      const field = layout.fields[name]
      if (!field) throw new Error(`sebh: ${layoutName} has no field ${name}`)
      const at = field.offset / 4
      const arr = typeof v === 'number' ? [v] : Array.from(v)
      const view = field.scalar === 'uint32' ? u32 : field.scalar === 'int32' ? i32 : f32
      for (let i = 0; i < arr.length; i++) view[at + i] = arr[i]
    }
    this.device.queue.writeBuffer(buffer, 0, bytes)
  }

  _writeConstants() {
    const a = this.atmosphere
    const m = this._matrices()
    const mieExt = vec3(a.mieExtinction)
    const mieScat = vec3(a.mieScattering)
    // Bruneton-style density layers {width, exp_term, exp_scale, linear, constant}
    // ×2, padded to 3 float4 — what GetAtmosphereParameters() unpacks.
    const layers = (l0, l1) => [...l0, ...l1, 0, 0]
    this._writeCb(this.cbSky, 'SKYATMOSPHERE_BUFFER', {
      solar_irradiance: [1, 1, 1],
      sun_angular_radius: 0.004675,
      absorption_extinction: vec3(a.absorptionExtinction),
      mu_s_min: Math.cos((120 * Math.PI) / 180),
      rayleigh_scattering: vec3(a.rayleighScattering),
      mie_phase_function_g: a.miePhaseG,
      mie_scattering: mieScat,
      bottom_radius: a.bottomRadius,
      mie_extinction: mieExt,
      top_radius: a.topRadius,
      mie_absorption: mieExt.map((e, i) => Math.max(0, e - mieScat[i])),
      ground_albedo: vec3(a.groundAlbedo),
      rayleigh_density: layers([0, 0, 0, 0, 0], [0, 1, a.rayleighDensityExpScale, 0, 0]),
      mie_density: layers([0, 0, 0, 0, 0], [0, 1, a.mieDensityExpScale, 0, 0]),
      absorption_density: layers(
        [a.absorptionDensity0LayerWidth, 0, 0, a.absorptionDensity0LinearTerm, a.absorptionDensity0ConstantTerm],
        [0, 0, 0, a.absorptionDensity1LinearTerm, a.absorptionDensity1ConstantTerm],
      ),
      TRANSMITTANCE_TEXTURE_WIDTH: TRANSMITTANCE.width,
      TRANSMITTANCE_TEXTURE_HEIGHT: TRANSMITTANCE.height,
      SKY_SPECTRAL_RADIANCE_TO_LUMINANCE: [114974.916437, 71305.954816, 65310.548555],
      SUN_SPECTRAL_RADIANCE_TO_LUMINANCE: [98242.786222, 69954.398112, 66475.012354],
      gSkyViewProjMat: m.viewProj,
      gSkyInvViewProjMat: m.invViewProj,
      gSkyInvProjMat: m.invProj,
      gSkyInvViewMat: m.invView,
      gShadowmapViewProjMat: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      camera: this.camera.position,
      sun_direction: this.sunDirection,
      view_ray: this.camera.viewDir,
      MultipleScatteringFactor: a.multiScatteringFactor ?? 1,
      MultiScatteringLUTRes: MULTISCAT_RES,
    })
    const common = (res) => ({
      gColor: [0, 1, 1, 1],
      gSunIlluminance: [this.sunIlluminance, this.sunIlluminance, this.sunIlluminance],
      gScatteringMaxPathDepth: this.pathMaxDepth,
      gResolution: res,
      gFrameId: this._ptFrame,
      // Far outside any pixel: keeps his GPU-debug-line path off.
      gMouseLastDownPos: [0xfffffff, 0xfffffff],
      gScreenshotCaptureActive: this.showSunDisc ? 0 : 1,
      RayMarchMinMaxSPP: this.rayMarchMinMaxSPP,
    })
    this._writeCb(this.cbFrame, 'CONSTANT_BUFFER', common([this.width, this.height]))
    this._writeCb(this.cbVolume, 'CONSTANT_BUFFER', common([AP_RES, AP_RES]))
  }

  // -------------------------------------------------------------------------
  // Passes (RenderSky.cpp)
  // -------------------------------------------------------------------------
  _fullscreen(enc, view, pipeline, bindGroup, { clear, depthSlice } = {}) {
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view,
          depthSlice,
          loadOp: clear ? 'clear' : 'load',
          clearValue: clear ?? [0, 0, 0, 0],
          storeOp: 'store',
        },
      ],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(3)
    pass.end()
  }

  _renderLuts(enc, g, { skyView = true, cameraVolume = true, multiScat = true } = {}) {
    const p = this.pipelines
    this._fullscreen(enc, this.transmittance.createView(), p.transmittance, g.transmittance, { clear: [0, 0, 0, 0] })
    if (multiScat) {
      // Dispatch(32, 32, 1) with [numthreads(1, 1, 64)]: one group per texel.
      const c = enc.beginComputePass()
      c.setPipeline(p.multiScat)
      c.setBindGroup(0, g.multiScat)
      c.dispatchWorkgroups(MULTISCAT_RES, MULTISCAT_RES, 1)
      c.end()
    }
    if (skyView) this._fullscreen(enc, this.skyView.createView(), p.skyView, g.skyView, { clear: [0, 0, 0, 0] })
    if (cameraVolume) {
      const view = this.apVolume.createView({ dimension: '3d' })
      for (let s = 0; s < AP_RES; s++) {
        this._fullscreen(enc, view, p.cameraVolume, g.cameraVolume[s], { clear: [0, 0, 0, 0], depthSlice: s })
      }
    }
  }

  _clearFrame(enc) {
    // Game::render: HDR cleared to (0,0,0,1), depth to 1.
    for (const [view, value] of [
      [this.hdr.createView(), [0, 0, 0, 1]],
      [this.depth.createView(), [1, 0, 0, 0]],
    ]) {
      enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', clearValue: value, storeOp: 'store' }] }).end()
    }
  }

  /**
   * Render one frame into the HDR buffer.
   * @param {'lut' | 'raymarch' | 'pathtrace'} method
   *   lut       — his default: Sky-View LUT for sky pixels, AP volume otherwise
   *   raymarch  — RenderRayMarchingPS with both LUT shortcuts off (per pixel)
   *   pathtrace — his path tracer, accumulated across calls until state changes
   */
  render(method = 'lut') {
    if (!this.width) throw new Error('sebh: call resize() first')
    if (method === 'pathtrace') {
      if (!this.canPathTrace) throw new Error('sebh: path tracing needs the float32-blendable feature')
      const key = JSON.stringify([
        this.atmosphere,
        this.sunDirection,
        this.camera,
        this.sunIlluminance,
        this.showSunDisc,
        this.pathMaxDepth,
        this.width,
        this.height,
      ])
      if (key !== this._ptKey) {
        this._ptKey = key
        this._ptFrame = 0
      }
    }
    this._writeConstants()
    const g = this._ensureBindGroups()
    const enc = this.device.createCommandEncoder({ label: `sebh ${method}` })
    this._clearFrame(enc)
    const p = this.pipelines

    if (method === 'lut') {
      this._renderLuts(enc, g)
      this._fullscreen(enc, this.hdr.createView(), p.rayMarchFast, g.rayMarchFast)
    } else if (method === 'raymarch') {
      this._renderLuts(enc, g, { skyView: false, cameraVolume: false })
      this._fullscreen(enc, this.hdr.createView(), p.rayMarchFull, g.rayMarchFull)
    } else {
      // Transmittance LUT only (TRANSMITANCE_METHOD 2); no MS approximation.
      this._renderLuts(enc, g, { skyView: false, cameraVolume: false, multiScat: false })
      const albedo = vec3(this.atmosphere.groundAlbedo)
      const gi = albedo.some((v) => v !== 0)
      const first = this._ptFrame === 0
      const load = (view) => ({ view, loadOp: first ? 'clear' : 'load', clearValue: [0, 0, 0, 0], storeOp: 'store' })
      const pass = enc.beginRenderPass({
        colorAttachments: [load(this.ptLum.createView()), load(this.ptTrans.createView())],
      })
      pass.setPipeline(gi ? p.pathTraceGroundGi : p.pathTrace)
      pass.setBindGroup(0, gi ? g.pathTraceGroundGi : g.pathTrace)
      pass.draw(3)
      pass.end()
      this._ptFrame++
      this._fullscreen(enc, this.hdr.createView(), p.applyPathTracing, g.applyPathTracing)
    }
    this.device.queue.submit([enc.finish()])
  }

  /** Samples accumulated by the path tracer since its last reset. */
  get pathTracedSamples() {
    return this._ptFrame
  }

  /**
   * Present into the canvas: his PostProcessPS, or |his − ours| × gain.
   * @param {{ diffAgainst?: CanvasImageSource, gain?: number }} [opts]
   */
  present({ diffAgainst, gain = 4 } = {}) {
    if (!this.canvas) return
    const g = this._ensureBindGroups()
    const d = this.device
    const enc = d.createCommandEncoder({ label: 'sebh present' })
    if (!diffAgainst) {
      this._fullscreen(enc, this.context.getCurrentTexture().createView(), this.pipelines.post, g.post, {
        clear: [0, 0, 0, 1],
      })
      d.queue.submit([enc.finish()])
      return
    }
    d.queue.copyExternalImageToTexture({ source: diffAgainst }, { texture: this.oursLdr }, [this.width, this.height])
    this._fullscreen(enc, this.ldr.createView(), this.pipelines.post, g.post, { clear: [0, 0, 0, 1] })
    d.queue.writeBuffer(this.presentUniform, 0, new Float32Array([gain, 0, 0, 0]))
    const bg = d.createBindGroup({
      layout: this.pipelines.present.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.ldr.createView() },
        { binding: 1, resource: this.oursLdr.createView() },
        { binding: 2, resource: { buffer: this.presentUniform } },
      ],
    })
    this._fullscreen(enc, this.context.getCurrentTexture().createView(), this.pipelines.present, bg, {
      clear: [0, 0, 0, 1],
    })
    d.queue.submit([enc.finish()])
  }

  // -------------------------------------------------------------------------
  // Readback
  // -------------------------------------------------------------------------
  /**
   * Read a texture back as RGBA float32, rows top-down (texel (0,0) first).
   * @returns {Promise<{ width: number, height: number, depth: number, data: Float32Array }>}
   */
  async readTexture(texture) {
    const { width, height, depthOrArrayLayers: depth, format } = texture
    const bpp = format === 'rgba32float' ? 16 : format === 'rgba16float' ? 8 : 4
    const bytesPerRow = Math.ceil((width * bpp) / 256) * 256
    const buf = this.device.createBuffer({
      size: bytesPerRow * height * depth,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const enc = this.device.createCommandEncoder()
    enc.copyTextureToBuffer({ texture }, { buffer: buf, bytesPerRow, rowsPerImage: height }, [width, height, depth])
    this.device.queue.submit([enc.finish()])
    await buf.mapAsync(GPUMapMode.READ)
    const raw = buf.getMappedRange()
    const out = new Float32Array(width * height * depth * 4)
    for (let z = 0; z < depth; z++) {
      for (let y = 0; y < height; y++) {
        const row = (z * height + y) * bytesPerRow
        const o = (z * height + y) * width * 4
        if (format === 'rgba32float') {
          out.set(new Float32Array(raw, row, width * 4), o)
        } else if (format === 'rgba16float') {
          const h = new Uint16Array(raw, row, width * 4)
          for (let i = 0; i < h.length; i++) out[o + i] = HALF[h[i]]
        } else {
          throw new Error(`sebh: readTexture does not handle ${format}`)
        }
      }
    }
    buf.unmap()
    buf.destroy()
    return { width, height, depth, data: out }
  }

  /** Linear HDR of the last frame (path-traced: normalised by sample count). */
  async readFrame(method = 'lut') {
    if (method !== 'pathtrace') return this.readTexture(this.hdr)
    const img = await this.readTexture(this.ptLum)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      const w = d[i + 3] || 1
      d[i] /= w
      d[i + 1] /= w
      d[i + 2] /= w
      d[i + 3] = 1
    }
    return img
  }

  destroy() {
    this.device.destroy()
  }
}

// Page-side presentation shader (not part of his code).
const PRESENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var his : texture_2d<f32>;
@group(0) @binding(1) var ours : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u : vec4<f32>;
@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
  let p = array(vec2(-1.0, -1.0), vec2(-1.0, 3.0), vec2(3.0, -1.0));
  return vec4(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
  let c = vec2<i32>(pos.xy);
  let a = textureLoad(his, c, 0).rgb;
  let b = textureLoad(ours, c, 0).rgb;
  return vec4(abs(a - b) * u.x, 1.0);
}
`
