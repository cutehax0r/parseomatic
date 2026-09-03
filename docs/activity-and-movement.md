# Activity, alive-time, and movement

Design for three related per-player, per-encounter metrics the Overview and
the (future) character page want:

- **Active time** — how much of the fight the player spent *doing something*
  (casting / channelling) rather than standing around.
- **Alive time** — how much of the fight the player was alive and able to
  act. Drives *active* DPS/HPS/DTPS (amount ÷ alive-seconds).
- **Movement** — distance travelled and time spent running, from the x/y
  on every event.

The cost worry (all three are O(events in the window)) is answered the
same way for all of them: **compute them once, per encounter, in a
background pass at parse time** (see "Where it runs").

---

## Where it runs

All of these are reductions over one encounter's event window, per player
— the same shape as the Overview players-table aggregates. Rather than
firing a live query per metric per encounter selection:

> One rayon pass **per encounter**, right after `build_reports` in
> `parser::parse_all`, producing an `EncounterStats` held on `ParsedData`.
> Encounters are a fraction of a log (~15–25 % of lines in the fixture),
> the pass is parallel across encounters, and it overlaps the background
> parse the user is already waiting on (progress bar up). A boss
> selection then becomes an **O(1) lookup**.

Custom time ranges (not a real encounter) still take the live
`query_events` path — rarer, opt-in, and unchanged.

`EncounterStats` also subsumes the players-table's current three
`query_events` scans (damage own/pet, healing own/pet, damage taken),
which closes `performance-concerns.md` #8(e).

### Structs

```
PlayerEncounterStats {
    unit_id: u32,
    damage_own, damage_pet, heal_own, heal_pet, damage_taken: i64,
    alive_ms, active_ms, movement_ms: i64,
    distance: f64,
    movement_bins: [f64; 10],   // distance per 10 % slice of the encounter
    deaths: u32,
}

EncounterStats { players: Vec<PlayerEncounterStats> }

// ParsedData
encounter_stats: Vec<EncounterStats>   // index-aligned with reports.encounters
```

Exposed to the frontend by an `encounter_stats(encounterIndex)` Tauri
command (camelCased rows), fetched once per encounter and memoized
client-side like `query_events` already is.

---

## Position → promoted columns

Today x/y is re-parsed from `raw_fields` on demand (`lib.rs`
`extract_position`, used only by the raw view). Movement needs it on every
event without re-parsing, so promote it:

```
EventStore {
    ...
    pos_x: Vec<f32>,   // f32::NAN when the event carries no position
    pos_y: Vec<f32>,
}
```

Filled in `parse_composed` from advanced-block indices 14/15
(`combat-log-format.md` §5); `NAN` for swings without an advanced block,
standalones, and unrecognized lines. ~8 bytes/event (~14 MB for the
547 MB fixture) and one `f32` parse per advanced composed event (~30 ms
total) — within budget. `raw_events` reads the column instead of
re-parsing; `extract_position` goes away.

---

## Active time

### Pluggable

```rust
pub trait ActivityModel: Sync {
    /// Active milliseconds for `player` within `[start_ms, end_ms]`.
    fn active_ms(
        &self,
        player: u32,
        start_ms: i64,
        end_ms: i64,
        events: &EventStore,
        tables: &InternTables,
    ) -> i64;
}
```

The per-encounter pass takes `&dyn ActivityModel`; a setting picks the
implementation later. Two planned:

### `ApsActivityModel` — ship this first

Closer to StarCraft "actions per second" than to a GCD model, and it
needs no external data.

