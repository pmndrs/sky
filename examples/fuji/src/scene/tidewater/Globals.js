import { uniform } from 'three/tsl'
import { Vector2 } from 'three/webgpu'
export const GRAVITY = 9.81
export const G = {
  dt: uniform(1 / 60),
  time: uniform(0),
  windDir: uniform(new Vector2(0.42, 0.91)),
  windSpeed: uniform(4.5),
  seaLevel: uniform(0),
}
