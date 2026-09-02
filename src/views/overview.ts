// Overview -- the first Panel/Widget view and the first consumer of the
// encounter selector. Assumes a single selected encounter; anything else
// (custom range, "Full log") shows an empty state.
//
// Real via query_events: damage/healing totals, DPS/HPS, the player table
// (grouped by sourceOwner, so pet damage folds into the owning player).
// Still MOCK: the chart's time series -- it needs time-bucketed sums, a
// `bucket` extension to QuerySpec that isn't built yet.

import "../ui/widgets"; // registers built-in widgets

import { buildView, type BuiltView } from "../ui/panel";
import { createViewContext, type ViewContext } from "../ui/context";
import type { NodeSpec } from "../ui/spec";
import type { EncounterRow } from "../types";
import { formatCompact, formatDuration, formatEncounterResult } from "../format";
import type { ChartBucket, ChartDeath } from "../ui/widgets/line-chart";
import type { PlayerRow } from "../ui/widgets/player-table";

const DAMAGE_KINDS = [
  "SPELL_DAMAGE",
  "SPELL_PERIODIC_DAMAGE",
  "RANGE_DAMAGE",
  "SWING_DAMAGE",
  "SPELL_BUILDING_DAMAGE",
];
const HEAL_KINDS = ["SPELL_HEAL", "SPELL_PERIODIC_HEAL"];

const overviewSpec: NodeSpec = {
  kind: "panel",
  columns: 1,
  children: [
    { kind: "widget", type: "encounter-title", id: "title", props: { name: "", meta: "" } },
    { kind: "widget", type: "section-heading", id: "h-stats", props: { text: "Stats" } },
    {
      kind: "panel",
      columns: 6,
      children: [
        { kind: "widget", type: "stat-tile", id: "dmg", props: { label: "Damage done", value: "—" } },
        { kind: "widget", type: "stat-tile", id: "dps", props: { label: "DPS", value: "—" } },
        { kind: "widget", type: "stat-tile", id: "heal", props: { label: "Healing done", value: "—" } },
        { kind: "widget", type: "stat-tile", id: "hps", props: { label: "HPS", value: "—" } },
        { kind: "widget", type: "stat-tile", id: "deaths", props: { label: "Deaths", value: "—" } },
        { kind: "widget", type: "stat-tile", id: "result", props: { label: "Result", value: "—" } },
        {
          kind: "widget",
          type: "line-chart",
          id: "chart",
          span: 6,
          props: { buckets: [], deaths: [], startMs: 0, endMs: 0 },
        },
      ],
    },
    { kind: "widget", type: "section-heading", id: "h-players", props: { text: "Players" } },
    {
      kind: "panel",
      columns: 1,
      children: [{ kind: "widget", type: "player-table", id: "players", span: 1, props: { rows: [] } }],
    },
  ],
};

let ctx: ViewContext | null = null;
let built: BuiltView | null = null;
// Bumped on every paint; an in-flight paint whose seq is stale (a newer
// encounter selection started painting) bails before touching the DOM.
let paintSeq = 0;

export function renderOverview(): void {
  const mount = document.querySelector<HTMLElement>("#overview-mount");
  if (!mount) return;

  if (!ctx) {
    ctx = createViewContext();
    ctx.subscribe(() => void paint());
  }
  if (!built) {
    built = buildView(overviewSpec, mount, ctx);
  }
  void paint();
}

