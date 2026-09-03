// The blank-window landing screen: an Open button, recently opened logs,
// and the folders those logs lived in. main.ts shows it whenever the
// window has no log (`window_info` is null) and re-renders it on focus.
//
// - a file row  -> `open_recent` (opens it in this window)
// - a location  -> `pick_log_in` (native dialog, started in that folder)
// - Open button -> `open_log_file` (native dialog, last-used folder)

import { invoke } from "@tauri-apps/api/core";

interface RecentFile {
  path: string;
  name: string;
  dir: string;
}
interface RecentLogs {
  files: RecentFile[];
  locations: string[];
}

let wired = false;

export async function renderLaunch(): Promise<void> {
  const openBtn = document.querySelector<HTMLButtonElement>("#launch-open-btn");
  const filesEl = document.querySelector<HTMLUListElement>("#launch-files");
  const filesEmpty = document.querySelector<HTMLElement>("#launch-files-empty");
  const locsEl = document.querySelector<HTMLUListElement>("#launch-locations");
  const locsEmpty = document.querySelector<HTMLElement>("#launch-locations-empty");
  if (!openBtn || !filesEl || !filesEmpty || !locsEl || !locsEmpty) return;

  if (!wired) {
    wired = true;
    const swallow = () => {};
    openBtn.addEventListener("click", () => void invoke("open_log_file").catch(swallow));
    // Event delegation -- the lists are replaced on every render.
    filesEl.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-path]");
      if (li?.dataset.path) void invoke("open_recent", { path: li.dataset.path }).catch(swallow);
    });
    locsEl.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-dir]");
      if (li?.dataset.dir) void invoke("pick_log_in", { dir: li.dataset.dir }).catch(swallow);
    });
  }

  let data: RecentLogs;
  try {
    data = await invoke<RecentLogs>("recent_logs");
  } catch {
    data = { files: [], locations: [] };
  }

  filesEl.replaceChildren(
    ...data.files.map((f) => {
      const li = document.createElement("li");
      li.dataset.path = f.path;
      li.className = "launch-item";
      const name = document.createElement("span");
      name.className = "launch-item-name";
      name.textContent = f.name;
      const dir = document.createElement("span");
      dir.className = "launch-item-sub";
      dir.textContent = f.dir;
      li.append(name, dir);
      return li;
    }),
  );
  filesEmpty.hidden = data.files.length > 0;

  locsEl.replaceChildren(
    ...data.locations.map((d) => {
      const li = document.createElement("li");
      li.dataset.dir = d;
      li.className = "launch-item";
      const name = document.createElement("span");
      name.className = "launch-item-name";
      name.textContent = d;
      li.append(name);
      return li;
    }),
  );
  // Only surface the locations placeholder in the odd case where we have
  // recent files but none of their folders still exist.
  locsEmpty.hidden = data.locations.length > 0 || data.files.length === 0;
}
