# Replay view — a 3D raid-wide replay

A **group** view (peer of Encounters / Overview): the whole raid's
positions over one encounter, played back in a 3D scene (perspective
camera, overhead 3/4 default, free orbit) with a
transport bar and a scrub timeline. Cubes for players, GUID-keyed shapes
for every creature, class-coloured from our theme, animated as they move /
cast / die. This doc is the design + the build plan; it will be filled in
as the view lands.

Related: `docs/movement-view.md` (the per-character path view — same
position data model, `pos_unit`, `fit_box`, `MOVE_GAP_MS`),
`docs/activity-and-movement.md` (the cast/channel/empower activity
heuristics the spin animation reuses), `docs/planning.md` §"3D spatial
replay" and §"Entity state" (the original sketch), `docs/ui-widgets.md`
§"Shared state: the playhead" (the fetch-once / rescan-per-frame model),
`docs/ui-items.md` §"Related — encounter maps" (hand-drawn arena floor
plans, deferred).

---

## 1. Scope

### In, v1

- **Every unit with position data**: all players, and **every creature we
  can** — the boss(es) and adds. Adds are disambiguated by **GUID** (two
  adds sharing a name are two entities), matching the two-level unit
  intern model (`docs/planning.md` §"String interning").
- **Class colour** from the `--class-*` tokens (our Catppuccin reading of
  the Blizzard hues). Players get their spec's class colour via
  `COMBATANT_INFO`; **logs without `COMBATANT_INFO` render every unit
  grey**. Creatures get a hostile / neutral token, not a class colour.
- **Cubes** for players. A distinct shape per non-player kind (spheres,
  etc. — see §5). Pets are **omitted** for v1; when added they get a small
  sphere.
- **Animations**: move bounce / squash-stretch, cast spin, death squish,
  resurrect pop, front-face turn-to-face (§6).
- **World**: grey grid floor on a square pillar rising from a black void,
  one directional "sun" with (lazy) shadows, a lazy static skybox (§4).
- **Transport**: play / pause, ±10 s, speed (0.5× / 1× / 2× / 4×), a
  click-to-seek timeline with a hover time tooltip, and **loop markers**
  (mark-in / mark-out + a loop toggle), in-memory per window (§7).

### Out, v1 (planned elsewhere, deliberately deferred)

Pets as entities · spell-cast lines between source and target ·
defensive-buff bubbles · floating buff / cooldown panels over a unit ·
cast-bar / ability-name labels · void-zone / hazard geometry
(`docs/boss-parsers.md` "Implied entities") · per-arena hand-drawn floor
plans (`docs/ui-items.md`) · the boss-parser "key moments" jump list
(`docs/boss-parsers.md`) · verticality — **logs carry x/y only**, so the
whole scene is one plane and knockbacks / platforms / flight read as
ground movement · persisting loop markers to disk.

---

## 2. Data — one fetch per encounter, scrubbed client-side

Follows `docs/ui-widgets.md`'s playhead rule: fetch a bounded dataset once
on `update`, then every animation frame only rescans data already in
memory — no IPC during playback.

### `replay_series` command (`src-tauri/src/replay.rs`)

One live windowed scan of the encounter — `query::window` then a single
linear pass over `[lo, hi)` — producing, for **every unit that carried a
position** in the window:

```
ReplaySeries {
    start_ms, end_ms: i64,
    units: Vec<ReplayUnit>,
    fit_box: Option<[f32; 4]>,   // tight [minX,maxX,minY,maxY] over EVERY unit's fixes
    map_box: Option<[f32; 4]>,   // MAP_CHANGE [x0,x1,y0,y1], corners unsorted, reference only
}

ReplayUnit {
    unit_id: u32,                // dense intern id -> index into log_lists.units
    guid: String,               // raw GUID (adds sharing a name differ here)
    kind: String,               // "Player" | "Pet" | "Creature" | ...
    spec_id: u16,               // players: COMBATANT_INFO CurrentSpecID; 0 otherwise
    samples: Vec<Sample>,       // ordered (t_ms, x, y) fixes -- the position track
    death_spans: Vec<Span>,     // UNIT_DIED -> SPELL_RESURRECT (or window end)
    cast_spans: Vec<CastSpan>,  // casting/channel/empower windows -- drives the spin
    face_events: Vec<FaceHint>, // (t_ms, target_x, target_y) -- a cast landing ON someone
}

Sample   { t_ms: i64, x: f32, y: f32 }
Span     { start_ms: i64, end_ms: Option<i64> }
CastSpan { start_ms: i64, end_ms: i64, spell_id: u16 }
FaceHint { t_ms: i64, x: f32, y: f32 }   // where the thing cast-at was, at cast time
```

