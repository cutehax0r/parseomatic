.PHONY: help install run dev build test clean uninstall release

# Default target
.DEFAULT_GOAL := help

# Help target
help:
	@echo "Makefile targets for parseomatic:"
	@echo ""
	@echo "  make help                     Display this help message"
	@echo ""
	@echo "App targets:"
	@echo "  make install                  Install frontend dependencies (bun install)"
	@echo "  make run [FILE]               Run the app locally with hot reload"
	@echo "  make dev [FILE]               Alias for 'make run'"
	@echo "  make build                    Produce a native app bundle for this platform"
	@echo "  make test                     Run Rust tests (cargo test)"
	@echo "  make clean                    Remove build artifacts (dist/, src-tauri/target)"
	@echo "  make uninstall                Unregister the built .app from macOS Launch Services"
	@echo ""
	@echo "  FILE, if given, is opened directly on launch (skips the open"
	@echo "  dialog) -- e.g. make run src-tauri/tests/fixtures/some-log.txt"
	@echo ""
	@echo "Release targets:"
	@echo "  make release VERSION [COMMIT] [DRY]  Create GitHub PR-based release (full workflow)"
	@echo ""
	@echo "Examples:"
	@echo "  make release v1.0.0                  Release from main branch"
	@echo "  make release v1.0.0 abc123de         Release from specific commit"
	@echo "  make release v1.0.0 DRY              Preview what would happen"
	@echo "  make release v1.0.0 abc123de DRY     Preview from specific commit"

# App targets
install:
	bun install

# Extra words after `run`/`dev` on the command line (e.g. the FILE in
# `make run /path/to/log.txt`) show up in MAKECMDGOALS -- filtered against
# known target names (not just $@) so this works the same whether invoked
# as `run` or via the `dev` alias. `abspath` resolves it against the repo
# root: `tauri dev` runs the binary via `cargo run`, whose cwd is
# `src-tauri/`, so a bare relative path would otherwise be looked up one
# level too deep and fail with "cannot open file".
RUN_ARGS := $(abspath $(filter-out run dev build test clean install uninstall help release,$(MAKECMDGOALS)))

run: install
	@# Free the Vite dev port (vite.config.ts: port 1420, strictPort) in
	@# case a previous `make run` was backgrounded and never cleaned up.
	-@lsof -ti tcp:1420 | xargs kill 2>/dev/null || true
	bun run tauri dev -- -- $(RUN_ARGS)

dev: run

build: install
	bun run tauri build
	@# `tauri build` mounts the .dmg it just made (to stage / verify it) and
	@# usually leaves it mounted. Every leftover mount registers another
	@# com.cutehax0r.parseomatic with Launch Services, and macOS then can't
	@# tell which copy to launch (you get the dev build *and* a stale one).
	@# Unregister + unmount any parseomatic DMG we find.
	@if [ "$$(uname)" = "Darwin" ]; then \
		for v in /Volumes/dmg.* /Volumes/parseomatic; do \
			if [ -e "$$v/parseomatic.app" ]; then \
				echo "Cleaning up mounted DMG $$v"; \
				[ -x "$(LSREGISTER)" ] && "$(LSREGISTER)" -u "$$v/parseomatic.app" 2>/dev/null || true; \
				hdiutil detach -quiet "$$v" 2>/dev/null || hdiutil detach -force -quiet "$$v" 2>/dev/null || true; \
			fi; \
		done; \
	fi

test:
	cd src-tauri && cargo test

clean:
	rm -rf dist
	cd src-tauri && cargo clean

LSREGISTER := /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
APP_BUNDLE := src-tauri/target/release/bundle/macos/parseomatic.app

# The bundled release app registers itself as a .txt file handler with
# macOS Launch Services (see CFBundleDocumentTypes in tauri.conf.json).
# Once registered, launchd can relaunch it on its own (e.g. after a
# `kill`, or when Finder/Spotlight/QuickLook touches an associated .txt
# file) -- with no file argument on that relaunch, it falls straight to
# the open-file dialog and just sits there looking like a hang. Worse,
# every `make build` leaves its .dmg mounted, so registrations pile up and
# macOS can't tell which copy to launch. This purges *all* of them.
uninstall:
	@pkill -f "MacOS/parseomatic" 2>/dev/null || true
	@if [ "$$(uname)" = "Darwin" ] && [ -x "$(LSREGISTER)" ]; then \
		for v in /Volumes/dmg.* /Volumes/parseomatic; do \
			if [ -e "$$v/parseomatic.app" ]; then \
				echo "Detaching mounted DMG $$v"; \
				hdiutil detach -force -quiet "$$v" 2>/dev/null || true; \
			fi; \
		done; \
		n=0; \
		for p in $$("$(LSREGISTER)" -dump 2>/dev/null \
			| sed -n 's/^[[:space:]]*path:[[:space:]]*\(.*parseomatic\.app\) (0x[0-9a-f]*)$$/\1/p' \
			| sort -u); do \
			"$(LSREGISTER)" -u "$$p" 2>/dev/null && n=$$((n+1)) || true; \
		done; \
		[ -d "$(APP_BUNDLE)" ] && "$(LSREGISTER)" -u "$(APP_BUNDLE)" 2>/dev/null || true; \
		echo "Unregistered $$n parseomatic bundle(s) from Launch Services."; \
		echo "(A reboot clears any leftover /Volumes/parseomatic volume records.)"; \
	else \
		echo "Nothing to do (not on macOS, or lsregister missing)."; \
	fi

