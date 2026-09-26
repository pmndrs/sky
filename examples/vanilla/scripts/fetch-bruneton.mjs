/**
 * Download Eric Bruneton's precomputed atmosphere textures (and, for
 * completeness, the shader dumps + demo.js) into public/bruneton/.
 *
 * The .dat files total 16.3 MB and are gitignored; the shaders and demo.js are
 * committed but re-fetched here so a stale vendored copy can be diffed against
 * upstream. Files that already exist are skipped unless --force is passed.
 *
 *   node scripts/fetch-bruneton.mjs [--force]
 *
 * Source: https://ebruneton.github.io/precomputed_atmospheric_scattering/
 * (BSD-3 — see public/bruneton/LICENSE).
 */
import fs from 'node:fs'
import path from 'node:path'

const REMOTE = 'https://ebruneton.github.io/precomputed_atmospheric_scattering/'
const OUT = new URL('../public/bruneton/', import.meta.url).pathname
const FILES = [
  'transmittance.dat',
  'scattering.dat',
  'irradiance.dat',
  'vertex_shader.txt',
  'fragment_shader.txt',
  'atmosphere_shader.txt',
  'demo.js',
]
const force = process.argv.includes('--force')

fs.mkdirSync(OUT, { recursive: true })
for (const name of FILES) {
  const dest = path.join(OUT, name)
  if (!force && fs.existsSync(dest)) {
    console.log(`skip   ${name} (exists)`)
    continue
  }
  const res = await fetch(REMOTE + name)
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(dest, buf)
  console.log(`fetched ${name} (${(buf.length / 1024).toFixed(0)} KB)`)
}
