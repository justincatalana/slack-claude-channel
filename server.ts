import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { App, LogLevel } from "@slack/bolt";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { z } from "zod";
import {
  loadAccess,
  saveAccess,
  gate,
  generatePairingCode,
  addPending,
  pollApprovals,
  assertSendable,
  getStateDir,
  getInboxDir,
} from "./access.js";
import { toMrkdwn } from "./mrkdwn.js";

// ── Env ──────────────────────────────────────────────────────────────

const ENV_FILE = join(getStateDir(), ".env");

async function loadEnv(): Promise<{ botToken: string; appToken: string }> {
  try {
    const raw = await readFile(ENV_FILE, "utf-8");
    const vars: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) vars[m[1]] = m[2];
    }
    return {
      botToken: vars.SLACK_BOT_TOKEN || "",
      appToken: vars.SLACK_APP_TOKEN || "",
    };
  } catch {
    return { botToken: "", appToken: "" };
  }
}

// ── Logging (stderr only — stdout is MCP) ────────────────────────────

function log(...args: unknown[]) {
  console.error("[slack-channel]", ...args);
}

const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.DEBUG) console.error("[bolt:debug]", ...args);
  },
  info: (...args: unknown[]) => console.error("[bolt:info]", ...args),
  warn: (...args: unknown[]) => console.error("[bolt:warn]", ...args),
  error: (...args: unknown[]) => console.error("[bolt:error]", ...args),
  getLevel: () => (process.env.DEBUG ? LogLevel.DEBUG : LogLevel.INFO),
  setLevel: () => {},
  setName: () => {},
};

// ── Instructions ─────────────────────────────────────────────────────

const INSTRUCTIONS = `Messages from Slack arrive as <channel source="slack" user_id="U..." user_name="..." channel_id="C..." message_ts="..." thread_ts="...">.

WORKFLOW — reply using the reply tool with channel_id. By default, reply in the channel (omit thread_ts). Only pass thread_ts if the notification includes one — that means the message came from a thread, so reply there.

If the message arrived in a thread, prior thread messages are included in the notification for context.

To acknowledge without a full reply, use the react tool (e.g., emoji "white_check_mark").

To pull context, use fetch_messages to read channel history or thread replies, list_channels to see available channels, or download_attachment to retrieve files shared in Slack.

When you read or write a file as part of your work, use share_snippet to post a preview to Slack so the user can see what you're looking at or what changed.

Attachments on inbound messages are NOT auto-downloaded. If a message includes attachments, their metadata (file_id, name, size) appears in the notification. Call download_attachment explicitly if you need the file contents.

When you finish your work, react to the original message (using message_ts as the timestamp) with "white_check_mark" to signal completion.

If someone sends "status", reply with what you're currently working on, your working directory, and a brief summary of recent activity.

You have full access to your normal tools (file read/write, bash, etc.) — you're a coding assistant reachable via Slack.`;

// ── Tool definitions ─────────────────────────────────────────────────

