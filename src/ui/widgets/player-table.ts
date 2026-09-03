// name | class/spec | % of raid (player+pet) damage | bar | damage done |
// DPS. Rows arrive already sorted (Overview sorts by damage desc). Plain
// grid, not virtualized -- a raid is <= ~30 players. A future `data-table`
// widget wraps VirtualList when something needs it (docs/ui-widgets.md).
// `spec` is "" for logs recorded without COMBATANT_INFO.
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
  dps: number;
  damage: number; // own + pet
  own: number; // damage by the player unit itself
  pet: number; // damage by the player's pets
  share: number; // 0..1, this row's damage / the table's total damage
}

export interface PlayerTableProps {
  rows: PlayerRow[];
}

const COLUMNS = ["Player", "Class / Spec", "%", "", "Damage", "DPS"];

registerWidget<PlayerTableProps>("player-table", (props) => {
  const element = document.createElement("div");
  element.className = "player-table";

  const header = document.createElement("div");
  header.className = "player-table-row player-table-head";
  for (const c of COLUMNS) {
    const cell = document.createElement("span");
    cell.textContent = c;
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
          spec.className = "pt-spec";
          spec.textContent = r.spec;
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

          row.append(name, spec, pct, bar, dmg, dps);
          return row;
        }),
      );
    },
  };
  widget.update(props);
  return widget;
});
