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

`<app data dir>/encounters/<encounterId>.<difficulty>.json` — flat, no
zone/name subfolder. E.g. `encounters/2549.mythic.json`. The filename
*is* the lookup key (see "Matching a log encounter" below): with a
couple thousand encounters in the game and ~50 more a year, a flat,
directly-addressable path is an O(1) file read instead of an O(n) scan
over every config ever authored. Also read from `plugins/*/encounters/`
the same way `plugins/*/maps/` works (`plugins.md`) — a plugin can ship
encounter configs alongside its maps and widget code; not yet wired up
(see below).

## File identity

One file per difficulty — `2549.heroic.json`, `2549.mythic.json` — rather
than one file with a `difficultyOverrides` block. Simpler to reason about
and edit; the cost (duplicating phase structure across difficulties) is
accepted since difficulties often add or remove whole mechanics, not just
retune numbers.

## Matching a log encounter

Picking an encounter from the log's own encounter list (main.ts) reads
`<app data dir>/encounters/<encounterId>.<difficulty>.json` directly —
`encounterId` is the log's real WoW encounter id (from ENCOUNTER_START),
`difficulty` is mapped from the log's numeric `difficultyId` via
`DIFFICULTY_ID` in `src/encounters/schema.ts`. The filename is the only
thing consulted — the backend (`find_encounter_config`,
`src-tauri/src/encounters.rs`) does one `read_to_string` at the computed
path, not a directory walk, and doesn't re-check the file's own
`encounterId`/`difficulty` fields against it. That's a deliberate
trade-off against the old content-scanned design: a file that's been
renamed or copied without updating its name will silently stop matching
(or start matching the wrong encounter) — the `encounterId` field inside
the file is kept for authoring/provenance only, not as a fallback.

No match (unrecognized encounter, unrecognized difficulty, or nothing
authored yet) just means every consumer below falls back to its default:

- **Replay's map**: `mapId` (below) picks `maps/<mapId>.map.json` for the
  playback backdrop instead of the generic deck (`src/views/replay.ts`).
- **Timeline's phase table** (and **Kanban**, one flat table across every
  pull in the log): phases render as a Name/Start/End(/Event count for
  Timeline) table, with each phase's bounds resolved against the actual
  pull's start/end (`src/encounters/evaluate.ts`). `combatStart` /
  `combatEnd` / `offset` / `ref` resolve with pure arithmetic; `castStart`
  / `castSuccess` resolve by querying the real log for the first matching
  cast (same `query_events` primitive every other view uses) — the only
  kinds so far backed by an actual event scan. Everything else
  (`auraApplied`, `unitSpawn`, ...) has no detector yet and shows as
  unresolved (—), not a wrong number.

Plugin-shipped configs (`plugins/*/encounters/`, mentioned above) aren't
read by `find_encounter_config` yet — only `<app data dir>/encounters/`.

## Shape

