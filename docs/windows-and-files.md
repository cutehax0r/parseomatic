# Windows, Files, and Drag-and-Drop

How opening a file, multiple windows, and drag-and-drop fit together. This
describes what's actually implemented in `src-tauri/src/lib.rs`, not a
future plan. `ParsedLog` now holds the real parsed representation described
in `planning.md` (interned tables, columnar event store, reports) plus the
retained `Mmap` its raw field spans resolve against — this doc's design
(sharing, lifecycle, multi-window) was written to be agnostic to what's
actually inside `ParsedLog`, and swapping in the real parser didn't end up
requiring any changes to it.

## Core idea: windows share data by reference

A file's parsed data lives once in memory as an `Arc<ParsedLog>`. Any
number of windows can point at the same `Arc` — opening the same file
twice never re-parses it, and N windows showing one file cost the same
memory as one window showing it.

Two pieces of global state (managed via `app.manage(...)`) make this work:

- **`LogRegistry`** — `Mutex<HashMap<PathBuf, Weak<ParsedLog>>>`, keyed by
  canonicalized file path. Used only to answer "is this file already
  open somewhere?" so a second open/drop of the same file reuses the
  existing data instead of re-reading it. It holds `Weak` references
  deliberately: the registry itself must never keep a `ParsedLog` alive,
  or files would never get freed once all their windows close.
- **`WindowLogs`** — `Mutex<HashMap<String, Arc<ParsedLog>>>`, keyed by
  window label. This is the *real* ownership: each window holds a strong
  `Arc` for whatever file it's currently displaying.

Because of this split, cleanup is just normal Rust ownership — nothing
bespoke to get wrong:

- A window closes → its `WindowLogs` entry is removed → if that was the
  last strong `Arc` for that file, `ParsedLog` deallocates right there.
  See `register_close_cleanup` (listens for `WindowEvent::Destroyed`).
- A window's file changes (open a different file in the same window, or
  drag-drop replaces it) → `WindowLogs`'s `insert` overwrites the old
  `Arc`, dropping it the same way if nothing else was still using it.

`get_or_parse(app, path)` is the single entry point for "give me this
file's data": canonicalize, check the registry, reuse-or-read, register a
`Weak` for future dedup, return an `Arc`.

## Getting a file into a window

`open_path_in_window(window, path)` is the one function that actually
attaches a file to a window — it's the shared tail end of every way a
file can reach the app (open dialog, drag-and-drop, OS file-open). It
calls `get_or_parse`, and on success:

1. `attach_window_to_log` — records the `Arc` in `WindowLogs` under this
   window's label, and emits a `log-changed` event so the window's own
   frontend re-fetches its state (via the `window_info` command).
2. `apply_window_chrome` — sets the window title to `parseomatic:
   <filename>` and, on macOS, the title-bar proxy icon
   (`NSWindow.setRepresentedFilename`).

On failure (only ever an I/O error — canonicalize/open/mmap; combat-log
content itself is parsed leniently in the background and never fails
synchronously), it shows a native "could not be opened: `<reason>`" dialog
and touches nothing else — the window is left exactly as it was. An
already-open file keeps showing (a bad drag-drop shouldn't break a
working window); an empty window just stays empty (a failed open-dialog
pick never spawns a new window with data). See `show_open_error`.

## Multiple windows

- **File > Open / toolbar button** (`pick_and_open_log`) — opens the
  native file dialog on whichever window triggered it (or the focused
  window, for the menu item), remembers the chosen directory
  (`get_last_dir`/`set_last_dir`, persisted to `app_config_dir()`) for
  next time.
- **New Window** (`spawn_sibling_window`) — looks up the calling window's
  current `Arc<ParsedLog>` and attaches a freshly created window to the
  *same* `Arc`. Zero re-parsing, just a refcount bump.
- **Window creation** (`create_empty_window`) always goes through
  `WebviewWindowBuilder`, with a counter-based label (`log-1`, `log-2`,
  ...), and always registers `register_close_cleanup`, `register_drag_drop`
  and `register_focus_sync` on the new window before handing it back. It's
  sized to ~80% of its monitor (`size_to_monitor`, which returns the size
  it applied), then **placed**: the first window (`main`, and any
  OS/dock-driven open) is centered via `center_in_work_area` — an explicit
  `set_position` computed from the monitor work area and the size we just
  set, *not* `window.center()`, which reads the live size and so races the
  `set_size` (centering the old 800×600 and leaving the grown window low
  and right). A window spawned off another
  (`create_empty_window(app, Some(src))` from `spawn_sibling_window`) is
  `cascade_from`'d one title-bar step (`CASCADE_STEP`, 28 logical px)
  down-and-right of its source, wrapping back toward the work-area top-left
  when a step would run it off-screen — same stagger the OS uses for its
  own "New Window".

Every window's capability permissions come from a single glob-scoped
capability (`src-tauri/capabilities/default.json`, `"windows": ["*"]`)
rather than listing labels individually, since every window in this app
needs the same permission set.

### Thread-safety notes (learned the hard way this session)

- `WebviewWindowBuilder::build()` deadlocks on Windows if called
  synchronously on the main thread. Plain (non-`sync`) `#[tauri::command]`
  functions already run off the main thread by default, so calling
  window-creating code directly from a command body is safe — but
  `on_menu_event`/`RunEvent` handlers run *on* the main thread, so
  anything in them that might create a window is wrapped in
  `std::thread::spawn`.
- AppKit calls (the proxy-icon trick) can only happen on the main thread.
  `apply_window_chrome` always marshals through
  `window.run_on_main_thread(...)`, regardless of which thread called it,
  so callers don't need to think about this themselves.

## Drag-and-drop

Two distinct mechanisms, both funnel into `open_path_in_window`:

- **Dropping a file onto a window** (`register_drag_drop`) — this is a
  `WindowEvent::DragDrop`, *not* a `WebviewEvent::DragDrop`. A window's
  primary, full-window webview (`WebviewKind::WindowContent`, which is
  every window in this app) delivers drops as a window event; the
  webview-level event only fires for child/embedded webviews. Getting
  this wrong looks like drag-and-drop silently doing nothing. Reading the
  file happens on a spawned thread, since window events dispatch on the
  main thread and large logs shouldn't block it.
- **Dropping a file onto the app/Dock icon** (`RunEvent::Opened`,
  macOS/iOS/Android only) — `open_path_from_os` focuses an existing
  window already showing that file if one exists
  (`find_window_for_path`), otherwise spawns a new window for it.

  This **requires the app to declare a file association** in
  `tauri.conf.json`'s `bundle.fileAssociations` — without it, Finder
  doesn't treat the Dock icon as a valid drop target at all (no bounce,
  no highlight, drop silently does nothing), regardless of whether
  `RunEvent::Opened` is wired up correctly on the Rust side. We declare
  `.txt` / `public.plain-text` as `role: Viewer`, `rank: None` ("accepts
  drops of this type, but never becomes the default opener for it") —
  deliberately not claiming ownership of `.txt` files in general, just
  accepting drops of them. This only takes effect in a properly bundled
  `.app` (`make build`), not the raw `cargo run`/`tauri dev` binary — the
  Dock-drop path can't be tested under `make run`.
- **Clicking the Dock icon with zero windows open** (`RunEvent::Reopen`,
  macOS only) re-triggers the open dialog on a fresh window, pairing with
  `RunEvent::ExitRequested` + `api.prevent_exit()` (macOS only) — the app
  stays running with no windows open rather than quitting, matching
  normal macOS app behavior, and clicking the Dock icon is how you get a
  window back.
