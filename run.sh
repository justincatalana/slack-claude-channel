#!/usr/bin/env bash
# Launcher for the MCP server — resolves bun from common locations
# and ensures no stray stdout from package installation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Find bun: PATH, mise, common install locations
find_bun() {
  command -v bun 2>/dev/null && return
  # mise
  for d in "$HOME"/.local/share/mise/installs/bun/*/bin/bun; do
    [ -x "$d" ] && echo "$d" && return
  done
  # bun default install
  [ -x "$HOME/.bun/bin/bun" ] && echo "$HOME/.bun/bin/bun" && return
  echo "bun" # fallback — will fail with a clear error
}

BUN="$(find_bun)"

# Install deps silently (stderr only — stdout is MCP)
"$BUN" install --cwd "$SCRIPT_DIR" --no-summary >&2 2>&1 || true

# Run the server
exec "$BUN" "$SCRIPT_DIR/server.ts"
