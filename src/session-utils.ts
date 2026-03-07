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

function isLikelySessionKey(value: unknown): value is string {
  return typeof value === "string" && /^agent:[^:]+:/i.test(value.trim());
}

export function resolveSessionContextFromCommandCtx(
  ctx: SaveCommandCtx,
  sessionStore: Record<string, SessionStoreEntry>,
): ResolvedSessionContext {
  const explicitAgentId = (typeof ctx.agentId === "string" && ctx.agentId.trim()) ? ctx.agentId.trim() : undefined;
  const keyCandidates: string[] = [];
  for (const candidate of [ctx.sessionKey, ctx.to, ctx.from]) {
    if (isLikelySessionKey(candidate)) keyCandidates.push(candidate.trim());
  }

  const resolvedSessionKey = keyCandidates
    .map(k => normalizeSessionKey(k))
    .find((k): k is string => Boolean(k));

  const inferredAgentId = parseAgentIdFromSessionKey(resolvedSessionKey);
  const agentId = explicitAgentId || inferredAgentId || "main";
  const byKey = getSessionIdByKey(sessionStore, resolvedSessionKey);
  const byCtxSessionId = typeof ctx.sessionId === "string" && ctx.sessionId.trim() ? ctx.sessionId.trim() : undefined;

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
