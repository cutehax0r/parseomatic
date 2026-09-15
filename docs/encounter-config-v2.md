# Encounter config v2 — design notes

Planning notes for a ground-up rework of the encounter-config subsystem
(`docs/encounter-config.md`, `src/encounters/**`). v1 is functional but has
two problems serious enough to justify burning it down rather than patching
it: **evaluation performance** is bad, and **authoring** a graph by hand is
tedious. This doc captures the design conversation that worked out why, and
what v2 should look like instead. Nothing here is implemented yet — this is
the plan to review before any of it gets built.

Status: draft, not yet reviewed against a build. Treat every open question
below as genuinely open, not a placeholder for an answer only the author
knows.

## 1. Why v1 is being replaced

Concrete findings from reading `src/encounters/evaluate.ts` closely (not
speculation):

- **No cross-trigger dedup beyond explicit `ref`.** Two *inline* triggers
  with identical conditions (e.g. "phase 2 starts when boss casts Spell X"
  and "mechanic ends when boss casts Spell X") each fire independent
  `query_events` IPC calls. Authoring naturally produces this duplication,
  because inlining is the path of least resistance in the node editor.
- **`threshold` fans out into one query per referenced observable**, and
  `after` chains resolve serially (`resolveSearchStart` recursively resolves
  the whole upstream trigger before its own query can start).
- **`query_events`'s raw-row mode returns full `RawEventRow`s** (including a
  `details` string built from every raw field) even when a caller like
  `evaluate.ts` only reads one or two typed fields off the result. Flagged
  once already as "not worth trimming at 8MB scale" — worth revisiting now
  that real-world performance is bad.
- **Mechanics were never implemented in v1's evaluator at all** — only
  `phases` resolve today. Whatever is slow right now is *before* the bulk of
  real authored content (mechanics) even exists.

Authoring tedium, structurally:
- `castStart` / `castSuccess` / `auraApplied` / `auraRemoved` are four
  near-identical node types differing only in which event kind they search
  for.
- Every "reuse this condition" requires manually routing through
  `EncounterConfig.triggers` via a `ref` node, rather than reuse being the
  default.
- Every unit/spell reference is a raw id typed in blind — no name lookup
  against the log's own interned tables.
- `after`-chaining requires manually wiring node-to-node with no "sequence"
  concept to shortcut it.

## 2. Existing internal data model (context, not changing)

For reference — this is what v2's evaluator has to sit on top of; it isn't
being rebuilt itself.

- **`EventStore`** (`src-tauri/src/parser/event.rs`) — one column-oriented
  table, one row per combat-log line: timestamp, kind, source/dest unit,
  spell, amount, flags, and (when present) position + HP/power from the
  advanced-combat-log block. `InternTables` holds the dictionaries these
  columns index into (units, spells, zones, strings).
- **A generic ad-hoc query engine** (`src-tauri/src/query.rs`) — `QuerySpec`:
  a time window, `where` filters over a fixed `Field` enum (`Time`, `Kind`,
  `SourceUnit`, `SourceOwner`/`SourceOwnerKind`, `TargetUnit`, `SpellId`,
  `HitType`, `Amount`, `Crit`, `PosUnit`, `PowerType`), `group_by`,
  `aggregate` (`Sum`/`Count`/`Avg`/`Min`/`Max`/`Stddev`), or a `bucket` mode
  for chart series. **v1's whole trigger-evaluation layer already runs on
  this** — it does not use any of the specialized per-view scans below.
- **Specialized, purpose-built scans, one per existing view** — `movement.rs`,
  `timeline.rs`, `interrupts.rs`, `replay.rs`, `damage.rs`, `deaths.rs`,
  `stats.rs`. Each hand-rolls its own "walk the events, build spans" logic
  for its own view's exact shape. No shared "span"/"interval" abstraction
  between them, and none of them are used by the encounter-config system.

## 3. Primitives

- **Numbers stay a single generic type, decided.** No count/ratio/absolute
  distinction at the type level — casting to int/float happens
  automatically where an operation needs it, rather than the schema
  enforcing which "kind" of number a value is. Simpler than the
  alternative considered earlier, and good enough.
- **Durations get a real evaluator, decided.** v1's `"interval"` slot type
  (`DurationNode`, `TimeMathNode`) exists in the node vocabulary but has
  **no evaluator behind it** — the `offset` trigger bakes straight to
  `seconds: number` and the module comments admit no evaluator exists. v2
  builds a real one, specifically so authors can trigger off **elapsed
  time into the encounter** directly ("5 minutes into the pull") rather
  than only via arithmetic wired around `combatStart`/`combatEnd`. This is
  a genuine authoring win, not just closing a gap — "N minutes in" is one
  of the single most common phase/enrage conditions in practice.
