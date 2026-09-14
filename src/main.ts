import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setLogData, getSelectedPlayer } from "./ui/context";
import { historyBack, historyForward } from "./ui/history";
import {
  renderDebugLists,
  updateSummaryText,
  setLineCount,
  setCounts,
  loadRawView,
  refreshActiveDebugTable,
  setupTabs,
  type LogListsPayload,
} from "./views/debug";
import {
  renderEncGrid,
  applySelection,
  setEncounterPickerVisible,
  setupEncounterPicker,
  duplicateWindow,
  loadEncounterPicker,
  resetEncounterPickerState,
  setCurrentLogPath,
  type PendingInit,
} from "./ui/encounter-picker";
import {
  setPlayerPickerVisible,
  setupPlayerPicker,
  refreshCharacterViewButtons,
  setLastCombatants,
} from "./ui/player-picker";
import { setupHistory } from "./ui/history-popup";
import { renderOverview } from "./views/overview";
import { renderCharacter } from "./views/character";
import { renderDamage } from "./views/damage";
import { renderHealing } from "./views/healing";
import { renderDamageTaken } from "./views/damage-taken";
import { renderDeaths } from "./views/deaths";
import { renderMovement } from "./views/movement";
import { renderTimeline } from "./views/timeline";
import { renderReplay } from "./views/replay";
import { renderInterrupts } from "./views/interrupts";
import { renderKanban } from "./views/kanban";
import { renderEncounterEditor } from "./views/encounter-editor";
import { renderLaunch } from "./views/launch";

interface WindowInfo {
  lineCount: number;
  percent: number;
  done: boolean;
  path: string;
}

export type ViewMode =
  | "encounters"
  | "overview"
  | "replay"
  | "interrupts"
  | "kanban"
  | "character"
  | "damage"
  | "healing"
  | "damage-taken"
  | "deaths"
  | "movement"
  | "timeline"
  | "debug"
  | "raw"
  | "encounter-editor";
let currentViewMode: ViewMode = "encounters";

// Shared with ./ui/encounter-picker (duplicateWindow) and
// ./ui/player-picker (the subscribeSelectedPlayer redraw switch) -- both
// only read it, and this is the sole writer (below), so they import this
// accessor rather than keeping their own copy.
export function getCurrentViewMode(): ViewMode {
  return currentViewMode;
}

// The lineCount lastCounts was actually built from. refreshStatus fires
// on both log-changed and view-changed, but log_lists rebuilds its
// entire payload (every unit/spell/zone/encounter/death/gear row, all
// cloned) from scratch server-side -- once a log is done, lineCount is
// stable for it, so a mismatch is the only signal that actually means
// "the log changed, go refetch," not "the user switched tabs."
let lastListsLineCount: number | null = null;

// A window created by "Duplicate Window" gets its inherited state from the
// backend once, on first load (see refreshStatus).
let pendingInitChecked = false;