**Position** is `EventStore::pos_unit` (the advanced block's `infoGUID`),
never `source_unit` — a unit's own fixes only (`docs/movement-view.md`
§2–3). Every unit's fix widens `fit_box` (the movement view only widened
it for players; here it's raid + boss + adds, which is what we frame on).

**`cast_spans`** — the piece `movement-view.md` §8 flagged as missing.
Per unit, walk the cast timeline:

- `SPELL_CAST_START` → open a window; the next `SPELL_CAST_SUCCESS` from
  that unit closes it → span `[start, success]`. A hard cast.
- A **lone `SPELL_CAST_SUCCESS`** (no open start) → a **short fixed span**
  (`INSTANT_SPIN_MS`, ~450 ms) from the cast timestamp. Covers a true
  instant *and* a channel's opening tick — both read as one quick spin.
- `SPELL_EMPOWER_START` → `_END` / `_INTERRUPT` — an empower span.
- An incoming `SPELL_INTERRUPT` (dest == the unit), `SPELL_CAST_FAILED`,
  or `UNIT_DIED` while a hard cast is open **truncates** it at that
  timestamp (a cast interrupted mid-way still spun).

Full channel-window reconstruction (a `CAST_SUCCESS` sustained until the
next cast / a hard cap, like `ApsActivityModel`) is **not** done in v1 —
the log carries no channel durations and the heuristic paints downtime
between back-to-back instants as a spin. §10 tracks the richer version.

**`face_events`** — a `SPELL_CAST_SUCCESS` (or `_START`) by the unit whose
`dest` is another unit resolves to that dest's position **at that
moment** (nearest fix), captured as a `FaceHint`. Snapshot, not tracked —
the cube does not follow a target that moves mid-channel (§6).

**`death_spans`** — `UNIT_DIED` (dest == unit) opens, `SPELL_RESURRECT`
(dest == unit) closes, else open to window end. Same as
`movement_series`, generalised to all units.

### Size budget

40 players + ~a dozen creatures, a 10 min fight, ~1–3 fixes/s per active
unit: order 50–100 k samples × 12 B ≈ ~1 MB, plus far smaller span
arrays. One fetch, held for the encounter's lifetime, is fine — the same
"small enough to hold client-side" bucket the debug tables and the
playhead design already assume. Cached in `src/ui/replay-series.ts`
(keyed `start:end`, cleared on log change), like `movement-series.ts`.

### Coordinate frame

One `MAP_CHANGE` frame per encounter (`docs/movement-view.md` §5 — true
in every current fixture; a mid-fight `MAP_CHANGE` is a later problem).
1 unit ≈ 1 yard, so no per-map scale lookup. Corners of `map_box` are
**not** sorted — normalise with min/max. The scene frames on `fit_box`
(padded, snapped to the 8-yard grid), falling back to `map_box` then a
fixed span.

---

## 3. Rendering — Three.js

`three` added to `package.json` (bundled by Vite like any dep; UMD not
needed — this is the app, not an Artifact). The scene lives in a
**`replay-scene` widget** (`src/ui/widgets/replay-scene.ts`); the
`replay` view composes it under the transport bar via the normal
Panel/Widget spec (`docs/ui-widgets.md`).

- **One `WebGLRenderer`**, sized to the widget, `devicePixelRatio`
  clamped to 2, `ResizeObserver`-driven. Torn down in `destroy()` (lose
  context, dispose geometries/materials) — the view is re-entered often.
