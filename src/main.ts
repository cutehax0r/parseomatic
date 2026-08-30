import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface WindowInfo {
  lineCount: number;
  percent: number;
  done: boolean;
}

const lineFormatter = new Intl.NumberFormat();

async function refreshStatus() {
  const statusEl = document.querySelector("#log-status");
  const statusBar = document.querySelector<HTMLElement>("#status-bar");
  const statusBarFill = document.querySelector<HTMLElement>("#statusbar-fill");
  const statusBarText = document.querySelector("#statusbar-text");
  if (!statusEl || !statusBar || !statusBarFill || !statusBarText) return;

  const info = await invoke<WindowInfo | null>("window_info");
  if (!info) {
    statusEl.textContent = "No combat log open";
    statusBar.hidden = true;
    return;
  }

  statusEl.textContent = `${lineFormatter.format(info.lineCount)} lines`;

  if (info.done) {
    statusBar.hidden = true;
    statusBarFill.style.width = "0%";
  } else {
    statusBar.hidden = false;
    const percent = Math.round(info.percent);
    statusBarFill.style.width = `${percent}%`;
    statusBarText.textContent = `Parsing... ${percent}%`;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  refreshStatus();

  document.querySelector("#open-file-btn")?.addEventListener("click", () => {
    invoke("open_log_file");
  });

  document.querySelector("#new-window-btn")?.addEventListener("click", () => {
    invoke("new_window_from");
  });

  listen("log-changed", () => refreshStatus());
});