async function paint(): Promise<void> {
  if (!ctx || !built) return;
  const seq = ++paintSeq;

  const emptyEl = document.querySelector<HTMLElement>("#overview-empty");
  const mount = document.querySelector<HTMLElement>("#overview-mount");

  const src = ctx.range.source;
  const e = src.kind === "encounter" ? ctx.encounters[src.index] : undefined;
  const ready = !!e && !e.isTrash;

  if (emptyEl) emptyEl.hidden = ready;
  if (mount) mount.hidden = !ready;
  if (!e || !ready) return;

  const result = formatEncounterResult(e); // Kill / Wipe / ?
  const durText = formatDuration(e.durationMs);
  const seconds = Math.max(1, e.durationMs / 1000);
  const tone = e.success === true ? "kill" : e.success === false ? "wipe" : undefined;
  const deathCount = ctx.deaths.filter(
    (d) => d.timestampMs >= e.startMs && d.timestampMs <= e.endMs,
  ).length;

  const bounds = { startMs: e.startMs, endMs: e.endMs };
  const [damage, healing, playerRows] = await Promise.all([
    sumAmount(bounds, DAMAGE_KINDS),
    sumAmount(bounds, HEAL_KINDS),
    playerDamageRows(bounds, seconds),
  ]);
  if (seq !== paintSeq) return; // a newer selection is painting

  const chart = mockChartSeries(e);

  built.get("title")?.update({ name: e.name, meta: `${result || "In progress"} · ${durText}`, tone });
  built.get("dmg")?.update({ label: "Damage done", value: formatCompact(damage) });
  built.get("dps")?.update({ label: "DPS", value: formatCompact(damage / seconds) });
  built.get("heal")?.update({ label: "Healing done", value: formatCompact(healing) });
  built.get("hps")?.update({ label: "HPS", value: formatCompact(healing / seconds) });
  built.get("deaths")?.update({ label: "Deaths", value: String(deathCount) });
  built.get("result")?.update({ label: result || "Result", value: durText, tone });
  built.get("chart")?.update({ ...chart, startMs: e.startMs, endMs: e.endMs });
  built.get("players")?.update({ rows: playerRows });
}

async function sumAmount(
  bounds: { startMs: number; endMs: number },
  kinds: string[],
): Promise<number> {
  const rows = await ctx!.query<{ total: number }>({
    ...bounds,
    where: [{ field: "kind", op: "in", value: kinds }],
    aggregate: [{ op: "sum", field: "amount", as: "total" }],
  });
  return rows[0]?.total ?? 0;
}

async function playerDamageRows(
  bounds: { startMs: number; endMs: number },
  seconds: number,
): Promise<PlayerRow[]> {
  const rows = await ctx!.query<{ sourceOwner: number; dmg: number }>({
    ...bounds,
    where: [{ field: "kind", op: "in", value: DAMAGE_KINDS }],
    groupBy: ["sourceOwner"],
    aggregate: [{ op: "sum", field: "amount", as: "dmg" }],
  });
  const units = ctx!.units;
  return rows
    .map((r) => ({ unit: units[r.sourceOwner], dmg: r.dmg }))
    .filter((r) => r.unit?.kind === "Player")
    .map((r) => ({ name: r.unit!.name, damage: r.dmg, dps: r.dmg / seconds }))
    .sort((a, b) => b.damage - a.damage);
}

// ---- MOCK -- the chart series still needs time-bucketed sums ----------
// TODO: a `bucket: { field: "time", width: N }` extension to QuerySpec so
// the backend returns per-interval sums; then this goes away. Death marks
// below are real.

function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mockChartSeries(e: EncounterRow): { buckets: ChartBucket[]; deaths: ChartDeath[] } {
  const rng = seededRng(e.startMs ^ (e.encounterId << 8));
  const seconds = Math.max(1, e.durationMs / 1000);
  const raidDps = 800_000 + rng() * 1_400_000;
  const hps0 = raidDps * (0.45 + rng() * 0.25);

  const n = Math.min(900, Math.max(40, Math.round(seconds)));
  const buckets: ChartBucket[] = [];
  let dmgLevel = raidDps;
  let healLevel = hps0;
  for (let i = 0; i < n; i++) {
    const frac = (i + 0.5) / n;
    dmgLevel += (rng() - 0.5) * raidDps * 0.25;
    healLevel += (rng() - 0.5) * hps0 * 0.3;
    const ramp = 0.7 + 0.5 * frac;
    buckets.push({
      tMid: e.startMs + frac * e.durationMs,
      damage: Math.max(0, dmgLevel * ramp),
      healing: Math.max(0, healLevel * ramp),
    });
  }

  const deaths: ChartDeath[] = (ctx?.deaths ?? [])
    .filter((d) => d.timestampMs >= e.startMs && d.timestampMs <= e.endMs)
    .map((d) => ({ t: d.timestampMs, label: d.playerName }));

  return { buckets, deaths };
}
