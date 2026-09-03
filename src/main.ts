import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { VirtualList } from "./virtual-list";
import type {
  UnitRow,
  EncounterRow,
  DeathRow,
  CombatantRow,
  RangeSource,
  RangeSelection,
} from "./types";
import { formatDuration, formatEncounterResult, formatUnitName } from "./format";
import { setRange, setLogData } from "./ui/context";
import {
  configureHistory,
  pushHistory,
  resetHistory,
  historyBack,
  historyForward,
  historyGoto,
  clearHistory,
  historyState,
  subscribeHistory,
  type HistoryState,
} from "./ui/history";
import { renderOverview } from "./views/overview";
import { renderLaunch } from "./views/launch";
import { renderEncounterGrid } from "./views/encounter-grid";

interface WindowInfo {
  lineCount: number;
  percent: number;
  done: boolean;
  path: string;
}

interface SpellRow {
  spellId: number;
  name: string;
  school: number;
}

interface ZoneRow {
  mapId: number;
  name: string;
}

interface DebugListsPayload {
  units: UnitRow[];
  spells: SpellRow[];
  zones: ZoneRow[];
  encounters: EncounterRow[];
  deaths: DeathRow[];
  combatants: CombatantRow[];
}

interface RawEventRow {
  row: number;
  timestampMs: number;
  kind: string;
  sourceUnitId: number | null;
  targetUnitId: number | null;
  spellId: number | null;
  position: [number, number] | null;
  details: string;
}

interface DebugCounts {
  players: number;
  pets: number;
  creatures: number;
  units: number;
  spells: number;
  zones: number;
  encounters: number;
  deaths: number;
  gear: number;
}

// [singular, plural] noun per tab, keyed by the tab buttons' data-tab value.
const TAB_LABELS: Record<keyof DebugCounts, [string, string]> = {
  players: ["player", "players"],
  pets: ["pet", "pets"],
  creatures: ["creature", "creatures"],
  units: ["unit", "units"],
  spells: ["spell", "spells"],
  zones: ["zone", "zones"],
  encounters: ["encounter", "encounters"],
  deaths: ["death", "deaths"],
  gear: ["gear snapshot", "gear snapshots"],
};

const lineFormatter = new Intl.NumberFormat();

// Set by refreshStatus whenever data loads, read by updateSummaryText
// whenever the active tab changes -- keeps the status line's trailing
// "X <noun>" in sync with whichever tab is currently showing without
// needing a fresh backend round-trip on every tab click.
let lastLineCount: number | null = null;
let lastCounts: DebugCounts | null = null;
// The lineCount lastCounts was actually built from. refreshStatus fires
// on both log-changed and view-changed, but debug_lists rebuilds its
// entire payload (every unit/spell/zone/encounter/death/gear row, all
// cloned) from scratch server-side -- once a log is done, lineCount is
// stable for it, so a mismatch is the only signal that actually means
// "the log changed, go refetch," not "the user switched tabs."
let lastListsLineCount: number | null = null;

// Backend intern ids (`GuidTable`/`SpellTable`) are dense and 0-indexed,
// so `units[id]`/`spells[id]` is an O(1) lookup -- the raw view sends ids
// (see RawEventRow) instead of resolved strings and resolves them
// against these, set alongside lastCounts whenever debug_lists is
// fetched. Avoids re-cloning the same handful of player/pet names on
// every scroll tick, including rows already scrolled past.
let unitsById: UnitRow[] = [];
let spellsById: SpellRow[] = [];

type ViewMode = "debug" | "raw" | "overview";
let currentViewMode: ViewMode = "overview";

const RAW_ROW_HEIGHT = 24;

const DATA_ROW_HEIGHT = 24;

// One VirtualList<string[]> per debug tab, keyed by tab id (e.g.
// "players"). Every tab's data is small enough to hold entirely in
// memory (unlike the raw view's 1.8M rows), so `fetchRange` just slices
// `rows` -- the same recycling-row machinery still avoids the ~6k real
// DOM rows that made these tables the raw view's next-worst offender
// (see docs/performance-concerns.md #1).
const debugTables = new Map<string, { list: VirtualList<string[]>; rows: string[][] }>();

