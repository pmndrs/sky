import { Matrix4 } from 'three/webgpu'

import { SkyStars } from './SkyStars'
import { worldToGalactic } from './stars/celestial'
import { generateMilkyWayTexture } from './stars/milkyWay'

import type { SkyStarsOptions } from './SkyStars'

export interface SkyNightOptions extends SkyStarsOptions {
  /** Milky Way glow intensity; 0 hides it. Default 0.25. */
  milkyWay?: number
  /**
   * Glow : sky luminance ratio at the midpoint of the Milky Way's twilight
   * fade (±3 stops, per pixel). Raise to hold it back until later. Default 20.
   */
  milkyWayContrast?: number
  /**
   * Use your own all-sky map instead of the procedural one — equirectangular
   * in GALACTIC coordinates, galactic centre at u = 0.5, b = −90° at v = 0
   * (see `generateMilkyWayTexture`). Not disposed by the sky.
   */
  milkyWayTexture?: any
}

/** Options that change the star buffers, so changing them rebuilds `SkyStars`. */
const REBUILD_KEYS = ['count', 'seed', 'catalog'] as const

/**
 * Night sky: resolved stars + the Milky Way, created by `sky.enableStars()`.
 *
 * The two halves are drawn in different places on purpose:
 *
 *  - **Stars** (`SkyStars`) are energy-normalised PSF sprites in YOUR scene,
 *    added on `attach()`. Points of light can't survive the 256² cube bake;
 *    as sprites they cost ~0.01 ms/frame and stay pixel-sharp at any
 *    resolution.
 *  - **The Milky Way** is a low-frequency glow texture sampled by the sky
 *    mesh and baked into the cube — zero per-frame cost, and it reaches the
 *    background, PMREM and IBL like the rest of the sky.
 *
 * Both are oriented from the sky's `timeOfDay`, `dayOfYear`, `latitude` and
 * `north` (local sidereal time from the same solar model as the sun), both
 * are attenuated by transmittance and occluded by the planet, and both fade
 * in through twilight by contrast against the sky behind them — no
 * sun-elevation ramp.
 */
export class SkyNight {
  sky: any
  stars: SkyStars | null = null
  milkyWayTexture: any = null
  _ownsMilkyWayTexture = false
  _milkyWay = 0.25
  _enabled = false
  _options: SkyNightOptions = {}
  _orientation = new Matrix4()

  constructor(sky: any) {
    this.sky = sky
  }

  get enabled() {
    return this._enabled
  }

  get mesh() {
    return this.sky.baker.sky
  }

  /**
   * Turn the night sky on (or update it in place). Returns `this`.
   * Changing `count`, `seed` or `catalog` rebuilds the star buffers.
   */
  enable(options: SkyNightOptions = {}) {
    this._enabled = true
    this._apply(options)
    this.stars!.visible = true
    this._attachStars()
    return this
  }

  /** Hide stars and the Milky Way; `enable()` brings them back cheaply. */
  disable() {
    this._enabled = false
    if (this.stars) {
      this.stars.visible = false
      this.stars.removeFromParent()
    }
    if (this.sky.state !== 'disposed') {
      this.mesh.milkyWayIntensity.value = 0
      this.sky.baker.markCubeDirty()
    }
    return this
  }

  setIntensity(value: number) {
    return this._apply({ intensity: value })
  }

  /** PSF σ in CSS pixels. */
  setSize(value: number) {
    return this._apply({ size: value })
  }

  setTwinkle(value: number) {
    return this._apply({ twinkle: value })
  }

  /** Star : sky ratio at the midpoint of the twilight fade. */
  setContrast(value: number) {
    return this._apply({ contrast: value })
  }

  /** Exponent on flux: 1 = physical magnitude ratios, < 1 compresses the range. */
  setMagnitudeContrast(value: number) {
    return this._apply({ magnitudeContrast: value })
  }

  /** Milky Way intensity; 0 hides it. */
  setMilkyWay(value: number) {
    return this._apply({ milkyWay: value })
  }

  setMilkyWayContrast(value: number) {
    return this._apply({ milkyWayContrast: value })
  }

