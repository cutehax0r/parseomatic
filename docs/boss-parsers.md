# Boss parsers — encounter-mechanic analyzers

Originally recorded as long-term design with nothing built. **The phases
half of this idea is now built** — `docs/encounter-config.md` — but it
took a different shape than sketched below, so read this doc as the
original motivation/vision with a status note on each section, not as an
accurate description of what exists. **The mechanics half (§2 below) is
still entirely unbuilt.**

**What actually shipped, in brief:** instead of a Rust-side registry of
per-encounter parser code keyed on `encounterId` (the "boss parser" this
doc originally proposed), phases are authored as a declarative JSON file
(`<encounterId>.<difficulty>.json`, one per encounter+difficulty, via a
node-graph editor — no code) and evaluated client-side, on demand, against
whatever's already queryable through the existing generic `query_events`
DSL — no new Rust pass, no per-encounter compiled code at all for phases.
See `encounter-config.md`'s "Trigger vocabulary" for what phase boundaries
can currently be detected from (casts, a numeric health/power threshold,
fixed timers, boolean combinations via the graph) and its "Graph node
types" for how they're authored. **Mechanics (§2) may still end up needing
real per-encounter code** (the `custom` mechanic kind is exactly that
escape hatch), so the questions below about code distribution/trust stay
relevant there even though they turned out not to apply to phases.

## The idea

Base parsing (`combat-log-format.md`, `reports.rs`) knows nothing about a
*specific* boss. It pairs `ENCOUNTER_START`/`_END`, classifies events,
tracks deaths. It can't tell you that **Nek'zali the Soulcoiler** has two
phases with an untargetable intermission between them, or that **Essence
Rend** is the mechanic that decides whether a pull went well.

A **boss parser** knows one encounter's mechanics. It activates when a log
contains that encounter (by `encounterId` + difficulty), scans that
encounter's event slice, and emits structured, encounter-specific output
the rest of the app consumes: phase boundaries, discrete mechanic events,
and derived stats. It turns a wall of events into "here's how the fight
played out — Essence Rend hit these three players at 1:42, the memory game
failed on pull 4, phase 2 started at 3:10."

Payoff: a **timeline / gantt / kanban view of an encounter** (see
`ui-widgets.md`'s reui.io reference), phase-aware graphs, mechanic
filtering, and encounter-specific widgets.

## What a boss parser produces

Attached to the `Encounter` (`reports.rs`) or a parallel structure.

### 1. Phases — named time sub-ranges

**BUILT**, as `PhaseDef`/`TimeRange` (`encounter-config.md`, `runtime.ts`)
rather than this exact shape — `kind` grew a third value (`"enrage"`),
and `startRow`/`endRow` don't exist (evaluation works in `startMs`/`endMs`
against `query_events`, not raw event-store row ranges). Current
consumers are the Timeline and Kanban phase tables
(`src/views/timeline.ts`, `src/views/kanban.ts`); the two below aren't
wired up to real phase data yet.

```
Phase { name, kind: "phase" | "intermission", startMs, endMs, startRow, endRow }
```

Nek'zali: `["Phase 1", "Intermission", "Phase 2"]` — literally the
worked example in `encounter-config.md` and this app's own test fixture
(`encounters/3470.normal.json`). Consumers:
- **Graph markers** — vertical dividers on the line chart. Not built.
- **Selectable sub-ranges** — the encounter picker (`ui-widgets.md`) gains
  these as named presets under the encounter; "inspect the intermission"
  is one click, resolving to a `RangeSelection` `[startMs, endMs]` like any
  other range. Not built.
- Detection is usually a cast or aura (`ENCOUNTER_START` → Phase 1; a
  boss "shield"/untargetable aura → Intermission; its removal → Phase 2),
  sometimes a boss-HP threshold (needs a running total of damage to the
  boss unit). **BUILT**, as `castStart`/`castSuccess`/`threshold` triggers
  (`encounter-config.md`) — the boss-HP case doesn't need a running
  damage total after all: `currentHP`/`maxHP` ride on every advanced
  combat-log block and are now typed `EventStore` columns
  (`current_hp`/`max_hp`, filterable by `posUnit`), so a threshold trigger
  reads real per-unit HP samples straight off the log. Aura-based
  detection (`auraApplied`/`auraRemoved`) is declared in the trigger
  vocabulary but has no evaluator case yet — same "no detector yet, shows
  as unresolved" bucket as the rest of the not-yet-built vocabulary.

