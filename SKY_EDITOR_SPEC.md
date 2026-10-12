# Embeddable Sky Editor Spec

Status: approved. The first release is implemented in `src/editor` with an integration guide in `docs/guides/sky-editor.mdx`. Later effects bindings, independent draft preview and versioned settings files remain follow-up work. The component inventory below records the original demo before extraction.

Ship an optional `@pmndrs/sky/editor` entry that opens a floating editor over an application's existing scene. Users tune the sky, watch their own materials and distant geometry respond, and export a grade without visiting a separate demo. The app supplies its existing `Sky` and renderer and retains its render loop, camera, scene, and post-processing.

The first release should bring the complete grade authoring workflow into the app, with solar controls and basic atmosphere settings alongside it. More specialized atmosphere diagnostics can follow without delaying the authoring tool.

## User workflow

1. Add the editor import and two calls to the existing render loop. Connect an app button to `editor.toggle()`.
2. Open **Sky Editor** over the running game or demo. The editor starts with the sky's current settings and grade.
3. Scrub the sun, pick a keyframe or click a region in the dome preview, and edit its colors. The app scene is the main preview.
4. Switch to **Physical** to compare, or play through the day to check transitions.
5. Download or copy the grade JSON, or send committed changes to the app's own save flow.
6. Close the editor. Authored changes stay applied and the app continues running.

Opening the editor must preserve the current sky. A preset, cached draft, new light, or post-process should only be applied through an explicit control or host integration.

## Existing demo components

The authoring reference is [25-sky-grade-editor.html](examples/vanilla/25-sky-grade-editor.html), documented in [Grade editor and demos](docs/guides/grade-editor.mdx).

| Component            | Current source and behavior                                                                                                                                      | Embedded version                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Toolbar              | [main.js](examples/vanilla/grade-editor/main.js) and demo HTML: time, playback speed, physical bypass, starting presets, name, New, undo/redo, load/save/copy    | Editor toolbar and file menu; use instance-local elements and commands   |
| Main scene           | `main.js`: renderer, camera, ground, mountains, material props, orbit controls, sun, ambient, stars, haze and dithering                                          | Supplied by the app; keep scene construction in the demo                 |
| Timeline             | [timeline.js](examples/vanilla/grade-editor/timeline.js): elevation ruler, twilight marks, three grade swatch strips, playhead, key insertion/selection/dragging | Reusable timeline with explicit cleanup and keyboard alternatives        |
| Inspector            | [inspector.js](examples/vanilla/grade-editor/inspector.js): whole-sky grading, gradient stops, six zones, zone shapes, night fill and keyed ambient              | Reusable inspector; preserve focused inputs during live updates          |
| Dome preview         | [SkyGradePreview.ts](src/sky/SkyGradePreview.ts): GPU view of the live Sky-View LUT and grade tables; split, graded, physical and grade-only modes               | Small canvas inside the editor, rendered through the app's renderer      |
| Preview overlay      | [overlay.js](examples/vanilla/grade-editor/overlay.js): zone guides, sun marker, hover coordinates, gradient ticks and zone picking                              | Reusable overlay using `toDome`, `fromDome` and `gradeZoneWeights`       |
| Editor state         | `main.js`: selection, interpolated settings, auto-keying, undo snapshots, preset/import handling and debounced autosave                                          | Controller independent of DOM and demo scene setup                       |
| Solar navigation     | `main.js`: fixed latitude/date, conversion from elevation to evening time, direct sun override outside that day's range                                          | Explicit time and elevation modes using the host sky's solar inputs      |
| Layout and shortcuts | [editor.css](examples/vanilla/grade-editor/editor.css) styles the whole page; `main.js` listens on `window`                                                      | Scoped styles, movable shell and shortcuts active only inside the editor |

The inspector already exposes the authoring controls needed for the first release. The main extraction work is lifecycle, renderer integration, state synchronization, and the floating shell.

### What LUT means here

The dome is an authoring view of the physical sky with the grade applied. It is not a generic image color-grading LUT editor. A sky grade is authored as keyframe parameters and compiled into lookup tables internally.

The physical atmosphere also uses Transmittance, MultiScatter, SkyView and AerialPerspective LUTs. Their debug demos live in `10-transmittance-lut.html` through `13-aerial-perspective-lut.html`. Add these later as an advanced **Diagnostics** panel; grade editing does not require editing their raw texture values.

## Floating UI

