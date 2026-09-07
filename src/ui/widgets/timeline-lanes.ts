// Timeline lanes -- a video-editor / gantt strip for one player over a
// bounded window (see docs/timeline-view.md). Inline SVG, no library.
//
// One shared time axis; below it a stack of lanes, each a row of boxes.
// A box's LEFT EDGE is its start time and its WIDTH is its duration.
// Auras (buffs / debuffs) carry a real duration; damage and heal events
// are instants -- drawn `INSTANT_MS` (1.5s) wide, and clamped down to a
// `MIN_PX` sliver when even that doesn't fit at the current zoom. Death
// intervals are pink rules across every lane.
//
// The strip is ZOOMABLE and horizontally SCROLLABLE: the SVG is drawn at
// its true pixel width (`totalMs * pxPerMs`) inside an `overflow-x:auto`
// pane, so a native scrollbar appears once it overflows. Default zoom
// shows one minute, or the whole window if that is shorter. The lane
// label gutter is a fixed HTML column that does not scroll.
//
// Each lane is COLLAPSIBLE. Collapsed (default) every box in the lane
// sits on one line -- overlapping boxes stack with the later one on top.
// Clicking the disclosure triangle splits the lane into one sub-lane per
// ability.
//
// Hovering a box shows a floating tooltip with THAT box's details only
// (not everything at that timestamp).
//
// The props are an ARRAY of tracks (one per unit). v1 always passes a
// single track; multi-character comparison just adds more.

import { registerWidget } from "../registry";
import { formatAxisTime } from "../../format";
import { el, pickTimeMajor, pickTimeMinor } from "./chart-util";

export type TimelineTone =
  | "dmgIn"
  | "dmgOut"
  | "healIn"
  | "healOut"
  | "buff"
  | "debuff"
  | "move"
  | "stop";

// Resolved by the view (names already looked up) so the widget stays dumb.
export interface TimelineBox {
  startMs: number;
  endMs: number; // == startMs for an instant
  instant: boolean;
  label: string; // spell name, or "Melee"
  tone: TimelineTone;
  amount?: number;
  periodic?: boolean; // a DoT / HoT tick rather than a direct hit
  stacks?: number; // peak stack count for a buff/debuff span (>1)
  detail?: string; // free-form value for the tooltip's first row (e.g. "320 yd")
  sourceName?: string;
  targetName?: string;
  x?: number | null;
  y?: number | null;
}

export interface TimelineLane {
  id: string;
  label: string;
  boxes: TimelineBox[];
}

export interface TimelineTrack {
  unitId: number;
  label: string;
  lanes: TimelineLane[];
}

export interface TimelineLanesProps {
  tracks: TimelineTrack[];
  deaths: { startMs: number; endMs: number | null }[];
  startMs: number;
  endMs: number;
}

const GUTTER_W = 225; // lane-label column width (px, HTML, does not scroll)
const AXIS_H = 20; // time-ruler strip at the top of the SVG
const ROW_H = 24; // one lane / sub-lane row
const ROW_GAP = 4;
const TRACK_HEAD = 20; // track label row (multi-track only)
const MIN_PX = 2; // narrowest a box is ever drawn
const INSTANT_MS = 1500; // nominal on-screen duration for an instant
const DEFAULT_SPAN_MS = 60_000; // default zoom target: 1 minute (or the whole window)
const ZOOM_FACTOR = 1.6;
const MAX_PX_PER_MS = 2; // hard zoom-in cap

const TONE_LABEL: Record<TimelineTone, string> = {
  dmgIn: "Took",
  dmgOut: "Hit",
  healIn: "Healed",
  healOut: "Heal",
  buff: "Buff",
  debuff: "Debuff",
  move: "Moving",
  stop: "Stopped",
};

