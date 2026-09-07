// Interrupts -- a raid-level list of every SPELL_INTERRUPT over the
// selected window (any range, whole log included), plus notable player
// SPELL_CAST_FAILED rows merged in, time-sorted. See
// docs/interrupts-view.md.

import "../ui/widgets"; // registers interrupt-list / encounter-title / ...

import { buildView, type BuiltView } from "../ui/panel";
import { createViewContext, type ViewContext } from "../ui/context";
import { interrupts } from "../ui/interrupts";
import type { NodeSpec } from "../ui/spec";
import type { InterruptListRow } from "../ui/widgets/interrupt-list";
import { formatUnitName } from "../format";

const spec: NodeSpec = {
  kind: "panel",
  columns: 1,
  children: [
    { kind: "widget", type: "encounter-title", id: "title", props: { name: "", badge: "" } },
    {
      kind: "widget",
      type: "interrupt-list",
      id: "list",
      span: 1,
      props: { rows: [], startMs: 0 },
    },
  ],
};

let ctx: ViewContext | null = null;
let built: BuiltView | null = null;
let paintSeq = 0;

export function renderInterrupts(): void {
  const mount = document.querySelector<HTMLElement>("#interrupts-mount");
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

  const hintEl = document.querySelector<HTMLElement>("#interrupts-hint");
  const mount = document.querySelector<HTMLElement>("#interrupts-mount");

  const { startMs, endMs } = ctx.range;
  const ready = endMs > startMs;

  if (hintEl) hintEl.hidden = ready;
  if (mount) mount.hidden = !ready;
  if (!ready) return;

  const report = await interrupts(startMs, endMs);
  if (seq !== paintSeq || !report) return;

  const units = ctx.units;
  const spells = ctx.spells;
  const unitName = (id: number): string => {
    const u = units[id];
    return u ? formatUnitName(u) : `#${id}`;
  };
  const spellName = (id: number | null): string =>
    id === null ? "?" : (spells[id]?.name ?? `#${id}`);

  const rows: InterruptListRow[] = [
    ...report.interrupts.map(
      (i): InterruptListRow => ({
        kind: "interrupt",
        tMs: i.tMs,
        caster: unitName(i.sourceUnit),
        target: unitName(i.targetUnit),
        ability: spellName(i.abilityId),
        interrupted: spellName(i.interruptedId),
        elapsedMs: i.elapsedMs,
      }),
    ),
    ...report.failedCasts.map(
      (f): InterruptListRow => ({
        kind: "failed",
        tMs: f.tMs,
        caster: unitName(f.sourceUnit),
        ability: spellName(f.abilityId),
        reason: f.reason,
        count: f.count,
      }),
    ),
  ].sort((a, b) => a.tMs - b.tMs);

  const src = ctx.range.source;
  const enc = src.kind === "encounter" ? ctx.encounters[src.index] : undefined;
  built.get("title")?.update({
    name: "Interrupts",
    badge: "",
    detail: enc ? enc.name : undefined,
  });
  built.get("list")?.update({ rows, startMs });
}
