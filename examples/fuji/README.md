# Sagami Bay — Sky 0.6 grade showcase

A styled coastal print that mounts the public `@pmndrs/sky/editor` in a floating, resizable Print studio. Drag its header to move it, drag the bottom-right corner to resize it, or use the expand/restore button. Scene & print opens by default; Sky grade holds the editor. The authored grade drives the sky, water lighting and aerial haze together. Haze, Dusk and Night animate the physical lighting without replacing the edited grade; reduced-motion preferences switch immediately.

From the repository root:

```sh
pnpm install
pnpm example:fuji
```

Open http://127.0.0.1:5191. Select **Adjust print → Sky grade** to edit the grade, compare Physical, navigate the sun, undo/redo, and save/load JSON. **Scene & print** controls the sun/lens effects, water, haze, ground fog, paper and camera. **Restore Fuji grade** restores the authored starting point through the editor's undoable import path. Draft storage is offered explicitly, never loaded over the starting grade automatically.

The top **Sky & atmosphere** section keeps Time of day, Sun elevation/heading, Sky brightness and Haze/turbidity directly available. Moving time follows the solar clock; elevation/heading select manual positioning. Scene navigation releases editor playback and cancels edition transitions; choosing an edition takes control back. Distance haze is immediately below these controls, while Sun & lens starts collapsed.

**Preview visible sun** selects Haze at 4° elevation / 256° heading, with a 1.2° disc, brightness 150, bloom and camera exposure 0.2. Adjust **Sun diameter (°)** in Sun & lens from 0.1° to 3°; reset restores the physical starting diameter of 0.535°. Size is a cinematic override, separate from the direct light's illumination. Dusk/Night normally put the source below the horizon. The final print explicitly uses ACES filmic tone mapping; Camera exposure prevents the sun and surrounding pale sky from both clipping to the same white. This is camera rendering, without changes to the library sky shader.

The original Tidewater four-cascade FFT, normals, detail and foam implementation are retained under their included MIT license. Foam and slicks are fixed off in this demo; wind streaks remain available. The camera, terrain, physical water material, captures and paper finish are app-owned. Distant land is deliberately excluded from both water captures to match the reference composition; docks/blocks/rocks reflect. Terrain still gates the direct sun from one bay-level viewpoint, an approximation rather than a spatial shadow map. No reference photographs, local backups, or absolute source paths are shipped.

The visible sun is the scene disc attached by `SkySun`, so terrain depth hides it behind the hills. The demo sets additive blending on this disc's own material to retain the atmosphere underneath the emissive source, without changing any library shader. **Sun & lens** provides camera exposure, disc diameter/brightness, bloom enable/strength/spread/threshold, and glare enable/strength/angular radius/offscreen reach/wide veil, plus a reset button. These settings survive Haze/Dusk/Night changes. Disc radiance starts at 100, independently of the physical sunlight intensity of 0.75 driving the water highlight. Bright-source bloom runs on the HDR scene before tone mapping and paper, affecting the solar core and water glints. It can be disabled to remove its blur passes.

The separate lens glare is an artistic camera effect, not added atmospheric scattering. It follows the sun's direction, atmospheric attenuation, disc visibility, and camera-eye terrain visibility; it extends slightly outside the frame and fades to zero farther off-axis or behind the camera. Camera translation produces no source parallax. Terrain visibility is cached until the eye, source direction or disc size changes. The disc and camera effects stay out of water captures to avoid counting solar reflection twice. The library's sky shader and atmospheric scattering are unchanged.

The Pages workflow builds this workspace at `/examples/fuji/` with the site's base path and copies it into the same artifact as the other examples. Library imports resolve to this repository's source; production output is self-contained. The example uses R3F canary's renderer/root and render override APIs while the library's existing React example retains its current dependency version.

Verified locally: the library's 212 tests and CI checks; Fuji's transition and terrain-visibility tests; the docs CLI, gallery and Fuji builds merged under a `/sky` base path; desktop grade edits/presets, undo/redo, Physical comparison and solar playback/handoff; studio movement, resizing and expand/restore; and a 390×844 studio without horizontal overflow. Terrain visibility sampling keeps the input sun vector unchanged. The default compass mapping aligns the stage's authored 286° view while retaining the original edition composition.

```sh
pnpm --filter @pmndrs/sky-example-fuji build
pnpm --filter @pmndrs/sky-example-fuji test
```
