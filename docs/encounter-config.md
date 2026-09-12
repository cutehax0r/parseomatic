# Encounter config — JSON schema

Concrete schema for the boss-parser idea in `boss-parsers.md`, specifically
its "recyclable mechanic templates" section. An encounter config is a JSON
file, one per `(encounterId, difficulty)` pair, loaded from the plugin
appdata folder (same trust model as `widget-distribution.md`: reviewed
JSON/code, no sandboxing). It declares phases and mechanics; the actual
detection/analysis logic lives in a small standard library of **mechanic
kinds** (see below), so most encounters are pure config — only genuinely
novel mechanics need a custom TS module.

TypeScript types mirroring this schema: `src/encounters/schema.ts`.

## File location

`<app data dir>/encounters/<zone>/<encounter-slug>.<difficulty>.json`,
where `<zone>` is the numeric map id — the same id a `<mapId>.map.json`
file is named after (`encounter-maps.md`), not a directory slug. E.g.
`encounters/2606/twin-fangs.mythic.json` alongside `maps/**/2606.map.json`.
Also scanned under `plugins/*/encounters/**` the same way `plugins/*/maps/**`
works (`plugins.md`) — a plugin can ship encounter configs alongside its
maps and widget code.

## File identity

One file per difficulty — `twin-fangs.heroic.json`, `twin-fangs.mythic.json`
— rather than one file with a `difficultyOverrides` block. Simpler to
reason about and edit; the cost (duplicating phase structure across
difficulties) is accepted since difficulties often add or remove whole
mechanics, not just retune numbers.

## Shape

```jsonc
{
  "schemaVersion": 1,
  "id": "twin-fangs",
  "name": "Twin Fangs",
  "difficulty": "mythic",
  "zone": 2606,

  "phases": [
    { "id": "phase1", "label": "Phase 1", "kind": "phase",
      "start": { "type": "combatStart" },
      "mechanics": ["soakBalls", "adds", "tankSoak", "groupSoak", "redBalls"] },

    { "id": "intermission1", "label": "Intermission 1", "kind": "intermission",
      "start": { "type": "castStart", "spellId": 111111 },
      "mechanics": ["rotation"] },

    { "id": "phase2", "label": "Phase 2", "kind": "phase",
      "start": { "type": "castEnd", "spellId": 111111 },
      "mechanics": ["soakBalls2", "adds2", "tankSoak2", "groupSoak2", "redBalls2"] },

    { "id": "enrage", "label": "Enrage", "kind": "enrage",
      "start": { "type": "timer", "since": "phase1.start", "seconds": 600 } }
  ],

  "mechanics": {
    "soakBalls": { "label": "Soak Balls", "kind": "orbSoak",
      "trigger": { "type": "castStart", "spellId": 222222 },
      "params": { "debuffId": 222333, "orbCount": 6, "explodeAfterSec": 20, "explosionSpellId": 222444 } },
    "soakBalls2": { "label": "Soak Balls", "kind": "orbSoak",
      "trigger": { "type": "castStart", "spellId": 222222 },
      "params": { "debuffId": 222333, "orbCount": 6, "explodeAfterSec": 20, "explosionSpellId": 222444 } },

    "adds": { "label": "Adds", "kind": "addSpawn",
      "trigger": { "type": "unitSpawn", "npcIds": [333111, 333112] },
      "params": { "expectedCount": 4 } },
    "adds2": { "label": "Adds", "kind": "addSpawn",
      "trigger": { "type": "unitSpawn", "npcIds": [333111, 333112] },
      "params": { "expectedCount": 4 } },

    "groupSoak": { "label": "Group Soak", "kind": "groupSoak",
      "trigger": { "type": "castStart", "spellId": 444555 },
      "params": { "hits": 3, "hitIntervalSec": 2 } },
    "groupSoak2": { "label": "Group Soak", "kind": "groupSoak",
      "trigger": { "type": "castStart", "spellId": 444555 },
      "params": { "hits": 3, "hitIntervalSec": 2 } }
  }
}
```

`start` is required; `end` is optional and normally omitted — a phase ends
where the next one starts. It exists for the one case with no following
phase to imply it: the last phase of an encounter, whose `end` is usually
`{ "type": "combatEnd" }`. A single-phase encounter is the minimal case
this covers — one phase, `start: combatStart`, `end: combatEnd`.

## Every phase gets its own mechanic entries

`phases[].mechanics` lists references into `mechanics`, but each phase
occurrence has its **own distinctly-named entry** (`adds`, `adds2`,
`adds3`, ...) rather than sharing one definition across phases — a bit of
copy-paste, but it keeps each phase's mechanics independently editable
(different add count in Phase 3, say) without the indirection of
figuring out which phase-occurrence a shared definition's instance
belongs to. One `mechanics` entry always produces exactly one runtime
instance.

