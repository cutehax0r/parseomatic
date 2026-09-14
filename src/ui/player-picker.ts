// Player picker -- a second toolbar listbox (index.html #player-picker),
// right of the encounter picker. Lists the human characters active in the
// currently selected time range and writes the pick to the shared
// `selectedPlayer` store (src/ui/context.ts) -- which the per-character
// views (Character, and later Damage & Healing / Interrupts / Deaths /
// replay) read. It does NOT touch the encounter range or the
// Encounters/Overview views.
//
// Simpler than the encounter picker: a flat list, no custom-range
// popover. The generic .picker / .picker-menu / .picker-option CSS is
// shared with the encounter picker.

import type { CombatantRow } from "../types";
import { classColorVar, formatSpec } from "../format";
import { getSelectedPlayer, setSelectedPlayer, subscribeSelectedPlayer, getRange } from "./context";
import { query } from "./query";
import { getUnitsById } from "../views/debug";
import { getCurrentViewMode } from "../main";
import { renderCharacter } from "../views/character";
import { renderDamage } from "../views/damage";
import { renderHealing } from "../views/healing";
import { renderDamageTaken } from "../views/damage-taken";
import { renderDeaths } from "../views/deaths";
import { renderMovement } from "../views/movement";
import { renderTimeline } from "../views/timeline";

interface RosterEntry {
  unitId: number;
  name: string;
  specId: number; // 0 when the log has no COMBATANT_INFO for them
}

let playerRoster: RosterEntry[] = [];
let activePlayerOption: HTMLElement | null = null;

// COMBATANT_INFO snapshots for the loaded log, kept so the player picker
// can label roster entries with their spec. Set by main.ts's
// refreshStatus alongside setLogData.
let lastCombatants: CombatantRow[] = [];

export function setLastCombatants(combatants: CombatantRow[]): void {
  lastCombatants = combatants;
}

function playerPickerOpen(): boolean {
  return document.querySelector<HTMLElement>("#player-picker")?.dataset.open === "true";
}

function setActivePlayerOption(el: HTMLElement | null): void {
  activePlayerOption?.classList.remove("is-active");
  activePlayerOption = el;
  if (el) {
    el.classList.add("is-active");
    el.scrollIntoView({ block: "nearest" });
  }
}

function movePlayerOption(delta: number): void {
  const opts = Array.from(
    document.querySelectorAll<HTMLElement>("#player-picker-menu .picker-option"),
  );
  if (opts.length === 0) return;
  const cur = activePlayerOption ? opts.indexOf(activePlayerOption) : -1;
  setActivePlayerOption(opts[(cur + delta + opts.length) % opts.length]);
}

function updatePlayerPickerLabel(): void {
  const label = document.querySelector<HTMLElement>("#player-picker-label");
  if (!label) return;
  const id = getSelectedPlayer();
  const unitsById = getUnitsById();
  label.textContent = id !== null && unitsById[id] ? unitsById[id].name : "Select player…";
}

// The per-character view buttons (Character, Damage, ...) are enabled
// only once a player is picked.
export function refreshCharacterViewButtons(): void {
  const disabled = getSelectedPlayer() === null;
  for (const id of [
    "#view-character-btn",
    "#view-damage-btn",
    "#view-healing-btn",
    "#view-damage-taken-btn",
    "#view-deaths-btn",
    "#view-movement-btn",
    "#view-timeline-btn",
  ]) {
    const btn = document.querySelector<HTMLButtonElement>(id);
    if (btn) btn.disabled = disabled;
  }
}

function buildPlayerMenu(): void {
  const menu = document.querySelector<HTMLElement>("#player-picker-menu");
  if (!menu) return;
  menu.replaceChildren();

  if (playerRoster.length === 0) {
    const empty = document.createElement("div");
    empty.className = "picker-section";
    empty.textContent = "No players active in this range";
    menu.appendChild(empty);
    return;
  }

  const selected = getSelectedPlayer();
  for (const p of playerRoster) {
    const opt = document.createElement("div");
    opt.className = "picker-option";
    opt.setAttribute("role", "option");
    opt.dataset.unit = String(p.unitId);

    const name = document.createElement("span");
    name.textContent = p.name;
    const color = classColorVar(p.specId);
    if (color) name.style.color = color;
    opt.appendChild(name);

    const specText = formatSpec(p.specId);
    if (specText) {
      const meta = document.createElement("span");
      meta.className = "picker-option-meta";
      meta.textContent = specText;
      opt.appendChild(meta);
    }

    if (p.unitId === selected) opt.setAttribute("aria-selected", "true");
    menu.appendChild(opt);
  }
}

