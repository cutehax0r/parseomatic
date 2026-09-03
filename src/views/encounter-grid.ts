// The "choose an encounter" screen -- the body of the Encounters view
// once a log is loaded. A header (file + kill/wipe tally) over a grid of
// bosses laid out horizontally, each with its pulls listed underneath.
// Clicking a pull selects that encounter and drills into the Overview view.
//
// Rendering only -- main.ts owns the data and wires `onPick` to its
// `applySelection`. Styling is deliberately minimal for now.

import type { EncounterRow } from "../types";
import { formatDuration, formatEncounterResult } from "../format";

export interface EncounterGridProps {
  path: string;
  encounters: EncounterRow[];
  selectedIndex: number | null; // currently-selected encounter, for the highlight
  onPick: (index: number) => void;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export function renderEncounterGrid(container: HTMLElement, props: EncounterGridProps): void {
  const { path, encounters, selectedIndex, onPick } = props;
  // `container` (#encounters-grid) has its `hidden` managed by main.ts, so
  // render into an inner root we own.
  const root = document.createElement("div");
  root.className = "eg";
  container.replaceChildren(root);

  const real = encounters.map((e, i) => ({ e, i })).filter((x) => !x.e.isTrash);
  const trash = encounters.map((e, i) => ({ e, i })).filter((x) => x.e.isTrash);

  // --- header ---
  const header = document.createElement("div");
  header.className = "eg-header";
  const file = document.createElement("div");
  file.className = "eg-file";
  const fname = document.createElement("span");
  fname.className = "eg-file-name";
  fname.textContent = basename(path) || "combat log";
  const fpath = document.createElement("span");
  fpath.className = "eg-file-path";
  fpath.textContent = path;
  file.append(fname, fpath);

  const kills = real.filter((x) => x.e.success === true).length;
  const wipes = real.filter((x) => x.e.success === false).length;
  const stats = document.createElement("div");
  stats.className = "eg-stats";
  stats.textContent = `${real.length} encounter${real.length === 1 ? "" : "s"} · ${kills} kill${
    kills === 1 ? "" : "s"
  } · ${wipes} wipe${wipes === 1 ? "" : "s"}`;
  header.append(file, stats);
  root.append(header);

  // --- grid: one column per boss (grouped by encounterId, falling back to
  // name; first-seen order; pulls numbered chronologically) ---
  const groups = new Map<string, Array<{ e: EncounterRow; i: number }>>();
  for (const x of real) {
    const key = String(x.e.encounterId || x.e.name);
    const list = groups.get(key);
    if (list) list.push(x);
    else groups.set(key, [x]);
  }

  const grid = document.createElement("div");
  grid.className = "eg-grid";

  const addColumn = (title: string, pulls: Array<{ e: EncounterRow; i: number }>, label: (n: number) => string) => {
    const col = document.createElement("div");
    col.className = "eg-col";
    const h = document.createElement("div");
    h.className = "eg-col-head";
    h.textContent = title;
    col.append(h);
    pulls
      .slice()
      .sort((a, b) => a.e.startMs - b.e.startMs)
      .forEach((x, n) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "eg-pull";
        const outcome = formatEncounterResult(x.e); // Kill / Wipe / ?
        btn.dataset.outcome = outcome.toLowerCase();
        if (x.i === selectedIndex) btn.setAttribute("aria-current", "true");
        const l = document.createElement("span");
        l.className = "eg-pull-label";
        l.textContent = label(n);
        const o = document.createElement("span");
        o.className = "eg-pull-outcome";
        o.textContent = outcome;
        const d = document.createElement("span");
        d.className = "eg-pull-dur";
        d.textContent = formatDuration(x.e.durationMs);
        btn.append(l, o, d);
        btn.addEventListener("click", () => onPick(x.i));
        col.append(btn);
      });
    grid.append(col);
  };

  for (const pulls of groups.values()) {
    addColumn(pulls[0].e.name || "(unnamed)", pulls, (n) => `Pull ${n + 1}`);
  }
  if (trash.length > 0) {
    addColumn("Trash", trash, (n) => `Trash ${n + 1}`);
  }

  if (grid.childElementCount === 0) {
    const empty = document.createElement("p");
    empty.className = "eg-empty";
    empty.textContent = "This log has no encounters.";
    root.append(empty);
  } else {
    root.append(grid);
  }
}
