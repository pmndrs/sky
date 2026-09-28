/**
 * Compile Sébastien Hillaire's reference HLSL (UnrealEngineSkyAtmosphere, EGSR
 * 2020 — the D3D11 demo Unreal's SkyAtmosphere grew out of) to WGSL with Slang,
 * so it runs unmodified next to @pmndrs/sky in 21-sebh-compare.html.
 *
 * His repo is Windows-only because of its D3D11 host, not its shaders. Slang
 * reads the HLSL as-is; the only adaptations are mechanical and live here:
 *
 *   - register spaces: D3D keeps b/t/s/u apart, WGSL has one binding space per
 *     group, so they are shifted to b→0.., t→10.., s→30.., u→40..
 *   - matrices: `-matrix-layout-row-major`, so the host uploads ordinary
 *     column-vector matrices row by row (sebh/SebhReference.js)
 *   - the AP camera volume: his geometry shader routes each instance to a 3D
 *     slice (SV_RenderTargetArrayIndex); WebGPU has no layered rendering, so
 *     sebh/CameraVolumeSlice.slang draws one pass per slice and calls his
 *     RenderCameraVolumePS unchanged
 *   - a Slang WGSL-emitter bug leaves @location/@interpolate on structs that
 *     are only used internally (never as entry IO); Tint rejects those, so
 *     they are stripped (stripInternalIoAttributes)
 *   - two unclamped sqrt(1 − x²) in SkyViewLutPS are clamped (PATCHES below):
 *     the only source edits, identical to his code for every valid input
 *
 * Outputs (committed, so nobody needs Slang to run the page):
 *   sebh/generated/*.wgsl      one module per entry point
 *   sebh/generated/manifest.json  entry → bindings, plus both constant-buffer layouts
 *   sebh/generated/bluenoise64.bin  the 64×64 blue-noise tile his path tracer reads
 *
 *   node scripts/build-sebh-wgsl.mjs            # clones his repo + fetches Slang into .cache/
 *   SEBH_REPO=~/src/UnrealEngineSkyAtmosphere SLANGC=/path/to/slangc node scripts/build-sebh-wgsl.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Pinned inputs. Bump deliberately and re-run scripts/verify-sebh.mjs.
const SEBH_URL = 'https://github.com/sebh/UnrealEngineSkyAtmosphere.git'
const SEBH_COMMIT = '183ead5bdacc701b3b626347a680a2f3cd3d4fbd'
const SLANG_VERSION = '2026.18.3'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const CACHE = path.join(APP, '.cache')
const SEBH_DIR = path.join(APP, 'sebh')
const OUT = path.join(SEBH_DIR, 'generated')

// Source patches, applied to a temporary copy of his Resources/. Keep this
// list minimal: each entry must be a no-op wherever his code is well defined.
const PATCHES = [
  {
    file: 'Resources/RenderSkyRayMarching.hlsl',
    find: 'viewZenithSinAngle * sqrt(1.0 - lightViewCosAngle * lightViewCosAngle),',
    replace: 'viewZenithSinAngle * sqrt(max(0.0, 1.0 - lightViewCosAngle * lightViewCosAngle)),',
    why:
      'SkyViewLutPS: the last LUT column maps to lightViewCosAngle = -(1+ε) once ' +
      'fromSubUvsToUnit(191.5/192) rounds above 1 (it does through Slang/Metal), so sqrt goes ' +
      'NaN and bilinear filtering spreads it across the anti-sun sky.',
  },
  {
    file: 'Resources/RenderSkyRayMarching.hlsl',
    find: 'SunDir = normalize(float3(sqrt(1.0 - sunZenithCosAngle * sunZenithCosAngle), 0.0, sunZenithCosAngle));',
    replace:
      'SunDir = normalize(float3(sqrt(max(0.0, 1.0 - sunZenithCosAngle * sunZenithCosAngle)), 0.0, sunZenithCosAngle));',
    why: 'SkyViewLutPS: same NaN when dot(up, sun) rounds above 1 (sun at the zenith).',
  },
]

function patchedSources(repo, tmp) {
  const root = path.join(tmp, 'src')
  fs.cpSync(path.join(repo, 'Resources'), path.join(root, 'Resources'), {
    recursive: true,
    filter: (f) => fs.statSync(f).isDirectory() || f.endsWith('.hlsl'),
  })
  for (const p of PATCHES) {
    const file = path.join(root, p.file)
    const src = fs.readFileSync(file, 'utf8')
    const hits = src.split(p.find).length - 1
    if (hits !== 1) throw new Error(`patch expected 1 match in ${p.file}, found ${hits}: ${p.find}`)
    fs.writeFileSync(file, src.replace(p.find, p.replace))
  }
  return root
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString()

// ---------------------------------------------------------------------------
// Inputs: his repo and a Slang compiler
// ---------------------------------------------------------------------------
function resolveSebhRepo() {
  const dir = process.env.SEBH_REPO
    ? path.resolve(process.env.SEBH_REPO)
    : path.join(CACHE, 'UnrealEngineSkyAtmosphere')
  if (!fs.existsSync(path.join(dir, 'Resources', 'RenderSkyRayMarching.hlsl'))) {
    if (process.env.SEBH_REPO) throw new Error(`SEBH_REPO=${dir} does not look like his repo`)
    console.log(`cloning ${SEBH_URL} → ${dir}`)
    fs.mkdirSync(CACHE, { recursive: true })
    run('git', ['clone', '--quiet', SEBH_URL, dir])
  }
  const head = run('git', ['-C', dir, 'rev-parse', 'HEAD']).trim()
  if (head !== SEBH_COMMIT) {
    if (process.env.SEBH_REPO) {
      console.warn(`warning: ${dir} is at ${head}, pinned ${SEBH_COMMIT} — output will not match the committed files`)
    } else {
      run('git', ['-C', dir, 'fetch', '--quiet', 'origin'])
      run('git', ['-C', dir, 'checkout', '--quiet', SEBH_COMMIT])
    }
  }
  return dir
}

function slangPlatform() {
  const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64'
  if (process.platform === 'darwin') return `macos-${arch}`
  if (process.platform === 'linux') return `linux-${arch}`
  if (process.platform === 'win32') return `windows-${arch}`
  throw new Error(`no Slang release for ${process.platform}; set SLANGC`)
}

// `slangc -v` prints the version on stderr.
function slangcVersion(bin) {
  const r = spawnSync(bin, ['-v'], { encoding: 'utf8' })
  return `${r.stdout}${r.stderr}`.trim()
}

async function resolveSlangc() {
  if (process.env.SLANGC) return process.env.SLANGC
  const dir = path.join(CACHE, `slang-${SLANG_VERSION}`)
  const bin = path.join(dir, 'bin', process.platform === 'win32' ? 'slangc.exe' : 'slangc')
  if (!fs.existsSync(bin)) {
    const name = `slang-${SLANG_VERSION}-${slangPlatform()}.zip`
    const url = `https://github.com/shader-slang/slang/releases/download/v${SLANG_VERSION}/${name}`
    console.log(`downloading ${url}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    fs.mkdirSync(dir, { recursive: true })
    const zip = path.join(CACHE, name)
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
    run(
      process.platform === 'win32' ? 'tar' : 'unzip',
      process.platform === 'win32' ? ['-xf', zip, '-C', dir] : ['-qo', zip, '-d', dir],
    )
    fs.rmSync(zip)
  }
  const version = slangcVersion(bin)
  if (version !== SLANG_VERSION) console.warn(`warning: slangc reports ${version}, pinned ${SLANG_VERSION}`)
  return bin
}

// ---------------------------------------------------------------------------
// Entry points. Defines mirror the permutations Game.cpp compiles for his
// default UI state (Game.h: fast sky on, fast AP on, coloured transmittance
// off, shadow map off, transmittance method = LUT).
// ---------------------------------------------------------------------------
const RAYMARCH = 'Resources/RenderSkyRayMarching.hlsl'
const PATHTRACE = 'Resources/RenderSkyPathTracing.hlsl'
const ENTRIES = [
  { name: 'ScreenTriangleVS', file: 'Resources/Common.hlsl', entry: 'ScreenTriangleVertexShader', stage: 'vertex' },
  { name: 'TransmittanceLutPS', file: RAYMARCH, entry: 'RenderTransmittanceLutPS', stage: 'fragment' },
  // Game.cpp:83 — the only entry he compiles with ILLUMINANCE_IS_ONE.
  {
    name: 'MultiScattCS',
    file: RAYMARCH,
    entry: 'NewMultiScattCS',
    stage: 'compute',
    defines: { ILLUMINANCE_IS_ONE: 1 },
    storageFormat: 'rgba16float',
  },
  {
    name: 'SkyViewLutPS',
    file: RAYMARCH,
    entry: 'SkyViewLutPS',
    stage: 'fragment',
    defines: { MULTISCATAPPROX_ENABLED: 1 },
  },
  {
    name: 'CameraVolumeSlicePS',
    file: 'sebh/CameraVolumeSlice.slang',
    local: true,
    entry: 'CameraVolumeSlicePS',
    stage: 'fragment',
    defines: { MULTISCATAPPROX_ENABLED: 1 },
  },
  // His default composite: Sky-View LUT for sky pixels, AP volume for the rest.
  {
    name: 'RayMarchingFastPS',
    file: RAYMARCH,
    entry: 'RenderRayMarchingPS',
    stage: 'fragment',
    defines: { MULTISCATAPPROX_ENABLED: 1, FASTSKY_ENABLED: 1, FASTAERIALPERSPECTIVE_ENABLED: 1 },
  },
  // Same shader with both LUT shortcuts off: a per-pixel raymarch (variable
  // 4–14 SPP, still with the MS LUT) — isolates Sky-View LUT error.
  {
    name: 'RayMarchingFullPS',
    file: RAYMARCH,
    entry: 'RenderRayMarchingPS',
    stage: 'fragment',
    defines: { MULTISCATAPPROX_ENABLED: 1, FASTSKY_ENABLED: 0, FASTAERIALPERSPECTIVE_ENABLED: 0 },
  },
  // Ground truth: his spectral path tracer, no multi-scattering approximation.
  {
    name: 'PathTracingPS',
    file: PATHTRACE,
    entry: 'RenderPathTracingPS',
    stage: 'fragment',
    defines: { TRANSMITANCE_METHOD: 2, GROUND_GI_ENABLED: 0, MULTISCATAPPROX_ENABLED: 0, SHADOWMAP_ENABLED: 0 },
  },
  {
    name: 'PathTracingGroundGiPS',
    file: PATHTRACE,
    entry: 'RenderPathTracingPS',
    stage: 'fragment',
    defines: { TRANSMITANCE_METHOD: 2, GROUND_GI_ENABLED: 1, MULTISCATAPPROX_ENABLED: 0, SHADOWMAP_ENABLED: 0 },
  },
  {
    name: 'ApplySkyAtmospherePS',
    file: 'Resources/PostProcess.hlsl',
    entry: 'ApplySkyAtmospherePS',
    stage: 'fragment',
  },
  { name: 'PostProcessPS', file: 'Resources/PostProcess.hlsl', entry: 'PostProcessPS', stage: 'fragment' },
]

const SLANG_FLAGS = [
  '-target',
  'wgsl',
  '-matrix-layout-row-major',
  ...[
    '-fvk-b-shift',
    '0',
    'all',
    '-fvk-t-shift',
    '10',
    'all',
    '-fvk-s-shift',
    '30',
    'all',
    '-fvk-u-shift',
    '40',
    'all',
  ],
  // register-without-vk-binding, binding overlap (both expected with shifts),
  // macro redefinition and implicit float→uint in his sources.
  '-warnings-disable',
  '39029,39001,15400,30081',
]

// Slang emits entry IO structs with @location/@builtin, but also leaves those
// attributes on structs his code passes around internally (GeometryOutput,
// VertexOutput inside the path tracer). WGSL only allows them on entry IO.
function entrySignatureTypes(wgsl) {
  const types = new Set()
  for (const m of wgsl.matchAll(/@(?:vertex|fragment|compute)[\s\S]*?\bfn\s+\w+\s*\(/g)) {
    // Parameters hold @builtin(...) etc., so walk to the balancing paren.
    let i = m.index + m[0].length
    let depth = 1
    const start = i
    while (depth > 0 && i < wgsl.length) {
      if (wgsl[i] === '(') depth++
      else if (wgsl[i] === ')') depth--
      i++
    }
    for (const t of wgsl.slice(start, i - 1).matchAll(/:\s*(\w+)/g)) types.add(t[1])
    const ret = /^\s*->\s*(\w+)/.exec(wgsl.slice(i))
    if (ret) types.add(ret[1])
  }
  return types
}

function stripInternalIoAttributes(wgsl) {
  const entryIo = entrySignatureTypes(wgsl)
  return wgsl.replace(/struct\s+(\w+)\s*\{([^}]*)\}/g, (all, name, body) => {
    if (entryIo.has(name)) return all
    const cleaned = body.replace(/@(?:location\(\d+\)|interpolate\([\w, ]+\)|builtin\(\w+\))\s*/g, '')
    return `struct ${name}\n{${cleaned}}`
  })
}

