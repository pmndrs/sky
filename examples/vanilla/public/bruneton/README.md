# Vendored: Eric Bruneton's WebGL demo

Everything in this directory is Eric Bruneton's, from
<https://github.com/ebruneton/precomputed_atmospheric_scattering> (BSD-3, see
`LICENSE`). It is the reference the `20-bruneton-compare.html` example renders
side-by-side with `@pmndrs/sky`.

| File                    | Origin                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| `demo.js`               | `atmosphere/demo/webgl/demo.js`, **unmodified** (md5 `c61bf40b…`)   |
| `vertex_shader.txt`     | dumped by `atmosphere/demo/webgl/precompute.cc` (his C++ demo)      |
| `fragment_shader.txt`   | same — the demo's scene shader (sky + ground + 1 km sphere)         |
| `atmosphere_shader.txt` | same — `functions.glsl` with the Earth `ATMOSPHERE` constants baked |
| `*.dat`                 | same — transmittance / scattering / irradiance textures (float32)   |

The `.dat` files are 16.3 MB and are **not committed**. Run
`node scripts/fetch-bruneton.mjs` from `examples/vanilla/` to download them
from <https://ebruneton.github.io/precomputed_atmospheric_scattering/>. The
example also falls back to fetching from that site at runtime (it serves
`Access-Control-Allow-Origin: *`), so the page works without the local copy —
it is just slower to load.

Model constants baked into `atmosphere_shader.txt` (radiance mode, RGB at
680 / 550 / 440 nm):

- `solar_irradiance = (1.474, 1.8504, 1.91198)` W/m²/nm
- `sun_angular_radius = 0.004675`
- `bottom_radius = 6360`, `top_radius = 6420` km (ours: 6460)
- Rayleigh `(0.005802, 0.013558, 0.0331)` /km, scale height 8 km
- Mie scattering `0.003996`, extinction `0.00444` /km, g = 0.8, scale height 1.2 km
- ozone tent 25 km ± 15 km, `(0.00065, 0.001881, 0.000085)` /km
- `ground_albedo = 0.1`, `mu_s_min = cos(102°)`

The demo's tone map is `pow(1 - exp(-radiance * exposure), 1/2.2)` with
`white_point = 1` and `exposure = 10` by default.