Default to one nonmodal window anchored at the bottom right, approximately 760 by 560 CSS pixels on a desktop. Its title bar supports dragging, collapse and close; a corner handle resizes it. Keep its bounds inside the supplied container. Below the desktop width, stack the preview and inspector and allow the body to scroll.

```text
┌ Sky Editor                         [Collapse] [Close] ┐
│ Grade name      [Undo] [Redo] [Physical] [File]        │
│ [Grade] [Sun and Atmosphere]                          │
├──────────────────────────────────────────────────────┤
│ Time / Elevation       [Play] Speed      [Follow app] │
│ Timeline: twilight marks, swatches, keys, playhead    │
├──────────────────────────────┬───────────────────────┤
│ Dome preview                 │ Keyframe inspector    │
│ Split / Graded / Physical    │ Whole sky             │
│ Grade only                   │ Gradient / Zones      │
│ Zone guides, click to select │ Shape / Fill / Ambient│
├──────────────────────────────┴───────────────────────┤
│ Sun +4.5° · key 3/5 · Editing sun · Unsaved changes    │
└──────────────────────────────────────────────────────┘
        The application's scene remains visible around the window.
```

The **Grade** tab contains the existing authoring controls. **Sun and Atmosphere** contains runtime settings; these remain separate from keyframe settings. Label sky exposure as a luminance multiplier and keyframe exposure as EV so their units are clear.

Use a Shadow DOM root for default style isolation. Keep CSS inside the editor entry and expose theme properties on its host element. Importing the module must not touch `document`, create a window, or inject page-wide styles. Permit mounting into a caller-supplied container for an app sidebar or inspector as well as the default floating layout.

Pointer events outside the window pass through to the app. Stop input from reaching game controls while a user interacts with the tool, and expose a focus callback for apps that listen on global input handlers. Shortcuts are scoped to editor focus and ignore text fields and contenteditable elements. Escape closes the window when no nested menu is active and returns focus to the launcher.

Canvas timeline and zone interactions need equivalent buttons, numeric fields, and a zone selector. A keyboard user must be able to select, insert, move and delete a keyframe without using the canvas.

## Public integration API

Use a separate package subpath so UI code and styles load only when requested. Build it with the existing package; Three.js remains a peer dependency and the editor has no React dependency.

The first release implements this integration API:

```js
import { createSkyEditor } from '@pmndrs/sky/editor'

// renderer and sky are the application's existing instances.
const editor = createSkyEditor({
  sky,
  renderer,
  container: document.getElementById('game'), // optional; defaults to body
  open: false,
  onCommit: ({ grade }) => {
    // grade is a detached SkyGradeJSON snapshot for the app's save flow.
    saveGradeToProject(grade)
  },
})

skyEditorButton.addEventListener('click', () => editor.toggle())

// Add these calls to the application's existing loop.
function frame(dtSeconds) {
  editor.update(dtSeconds) // sync UI; apply editor playback before sky.update
  sky.update(camera)
  // Keep the app's existing AP update here if it uses aerial-perspective haze.
  renderApplication()
  editor.render() // optional dome draw, after the main render
}

// When this app view is destroyed:
// editor.dispose()
```