const TOOLS = [
  {
    name: "reply",
    description:
      "Send a message to a Slack channel or thread. Markdown is auto-converted to Slack mrkdwn. Optionally attach files.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel_id: { type: "string", description: "Slack channel ID" },
        text: { type: "string", description: "Message text (markdown)" },
        thread_ts: {
          type: "string",
          description: "Thread timestamp to reply in (optional)",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Absolute file paths to attach (max 10 files, 20MB each)",
        },
      },
      required: ["channel_id", "text"],
    },
  },
  {
    name: "react",
    description: "Add an emoji reaction to a message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel_id: { type: "string", description: "Slack channel ID" },
        timestamp: { type: "string", description: "Message timestamp" },
        emoji: {
          type: "string",
          description: "Emoji name without colons (e.g., 'eyes', 'white_check_mark')",
        },
      },
      required: ["channel_id", "timestamp", "emoji"],
    },
  },
  {
    name: "edit_message",
    description:
      "Update a previously sent bot message. Use this to replace the 'thinking' placeholder with your actual reply.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel_id: { type: "string", description: "Slack channel ID" },
        timestamp: {
          type: "string",
          description: "Timestamp of the message to edit (use pending_ts from the notification)",
        },
        text: { type: "string", description: "New message text (markdown)" },
      },
      required: ["channel_id", "timestamp", "text"],
    },
  },
  {
    name: "fetch_messages",
    description:
      "Retrieve channel history or thread replies. Use thread_ts to fetch a specific thread.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel_id: { type: "string", description: "Slack channel ID" },
        thread_ts: {
          type: "string",
          description: "Thread timestamp (omit for channel history)",
        },
        limit: {
          type: "number",
          description: "Number of messages (default 25, max 100)",
        },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "download_attachment",
    description:
      "Download a Slack file to local inbox. Returns the local file path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_id: { type: "string", description: "Slack file ID (e.g. F...)" },
      },
      required: ["file_id"],
    },
  },
  {
    name: "list_channels",
    description: "List channels the bot is a member of.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max channels to return (default 100)",
        },
      },
    },
  },
  {
    name: "share_snippet",
    description:
      "Share a code or text snippet to Slack. Use this to show the user file contents or changes you've made.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel_id: { type: "string", description: "Slack channel ID" },
        thread_ts: {
          type: "string",
          description: "Thread timestamp to post in",
        },
        content: { type: "string", description: "The code or text content" },
        filename: {
          type: "string",
          description: "Filename for syntax highlighting (e.g., 'diff.patch', 'app.ts')",
        },
        title: {
          type: "string",
          description: "Title shown above the snippet (e.g., 'Changes to server.ts')",
        },
      },
      required: ["channel_id", "content", "filename"],
    },
  },
  {
    name: "search_messages",
    description:
      "Search Slack messages. Requires a user token (xoxp-) configured as SLACK_USER_TOKEN.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        count: {
          type: "number",
          description: "Number of results (default 20)",
        },
      },
      required: ["query"],
    },
  },
];

// ── Chunking helper ──────────────────────────────────────────────────

