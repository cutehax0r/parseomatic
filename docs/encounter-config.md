# Encounter config — JSON schema

**Reflects the v2 schema, implemented.** `encounter-config-v2.md` and
`encounter-config-v2-nodes.md` are the design rationale behind the
`query`/Source/Filter/Collection shapes below (kept as historical
context, not restated here) — this doc describes what actually shipped.
Mechanics, Views/Reports, Templates, and the Latch primitive from those
docs are **not built yet**: `PhaseDef.mechanics`/`EncounterConfig.
globalMechanics` exist as real, graph-wired slots (so the Mechanic node
type can plug in later without reshaping Phase/Info again) but always
compile to `[]` today.

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
  / `castSuccess` / `auraApplied` / `auraRemoved` resolve by querying the
  real log for the first matching event (same `query_events` primitive
  every other view uses) — the only kinds so far backed by an actual
  event scan, alongside `threshold`. Everything else (`unitSpawn`,
  `stackCount`, ...) has no detector yet and shows as unresolved (—), not
  a wrong number.

Plugin-shipped configs (`plugins/*/encounters/`, mentioned above) aren't
read by `find_encounter_config` yet — only `<app data dir>/encounters/`.

## Shape

```jsonc
{
  "schemaVersion": 2,
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
      "start": { "type": "query", "source": { "kind": "casts", "mode": "start" },
        "filters": [{ "type": "spell", "ids": { "type": "literal", "ids": [111111] } }] },
      "mechanics": ["rotation"] },

    { "id": "phase2", "label": "Phase 2", "kind": "phase",
      "start": { "type": "query", "source": { "kind": "casts", "mode": "success" },
        "filters": [{ "type": "spell", "ids": { "type": "literal", "ids": [111111] } }] },
      "mechanics": ["soakBalls2", "adds2", "tankSoak2", "groupSoak2", "redBalls2"] },

    { "id": "enrage", "label": "Enrage", "kind": "enrage",
      "start": { "type": "timer", "since": "phase1.start", "seconds": 600 } }
  ],

  "mechanics": {
    "soakBalls": { "label": "Soak Balls", "kind": "orbSoak",
      "trigger": { "type": "query", "source": { "kind": "casts", "mode": "start" },
        "filters": [{ "type": "spell", "ids": { "type": "literal", "ids": [222222] } }] },
      "params": { "debuffId": 222333, "orbCount": 6, "explodeAfterSec": 20, "explosionSpellId": 222444 } },
    "soakBalls2": { "label": "Soak Balls", "kind": "orbSoak",
      "trigger": { "type": "query", "source": { "kind": "casts", "mode": "start" },
        "filters": [{ "type": "spell", "ids": { "type": "literal", "ids": [222222] } }] },
      "params": { "debuffId": 222333, "orbCount": 6, "explodeAfterSec": 20, "explosionSpellId": 222444 } },

    "adds": { "label": "Adds", "kind": "addSpawn",
      "trigger": { "type": "query", "source": { "kind": "deaths", "mode": "died" },
        "filters": [{ "type": "actor", "ids": { "type": "literal", "ids": [333111, 333112] } }] },
      "params": { "expectedCount": 4 } },
    "adds2": { "label": "Adds", "kind": "addSpawn",
      "trigger": { "type": "query", "source": { "kind": "deaths", "mode": "died" },
        "filters": [{ "type": "actor", "ids": { "type": "literal", "ids": [333111, 333112] } }] },
      "params": { "expectedCount": 4 } },

    "groupSoak": { "label": "Group Soak", "kind": "groupSoak",
      "trigger": { "type": "query", "source": { "kind": "casts", "mode": "start" },
        "filters": [{ "type": "spell", "ids": { "type": "literal", "ids": [444555] } }] },
      "params": { "hits": 3, "hitIntervalSec": 2 } },
    "groupSoak2": { "label": "Group Soak", "kind": "groupSoak",
      "trigger": { "type": "query", "source": { "kind": "casts", "mode": "start" },
        "filters": [{ "type": "spell", "ids": { "type": "literal", "ids": [444555] } }] },
      "params": { "hits": 3, "hitIntervalSec": 2 } }
  }
}
```

