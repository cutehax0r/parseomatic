// The Overview players-table "Active" cell: a smooth curve through the
// per-decile activity level, with the stretches the player was dead for
// redrawn yellow (a clipPath over the dead x-ranges -- one treatment, a
// colour change at full strength). Headline is the active %; the death
// count lives on the Damage-taken cell, not here.
//
// Plain DOM factory like metric-cell.ts -- the player table rebuilds its
// body on every sort, so this stays cheap `createElement` + a static SVG
// string, no lifecycle.

const VB_W = 120;
const VB_H = 24;
const PAD = 1.5;
// A decile counts as "dead" for the recolour when the player was dead for
// more than half of it.
const DEAD_CUTOFF = 0.5;

let clipSeq = 0;

export interface ActiveCellSpec {
  activePct: number | null; // null: no encounter stats (custom range) -> dash
  activeBins: number[]; // 0..1 per decile
  deadBins: number[]; // 0..1 per decile
}

// Catmull-Rom -> cubic bezier through `pts` (matches the line-chart widget).
function smoothPath(pts: Array<[number, number]>): string {
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function sparkSvg(activeBins: number[], deadBins: number[]): string {
  const n = activeBins.length;
  if (n < 2) return "";
  const step = VB_W / (n - 1);
  const pts = activeBins.map(
    (a, i) => [i * step, (1 - Math.max(0, Math.min(1, a))) * (VB_H - 2 * PAD) + PAD] as [number, number],
  );
  const line = smoothPath(pts);
  const fill = `${line}L${VB_W},${VB_H}L0,${VB_H}Z`;

  // x-ranges (one per dead decile) to redraw yellow
  const deadRanges: Array<[number, number]> = [];
  deadBins.forEach((dv, i) => {
    if (dv > DEAD_CUTOFF) deadRanges.push([(i - 0.5) * step, (i + 0.5) * step]);
  });

  let deadOverlay = "";
  if (deadRanges.length) {
    const id = `sk${++clipSeq}`;
    const rects = deadRanges
      .map(
        ([x0, x1]) =>
          `<rect x="${Math.max(0, x0).toFixed(1)}" y="0" width="${(x1 - x0).toFixed(1)}" height="${VB_H}"/>`,
      )
      .join("");
    deadOverlay =
      `<defs><clipPath id="${id}">${rects}</clipPath></defs>` +
      `<path class="pt-spark-fill pt-spark-dead" d="${fill}" clip-path="url(#${id})"/>` +
      `<path class="pt-spark-line pt-spark-dead" d="${line}" clip-path="url(#${id})"/>`;
  }

  return (
    `<svg class="pt-spark" viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="none" aria-hidden="true">` +
    `<path class="pt-spark-fill" d="${fill}"/>` +
    `<path class="pt-spark-line" d="${line}"/>` +
    deadOverlay +
    `</svg>`
  );
}

export function buildActiveCell(spec: ActiveCellSpec): HTMLElement {
  const cell = document.createElement("div");
  cell.className = "pt-metric";

  const nums = document.createElement("span");
  nums.className = "pt-metric-nums";

  if (spec.activePct === null) {
    nums.innerHTML = `<b>—</b>`;
    cell.append(nums);
    return cell;
  }

  const svg = sparkSvg(spec.activeBins, spec.deadBins);
  if (svg) {
    const holder = document.createElement("span");
    holder.className = "pt-spark-wrap";
    holder.innerHTML = svg;
    cell.append(holder);
  }

  const main = document.createElement("span");
  main.className = "pt-metric-main";
  const amount = document.createElement("b");
  amount.textContent = `${Math.round(spec.activePct * 100)}%`;
  main.appendChild(amount);
  const sub = document.createElement("span");
  sub.className = "pt-metric-sub";
  sub.textContent = "active";
  main.appendChild(sub);
  nums.appendChild(main);

  cell.append(nums);
  return cell;
}
