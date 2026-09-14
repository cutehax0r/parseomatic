// Encounter picker -- a custom popup listbox in the toolbar
// (index.html #encounter-picker), plus a "Custom range" popover with two
// datetime-local inputs. UI only for now: it populates from the loaded
// log's encounter list and broadcasts the current selection as a
// `filter-changed` CustomEvent on `window` (`detail.range`). Nothing
// consumes that event yet -- the planned "Log" page's table widget will.
// Raw/Debug are untouched.
//
// When the ViewContext/filter-chain from docs/ui-widgets.md lands, this
// becomes one `encounter-picker` widget writing to `ctx.setFilterChain`;
// the window CustomEvent is the stand-in until then.

// `RangeSource` / `RangeSelection` live in ../types (shared with src/ui).
// The filter is ALWAYS a concrete [startMs, endMs]. `source` is only what
// the menu highlights and how the button labels it: picking an encounter
// row sets the range to that encounter's bounds but keeps its own
// identity; "custom" is the free range edited in the popover. There's no
// "everything" source -- the whole-log range is just a custom range at
// full width, which the popover's snap buttons produce.

import { invoke } from "@tauri-apps/api/core";
import type { EncounterRow, RangeSource, RangeSelection } from "../types";
import { setRange } from "./context";
import { pushHistory, resetHistory } from "./history";
import { renderEncounterGrid } from "../views/encounter-grid";
import { populatePlayerPicker } from "./player-picker";
import { getCurrentViewMode, type ViewMode } from "../main";

// Menu layout mode. "grouped" (below) = bosses grouped by name + a
// separate Trash section. "chronological" (planned, gated on a Settings
// toggle "Sort pulls chronologically / trash separately") = one flat
// file-ordered list interleaving trash and pulls by time. Only "grouped"
// is implemented; see docs/ui-widgets.md.
const pickerSortMode: "grouped" | "chronological" = "grouped";

let encounterRows: EncounterRow[] = [];
// Absolute path of the log this window is showing (from `window_info`);
// the encounter-grid header displays it. Set by main.ts's refreshStatus.
let currentLogPath = "";

export function setCurrentLogPath(path: string): void {
  currentLogPath = path;
}

// (Re)draws the "choose an encounter" grid into the Encounters view.
// Cheap enough to call on every selection change (to move the highlight).
export function renderEncGrid(): void {
  const el = document.querySelector<HTMLElement>("#encounters-grid");
  if (!el || encounterRows.length === 0) return;
  const sel = rangeSelection.source;
  renderEncounterGrid(el, {
    path: currentLogPath,
    encounters: encounterRows,
    selectedIndex: sel.kind === "encounter" ? sel.index : null,
    onPick: (idx) => {
      const e = encounterRows[idx];
      if (!e) return;
      applySelection({ startMs: e.startMs, endMs: e.endMs, source: { kind: "encounter", index: idx } });
      // Picking a pull drills straight into the Overview view.
      void invoke("set_current_view", { view: "overview" });
    },
  });
}
// The loaded log's overall time extent -- the snap targets and the
// datetime inputs' min/max. Derived from the encounter list, whose
// leading/trailing synthesized trash spans reach the first/last event
// (see reports.rs).
let logStartMs = 0;
let logEndMs = 0;
let rangeSelection: RangeSelection = { startMs: 0, endMs: 0, source: { kind: "custom" } };

export interface PendingInit {
  selection: RangeSelection;
  view: ViewMode;
}

// Opens a new window sharing this one's parsed log, carrying the current
// encounter selection + view (zoom is global). No-op with no log open.
export function duplicateWindow(): void {
  if (!currentLogPath) return;
  void invoke("duplicate_window", {
    init: { selection: rangeSelection, view: getCurrentViewMode() } satisfies PendingInit,
  });
}
// Original-array index -> the collapsed button's label for that encounter
// ("Boss Name — Pull 2", "Trash 3"). Built alongside the menu.
const encounterOptionLabels = new Map<number, string>();
let activeOption: HTMLElement | null = null;

function computeLogExtent(): void {
  logStartMs = encounterRows.reduce((m, e) => Math.min(m, e.startMs), Number.POSITIVE_INFINITY);
  logEndMs = encounterRows.reduce((m, e) => Math.max(m, e.endMs), Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(logStartMs)) logStartMs = 0;
  if (!Number.isFinite(logEndMs)) logEndMs = 0;
}

