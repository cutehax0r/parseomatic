// Timeline -- a per-player, video-editor-style activity strip over a
// bounded window (see docs/timeline-view.md). Fixed lanes:
//
//   Debuffs · Damage Taken · Damage Done · Healing Done · Healing Received
//   · Buffs · Movement
//
// Buffs / debuffs carry real durations (AURA_APPLIED..AURA_REMOVED); the
// damage / heal lanes are instants drawn ~1.5s wide; Movement is an
// always-full strip of alternating Moving / Stopped segments (the
// Movement view's standstill model, `movement-segments.ts`). Backed by a
// `timeline_series` + `movement_series` fetch. Gated like Movement: needs
// a picked player and a bounded window, not the whole log.

import "../ui/widgets"; // registers timeline-lanes / encounter-title / ...

import { buildView, type BuiltView } from "../ui/panel";
import { createViewContext, type ViewContext } from "../ui/context";
import { timelineSeries } from "../ui/timeline-series";
import { movementSeries } from "../ui/movement-series";
import { movementSegments } from "../ui/movement-segments";
import type { NodeSpec } from "../ui/spec";
import type {
  TimelineBox,
  TimelineLane,
  TimelineTone,
} from "../ui/widgets/timeline-lanes";
import type { TimelineInstantKind } from "../types";
import { formatCompact, formatUnitName } from "../format";

function fmtDur(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

const spec: NodeSpec = {
  kind: "panel",
  columns: 1,
  children: [
    { kind: "widget", type: "encounter-title", id: "title", props: { name: "", badge: "" } },
    {
      kind: "widget",
      type: "timeline-lanes",
      id: "lanes",
      span: 1,
      props: { tracks: [], deaths: [], startMs: 0, endMs: 0 },
    },
  ],
};

// Lane order, top -> bottom, and which stream feeds each.
const INSTANT_LANE: Record<TimelineInstantKind, string> = {
  dmgIn: "Damage Taken",
  dmgOut: "Damage Done",
  healOut: "Healing Done",
  healIn: "Healing Received",
};
const INSTANT_TONE: Record<TimelineInstantKind, TimelineTone> = {
  dmgIn: "dmgIn",
  dmgOut: "dmgOut",
  healOut: "healOut",
  healIn: "healIn",
};
const LANE_ORDER = [
  "Debuffs",
  "Damage Taken",
  "Damage Done",
  "Healing Done",
  "Healing Received",
  "Buffs",
  "Movement",
] as const;

let ctx: ViewContext | null = null;
let built: BuiltView | null = null;
let paintSeq = 0;

export function renderTimeline(): void {
  const mount = document.querySelector<HTMLElement>("#timeline-mount");
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

  const hintEl = document.querySelector<HTMLElement>("#timeline-hint");
  const mount = document.querySelector<HTMLElement>("#timeline-mount");

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
      ? "Select a player from the toolbar to see their timeline."
      : "Pick an encounter or a custom range — the timeline needs a bounded window.";
  }
  if (mount) mount.hidden = !ready;
  if (!ready || !unit || unitId === null) return;

  const { startMs, endMs } = ctx.range;
  const [series, move] = await Promise.all([
    timelineSeries(unitId, startMs, endMs),
    // buckets is irrelevant here -- we only read `.samples`.
    movementSeries(unitId, startMs, endMs, 120),
  ]);
  if (seq !== paintSeq || !series) return;

  const spells = ctx.spells;
  const units = ctx.units;
  const spellName = (id: number | null): string =>
    id === null ? "Melee" : (spells[id]?.name ?? `#${id}`);
  const unitName = (id: number | null): string | undefined => {
    if (id === null) return undefined;
    const u = units[id];
    return u ? formatUnitName(u) : `#${id}`;
  };

  const byLane = new Map<string, TimelineBox[]>(LANE_ORDER.map((l) => [l, []]));

  for (const ev of series.instants) {
    const box: TimelineBox = {
      startMs: ev.tMs,
      endMs: ev.tMs,
      instant: true,
      label: spellName(ev.spellId),
      tone: INSTANT_TONE[ev.kind],
      amount: ev.amount || undefined,
      periodic: ev.periodic,
      x: ev.x,
      y: ev.y,
    };
    if (ev.kind === "dmgIn" || ev.kind === "healIn") box.sourceName = unitName(ev.otherUnit);
    else box.targetName = unitName(ev.otherUnit);
    byLane.get(INSTANT_LANE[ev.kind])!.push(box);
  }

  for (const a of series.auras) {
    const lane = a.isDebuff ? "Debuffs" : "Buffs";
    byLane.get(lane)!.push({
      startMs: a.startMs,
      endMs: a.endMs ?? series.endMs,
      instant: false,
      label: spellName(a.spellId),
      tone: a.isDebuff ? "debuff" : "buff",
      sourceName: unitName(a.sourceUnit),
      stacks: a.maxStacks > 1 ? a.maxStacks : undefined,
    });
  }

  // Movement: the same standstill model the Movement view uses, drawn as
  // an always-full strip of alternating Moving / Stopped segments.
  if (move) {
    for (const seg of movementSegments(move.samples, series.startMs, series.endMs)) {
      byLane.get("Movement")!.push({
        startMs: seg.startMs,
        endMs: seg.endMs,
        instant: false,
        label: seg.kind === "stop" ? "Stopped" : "Moving",
        tone: seg.kind,
        detail:
          seg.kind === "stop"
            ? fmtDur(seg.endMs - seg.startMs)
            : `${Math.round(seg.distance)} yd`,
        x: seg.x ?? null,
        y: seg.y ?? null,
      });
    }
  }

  const lanes: TimelineLane[] = LANE_ORDER.map((label) => ({
    id: label,
    label,
    boxes: byLane.get(label)!,
  }));

  const nBoxes = lanes.reduce((n, l) => n + (l.id === "Movement" ? 0 : l.boxes.length), 0);
  built.get("title")?.update({
    name: formatUnitName(unit),
    badge: `${formatCompact(nBoxes)} events`,
  });
  built.get("lanes")?.update({
    tracks: [{ unitId, label: formatUnitName(unit), lanes }],
    deaths: series.deaths.map((d) => ({ startMs: d.startMs, endMs: d.endMs })),
    startMs: series.startMs,
    endMs: series.endMs,
  });
}
