# Movement view — where a player went during an encounter

A per-character view (raid view later) that reconstructs a player's
path from the x/y on their combat-log events: a top-down path plot and
a "how much did they move" bar graph over time. This doc is the
research + data model; the visual design is sketched at the end and
will be filled in as the view is built.

Related: `docs/activity-and-movement.md` (the per-encounter stats pass
that already computes `distance` / `movement_ms` / `movement_bins`),
`docs/combat-log-format.md` §5 (the advanced-params block).

---

## 1. Where x/y comes from

One source only: the **advanced-params block**, fields 15/16
(`positionX`, `positionY`) — `docs/combat-log-format.md` §5. Already
promoted to columns so no re-parsing:

```
EventStore { pos_x: Vec<f32>, pos_y: Vec<f32> }   // f32::NAN when absent
```

`NaN` whenever the row has no advanced block. A `MAP_CHANGE`'s uiMapID
(advanced field 17) is **not** promoted — only x/y are.

## 2. Whose position is it — `infoGUID`, not always the source

The advanced block describes its **`infoGUID`** field (block field 1),
and which unit that is depends on the sub-event. Checked against
`WoWCombatLog-090326_192352.txt` across every event family:

| Event | `infoGUID` = | the coords are |
|---|---|---|
| `SPELL_CAST_SUCCESS` | **source** (caster) | the casting player's own spot — even when the spell lands on someone else |
| `SPELL_DAMAGE`, `SPELL_PERIODIC_DAMAGE`, `RANGE_DAMAGE`, `SWING_DAMAGE` | **dest** | the target that was hit |
| `SPELL_HEAL`, `SPELL_PERIODIC_HEAL` | **dest** | the heal recipient |
| `SPELL_ENERGIZE` / `_DRAIN` / `_LEECH` | **dest** | the unit gaining/losing power (usually self) |
| `ENVIRONMENTAL_DAMAGE` | dest (victim) | the victim — but the field order is irregular in current logs, see §6 |
| `SPELL_CAST_START` | — | no advanced block — **no position** |
| `SPELL_AURA_APPLIED` / `_REMOVED` / `_REFRESH` / `_DOSE`, `_INTERRUPT`, `_CAST_FAILED` | — | no advanced block — **no position** |

Evidence: in one 1-second slice, 20+ players' `SPELL_DAMAGE` lines onto
the boss all carry the identical coords `387.14, 403.95` (the boss's
spot), while each of those players' own `SPELL_CAST_SUCCESS` in the same
second carries their own distinct coords. Boss→player `SPELL_DAMAGE`
carries the *player's* coords.

Consequences for anything reading position:

- **Damage taken → the victim's position.** A player who is the *dest*
  of damage (boss hit, environmental, a DoT ticking on them) — those
  coords are theirs.
- **Damage/healing dealt → the target's position, not the caster's.** A
  player's outgoing `SPELL_DAMAGE` / `SPELL_PERIODIC_DAMAGE` /
  `SPELL_HEAL` rows carry where the *target* was.
- **Buff/debuff gains carry no position at all** — aura events have no
  advanced block. Boss-debuff colouring (§7) is a time-only interval
  query over `AURA_APPLIED`→`AURA_REMOVED`, independent of x/y.

## 3. `EventStore::pos_unit(row)`

Resolves the unit a row's `pos_x`/`pos_y` belong to:

```rust
pub fn pos_unit(&self, row: usize) -> u32 {
    if self.pos_x[row].is_nan() { return NO_UNIT; }
    match self.kind[row] {
        LineKind::Composed { suffix: Suffix::CastSuccess, .. } => self.source_unit[row],
        _ => self.dest_unit[row],
    }
}
```

Zero new storage — it's derivable from `kind` + the existing
`source_unit` / `dest_unit` columns. A dedicated `pos_unit: Vec<u32>`
column (interned `infoGUID`, ~4 bytes/event) would be more robust if the
`infoGUID` rule ever drifts, but isn't worth the memory today.

**Bug this fixed:** the `stats.rs` per-encounter movement pass keyed
distance off `is_player(source_unit)` and treated `pos_x` as the
source's location. For a DPS tunnelling a stationary boss, nearly every
positioned row they *source* is a `SPELL_DAMAGE` carrying the *boss's*
fixed coords, so their `distance` / `movement_ms` / `movement_bins` were
effectively the boss's movement. The pass now walks `pos_unit`. (The
Deaths view already read the advanced block as "dest" for
`currentHp`/`maxHp` — it just hadn't accounted for the
`SPELL_CAST_SUCCESS` exception, which for HP rarely matters and for
position matters a lot.)

## 4. Reconstructing one player's track

Merge, in timestamp order, the rows where `pos_unit(row) == player`:

- every `SPELL_CAST_SUCCESS` they cast (the densest source — a busy
  player emits 1–3/s),
- every damage / heal they **received** (incl. DoT/HoT ticks on them),
- self-buffs' `SPELL_ENERGIZE`, self-heals.