// RWTexture2D<float4> comes out as `texture_storage_2d<rgba32float, read_write>`,
// which core WebGPU does not allow. His only UAV target (the multi-scattering
// LUT, NewMultiScattCS) is write-only and R16G16B16A16_FLOAT in Game.cpp:432,
// so declare exactly that.
function writeOnlyStorage(wgsl, format) {
  return wgsl.replace(/(var\s+(\w+)\s*:\s*texture_storage_2d<)\w+,\s*read_write>/g, (all, head, name) => {
    if (wgsl.includes(`textureLoad((${name})`) || wgsl.includes(`textureLoad(${name}`)) return all
    return `${head}${format}, write>`
  })
}

// `@binding(N) @group(0) var<uniform> NAME : T;` → { binding, name, kind }
function parseBindings(wgsl) {
  const out = []
  for (const m of wgsl.matchAll(/@binding\((\d+)\)\s*@group\(0\)\s*var(?:<([\w, ]+)>)?\s+(\w+)\s*:\s*([^;]+);/g)) {
    const [, binding, space, name, type] = m
    const kind = space?.startsWith('uniform')
      ? 'uniform'
      : space?.startsWith('storage')
        ? 'storage'
        : type.startsWith('sampler')
          ? 'sampler'
          : type.includes('storage')
            ? 'storageTexture'
            : 'texture'
    out.push({ binding: +binding, name: name.replace(/_0$/, ''), kind, type: type.trim() })
  }
  return out
}

