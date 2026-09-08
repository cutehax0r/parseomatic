# Encounter maps — arena floor plans for the replay

A per-encounter **floor plan**: a small piece of self-contained low-poly
geometry — walkable deck, walls, obstacles, void holes, reference marks —
that the 3D replay drops in place of its generic scaled grid box so a
pull reads against the *actual* arena shape. Maps are **authored** in a
dedicated editor window and **stored as data** in the app data folder,
one file per map, keyed on the game's `UiMapID`. This doc is the design +
the build plan; it will be filled in as the feature lands.

Related: `docs/replay-view.md` (the consumer — world, coordinate frame,
`fit_box`, Catppuccin materials, the `replay-scene` widget this shares a
renderer with), `docs/movement-view.md` §2–5 (the position data model —
yards, `pos_unit`, `MAP_CHANGE`), `docs/ui-items.md` §"Related — encounter
maps" (the earlier one-paragraph sketch — **this doc supersedes it**),
`docs/ui-widgets.md` (Panel/Widget/ViewContext), `docs/widget-distribution.md`
(the trust model for user files in the data dir), `docs/windows-and-files.md`
(multi-window + the app data / config dirs).

---

## 1. Scope

### In, v1

- **A separate editor window** inside parseomatic (like Settings — its own
  HTML entry, not a view), reusing the replay's Three.js renderer so the
  editor preview is pixel-identical to what the replay will show.
- **Vector authoring.** Click out closed polygons on top of the arena map
  image; each polygon belongs to a **layer** (`safe` / `wall` /
  `void-hole` / `mark`) with a flat floor/top height. Geometry is
  **extruded from the polygons at load time**, not stored as a baked mesh.
- **Four layer kinds** (§4): walkable deck, tall wall/obstacle, hole cut
  into the deck (donuts, pit obstacles), and flat ground marks that
  render just above the deck.
- **Map image on the floor.** The `wago.tools` world-map PNG for the
  `UiMapID`, fetched by a Rust command (webview CORS blocks hotlinking),
  shown on the deck plane as a drawing reference. **Reference only — not
  redistributed** (§7).
- **World calibration.** A drag-a-rectangle-against-the-8-yard-grid step
  that fixes the drawing's world bounds in **yards**, so the finished map
  lines up with unit positions in the replay.
- **Save / load** `<mapId>.map.json` in `<data>/maps/<raid-slug>/`.
- **Replay consumption** (§6): resolve the encounter's `UiMapID`, load its
  map if one exists, else fall back to today's generic grid box.

### Out, v1 (deferred, tracked in §9)

Per-vertex / sloped heights (v1 is piecewise-flat plateaus) · a painted
**heightmap** pipeline (considered and rejected — §8) · automatic
**trace-from-image** (classical-CV contour trace + a labelling pass —
§9) · CSG/boolean *cleanup* beyond `void-hole` subtraction · textured or
lit-beyond-flat-grey surfaces · animated / stateful geometry (rotating
platforms, rising bridges) · shipping a curated map pack with the app ·
mid-encounter `MAP_CHANGE` (a boss that relocates mid-pull) — same
deferral as `movement-view.md` §5.

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
  the editor's heavier deps (polygon triangulation, a boolean lib) load
  **only** in the editor window — the shipped analyzer binary doesn't
  grow.
- One app to build / sign / notarize; the map files live in
  parseomatic's data dir regardless.

**Keep the seam, though.** Split `src/ui/widgets/replay-scene.ts` into:

- **`src/ui/widgets/scene-rig.ts`** — world + camera + materials + grid +
  void/fog/mist + `OrbitControls` + the on-demand render loop. No game
  data. Consumed by both the replay and the editor.
- **`replay-scene.ts`** — unit meshes, tracks, animation, transport;
  builds on `scene-rig`.

If community map authoring ever wants a renderer without the analyzer,
`scene-rig` + the editor extract into their own Tauri app cheaply. Not
now.

---

## 3. Storage — the data folder

```
<app data dir>/maps/                     (windows-and-files.md — app_data_dir)
  <raid-slug>/
    raid.json          # instance name/id + encounterId -> UiMapID list
    2606.map.json      # one map, keyed on UiMapID (what wago serves)
    2606.glb           # optional baked extrusion cache (§5)
    _src/              # editor working files — NOT shipped, NOT committed
      2606.worldmap.png    # Blizzard art, local drawing reference only
      2606.trace.svg       # a trace-from-image result, pre-cleanup (§9)
```