Sampling is dense while the player is doing things and sparse when idle
(observed: one player held a single coord across 4 casts spanning
~1.3 s, then jumped). Between samples, interpolate on a straight line —
we deliberately don't try to recover stutter-steps or back-and-forth
inside a gap. Treat a gap longer than `MOVE_GAP_MS` (5 s) as "unknown",
not a run (a log gap, a wipe/reset, or a phase teleport).

## 5. Units, distance, and the map box

**1 coordinate unit ≈ 1 yard.** Sanity check: a player moving
`(570.70, 12.48) → (576.23, 22.02)` in 1.35 s covers 11.0 units =
**8.2 units/s**, right at WoW run speed (7 yd/s base, higher with raid
speed buffs). So `hypot(dx, dy)` is already ~yards; no per-map lookup
table is needed for approximate distance.

For the top-down plot's extents, use the `MAP_CHANGE` line:

```
MAP_CHANGE,uiMapID,"uiMapName",x0,x1,y0,y1
MAP_CHANGE,2607,"The Venomous Abyss",1088.000000,410.000000,508.500000,-508.500000
```

`x0,x1,y0,y1` is the playable-area bounding box (not a unit position).
**Watch the axis order:** in the example `x0 (1088) > x1 (410)` — the box
corners aren't sorted, so normalise per-map with `min`/`max`, don't
assume `x0 < x1`.

**Maps can change within one instance.** "The Venomous Abyss" shows up
as both uiMapID 2607 and 2609 with different boxes. In the current
fixtures every boss pull sits entirely on one map (the `MAP_CHANGE`
lines fall in the trash gaps *between* pulls), so **v1 can assume one
coordinate frame per encounter**. A phased boss that relocates mid-fight
would emit a `MAP_CHANGE` inside the encounter window — to support that
later, either promote uiMapID to a column or track the active
`MAP_CHANGE` and segment the path by map.

## 6. `ENVIRONMENTAL_DAMAGE` caveat

In current logs the `environmentalType` token ("Falling") appears at the
**end** of the line, after the advanced block and the damage suffix —
not in the prefix slot §6 documents. `parse_composed` computes
`after_prefix = 9 + 1` for Environmental and looks for the advanced
block starting one field too early, so `has_advanced` comes out false
and these rows get **no position**. Environmental damage is rare and the
victim's position is usually available from a nearby event anyway;
noting it rather than fixing it now. If the path view needs it, fix the
Environmental field offset in `parse_composed`.

## 7. The two graphs

### 7a. Top-down path plot — **built (first cut)**

`src/ui/widgets/movement-path.ts`: the selected player's `(x, y)` fixes
drawn as a smooth **Catmull-Rom curve** (open, no value-band clamp —
this is a spatial curve) on a faint world-coordinate grid. The plot is a
**square** (CSS `aspect-ratio: 1`, capped ~460 px, centred in its
column; the widget reads its real pixel width AND height), one uniform
scale for both axes so the route shape isn't distorted; screen +x right,
+y up. Sits beside the activity pie (§7c).

- **Framing:** `fit_box` — the tight bounds over **every player's** fixes
  in the window ("the area the raid played in"), from `movement_series`
  — padded 10 %. Falls back to the `MAP_CHANGE` box (§5, corners
  min/max-normalised), then to this player's own extent, with a 20-yard
  minimum span so a barely-moving player isn't magnified into noise.
  (All a stopgap until a real map image + per-map lookup replace it.)
- **Grid:** lines at round world coordinates (`niceStep(worldSpan/6)`),
  clipped to the region, plus a frame rect.
- **Trail direction:** the curve is drawn in ~8-point chunks with
  `stroke-opacity` ramping 0.22 → 1.0 across `[startMs, lastFix]`, so
  old route reads faint and recent route bright — direction without an
  animation.
- **Markers:** hollow ring at the first fix, filled dot at the last,
  `--chart-death` crosses at the fix nearest each `UNIT_DIED`.
- **Gaps:** consecutive fixes more than `GAP_MS` (5 s) apart break the
  trail rather than drawing a long false segment across a wipe reset /
  phase teleport.
- Hover snaps to the nearest fix and shows its elapsed time.

**Still to add:** per-segment **state colouring** (green still / blue
moving+casting / red moving raw / purple boss-debuff) — needs the cast
and aura spans, which the shipped `movement_series` doesn't carry yet
(`stats.rs` already derives the cast timeline as `CastEvent`; the aura
spans need a new scan). A **playback scrubber** and the growing
"camped here" standstill circles are also future.

### 7b. Movement-over-time line graph — **built**

`src/ui/widgets/movement-chart.ts`, a single-series sibling of the
Overview `line-chart` (same geometry, axis/tick engine, hover). One
`--accent` line of **distance rate (yd/s)** over time; the selected
player's `UNIT_DIED` timestamps are `--chart-death` vertical rules. Fed
by the `movement_series` command (§8).

