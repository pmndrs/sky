import { Color, DoubleSide, Mesh, NodeMaterial, PlaneGeometry } from 'three/webgpu'
import {
  Fn,
  If,
  acos,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cross,
  cos,
  cubeTexture,
  dot,
  float,
  fwidth,
  length,
  luminance,
  max,
  mix,
  normalize,
  smoothstep,
  sin,
  sqrt,
  tan,
  texture,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl'

import { raySphereIntersectNearest, transmittanceLutParamsToUv } from '../backends/tsl/atmosphere.tsl'

/**
 * A camera-independent angular disc in the main scene, outside the cube bake.
 * Its parent can be a directional light: projection uses the same sky direction
 * uniform as the light, ignoring translation/scale so camera motion has no parallax.
 */
export class SkyCelestialDisc extends Mesh<PlaneGeometry, NodeMaterial> {
  constructor(baker: any, body: 'sun' | 'moon', tint?: Color) {
    const material = new NodeMaterial()
    super(new PlaneGeometry(2, 2), material)
    this.name = body === 'sun' ? 'SkySun.disc' : 'SkyMoon.disc'
    this.frustumCulled = false
    // Transparent list, after the sky and stars, before scene transparency.
    this.renderOrder = -0.5

    const sky = baker.sky
    const params = baker.atmosphereUniforms
    const solar = body === 'sun'
    const direction = solar ? sky.sunDirection : sky.moonDirection
    const discCos = solar ? sky.sunDiscCos : sky.moonDiscCos
    const visible = solar ? sky.showSunDisc : sky.showMoonDisc
    const intensity = solar ? sky.sunDiscIntensity : sky.moonIntensity
    const color = solar ? sky.sunColor.mul(uniform(tint ?? new Color(1, 1, 1))) : sky.moonColor
    const radius = tan(acos(clamp(discCos, -1, 1)))

    // Build a tangent plane around the source direction, with a stable basis
    // at zenith as well. w=0 removes camera translation; z=w puts the disc at
    // the far plane even with a short camera.far or a translated light parent.
    const ray = Fn(() => {
      const dir = normalize(direction)
      const axis = dot(dir, vec3(0, 1, 0))
        .abs()
        .lessThan(0.99)
        .select(vec3(0, 1, 0), vec3(1, 0, 0))
      const right = normalize(cross(axis, dir))
      const up = cross(dir, right)
      const p = uv().mul(2).sub(1)
      return dir.add(right.mul(p.x.mul(radius))).add(up.mul(p.y.mul(radius)))
    })()
    const viewRay = varying(ray)
    material.vertexNode = Fn(() => {
      const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(ray, 0)))
      return vec4(clip.xy, clip.w, clip.w)
    })()

    material.colorNode = Fn(() => {
      const dir = normalize(viewRay)
      const up = normalize(sky.upVector)
      const height = max(sky.viewHeight, params.bottomRadius.add(0.01))
      const cz = clamp(dot(dir, up), -1, 1)
      const hitsGround = raySphereIntersectNearest(up.mul(height), dir, vec3(0), params.bottomRadius).greaterThanEqual(
        0,
      )
      const open = hitsGround.select(float(0), float(1))
      // Each fragment sees its own atmospheric path, including limb reddening
      // and partial planet occlusion as the disc crosses the horizon.
      const T = vec3(1).toVar()
      If(height.lessThan(params.topRadius), () => {
        T.assign(texture(baker.transmittanceLUT.texture, transmittanceLutParamsToUv(height, cz, params)).level(0).rgb)
      })
      const r = length(uv().mul(2).sub(1))
      const softness = solar
        ? float(1).sub(tan(acos(clamp(sky.sunDiscCosInner, -1, 1))).div(max(radius, 1e-8)))
        : float(0.02)
      const rim = max(softness, fwidth(r))
      const mask = float(1)
        .sub(smoothstep(float(1).sub(rim), 1, r))
        .mul(visible)
        .mul(open)
        .toVar()
      const radiance = T.mul(color).mul(intensity).toVar()
      if (!solar) {
        If(sky.moonPhaseShading.greaterThan(0.5), () => {
          // A projected sphere lit from phase angle: new → waxing → full →
          // waning. Shading the terminator keeps cinematic manual placement
          // independent of the approximate lunar orbit.
          const p = uv().mul(2).sub(1)
          const z = sqrt(max(float(1).sub(dot(p, p)), 0))
          const angle = sky.moonPhase.mul(Math.PI * 2)
          const lit = p.x.mul(sin(angle)).sub(z.mul(cos(angle)))
          const aa = max(fwidth(lit), 1e-5)
          mask.mulAssign(smoothstep(aa.negate(), aa, lit))
          // Derivative antialiasing alone leaves a faint ring at exact new
          // moon, where the terminator coincides with the outer limb.
          mask.mulAssign(cos(angle).lessThan(0.999999).select(1, 0))
        })
        If(sky.moonDaylightFade.greaterThan(0.5), () => {
          // Sample the raw background cube, including its current artistic
          // grade. It contains no discs and matches the displayed background.
          const skyRgb = cubeTexture(baker.texture, dir).level(0).rgb.toVar()
          // Cinematic night radiance is too strong against a daytime sky.
          // Adapt that boost to local sky brightness, then fade low-contrast
          // features. This is artistic visibility, not an eye adaptation model.
          const skyL = luminance(skyRgb)
          const day = smoothstep(
            Math.sin((-6 * Math.PI) / 180),
            Math.sin((10 * Math.PI) / 180),
            dot(normalize(sky.sunDirection), up),
          )
          radiance.divAssign(float(1).add(skyL.mul(5).mul(day)))
          const contrast = luminance(radiance).div(max(skyL, 1e-4))
          mask.mulAssign(mix(1, smoothstep(0.01, 0.08, contrast), day))
          // Atmospheric in-scatter is in front of the moon too: retaining it
          // gives a pale blue daytime disc rather than a white sky cutout.
          radiance.addAssign(skyRgb)
        })
      }
      return vec4(radiance, mask)
    })()
    material.transparent = true
    material.side = DoubleSide
    material.forceSinglePass = true
    material.depthTest = true
    material.depthWrite = false
    // Override logarithmic depth derived from the light parent's position.
    // Only this tiny quad pays the fragment-depth cost; it remains at infinity.
    material.depthNode = float(1)
    material.fog = false
  }

  dispose() {
    this.removeFromParent()
    this.geometry.dispose()
    this.material.dispose()
  }
}
