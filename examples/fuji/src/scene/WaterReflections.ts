import { SkyPmrem } from '@pmndrs/sky'
import type { useSky } from '@pmndrs/sky/react'
import {
  CubeCamera,
  CubeRenderTarget,
  HalfFloatType,
  LinearMipmapLinearFilter,
  Matrix4,
  PerspectiveCamera,
  PMREMGenerator,
  RenderPipeline,
  RenderTarget,
  Vector2,
  Vector3,
  type ClippingGroup,
  type Mesh,
  type Scene,
  type WebGPURenderer,
  type NodeBuilder,
  type Node,
  type NodeFrame,
} from 'three/webgpu'
import {
  Fn,
  cameraPosition,
  float,
  normalWorld,
  pass,
  pmremTexture,
  positionWorld,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'

/** Static scene captures; animated waves only resample the cached textures.
 * Cube IBL handles offscreen directions. A mirrored camera preserves parallax
 * for docks/blocks instead of projecting a single probe onto the entire bay.
 */
export class WaterReflections {
  readonly cube = new CubeRenderTarget(256, {
    type: HalfFloatType,
    generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter,
  })
  readonly cubeCamera = new CubeCamera(0.1, 110000, this.cube)
  readonly planar = new RenderTarget(1, 1, {
    type: HalfFloatType,
    generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter,
  })
  readonly mirror = new PerspectiveCamera()
  readonly projection = uniform(new Matrix4())
  readonly ready = uniform(0)
  readonly maxMip = uniform(0)
  readonly pmrem: SkyPmrem
  readonly envNode
  private pipelines: ReturnType<WaterReflections['makePipeline']>[] = []
  private planarPipeline: ReturnType<WaterReflections['makePipeline']>
  private generator: PMREMGenerator | null = null
  private cubeDirty = true
  private planarDirty = true
  private compiled = false
  private disposed = false
  private cameraMatrix = new Matrix4()
  private cameraProjection = new Matrix4()
  private size = new Vector2()
  private drawingSize = new Vector2()
  private unsubscribe: () => void
  private cubeCaptures = 0
  private planarCaptures = 0

  constructor(
    private renderer: WebGPURenderer,
    private scene: Scene,
    private sky: NonNullable<ReturnType<typeof useSky>>,
  ) {
    this.cubeCamera.coordinateSystem = renderer.coordinateSystem
    this.cubeCamera.updateCoordinateSystem()
    this.cubeCamera.position.set(0, 1, 0)
    this.cubeCamera.updateMatrixWorld(true)
    this.pmrem = new SkyPmrem(renderer, () => (this.generator ??= new PMREMGenerator(renderer)), this.cube.texture, {
      generator: 'sky',
      quality: 'fast',
    })
    this.pmrem.ready.then(() => {
      if (!this.disposed) this.compiled = true
    })
    this.unsubscribe = sky.baker.addBakeListener(() => this.invalidate())
    this.pipelines = this.cubeCamera.children.map((camera) => this.makePipeline(camera as PerspectiveCamera, true))
    this.planarPipeline = this.makePipeline(this.mirror)

    const cubeSample = pmremTexture(this.pmrem.texture!)
    // EnvironmentNode invokes this for both radiance and irradiance. Its
    // irradiance query has roughness=1 and stays on the filtered cube.
    this.envNode = Fn((_: unknown[], builder: NodeBuilder) => {
      const roughness = (builder.context as { getTextureLevel(): Node<'float'> }).getTextureLevel()
      const point = vec3(positionWorld.x, 0, positionWorld.z)
      const distance = cameraPosition.sub(point).length()
      const warp = normalWorld.xz.mul(distance.min(120)).mul(0.12)
      const clip = this.projection.mul(vec4(point.add(vec3(warp.x, 0, warp.y)), 1))
      const ndc = clip.xy.div(clip.w.max(0.0001))
      // RenderTarget textures use top-left UVs on WebGPU.
      const uv = ndc.mul(vec2(0.5, -0.5)).add(0.5)
      const margins = uv.min(float(1).sub(uv))
      const edge = margins.x.min(margins.y)
      // The planar image contains premultiplied solid objects only. Filtering
      // its alpha along with colour prevents sky leaking into object edges.
      const planarSample = texture(this.planar.texture, uv.clamp(0, 1)).level(roughness.mul(this.maxMip).mul(0.65))
      const coverage = smoothstep(0, 0.04, edge)
        .mul(clip.w.greaterThan(0).select(1, 0))
        .mul(float(1).sub(smoothstep(0.45, 0.8, roughness)))
        .mul(this.ready)
      return cubeSample.rgb.mul(float(1).sub(coverage.mul(planarSample.a))).add(planarSample.rgb.mul(coverage))
    })()
  }

  private makePipeline(camera: PerspectiveCamera, cubeFace = false) {
    const scenePass = pass(this.scene, camera, { samples: 0 })
    if (cubeFace) {
      // Cube faces stay square regardless of the main viewport's aspect.
      const setSize = scenePass.setSize.bind(scenePass)
      scenePass.setSize = () => setSize(this.cube.width, this.cube.height)
    }
    // r186 PassNode restores the target but drops the active cube face/mip.
    // Restore those too, before the pipeline quad writes the hazed face.
    const renderPass = scenePass.updateBefore.bind(scenePass)
    scenePass.updateBefore = (frame: NodeFrame) => {
      const target = this.renderer.getRenderTarget()
      const face = this.renderer.getActiveCubeFace(),
        mip = this.renderer.getActiveMipmapLevel()
      try {
        return renderPass(frame)
      } finally {
        this.renderer.setRenderTarget(target, face, mip)
      }
    }
    const haze = this.sky.applyHaze(scenePass.getTextureNode(), {
      scenePass,
      logarithmicDepthBuffer: this.renderer.logarithmicDepthBuffer,
      useCameraFar: true,
      raymarchFallback: false,
      shadows: false,
    })
    const fog = this.sky.applyFog(haze, { scenePass, logarithmicDepthBuffer: this.renderer.logarithmicDepthBuffer })
    const pipeline = new RenderPipeline(this.renderer)
    pipeline.outputColorTransform = false
    const objectMask = scenePass.getTextureNode('depth').r.lessThan(0.99999).select(1, 0)
    pipeline.outputNode = cubeFace ? fog : vec4(fog.rgb.mul(objectMask), objectMask)
    return { pipeline, scenePass }
  }

  invalidate() {
    this.cubeDirty = this.planarDirty = true
  }

  update(camera: PerspectiveCamera, water: Mesh) {
    if (!this.compiled || this.disposed) return
    camera.updateMatrixWorld()
    const size = this.renderer.getDrawingBufferSize(this.drawingSize)
    if (
      !this.cameraMatrix.equals(camera.matrixWorld) ||
      !this.cameraProjection.equals(camera.projectionMatrix) ||
      !this.size.equals(size)
    ) {
      this.planarDirty = true
    }
    if (!this.cubeDirty && !this.planarDirty) return

    const renderer = this.renderer
    const previousTarget = renderer.getRenderTarget()
    const face = renderer.getActiveCubeFace(),
      mip = renderer.getActiveMipmapLevel()
    const previousMRT = renderer.getMRT(),
      previousXR = renderer.xr.enabled
    const visible = water.visible
    const hidden: Mesh[] = []
    const stage = this.scene.getObjectByName('Shonan / Fuji coastal stage') as ClippingGroup | undefined
    const clippingEnabled = stage?.enabled
    const sunDisc = this.sky.baker.sky.showSunDisc
    const moonDisc = this.sky.baker.sky.showMoonDisc
    const previousSunDisc = sunDisc.value
    const previousMoonDisc = moonDisc?.value
    // The direct light supplies the solar BRDF; including its bright disc in
    // IBL would count it twice and smear it into low-resolution cube texels.
    // Distant land is deliberately excluded from both water captures. Its
    // main-view visibility and separate CPU sunset occlusion are preserved.
    this.scene.traverseVisible((object) => {
      if (
        object.userData.excludeFromWaterReflection ||
        object.name === 'SkySun.disc' ||
        object.name === 'SkyMoon.disc' ||
        object.name.startsWith('SkyStars')
      ) {
        hidden.push(object as Mesh)
      }
    })
    try {
      water.visible = false
      // Some Sky versions draw discs in the live sky material rather than
      // separate meshes. Keep them out of IBL in either representation.
      sunDisc.value = 0
      if (moonDisc) moonDisc.value = 0
      if (stage) stage.enabled = true
      hidden.forEach((object) => {
        object.visible = false
      })
      renderer.xr.enabled = false
      renderer.setMRT(null)
      if (this.cubeDirty) {
        for (let i = 0; i < 6; i++) {
          const { pipeline, scenePass } = this.pipelines[i]
          scenePass.setResolutionScale(1)
          renderer.setRenderTarget(this.cube, i)
          pipeline.render()
        }
        this.pmrem.markDirty()
        this.pmrem.flush()
        this.cubeDirty = false
        this.cubeCaptures++
      }
      if (this.planarDirty) {
        this.mirror.copy(camera, false)
        const forward = camera.getWorldDirection(new Vector3())
        const eye = camera.getWorldPosition(new Vector3())
        this.mirror.position.set(eye.x, -eye.y, eye.z)
        this.mirror.up.copy(camera.up).multiply(new Vector3(1, -1, 1))
        this.mirror.lookAt(this.mirror.position.clone().add(forward.multiply(new Vector3(1, -1, 1))))
        this.mirror.updateMatrixWorld()
        this.projection.value.multiplyMatrices(this.mirror.projectionMatrix, this.mirror.matrixWorldInverse)
        this.planar.setSize(Math.max(1, Math.round(size.x * 0.75)), Math.max(1, Math.round(size.y * 0.75)))
        this.planarPipeline.scenePass.setResolutionScale(0.75)
        renderer.setRenderTarget(this.planar)
        this.planarPipeline.pipeline.render()
        this.maxMip.value = Math.log2(Math.max(this.planar.width, this.planar.height))
        this.ready.value = camera.position.y > 0 ? 1 : 0
        this.cameraMatrix.copy(camera.matrixWorld)
        this.cameraProjection.copy(camera.projectionMatrix)
        this.size.copy(size)
        this.planarDirty = false
        this.planarCaptures++
      }
      // Read-only QA counters, absent from the product's visible interface.
      renderer.domElement.dataset.reflectionCubeCaptures = String(this.cubeCaptures)
      renderer.domElement.dataset.reflectionPlanarCaptures = String(this.planarCaptures)
      renderer.domElement.dataset.reflectionFilter = this.pmrem.mode
    } finally {
      water.visible = visible
      sunDisc.value = previousSunDisc
      if (moonDisc) moonDisc.value = previousMoonDisc
      if (stage) stage.enabled = clippingEnabled!
      hidden.forEach((object) => {
        object.visible = true
      })
      renderer.setMRT(previousMRT)
      renderer.setRenderTarget(previousTarget, face, mip)
      renderer.xr.enabled = previousXR
    }
  }

  dispose() {
    this.disposed = true
    this.unsubscribe()
    for (const { pipeline, scenePass } of [...this.pipelines, this.planarPipeline]) {
      pipeline.dispose()
      scenePass.dispose()
    }
    this.pmrem.dispose()
    this.generator?.dispose()
    this.cube.dispose()
    this.planar.dispose()
  }
}
