# Encounter maps — arena floor plans for the replay

A per-encounter **floor plan**: a small piece of self-contained low-poly
geometry — walkable deck, walls, obstacles, holes into the void, marks —
that the 3D replay drops in place of its generic scaled grid box so a
pull reads against the *actual* arena shape. Maps are **authored** in a
dedicated editor window and **stored as data** in the app data folder,
one file per map, keyed on the game's `UiMapID`.

This doc is the design + the build plan; it fills in as the feature
lands.

Related: `docs/replay-view.md` (the consumer — world, coordinate frame,
`fit_box`, Catppuccin materials, the `replay-scene` widget this shares a
renderer with) · `docs/replay-effects.md` (the deterministic-over-`t`
animation model this reuses for runtime map states, §4) ·
`docs/movement-view.md` §2–5 (the position data model — yards,
`pos_unit`, `MAP_CHANGE`) · `docs/plugins.md` (the packaged-extension
system; a plugin can supply maps + the timings that drive their runtime
states) · `docs/ui-items.md` §"Related — encounter maps" (the earlier
one-paragraph sketch — **this doc supersedes it**) · `docs/ui-widgets.md`
(Panel/Widget/ViewContext) · `docs/widget-distribution.md` (the trust
model for user files in the data dir) · `docs/windows-and-files.md`
(multi-window + the app data / config dirs).

---

## 1. Scope

### In, v1

- **A separate editor window** inside parseomatic (like Settings — its own
  HTML entry, not a view), reusing the replay's Three.js renderer so the
  editor preview is pixel-identical to what the replay will show.
- **Vector authoring.** Click out closed polygons on top of the arena map
  image; each polygon belongs to a **layer** (`ground` / `wall` / `void` /
  `mark`) with a flat floor/top height. Geometry is **extruded from the
  polygons at load time**, not stored as a baked mesh. See §8 for why not
  a painted heightmap; the editor also accepts a hand-drawn SVG import
  (paths → polygons) for authors who'd rather draw in Inkscape.
- **Four layer kinds** (§4): walkable deck, tall wall/obstacle, hole cut
  into the deck (pit obstacles, fire, etc), and flat ground marks that
  render just above the deck. `kind` is an **open string** — a renderer
  skips a kind it doesn't know rather than failing, so new kinds are not
  a schema break (§4).
- **A backdrop image the author supplies.** The editor has an **Open…**
  button that pops a native file dialog; the chosen image is shown on the
  deck plane as a tracing reference. parseomatic never downloads it — no
  network, no CORS shim, no licensing tightrope (§7). The image is a
  *visual aid only*; tracing accuracy comes from calibrating against a
  real pull (§10), so a rough top-down screenshot is plenty and the
  feature works with no image at all.
- **Calibration against a real pull.** Load a `replay_series` for an
  encounter on the map; the unit tracks give exact `pixel → world yard`
  anchor points and a "definitely walkable" heatmap to trace against
  (§10). Replaces eyeballing a rectangle over the 8-yard grid.
- **Save / load** `<mapId>.map.json` in `<data>/maps/<raid-slug>/`.
- **Replay consumption** (§6): resolve the encounter's `UiMapID`, load its
  map if one exists, else fall back to today's generic grid box.

### Out, v1 (deferred, tracked in §13)

Per-vertex / sloped heights (v1 is piecewise-flat plateaus) · a painted
**heightmap** pipeline (considered and rejected — §8) · a **baked-mesh
cache** (`.glb` next to the JSON — cut; re-extruding tens of polygons at
load is sub-millisecond, and a stale-cache check plus a second format
buys nothing measurable — §5) · automatic **trace-from-image**
(classical-CV contour trace + a labelling pass — §9) · CSG/boolean
*cleanup* beyond `void` subtraction · textured or lit-beyond-flat-grey
surfaces · the `states` / `ops` **editor UI** (the format reserves it in
v1; hand-authored JSON only — §4) · mid-encounter `MAP_CHANGE` (a boss
that relocates mid-pull) — same deferral as `movement-view.md` §5 · the
**previs editor** (fake-log strategy visualisations — §12).

