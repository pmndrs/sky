import { PerspectiveCamera, Vector3 } from 'three/webgpu'

import { getPlanetCameraFrame } from './planetScaleUtils'

const MAX_PITCH_RAD = 89 * (Math.PI / 180)
// Wheel altitude step: ~8% of the current altitude per tick, applied
// exponentially so it feels consistent from 25 m to 500 km.
const ALTITUDE_WHEEL_FACTOR = 1.08

interface PlanetFlightControlsOptions {
  planetCenter: Vector3
  bottomRadiusM: number
  minAltitudeM?: number
  maxAltitudeM?: number
  lookSpeed?: number
  smoothTime?: number
}

function clampNum(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}

/**
 * First-person "flight" controls for planet-scale demos.
 *
 * `camera-controls`'s orbit model rotates the camera *through space* around
 * a ground target — at planet scale that means huge sweeping arcs for what
 * should be a small look-around, and dolly/orbit both perturb altitude as a
 * side effect. This does the opposite: there is no target. Dragging looks
 * around from wherever the camera currently is (yaw/pitch in place), and the
 * wheel is the only thing that moves the camera at all — purely radially, so
 * altitude changes never touch view direction and vice versa.
 *
 * Orientation is tracked as yaw (about the local radial "up") and pitch
 * (about the local "right") against a tangent-plane basis established once
 * from the camera's initial look direction. Every `update()` recomputes
 * `up` from the camera's *current* position (via `getPlanetCameraFrame`)
 * and re-derives `forward` from that basis + yaw/pitch, then hands off to
 * `camera.lookAt()` with `camera.up` pinned to the fresh radial up — the
 * same roll-free re-orthonormalization `Matrix4.lookAt` already does for
 * any other look-at camera. v1 only translates the camera radially (wheel),
 * so `up`'s direction never actually changes turn to turn, but recomputing
 * it from position rather than caching it keeps this correct if a future
 * version adds lateral movement over the sphere.
 */
export class PlanetFlightControls {
  private readonly camera: PerspectiveCamera
  private readonly domElement: HTMLElement
  private readonly planetCenter: Vector3
  private readonly bottomRadiusM: number
  private readonly minAltitudeM: number
  private readonly maxAltitudeM: number
  private readonly lookSpeed: number
  private readonly smoothTime: number

  // Tangent-plane reference basis established at construction from the
  // camera's initial look direction. Yaw is measured from `basisForward`.
  private readonly basisForward = new Vector3()
  private readonly basisRight = new Vector3()

  private yawCurrent = 0
  private yawTarget = 0
  private pitchCurrent = 0
  private pitchTarget = 0
  private altitudeCurrent: number
  private altitudeTarget: number

  private dragging = false
  private activePointerId: number | null = null
  private lastX = 0
  private lastY = 0

  private readonly prevTouchAction: string
  private readonly handlePointerDown: (event: PointerEvent) => void
  private readonly handlePointerMove: (event: PointerEvent) => void
  private readonly handlePointerUp: (event: PointerEvent) => void
  private readonly handleWheel: (event: WheelEvent) => void

