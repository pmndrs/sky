import {
  Object3D,
  BufferGeometry,
  Line,
  LineBasicMaterial,
  Mesh,
  ConeGeometry,
  MeshBasicMaterial,
  Vector3,
  Color,
} from 'three/webgpu'

/**
 * Visual debug helper that displays the sun frame at a point in world space.
 *
 * Renders:
 * - Azimuth compass ring on the local XZ plane (radius = size, #444444)
 * - Cardinal tick marks at +X, -X, +Z, -Z; +Z (north) is #e33 and 2x length
 * - Sun direction arrow from origin toward the sun (shaft #fc3, cone at tip)
 * - Elevation arc tracing from sun's horizon point up to the sun direction (#fc3, 40% opacity)
 *
 * The +Z tick mark always points north, matching the Sky facade's default
 * `north: '+Z'` orientation. Sun position updates are tracked via the baker's
 * sun listener and reflected in real time.
 *
 * @example
 * const helper = new SkyHelper(sky, { size: 20 })
 * scene.add(helper)
 * // ... later
 * helper.dispose()
 */
export class SkyHelper extends Object3D {
  private baker: any
  private size: number
  private compassGroup: Object3D
  private arrowGroup: Object3D
  private elevationArc: Line
  private elevationGeometry: BufferGeometry
  private sunListener: (() => void) | null = null

  constructor(sky: any, options?: { size?: number }) {
    super()

    // Duck-type: sky is either a Sky facade (has .baker) or a baker itself
    this.baker = sky?.baker ?? sky
    this.size = options?.size ?? 10

    // Build compass ring with cardinal ticks
    this.compassGroup = this.buildCompass()
    this.add(this.compassGroup)

    // Build sun direction arrow (shaft + cone tip)
    this.arrowGroup = this.buildArrow()
    this.add(this.arrowGroup)

    // Build elevation arc (will be updated on sun changes)
    this.elevationGeometry = new BufferGeometry()
    this.elevationArc = new Line(
      this.elevationGeometry,
      new LineBasicMaterial({
        color: new Color('#fc3'),
        transparent: true,
        opacity: 0.4,
      }),
    )
    this.add(this.elevationArc)

    // Subscribe to sun direction changes
    this.sunListener = this.baker.addSunListener((sunVec: Vector3) => {
      this.updateFromSun(sunVec)
    })

    // Initial update with baker's current sun vector
    if (this.baker._sunVec) {
      this.updateFromSun(this.baker._sunVec)
    }
  }

  private buildCompass(): Object3D {
    const group = new Object3D()

    // Main ring (XZ plane, Y=0), ~64 segments
    const ringGeometry = new BufferGeometry()
    const ringPoints: Vector3[] = []
    const segments = 64

    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      ringPoints.push(new Vector3(Math.sin(angle) * this.size, 0, Math.cos(angle) * this.size))
    }

    ringGeometry.setFromPoints(ringPoints)
    const ring = new Line(ringGeometry, new LineBasicMaterial({ color: new Color('#444444') }))
    group.add(ring)

    // Cardinal ticks: +Z (north, red, 2x length), others 1.1x
    // +Z (north) — 2x length, red
    const northGeometry = new BufferGeometry()
    northGeometry.setFromPoints([new Vector3(0, 0, this.size), new Vector3(0, 0, this.size * 1.2)])
    const northTick = new Line(northGeometry, new LineBasicMaterial({ color: new Color('#e33') }))
    group.add(northTick)

    // Other ticks in one geometry — +X, -X, -Z
    const otherTicksGeometry = new BufferGeometry()
    otherTicksGeometry.setFromPoints([
      // +X (east)
      new Vector3(this.size, 0, 0),
      new Vector3(this.size * 1.1, 0, 0),
      // -X (west)
      new Vector3(-this.size, 0, 0),
      new Vector3(-this.size * 1.1, 0, 0),
      // -Z (south)
      new Vector3(0, 0, -this.size),
      new Vector3(0, 0, -this.size * 1.1),
    ])
    const otherTicks = new Line(otherTicksGeometry, new LineBasicMaterial({ color: new Color('#888') }))
    group.add(otherTicks)

    return group
  }

  private buildArrow(): Object3D {
    const group = new Object3D()

    // Arrow shaft: line from origin to +Y (size)
    const shaftGeometry = new BufferGeometry()
    shaftGeometry.setFromPoints([new Vector3(0, 0, 0), new Vector3(0, this.size, 0)])
    const shaft = new Line(shaftGeometry, new LineBasicMaterial({ color: new Color('#fc3'), linewidth: 2 }))
    group.add(shaft)

    // Cone tip at the end (+Y), pointing outward
    const coneGeometry = new ConeGeometry(this.size * 0.15, this.size * 0.3, 16)
    const cone = new Mesh(coneGeometry, new MeshBasicMaterial({ color: new Color('#fc3') }))
    cone.position.y = this.size
    group.add(cone)

    return group
  }

  private updateFromSun(sunVec: Vector3): void {
    // Orient the arrow group to point toward the sun
    // The arrow is built pointing +Y; rotate it to point along sunVec
    const normalized = sunVec.clone().normalize()
    this.arrowGroup.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), normalized)

    // Rebuild elevation arc: from sun's horizon point to the sun direction
    // Horizon point = same azimuth as sun, but at elevation 0 (on the XZ plane ring)
    const sunAzimuth = Math.atan2(sunVec.x, sunVec.z)
    const horizonPoint = new Vector3(Math.sin(sunAzimuth) * this.size, 0, Math.cos(sunAzimuth) * this.size)

    // Sun point: normalized sun direction scaled to size
    const sunPoint = sunVec.clone().normalize().multiplyScalar(this.size)

    // Generate arc by interpolating horizon → sun, then re-projecting to sphere
    const arcPoints: Vector3[] = []
    const arcSegments = 24

    for (let i = 0; i <= arcSegments; i++) {
      const t = i / arcSegments
      const point = new Vector3().lerpVectors(horizonPoint, sunPoint, t).normalize().multiplyScalar(this.size)
      arcPoints.push(point)
    }

    // Replace geometry
    this.elevationGeometry.dispose()
    this.elevationGeometry = new BufferGeometry()
    this.elevationGeometry.setFromPoints(arcPoints)
    this.elevationArc.geometry = this.elevationGeometry
  }

  dispose(): void {
    // Unsubscribe from sun listener
    if (this.sunListener) {
      this.sunListener()
      this.sunListener = null
    }

    // Dispose compass geometries and materials
    this.compassGroup.traverse((child: any) => {
      if (child instanceof Line) {
        child.geometry.dispose()
        if (child.material instanceof LineBasicMaterial) {
          child.material.dispose()
        }
      }
    })

    // Dispose arrow geometries and materials
    this.arrowGroup.traverse((child: any) => {
      if (child.geometry) child.geometry.dispose()
      if (child.material instanceof MeshBasicMaterial || child.material instanceof LineBasicMaterial) {
        child.material.dispose()
      }
    })

    // Dispose elevation arc
    this.elevationGeometry.dispose()
    if (this.elevationArc.material instanceof LineBasicMaterial) {
      this.elevationArc.material.dispose()
    }
  }
}
