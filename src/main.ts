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

interface InternTablesPayload {
  units: UnitRow[];
  spells: SpellRow[];
  zones: ZoneRow[];
}

const lineFormatter = new Intl.NumberFormat();

function makeRow(cells: string[]): HTMLTableRowElement {
  const tr = document.createElement("tr");
  for (const text of cells) {
    const td = document.createElement("td");
    td.textContent = text;
    tr.appendChild(td);
  }
  return tr;
}

function renderTable(bodyId: string, rows: string[][]) {
  const body = document.querySelector(`#${bodyId}`);
  if (!body) return;
  body.replaceChildren(...rows.map(makeRow));
}

function renderInternTables(tables: InternTablesPayload) {
  renderTable(
    "units-body",
    tables.units.map((u) => [u.name, u.kind, u.owner ?? "", u.guid]),
  );
  renderTable(
    "spells-body",
    tables.spells.map((s) => [s.name, String(s.spellId), "0x" + s.school.toString(16)]),
  );
  renderTable(
    "zones-body",
    tables.zones.map((z) => [z.name, String(z.mapId)]),
  );
}

async function refreshStatus() {
  const content = document.querySelector<HTMLElement>("#content");
  const statusEl = document.querySelector<HTMLElement>("#log-status");
  const tablesView = document.querySelector<HTMLElement>("#tables-view");
  const statusBar = document.querySelector<HTMLElement>("#status-bar");
  const statusBarFill = document.querySelector<HTMLElement>("#statusbar-fill");
  const statusBarText = document.querySelector("#statusbar-text");
  if (!content || !statusEl || !tablesView || !statusBar || !statusBarFill || !statusBarText) return;

  const info = await invoke<WindowInfo | null>("window_info");
  if (!info) {
    statusEl.textContent = "No combat log open";
    statusBar.hidden = true;
    content.classList.remove("has-data");
    tablesView.hidden = true;
    return;
  }

  if (info.done) {
    statusBar.hidden = true;
    statusBarFill.style.width = "0%";

    const tables = await invoke<InternTablesPayload | null>("intern_tables");
    if (tables) {
      statusEl.textContent = `${lineFormatter.format(info.lineCount)} lines — ${lineFormatter.format(tables.units.length)} units, ${lineFormatter.format(tables.spells.length)} spells, ${lineFormatter.format(tables.zones.length)} zones`;
      renderInternTables(tables);
      content.classList.add("has-data");
      tablesView.hidden = false;
    } else {
      statusEl.textContent = `${lineFormatter.format(info.lineCount)} lines`;
      content.classList.remove("has-data");
      tablesView.hidden = true;
    }
  } else {
    statusEl.textContent = `${lineFormatter.format(info.lineCount)} lines`;
    content.classList.remove("has-data");
    tablesView.hidden = true;

    statusBar.hidden = false;
    const percent = Math.round(info.percent);
    statusBarFill.style.width = `${percent}%`;
    statusBarText.textContent = `Parsing... ${percent}%`;
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

  listen("log-changed", () => refreshStatus());
});