## Trigger vocabulary

**Draft — names and coverage will change** once checked against real
combat logs and more encounters; treat this table as a starting point to
refine together, not a settled list.

Shared by `phases[].start` and `mechanics[].trigger`:

| type | fields | fires when |
|---|---|---|
| `combatStart` | — | `ENCOUNTER_START` |
| `combatEnd` | — | `ENCOUNTER_END` |
| `castStart` / `castEnd` | `spellId`, optional `sourceNpcId` | a matching `SPELL_CAST_SUCCESS` / cast-channel end |
| `auraApplied` / `auraRemoved` | `spellId` | matching `SPELL_AURA_APPLIED` / `_REMOVED` |
| `stackCount` | `spellId`, `atLeast` | an aura's stack count crosses a threshold |
| `unitSpawn` / `unitDied` | `npcIds` | a unit matching one of the ids appears / dies |
| `healthPct` | `npcId`, `atOrBelow` | running damage total crosses a % of that unit's max HP |
| `timer` | `since` (a trigger reference, e.g. `"phase1.start"` or `"soakBalls.end"`), `seconds` | a fixed offset from another named trigger |
| `offset` | `from` (an inline `Trigger`), `op` (`+`/`-`), `seconds` | a Time Math node's result — `from` offset by `seconds` |
| `ref` | `id` | points at `EncounterConfig.triggers[id]` — see "Shared triggers" below |

`since` references are dotted paths: `<phaseId>.start`, `<phaseId>.end`,
or `<mechanicId>.end` (a mechanic kind defines what "end" means for it —
see below).

### Shared triggers

A Time Math (or trigger) node's output can feed more than one consumer —
e.g. "Encounter Start + 5 minutes" used as both Phase 1's `end` and Phase
2's `start`. Compiling each consumer independently would inline the same
value twice; loading that back would then reconstruct two duplicate node
trees instead of the one shared node the graph actually had. `graphToConfig`
avoids this: any node whose output has more than one downstream connection
gets hoisted into `EncounterConfig.triggers` under a generated id
(`moment1`, `moment2`, ...) and referenced everywhere it's used via
`{ "type": "ref", "id": "moment1" }`; a node used only once stays inlined.
`configToGraph` reverses this — a `ref` is only built once per id, on first
use, and reused for every other reference to the same id, reconstructing
the original shared wiring rather than duplicating it. `triggers` is
omitted from the JSON entirely when nothing needed it.

## Mechanic kinds — the standard library

**Draft — same caveat as the trigger vocabulary above.** These eight kinds
come from one encounter's worth of examples; expect renames, splits, and
new kinds once we look at more fights.


`kind` selects a parameterized template with a fixed three-part
implementation (detector / analyzer / renderer, `ui-widgets.md`'s Widget
system for the last part):

- **`groupSoak`** — an ability that hits players in N waves. `params:
  { hits, hitIntervalSec }`. Analyzer output: who was hit in wave 1/2/3,
  who was never hit.
- **`addSpawn`** — adds appear and must be killed. `params: { npcIds,
  expectedCount? }`. Tracks time-alive, produces a health/DPS-by-player
  series; "end" = all instances of `npcIds` in this window dead (or a
  timeout).
- **`orbSoak`** — ground puddles that must be soaked before a deadline or
  a raid-wide explosion fires; soaking grants debuff stacks. `params: {
  debuffId, orbCount, explodeAfterSec, explosionSpellId }`. Analyzer
  output: who soaked, who didn't, final stack count per player.
- **`tankBuster`** — single large hit on the current tank. `params: {
  spellId }`.
- **`mustKick`** — a cast that must be interrupted. `params: { spellId }`.
  Reuses the existing Interrupts view's detection primitives.
- **`runAway`** — players must leave a zone/stop stacking before a
  deadline. `params: { debuffId, deadlineSec }`.
- **`stackingDebuff`** — a generic stacking-debuff tracker without the
  orb-soak explosion semantics, for mechanics that are just "don't cap
  your stacks." `params: { debuffId, capStacks }`.
- **`custom`** — escape hatch. `params: { module }` points at a TS file
  (loaded from appdata like a widget pack) that exports a detector +
  analyzer + renderer following the same interface as a built-in kind.
  Built via a small helper library (`defineMechanic()`,
  `matchSpellCast()`, `matchAura()`, `timerFrom()`, ...) so hand-rolled
  mechanics aren't starting from nothing. For mechanics that aren't
  directly observable in the log, follow `boss-parsers.md`'s "anchor on
  observable casts/auras/damage, infer the middle" pattern.

Every kind's implementation decides its own "end" condition (used for
`timer` triggers referencing `<mechanicId>.end` and for the kanban card's
displayed duration) — e.g. `addSpawn` ends when its adds are all dead,
`groupSoak` ends `hitIntervalSec` after the last wave.

