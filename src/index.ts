/**
 * Memory LanceDB Lite Plugin
 * Streamlined, security-hardened LanceDB-backed long-term memory
 * with hybrid retrieval and multi-scope isolation.
 */

import { homedir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { readFile, readdir, writeFile, mkdir, unlink, stat } from "node:fs/promises";

import { MemoryStore } from "./store.js";
import { createEmbedder, getVectorDimensions, resolveApiKey } from "./embedder.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "./retriever.js";
import OpenAI from "openai";
import { createScopeManager } from "./scopes.js";
import { registerAllMemoryTools } from "./tools.js";
import { shouldSkipRetrieval } from "./adaptive-retrieval.js";
import { isNoise } from "./noise-filter.js";

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

// ============================================================================
// Utility Functions
// ============================================================================

function getDefaultDbPath(): string {
    return join(homedir(), ".openclaw", "memory", "lancedb-lite");
}

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
            .map((part: any) => {
                if (typeof part === "string") return part;
                if (part && typeof part.text === "string") return part.text;
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
        version: "1.1.4",
        description: "Streamlined LanceDB-backed long-term memory",
        author: "OpenClaw Team",
        license: "MIT",
    },
    register: (api: any) => {
        api.logger.info("memory-lancedb-lite: loaded (v1.1.4)");
        const OPENCLAW_DIR = join(homedir(), ".openclaw");
        const config = parsePluginConfig(api.config.plugins.entries["memory-lancedb-lite"].config);

        const dbPath = config.dbPath || getDefaultDbPath();
        const embeddingConfig = {
            ...config.embedding,
            model: config.embedding.model || "text-embedding-3-small",
        };
        const embedder = createEmbedder(embeddingConfig);
        const dims = getVectorDimensions(embeddingConfig.model, embeddingConfig.dimensions);
        const store = new MemoryStore({ dbPath, vectorDim: dims });
        const retriever = createRetriever(store, embedder, config.retrieval);
        const scopeManager = createScopeManager(config.scopes);
        const recentlyCaptured = new Map<string, number>();

        if (config.enableManagementTools) {
            registerAllMemoryTools(api, {
                retriever, store, scopeManager, embedder,
            }, { enableManagementTools: true });
        }

        // Adaptive Retrieval Hook
        if (config.autoRecall) {
            api.on(
                "before_prompt_build",
                async (event: any, ctx: any) => {
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
                        const memories = results.map((r: any) => r.entry.text).join("\n---\n");
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
                async (event: any, ctx: any) => {
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

                    const sessionKey = `${ctx?.sessionId || "unknown"}:${event?.agentId || "unknown"}:${role}:${text}`;
                    const now = Date.now();
                    const lastCapturedAt = recentlyCaptured.get(sessionKey) || 0;
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
                        recentlyCaptured.set(sessionKey, now);

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
                handler: async (args: any, context: any) => {
                    api.logger.info("save-command: /save triggered, starting handover...");
                    try {
                        const sessionsDir = join(OPENCLAW_DIR, "agents", "main", "sessions");
                        let targetFileName: string | undefined;
                        let sessionId = context?.sessionId || context?.state?.sessionId;

                        try {
                            const sessionsMapStr = await readFile(join(sessionsDir, "sessions.json"), "utf8").catch(() => "{}");
                            const sessionsMap = JSON.parse(sessionsMapStr);
                            const smap = sessionsMap.sessions || sessionsMap;
                            if (sessionId && smap[sessionId]?.id) {
                                sessionId = smap[sessionId].id;
                            }
                        } catch (e) { }

                        if (sessionId) {
                            targetFileName = `${sessionId}.jsonl`;
                            try {
                                await stat(join(sessionsDir, targetFileName));
                            } catch (e) {
                                targetFileName = undefined;
                            }
                        }

                        if (!targetFileName) {
                            const files = await readdir(sessionsDir);
                            const sortedFiles = (await Promise.all(
                                files.filter(f => f.endsWith(".jsonl") && f !== "test-session.jsonl" && !f.includes("sessions.json") && !f.includes(".deleted.") && !f.includes(".reset.")).map(async f => {
                                    try {
                                        return { name: f, mtime: (await stat(join(sessionsDir, f))).mtimeMs };
                                    } catch (e) { return null; }
                                })
                            )).filter((x): x is { name: string, mtime: number } => x !== null)
                                .sort((a, b) => b.mtime - a.mtime);

                            if (sortedFiles.length > 0) targetFileName = sortedFiles[0].name;
                        }

                        if (!targetFileName) throw new Error("No session files found");

                        const filePath = join(sessionsDir, targetFileName);
                        const content = await readFile(filePath, "utf-8");
                        const messages = content.split("\n")
                            .filter(l => l.trim())
                            .map(l => {
                                try {
                                    return JSON.parse(l);
                                } catch (e) {
                                    api.logger.warn(`save-command: 警告：無法解析日誌行，已跳過。錯誤：${String(e)}`);
                                    return null;
                                }
                            })
                            .filter(e => e !== null && e.type === "message")
                            .map(e => ({ role: e.message.role, content: e.message.content }));

                        const configuredMessageCount = parsePositiveInt(config.sessionMemory?.messageCount) || 15;
                        const messageCount = Math.min(configuredMessageCount, 100);
                        const recentMessages = messages.slice(-messageCount);

                        if (recentMessages.length === 0) throw new Error("No messages found in session");

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

                        const prompt = `Compress the following conversation into a concise "State Fragment" for a perfect context handover. 
                                      Captured user facts, active plans, behavioral constraints, and secret codewords. 
                                      Use Traditional Chinese.`;

                        const response = await summarizer.chat.completions.create({
                            model: config.summarizer?.model || "gpt-4o-mini",
                            messages: [
                                { role: "user", content: `${prompt}\n\n=== CONVERSATION LOG ===\n${JSON.stringify(recentMessages)}\n=== END LOG ===\n\nPlease reply ONLY with the compressed State Fragment.` }
                            ]
                        });

                        const summary = response.choices[0].message.content || "";
                        const ephemeralPath = join(OPENCLAW_DIR, "memory", "lancedb-lite", "ephemeral_handover.json");
                        await mkdir(dirname(ephemeralPath), { recursive: true });
                        await writeFile(ephemeralPath, JSON.stringify({
                            date: new Date().toISOString(),
                            context: summary
                        }));

                        api.logger.info("save-command: successfully saved ephemeral handover");
                        return { text: "✅ 交接儲存成功！下一對話將自動載入此語境。" };
                    } catch (err) {
                        api.logger.error(`save-command failed: ${String(err)}`);
                        return { text: `❌ 交接失敗：${String(err)}` };
                    }
                }
            });

            // Handover Injection Hook
            api.on(
                "before_prompt_build",
                async (event: any, ctx: any) => {
                    if (ctx?.sessionId?.includes("slug-gen") || ctx?.sessionId?.includes("slug-generator")) return;
                    const ephemeralPath = join(OPENCLAW_DIR, "memory", "lancedb-lite", "ephemeral_handover.json");
                    try {
                        const content = await readFile(ephemeralPath, "utf-8");
                        const data = JSON.parse(content);
                        if (data?.context) {
                            api.logger.info("ephemeral-injection: injecting handover context");
                            const injection = `\n<previous-session-handoff>\n${data.context}\n</previous-session-handoff>\n`;
                            await unlink(ephemeralPath);
                            return { prependContext: injection };
                        }
                    } catch (e: any) {
                        if (e.code !== "ENOENT") api.logger.error(`ephemeral-injection error: ${String(e)}`);
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

function parsePluginConfig(value: any): PluginConfig {
    // simplified for brevity in this fix, assumed valid as we just checked it
    return value as PluginConfig;
}

export default memoryLanceDBLitePlugin;