---

## 2. Delivery — a window, not an app

The instinct to make this a standalone application is reasonable
(authoring vs analysis are different modes) but the renderer sharing wins:

- The editor's live preview **must** match the replay exactly — same
  grid texture, `FLOOR_LIFT`, fog/void colour, camera rig — or "what you
  drew" and "what the replay shows" drift. Sharing one renderer
  guarantees it; a separate app would fork it or need a shared package
  today.
- Tauri already runs multiple windows with separate HTML entries
  (`settings.html`; `duplicate_window`). Vite code-splits per entry, so
  the editor's heavier deps (polygon triangulation, an SVG parser) load
  **only** in the editor window — the shipped analyzer binary doesn't
  grow.
- One app to build / sign / notarize; the map files live in
  parseomatic's data dir regardless.

**Keep the seam, though.** Split `src/ui/widgets/replay-scene.ts` into:

- **`src/map/extrude.ts`** — **done.** The doc-to-world extrusion pipeline
  (`buildDevMap`, the `DevMap*` doc types, `mapDocToWorld`, framing, the
  grid texture + CSS-token colour helpers, and the world-scale constants
  `CELL`/`FLOOR_LIFT`/`PILLAR_DEPTH`/`PLAYER_H`/…). No app-specific
  imports (no widget registry, no view context), so either Vite entry
  pulls it in cheaply. `replay-scene.ts`'s dev-map preview and
  `map-editor.ts`'s "3D" toolbar button both call the same `buildDevMap`
  now — the editor preview builds its own `DevMapDoc` from the live
  shapes + calibration fields and renders literally the same geometry the
  replay would, at true world-yard scale, instead of a separate
  hand-rolled extrusion that could drift out of sync.
- **`src/ui/widgets/scene-rig.ts`** (still future work) — camera +
  `OrbitControls` + the on-demand render loop + fog/base-layer/skybox
  dressing. No game data. Would let the editor's camera rig (currently
  its own simpler Box3-fit orbit camera, no fog/skybox) match the
  replay's exactly too, if that's ever worth the shared complexity.
- **`replay-scene.ts`** — unit meshes, tracks, animation, transport,
  selection, effects; builds on `extrude` (and eventually `scene-rig`).

If community map authoring ever wants a renderer without the analyzer,
`extrude` (+ `scene-rig`, once it exists) and the editor extract into
their own Tauri app cheaply. Not now.

---

## 3. Storage — the data folder

```
<app data dir>/maps/                     (windows-and-files.md — app_data_dir)
  <raid-slug>/
    raid.json          # instance name/id + encounterId -> UiMapID list
    2606.map.json      # one map, keyed on UiMapID
    _src/              # editor working files — NOT shipped, NOT committed
      2606.backdrop.png    # the author-picked tracing image, copied here
      2606.trace.svg       # a trace-from-image result, pre-cleanup (§9)
```

- **`maps/` sits under `app_data_dir`**, not `app_config_dir` — it's
  user-facing content, the toolbar's "open data folder" button
  (`open_data_dir`, `index.html`) lands here. On macOS the two dirs are
  the same path; elsewhere data is the right one.
- **The raid folder is organisational only.** Resolution scans every
  `*/*.map.json` under `maps/` **and** every `plugins/*/maps/**/*.map.json`
  (`docs/plugins.md`) into a `UiMapID -> path` index at startup (and on a
  file-watch or a manual "reload maps"). The replay never cares whether a
  map was hand-dropped or plugin-supplied; a wrong `raid-slug` never
  breaks a lookup.
- **Key on `UiMapID`**, not `encounterID`. `UiMapID` is the id the game
  exposes for a map (`zones[].mapId` in `log_lists`) and the natural key
  for a curated geometry pack later. The replay needs an
  `encounterID -> UiMapID` step (§6).
