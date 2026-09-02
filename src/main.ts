import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { VirtualList } from "./virtual-list";

interface WindowInfo {
  lineCount: number;
  percent: number;
  done: boolean;
}

interface UnitRow {
  guid: string;
  name: string;
  kind: string;
  owner: string | null;
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

interface EncounterRow {
  name: string;
  encounterId: number;
  difficultyId: number;
  groupSize: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  success: boolean | null;
  isTrash: boolean;
}

interface DeathRow {
  playerName: string;
  timestampMs: number;
  encounterName: string;
}

interface GearItemRow {
  itemId: number;
  itemLevel: number;
  enchantId: number;
  gemIds: number[];
}

interface CombatantRow {
  playerName: string;
  encounterName: string;
  specId: number;
  avgItemLevel: number | null;
  itemCount: number;
  gear: GearItemRow[];
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

type ViewMode = "debug" | "raw";
let currentViewMode: ViewMode = "debug";

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

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatEncounterResult(e: EncounterRow): string {
  if (e.isTrash) return "";
  if (e.success === true) return "Kill";
  if (e.success === false) return "Wipe";
  return "?"; // implicit end synthesized (malformed log / EOF-while-open)
}

function renderDebugLists(lists: DebugListsPayload): DebugCounts {
  unitsById = lists.units;
  spellsById = lists.spells;

  renderTable(
    "units",
    "1fr 100px 220px 220px",
    lists.units.map((u) => [u.name, u.kind, u.owner ?? "", u.guid]),
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
    "1fr 320px",
    players.map((u) => [u.name, u.guid]),
    "No players found in this log.",
  );
  renderTable(
    "pets",
    "1fr 100px 220px 220px",
    pets.map((u) => [u.name, u.kind, u.owner ?? "", u.guid]),
    "No player-owned pets found in this log.",
  );
  renderTable(
    "creatures",
    "1fr 100px 220px 220px",
    creatures.map((u) => [u.name, u.kind, u.owner ?? "", u.guid]),
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
  setRawCell(source, sourceUnit?.name ?? "", sourceUnit !== undefined, sourceUnit?.guid);
  setRawCell(target, targetUnit?.name ?? "", targetUnit !== undefined, targetUnit?.guid);
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
// A custom popup listbox in the toolbar (index.html #encounter-picker).
// UI only for now: it populates from the loaded log's encounter list and
// broadcasts the current selection as a `filter-changed` CustomEvent on
// `window`. Nothing consumes that event yet -- the planned "Log" page's
// table widget will. Raw/Debug views are deliberately untouched.
//
// When the ViewContext/filter-chain from docs/ui-widgets.md lands, this
// becomes one `encounter-picker` widget writing to `ctx.setFilterChain`;
// the window CustomEvent is the stand-in until then.

// `custom` is a free time range -- a subset of one encounter, or a span
// crossing several. Its bounds come from a future timeline brush on the
// Log page; picking "Custom range" from the menu just switches into that
// mode (null bounds) until then.
type EncounterFilter =
  | { kind: "all" }
  | { kind: "custom"; startMs: number | null; endMs: number | null }
  | { kind: "encounter"; index: number };

// Menu layout mode. "grouped" = bosses grouped by name with a separate
// Trash section (below). "chronological" (planned, gated on a Settings
// toggle "Sort pulls chronologically / trash separately") = one flat
// file-ordered list interleaving trash and pulls by time. Only "grouped"
// is implemented; see docs/ui-widgets.md.
const pickerSortMode: "grouped" | "chronological" = "grouped";

let encounterRows: EncounterRow[] = [];
let encounterFilter: EncounterFilter = { kind: "all" };
// Original-array index -> the collapsed button's label for that option
// ("Boss Name — Pull 2", "Trash 3"). Built alongside the menu.
const encounterOptionLabels = new Map<number, string>();
let activeOption: HTMLElement | null = null;

function filtersEqual(a: EncounterFilter, b: EncounterFilter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "encounter" && b.kind === "encounter") return a.index === b.index;
  return true; // "all"==="all"; any "custom" maps to the single Custom range row
}

function encounterFilterLabel(filter: EncounterFilter): string {
  switch (filter.kind) {
    case "all":
      return "Everything";
    case "custom":
      return filter.startMs !== null && filter.endMs !== null
        ? `Custom range (${formatClockTime(filter.startMs)}–${formatClockTime(filter.endMs)})`
        : "Custom range";
    case "encounter":
      return encounterOptionLabels.get(filter.index) ?? "Everything";
  }
}

function formatDurationWords(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatClockTime(ms: number): string {
  const d = new Date(ms);
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const meridiem = d.getHours() >= 12 ? "pm" : "am";
  const hours = d.getHours() % 12 || 12;
  return `${hours}:${minutes}${meridiem}`;
}

type EncounterOutcome = "kill" | "wipe" | "unknown";

function encounterOutcomeWord(e: EncounterRow): EncounterOutcome {
  if (e.success === true) return "kill";
  if (e.success === false) return "wipe";
  return "unknown"; // synthesized end -- malformed log / EOF while open
}

interface PickerOptionOpts {
  filter: EncounterFilter;
  pull?: boolean;
  // Trailing detail rendered as "(meta)", or "(outcome: meta)" when
  // `outcome` is set (kill/wipe get a colored word; trash passes no
  // outcome and stays fully faint).
  meta?: string;
  outcome?: EncounterOutcome;
}

function makePickerOption(label: string, opts: PickerOptionOpts): HTMLElement {
  const { filter, pull = false, meta, outcome } = opts;

  const opt = document.createElement("div");
  opt.className = pull ? "picker-option picker-option--pull" : "picker-option";
  opt.setAttribute("role", "option");
  opt.dataset.filter = JSON.stringify(filter);

  const name = document.createElement("span");
  name.textContent = label;
  opt.appendChild(name);

  if (meta || outcome) {
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
      metaEl.textContent = `(${meta ?? ""})`;
    }
    opt.appendChild(metaEl);
  }

  if (filtersEqual(filter, encounterFilter)) opt.setAttribute("aria-selected", "true");
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
              filter: { kind: "encounter", index: idx },
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
    trashIndices.forEach((idx, n) => {
      const e = encounterRows[idx];
      const label = `Trash ${n + 1}`;
      menu.appendChild(
        makePickerOption(label, {
          filter: { kind: "encounter", index: idx },
          meta: `${formatClockTime(e.startMs)}: ${formatDurationWords(e.durationMs)}`,
        }),
      );
      encounterOptionLabels.set(idx, label);
    });
  }
}

// Rebuilds the popup from `encounterRows`. Fixed leading options
// ("Everything", "Custom range"), then the encounter list in whichever
// layout `pickerSortMode` selects. Called once per loaded log.
function buildEncounterMenu(): void {
  const menu = document.querySelector<HTMLElement>("#encounter-picker-menu");
  if (!menu) return;
  menu.replaceChildren();
  encounterOptionLabels.clear();

  menu.appendChild(makePickerOption("Everything", { filter: { kind: "all" } }));
  menu.appendChild(
    makePickerOption("Custom range", { filter: { kind: "custom", startMs: null, endMs: null } }),
  );

  if (pickerSortMode === "grouped") {
    appendGroupedEncounters(menu);
  } else {
    // TODO(settings): chronological -- one flat file-ordered list
    // interleaving trash and pulls by time. See docs/ui-widgets.md.
    appendGroupedEncounters(menu);
  }
}

function setEncounterFilter(filter: EncounterFilter, opts: { silent?: boolean } = {}): void {
  encounterFilter = filter;

  const labelEl = document.querySelector<HTMLElement>("#encounter-picker-label");
  if (labelEl) labelEl.textContent = encounterFilterLabel(filter);

  document.querySelectorAll<HTMLElement>("#encounter-picker-menu .picker-option").forEach((opt) => {
    const raw = opt.dataset.filter;
    if (raw && filtersEqual(JSON.parse(raw) as EncounterFilter, filter)) {
      opt.setAttribute("aria-selected", "true");
    } else {
      opt.removeAttribute("aria-selected");
    }
  });

  if (!opts.silent) {
    window.dispatchEvent(new CustomEvent("filter-changed", { detail: { encounter: encounterFilter } }));
  }
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

function setPickerOpen(open: boolean): void {
  const picker = document.querySelector<HTMLElement>("#encounter-picker");
  const btn = document.querySelector<HTMLButtonElement>("#encounter-picker-btn");
  const menu = document.querySelector<HTMLElement>("#encounter-picker-menu");
  if (!picker || !btn || !menu) return;

  picker.dataset.open = String(open);
  btn.setAttribute("aria-expanded", String(open));
  menu.hidden = !open;

  if (open) {
    const selected = menu.querySelector<HTMLElement>('.picker-option[aria-selected="true"]');
    setActiveOption(selected ?? menu.querySelector<HTMLElement>(".picker-option"));
    menu.focus();
  } else {
    setActiveOption(null);
  }
}

function isPickerOpen(): boolean {
  return document.querySelector<HTMLElement>("#encounter-picker")?.dataset.open === "true";
}

// Toolbar slot + button visibility -- shown only once a log has finished
// parsing (same gate as the debug/raw views).
function setEncounterPickerVisible(visible: boolean): void {
  const slot = document.querySelector<HTMLElement>("#encounter-picker-slot");
  const picker = document.querySelector<HTMLElement>("#encounter-picker");
  if (slot) slot.hidden = !visible;
  if (picker) picker.hidden = !visible;
  if (!visible) setPickerOpen(false);
}

function setupEncounterPicker(): void {
  const btn = document.querySelector<HTMLButtonElement>("#encounter-picker-btn");
  const menu = document.querySelector<HTMLElement>("#encounter-picker-menu");
  if (!btn || !menu) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setPickerOpen(!isPickerOpen());
  });