- **`maps/` sits under `app_data_dir`**, not `app_config_dir` — it's
  user-facing content, the toolbar's "open data folder" button
  (`open_data_dir`, `index.html`) lands here. On macOS the two dirs are
  the same path; elsewhere data is the right one.
- **The raid folder is organisational only.** Resolution scans every
  `*/*.map.json` into a `UiMapID -> path` index at startup (and on a
  file-watch or a manual "reload maps"). A wrong `raid-slug` never breaks
  a lookup.
- **Key on `UiMapID`**, not `encounterID`. `UiMapID` is what
  `wago.tools/maps/worldmap/<id>` serves and what `_src/<id>.worldmap.png`
  is named after. `zones[].mapId` already surfaces it (`log_lists`). The
  replay needs an `encounterID -> UiMapID` step (§6).
- **`_src/` is out of band.** The PNG the editor draws over and any
  intermediate trace live here; nothing in `_src/` is read at replay time
  or redistributed. Add `maps/**/_src/` to `.gitignore` for any repo that
  vendors maps.
- **User files are untrusted data** (`widget-distribution.md`). A
  `.map.json` is parsed defensively — unknown `layer.kind` skipped,
  vertex counts capped, `schema` gated — never `eval`'d, and a malformed
  file degrades to the generic box with a console warning, never a crash.

---

## 4. The `.map.json` format

The **authoring representation** — closed 2D polygons in world yards, per
layer, with flat heights — not a mesh. Small, hand-diffable, re-extrudable
with better tessellation later without redrawing.

```jsonc
{
  "schema": 1,
  "mapId": 2606,                       // UiMapID
  "name": "Queen Ansurek",             // free text, editor-set
  "raidSlug": "nerubar-palace",
  "sourceImage": "wago.tools/maps/worldmap/2606",   // provenance note, not loaded
  "editor": { "app": "parseomatic", "version": "0.1.0", "savedAt": "2026-09-07T…" },

  // Maps drawing-local coordinates to WoW world yards. This IS the
  // X / Z / length / width placement — the replay lines the deck up with
  // unit positions through this. Same axis names as replay `fit_box`.
  "worldBounds": { "minX": -120.0, "maxX": 140.0, "minY": -90.0, "maxY": 110.0 },

  "layers": [
    {
      "kind": "safe",                  // walkable deck — grey grid, like the generic box top
      "floorY": 0.0,                   // deck surface, yards above the void datum
      "polys": [
        [ [x, y], [x, y], … ]          // world yards; closed implicitly; CCW = solid
      ]
    },
    {
      "kind": "wall",                  // obstacle / boundary — same draw, tall
      "floorY": 0.0,
      "topY": 4.0,                     // ~2 player-units; default WALL_HEIGHT
      "polys": [ … ]
    },
    {
      "kind": "void-hole",             // subtracts from `safe` in draw order — donuts, pits
      "polys": [ … ]
    },
    {
      "kind": "mark",                  // flat reference decal a hair above the deck
      "offsetY": 0.05,                 // MARK_LIFT — wins the z-fight, always on top
      "color": "var(--ctp-yellow)",    // theme token or literal; editor palette
      "closed": true,                  // false => a stroked line, not a fill
      "polys": [ … ]
    }
  ]
}
```

Notes:

- **Vertices are world yards**, stored absolute — no normalisation, no
  scale ambiguity, 1 unit = 1 yard end to end (`movement-view.md` §5). The
  editor may *draw* in image pixels and convert on save via
  `worldBounds`.
- **Heights are along scene-`y` (up).** `floorY` = 0 is the deck datum;
  the generic box's `FLOOR_LIFT` (3 yd above `y=0`) is applied by the rig
  so a map at `floorY: 0` sits exactly where the generic deck did. A
  sunken section is `floorY: -2`; a raised ledge `floorY: +3`.
- **`safe` without an explicit `topY`** gets a thin slab (`DECK_THICKNESS`,
  ~0.4 yd) so its edge reads against the void. `wall` needs `topY`.
- **`void-hole` order matters** — it cuts every `safe`/`wall` polygon
  drawn before it. A donut = one `safe` decagon, then one `void-hole`
  circle inside it.
- **Winding**: outer ring CCW, holes-within-a-single-poly CW (standard
  even-odd); the editor enforces it so hand edits don't have to.
