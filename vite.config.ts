import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// A human-readable identifier for *this* build, shown in the Settings
// window (src/settings.ts). Evaluated when Vite starts -- so `make run`
// stamps the dev-server start time, `make build` stamps the build time.
// Tauri's own version (tauri.conf.json) feeds the native About panel;
// this is the finer-grained "which build am I looking at".
function buildStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  let git = "nogit";
  try {
    const run = (cmd: string) =>
      execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const sha = run("git rev-parse --short HEAD");
    git = run("git status --porcelain") ? `${sha}-dirty` : sha;
  } catch {
    /* not a git checkout */
  }
  return `${when} · ${git}`;
}

// https://vite.dev/config/
export default defineConfig(async () => ({

  // Compile-time constants -- see src/settings.ts.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_STAMP__: JSON.stringify(buildStamp()),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Multi-page build: the Settings window is a second, separate HTML entry
  // point (settings.html), not a route within the main index.html -- kept
  // as its own minimal page rather than teaching the log-viewer's chrome
  // to also render a settings UI. Input paths resolve relative to root.
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        settings: "settings.html",
      },
    },
  },
}));