  constructor(camera: PerspectiveCamera, domElement: HTMLElement, opts: PlanetFlightControlsOptions) {
    this.camera = camera
    this.domElement = domElement
    this.planetCenter = opts.planetCenter
    this.bottomRadiusM = opts.bottomRadiusM
    this.minAltitudeM = opts.minAltitudeM ?? 25
    this.maxAltitudeM = opts.maxAltitudeM ?? 500_000
    this.lookSpeed = opts.lookSpeed ?? 0.002
    this.smoothTime = opts.smoothTime ?? 0.1

    const frame = getPlanetCameraFrame(camera.position, this.planetCenter, this.bottomRadiusM)
    const altitude = clampNum(frame.altitudeM, this.minAltitudeM, this.maxAltitudeM)
    this.altitudeCurrent = altitude
    this.altitudeTarget = altitude

    this.establishBasis(frame.up)

    // Seed pitch from the camera's actual initial look direction (yaw is 0
    // by construction — `basisForward` *is* the yaw-0 direction) so the
    // first-person view starts exactly where the caller pointed the camera.
    const forward0 = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    const pitch0 = Math.asin(clampNum(forward0.dot(frame.up), -1, 1))
    this.pitchCurrent = this.pitchTarget = clampNum(pitch0, -MAX_PITCH_RAD, MAX_PITCH_RAD)

    this.prevTouchAction = domElement.style.touchAction
    domElement.style.touchAction = 'none'

    this.handlePointerDown = (event: PointerEvent) => {
      // Left button only, and only drags that start on our own element —
      // GUI panels (Inspector, dat.gui) live outside `domElement`, so this
      // naturally ignores drags that begin on them.
      if (event.button !== 0 || event.target !== domElement) return
      this.dragging = true
      this.activePointerId = event.pointerId
      this.lastX = event.clientX
      this.lastY = event.clientY
      domElement.setPointerCapture(event.pointerId)
      event.preventDefault()
    }

    this.handlePointerMove = (event: PointerEvent) => {
      if (!this.dragging || event.pointerId !== this.activePointerId) return
      const dx = event.clientX - this.lastX
      const dy = event.clientY - this.lastY
      this.lastX = event.clientX
      this.lastY = event.clientY
      this.yawTarget += dx * this.lookSpeed
      this.pitchTarget = clampNum(this.pitchTarget - dy * this.lookSpeed, -MAX_PITCH_RAD, MAX_PITCH_RAD)
    }

    this.handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== this.activePointerId) return
      this.dragging = false
      this.activePointerId = null
      if (domElement.hasPointerCapture(event.pointerId)) domElement.releasePointerCapture(event.pointerId)
    }

    this.handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      // Scroll up (deltaY < 0) climbs; scroll down descends.
      const factor = event.deltaY < 0 ? ALTITUDE_WHEEL_FACTOR : 1 / ALTITUDE_WHEEL_FACTOR
      this.altitudeTarget = clampNum(this.altitudeTarget * factor, this.minAltitudeM, this.maxAltitudeM)
    }

    domElement.addEventListener('pointerdown', this.handlePointerDown)
    domElement.addEventListener('pointermove', this.handlePointerMove)
    domElement.addEventListener('pointerup', this.handlePointerUp)
    domElement.addEventListener('pointercancel', this.handlePointerUp)
    domElement.addEventListener('wheel', this.handleWheel, { passive: false })
  }

  /**
   * Build an orthonormal (forward, right) tangent-plane basis from the
   * camera's current look direction, projected perpendicular to `up`.
   */
  private establishBasis(up: Vector3): void {
    const forward = new Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion)
    let tangentForward = forward.clone().addScaledVector(up, -forward.dot(up))
    if (tangentForward.lengthSq() < 1e-8) {
      // Camera started looking straight up/down `up` — fall back to any
      // vector not parallel to `up` to seed a stable basis.
      const fallback = Math.abs(up.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)
      tangentForward = fallback.clone().addScaledVector(up, -fallback.dot(up))
    }
    tangentForward.normalize()
    this.basisForward.copy(tangentForward)
    // Matches three.js's camera convention (forward = -Z, up = +Y, right =
    // forward × up = +X), so positive yaw (drag right) turns toward `right`.
    this.basisRight.crossVectors(this.basisForward, up).normalize()
  }

  update(deltaSeconds: number): void {
    const frame = getPlanetCameraFrame(this.camera.position, this.planetCenter, this.bottomRadiusM)
    const up = frame.up

    const damping = 1 - Math.exp(-deltaSeconds / this.smoothTime)
    this.yawCurrent += (this.yawTarget - this.yawCurrent) * damping
    this.pitchCurrent += (this.pitchTarget - this.pitchCurrent) * damping
    this.altitudeCurrent += (this.altitudeTarget - this.altitudeCurrent) * damping

    const cosPitch = Math.cos(this.pitchCurrent)
    const forward = this.basisForward
      .clone()
      .multiplyScalar(Math.cos(this.yawCurrent) * cosPitch)
      .addScaledVector(this.basisRight, Math.sin(this.yawCurrent) * cosPitch)
      .addScaledVector(up, Math.sin(this.pitchCurrent))
      .normalize()

    this.camera.position.copy(this.planetCenter).addScaledVector(up, this.bottomRadiusM + this.altitudeCurrent)
    this.camera.up.copy(up)
    this.camera.lookAt(this.camera.position.clone().add(forward))
  }

  getAltitudeM(): number {
    return this.altitudeCurrent
  }

  /**
   * Move radially to the given altitude, keeping view direction. Clamped to
   * [minAltitudeM, maxAltitudeM] and eased in via the same damping as
   * everything else (`update()` must still be called for this to animate).
   */
  setAltitudeM(m: number): void {
    this.altitudeTarget = clampNum(m, this.minAltitudeM, this.maxAltitudeM)
  }

  dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.handlePointerDown)
    this.domElement.removeEventListener('pointermove', this.handlePointerMove)
    this.domElement.removeEventListener('pointerup', this.handlePointerUp)
    this.domElement.removeEventListener('pointercancel', this.handlePointerUp)
    this.domElement.removeEventListener('wheel', this.handleWheel)
    this.domElement.style.touchAction = this.prevTouchAction
  }
}
