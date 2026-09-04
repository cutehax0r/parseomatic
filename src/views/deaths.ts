// Deaths -- per-character post-mortem: for each of the selected player's
// deaths in the current range, a 15s-before-death HP trace (green bars =
// healed, red = damaged, vertical rules = any death -- this player's own
// or another player's, within the same window) plus the raw event
// sequence leading up to it. More than one death in range gets a small
// tab strip to switch between them, rather than stacking every death's
// chart+table at once.

import "../ui/widgets"; // registers hp-chart / encounter-title / ...

import { buildView, type BuiltView } from "../ui/panel";
import { getWidget } from "../ui/registry";
import { createViewContext, type ViewContext } from "../ui/context";
import { deathDetail } from "../ui/death-detail";
import type { NodeSpec, Widget } from "../ui/spec";
import type { DeathDetail, DeathRow } from "../types";
import type { ChartDeath } from "../ui/widgets/line-chart";
import type { HpChartProps, HpSampleBar } from "../ui/widgets/hp-chart";
import { formatCompact, formatUnitName } from "../format";

// Mirrors `main.ts`'s private `RawEventRow` -- not exported from types.ts,
// so duplicated here rather than reaching into main.ts's module scope.
interface RawEventRow {
  row: number;
  timestampMs: number;
  kind: string;
  sourceUnitId: number | null;
  targetUnitId: number | null;
  spellId: number | null;
  position: [number, number] | null;
  details: string;
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function cell(text: string, cls: string): HTMLElement {
  const e = document.createElement("div");
  e.className = cls;
  e.textContent = text;
  return e;
}

const spec: NodeSpec = {
  kind: "panel",
  columns: 1,
  children: [{ kind: "widget", type: "encounter-title", id: "title", props: { name: "", badge: "" } }],
};

let ctx: ViewContext | null = null;
let built: BuiltView | null = null;
let bodyHost: HTMLElement | null = null;
let hpChart: Widget | null = null;
let paintSeq = 0;
let selectedDeathIdx = 0;

export function renderDeaths(): void {
  const mount = document.querySelector<HTMLElement>("#deaths-mount");
  if (!mount) return;

  if (!ctx) {
    ctx = createViewContext();
    ctx.subscribe(() => void paint());
  }
  if (!built) {
    built = buildView(spec, mount, ctx);
    bodyHost = document.createElement("div");
    bodyHost.className = "deaths-body";
    mount.append(bodyHost);
  }
  void paint();
}

async function paint(): Promise<void> {
  if (!ctx || !built || !bodyHost) return;
  const seq = ++paintSeq;

  const hintEl = document.querySelector<HTMLElement>("#deaths-hint");
  const mount = document.querySelector<HTMLElement>("#deaths-mount");

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
      ? "Select a player from the toolbar to see their deaths."
      : "Pick an encounter or a custom range — deaths needs a bounded window.";
  }
  if (mount) mount.hidden = !ready;
  if (!ready || !unit || unitId === null) return;

  const { startMs, endMs } = ctx.range;
  const deaths = ctx.deaths
    .filter((d) => d.unitId === unitId && d.timestampMs >= startMs && d.timestampMs <= endMs)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  built.get("title")?.update({
    name: formatUnitName(unit),
    badge: deaths.length === 1 ? "1 death" : `${deaths.length} deaths`,
  });

  if (selectedDeathIdx >= deaths.length) selectedDeathIdx = 0;

  await renderBody(deaths, unitId, seq);
}