- **`_src/` is out of band.** The backdrop the author traces over (copied
  in when they pick it) and any intermediate trace live here; nothing in
  `_src/` is read at replay time or redistributed. Add `maps/**/_src/` to
  `.gitignore` for any repo that vendors maps.
- **User files are untrusted data** (`widget-distribution.md`). A
  `.map.json` is parsed defensively — unknown `layer.kind` skipped,
  vertex counts capped, `schema` gated — never `eval`'d, and a malformed
  file degrades to the generic box with a console warning, never a crash.
  `states` / `ops` (§4) are declarative data, not code, for the same
  reason.

---

## 4. The `.map.json` format

The **authoring representation** — closed 2D polygons (or bare points) in
world yards, per layer, with flat heights — not a mesh. Small,
hand-diffable, re-extrudable with better tessellation later without
redrawing.

```jsonc
{
  "schema": 1,
  "mapId": 2606,                       // UiMapID
  "name": "Queen Ansurek",             // free text, editor-set
  "raidSlug": "nerubar-palace",
  "sourceImage": "wago.tools/maps/worldmap/2606",   // free-text: where the author got the backdrop
  "editor": { "app": "parseomatic", "version": "0.1.0", "savedAt": "2026-09-08T…" },

  // Maps drawing-local coordinates to WoW world yards. This IS the
  // X / Z / length / width placement — the replay lines the deck up with
  // unit positions through this. Same axis names as replay `fit_box`.
  "worldBounds": { "minX": -120.0, "maxX": 140.0, "minY": -90.0, "maxY": 110.0 },

  "layers": [
    {
      "kind": "ground",                 // walkable deck — grey grid, like the generic box top
      "floorY": 0.0,                   // deck surface, yards above the void datum
      "polys": [
        { "id": "main-deck",           // optional; only ids can be a `states` target
          "points": [ [x, y], [x, y], … ] }   // world yards; closed implicitly; CCW = solid
      ]
    },
    {
      "kind": "wall",                  // obstacle / boundary — same draw, tall
      "floorY": 0.0,
      "topY": 4.0,                     // ~2 player-units; default WALL_HEIGHT
      "polys": [ … ]
    },
    {
      "kind": "void",                  // subtracts from `ground` in draw order — donuts, pits
      "polys": [ … ]
    },
    {
      "kind": "mark",                  // flat reference decal a hair above the deck
      "offsetY": 0.05,                 // MARK_LIFT — wins the z-fight, always on top
      "color": "var(--ctp-yellow)",    // theme token or literal; editor palette
      "closed": true,                  // false => a stroked line, not a fill
      "polys": [ … ]
    },
    {
      "kind": "widget",                // RESERVED (not rendered in v1): an interactable
      "points": [ { "id": "orb-north", "at": [x, y] } ]   // a point, not a poly
    }
  ],

  // RESERVED (hand-authored only in v1). Named alternative arrangements of
  // the geometry; see "Runtime map states" below.
  "states": [
    {
      "id": "phase2",
      "transitionMs": 800,
      "ops": [
        { "target": "bridge-north", "op": "hide" },
        { "target": "platform-2",   "op": "translate", "by": [0.0, -10.0, 0.0] }
      ]
    }
  ]
}
```

Notes:

- **Geometry carriers.** A layer holds `polys` (closed rings) **and/or**
  `points` (bare positions). `ground` / `wall` / `void` are poly-only;
  `mark` is usually polys but a single point renders as a glyph;
  reserved kinds like `widget` / `spawn` / `path` are point-first. Every
  poly and point may carry an optional `id`.
- **`id` is the stable handle.** Only a poly / point with an `id` can be a
  `states` `ops` target, or be referenced by a plugin's spell-display /
  mechanic rules (`docs/plugins.md`). Ids must be authored **now** even
  though the `states` editor is deferred — retrofitting stable ids after
  a map is drawn means re-tessellating and breaking every reference.