### 2. Mechanic events — discrete named occurrences

**NOT BUILT.** `encounter-config.md`'s schema has a `MechanicDef`/
`MechanicKind` stub (label/kind/trigger/params, eight sketched kinds --
`groupSoak`, `addSpawn`, `orbSoak`, `tankBuster`, `mustKick`, `runAway`,
`stackingDebuff`, `custom`) and `PhaseDef.mechanics` references into it,
but no mechanic has a node type, a detector, an analyzer, or a renderer
yet -- every phase compiles with `mechanics: []` regardless of what's
authored. Everything below this point in the doc is still the original,
unimplemented plan.

```
MechanicEvent {
  mechanic,            // "Essence Rend", "Memory Game", "Find Your Buddy"
  startMs, endMs?,     // a moment, or a window
  startRow, endRow?,
  targets: [unitId],   // who it hit / who was assigned
  outcome: "success" | "fail" | "partial" | "info" | null,
  detail: { ... },     // mechanic-specific: damage, symbols, adds killed, …
}
```

Consumers:
- **Encounter widget** — a card/panel per mechanic (targets, damage,
  pass/fail).
- **Timeline / kanban board** — each event a bar/card on a lane; click to
  focus its `[startMs, endMs]`.
- **Graph flags** — markers where important events land.
- **Filter clause** — a new `mechanic` clause in the filter chain, so
  "only Essence Rend windows" works.
- **Aggregate stats** — "12 players hit by avoidable damage", "memory
  game: 3/5 pulls passed" — fed to `stat-tile` / `bar-list` widgets.

### 3. Derived stats

Encounter-specific counters that don't fit the generic `query_events`
aggregate DSL (`ui-widgets.md`, "Data access") — the parser computes them:
adds killed before enrage, avoidable vs unavoidable damage taken,
interrupt success rate on a specific cast.

## Where it plugs in

**Superseded for phases** (§1) by what's actually built — kept below as
the still-relevant plan for mechanics (§2), which may yet need this shape
once the `custom` kind's TS modules need real per-encounter execution.

- ~~Runs **after** base encounter pairing in `reports.rs` (or a dedicated
  pass), once per `Encounter` whose `(encounterId, difficultyId)` has a
  registered parser.~~ Phases instead run **on demand, client-side**,
  triggered by picking an encounter in the UI (`src/ui/context.ts`'s
  `refreshEncounterConfig`) — no Rust-side pass, nothing runs at parse
  time.
- ~~Input: the encounter's `EventStore` slice (`start_row..=end_row`), the
  intern tables, the `Encounter` metadata.~~ Phases' actual input is the
  matched `EncounterConfig` JSON (found by a direct
  `<encounterId>.<difficulty>.json` file read, `encounter-config.md`
  "Matching a log encounter") plus whatever the generic `query_events`
  DSL can answer for the picked encounter's `[startMs, endMs]` window —
  no dedicated row-range slice, no bespoke per-encounter Rust code path.