- **Camera**: `PerspectiveCamera` (45° FOV) — an orthographic camera
  distorted the box shapes too much. Distance is derived from `fit_box`
  so the framed span fills the view. It opens **face-on** (`dir.x = 0` —
  looking straight down an axis so the grid is square to the screen, not
  corner-on), at a **low-ish 3/4** (`dir.y` ≈ 0.4, ~22° above the deck —
  cinematic; steeper reads as the platform floating above the horizon),
  pulled in close (distance multiplier ≈ 0.84), and **aims at the
  floor's top surface** (`y = FLOOR_LIFT`), where the units are, not the
  centre of the tall pillar. **Free orbit / pan / zoom** via
  `OrbitControls`; a "reset camera" affordance returns to the default,
  rotation otherwise unconstrained.
  `OrbitControls`' `change` event drives an on-demand render — its
  handler must **not** call `controls.update()` (that re-emits `change`
  → infinite recursion); `update()` is called once after each
  programmatic camera move instead.
- **The render loop is the playhead loop.** One `requestAnimationFrame`
  owned by the widget: advance `timeMs` when playing (× speed, clamped to
  the range or the loop region), then position/animate every unit from
  the in-memory arrays. No React, no per-object framework overhead.
- **Instancing later if needed.** Start with one `Mesh` per unit (≤ ~60
  objects — trivial). If add-heavy pulls push object counts up, move
  players/creatures to `InstancedMesh`. Not a v1 concern.
- **Canvas, not DOM, for the scene**; the transport bar and timeline are
  ordinary DOM widgets above it.

---

## 4. The world

- **Grid floor** — the play area is **one box**: a grid-textured top that
  *is* the floor, the same grid **continuing down the four sides**. The
  grid is a tileable canvas texture (`gridTexture()`): a **dark** base
  fill in Catppuccin **`--ctp-base`** with **lighter** lines drawn on top
  — a **major** cell border every `CELL` (8) yд in **`--ctp-surface1`**
  and `SUBDIV - 1` (4) dimmer **minor** lines per cell in
  **`--ctp-surface0`**.
  Per-face `repeat` (top `span/CELL` both ways, sides `span/CELL` ×
  `PILLAR_DEPTH/CELL`) keeps cells 8 yд on every face and aligned where
  the top meets the sides. "80s wireframe game in our palette." Extent =
  `fit_box` padded one cell and snapped to whole cells; a fixed minimum
  span so a stationary fight isn't a postage stamp.
- **The pillar & mist** — that same box is tall (`PILLAR_DEPTH` ≈ 90 yд),
  rising out of a **cloudy mist** into the void. The void colour is
  Catppuccin **`--ctp-crust`** — used for the `.replay-scene` background,
  the box's unseen bottom face, and `THREE.Fog` (linear, `near`/`far`
  retuned to the span each reframe) which takes over below the mist so
  the pillar has no visible bottom edge. The mist is `MIST_LAYERS` — a
  few stacked translucent discs (`MeshBasicMaterial` + a soft radial blob
  texture, dark-tinted, fog-aware) just below the floor, radii scaled to
  the framed span so they fill the lower frame all around. No far floor.
- **Sun** — one `DirectionalLight` at a fixed angle casting shadows, plus
  a low `HemisphereLight` / ambient fill so shadowed faces aren't pure
  black. **Shadows are deliberately cheap**: a single 1024–2048 shadow
  map over the play area, `PCFSoftShadowMap`, no cascades. Cubes cast;
  the floor receives; cubes' self-shadow receiving is fine to skip.
- **Skybox** — **lazy**: a dark, minimal line-art panorama (clouds +
  distant mountains) drawn to a canvas at runtime, mapped
  **equirectangular** as `scene.background` so it wraps the horizon and
  turns with the camera when you orbit (a plain screen-space background
  reads as "the world is spinning, not the camera"). The mountain
  ridgeline is drawn across the **vertical middle** of the canvas — in an
  equirect map `v = 0.5` is the horizon — with peaks just above it, so
  the mountains sit at eye level, not way below the play area. One
  texture, reused for every encounter. `docs/ui-items.md` covers the
  "get fancy later" (per-arena art, shipped asset) path.

---

## 5. Unit models

`PLAYER_SIZE` ≈ 1.6 yд; `BOSS_SIZE` = `PLAYER_SIZE × 4.8`. Every shape
hovers `HOVER` above the deck.

| Unit | Shape | Size | Colour |
|---|---|---|---|
| Player | Cube | `PLAYER_SIZE` | spec → `--class-*`; `--ctp-overlay1` with no `COMBATANT_INFO` |
| Vehicle / other | Cube | `PLAYER_SIZE` | `--ctp-overlay2` |
| Creature | Sphere | by health (below) | Catppuccin grey by tier (below) — read against the class-coloured players |

