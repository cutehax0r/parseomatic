# Parseomatic

A combat log parser for World of Warcraft. Opens a retail Advanced Combat Log (patch 12+) and parses it in the background, keyed off a hand-rolled tokenizer and aggressive string/GUID/spell/zone interning so multi-hundred-megabyte, multi-million-line logs stay fast and memory-light rather than materializing raw strings everywhere.

## Features

- **Fast, background parsing** — mmap'd, chunked in parallel across cores, then merged; a 547MB / 1.8M-line log parses in the background while the window stays responsive, with a progress bar until it's done.
- **Debug view** — nine tabbed tables built from the parsed log: Players, Pets (player-owned only), Creatures, Units, Spells, Zones, Encounters (including synthesized "Trash" spans between real pulls), Deaths, and Gear (spec + equipped items from `COMBATANT_INFO`, when present).
- **Raw view** — the combat log itself, one row per event in file order (time, kind, source, target, spell, details), virtualized so scrolling a multi-million-row log never renders more than what's on screen.
- Both views are virtualized end-to-end (`src/virtual-list.ts`) with recycled DOM rows and throttled scroll-driven fetches, so scrolling stays smooth regardless of log size.
- **Multiple windows** — open a log, open another in a new window, drag-and-drop a `.txt` log onto any window to load it there. Each window remembers its own view (Debug/Raw) independently.
- Catppuccin Macchiato color scheme.

See `docs/` for the combat log format reference, architecture/interning design notes, and a running log of performance characteristics and how they were addressed.

# Development

Have a look at the makefile for the usual stuff like building, releasing, etc.

## Getting Started

Development happens natively on macOS for now (Linux packaging can wait until there's a working app). Install:

- Xcode Command Line Tools: `xcode-select --install`
- Rust, via rustup: `brew install rustup && rustup default stable`
- Bun: `brew install bun` (used instead of npm/node for the frontend — install, dev, and build scripts)
- [GitHub CLI](https://cli.github.com) (`gh`) — required for the `make release` workflow

## Tech Stack
- [Tauri](https://tauri.app) — cross-platform app shell (Rust backend + native webview)
- [Bun](https://bun.sh) — JS/TS runtime and package manager (not the bundler — see below)
- [Vite](https://vite.dev) — frontend bundler/dev-server, as wired up by Tauri's official `vanilla-ts` template (kept rather than hand-rolling a Bun-only build, see project decision log)

## Daily Grind
```sh
make run                    # run the app locally
make run path/to/log.txt    # ...opening a specific log directly, skipping the open dialog
make build                  # produce a native bundle for this platform
make test                   # run Rust tests (cargo test)
make uninstall              # unregister the built .app from macOS Launch Services
                            # (fixes a stray relaunch loop that can happen after a `kill`)
```

`make help` lists everything, including the release workflow.
