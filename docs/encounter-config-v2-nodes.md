# Encounter config v2 — node catalog

**Foundations implemented in `docs/encounter-config.md`'s "Graph node
types" section.** This doc is kept as historical design rationale for the
node vocabulary that shipped (and the parts — Mechanics, Templates, Latch —
that didn't yet).

A working list of the specific graph nodes v2 needs, organized by what kind
of thing each one is. Companion to `docs/encounter-config-v2.md` (the design
rationale) — this doc is the concrete vocabulary that design implies, not a
restatement of it. Status tags: **[new]** doesn't exist in v1 at all,
**[keep]** exists in v1's `src/encounters/nodes/` and carries over largely
as-is, **[rework]** exists in v1 but changes shape, **[design]** named but
not yet fully specified.

Nothing here is final — it's the list to argue with, not implement from
directly.

## 1. Primitive value types

The base slot types every other node produces or consumes.

| Type | Status | Notes |
|---|---|---|
| `string` | **[new]** | Free text (Comment node's text; a phase/mechanic's display name). Not used for unit/spell identity — see Names below. |
| `number` | **[keep]** | One generic type — no count/ratio/absolute split at the type level (`encounter-config-v2.md` §3). Casting is automatic. |
| `moment` | **[keep]** | A resolved instant in the log (v1's `Trigger`/`ResolvedMoment`). What a Source→Filter chain, a combinator, or a Phase boundary ultimately produces. |
| `interval`/`duration` | **[rework]** | Exists in v1 (`DurationNode`, `TimeMathNode`) but has no evaluator. v2 gives it a real one, specifically to support "N minutes into the encounter" authoring (§3). See §5 below for the concrete node. |
| `boolean` | **[design]** | Not an explicit v1 slot type — conditions today resolve straight to a `moment` or `null`. Combinators (§6) and aggregation nodes (§4) may need a real boolean type distinct from "resolved instant," e.g. a positioning condition ("are these two units too close *right now*") that's true/false at any instant rather than resolving once. Needs thought before §4/§6 nodes are locked down. |

**Names** (unit/spell/zone) are explicitly *not* a primitive type — they're
a search-by-name widget affordance over `log_lists`, always compiling to
the same integer id v1 already uses (§3). No `name` slot type needed.

## 2. Collections

| Type | Status | Notes |
|---|---|---|
| `spell-id-list` | **[rework]** | v1's inline `spellIds: number[]`, promoted to a real connectable, domain-tagged node output. |
| `actor-id-list` | **[new]** | Same idea for units/npcs — v1's inline `npcIds`/`sourceNpcIds`. Domain-tagged separately from `spell-id-list` so a wrong-kind hookup is a structurally invalid connection (§4). |
| `number-list` | **[new]** | A collection of *values*, not ids — "each raid member's current health," "the timestamp of each add death." Distinct from an id-list; feeds the generic aggregate node (§4). |

Both id-list types auto-wrap a bare scalar of the matching domain (a lone
spell id becomes a 1-element `spell-id-list` wherever a list is expected).

## 3. Major building blocks

| Node | Status | Notes |
|---|---|---|
| **Phase** | **[rework]** | v1's `PhaseNode` exists and its start/end pass-through (`passThroughInputFor`) already works as intended (§9). What changes: subgraph/container semantics (mechanics nested inside a Phase inherit its time window), and the evaluator-side end-inference fix (global-next-start, not file-order). |
| **Mechanic** | **[new]** | Doesn't exist as an evaluated concept in v1 at all (`MechanicDef` is currently unevaluated schema). Resolves to a list of instances, not one span (§10) — a structurally new node/evaluation kind, not a rework of an existing one. |
| **View / report block** | **[new]** | A `{query, renderer}` pair, authored per-encounter, flat-ordered (§11). No v1 precedent. |
| **Template** | **[new]** | A named, editable-subgraph archetype bundling a Mechanic skeleton + default View (§12). Mechanically "insert a saved subgraph," so this may be more of an editor feature (a subgraph library/palette) than a new node type per se — worth confirming it doesn't need its own graph-node representation at all. |

## 4. Collection utilities

Decided: one generic node per collection kind, with an operation picker,
rather than a node per operation (§4).

| Node | Operations | Status |
|---|---|---|
| **Id-list combine** | combine (union), subtract, contains (membership test) | **[new]** |
| **Number-list aggregate** | min, max, average, count, stddev, first, last | **[new]** |

Both take a `spell-id-list`/`actor-id-list`/`number-list` input (matching
kind) and an operation-select widget; auto-wrap (§2) means a bare scalar
plugged into either still works.

Open per §15: §7's "aggregation over a collection" (any/all/count-based
conditions like the turtle-positioning rule) may turn out to be nothing
more than the number-list aggregate node feeding a comparison, rather than
a separate vocabulary — worth confirming once this node's shape is settled
in practice, not assumed here.

## 5. Math / arithmetic

| Node | Status | Notes |
|---|---|---|
| **Number math** (`+` `-` `*` `/`) | **[keep]** | v1's `NumberMathNode` already covers this for the `number` type. |
| **Time math** (`moment ± duration`, `duration ± duration`, `moment − moment → duration`) | **[rework]** | v1's `TimeMathNode` exists but has no evaluator backing `interval` (§3). This is the concrete node that needs a real evaluator: given the decision to support "N minutes into the encounter" directly, this node (or a new dedicated "N into encounter" node — TBD) is where that gets resolved against `combatStart`. |

## 6. Sources

Kind-scoped, time-window-scoped event streams (§6). All default their time
window from whatever they're nested under (a Phase's span, or the whole
encounter if unnested, §9) — this is the subgraph-scoping mechanism, not a
per-Source setting to author manually.

