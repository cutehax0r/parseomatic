// Damage Taken -- per-character breakdown of the damage the selected
// player took over the current window, by attacker + spell. Structured
// like `spell-breakdown-view.ts` (identity header, chart, distribution
// table, share donut), but the chart is a stacked **bar** chart of
// fixed-width chunks (5s/10s, not a continuous rate) with death markers,
// since incoming damage is bursty and "which hit landed near this death"
// reads better as discrete chunks than a smoothed curve. Unlike the
// Damage/Healing views, `spell_breakdown`'s `damageTaken` metric matches
// the player directly (no pet fold) and groups by the *attacker's*
// `(spell, source)` -- see `src-tauri/src/damage.rs`.

import "../ui/widgets"; // registers bar-chart / pie-chart / encounter-title / ...

import { buildView, type BuiltView } from "../ui/panel";
import { getWidget } from "../ui/registry";
import { createViewContext, type ViewContext } from "../ui/context";
import { spellBreakdown } from "../ui/spell-breakdown";
import { paletteColor } from "../ui/palette";
import type { NodeSpec, Widget } from "../ui/spec";
import type { HitDist, SpellBreakdown, SpellStat } from "../types";
import type { ChartDeath } from "../ui/widgets/line-chart";
import { formatCompact, formatDuration, formatUnitName } from "../format";

// The chart/donut still cap at the top 8 (readability) -- everything past
// that folds into one grey "Other" band/slice. The table has no such cap
// (see paintTable): every row gets its own color from `paletteColor`.
const OTHER_COLOR = "var(--text-faint)";
const TOP_N = 8;
const HEAD_2 = ["min", "max", "avg", "med", "σ"];

// Fixed-width bar chunks: 5s for anything up to ~10 min (most pulls),
// widening only so a long custom range doesn't render hundreds of bars.
function pickChunkSeconds(totalSeconds: number): number {
  if (totalSeconds <= 600) return 5;
  if (totalSeconds <= 1800) return 10;
  return Math.max(10, Math.ceil(totalSeconds / 300 / 5) * 5);
}

function sourceLabel(c: ViewContext, s: SpellStat): string {
  const spell = s.spellId != null ? c.spells[s.spellId]?.name || `#${s.spellId}` : "Melee";
  const attacker = c.units[s.sourceUnit]?.name;
  return attacker ? `${spell} — ${attacker}` : spell;
}

function distCells(d: HitDist): string[] {
  if (d.count === 0) return ["—", "—", "—", "—", "—"];
  return [
    formatCompact(d.min),
    formatCompact(d.max),
    formatCompact(Math.round(d.mean)),
    formatCompact(Math.round(d.median)),
    formatCompact(Math.round(d.stddev)),
  ];
}

function cell(text: string, cls: string): HTMLElement {
  const e = document.createElement("div");
  e.className = cls;
  e.textContent = text;
  return e;
}

// The name cell for a table row: a color swatch (from the same cycling
// palette the chart/donut use for their top-N, continuing past it for
// every row after) plus the label, truncating independently so a long
// name doesn't push the swatch off.
function nameCell(text: string, color: string): HTMLElement {
  const e = document.createElement("div");
  e.className = "spell-td spell-td-name";
  const dot = document.createElement("i");
  dot.className = "spell-td-swatch";
  dot.style.background = color;
  const label = document.createElement("span");
  label.className = "spell-td-name-text";
  label.textContent = text;
  e.append(dot, label);
  return e;
}

const spec: NodeSpec = {
  kind: "panel",
  columns: 1,
  children: [
    { kind: "widget", type: "encounter-title", id: "title", props: { name: "", badge: "" } },
    { kind: "widget", type: "section-heading", id: "h-chart", props: { text: "Damage taken over time" } },
    {
      kind: "widget",
      type: "bar-chart",
      id: "chart",
      span: 1,
      props: { title: "Damage taken", series: [], buckets: [], startMs: 0, endMs: 0, deaths: [] },
    },
    { kind: "widget", type: "section-heading", id: "h-sources", props: { text: "By source" } },
  ],
};

let ctx: ViewContext | null = null;
let built: BuiltView | null = null;
let pie: Widget | null = null;
let tableHost: HTMLElement | null = null;
let paintSeq = 0;

export function renderDamageTaken(): void {
  const mount = document.querySelector<HTMLElement>("#damage-taken-mount");
  if (!mount) return;

  if (!ctx) {
    ctx = createViewContext();
    ctx.subscribe(() => void paint());
  }
  if (!built) {
    built = buildView(spec, mount, ctx);

    const detail = document.createElement("div");
    detail.className = "spell-detail";
    tableHost = document.createElement("div");
    tableHost.className = "spell-table-wrap";
    const pieHost = document.createElement("div");
    pieHost.className = "spell-pie-wrap";
    pie = getWidget("pie-chart")({ title: "Damage taken share", slices: [] }, ctx);
    pieHost.append(pie.element);
    detail.append(tableHost, pieHost);
    mount.append(detail);
  }
  void paint();
}