  /** Merge options into the current state without changing enabled/disabled. */
  _apply(options: SkyNightOptions) {
    const needsRebuild = !this.stars || REBUILD_KEYS.some((k) => k in options && options[k] !== this._options[k])
    this._options = { ...this._options, ...options }
    const o = this._options

    if (needsRebuild) {
      const wasAttached = !!this.stars?.parent
      this.stars?.dispose()
      this.stars = new SkyStars(this.sky.baker, o)
      this.stars.orientation.copy(this._orientation)
      this.stars.visible = this._enabled
      if (wasAttached) this._attachStars()
    }
    const u = this.stars!.uniforms
    if (o.intensity !== undefined) u.intensity.value = o.intensity
    if (o.size !== undefined) u.size.value = o.size
    if (o.magnitudeContrast !== undefined) u.magnitudeContrast.value = o.magnitudeContrast
    if (o.contrast !== undefined) u.contrast.value = o.contrast
    if (o.twinkle !== undefined) u.twinkle.value = o.twinkle

    // Milky Way: bind the map (generated once, on first use) and uniforms.
    const mesh = this.mesh
    if ('milkyWayTexture' in options) this.setMilkyWayTexture(options.milkyWayTexture ?? null)
    else if (!this.milkyWayTexture) this.setMilkyWayTexture(null)
    if (o.milkyWay !== undefined) this._milkyWay = o.milkyWay
    if (o.milkyWayContrast !== undefined) mesh.milkyWayContrast.value = o.milkyWayContrast
    mesh.milkyWayIntensity.value = this._enabled ? this._milkyWay : 0
    this.sky.baker.markCubeDirty()
    return this
  }

  /**
   * Swap the Milky Way map; `null` returns to the procedural one. A texture
   * you pass in stays yours to dispose.
   */
  setMilkyWayTexture(texture: any | null) {
    if (this._ownsMilkyWayTexture && this.milkyWayTexture && this.milkyWayTexture !== texture) {
      this.milkyWayTexture.dispose()
    }
    if (texture) {
      this.milkyWayTexture = texture
      this._ownsMilkyWayTexture = false
    } else if (!this._ownsMilkyWayTexture || !this.milkyWayTexture) {
      this.milkyWayTexture = generateMilkyWayTexture()
      this._ownsMilkyWayTexture = true
    }
    this.mesh.milkyWayTextureNode.value = this.milkyWayTexture
    this.sky.baker.markCubeDirty()
    return this
  }

  /** @internal Sky calls this whenever time, date, latitude or north change. */
  _setOrientation(orientation: Matrix4) {
    this._orientation.copy(orientation)
    if (this.stars) this.stars.orientation.copy(orientation)
    worldToGalactic(orientation, this.mesh.milkyWayMatrix.value)
    if (this._enabled && this._milkyWay > 0) this.sky.baker.markCubeDirty()
  }

  /** @internal Add the sprites to the sky's attached scene. */
  _attachStars() {
    const scene = this.sky._scene
    if (this._enabled && this.stars && scene && this.stars.parent !== scene) scene.add(this.stars)
  }

  /** @internal */
  _detachStars() {
    this.stars?.removeFromParent()
  }

  /** @internal Per frame, from `sky.update(camera)`. */
  update(camera: any, pixelRatio = 1) {
    if (this._enabled && this.stars && camera) this.stars.update(camera, pixelRatio)
  }

  /** Remove the sprites, free the buffers and the generated map. */
  dispose() {
    this._enabled = false
    if (this.stars) {
      this.stars.dispose()
      this.stars = null
    }
    if (this.sky.state !== 'disposed') {
      const mesh = this.mesh
      mesh.milkyWayIntensity.value = 0
      mesh.milkyWayTextureNode.value = mesh._milkyWayPlaceholder
      this.sky.baker.markCubeDirty()
    }
    if (this._ownsMilkyWayTexture && this.milkyWayTexture) this.milkyWayTexture.dispose()
    this.milkyWayTexture = null
    this._ownsMilkyWayTexture = false
  }
}