- **Vertices are world yards**, stored absolute — no normalisation, no
  scale ambiguity, 1 unit = 1 yard end to end (`movement-view.md` §5). The
  editor may *draw* in image pixels and convert on save via
  `worldBounds`.
- **Heights are along scene-`y` (up).** `floorY` = 0 is the deck datum;
  the generic box's `FLOOR_LIFT` (3 yd above `y=0`) is applied by the rig
  so a map at `floorY: 0` sits exactly where the generic deck did. A
  sunken section is `floorY: -2`; a raised ledge `floorY: +3`.
- **`ground` without an explicit `topY`** gets a thin slab (`DECK_THICKNESS`,
  ~0.4 yd) so its edge reads against the void. `wall` needs `topY`.
- **`void` order matters** — it cuts every `ground`/`wall` polygon drawn
  before it in the file. A donut = one `ground` decagon, then one `void`
  circle inside it.
- **Winding**: outer ring CCW, holes-within-a-single-poly CW (standard
  even-odd); the editor enforces it so hand edits don't have to.
- **`mark`** has no back face and `depthWrite: false` (§5) — it's a
  drawn-on annotation (boss-marker spots, intermission lines, "stack
  here"), not collision.
- **`kind` is an open enum.** Core kinds are `ground` / `wall` / `void` /
  `mark`, plus `wall2` / `wall3` (walls extruded to **2x / 3x a plain
  `wall`'s** height above the deck) and `ground-1` / `ground-2` (thin FX
  slabs whose top sits **1/4** and **1/2 a player's height below** the
  deck, recessing the deck above them — water / ice / poison / lava). `mark`, `ground-1` and `ground-2` polys may
  carry `"color": "#rrggbb"`; `ground-1` / `ground-2` also carry
  `"material": "<tag>"` (free string — the renderer stashes it for a
  future animated / emissive / reflective shader). A `void` cuts every
  `ground` / `wall*` / `mark` / `ground-1` / `ground-2` it sits inside —
  all the way through, deck to water. A `ground-1`/`ground-2` recess only
  cuts `ground` / `wall*` / `mark` above it, never another ground slab —
  overlapping ground layers just render one under the other at their own
  depths, no hole punched between them. A renderer **must** skip an
  unrecognised kind (and log once), never fail the whole map.
  Reserved-but-unspecified: `widget` (interactable, render as a pyramid),
  `spawn`, `path`. Plugin-private kinds should use an `x-` prefix.

### v1 bootstrap shape (what the editor writes today)

The editor emits `schema: 2`. `calibration` is now editor-owned (the
right-toolbar Calibration fields); `encounters` is still hand-edited.
This supersedes the older `worldBounds` + separate `raid.json` split
above — the transform and the `encounterID → map` binding both live in
the map file.

```jsonc
{
  "schema": 2,
  "calibration": {            // doc-unit → world-yard transform:
    "yardsPerUnit": 1,        //   world = R(rotationDeg)·(doc · yardsPerUnit), Y flipped if mirrorY, + originYards
    "rotationDeg": 0,         // identity == "doc units already are combat-log yards"
    "originYards": [0, 0],
    "mirrorY": false          // WoW's zone-map image is a mirrored frame vs world axes;
  },                          //   "Fit to log map" sets rotationDeg 90 + mirrorY true from the MAP_CHANGE box
  "encounters": {             // keyed by the numeric encounterID from ENCOUNTER_START;
    "default": {              // "default" applies to any encounter with no entry
      "orientationDeg": 0,    // spin the whole scene to match how players hold the arena
      "frame": null           // null = auto-fit the action + clamp to the map bounds,
    }                         //   or [centreX, centreY, span] in world yards to pin it
  }
}
```

The replay reads only `orientationDeg` and `frame` in v1. Other keys
under an encounter (enemies to hide/highlight by name, per-ability
treatment, timeline phase markers) are **reserved** — author them now,
wired later. The editor round-trips every top-level key it doesn't
manage, so hand edits to `calibration` / `encounters` / `states` survive
a geometry re-save.

### Runtime map states

`states` names alternative arrangements of the *same* geometry: hide /
show / translate / rotate / set-opacity a set of `id`-tagged polys. It is
**declarative data, never code** — the renderer applies the ops and lerps
over `transitionMs`, deterministic over the playhead `t` exactly like the
replay's cast lines and particles (`docs/replay-effects.md`), so it
scrubs cleanly.

- **What** the states are lives in the map file. **When** a state is
  entered ("90 s in", "on cast X") lives in a plugin's *encounter
  declarations* (`docs/plugins.md`) — so one map serves multiple
  difficulties with different timings, and the map file stays timing-free.
- Covered: rising bridges, rotating platforms, a floor section dropping
  out. Not covered: arbitrary deformation.
- **Escape hatch for a true transform:** a `state` may instead carry
  `"mapId": <other UiMapID>` — load that whole map and cross-fade the
  meshes. Rare; `ops` is the default.
- A plugin that wants *procedural* map animation runs that code in the
  plugin (its own trust model), and drives the renderer through the same
  `ops` vocabulary. The `.map.json` never executes.

### `raid.json`

```jsonc
{
  "slug": "nerubar-palace",
  "name": "Nerub-ar Palace",
  "instanceId": 1273,                  // journalInstanceID, for a future bundled map pack
  "encounters": [
    { "encounterId": 2902, "name": "Ulgrax the Devourer", "mapId": 2657 },
    { "encounterId": 2917, "name": "Queen Ansurek",        "mapId": 2606 }
  ]
}
```

The editor writes/updates it; the replay's `encounterID -> UiMapID`
resolve reads it (§6), falling back to a small bundled table and then to
"no map".

---

## 5. Extrusion + materials

Load path (`buildDevMap`, `src/map/extrude.ts`) — runs every load, from
the polygons; there is no baked-mesh cache:

1. Parse `.map.json`; skip unknown `layer.kind`, cap vertex counts.
2. Per `ground`/`wall` layer: triangulate each polygon (ear-clipping —
   `THREE.ShapeUtils.triangulateShape`, or `earcut`), applying every
   later `void` polygon in file order as a hole contour. Extrude
   `floorY -> topY` (or the thin slab). One `BufferGeometry` per layer,
   merged.
3. Material = the **same** `MeshStandardMaterial` + procedural grid
   `CanvasTexture` (`gridTexture()`) the generic box uses, `repeat` set so
   cells stay `CELL` (8 yd) on the deck and down the wall sides — visual
   continuity with the fallback box and the replay's read.
4. `mark` layers: a flat `ShapeGeometry` at `floorY + offsetY`,
   `MeshBasicMaterial` (unlit), `side: THREE.FrontSide`,
   `depthWrite: false`, `renderOrder` above the deck — always wins the
   z-fight, never occludes a unit. `closed: false` → a `Line2` stroke
   instead.
5. Keep every `id`-tagged poly's mesh (or a sub-range of the merged
   buffer) addressable so `states` `ops` can hide / move it later.

