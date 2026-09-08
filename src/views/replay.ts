// Replay -- the 3D raid-wide replay (see docs/replay-view.md). A group
// view: every unit that carried a position over the selected encounter,
// rendered as class-coloured player cubes and (darker) enemy shapes on a
// grid platform, with a free orbit camera.
//
// PHASE A + B: the world plus static shapes at the window's start
// moment. Playback controls, the scrub timeline, animation, and loop
// markers are phases C-E.

import "../ui/widgets"; // registers replay-scene / encounter-title / ...

import { buildView, type BuiltView } from "../ui/panel";
import { createViewContext, type ViewContext } from "../ui/context";
import { replaySeries } from "../ui/replay-series";
import type { NodeSpec } from "../ui/spec";
import type { ReplaySceneUnitInput, ReplayShape } from "../ui/widgets/replay-scene";
import type {
  EncounterRow,
  ReplayCastLine,
  ReplayPeriodicHit,
  ReplayUnit,
} from "../types";
import {
  classColorVar,
  formatDifficulty,
  formatDuration,
  formatEncounterResult,
  roleRank,
} from "../format";

// roleRank (tank 0, healer 1, melee 2, ranged 3, unknown 4) -> the
// replay's bottom-to-top stack order: tank, melee, ranged, healer.
const STACK_RANK_BY_ROLE = [0, 3, 1, 2, 4];

const spec: NodeSpec = {
  kind: "panel",
  columns: 1,
  children: [
    { kind: "widget", type: "encounter-title", id: "title", props: { name: "", badge: "" } },
    {
      kind: "widget",
      type: "replay-scene",
      id: "scene",
      span: 1,
      props: {
        units: [],
        castLines: [],
        periodicHits: [],
        hostilePeriodicHits: [],
        periodicHeals: [],
        envHits: [],
        worldMarkers: [],
        fitBox: null,
        startMs: 0,
        endMs: 0,
      },
    },
  ],
};

// Unit kinds worth putting in the scene. Pets are omitted for v1
// (docs/replay-view.md §1); the rest (game objects, cast anchors, battle
// pets, ...) never have meaningful positions.
const RENDER_KINDS = new Set(["Player", "Creature", "Vehicle"]);

// Player cube side (yards); the big-creature ("boss") size, +100% over the
// first cut. Creatures are sized by their share of the biggest
// creature's max health -- see `enemySize`.
const PLAYER_SIZE = 1.6;
const BOSS_SIZE = PLAYER_SIZE * 4.8;

// Creature size from its `maxHp / bossHp` fraction. `null` (no health
// data) falls back to player size. A creature reaching boss size also
// switches shape (cube), so council co-bosses read the same as the
// single biggest.
function enemySize(frac: number | null): number {
  if (frac === null) return PLAYER_SIZE;
  if (frac >= 0.75) return BOSS_SIZE;
  if (frac >= 0.5) return PLAYER_SIZE * 2;
  if (frac >= 0.1) return PLAYER_SIZE;
  return PLAYER_SIZE * 0.5;
}

// Enemy colour by health tier -- Catppuccin greys: the biggest is the
// darkest (`surface2`), mid-size `overlay0`, the smallest adds the
// lightest (`overlay2`) so trash still reads. Passed straight through --
// the widget does not dim enemies further.
function enemyColor(frac: number | null): string {
  if (frac !== null && frac >= 0.75) return "var(--ctp-surface2)"; // boss
  if (frac !== null && frac < 0.1) return "var(--ctp-overlay2)"; // trash
  return "var(--ctp-overlay0)"; // mid
}

// Enemy unit kinds: a real creature, or a `Vehicle` -- the boss half of
// council / vehicle fights (Zul'jan on The Coiled Altar, Ula'tek's head
// and tail) logs as `Vehicle`, so it has to size + colour + shape like
// any other enemy, not fall through to the grey player-cube branch.
const ENEMY_KINDS = new Set(["Creature", "Vehicle"]);

// `Creature-0-<server>-<inst>-<zone>-<npcId>-<spawn>` -- the npcId is the
// stable identity across a unit's spawns. Same shape for `Vehicle-`.
// `null` for players / anything without the 6-dash creature form.
function npcIdOf(guid: string): string | null {
  const m = /^(?:Creature|Vehicle)-\d+-\d+-\d+-\d+-(\d+)-/.exec(guid);
  return m ? m[1] : null;
}

