import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

function makeRow(cells: string[]): HTMLTableRowElement {
  const tr = document.createElement("tr");
  for (const text of cells) {
    const td = document.createElement("td");
    td.textContent = text;
    tr.appendChild(td);
  }
  return tr;
}

function renderTable(bodyId: string, rows: string[][], columnCount: number, emptyMessage: string) {
  const body = document.querySelector(`#${bodyId}`);
  if (!body) return;
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = columnCount;
    td.className = "empty-message";
    td.textContent = emptyMessage;
    tr.appendChild(td);
    body.replaceChildren(tr);
    return;
  }
  body.replaceChildren(...rows.map(makeRow));
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
    "units-body",
    lists.units.map((u) => [u.name, u.kind, u.owner ?? "", u.guid]),
    4,
    "No units found in this log.",
  );
  renderTable(
    "spells-body",
    lists.spells.map((s) => [s.name, String(s.spellId), "0x" + s.school.toString(16)]),
    3,
    "No spells found in this log.",
  );
  renderTable(
    "zones-body",
    lists.zones.map((z) => [z.name, String(z.mapId)]),
    2,
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
    "players-body",
    players.map((u) => [u.name, u.guid]),
    2,
    "No players found in this log.",
  );
  renderTable(
    "pets-body",
    pets.map((u) => [u.name, u.kind, u.owner ?? "", u.guid]),
    4,
    "No player-owned pets found in this log.",
  );
  renderTable(
    "creatures-body",
    creatures.map((u) => [u.name, u.kind, u.owner ?? "", u.guid]),
    4,
    "No creatures found in this log.",
  );

  renderTable(
    "encounters-body",
    lists.encounters.map((e) => [
      e.isTrash ? "Trash" : e.name,
      formatEncounterResult(e),
      formatDuration(e.durationMs),
      e.isTrash ? "" : String(e.groupSize),
    ]),
    4,
    "No encounters found in this log.",
  );
  renderTable(
    "deaths-body",
    lists.deaths.map((d) => [d.playerName, d.encounterName, new Date(d.timestampMs).toLocaleTimeString()]),
    3,
    "No player deaths found in this log.",
  );
  renderTable(
    "gear-body",
    lists.combatants.map((c) => [
      c.playerName,
      c.encounterName,
      String(c.specId),
      c.avgItemLevel !== null ? c.avgItemLevel.toFixed(1) : "",
      String(c.itemCount),
    ]),
    5,
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

async function refreshStatus() {
  const content = document.querySelector<HTMLElement>("#content");
  const statusEl = document.querySelector<HTMLElement>("#log-status");
  const debugView = document.querySelector<HTMLElement>("#debug-view");
  const debugBtn = document.querySelector<HTMLButtonElement>("#debug-view-btn");
  const statusBar = document.querySelector<HTMLElement>("#status-bar");
  const statusBarFill = document.querySelector<HTMLElement>("#statusbar-fill");
  const statusBarText = document.querySelector("#statusbar-text");
  if (!content || !statusEl || !debugView || !debugBtn || !statusBar || !statusBarFill || !statusBarText) {
    return;
  }

  const [info, debugVisible] = await Promise.all([
    invoke<WindowInfo | null>("window_info"),
    invoke<boolean>("debug_view_visible"),
  ]);
  debugBtn.setAttribute("aria-pressed", String(debugVisible));

  if (!info) {
    statusEl.textContent = "No combat log open";
    statusBar.hidden = true;
    content.classList.remove("has-data");
    debugView.hidden = true;
    lastLineCount = null;
    lastCounts = null;
    return;
  }

  if (!info.done) {
    lastLineCount = info.lineCount;
    lastCounts = null;
    updateSummaryText();
    content.classList.remove("has-data");
    debugView.hidden = true;

    statusBar.hidden = false;
    const percent = Math.round(info.percent);
    statusBarFill.style.width = `${percent}%`;
    statusBarText.textContent = `Parsing... ${percent}%`;
    return;
  }

  statusBar.hidden = true;
  statusBarFill.style.width = "0%";

  const lists = await invoke<DebugListsPayload | null>("debug_lists");
  lastLineCount = info.lineCount;
  if (!lists) {
    lastCounts = null;
    updateSummaryText();
    content.classList.remove("has-data");
    debugView.hidden = true;
    return;
  }

  lastCounts = renderDebugLists(lists);
  updateSummaryText();
  // The debug view only actually shows when there's data *and* the user
  // hasn't toggled it off (toolbar button / View > Debug menu checkbox).
  content.classList.toggle("has-data", debugVisible);
  debugView.hidden = !debugVisible;
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

  document.querySelector("#debug-view-btn")?.addEventListener("click", () => {
    invoke("toggle_debug_view");
  });

  listen("log-changed", () => refreshStatus());
  listen("view-changed", () => refreshStatus());
});