function fullLogSelection(): RangeSelection {
  return { startMs: logStartMs, endMs: logEndMs, source: { kind: "custom" } };
}

function rangeIsFullLog(sel: RangeSelection): boolean {
  return sel.startMs <= logStartMs && sel.endMs >= logEndMs;
}

function sourcesEqual(a: RangeSource, b: RangeSource): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "encounter" && b.kind === "encounter" ? a.index === b.index : true;
}

// Repopulates the picker for a newly loaded log and resets the range to
// the whole log (notifying any listener the filter changed). Called by
// main.ts's refreshStatus once `log_lists` has been fetched.
export function loadEncounterPicker(encounters: EncounterRow[]): void {
  encounterRows = encounters;
  computeLogExtent();
  buildEncounterMenu();
  applySelection(fullLogSelection(), { history: "reset" });
}

// Clears the picker's state when the window has no loaded log. Caller
// still applies a zeroed selection afterward.
export function resetEncounterPickerState(): void {
  encounterRows = [];
  encounterOptionLabels.clear();
  logStartMs = 0;
  logEndMs = 0;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function formatDurationWords(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function sameCalendarDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

// Clock with seconds. Millisecond precision lives in the datetime inputs
// and the stored range, not in any label (a label to .001s is unreadable).
function formatClockTime(ms: number): string {
  const d = new Date(ms);
  const meridiem = d.getHours() >= 12 ? "pm" : "am";
  const hours = d.getHours() % 12 || 12;
  return `${hours}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${meridiem}`;
}

// One end of a range. Prefixes "Mon D " only when the two ends fall on
// different calendar days (a raid crossing midnight).
function formatRangeEndpoint(ms: number, otherMs: number): string {
  const clock = formatClockTime(ms);
  if (sameCalendarDay(ms, otherMs)) return clock;
  const d = new Date(ms);
  return `${MONTH_ABBR[d.getMonth()]} ${d.getDate()} ${clock}`;
}

function formatRange(startMs: number, endMs: number): string {
  return `${formatRangeEndpoint(startMs, endMs)} – ${formatRangeEndpoint(endMs, startMs)}`;
}

// ms <-> <input type="datetime-local" step="0.001"> value, local time,
// millisecond precision ("2026-04-14T20:03:53.934").
function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function fromDatetimeLocal(value: string): number | null {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

type EncounterOutcome = "kill" | "wipe" | "unknown";

function encounterOutcomeWord(e: EncounterRow): EncounterOutcome {
  if (e.success === true) return "kill";
  if (e.success === false) return "wipe";
  return "unknown"; // synthesized end -- malformed log / EOF while open
}

// Collapsed-button text for the current selection.
function selectionLabel(sel: RangeSelection): string {
  if (sel.source.kind === "encounter") {
    return encounterOptionLabels.get(sel.source.index) ?? formatRange(sel.startMs, sel.endMs);
  }
  return rangeIsFullLog(sel) ? "Full log" : formatRange(sel.startMs, sel.endMs);
}

interface PickerOptionOpts {
  source: RangeSource;
  pull?: boolean;
  // Trailing detail rendered as "(meta)", or "(outcome: meta)" when
  // `outcome` is set (kill/wipe get a colored word; trash passes no
  // outcome and stays fully faint). An empty string still creates the
  // element -- the Custom range row's subtitle is filled in later.
  meta?: string;
  outcome?: EncounterOutcome;
}

function makePickerOption(label: string, opts: PickerOptionOpts): HTMLElement {
  const { source, pull = false, meta, outcome } = opts;

  const opt = document.createElement("div");
  opt.className = pull ? "picker-option picker-option--pull" : "picker-option";
  opt.setAttribute("role", "option");
  opt.dataset.source = JSON.stringify(source);

  const name = document.createElement("span");
  name.textContent = label;
  opt.appendChild(name);

  if (meta !== undefined || outcome) {
    const metaEl = document.createElement("span");
    metaEl.className = "picker-option-meta";
    if (outcome) {
      const word = document.createElement("span");
      word.className =
        outcome === "unknown"
          ? "picker-option-outcome"
          : `picker-option-outcome picker-option-outcome--${outcome}`;
      word.textContent = outcome;
      metaEl.append("(", word, `: ${meta ?? ""})`);
    } else {
      metaEl.textContent = meta ? `(${meta})` : "";
    }
    opt.appendChild(metaEl);
  }

  if (sourcesEqual(source, rangeSelection.source)) opt.setAttribute("aria-selected", "true");
  return opt;
}

function makePickerSection(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "picker-section";
  el.textContent = text;
  return el;
}

// "grouped" layout: an Encounters section with one .picker-group header
// per boss (grouped by encounterId, falling back to name; first-seen
// order kept, pulls numbered chronologically within the group), then a
// separate Trash section as a flat numbered list.
//
// TODO(settings): a "Hide resets" toggle -- drop encounters whose combat
// lasted < ~10s with few/no deaths (aborted pulls). Display filter only.
// See docs/ui-widgets.md.
function appendGroupedEncounters(menu: HTMLElement): void {
  const groups = new Map<string, number[]>(); // group key -> original indices
  encounterRows.forEach((e, i) => {
    if (e.isTrash) return;
    const key = String(e.encounterId || e.name);
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  });

  if (groups.size > 0) {
    menu.appendChild(makePickerSection("Encounters"));
    for (const indices of groups.values()) {
      const bossName = encounterRows[indices[0]].name || "(unnamed encounter)";
      const header = document.createElement("div");
      header.className = "picker-group";
      header.textContent = bossName;
      menu.appendChild(header);

      indices
        .slice()
        .sort((a, b) => encounterRows[a].startMs - encounterRows[b].startMs)
        .forEach((idx, n) => {
          const e = encounterRows[idx];
          const label = `Pull ${n + 1}`;
          menu.appendChild(
            makePickerOption(label, {
              source: { kind: "encounter", index: idx },
              pull: true,
              meta: formatDurationWords(e.durationMs),
              outcome: encounterOutcomeWord(e),
            }),
          );
          encounterOptionLabels.set(idx, `${bossName} — ${label}`);
        });
    }
  }

  const trashIndices = encounterRows.map((e, i) => (e.isTrash ? i : -1)).filter((i) => i >= 0);
  if (trashIndices.length > 0) {
    menu.appendChild(makePickerSection("Trash"));
    // TODO: better trash names -- "Pre-<boss> trash N" / "Post-<boss> trash N"
    // by adjacency to encounters, "Trash N" only when the log has no bosses.
    // See docs/ui-widgets.md.
    trashIndices.forEach((idx, n) => {
      const e = encounterRows[idx];
      const label = `Trash ${n + 1}`;
      menu.appendChild(
        makePickerOption(label, {
          source: { kind: "encounter", index: idx },
          meta: `${formatClockTime(e.startMs)}: ${formatDurationWords(e.durationMs)}`,
        }),
      );
      encounterOptionLabels.set(idx, label);
    });
  }
}

// Rebuilds the popup from `encounterRows`: the "Custom range" row (opens
// the popover; its subtitle mirrors the current range), then the
// encounter list in whichever layout `pickerSortMode` selects. Called
// once per loaded log.
function buildEncounterMenu(): void {
  const menu = document.querySelector<HTMLElement>("#encounter-picker-menu");
  if (!menu) return;
  menu.replaceChildren();
  encounterOptionLabels.clear();

  menu.appendChild(makePickerOption("Custom range", { source: { kind: "custom" }, meta: "" }));

  if (pickerSortMode === "grouped") {
    appendGroupedEncounters(menu);
  } else {
    // TODO(settings): chronological -- one flat file-ordered list
    // interleaving trash and pulls by time. See docs/ui-widgets.md.
    appendGroupedEncounters(menu);
  }

  refreshCustomRangeSubtitle();
}

// The Custom range row shows the current range as its subtitle -- that's
// what clicking it lets you edit -- regardless of which row is selected.
function refreshCustomRangeSubtitle(): void {
  const el = document.querySelector<HTMLElement>(
    '#encounter-picker-menu .picker-option[data-source*="custom"] .picker-option-meta',
  );
  if (!el) return;
  el.textContent = rangeIsFullLog(rangeSelection)
    ? "(full log)"
    : `(${formatRange(rangeSelection.startMs, rangeSelection.endMs)})`;
}

// `history`: "push" (default -- a user selection) records it on the
// selection-history stack; "reset" reseeds the stack (new log); "none"
// records nothing (teardown, and Back/Forward, which already move the
// cursor themselves).
export function applySelection(
  sel: RangeSelection,
  opts: { silent?: boolean; history?: "push" | "reset" | "none" } = {},
): void {
  rangeSelection = sel;

  const labelEl = document.querySelector<HTMLElement>("#encounter-picker-label");
  if (labelEl) labelEl.textContent = selectionLabel(sel);

  document.querySelectorAll<HTMLElement>("#encounter-picker-menu .picker-option").forEach((opt) => {
    const raw = opt.dataset.source;
    if (raw && sourcesEqual(JSON.parse(raw) as RangeSource, sel.source)) {
      opt.setAttribute("aria-selected", "true");
    } else {
      opt.removeAttribute("aria-selected");
    }
  });
  refreshCustomRangeSubtitle();

  // Shared range store -- views (src/ui) read/subscribe here. The window
  // CustomEvent stays as a coarse stand-in; nothing else listens yet.
  setRange(rangeSelection);
  if (!opts.silent) {
    window.dispatchEvent(new CustomEvent("filter-changed", { detail: { range: rangeSelection } }));
  }

  const mode = opts.history ?? "push";
  if (mode === "push") pushHistory(sel, selectionLabel(sel));
  else if (mode === "reset") resetHistory(sel, selectionLabel(sel));

  // Keep the encounter grid's highlight in step with the selection.
  renderEncGrid();

  // The player picker's roster is scoped to the selected range.
  void populatePlayerPicker();
}

function setActiveOption(el: HTMLElement | null): void {
  activeOption?.classList.remove("is-active");
  activeOption = el;
  if (el) {
    el.classList.add("is-active");
    el.scrollIntoView({ block: "nearest" });
  }
}

function moveActiveOption(delta: number): void {
  const opts = Array.from(
    document.querySelectorAll<HTMLElement>("#encounter-picker-menu .picker-option"),
  );
  if (opts.length === 0) return;
  const cur = activeOption ? opts.indexOf(activeOption) : -1;
  setActiveOption(opts[(cur + delta + opts.length) % opts.length]);
}

function pickerSurfacesOpen(): boolean {
  return document.querySelector<HTMLElement>("#encounter-picker")?.dataset.open === "true";
}

function closePicker(): void {
  const picker = document.querySelector<HTMLElement>("#encounter-picker");
  const btn = document.querySelector<HTMLButtonElement>("#encounter-picker-btn");
  const menu = document.querySelector<HTMLElement>("#encounter-picker-menu");
  const popover = document.querySelector<HTMLElement>("#encounter-range-popover");
  if (!picker || !btn || !menu || !popover) return;
  picker.dataset.open = "false";
  btn.setAttribute("aria-expanded", "false");
  menu.hidden = true;
  popover.hidden = true;
  setActiveOption(null);
}

function openPickerMenu(): void {
  const picker = document.querySelector<HTMLElement>("#encounter-picker");
  const btn = document.querySelector<HTMLButtonElement>("#encounter-picker-btn");
  const menu = document.querySelector<HTMLElement>("#encounter-picker-menu");
  const popover = document.querySelector<HTMLElement>("#encounter-range-popover");
  if (!picker || !btn || !menu || !popover) return;
  popover.hidden = true;
  menu.hidden = false;
  picker.dataset.open = "true";
  btn.setAttribute("aria-expanded", "true");
  const selected = menu.querySelector<HTMLElement>('.picker-option[aria-selected="true"]');
  setActiveOption(selected ?? menu.querySelector<HTMLElement>(".picker-option"));
  menu.focus();
}

function openRangePopover(): void {
  const picker = document.querySelector<HTMLElement>("#encounter-picker");
  const menu = document.querySelector<HTMLElement>("#encounter-picker-menu");
  const popover = document.querySelector<HTMLElement>("#encounter-range-popover");
  const startInput = document.querySelector<HTMLInputElement>("#range-start");
  const endInput = document.querySelector<HTMLInputElement>("#range-end");
  const errorEl = document.querySelector<HTMLElement>("#range-error");
  if (!picker || !menu || !popover || !startInput || !endInput) return;

  const min = toDatetimeLocal(logStartMs);
  const max = toDatetimeLocal(logEndMs);
  for (const input of [startInput, endInput]) {
    input.min = min;
    input.max = max;
  }
  startInput.value = toDatetimeLocal(rangeSelection.startMs);
  endInput.value = toDatetimeLocal(rangeSelection.endMs);
  if (errorEl) errorEl.hidden = true;

  menu.hidden = true;
  popover.hidden = false;
  picker.dataset.open = "true";
  setActiveOption(null);
  startInput.focus();
}

function applyRangePopover(): void {
  const startInput = document.querySelector<HTMLInputElement>("#range-start");
  const endInput = document.querySelector<HTMLInputElement>("#range-end");
  const errorEl = document.querySelector<HTMLElement>("#range-error");
  if (!startInput || !endInput) return;

  const fail = (msg: string) => {
    if (errorEl) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    }
  };

  const rawStart = fromDatetimeLocal(startInput.value);
  const rawEnd = fromDatetimeLocal(endInput.value);
  if (rawStart === null || rawEnd === null) {
    fail("Enter a start and end time.");
    return;
  }
  // Clamp into the log's extent.
  const startMs = Math.max(logStartMs, Math.min(rawStart, logEndMs));
  const endMs = Math.max(logStartMs, Math.min(rawEnd, logEndMs));
  if (startMs >= endMs) {
    fail("Start must be before end.");
    return;
  }

  applySelection({ startMs, endMs, source: { kind: "custom" } });
  closePicker();
  document.querySelector<HTMLButtonElement>("#encounter-picker-btn")?.focus();
}

// Menu row -> selection. The Custom range row opens the popover instead of
// applying immediately.
function chooseOption(opt: HTMLElement): void {
  const raw = opt.dataset.source;
  if (!raw) return;
  const source = JSON.parse(raw) as RangeSource;
  if (source.kind === "custom") {
    openRangePopover();
    return;
  }
  const e = encounterRows[source.index];
  if (!e) return;
  applySelection({ startMs: e.startMs, endMs: e.endMs, source });
  closePicker();
  document.querySelector<HTMLButtonElement>("#encounter-picker-btn")?.focus();
}

// Toolbar slot + picker visibility -- shown only once a log has finished
// parsing (same gate as the debug/raw views).
export function setEncounterPickerVisible(visible: boolean): void {
  const slot = document.querySelector<HTMLElement>("#encounter-picker-slot");
  const picker = document.querySelector<HTMLElement>("#encounter-picker");
  if (slot) slot.hidden = !visible;
  if (picker) picker.hidden = !visible;
  if (!visible) closePicker();
}

export function setupEncounterPicker(): void {
  const btn = document.querySelector<HTMLButtonElement>("#encounter-picker-btn");
  const menu = document.querySelector<HTMLElement>("#encounter-picker-menu");
  const popover = document.querySelector<HTMLElement>("#encounter-range-popover");
  if (!btn || !menu || !popover) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pickerSurfacesOpen()) closePicker();
    else openPickerMenu();
  });

  menu.addEventListener("click", (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>(".picker-option");
    if (opt?.dataset.source) chooseOption(opt);
  });

  menu.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveActiveOption(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveActiveOption(-1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (activeOption) chooseOption(activeOption);
        break;
      case "Escape":
        e.preventDefault();
        closePicker();
        btn.focus();
        break;
    }
  });

  popover.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!t) return;
    if (t.dataset.snap === "start") {
      const i = document.querySelector<HTMLInputElement>("#range-start");
      if (i) i.value = toDatetimeLocal(logStartMs);
    } else if (t.dataset.snap === "end") {
      const i = document.querySelector<HTMLInputElement>("#range-end");
      if (i) i.value = toDatetimeLocal(logEndMs);
    } else if (t.dataset.act === "apply") {
      applyRangePopover();
    } else if (t.dataset.act === "cancel") {
      closePicker();
      btn.focus();
    }
  });

  popover.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePicker();
      btn.focus();
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      applyRangePopover();
    }
  });

  // Click anywhere outside an open picker closes it (menu or popover).
  document.addEventListener("click", (e) => {
    const picker = document.querySelector<HTMLElement>("#encounter-picker");
    if (picker && pickerSurfacesOpen() && !picker.contains(e.target as Node)) closePicker();
  });
}
