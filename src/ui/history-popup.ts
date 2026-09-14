// Selection history -- the toolbar's back/forward buttons and the
// history popup that lists every entry. The stack itself (push/goto/
// back/forward bookkeeping) lives in ./history; this module is the UI
// layer on top of it -- rendering the popup, keeping the back/forward
// buttons' disabled state and the native History menu in sync, and
// wiring the menu bar's "history-command" event.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  configureHistory,
  historyBack,
  historyForward,
  historyGoto,
  clearHistory,
  historyState,
  subscribeHistory,
  type HistoryState,
} from "./history";
import { applySelection } from "./encounter-picker";
import { renderLaunch } from "../views/launch";

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

export function setupHistory(): void {
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
    if (!document.querySelector<HTMLElement>("#encounters-open")?.hidden) void renderLaunch();
  });
}
