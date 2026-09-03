// role icon | player (bold class-coloured name over a dim spec line) |
// Damage | Healing | Damage taken | Active. Damage/Healing/Damage taken
// are `buildMetricCell` cells (bar + amount + rate/%); see metric-cell.ts.
// Active is `buildActiveCell` -- an activity curve (dead stretches drawn
// yellow) + "NN% / N deaths"; see active-cell.ts. Plain grid, not
// virtualized -- a raid is <= ~30 players. A future `data-table` widget
// wraps VirtualList when something needs it (docs/ui-widgets.md).
// `spec`/`role`/`nameColor` are "" for logs without COMBATANT_INFO (or an
// unmapped spec id) -- the row then shows no glyph and a default-colour
// name.
//
// Sorting lives here, not in the view: every column's data is already in
// the row, so a header click is a local array re-sort + body rebuild (~30
// rows) -- no query, no IPC. Default sort is role-grouped (tanks, healers,
// melee, ranged), each role by healing (healers) or damage (everyone
// else). Clicking the active header flips direction.
//
// The damage and healing bars split player-own vs pet as two segments and
// carry a hover popover (own vs aggregated-pet amount + rate), served by
// one delegated pointer listener on the table. Damage taken is the player
// unit only -- one segment, no rate, no %, no hover.

import { registerWidget } from "../registry";
import type { Widget } from "../spec";
import { formatCompact } from "../../format";
import { buildMetricCell } from "./metric-cell";
import { buildActiveCell } from "./active-cell";
import { roleIcon, roleIconClass } from "./role-icon";

export interface PlayerRow {
  name: string;
  spec: string; // "Frost Mage" etc., or "" if unknown
  role: string; // "Tank" / "Healer" / "DPS (ranged)" / "DPS (melee)" / ""
  roleRank: number; // 0 tank / 1 healer / 2 melee / 3 ranged / 4 unknown
  nameColor: string; // CSS colour for the name (class colour), or "" for default
  itemLevel: number | null; // avg ilvl from COMBATANT_INFO, shown under the role glyph

  // Damage -- own is the player unit, pet is all their pets folded together.
  dmgOwn: number;
  dmgPet: number;
  damage: number; // dmgOwn + dmgPet
  dps: number; // damage / window seconds
  dmgOwnDps: number;
  dmgPetDps: number;
  dmgShare: number; // 0..1, this row's damage / the table's total

  // Healing -- same own/pet split.
  healOwn: number;
  healPet: number;
  healing: number; // healOwn + healPet
  hps: number;
  healOwnHps: number;
  healPetHps: number;
  healShare: number; // 0..1, this row's healing / the table's total

  // Damage taken -- the player unit only (no pets).
  taken: number;
  takenShare: number; // 0..1, this row's damage taken / the table's total

  // Active -- from `encounter_stats`; `activePct` is null for a custom
  // time range (no encounter to key stats by). `deaths` is this player's
  // death count in the encounter; `activeBins`/`deadBins` are the 10
  // per-decile fractions the "Active" cell's curve is drawn from.
  activePct: number | null;
  deaths: number;
  activeBins: number[];
  deadBins: number[];
}

export interface PlayerTableProps {
  rows: PlayerRow[];
}

type SortKey = "name" | "role" | "damage" | "healing" | "taken" | "active";

// `sortable` columns get a header button; the rest are plain labels.
// `center` aligns the header (the narrow role column).
const COLUMNS: Array<{ label: string; sort?: SortKey; center?: boolean }> = [
  { label: "Role", sort: "role", center: true },
  { label: "Player", sort: "name" },
  { label: "Damage", sort: "damage" },
  { label: "Healing", sort: "healing" },
  { label: "Damage taken", sort: "taken" },
  { label: "Active", sort: "active" },
];

// Natural ("as written") order for a key: names A->Z, everything else
// biggest first. Re-clicking the active header multiplies this by -1.
function compare(a: PlayerRow, b: PlayerRow, key: SortKey): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "role": {
      if (a.roleRank !== b.roleRank) return a.roleRank - b.roleRank;
      const m = (r: PlayerRow) => (r.roleRank === 1 ? r.healing : r.damage);
      return m(b) - m(a);
    }
    case "damage":
      return b.damage - a.damage;
    case "healing":
      return b.healing - a.healing;
    case "taken":
      return b.taken - a.taken;
    case "active":
      return (b.activePct ?? -1) - (a.activePct ?? -1);
  }
}

function sortRows(rows: PlayerRow[], key: SortKey, dir: 1 | -1): PlayerRow[] {
  return [...rows].sort((a, b) => dir * (compare(a, b, key) || a.name.localeCompare(b.name)));
}

