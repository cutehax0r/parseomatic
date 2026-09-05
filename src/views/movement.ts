// Movement -- per-character (raid view later): how the selected player
// moved over an encounter, reconstructed from the x/y on their combat-log
// events (see `docs/movement-view.md` for the data model).
//
// First graph: distance moved over time, styled like the Overview page's
// DPS/HPS line chart -- a single "yards per second" line with the
// player's death timestamps as vertical rules. A top-down path plot with
// a playback scrubber is still to come.

import "../ui/widgets"; // registers movement-chart / encounter-title / ...

import { buildView, type BuiltView } from "../ui/panel";
import { createViewContext, type ViewContext } from "../ui/context";
import { movementSeries } from "../ui/movement-series";
import type { NodeSpec } from "../ui/spec";
import type { MovementChartDeath } from "../ui/widgets/movement-chart";
import { formatCompact, formatUnitName } from "../format";

const spec: NodeSpec = {
  kind: "panel",
  columns: 1,
  children: [
    { kind: "widget", type: "encounter-title", id: "title", props: { name: "", badge: "" } },
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
  const deaths: MovementChartDeath[] = series.deaths.map((t) => ({ t, label: formatUnitName(unit) }));

  built.get("title")?.update({
    name: formatUnitName(unit),
    badge: `${formatCompact(series.total)} yd`,
  });
  built.get("chart")?.update({
    buckets,
    deaths,
    startMs: series.startMs,
    endMs: series.endMs,
  });
}
