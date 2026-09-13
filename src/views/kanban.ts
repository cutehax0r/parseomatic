// Kanban -- a flat table of every phase of every boss pull in the log,
// resolved against each pull's matched encounter config (see
// docs/encounter-config.md "Matching a log encounter"). Not the kanban
// *board* described in boss-parsers.md yet (drag/drop columns, mechanic
// cards) -- that needs the detection engine, which doesn't exist. This is
// the flat data it would eventually be built from.

import type { EncounterRow } from "../types";
import type { PhaseDef } from "../encounters/schema";
import { createViewContext, type ViewContext } from "../ui/context";
import { findEncounterConfig } from "../encounters/lookup";
import { evaluatePhases } from "../encounters/evaluate";
import { formatClockTime, formatDifficulty } from "../format";

interface PhaseRow {
  encounter: EncounterRow;
  phase: PhaseDef;
  startMs: number | null;
  endMs: number | null;
}

let ctx: ViewContext | null = null;
let paintSeq = 0;

export function renderKanban(): void {
  const mount = document.querySelector<HTMLElement>("#kanban-mount");
  if (!mount) return;

  if (!ctx) {
    ctx = createViewContext();
    ctx.subscribe(() => void paint());
  }
  void paint();
}

async function paint(): Promise<void> {
  const mount = document.querySelector<HTMLElement>("#kanban-mount");
  if (!ctx || !mount) return;
  const seq = ++paintSeq;

  const rows: PhaseRow[] = [];
  for (const encounter of ctx.encounters) {
    if (encounter.isTrash) continue;
    const found = await findEncounterConfig(encounter.encounterId, encounter.difficultyId);
    if (seq !== paintSeq) return; // a newer log/paint landed while this was in flight
    if (!found || found.config.phases.length === 0) continue;
    const evaluated = await evaluatePhases(found.config, encounter.startMs, encounter.endMs, {
      query: ctx.query,
      spells: ctx.spells,
      units: ctx.units,
    });
    if (seq !== paintSeq) return;
    for (const { phase, range } of evaluated) {
      rows.push({ encounter, phase, startMs: range?.startMs ?? null, endMs: range?.endMs ?? null });
    }
  }
  if (seq !== paintSeq) return;

  render(mount, rows);
}

function render(mount: HTMLElement, rows: PhaseRow[]): void {
  mount.replaceChildren();

  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "kanban-placeholder";
    empty.textContent = "No encounter configs matched this log's pulls yet.";
    mount.append(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "kanban-table";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th>Encounter ID</th><th>Encounter Name</th><th>Difficulty</th><th>Phase</th><th>Start</th><th>End</th></tr>";
  const tbody = document.createElement("tbody");

  for (const { encounter, phase, startMs, endMs } of rows) {
    const tr = document.createElement("tr");
    const cells = [
      String(encounter.encounterId),
      encounter.name,
      formatDifficulty(encounter),
      phase.label || phase.id,
      startMs !== null ? formatClockTime(startMs) : "—",
      endMs !== null ? formatClockTime(endMs) : "—",
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i >= 4 && text === "—") td.className = "unresolved";
      tr.append(td);
    });
    tbody.append(tr);
  }

  table.append(thead, tbody);
  mount.append(table);
}
