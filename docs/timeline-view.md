# Timeline view — a player's activity as a video-editor strip

A per-character view (multi-character comparison later). One bounded
window (a picked encounter or a custom range — same gate as Movement /
Deaths, not the whole log), one player, laid out as a horizontal
time axis with a stack of fixed **lanes**, each a row of **boxes**.

A box's **left edge is its start time** and its **width is its
duration**. Buffs and debuffs carry a real duration
(`SPELL_AURA_APPLIED` … `SPELL_AURA_REMOVED`); damage and heal events are
instants — drawn `1.5s` wide, shrinking to a `2px` sliver when even that
doesn't fit at the current zoom. On an **expanded** lane's per-ability
sub-rows, a damage / heal box wide enough to hold it prints its
**amount** (whole numbers, `123k`); the collapsed "type" lane overlaps
too much to label and relies on the hover tooltip. Consecutive ticks of
one DoT / HoT alternate shade (a darker stripe) so an abutting run reads
as distinct segments. The player's death intervals are pink rules across
every lane.

**Zoom + scroll.** The plot is drawn at its true pixel width
(`totalMs × pxPerMs`) inside an `overflow-x:auto` pane, so a native
horizontal scrollbar appears once it overflows. Default zoom shows one
minute, or the whole window if that's shorter. `−` / `+` / `Fit`
buttons (and ⌘/ctrl-wheel toward the cursor) change the zoom, keeping
the time under the cursor / pane centre fixed. The lane-label **gutter**
is a fixed HTML column that doesn't scroll.

**Collapsible lanes.** Clicking a lane's label row (triangle + name)
toggles it. Collapsed (default) every box in the lane is on one line;
overlapping boxes stack with the later one painted on top. Expanded
splits the lane into one sub-lane per ability (grouped by spell name,
ordered by first occurrence).

**Per-lane ability filter.** A funnel icon on each lane opens a popup
of that lane's ability names with checkboxes; unchecking one hides it in
both the collapsed lane and its sub-lane. State is a
`Map<laneId, Set<spellLabel>>` in the widget, cleared when the window
changes. (Long-term this becomes a global, per-encounter/class config
with important / normal / unimportant categories and a show/hide toggle
— not built.)

Hovering a box shows a floating tooltip with **that box's** details only
(name, amount, start/end + duration, source/target, position) — not
everything at that timestamp.

## Lanes (top → bottom)

| Lane | Source | Notes |
|---|---|---|
| Debuffs | `SPELL_AURA_APPLIED`/`_REFRESH` … `_REMOVED` on the player, `auraType == DEBUFF` | real width |
| Damage Taken | `_DAMAGE` where the player is the dest | instant |
| Damage Done | `_DAMAGE` where the player is the source | instant |
| Healing Done | `_HEAL` where the player is the source | instant |
| Healing Received | `_HEAL` where the player is the dest | instant |
| Buffs | aura spans, `auraType == BUFF` | real width |
| Movement | alternating Moving / Stopped segments | always full |

The **Movement** lane reuses the Movement view's standstill model
(`src/ui/movement-segments.ts` — a run of fixes within 1.5 yd of an
anchor for ≥3 s is a stop; a >5 s fix gap breaks it), fed by the
existing `movement_series` command's `samples`. Moving segments carry the
summed fix-to-fix distance; stops carry their duration and anchor
position (shown in the hover tooltip).

A future **Utility** lane (Invisibility, Counterspell, immunities…)
needs a curated spell list — not yet designed.

## Data — `timeline_series` command

`src-tauri/src/timeline.rs`, wired in `lib.rs`, fetched/cached by
`src/ui/timeline-series.ts` (keyed `unitId:startMs:endMs`, cleared on log
change). One `query::window` + one row loop over the window, reusing
`movement.rs`'s patterns:

- **instants** — direction classification and the same-ms
  `SWING_DAMAGE` / `SWING_DAMAGE_LANDED` dedup are the same as
  `movement::events`. `x`/`y` are the player's own coords
  (`pos_unit == unit_id`), else `null`.
- **auras** — `APPLIED`/`REFRESH` opens a span for a spell id if none is
  open for it; `REMOVED` closes the newest open one. `is_debuff` is read
  from the leftover `auraType` raw field (`"DEBUFF"`). `_DOSE` events
  update the span's `max_stacks` (peak); a small trailing number on
  `APPLIED` seeds the initial count (large values are absorb amounts and
  ignored). The box shows the count when the peak is >1. A span whose
  apply/removal falls outside the window is missed (no back-scan yet); an
  unclosed span runs to the window end.
- **deaths** — `UNIT_DIED` … `SPELL_RESURRECT`, lifted from
  `movement::series`.

## Widget — `timeline-lanes`

`src/ui/widgets/timeline-lanes.ts`. Inline SVG in an `overflow-x:auto`
scroll pane + a fixed HTML gutter; rAF-throttled hover, floating
tooltip. `pxPerMs` is the zoom; a `ResizeObserver` recomputes the
default against the real pane width on first measure. Lane collapse
state (`expanded: Set<laneId>`) persists across re-renders. Row layout
(`y`/`h` per row) is computed once and shared by the gutter and the SVG
so the two stay aligned.

Props are an **array of tracks** (`{ unitId, label, lanes[] }`). v1
passes one; multi-character comparison adds more, each rendered as its
own labelled block of lanes — either stacked per-player or (a later
toggle) grouped by lane type. No structural change needed here.

The view (`src/views/timeline.ts`) resolves spell/unit names and maps the
three streams onto the six lanes.
