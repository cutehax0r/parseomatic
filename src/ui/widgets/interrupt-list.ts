// Interrupts view -- a plain vertical scrolling list, one row per
// SPELL_INTERRUPT, plus (merged, time-sorted) notable SPELL_CAST_FAILED
// rows. No library, no virtualization: a raid night is a few hundred
// rows (swap in VirtualList if a real log ever pushes past ~1-2k).
//
// The view resolves all names/spells before handing rows here.

import { registerWidget } from "../registry";
import { formatAxisTime } from "../../format";

export type InterruptListRow =
  | {
      kind: "interrupt";
      tMs: number;
      caster: string;
      target: string;
      ability: string;
      interrupted: string;
      elapsedMs: number | null;
    }
  | {
      kind: "failed";
      tMs: number;
      caster: string;
      ability: string;
      reason: string;
      count: number;
    };

export interface InterruptListProps {
  rows: InterruptListRow[]; // already time-sorted
  startMs: number;
}

registerWidget<InterruptListProps>("interrupt-list", (props) => {
  const element = document.createElement("div");
  element.className = "chart interrupt-list";

  const header = document.createElement("div");
  header.className = "chart-header il-header";
  const count = document.createElement("span");
  count.className = "il-count";
  const toggle = document.createElement("label");
  toggle.className = "il-toggle";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = true;
  toggle.append(cb, document.createTextNode(" Show failed casts"));
  header.append(count, toggle);

  const body = document.createElement("div");
  body.className = "il-body";
  const empty = document.createElement("p");
  empty.className = "il-empty";
  empty.textContent = "No interrupts in this window.";

  element.append(header, body);

  let current: InterruptListProps = props;

  const fmtTime = (tMs: number) => formatAxisTime(tMs - current.startMs, 1);

  function render() {
    const { rows } = current;
    const nInt = rows.reduce((n, r) => n + (r.kind === "interrupt" ? 1 : 0), 0);
    const nFail = rows.length - nInt;
    count.textContent = `${nInt} interrupt${nInt === 1 ? "" : "s"}`;
    toggle.hidden = nFail === 0;

    const shown = cb.checked ? rows : rows.filter((r) => r.kind === "interrupt");
    body.replaceChildren();
    if (shown.length === 0) {
      body.append(empty);
      return;
    }

    for (const r of shown) {
      const row = document.createElement("div");
      row.className = r.kind === "failed" ? "il-row il-failed" : "il-row";

      const time = document.createElement("span");
      time.className = "il-time";
      time.textContent = fmtTime(r.tMs);
      row.append(time);

      const caster = document.createElement("span");
      caster.className = "il-caster";
      caster.textContent = r.caster;
      row.append(caster);

      if (r.kind === "interrupt") {
        const arrow = document.createElement("span");
        arrow.className = "il-arrow";
        arrow.textContent = "→";
        const target = document.createElement("span");
        target.className = "il-target";
        target.textContent = r.target;
        const ability = document.createElement("span");
        ability.className = "il-ability";
        ability.textContent = r.ability;
        const what = document.createElement("span");
        what.className = "il-what";
        what.textContent =
          `interrupted ${r.interrupted}` +
          (r.elapsedMs != null ? ` · ${(r.elapsedMs / 1000).toFixed(1)}s in` : "");
        row.append(arrow, target, ability, what);
      } else {
        const ability = document.createElement("span");
        ability.className = "il-ability";
        ability.textContent = r.ability;
        const what = document.createElement("span");
        what.className = "il-what";
        what.textContent = `failed: ${r.reason}` + (r.count > 1 ? ` ×${r.count}` : "");
        row.append(ability, what);
      }

      body.append(row);
    }
  }

  cb.addEventListener("change", render);
  render();

  return {
    element,
    update(next) {
      current = next;
      render();
    },
  };
});