| Surface                         | Contract                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sky`, `renderer`               | Required. Renderer must be initialized and be the one used by this sky. The tool supports the library's WebGPU renderer path                      |
| `container`                     | Optional DOM mount and bounds for the floating window                                                                                             |
| `open`, `layout`                | Initial visibility; `layout` is `floating` or `embedded`                                                                                          |
| `requestRender()`               | Optional callback for apps that render on demand; called on visual changes and while editor playback needs another frame                          |
| `onCommit({ grade })`           | One notification per completed grade transaction, including undo/redo, rename, import and preset replacement; no notifications for time scrubbing |
| `onFocusChange(focused)`        | Host can suspend keyboard/mouse game controls while editor input is active                                                                        |
| `acquireSunControl()`           | Optional host callback, returning a release function or `false`; coordinates exclusive editing with an app day/night controller                   |
| `open()`, `close()`, `toggle()` | Visibility lifecycle. Closing stops playback and releases sun control; edits stay applied                                                         |
| `update(dtSeconds)`             | Synchronizes external changes and advances editor playback; never updates the sky bake or renders the app                                         |
| `render()`                      | Draws the dome only when visible and dirty; never renders or resizes the main canvas                                                              |
| `getGradeJSON()`                | Returns the current authored grade as detached JSON, including while physical comparison is active                                                |
| `loadGrade(json)`               | Validates and installs a saved grade as one undoable transaction                                                                                  |
| `dispose()`                     | Idempotent cleanup of editor resources; keeps authored changes and leaves host resources alive                                                    |

Also expose `followApp()` to stop playback and release editor sun control, giving the host a way to revoke an editing session.

`onSettingsCommit({ settings })` supports host-owned runtime settings persistence. Grade commits and settings commits have distinct payloads: a grade file does not contain atmosphere or time configuration.

## State and editing behavior

### Grade ownership

Bind to the current `sky.grade` and edit it through the public `SkyGrade` methods. Preserve that grade object's identity across edits, imports, presets and undo by restoring its name and calling `setKeys`. An app intentionally sharing one grade among skies will see those edits everywhere; apps wanting independent authoring can assign `sky.grade.clone()` before opening the editor.

For a physical sky with `grade === null`, keep an empty local draft. Attach it only when the first authoring action occurs. Merely opening or selecting a tab must not assign a grade.

Observe grade replacement as well as changes within a grade. The baker already exposes `addGradeListener`; expose a facade `sky.onGradeChange(listener)` wrapper so the editor can use a stable high-level contract. Subscribe to the retained grade itself during comparison, when it is detached from the sky. Tag synchronous editor commands so their own notifications do not count as external changes. Rebind on external replacement, discard history for the old binding, and reflect the new grade. A change made outside the editor to the bound grade establishes a new history baseline so undo cannot silently overwrite that change.

### Keyframes and history

Keys are stored by **sun elevation in degrees**, independent of the displayed clock time. Keep the existing behaviors: a one-key grade holds all day; between keys the inspector shows interpolated settings and the first edit inserts a key. Use `MAX_GRADE_KEYS` from the package, currently 16, across every insertion path.

`updateKey` returns a replacement key, so selection must track its return value rather than a stale index after sorting. Use the demo's 0.25° selection tolerance as an initial UI value. Handle keys at matching elevations deterministically and disable insertion when an existing key occupies that elevation.

Coalesce a slider drag, color gesture or key drag into one undo transaction. Treat auto-key insertion and its first edit as the same transaction. Reject invalid input before mutating the active grade. Rename commands need explicit history and commit handling because setting `grade.name` alone does not emit `onChange`.

Inserting interpolated parameters is only approximately neutral when neighboring keyframes have different shapes: the runtime interpolates baked tables. Preserve the library's behavior and do not promise a pixel-identical insertion.

### Comparison and closing

The **Physical** toggle temporarily calls `sky.setGrade(null)` while retaining the authored grade and history. Export always uses the retained grade. On returning to graded view, closing or disposing, restore the retained grade only if the tool still owns that comparison state. If the host replaces the grade during comparison, respect that replacement and end the comparison.

The current `SkyGradePreview` reads the sky's live grade uniforms. During physical comparison, its graded and grade-only views therefore cannot show a detached draft. Force the preview to Physical and explain the state in the toolbar; restore the chosen preview mode when comparison ends. Independently previewing an unattached grade would require a later preview API extension.

### Sun control

Start in **Follow app**: observe the sun without writing time or direction. Grade edits remain available. On the first scrub or play action, acquire editor sun control through the optional host callback. If the host refuses, keep navigation read-only and show that the app controls the sun. If no callback is supplied, assume the application permits editor writes.

While editor sun control is active, the host must pause its competing solar writes. Release it on **Follow app**, close, dispose, or a host revocation. Pause playback whenever the user manually scrubs. The release callback decides whether the app resumes from the authored pose or its own simulation clock.

Provide two explicit modes:

- **Time** uses `setTimeOfDay`, `setLatitude` and `setDayOfYear`. It displays the actual elevation and lets the user play 0–24 hours at a stated hours-per-second speed.
- **Elevation** uses `setSunDirection` and an azimuth control. Timeline scrubbing and selecting a key enter this mode, giving access to any grade key regardless of season or latitude. Label it as a manual sun pose; do not display a stale clock time as the active position.

Returning to Time explicitly recomputes solar position from the saved time inputs. Avoid inheriting the demo's evening-only elevation-to-time conversion: a given elevation can occur in both morning and evening, and some elevations are unreachable for a particular day and latitude.

For a planet-frame camera, the grade evaluates elevation against the camera's local up, whereas `sky.sunElevation` reports the configured world pose. Expose the evaluated elevation in public readback for correct selection and refresh it after the host's sky update. Local elevation-to-world sun navigation needs a corresponding conversion or host binding; until that exists, keep manual timeline scrubbing read-only in planet-frame scenes. The first release's direct manual navigation targets the usual Y-up ground scene.

## Settings and capability boundaries

| Panel               | Controls and existing API                                                                                                                                 | Release                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Grade               | All current inspector controls, timeline, presets, dome modes, guides, physical comparison and file actions; `SkyGrade`, `SkyGradePreview`, grade helpers | First release                                                                     |
| Sun                 | Time, latitude, day of year, elevation/azimuth, north, sun color and disc; corresponding `Sky` setters                                                    | First release                                                                     |
| Atmosphere          | Earth/Mars/Titan, sky exposure, turbidity, ground albedo; `setPreset`, `setExposure`, `setTurbidity`, `setGroundAlbedo`                                   | First release                                                                     |
| Haze and fog        | Strength, policy, altitude blend, AP distance scale and fog parameters; existing live setters                                                             | Follow-up, only for host-connected effects                                        |
| Lighting and night  | Controls for host-supplied sun, ambient and night helpers                                                                                                 | Follow-up through explicit bindings                                               |
| Advanced atmosphere | Scattering, absorption, radii, density profiles and multi-scattering; `setAtmosphere`, `setMultiScatteringFactor`                                         | Follow-up with units and validation                                               |
| Diagnostics         | Physical LUT views, AP slice selection, actual texture sizes and bake state                                                                               | Follow-up                                                                         |
| Quality             | Quality tier, cube size and LUT allocation                                                                                                                | Display only initially; changing them requires host-owned instance reconstruction |

Haze/fog setters do not insert a post-process into the app. Ambient grade keys do not create a `SkyAmbient` light. Show those controls' authored values, but identify when the host has not connected the corresponding effect or helper. Accept explicit capability bindings rather than inferring pipeline support from internal uniforms.

The editor should not construct lights, enable stars, replace `scene.background` or `scene.environment`, rewire output nodes, change renderer tone mapping, or aim the app camera by default. The demo keeps its scene setup and camera buttons. An optional host callback can later implement **Look toward Sun/Away/Up/Ground** for applications that want it.

### Required public state access

The facade exposes `grade`, `north`, `sunElevation`, `sunAzimuth` and lifecycle state, but lacks a complete settings readback API. Add a typed `sky.getSettings()` snapshot for controls the editor supports, including solar inputs, active time/manual mode, sky exposure, effective atmosphere values, turbidity baseline and sun appearance. Return detached data suitable for a UI; do not make consumers read underscored fields or mutate uniforms.

Store the sun control mode explicitly. Time-based setters should use an internal solar refresh path so their call to sun positioning does not incorrectly mark the mode as manual. Effective atmosphere values must round-trip correctly with the turbidity baseline; copying already-scaled Mie values and then applying turbidity again would change the result.

The controller can compare supported settings during `update` and subscribe to grade changes through the new facade wrapper. Full settings change events can be added later if other consumers need them. Construction settings need a separate description when they become visible; the first editor must not imply they have live setters.

## Rendering and lifecycle

Use the existing renderer with a second `CanvasTarget`; do not allocate another GPU renderer or duplicate the atmosphere. Call the preview draw after the app's main render so it reads the sky updated for that frame.

Capture renderer state at the start of each draw and restore it in `finally`, including canvas target, render target, viewport, scissor, scissor test and any clear/output state the draw changes. Do not cache the main target at construction: a host may change targets between frames. Resize the preview target only while it is active, matching the current demo's depth-buffer requirement.

The dome inherits renderer tone mapping and output color space. An application with custom final post-processing may look different from this direct preview. Expose a host preview-output adapter later if exact matching is required; the app scene remains the reference for final appearance.

Bound preview resolution and device pixel ratio, and redraw only when the sun, grade, view altitude, relevant renderer output settings or preview size change. Keep 2D overlay invalidation separate from GPU drawing so hover does not cause another sky bake. Grade edits already invalidate the cube and IBL through the library; atmosphere edits trigger the wider LUT chain. Coalesce queued physical slider changes to one setter application per host frame.

Closing or collapsing cancels playback, releases sun control and suspends preview drawing. Dispose listeners, observers, subscriptions, timers, preview material and target. Never dispose the host sky, renderer, scene, textures, controls or helpers. Detect a disposed sky and disable the editor before accessing its baker. A new sky instance can initially be handled by disposing and recreating the editor.

For apps that render on demand, `requestRender` schedules the next host frame. Continue requesting frames during editor playback and while a throttled environment refresh remains pending. Expose a public pending-work signal if necessary; do not force `flushEnvironment()` on every slider event.

## Saving and recovery

Keep grade export compatible with the existing `pmndrs-sky-grade` version 1 JSON format, sRGB hex colors and `SkyGrade.fromJSON`. This makes files authored in the floating editor usable by the demo, runtime API and React bindings.

Parse imports into a temporary grade and validate them before changing the current grade. Handle invalid JSON, unsupported format/version and excess keys with an inline error. Provide download when clipboard access fails.

Autosave is opt-in with a caller-provided project key. Store a recoverable draft; never replace the host grade automatically when opening. Offer **Restore draft** when a different draft exists. Keep window position and preview mode separate from grade data, and tolerate unavailable browser storage.

The first release exports grades. A later versioned settings document can contain grade plus serializable runtime settings, with a documented apply order and round-trip tests. Keep cameras, scenes, GPU textures, effect nodes and host callbacks outside that format. Until settings export exists, the UI must clearly say **Save grade**, because atmosphere changes are not included.

## Implementation structure

```text
src/editor/
  index.ts              public factory, handle and option types
  controller.ts         binding, commands, history, selection, playback
  shell.ts              floating/embedded mounting, focus, drag, resize
  toolbar.ts            grade actions, solar controls and status
  timeline.ts           elevation timeline and CPU swatches
  inspector.ts          keyframe controls and validation
  settings.ts           solar and basic atmosphere controls
  preview.ts            CanvasTarget, rendering state and invalidation
  overlay.ts            guides, hover and picking
  persistence.ts        grade file actions and optional local drafts
  styles.ts             scoped styles and theme properties