function getOrCreateDebugTable(tabKey: string, gridColumns: string): { list: VirtualList<string[]>; rows: string[][] } {
  const existing = debugTables.get(tabKey);
  if (existing) return existing;

  const container = document.querySelector<HTMLElement>(`#${tabKey}-scroll`);
  const spacer = document.querySelector<HTMLElement>(`#${tabKey}-spacer`);
  const rowsContainer = document.querySelector<HTMLElement>(`#${tabKey}-rows`);
  const header = document.querySelector<HTMLElement>(`#${tabKey}-header`);
  if (!container || !spacer || !rowsContainer) throw new Error(`debug table DOM missing for "${tabKey}"`);

  container.style.setProperty("--cols", gridColumns);
  header?.style.setProperty("--cols", gridColumns);

  const state = { rows: [] as string[][], list: null as unknown as VirtualList<string[]> };
  state.list = new VirtualList<string[]>({
    container,
    spacer,
    rowsContainer,
    rowHeight: DATA_ROW_HEIGHT,
    createRow: () => {
      const div = document.createElement("div");
      div.className = "data-row";
      return div;
    },
    renderRow: (cells, el) => {
      // VirtualList already positioned `el` (anchored to the live scroll
      // position, possibly scale-compressed for a huge total) -- setting
      // `top` again here from the raw logical `index` would silently
      // clobber that with the wrong, uncompressed value.
      if (el.children.length !== cells.length) {
        el.replaceChildren(
          ...cells.map(() => {
            const span = document.createElement("span");
            span.className = "data-col";
            return span;
          }),
        );
      }
      cells.forEach((text, i) => {
        (el.children[i] as HTMLElement).textContent = text;
      });
    },
    fetchRange: (start, count) => state.rows.slice(start, start + count),
  });

  debugTables.set(tabKey, state);
  return state;
}

function renderTable(tabKey: string, gridColumns: string, rows: string[][], emptyMessage: string) {
  const table = getOrCreateDebugTable(tabKey, gridColumns);
  table.rows = rows;

  const emptyEl = document.querySelector<HTMLElement>(`#${tabKey}-empty`);
  const scrollEl = document.querySelector<HTMLElement>(`#${tabKey}-scroll`);
  const isEmpty = rows.length === 0;
  if (emptyEl) {
    emptyEl.hidden = !isEmpty;
    emptyEl.textContent = emptyMessage;
  }
  if (scrollEl) scrollEl.hidden = isEmpty;

  table.list.setTotal(rows.length);
}