async function refreshStatus() {
  const content = document.querySelector<HTMLElement>("#content");
  const statusEl = document.querySelector<HTMLElement>("#log-status");
  const encountersView = document.querySelector<HTMLElement>("#encounters-view");
  const encountersOpen = document.querySelector<HTMLElement>("#encounters-open");
  const encountersGrid = document.querySelector<HTMLElement>("#encounters-grid");
  const debugView = document.querySelector<HTMLElement>("#debug-view");
  const rawView = document.querySelector<HTMLElement>("#raw-view");
  const encounterEditorView = document.querySelector<HTMLElement>("#encounter-editor-view");
  const overviewView = document.querySelector<HTMLElement>("#overview-view");
  const replayView = document.querySelector<HTMLElement>("#replay-view");
  const interruptsView = document.querySelector<HTMLElement>("#interrupts-view");
  const kanbanView = document.querySelector<HTMLElement>("#kanban-view");
  const characterView = document.querySelector<HTMLElement>("#character-view");
  const damageView = document.querySelector<HTMLElement>("#damage-view");
  const healingView = document.querySelector<HTMLElement>("#healing-view");
  const damageTakenView = document.querySelector<HTMLElement>("#damage-taken-view");
  const deathsView = document.querySelector<HTMLElement>("#deaths-view");
  const movementView = document.querySelector<HTMLElement>("#movement-view");
  const timelineView = document.querySelector<HTMLElement>("#timeline-view");
  const encountersBtn = document.querySelector<HTMLButtonElement>("#view-encounters-btn");
  const overviewBtn = document.querySelector<HTMLButtonElement>("#view-overview-btn");
  const replayBtn = document.querySelector<HTMLButtonElement>("#view-replay-btn");
  const interruptsBtn = document.querySelector<HTMLButtonElement>("#view-interrupts-btn");
  const kanbanBtn = document.querySelector<HTMLButtonElement>("#view-kanban-btn");
  const characterBtn = document.querySelector<HTMLButtonElement>("#view-character-btn");
  const damageBtn = document.querySelector<HTMLButtonElement>("#view-damage-btn");
  const healingBtn = document.querySelector<HTMLButtonElement>("#view-healing-btn");
  const damageTakenBtn = document.querySelector<HTMLButtonElement>("#view-damage-taken-btn");
  const deathsBtn = document.querySelector<HTMLButtonElement>("#view-deaths-btn");
  const movementBtn = document.querySelector<HTMLButtonElement>("#view-movement-btn");
  const timelineBtn = document.querySelector<HTMLButtonElement>("#view-timeline-btn");
  const newWindowBtn = document.querySelector<HTMLButtonElement>("#new-window-btn");
  const statusBar = document.querySelector<HTMLElement>("#status-bar");
  const statusBarFill = document.querySelector<HTMLElement>("#statusbar-fill");
  const statusBarText = document.querySelector("#statusbar-text");
  if (
    !content ||
    !statusEl ||
    !encountersView ||
    !encountersOpen ||
    !encountersGrid ||
    !debugView ||
    !rawView ||
    !encounterEditorView ||
    !overviewView ||
    !replayView ||
    !interruptsView ||
    !kanbanView ||
    !characterView ||
    !damageView ||
    !healingView ||
    !damageTakenView ||
    !deathsView ||
    !movementView ||
    !timelineView ||
    !encountersBtn ||
    !overviewBtn ||
    !replayBtn ||
    !interruptsBtn ||
    !kanbanBtn ||
    !characterBtn ||
    !damageBtn ||
    !healingBtn ||
    !damageTakenBtn ||
    !deathsBtn ||
    !movementBtn ||
    !timelineBtn ||
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
  currentViewMode = (
    [
      "encounters",
      "overview",
      "replay",
      "interrupts",
      "kanban",
      "character",
      "damage",
      "healing",
      "damage-taken",
      "deaths",
      "movement",
      "timeline",
      "raw",
      "debug",
      "encounter-editor",
    ].includes(viewId)
      ? viewId
      : "encounters"
  ) as ViewMode;
  // The per-character views need a picked player -- fall back to Encounters
  // if one is somehow active without one (a Duplicate Window inheriting the
  // view, or the View menu item clicked with nothing selected).
  if (
    (currentViewMode === "character" ||
      currentViewMode === "damage" ||
      currentViewMode === "healing" ||
      currentViewMode === "damage-taken" ||
      currentViewMode === "deaths" ||
      currentViewMode === "movement" ||
      currentViewMode === "timeline") &&
    getSelectedPlayer() === null
  ) {
    if (viewId !== "encounters") void invoke("set_current_view", { view: "encounters" });
    currentViewMode = "encounters";
  }
  // Encounters + Overview + Character + Damage have toolbar buttons
  // (Debug/Raw are menu-only, under the Develop menu).
  encountersBtn.setAttribute("aria-pressed", String(currentViewMode === "encounters"));
  overviewBtn.setAttribute("aria-pressed", String(currentViewMode === "overview"));
  replayBtn.setAttribute("aria-pressed", String(currentViewMode === "replay"));
  interruptsBtn.setAttribute("aria-pressed", String(currentViewMode === "interrupts"));
  kanbanBtn.setAttribute("aria-pressed", String(currentViewMode === "kanban"));
  characterBtn.setAttribute("aria-pressed", String(currentViewMode === "character"));
  damageBtn.setAttribute("aria-pressed", String(currentViewMode === "damage"));
  healingBtn.setAttribute("aria-pressed", String(currentViewMode === "healing"));
  damageTakenBtn.setAttribute("aria-pressed", String(currentViewMode === "damage-taken"));
  deathsBtn.setAttribute("aria-pressed", String(currentViewMode === "deaths"));
  movementBtn.setAttribute("aria-pressed", String(currentViewMode === "movement"));
  timelineBtn.setAttribute("aria-pressed", String(currentViewMode === "timeline"));
  refreshCharacterViewButtons();
  // "Duplicate window" needs a loaded log to copy from.
  if (newWindowBtn) newWindowBtn.disabled = !info || !info.done;

  if (!info && viewId === "encounter-editor") {
    // The Encounter Editor authors config files from scratch -- it has no
    // dependency on a loaded log, so it's exempt from the "no log ->
    // Encounters" bounce below.
    currentViewMode = "encounter-editor";
    statusEl.hidden = true;
    statusBar.hidden = true;
    encountersView.hidden = true;
    content.classList.add("has-data");
    debugView.hidden = true;
    rawView.hidden = true;
    overviewView.hidden = true;
    replayView.hidden = true;
    interruptsView.hidden = true;
    kanbanView.hidden = true;
    characterView.hidden = true;
    damageView.hidden = true;
    healingView.hidden = true;
    damageTakenView.hidden = true;
    deathsView.hidden = true;
    movementView.hidden = true;
    timelineView.hidden = true;
    encounterEditorView.hidden = false;
    setEncounterPickerVisible(false);
    setPlayerPickerVisible(false);
    renderEncounterEditor();
    return;
  }

  if (!info) {
    // No log: the Encounters view shows the open-a-file / recent-logs UI.
    // Force the view to Encounters (nothing else makes sense with no log);
    // guarded so the resulting view-changed -> refreshStatus doesn't loop.
    if (viewId !== "encounters") void invoke("set_current_view", { view: "encounters" });
    currentViewMode = "encounters";
    statusEl.hidden = true;
    encountersView.hidden = false;
    encountersOpen.hidden = false;
    encountersGrid.hidden = true;
    void renderLaunch();
    statusBar.hidden = true;
    content.classList.remove("has-data");
    debugView.hidden = true;
    rawView.hidden = true;
    overviewView.hidden = true;
    characterView.hidden = true;
    damageView.hidden = true;
    healingView.hidden = true;
    setLineCount(null);
    setCounts(null);
    lastListsLineCount = null;
    setLastCombatants([]);
    resetEncounterPickerState();
    applySelection(
      { startMs: 0, endMs: 0, source: { kind: "custom" } },
      { silent: true, history: "none" },
    );
    setEncounterPickerVisible(false);
    setPlayerPickerVisible(false);
    return;
  }

  setCurrentLogPath(info.path);

  if (!info.done) {
    setLineCount(info.lineCount);
    setCounts(null);
    updateSummaryText();
    encountersView.hidden = true;
    content.classList.remove("has-data");
    debugView.hidden = true;
    rawView.hidden = true;
    overviewView.hidden = true;
    characterView.hidden = true;
    damageView.hidden = true;
    healingView.hidden = true;
    setEncounterPickerVisible(false);
    setPlayerPickerVisible(false);

    statusBar.hidden = false;
    const percent = Math.round(info.percent);
    statusBarFill.style.width = `${percent}%`;
    statusBarText.textContent = `Parsing... ${percent}%`;
    return;
  }

  statusBar.hidden = true;
  statusBarFill.style.width = "0%";
  setLineCount(info.lineCount);

  // log_lists rebuilds and clones its entire payload server-side --
  // skip the round-trip (and the full-DOM rebuild in renderDebugLists)
  // entirely when we already have it for this exact log. A view-only
  // change (log-changed re-fires "done" state, or the user just flipped
  // to Raw) never changes lineCount, so this is a safe, cheap guard.
  if (lastListsLineCount !== info.lineCount) {
    const lists = await invoke<LogListsPayload | null>("log_lists");
    if (!lists) {
      setCounts(null);
      lastListsLineCount = null;
      updateSummaryText();
      content.classList.remove("has-data");
      encountersView.hidden = true;
      debugView.hidden = true;
      rawView.hidden = true;
      overviewView.hidden = true;
      characterView.hidden = true;
      damageView.hidden = true;
      healingView.hidden = true;
      setEncounterPickerVisible(false);
      setPlayerPickerVisible(false);
      return;
    }
    setCounts(renderDebugLists(lists));
    lastListsLineCount = info.lineCount;
    setLastCombatants(lists.combatants);

    // Feed the shared stores the src/ui views read from.
    setLogData({
      encounters: lists.encounters,
      deaths: lists.deaths,
      units: lists.units,
      spells: lists.spells,
      combatants: lists.combatants,
    });

    // New log -> repopulate the encounter picker and reset the range to
    // the whole log (notifying any listener the filter changed).
    loadEncounterPicker(lists.encounters);
  }
  updateSummaryText();

  // If this window was made by "Duplicate Window", adopt the source
  // window's selection + view (once). Its `set_current_view` re-triggers
  // refreshStatus, by which point `pendingInitChecked` is set.
  if (!pendingInitChecked) {
    pendingInitChecked = true;
    const init = await invoke<PendingInit | null>("take_pending_init");
    if (init) {
      applySelection(init.selection, { history: "reset" });
      currentViewMode = init.view;
      if (init.view !== "encounters") void invoke("set_current_view", { view: init.view });
    }
  }

  content.classList.add("has-data");
  setEncounterPickerVisible(true);
  setPlayerPickerVisible(true);
  encountersView.hidden = currentViewMode !== "encounters";
  encountersOpen.hidden = true; // a log is loaded -> the grid, not the open prompt
  encountersGrid.hidden = false;
  debugView.hidden = currentViewMode !== "debug";
  rawView.hidden = currentViewMode !== "raw";
  overviewView.hidden = currentViewMode !== "overview";
  replayView.hidden = currentViewMode !== "replay";
  interruptsView.hidden = currentViewMode !== "interrupts";
  kanbanView.hidden = currentViewMode !== "kanban";
  characterView.hidden = currentViewMode !== "character";
  damageView.hidden = currentViewMode !== "damage";
  healingView.hidden = currentViewMode !== "healing";
  damageTakenView.hidden = currentViewMode !== "damage-taken";
  deathsView.hidden = currentViewMode !== "deaths";
  movementView.hidden = currentViewMode !== "movement";
  timelineView.hidden = currentViewMode !== "timeline";
  encounterEditorView.hidden = currentViewMode !== "encounter-editor";
  // The "X lines — Y players" line is parser-sanity-check context for
  // Debug/Raw; on the everyday views it's just noise.
  statusEl.hidden = currentViewMode !== "debug" && currentViewMode !== "raw";
  if (currentViewMode === "encounters") {
    renderEncGrid();
  } else if (currentViewMode === "overview") {
    renderOverview();
  } else if (currentViewMode === "replay") {
    renderReplay();
  } else if (currentViewMode === "interrupts") {
    renderInterrupts();
  } else if (currentViewMode === "kanban") {
    renderKanban();
  } else if (currentViewMode === "character") {
    renderCharacter();
  } else if (currentViewMode === "damage") {
    renderDamage();
  } else if (currentViewMode === "healing") {
    renderHealing();
  } else if (currentViewMode === "damage-taken") {
    renderDamageTaken();
  } else if (currentViewMode === "deaths") {
    renderDeaths();
  } else if (currentViewMode === "movement") {
    renderMovement();
  } else if (currentViewMode === "timeline") {
    renderTimeline();
  } else if (currentViewMode === "raw") {
    await loadRawView();
  } else if (currentViewMode === "encounter-editor") {
    renderEncounterEditor();
  } else {
    // The active tab's scroll container had clientHeight 0 while the
    // whole debug view was hidden (e.g. we were showing Raw) -- force a
    // re-measure now that it's visible again.
    refreshActiveDebugTable();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  setupEncounterPicker();
  setupPlayerPicker();
  setupHistory();
  refreshStatus();

  document.querySelector("#open-file-btn")?.addEventListener("click", () => {
    invoke("open_log_file");
  });

  document.querySelector("#new-window-btn")?.addEventListener("click", () => {
    duplicateWindow();
  });
  // ⌘⇧N / File > Duplicate Window fires this event on the focused window;
  // we call back with the selection + view the new window should inherit.
  listen("duplicate-window", () => duplicateWindow());

  document.querySelector("#view-encounters-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "encounters" });
  });

  document.querySelector("#view-overview-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "overview" });
  });

  document.querySelector("#view-replay-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "replay" });
  });
  document.querySelector("#view-kanban-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "kanban" });
  });
  document.querySelector("#view-interrupts-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "interrupts" });
  });

  document.querySelector("#view-character-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "character" });
  });

  document.querySelector("#view-damage-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "damage" });
  });

  document.querySelector("#view-healing-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "healing" });
  });

  document.querySelector("#view-damage-taken-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "damage-taken" });
  });

  document.querySelector("#view-deaths-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "deaths" });
  });

  document.querySelector("#view-movement-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "movement" });
  });
  document.querySelector("#view-timeline-btn")?.addEventListener("click", () => {
    invoke("set_current_view", { view: "timeline" });
  });

  document.querySelector("#zoom-out-btn")?.addEventListener("click", () => {
    invoke("zoom", { direction: -1 });
  });
  document.querySelector("#zoom-in-btn")?.addEventListener("click", () => {
    invoke("zoom", { direction: 1 });
  });

  // Reveals the app data directory in the OS file browser (Finder). It's
  // the root for user-installed plugins / encounter extensions, so the
  // command creates it on first use rather than failing on a fresh install.
  document.querySelector("#open-data-dir-btn")?.addEventListener("click", () => {
    invoke("open_data_dir");
  });

  // ⌘←/⌘→ mirror the History menu's Back/Forward (⌘[/⌘]); ignore while a
  // text field has focus so arrow-key editing still works there.
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    if (e.key === "ArrowLeft") historyBack();
    else historyForward();
  });

  listen("log-changed", () => refreshStatus());
  listen("view-changed", () => refreshStatus());
});
