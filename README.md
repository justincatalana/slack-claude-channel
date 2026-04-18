# slack-claude-channel

Slack channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Receive DMs, @mentions, and private-channel messages; reply in channels or threads — all from your terminal (or a VPS, or a container).

Uses Slack **Socket Mode** (outbound WebSocket) so no public URL, SSL cert, or domain is needed. Run it on any VPS or local machine.

## Quick Start

```bash
git clone https://github.com/justincatalana/slack-claude-channel.git
cd slack-claude-channel
./setup.sh
```

The setup script:
1. Installs bun (if needed) and dependencies.
2. Opens your browser to create a pre-configured Slack app via `slack-manifest.json` (all scopes, events, and Socket Mode are set automatically).
3. Prompts for your two tokens and saves them to `~/.claude/channels/slack/.env`.

Then launch Claude with the plugin loaded:

```bash
claude --plugin-dir /path/to/slack-claude-channel
```

The plugin declares the `claude/channel` MCP capability, so Claude Code auto-activates it on startup — no separate `--channels` flag required.

DM the bot in Slack → get a pairing code → `/slack:access pair <code>` → done.

## Manual Setup

If you prefer to set things up yourself:

### 1. Create a Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest** → select your workspace → paste the contents of [`slack-manifest.json`](slack-manifest.json) → **Create**.

This pre-configures all scopes, events (DM, public channel, private channel, @mention), and Socket Mode in one step.

Then grab your two tokens:

1. **App-Level Token**: Basic Information → App-Level Tokens → **Generate Token** with `connections:write` scope → save the `xapp-*` token.
2. **Bot Token**: Install App → Install to Workspace → save the `xoxb-*` token.

### 2. Install Dependencies

```bash
bun install
```

### 3. Configure Tokens

```
/slack:configure xoxb-your-bot-token xapp-your-app-token
```

Or create `~/.claude/channels/slack/.env` directly:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

### 4. Launch

```bash
claude --plugin-dir /path/to/slack-claude-channel
```

### 5. Pair

1. DM the bot in Slack — you'll get a pairing code.
2. In Claude Code: `/slack:access pair <code>`
3. Lock down: `/slack:access policy allowlist`

## Usage

Once paired, DM the bot or @mention it in an opted-in channel. Claude receives the message and can reply using its full tool set.

### Public & Private Channel Listening

Channels are opt-in. To have the bot listen in a channel it's been invited to:

```
/slack:access channel add C0123456789
/slack:access channel add C0123456789 --no-mention
/slack:access channel add C0123456789 --allow U111,U222
```

- By default, messages in a configured channel require an `@mention` of the bot.
- `--no-mention` forwards every non-bot message in the channel (useful for dedicated bot channels).
- `--allow <user_ids>` restricts to specific users.

The manifest subscribes to `message.channels`, `message.groups`, and `message.im`, so private channels work the same as public ones once added.

### Access Control

See [ACCESS.md](ACCESS.md) for full details on pairing, allowlists, and policies.

## Programmatic Setup (for bots, agents, containers)

If you're running this plugin inside a headless container or agent framework (for example, one Claude Code process per Slack channel), you probably don't want to DM-pair at all. Bootstrap the plugin by writing its state files directly:

```bash
# Tokens
cat > ~/.claude/channels/slack/.env <<EOF
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
EOF

# Access: DMs disabled, one channel owned, no mention required, anyone in the channel can talk to it.
mkdir -p ~/.claude/channels/slack
cat > ~/.claude/channels/slack/access.json <<EOF
{
  "dmPolicy": "disabled",
  "allowFrom": [],
  "channels": {
    "C0123456789": { "requireMention": false, "allowFrom": [] }
  },
  "pending": {},
  "delivery": {}
}
EOF
```

Then launch Claude with the plugin in the same way:

```bash
claude --plugin-dir /path/to/slack-claude-channel --dangerously-skip-permissions
```

The `--dangerously-skip-permissions` flag is appropriate for a sandboxed container where you trust the workload, not for interactive use.

## Troubleshooting

### Server doesn't connect to Slack

- Verify tokens: `cat ~/.claude/channels/slack/.env`
- Test standalone: `bun server.ts` — you should see `MCP server connected` then `Slack Bolt connected via Socket Mode`.
- If you see `invalid_auth`, regenerate your tokens in the Slack app dashboard.

### Messages not reaching Claude

- Confirm the plugin is loaded: `/plugin list` should include `slack`.
- Check that your user is in the allowlist: `cat ~/.claude/channels/slack/access.json`.
- Run `/slack:access` in Claude Code to see the current access state.
- For private channels, make sure the bot was invited (`/invite @ClaudeCode` in Slack) AND that the channel is added via `/slack:access channel add <id>`.

### bun not found

- `run.sh` searches PATH, mise installs, and `~/.bun/bin/` automatically.
- Install bun: `curl -fsSL https://bun.sh/install | bash`.

## Optional: Search

Slack's `search.messages` API requires a **user token** (`xoxp-*`), not a bot token. To enable the `search_messages` tool:

```
/slack:configure user-token xoxp-your-user-token
```

## License

Apache-2.0
