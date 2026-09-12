// Raid -- a kanban board of encounter phases and their mechanics, driven
// by per-encounter config loaded from the plugin appdata folder. Not
// built yet: this is a static placeholder until the encounter-config
// format and detection engine exist.

let rendered = false;

export function renderRaid(): void {
  const mount = document.querySelector<HTMLElement>("#raid-mount");
  if (!mount || rendered) return;
  rendered = true;

  mount.innerHTML = "";
  const placeholder = document.createElement("p");
  placeholder.className = "raid-placeholder";
  placeholder.textContent = "Raid board coming soon.";
  mount.appendChild(placeholder);
}