- **Cost.** A whole arena is tens of polygons → a few hundred to low
  thousands of triangles per map, triangulated in well under a
  millisecond. Trivial next to the unit meshes; no instancing, no LOD, no
  `.glb` cache. (If load profiling ever shows a stall, a cache is a small
  add-back — it is not in v1.)
- **Framing.** When a map is present the replay frames on the map's
  `worldBounds` (padded, snapped to `CELL`) instead of `fit_box`, so the
  camera shows the whole arena, not just where the raid stood. `fit_box`
  still available for a "zoom to action" affordance.
- **Void crossings are fine.** A unit whose fix lands over a `void`
  polygon or off the deck is drawn at its real spot regardless —
  sometimes the void isn't lethal, sometimes a knockback earns the death.
  No clamping, no collision.

---

## 6. How the replay picks up a map

In `src/views/replay.ts` / the `replay-scene` widget, once per loaded
encounter (cached like `replay_series`):

1. `encounterID` (from `ENCOUNTER_START`) → `UiMapID`: check `raid.json`
   files under `maps/` and `plugins/*/maps/`, then a small bundled
   `encounterId -> mapId` table, then the encounter's own zone `mapId`
   from `log_lists` as a last resort.
2. `UiMapID` → `<id>.map.json` via the startup index.
3. Found → `buildDevMap` (`src/map/extrude.ts`) builds the map geometry
   instead of the generic scaled box, frames on `worldBounds`. Not found →
   **exactly today's behaviour**, no regression.