// A phased / council boss re-spawns a fresh GUID (sometimes a fresh
// npcId) each stage, and `replay.rs` hands each back as its own unit --
// so the sphere pops in late, freezes when its stage ends, and a
// `UNIT_DIED` at a stage change paints it dead for the rest of the pull.
// Fold every same-npcId enemy spawn into one logical unit whose track is
// the concatenation of its spawns', so the boss hands off across stages.
// Gated hard so swarms (82 Manifestations, 133 venom stalkers) never
// collapse into one teleporting blob: few spawns, and together they must
// cover most of the pull.
const BOSS_MERGE_MAX_SPAWNS = 8;
const BOSS_MERGE_MIN_COVERAGE = 0.35; // union of spawn lifetimes / window
const BOSS_MERGE_MIN_FRAC = 0.15; // vs the biggest enemy's max health

// An enemy at the top of the pack's level range reads as a boss only when
// the pack spans at least this many levels -- a skull boss is
// `maxPlayerLevel + 3`, trash is `maxPlayerLevel`, elites in between.
const BOSS_LEVEL_SPREAD = 2;

// Fraction of `[0, windowMs]` covered by the union of `[first, last]`
// sample spans across `units`.
function spanCoverage(units: ReplayUnit[], windowMs: number): number {
  if (windowMs <= 0) return 0;
  const iv = units
    .map((u) => u.samples)
    .filter((s) => s.length > 0)
    .map((s) => [s[0].tMs, s[s.length - 1].tMs] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let curLo = Infinity;
  let curHi = -Infinity;
  for (const [lo, hi] of iv) {
    if (lo > curHi) {
      if (curHi > curLo) covered += curHi - curLo;
      curLo = lo;
      curHi = hi;
    } else {
      curHi = Math.max(curHi, hi);
    }
  }
  if (curHi > curLo) covered += curHi - curLo;
  return covered / windowMs;
}

interface MergeResult {
  units: ReplayUnit[];
  // merged-away unitId -> the id its group is now keyed by. Cast lines /
  // periodic hits referencing an absorbed spawn are re-pointed through
  // this before the on-screen filter.
  remap: Map<number, number>;
  // unitIds that ended up as a merged council/phased boss -- forced to
  // boss size + colour regardless of their health fraction (a co-boss
  // like Hex Lord Malacrass sits well below the biggest's health).
  bossIds: Set<number>;
}

function mergeBossGuids(
  enemies: ReplayUnit[],
  bossHp: number,
  windowMs: number,
): MergeResult {
  const byNpc = new Map<string, ReplayUnit[]>();
  const passthrough: ReplayUnit[] = [];
  for (const u of enemies) {
    const npc = npcIdOf(u.guid);
    if (npc === null) {
      passthrough.push(u);
      continue;
    }
    const bucket = byNpc.get(npc);
    if (bucket) bucket.push(u);
    else byNpc.set(npc, [u]);
  }

  const out: ReplayUnit[] = [...passthrough];
  const remap = new Map<number, number>();
  const bossIds = new Set<number>();

  for (const group of byNpc.values()) {
    const groupMaxHp = group.reduce((mx, u) => Math.max(mx, u.maxHp), 0);
    const mergeable =
      group.length > 1 &&
      group.length <= BOSS_MERGE_MAX_SPAWNS &&
      (bossHp <= 0 || groupMaxHp >= BOSS_MERGE_MIN_FRAC * bossHp) &&
      spanCoverage(group, windowMs) >= BOSS_MERGE_MIN_COVERAGE;

    if (!mergeable) {
      out.push(...group);
      continue;
    }

    // Key the merged unit on the spawn with the most position fixes.
    const rep = group.reduce((a, b) => (b.samples.length > a.samples.length ? b : a));
    const samples = group.flatMap((u) => u.samples).sort((a, b) => a.tMs - b.tMs);
    const castSpans = group.flatMap((u) => u.castSpans).sort((a, b) => a.startMs - b.startMs);
    const faceEvents = group.flatMap((u) => u.faceEvents).sort((a, b) => a.tMs - b.tMs);
    // A stage-transition `UNIT_DIED` leaves an open (endMs null) death
    // span; keep a span only if it's closed, or nothing in the stitched
    // track moves after it -- i.e. it's the real death at the pull's end.
    const deathSpans = group
      .flatMap((u) => u.deathSpans)
      .sort((a, b) => a.startMs - b.startMs)
      .filter((d) => d.endMs !== null || !samples.some((s) => s.tMs > d.startMs + 500));

    for (const u of group) if (u.unitId !== rep.unitId) remap.set(u.unitId, rep.unitId);
    bossIds.add(rep.unitId);
    out.push({
      ...rep,
      maxHp: groupMaxHp,
      samples,
      deathSpans,
      castSpans,
      faceEvents,
    });
  }

  return { units: out, remap, bossIds };
}

let ctx: ViewContext | null = null;
let built: BuiltView | null = null;
let paintSeq = 0;

export function renderReplay(): void {
  const mount = document.querySelector<HTMLElement>("#replay-mount");
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

  const hintEl = document.querySelector<HTMLElement>("#replay-hint");
  const mount = document.querySelector<HTMLElement>("#replay-mount");

  const src = ctx.range.source;
  const encs = ctx.encounters;
  const e = src.kind === "encounter" ? encs[src.index] : undefined;

  // Like Overview / Movement: any concrete window, but not the whole log.
  const extentStart = encs.length ? Math.min(...encs.map((x) => x.startMs)) : 0;
  const extentEnd = encs.length ? Math.max(...encs.map((x) => x.endMs)) : 0;
  const isWholeLog = !e && ctx.range.startMs <= extentStart && ctx.range.endMs >= extentEnd;
  const ready = !isWholeLog && ctx.range.endMs > ctx.range.startMs;

  if (hintEl) hintEl.hidden = ready;
  if (mount) mount.hidden = !ready;
  if (!ready) return;

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
  const tone = win.success === true ? "kill" : win.success === false ? "wipe" : undefined;

  built.get("title")?.update({
    name: win.name,
    badge: formatDuration(win.durationMs),
    tone,
    detail: e ? formatDifficulty(win) : formatEncounterResult(win),
  });

  const series = await replaySeries(win.startMs, win.endMs);
  if (seq !== paintSeq || !series) return;

  const units = ctx.units;
  const specByUnit = new Map<number, number>();
  for (const c of ctx.combatants) specByUnit.set(c.unitId, c.specId);

  // Player pets / guardians / totems are `Creature`/`Vehicle` kind but
  // owned by a player -- drop them (v1 shows raiders + real enemies only;
  // a modern pull is ~100 totems/procs of grey clutter otherwise).
  // Boss-summoned adds also carry an owner (the boss), so check the owner
  // is a Player, not just that one exists.
  const renderable = series.units.filter(
    (u) =>
      RENDER_KINDS.has(u.kind) &&
      !(ENEMY_KINDS.has(u.kind) && units[u.unitId]?.owner?.startsWith("Player-")),
  );

  // "Boss" = the enemy with the biggest max health (user's definition) --
  // `Vehicle` counts, it's the boss half of a council fight. Everything
  // scales off that.
  const bossHp = renderable
    .filter((u) => ENEMY_KINDS.has(u.kind))
    .reduce((mx, u) => Math.max(mx, u.maxHp), 0);

  // Fold a phased / council boss's per-stage spawns into one unit so it
  // hands off across stages instead of popping in late and freezing.
  const enemies = renderable.filter((u) => ENEMY_KINDS.has(u.kind));
  const others = renderable.filter((u) => !ENEMY_KINDS.has(u.kind));
  const merged = mergeBossGuids(enemies, bossHp, win.endMs - win.startMs);
  const finalUnits = [...others, ...merged.units];

  // Level as a second boss signal: a skull / `??` boss logs its effective
  // level (`maxPlayerLevel + 3`), a clear tier above trash. Only trust it
  // when the enemy pack actually spans levels (`BOSS_LEVEL_SPREAD`) --
  // otherwise a same-level trash pull would all read as boss. Catches a
  // co-boss like Hex Lord Malacrass, whose health pool alone is ~0.38 of
  // the biggest's so `enemySize` would shrink it.
  const enemyLevels = finalUnits
    .filter((u) => ENEMY_KINDS.has(u.kind) && u.level > 0)
    .map((u) => u.level);
  const topEnemyLevel = enemyLevels.length ? Math.max(...enemyLevels) : 0;
  const enemyLevelSpread = enemyLevels.length ? topEnemyLevel - Math.min(...enemyLevels) : 0;
  const isBossLevel = (u: ReplayUnit): boolean =>
    u.level > 0 && u.level >= topEnemyLevel && enemyLevelSpread >= BOSS_LEVEL_SPREAD;

  const sceneUnits: ReplaySceneUnitInput[] = finalUnits.map((u: ReplayUnit) => {
    let team: ReplaySceneUnitInput["team"];
    let color: string;
    let size: number;
    let stackRank = 4;

    if (u.kind === "Player") {
      team = "player";
      color = classColorVar(specByUnit.get(u.unitId) ?? 0) || "var(--ctp-overlay1)";
      size = PLAYER_SIZE;
      stackRank = STACK_RANK_BY_ROLE[roleRank(specByUnit.get(u.unitId) ?? 0)] ?? 4;
    } else if (ENEMY_KINDS.has(u.kind)) {
      team = "enemy";
      // A merged council co-boss, or one flagged by its skull-tier level,
      // reads as a boss even when its own health pool is a fraction of
      // the biggest's.
      const frac =
        merged.bossIds.has(u.unitId) || isBossLevel(u)
          ? 1
          : bossHp > 0 && u.maxHp > 0
            ? u.maxHp / bossHp
            : null;
      size = enemySize(frac);
      color = enemyColor(frac);
    } else {
      team = "other";
      color = "var(--ctp-overlay2)";
      size = PLAYER_SIZE;
    }

    // Every enemy (boss included) is a sphere; players and everything
    // else are cubes.
    const shape: ReplayShape = team === "enemy" ? "sphere" : "cube";

    return {
      unitId: u.unitId,
      guid: u.guid,
      kind: u.kind,
      color,
      team,
      shape,
      size,
      stackRank,
      samples: u.samples,
      deathSpans: u.deathSpans,
      castSpans: u.castSpans,
      faceEvents: u.faceEvents,
    };
  });

  // Cast lines whose source didn't make the render cut (no position
  // fixes) can't be drawn -- filter to on-screen units, re-pointing any
  // endpoint that was folded into a merged boss.
  const shown = new Set(sceneUnits.map((u) => u.unitId));
  const id = (n: number): number => merged.remap.get(n) ?? n;
  const remapLine = (c: ReplayCastLine): ReplayCastLine => ({
    ...c,
    sourceUnit: id(c.sourceUnit),
    targetUnit: id(c.targetUnit),
  });
  const remapHit = (h: ReplayPeriodicHit): ReplayPeriodicHit => ({
    ...h,
    sourceUnit: id(h.sourceUnit),
    targetUnit: id(h.targetUnit),
  });
  const castLines = series.castLines
    .map(remapLine)
    .filter((c) => shown.has(c.sourceUnit) && shown.has(c.targetUnit));
  const periodicHits = series.periodicHits
    .map(remapHit)
    .filter((h) => shown.has(h.sourceUnit) && shown.has(h.targetUnit));
  const periodicHeals = series.periodicHeals
    .map(remapHit)
    .filter((h) => shown.has(h.sourceUnit) && shown.has(h.targetUnit));
  // Bursts anchored on the struck player -- the source (a creature, or
  // nothing for environmental) doesn't need to be on screen.
  const hostilePeriodicHits = series.hostilePeriodicHits
    .map(remapHit)
    .filter((h) => shown.has(h.targetUnit));
  const envHits = series.envHits.map(remapHit).filter((h) => shown.has(h.targetUnit));

  built.get("scene")?.update({
    units: sceneUnits,
    castLines,
    periodicHits,
    hostilePeriodicHits,
    periodicHeals,
    envHits,
    worldMarkers: series.worldMarkers,
    fitBox: series.fitBox,
    startMs: series.startMs,
    endMs: series.endMs,
  });
}