```

Keep the controller usable without DOM so future integrations can reuse the commands. Export the factory and stable public types first; internal panel APIs can remain private until a concrete consumer needs them.

Add `src/editor/index` to `build.config.ts` and `./editor` to the package export map, emitting the same ESM, CJS and declaration outputs as existing entries. Avoid an eager editor re-export from the core or React entries. A development example may dynamically import the editor when its launcher is clicked.

## Delivery sequence

1. **Public readback and controller.** Add settings snapshot and grade subscription wrapper. Extract grade commands, history, selection and solar modes from the demo. Verify shared grade identity, external replacement and transaction behavior.
2. **Floating authoring tool.** Port toolbar, timeline, inspector, dome and overlay into the optional editor entry. Add mount/close/dispose, style isolation, rendering integration and scoped input. Connect basic sun/atmosphere settings.
3. **Use the shipped tool in the demo.** Retain the demo scene but replace its duplicate authoring logic with the editor. Add a smaller example showing the editor floating over an ordinary app with minimal integration code. Document continuous and demand-rendered loops.
4. **Integration verification and release.** Exercise a host day/night controller, custom post-processing, keyboard navigation and repeated open/close/dispose. Publish the optional entry and its API guide.
5. **Expand from usage.** Add host-connected effects, settings export and physical LUT diagnostics as separate features.

## Acceptance criteria

- A vanilla app can open the editor against its existing sky with no new scene or renderer and no React dependency. Importing the main sky entry does not load editor UI code.
- Opening preserves the current sun, atmosphere, grade and scene configuration. Grade edits appear in the app's existing background and IBL, and in haze when the host has connected it.
- Timeline insertion, movement, deletion, auto-keying and every inspector control work up to `MAX_GRADE_KEYS`. One-key grades stay fixed until another key is explicitly added.
- Undo/redo groups gestures correctly; external grade edits or replacement cannot be overwritten by old history. Physical comparison, close and dispose never resurrect a grade replaced by the host.
- A grade exported here loads in the demo and through `sky.setGrade`, retaining keyframes, colors, gradients, night fill and ambient values.
- Editor time playback and host time simulation coordinate through the sun-control contract. Manual elevation navigation is labeled correctly at polar and unreachable elevations.
- Preview rendering restores host renderer state even after a draw failure. Resizing the tool does not resize the app canvas or change its camera aspect.
- Hidden editor frames perform no preview draw. Repeated mounting and disposal leave no editor listeners, observers or GPU resources behind. Demand-rendered scenes continue to settle IBL refreshes.
- Host CSS, global game shortcuts and text entry coexist with the tool. All authoring commands are reachable without pointer-only canvas gestures.

Use focused controller tests for the state transitions and real browser integration checks for GPU state restoration, live preview, input isolation and cleanup. Reuse [verify-grade.mjs](examples/vanilla/scripts/verify-grade.mjs) for grading correctness; the editor should reuse the existing math and shaders.
