# Parseomatic

A combat log parser for World of Warcraft. Opens a retail Advanced Combat Log
(patch 12+) and parses it. Slowly adding features from sites like world of logs
but hopefully a lot faster because all the data is local. Having access to
regular OS windows also means we can do certain kinds of analysis with greater
ease: comparing two characters or two pulls for example.

## Features

# Development

Have a look at the makefile for the usual stuff like building, releasing, etc.
There are some notes in the docs folder of questionable values.

## Getting Started

Development happens natively on macOS for now. Install:

- Xcode Command Line Tools: `xcode-select --install`
- Rust, via rustup: `brew install rustup && rustup default stable`
- The `llvm-tools` rustup component: `rustup component add llvm-tools` — supplies a working `rust-objcopy`, which `make build` uses to strip release binaries. Without it, `make build` still succeeds but warns and ships an unstripped (larger) binary.
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

`make build` places the final artifacts under `src-tauri/target/release/bundle/`:
- `macos/parseomatic.app` — the app bundle itself
- `dmg/parseomatic_<version>_<arch>.dmg` — a disk image wrapping it, for distribution

Both are gitignored (`target/` isn't tracked). If a `.app` there was ever run directly (as opposed to via `make run`, which uses `target/debug/...`), macOS registers it with Launch Services — see `make uninstall` above.
