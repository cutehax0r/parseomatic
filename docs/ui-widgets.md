# UI: Panels and Widgets

How new views get built going forward, starting with the **Overview**
view. Debug and Raw (`docs/status.md`) are explicitly *not* migrated onto
this — they stay hand-rolled as the quick "does the parser actually work"
sanity check, and this doc doesn't change them.

> **Implementation status.** A first cut is built: `src/ui/` (`spec.ts`,
> `registry.ts`, `panel.ts` `buildView`, `context.ts`, `query.ts`),
> `src/ui/widgets/` (`encounter-title`, `section-heading`, `stat-tile`,
> `player-table`, `line-chart`), and `src/views/overview.ts` — the
> Overview view, wired to the encounter picker. Deliberately minimal vs.
> the design below: `ViewContext` carries `range` + the loaded log's
> lists + `query` + `requestFrame` + `subscribe`, **no `filterChain` or
> `playhead` yet**; `WidgetFactory` is `(props, ctx)` — the widget builds
> its own `element`, no `root` mount param; `query.ts` throws (no
> `query_events` backend yet, so Overview's damage/healing/player numbers
> and chart series are mocked). Overview assumes a single selected
> encounter and shows an empty state otherwise.

Packaging/loading third-party widget code and the trust model around that
are a separate concern — see `docs/widget-distribution.md`. This doc is
about how a view is built and how widgets get data, assuming all widget
code is already loaded and trusted.

## Why

Debug and Raw were each built by hand: markup hardcoded per tab in
`index.html`, wiring hand-written per tab in `main.ts`. Fine for two views
built once. The roadmap (`planning.md` views 2-4, `stats-features.md`) calls
for a Statistics view with a dozen small panels (line chart, per-source bar
lists, a character table, side-by-side comparison), a Character status view
(health/energy bars, cooldown state, buffs/debuffs), and encounter-specific
custom analysis (see `docs/widget-distribution.md`'s worked example) —
repeating the hand-rolled pattern for each means re-deriving the same
tile/grid/bar-chart/query-wiring every time.

Instead: a small set of reusable pieces — **Panels** (layout containers) and
**Widgets** (the content placed inside them, sharing one small API) —
composed into a view instead of hand-built per view.

## Core concepts

### Panel

A layout container, CSS Grid under the hood
(`grid-template-columns: repeat(columns, 1fr)`), with a `columns` count — 1,
2, 4, whatever the layout calls for, not a fixed enum. Children lay out
left-to-right and wrap into new rows. A child can `span` more than one
column (e.g. a full-width chart in a 4-column panel spans all 4).

Panels **nest**: a child slot can hold either a Widget or another Panel, so
a 2-column top-level panel can have a 4-column panel of stat tiles in one
cell and a single wide chart widget in the other.

### Widget

A single piece of content — a stat tile, a bar list, a progress bar, a
chart, a toolbar button, a filter dropdown. **There is no separate "control
widget" subtype** — a toolbar button is an ordinary widget that happens to
call a mutator on `ViewContext` (below) when clicked, instead of only
reading from it. Everything in a view, including its own chrome, is
addressable the same way.

```ts
interface Widget<TProps = unknown> {
  readonly element: HTMLElement;
  update(props: TProps): void;
  setPlayhead?(timeMs: number): void; // optional -- see "Shared state: the playhead"
  destroy?(): void;
}

type WidgetFactory<TProps = unknown> =
  (root: HTMLElement, props: TProps, ctx: ViewContext) => Widget<TProps>;
```

`update` and `setPlayhead` are deliberately two different tiers: `update`
runs when a widget's props or the shared filter chain change — potentially
an IPC round trip, expensive, infrequent. `setPlayhead` runs every animation
frame during playback and must never touch the backend — see below. A
widget that doesn't care about playhead position (a stat tile showing a
fixed total) just doesn't implement it; nothing calls a method that isn't
there.

