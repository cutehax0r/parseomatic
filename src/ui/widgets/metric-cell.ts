// A reusable "metric" cell for tabular rows: a horizontal bar (one or more
// stacked segments) sitting above a line of numbers -- a headline amount,
// an optional rate (DPS / HPS) and an optional share (% of the column
// total). The player-table uses three per row (damage / healing / damage
// taken); any future table can reuse it the same way.
//
// This is a plain DOM factory, NOT a registered Widget. The player-table
// throws its whole body away and rebuilds it on every sort, so ~90 of
// these per repaint have to be cheap `createElement` calls with no
// per-instance lifecycle. A hover popover, where wanted, is driven by ONE
// delegated listener on the table (see player-table.ts) keyed off
// `data-metric` -- the cell only stamps that hook, it holds no listeners
// of its own.

import { formatCompact } from "../../format";

export interface BarSegment {
  cls: string; // CSS class carrying the segment colour
  value: number; // contribution to the bar, same unit as `max`
}

export interface MetricCellSpec {
  segs: BarSegment[]; // stacked left-to-right; filled width = sum / max
  max: number; // column-wide maximum, for bar scaling
  amount: number; // the headline figure
  rate?: number; // per-second figure; omit -> no rate shown
  rateUnit?: string; // "DPS" / "HPS"
  share?: number; // 0..1 of the column total; omit -> no % shown
  hover?: boolean; // stamp the delegated-hover hook + `data-metric`
}

export function buildMetricCell(spec: MetricCellSpec, metric: string): HTMLElement {
  const cell = document.createElement("div");
  cell.className = "pt-metric";
  if (spec.hover) {
    cell.classList.add("pt-metric--hover");
    cell.dataset.metric = metric;
  }

  const bar = document.createElement("span");
  bar.className = "pt-bar";
  const max = spec.max > 0 ? spec.max : 1;
  for (const s of spec.segs) {
    if (s.value <= 0) continue;
    const seg = document.createElement("span");
    seg.className = `pt-bar-seg ${s.cls}`;
    seg.style.width = `${(s.value / max) * 100}%`;
    bar.appendChild(seg);
  }

  const nums = document.createElement("span");
  nums.className = "pt-metric-nums";
  const amount = document.createElement("b");
  amount.textContent = formatCompact(spec.amount);
  nums.appendChild(amount);

  const bits: string[] = [];
  if (spec.share !== undefined) bits.push(`${(spec.share * 100).toFixed(1)}%`);
  if (spec.rate !== undefined) {
    bits.push(`${formatCompact(spec.rate)} ${spec.rateUnit ?? ""}`.trim());
  }
  if (bits.length) {
    const sub = document.createElement("span");
    sub.className = "pt-metric-sub";
    sub.textContent = bits.join(" · ");
    nums.appendChild(sub);
  }

  cell.append(bar, nums);
  return cell;
}
