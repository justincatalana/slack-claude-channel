import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const STATE_DIR = join(homedir(), ".claude", "channels", "slack");
const STATE_FILE = join(STATE_DIR, "access.json");
const APPROVED_DIR = join(STATE_DIR, "approved");

export interface ChannelConfig {
  requireMention: boolean;
  allowFrom: string[];
}

export interface PendingPairing {
  senderId: string;
  channelId: string;
  displayName: string;
  createdAt: number;
  expiresAt: number;
}

export interface DeliveryConfig {
  ackReaction?: string;
  replyToMode?: "first" | "all" | "off";
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
}

export interface AccessState {
  dmPolicy: "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  channels: Record<string, ChannelConfig>;
  pending: Record<string, PendingPairing>;
  delivery: DeliveryConfig;
}

function defaults(): AccessState {
  return {
    dmPolicy: "pairing",
    allowFrom: [],
    channels: {},
    pending: {},
    delivery: {},
  };
}

export async function loadAccess(): Promise<AccessState> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...defaults(), ...parsed };
  } catch {
    return defaults();
  }
}

export async function saveAccess(state: AccessState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

export type GateResult = "allowed" | "pairing" | "blocked";

export function gate(
  userId: string,
  channelId: string,
  isDm: boolean,
  isMention: boolean,
  access: AccessState,
): GateResult {
  if (isDm) {
    if (access.dmPolicy === "disabled") return "blocked";
    if (access.allowFrom.includes(userId)) return "allowed";
    if (access.dmPolicy === "allowlist") return "blocked";
    // dmPolicy === "pairing"
    return "pairing";
  }

  // Channel message
  const chanCfg = access.channels[channelId];
  if (!chanCfg) return "blocked"; // channels are opt-in

  if (chanCfg.requireMention && !isMention) return "blocked";

  // Per-channel allowFrom (empty = anyone in channel is allowed)
  if (chanCfg.allowFrom.length > 0 && !chanCfg.allowFrom.includes(userId)) {
    return "blocked";
  }

  return "allowed";
}

export function generatePairingCode(): string {
  return randomBytes(3).toString("hex"); // 6-char hex
}

const MAX_PENDING = 3;
const PAIRING_TTL_MS = 60 * 60 * 1000; // 1 hour

export function addPending(
  state: AccessState,
  code: string,
  senderId: string,
  channelId: string,
  displayName: string,
): void {
  // Expire old entries
  const now = Date.now();
  for (const [k, v] of Object.entries(state.pending)) {
    if (v.expiresAt < now) delete state.pending[k];
  }

  // Enforce max pending
  const keys = Object.keys(state.pending);
  if (keys.length >= MAX_PENDING) {
    delete state.pending[keys[0]];
  }

  state.pending[code] = {
    senderId,
    channelId,
    displayName,
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
  };
}

export function approvePairing(
  state: AccessState,
  code: string,
): PendingPairing | null {
  const pending = state.pending[code];
  if (!pending) return null;
  if (pending.expiresAt < Date.now()) {
    delete state.pending[code];
    return null;
  }

  // Add to allowlist
  if (!state.allowFrom.includes(pending.senderId)) {
    state.allowFrom.push(pending.senderId);
  }

  const result = { ...pending };
  delete state.pending[code];
  return result;
}

export function denyPairing(
  state: AccessState,
  code: string,
): PendingPairing | null {
  const pending = state.pending[code];
  if (!pending) return null;
  const result = { ...pending };
  delete state.pending[code];
  return result;
}

export function addToAllowlist(state: AccessState, userId: string): boolean {
  if (state.allowFrom.includes(userId)) return false;
  state.allowFrom.push(userId);
  return true;
}

export function removeFromAllowlist(
  state: AccessState,
  userId: string,
): boolean {
  const idx = state.allowFrom.indexOf(userId);
  if (idx === -1) return false;
  state.allowFrom.splice(idx, 1);
  return true;
}

export async function writeApproval(
  senderId: string,
  channelId: string,
): Promise<void> {
  await mkdir(APPROVED_DIR, { recursive: true });
  await writeFile(join(APPROVED_DIR, senderId), channelId);
}

export async function pollApprovals(): Promise<
  Array<{ senderId: string; channelId: string }>
> {
  try {
    const files = await readdir(APPROVED_DIR);
    const results: Array<{ senderId: string; channelId: string }> = [];
    for (const senderId of files) {
      const filePath = join(APPROVED_DIR, senderId);
      const channelId = await readFile(filePath, "utf-8");
      results.push({ senderId, channelId: channelId.trim() });
      await unlink(filePath);
    }
    return results;
  } catch {
    return [];
  }
}

export function assertSendable(filePath: string): void {
  const resolved = resolve(filePath);
  const stateResolved = resolve(STATE_DIR);
  if (resolved.startsWith(stateResolved + "/") || resolved === stateResolved) {
    throw new Error(
      `Refusing to send file under state directory: ${resolved}`,
    );
  }
}

export function getStateDir(): string {
  return STATE_DIR;
}

export function getInboxDir(): string {
  return join(STATE_DIR, "inbox");
}