function chunkText(
  text: string,
  limit: number,
  mode: "length" | "newline",
): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitAt = limit;
    if (mode === "newline") {
      const lastNl = remaining.lastIndexOf("\n", limit);
      if (lastNl > limit * 0.3) splitAt = lastNl + 1;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

// ── File attachment metadata ─────────────────────────────────────────

interface SlackFile {
  id: string;
  name: string;
  size: number;
  mimetype: string;
}

function formatAttachmentMeta(files: SlackFile[]): string {
  if (!files.length) return "";
  const parts = files.map(
    (f) => `${f.name} (${formatSize(f.size)}, file_id:${f.id})`,
  );
  const shown = parts.slice(0, 3).join(", ");
  const extra = files.length > 3 ? ` +${files.length - 3} more` : "";
  return `\n[Attachments: ${shown}${extra}]`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Permission verdict regex ─────────────────────────────────────────
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const env = await loadEnv();

  if (!env.botToken || !env.appToken) {
    log(
      "No tokens configured. Use /slack:configure <bot-token> <app-token> to set up.",
    );
    log("Starting MCP server without Slack connection...");
  }

  // ── MCP Server ───────────────────────────────────────────────────

  const mcp = new Server(
    { name: "villager", version: "0.0.2" },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  // ── Slack Bolt App ───────────────────────────────────────────────

  let app: App | null = null;

  if (env.botToken && env.appToken) {
    app = new App({
      token: env.botToken,
      appToken: env.appToken,
      socketMode: true,
      logger: stderrLogger as any,
    });
  }

  // Display name cache
  const nameCache = new Map<string, string>();

  async function getDisplayName(userId: string): Promise<string> {
    if (nameCache.has(userId)) return nameCache.get(userId)!;
    if (!app) return userId;
    try {
      const result = await app.client.users.info({ user: userId });
      const name =
        result.user?.profile?.display_name ||
        result.user?.real_name ||
        result.user?.name ||
        userId;
      nameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  // Track the most recent DM channel for permission relay
  let lastDmChannelId: string | null = null;

  // ── Permission relay ───────────────────────────────────────────────

  const PermissionRequestSchema = z.object({
    method: z.literal("notifications/claude/channel/permission_request"),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  });

  mcp.setNotificationHandler(
    PermissionRequestSchema,
    async ({ params }) => {
      if (!app || !lastDmChannelId) {
        log("Permission request received but no DM channel available");
        return;
      }

      const prompt =
        `*Permission request:* Claude wants to run \`${params.tool_name}\`\n` +
        `> ${params.description}\n\n` +
        `Reply \`yes ${params.request_id}\` or \`no ${params.request_id}\``;

      try {
        await app.client.chat.postMessage({
          channel: lastDmChannelId,
          text: prompt,
        });
        log(
          `Permission prompt sent to ${lastDmChannelId}: ${params.request_id}`,
        );
      } catch (err) {
        log("Failed to send permission prompt:", err);
      }
    },
  );

  // ── Thread context helper ──────────────────────────────────────────

  async function fetchThreadContext(
    channelId: string,
    threadTs: string,
    currentTs: string,
  ): Promise<string> {
    if (!app) return "";
    try {
      const result = await app.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 20,
      });
      const messages = (result.messages || []).filter(
        (m: any) => m.ts !== currentTs,
      );
      if (messages.length === 0) return "";

      const lines = await Promise.all(
        messages.map(async (m: any) => {
          const name = m.bot_id
            ? "Claude"
            : await getDisplayName(m.user || "unknown");
          return `[${name}]: ${m.text || "(no text)"}`;
        }),
      );
      return "\n\n--- Thread context ---\n" + lines.join("\n");
    } catch {
      return "";
    }
  }

  // ── Event handlers ───────────────────────────────────────────────

  async function handleMessage(
    userId: string,
    channelId: string,
    text: string,
    threadTs: string,
    messageTs: string,
    isDm: boolean,
    isMention: boolean,
    files?: SlackFile[],
  ) {
    const access = await loadAccess();
    const result = gate(userId, channelId, isDm, isMention, access);

    if (result === "blocked") return;

    if (result === "pairing") {
      if (!app) return;
      const displayName = await getDisplayName(userId);
      const code = generatePairingCode();
      addPending(access, code, userId, channelId, displayName);
      await saveAccess(access);

      await app.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Hi ${displayName}! To pair with Claude, ask the Claude Code operator to run:\n\`/slack:access pair ${code}\`\n\nThis code expires in 1 hour.`,
      });
      return;
    }

    // Track DM channel for permission relay
    if (isDm) {
      lastDmChannelId = channelId;
    }

    // Check for permission verdict before forwarding as chat
    const m = PERMISSION_REPLY_RE.exec(text);
    if (m) {
      await mcp.notification({
        method: "notifications/claude/channel/permission",
        params: {
          request_id: m[2].toLowerCase(),
          behavior: m[1].toLowerCase().startsWith("y") ? "allow" : "deny",
        },
      });
      log(`Permission verdict: ${m[1]} ${m[2]}`);

      if (app) {
        try {
          await app.client.reactions.add({
            channel: channelId,
            timestamp: messageTs,
            name: m[1].toLowerCase().startsWith("y")
              ? "white_check_mark"
              : "x",
          });
        } catch {}
      }
      return;
    }

    // ── Feature: Status reaction — acknowledge receipt ─────────────
    if (app) {
      try {
        await app.client.reactions.add({
          channel: channelId,
          timestamp: messageTs,
          name: "eyes",
        });
      } catch {}
    }

    // ── Feature: Thread context — include prior messages ───────────
    let threadContext = "";
    if (threadTs && threadTs !== messageTs) {
      threadContext = await fetchThreadContext(channelId, threadTs, messageTs);
    }

    // Build notification
    const displayName = await getDisplayName(userId);
    const attachmentMeta = files ? formatAttachmentMeta(files) : "";

    log(
      `NOTIFY: user=${displayName} channel=${channelId} text="${text.slice(0, 80)}"`,
    );

    const isInThread = threadTs !== messageTs;
    const meta: Record<string, string> = {
      user_id: userId,
      user_name: displayName,
      channel_id: channelId,
      message_ts: messageTs,
    };
    // Only include thread_ts when the message is actually in a thread
    if (isInThread) {
      meta.thread_ts = threadTs;
    }

    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: text + attachmentMeta + threadContext,
        meta,
      },
    });
    log("NOTIFY sent successfully");

  }

  if (app) {
    // DMs
    app.event("message", async ({ event }) => {
      const msg = event as any;
      if (msg.subtype) return;
      if (msg.bot_id) return;
      if (!msg.user) return;

      const isDm = msg.channel_type === "im";

      const files: SlackFile[] = (msg.files || []).map((f: any) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        mimetype: f.mimetype,
      }));

      await handleMessage(
        msg.user,
        msg.channel,
        msg.text || "",
        msg.thread_ts || msg.ts,
        msg.ts,
        isDm,
        false,
        files,
      );
    });

    // @mentions in channels
    app.event("app_mention", async ({ event }) => {
      const msg = event as any;
      if (msg.bot_id) return;

      const files: SlackFile[] = (msg.files || []).map((f: any) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        mimetype: f.mimetype,
      }));

      await handleMessage(
        msg.user,
        msg.channel,
        msg.text || "",
        msg.thread_ts || msg.ts,
        msg.ts,
        false,
        true,
        files,
      );
    });
  }

  // ── Tool handlers ────────────────────────────────────────────────

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!app) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Slack is not connected. Use /slack:configure to set tokens.",
          },
        ],
        isError: true,
      };
    }

    try {
      switch (name) {
        case "reply":
          return await toolReply(args);
        case "react":
          return await toolReact(args);
        case "edit_message":
          return await toolEditMessage(args);
        case "fetch_messages":
          return await toolFetchMessages(args);
        case "download_attachment":
          return await toolDownloadAttachment(args);
        case "list_channels":
          return await toolListChannels(args);
        case "share_snippet":
          return await toolShareSnippet(args);
        case "search_messages":
          return await toolSearchMessages(args);
        default:
          return {
            content: [
              { type: "text" as const, text: `Unknown tool: ${name}` },
            ],
            isError: true,
          };
      }
    } catch (err: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err.message || String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // ── Tool implementations ─────────────────────────────────────────

  async function toolReply(args: any) {
    const { channel_id, text, thread_ts, files: filePaths } = args;
    const access = await loadAccess();
    const limit = access.delivery.textChunkLimit || 4000;
    const mode = access.delivery.chunkMode || "newline";
    const mrkdwn = toMrkdwn(text);
    const chunks = chunkText(mrkdwn, limit, mode);

    const timestamps: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const replyTs =
        access.delivery.replyToMode === "off"
          ? undefined
          : access.delivery.replyToMode === "first"
            ? i === 0
              ? thread_ts
              : undefined
            : thread_ts;

      const result = await app!.client.chat.postMessage({
        channel: channel_id,
        text: chunks[i],
        thread_ts: replyTs,
      });
      if (result.ts) timestamps.push(result.ts);
    }

    if (filePaths && filePaths.length > 0) {
      const safeFiles = filePaths.slice(0, 10);
      for (const filePath of safeFiles) {
        assertSendable(filePath);
        const fileContent = await readFile(filePath);
        const fileName = filePath.split("/").pop() || "file";

        const fileStat = await stat(filePath);
        if (fileStat.size > 20 * 1024 * 1024) {
          throw new Error(`File too large (max 20MB): ${filePath}`);
        }

        await app!.client.files.uploadV2({
          channel_id: channel_id,
          thread_ts: thread_ts,
          file: fileContent,
          filename: fileName,
        });
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            timestamps,
            chunks: chunks.length,
          }),
        },
      ],
    };
  }

  async function toolReact(args: any) {
    const { channel_id, timestamp, emoji } = args;
    await app!.client.reactions.add({
      channel: channel_id,
      timestamp,
      name: emoji,
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    };
  }

  async function toolEditMessage(args: any) {
    const { channel_id, timestamp, text } = args;
    const mrkdwn = toMrkdwn(text);
    await app!.client.chat.update({
      channel: channel_id,
      ts: timestamp,
      text: mrkdwn,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    };
  }

  async function toolFetchMessages(args: any) {
    const { channel_id, thread_ts, limit: rawLimit } = args;
    const limit = Math.min(rawLimit || 25, 100);

    let messages: any[];
    if (thread_ts) {
      const result = await app!.client.conversations.replies({
        channel: channel_id,
        ts: thread_ts,
        limit,
      });
      messages = result.messages || [];
    } else {
      const result = await app!.client.conversations.history({
        channel: channel_id,
        limit,
      });
      messages = result.messages || [];
    }

    const formatted = messages.map((m: any) => ({
      user: m.user || m.bot_id || "unknown",
      text: m.text || "",
      ts: m.ts,
      thread_ts: m.thread_ts,
      attachments: (m.files || []).map((f: any) => ({
        file_id: f.id,
        name: f.name,
        size: f.size,
      })),
    }));

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(formatted, null, 2) },
      ],
    };
  }

  async function toolDownloadAttachment(args: any) {
    const { file_id } = args;

    const info = await app!.client.files.info({ file: file_id });
    const file = info.file;
    if (!file || !file.url_private) {
      throw new Error(`File not found or no download URL: ${file_id}`);
    }

    const rawName = file.name || file_id;
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, "_");

    const inboxDir = getInboxDir();
    await mkdir(inboxDir, { recursive: true });
    const localPath = join(inboxDir, safeName);

    const resp = await fetch(file.url_private, {
      headers: { Authorization: `Bearer ${env.botToken}` },
    });
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    await writeFile(localPath, buffer);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            path: localPath,
            name: safeName,
            size: buffer.length,
          }),
        },
      ],
    };
  }

  async function toolListChannels(args: any) {
    const limit = args?.limit || 100;
    const result = await app!.client.conversations.list({
      types: "public_channel,private_channel",
      limit,
      exclude_archived: true,
    });

    const channels = (result.channels || []).map((c: any) => ({
      id: c.id,
      name: c.name,
      topic: c.topic?.value || "",
      num_members: c.num_members,
      is_member: c.is_member,
    }));

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(channels, null, 2) },
      ],
    };
  }

  async function toolShareSnippet(args: any) {
    const { channel_id, thread_ts, content, filename, title } = args;

    assertSendable(filename);

    const fileBuffer = Buffer.from(content, "utf-8");
    await app!.client.files.uploadV2({
      channel_id,
      thread_ts,
      file: fileBuffer,
      filename: filename,
      title: title || filename,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ok: true, filename, size: fileBuffer.length }),
        },
      ],
    };
  }

  async function toolSearchMessages(args: any) {
    const { query, count } = args;

    let userToken: string | undefined;
    try {
      const raw = await readFile(ENV_FILE, "utf-8");
      const m = raw.match(/^SLACK_USER_TOKEN=(.*)$/m);
      if (m) userToken = m[1];
    } catch {}

    if (!userToken) {
      throw new Error(
        "search_messages requires a user token (SLACK_USER_TOKEN=xoxp-...) in .env. " +
          "Bot tokens cannot search. Use fetch_messages for channel/thread history instead.",
      );
    }

    const result = await app!.client.search.messages({
      token: userToken,
      query,
      count: count || 20,
    });

    const matches = (result.messages?.matches || []).map((m: any) => ({
      channel: m.channel?.name || m.channel?.id,
      user: m.user || m.username,
      text: m.text,
      ts: m.ts,
      permalink: m.permalink,
    }));

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(matches, null, 2) },
      ],
    };
  }

  // ── Pairing approval polling ─────────────────────────────────────

  let approvalInterval: ReturnType<typeof setInterval> | null = null;

  if (app) {
    approvalInterval = setInterval(async () => {
      try {
        const approvals = await pollApprovals();
        for (const { senderId, channelId } of approvals) {
          const displayName = await getDisplayName(senderId);
          await app!.client.chat.postMessage({
            channel: channelId,
            text: `${displayName}, you've been approved! I can now receive your messages. Go ahead and send me something.`,
          });
        }
      } catch {}
    }, 3000);
  }

  // ── Start ────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();

  transport.onclose = async () => {
    log("MCP transport closed, shutting down...");
    if (approvalInterval) clearInterval(approvalInterval);
    if (app) {
      try {
        await app.stop();
      } catch {}
    }
    process.exit(0);
  };

  await mcp.connect(transport);
  log("MCP server connected");

  if (app) {
    await app.start();
    log("Slack Bolt connected via Socket Mode");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
