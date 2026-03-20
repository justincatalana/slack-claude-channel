# Access Control

The Slack channel plugin gates who can interact with Claude Code via Slack. All state lives in `~/.claude/channels/slack/access.json`.

## DM Policy

Controls how direct messages are handled:

| Policy | Behavior |
|--------|----------|
| `pairing` (default) | Unknown users receive a 6-character pairing code. The Claude Code operator approves via `/slack:access pair <code>`. |
| `allowlist` | Only users in `allowFrom` can send DMs. Unknown users are silently ignored. |
| `disabled` | All DMs are blocked. |

## Pairing Flow

1. User sends a DM to the Slack bot
2. Bot replies with a pairing code (e.g., `a7k3m2`), valid for 1 hour
3. Claude Code operator runs `/slack:access pair a7k3m2`
4. User is added to the allowlist and receives a confirmation DM
5. Subsequent DMs from that user are forwarded to Claude

Maximum 3 pending pairings at a time. Oldest is evicted if exceeded.

## Channel Listening

Channels are **opt-in**. To enable:

```
/slack:access channel add C0123456789
```

Options:
- By default, requires an `@mention` of the bot
- `--no-mention` to forward all messages (use with caution)
- `--allow U111,U222` to restrict to specific users

## Allowlist

Manage the global DM allowlist:

```
/slack:access allow U0123456789    # add user
/slack:access remove U0123456789   # remove user
```

## Delivery Settings

Configure how messages are delivered:

```
/slack:access set ackReaction eyes         # react to acknowledge receipt
/slack:access set replyToMode all          # thread all reply chunks
/slack:access set textChunkLimit 4000      # max chars per message
/slack:access set chunkMode newline        # split at paragraph boundaries
```

## Security

- Access mutations (`pair`, `deny`, `allow`, `remove`, `policy`, `channel`) are only accepted from direct Claude Code operator input, never from channel messages
- The plugin refuses to send files from the state directory (`~/.claude/channels/slack/`)
- Pairing codes are cryptographically random (6 hex chars from `crypto.randomBytes`)
