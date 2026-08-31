# Status

Where the project stands, for picking this back up in a fresh conversation. For *how* things work, see `planning.md` (overall architecture/design decisions) and `windows-and-files.md` (multi-window/file-open implementation detail) — this doc is just "what's done, what's not."

## Stack

Tauri (Rust) + vanilla TypeScript + Vite + Bun. No UI framework. Native installs via Homebrew (`rustup`, `bun`, Xcode CLT) — no Docker/Podman, that was tried and dropped. `make` is the front end to everything (`make help` for the list); `make run` for dev, `make build` for a release bundle.

## What's built (commit history so far)

1. **Basic planning and infrastructure** — `docs/planning.md` (architecture decisions), release automation (`make release`, GitHub Actions), README.
2. **Scaffold app** — Tauri + Bun + Vite skeleton via `create-tauri-app`.
3. **Opening files and attaching windows** — the multi-window architecture. Full detail in `docs/windows-and-files.md`; short version:
   - File > Open / toolbar / drag-and-drop (onto a window, and onto the Dock icon) all open files.
   - Multiple windows can share one file's data via `Arc<ParsedLog>` — opening the same file twice never re-reads it, and "New Window" spawns a sibling view of the *current* file with zero re-parsing (verified with real instrumentation, not just code review).
   - A file's data is freed automatically once the last window showing it closes (plain Rust `Arc`/`Weak` ownership, no manual refcounting).
   - App stays running with zero windows open on macOS (Dock reopens it); launches straight into the open dialog.
   - `parseomatic <path>` opens a file directly from the command line, skipping the dialog (also how this project's automated testing works, since the native file picker can't be driven reliably by an agent).
   - Failed opens show an error dialog and leave the target window's state untouched.
4. **Basic parsing is in** — `src-tauri/src/parser.rs`. Still just a placeholder for real parsing (`ParsedLog` = path + line count, nothing structural yet), but the counting itself is real and fast: mmap the file, split into newline-aligned chunks (~filesize/numcpus, capped at 1MB), count each chunk in parallel with `rayon` + `memchr`. **12ms for a 547MB/1.8M-line file** — faster than `rg -c '$'` itself. Counting runs in the background so the window appears instantly regardless of file size; a status bar shows live progress and hides when done (only visible in practice for files slow enough to need it, which the test file no longer is).

## What's not built yet

Everything past line-counting. Per `docs/planning.md`'s design (not yet implemented):
- The real tokenizer: bytewise (no regex), build tokens before casting to typed values, byte-offset-tagged structs for debugging. Reference for the log format: [warcraft.wiki.gg/wiki/Combat_Log](https://warcraft.wiki.gg/wiki/Combat_Log).
- String interning for player/spell names.
- Encounter detection (`ENCOUNTER_START`/`ENCOUNTER_END` pairing, malformed-log handling).
- Entity state replay + checkpointing (for scrubbing).
- All 4 views: log table, character status panel, 3D spatial replay (Three.js), statistics view. The frontend today is just a toolbar + a line-count placeholder, nothing view-like exists.
- Directory monitoring / live log tailing (`notify` crate).
- Frontend framework choice for the panel/table UI is still an open question (noted in `planning.md`'s Open Questions).

## Known constraints worth remembering

- Testing this app interactively requires either the CLI-arg launch (reliable) or manual clicking by the user — the native file-open dialog cannot be automated reliably.
- Dock-icon file drop only works in a bundled `.app` (`make build`), not the raw dev binary.
- Drag-and-drop onto a window must be handled as `WindowEvent::DragDrop`, not `WebviewEvent::DragDrop` — an easy, silent mistake (see `windows-and-files.md`).
