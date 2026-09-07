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
import type { EncounterRow, ReplayUnit } from "../types";
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
        periodicHeals: [],
        envHits: [],
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

// Player cube side (yд); the big-creature ("boss") size, +100% over the
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

  // Player pets / guardians / totems are `Creature` kind but owned by a
  // player -- drop them (v1 shows raiders + real enemies only; a modern
  // pull is ~100 totems/procs of grey clutter otherwise). Boss-summoned
  // adds also carry an owner (the boss), so check the owner is a Player,
  // not just that one exists.
  const renderable = series.units.filter(
    (u) =>
      RENDER_KINDS.has(u.kind) &&
      !(u.kind === "Creature" && units[u.unitId]?.owner?.startsWith("Player-")),
  );

  // "Boss" = the creature with the biggest max health (user's
  // definition). Everything scales off that.
  const bossHp = renderable
    .filter((u) => u.kind === "Creature")
    .reduce((mx, u) => Math.max(mx, u.maxHp), 0);

  const sceneUnits: ReplaySceneUnitInput[] = renderable.map((u: ReplayUnit) => {
    let team: ReplaySceneUnitInput["team"];
    let color: string;
    let size: number;
    let stackRank = 4;

    if (u.kind === "Player") {
      team = "player";
      color = classColorVar(specByUnit.get(u.unitId) ?? 0) || "var(--ctp-overlay1)";
      size = PLAYER_SIZE;
      stackRank = STACK_RANK_BY_ROLE[roleRank(specByUnit.get(u.unitId) ?? 0)] ?? 4;
    } else if (u.kind === "Creature") {
      team = "enemy";
      const frac = bossHp > 0 && u.maxHp > 0 ? u.maxHp / bossHp : null;
      size = enemySize(frac);
      color = enemyColor(frac);
    } else {
      team = "other";
      color = "var(--ctp-overlay2)";
      size = PLAYER_SIZE;
    }

    // Every enemy (boss included) is a sphere; players and vehicles are
    // cubes.
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
  // fixes) can't be drawn -- filter to renderable sources.
  const shown = new Set(sceneUnits.map((u) => u.unitId));
  const castLines = series.castLines.filter(
    (c) => shown.has(c.sourceUnit) && shown.has(c.targetUnit),
  );
  const periodicHits = series.periodicHits.filter(
    (h) => shown.has(h.sourceUnit) && shown.has(h.targetUnit),
  );
  const periodicHeals = series.periodicHeals.filter(
    (h) => shown.has(h.sourceUnit) && shown.has(h.targetUnit),
  );
  // Environmental damage has no source unit -- only the victim needs to
  // be on screen.
  const envHits = series.envHits.filter((h) => shown.has(h.targetUnit));

  built.get("scene")?.update({
    units: sceneUnits,
    castLines,
    periodicHits,
    periodicHeals,
    envHits,
    fitBox: series.fitBox,
    startMs: series.startMs,
    endMs: series.endMs,
  });
}