function renderDebugLists(lists: DebugListsPayload): DebugCounts {
  unitsById = lists.units;
  spellsById = lists.spells;

  renderTable(
    "units",
    "1fr 100px 220px 220px",
    lists.units.map((u) => [formatUnitName(u), u.kind, u.owner ?? "", u.guid]),
    "No units found in this log.",
  );
  renderTable(
    "spells",
    "1fr 120px 100px",
    lists.spells.map((s) => [s.name, String(s.spellId), "0x" + s.school.toString(16)]),
    "No spells found in this log.",
  );
  renderTable(
    "zones",
    "1fr 120px",
    lists.zones.map((z) => [z.name, String(z.mapId)]),
    "No zones found in this log.",
  );

  // Players, pets, and creatures are pure filters over the units list, not
  // separate backend data. Pets is specifically *player-owned* units only
  // (covers Pet-GUID minions and owned totems/guardians alike, via a
  // lookup on the owner's own kind) -- something owned by a creature
  // rather than a player belongs in Creatures instead, not Pets.
  const kindByGuid = new Map(lists.units.map((u) => [u.guid, u.kind]));
  const isPlayerOwned = (u: UnitRow) => u.owner !== null && kindByGuid.get(u.owner) === "Player";

  const players = lists.units.filter((u) => u.kind === "Player");
  const pets = lists.units.filter(isPlayerOwned);
  const creatures = lists.units.filter((u) => u.kind === "Creature" && !isPlayerOwned(u));

  renderTable(
    "players",
    "1fr 160px 320px",
    players.map((u) => [u.name, u.server ?? "", u.guid]),
    "No players found in this log.",
  );
  renderTable(
    "pets",
    "1fr 100px 220px 220px",
    pets.map((u) => [formatUnitName(u), u.kind, u.owner ?? "", u.guid]),
    "No player-owned pets found in this log.",
  );
  renderTable(
    "creatures",
    "1fr 100px 220px 220px",
    creatures.map((u) => [formatUnitName(u), u.kind, u.owner ?? "", u.guid]),
    "No creatures found in this log.",
  );

  renderTable(
    "encounters",
    "1fr 100px 120px 120px",
    lists.encounters.map((e) => [
      e.isTrash ? "Trash" : e.name,
      formatEncounterResult(e),
      formatDuration(e.durationMs),
      e.isTrash ? "" : String(e.groupSize),
    ]),
    "No encounters found in this log.",
  );
  renderTable(
    "deaths",
    "1fr 1fr 140px",
    lists.deaths.map((d) => [d.playerName, d.encounterName, new Date(d.timestampMs).toLocaleTimeString()]),
    "No player deaths found in this log.",
  );
  renderTable(
    "gear",
    "1fr 1fr 100px 140px 100px",
    lists.combatants.map((c) => [
      c.playerName,
      c.encounterName,
      String(c.specId),
      c.avgItemLevel !== null ? c.avgItemLevel.toFixed(1) : "",
      String(c.itemCount),
    ]),
    "No COMBATANT_INFO lines found in this log -- spec/gear snapshots aren't available for this capture.",
  );

  return {
    players: players.length,
    pets: pets.length,
    creatures: creatures.length,
    units: lists.units.length,
    spells: lists.spells.length,
    zones: lists.zones.length,
    encounters: lists.encounters.filter((e) => !e.isTrash).length,
    deaths: lists.deaths.length,
    gear: lists.combatants.length,
  };
}

function activeTabKey(): keyof DebugCounts {
  const tab = document.querySelector<HTMLButtonElement>(".tab-btn.active")?.dataset.tab;
  return tab && tab in TAB_LABELS ? (tab as keyof DebugCounts) : "players";
}

function updateSummaryText() {
  const statusEl = document.querySelector<HTMLElement>("#log-status");
  if (!statusEl || lastLineCount === null) return;
  if (!lastCounts) {
    statusEl.textContent = `${lineFormatter.format(lastLineCount)} lines`;
    return;
  }
  const tab = activeTabKey();
  const count = lastCounts[tab];
  const [singular, plural] = TAB_LABELS[tab];
  const noun = count === 1 ? singular : plural;
  statusEl.textContent = `${lineFormatter.format(lastLineCount)} lines — ${lineFormatter.format(count)} ${noun}`;
}

function formatRawTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function createRawRowElement(): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "raw-row";
  const columns = ["raw-col-time", "raw-col-kind", "raw-col-source", "raw-col-target", "raw-col-spell", "raw-col-details"];
  for (const cls of columns) {
    const span = document.createElement("span");
    span.className = `raw-col ${cls}`;
    div.appendChild(span);
  }
  return div;
}

function setRawCell(el: HTMLElement, text: string, clickable: boolean, tooltip?: string) {
  el.textContent = text;
  el.classList.toggle("raw-clickable", clickable);
  if (tooltip) {
    el.title = tooltip;
  } else {
    el.removeAttribute("title");
  }
}