- Step the window in 1 s bins.
- A bin is **active** if the player, in that bin:
  - started a cast (`SPELL_CAST_START`), or
  - had a `SPELL_CAST_SUCCESS` (instant cast, or the start of a channel),
    or
  - was inside an open **empower** span (`SPELL_EMPOWER_START` →
    `_END` / `_INTERRUPT`), or
  - was inside a short **channel window** opened by a `CAST_SUCCESS` and
    closed by the next `CAST_*` from that player / `SPELL_CAST_FAILED` /
    `UNIT_DIED` / a hard cap (~6 s — channels are short and the log
    doesn't carry their duration).
- Interruptions: `SPELL_CAST_FAILED` (reason "Interrupted"), an incoming
  `SPELL_INTERRUPT`, `UNIT_DIED`, or a large position delta between two
  sub-second events while a cast/channel is open. A small per-player
  stack handles nesting.
- `active_pct = active_ms / (end_ms - start_ms)`.

**Known caveat (surface in the UI):** HoT/DoT classes read low (ticks
aren't "pushing buttons"), and healers read oddly in general. This is the
same limitation World of Logs' metric has, and the reason the model is
pluggable.

### `GcdActivityModel` — phase 2

World-of-Logs style: compute the GCD (1.5 s, haste-scaled, not universal)
at each cast and require the player to be casting/channelling whenever not
on the GCD. Needs a **bundled spell-data table** (GCD category, cast /
channel time, off-GCD flag) — the combat log carries none of that — so
it's a separate dependency/asset decision, deferred.

---

## Alive time

Per player, track alive intervals inside the encounter:

- `UNIT_DIED` (dest == player) closes an interval.
- A combat-res (`SPELL_RESURRECT`, or the res aura followed by renewed
  activity) reopens one.
- First / last event involving the player bounds their presence (players
  join and leave across a night).

`alive_pct = Σ alive_ms / encounter_ms`.

**Active DPS/HPS/DTPS** = amount ÷ alive-seconds (vs ÷ encounter-seconds
for the plain figure). Since damage/healing only land while alive, this is
essentially a denominator swap once `alive_ms` exists — nearly free, and
shown as the metric cell's sub-line or a toggle.

---

## Movement

In the per-encounter pass, per player, walk positioned events in order:

- `distance += hypot(dx, dy)` between consecutive positioned events.
- `movement_ms += Δt` for steps whose speed (`dist / Δt`, Δt small)
  exceeds a stand/walk threshold.
- Bin `distance` into 10 buckets (10 % of the encounter each) for a row
  sparkline.
- Keep a coarse `(t, speed)` series for a velocity graph on the character
  page.

**"Jesus footsteps" path view** is just the raw `(t, x, y)` polyline per
unit, downsampled client-side from `raw_events` — no precompute; build it
with the spatial/replay view.

---

## Overview "Active" column (next)

A metric-cell column matching the damage/healing cells:

- **Headline:** active % (`activeMs / encounterMs`). **Secondary line:**
  death count in red when > 0, else "active".
- **Micro-chart:** a smooth **curve** through the 10 per-decile activity
  values (Catmull-Rom, like the line-chart widget), teal stroke
  (`--ctp-teal`, distinct from damage/heal/taken) over a faint teal area
  fill.
  - Where the player was **dead**, that stretch of the curve + fill is
    redrawn **yellow** (`--ctp-yellow`) — one treatment only: a colour
    change at full strength, not a dimmed teal. Implemented as a
    `clipPath` over the dead x-ranges. So a dip that's death reads
    differently from a dip that's slacking.
  - A decile counts as dead for the recolour when `deadBins[i] > 0.5`.

**Data still to add:** two per-decile arrays on `PlayerStatsRow` /
`PlayerEncounterStats` — `active_bins: [f64; 10]` (active fraction) and
`dead_bins: [f64; 10]` (dead fraction). Both fall out of the existing
pass: `dead_bins` distributes `dead_spans` across the deciles the way
`movement_bins` already distributes distance; `active_bins` means having
the `ActivityModel` report a per-bin profile rather than only the scalar
`active_ms` (change the trait method to return `Vec<f64>` / a fixed-size
profile and derive the scalar from it).

Mock: `active-column-mock.html`.

## Later: "maximum possible" projection line on damage / healing bars

A tick on each damage-done / healing-done bar marking where that player's
amount *would* land at 100 % active time — `amount / active_pct`. So the
top DPS at 98 % uptime / 150k reads a tick at ~153k; a player at 125k /
85 % uptime reads a tick at ~147k, i.e. "more buttons ≈ 97 % of the top
bar". It's aspirational, not literal — damage done is zero-sum, encounter
mechanics cap real uptime below 100 %, and it needs care for players who
did burst damage and then died (dividing a big number by a small
active-fraction over a short alive window explodes). **Not building now**
— captured here for when the activity numbers are trusted.

---

## Rollout

1. `pos_x` / `pos_y` columns; `raw_events` + tests moved onto them.
2. `stats.rs`: `EncounterStats`, `ActivityModel` + `ApsActivityModel`,
   the per-encounter rayon pass, wired into `parse_all`.
3. `encounter_stats` Tauri command + frontend types + `ctx` accessor +
   client memoization.
4. Overview "Active" column + mock-up; then migrate the whole players
   table onto `encounter_stats` (drops the 3 live `query_events` scans).
5. Character page velocity graph.
6. (Later) `GcdActivityModel` + bundled spell-data table; path/replay
   view.
