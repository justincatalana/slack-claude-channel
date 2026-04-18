#!/usr/bin/env bash
set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────
bold='\033[1m'
dim='\033[2m'
green='\033[32m'
yellow='\033[33m'
red='\033[31m'
reset='\033[0m'

say()  { echo -e "${bold}$*${reset}"; }
ok()   { echo -e "${green}✓${reset} $*"; }
warn() { echo -e "${yellow}!${reset} $*"; }
err()  { echo -e "${red}✗${reset} $*" >&2; }
dim()  { echo -e "${dim}$*${reset}"; }

# ── Locate project root ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

say "slack-claude-channel setup"
echo

# ── Step 1: Check for bun ────────────────────────────────────────────
BUN=""
if command -v bun &>/dev/null; then
  BUN="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
else
  # Check mise installs
  for d in "$HOME"/.local/share/mise/installs/bun/*/bin/bun; do
    if [ -x "$d" ]; then
      BUN="$d"
      break
    fi
  done
fi

if [ -n "$BUN" ]; then
  ok "bun found: $BUN ($("$BUN" --version))"
else
  say "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  BUN="$HOME/.bun/bin/bun"
  if [ -x "$BUN" ]; then
    ok "bun installed: $BUN"
  else
    err "Failed to install bun. Install manually: https://bun.sh"
    exit 1
  fi
fi

# ── Step 2: Install dependencies ─────────────────────────────────────
say "Installing dependencies..."
"$BUN" install --no-summary
ok "Dependencies installed"
echo

# ── Step 3: Create Slack app ─────────────────────────────────────────
MANIFEST=$(cat "$SCRIPT_DIR/slack-manifest.json")
ENCODED=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.stdin.read()))" <<< "$MANIFEST" 2>/dev/null \
  || node -e "process.stdout.write(encodeURIComponent(require('fs').readFileSync('/dev/stdin','utf8')))" <<< "$MANIFEST" 2>/dev/null \
  || echo "")

MANIFEST_URL="https://api.slack.com/apps?new_app=1&manifest_json=${ENCODED}"

say "Step 1: Create your Slack app"
echo
if [ -n "$ENCODED" ]; then
  dim "Opening browser to create your Slack app..."
  dim "(All scopes, events, and Socket Mode are pre-configured)"
  echo
  # Try to open browser
  if command -v xdg-open &>/dev/null; then
    xdg-open "$MANIFEST_URL" 2>/dev/null || true
  elif command -v open &>/dev/null; then
    open "$MANIFEST_URL" 2>/dev/null || true
  else
    echo "Open this URL in your browser:"
    echo "$MANIFEST_URL"
  fi
else
  echo "Go to https://api.slack.com/apps"
  echo "→ Create New App → From an app manifest"
  echo "→ Paste the contents of slack-manifest.json"
fi

echo
say "Step 2: Get your tokens"
echo
dim "After creating the app:"
dim "  1. Basic Information → App-Level Tokens → Generate Token"
dim "     (add 'connections:write' scope) → copy the xapp-* token"
dim "  2. Install App → Install to Workspace → copy the xoxb-* token"
echo

# ── Step 4: Collect tokens ───────────────────────────────────────────
STATE_DIR="$HOME/.claude/channels/slack"
ENV_FILE="$STATE_DIR/.env"
SKIP_TOKENS=""

# Check if already configured
if [ -f "$ENV_FILE" ]; then
  echo
  warn "Existing tokens found at $ENV_FILE"
  read -rp "Overwrite? [y/N] " overwrite
  if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
    ok "Keeping existing tokens"
    SKIP_TOKENS=true
  fi
fi

if [ -z "$SKIP_TOKENS" ]; then
  while true; do
    read -rp "Bot token (xoxb-...): " BOT_TOKEN
    if [[ "$BOT_TOKEN" == xoxb-* ]]; then
      break
    fi
    err "Bot token must start with xoxb-"
  done

  while true; do
    read -rp "App token (xapp-...): " APP_TOKEN
    if [[ "$APP_TOKEN" == xapp-* ]]; then
      break
    fi
    err "App token must start with xapp-"
  done

  # Write tokens
  mkdir -p "$STATE_DIR"
  cat > "$ENV_FILE" <<EOF
SLACK_BOT_TOKEN=$BOT_TOKEN
SLACK_APP_TOKEN=$APP_TOKEN
EOF
  ok "Tokens saved to $ENV_FILE"
fi

echo

# ── Done ──────────────────────────────────────────────────────────────
say "Done! Next steps:"
echo
echo "  1. Start Claude with the Slack channel:"
dim "     claude --plugin-dir $SCRIPT_DIR"
echo
echo "  2. DM your bot in Slack to get a pairing code"
echo
echo "  3. Approve the pairing:"
dim "     /slack:access pair <code>"
echo
echo "  4. Lock down to your user only:"
dim "     /slack:access policy allowlist"
echo
