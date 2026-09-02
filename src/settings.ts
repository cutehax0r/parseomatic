// The Settings window's script (settings.html, a separate Rollup entry).
// For now it only fills in the version / build line. `__APP_VERSION__`
// (from package.json) and `__BUILD_STAMP__` (build time + git short SHA,
// "-dirty" if the tree had uncommitted changes) are injected by Vite --
// see vite.config.ts.

declare const __APP_VERSION__: string;
declare const __BUILD_STAMP__: string;

const el = document.querySelector("#settings-version");
if (el) el.textContent = `parseomatic ${__APP_VERSION__} · built ${__BUILD_STAMP__}`;