async function paint(): Promise<void> {
  if (!ctx || !built || !pie || !tableHost) return;
  const seq = ++paintSeq;

  const hintEl = document.querySelector<HTMLElement>("#damage-taken-hint");
  const mount = document.querySelector<HTMLElement>("#damage-taken-mount");

  const unitId = ctx.selectedPlayer;
  const unit = unitId !== null ? ctx.units[unitId] : undefined;

  const encs = ctx.encounters;
  const extentStart = encs.length ? Math.min(...encs.map((e) => e.startMs)) : 0;
  const extentEnd = encs.length ? Math.max(...encs.map((e) => e.endMs)) : 0;
  const isWholeLog = ctx.range.startMs <= extentStart && ctx.range.endMs >= extentEnd;
  const ready = !!unit && unitId !== null && ctx.range.endMs > ctx.range.startMs && !isWholeLog;

  if (hintEl) {
    hintEl.hidden = ready;
    hintEl.textContent = !unit
      ? "Select a player from the toolbar to see the damage they took."
      : "Pick an encounter or a custom range — damage-taken needs a bounded window.";
  }
  if (mount) mount.hidden = !ready;
  if (!ready || !unit || unitId === null) return;

  const { startMs, endMs } = ctx.range;
  const seconds = Math.max(1, (endMs - startMs) / 1000);
  const chunkSeconds = pickChunkSeconds(seconds);
  const bucketCount = Math.max(1, Math.round(seconds / chunkSeconds));

  const data = await spellBreakdown({ unitId, startMs, endMs, buckets: bucketCount, metric: "damageTaken" });
  if (seq !== paintSeq) return; // a newer selection is painting
  if (!data) return;

  const deaths: ChartDeath[] = ctx.deaths
    .filter((d) => d.unitId === unitId && d.timestampMs >= startMs && d.timestampMs <= endMs)
    .map((d) => ({ t: d.timestampMs, label: d.playerName }));

  built.get("title")?.update({
    name: formatUnitName(unit),
    badge: `${formatCompact(data.total)} taken`,
    detail: `${formatDuration(endMs - startMs)} · ${formatCompact(data.total / seconds)}/s`,
  });

  paintChart(data, deaths);
  paintPie(data);
  paintTable(data, seconds);
}

function paintChart(data: SpellBreakdown, deaths: ChartDeath[]): void {
  const c = ctx!;
  const top = data.spells.slice(0, TOP_N);
  const rest = data.spells.slice(TOP_N);
  const n = data.spells[0]?.buckets.length ?? 0;

  const series = top.map((s, i) => ({ key: `s${i}`, label: sourceLabel(c, s), color: paletteColor(i) }));
  if (rest.length > 0) series.push({ key: "other", label: `Other (${rest.length})`, color: OTHER_COLOR });

  const buckets: Array<{ tMid: number } & Record<string, number>> = [];
  for (let i = 0; i < n; i++) {
    const row: { tMid: number } & Record<string, number> = {
      tMid: data.startMs + (i + 0.5) * data.bucketMs,
    };
    top.forEach((s, k) => (row[`s${k}`] = s.buckets[i] ?? 0));
    if (rest.length > 0) row.other = rest.reduce((sum, s) => sum + (s.buckets[i] ?? 0), 0);
    buckets.push(row);
  }

  built!.get("chart")?.update({
    title: "Damage taken",
    series,
    buckets,
    startMs: data.startMs,
    endMs: data.endMs,
    deaths,
  });
}

function paintPie(data: SpellBreakdown): void {
  const c = ctx!;
  const top = data.spells.slice(0, TOP_N);
  const rest = data.spells.slice(TOP_N);
  const slices = top.map((s, i) => ({ label: sourceLabel(c, s), value: s.total, color: paletteColor(i) }));
  if (rest.length > 0) {
    slices.push({
      label: `Other (${rest.length})`,
      value: rest.reduce((sum, s) => sum + s.total, 0),
      color: OTHER_COLOR,
    });
  }
  pie!.update({ title: "Damage taken share", slices });
}

function paintTable(data: SpellBreakdown, seconds: number): void {
  const c = ctx!;
  const host = tableHost!;
  host.replaceChildren();
  const table = document.createElement("div");
  table.className = "spell-table";

  for (const h of ["Source", "Hits", "Total", "Per sec"]) table.append(cell(h, "spell-th"));
  table.append(cell("Normal", "spell-th spell-th-group"));
  table.append(cell("Crit", "spell-th spell-th-group"));
  for (let i = 0; i < 4; i++) table.append(cell("", "spell-th spell-th-sub"));
  for (const h of [...HEAD_2, ...HEAD_2]) table.append(cell(h, "spell-th spell-th-sub"));

  data.spells.forEach((s, i) => {
    table.append(nameCell(sourceLabel(c, s), paletteColor(i)));
    table.append(cell(String(s.hits), "spell-td spell-td-num"));
    table.append(cell(formatCompact(s.total), "spell-td spell-td-num"));
    table.append(cell(formatCompact(s.total / seconds), "spell-td spell-td-num"));
    for (const v of distCells(s.normal)) table.append(cell(v, "spell-td spell-td-num"));
    for (const v of distCells(s.crit)) table.append(cell(v, "spell-td spell-td-num spell-td-crit"));
  });

  host.append(table);
}
