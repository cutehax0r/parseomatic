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

### 7a. Top-down path plot

The `(t, x, y)` polyline for the selected player, drawn over the map
box from §5, optionally animated with a playback scrubber.

Segment colouring, by state between consecutive samples:

| State | Colour | Backing data |
|---|---|---|
| standing still | green | step speed `< MOVE_SPEED_MIN` (1 unit/s) |
| moving, doing nothing | red | speed ≥ threshold, no cast open |
| moving while casting | blue | step interval overlaps a `SPELL_CAST_START`…`SPELL_CAST_SUCCESS`/`_FAILED` span for that player |
| moving with a boss debuff | purple | step interval overlaps an aura interval whose caster is an enemy unit; exact debuff list TBD |
| dead | yellow dot at the spot | `UNIT_DIED` (dest = player) → next `SPELL_RESURRECT`; `stats.rs` already tracks these as `dead_spans` |

`stats.rs` already builds a per-player cast timeline (`CastEvent`:
Start / Success / Failed / Empower / Died), which the blue state reuses.
The purple state needs a new aura-interval scan (no position involved).

**Standstill markers:** where consecutive samples stay within a small
radius for > 1.5 s, drop a circle at that spot and grow it by a fixed
increment per additional second parked — a quick read of "camped here".

### 7b. Movement-over-time bar graph

Like the Overview line chart: distance moved per time bin (**1.5 s
minimum bin**, matching `stats.rs` `BIN_MS`). Each bin coloured by its
dominant state — green (still) / blue (moving+casting) / red (moving
raw). Death periods marked yellow, same as 7a.

`stats.rs` `movement_bins[10]` (distance per encounter-decile) is the
coarse version of this and already ships in `PlayerEncounterStats`; the
view wants a finer, per-1.5 s series with the state split, so it needs
its own data path (§8).

## 8. Data model / where it computes

Two consumers, two paths:

- **Coarse row stats** (distance, moving-%, the 10-bucket sparkline) —
  already in the parse-time `stats.rs` pass, on `PlayerEncounterStats`.
  Nothing new.
- **The path polyline + fine movement series** — a dedicated backend
  command, e.g. `movement_path(encounterIndex, unitId)`, returning the
  ordered samples for that unit:

  ```
  MovementPath {
      map_boxes: Vec<{ ui_map_id, x0, x1, y0, y1 }>,   // from MAP_CHANGE
      samples: Vec<{ t_ms, x, y }>,                    // pos_unit == unitId, time order
      casts:   Vec<{ start_ms, end_ms }>,              // for the blue state
      boss_debuffs: Vec<{ start_ms, end_ms }>,         // for the purple state
      deaths:  Vec<{ died_ms, revived_ms? }>,
  }
  ```

  One scan of the encounter window picking `pos_unit(row) == unitId`,
  plus the cast/aura/death spans (the pass in `stats.rs` already derives
  most of these). Cache it per `(encounterIndex, unitId)` like
  `encounter_stats` / `spell_breakdown` already are. Client does the
  binning, interpolation, colour classification, and downsampling for
  the plot.

  A pure-client alternative (query `raw_events` for source=player +
  target=player, read the `position` field, merge) works for a first
  cut — the raw row already carries `position` — but re-does the
  `pos_unit` logic in TS and can't see cast/aura spans cheaply. Prefer
  the command.

## 9. Raid view (later)

Same `movement_path` shape, all players at once, drawn on the shared
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