# Unified GitHub PR-based release target
release:
	@bash -c 'VERSION="$(word 2,$(MAKECMDGOALS))"; \
	COMMIT="$(word 3,$(MAKECMDGOALS))"; \
	DRY_RUN="$(word 4,$(MAKECMDGOALS))"; \
	if [ -z "$$VERSION" ] || [ "$$VERSION" = "release" ]; then \
		echo "ERROR: No version provided"; \
		echo "Usage: make release VERSION [COMMIT] [DRY]"; \
		echo "Examples:"; \
		echo "  make release v1.0.0"; \
		echo "  make release v1.0.0 abc123de"; \
		echo "  make release v1.0.0 DRY"; \
		echo "  make release v1.0.0 abc123de DRY"; \
		exit 1; \
	fi; \
	if [ -n "$$COMMIT" ] && [ "$$COMMIT" = "DRY" ]; then \
		DRY_RUN="$$COMMIT"; \
		COMMIT=""; \
	fi; \
	if [ -z "$$COMMIT" ]; then \
		COMMIT="main"; \
	fi; \
	if ! git rev-parse -q --verify "$$COMMIT" >/dev/null 2>&1; then \
		echo "ERROR: Invalid commit: $$COMMIT"; \
		exit 1; \
	fi; \
	if ! echo "$$VERSION" | grep -qE "^v[0-9]+\.[0-9]+\.[0-9]+$$"; then \
		echo "ERROR: Invalid version format: $$VERSION"; \
		echo "Must be semantic versioning format: vX.Y.Z (e.g., v1.0.0)"; \
		exit 1; \
	fi; \
	if git rev-parse -q --verify "refs/tags/$$VERSION" >/dev/null 2>&1; then \
		echo "ERROR: Tag $$VERSION already exists"; \
		echo "To see existing tags, run: git tag -l"; \
		exit 1; \
	fi; \
	if ! command -v gh &> /dev/null; then \
		echo "ERROR: GitHub CLI not found"; \
		echo "Install from: https://cli.github.com"; \
		exit 1; \
	fi; \
	if [ "$$DRY_RUN" = "DRY" ]; then \
		echo "DRY-RUN MODE (no changes will be made)"; \
		echo ""; \
		echo "Release: $$VERSION"; \
		echo "From commit: $$COMMIT"; \
		echo ""; \
		echo "Would perform:"; \
		echo "  1. Create branch release/$$VERSION (on $$COMMIT)"; \
		echo "  2. Bump version to $${VERSION#v} in src-tauri/tauri.conf.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock, package.json; set README.md first line to # Parseomatic $$VERSION"; \
		echo "  3. Commit change with message: tagging new release"; \
		echo "  4. Push branch to GitHub"; \
		echo "  5. Create PR with title: RELEASE: $$VERSION"; \
		echo "  6. Wait for CI checks (2 minute timeout)"; \
		echo "  7. Merge PR (squash)"; \
		echo "  8. Wait for merge to complete"; \
		echo "  9. Tag created via GitHub Actions"; \
		echo "  10. Delete local branch release/$$VERSION"; \
		echo ""; \
		echo "To execute, run: make release $$VERSION"; \
	else \
		echo "Creating release $$VERSION via GitHub PR..."; \
		echo "From commit: $$COMMIT"; \
		echo ""; \
		echo "Step 1/10: Creating branch..."; \
		BRANCH="release/$$VERSION"; \
		git checkout -b "$$BRANCH" "$$COMMIT" >/dev/null 2>&1 || { echo "ERROR: Failed to create branch on $$COMMIT"; exit 1; }; \
		echo "✓ Created branch $$BRANCH from $$COMMIT"; \
		echo ""; \
		echo "Step 2/10: Bumping version and updating README.md..."; \
		if [ ! -f "README.md" ]; then echo "ERROR: README.md not found"; exit 1; fi; \
		VNUM="$${VERSION#v}"; \
		sed -i.bak "1s/^#.*[Pp]arseomatic.*$$/# Parseomatic $$VERSION/" README.md || { echo "ERROR: Failed to update README.md"; exit 1; }; \
		rm -f README.md.bak; \
		sed -i.bak "s/^version = \".*\"/version = \"$$VNUM\"/" src-tauri/Cargo.toml && rm -f src-tauri/Cargo.toml.bak || { echo "ERROR: Failed to bump src-tauri/Cargo.toml"; exit 1; }; \
		sed -i.bak "s/\"version\": \".*\"/\"version\": \"$$VNUM\"/" src-tauri/tauri.conf.json && rm -f src-tauri/tauri.conf.json.bak || { echo "ERROR: Failed to bump src-tauri/tauri.conf.json"; exit 1; }; \
		sed -i.bak "s/\"version\": \".*\"/\"version\": \"$$VNUM\"/" package.json && rm -f package.json.bak || { echo "ERROR: Failed to bump package.json"; exit 1; }; \
		if command -v cargo >/dev/null 2>&1; then ( cd src-tauri && cargo update -p parseomatic >/dev/null 2>&1 ) || true; fi; \
		echo "✓ Version -> $$VNUM (tauri.conf.json, Cargo.toml, Cargo.lock, package.json); README.md first line -> # Parseomatic $$VERSION"; \
		echo ""; \
		echo "Step 3/10: Committing change..."; \
		git add README.md src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock package.json || { echo "ERROR: Failed to stage version bump"; exit 1; }; \
		git commit -m "tagging new release" >/dev/null 2>&1 || { echo "ERROR: Failed to commit"; exit 1; }; \
		echo "✓ Committed change"; \
		echo ""; \
		echo "Step 4/10: Pushing to GitHub..."; \
		git push -u origin "$$BRANCH" >/dev/null 2>&1 || { echo "ERROR: Failed to push branch"; exit 1; }; \
		echo "✓ Pushed to origin"; \
		echo ""; \
		echo "Step 5/10: Creating pull request..."; \
		PR_URL=$$(gh pr create --title "RELEASE: $$VERSION" --body "Release $$VERSION" --base main --head "$$BRANCH" 2>&1) || { echo "ERROR: Failed to create PR"; exit 1; }; \
		PR_NUMBER=$$(echo "$$PR_URL" | awk -F"/" "{print \$$NF}"); \
		echo "✓ Created PR #$$PR_NUMBER"; \
		echo "  Link: $$PR_URL"; \
		echo ""; \
		echo "Step 6/10: Waiting for CI checks (2 min timeout)..."; \
		CHECK_COUNT=0; \
		while [ $$CHECK_COUNT -lt 120 ]; do \
			CHECKS=$$(gh pr view "$$PR_NUMBER" --json statusCheckRollup -q ".statusCheckRollup | map(select(.status != \"COMPLETED\")) | length" 2>/dev/null); \
			if [ "$$CHECKS" = "0" ]; then \
				FAILED=$$(gh pr view "$$PR_NUMBER" --json statusCheckRollup -q ".statusCheckRollup | map(select(.conclusion == \"FAILURE\")) | length" 2>/dev/null); \
				if [ "$$FAILED" -gt 0 ]; then echo "ERROR: CI checks failed"; echo "Check results: $$PR_URL"; exit 1; fi; \
				echo "✓ All checks passed!"; \
				break; \
			fi; \
			sleep 1; CHECK_COUNT=$$((CHECK_COUNT + 1)); \
		done; \
		if [ $$CHECK_COUNT -ge 120 ]; then echo "ERROR: Checks did not complete within 2 minutes"; echo "Check status: $$PR_URL"; exit 1; fi; \
		echo ""; \
		echo "Step 7/10: Merging pull request..."; \
		gh pr merge --squash "$$PR_NUMBER" >/dev/null 2>&1 || { echo "ERROR: Failed to merge PR"; exit 1; }; \
		echo "✓ PR merged (squash)"; \
		echo ""; \
		echo "Step 8/10: Waiting for merge to complete..."; \
		MERGE_COUNT=0; \
		while [ $$MERGE_COUNT -lt 30 ]; do \
			STATE=$$(gh pr view "$$PR_NUMBER" --json state -q .state 2>/dev/null); \
			if [ "$$STATE" = "MERGED" ]; then echo "✓ Merge completed"; break; fi; \
			sleep 1; MERGE_COUNT=$$((MERGE_COUNT + 1)); \
		done; \
		echo ""; \
		echo "Step 9/10: Confirming tag creation..."; \
		TAG_COUNT=0; \
		while [ $$TAG_COUNT -lt 30 ]; do \
			if git rev-parse -q --verify "refs/tags/$$VERSION" >/dev/null 2>&1; then echo "✓ Tag $$VERSION created"; break; fi; \
			git fetch --tags origin >/dev/null 2>&1; sleep 1; TAG_COUNT=$$((TAG_COUNT + 1)); \
		done; \
		echo ""; \
		echo "Step 10/10: Cleaning up..."; \
		git checkout main >/dev/null 2>&1; \
		git branch -D "$$BRANCH" >/dev/null 2>&1; \
		git pull origin main >/dev/null 2>&1; \
		echo "✓ Deleted local branch $$BRANCH"; \
		echo ""; \
		echo "✓ Release $$VERSION created successfully!"; \
		echo ""; \
		echo "GitHub Actions will now build and create artifacts."; \
		echo "Monitor at: https://github.com/cutehax0r/parseomatic/actions/workflows/release.yml"; \
		echo "Or run: gh run list --workflow release.yml -L 5"; \
	fi'
	@true

# Catch-all for release targets to suppress "No rule to make target" errors
%:
	@true
