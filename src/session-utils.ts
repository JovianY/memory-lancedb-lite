import { createHash } from "node:crypto";
import { readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";

export type SessionStoreEntry = {
  id?: string;
  sessionId?: string;
};

export type SaveCommandCtx = {
  channel?: string;
  from?: string;
  to?: string;
  args?: string;
  commandBody?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
};

export type ResolvedSessionContext = {
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
};

export function normalizeSessionKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase();
}

export function parseAgentIdFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const m = /^agent:([^:]+):/i.exec(sessionKey.trim());
  return m?.[1] || undefined;
}

export function normalizeSessionStore(raw: unknown): Record<string, SessionStoreEntry> {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const sessions = (obj.sessions && typeof obj.sessions === "object")
    ? obj.sessions as Record<string, unknown>
    : obj;
  const out: Record<string, SessionStoreEntry> = {};
  for (const [k, v] of Object.entries(sessions)) {
    if (!v || typeof v !== "object") continue;
    out[normalizeSessionKey(k) || k] = v as SessionStoreEntry;
  }
  return out;
}

export function parseJsonOrDefaultObject(raw: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch { }
  return fallback;
}

function getSessionIdByKey(store: Record<string, SessionStoreEntry>, key?: string): string | undefined {
  const normalized = normalizeSessionKey(key);
  if (!normalized) return undefined;
  const entry = store[normalized];
  if (!entry) return undefined;
  const id = entry.id || entry.sessionId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function getSessionKeyBySessionId(store: Record<string, SessionStoreEntry>, sessionId?: string): string | undefined {
  if (typeof sessionId !== "string" || !sessionId.trim()) return undefined;
  const target = sessionId.trim();
  for (const [key, entry] of Object.entries(store)) {
    const id = entry?.id || entry?.sessionId;
    if (typeof id === "string" && id.trim() === target) return key;
  }
  return undefined;
}

function isLikelySessionKey(value: unknown): value is string {
  return typeof value === "string" && /^agent:[^:]+:/i.test(value.trim());
}

function pushUnique(arr: string[], value?: string): void {
  const normalized = normalizeSessionKey(value);
  if (!normalized) return;
  if (!arr.includes(normalized)) arr.push(normalized);
}

function inferSessionKeyCandidates(ctx: SaveCommandCtx, agentIdHint: string): string[] {
  const out: string[] = [];
  const channel = typeof ctx.channel === "string" ? ctx.channel.trim().toLowerCase() : "";
  if (!channel) return out;

  const rawTargets = [ctx.to, ctx.from]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);

  const targetTokens = new Set<string>();
  for (const raw of rawTargets) {
    targetTokens.add(raw);
    const unwrapped = raw.replace(/[<>\s]/g, "");
    if (unwrapped) targetTokens.add(unwrapped);
    if (unwrapped.includes(":")) {
      const tail = unwrapped.split(":").filter(Boolean).pop();
      if (tail) targetTokens.add(tail);
    }
    for (const m of unwrapped.matchAll(/[0-9]{6,}/g)) {
      if (m[0]) targetTokens.add(m[0]);
    }
  }

  for (const target of targetTokens) {
    if (isLikelySessionKey(target)) {
      pushUnique(out, target);
      continue;
    }
    // Legacy command ctx often exposes plain channel/user id in `to`/`from`.
    pushUnique(out, `agent:${agentIdHint}:${channel}:channel:${target}`);
    pushUnique(out, `agent:${agentIdHint}:${channel}:user:${target}`);
    pushUnique(out, `agent:${agentIdHint}:${channel}:${target}`);
  }
  return out;
}

export function resolveSessionContextFromCommandCtx(
  ctx: SaveCommandCtx,
  sessionStore: Record<string, SessionStoreEntry>,
): ResolvedSessionContext {
  const explicitAgentId = (typeof ctx.agentId === "string" && ctx.agentId.trim()) ? ctx.agentId.trim() : undefined;
  const keyCandidates: string[] = [];
  for (const candidate of [ctx.sessionKey, ctx.to, ctx.from]) {
    if (isLikelySessionKey(candidate)) pushUnique(keyCandidates, candidate);
  }

  const inferredAgentId = parseAgentIdFromSessionKey(keyCandidates[0]);
  const agentIdHint = explicitAgentId || inferredAgentId || "main";
  for (const candidate of inferSessionKeyCandidates(ctx, agentIdHint)) {
    pushUnique(keyCandidates, candidate);
  }

  let resolvedSessionKey: string | undefined = keyCandidates[0];
  let byKey: string | undefined;
  for (const candidate of keyCandidates) {
    const hit = getSessionIdByKey(sessionStore, candidate);
    if (hit) {
      resolvedSessionKey = candidate;
      byKey = hit;
      break;
    }
  }

  const resolvedAgentId = parseAgentIdFromSessionKey(resolvedSessionKey);
  const agentId = explicitAgentId || resolvedAgentId || "main";
  const byCtxSessionId = typeof ctx.sessionId === "string" && ctx.sessionId.trim() ? ctx.sessionId.trim() : undefined;
  const keyBySessionId = !resolvedSessionKey ? getSessionKeyBySessionId(sessionStore, byCtxSessionId) : undefined;
  if (keyBySessionId) {
    resolvedSessionKey = keyBySessionId;
  }

  return {
    agentId,
    sessionKey: resolvedSessionKey,
    sessionId: byKey || byCtxSessionId,
  };
}

function isValidSessionJsonlFile(name: string): boolean {
  return (
    name.endsWith(".jsonl") &&
    !name.startsWith("test") &&
    !name.includes("sessions.json") &&
    !name.includes(".deleted.") &&
    !name.includes(".reset.") &&
    !name.includes(".tmp")
  );
}

export async function resolveSessionFileName(
  sessionsDir: string,
  sessionId: string,
): Promise<string | undefined> {
  const exact = `${sessionId}.jsonl`;
  try {
    await stat(join(sessionsDir, exact));
    return exact;
  } catch { }

  const files = await readdir(sessionsDir).catch(() => []);
  const prefixed = (await Promise.all(
    files
      .filter((f) => isValidSessionJsonlFile(f) && f.startsWith(`${sessionId}-`))
      .map(async (f) => {
        try {
          return { name: f, mtime: (await stat(join(sessionsDir, f))).mtimeMs };
        } catch {
          return null;
        }
      })
  ))
    .filter((x): x is { name: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);
  return prefixed[0]?.name;
}

export async function readTailUtf8(filePath: string, maxBytes: number): Promise<string> {
  const fh = await open(filePath, "r");
  try {
    const info = await fh.stat();
    const safeBytes = Math.max(1024, Math.floor(maxBytes));
    const size = info.size;
    const start = Math.max(0, size - safeBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      await fh.read(buffer, 0, length, start);
    }
    return buffer.toString("utf8");
  } finally {
    await fh.close();
  }
}

export function getEphemeralHandoverPath(baseOpenClawDir: string, sessionKey: string): string {
  const key = normalizeSessionKey(sessionKey) || sessionKey;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return join(baseOpenClawDir, "memory", "lancedb-lite", "ephemeral_handover", `${hash}.json`);
}

export function getSessionKeyForHandoverWrite(ctx: SaveCommandCtx, fallbackAgentId: string): string {
  if (isLikelySessionKey(ctx.sessionKey)) return normalizeSessionKey(ctx.sessionKey)!;
  if (isLikelySessionKey(ctx.to)) return normalizeSessionKey(ctx.to)!;
  if (isLikelySessionKey(ctx.from)) return normalizeSessionKey(ctx.from)!;
  return `agent:${fallbackAgentId}:main`;
}