async function renderBody(deaths: DeathRow[], unitId: number, seq: number): Promise<void> {
  const host = bodyHost!;
  host.replaceChildren();
  hpChart?.destroy?.();
  hpChart = null;

  if (deaths.length === 0) {
    const msg = document.createElement("p");
    msg.className = "deaths-empty";
    msg.textContent = "No deaths in this window.";
    host.append(msg);
    return;
  }

  if (deaths.length > 1) {
    const tabs = document.createElement("div");
    tabs.className = "deaths-tabs";
    deaths.forEach((d, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "deaths-tab" + (i === selectedDeathIdx ? " deaths-tab-active" : "");
      btn.textContent = `Death ${i + 1} · ${formatClock(d.timestampMs)}`;
      btn.addEventListener("click", () => {
        if (selectedDeathIdx === i) return;
        selectedDeathIdx = i;
        void renderBody(deaths, unitId, seq);
      });
      tabs.append(btn);
    });
    host.append(tabs);
  }

  const death = deaths[selectedDeathIdx];
  const detail = await deathDetail(unitId, death.timestampMs);
  if (seq !== paintSeq) return; // a newer selection is painting
  if (!detail) return;

  const block = document.createElement("div");
  block.className = "death-block";

  const lastDamage = [...detail.samples].reverse().find((s) => !s.isHeal);
  const killer = lastDamage ? ctx!.units[lastDamage.sourceUnit] : undefined;
  const heading = document.createElement("h3");
  heading.className = "death-block-heading";
  heading.textContent = killer
    ? `${formatClock(death.timestampMs)} — killed by ${formatUnitName(killer)}`
    : formatClock(death.timestampMs);
  block.append(heading);

  const chartHost = document.createElement("div");
  block.append(chartHost);
  hpChart = getWidget("hp-chart")(buildHpChartProps(detail), ctx!);
  chartHost.append(hpChart.element);

  const tableHost = document.createElement("div");
  tableHost.className = "death-raw-table-wrap";
  block.append(tableHost);

  host.append(block);

  await paintRawTable(tableHost, unitId, detail.startMs, detail.endMs, seq);
}

function buildHpChartProps(detail: DeathDetail): HpChartProps {
  const c = ctx!;
  const samples: HpSampleBar[] = detail.samples.map((s) => {
    const source = c.units[s.sourceUnit]?.name ?? "Unknown";
    const spell = s.spellId != null ? c.spells[s.spellId]?.name || `#${s.spellId}` : "Melee";
    const sign = s.isHeal ? "+" : "-";
    return {
      t: s.timestampMs,
      pct: s.maxHp > 0 ? (s.currentHp / s.maxHp) * 100 : 0,
      isHeal: s.isHeal,
      label: `${spell} — ${source} (${sign}${formatCompact(s.amount)})`,
    };
  });

  // Any death within this window, not just the player's own -- helps
  // read a wipe's chain of deaths on one chart.
  const chartDeaths: ChartDeath[] = c.deaths
    .filter((d) => d.timestampMs >= detail.startMs && d.timestampMs <= detail.endMs)
    .map((d) => ({ t: d.timestampMs, label: d.playerName }));

  return { title: "Health", startMs: detail.startMs, endMs: detail.endMs, samples, deaths: chartDeaths };
}

async function paintRawTable(host: HTMLElement, unitId: number, startMs: number, endMs: number, seq: number): Promise<void> {
  const [bySource, byTarget] = await Promise.all([
    ctx!.query<RawEventRow>({ startMs, endMs, where: [{ field: "sourceUnit", op: "eq", value: unitId }] }),
    ctx!.query<RawEventRow>({ startMs, endMs, where: [{ field: "targetUnit", op: "eq", value: unitId }] }),
  ]);
  if (seq !== paintSeq) return;

  const merged = new Map<number, RawEventRow>();
  for (const r of [...bySource, ...byTarget]) merged.set(r.row, r);
  const rows = Array.from(merged.values()).sort((a, b) => a.timestampMs - b.timestampMs);

  const c = ctx!;
  const table = document.createElement("div");
  table.className = "death-raw-table";
  for (const h of ["Time", "Kind", "Source", "Target", "Spell", "Details"]) table.append(cell(h, "death-raw-th"));

  for (const r of rows) {
    const source = r.sourceUnitId !== null ? c.units[r.sourceUnitId] : undefined;
    const target = r.targetUnitId !== null ? c.units[r.targetUnitId] : undefined;
    const spell = r.spellId !== null ? c.spells[r.spellId] : undefined;
    table.append(cell(formatClock(r.timestampMs), "death-raw-td"));
    table.append(cell(r.kind, "death-raw-td"));
    table.append(cell(source ? formatUnitName(source) : "", "death-raw-td"));
    table.append(cell(target ? formatUnitName(target) : "", "death-raw-td"));
    table.append(cell(spell?.name ?? "", "death-raw-td"));
    table.append(cell(r.details, "death-raw-td death-raw-td-details"));
  }

  host.replaceChildren(table);
}
