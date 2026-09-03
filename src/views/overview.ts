// Overview -- the first Panel/Widget view and the first consumer of the
// encounter selector. Assumes a single selected encounter; anything else
// (custom range, "Full log") shows an empty state.
//
// All numbers are real via query_events: one bucketed query yields the
// chart's four time series (damage and healing, each split player-side vs
// creature) and, summed client-side, the stat-tile totals; two more
// grouped queries yield the player table -- one by sourceOwner (pet damage
// / healing folds into the owning player, split own vs pet) and one by
// targetUnit (damage taken, players only). Death markers come from the
// loaded deaths list.

import "../ui/widgets"; // registers built-in widgets

import { buildView, type BuiltView } from "../ui/panel";
import { createViewContext, type ViewContext } from "../ui/context";
import type { NodeSpec } from "../ui/spec";
import type { EncounterRow } from "../types";
import {
  classColorVar,
  formatCompact,
  formatDifficulty,
  formatDuration,
  formatEncounterResult,
  formatRole,
  formatSpec,
  roleRank,
} from "../format";
import type { ChartDeath } from "../ui/widgets/line-chart";
import type { PlayerRow } from "../ui/widgets/player-table";
import { encounterStats } from "../ui/encounter-stats";
import type { PlayerStatsRow } from "../types";

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
  const encs = ctx.encounters;
  const e = src.kind === "encounter" ? encs[src.index] : undefined;

  // Render the overview for any concrete time window: a boss encounter, a
  // trash span, or a user-picked custom range. The chooser shows only when
  // nothing narrower than the whole log is selected (the default state).
  const extentStart = encs.length ? Math.min(...encs.map((x) => x.startMs)) : 0;
  const extentEnd = encs.length ? Math.max(...encs.map((x) => x.endMs)) : 0;
  const isWholeLog =
    !e && ctx.range.startMs <= extentStart && ctx.range.endMs >= extentEnd;
  const ready = !isWholeLog && ctx.range.endMs > ctx.range.startMs;

  if (emptyEl) emptyEl.hidden = ready;
  if (mount) mount.hidden = !ready;
  if (!ready) return;

  // The window we're overviewing -- a real encounter, or a synthetic
  // stand-in for a custom range so the rest of paint() is uniform.
  const win: EncounterRow = e ?? {
    name: "Custom range",
    encounterId: 0,
    difficultyId: 0,
    groupSize: 0,
    startMs: ctx.range.startMs,
    endMs: ctx.range.endMs,
    durationMs: ctx.range.endMs - ctx.range.startMs,
    success: null,
    isTrash: false,
  };

  const result = formatEncounterResult(win); // Kill / Wipe / ?
  const durText = formatDuration(win.durationMs);
  const seconds = Math.max(1, win.durationMs / 1000);
  const tone = win.success === true ? "kill" : win.success === false ? "wipe" : undefined;
  const deathCount = ctx.deaths.filter(
    (d) => d.timestampMs >= win.startMs && d.timestampMs <= win.endMs,
  ).length;

  const bounds = { startMs: win.startMs, endMs: win.endMs };
  // ~1 bucket/second, capped near the chart's pixel width.
  const bucketCount = Math.min(800, Math.max(60, Math.round(seconds)));
  // Per-player active/alive/movement stats -- only for a real encounter
  // (they're keyed by encounter index); a custom range gets an empty list
  // and the Active column falls back to a dash.
  const statsPromise: Promise<PlayerStatsRow[]> =
    src.kind === "encounter" ? encounterStats(src.index) : Promise.resolve([]);
  const [series, playerRows] = await Promise.all([
    damageHealingSeries(bounds, bucketCount),
    statsPromise.then((stats) => buildPlayerRows(bounds, seconds, win.name, stats)),
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
  const deaths = deathMarkers(win);

  built.get("title")?.update({ name: win.name, badge: durText, tone, detail: formatDifficulty(win) });
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
  built.get("chart")?.update({ buckets, deaths, startMs: win.startMs, endMs: win.endMs, displaySeconds: 8 });
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

async function buildPlayerRows(
  bounds: { startMs: number; endMs: number },
  seconds: number,
  encounterName: string,
  stats: PlayerStatsRow[],
): Promise<PlayerRow[]> {
  // Two parallel passes over the window:
  //  - grouped by (owner, unit): damage and healing, each split own vs pet
  //    via `sourceUnit === sourceOwner`. A player who only healed (common
  //    on trash spans / between pulls) still gets a row.
  //  - grouped by target unit: damage taken. Keyed by unit id, which for a
  //    player equals their owner id, so it joins straight onto the rows;
  //    pets are dropped by the Player-kind filter below.
  const [grouped, takenRows] = await Promise.all([
    ctx!.query<{ sourceOwner: number; sourceUnit: number; dmg: number; heal: number }>({
      ...bounds,
      groupBy: ["sourceOwner", "sourceUnit"],
      aggregate: [
        { op: "sum", field: "amount", as: "dmg", where: [{ field: "kind", op: "in", value: DAMAGE_KINDS }] },
        { op: "sum", field: "amount", as: "heal", where: [{ field: "kind", op: "in", value: HEAL_KINDS }] },
      ],
    }),
    ctx!.query<{ targetUnit: number; taken: number }>({
      ...bounds,
      groupBy: ["targetUnit"],
      aggregate: [
        { op: "sum", field: "amount", as: "taken", where: [{ field: "kind", op: "in", value: DAMAGE_KINDS }] },
      ],
    }),
  ]);

  const units = ctx!.units;
  const takenByUnit = new Map<number, number>();
  for (const r of takenRows) takenByUnit.set(r.targetUnit, r.taken);

  type Acc = { dmgOwn: number; dmgPet: number; healOwn: number; healPet: number };
  const byOwner = new Map<number, Acc>();
  for (const r of grouped) {
    if (units[r.sourceOwner]?.kind !== "Player") continue;
    const acc = byOwner.get(r.sourceOwner) ?? { dmgOwn: 0, dmgPet: 0, healOwn: 0, healPet: 0 };
    if (r.sourceUnit === r.sourceOwner) {
      acc.dmgOwn += r.dmg;
      acc.healOwn += r.heal;
    } else {
      acc.dmgPet += r.dmg;
      acc.healPet += r.heal;
    }
    byOwner.set(r.sourceOwner, acc);
  }

  const list = [...byOwner]
    .map(([id, v]) => ({ id, name: units[id]!.name, ...v, taken: takenByUnit.get(id) ?? 0 }))
    .filter((r) => r.dmgOwn + r.dmgPet + r.healOwn + r.healPet + r.taken > 0);

  const totalDmg = list.reduce((s, r) => s + r.dmgOwn + r.dmgPet, 0);
  const totalHeal = list.reduce((s, r) => s + r.healOwn + r.healPet, 0);
  const totalTaken = list.reduce((s, r) => s + r.taken, 0);
  const share = (n: number, total: number) => (total > 0 ? n / total : 0);

  // player name -> spec, from this encounter's COMBATANT_INFO (falling back
  // to any snapshot for that player). Empty for logs without COMBATANT_INFO.
  const specByName = new Map<string, number>();
  for (const c of ctx!.combatants) {
    if (c.encounterName === encounterName || !specByName.has(c.playerName)) {
      specByName.set(c.playerName, c.specId);
    }
  }

  // Active / alive / death stats from `encounter_stats`, joined by unit id
  // (a player's own unit id == their `sourceOwner`). Empty for a custom
  // range -> `activePct` stays null and the Active cell shows a dash.
  const statsByUnit = new Map<number, PlayerStatsRow>();
  for (const s of stats) statsByUnit.set(s.unitId, s);

  return list
    .map((r) => {
      const specId = specByName.get(r.name) ?? 0;
      const damage = r.dmgOwn + r.dmgPet;
      const healing = r.healOwn + r.healPet;
      const st = statsByUnit.get(r.id);
      return {
        name: r.name,
        spec: formatSpec(specId),
        role: formatRole(specId),
        roleRank: roleRank(specId),
        nameColor: classColorVar(specId),
        dmgOwn: r.dmgOwn,
        dmgPet: r.dmgPet,
        damage,
        dps: damage / seconds,
        dmgOwnDps: r.dmgOwn / seconds,
        dmgPetDps: r.dmgPet / seconds,
        dmgShare: share(damage, totalDmg),
        healOwn: r.healOwn,
        healPet: r.healPet,
        healing,
        hps: healing / seconds,
        healOwnHps: r.healOwn / seconds,
        healPetHps: r.healPet / seconds,
        healShare: share(healing, totalHeal),
        taken: r.taken,
        takenShare: share(r.taken, totalTaken),
        activePct: st && st.encounterMs > 0 ? st.activeMs / st.encounterMs : null,
        deaths: st?.deaths ?? 0,
        activeBins: st?.activeBins ?? [],
        deadBins: st?.deadBins ?? [],
      };
    })
    // Pre-sorted to the widget's default (role-grouped); the widget owns
    // sorting from here -- header clicks re-sort locally, no re-query.
    .sort((a, b) => {
      if (a.roleRank !== b.roleRank) return a.roleRank - b.roleRank;
      const m = (r: PlayerRow) => (r.roleRank === 1 ? r.healing : r.damage);
      return m(b) - m(a);
    });
}

function deathMarkers(e: EncounterRow): ChartDeath[] {
  return (ctx?.deaths ?? [])
    .filter((d) => d.timestampMs >= e.startMs && d.timestampMs <= e.endMs)
    .map((d) => ({ t: d.timestampMs, label: d.playerName }));
}