- **`mark`** has no back face and `depthWrite: false` (§5) — it's a
  drawn-on annotation (boss-marker spots, intermission lines, "stack
  here"), not collision.

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

Load path (`scene-rig` helper, `src/map/extrude.ts`):

1. Parse `.map.json`; if a sibling `<mapId>.glb` exists **and** is newer
   than the JSON, load that instead (skip 2–4).
2. Per `safe`/`wall` layer: triangulate each polygon (ear-clipping —
   `THREE.ShapeUtils.triangulateShape`, or `earcut`), applying every
   later `void-hole` in the layer as a hole contour. Extrude
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
5. Optionally bake the merged result to `<mapId>.glb` (`GLTFExporter`) as
   a cache — a "Bake" button in the editor, never automatic.

- **Framing.** When a map is present the replay frames on the map's
  `worldBounds` (padded, snapped to `CELL`) instead of `fit_box`, so the
  camera shows the whole arena, not just where the raid stood. `fit_box`
  still available for a "zoom to action" affordance.
- **Void crossings are fine.** A unit whose fix lands over a `void-hole`
  or off the deck is drawn at its real spot regardless — sometimes the
  void isn't lethal, sometimes a knockback earns the death. No clamping,
  no collision.
- **Budget.** A whole arena is tens of polygons → a few hundred to low
  thousands of triangles per map. Trivial next to the unit meshes; no
  instancing, no LOD.

---

## 6. How the replay picks up a map

In `src/views/replay.ts` / the `replay-scene` widget, once per loaded
encounter (cached like `replay_series`):

1. `encounterID` (from `ENCOUNTER_START`) → `UiMapID`: check `raid.json`
   files in `maps/`, then a small bundled `encounterId -> mapId` table,
   then the encounter's own zone `mapId` from `log_lists` as a last
   resort.
2. `UiMapID` → `maps/**/<id>.map.json` via the startup index.
3. Found → `scene-rig` builds the map geometry instead of the generic
   scaled box, frames on `worldBounds`. Not found → **exactly today's
   behaviour**, no regression.

New Rust commands (`src-tauri/src/maps.rs`):

| command | does |
|---|---|
| `map_index()` | `[{ mapId, path, name, raidSlug }]` — the resolve index |
| `read_map(mapId)` | the `.map.json` text (editor + replay) |
| `write_map(mapId, json)` | save (editor only) |
| `fetch_map_image(mapId)` | download the wago PNG into `_src/`, return a local path/URL the webview can load |

`fetch_map_image` is the CORS workaround — the webview can't `fetch()`
`wago.tools` directly; Rust downloads once, the editor loads
`_src/<id>.worldmap.png` from disk.

---

## 7. The map image — acquisition + licensing

- **Source**: `https://wago.tools/maps/worldmap/<UiMapID>` (the same
  `wago.tools` route family `docs/ui-items.md` already leans on for DB2
  data). One PNG per map.
- **Fetched on demand** by `fetch_map_image`, cached in `_src/`. Never
  bundled with the app.
- **Licensing**: the world-map art is **Blizzard's**, redistributed by
  `wago.tools`. It's fine as a **local authoring reference** (same footing
  as opening the game to eyeball a room) but it is **not** shipped inside
  `.map.json`, not committed, not baked into `.glb`. The extruded
  geometry is original work (`ui-items.md` makes the same call). `_src/`
  is git-ignored; `NOTICE` gets a line noting maps are hand-authored and
  reference imagery is Blizzard's, used transiently.

---

## 8. Why vector, not a painted heightmap

A greyscale-heightmap pipeline (paint height per pixel, sample into a
tessellated plane) was considered and rejected for this content:

- Raid arenas are **flat plateaus with hard vertical edges into the
  void** and **sharp-edged obstacles**. The safe/void boundary — the most
  important line on the map — is exactly what a heightmap renders worst
  (stair-stepping or a fuzzy ramp unless resolution is huge).
- The authoring interaction is **corner-clicking on the map image** —
  inherently vector. Painting can't produce a clean decagon.
- Donut / pit / column / "wall two player-units taller" are natural
  polygon booleans + per-layer heights; clumsy as paint layers.