// Row content is updated in place on an already-appended, recycled
// element (see VirtualList) rather than rebuilt from scratch every
// time. VirtualList already positioned `el` before calling this --
// don't touch `top` here (see the debug-table renderRow for why that
// used to silently break the raw view specifically: VirtualList
// anchors to the live, possibly scale-compressed scroll position for a
// huge total, which a naive `index * rowHeight` here would clobber).
function renderRawRow(r: RawEventRow, el: HTMLElement) {
  const [time, kind, source, target, spell, details] = Array.from(el.children) as HTMLElement[];
  const sourceUnit = r.sourceUnitId !== null ? unitsById[r.sourceUnitId] : undefined;
  const targetUnit = r.targetUnitId !== null ? unitsById[r.targetUnitId] : undefined;
  const spellRow = r.spellId !== null ? spellsById[r.spellId] : undefined;
  setRawCell(time, formatRawTimestamp(r.timestampMs), false);
  setRawCell(kind, r.kind, false);
  setRawCell(source, sourceUnit ? formatUnitName(sourceUnit) : "", sourceUnit !== undefined, sourceUnit?.guid);
  setRawCell(target, targetUnit ? formatUnitName(targetUnit) : "", targetUnit !== undefined, targetUnit?.guid);
  setRawCell(spell, spellRow?.name ?? "", spellRow !== undefined);
  const position = r.position ? `[${r.position[0].toFixed(1)}, ${r.position[1].toFixed(1)}] ` : "";
  setRawCell(details, position + r.details, false, position + r.details);
}

let rawList: VirtualList<RawEventRow> | null = null;

function getRawList(): VirtualList<RawEventRow> | null {
  if (rawList) return rawList;
  const container = document.querySelector<HTMLElement>("#raw-scroll");
  const spacer = document.querySelector<HTMLElement>("#raw-spacer");
  const rowsContainer = document.querySelector<HTMLElement>("#raw-rows");
  if (!container || !spacer || !rowsContainer) return null;
  rawList = new VirtualList<RawEventRow>({
    container,
    spacer,
    rowsContainer,
    rowHeight: RAW_ROW_HEIGHT,
    overscan: 15,
    createRow: createRawRowElement,
    renderRow: renderRawRow,
    fetchRange: (start, count) =>
      invoke<RawEventRow[] | null>("raw_events", { start, count }).then((rows) => rows ?? []),
  });
  return rawList;
}

// Called whenever the raw view becomes the active one (or the log
// changes while it's active) -- sizes the virtual-scroll spacer and
// forces a fresh render regardless of scroll position, since the
// previous render (if any) was for a different log.
async function loadRawView() {
  const total = (await invoke<number | null>("raw_event_count")) ?? 0;
  getRawList()?.setTotal(total);
}

// ---- Encounter picker -----------------------------------------------------
//
// A custom popup listbox in the toolbar (index.html #encounter-picker),
// plus a "Custom range" popover with two datetime-local inputs. UI only
// for now: it populates from the loaded log's encounter list and
// broadcasts the current selection as a `filter-changed` CustomEvent on
// `window` (`detail.range`). Nothing consumes that event yet -- the
// planned "Log" page's table widget will. Raw/Debug are untouched.
//
// When the ViewContext/filter-chain from docs/ui-widgets.md lands, this
// becomes one `encounter-picker` widget writing to `ctx.setFilterChain`;
// the window CustomEvent is the stand-in until then.

// `RangeSource` / `RangeSelection` live in ./types (shared with src/ui).
// The filter is ALWAYS a concrete [startMs, endMs]. `source` is only what
// the menu highlights and how the button labels it: picking an encounter
// row sets the range to that encounter's bounds but keeps its own
// identity; "custom" is the free range edited in the popover. There's no
// "everything" source -- the whole-log range is just a custom range at
// full width, which the popover's snap buttons produce.

// Menu layout mode. "grouped" (below) = bosses grouped by name + a
// separate Trash section. "chronological" (planned, gated on a Settings
// toggle "Sort pulls chronologically / trash separately") = one flat
// file-ordered list interleaving trash and pulls by time. Only "grouped"
// is implemented; see docs/ui-widgets.md.
const pickerSortMode: "grouped" | "chronological" = "grouped";