function cbufferLayout(reflection, cbName) {
  const p = reflection.parameters.find((x) => x.name === cbName)
  if (!p) return null
  const el = p.type.elementVarLayout
  const fields = {}
  for (const f of el.type.fields) {
    const scalar = f.type.scalarType ?? f.type.elementType?.scalarType ?? f.type.elementType?.elementType?.scalarType
    fields[f.name] = {
      offset: f.binding.offset,
      size: f.binding.size,
      kind: f.type.kind,
      ...(scalar ? { scalar } : {}),
      ...(f.type.elementCount ? { count: f.type.elementCount } : {}),
    }
  }
  return { binding: p.binding.index, size: el.binding.size, fields }
}

async function main() {
  const repo = resolveSebhRepo()
  const slangc = await resolveSlangc()
  fs.mkdirSync(OUT, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sebh-wgsl-'))
  const slangVersion = slangcVersion(slangc)

  const src = patchedSources(repo, tmp)
  const manifest = {
    source: { repo: SEBH_URL, commit: SEBH_COMMIT },
    patches: PATCHES.map(({ file, find, replace, why }) => ({ file, find, replace, why })),
    slang: slangVersion,
    flags: SLANG_FLAGS.join(' '),
    entries: {},
    cbuffers: {},
  }

  for (const e of ENTRIES) {
    const input = e.local ? path.join(APP, e.file) : path.join(src, e.file)
    const outFile = path.join(OUT, `${e.name}.wgsl`)
    const reflFile = path.join(tmp, `${e.name}.json`)
    const defs = Object.entries(e.defines ?? {}).flatMap(([k, v]) => ['-D', `${k}=${v}`])
    // Includes are written "./Resources/X.hlsl", so the repo root is the include dir.
    const args = [input, '-I', src, '-entry', e.entry, '-stage', e.stage, ...defs, ...SLANG_FLAGS]
    args.push('-o', outFile, '-reflection-json', reflFile)
    try {
      run(slangc, args, { cwd: src })
    } catch (err) {
      throw new Error(`${e.name}: slangc failed\n${err.stderr?.toString() ?? err.message}`)
    }
    const raw = fs.readFileSync(outFile, 'utf8')
    let wgsl = stripInternalIoAttributes(raw)
    if (e.storageFormat) wgsl = writeOnlyStorage(wgsl, e.storageFormat)
    const header =
      `// GENERATED by examples/vanilla/scripts/build-sebh-wgsl.mjs — do not edit.\n` +
      `// ${e.file} :: ${e.entry} (${e.stage})` +
      (e.defines
        ? ` ${Object.entries(e.defines)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}`
        : '') +
      `\n// Source: ${SEBH_URL} @ ${SEBH_COMMIT.slice(0, 12)} (MIT, © Epic Games). Compiled with Slang ${slangVersion}.\n\n`
    fs.writeFileSync(outFile, header + wgsl)

    const refl = JSON.parse(fs.readFileSync(reflFile, 'utf8'))
    for (const cb of ['CONSTANT_BUFFER', 'SKYATMOSPHERE_BUFFER', 'SliceCB']) {
      const layout = cbufferLayout(refl, cb)
      if (layout && !manifest.cbuffers[cb]) manifest.cbuffers[cb] = layout
    }
    manifest.entries[e.name] = {
      file: `${e.name}.wgsl`,
      entry: e.entry,
      stage: e.stage,
      defines: e.defines ?? {},
      bindings: parseBindings(wgsl),
    }
    console.log(`${e.name.padEnd(24)} ${String(wgsl.split('\n').length).padStart(5)} lines`)
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  // His path tracer reads BlueNoise2dTexture[(pixPos * 7) % 64].r — only the
  // top-left 64×64 of the 448² EXR. three's EXRLoader stores rows bottom-up,
  // so row y (D3D, top-down) is loader row height-1-y.
  const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js')
  const { FloatType } = await import('three')
  const exr = fs.readFileSync(path.join(repo, 'Resources', 'bluenoise.exr'))
  const loader = new EXRLoader()
  loader.setDataType(FloatType)
  const tex = loader.parse(exr.buffer.slice(exr.byteOffset, exr.byteOffset + exr.byteLength))
  const tile = new Float32Array(64 * 64)
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) tile[y * 64 + x] = tex.data[((tex.height - 1 - y) * tex.width + x) * 4]
  }
  fs.writeFileSync(path.join(OUT, 'bluenoise64.bin'), Buffer.from(tile.buffer))
  console.log(`bluenoise64.bin          64×64 r32f from ${tex.width}×${tex.height} EXR`)

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`)
}

main().catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})