`MechanicDef.trigger` above uses the same `Trigger` shape as a phase's
`start`/`end` (a still-unevaluated placeholder -- see this doc's opening
note: Mechanics aren't built yet, only phases resolve today), just to keep
the example internally consistent with the schema actually in
`src/encounters/schema.ts`, not because a mechanic's condition is
evaluated the same way a phase boundary is (v2's real Mechanic node,
next branch, resolves to a *list* of instances, not one moment).

`start` is required; `end` is optional and normally omitted — a phase ends
where the next one starts. It exists for the one case with no following
phase to imply it: the last phase of an encounter, whose `end` is usually
`{ "type": "combatEnd" }`. A single-phase encounter is the minimal case
this covers — one phase, `start: combatStart`, `end: combatEnd`.

## Persisted editor state (`ui`)

**Reverses v1's deliberate choice not to persist layout** (v2 doc §13):
`EncounterConfig.ui` records node positions, collapsed state, per-node
color, and group boxes, so opening a saved file restores the graph as it
was left rather than re-arranging it from scratch every time. Kept in a
separate top-level section rather than interleaved into the semantic
tree above, so the evaluator (and anyone just reading the config) never
has to skip over presentation data:

```jsonc
"ui": {
  "layout": {
    "info": { "x": 40, "y": 40 },
    "info.phases": { "x": 260, "y": 40 },
    "phases[0]": { "x": 480, "y": 40 },
    "phases[0].start": { "x": 480, "y": 200 },
    "phases[0].start.filters[0]": { "x": 300, "y": 200, "collapsed": true },
    "triggers.moment3": { "x": 100, "y": 400, "color": "#223", "bgcolor": "#335" }
  },
  "groups": [
    { "title": "Intermission wiring", "color": "#8A8", "bounds": [40, 300, 400, 200] }
  ]
}
```

- **No stable node ids** (the fuller version of §13 this doc's earlier
  draft anticipated). Instead, `layout` is keyed by a **structural path**
  describing where a node sits in the compiled tree --
  `src/encounters/compile.ts`'s `recordLayout`/`applyLayout` build and
  consume these paths in lock-step with the semantic compilation, e.g.
  `phases[1].start.filters[0]` (the first Filter in Phase 2's start
  chain) or `phases[1].start.window.end` (the Trigger feeding that
  chain's Source's window's `end` input). A node whose output feeds more
  than one consumer (hoisted into `triggers`/`collections`, "Shared
  triggers" above) is keyed by that canonical `triggers.<id>`/
  `collections.<id>` path instead of any one consumer's path, since it
  has one true position, not one per consumer.
- **Not a permanent identity.** Restructuring a chain (inserting or
  removing a Filter mid-way, say) shifts every path after it, so a
  repositioned node just falls back to auto-layout on the next Open
  rather than picking up the wrong saved position -- a known, honest
  limitation of path-based keys, not a crash. Good enough for the common
  case (save, reopen later without restructuring); a future pass could
  move to real per-node ids if this proves too fragile in practice.
- **`configToGraph` only auto-arranges (`LGraph.arrange()`) when `ui` is
  entirely absent** -- an older or hand-authored file with no layout
  info. Once a file has been saved once with `ui.layout` populated,
  every subsequent Open restores from it instead.
- **Groups have no path** -- they're pure visual annotations with no
  connection to any node, so `ui.groups` is a plain list, order not
  meaningful.

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
| `query` | `source` (`SourceSpec`), `filters` (`FilterSpec[]`), optional `window: { start, end }` (both `Trigger`) | the first matching event from a Source→Filter chain (see below) -- replaces v1's `castStart`/`castSuccess`/`auraApplied`/`auraRemoved`/`unitSpawn`/`unitDied`/`stackCount` with one generic shape |
| `threshold` | `value`, `op` (`above`/`below`/`equal`), `threshold` (both `NumberExpr` -- see below) | `value op threshold` first holds, scanning each referenced unit's real HP/death-count/aggregate samples |
| `timer` | `since` (a trigger reference, e.g. `"phase1.start"` or `"soakBalls.end"`), `seconds` | a fixed offset from another named trigger |
| `offset` | `from` (an inline `Trigger`), `op` (`+`/`-`), `seconds` | a Time Math node's result — `from` offset by `seconds` |
| `ref` | `id` | points at `EncounterConfig.triggers[id]` — see "Shared triggers" below |

`since` references are dotted paths: `<phaseId>.start`, `<phaseId>.end`,
or `<mechanicId>.end` (a mechanic kind defines what "end" means for it —
see below).

### `query` — Source, Filter, and Collection shapes

Authored in the graph as a Source node (`nodes/sources.ts`) feeding
zero-or-more Filter nodes (`nodes/filters.ts`) feeding a "First Event"
node, which is what actually plugs into a Phase's `start`/`end`
(`src/encounters/compile.ts`'s `queryTriggerFromEventStreamFirst` walks
this chain backward to compile it, and `nodeForEventStreamChain`
reconstructs it on load). Compiles straight to `src/ui/query.ts`'s
`QuerySpec` DSL (`src-tauri/src/query.rs`), not bespoke per-kind Rust code.

**`SourceSpec`** — a kind-scoped event stream, time-window-scoped
implicitly (the whole encounter, or, if the Source's `window` input is
wired to anything exposing `start`/`end` moment inputs, that range).
Wiring a Phase node's `phase` output in scopes it to that phase's own span
(`window`'s `start`/`end` inline the same triggers feeding the Phase's own
`start`/`end` inputs); wiring a standalone **Window** node (`nodes/window.ts`
— just `start`/`end` moment inputs, no id/label/kind) in scopes it to any
manually-authored range, e.g. "the last 30 seconds of the pull." Both
compile identically — the JSON never records *which phase* a window came
from, only the two inlined `Trigger`s (see the `query` row above):

| `kind` | `mode` | fires on |
|---|---|---|
| `casts` | `start` \| `success` | `SPELL_CAST_START` / `SPELL_CAST_SUCCESS` |
| `auras` | `applied` \| `removed` | `SPELL_AURA_APPLIED` / `SPELL_AURA_REMOVED` |
| `deaths` | `died` \| `destroyed` \| `dissipates` | `UNIT_DIED` / `UNIT_DESTROYED` / `UNIT_DISSIPATES` |
| `interrupts` | — | `SPELL_INTERRUPT` |

**`FilterSpec`** — narrows a Source, chainable (applied in order):

| `type` | fields | narrows to rows where |
|---|---|---|
| `actor` | `ids` (`CollectionExpr`), optional `which` (`"auto"` default \| `"source"` \| `"target"`) | the chosen unit matches -- `"auto"` (or omitted) infers the acting unit (caster/interrupter; the *victim* for a `deaths` Source, since `UNIT_DIED` interns it as the target); `"source"`/`"target"` overrides that explicitly, e.g. filtering a `casts` Source by *target* ("boss casts X on the current tank") rather than by caster |
| `spell` | `ids` (`CollectionExpr`) | the spell id matches |
| `auraState` | `spellIds` (`CollectionExpr`), `has` (bool) | the same unit has/lacks a matching buff/debuff *at that row's own timestamp* -- resolved client-side (`evaluate.ts`'s `resolveAuraStateFilter`), not pushed into `query.rs` |
| `position` | `x`, `y`, `radius` | the row's own position is within `radius` of `(x, y)` (`query.rs`'s `Field::Position`/`Op::WithinRadius`, squared-distance, point+radius only, no polygon) |
| `role` | `roles: ("tank"\|"healer"\|"ranged")[]` | **not yet backed by real data** -- currently a documented no-op (matches everything); needs `COMBATANT_INFO` spec-id data threaded into `EvalDeps`, not just interned units/spells |

**`CollectionExpr`** — a domain-tagged (spell-id-list / actor-id-list,
tag is graph-slot-only, not in the JSON) reusable id list, authored as
Spell/Actor ID list nodes, a Combine node (union/subtract), a Match-by-Name
node (glob/regex against the log's own interned tables, resolved once, not
per event row), or a `ref` into `EncounterConfig.collections` (config-local
sharing, same hoist-if-shared pattern as `EncounterConfig.triggers`).

### Repeated conditions: `after` and phase chaining

`query` and `threshold` both take an optional `after: Trigger` — resolve
`after` first, then only look for a match strictly later than it, rather
than scanning from the encounter's own start (or the phase window's own
start, if the Source has a `window`). Without it, the *same* condition
reused for a repeating mechanic (a council fight's second intermission
triggered by the same cast as the first, a boss buff that hits 100 power
twice) would resolve to the fight's very first occurrence every time it's
evaluated, regardless of which phase is asking — `after` is what lets "the
second time this happens" mean something different from "the first."