function fmtDur(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

// Compact amount, whole numbers only (123456 -> "123k", 1.6M -> "2M").
function fmtAmt(n: number): string {
  const abs = Math.abs(n);
  for (const [size, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ] as const) {
    if (abs >= size) return `${Math.round(n / size)}${suffix}`;
  }
  return String(Math.round(n));
}

// One drawable row -- kept identical between the gutter (HTML) and the
// plot (SVG) so the two stay aligned.
interface Row {
  y: number;
  h: number;
  kind: "track" | "laneHead" | "lane" | "sublane";
  laneId?: string;
  label: string;
  indent?: boolean;
  collapsible?: boolean;
  expanded?: boolean;
  groupStart?: boolean; // first row of a top-level "type" lane
  hasFilter?: boolean; // lane has abilities -> show the per-lane filter control
  boxes: TimelineBox[];
}

// MDI `filter-variant` funnel (Apache-2.0, see NOTICE). Close enough to
// the requested `filter-variant-plus`; swap the path if the plus matters.
const FILTER_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
  '<path d="M6,13H18V11H6M3,6V8H21V6M10,18H14V16H10V18Z"/></svg>';

registerWidget<TimelineLanesProps>("timeline-lanes", (props) => {
  const element = document.createElement("div");
  element.className = "chart timeline-lanes";

  // Toolbar: zoom out / zoom in / fit.
  const toolbar = document.createElement("div");
  toolbar.className = "tl-toolbar";
  const zoomOut = document.createElement("button");
  zoomOut.type = "button";
  zoomOut.className = "tl-zoom-btn";
  zoomOut.textContent = "−";
  zoomOut.title = "Zoom out";
  const zoomIn = document.createElement("button");
  zoomIn.type = "button";
  zoomIn.className = "tl-zoom-btn";
  zoomIn.textContent = "+";
  zoomIn.title = "Zoom in";
  const fitBtn = document.createElement("button");
  fitBtn.type = "button";
  fitBtn.className = "tl-zoom-btn tl-zoom-fit";
  fitBtn.textContent = "Fit";
  fitBtn.title = "Fit the whole window";
  const readout = document.createElement("span");
  readout.className = "tl-zoom-readout";
  toolbar.append(zoomOut, zoomIn, fitBtn, readout);

  const plot = document.createElement("div");
  plot.className = "tl-plot";
  const gutter = document.createElement("div");
  gutter.className = "tl-gutter";
  const scroll = document.createElement("div");
  scroll.className = "tl-scroll";
  // No viewBox: user units == CSS px, so text never gets scaled/clipped.
  const svg = el("svg", {});
  const empty = document.createElement("p");
  empty.className = "tl-empty";
  empty.textContent = "Nothing recorded for this player in this window.";
  empty.hidden = true;
  const tooltip = document.createElement("div");
  tooltip.className = "tl-tooltip";
  tooltip.hidden = true;
  // Per-lane "hide abilities" popup -- persists across render() (which
  // only clears `gutter` / `svg`).
  const filterPop = document.createElement("div");
  filterPop.className = "tl-filter-pop";
  filterPop.hidden = true;
  scroll.append(svg);
  plot.append(gutter, scroll, empty, tooltip, filterPop);
  element.append(toolbar, plot);

  let current: TimelineLanesProps = props;
  let expanded = new Set<string>();
  // laneId -> set of spell labels hidden in that lane (collapsed row AND
  // its sub-lanes). A future global/category config would layer on top.
  const hidden = new Map<string, Set<string>>();
  // laneId -> its full (unfiltered) distinct spell list, rebuilt per render.
  let laneSpells = new Map<string, string[]>();
  let filterOpenLane: string | null = null;
  let pxPerMs: number | null = null; // null -> recompute default on next render
  let layout: Row[] = [];
  let contentW = 1000;
  let totalH = 200;
  let hoverRaf = 0;
  let pendingPtr: [number, number] = [0, 0];
  let lastPaneW = -1;
  let userZoomed = false;

  const totalMs = () => Math.max(1, current.endMs - current.startMs);
  const paneW = () => Math.max(120, scroll.clientWidth || plot.clientWidth - GUTTER_W || 600);
  const fitPxPerMs = () => paneW() / totalMs();

  function ensureZoom() {
    if (pxPerMs === null) {
      const target = Math.min(DEFAULT_SPAN_MS, totalMs());
      pxPerMs = clampZoom(paneW() / target);
    }
  }
  function clampZoom(v: number): number {
    return Math.max(fitPxPerMs(), Math.min(MAX_PX_PER_MS, v));
  }

  function setZoom(next: number, anchorClientX?: number) {
    userZoomed = true;
    const prev = pxPerMs ?? fitPxPerMs();
    const clamped = clampZoom(next);
    if (clamped === prev) return;
    // Keep the time under the anchor (cursor, or pane centre) fixed.
    const rect = scroll.getBoundingClientRect();
    const anchorPx = anchorClientX != null ? anchorClientX - rect.left : paneW() / 2;
    const anchorMs = (scroll.scrollLeft + anchorPx) / prev;
    pxPerMs = clamped;
    render();
    scroll.scrollLeft = anchorMs * clamped - anchorPx;
  }

  zoomOut.addEventListener("click", () => setZoom((pxPerMs ?? fitPxPerMs()) / ZOOM_FACTOR));
  zoomIn.addEventListener("click", () => setZoom((pxPerMs ?? fitPxPerMs()) * ZOOM_FACTOR));
  fitBtn.addEventListener("click", () => setZoom(fitPxPerMs()));
  // Wheel with a modifier zooms toward the cursor; plain wheel scrolls.
  scroll.addEventListener(
    "wheel",
    (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      const f = ev.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      setZoom((pxPerMs ?? fitPxPerMs()) * f, ev.clientX);
    },
    { passive: false },
  );

  const resizeObserver = new ResizeObserver(() => {
    // Only react to a real width change -- render() mutates plot height,
    // which would otherwise re-trigger this in a loop.
    const w = Math.round(paneW());
    if (Math.abs(w - lastPaneW) < 2) return;
    const first = lastPaneW < 0;
    lastPaneW = w;
    // First real measurement (or the user never touched zoom): recompute
    // the "1 minute or the whole window" default against the true width.
    if (first || !userZoomed) pxPerMs = null;
    else pxPerMs = clampZoom(pxPerMs as number);
    render();
  });
  resizeObserver.observe(plot);

  // ---- layout ------------------------------------------------------------

  function groupBySpell(boxes: TimelineBox[]): { label: string; boxes: TimelineBox[] }[] {
    const map = new Map<string, TimelineBox[]>();
    for (const b of boxes) {
      const arr = map.get(b.label);
      if (arr) arr.push(b);
      else map.set(b.label, [b]);
    }
    return [...map.entries()]
      .map(([label, bs]) => ({ label, boxes: bs }))
      .sort((a, b) => a.boxes[0].startMs - b.boxes[0].startMs);
  }

  function buildLayout(): Row[] {
    const rows: Row[] = [];
    laneSpells = new Map();
    let y = AXIS_H;
    const multi = current.tracks.length > 1;
    for (const track of current.tracks) {
      if (multi) {
        rows.push({ y, h: TRACK_HEAD, kind: "track", label: track.label, boxes: [] });
        y += TRACK_HEAD + ROW_GAP;
      }
      for (const lane of track.lanes) {
        // Full spell list (for the filter popup), then drop hidden ones.
        const allSpells = [...new Set(lane.boxes.map((b) => b.label))].sort((a, b) =>
          a.localeCompare(b),
        );
        laneSpells.set(lane.id, allSpells);
        const hide = hidden.get(lane.id);
        const kept = hide ? lane.boxes.filter((b) => !hide.has(b.label)) : lane.boxes;
        const sorted = [...kept].sort((a, b) => a.startMs - b.startMs);
        const hasFilter = allSpells.length > 0;
        const isExpanded = expanded.has(lane.id) && sorted.length > 0;
        if (isExpanded) {
          rows.push({
            y,
            h: ROW_H,
            kind: "laneHead",
            laneId: lane.id,
            label: lane.label,
            collapsible: true,
            expanded: true,
            groupStart: true,
            hasFilter,
            boxes: [],
          });
          y += ROW_H + ROW_GAP;
          for (const g of groupBySpell(sorted)) {
            rows.push({ y, h: ROW_H, kind: "sublane", laneId: lane.id, label: g.label, indent: true, boxes: g.boxes });
            y += ROW_H + ROW_GAP;
          }
        } else {
          rows.push({
            y,
            h: ROW_H,
            kind: "lane",
            laneId: lane.id,
            label: lane.label,
            collapsible: sorted.length > 0,
            expanded: false,
            groupStart: true,
            hasFilter,
            boxes: sorted,
          });
          y += ROW_H + ROW_GAP;
        }
      }
    }
    totalH = Math.max(AXIS_H + ROW_H, y - ROW_GAP + 4);
    return rows;
  }

  // ---- per-lane "hide abilities" popup --------------------------------

  function onDocPointerDown(ev: PointerEvent) {
    const t = ev.target as Element | null;
    if (t && (filterPop.contains(t) || t.closest(".tl-filter-btn"))) return;
    closeFilter();
  }
  function onFilterKey(ev: KeyboardEvent) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeFilter();
    }
  }

  function closeFilter() {
    if (filterOpenLane === null) return;
    filterOpenLane = null;
    filterPop.hidden = true;
    filterPop.replaceChildren();
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onFilterKey, true);
    render(); // drop the icon's active state
  }

  function openFilter(laneId: string, anchor: HTMLElement) {
    const spells = laneSpells.get(laneId) ?? [];
    filterOpenLane = laneId;
    filterPop.replaceChildren();

    const head = document.createElement("div");
    head.className = "tl-filter-head";
    const title = document.createElement("span");
    title.textContent = "Show abilities";
    const setAll = (show: boolean) => {
      if (show) hidden.delete(laneId);
      else hidden.set(laneId, new Set(spells));
      filterPop.querySelectorAll("input").forEach((i) => (i.checked = show));
      render();
    };
    const noneBtn = document.createElement("button");
    noneBtn.type = "button";
    noneBtn.className = "tl-filter-reset";
    noneBtn.textContent = "None";
    noneBtn.addEventListener("click", () => setAll(false));
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "tl-filter-reset";
    allBtn.textContent = "All";
    allBtn.addEventListener("click", () => setAll(true));
    const btns = document.createElement("div");
    btns.className = "tl-filter-btns";
    btns.append(noneBtn, allBtn);
    head.append(title, btns);
    filterPop.append(head);

    const list = document.createElement("div");
    list.className = "tl-filter-list";
    for (const name of spells) {
      const item = document.createElement("label");
      item.className = "tl-filter-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !(hidden.get(laneId)?.has(name) ?? false);
      cb.addEventListener("change", () => {
        let set = hidden.get(laneId);
        if (!set) {
          set = new Set();
          hidden.set(laneId, set);
        }
        if (cb.checked) set.delete(name);
        else set.add(name);
        if (set.size === 0) hidden.delete(laneId);
        render();
      });
      const txt = document.createElement("span");
      txt.textContent = name;
      txt.title = name;
      item.append(cb, txt);
      list.append(item);
    }
    filterPop.append(list);
    filterPop.hidden = false;

    // Anchor under the button, kept inside the plot.
    const pr = plot.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const maxLeft = plot.clientWidth - filterPop.offsetWidth - 6;
    filterPop.style.left = `${Math.max(6, Math.min(ar.left - pr.left, maxLeft))}px`;
    filterPop.style.top = `${ar.bottom - pr.top + 4}px`;

    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onFilterKey, true);
  }

  // ---- render ----------------------------------------------------------

  function render() {
    ensureZoom();
    layout = buildLayout();

    const anyBoxes = current.tracks.some((t) => t.lanes.some((l) => l.boxes.length > 0));
    empty.hidden = anyBoxes;
    scroll.style.visibility = anyBoxes ? "visible" : "hidden";

    const { startMs } = current;
    const dur = totalMs();
    contentW = Math.max(paneW(), Math.ceil(dur * (pxPerMs as number)));
    const xOf = (ms: number) => (ms - startMs) * (pxPerMs as number);

    svg.setAttribute("width", String(contentW));
    svg.setAttribute("height", String(totalH));
    svg.replaceChildren();
    gutter.replaceChildren();
    gutter.style.top = "0px";

    // A spacer in the gutter to clear the ruler strip.
    const gAxis = document.createElement("div");
    gAxis.className = "tl-gutter-axis";
    gAxis.style.height = `${AXIS_H}px`;
    gutter.append(gAxis);

    if (!anyBoxes) {
      readout.textContent = "";
      return;
    }

    // --- time ruler ---------------------------------------------------
    const spanSec = dur / 1000;
    const major = pickTimeMajor(spanSec, contentW);
    const minor = pickTimeMinor(major, spanSec, contentW);
    const tick = (sec: number, isMajor: boolean) => {
      const x = xOf(startMs + sec * 1000);
      if (x < -1 || x > contentW + 1) return;
      svg.appendChild(
        el("line", {
          x1: x,
          y1: isMajor ? 0 : AXIS_H * 0.55,
          x2: x,
          y2: totalH,
          class: isMajor ? "tl-grid" : "tl-grid tl-grid--minor",
        }),
      );
      if (isMajor) {
        const t = el("text", { x: x + 3, y: 13, class: "tl-axis-label" });
        t.textContent = formatAxisTime(sec * 1000, major);
        svg.appendChild(t);
      }
    };
    if (minor) for (let s = 0; s <= spanSec + 1e-6; s += minor) tick(s, false);
    for (let s = 0; s <= spanSec + 1e-6; s += major) tick(s, true);

    // --- rows -------------------------------------------------------
    let firstGroupDone = false;
    for (const row of layout) {
      if (row.kind === "track") {
        const g = document.createElement("div");
        g.className = "tl-gutter-track";
        g.style.height = `${row.h}px`;
        g.textContent = row.label;
        gutter.append(g);
        const t = el("text", { x: 6, y: row.y + row.h - 6, class: "tl-track-label" });
        t.textContent = row.label;
        svg.appendChild(t);
        continue;
      }

      const groupDivider = !!row.groupStart && firstGroupDone;
      if (row.groupStart) firstGroupDone = true;

      // gutter entry
      const g = document.createElement("div");
      g.className = "tl-gutter-row";
      if (row.indent) g.classList.add("tl-gutter-row--sub");
      if (groupDivider) g.classList.add("tl-gutter-row--group");
      g.style.height = `${row.h}px`;
      if (row.collapsible) {
        const id = row.laneId as string;
        const tri = document.createElement("span");
        tri.className = "tl-disclosure";
        tri.textContent = row.expanded ? "▾" : "▸";
        g.append(tri);
        // The whole label row toggles the lane.
        g.classList.add("tl-gutter-row--toggle");
        g.setAttribute("role", "button");
        g.tabIndex = 0;
        g.title = row.expanded ? "Collapse lane" : "Expand into per-ability sub-lanes";
        const toggle = () => {
          if (expanded.has(id)) expanded.delete(id);
          else expanded.add(id);
          render();
        };
        g.addEventListener("click", toggle);
        g.addEventListener("keydown", (ev) => {
          if (ev.target !== g) return; // not a keypress on a child control
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            toggle();
          }
        });
      } else {
        const sp = document.createElement("span");
        sp.className = "tl-disclosure tl-disclosure--empty";
        g.append(sp);
      }
      const lbl = document.createElement("span");
      lbl.className = "tl-gutter-label";
      lbl.textContent = row.label;
      lbl.title = row.label;
      g.append(lbl);

      // Per-lane "hide abilities" control.
      if (row.hasFilter) {
        const id = row.laneId as string;
        const fbtn = document.createElement("button");
        fbtn.type = "button";
        fbtn.className = "tl-filter-btn";
        const nHidden = hidden.get(id)?.size ?? 0;
        if (nHidden > 0 || filterOpenLane === id) fbtn.classList.add("is-active");
        fbtn.title = nHidden > 0 ? `${nHidden} ability(s) hidden` : "Hide abilities";
        fbtn.innerHTML = FILTER_ICON;
        fbtn.addEventListener("click", (ev) => {
          ev.stopPropagation(); // don't also toggle the lane
          if (filterOpenLane === id) closeFilter();
          else openFilter(id, fbtn);
        });
        g.append(fbtn);
      }

      gutter.append(g);

      // plot: a strong divider above each top-level "type" lane.
      if (groupDivider) {
        const dy = row.y - ROW_GAP / 2;
        svg.appendChild(el("line", { x1: 0, y1: dy, x2: contentW, y2: dy, class: "tl-lane-divider" }));
      }

      // plot: row background
      svg.appendChild(
        el("rect", { x: 0, y: row.y, width: contentW, height: row.h, class: "tl-lane-bg" }),
      );
      // Dim separators between per-ability sub-lanes (and under the lane
      // header that opens them).
      if (row.kind === "laneHead" || row.kind === "sublane") {
        const ry = row.y + row.h + ROW_GAP / 2;
        svg.appendChild(el("line", { x1: 0, y1: ry, x2: contentW, y2: ry, class: "tl-sublane-rule" }));
      }
      if (row.kind === "laneHead") continue; // header-only row, no boxes

      // Stripe parity for ticking abilities: flip per distinct tick TIME
      // (not per box -- one tick that hits several targets is many boxes
      // at the same instant and must share a shade), and precompute it
      // over every box so viewport clipping can't shift the sequence.
      const tickParity = new Map<string, Map<number, number>>();
      for (const box of row.boxes) {
        if (!box.periodic) continue;
        let m = tickParity.get(box.label);
        if (!m) {
          m = new Map();
          tickParity.set(box.label, m);
        }
        if (!m.has(box.startMs)) m.set(box.startMs, m.size % 2);
      }

      // plot: boxes -- later boxes appended last -> painted on top.
      for (const box of row.boxes) {
        const x0 = xOf(box.startMs);
        const rawW = box.instant ? xOf(box.startMs + INSTANT_MS) - x0 : xOf(box.endMs) - x0;
        const x = Math.max(0, x0);
        const w = Math.max(MIN_PX, Math.min(rawW - (x - x0), contentW - x));
        if (x > contentW || x + w < 0) continue;
        let cls = `tl-box tl-box--${box.tone}`;
        if (box.periodic && tickParity.get(box.label)?.get(box.startMs) === 1) {
          cls += " tl-box--alt";
        }
        const rect = el("rect", {
          x,
          y: row.y + 2,
          width: w,
          height: row.h - 4,
          rx: 2,
          class: cls,
        });
        svg.appendChild(rect);

        // On-box label, left-aligned, when the box is wide enough
        // (~5.8px per char at 9px): the damage/heal amount on a
        // per-ability sub-lane (a collapsed "type" lane overlaps too
        // much -- it relies on the hover tooltip), or a buff/debuff's
        // peak stack count.
        const onBox =
          box.stacks != null
            ? String(box.stacks)
            : box.amount != null && row.kind === "sublane"
              ? fmtAmt(box.amount)
              : null;
        if (onBox && w >= onBox.length * 5.8 + 7) {
          const t = el("text", {
            x: x + 3,
            y: row.y + row.h / 2 + 3,
            class: "tl-box-amt",
          });
          t.textContent = onBox;
          svg.appendChild(t);
        }
      }
    }

    // --- death rules (over everything) ------------------------------
    for (const d of current.deaths) {
      const x = xOf(d.startMs);
      if (x < -1 || x > contentW + 1) continue;
      svg.appendChild(el("line", { x1: x, y1: AXIS_H, x2: x, y2: totalH, class: "tl-death" }));
    }

    // --- zoom readout ---------------------------------------------------
    const shownMs = paneW() / (pxPerMs as number);
    readout.textContent = shownMs >= dur - 1 ? "whole window" : `${fmtDur(shownMs)} shown`;
  }

  // ---- hover ---------------------------------------------------------

  function boxAt(vx: number, vy: number): { box: TimelineBox; row: Row } | null {
    const startMs = current.startMs;
    const ppm = pxPerMs as number;
    const xOf = (ms: number) => (ms - startMs) * ppm;
    for (const row of layout) {
      if (!row.boxes.length) continue;
      if (vy < row.y + 2 || vy > row.y + row.h - 2) continue;
      let found: TimelineBox | null = null;
      for (const box of row.boxes) {
        const x0 = Math.max(0, xOf(box.startMs));
        const rawW = box.instant ? xOf(box.startMs + INSTANT_MS) - xOf(box.startMs) : xOf(box.endMs) - xOf(box.startMs);
        const w = Math.max(MIN_PX, rawW);
        const pad = Math.max(0, 3 - w / 2);
        if (vx >= x0 - pad && vx <= x0 + w + pad) found = box; // last match wins (top box)
      }
      if (found) return { box: found, row };
    }
    return null;
  }

  function processHover() {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const vx = pendingPtr[0] - rect.left;
    const vy = pendingPtr[1] - rect.top;
    const found = boxAt(vx, vy);
    if (!found) {
      tooltip.hidden = true;
      return;
    }
    const { box } = found;
    const startMs = current.startMs;
    const rows: string[] = [`<div class="tl-tt-title">${box.label}</div>`];
    const line = (k: string, v: string) =>
      `<div class="tl-tt-row"><span>${k}</span><b>${v}</b></div>`;
    rows.push(
      line(TONE_LABEL[box.tone], box.detail ?? (box.amount ? fmtAmt(box.amount) : "—")),
    );
    if (box.stacks != null) rows.push(line("Stacks", `${box.stacks} (peak)`));
    if (box.instant) {
      rows.push(line("At", formatAxisTime(box.startMs - startMs, 0.1)));
    } else {
      rows.push(
        line(
          "Span",
          `${formatAxisTime(box.startMs - startMs, 0.1)}–${formatAxisTime(box.endMs - startMs, 0.1)} (${fmtDur(box.endMs - box.startMs)})`,
        ),
      );
    }
    const incoming = box.tone === "dmgIn" || box.tone === "healIn" || box.tone === "buff" || box.tone === "debuff";
    if (incoming && box.sourceName) rows.push(line("From", box.sourceName));
    if (!incoming && box.targetName) rows.push(line("To", box.targetName));
    if (box.x != null && box.y != null) rows.push(line("Pos", `${box.x.toFixed(0)}, ${box.y.toFixed(0)}`));
    tooltip.innerHTML = rows.join("");

    // Position within .tl-plot: box centre, clamped into the scroll pane.
    const ppm = pxPerMs as number;
    const centreContentX = (box.startMs - startMs) * ppm + (box.instant ? INSTANT_MS * ppm : (box.endMs - box.startMs) * ppm) / 2;
    const paneX = GUTTER_W + centreContentX - scroll.scrollLeft;
    const clampedX = Math.max(GUTTER_W + 8, Math.min(plot.clientWidth - 8, paneX));
    tooltip.style.left = `${clampedX}px`;
    tooltip.style.top = `${found.row.y}px`;
    tooltip.hidden = false;
  }

  function onMove(ev: PointerEvent) {
    pendingPtr = [ev.clientX, ev.clientY];
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      processHover();
    });
  }
  function onLeave() {
    if (hoverRaf) {
      cancelAnimationFrame(hoverRaf);
      hoverRaf = 0;
    }
    tooltip.hidden = true;
  }
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerleave", onLeave);
  scroll.addEventListener("scroll", () => {
    if (!tooltip.hidden) tooltip.hidden = true;
  });

  render();

  return {
    element,
    destroy() {
      resizeObserver.disconnect();
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      document.removeEventListener("keydown", onFilterKey, true);
    },
    update(next) {
      const sameWindow = next.startMs === current.startMs && next.endMs === current.endMs;
      current = next;
      tooltip.hidden = true;
      if (!sameWindow) {
        pxPerMs = null; // recompute default zoom
        userZoomed = false;
        scroll.scrollLeft = 0;
        hidden.clear(); // a new window has a different ability set
        closeFilter();
      }
      render();
    },
  };
});