### ViewContext — shared per-window state, passed to every widget

```ts
interface ViewContext {
  filterChain: FilterChain;
  playhead: PlayheadState;
  activeView: string; // generalizes today's ad hoc `currentViewMode` in main.ts

  setFilterChain(next: FilterChain): void;
  setPlayhead(next: Partial<PlayheadState>): void;
  setActiveView(id: string): void;

  query<T>(spec: QuerySpec): Promise<T[]>; // the one gateway to backend data
  requestFrame(cb: () => void): void; // batches redraw requests into one rAF per window
  subscribe(fn: (ctx: ViewContext) => void): () => void; // returns an unsubscribe fn
}
```

Every widget factory gets the same `ctx` for its window. This is what makes
"widgets can just be wired into views, including chrome" work without a
special case: a toolbar-button widget calls `ctx.setActiveView(...)`; a
filter-dropdown widget calls `ctx.setFilterChain(...)`; a chart or table
widget calls `ctx.query(...)` and reads `ctx.playhead`. Same interface,
different behavior, no subclassing.

`requestFrame` is a per-window scheduler, not per-widget — it batches
however many widgets ask for a redraw in a given tick into one
`requestAnimationFrame`, the same discipline `VirtualList` already uses
internally for scroll-driven rendering, just hoisted to window scope so
nothing runs a second, competing loop.

This supersedes the original "no shared reactive data-source/context bus
yet" stance — two independent triggers for it (the filter chain and the
playhead) showed up close together, which is exactly the signal that was
named as the reason to build one.

## Shared state: the filter chain

Multiple widgets in one view (a bar list, a line chart, a stat tile, all in
"Damage Done") need to react to the same encounter/player/spell/target
selection at once. Modeled as one ordered list of AND clauses, shared per
window/view, not per widget:

```ts
interface FilterClause {
  field: "encounter" | "sourceGuid" | "spellId" | "targetGuid" | "kind";
  op: "eq" | "in";
  value: unknown;
  label: string; // "Player: Thrall" -- for rendering as a removable chip
}
type FilterChain = FilterClause[];
```

Flat and ordered, not a tree — no OR/NOT needed for "start broad, keep
narrowing," and the order doubles as the natural order for a breadcrumb/chip
UI. **A widget's actual query is the view's `filterChain` plus that widget's
own fixed clause(s)** — "Damage Done" always adds `kind = SPELL_DAMAGE`,
"Healing Done" elsewhere always adds `kind = SPELL_HEAL`; encounter,
player, spell, and target all come from the shared chain.

**Two ways a clause gets added:**
- A filter bar (dropdowns/chips) — itself a Panel of ordinary widgets (e.g.
  an `encounter-picker` widget) that call `ctx.setFilterChain(...)`.
- Drill-down: double-click a rendered value. `main.ts`'s `setRawCell`
  already marks certain raw-view cells `raw-clickable` and knows their
  underlying id (currently just a tooltip) — extending that into an actual
  action is the same fact, used for real. Can apply in place, or spawn a
  **new** window seeded with `currentChain + [newClause]`, extending
  `spawn_sibling_window` (`windows-and-files.md`) to carry the chain as an
  extra payload — the new window's chain then diverges independently, same
  as `WindowLogs` already gives every window independent state off one
  shared parsed log.

**Backend note — a clause isn't always a flat per-event field compare:**
- `encounter`: filter using the `start_row`/`end_row` index range already on
  `Encounter` (`reports.rs`), not a `timestamp_ms` comparison — cheaper, and
  unambiguous at the boundary since it's exactly the range the encounter was
  built from in the first place.
- The time scope is **always a concrete `[startMs, endMs]`**, never a
  distinct "all" state. Picking an encounter row sets the range to that
  encounter's `start_ms`/`end_ms`; "Custom range" sets it freely. The
  backend can still take the `start_row`/`end_row` fast path when the
  range came from an encounter, and fall back to a `timestamp_ms BETWEEN`
  compare otherwise.