| Node | Status | Notes |
|---|---|---|
| **Casts** | **[rework]** | Replaces v1's separate `CastStartTriggerNode`/`CastSuccessTriggerNode` with one Source (kind-toggle: cast start vs. cast success) feeding a Filter, rather than two node types. |
| **Auras** | **[rework]** | Same collapse for `AuraAppliedTriggerNode`/`AuraRemovedTriggerNode`. |
| **Deaths** | **[new]** | Single Source, kind-toggle (`UnitDied` / `UnitDestroyed` / `UnitDissipates`) (§6, decided). Needs the new `TargetOwnerKind` field (done — `src-tauri/src/query.rs`) to filter/group by victim kind. |
| **Interrupts** | **[new]** | No v1 equivalent at all — v1 has no interrupt-based trigger. |
| **Lifetime / lifecycle** | **[new]** | Backend concept, not just a graph node — per-unit span from first observed activity to death/despawn (§6). Needs the backend "first activity" query support before the node itself can exist. |
| **Spawns / Births** | **deferred** | No reliable log event (§6, §14) — not designing the node until the detection heuristic exists. |

## 7. Filters

Narrow a Source by collection membership or another predicate (§6). Per
§10's "involved units" decision, this needs a real family, not one
catch-all:

| Node | Status | Notes |
|---|---|---|
| **Filter by actor** | **[new]** | Takes an `actor-id-list` (or auto-wrapped single unit). Covers "hit by," "cast by," "died as" depending on what it's filtering. |
| **Filter by spell** | **[rework]** | v1's `spell-filter-trigger.ts` is the closest existing precedent — generalizes to take a `spell-id-list`. |
| **Filter by aura state** | **[new]** | Has / lacks a given buff/debuff at the time of the event. |
| **Filter by position/area** | **[new]** | Within/outside a region — needs a concrete "region" value shape (point+radius? polygon?) not yet designed. Depends on `pos_x`/`pos_y` already in `EventStore`. |
| **Filter by role/class** | **[new]** | Backed by `src/format.ts`'s existing `TANK_SPECS`/`HEALER_SPECS`/`RANGED_DPS_SPECS`/`formatRole` — no new backend detection needed, just a node wrapping existing data (§5). |
| **Match units/spells by name** | **[new]** | Glob by default (`big bad*`), regex for power users — resolves once against the interned unit/spell tables to produce an `actor-id-list`/`spell-id-list`, **not** a per-event-row string comparison, so pattern complexity doesn't cost anything at log scale (`encounter-config-v2.md` §17). Feeds the same collection inputs as any other id-list, downstream. |

## 7a. Comparisons

Not graph nodes on their own — the operator choices available on a
Filter/threshold's comparison widget, backed directly by `query.rs`'s
`Op` enum.

| Op | Status | Notes |
|---|---|---|
| `=` / `≠` / `<` / `≤` / `>` / `≥` | **[keep]** | v1's existing comparison set (`ThresholdTriggerNode`'s `above`/`below`/`equal`, and `query.rs`'s `Eq`/`Ne`/`Lt`/`Lte`/`Gt`/`Gte`). |
| `in` / `not in` a list | **[keep]** | Already how spell/actor collection membership is checked today (`query.rs`'s `Op::In`). |
| **in range / out of range** | **[new]** | `Op::InRange`/`Op::OutOfRange` — implemented in `src-tauri/src/query.rs` and `src/ui/query.ts`. `value: [lo, hi]`, inclusive both ends, numeric fields only. Cheap (a bounds check, not a scan) even though — unlike name matching — this genuinely runs per event row. |

## 8. Latch (replaces the combinator family)

**Decided**: `firstOf`/`allOf`/`noneOf` as separate bespoke node types are
dropped in favor of one stateful primitive (`encounter-config-v2.md` §8).

| Node | Status | Notes |
|---|---|---|
| **Latch** (a.k.a. Variable) | **[new]** | Two inputs, `set true` / `set false`, each accepting a pulse *plus a value*; one output, the currently-held value. Mode toggle: **lock-on-first-set** (ignore all pulses after the first) or **always-overwrite** (each pulse replaces the held value). The low-level, hand-wired primitive — for bespoke merges that don't fit the two convenience nodes below. No branch/pulse provenance kept — just the value. |
| **Race** | **[new]** | Sugar over a lock-on-first Latch with N labeled inputs. Implements `firstOf`. |
| **Wait for all of {collection}** | **[new]** | Sugar over an *automatically fanned-out* set of per-collection-member latches (one per member, never hand-wired) plus a count check (§4's number-list aggregate: `count(members currently latched true) == collection size`). Implements `allOf` — "last of N to complete" — without the author placing a latch per member. |

Reading a **single** tracked value's current state (a boss's current HP,
whether a unit currently has a debuff) needs none of the above — it's
automatic/invisible, the same "latest known value per key" fold
`evaluate.ts`'s `resolveThreshold` already does. The Latch and its two
convenience nodes exist only for combining *distinct* branches into one
answer, not for reading one thing's value over time.

## 9. Open threads this catalog surfaces (beyond what §15 already lists)

- A real `boolean` slot type may be needed (§1) — v1 has never had one; every condition today resolves to a `moment` or nothing. Positioning-style "is this true right now" checks (§4, §7) don't obviously fit the `moment`-resolution model at all.
- Whether Template (§3) needs its own node representation, or is purely an editor-level "insert this saved subgraph" affordance with no new runtime node type.
- Whether §4's number-list aggregate subsumes §7's aggregation-over-collections entirely, or whether the latter still needs its own node.