```jsonc
{
  "schemaVersion": 1,
  "encounterId": 2549,
  "id": "twin-fangs",
  "name": "Twin Fangs",
  "difficulty": "mythic",
  "mapId": 2606,

  "phases": [
    { "id": "phase1", "label": "Phase 1", "kind": "phase",
      "start": { "type": "combatStart" },
      "mechanics": ["soakBalls", "adds", "tankSoak", "groupSoak", "redBalls"] },

    { "id": "intermission1", "label": "Intermission 1", "kind": "intermission",
      "start": { "type": "castStart", "spellIds": [111111] },
      "mechanics": ["rotation"] },

    { "id": "phase2", "label": "Phase 2", "kind": "phase",
      "start": { "type": "castSuccess", "spellIds": [111111] },
      "mechanics": ["soakBalls2", "adds2", "tankSoak2", "groupSoak2", "redBalls2"] },

    { "id": "enrage", "label": "Enrage", "kind": "enrage",
      "start": { "type": "timer", "since": "phase1.start", "seconds": 600 } }
  ],

  "mechanics": {
    "soakBalls": { "label": "Soak Balls", "kind": "orbSoak",
      "trigger": { "type": "castStart", "spellIds": [222222] },
      "params": { "debuffId": 222333, "orbCount": 6, "explodeAfterSec": 20, "explosionSpellId": 222444 } },
    "soakBalls2": { "label": "Soak Balls", "kind": "orbSoak",
      "trigger": { "type": "castStart", "spellIds": [222222] },
      "params": { "debuffId": 222333, "orbCount": 6, "explodeAfterSec": 20, "explosionSpellId": 222444 } },

    "adds": { "label": "Adds", "kind": "addSpawn",
      "trigger": { "type": "unitSpawn", "npcIds": [333111, 333112] },
      "params": { "expectedCount": 4 } },
    "adds2": { "label": "Adds", "kind": "addSpawn",
      "trigger": { "type": "unitSpawn", "npcIds": [333111, 333112] },
      "params": { "expectedCount": 4 } },

    "groupSoak": { "label": "Group Soak", "kind": "groupSoak",
      "trigger": { "type": "castStart", "spellIds": [444555] },
      "params": { "hits": 3, "hitIntervalSec": 2 } },
    "groupSoak2": { "label": "Group Soak", "kind": "groupSoak",
      "trigger": { "type": "castStart", "spellIds": [444555] },
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
| `castStart` / `castSuccess` | `spellIds` (any one matches), optional `sourceNpcIds` (any one matches; omitted = any caster) | a matching `SPELL_CAST_START` / `SPELL_CAST_SUCCESS` |
| `auraApplied` / `auraRemoved` | `spellId` | matching `SPELL_AURA_APPLIED` / `_REMOVED` |
| `stackCount` | `spellId`, `atLeast` | an aura's stack count crosses a threshold |
| `unitSpawn` / `unitDied` | `npcIds` | a unit matching one of the ids appears / dies |
| `threshold` | `value`, `op` (`above`/`below`/`equal`), `threshold` (both `NumberExpr` -- see below) | `value op threshold` first holds, scanning each referenced unit's real HP/death-count samples |
| `timer` | `since` (a trigger reference, e.g. `"phase1.start"` or `"soakBalls.end"`), `seconds` | a fixed offset from another named trigger |
| `offset` | `from` (an inline `Trigger`), `op` (`+`/`-`), `seconds` | a Time Math node's result — `from` offset by `seconds` |
| `ref` | `id` | points at `EncounterConfig.triggers[id]` — see "Shared triggers" below |

`since` references are dotted paths: `<phaseId>.start`, `<phaseId>.end`,
or `<mechanicId>.end` (a mechanic kind defines what "end" means for it —
see below).

### NumberExpr vocabulary

A plain numeric expression, parallel to `Trigger`'s "moment" one -- only
ever appears nested inside a `threshold` Trigger's `value`/`threshold`,
not standalone. Not shareable via `EncounterConfig.triggers` (that
dictionary is keyed for `Trigger`s only) -- a reused number expression is
just inlined twice.

| type | fields | resolves to |
|---|---|---|
| `numberValue` | `value` | a fixed float, e.g. `0.20` for "20%", or `4` for a count |
| `unitHealthCurrent` / `unitHealthMax` | `npcId` | that unit's current/max HP, as of the instant being evaluated |
| `unitDeathCount` | optional `npcIds` (omitted/empty = any unit) | a running count of `UNIT_DIED` events matching one of `npcIds`, as of the instant being evaluated |
| `numberMath` | `a`, `op` (`+`/`-`/`*`/`/`), `b` (both `NumberExpr`) | e.g. `unitHealthCurrent / unitHealthMax` for a 0-1 health fraction |

E.g. "boss enrages at 20% health": `{ "type": "threshold", "op": "below", "value": { "type": "numberMath", "a": { "type": "unitHealthCurrent", "npcId": 12345 }, "op": "/", "b": { "type": "unitHealthMax", "npcId": 12345 } }, "threshold": { "type": "numberValue", "value": 0.20 } }`.
Since both sides of a `threshold` are full `NumberExpr` trees, "unit A's
health drops 10% under unit B's" needs no separate mechanism -- `value` is
A's health fraction, `threshold` is `B's health fraction - 0.10`.

