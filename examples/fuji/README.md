# Sagami Bay — Sky 0.6 grade showcase

A styled coastal print that mounts the public `@pmndrs/sky/editor` in a floating, resizable Print studio. Drag its header to move it, drag the bottom-right corner to resize it, or use the expand/restore button. Scene & print opens by default; Sky grade holds the editor. The authored grade drives the sky, water lighting and aerial haze together. Haze, Dusk and Night animate the physical lighting without replacing the edited grade; reduced-motion preferences switch immediately.

From the repository root:

```sh
pnpm install
pnpm example:fuji
```

Open http://127.0.0.1:5191. Select **Adjust print → Sky grade** to edit the grade, compare Physical, navigate the sun, undo/redo, and save/load JSON. **Scene & print** controls the water, haze, ground fog, paper and camera. **Restore Fuji grade** restores the authored starting point through the editor's undoable import path. Draft storage is offered explicitly, never loaded over the starting grade automatically.

The original Tidewater four-cascade FFT, normals, detail and foam implementation are retained under their included MIT license. Foam and slicks are fixed off in this demo; wind streaks remain available. The camera, terrain, physical water material, captures and paper finish are app-owned. Distant land is deliberately excluded from both water captures to match the reference composition; docks/blocks/rocks reflect. Terrain still gates the direct sun from one bay-level viewpoint, an approximation rather than a spatial shadow map. No reference photographs, local backups, or absolute source paths are shipped.

The Pages workflow builds this workspace at `/examples/fuji/` with the site's base path and copies it into the same artifact as the other examples. Library imports resolve to this repository's source; production output is self-contained. The example uses R3F canary's renderer/root and render override APIs while the library's existing React example retains its current dependency version.

Verified locally: the library's 195 tests and CI checks; Fuji's transition and terrain-visibility tests; the docs CLI, gallery and Fuji builds merged under a `/sky` base path; desktop grade edits/presets, undo/redo, Physical comparison and solar playback/handoff; studio movement, resizing and expand/restore; and a 390×844 studio without horizontal overflow. Terrain visibility sampling keeps the input sun vector unchanged. The default compass mapping aligns the stage's authored 286° view while retaining the original edition composition.

```sh
pnpm --filter @pmndrs/sky-example-fuji build
pnpm --filter @pmndrs/sky-example-fuji test
```
