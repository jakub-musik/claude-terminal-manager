#!/usr/bin/env bash
# install.sh — Build and install the Claude Terminal Manager extension.
#
# Bundles the TypeScript extension, packages a VSIX, and installs it into VS Code.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Installing npm dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo "==> Compiling TypeScript extension..."
pnpm compile

echo "==> Packaging VSIX..."
pnpm exec vsce package --no-dependencies

VSIX="$(ls -t claude-terminal-manager-*.vsix | head -1)"
echo "==> Installing ${VSIX}..."
code --install-extension "${VSIX}"

echo "==> Done! Reload VS Code to activate the updated extension."