Phase nodes make this easy to wire without extra bookkeeping: a Phase
node's `start`/`end` **outputs** re-expose whatever's wired into that
same node's `start`/`end` **inputs** (`phase.ts`) — pure pass-throughs,
not new values. So "Phase 1 ends" can feed both Phase 1 itself and,
directly, "Phase 2 starts" or a Threshold/Source node's `after` input
elsewhere, without duplicating the trigger definition or routing it
through `EncounterConfig.triggers`/`ref` at all. Chained this way, a
repeating fight structure (phase — intermission — phase, twice or more)
becomes: wire each phase's `end` into the next one's `start`, and for any
condition that repeats verbatim (the same cast starting each
intermission, the same buff ending each of them), wire the previous
occurrence's own resolved moment into that condition's `after` input so
each repetition finds the next real occurrence instead of the first.

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
| `unitPowerCurrent` / `unitPowerMax` | `npcId`, `powerType` (`Enum.PowerType` -- see below) | that unit's current/max power *of that type*, as of the instant being evaluated. Less trustworthy than health -- see below |
| `unitDeathCount` | optional `npcIds` (omitted/empty = any unit) | a running count of `UNIT_DIED` events matching one of `npcIds`, as of the instant being evaluated |
| `numberMath` | `a`, `op` (`+`/`-`/`*`/`/`), `b` (both `NumberExpr`) | e.g. `unitHealthCurrent / unitHealthMax` for a 0-1 health fraction |
| `aggregate` | `op` (`min`/`max`/`avg`/`count`/`stddev`/`first`/`last`), `of` (a `NumberListExpr`: `perActorHealth`/`perActorPower` over an actor `CollectionExpr`) | one generic reduction over a collection's per-member current health/power, evaluated at the instant being evaluated (a member with no sample yet is skipped, not treated as 0) -- the "keep 2 of 3 turtles apart" / any-of-N style checks all fold into this plus a comparison, rather than a node per operation |