- ~~Output: `EncounterAnalysis { phases, mechanics, stats }`, hung off the
  `Encounter` and serialized to the frontend.~~ Phases' actual output is
  `EvaluatedPhase[]` (`src/encounters/evaluate.ts`) built fresh in the
  frontend each time a view needs it (Timeline, Kanban) — not cached on
  the backend `Encounter`, not serialized as a single payload. Whether
  mechanics eventually need a real `EncounterAnalysis`-shaped payload
  (and whether it's worth caching) is still open.
- ~~A **registry** keyed on `encounterId`, falling through to a no-op —
  same shape as the widget registry (`ui-widgets.md`).~~ Phases have no
  registry or fallback-to-no-op concept — a missing config file for a
  given `(encounterId, difficulty)` just means every consumer falls back
  to its default (no map override, no phase table, etc.), which serves
  the same purpose without needing an explicit registration step.

## The detection toolkit

Parsers must not each hand-roll event scanning. A small helper library
over the columnar `EventStore`. For phases, this ended up being the
`Trigger`/`NumberExpr` vocabulary (`encounter-config.md`) plus
`src/encounters/evaluate.ts`'s resolvers, not a Rust helper library —
status per originally-sketched primitive:

- `first_cast(spellId, after?)` / `all_casts(spellId)` — **BUILT** as
  `castStart`/`castSuccess` (first match only; no `all_casts` equivalent
  yet, nothing's needed it).
- `aura_holders(spellId, atMs)` — who holds debuff/buff X at a moment.
  Not built (`auraApplied`/`auraRemoved` are declared triggers with no
  evaluator case).
- `occurred(predicate, window)` / `damage_in(window, sources?, targets?)`
  — not built; would matter for mechanics (§2), not phases.
- `sequence([spellId…], maxGapMs)` — cast A then B then C within a gap.
  Not built.
- `boss_hp_crosses(pct)` — running damage total vs the boss's max HP.
  **BUILT**, and simpler than planned: `threshold` + `NumberExpr` reads
  real per-unit HP samples directly (`current_hp`/`max_hp` are now typed
  `EventStore` columns) rather than reconstructing HP from a running
  damage total, and generalizes past a fixed percentage to arbitrary
  unit-vs-unit / unit-vs-constant comparisons.

### Recyclable mechanic templates

Mechanics repeat across tiers: "find your buddy", "don't stand in the
fire", "take the void zone away from the group", "interrupt the spell",
"kill the adds", "safety dance", "don't let this guy touch that guy".
Each becomes a **parameterized template** — logic written once, an
encounter instantiates it with that fight's spell IDs / thresholds. A
tier's ~30 parsers (roughly every 6 months) then reduce to mostly template
instantiation plus a handful of bespoke ones. The library compounds.

## Mechanics that aren't in the log

The hardest, most valuable case. **Lura's "memory game"**: the boss flashes
a symbol sequence; 5 random players get those symbols as debuffs; a
"sweep" cast must hit the marked players *in the shown order* or a
raid-wide explosion does huge damage. **The shown sequence itself almost
certainly isn't logged.**

The parser infers from observable anchors around it:
- the "assign symbols" cast burst (`SPELL_CAST_SUCCESS` /
  `SPELL_AURA_APPLIED`) — which 5 players, which symbol debuff each,
- the "sweep" cast window,
- whether the raid-wide explosion `SPELL_DAMAGE` fired, and how big.

Outcome: explosion absent/small → `success`; large → `fail`. The order the
raid actually lined up in can sometimes be read from the sweep's hit order
(consecutive `SPELL_DAMAGE` on the marked players); the *intended* order
may stay unknown, and that's fine — pass/fail + who-was-marked is the
useful 90%.

General pattern: **anchor on observable casts / auras / damage; infer the
unobservable middle from the outcome.**

## Implied entities

Environmental hazards the app wants to render — a slime pool, a void zone,
a "don't stand here" blast footprint — that aren't first-class combat-log
units. A boss parser emits them for the 3D spatial replay (`planning.md`
§3, "Additional render layers") and for timeline flags. Three cases, by
how much the log tells us:

1. **Logged on spawn, static.** A persistent ground effect appears as its
   own spell event when created, carrying `positionX`/`positionY` from the
   advanced block (`combat-log-format.md` §5), and doesn't move. Position,
   lifetime, and owner are all known; the only missing piece is
   footprint — a **maintained shape/size table keyed on spell id** (circle
   radius, cone, rectangle). Small static data, easy to keep current.
   Output: `ImpliedEntity { spellId, shape, positions: [{ t, x, y }],
   startMs, endMs }` — here just one position.

2. **Only detectable on contact.** A "don't stand in this" blast that
   never logs unless a player is hit by it. All we get is the damage
   event: its `positionX`/`positionY` (the victim's location at that tick)
   and timing. Output is a low-fidelity marker — *someone got clipped
   here, then* — not the true footprint. Multiple hits in a short window
   hint at the real area; a lone hit is just a dot.

3. **Too complex to fully reconstruct.** Aleria's void zone that "draws a
   bow and fires arrows when you leave it" would need bespoke geometry and
   timing logic to recreate spatially. Don't. Fall back to a **per-player
   right/wrong outcome** — did this player leave the zone / eat an arrow —
   emitted as a `MechanicEvent` (`outcome`, `targets`) for the encounter
   timeline. No spatial render, just the judgment, which is most of the
   analytical value anyway.

The parser decides which case a hazard is and emits an `ImpliedEntity`
(replay), a `MechanicEvent` (timeline), or both.

## Formerly blocked on this: the Overview "Progress" tile

The Overview stats row wants a **Progress** tile — boss health remaining
at the end of the encounter (`0%` on a kill, `14%` on a wipe), with the
duration as its inline sub value. Still not built, but its original
blocker is gone:

- ~~**Boss HP isn't parsed.** `currentHP` / `maxHP` ride on every advanced
  damage/heal event (the *target's* values), but the parser only keeps the
  19-field advanced block as raw arena spans.~~ **Resolved** — `current_hp`
  / `max_hp` are now typed `EventStore` columns (added for the `threshold`
  trigger above), filterable by `posUnit` in the `query_events` DSL. A
  Progress tile can query them directly instead of a bespoke scan.
- **"Boss" identification:** for a first cut, the `Creature`-kind unit(s)
  with the highest observed `maxHP` in the window. Long term, a curated
  name list (updated once or twice a tier). Still open.
- **Council fights:** average across the bosses as `Σ current / Σ max`,
  not a per-boss number. Still open.
- **Why it was blocked:** "lowest HP reached" is wrong — bosses heal
  mid-fight (phase transitions, e.g. Venomous Abyss boss 5 goes ~0% → 100%
  on a phase change), so a min taken across the whole fight reports a
  number the pull never meaningfully sat at. "HP at the encounter end" is
  closer but still confounded by a heal right before the wipe. Doing it
  properly means knowing the phase boundaries — which now exist for any
  encounter with an authored config (though most don't have one yet), so
  this tile is buildable but not yet built.

## Distribution & maintenance

Boss parsers are code, custom per encounter, refreshed each tier — the same
profile as the third-party widget code in `widget-distribution.md`:
- packaged like widget packs (manifest + modules); a **boss-parser pack**
  ships spell-ID tables + template instantiations + bespoke logic for one
  raid tier,
- same **no-sandbox, curation-not-isolation** trust model — a parser is
  reviewed code, not sandboxed,
- the template library keeps per-tier cost low; many parsers are ~config.

## Open questions

- ~~**Rust vs JS execution.**~~ **Settled for phases**, and not the way
  either original option imagined: no per-encounter compiled code at
  all, Rust or JS — a declarative JSON config, evaluated in TS against
  the `query_events` toolkit Rust already exposes for every other view.
  Still open for mechanics (§2), where the `custom` kind's bespoke logic
  is real per-encounter TS code and the widget-distribution trust
  questions apply.
- ~~How `EncounterAnalysis` reaches the frontend — new command vs. folded
  into the encounter payload.~~ Doesn't apply to phases (no backend pass
  produces one — see "Where it plugs in"). Still open for mechanics, if
  they end up needing a comparable payload.
- ~~The timeline/gantt/kanban view is unbuilt~~ **Partly built**: Timeline
  and Kanban both render a phase table now (`src/views/timeline.ts`,
  `src/views/kanban.ts`) — a plain table, not the drag/drop board or
  gantt chart `ui-widgets.md`'s reui.io reference implies. That richer
  view is still unbuilt, and has nothing to show yet regardless (no
  mechanic events exist to put on it).
- Phase/mechanic output feeding the filter chain needs the filter chain
  built. Still true — `ViewContext.filterChain` doesn't exist yet
  (`docs/status.md`'s open threads).
- **New**: how a config's `id`/human-slug and the game's real encounter
  names should be kept in sync, and whether the Encounter Editor should
  offer any lookup/autocomplete against a bundled encounter-id table
  instead of the author typing both `encounterId` and `name` by hand.
- **New**: `find_encounter_config` only reads `<app data dir>/encounters/`
  — the `plugins/*/encounters/` half of the file-location design
  (`encounter-config.md`) isn't wired up.
- First targets from the sample data (`WoWCombatLog-090126_*`): Nek'zali
  the Soulcoiler (phases done; Essence Rend and the rest of §2 not
  started), Lura (memory game, not started).
