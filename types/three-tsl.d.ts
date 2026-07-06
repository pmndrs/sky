// Loosened type surface for the TSL node DSL (`three/tsl`).
//
// @types/three models TSL expression results as `Node<...>`, which cannot
// express swizzle accessors (`.rgb`, `.a`, `.z`), operator chaining (`.mul`,
// `.add`), or the flexible scalar/vector overloads the DSL accepts at runtime —
// producing false-positive errors on otherwise-correct shader graphs. We type
// every TSL entrypoint as `any` so the shader graphs compile as authored.
//
// `three/webgpu` (the real Three.js object model — Vector3, Mesh, materials,
// render targets) keeps its precise @types/three declarations; only this DSL is
// loosened. Wired in via `compilerOptions.paths` in tsconfig.json.
//
// If you import a new TSL symbol and TS reports it "has no exported member",
// add it to the list below.

export const Fn: any
export const If: any
export const Loop: any
export const PI: any
export const abs: any
export const acos: any
export const add: any
export const cameraPosition: any
export const clamp: any
export const cos: any
export const cross: any
export const cubeTexture: any
export const dot: any
export const equirectUV: any
export const exp: any
export const float: any
export const floor: any
export const fract: any
export const instanceIndex: any
export const int: any
export const ivec3: any
export const length: any
export const logarithmicDepthToViewZ: any
export const max: any
export const min: any
export const mix: any
export const modelViewProjection: any
export const mul: any
export const normalize: any
export const positionLocal: any
export const positionWorld: any
export const pow: any
export const reflect: any
export const reflector: any
export const saturate: any
export const select: any
export const sin: any
export const smoothstep: any
export const sqrt: any
export const step: any
export const sub: any
export const texture: any
export const texture3D: any
export const textureStore: any
export const time: any
export const uint: any
export const uniform: any
export const uv: any
export const varyingProperty: any
export const vec2: any
export const vec3: any
export const vec4: any
export const viewZToOrthographicDepth: any
export const wgslFn: any