- **Names** (unit/spell/zone) are an authoring convenience over the log's
  own `log_lists` tables (a searchable name → id picker), **not** a new
  runtime value type — the compiled value is always the same integer id v1
  already uses. Ids are the actually-stable, log-independent join key;
  names are a per-log-dependent label on one.

## 4. Collections

A first-class, connectable "list of ids" type — generalizing v1's inline
`spellIds: number[]` / `npcIds: number[]` arrays into a real graph value.

- Tagged by domain (spell-id list vs. unit/actor-id list) so a
  wrong-kind hookup (plugging a Spell IDs collection into an npc-id input)
  is a structurally invalid connection, not a silent bug.
- A bare scalar **auto-wraps** to a 1-element collection wherever a
  collection is expected (e.g. "On Spell Cast" accepting either a single id
  or a list).
- **Motivation beyond convenience**: many WoW abilities are "the same
  thing" across difficulty tiers (normal/heroic/mythic/LFR spell-id
  variants of one ability) or across specs (a mage's "big defensive" vs. a
  priest's vs. a warrior's — different spell ids, functionally
  interchangeable). Collections let an author group these once and treat
  them as one condition.
- **Dedup/caching is by node reference/identity, not value equality** — two
  triggers wired to the *same* collection node share one query; two
  triggers with textually-identical but separately-authored id lists do
  not (matching v1's actual failure mode from §1). This is also the
  motivating reason every node needs a stable id (§13) — a stable id is a
  more robust identity key than relying on in-memory object references
  surviving unchanged.
- **Combinators, decided**: yes, needed — but one generic node covering
  combine (union), subtract, and test-for-inclusion is enough. No need for
  a separate node per operation.

**Number lists** are a related but distinct primitive — not a collection
of *ids*, a collection of *values* (e.g. "each raid member's current
health," "the timestamp of each add death"). These get their own single
generic aggregate node: min, max, average, count, standard deviation,
first, last. Same principle as id-collections — one flexible node with an
operation picker, not a family of single-purpose nodes.

## 5. Scoping — two levels of reusable groups

Two genuinely different lifetimes for a reusable collection:

1. **Config-local** — today's `EncounterConfig.triggers`-style sharing,
   specific to one fight's file (extended to cover collections generally,
   not just triggers). Example: "Dangerous Adds" vs. "Trivial Adds" for one
   specific encounter.
2. **App-global "sources"** — named categories maintained once, outside any
   single encounter file: `Raid Offensive` (Bloodlust/Heroism/Timewarp/...),
   `Personal Defensive (Big/Small)`, `Health Pots`, `Combat Potions`,
   `Immunity`, plus role/kind groups (`Players`, `Creatures`, `Pets`,
   `Tanks`, `Healers`, `Ranged`). Edited in a Settings window, shipped with
   sensible defaults, user-editable.
   - **Referenced live by name.** The compiled encounter file stores the
     category's *name*, not a snapshot of its contents — fixing or
     expanding a category in Settings retroactively affects every encounter
     that references it. This is a deliberate tradeoff: an encounter config
     is no longer fully self-contained; it has an external dependency on
     app state. Decided explicitly, not a default that was backed into.
   - Some of these are more buildable than they look with zero new
     detection work: `UnitKind` (`src-tauri/src/parser/intern.rs`) already
     distinguishes `Player` / `Creature` / `Pet` / `Vehicle` / ...; role
     groups (`Tank`/`Healer`/`Ranged`) already exist as
     `TANK_SPECS`/`HEALER_SPECS`/`RANGED_DPS_SPECS` +
     `formatRole(specId)` in `src/format.ts`, keyed off `COMBATANT_INFO`'s
     spec id.

## 6. Source → Filter — the event-stream backbone

The core authoring primitive for mechanics/phases: a **Source** node is a
kind-scoped, time-window-scoped event stream (Deaths, Casts, Auras,
Interrupts, ...); a **Filter** node narrows it by an actor collection or a
spell collection (auto-wrapping scalars per §4), or another predicate.

This maps almost directly onto the existing generic query engine (§2): a
Source ≈ an initial `kind` filter, a Filter ≈ an additional `where` clause.
**If v2's graph compiles down to that same `QuerySpec` shape** rather than
each Source type getting bespoke Rust evaluator code (v1's per-trigger-kind
approach), the shared-query performance win from §4's reference-identity
dedup applies here too — two Source→Filter chains producing the same
`QuerySpec` really are the same query.

Concrete backend gaps found while working through examples:

- **`UNIT_DIED` interns the victim as the *target* unit, not the source**
  (confirmed in `evaluate.ts`'s own comments). `query.rs`'s `Field` enum
  has `SourceOwnerKind` but no `TargetOwnerKind` — so today's query engine
  literally cannot filter/group deaths by "was the victim a player or a
  creature." Needed for a "Deaths → players / creatures" split. **Backend
  addition required**, not just graph wiring.
- The parser already distinguishes `UnitDied` / `UnitDestroyed` /
  `UnitDissipates` as separate kinds (`StandaloneKind`,
  `src-tauri/src/parser/event.rs`) — totems/vehicles typically despawn via
  `UNIT_DESTROYED`, not `UNIT_DIED`. **Decided: Deaths is a single Source
  with a kind toggle** (`UnitDied` / `UnitDestroyed` / `UnitDissipates`,
  selectable), not two separate Source node types — death and despawn are
  semantically distinct events, but that distinction lives at the
  parameter level of one node, not as two node types to choose between.
- **A new backend concept: "Lifetime"/"lifecycle."** For each unit, a span
  from its first observed activity to its death/despawn (or open-ended if
  neither happens in the window). "First observed activity" is the default
  start anchor when there's no better log marker to use instead — this is
  the concrete answer to v1's "no reliable spawn event" gap: not a true
  spawn detector, but a good-enough anchor that's honest about what it
  actually is.
  - **Future extension (not now)**: location-based inference — in 5-player
    dungeons, trash spawns in known locations, so "this entity's first
    action happened in this named region" could infer which named unit it
    probably is, without waiting for a more specific event.
  - **A harder related problem, explicitly not solved yet: social aggro.**
    A creature linked to others can become active without being directly
    interacted with — a player getting too close, or one of its linked
    allies activating first, can pull it into combat. That means "first
    activity" for such a creature may badly lag (or misrepresent) when it
    actually became functionally relevant. Needs more thought before
    lifecycle/spawn detection can be trusted for pulled/linked packs, not
    just solo patrols.

## 7. Aggregation over collections

A recurring, load-bearing pattern that showed up independently in unrelated
examples, which argues for designing it once rather than solving it ad hoc
per mechanic:

- The "keep 2 of 3 turtles apart, doesn't matter which 2" positioning rule:
  the *minimum* pairwise distance among any two members of a collection
  above/below a threshold.

**Correction to an earlier draft of the turtle example**: an early pass at
"Lost Explorers" described "any one of {Turtle A, B, C} dying forces a
wipe" as a mechanic worth detecting via aggregation. It doesn't need
special detection — a wipe is just an unsuccessful `ENCOUNTER_END`, and
`EncounterRow.success` already carries that (§2's existing reports). Worth
remembering in general: before reaching for a new mechanic-detection
primitive, check whether the answer is already sitting in data the parser
already produces. Positioning-style aggregation (the "keep them apart" rule
above) is still a real, needed case — it's specifically about a *live*
condition during the fight, not "did the pull ultimately succeed."

Given `count`/`any`/`all`/`min`/`max` now folds into the "number lists"
generic aggregate node from §4 (a collection's per-member values, reduced
one way), this section may not need its own separate vocabulary — revisit
once §4's generic aggregate node is nailed down.

## 8. Combinators → the Latch primitive

v1 has no way to race or combine trigger conditions — every trigger
resolves independently. Two real examples need this:

- "[Intermission] ends when 5 skeletons die **or** 30 seconds pass,
  whichever comes first."
- "The enrage forces the end of the fight **unless** the boss dies first"
  (a race between an enrage-timer/energy trigger and a boss-death trigger).

The first pass at this (bespoke `firstOf`/`allOf`/`noneOf` trigger types)
ran into a real problem: **a race has to propagate the winning branch's
actual resolved value, not just a timestamp or a boolean.** "Ends when 5
adds die or 30 seconds pass" needs the *real* moment it actually ended,
whichever branch won — the 5th add's death time, or the timer's expiry,
whichever came first. A combinator that only reports "which branch won,"
not "and here is that branch's own value," isn't enough to anchor whatever
comes after it. Designing that value-propagation as a special rule per
combinator type turned out to be the wrong altitude to fix it at.

**Resolved: replace the combinator family with one stateful primitive — a
Latch (a.k.a. Variable).** A Latch holds a value and is updated by
**set-true** / **set-false** pulses, each of which carries its own value
along. The latch doesn't need to know or care what kind of value rides on
a pulse (a timestamp, a count, anything) — it just remembers whichever one
arrived, decoupling "how do I combine conditions" from "what type is the
result" entirely.

This comes in **two distinct modes**, corresponding to the two combinator
shapes that motivated it:

- **Lock-on-first-set**: ignore every pulse after the first one, on either
  input. This is `firstOf`/race — "whichever fires first wins, and a later
  pulse on the other input doesn't matter." The 5-adds-vs-30s-timer example
  is this mode.
- **Always-overwrite**: every new pulse replaces the held value, no
  locking. This is the general shape of `allOf` *and* a real worked
  example: "bosses gain a debuff; players move them apart; the debuff
  falls off each one independently; the moment we care about is when the
  **last** one loses it." Each boss's "aura lost" event re-fires
  set-false, overwriting the previous value, so after the last boss loses
  it, the latch holds exactly that final timestamp. `allOf`'s "every
  condition must hold" and this debuff example are the same underlying
  pattern (the moment the *last* required thing happens) — not two
  different combinators. `noneOf` mostly dissolves into this too: "none of
  them currently have it" is just reading the latch's current boolean
  state, not a separate resolution mode.

**Evaluation consequence, not a new problem**: resolving a Latch means
folding over a chronologically-merged stream of set-pulses, updating held
state as you walk forward in time — not "resolve to one value
independently," which is how every trigger works today. This isn't a
foreign pattern to introduce, though — `resolveThreshold`
(`evaluate.ts:325-364`) already merges several time series and walks
forward maintaining "latest known value per key" for exactly this reason.
The Latch generalizes that into a first-class node rather than logic
baked into one specific trigger kind.

**Resolved: three layers, not one bolted-on special case.**

1. **Automatic, invisible** — reading any single tracked value's "current
   state" (a boss's current HP, whether a unit currently has a debuff)
   never needs an authored Latch node at all. It's just how a Source/
   Filter chain's value at an instant behaves, the same "latest known
   value per key" fold `resolveThreshold` already does. Not a node an
   author ever places.
2. **The general Latch primitive** (as described above) — explicit
   set-true/set-false wiring, for genuinely bespoke merges that don't fit
   the common shapes below.
3. **Convenience nodes built on (2), auto-wired, for the common cases** —
   a **Race** node (lock-on-first Latch, N labeled inputs) for `firstOf`,
   and a **Wait for all of {collection}** node for `allOf`: this
   auto-generates one per-member latch *per collection member*, invisible
   to the author, plus a count read (§4's number-list aggregate:
   `count(members currently latched true) == collection size`). The
   author never wires per-member latches by hand — they drop one node,
   and the fan-out + counting happens underneath it. Same underlying
   mechanism as the two-branch race, just automated over a collection
   instead of two named branches.

This means `allOf` doesn't carry its own bespoke "how do I know I've heard
from everyone" design question — it's the same Latch mechanism, automated.

**Decided: no record of which branch/pulse won.** In the rare case where
that's actually useful for debugging, the raw log itself is the test case
— an author can re-derive by hand what happened, rather than the schema
carrying provenance for every latch transition. Keeps the Latch's output
to just the value, nothing extra.

## 9. Phases

A phase is a **labeled span of the timeline**.

- **Phases fully partition `[combatStart, combatEnd]` with no gaps.** "No
  authored phases" is the degenerate case of one implicit phase covering
  the whole fight, not an absence of phases — every instant during combat
  has a well-defined active phase.
- **You're in phase N until phase N+1's trigger fires.** A phase's end is
  not independently authored in the common case — it's implied by whatever
  phase (or intermission) comes next.
- **Confirmed v1 bug, needs fixing regardless of anything else in this
  doc**: v1 infers an unset phase's end by scanning forward through the
  *config file's array order* (`evaluate.ts`, `starts.slice(i + 1).find(...)`)
  for the next resolvable phase's start. This is wrong whenever phases can
  occur in an order different from file order — confirmed necessary by the
  turtle-activation example below, where any of three phases can occur
  first. **Fix**: a phase's end is the soonest *any other phase's* start
  that occurs strictly after this phase's own start, computed globally
  across all phases, not by list position.
- **Linear chains use direct end→start wiring.** Dragging Phase 1's `end`
  output into Intermission's `start` input is literal graph wiring, not two
  independently-authored triggers that happen to coincide at the same
  moment. This mechanism **already exists in v1**:
  `PhaseNode.passThroughInputFor` (`src/encounters/nodes/phase.ts`) — a
  phase's start/end outputs re-expose whatever's wired into its own
  start/end inputs. Good sign this was already the right shape.
- **Non-linear / order-free phases still need independent start triggers.**
  The Lost Explorers "any of three turtles can be empowered first, in any
  order, and not all three necessarily occur" case has no single "previous"
  node to wire from — each candidate phase needs its own self-contained
  start condition. Both capabilities (pass-through wiring for linear
  chains, independent triggers for order-free ones) need to coexist.
- **Phase-scoped event sources default to that phase's own time window,
  not the whole encounter.** A "5 skeletons must die" mechanic inside
  Intermission 2 needs to only count deaths within Intermission 2's own
  span — a global/cumulative count ("10 skeletons total") is fragile,
  because a stray skeleton dying during the wrong phase (a player mistake)
  would corrupt a running total. This generalizes "Sources come pre-wired
  to encounter start/end" (§6) to "Sources come pre-wired to whichever
  context — a phase, or the whole encounter — they're nested under."
- **This scoping is implemented as real subgraph/container semantics in the
  editor**, not a manual wiring convention — a mechanic authored visually
  "inside" a Phase node automatically inherits that phase's time window for
  its Sources, rather than requiring the author to re-plumb scope by hand
  every time. Decided explicitly: yes, build real subgraph scoping.
- **Possible simplification, not yet fully decided**: because most real
  phase transitions are recognizable from simple, common log markers (a
  buff gained/lost, energy resetting to 0 for the Nth time), phases might
  not need the full node-graph/subgraph editing experience at all — a
  simpler "mark points directly on a timeline, detecting known markers"
  authoring tool may cover most real cases. The heavy graph-editor
  complexity (subgraphs, Source/Filter wiring) is reserved for
  **mechanics**, where the real complexity actually lives. This shifts
  where in the editor phases vs. mechanics get built, without changing
  anything about how phases *evaluate* (§9's rules above still apply
  either way).

### Worked example (why the file-order bug matters)

*Lost Explorers* — three turtles (Nama, Gebbo, and a third) wander freely;
players "feed a fish" to one, resetting a 4th unattackable entity
(Mor'zahi)'s energy to 0 and empowering that turtle with new abilities.
Which turtle gets fed, and in what order, is a player choice that varies
pull to pull — sometimes a pull ends before the third fish is ever needed.
Each possible activation is authored as its own `PhaseDef` with a fixed
label ("Nama Empowered," etc.); an un-triggered one simply resolves to
`null` (already-correct v1 behavior). But because the actual order isn't
fixed, computing "Nama's phase end" by looking only at phases *later in the
file* breaks the moment a pull's real order doesn't match authoring order —
exactly the bug described above.

## 10. Mechanics

A significant departure from v1, where `MechanicDef` lives nested inside a
phase's `mechanics: string[]` list.

- **Mechanics are not owned by exactly one phase.** A mechanic can be
  phase-scoped (only watched while a given phase is active, inheriting that
  phase's Source scope via subgraph nesting, §9) or global/encounter-wide —
  e.g. Lost Explorers' "keep 2 of 3 turtles apart" positioning rule (§7),
  which holds regardless of which turtle happens to be empowered at the
  time. (An earlier draft used "Mor'zahi's energy reaches 100 and wipes
  the raid" as the global-mechanic example — corrected in §7: that's just
  an unsuccessful `ENCOUNTER_END`, already known data, not something a
  mechanic needs to detect.)
- **Mechanics are scoped to a single encounter's duration.** They don't
  span multiple pulls the way a report/view block can (§11) — cross-pull
  aggregation is entirely the report layer's job, not the mechanic
  definition's.
- **A mechanic resolves to a *list of instances*** (one per occurrence —
  "Smash #1," "Smash #2," ...), not a single span like a phase. This is a
  structurally different evaluation shape: an iteration/mapping over every
  match in the window, not a resolve-to-one-or-null trigger resolution.
  v2's mechanic evaluator cannot just be "resolveTrigger but for mechanics"
  — it needs to walk the whole window finding *every* match.
- **A mechanic instance's payload is deliberately minimal**: a time window
  (an anchor moment ± fixed padding, e.g. cast start −3s / +3s) and/or the
  raw list of matching events. It does **not** pre-compute "involved
  units," cooldowns used, health series, etc. — that's the report/view
  layer's job (§11), applied on demand against the instance's window. This
  keeps mechanic definitions cheap and lets new questions be asked of old
  mechanics without re-authoring them.
- **"Involved units" is confirmed to need a family of filter kinds, not
  one**: hit by a given spell, has (or lacks) a particular buff/debuff, is
  within a particular area/position, and is of a particular role or class.
  Each is a genuinely different way of deciding who counts, and a mechanic
  should be able to pick whichever fits.
- **Windowing can also be authored directly as a union of time ranges**,
  not only derived from discrete detected occurrences. For a mechanic on a
  known fixed cadence (a tank buster every 45s, lasting 5s), an author
  should be able to say "look at events in `[45,50), [90,95), [130,135),
  [175,180)` seconds" directly, rather than only ever deriving windows by
  first finding a triggering event and padding around it. Both windowing
  styles — anchor-and-pad, and directly-authored time-range unions — need
  to be supported.

## 11. Views / reports

A separate layer, authored **per-encounter** alongside phases and
mechanics (not a generic ad-hoc dashboard tool a user builds fresh each
time) — Kanban, on selecting a pull, shows that encounter's defined views
stacked as one big scrolling list, in authored order. A trivial fight might
define zero views; a complex mythic one might define many. Complexity is
driven entirely by what the author bothered to build for that boss.

- Structurally a **flat, ordered list of `{query, renderer}` blocks** — not
  graph-shaped. Confirmed: no block references another block's output.
- **Reuses the Source→Filter→collections vocabulary** from §5/§6, just
  applied at report-authoring time instead of encounter-definition time:
  "health for players with role Tank, over the Tankbuster mechanic's
  windows" is Source (health series) → Filter (actor collection =
  role:tank) → Filter (time windows = Tankbuster's instances) → render as
  graph.
- **Can span multiple encounters/pulls at once** — a different aggregation
  level than mechanics/phases, which are per-pull. "Show me every
  tankbuster from tonight's raid" pulls mechanic instances from many pulls
  and lays them out together (e.g. one row per instance, across pulls, in
  a table).
- **Rendering is explicitly out of the compiled schema's hands.** A
  mechanic/report declares *what data it needs* (a mechanic's windows +
  events, a report block's query); the actual presentation — table, graph,
  a 3D-replay "zoomed in" window on the relevant area/players, a movement
  map, a generated text summary ("a, b, c used personal defensive; d
  died"), or some combination — is a renderer chosen at the view-block
  level, decoupled from mechanic authoring so the same mechanic can be
  looked at new ways later without re-authoring it.

## 12. Templates

A pattern library of common ability archetypes (Soak, Tank Buster, ...)
sitting on top of everything above — direct prior art already exists in
`docs/boss-parsers.md`'s "Recyclable mechanic templates" section (written
before this schema existed): "logic written once, an encounter instantiates
it with that fight's spell IDs / thresholds." v2 gives this a concrete
graph-editor form.

- **A template bundles a mechanic-definition skeleton *and* a matching
  default view as one named archetype**, not two independently-chosen
  things — "Single-Target Tank Buster" already knows to filter to
  tank-role players, expects exactly one target, shows an HP-over-time
  graph plus active-defensive-cooldown overlay, and windows ±3s around the
  hit for deaths/cooldown-use/position data. The view stays overridable per
  instance if the author wants something different for a specific boss.
- **Instantiating a template writes out a normal, standalone config for
  now** — a snapshot/copy, not a live link back to the template. Whether
  improving a template should retroactively propagate to its existing
  instances is **explicitly deferred** until there's enough real template
  usage to know whether that's wanted (unlike §5's app-global sources,
  which *are* live-referenced — this is a deliberately different choice for
  a different kind of reusable thing, revisit once templates exist).
- **Templates are editable subgraphs, decided.** Instantiating a template
  drops a real, fully-editable subgraph into the encounter's graph — not a
  locked node with a fixed set of scalar parameter fields. This resolves
  the earlier open question in favor of the more flexible option: nothing
  about a template's internals is off-limits after instantiation, so
  Soak's "who counts as having soaked it" (melee range vs. a specific
  debuff vs. a ground effect) is just part of the subgraph the author can
  edit directly, not a special "hole" type the schema has to distinguish
  from a plain scalar. Consistent with §12's snapshot-not-live-linked
  decision above — once instantiated, it's the author's own subgraph to
  change freely.
- **Escape hatch, resolved**: "just write TypeScript" for a fully custom
  view when no template fits, built on the app's existing Panel/Widget/
  `ViewContext` system and widget-distribution/trust model
  (`docs/ui-widgets.md`, `docs/widget-distribution.md`) — curated review,
  not code isolation, same as boss-parser packs. `docs/widget-distribution.md`'s
  CSP (`connect-src` scoped to `'self' ipc: http://ipc.localhost`, no
  external host) already blocks network exfiltration for this escape hatch
  the same as any other widget, at zero extra cost — that doc's own "not
  yet done" claim was stale and has been corrected. **Real
  isolation (a separate webview/iframe/worker per view) is explicitly
  deferred**, not designed — revisit only if custom views end up
  distributed more openly/less-reviewed than boss-parser packs are today.

## 13. Persisted editor/UI state

**Reverses a deliberate v1 decision.** v1's `PhaseNode` module comment
states outright: "nothing about the graph's visual layout survives
save/load ... `configToGraph` calls `LGraph.arrange()` fresh every time."
v2 persists node position (x/y), per-node color/title overrides, and
LiteGraph's native "group" concept (title/color/bounding box — purely
cosmetic, no wiring).

- **This requires giving every graph node a stable id**, assigned once at
  creation and carried unchanged across re-saves — v1's compiled JSON has
  **no node-identity concept at all** today (it's a pure semantic tree;
  `configToGraph` rebuilds fresh node instances from it on every load,
  with no link back to "the same visual node" from before). Decided: every
  node gets one, uniformly — no id-bearing/id-less special-casing based on
  node kind.
- **UI/layout data lives in a separate top-level `ui` section**, not
  interleaved into the semantic tree the evaluator reads:
  `ui.layout: { [nodeId]: { x, y, color?, title? } }`,
  `ui.groups: [{ title, color, bounds }]` (groups don't attach to any
  single node, so they need no per-node key at all). Keeping this separate
  means the evaluator never has to skip over presentation data, and
  evaluation performance isn't coupled to how much the author fiddled with
  layout.
- **Side benefit**: the same stable node id is a better cache/dedup key for
  §4's reference-identity collection sharing than relying on JS object
  identity surviving unchanged in memory.

## 14. Deferred / explicitly out of scope for this pass

- **The "burn phase" correlation problem**: "starts on gaining any member
  of a group, ends on losing *that specific* member" needs one trigger's
  match identity to flow into another trigger's search — today's evaluator
  only ever returns a timestamp, never "which specific thing matched."
  Phase start/end stay two independently-configured triggers for now
  (v1-style), accepting that "end = any group member lost" can occasionally
  match the wrong instance on overlapping casts.
- **Template live-linking** (§12) — deferred until real usage exists;
  instantiation snapshots as an editable subgraph instead.
- **Location-based spawn inference and social aggro** (§6) — noted as a
  future direction (useful once 5-player dungeons are in scope), not
  designed. Social aggro in particular (a creature activating via a
  linked ally or proximity, not direct interaction) needs real thought
  before lifecycle/spawn detection can be trusted for pulled packs.
- **Whether §7's aggregation needs anything beyond §4's generic
  number-list aggregate** — named as needed, not yet designed. (§8's
  combinator value-propagation question is resolved — see the Latch
  primitive and its Race/"Wait for all of" convenience nodes.)

## 15. Open questions, consolidated

None outstanding as of this revision — the last one (combinator shape,
§8) resolved into the Latch primitive. Treat this section as a checkpoint
marker, not a claim that the design is finished; new open questions will
accumulate as the node catalog (`encounter-config-v2-nodes.md`) gets
fleshed out and implementation starts.

## 16. Confirmed decisions, consolidated

For quick reference — everything in this doc that's settled, not open:

- Numbers stay one generic type; casting is automatic, no
  count/ratio/absolute distinction at the type level (§3).
- Durations get a real evaluator, specifically to support triggering off
  elapsed time into the encounter (§3).
- Collections: reference-identity dedup, scalar auto-wrap, domain-tagged,
  one generic combine/subtract/contains-test combinator node (§4).
- Number lists (a collection's per-member values) get their own generic
  aggregate node: min/max/average/count/stddev/first/last (§4).
- App-global sources: live-by-name reference; config-local groups stay
  file-local (§5).
- Source→Filter compiles toward the existing generic `query.rs` DSL, not
  bespoke per-Source-kind evaluator code (§6).
- Deaths is a single Source with a kind toggle (death vs. despawn kinds
  are real and distinct, but selected on one node, not two) (§6).
- A "Lifetime/lifecycle" concept anchors a unit's start to its first
  observed activity absent a better marker, running to death/despawn (§6).
- Wipes don't need mechanic-level detection — `EncounterRow.success`
  already has it; check existing parser data before reaching for a new
  detection primitive (§7, §10).
- Combinators are replaced by one stateful **Latch** primitive
  (set-true/set-false pulses, each carrying its own value; lock-on-first
  mode = `firstOf`/race, always-overwrite mode = `allOf`/"last of N"),
  evaluated by folding a chronologically-merged pulse stream — the same
  pattern `resolveThreshold` already uses. No record of which pulse won;
  the raw log is the debugging tool if that's ever needed (§8). Reading a
  single tracked value's current state is automatic/invisible, never an
  authored node; **Race** and **Wait for all of {collection}** are
  convenience nodes that auto-wire the Latch underneath (the latter
  fanning out one latch per collection member automatically) so an author
  never hand-wires raw latch pulses for the common cases (§8).
- Phases fully partition the timeline; "no phases" = one implicit phase
  (§9).
- Phase-end inference must be global-next-start, not file-order-next-start
  (v1 bug, must be fixed regardless of anything else) (§9).
- Linear phase chains wire end→start directly (`passThroughInputFor`,
  already built); non-linear phases keep independent start triggers (§9).
- Subgraph scoping is real editor machinery, not a wiring convention (§9).
- Mechanics are independently scoped (phase-local or global), not
  phase-owned; scoped to a single encounter; resolve to instance lists,
  not single spans (§10).
- Mechanic instances stay minimal (window + events); all derived data
  (involved units, cooldowns, health) computed by the report layer on
  demand (§10).
- "Involved units" needs a family of filter kinds: hit-by-spell,
  has/lacks-aura, positional/area, role/class (§10).
- Mechanic windows can be authored either as anchor-and-pad around a
  detected event, or directly as a union of time ranges (for fixed-cadence
  mechanics) (§10).
- Views/reports: per-encounter authored, flat ordered block list, can span
  multiple pulls, renderer decoupled from mechanic/report definition
  (§11).
- Templates bundle a mechanic skeleton + default view as one archetype;
  instantiation drops a fully editable subgraph (snapshot, no live link
  back to the template) (§12).
- Every graph node gets a stable id, uniformly; UI/layout state lives in a
  separate `ui` section, not the semantic tree (§13).
- `TargetOwnerKind` added to `query.rs`'s `Field` enum (implemented,
  `src-tauri/src/query.rs`) — Deaths can now filter/group by victim kind
  (§6).
- Sandboxing: curated review (no code isolation) plus the app's existing
  CSP (`connect-src` scoped, no external hosts) is the whole answer for
  now; real per-view isolation is deferred until distribution goes
  open/unreviewed (§12, `docs/widget-distribution.md`).
- Name/pattern matching against units or spells (e.g. "creature name
  matches `big bad*`") resolves once against the log's interned
  unit/spell tables to build an `actor-id-list`/`spell-id-list` — it is
  **not** a per-event-row comparison. Because the intern tables are small
  (hundreds to low thousands of entries) regardless of log size, this is
  cheap even with full regex; a wildcard/glob syntax is still the better
  *default* for authors (§17).

## 17. Name / pattern matching (addendum)

Raised as "can filters do regex on names (e.g. `big bad*`) without being
slow." **Decided: yes, and it isn't a performance tradeoff at all**, once
the actual matching target is identified correctly.

- **This is not a per-event-row string comparison.** `EventStore` rows
  never carry raw names — units/spells are interned ids (§2). A "match by
  name" node resolves its pattern against the log's *interned* unit/spell
  tables (`InternTables`) exactly once, producing a concrete id list —
  the same resolution `evaluate.ts`'s `internSpellIndices`/
  `internSourceIndices` already do for exact ids today (§4, §6). That id
  list is what actually feeds Sources/Filters downstream, at the same
  cost as any other `actor-id-list`/`spell-id-list`.
- **Because interned tables are small** (hundreds of units, low thousands
  of spells per log — nowhere near event-row count, which can be
  millions), matching every entry against even a real regex is cheap
  regardless of log size. There is no version of this feature that's slow
  *if it's kept at the intern-table level* — the performance risk would
  only appear if pattern matching were (wrongly) pushed down into the
  per-row query engine (`query.rs`), which it doesn't need to be.
- **Still recommend glob/wildcard (`*`, `?`) as the default authoring
  syntax**, with full regex available for power users — most authors think
  in "starts with," "contains," "ends with" shapes (exactly `big bad*`),
  and glob syntax reads better in a node's widget than an escaped regex
  literal. Both compile to the same cheap one-time table scan, so this is
  a UX choice, not a performance one.

**Numeric range matching, implemented.** Unlike name matching, a number
range check (health between X and Y, a timestamp within a window) *is* a
genuine per-event-row concern — but a bounds check is two comparisons, not
a scan, so it's cheap regardless. Added `Op::InRange`/`Op::OutOfRange` to
`query.rs`'s filter DSL directly (`value: [lo, hi]`, inclusive both ends,
numeric fields only) — implemented and verified (`cargo test`,
`bun run build` both clean), mirrored in `src/ui/query.ts`'s `FilterOp`.