- The proposed encoding ("black = void, else one unit up, 254 steps
  above") is *quantising the heightmap back into a handful of flat
  plateaus* — i.e. polygons with per-polygon heights.
- Mesh cost: a 4k×4k plane naively tessellated ≈ 33 M quads for geometry
  that is ~50 polygons; usable only with adaptive meshing you'd have to
  build.
- **Resolution was never the blocker** — 4k over a 200-yard arena is
  ~20 px/yd, plenty; 16-bit greyscale would fix vertical banding. The
  blocker is the flat-vs-sharp mismatch and the tessellation cost.

Per-*layer* `floorY`/`topY` already covers walls, obstacles, sunken and
raised sections. If a specific boss ever needs a true slope, add an
optional per-polygon linear gradient (two heights + an axis) before
reaching for a heightmap.

---

## 9. Trace-from-image (later)

A fully hands-off "map PNG in → correct arena out" is not reliable — the
world-map art carries labels, icons and gradients and doesn't encode
"where you can stand." A **semi-automatic** importer is very achievable
and would make a map a ~5-minute job:

1. `fetch_map_image` gets the PNG.
2. Classical CV — threshold, edge-detect, `findContours`, `approxPolyDP`
   (Douglas–Peucker) — traces candidate polygons deterministically. Runs
   as a build/tooling script, not in the app; output is
   `_src/<id>.trace.svg`.
3. A **labelling pass** — a human, or Claude given the image + the
   contours — tags each contour `safe` / `wall` / `void-hole` / `mark`
   and sets heights. This is the part pure CV can't do.
4. Import the labelled polygons into the editor; clean up by hand.

Build the manual editor first — it's the ground-truth / fixup tool
regardless — then add a "Trace from image" button that just seeds
polygons.

---

## 10. Build phases

- **A — renderer split.** Extract `scene-rig.ts` from `replay-scene.ts`;
  the replay keeps working unchanged. No editor yet.
- **B — editor shell.** `map-editor.html` + `src/map/*` + a
  `map_editor` menu item (View › Developer for now — it may graduate to a
  top-level "Tools" menu). Opens a `scene-rig` scene, the generic box,
  orbit camera. `maps.rs` with `read_map`/`write_map`/`map_index`.
- **C — image + calibration.** `fetch_map_image`; show the PNG on the
  deck; the drag-rect-against-the-grid calibration that writes
  `worldBounds`.
- **D — polygon tool + `safe`.** Click vertices, close, Enter to commit;
  edit/delete vertices; snap to grid + to existing vertices. Live
  extrude of the `safe` layer through `src/map/extrude.ts`. Save / load
  `.map.json`.
- **E — the other layers.** `wall` (with `topY`), `void-hole` (boolean
  into `safe`), `mark` (palette, `closed` toggle). Per-layer height
  fields. `raid.json` write.
- **F — replay consumption.** `encounterID -> UiMapID` resolve, load a
  map or fall back, frame on `worldBounds`. This is the first phase a
  non-author sees anything.
- **G — bake + polish.** "Bake `.glb`" button, file-watch reload, the
  `_src/` trace import hook.

Phases A + B land first for review.

---

## 11. Open questions

- **`encounterID -> UiMapID` source of truth.** A bundled table
  (maintainable, offline) vs deriving from `raid.json` files the user
  authored vs the log's own zone `mapId` (present but coarse — one zone
  can hold several boss sub-maps). v1 leans: `raid.json` → bundled table
  → zone `mapId`.
- **Calibration accuracy.** Dragging a rect against the 8-yard grid is
  eyeballed. Is a two-known-world-points entry (type in coords for two
  clicked pixels) worth offering as the precise mode? Probably yes by
  phase C.
- **Multiple maps per encounter** (intermission relocations, Mythic-only
  platforms). Deferred with `MAP_CHANGE` (§1) — but the format could grow
  a `variants: [{ when, layers }]` without a schema break.
- **Sub-map vs full-zone image.** Some `UiMapID`s are the whole raid
  wing; the encounter journal often has a tighter per-boss map. Pick per
  map at author time; `sourceImage` records which.
- **Editor undo model** — a flat command stack over polygon ops, or
  snapshot the whole `layers` array per edit (small enough)? Leaning
  snapshot.
- **Sharing maps between users.** Out of scope now, but the on-disk
  format is deliberately a plain file so a future "import a map" is just a
  copy into `maps/`.
- **Wall height default.** `WALL_HEIGHT` = 4 yd (~2 player-units) is a
  guess; tune once real arenas are drawn.
