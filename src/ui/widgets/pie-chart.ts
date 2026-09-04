// Donut chart -- each spell's share of total damage. Inline SVG, no
// library. A legend lists `label — value (nn%)`; hovering a legend row or
// a wedge raises that wedge and dims the rest. Sized by CSS
// (`.pie-chart`), viewBox fixed.

import { registerWidget } from "../registry";
import { formatCompact } from "../../format";

export interface PieSlice {
  label: string;
  value: number;
  color: string;
}

export interface PieChartProps {
  title: string;
  slices: PieSlice[];
}

const NS = "http://www.w3.org/2000/svg";
const R = 46;
const R_INNER = 26;
const C = 50;

// Point on the circle of radius `r` at `frac` of a full turn, 12 o'clock = 0.
function pt(frac: number, r: number): [number, number] {
  const a = frac * 2 * Math.PI - Math.PI / 2;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

// Donut-segment path from `f0` to `f1` (fractions of a turn).
function wedge(f0: number, f1: number): string {
  const large = f1 - f0 > 0.5 ? 1 : 0;
  const [ox0, oy0] = pt(f0, R);
  const [ox1, oy1] = pt(f1, R);
  const [ix1, iy1] = pt(f1, R_INNER);
  const [ix0, iy0] = pt(f0, R_INNER);
  return (
    `M${ox0},${oy0} A${R},${R} 0 ${large} 1 ${ox1},${oy1} ` +
    `L${ix1},${iy1} A${R_INNER},${R_INNER} 0 ${large} 0 ${ix0},${iy0} Z`
  );
}

registerWidget<PieChartProps>("pie-chart", (props) => {
  const element = document.createElement("div");
  element.className = "pie-chart";

  const title = document.createElement("div");
  title.className = "chart-title pie-title";

  const body = document.createElement("div");
  body.className = "pie-body";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("class", "pie-svg");
  const centre = document.createElementNS(NS, "text");
  centre.setAttribute("class", "pie-centre");
  centre.setAttribute("x", "50");
  centre.setAttribute("y", "53");
  centre.setAttribute("text-anchor", "middle");
  const legend = document.createElement("div");
  legend.className = "pie-legend";
  body.append(svg, legend);
  element.append(title, body);

  let wedges: SVGPathElement[] = [];
  let rows: HTMLElement[] = [];

  function focus(idx: number | null) {
    wedges.forEach((w, i) => w.classList.toggle("is-dim", idx !== null && i !== idx));
    rows.forEach((r, i) => r.classList.toggle("is-active", idx === i));
  }

  function render(p: PieChartProps) {
    title.textContent = p.title;
    const total = p.slices.reduce((s, x) => s + x.value, 0) || 1;

    svg.replaceChildren();
    wedges = [];
    let acc = 0;
    for (let i = 0; i < p.slices.length; i++) {
      const s = p.slices[i];
      const f0 = acc / total;
      acc += s.value;
      const f1 = acc / total;
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", f1 - f0 >= 0.9999 ? fullRing() : wedge(f0, f1));
      path.setAttribute("class", "pie-wedge");
      path.style.fill = s.color;
      path.addEventListener("pointerenter", () => focus(i));
      path.addEventListener("pointerleave", () => focus(null));
      svg.appendChild(path);
      wedges.push(path);
    }
    svg.appendChild(centre);
    centre.textContent = formatCompact(total);

    legend.replaceChildren();
    rows = p.slices.map((s, i) => {
      const row = document.createElement("div");
      row.className = "pie-legend-row";
      const dot = document.createElement("i");
      dot.style.background = s.color;
      const name = document.createElement("span");
      name.className = "pie-legend-name";
      name.textContent = s.label;
      const val = document.createElement("span");
      val.className = "pie-legend-val";
      val.textContent = `${formatCompact(s.value)} · ${Math.round((s.value / total) * 100)}%`;
      row.append(dot, name, val);
      row.addEventListener("pointerenter", () => focus(i));
      row.addEventListener("pointerleave", () => focus(null));
      legend.append(row);
      return row;
    });
  }

  // A near-100% single slice -- draw the whole ring so there's no seam.
  function fullRing(): string {
    return (
      `M${C},${C - R} A${R},${R} 0 1 1 ${C - 0.01},${C - R} Z ` +
      `M${C},${C - R_INNER} A${R_INNER},${R_INNER} 0 1 0 ${C - 0.01},${C - R_INNER} Z`
    );
  }

  render(props);
  return {
    element,
    update(next) {
      render(next);
    },
  };
});
