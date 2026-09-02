// name | DPS | damage done. Rows arrive already sorted (Overview sorts by
// damage desc). Plain grid, not virtualized -- a raid is <= ~30 players.
// A future `data-table` widget wraps VirtualList when something needs it
// (docs/ui-widgets.md).

import { registerWidget } from "../registry";
import type { Widget } from "../spec";
import { formatCompact } from "../../format";

export interface PlayerRow {
  name: string;
  dps: number;
  damage: number;
}

export interface PlayerTableProps {
  rows: PlayerRow[];
}

const COLUMNS = ["Player", "DPS", "Damage"];

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
      body.replaceChildren(
        ...next.rows.map((r) => {
          const row = document.createElement("div");
          row.className = "player-table-row";
          const name = document.createElement("span");
          name.textContent = r.name;
          const dps = document.createElement("span");
          dps.textContent = formatCompact(r.dps);
          const dmg = document.createElement("span");
          dmg.textContent = formatCompact(r.damage);
          row.append(name, dps, dmg);
          return row;
        }),
      );
    },
  };
  widget.update(props);
  return widget;
});