New Rust commands (`src-tauri/src/maps.rs`):

| command | does |
|---|---|
| `map_index()` | `[{ mapId, path, name, raidSlug }]` — the resolve index |
| `read_map(mapId)` | the `.map.json` text (editor + replay) |
| `write_map(mapId, json)` | save (editor only) |
| `import_backdrop(mapId, srcPath)` | copy the user-picked image to `_src/<id>.backdrop.<ext>`, return a webview-loadable URL for it (editor only) |

The editor's **Open…** button uses `tauri_plugin_dialog` (already a
dependency) to pick the file; `import_backdrop` copies it into `_src/`
so reopening the map re-loads the same reference without re-picking.
parseomatic makes no network request for it.

---

## 7. The backdrop image — bring your own

- The editor's **Open…** button pops a native file dialog; the author
  points it at any roughly top-down image of the arena. parseomatic never
  downloads one — there's no CORS shim, no HTTP client, nothing to keep
  current.
- **Sources the author can grab themselves**, in a browser or the game:
  `wago.tools/maps/worldmap/<UiMapID>` (clean per-map renders), a WoWhead
  / Method Dungeon Tools view, or an in-game top-down screenshot. Their
  choice, their provenance — recorded free-text in `sourceImage`.
- The picked file is **copied** into the git-ignored `_src/` (never read
  at replay time, never shipped, never baked into geometry). Whatever the
  author brought is on their own machine, put there by them — same as any
  scratch file; parseomatic just displays it under the tracing plane.
- The extruded geometry is original work (`ui-items.md` makes the same
  call). `NOTICE` gets a line: maps are hand-authored; any backdrop is
  user-supplied and stays local.
- The backdrop is **optional** — §10 calibrates against a real pull, so a
  map can be traced from the walkable heatmap alone with no image.

---

## 8. Why vector, not a painted heightmap

A greyscale-heightmap pipeline (paint height per pixel, sample into a
tessellated plane) was considered and rejected for this content:

- Raid arenas are **flat plateaus with hard vertical edges into the
  void** and **sharp-edged obstacles**. The ground/void boundary — the most
  important line on the map — is exactly what a heightmap renders worst
  (stair-stepping or a fuzzy ramp unless resolution is huge).
- The authoring interaction is **corner-clicking on the map image** —
  inherently vector. Painting a clean-edged decagon in a raster tool is
  *harder* than clicking its corners: you fight anti-aliasing and brush
  softness and can't snap to the grid.
- **A heightmap carries no semantics.** It can't say "this loop is a
  wall" vs "a pit" vs "a widget", which is exactly what the format needs
  *more* of (`kind`, `id`, `states`). Polygons + per-layer heights carry
  it for free.
- Donut / pit / column / "wall two player-units taller" are natural
  polygon booleans + per-layer heights; clumsy as paint layers.