registerWidget<PlayerTableProps>("player-table", (props) => {
  const element = document.createElement("div");
  element.className = "player-table";

  let rows: PlayerRow[] = [];
  let view: PlayerRow[] = []; // `rows` in current sort order -- indexes match body rows
  let sortKey: SortKey = "role";
  let sortDir: 1 | -1 = 1;
  const max = { dmg: 1, heal: 1, taken: 1 };

  // --- header (sort controls) ---
  const header = document.createElement("div");
  header.className = "player-table-row player-table-head";
  const headBtns = new Map<SortKey, { btn: HTMLButtonElement; caret: HTMLSpanElement }>();
  for (const c of COLUMNS) {
    const cell = document.createElement("span");
    if (c.center) cell.className = "pt-head-center";
    if (c.sort) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = c.label;
      const caret = document.createElement("span");
      caret.className = "pt-sort-caret";
      btn.appendChild(caret);
      const key = c.sort;
      btn.addEventListener("click", () => {
        if (sortKey === key) sortDir = sortDir === 1 ? -1 : 1;
        else {
          sortKey = key;
          sortDir = 1;
        }
        renderBody();
      });
      headBtns.set(key, { btn, caret });
      cell.appendChild(btn);
    } else {
      cell.textContent = c.label;
    }
    header.appendChild(cell);
  }

  const body = document.createElement("div");
  body.className = "player-table-body";

  // --- hover popover (one element, one pair of delegated listeners) ---
  const tip = document.createElement("div");
  tip.className = "pt-tooltip";
  tip.hidden = true;
  element.append(header, body, tip);

  function showTip(cell: HTMLElement) {
    const rowEl = cell.closest<HTMLElement>(".player-table-row");
    const metric = cell.dataset.metric;
    if (!rowEl || !metric) return;
    const r = view[Number(rowEl.dataset.i)];
    if (!r) return;

    const isHeal = metric === "healing";
    const own = isHeal ? r.healOwn : r.dmgOwn;
    const pet = isHeal ? r.healPet : r.dmgPet;
    const ownRate = isHeal ? r.healOwnHps : r.dmgOwnDps;
    const petRate = isHeal ? r.healPetHps : r.dmgPetDps;
    const unit = isHeal ? "HPS" : "DPS";
    const line = (amount: number, rate: number) =>
      `${formatCompact(amount)} · ${formatCompact(rate)} ${unit}`;

    let html =
      `<div class="pt-tooltip-head">${isHeal ? "Healing" : "Damage"}</div>` +
      `<div class="pt-tooltip-row"><span>${r.name}</span><b>${line(own, ownRate)}</b></div>`;
    if (pet > 0) {
      html += `<div class="pt-tooltip-row"><span>Pets</span><b>${line(pet, petRate)}</b></div>`;
    }
    tip.innerHTML = html;

    const box = cell.getBoundingClientRect();
    tip.style.left = `${box.left + box.width / 2}px`;
    tip.style.top = `${box.top - 8}px`;
    tip.hidden = false;
  }

  element.addEventListener("pointerover", (ev) => {
    const cell = (ev.target as HTMLElement).closest<HTMLElement>(".pt-metric--hover");
    if (cell) showTip(cell);
  });
  element.addEventListener("pointerout", (ev) => {
    const cell = (ev.target as HTMLElement).closest<HTMLElement>(".pt-metric--hover");
    if (!cell) return;
    // Ignore moves between children of the same cell.
    if (cell.contains(ev.relatedTarget as Node | null)) return;
    tip.hidden = true;
  });

  function renderBody() {
    for (const [key, { btn, caret }] of headBtns) {
      const active = key === sortKey;
      caret.textContent = active ? (sortDir === 1 ? " ▾" : " ▴") : "";
      if (active) btn.setAttribute("aria-sort", sortDir === 1 ? "descending" : "ascending");
      else btn.removeAttribute("aria-sort");
    }

    view = sortRows(rows, sortKey, sortDir);
    tip.hidden = true;
    body.replaceChildren(
      ...view.map((r, i) => {
        const row = document.createElement("div");
        row.className = "player-table-row";
        row.dataset.i = String(i);

        const role = document.createElement("span");
        role.className = `pt-role ${roleIconClass(r.roleRank)}`.trim();
        role.innerHTML = roleIcon(r.roleRank);
        if (r.role) role.title = r.role;
        if (r.itemLevel !== null) {
          const ilvl = document.createElement("span");
          ilvl.className = "pt-role-ilvl";
          ilvl.textContent = String(r.itemLevel);
          role.appendChild(ilvl);
        }

        const who = document.createElement("span");
        who.className = "pt-who";
        const name = document.createElement("span");
        name.className = "pt-name";
        name.textContent = r.name;
        if (r.nameColor) name.style.color = r.nameColor;
        const spec = document.createElement("span");
        spec.className = "pt-spec pt-dim";
        spec.textContent = r.spec;
        who.append(name, spec);

        const dmg = buildMetricCell(
          {
            segs: [
              { cls: "pt-bar-own", value: r.dmgOwn },
              { cls: "pt-bar-pet", value: r.dmgPet },
            ],
            max: max.dmg,
            amount: r.damage,
            rate: r.dps,
            rateUnit: "DPS",
            share: r.dmgShare,
            hover: true,
          },
          "damage",
        );
        const heal = buildMetricCell(
          {
            segs: [
              { cls: "pt-bar-heal-own", value: r.healOwn },
              { cls: "pt-bar-heal-pet", value: r.healPet },
            ],
            max: max.heal,
            amount: r.healing,
            rate: r.hps,
            rateUnit: "HPS",
            share: r.healShare,
            hover: true,
          },
          "healing",
        );
        const taken = buildMetricCell(
          {
            segs: [{ cls: "pt-bar-taken", value: r.taken }],
            max: max.taken,
            amount: r.taken,
          },
          "taken",
        );
        const active = buildActiveCell({
          activePct: r.activePct,
          deaths: r.deaths,
          activeBins: r.activeBins,
          deadBins: r.deadBins,
        });

        row.append(role, who, dmg, heal, taken, active);
        return row;
      }),
    );
  }

  const widget: Widget<PlayerTableProps> = {
    element,
    update(next) {
      rows = next.rows;
      max.dmg = rows.reduce((m, r) => Math.max(m, r.damage), 1);
      max.heal = rows.reduce((m, r) => Math.max(m, r.healing), 1);
      max.taken = rows.reduce((m, r) => Math.max(m, r.taken), 1);
      renderBody();
    },
  };
  widget.update(props);
  return widget;
});
