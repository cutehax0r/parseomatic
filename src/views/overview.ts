// Overview -- the first Panel/Widget view and the first consumer of the
// encounter selector. Assumes a single selected encounter; anything else
// (custom range, "Full log") shows an empty state.
//
// Real data: title, kill/wipe, duration, death count. Everything that
// needs event aggregation (damage/healing totals, DPS/HPS, the player
// table, the chart series) is MOCK for now -- see mockEncounterStats.
// Wiring the real `query_events` + aggregate DSL is the next task.

import "../ui/widgets"; // registers built-in widgets

import { buildView, type BuiltView } from "../ui/panel";
import { createViewContext, type ViewContext } from "../ui/context";
import type { NodeSpec } from "../ui/spec";
import type { EncounterRow, DeathRow, UnitRow } from "../types";
import { formatCompact, formatDuration, formatEncounterResult } from "../format";
import type { ChartBucket, ChartDeath } from "../ui/widgets/line-chart";
import type { PlayerRow } from "../ui/widgets/player-table";

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

export function renderOverview(): void {
  const view = document.querySelector<HTMLElement>("#overview-view");
  const mount = document.querySelector<HTMLElement>("#overview-mount");
  if (!view || !mount) return;

  if (!ctx) {
    ctx = createViewContext();
    ctx.subscribe(() => paint());
  }
  if (!built) {
    built = buildView(overviewSpec, mount, ctx);
  }
  paint();
}

function paint(): void {
  if (!ctx || !built) return;
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
  const tone = e.success === true ? "kill" : e.success === false ? "wipe" : undefined;
  const deathCount = ctx.deaths.filter(
    (d) => d.timestampMs >= e.startMs && d.timestampMs <= e.endMs,
  ).length;

  const mock = mockEncounterStats(e, ctx.players, ctx.deaths);

  built.get("title")?.update({ name: e.name, meta: `${result || "In progress"} · ${durText}`, tone });
  built.get("dmg")?.update({ label: "Damage done", value: formatCompact(mock.damage) });
  built.get("dps")?.update({ label: "DPS", value: formatCompact(mock.dps) });
  built.get("heal")?.update({ label: "Healing done", value: formatCompact(mock.healing) });
  built.get("hps")?.update({ label: "HPS", value: formatCompact(mock.hps) });
  built.get("deaths")?.update({ label: "Deaths", value: String(deathCount) });
  built.get("result")?.update({ label: result || "Result", value: durText, tone });
  built.get("chart")?.update({
    buckets: mock.buckets,
    deaths: mock.deaths,
    startMs: e.startMs,
    endMs: e.endMs,
  });
  built.get("players")?.update({ rows: mock.players });
}

// ---- MOCK -- real numbers need query_events aggregation ----------------

interface MockStats {
  damage: number;
  dps: number;
  healing: number;
  hps: number;
  players: PlayerRow[];
  buckets: ChartBucket[];
  deaths: ChartDeath[];
}

// mulberry32 -- deterministic so a given encounter always mocks the same.
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

function mockEncounterStats(e: EncounterRow, players: UnitRow[], deaths: DeathRow[]): MockStats {
  const rng = seededRng(e.startMs ^ (e.encounterId << 8));
  const seconds = Math.max(1, e.durationMs / 1000);

  // MOCK roster: a stable per-encounter subset of the log-wide player
  // pool. Stands in for "who was actually present" -- players come and go
  // across a raid night, so this must never be the whole-log list.
  // TODO: real roster from query_events -- distinct player units with
  // damage/healing/cast activity inside [encounter.start_row, end_row].
  // Pet contributions (UnitRow.owner) roll up into the owning player's
  // row; pets are not their own rows. See docs/ui-widgets.md.
  const pool = players.length > 0 ? players.map((p) => p.name) : ["Player 1", "Player 2", "Player 3"];
  const raidSize = Math.min(pool.length, 16 + Math.floor(rng() * 7));
  const roster = pool
    .map((name) => ({ name, k: rng() }))
    .sort((a, b) => a.k - b.k)
    .slice(0, raidSize)
    .map((x) => x.name);

  const perPlayerDps = roster.map((name) => ({ name, w: 0.4 + rng() }));
  const totalW = perPlayerDps.reduce((s, p) => s + p.w, 0);
  const raidDps = 800_000 + rng() * 1_400_000;
  const damage = raidDps * seconds;
  const healing = damage * (0.45 + rng() * 0.25);

  const playerRows: PlayerRow[] = perPlayerDps
    .map((p) => {
      const dps = (raidDps * p.w) / totalW;
      return { name: p.name, dps, damage: dps * seconds };
    })
    .sort((a, b) => b.damage - a.damage);

  // ~1s buckets, capped to roughly the chart's pixel width.
  const n = Math.min(900, Math.max(40, Math.round(seconds)));
  const buckets: ChartBucket[] = [];
  let dmgLevel = raidDps;
  let healLevel = healing / seconds;
  for (let i = 0; i < n; i++) {
    const frac = (i + 0.5) / n;
    dmgLevel += (rng() - 0.5) * raidDps * 0.25;
    healLevel += (rng() - 0.5) * (healing / seconds) * 0.3;
    const ramp = 0.7 + 0.5 * frac; // slow build over the fight
    buckets.push({
      tMid: e.startMs + frac * e.durationMs,
      damage: Math.max(0, dmgLevel * ramp),
      healing: Math.max(0, healLevel * ramp),
    });
  }

  const deathMarks: ChartDeath[] = deaths
    .filter((d) => d.timestampMs >= e.startMs && d.timestampMs <= e.endMs)
    .map((d) => ({ t: d.timestampMs, label: d.playerName }));

  return {
    damage,
    dps: raidDps,
    healing,
    hps: healing / seconds,
    players: playerRows,
    buckets,
    deaths: deathMarks,
  };
}