  menu.addEventListener("click", (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>(".picker-option");
    if (!opt?.dataset.filter) return;
    setEncounterFilter(JSON.parse(opt.dataset.filter) as EncounterFilter);
    setPickerOpen(false);
    btn.focus();
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
        if (activeOption?.dataset.filter) {
          setEncounterFilter(JSON.parse(activeOption.dataset.filter) as EncounterFilter);
          setPickerOpen(false);
          btn.focus();
        }
        break;
      case "Escape":
        e.preventDefault();
        setPickerOpen(false);
        btn.focus();
        break;
    }
  });

  // Click anywhere outside an open picker closes it.
  document.addEventListener("click", (e) => {
    const picker = document.querySelector<HTMLElement>("#encounter-picker");
    if (picker && isPickerOpen() && !picker.contains(e.target as Node)) setPickerOpen(false);
  });
}

async function refreshStatus() {
  const content = document.querySelector<HTMLElement>("#content");
  const statusEl = document.querySelector<HTMLElement>("#log-status");
  const debugView = document.querySelector<HTMLElement>("#debug-view");
  const rawView = document.querySelector<HTMLElement>("#raw-view");
  const debugBtn = document.querySelector<HTMLButtonElement>("#view-debug-btn");
  const rawBtn = document.querySelector<HTMLButtonElement>("#view-raw-btn");
  const statusBar = document.querySelector<HTMLElement>("#status-bar");
  const statusBarFill = document.querySelector<HTMLElement>("#statusbar-fill");
  const statusBarText = document.querySelector("#statusbar-text");
  if (
    !content ||
    !statusEl ||
    !debugView ||
    !rawView ||
    !debugBtn ||
    !rawBtn ||
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
  currentViewMode = viewId === "raw" ? "raw" : "debug";
  debugBtn.setAttribute("aria-pressed", String(currentViewMode === "debug"));
  rawBtn.setAttribute("aria-pressed", String(currentViewMode === "raw"));

  if (!info) {
    statusEl.textContent = "No combat log open";
    statusBar.hidden = true;
    content.classList.remove("has-data");
    debugView.hidden = true;
    rawView.hidden = true;
    lastLineCount = null;
    lastCounts = null;
    lastListsLineCount = null;
    encounterRows = [];
    encounterOptionLabels.clear();
    setEncounterFilter({ kind: "all" }, { silent: true });
    setEncounterPickerVisible(false);
    return;
  }

  if (!info.done) {
    lastLineCount = info.lineCount;
    lastCounts = null;
    updateSummaryText();
    content.classList.remove("has-data");
    debugView.hidden = true;
    rawView.hidden = true;
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
      setEncounterPickerVisible(false);
      return;
    }
    lastCounts = renderDebugLists(lists);
    lastListsLineCount = info.lineCount;

    // New log -> repopulate the encounter picker and reset its selection
    // to "Everything" (notifying any listener that the filter cleared).
    encounterRows = lists.encounters;
    buildEncounterMenu();
    setEncounterFilter({ kind: "all" });
  }
  updateSummaryText();

  content.classList.add("has-data");
  setEncounterPickerVisible(true);
  debugView.hidden = currentViewMode !== "debug";
  rawView.hidden = currentViewMode !== "raw";
  if (currentViewMode === "raw") {
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
  refreshStatus();

  document.querySelector("#open-file-btn")?.addEventListener("click", () => {
    invoke("open_log_file");
  });

  document.querySelector("#new-window-btn")?.addEventListener("click", () => {
    invoke("new_window_from");
  });

  document.querySelector("#view-debug-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "debug" });
  });

  document.querySelector("#view-raw-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "raw" });
  });

  listen("log-changed", () => refreshStatus());
  listen("view-changed", () => refreshStatus());
});