`equal` is what a counting condition wants: "phase 2 starts once 4 adds
have died" is `{ "type": "threshold", "op": "equal", "value": { "type":
"unitDeathCount", "npcIds": [333111] }, "threshold": { "type":
"numberValue", "value": 4 } }`; leaving `npcIds` off counts *any* unit's
death, for "this many players have died" regardless of which ones. There's
no equivalent spawn counter yet -- `unitSpawn` (above) has no evaluator
case, since WoW's combat log has no reliable universal "this unit just
appeared" event to detect it from.

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
against a real log live in `src/encounters/runtime.ts`. The evaluator
(`src/encounters/evaluate.ts`) walks the compiled JSON's
`combatStart`/`combatEnd`/`offset`/`ref` triggers with pure arithmetic,
`castStart`/`castSuccess` by querying the real log for a matching cast,
and `threshold` by scanning each referenced unit's real HP samples (see
"Matching a log encounter" above and the "NumberExpr vocabulary" table) —
every graph node type below compiles down to one of those, so anything
buildable in the editor already evaluates:

| slot type | resolves to |
|---|---|
| `moment` | `ResolvedMoment` — a single instant, ms since `ENCOUNTER_START` |
| `interval` | `ResolvedInterval` — a length of time, in ms |
| `number` | `ResolvedNumber` — a plain float that may change over the encounter (e.g. a unit's health) |
| `phase` | `TimeRange` — `{ startMs, endMs }`. Node identity (id/label/kind) stays on the Phase node itself, not in this value |
| `phases` | `PhaseTimeline` — `TimeRange[]`, in slot order. Exactly what a playback scrollbar, timeline, or kanban view needs |

- **`encounter/info`** (`info.ts`) — the encounter's identity: encounter id
  (the log's real WoW encounter id, stored as `encounterId` — together
  with difficulty, this *is* the file's name), display name, difficulty,
  map id (stored as `mapId` — matches a `<mapId>.map.json` file), and a
  `phases` input that takes a Phase List's output — this is what attaches
  the phase graph to the encounter. One per graph.
- **`encounter/trigger-start`** / **`encounter/trigger-end`** (`trigger.ts`)
  — fixed-value carriers for `{ type: "combatStart" }` /
  `{ type: "combatEnd" }`. A `moment`-typed output that plugs into a Phase
  node's `start`/`end` input, or a Time Math node's inputs.
- **`encounter/cast-start`** / **`encounter/cast-success`** (`cast-trigger.ts`)
  — fires on the first `SPELL_CAST_START` / `SPELL_CAST_SUCCESS` matching
  a comma-separated Spell IDs widget, optionally narrowed by a
  comma-separated Source NPC IDs widget (blank = any caster). Both take
  more than one id so one node covers a council fight's "any of these
  bosses casts any of these spells" phase-change condition, not just a
  single caster/spell pair. A `moment`-typed output, same slot as the two
  above. The rest of the trigger vocabulary (`auraApplied`, `timer`, ...)
  gets its own node once a phase actually needs one.
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
- **`encounter/unit-health-current`** / **`encounter/unit-health-max`**
  (`number.ts`) — that unit's current/max HP as of the instant being
  evaluated, off an NPC ID widget. Two separate single-output nodes
  rather than one node with two outputs, matching Encounter Start/End's
  precedent. A `number`-typed output.
- **`encounter/number-value`** (`number.ts`) — a fixed float authored as
  a single Value widget, e.g. the "0.20" in "health drops below 20%". A
  `number`-typed output.
- **`encounter/number-math`** (`number.ts`) — combines two `number`
  inputs with a `+`/`-`/`*`/`/` Op widget, e.g. Unit Health (Current) ÷
  Unit Health (Max) for a 0-1 health fraction. A `number`-typed output.
- **`encounter/unit-death-count`** (`number.ts`) — a running count of
  `UNIT_DIED` events off a comma-separated NPC IDs widget (blank = any
  unit), for counting conditions ("4 adds have died", "2 players have
  died"). A `number`-typed output.
- **`encounter/threshold`** (`number.ts`) — the bridge back from `number`
  to `moment`: two `number` inputs (`value`, `threshold`) and an
  above/below/equal Op widget, firing at the first instant `value`
  crosses (or, for `equal`, first matches) `threshold`
  (`src/encounters/evaluate.ts` scans the referenced unit(s)' real
  HP/death-count samples for it). A trigger node like Cast Start/Success
  — its `moment`-typed output plugs into a Phase's `start`/`end` or a
  Time Math node same as any other trigger.
- **`encounter/comment`** (`comment.ts`) — a pure annotation: no inputs,
  no outputs, one free-text widget, no effect on compilation or
  evaluation. Collected into `EncounterConfig.comments` (every Comment
  node in the graph, regardless of position — comments aren't reached via
  a connection like everything else here) so notes survive save/load;
  a native LiteGraph comment/group decoration wouldn't, since graph
  layout itself is never persisted (see `LGraph.arrange()` below).

First target, done: a Phase node (`start` → an Encounter Start trigger,
`end` → a Time Math node computing Encounter Start + a 5-minute Duration)
wired into a Phase List, and the Phase List into Encounter Info,
round-trips through `graphToConfig`/`configToGraph` — a single-phase
encounter with a computed enrage boundary, end to end. Next: mechanics.

## Open items

See also `boss-parsers.md`'s status notes — the doc this schema
implements, reconciled against what actually shipped (phases done, the
mechanics half below still entirely unbuilt).

- Difficulty-specific mechanic param overrides still require a full
  duplicate file; revisit if that proves painful in practice (tier with
  4 difficulties, mostly-numeric deltas).
- `EncounterAnalysis` output shape (how instances + analyzer results reach
  the Kanban view) isn't designed yet — this doc only covers the config
  input, not the runtime engine or its frontend payload.
- Where the standard mechanic-kind library's code lives (in-repo vs a
  separate package importable from `custom` modules) — undecided.
