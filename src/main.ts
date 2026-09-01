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
  sourceName: string | null;
  sourceGuid: string | null;
  targetName: string | null;
  targetGuid: string | null;
  spellName: string | null;
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
    renderRow: (cells, el, index) => {
      el.style.top = `${index * DATA_ROW_HEIGHT}px`;
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
// element (see VirtualList) rather than rebuilt from scratch every time.
function renderRawRow(r: RawEventRow, el: HTMLElement, index: number) {
  el.style.top = `${index * RAW_ROW_HEIGHT}px`;
  const [time, kind, source, target, spell, details] = Array.from(el.children) as HTMLElement[];
  setRawCell(time, formatRawTimestamp(r.timestampMs), false);
  setRawCell(kind, r.kind, false);
  setRawCell(source, r.sourceName ?? "", r.sourceName !== null, r.sourceGuid ?? undefined);
  setRawCell(target, r.targetName ?? "", r.targetName !== null, r.targetGuid ?? undefined);
  setRawCell(spell, r.spellName ?? "", r.spellName !== null);
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
    return;
  }

  if (!info.done) {
    lastLineCount = info.lineCount;
    lastCounts = null;
    updateSummaryText();
    content.classList.remove("has-data");
    debugView.hidden = true;
    rawView.hidden = true;

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
      return;
    }
    lastCounts = renderDebugLists(lists);
    lastListsLineCount = info.lineCount;
  }
  updateSummaryText();

  content.classList.add("has-data");
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