function openPlayerPickerMenu(): void {
  const picker = document.querySelector<HTMLElement>("#player-picker");
  const btn = document.querySelector<HTMLButtonElement>("#player-picker-btn");
  const menu = document.querySelector<HTMLElement>("#player-picker-menu");
  if (!picker || !btn || !menu) return;
  buildPlayerMenu();
  menu.hidden = false;
  picker.dataset.open = "true";
  btn.setAttribute("aria-expanded", "true");
  const selected = menu.querySelector<HTMLElement>('.picker-option[aria-selected="true"]');
  setActivePlayerOption(selected ?? menu.querySelector<HTMLElement>(".picker-option"));
  menu.focus();
}

function closePlayerPicker(): void {
  const picker = document.querySelector<HTMLElement>("#player-picker");
  const btn = document.querySelector<HTMLButtonElement>("#player-picker-btn");
  const menu = document.querySelector<HTMLElement>("#player-picker-menu");
  if (!picker || !btn || !menu) return;
  picker.dataset.open = "false";
  btn.setAttribute("aria-expanded", "false");
  menu.hidden = true;
  setActivePlayerOption(null);
}

function choosePlayerOption(opt: HTMLElement): void {
  const raw = opt.dataset.unit;
  if (raw === undefined) return;
  setSelectedPlayer(Number(raw)); // subscriber refreshes the label + button
  closePlayerPicker();
  document.querySelector<HTMLButtonElement>("#player-picker-btn")?.focus();
}

export function setPlayerPickerVisible(visible: boolean): void {
  const slot = document.querySelector<HTMLElement>("#player-picker-slot");
  const picker = document.querySelector<HTMLElement>("#player-picker");
  if (slot) slot.hidden = !visible;
  if (picker) picker.hidden = !visible;
  if (!visible) closePlayerPicker();
}

// Rebuilds `playerRoster` for the current range: the human characters
// that acted as a source or target of any event in the window. One
// aggregated `query_events` pass per direction (both memoized by
// src/ui/query.ts, so re-selecting a seen range costs no IPC). Keeps the
// existing selection even if that player isn't in the new roster -- their
// gear snapshot isn't range-dependent.
export async function populatePlayerPicker(): Promise<void> {
  const sel = getRange();
  const unitsById = getUnitsById();
  if (!sel || sel.endMs <= sel.startMs || unitsById.length === 0) {
    playerRoster = [];
    if (playerPickerOpen()) buildPlayerMenu();
    return;
  }

  const bounds = { startMs: sel.startMs, endMs: sel.endMs };
  const [srcRows, tgtRows] = await Promise.all([
    query<{ sourceUnit: number }>({
      ...bounds,
      groupBy: ["sourceUnit"],
      aggregate: [{ op: "count", as: "n" }],
    }),
    query<{ targetUnit: number }>({
      ...bounds,
      groupBy: ["targetUnit"],
      aggregate: [{ op: "count", as: "n" }],
    }),
  ]);

  const ids = new Set<number>();
  for (const r of srcRows) ids.add(r.sourceUnit);
  for (const r of tgtRows) ids.add(r.targetUnit);

  const specByUnit = new Map<number, number>();
  for (const c of lastCombatants) specByUnit.set(c.unitId, c.specId);

  playerRoster = [...ids]
    .filter((id) => unitsById[id]?.kind === "Player")
    .map((id) => ({ unitId: id, name: unitsById[id].name, specId: specByUnit.get(id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (playerPickerOpen()) buildPlayerMenu();
}

export function setupPlayerPicker(): void {
  const btn = document.querySelector<HTMLButtonElement>("#player-picker-btn");
  const menu = document.querySelector<HTMLElement>("#player-picker-menu");
  if (!btn || !menu) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (playerPickerOpen()) closePlayerPicker();
    else openPlayerPickerMenu();
  });

  menu.addEventListener("click", (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>(".picker-option");
    if (opt?.dataset.unit) choosePlayerOption(opt);
  });

  menu.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        movePlayerOption(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        movePlayerOption(-1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (activePlayerOption) choosePlayerOption(activePlayerOption);
        break;
      case "Escape":
        e.preventDefault();
        closePlayerPicker();
        btn.focus();
        break;
    }
  });

  document.addEventListener("click", (e) => {
    const picker = document.querySelector<HTMLElement>("#player-picker");
    if (picker && playerPickerOpen() && !picker.contains(e.target as Node)) closePlayerPicker();
  });

  // The store is the single source of truth -- new log clears it
  // (setLogData), the menu sets it. Keep the label + Character button in
  // sync from one place.
  subscribeSelectedPlayer(() => {
    updatePlayerPickerLabel();
    refreshCharacterViewButtons();
    const currentViewMode = getCurrentViewMode();
    if (currentViewMode === "character") renderCharacter();
    else if (currentViewMode === "damage") renderDamage();
    else if (currentViewMode === "healing") renderHealing();
    else if (currentViewMode === "damage-taken") renderDamageTaken();
    else if (currentViewMode === "deaths") renderDeaths();
    else if (currentViewMode === "movement") renderMovement();
    else if (currentViewMode === "timeline") renderTimeline();
  });
}
