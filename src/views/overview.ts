// Overview -- the first Panel/Widget view and the first consumer of the
// encounter selector. Assumes a single selected encounter; anything else
// (custom range, "Full log") shows an empty state.
//
// All numbers are real via query_events: one bucketed query yields the
// chart's four time series (damage and healing, each split player-side vs
// creature) and, summed client-side, the stat-tile totals; a second
// grouped query yields the player table (grouped by sourceOwner, so pet
// damage folds into the owning player). Death markers come from the
// loaded deaths list.

import "../ui/widgets"; // registers built-in widgets

import { buildView, type BuiltView } from "../ui/panel";
import { createViewContext, type ViewContext } from "../ui/context";
import type { NodeSpec } from "../ui/spec";
import type { EncounterRow } from "../types";
import { formatCompact, formatDifficulty, formatDuration, formatEncounterResult } from "../format";
import type { ChartDeath } from "../ui/widgets/line-chart";
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
    { kind: "widget", type: "encounter-title", id: "title", props: { name: "", badge: "" } },
    { kind: "widget", type: "section-heading", id: "h-stats", props: { text: "Stats" } },
    {
      kind: "panel",
      columns: 4,
      children: [
        { kind: "widget", type: "stat-tile", id: "dmg", props: { label: "Damage", value: "—" } },
        { kind: "widget", type: "stat-tile", id: "heal", props: { label: "Healing", value: "—" } },
        { kind: "widget", type: "stat-tile", id: "deaths", props: { label: "Deaths", value: "—" } },
        { kind: "widget", type: "stat-tile", id: "progress", props: { label: "Progress", value: "—" } },
        {
          kind: "widget",
          type: "line-chart",
          id: "chart",
          span: 4,
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
  // ~1 bucket/second, capped near the chart's pixel width.
  const bucketCount = Math.min(800, Math.max(60, Math.round(seconds)));
  const [series, playerRows] = await Promise.all([
    damageHealingSeries(bounds, bucketCount),
    playerDamageRows(bounds, seconds),
  ]);
  if (seq !== paintSeq) return; // a newer selection is painting

  const playerDmg = series.reduce((s, r) => s + r.player, 0);
  const healing = series.reduce((s, r) => s + r.playerHeal, 0);
  const buckets = series.map((r) => ({
    tMid: r.tMid,
    player: r.player,
    healing: r.playerHeal,
    npc: r.npc,
    npcHeal: r.npcHeal,
  }));
  const deaths = deathMarkers(e);

  built.get("title")?.update({ name: e.name, badge: durText, tone, detail: formatDifficulty(e) });
  built.get("dmg")?.update({
    label: "Damage",
    value: formatCompact(playerDmg),
    sub: `${formatCompact(playerDmg / seconds)} DPS`,
  });
  built.get("heal")?.update({
    label: "Healing",
    value: formatCompact(healing),
    sub: `${formatCompact(healing / seconds)} HPS`,
  });
  built.get("deaths")?.update({ label: "Deaths", value: String(deathCount) });
  // "Progress": on a kill, the word "Kill"; on a wipe, the boss's health %
  // when the pull ended -- but that needs boss-HP + phase logic
  // (docs/boss-parsers.md), so for now a wipe just shows "Wipe". Duration
  // rides along in the sub slot, like DPS under Damage.
  built.get("progress")?.update({ label: "Progress", value: result || "?", sub: durText, tone });
  built.get("chart")?.update({ buckets, deaths, startMs: e.startMs, endMs: e.endMs, displaySeconds: 8 });
  built.get("players")?.update({ rows: playerRows });
}

// One bucketed pass -> per-slice sums, each split player-side (players +
// their pets) vs creature (bosses/adds): damage and healing. Grand totals
// shown in the stat tiles are the client-side sum of the player-side
// columns.
type Slice = { tMid: number; player: number; npc: number; playerHeal: number; npcHeal: number };
function damageHealingSeries(
  bounds: { startMs: number; endMs: number },
  count: number,
): Promise<Slice[]> {
  const dmg = { field: "kind", op: "in", value: DAMAGE_KINDS } as const;
  const heal = { field: "kind", op: "in", value: HEAL_KINDS } as const;
  const byPlayer = { field: "sourceOwnerKind", op: "eq", value: "Player" } as const;
  const byNpc = { field: "sourceOwnerKind", op: "eq", value: "Creature" } as const;
  return ctx!.query<Slice>({
    ...bounds,
    bucket: { count },
    aggregate: [
      { op: "sum", field: "amount", as: "player", where: [dmg, byPlayer] },
      { op: "sum", field: "amount", as: "npc", where: [dmg, byNpc] },
      { op: "sum", field: "amount", as: "playerHeal", where: [heal, byPlayer] },
      { op: "sum", field: "amount", as: "npcHeal", where: [heal, byNpc] },
    ],
  });
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
  const players = rows
    .map((r) => ({ unit: units[r.sourceOwner], dmg: r.dmg }))
    .filter((r) => r.unit?.kind === "Player");
  const total = players.reduce((s, r) => s + r.dmg, 0);
  return players
    .map((r) => ({
      name: r.unit!.name,
      damage: r.dmg,
      dps: r.dmg / seconds,
      share: total > 0 ? r.dmg / total : 0,
    }))
    .sort((a, b) => b.damage - a.damage);
}

function deathMarkers(e: EncounterRow): ChartDeath[] {
  return (ctx?.deaths ?? [])
    .filter((d) => d.timestampMs >= e.startMs && d.timestampMs <= e.endMs)
    .map((d) => ({ t: d.timestampMs, label: d.playerName }));
}
