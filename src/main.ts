import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface WindowInfo {
  filename: string;
}

async function refreshStatus() {
  const statusEl = document.querySelector("#log-status");
  if (!statusEl) return;

  const info = await invoke<WindowInfo | null>("window_info");
  statusEl.textContent = info ? `Viewing: ${info.filename}` : "No combat log open";
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
