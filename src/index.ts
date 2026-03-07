/**
 * Memory LanceDB Lite Plugin
 * Streamlined, security-hardened LanceDB-backed long-term memory
 * with hybrid retrieval and multi-scope isolation.
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";

import { MemoryStore } from "./store.js";
import { createEmbedder, getVectorDimensions } from "./embedder.js";
import { createRetriever } from "./retriever.js";
import OpenAI from "openai";
import { createScopeManager } from "./scopes.js";
import { shouldSkipRetrieval } from "./adaptive-retrieval.js";
import { isNoise } from "./noise-filter.js";
import {
    type SaveCommandCtx,
    type SessionStoreEntry,
    getEphemeralHandoverPath,
    getSessionKeyForHandoverWrite,
    normalizeSessionKey,
    normalizeSessionStore,
    parseJsonOrDefaultObject,
    readTailUtf8,
    resolveSessionContextFromCommandCtx,
    resolveSessionFileName,
} from "./session-utils.js";

// ============================================================================
// Configuration Types
// ============================================================================

interface PluginConfig {
    embedding: {
        provider: "openai-compatible";
        apiKey: string;
        model?: string;
        baseURL?: string;
        dimensions?: number;
        taskQuery?: string;
        taskPassage?: string;
        normalized?: boolean;
    };
    dbPath?: string;
    autoCapture?: boolean;
    autoRecall?: boolean;
    autoRecallMinLength?: number;
    captureAssistant?: boolean;
    retrieval?: {
        mode?: "hybrid" | "vector";
        vectorWeight?: number;
        bm25Weight?: number;
        minScore?: number;
        rerank?: "cross-encoder" | "lightweight" | "none";
        candidatePoolSize?: number;
        rerankApiKey?: string;
        rerankModel?: string;
        rerankEndpoint?: string;
        rerankProvider?: "jina" | "siliconflow" | "voyage" | "pinecone";
        recencyHalfLifeDays?: number;
        recencyWeight?: number;
        filterNoise?: boolean;
        lengthNormAnchor?: number;
        hardMinScore?: number;
        timeDecayHalfLifeDays?: number;
    };
    scopes?: {
        default?: string;
        definitions?: Record<string, { description: string }>;
        agentAccess?: Record<string, string[]>;
    };
    enableManagementTools?: boolean;
    sessionMemory?: { enabled?: boolean; messageCount?: number };
    summarizer?: {
        apiKey?: string;
        model?: string;
        baseURL?: string;
    };
}

interface PromptMessage {
    role?: string;
    content?: unknown;
}

interface PromptBuildEvent {
    messages?: PromptMessage[];
    agentId?: string;
}

interface PromptBuildContext {
    sessionId?: string;
    sessionKey?: string;
}

interface OpenClawLogger {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}

interface OpenClawApi {
    config: {
        plugins: {
            entries: Record<string, { config?: unknown }>;
        };
        gateway?: {
            auth?: {
                token?: string;
            };
        };
    };
    logger: OpenClawLogger;
    on: (
        event: string,
        handler: (event: PromptBuildEvent, ctx?: PromptBuildContext) => Promise<{ prependContext: string } | void> | { prependContext: string } | void
    ) => void;
    registerCommand: (command: {
        name: string;
        description: string;
        handler: (ctx: SaveCommandCtx) => Promise<{ text: string }>;
    }) => void;
    registerService: (service: {
        id: string;
        start: () => Promise<void>;
        stop: () => void;
    }) => void;
}

// ============================================================================
// Utility Functions
// ============================================================================

function getDefaultDbPath(): string {
    return join(homedir(), ".openclaw", "memory", "lancedb-lite");
}

const SAVE_MAX_SESSION_TAIL_BYTES = 512 * 1024;
const SAVE_MAX_SUMMARY_MESSAGES = 100;

function parsePositiveInt(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    if (typeof value === "string") {
        const n = Number(value.trim());
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    return undefined;
}

function extractMessageText(content: unknown): string {
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
        const parts = content
            .map((part: unknown) => {
                if (typeof part === "string") return part;
                if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
                    return (part as { text: string }).text;
                }
                return "";
            })
            .filter(Boolean);
        return parts.join("\n").trim();
    }
    return "";
}

// ============================================================================
// Main Plugin Definition
// ============================================================================

export const memoryLanceDBLitePlugin = {
    meta: {
        id: "memory-lancedb-lite",
        name: "Memory (LanceDB Lite)",
        version: "1.1.7",
        description: "Streamlined LanceDB-backed long-term memory",
        author: "OpenClaw Team",
        license: "MIT",
    },
    register: async (api: OpenClawApi) => {
        api.logger.info("memory-lancedb-lite: loaded (v1.1.7)");
        const OPENCLAW_DIR = join(homedir(), ".openclaw");
        const config = parsePluginConfig(api.config.plugins.entries["memory-lancedb-lite"]?.config);

        const dbPath = config.dbPath || getDefaultDbPath();
        const embeddingConfig = {
            ...config.embedding,
            model: config.embedding.model || "text-embedding-3-small",
        };
        const embedder = createEmbedder(embeddingConfig);
        const dims = getVectorDimensions(embeddingConfig.model, embeddingConfig.dimensions);
        const store = new MemoryStore({ dbPath, vectorDim: dims, logger: api.logger });
        const retriever = createRetriever(store, embedder, config.retrieval, api.logger);
        const scopeManager = createScopeManager(config.scopes);
        const recentlyCaptured = new Map<string, number>();

        if (config.enableManagementTools) {
            const { registerAllMemoryTools } = await import("./tools.js");
            registerAllMemoryTools(api as any, {
                retriever, store, scopeManager, embedder,
            }, { enableManagementTools: true });
        }

        // Adaptive Retrieval Hook
        if (config.autoRecall) {
            api.on(
                "before_prompt_build",
                async (event: PromptBuildEvent, ctx?: PromptBuildContext) => {
                    if (ctx?.sessionId?.includes("slug-gen") || ctx?.sessionId?.includes("slug-generator")) return;
                    if (!event.messages?.length) return;
                    const message = event.messages[event.messages.length - 1];
                    if (!message || message.role !== "user") return;

                    const query = typeof message.content === "string" ? message.content : "";
                    if (query.length < (config.autoRecallMinLength || 15)) return;

                    if (shouldSkipRetrieval(query)) {
                        api.logger.debug("memory-lancedb-lite: auto-recall skipped (adaptive filter)");
                        return;
                    }

                    const scopeFilter = scopeManager.getAccessibleScopes(event.agentId);
                    const results = await retriever.retrieve({ query, limit: 3, scopeFilter });

                    if (results.length > 0) {
                        const memories = results.map((r) => r.entry.text).join("\n---\n");
                        const injection = `\n<relevant-memories>\n${memories}\n</relevant-memories>\n`;
                        api.logger.info(`memory-lancedb-lite: auto-recalled ${results.length} memories`);
                        return { prependContext: injection };
                    }
                }
            );
        }

        // Auto-capture Hook (v1): capture user messages (and optional assistant messages).
        if (config.autoCapture !== false) {
            api.on(
                "before_prompt_build",
                async (event: PromptBuildEvent, ctx?: PromptBuildContext) => {
                    if (ctx?.sessionId?.includes("slug-gen") || ctx?.sessionId?.includes("slug-generator")) return;
                    if (!event?.messages?.length) return;
                    const message = event.messages[event.messages.length - 1];
                    if (!message) return;
                    const role = String(message.role || "");
                    const allowAssistantCapture = config.captureAssistant === true;
                    if (role !== "user" && !(allowAssistantCapture && role === "assistant")) return;

                    const text = extractMessageText(message.content);
                    if (!text) return;
                    if (isNoise(text)) return;
                    if (role === "assistant" && text.length < 20) return;
                    if (shouldSkipRetrieval(text, 10)) return;

                    const dedupeKey = createHash("sha256")
                        .update(`${ctx?.sessionId || "unknown"}:${event?.agentId || "unknown"}:${role}:${text}`)
                        .digest("hex")
                        .slice(0, 24);
                    const now = Date.now();
                    const lastCapturedAt = recentlyCaptured.get(dedupeKey) || 0;
                    if (now - lastCapturedAt < 60_000) return;

                    const targetScope = scopeManager.getDefaultScope(event.agentId);
                    const scopeFilter = [targetScope];

                    try {
                        const vector = await embedder.embedPassage(text);
                        const existing = await store.vectorSearch(vector, 1, 0.1, scopeFilter);
                        if (existing.length > 0 && existing[0].score > 0.98) {
                            return;
                        }

                        await store.store({
                            text,
                            vector,
                            category: "other",
                            importance: role === "assistant" ? 0.6 : 0.7,
                            scope: targetScope,
                        });
                        recentlyCaptured.set(dedupeKey, now);

                        if (recentlyCaptured.size > 2000) {
                            for (const [k, ts] of recentlyCaptured.entries()) {
                                if (now - ts > 3_600_000) recentlyCaptured.delete(k);
                            }
                        }

                        api.logger.debug(`memory-lancedb-lite: auto-captured 1 ${role} memory`);
                    } catch (err) {
                        api.logger.warn(`memory-lancedb-lite: auto-capture skipped due to error: ${String(err)}`);
                    }
                }
            );
        }

        // Session Memory Logic
        if (config.sessionMemory?.enabled) {
            // /handoff Command
            api.registerCommand({
                name: "save",
                description: "Manually trigger session summarization and ephemeral handover",
                handler: async (ctx: SaveCommandCtx) => {
                    api.logger.info("save-command: /save triggered, starting handover...");
                    try {
                        const rawSessions = await readFile(join(OPENCLAW_DIR, "agents", "main", "sessions", "sessions.json"), "utf8")
                            .catch(() => "{}");
                        const mainSessionStore = normalizeSessionStore(parseJsonOrDefaultObject(rawSessions));
                        const resolvedFromMain = resolveSessionContextFromCommandCtx(ctx, mainSessionStore);

                        const agentId = resolvedFromMain.agentId;
                        const sessionsDir = join(OPENCLAW_DIR, "agents", agentId, "sessions");
                        let sessionStore: Record<string, SessionStoreEntry> = {};
                        try {
                            const sessionsMapStr = await readFile(join(sessionsDir, "sessions.json"), "utf8").catch(() => "{}");
                            sessionStore = normalizeSessionStore(parseJsonOrDefaultObject(sessionsMapStr));
                        } catch { }
                        const resolved = resolveSessionContextFromCommandCtx(ctx, sessionStore);
                        const resolvedSessionId = resolved.sessionId || resolvedFromMain.sessionId;
                        if (!resolvedSessionId) {
                            throw new Error("Unable to resolve current session ID from command context; refuse fallback for safety.");
                        }
                        const targetFileName = await resolveSessionFileName(sessionsDir, resolvedSessionId);

                        if (!targetFileName) throw new Error(`No session file found for resolved session ID: ${resolvedSessionId}`);

                        const filePath = join(sessionsDir, targetFileName);
                        const content = await readTailUtf8(filePath, SAVE_MAX_SESSION_TAIL_BYTES);
                        const allLines = content.split("\n").filter(l => l.trim());
                        
                        // 1. 提取最後一個交接標籤 (從全量日誌中找，避免長對話遺失)
                        let previousHandoff = "";
                        const handoffRegex = /<previous-session-handoff>([\s\S]*?)<\/previous-session-handoff>/g;
                        let match;
                        while ((match = handoffRegex.exec(content)) !== null) {
                            previousHandoff = match[1].trim();
                        }

                        // 2. 獲取最近對話 (排除標籤干擾，只取原始對話)
                        const messages = allLines
                            .map(l => {
                                try {
                                    const e = JSON.parse(l);
                                    if (e.type !== "message") return null;
                                    let text = typeof e.message.content === "string" ? e.message.content : JSON.stringify(e.message.content);
                                    // 清理掉內容中的標籤以便純淨歸納
                                    text = text.replace(/<previous-session-handoff>[\s\S]*?<\/previous-session-handoff>/g, "").trim();
                                    return { role: e.message.role, content: text };
                                } catch { return null; }
                            })
                            .filter(e => e !== null);

                        const configuredMessageCount = parsePositiveInt(config.sessionMemory?.messageCount) || 15;
                        const recentMessages = messages.slice(-Math.min(configuredMessageCount, SAVE_MAX_SUMMARY_MESSAGES));

                        if (recentMessages.length === 0 && !previousHandoff) throw new Error("No conversation history found to save.");

                        // Summarize — pick correct API key based on target
                        let summarizerBaseURL = config.summarizer?.baseURL || "https://openrouter.ai/api/v1";
                        const isLocalGateway = summarizerBaseURL.includes("127.0.0.1:18789") || summarizerBaseURL.includes("localhost:18789");

                        let summarizerApiKey: string | undefined = config.summarizer?.apiKey;
                        if (!summarizerApiKey && isLocalGateway) {
                            // Try to resolve the gateway auth token
                            summarizerApiKey = process.env.OPENCLAW_GATEWAY_TOKEN;
                            if (!summarizerApiKey) {
                                // Read raw token from config (may be resolved by gateway internals)
                                const rawToken = api.config?.gateway?.auth?.token;
                                if (rawToken && !rawToken.startsWith("${")) {
                                    summarizerApiKey = rawToken;
                                }
                            }
                            if (!summarizerApiKey) {
                                // Fall back to OpenRouter if we can't authenticate with local gateway
                                api.logger.warn("save-command: can't resolve gateway token, falling back to OpenRouter for summarization");
                                summarizerBaseURL = "https://openrouter.ai/api/v1";
                                summarizerApiKey = process.env.OPENROUTER_API_KEY;
                            }
                        }
                        if (!summarizerApiKey) {
                            summarizerApiKey = process.env.OPENROUTER_API_KEY || "local_dummy_key";
                        }

                        const summarizer = new OpenAI({
                            apiKey: summarizerApiKey,
                            baseURL: summarizerBaseURL
                        });

                        const prompt = `You are a context synthesizer. Update the "State Fragment" for an agent handover.
                                      PREVIOUS STATE: ${previousHandoff || "None"}
                                      NEW MESSAGES: ${JSON.stringify(recentMessages)}
                                      
                                      TASK:
                                      1. Merge the previous state with new information.
                                      2. REMOVE facts that are likely already stored in long-term memory (like names or permanent preferences).
                                      3. KEEP active task status, pending plans, behavioral constraints, and temporary secrets.
                                      4. Output ONLY the new State Fragment in Traditional Chinese.`;

                        const response = await summarizer.chat.completions.create({
                            model: config.summarizer?.model || "gpt-4o-mini",
                            messages: [{ role: "user", content: prompt }]
                        });

                        const summary = (response.choices[0]?.message?.content || "").trim();
                        if (!summary) {
                            throw new Error("Summarizer returned empty handover context.");
                        }
                        const effectiveSessionKey = getSessionKeyForHandoverWrite(ctx, agentId);
                        const ephemeralPath = getEphemeralHandoverPath(OPENCLAW_DIR, effectiveSessionKey);
                        await mkdir(dirname(ephemeralPath), { recursive: true });
                        await writeFile(ephemeralPath, JSON.stringify({
                            date: new Date().toISOString(),
                            sessionKey: effectiveSessionKey,
                            context: summary
                        }));

                        api.logger.info("save-command: successfully saved ephemeral handover");
                        const preview = summary.length > 60 ? summary.slice(0, 60).replace(/\n/g, " ") + "..." : summary.replace(/\n/g, " ");
                        return { text: `✅ 交接儲存成功！\n\n**存檔摘要：**\n> ${preview}\n\n下一對話將自動載入此語境。` };
                    } catch (err) {
                        api.logger.error(`save-command failed: ${String(err)}`);
                        return { text: `❌ 交接失敗：${String(err)}` };
                    }
                }
            });

            // Handover Injection Hook
            api.on(
                "before_prompt_build",
                async (_event: PromptBuildEvent, ctx?: PromptBuildContext) => {
                    if (ctx?.sessionId?.includes("slug-gen") || ctx?.sessionId?.includes("slug-generator")) return;
                    const sessionKey = normalizeSessionKey(ctx?.sessionKey);
                    if (!sessionKey) return;
                    const ephemeralPath = getEphemeralHandoverPath(OPENCLAW_DIR, sessionKey);
                    const consumePath = `${ephemeralPath}.consume-${randomUUID()}`;
                    try {
                        await rename(ephemeralPath, consumePath);
                        const content = await readFile(consumePath, "utf-8");
                        const data = JSON.parse(content);
                        if (data?.context) {
                            api.logger.info("ephemeral-injection: injecting handover context");
                            const injection = `\n<previous-session-handoff>\n${data.context}\n</previous-session-handoff>\n`;
                            await unlink(consumePath).catch(() => { });
                            return { prependContext: injection };
                        }
                        await unlink(consumePath).catch(() => { });
                    } catch (e: unknown) {
                        if (!(e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "ENOENT")) {
                            api.logger.error(`ephemeral-injection error: ${String(e)}`);
                        }
                        await unlink(consumePath).catch(() => { });
                    }
                }
            );
        }

        api.registerService({
            id: "memory-lancedb-lite",
            start: async () => {
                api.logger.info("memory-lancedb-lite: service started");
            },
            stop: () => {
                api.logger.info("memory-lancedb-lite: service stopped");
            }
        });
    }
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getString(value: unknown, field: string, required = false): string | undefined {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (required) throw new Error(`Invalid config: ${field} must be a non-empty string`);
    return undefined;
}

function getBoolean(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value;
    return undefined;
}

function getNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return undefined;
}

function parsePluginConfig(value: unknown): PluginConfig {
    if (!isPlainObject(value)) {
        throw new Error("Invalid config: memory-lancedb-lite config must be an object");
    }

    const embeddingRaw = value.embedding;
    if (!isPlainObject(embeddingRaw)) {
        throw new Error("Invalid config: embedding is required");
    }

    const provider = getString(embeddingRaw.provider, "embedding.provider", true);
    if (provider !== "openai-compatible") {
        throw new Error(`Invalid config: embedding.provider must be \"openai-compatible\" (got ${provider})`);
    }

    const embedding: PluginConfig["embedding"] = {
        provider: "openai-compatible",
        apiKey: getString(embeddingRaw.apiKey, "embedding.apiKey", true)!,
        model: getString(embeddingRaw.model, "embedding.model") || "text-embedding-3-small",
        baseURL: getString(embeddingRaw.baseURL, "embedding.baseURL"),
        dimensions: getNumber(embeddingRaw.dimensions),
        taskQuery: getString(embeddingRaw.taskQuery, "embedding.taskQuery"),
        taskPassage: getString(embeddingRaw.taskPassage, "embedding.taskPassage"),
        normalized: getBoolean(embeddingRaw.normalized),
    };

    const retrievalRaw = isPlainObject(value.retrieval) ? value.retrieval : {};
    const retrieval: PluginConfig["retrieval"] = {
        mode: retrievalRaw.mode === "vector" ? "vector" : retrievalRaw.mode === "hybrid" ? "hybrid" : undefined,
        vectorWeight: getNumber(retrievalRaw.vectorWeight),
        bm25Weight: getNumber(retrievalRaw.bm25Weight),
        minScore: getNumber(retrievalRaw.minScore),
        rerank: retrievalRaw.rerank === "none" || retrievalRaw.rerank === "lightweight" || retrievalRaw.rerank === "cross-encoder"
            ? retrievalRaw.rerank
            : undefined,
        candidatePoolSize: getNumber(retrievalRaw.candidatePoolSize),
        rerankApiKey: getString(retrievalRaw.rerankApiKey, "retrieval.rerankApiKey"),
        rerankModel: getString(retrievalRaw.rerankModel, "retrieval.rerankModel"),
        rerankEndpoint: getString(retrievalRaw.rerankEndpoint, "retrieval.rerankEndpoint"),
        rerankProvider: retrievalRaw.rerankProvider === "jina" || retrievalRaw.rerankProvider === "siliconflow" || retrievalRaw.rerankProvider === "voyage" || retrievalRaw.rerankProvider === "pinecone"
            ? retrievalRaw.rerankProvider
            : undefined,
        recencyHalfLifeDays: getNumber(retrievalRaw.recencyHalfLifeDays),
        recencyWeight: getNumber(retrievalRaw.recencyWeight),
        filterNoise: getBoolean(retrievalRaw.filterNoise),
        lengthNormAnchor: getNumber(retrievalRaw.lengthNormAnchor),
        hardMinScore: getNumber(retrievalRaw.hardMinScore),
        timeDecayHalfLifeDays: getNumber(retrievalRaw.timeDecayHalfLifeDays),
    };

    const sessionMemoryRaw = isPlainObject(value.sessionMemory) ? value.sessionMemory : {};
    const summarizerRaw = isPlainObject(value.summarizer) ? value.summarizer : {};

    return {
        embedding,
        dbPath: getString(value.dbPath, "dbPath"),
        autoCapture: getBoolean(value.autoCapture),
        autoRecall: getBoolean(value.autoRecall),
        autoRecallMinLength: getNumber(value.autoRecallMinLength),
        captureAssistant: getBoolean(value.captureAssistant),
        retrieval,
        scopes: isPlainObject(value.scopes) ? value.scopes as PluginConfig["scopes"] : undefined,
        enableManagementTools: getBoolean(value.enableManagementTools),
        sessionMemory: {
            enabled: getBoolean(sessionMemoryRaw.enabled),
            messageCount: getNumber(sessionMemoryRaw.messageCount),
        },
        summarizer: {
            apiKey: getString(summarizerRaw.apiKey, "summarizer.apiKey"),
            model: getString(summarizerRaw.model, "summarizer.model"),
            baseURL: getString(summarizerRaw.baseURL, "summarizer.baseURL"),
        },
    };
}

export default memoryLanceDBLitePlugin;