let encounterRows: EncounterRow[] = [];
// Absolute path of the log this window is showing (from `window_info`);
// the encounter-grid header displays it.
let currentLogPath = "";

// (Re)draws the "choose an encounter" grid into #overview-empty. Cheap
// enough to call on every selection change (to move the highlight).
function renderEncGrid(): void {
  const el = document.querySelector<HTMLElement>("#overview-empty");
  if (!el || encounterRows.length === 0) return;
  const sel = rangeSelection.source;
  renderEncounterGrid(el, {
    path: currentLogPath,
    encounters: encounterRows,
    selectedIndex: sel.kind === "encounter" ? sel.index : null,
    onPick: (idx) => {
      const e = encounterRows[idx];
      if (e) applySelection({ startMs: e.startMs, endMs: e.endMs, source: { kind: "encounter", index: idx } });
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
function applySelection(
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
function setEncounterPickerVisible(visible: boolean): void {
  const slot = document.querySelector<HTMLElement>("#encounter-picker-slot");
  const picker = document.querySelector<HTMLElement>("#encounter-picker");
  if (slot) slot.hidden = !visible;
  if (picker) picker.hidden = !visible;
  if (!visible) closePicker();
}

function setupEncounterPicker(): void {
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

// ---- Selection history (toolbar back/forward + the history popup) --------

function historyPopupOpen(): boolean {
  return document.querySelector<HTMLElement>("#history-picker")?.dataset.open === "true";
}

function setHistoryPopupOpen(open: boolean): void {
  const picker = document.querySelector<HTMLElement>("#history-picker");
  const btn = document.querySelector<HTMLButtonElement>("#history-menu-btn");
  const popup = document.querySelector<HTMLElement>("#history-popup");
  if (!picker || !btn || !popup) return;
  picker.dataset.open = String(open);
  btn.setAttribute("aria-expanded", String(open));
  popup.hidden = !open;
  if (open) {
    renderHistoryPopup(historyState()); // built lazily -- only while visible
    popup.focus();
  }
}

// Newest-first list; the current entry is marked. "Clear History" lives on
// the app menu bar's History menu, not here.
function renderHistoryPopup(state: HistoryState): void {
  const popup = document.querySelector<HTMLElement>("#history-popup");
  if (!popup) return;
  popup.replaceChildren();

  for (let i = state.entries.length - 1; i >= 0; i--) {
    const row = document.createElement("div");
    row.className = "picker-option";
    row.setAttribute("role", "menuitem");
    row.dataset.index = String(i);
    row.textContent = state.entries[i].label;
    if (i === state.cursor) row.setAttribute("aria-current", "true");
    popup.appendChild(row);
  }
}

// Last nav state pushed to the native History menu -- skip the IPC when
// it hasn't moved. `null` forces a send on the first call and after a
// focus change (a different window re-asserting).
let lastNavSent: { back: boolean; forward: boolean } | null = null;

function syncHistoryUi(state: HistoryState): void {
  const back = document.querySelector<HTMLButtonElement>("#history-back-btn");
  const fwd = document.querySelector<HTMLButtonElement>("#history-forward-btn");
  if (back) back.disabled = !state.canBack;
  if (fwd) fwd.disabled = !state.canForward;

  // Only rebuild the popup DOM while it's actually visible.
  if (historyPopupOpen()) renderHistoryPopup(state);

  if (!lastNavSent || lastNavSent.back !== state.canBack || lastNavSent.forward !== state.canForward) {
    lastNavSent = { back: state.canBack, forward: state.canForward };
    void invoke("set_history_nav", {
      canBack: state.canBack,
      canForward: state.canForward,
    }).catch(() => {});
  }
}

function setupHistory(): void {
  const back = document.querySelector<HTMLButtonElement>("#history-back-btn");
  const fwd = document.querySelector<HTMLButtonElement>("#history-forward-btn");
  const menuBtn = document.querySelector<HTMLButtonElement>("#history-menu-btn");
  const popup = document.querySelector<HTMLElement>("#history-popup");
  if (!back || !fwd || !menuBtn || !popup) return;

  // Back/Forward navigate; they don't re-record (history "none").
  configureHistory((sel) => applySelection(sel, { history: "none" }));

  back.addEventListener("click", () => historyBack());
  fwd.addEventListener("click", () => historyForward());

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setHistoryPopupOpen(!historyPopupOpen());
  });

  popup.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".picker-option");
    if (!row) return;
    if (row.dataset.index !== undefined) historyGoto(Number(row.dataset.index));
    setHistoryPopupOpen(false);
    menuBtn.focus();
  });

  popup.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setHistoryPopupOpen(false);
      menuBtn.focus();
    }
  });

  document.addEventListener("click", (e) => {
    const picker = document.querySelector<HTMLElement>("#history-picker");
    if (picker && historyPopupOpen() && !picker.contains(e.target as Node)) setHistoryPopupOpen(false);
  });

  subscribeHistory(syncHistoryUi);
  syncHistoryUi(historyState());

  listen<string>("history-command", (ev) => {
    if (ev.payload === "back") historyBack();
    else if (ev.payload === "forward") historyForward();
    else if (ev.payload === "clear") clearHistory();
  });
  // The menu bar is app-level; on focus, re-assert this window's nav state.
  // On focus the app-level History menu may be showing another window's
  // nav state -- force a re-send even if ours hasn't changed.
  listen("window-focused", () => {
    lastNavSent = null;
    syncHistoryUi(historyState());
    // Keep the launch screen's recent list fresh if a file was opened in
    // another window while this one sat blank.
    if (!document.querySelector<HTMLElement>("#launch-view")?.hidden) void renderLaunch();
  });
}