- The proposed encoding ("black = void, else one unit up, 254 steps
  above") is *quantising the heightmap back into a handful of flat
  plateaus* — i.e. polygons with per-polygon heights, in a lossy raster
  container.
- Mesh cost: a 4k×4k plane naively tessellated ≈ 33 M quads for geometry
  that is ~50 polygons; usable only with adaptive meshing you'd have to
  build.
- **Resolution was never the blocker** — 4k over a 200-yard arena is
  ~20 px/yd, plenty. The blocker is the flat-vs-sharp mismatch and the
  tessellation cost.

**For authors who want a real drawing program:** the editor accepts a
hand-drawn **SVG** import — closed paths → polygons, `data-kind` / layer
name → `kind`. That's the "use Inkscape" workflow without a heightmap.
`docs/plugins.md` map contributions can ship the SVG in `_src/` and the
extracted `.map.json` beside it.

Per-*layer* `floorY`/`topY` already covers walls, obstacles, sunken and
raised sections. If a specific boss ever needs a true slope, add an
optional per-polygon linear gradient (two heights + an axis) before
reaching for a heightmap.

---

## 9. Trace-from-image (later)

A fully hands-off "map image in → correct arena out" is not reliable —
world-map art carries labels, icons and gradients and doesn't encode
"where you can stand." A **semi-automatic** importer is very achievable
and would make a map a ~5-minute job:

1. Start from the author-picked backdrop in `_src/` (§7).
2. Classical CV — threshold, edge-detect, `findContours`, `approxPolyDP`
   (Douglas–Peucker) — traces candidate polygons deterministically. Runs
   as a build/tooling script, not in the app; output is
   `_src/<id>.trace.svg` (the same SVG import path as §8).
3. A **labelling pass** — a human, or Claude given the image + the
   contours — tags each contour `ground` / `wall` / `void` / `mark` and
   sets heights. This is the part pure CV can't do.
4. Import the labelled polygons into the editor; clean up by hand.

Build the manual editor first — it's the ground-truth / fixup tool
regardless — then add a "Trace from image" button that just seeds
polygons.

---

## 10. Calibration — against a real pull

The finished map has to line up with unit positions in yards. Rather than
eyeballing a rectangle over the 8-yard grid, the editor loads a real
encounter's tracks and calibrates off them:

1. **Load reference replay.** Pick an encounter on this `UiMapID`; the
   editor pulls `replay_series` for it and drops the unit tracks +
   transport onto the map layer (the `replay-scene` layer on top of the
   editor's `scene-rig`).
2. **Anchor points.** Scrub to a moment, click a player standing on a
   recognisable feature (a doorway, dead centre). That player's own
   position fix at that `t` is an exact `pixel → world yard` pair. Two
   such pairs fix `worldBounds` precisely — this is the "two known world
   points" precise mode, with the world points supplied for free.
3. **Walkable heatmap.** The union of *every* player fix across the pull
   is a dense "definitely stood here" point cloud. Render it under the
   trace image and trace the outline of where people went — a
   near-automatic deck boundary for the `ground` layer.

Caveat: the replay's coordinate handling and the map's `worldBounds` must
use the same axes and signs. `movement-view.md` §5 notes the `MAP_CHANGE`
box corners aren't sorted and axes can flip — get one real encounter
end-to-end before trusting the pipeline.

---

## 11. Build phases

- **A — renderer split.** Extract `scene-rig.ts` from `replay-scene.ts`;
  the replay keeps working unchanged. No editor yet.
- **B — one hand-written map, end to end.** Hand-author a single
  `.map.json` for one encounter (no editor), wire `maps.rs`
  (`map_index` / `read_map`), the `encounterID -> UiMapID` resolve, the
  `src/map/extrude.ts` load path, and `worldBounds` framing. **Prove the
  consumption path and that extruded polygons read well in the replay
  before building any authoring UI.** This is the first phase a
  non-author sees anything, and the cheapest place to discover the
  geometry looks wrong.
- **C — editor shell.** `map-editor.html` + `src/map/*` + a `map_editor`
  menu item (View › Developer for now — may graduate to a "Tools" menu).
  Opens a `scene-rig` scene, the generic box, orbit camera. `write_map`.
- **D — backdrop + calibration.** **Open…** file picker →
  `import_backdrop`; show the image on the deck; load-reference-replay +
  the anchor-point / heatmap calibration that writes `worldBounds` (§10).
- **E — polygon tool + `ground`.** Click vertices, close, Enter to commit;
  edit/delete vertices; snap to grid + to existing vertices; assign an
  `id`. Live extrude of the `ground` layer. Save / load.
- **F — the other layers.** `wall` (with `topY`), `void` (boolean into
  `ground`), `mark` (palette, `closed` toggle). Per-layer height fields.
  `raid.json` write. SVG import.
- **G — polish.** File-watch reload, the `_src/` trace import hook, undo.

Phases A + B land first for review.

---

## 12. Future — the previs editor

A **standalone-feeling mode** (same window family) for authoring *fake
logs*: strategy visualisations rather than recordings of real pulls.

The author manually creates players — class, name, HP — and drops them on
a map, places raid markers, creates a boss. They drag the playhead
forward and reposition units at each keyframe. They can flag a player
attacking one or more mobs, healing party members, taking damage from the
environment / creatures / DoTs; flag buffs, debuffs, potions, defensive
cooldowns; drag the boss like any unit; mark units alive or dead.

Under the hood this **synthesises the combat-log events** the replay
already consumes — zero-impact self-heals every keyframe to carry
position, 1 s repeating zero-damage casts to show target priority,
`UNIT_DIED` / `SPELL_RESURRECT` for the alive/dead flags — so the previs
plays back through the exact same pipeline as a real log.

Extras it wants:

- **Manual world marks** — "poison cloud" no-stand zones, "safe zone"
  stack points — and basic reference geometry (transparent walls, ground
  lines). These overlap the map format's `mark` / reserved layer kinds;
  the previs editor should emit them into the same `.map.json`
  vocabulary, not a parallel one.
- **A side-car caption file** — timed text descriptions of the strategy,
  shown alongside playback (closed-captioning style).
- **Camera keyframes** — recorded camera position so playback flies to
  highlight a mechanic; exportable to a shareable video.

Goal: a compact pre-vis guide a raid leader watches or exports. Out of
scope for the map feature itself; captured here because it shares the
editor window, `scene-rig`, and the map format.

---

## 13. Open questions

- **`encounterID -> UiMapID` source of truth.** A bundled table
  (maintainable, offline) vs deriving from `raid.json` files the user
  authored vs the log's own zone `mapId` (present but coarse — one zone
  can hold several boss sub-maps). v1 leans: `raid.json` → bundled table
  → zone `mapId`.
- **Multiple maps per encounter** (intermission relocations, Mythic-only
  platforms). A `state` with `mapId` (§4) covers a full swap; the harder
  case — the replay knowing *when* to swap without a plugin — is deferred
  with `MAP_CHANGE` (§1).
- **Which backdrop to trace.** A whole-wing render vs a tight per-boss
  view vs an in-game screenshot — the author's call at author time;
  `sourceImage` records which. Calibration (§10) makes the choice
  low-stakes: the pull's tracks define the yard frame regardless of the
  image.
- **Editor undo model.** Snapshot the whole `layers` array per edit
  (small enough — tens of polygons) rather than a command stack. Leaning
  snapshot.
- **Sharing maps between users.** Out of scope now, but the on-disk
  format is a plain file so a future "import a map" is just a copy into
  `maps/` (or bundling it in a plugin — `docs/plugins.md`).
- **Wall height default.** `WALL_HEIGHT` = 4 yd (~2 player-units) is a
  guess; tune once real arenas are drawn.
- **`states` triggers when there's no plugin.** The map file can't say
  *when* a state fires (that's plugin encounter-data). Should the replay
  ship a tiny built-in trigger table for a few marquee bosses so map
  states work without a plugin installed? Probably yes, small.
