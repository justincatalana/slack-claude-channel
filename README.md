# slack-claude-channel

Slack channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Receive DMs and @mentions from Slack, reply in threads — all without leaving your terminal.

Uses Slack **Socket Mode** (outbound WebSocket) so no public URL, SSL cert, or domain is needed. Run it on any VPS or local machine.

## Quick Start

```bash
git clone https://github.com/justincatalana/slack-claude-channel.git
cd slack-claude-channel
./setup.sh
```

The setup script will:
1. Install bun (if needed) and dependencies
2. Open your browser to create a pre-configured Slack app (all scopes/events/Socket Mode set automatically)
3. Prompt for your two tokens and save them
4. Install the plugin into Claude Code

Then:

```bash
claude --channels
```

DM the bot in Slack → get a pairing code → `/slack:access pair <code>` → done.

## Manual Setup

If you prefer to set things up yourself:

### 1. Create a Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest** → select your workspace → paste the contents of [`slack-manifest.json`](slack-manifest.json) → **Create**.

This pre-configures all scopes, events, and Socket Mode in one step.

Then grab your two tokens:
1. **App-Level Token**: Basic Information → App-Level Tokens → **Generate Token** with `connections:write` scope → save the `xapp-*` token
2. **Bot Token**: Install App → Install to Workspace → save the `xoxb-*` token

### 2. Install

```bash
bun install
claude plugin add /path/to/slack-claude-channel
```

### 3. Configure Tokens

```
/slack:configure xoxb-your-bot-token xapp-your-app-token
```

### 4. Launch

```bash
claude --channels
```

### 5. Pair

1. DM the bot in Slack — you'll get a pairing code
2. In Claude Code: `/slack:access pair <code>`
3. Lock down: `/slack:access policy allowlist`

## Usage

Once paired, DM the bot or @mention it in an opted-in channel. Claude receives the message and can reply using its full tool set.

### Channel Listening

Channels are opt-in:

```
/slack:access channel add C0123456789
/slack:access channel add C0123456789 --no-mention
```

### Access Control

See [ACCESS.md](ACCESS.md) for full details on pairing, allowlists, and policies.

## Optional: Search

Slack's `search.messages` API requires a **user token** (`xoxp-*`), not a bot token. To enable the `search_messages` tool:

```
/slack:configure user-token xoxp-your-user-token
```

## License

Apache-2.0