async function refreshStatus() {
  const content = document.querySelector<HTMLElement>("#content");
  const statusEl = document.querySelector<HTMLElement>("#log-status");
  const launchView = document.querySelector<HTMLElement>("#launch-view");
  const debugView = document.querySelector<HTMLElement>("#debug-view");
  const rawView = document.querySelector<HTMLElement>("#raw-view");
  const overviewView = document.querySelector<HTMLElement>("#overview-view");
  const overviewBtn = document.querySelector<HTMLButtonElement>("#view-overview-btn");
  const statusBar = document.querySelector<HTMLElement>("#status-bar");
  const statusBarFill = document.querySelector<HTMLElement>("#statusbar-fill");
  const statusBarText = document.querySelector("#statusbar-text");
  if (
    !content ||
    !statusEl ||
    !launchView ||
    !debugView ||
    !rawView ||
    !overviewView ||
    !overviewBtn ||
    !statusBar ||
    !statusBarFill ||
    !statusBarText
  ) {
    return;
  }

  const [info, viewId] = await Promise.all([
    invoke<WindowInfo | null>("window_info"),
    invoke<string>("current_view"),
  ]);
  currentViewMode = viewId === "raw" ? "raw" : viewId === "overview" ? "overview" : "debug";
  // Only Overview has a toolbar button now (Debug/Raw are menu-only, under
  // View > Developer); it reads as "pressed" whenever Overview is showing.
  overviewBtn.setAttribute("aria-pressed", String(currentViewMode === "overview"));

  if (!info) {
    statusEl.hidden = true;
    launchView.hidden = false;
    void renderLaunch();
    statusBar.hidden = true;
    content.classList.remove("has-data");
    debugView.hidden = true;
    rawView.hidden = true;
    overviewView.hidden = true;
    lastLineCount = null;
    lastCounts = null;
    lastListsLineCount = null;
    encounterRows = [];
    encounterOptionLabels.clear();
    logStartMs = 0;
    logEndMs = 0;
    applySelection(
      { startMs: 0, endMs: 0, source: { kind: "custom" } },
      { silent: true, history: "none" },
    );
    setEncounterPickerVisible(false);
    return;
  }

  currentLogPath = info.path;

  if (!info.done) {
    lastLineCount = info.lineCount;
    lastCounts = null;
    updateSummaryText();
    launchView.hidden = true;
    content.classList.remove("has-data");
    debugView.hidden = true;
    rawView.hidden = true;
    overviewView.hidden = true;
    setEncounterPickerVisible(false);

    statusBar.hidden = false;
    const percent = Math.round(info.percent);
    statusBarFill.style.width = `${percent}%`;
    statusBarText.textContent = `Parsing... ${percent}%`;
    return;
  }

  statusBar.hidden = true;
  statusBarFill.style.width = "0%";
  lastLineCount = info.lineCount;

  // debug_lists rebuilds and clones its entire payload server-side --
  // skip the round-trip (and the full-DOM rebuild in renderDebugLists)
  // entirely when we already have it for this exact log. A view-only
  // change (log-changed re-fires "done" state, or the user just flipped
  // to Raw) never changes lineCount, so this is a safe, cheap guard.
  if (lastListsLineCount !== info.lineCount) {
    const lists = await invoke<DebugListsPayload | null>("debug_lists");
    if (!lists) {
      lastCounts = null;
      lastListsLineCount = null;
      updateSummaryText();
      content.classList.remove("has-data");
      debugView.hidden = true;
      rawView.hidden = true;
      overviewView.hidden = true;
      setEncounterPickerVisible(false);
      return;
    }
    lastCounts = renderDebugLists(lists);
    lastListsLineCount = info.lineCount;

    // Feed the shared stores the src/ui views read from.
    setLogData({
      encounters: lists.encounters,
      deaths: lists.deaths,
      units: lists.units,
      combatants: lists.combatants,
    });

    // New log -> repopulate the encounter picker and reset the range to
    // the whole log (notifying any listener the filter changed).
    encounterRows = lists.encounters;
    computeLogExtent();
    buildEncounterMenu();
    applySelection(fullLogSelection(), { history: "reset" });
  }
  updateSummaryText();
  renderEncGrid();

  launchView.hidden = true;
  content.classList.add("has-data");
  setEncounterPickerVisible(true);
  debugView.hidden = currentViewMode !== "debug";
  rawView.hidden = currentViewMode !== "raw";
  overviewView.hidden = currentViewMode !== "overview";
  // The "X lines — Y players" line is parser-sanity-check context for
  // Debug/Raw; on Overview it's just noise.
  statusEl.hidden = currentViewMode === "overview";
  if (currentViewMode === "overview") {
    renderOverview();
  } else if (currentViewMode === "raw") {
    await loadRawView();
  } else {
    // The active tab's scroll container had clientHeight 0 while the
    // whole debug view was hidden (e.g. we were showing Raw) -- force a
    // re-measure now that it's visible again.
    debugTables.get(activeTabKey())?.list.refresh();
  }
}

function setupTabs() {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".tab-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll<HTMLElement>(".tab-panel").forEach((panel) => {
        panel.hidden = panel.dataset.panel !== btn.dataset.tab;
      });
      // The now-visible panel's scroll container had clientHeight 0 while
      // hidden, so whatever VirtualList last computed from that is stale --
      // force it to re-measure against its real height now.
      if (btn.dataset.tab) debugTables.get(btn.dataset.tab)?.list.refresh();
      updateSummaryText();
    });
  });
}

window.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  setupEncounterPicker();
  setupHistory();
  refreshStatus();

  document.querySelector("#open-file-btn")?.addEventListener("click", () => {
    invoke("open_log_file");
  });

  document.querySelector("#new-window-btn")?.addEventListener("click", () => {
    invoke("new_window_from");
  });

  document.querySelector("#view-overview-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "overview" });
  });

  document.querySelector("#zoom-out-btn")?.addEventListener("click", () => {
    invoke("zoom", { direction: -1 });
  });
  document.querySelector("#zoom-in-btn")?.addEventListener("click", () => {
    invoke("zoom", { direction: 1 });
  });

  listen("log-changed", () => refreshStatus());
  listen("view-changed", () => refreshStatus());
});
