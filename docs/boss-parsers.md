# Boss parsers — encounter-mechanic analyzers

Long-term design. Nothing built. Recorded now so the pieces it touches
(`reports.rs`, the `query_events` DSL, the encounter picker's range model,
the planned timeline view) are shaped with it in mind.

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

```
Phase { name, kind: "phase" | "intermission", startMs, endMs, startRow, endRow }
```

Nek'zali: `["Phase 1", "Intermission", "Phase 2"]`. Consumers:
- **Graph markers** — vertical dividers on the line chart.
- **Selectable sub-ranges** — the encounter picker (`ui-widgets.md`) gains
  these as named presets under the encounter; "inspect the intermission"
  is one click, resolving to a `RangeSelection` `[startMs, endMs]` like any
  other range.
- Detection is usually a cast or aura (`ENCOUNTER_START` → Phase 1; a
  boss "shield"/untargetable aura → Intermission; its removal → Phase 2),
  sometimes a boss-HP threshold (needs a running total of damage to the
  boss unit).

### 2. Mechanic events — discrete named occurrences

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

- Runs **after** base encounter pairing in `reports.rs` (or a dedicated
  pass), once per `Encounter` whose `(encounterId, difficultyId)` has a
  registered parser.
- Input: the encounter's `EventStore` slice (`start_row..=end_row`), the
  intern tables, the `Encounter` metadata.
- Output: `EncounterAnalysis { phases, mechanics, stats }`, hung off the
  `Encounter` and serialized to the frontend.
- A **registry** keyed on `encounterId`, falling through to a no-op — same
  shape as the widget registry (`ui-widgets.md`).

## The detection toolkit

Parsers must not each hand-roll event scanning. A small helper library
over the columnar `EventStore`:

- `first_cast(spellId, after?)` / `all_casts(spellId)`
- `aura_holders(spellId, atMs)` — who holds debuff/buff X at a moment
- `occurred(predicate, window)` / `damage_in(window, sources?, targets?)`
- `sequence([spellId…], maxGapMs)` — cast A then B then C within a gap
- `boss_hp_crosses(pct)` — running damage total vs the boss's max HP

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

- **Rust vs JS execution.** Rust is fast but native packs are a bigger
  trust/distribution problem; JS packs match the widget model but are
  slower over a full log. Leaning JS, with the expensive toolkit scans
  implemented in Rust and exposed `query_events`-style.
- How `EncounterAnalysis` reaches the frontend — new command vs. folded
  into the encounter payload.
- The timeline/gantt/kanban view is unbuilt (not in `ui-widgets.md`'s
  starter set).
- Phase/mechanic output feeding the filter chain needs the filter chain
  built.
- First targets from the sample data (`WoWCombatLog-090126_*`): Nek'zali
  the Soulcoiler (phases + Essence Rend), Lura (memory game).