Unlike `line-chart` it draws a **straight polyline through every fine
bucket — no Catmull-Rom, no draw-bucket roll-up.** Movement is spiky by
nature (stand still = 0, dodge = burst) and the bursts are the point;
the smoothing + 8 s roll-up that read well for a DPS trend turned a
real `3/6/2/0/25/7` bounce into a smooth steep ramp (the spline
overshooting toward the spike). The line and the hover tooltip now read
the same fine-bucket array the same way, so they can't disagree.

The view (`src/views/movement.ts`) gates like Overview/Deaths — a
player must be picked and the range must be a bounded window, not the
whole log — and shows total distance as the title badge.

### 7c. Activity pie — **built**

Reuses the `pie-chart` widget. The window is stepped in `BIN_MS` (1.5 s)
slots — shared with `stats.rs` — and each slot is classed two ways:

- **moving** if the majority of the slot was spent above
  `MOVE_SPEED_MIN` (1 yd/s), from the fix-to-fix intervals spread across
  the slots they cover; else **standing**.
- **acting** if a `SPELL_CAST_START` / `_SUCCESS` of the player's own
  landed in the slot (checked before the position gate — `CAST_START`
  has no advanced block); else idle.

→ four slices: **Standing** (grey), **Standing + acting** (green),
**Moving** (amber), **Moving + acting** (blue), as seconds.
`movement_series.activity` (`ActivitySplit`) carries the four ms totals.

This is a coarser cousin of `stats.rs`'s `ApsActivityModel` — it keys
only off cast events landing in a slot, not channel/empower spans or
mid-cast slots — enough for "did they press a button roughly every GCD
while moving". Refine against `ApsActivityModel` if it reads wrong.

**Later:** per-bin state colouring (green still / blue moving+casting /
red moving raw), matching 7a. Needs the cast/aura spans (§8); the
shipped `movement_series` is distance + fixes only.

`stats.rs` `movement_bins[10]` (distance per encounter-decile) is the
coarse precomputed version, still on `PlayerEncounterStats` for the
Overview row sparkline.

## 8. Data model / where it computes

- **Coarse row stats** (distance, moving-%, the 10-bucket sparkline) —
  in the parse-time `stats.rs` pass, on `PlayerEncounterStats`. Nothing
  new.
- **`movement_series` command** (`src-tauri/src/movement.rs`, **built**) —
  one live windowed scan feeding both graphs. Same shape as
  `spell_breakdown` / `death_detail`:

  ```
  MovementSeries {
      start_ms, end_ms, bucket_ms: i64,
      buckets: Vec<f64>,          // distance (~yd) per equal time slice -- the line graph
      total:   f64,
      deaths:  Vec<i64>,          // this unit's UNIT_DIED timestamps in the window
      samples: Vec<Sample>,       // ordered (t_ms, x, y) fixes -- the path plot
      map_box: Option<[f32; 4]>,  // MAP_CHANGE [x0,x1,y0,y1] (corners unsorted), reference only
      fit_box: Option<[f32; 4]>,  // tight [minX,maxX,minY,maxY] over EVERY player's fixes -- the path frame
      activity: ActivitySplit,    // standing / moving x idle / acting ms -- the pie (§7c)
  }
  ```

  `query::window` binary-searches the row range, then **one linear pass**
  does everything: `hypot` between consecutive `pos_unit == unitId` fixes
  into `query.rs`-style buckets (`dt > MOVE_GAP_MS` steps don't count
  toward distance but the fix is still recorded to `samples`); every
  player's fix widens `fit_box`; cast events fill the per-slot "acted"
  bitmap and moving intervals fill the per-slot "moving ms", folded into
  `activity` after the loop. `map_box` comes from a backward scan for the
  nearest `MAP_CHANGE` at/before the window (raw fields 3–6, resolved
  against the mmap). Bucket count matches the Overview chart (~1/s,
  capped 800). Fetched + cached in `src/ui/movement-series.ts` (keyed
  `unitId:start:end:buckets`, cleared on log change).

- **Still missing for §7a's colour states:** the cast spans
  (`SPELL_CAST_START`…`_SUCCESS`) and enemy-aura spans. Add them to
  `movement_series` when building that; `stats.rs` already derives the
  cast timeline as `CastEvent`.

## 9. Raid view (later)

Same shape, all players at once, drawn on the shared
map box — a heatmap or spaghetti plot with the scrubber. The
"wrong for the player" outgoing-damage rows are a bonus here: every
player's hits on the boss agree on the **boss's** coordinates each tick,
so a boss dot on the scrubber is nearly free.

## 10. Open questions

- Exact "boss debuff" list for the purple state — probably a small
  hardcoded per-encounter set, like the Deaths view's aura-highlight
  plan, not "every enemy aura".
- Whether to promote `uiMapID` (needed only for mid-encounter map
  changes — not in the current fixtures).
- Fix the `ENVIRONMENTAL_DAMAGE` field offset (§6) if the path view
  turns out to want those samples.
