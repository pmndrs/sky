# PMREM lab

Experiments behind [`SKY_PMREM_SPEC.md`](../../SKY_PMREM_SPEC.md). Plain
WebGPU pages with no build step, served statically and driven headless.

| File                                                                  | Phase | What it does                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lab.js`                                                              | –     | Shared WebGPU pieces: synthetic and captured sources, cached prefilter plans (FIS / reduction integration / tiled integration), arbitrary-level prefilter + CubeUV atlas pack, brute-force reference, error metric, sphere-grid renderer |
| `bench-r185.html`, `bench-r186.html`, `bench-dev.html` (+ `bench.js`) | 0     | three's `PMREMGenerator` on the same sky-like cube, 64/128/256                                                                                                                                                                           |
| `timing.html`                                                         | 1     | First raw compute prefilter (FIS on every level) at 16–256 samples                                                                                                                                                                       |
| `quality.html`                                                        | 2a    | First quality harness, synthetic skies (superseded by `plans.html`)                                                                                                                                                                      |
| `plans.html`                                                          | 2b/2c | Candidate plans vs the reference, per level, on real-sky captures + the synthetic stress sky                                                                                                                                             |
| `breakdown.html`                                                      | 2b    | Per-step cost of one plan                                                                                                                                                                                                                |
| `timing-rr.html`                                                      | 2b    | Round-robin timing across plans (min / median / max): use this for speed                                                                                                                                                                 |
| `spheres.html`                                                        | 2c    | Q6 proxy: sphere-grid renders lit by each plan vs the reference, 8-bit diffs                                                                                                                                                             |
| `capture-sky.mjs`                                                     | 2c    | Captures the library's baked sky cube at six sun elevations into `captures/` (git-ignored)                                                                                                                                               |
| `atlas-r185.html`, `atlas-r186.html` (+ `atlas.js`)                   | 3     | CubeUV atlas writer for r185/r186 ([`ATLAS_NOTES.md`](ATLAS_NOTES.md)): layout check vs three, sphere grid through three's own sampler (three's atlas / ours / ideal) vs truth, timing                                                   |

## Run

```sh
# three sources for Phase 0 (not committed; see .gitignore)
cd research/pmrem-lab && mkdir -p three && cd three
ln -s ../../../node_modules/three r185
npm pack three@0.186.1 && mkdir r186 && tar -xzf three-0.186.1.tgz -C r186 && rm three-0.186.1.tgz
git clone --depth 1 --filter=blob:none --sparse -b dev https://github.com/mrdoob/three.js dev-repo \
  && (cd dev-repo && git sparse-checkout set src)
cd ../../..

python3 -m http.server 5218 --directory research/pmrem-lab &
node research/pmrem-lab/run.mjs bench
node research/pmrem-lab/run.mjs timing.html
node research/pmrem-lab/run.mjs quality.html

# real-sky captures need the examples dev server
pnpm --filter @pmndrs/sky-example-vanilla dev --port 5219 &
node research/pmrem-lab/capture-sky.mjs
node research/pmrem-lab/run.mjs plans.html
node research/pmrem-lab/run.mjs spheres.html
node research/pmrem-lab/run.mjs timing-rr.html

# CubeUV atlas writer (r185 / r186); flags: ?quick (one variant) ?skies=a,b ?timing (timing only) ?extra ?png
node research/pmrem-lab/run.mjs atlas-r185.html
node research/pmrem-lab/run.mjs atlas-r186.html
```

Timings are burst wall-clock (N submits, one `onSubmittedWorkDone`). The
quality page creates bind groups per run, which inflates its `ms` column;
use `timing.html` for speed.
