#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds what the web package's tests and dev server need (the wasm for the browser and Node,
# and the app's assets), installing the pinned toolchain pieces when they are missing. Meant
# for a build machine: `fleet-build ... -- bash tools/agent/build-web-assets.sh`.
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/../.."
uname -a
command -v cargo >/dev/null || { echo "no cargo on this machine"; exit 2; }
rustup target list --installed | grep -q wasm32-unknown-unknown || rustup target add wasm32-unknown-unknown
if [ "$(wasm-bindgen -V 2>/dev/null | awk '{print $2}')" != "0.2.129" ]; then
  cargo install -q wasm-bindgen-cli --version 0.2.129 --locked
fi
command -v pnpm >/dev/null || corepack enable
cd packages/vitryne-web
pnpm install --frozen-lockfile
pnpm run wasm
pnpm run assets
ls -la pkg pkg-node public/examples