**Encounter picker (built ahead of the filter chain, hand-wired in
`main.ts` like Debug/Raw).** A toolbar popup listbox — `Custom range`,
then the grouped encounter list — plus a **Custom range popover**: two
native `datetime-local` inputs (`step="0.001"` for a milliseconds field,
`min`/`max` clamped to the log's extent, seeded from the current range on
open) with per-field "Log start" / "Log end" snap buttons and Cancel /
Apply. There is no "Everything" row — the whole-log range is just a
custom range at full width, which the snap buttons produce; the button
labels it "Full log" at that width, otherwise the range, or "Boss —
Pull N" when an encounter row is selected. The log's overall extent is
derived from the encounter list (its leading/trailing synthesized trash
spans reach the first/last event — see `reports.rs`). What the picker
writes today is a `filter-changed` `CustomEvent` on `window` —
`detail.range = { startMs, endMs, source: { kind: "custom" } | { kind:
"encounter", index } }` — and it folds into `ctx.setFilterChain` as an
`encounter-picker` widget once ViewContext exists. A **timeline brush on
the Log page** is the other way to set the same range. The list's
**layout is a display preference, not part of the filter model**:
default is grouped (one header per boss by `encounterId`, pulls numbered
within it, a separate Trash section); a planned Settings toggle ("Sort
pulls chronologically / trash separately") switches it to one flat
file-ordered list interleaving trash and pulls by time (`trash 1,
trash 2, boss1 wipe 1, boss1 wipe 2, boss1 kill, trash 3, boss2 kill,
…`). Kill/wipe outcomes are colored (`--success`/`--danger`); trash and
synthesized ("unknown") ends are not.

**TODO — trash span names.** `Trash 1, Trash 2, …` is uninformative. Name
by adjacency instead: trash before an encounter → `Pre-<boss X> trash N`;
trash after `<boss X>` with no later encounter → `Post-<boss X> trash N`;
fall back to `Trash N` only when the log has no encounters at all. Not
urgent — do it when the picker is next revisited.

## Shared state: the playhead

```ts
interface PlayheadState {
  timeMs: number;
  rangeStart: number;
  rangeEnd: number;
  playing: boolean;
  speed: number;
}
```

One playhead per window, driving every widget in it. Range derives from the
filter chain's current time scope — selecting an encounter sets
`[encounter.start_ms, encounter.end_ms]`. A single `requestAnimationFrame`
loop (via `ctx.requestFrame`, owned by the window, not per-widget) advances
`timeMs` while playing and calls `setPlayhead` on whichever widgets
implement it.

This only works at 60fps because of the `update`/`setPlayhead` split above:
a playhead-driven widget fetches its (bounded, small) dataset **once**, on
`update`, via `ctx.query` — e.g. one player's damage events across one
5-15 minute encounter, at most a few thousand rows, the same "small enough
to hold client-side" bucket the existing debug tables are already in, as
opposed to the raw view's paged fetching. `setPlayhead` then only
rescans/repositions data already held in memory — no IPC, no backend query,
cheap enough to run every frame.

**Chart widgets:** compute the curve/fit once in `update()`. Redraw only the
moving position indicator in `setPlayhead`, ideally a transform on one
layered element rather than a full repaint. Canvas is the likely right
choice for the curve itself given the redraw-at-60fps requirement, but
that's internal to the widget, not an architecture decision.

**Table widgets ("auto-scroll to now"):** since the data's already sorted by
timestamp (columnar `EventStore` is file-ordered; filtering never
reorders), `setPlayhead` binary-searches for the current row and scrolls
`VirtualList` there. `VirtualList` doesn't have a "scroll to logical index"
entry point yet — needed before this widget can be built. "Top is newest"
vs. "bottom is newest" is a config flag on one widget type (which end it
anchors to), not two widget types. This is the same mechanism
`planning.md`'s view 1 already named and left unbuilt — "this table moves
to a right-hand panel that auto-scrolls with the timeline, karaoke-lyrics
style."

**Open, not resolved:** if the user manually scrolls the table mid-playback,
does auto-scroll keep fighting them, or disengage (chat-app style — a "jump
to now" affordance reappears)? Decide before building this widget.

**Transport controls** (play/pause/seek/speed) are just another widget
(`playhead-control`) that writes to `ctx.playhead` — no special type, same
as the filter-bar widgets above.

## The spec tree — the seam for future declarative/visual config

A view's layout is a plain, JSON-serializable data structure, not a
sequence of imperative TS calls:

```ts
type NodeSpec = PanelSpec | WidgetSpec;

interface PanelSpec {
  kind: "panel";
  columns: number;
  children: NodeSpec[];
  id?: string; // optional -- for later addressing (editor, targeted updates)
}

interface WidgetSpec {
  kind: "widget";
  type: string; // looked up in the widget registry
  span?: number; // columns occupied, default 1
  props?: Record<string, unknown>;
  id?: string;
}
```

`buildView(spec: NodeSpec, mountPoint: HTMLElement, ctx: ViewContext): BuiltView`
walks the tree, creates the Panel grid DOM, and instantiates widgets via the
registry and `WidgetFactory`. `BuiltView` keeps a `Map<string, Widget>` of
every spec node that declared an `id`, so a view can push targeted updates —
`builtView.get("dps-tile")?.update(...)` — without rebuilding anything else.

v1 specs are written by hand as TS object literals inside each view's source
file — no editor, no external authoring format yet. This indirection is
worth it now because none of the plausible future authoring surfaces need
to touch Panel, the registry, or any existing widget:

- A **node-based visual editor** for the data-wiring half specifically (a
  widget's props — spell id, unit id, time range — as input sockets, wired
  from picker/filter/aggregate nodes) is the current leading candidate,
  ahead of a Lua config format — more approachable for non-programmers, and
  a natural DAG shape for exactly this kind of wiring. Prototype target:
  [LiteGraph.js](https://github.com/jagenjo/litegraph.js/) via the actively
  maintained fork, [`@comfyorg/litegraph`](https://www.npmjs.com/package/@comfyorg/litegraph)
  (the original repo is archived) — canvas-rendered, no framework
  dependency, proven at scale in ComfyUI. [Rete.js](https://retejs.org/) was
  considered and set aside: TS-first and more modular, but it only ships
  official renderers for React/Vue/Angular/Svelte/Lit, no first-party
  vanilla renderer, which is a real cost against this project's
  no-framework stance. Not started.
- A **drag/drop layout editor** just needs to mutate this same tree and
  re-run `buildView`.

## Widget registry

```ts
registerWidget(type: string, factory: WidgetFactory)
```

into a single `Map<string, WidgetFactory>`. Built-ins register themselves
from one explicit `src/ui/widgets/index.ts` that imports every widget
module — deliberate, rather than relying on Vite not tree-shaking
side-effect-only imports. `buildView` throws a clear error on an unknown
`type`. This is also the exact registry a loaded third-party pack populates
at runtime — see `docs/widget-distribution.md`.

## Data access

`ctx.query<T>(spec: QuerySpec)` is the one path from a widget to parsed log
data, backed by a generic Tauri command (`query_events`, say):

```ts
interface QuerySpec {
  filter: FilterClause[]; // typically ctx.filterChain + the widget's own fixed clauses
  select?: string[]; // raw-row mode: which fields to return; omit for all
  groupBy?: string[]; // e.g. ["sourceGuid"] or ["sourceGuid", "spellId"]
  aggregate?: AggregateClause[]; // present -> one row per groupBy tuple instead of raw events
}

interface AggregateClause {
  op: "sum" | "count" | "min" | "max";
  field?: string; // required for sum/min/max; omitted for count
  as: string; // output column name
}
```

**Two modes, one command.** With no `aggregate`, it returns raw rows as
before (`select` picks columns). With `aggregate`, the backend does the
group-by/reduce over the columnar `EventStore` and returns one row per
distinct `groupBy` tuple — the group-key fields plus each `as` column.

Aggregation is in from the start, not deferred, because the common
Overview/Statistics widgets — per-player Damage Done / Healing Done / Damage
Taken bar lists, raid DPS/HPS totals, damage-taken-by-ability, death
counts — are all `sum`/`count` grouped by one or two fields. The
alternative, shipping every matching event over IPC to reduce in JS on every
filter-chain change (20 players × thousands of rows, re-summed on each
selection), is exactly the cost the performance tiebreaker (`planning.md`)
says to avoid. Reducing in Rust against data that's already
struct-of-arrays is cheap and keeps the IPC payload proportional to the
answer, not the input.

**Scope stays deliberately small: `sum`/`count`/`min`/`max` with group-by,
nothing more.** A general aggregate DSL would have to anticipate every
possible computation (crit rate, uptime %, "which two players were closest
when a debuff was removed" — see `docs/widget-distribution.md`'s worked
example), and most of those don't fit one shape. Anything past
sum/count/min/max stays in widget code, operating on rows `ctx.query`
returned in raw mode (including position fields, already tracked per event
for the planned 3D replay) — not a backend feature. Conditional aggregates
(crit rate = crits ÷ hits) are two queries, or a client-side pass over raw
rows — not a new clause type.

**Per-encounter player rows (what the Overview "Players" table needs, once
real):**
- **Roster is per-encounter, never log-wide.** Players come and go across a
  raid night. The roster for an encounter is the set of player units with
  damage / healing / cast activity inside its `[start_row, end_row]` range —
  derived from the events, not from a static player list.
- **Pet contributions roll up into the owning player.** A pet/guardian/totem
  owned by a player (`UnitRow.owner`) has its damage and healing added to
  that player's row; pets are not their own rows. (How to surface the
  pet-vs-player split visually is a later question — for now it's just
  summed in.) The group-by key for a "damage by player" query is therefore
  *effective owner* (`owner ?? self` when the source is a player-owned
  unit), not the raw `sourceGuid`.

Until `query_events` exists, Overview mocks both: a stable per-encounter
subset of the log's players, with synthesized numbers.

## Starter widget set

Enough to prove the pattern on Overview — not a full Statistics-view
build-out:

- **`stat-tile`** — label + big number (e.g. total raid DPS).
- **`bar-list`** — name + horizontal bar + value, with left/right labels for
  percent-of-total and absolute amount. Matches the per-player rows
  described in `stats-features.md` (damage done, healing done, damage
  taken).
- **`progress-bar`** — a single labeled bar (health/energy). Built now for
  Overview, deliberately reusable later for the Character status view
  (`planning.md` view 2) without change.

Playback and filter-chain UI (`playhead-control`, an `encounter-picker`
style filter widget, a `bar-chart` with a moving playhead indicator, an
auto-scrolling event table) are designed above but not part of this starter
set — build them once there's a concrete view that needs playback.

Table-shaped data (a future `data-table` widget) can wrap the existing
`VirtualList` internally once a widget actually needs it — that's the
intended reuse path, not a second virtualization mechanism.

## Example composition (Overview)

Sanity check for the design above, not a committed layout:

```ts
const overviewSpec: NodeSpec = {
  kind: "panel",
  columns: 2,
  children: [
    {
      kind: "panel",
      columns: 4,
      children: [
        { kind: "widget", type: "stat-tile", id: "raid-dps", props: { label: "Raid DPS" } },
        { kind: "widget", type: "stat-tile", id: "raid-hps", props: { label: "Raid HPS" } },
        { kind: "widget", type: "stat-tile", id: "deaths", props: { label: "Deaths" } },
        { kind: "widget", type: "stat-tile", id: "duration", props: { label: "Duration" } },
      ],
    },
    { kind: "widget", type: "bar-list", id: "damage-done", span: 1, props: { title: "Damage Done" } },
  ],
};

const built = buildView(overviewSpec, document.querySelector("#overview-view")!, viewContext);
built.get("raid-dps")?.update({ value: "142.3k" });
built.get("damage-done")?.update({ rows: [...] });
```

## File layout

```
src/ui/
  spec.ts             # NodeSpec/PanelSpec/WidgetSpec types, Widget/WidgetFactory interfaces
  panel.ts             # buildView(), Panel grid DOM creation
  registry.ts          # registerWidget/getWidget map
  context.ts            # ViewContext: filter chain, playhead, requestFrame scheduler
  query.ts               # ctx.query() -- thin wrapper over the query_events Tauri command
  widgets/
    index.ts             # imports every built-in widget module (registers them)
    stat-tile.ts
    bar-list.ts
    progress-bar.ts
    playhead-control.ts
src/views/
  overview.ts             # first consumer: hand-written NodeSpec + ViewContext wiring
```

Matches the existing flat, lowercase-kebab module style
(`src/virtual-list.ts`), just grouped under `ui/` and `views/` now that
there's more than a couple of files.

## Styling

Extends the existing single `src/styles.css` (Catppuccin Macchiato,
semantic `--bg`/`--border`/`--text`/... aliases already defined there)
rather than introducing per-component stylesheets or CSS-in-JS, matching
current practice. A clearly delimited section holds `.panel`/`.panel-cell`
grid rules, plus one block per starter widget's classes.

**Visual reference: [shadcn-svelte](https://www.shadcn-svelte.com/docs/components/sidebar).**
The look there (restrained neutral surfaces, 1px low-contrast borders,
`--radius` ≈ 0.5rem, `shadow-sm`-scale elevation not glows, 14px base UI
text, muted-foreground for secondary text, a 4/6/8/12/16px spacing
rhythm, a 2px offset focus ring) is worth matching for the widget set. It
is reproducible in the current vanilla + CSS-variables setup *without
adopting the library*, because that setup is already the same
architecture — token-driven, one theme, every rule referencing semantic
aliases. Doing so means adding a few tokens (`--radius`, `--ring`,
`--card`/`--popover` surfaces, `--muted`/`--muted-foreground`) and
following those conventions; the Catppuccin palette stays. shadcn-svelte
distributes component *source* (a CLI copies files into the repo), not a
runtime package, so there is nothing to import and no Tailwind/Svelte
dependency incurred by treating it as a style target. The project's
no-framework stance holds for now (noted under "The spec tree" re: Rete.js);
if that is ever revisited, shadcn-svelte's copy-in model — and Svelte or
Solid over React, for the playhead-redraw reasons in "Shared state: the
playhead" — is the concrete direction. Component *behavior* (e.g. the
sidebar's collapse/persist/off-canvas plumbing) is the part that needs
reimplementing by hand as long as the stance holds; the look does not.

## Explicit non-goals for v1

- No end-user layout editor (node-based visual data-wiring editor is the
  leading future candidate — see "The spec tree" above — not started).
- No Lua/declarative loader.
- No dynamic/third-party widget loading — see `docs/widget-distribution.md`
  for the intended design once there are a few real widgets built against
  this API.
- No responsive column reflow — `columns` is fixed per panel. Revisit if
  Overview ever needs to look reasonable at very narrow window widths.
- Auto-scroll-disengage-on-manual-scroll behavior for playback tables is
  undecided (see "Shared state: the playhead").
- No role-based filtering (tank/healer/dps). Deriving role from
  `COMBATANT_INFO` `CurrentSpecID` via a static specId→role table was
  considered and cut as non-essential — filter by `sourceGuid` (individual
  player) instead. Revisit only if a concrete view actually needs
  group-by-role.
