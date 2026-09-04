// Shared body for the per-character "Damage" and "Healing" views -- they
// differ only in the metric (`_DAMAGE` vs `_HEAL`) and a handful of
// labels, so `damage.ts` / `healing.ts` are thin wrappers around this.
//
// Layout: an identity header, a stacked area chart of the metric by spell
// over time (top 8 + "Other"), a per-spell distribution table
// (min/max/avg/median/stddev, normal vs crit), and a share donut.
// One `spell_breakdown` command call, cached by `src/ui/spell-breakdown.ts`.

import "../ui/widgets"; // registers area-chart / pie-chart / encounter-title / ...

import { buildView, type BuiltView } from "../ui/panel";
import { getWidget } from "../ui/registry";
import { createViewContext, type ViewContext } from "../ui/context";
import { spellBreakdown, type BreakdownMetric } from "../ui/spell-breakdown";
import type { NodeSpec, Widget } from "../ui/spec";
import type { HitDist, SpellBreakdown, SpellStat } from "../types";
import { formatCompact, formatDuration, formatUnitName } from "../format";

// 8 distinct hues for the top spells, then a grey for the "Other" roll-up.
const PALETTE = [
  "var(--ctp-blue)",
  "var(--ctp-peach)",
  "var(--ctp-green)",
  "var(--ctp-mauve)",
  "var(--ctp-yellow)",
  "var(--ctp-teal)",
  "var(--ctp-red)",
  "var(--ctp-sky)",
];
const OTHER_COLOR = "var(--text-faint)";
const TOP_N = 8;

export interface SpellBreakdownViewConfig {
  metric: BreakdownMetric;
  mountSel: string; // "#damage-mount"
  hintSel: string; // "#damage-hint"
  chartHeading: string; // "Damage over time"
  chartTitle: string; // "DPS"
  rateUnit: string; // "DPS" / "HPS"
  totalNoun: string; // "dmg" / "heal"
  shareTitle: string; // "Damage share"
  hintNoun: string; // "damage" / "healing"
}

const HEAD_2 = ["min", "max", "avg", "med", "σ"];

