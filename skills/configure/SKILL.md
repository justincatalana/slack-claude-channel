---
name: configure
description: Configure Slack channel plugin tokens and view status
argument-hint: "[<bot-token> <app-token> | clear | status]"
allowed-tools: [Read, Write, Bash(ls *), Bash(mkdir *)]
---

# /slack:configure

Configure the Slack channel plugin. Tokens are stored in `~/.claude/channels/slack/.env`.

## Usage

**Show status** (no arguments or `status`):
Read `~/.claude/channels/slack/.env` and `~/.claude/channels/slack/access.json`. Report:
- Whether bot token is set (show first 10 chars + `...`)
- Whether app token is set (show first 10 chars + `...`)
- Current DM policy
- Number of allowed users
- Number of configured channels
- Delivery settings (ackReaction, replyToMode, etc.)

**Set tokens** (`$1` = bot token, `$2` = app token):
1. Validate bot token starts with `xoxb-`
2. Validate app token starts with `xapp-`
3. Create `~/.claude/channels/slack/` directory if needed
4. Write to `~/.claude/channels/slack/.env`:
```
SLACK_BOT_TOKEN=$1
SLACK_APP_TOKEN=$2
```
5. Confirm success and remind user to restart Claude with `--channels` flag

**Clear tokens** (`$1` = "clear"):
Remove `~/.claude/channels/slack/.env` and confirm.

**Set user token** (`$1` = "user-token", `$2` = token):
1. Validate token starts with `xoxp-`
2. Append or update `SLACK_USER_TOKEN` line in `.env`
3. This enables the `search_messages` tool

## Security

After initial setup, recommend the user tighten access:
1. DM the bot from Slack to get a pairing code
2. Run `/slack:access pair <code>` to approve yourself
3. Run `/slack:access policy allowlist` to lock down to approved users only

## Arguments

$ARGUMENTS
