# Parseomatic

A combat log parser for world of warcraft.

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
make run    # run the app locally
make build  # produce a native bundle for this platform
```