function spellLabel(c: ViewContext, s: SpellStat): string {
  const base = s.spellId != null ? c.spells[s.spellId]?.name || `#${s.spellId}` : "Melee";
  if (!s.isPet) return base;
  const pet = c.units[s.sourceUnit]?.name ?? "pet";
  return `${base} (pet: ${pet})`;
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

// Returns the view's `render()` -- call it whenever the view becomes
// active or the selected player / range changes.
export function makeSpellBreakdownView(cfg: SpellBreakdownViewConfig): () => void {
  const spec: NodeSpec = {
    kind: "panel",
    columns: 1,
    children: [
      { kind: "widget", type: "encounter-title", id: "title", props: { name: "", badge: "" } },
      { kind: "widget", type: "section-heading", id: "h-chart", props: { text: cfg.chartHeading } },
      {
        kind: "widget",
        type: "area-chart",
        id: "chart",
        span: 1,
        props: { title: cfg.chartTitle, series: [], buckets: [], startMs: 0, endMs: 0 },
      },
      { kind: "widget", type: "section-heading", id: "h-spells", props: { text: "By spell" } },
    ],
  };

  let ctx: ViewContext | null = null;
  let built: BuiltView | null = null;
  let pie: Widget | null = null;
  let tableHost: HTMLElement | null = null;
  let paintSeq = 0;

  function render(): void {
    const mount = document.querySelector<HTMLElement>(cfg.mountSel);
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
      pie = getWidget("pie-chart")({ title: cfg.shareTitle, slices: [] }, ctx);
      pieHost.append(pie.element);
      detail.append(tableHost, pieHost);
      mount.append(detail);
    }
    void paint();
  }

  async function paint(): Promise<void> {
    if (!ctx || !built || !pie || !tableHost) return;
    const seq = ++paintSeq;

    const hintEl = document.querySelector<HTMLElement>(cfg.hintSel);
    const mount = document.querySelector<HTMLElement>(cfg.mountSel);

    const unitId = ctx.selectedPlayer;
    const unit = unitId !== null ? ctx.units[unitId] : undefined;

    // Needs a picked player and a concrete window (not the whole-log default).
    const encs = ctx.encounters;
    const extentStart = encs.length ? Math.min(...encs.map((e) => e.startMs)) : 0;
    const extentEnd = encs.length ? Math.max(...encs.map((e) => e.endMs)) : 0;
    const isWholeLog = ctx.range.startMs <= extentStart && ctx.range.endMs >= extentEnd;
    const ready = !!unit && unitId !== null && ctx.range.endMs > ctx.range.startMs && !isWholeLog;

    if (hintEl) {
      hintEl.hidden = ready;
      hintEl.textContent = !unit
        ? `Select a player from the toolbar to see their ${cfg.hintNoun}.`
        : `Pick an encounter or a custom range — ${cfg.hintNoun}-over-time needs a bounded window.`;
    }
    if (mount) mount.hidden = !ready;
    if (!ready || !unit || unitId === null) return;

    const { startMs, endMs } = ctx.range;
    const seconds = Math.max(1, (endMs - startMs) / 1000);
    const bucketCount = Math.min(800, Math.max(60, Math.round(seconds)));

    const data = await spellBreakdown({ unitId, startMs, endMs, buckets: bucketCount, metric: cfg.metric });
    if (seq !== paintSeq) return; // a newer selection is painting
    if (!data) return;

    built.get("title")?.update({
      name: formatUnitName(unit),
      badge: `${formatCompact(data.total)} ${cfg.totalNoun}`,
      detail: `${formatDuration(endMs - startMs)} · ${formatCompact(data.total / seconds)} ${cfg.rateUnit}`,
    });

    paintChart(data);
    paintPie(data);
    paintTable(data, seconds);
  }

  function paintChart(data: SpellBreakdown): void {
    const c = ctx!;
    const top = data.spells.slice(0, TOP_N);
    const rest = data.spells.slice(TOP_N);
    const n = data.spells[0]?.buckets.length ?? 0;

    const series = top.map((s, i) => ({ key: `s${i}`, label: spellLabel(c, s), color: PALETTE[i] }));
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
      title: cfg.chartTitle,
      series,
      buckets,
      startMs: data.startMs,
      endMs: data.endMs,
      displaySeconds: 8,
    });
  }

  function paintPie(data: SpellBreakdown): void {
    const c = ctx!;
    const top = data.spells.slice(0, TOP_N);
    const rest = data.spells.slice(TOP_N);
    const slices = top.map((s, i) => ({ label: spellLabel(c, s), value: s.total, color: PALETTE[i] }));
    if (rest.length > 0) {
      slices.push({
        label: `Other (${rest.length})`,
        value: rest.reduce((sum, s) => sum + s.total, 0),
        color: OTHER_COLOR,
      });
    }
    pie!.update({ title: cfg.shareTitle, slices });
  }

  function paintTable(data: SpellBreakdown, seconds: number): void {
    const c = ctx!;
    const host = tableHost!;
    host.replaceChildren();
    const table = document.createElement("div");
    table.className = "spell-table";

    for (const h of ["Spell", "Hits", "Total", cfg.rateUnit]) table.append(cell(h, "spell-th"));
    table.append(cell("Normal", "spell-th spell-th-group"));
    table.append(cell("Crit", "spell-th spell-th-group"));
    for (let i = 0; i < 4; i++) table.append(cell("", "spell-th spell-th-sub"));
    for (const h of [...HEAD_2, ...HEAD_2]) table.append(cell(h, "spell-th spell-th-sub"));

    for (const s of data.spells) {
      table.append(cell(spellLabel(c, s), "spell-td spell-td-name"));
      table.append(cell(String(s.hits), "spell-td spell-td-num"));
      table.append(cell(formatCompact(s.total), "spell-td spell-td-num"));
      table.append(cell(formatCompact(s.total / seconds), "spell-td spell-td-num"));
      for (const v of distCells(s.normal)) table.append(cell(v, "spell-td spell-td-num"));
      for (const v of distCells(s.crit)) table.append(cell(v, "spell-td spell-td-num spell-td-crit"));
    }

    host.append(table);
  }

  return render;
}
