# Reproducible build/dev environment for parseomatic — Rust + Bun toolchain,
# so contributors don't need either installed on the host.
#
# Covers: cargo build/test/clippy, bun install/build, and Linux Tauri bundles
# (.deb / .AppImage). It does NOT produce macOS or Windows bundles (no Xcode
# SDK or MSVC toolchain available in a Linux container) — those are built on
# real runners in .github/workflows/release.yml. Running the GUI interactively
# (`tauri dev`) from here also needs X11/display forwarding, which this image
# does not set up.

FROM rust:1-bookworm

# Tauri's Linux build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    file \
    libayatana-appindicator3-dev \
    libgtk-3-dev \
    librsvg2-dev \
    libssl-dev \
    libwebkit2gtk-4.1-dev \
    patchelf \
    pkg-config \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Bun (frontend package manager/bundler)
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

# Tauri CLI (drives `cargo tauri build` / `cargo tauri dev`)
RUN cargo install tauri-cli --locked

WORKDIR /app
