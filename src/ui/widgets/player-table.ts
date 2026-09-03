// name | class/spec | role | % of raid (player+pet) damage | bar | damage
// done | DPS. Rows arrive already sorted (Overview sorts by damage desc).
// Plain grid, not virtualized -- a raid is <= ~30 players. A future
// `data-table` widget wraps VirtualList when something needs it
// (docs/ui-widgets.md). `spec`/`role` are "" for logs without
// COMBATANT_INFO (or an unmapped spec id).
//
// The bar is scaled 0..max where max is the top row's total damage. Two
// segments from the left: a light one for the player's own damage, then a
// darker one for their pets', so the pair reaches (own+pet)/max wide.

import { registerWidget } from "../registry";
import type { Widget } from "../spec";
import { formatCompact } from "../../format";

export interface PlayerRow {
  name: string;
  spec: string; // "Frost Mage" etc., or "" if unknown
  role: string; // "Tank" / "Healer" / "DPS (ranged)" / "DPS (melee)" / ""
  dps: number;
  damage: number; // own + pet
  own: number; // damage by the player unit itself
  pet: number; // damage by the player's pets
  share: number; // 0..1, this row's damage / the table's total damage
}

export interface PlayerTableProps {
  rows: PlayerRow[];
}

// `left` columns hold text, not figures -- left-aligned, not tabular.
const COLUMNS: Array<{ label: string; left?: boolean }> = [
  { label: "Player" },
  { label: "Class / Spec", left: true },
  { label: "Role", left: true },
  { label: "%" },
  { label: "" },
  { label: "Damage" },
  { label: "DPS" },
];

registerWidget<PlayerTableProps>("player-table", (props) => {
  const element = document.createElement("div");
  element.className = "player-table";

  const header = document.createElement("div");
  header.className = "player-table-row player-table-head";
  for (const c of COLUMNS) {
    const cell = document.createElement("span");
    cell.textContent = c.label;
    if (c.left) cell.className = "pt-text";
    header.appendChild(cell);
  }
  const body = document.createElement("div");
  body.className = "player-table-body";
  element.append(header, body);

  const widget: Widget<PlayerTableProps> = {
    element,
    update(next) {
      const max = next.rows.reduce((m, r) => Math.max(m, r.own + r.pet), 1);
      body.replaceChildren(
        ...next.rows.map((r) => {
          const row = document.createElement("div");
          row.className = "player-table-row";
          const name = document.createElement("span");
          name.textContent = r.name;
          const spec = document.createElement("span");
          spec.className = "pt-text pt-dim";
          spec.textContent = r.spec;
          const role = document.createElement("span");
          role.className = "pt-text pt-dim";
          role.textContent = r.role;
          const pct = document.createElement("span");
          pct.textContent = `${(r.share * 100).toFixed(1)}%`;
          const dmg = document.createElement("span");
          dmg.textContent = formatCompact(r.damage);
          const dps = document.createElement("span");
          dps.textContent = formatCompact(r.dps);

          const bar = document.createElement("span");
          bar.className = "pt-bar";
          const own = document.createElement("span");
          own.className = "pt-bar-seg pt-bar-own";
          own.style.width = `${(r.own / max) * 100}%`;
          const pet = document.createElement("span");
          pet.className = "pt-bar-seg pt-bar-pet";
          pet.style.width = `${(r.pet / max) * 100}%`;
          bar.append(own, pet);

          row.append(name, spec, role, pct, bar, dmg, dps);
          return row;
        }),
      );
    },
  };
  widget.update(props);
  return widget;
});