## Graph node types

The encounter editor's node graph (LiteGraph, `src/views/encounter-editor.ts`)
is how this JSON gets authored. `src/encounters/compile.ts` compiles the
graph reachable from Encounter Info into this JSON shape (`graphToConfig`,
used by Save) and rebuilds a graph from a loaded file (`configToGraph`,
used by Open) — narrow on purpose: only the node types below round-trip,
nothing about mechanics yet. The JSON view in the editor is a read-only
preview of what Save would write, not a second way to edit the document.

`configToGraph` finishes by calling LiteGraph's `LGraph.arrange()` (a
built-in topological/column layout keyed off link order), so opening a
file lays freshly-built nodes out left-to-right by dependency rather than
stacking them all at the same position. Positions aren't persisted in the
JSON — a plain declarative document, not a graph-editor save file — so
opening the same file always re-lays-out from scratch. The editor's
**Tidy** button re-runs the same layout on demand after you've been
rewiring things by hand.

**Value contracts** for what a connection resolves to once evaluated
against a real log live in `src/encounters/runtime.ts` (no evaluator
exists yet — this only pins down the types it will produce):

| slot type | resolves to |
|---|---|
| `moment` | `ResolvedMoment` — a single instant, ms since `ENCOUNTER_START` |
| `interval` | `ResolvedInterval` — a length of time, in ms |
| `phase` | `TimeRange` — `{ startMs, endMs }`. Node identity (id/label/kind) stays on the Phase node itself, not in this value |
| `phases` | `PhaseTimeline` — `TimeRange[]`, in slot order. Exactly what a playback scrollbar, timeline, or kanban view needs |

- **`encounter/info`** (`info.ts`) — the encounter's identity: zone (a
  numeric map id — matches a `<mapId>.map.json` file, also stored in the
  JSON as `zone`), id, name, difficulty, and a `phases` input that takes a
  Phase List's output — this is what attaches the phase graph to the
  encounter. One per graph.
- **`encounter/trigger-start`** / **`encounter/trigger-end`** (`trigger.ts`)
  — fixed-value carriers for `{ type: "combatStart" }` /
  `{ type: "combatEnd" }`. A `moment`-typed output that plugs into a Phase
  node's `start`/`end` input, or a Time Math node's inputs. The rest of
  the trigger vocabulary (`castStart`, `auraApplied`, `timer`, ...) gets
  its own node once a phase actually needs one.
- **`encounter/duration`** (`duration.ts`) — a fixed length of time
  authored as Minutes/Seconds widgets (e.g. "5 minutes" for an enrage
  timer). An `interval`-typed output that plugs into a Time Math node.
- **`encounter/time-math`** (`time-math.ts`) — combines two
  `moment,interval`-typed inputs (LiteGraph's comma-separated
  accepted-types syntax — either kind connects) with a `+`/`-` Op widget,
  e.g. "Encounter Start" (moment) + "Duration: 5 minutes" (interval) = a
  moment 5 minutes into the fight, usable as a Phase node's `start`/`end`.
  Which kind the single `moment,interval`-typed output actually is
  depends on what's plugged in, not on anything the node declares up
  front: `moment ± interval → moment`, `interval ± interval → interval`,
  `moment − moment → interval` (`moment + moment` is invalid — an
  evaluator should reject it). No static type-checking for this exists,
  only at evaluation time.
- **`encounter/phase`** (`phase.ts`) — one phase occurrence: `id`, `label`,
  `kind` widgets, `start`/`end` moment inputs, a `phase`-typed output.
  Matches "every phase gets its own mechanic entries" above — repeated
  phases are separate nodes, not one reused. No `mechanics` input yet
  (no mechanic node types exist).
- **`encounter/phase-list`** (`phase-list.ts`) — the ordered collection a
  phase graph is built into: each numbered `phase`-typed input holds one
  Phase node, slot order is phase order. Always keeps one trailing empty
  slot open for the next connection. Its `phases` output plugs into
  Encounter Info's `phases` input.

First target, done: a Phase node (`start` → an Encounter Start trigger,
`end` → a Time Math node computing Encounter Start + a 5-minute Duration)
wired into a Phase List, and the Phase List into Encounter Info,
round-trips through `graphToConfig`/`configToGraph` — a single-phase
encounter with a computed enrage boundary, end to end. Next: mechanics.

## Open items

- Difficulty-specific mechanic param overrides still require a full
  duplicate file; revisit if that proves painful in practice (tier with
  4 difficulties, mostly-numeric deltas).
- `EncounterAnalysis` output shape (how instances + analyzer results reach
  the Raid view) isn't designed yet — this doc only covers the config
  input, not the runtime engine or its frontend payload.
- Where the standard mechanic-kind library's code lives (in-repo vs a
  separate package importable from `custom` modules) — undecided.