E.g. "boss enrages at 20% health": `{ "type": "threshold", "op": "below", "value": { "type": "numberMath", "a": { "type": "unitHealthCurrent", "npcId": 12345 }, "op": "/", "b": { "type": "unitHealthMax", "npcId": 12345 } }, "threshold": { "type": "numberValue", "value": 0.20 } }`.
Since both sides of a `threshold` are full `NumberExpr` trees, "unit A's
health drops 10% under unit B's" needs no separate mechanism -- `value` is
A's health fraction, `threshold` is `B's health fraction - 0.10`.

`equal` is what a counting condition wants: "phase 2 starts once 4 adds
have died" is `{ "type": "threshold", "op": "equal", "value": { "type":
"unitDeathCount", "npcIds": [333111] }, "threshold": { "type":
"numberValue", "value": 4 } }`; leaving `npcIds` off counts *any* unit's
death, for "this many players have died" regardless of which ones. There's
no equivalent spawn counter -- WoW's combat log has no reliable universal
"this unit just appeared" event to detect it from (a "Lifetime/lifecycle"
concept anchored on first observed activity is a future direction, not
built -- see `encounter-config-v2.md` §6/§14).

`powerType` (`unitPowerCurrent`/`unitPowerMax`) is `Enum.PowerType`
(https://wowwiki-archive.fandom.com/wiki/API_COMBAT_LOG_EVENT's "Power
Type" table -- `src/encounters/power-type.ts`'s `POWER_TYPES`): `-2`
health, `0` mana, `1` rage, `2` focus, `3` energy, `4` combo points, `5`
runes, `6` runic power, `7` soul shards, `8` lunar power, `9` holy power,
`10` alternate power, `11` maelstrom, `12` chi, `13` insanity, `16` arcane
charges, `17` fury, `18` pain, `19` essence. Required, not optional --
unlike health, a unit can have more than one power resource (a mage's
mana *and* arcane charges), each reported only on whichever log lines are
about it, so there's no single "the" power to read without picking one.
**Less trustworthy than health**: the combat log's power-info region is
the one part of the 19-field advanced block
(`docs/combat-log-format.md` §5) not fully pinned down -- 2 unidentified
fields were inserted somewhere in the old 4-field power region, and
`currentPower`/`maxPower`'s exact position is the doc's best current
guess, not confirmed the way health's position is. Verify against a real
log before relying on a power threshold in a shipped encounter config.

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

`EncounterConfig.collections` is the exact same pattern, applied to
`CollectionExpr` (a Combine/Match-by-Name node used by more than one
Filter gets hoisted under a generated id like `collection1`, referenced
via `{ "type": "ref", "id": "collection1" }`) — config-local sharing only
(`encounter-config-v2.md` §5 level 1); app-global, Settings-managed
categories are a separate, not-yet-built concept.

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

Each node's registered type string (`nodes/index.ts`'s
`registerEncounterNodeTypes`) is `<category>/<name>`, and LiteGraph derives
the Add Node menu's submenus directly from that prefix (everything before
the last `/` — `LiteGraph.registerNodeType`'s `base_class.category =
type.substring(0, type.lastIndexOf("/"))`) -- so the category below isn't
just documentation, it's literally which submenu a node shows up under:

- **Structure** — Encounter Info, Phase, Phase List, Window
- **Constants** — Duration, Number, Spell IDs, Actor IDs
- **Filter** — Filter by Actor/Spell/Aura State/Position/Role, Match by Name
- **Calculation** — Time Math, Number Math, Threshold, Combine, Aggregate
- **Events** — Encounter Start/End, Casts, Auras, Deaths, Interrupts, First Event
- **States** — Unit Health/Power (Current/Max), Unit Death Count

**Comment** (`comment.ts`) is registered with no category prefix at all
(bare type string `"comment"`) so it shows up directly in the top-level
Add Node list instead of nested in a submenu — it's common/annotation-only
enough to want one click away, not two.

**Color-coded by category** (`nodes/index.ts`'s `applyCategoryColors`,
run once after every node type registers): each category above maps to
one of LiteGraph's built-in `LGraphCanvas.node_colors` presets (Structure
brown, Constants green, Filter purple, Calculation blue, Events red,
States cyan, Comment yellow) and is applied to that node class's
`prototype.color`/`bgcolor` — a glance at a node's color on the canvas
places it in a category without reading its title. Set on the prototype
(the default for every new node of that type), so an author can still
recolor one specific node instance from the canvas's own right-click
"Colors" menu without affecting the type's default.

The encounter editor's node graph (LiteGraph, `src/views/encounter-editor.ts`)
is how this JSON gets authored. `src/encounters/compile.ts` compiles the
graph reachable from Encounter Info into this JSON shape (`graphToConfig`,
used by Save) and rebuilds a graph from a loaded file (`configToGraph`,
used by Open) — narrow on purpose: only the node types below round-trip,
nothing about mechanics yet. The JSON view in the editor is a read-only
preview of what Save would write, not a second way to edit the document.

**Positions, collapse, color, and groups persist** across save/reopen via
the `ui` section above -- `configToGraph` only falls back to LiteGraph's
`LGraph.arrange()` (a built-in topological/column layout keyed off link
order) when `ui` is missing entirely, e.g. a file that's never been saved
with layout info. The editor's **Tidy** button still re-runs `arrange()`
on demand at any time, for when you want a fresh layout rather than the
saved one.

**Value contracts** for what a connection resolves to once evaluated
against a real log live in `src/encounters/runtime.ts`. The evaluator
(`src/encounters/evaluate.ts`) walks the compiled JSON's
`combatStart`/`combatEnd`/`offset`/`ref` triggers with pure arithmetic,
`query` by compiling its Source/Filters to a real `query.rs` `QuerySpec`
and fetching the first match, and `threshold` by scanning each referenced
unit's real HP/power/aggregate samples (see "Matching a log encounter"
above and the "NumberExpr vocabulary" table) — every graph node type below
compiles down to one of those, so anything buildable in the editor already
evaluates:

| slot type | resolves to |
|---|---|
| `moment` | `ResolvedMoment` — a single instant, ms since `ENCOUNTER_START` |
| `interval` | `ResolvedInterval` — a length of time, in ms |
| `number` | `ResolvedNumber` — a plain float that may change over the encounter (e.g. a unit's health) |
| `phase` | `TimeRange` — `{ startMs, endMs }`. Node identity (id/label/kind) stays on the Phase node itself, not in this value |
| `phases` | `PhaseTimeline` — `TimeRange[]`, in slot order. Exactly what a playback scrollbar, timeline, or kanban view needs |
| `event-stream` | not independently resolved — an intermediate Source→Filter chain value, only meaningful once a "First Event" node turns it into a `moment` |
| `spell-id-list` / `actor-id-list` | `ResolvedCollection` (`number[]`) — the domain tag is a graph-slot distinction only, both resolve the same way |
| `mechanic` | nothing yet — the slot type exists (Phase/Encounter Info's growable "mechanics" input lists) so a future Mechanic node type can plug in without reshaping those nodes, but nothing produces it today |

- **`structure/info`** (`info.ts`) — the encounter's identity: encounter id
  (the log's real WoW encounter id, stored as `encounterId` — together
  with difficulty, this *is* the file's name), display name, difficulty,
  map id (stored as `mapId` — matches a `<mapId>.map.json` file), and a
  `phases` input that takes a Phase List's output — this is what attaches
  the phase graph to the encounter. One per graph.
- **`events/encounter-start`** / **`events/encounter-end`** (`trigger.ts`)
  — fixed-value carriers for `{ type: "combatStart" }` /
  `{ type: "combatEnd" }`. A `moment`-typed output that plugs into a Phase
  node's `start`/`end` input, or a Time Math node's inputs.
- **Sources** (`sources.ts`) — **`events/casts`** (Mode: start/success),
  **`events/auras`** (Mode: applied/removed), **`events/deaths`**
  (Mode: died/destroyed/dissipates), **`events/interrupts`** — each an
  `event-stream`-typed output, an optional `after` moment **input** (same
  "Repeated conditions" semantics as v1's cast/aura nodes), and an
  optional `window` input typed `phase`: wiring anything exposing
  `start`/`end` moment inputs into it scopes that Source to that range
  instead of the whole encounter, compiling to `query`'s `window: { start,
  end }` (both inlined `Trigger`s — the JSON never records *which node*
  the window came from). Two things fit that "exposes start/end" shape
  today: a Phase node's `phase` output (scopes to that phase's own span)
  and a standalone **`structure/window`** node (`window.ts`) with nothing
  but its own `start`/`end` inputs and no id/label/kind, for an ad hoc
  range that isn't a named phase ("the last 30 seconds of the pull," "5
  minutes in for 2 minutes"). No window *widget* on the Source itself —
  v2's design doc originally called for automatic scope inheritance via
  real LiteGraph subgraph nesting, dropped after inspecting LiteGraph's
  actual `Subgraph` API (a heavier, differently-shaped feature built
  around packaging a canvas selection into a reusable block, not a
  lightweight container primitive) in favor of this explicit wire.
- **Filters** (`filters.ts`) — **`filter/actor`** /
  **`filter/spell`** (an `actor-id-list`/`spell-id-list` input,
  auto-wrapping a comma-separated-ids fallback widget — the "auto-wrap a
  scalar" convenience carried over from v1). `filter/actor` also has a
  Which widget (`"auto"` default \| `"source"` \| `"target"`) overriding
  which side of the event it checks -- one node with a toggle rather than
  two node types, matching how Casts/Auras/Deaths each collapse a mode
  choice into one node. **`filter/aura-state`**
  (a `spell-id-list` input + Has/Lacks toggle), **`filter/position`**
  (X/Y/Radius widgets), **`filter/role`** (tank/healer/ranged
  checkboxes — currently a documented no-op, see the Trigger vocabulary's
  `FilterSpec` table). Each: one `event-stream` input, one `event-stream`
  output — chainable, Source → Filter → Filter → ... A council fight's
  "any of these bosses casts any of these spells" phase-change condition
  is now a Casts Source → one Filter by Actor (multiple ids) → one Filter
  by Spell (multiple ids), rather than baked into one fixed node's two id
  lists.
- **`events/first-event`** (`sources.ts`) — the terminal node that
  resolves a Source→Filter chain to a `moment`: the chain's first match
  in its window. What actually plugs into a Phase's `start`/`end`, or a
  Time Math/Threshold node's `after` input. A future Mechanics branch adds
  a sibling "every match" terminal node without changing Source/Filter at
  all.
- **Collections** (`collections.ts`) — **`constants/spell-ids`** /
  **`constants/actor-ids`** (a literal comma-separated id list, as a
  real connectable output so it can be shared or combined),
  **`calculation/combine`** (Domain toggle spell/actor, Op
  union/subtract — "contains"/membership-test isn't here, it produces a
  boolean, not a list, and has no graph node yet), **`filter/name-match`**
  (Domain, Pattern, glob/regex Syntax — resolved once against the log's
  interned unit/spell tables, not per event row), **`calculation/aggregate`**
  (an `actor-id-list` input, Op min/max/avg/count/stddev/first/last, Reads
  health/power, Which current/max — feeds a `number`-typed output, for the
  `NumberExpr` `aggregate` case above).
- **`constants/duration`** (`duration.ts`) — a fixed length of time
  authored as Minutes/Seconds widgets (e.g. "5 minutes" for an enrage
  timer). An `interval`-typed output that plugs into a Time Math node.
- **`calculation/time-math`** (`time-math.ts`) — combines two
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
- **`structure/phase`** (`phase.ts`) — one phase occurrence: `id`, `label`,
  `kind` widgets, `start`/`end` moment inputs, a `phase`-typed output, and
  **`start`/`end` moment outputs that re-expose those same two inputs**
  (pure pass-throughs, not new values) — see "Repeated conditions" above
  for why: it's what lets "Phase 1 ends" feed both Phase 1 itself and,
  directly, "Phase 2 starts" or another trigger's `after` input, with no
  `EncounterConfig.triggers`/`ref` indirection needed for a simple
  chained fight structure. Matches "every phase gets its own mechanic
  entries" above — repeated phases are separate nodes, not one reused.
  Also has a growable `mechanics` input list (same variadic pattern as
  Phase List's `phase` inputs, slot type `mechanic`) — always compiles to
  `[]` today, no Mechanic node type exists yet to populate it (see the
  `mechanic` slot-type row in the value-contracts table above).
- **`structure/phase-list`** (`phase-list.ts`) — the ordered collection a
  phase graph is built into: each numbered `phase`-typed input holds one
  Phase node, slot order is phase order. Always keeps one trailing empty
  slot open for the next connection. Its `phases` output plugs into
  Encounter Info's `phases` input.
- **`structure/window`** (`window.ts`) — a plain, manually-authored time
  range: `start`/`end` moment inputs, one `phase`-typed output (same
  contract as a Phase node's own `phase` output -- a `TimeRange` once
  evaluated). No id/label/kind/mechanics -- exists purely so a Source's
  `window` input can be scoped to an ad hoc range without declaring a
  named phase for it.
- **`states/unit-health-current`** / **`states/unit-health-max`**
  (`number.ts`) — that unit's current/max HP as of the instant being
  evaluated, off an NPC ID widget. Two separate single-output nodes
  rather than one node with two outputs, matching Encounter Start/End's
  precedent. A `number`-typed output.
- **`states/unit-power-current`** / **`states/unit-power-max`**
  (`number.ts`) — like Unit Health, but with an added Power Type widget
  (a labeled dropdown over `Enum.PowerType`, since a unit can have more
  than one resource) — an NPC ID widget alone isn't enough to say which
  power. A `number`-typed output. See `NumberExpr`'s `unitPowerCurrent`/
  `unitPowerMax` doc comment (schema.ts) for the "less trustworthy than
  health" caveat.
- **`constants/number`** (`number.ts`) — a fixed float authored as
  a single Value widget, e.g. the "0.20" in "health drops below 20%". A
  `number`-typed output.
- **`calculation/number-math`** (`number.ts`) — combines two `number`
  inputs with a `+`/`-`/`*`/`/` Op widget, e.g. Unit Health (Current) ÷
  Unit Health (Max) for a 0-1 health fraction. A `number`-typed output.
- **`states/unit-death-count`** (`number.ts`) — a running count of
  `UNIT_DIED` events off a comma-separated NPC IDs widget (blank = any
  unit), for counting conditions ("4 adds have died", "2 players have
  died"). A `number`-typed output.
- **`calculation/threshold`** (`number.ts`) — the bridge back from `number`
  to `moment`: two `number` inputs (`value`, `threshold`), an optional
  `after` moment input (same as the cast/aura nodes -- "Repeated
  conditions" above), and an above/below/equal Op widget, firing at the
  first instant `value` crosses (or, for `equal`, first matches)
  `threshold` (`src/encounters/evaluate.ts` scans the referenced unit(s)'
  real HP/death-count samples for it). A trigger node like Cast
  Start/Success — its `moment`-typed output plugs into a Phase's
  `start`/`end` or a Time Math node same as any other trigger.
- **`comment`** (`comment.ts`) — a pure annotation: no inputs,
  no outputs, one free-text widget, no effect on compilation or
  evaluation. Collected into `EncounterConfig.comments` (every Comment
  node in the graph, regardless of position — comments aren't reached via
  a connection like everything else here) so notes survive save/load. A
  double-click on any node's title bar collapses/expands it
  (`nodes/index.ts`'s `enableTitleDoubleClickCollapse` -- LiteGraph
  already fires this gesture, it just ships no default handler for any
  node to opt into).

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
- `FilterSpec`'s `role` case has no real data behind it yet -- currently a
  documented no-op (matches everything). Needs `COMBATANT_INFO` spec-id
  data (`src/types.ts`'s `CombatantSnapshot`) threaded into `EvalDeps`,
  which today only carries interned spells/units.
- Mechanics, Views/Reports, Templates, and the Latch primitive
  (`encounter-config-v2.md` §8/§10/§11/§12) are designed but not built --
  `PhaseDef.mechanics`/`EncounterConfig.globalMechanics` and Phase/
  Encounter Info's growable `mechanic`-typed input lists exist as scaffold
  for the first of these, always compiling to `[]` for now.
- App-global (Settings-managed) Sources (`encounter-config-v2.md` §5 level
  2) and Lifetime/lifecycle + Spawn detection (§6) are noted future
  directions, not designed.
