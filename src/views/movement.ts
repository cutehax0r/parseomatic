// Movement -- per-character (raid view later): how the selected player
// moved over an encounter, reconstructed from the x/y on their combat-log
// events (see `docs/movement-view.md` for the data model).
//
// A square top-down "radar" of the player's route (rainbow trail =
// time), a movable playhead, and a side table of the player's
// cast/damage/heal events around the playhead moment. Below it:
// distance moved over time, styled like the Overview DPS/HPS line chart.

import "../ui/widgets"; // registers movement-path / movement-chart / ...

import { buildView, type BuiltView } from "../ui/panel";
import { createViewContext, type ViewContext } from "../ui/context";
import { movementSeries } from "../ui/movement-series";
import { movementEvents } from "../ui/movement-events";
import type { NodeSpec } from "../ui/spec";
import type { MovementChartDeath } from "../ui/widgets/movement-chart";
import type { MovementPathEvent } from "../ui/widgets/movement-path";
import { formatCompact, formatUnitName } from "../format";

const spec: NodeSpec = {
  kind: "panel",
  columns: 1,
  children: [
    { kind: "widget", type: "encounter-title", id: "title", props: { name: "", badge: "" } },
    {
      kind: "widget",
      type: "movement-path",
      id: "path",
      span: 1,
      props: { samples: [], deathSpans: [], events: [], startMs: 0, endMs: 0, fitBox: null, mapBox: null },
    },
    {
      kind: "widget",
      type: "movement-chart",
      id: "chart",
      span: 1,
      props: { buckets: [], deaths: [], startMs: 0, endMs: 0 },
    },
  ],
};

let ctx: ViewContext | null = null;
let built: BuiltView | null = null;
// Bumped per paint; a stale in-flight fetch bails before touching the DOM.
let paintSeq = 0;

export function renderMovement(): void {
  const mount = document.querySelector<HTMLElement>("#movement-mount");
  if (!mount) return;

  if (!ctx) {
    ctx = createViewContext();
    ctx.subscribe(() => void paint());
  }
  if (!built) {
    built = buildView(spec, mount, ctx);
  }
  void paint();
}

async function paint(): Promise<void> {
  if (!ctx || !built) return;
  const seq = ++paintSeq;

  const hintEl = document.querySelector<HTMLElement>("#movement-hint");
  const mount = document.querySelector<HTMLElement>("#movement-mount");

  const unitId = ctx.selectedPlayer;
  const unit = unitId !== null ? ctx.units[unitId] : undefined;

  // Like the Overview / Deaths views: needs a concrete window, not the
  // whole log (movement over a 4-hour night isn't a useful line).
  const encs = ctx.encounters;
  const extentStart = encs.length ? Math.min(...encs.map((e) => e.startMs)) : 0;
  const extentEnd = encs.length ? Math.max(...encs.map((e) => e.endMs)) : 0;
  const isWholeLog = ctx.range.startMs <= extentStart && ctx.range.endMs >= extentEnd;
  const ready = !!unit && unitId !== null && ctx.range.endMs > ctx.range.startMs && !isWholeLog;

  if (hintEl) {
    hintEl.hidden = ready;
    hintEl.textContent = !unit
      ? "Select a player from the toolbar to see how they moved."
      : "Pick an encounter or a custom range — movement needs a bounded window.";
  }
  if (mount) mount.hidden = !ready;
  if (!ready || !unit || unitId === null) return;

  const { startMs, endMs } = ctx.range;
  const seconds = Math.max(1, (endMs - startMs) / 1000);
  // ~1 bucket/second, capped near the chart's pixel width (matches the
  // Overview chart).
  const bucketCount = Math.min(800, Math.max(60, Math.round(seconds)));

  const series = await movementSeries(unitId, startMs, endMs, bucketCount);
  if (seq !== paintSeq) return; // a newer selection is painting
  if (!series) return;

  const buckets = series.buckets.map((distance, i) => ({
    tMid: series.startMs + (i + 0.5) * series.bucketMs,
    distance,
  }));
  const deaths: MovementChartDeath[] = series.deathSpans.map((d) => ({
    t: d.startMs,
    label: formatUnitName(unit),
  }));
  const pathBase = {
    samples: series.samples,
    deathSpans: series.deathSpans,
    startMs: series.startMs,
    endMs: series.endMs,
    fitBox: series.fitBox,
    mapBox: series.mapBox,
  };

  built.get("title")?.update({
    name: formatUnitName(unit),
    badge: `${formatCompact(series.total)} yd`,
  });
  built.get("path")?.update({ ...pathBase, events: [] });
  built.get("chart")?.update({ buckets, deaths, startMs: series.startMs, endMs: series.endMs });

  // The side table's events are a separate (often larger) fetch -- don't
  // block the path on them; fill in when they arrive.
  const rawEvents = await movementEvents(unitId, startMs, endMs);
  if (seq !== paintSeq || !rawEvents) return;
  const spells = ctx.spells;
  const units = ctx.units;
  const events: MovementPathEvent[] = rawEvents.map((e) => ({
    tMs: e.tMs,
    kind: e.kind,
    name: e.spellId != null ? (spells[e.spellId]?.name ?? `#${e.spellId}`) : "Melee",
    other: e.otherUnit != null ? (units[e.otherUnit]?.name ?? "?") : "",
    amount: e.amount,
  }));
  built.get("path")?.update({ ...pathBase, events });
}