**Creatures are sized *and coloured* by max health.** `bossHp` = the
largest advanced-block `maxHP` seen for any creature in the window
(`replay.rs` keeps a per-unit max; "boss" = *the creature with the
biggest health*, the user's definition — not a name match). For a
creature with fraction `f = maxHp / bossHp`:

| `f` | size | colour |
|---|---|---|
| ≥ 0.75 (incl. the biggest, and any council co-boss) | `BOSS_SIZE` | `--ctp-surface2` (darkest) |
| 0.50 – 0.75 | `PLAYER_SIZE × 2` | `--ctp-overlay0` |
| 0.10 – 0.50 | `PLAYER_SIZE` | `--ctp-overlay0` |
| < 0.10 (trash adds) | `PLAYER_SIZE × 0.5` | `--ctp-overlay2` (lightest, so trash still reads) |
| no health data | `PLAYER_SIZE` | `--ctp-overlay0` |

`views/replay.ts` (`enemyColor`).

"Front" is one face of the cube (a darker panel so the facing is legible
at the camera angle). Colour is applied as the material colour; a faint
emissive of the same hue keeps it readable against shadow. Pets are
omitted for v1 (§1) — small spheres in the owner's class colour when
added.

**Overlap de-conflict.** Shapes sharing a spot z-fight.
`deconflictOverlaps` in the widget (greedy clustering, re-run each frame
in phase C):

- overlapping **player cubes fan upward** into a stack — ordered tank →
  melee → ranged → healer (`format.ts` `roleRank`, remapped), GUID
  alphabetical as the tiebreak, each lifted `PLAYER_STEP` (0.1) × its
  height above the one below;
- an **enemy over a player** is pushed **down** flush onto the deck (the
  `HOVER` gap dropped) — it reads as under the player stack;
- **enemies over each other** fan **upward**, biggest on the bottom,
  each smaller one `ADD_STEP` (0.25) × its height higher.

---

## 6. Animation

All animation is a function of `timeMs` and the in-memory arrays —
recomputed each frame, no tweening state that can desync from a scrub.

- **Position** — linear interpolation between the two bracketing
  `samples` (`docs/planning.md`: lerp between real fixes, no prediction).
  A gap > `MOVE_GAP_MS` (5 s) between fixes is "unknown": **hold the last
  known position** (the user's call — not a ghost-out) and drop the
  bounce until real fixes resume.
- **Move bounce / squash-stretch** — driven by interpolated speed
  (yd/s). A gentle vertical bob (a few cm at ~2–3 Hz, scaled by speed)
  plus a small volume-preserving squash on the direction of travel.
  Purely cosmetic; capped so a fast dodge doesn't look violent.
- **Cast spin** — while `timeMs` is inside a `cast_span`, rotate the unit
  about the vertical axis at **~100 rpm**. Overrides the facing logic for
  the duration; may run concurrently with the bounce. Instant casts get a
  short `INSTANT_SPIN_MS` span (§2), so they spin once quickly too.
- **Facing** — the chosen front face turns to a target yaw, eased (not
  snapped):
  1. **After a `face_event`** (a cast landing on someone), face that
     target's snapshot position, and **stay** facing it until **2 s after
     the unit's last action** (last `face_event` or `cast_span` end) —
     "sticky".
  2. **Otherwise**, when the unit is about to move to a fix **> 8 yд**
     away (one grid cell), face that direction of travel.
  3. Otherwise hold the current facing.
  Best-effort for creatures too (bosses have weak facing data, but the
  same rules apply).
- **Death** — on entering a `death_span`, **squish flat to the floor**
  (scale y → ~0.1, x/z spread) over ~0.3 s; hold flat for the span.
- **Resurrect** — on the span closing, **pop up from the floor** (a quick
  overshoot back to normal scale + a small hop) over ~0.3 s.

---

## 7. Transport + timeline

A DOM bar above the scene — its own widgets, writing to the widget's
playhead state (mirrors `docs/ui-widgets.md`'s `playhead-control`, but
self-contained in this view until `ViewContext.playhead` is real).

- **Play / Pause**, **−10 s / +10 s**, **speed** (0.5× / 1× / 2× / 4×).
- **Timeline** — full encounter width. Click anywhere to seek; **hover
  shows a tooltip with the time** at that x (`m:ss.s` relative to
  encounter start, consistent with the Movement view's readouts). Death
  ticks are drawn on it (`death_spans` starts, all units); nothing else
  until the boss-parser key-moments list exists.
- **Loop markers** — **Mark In** / **Mark Out** buttons drop handles at
  the current playhead; the handles are draggable on the timeline. A
  **Loop** toggle confines playback to `[in, out]` (wrap at `out` back to
  `in`). Markers live **in memory, per window** — not persisted in v1.
  This is the seam the boss-parser "key moments" feature plugs into
  later: a moment becomes a preset `(in, out)` pair.
- **Time display** — current `m:ss.s` / total.

Playhead default position: the encounter start.

---

## 8. View wiring

- **`ViewKind::Replay`** (`src-tauri/src/lib.rs`) — id `replay`, menu id
  `view_replay`. A **group view**: its toolbar button sits in the same
  `toolbar-group` as Encounters / Overview (not the per-character group),
  enabled whenever a **bounded encounter range** is selected (like
  Overview / Movement — disabled for the whole-log / unbounded range).
  **No player-picker dependency.**
- **View menu dividers** — split the flat radio list into three groups:
  `[ Encounters · Overview · Replay ]` │ `[ Character · Damage · Healing ·
  Damage Taken · Deaths · Movement ]` │ `[ Debug · Raw ]`
  (`PredefinedMenuItem::separator` between the groups).
- **Toolbar icon** — Font Awesome Free **`video`** (Nerd Fonts alias
  `nf-fa-video_camera`), inline SVG with a `NOTICE` entry, matching the
  existing per-view icons. It goes on the group toolbar (a divider added
  after Overview so the icon reads as its own group with Replay).
- **`index.html`** — a `#replay-view` section with a `#replay-mount`, plus
  a `#replay-hint` empty state ("Pick an encounter — replay needs a
  bounded window.").
- **`src/main.ts`** — `renderReplay()` wired into the view switch, the
  `ViewMode` union, the `aria-pressed` sync, and the hidden-toggle block,
  the same way `movement` is.
- **`src/views/replay.ts`** — the view: builds the `NodeSpec`
  (`transport bar` + `replay-scene`), a `ViewContext`, fetches
  `replay_series` on range change, feeds the scene widget.

---

## 9. Build phases

- **A — scaffold + empty world.** `ViewKind::Replay`, toolbar button +
  icon + divider, menu item + the three menu-group dividers, `#replay-view`
  section, `main.ts` wiring, `src/views/replay.ts`, the `replay-scene`
  widget rendering just the world (grid floor, pillar, void, sun +
  shadows, skybox) with `OrbitControls` at the 3/4 default. No data.
- **B — data + static cubes.** `src-tauri/src/replay.rs` +
  `replay_series` command + `src/ui/replay-series.ts` fetch/cache. Render
  one shape per unit at its **t = encounter-start** position, class /
  hostile coloured, front face marked. No playback yet.
- **C — playhead + transport.** The rAF loop, lerp positioning, the
  transport bar, the click/hover timeline, death ticks.
- **D — animation.** Move bounce / squash, cast spin, death squish,
  resurrect pop, facing.
- **E — loop markers.** Mark-in / mark-out, draggable handles, loop
  toggle.

Phases A + B land first for review, then C–E.

---

## 10. Open questions

- Add density on the worst pulls — if one-`Mesh`-per-unit gets heavy,
  move to `InstancedMesh` (noted in §3).
- Creature colour: one hostile token for everything, or boss vs add vs
  neutral-NPC distinction? (Leaning boss brighter, adds dimmer, same
  hue.)
- Whether the camera should auto-follow the raid centroid during playback
  or stay put (v1: stay put, manual).
- Mid-encounter `MAP_CHANGE` (phased bosses that relocate) — same
  deferral as `movement-view.md` §5.
- `ENVIRONMENTAL_DAMAGE` positions are currently dropped
  (`movement-view.md` §6) — a unit that only ever took falling damage
  would be absent. Rare; fix the field offset if it matters.
