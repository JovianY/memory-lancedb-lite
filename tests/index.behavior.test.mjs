import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import memoryPlugin from "../dist/index.js";
import { MemoryStore } from "../dist/store.js";
import { Embedder } from "../dist/embedder.js";

async function withTempHome(run) {
  const root = await mkdtemp(join(tmpdir(), "memory-lancedb-lite-index-test-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  try {
    await run(root);
  } finally {
    process.env.HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
}

function makeApi(pluginConfig) {
  const hooks = [];
  const commands = [];
  const logs = [];
  const api = {
    config: {
      plugins: { entries: { "memory-lancedb-lite": { config: pluginConfig } } },
      gateway: { auth: { token: "gateway-token" } },
    },
    logger: {
      info: (...args) => logs.push(["info", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
      debug: (...args) => logs.push(["debug", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
    registerTool() { },
    registerCommand(c) { commands.push(c); },
    registerService() { },
    on(name, handler) { hooks.push({ name, handler }); },
  };
  return { api, hooks, commands, logs };
}

async function runBeforePromptHooks(hooks, event, ctx) {
  const responses = [];
  for (const hook of hooks.filter((h) => h.name === "before_prompt_build")) {
    const out = await hook.handler(event, ctx);
    if (out) responses.push(out);
  }
  return responses;
}

test("register fails on invalid plugin config", async () => {
  const { api } = makeApi({});
  await assert.rejects(
    () => memoryPlugin.register(api),
    /embedding is required|embedding\.provider/,
  );
});

test("autoCapture and autoRecall hooks operate on live flow", async () => {
  await withTempHome(async () => {
    const originalStore = MemoryStore.prototype.store;
    const originalVectorSearch = MemoryStore.prototype.vectorSearch;
    const originalBm25Search = MemoryStore.prototype.bm25Search;
    const originalHasFts = Object.getOwnPropertyDescriptor(MemoryStore.prototype, "hasFtsSupport");
    const originalEmbedPassage = Embedder.prototype.embedPassage;
    const originalEmbedQuery = Embedder.prototype.embedQuery;

    const mem = [];
    MemoryStore.prototype.store = async function patchedStore(entry) {
      const saved = {
        id: `id-${mem.length + 1}`,
        text: entry.text,
        vector: entry.vector,
        category: entry.category,
        scope: entry.scope,
        importance: entry.importance,
        timestamp: Date.now(),
        metadata: entry.metadata || "{}",
      };
      mem.push(saved);
      return saved;
    };
    MemoryStore.prototype.vectorSearch = async function patchedVectorSearch(_vector, limit) {
      return mem.slice(0, limit).map((m) => ({
        entry: m,
        score: 0.95,
      }));
    };
    MemoryStore.prototype.bm25Search = async function patchedBm25Search() {
      return [];
    };
    Object.defineProperty(MemoryStore.prototype, "hasFtsSupport", {
      configurable: true,
      get() { return false; },
    });
    Embedder.prototype.embedPassage = async function patchedEmbedPassage() {
      return [0.2, 0.2, 0.2];
    };
    Embedder.prototype.embedQuery = async function patchedEmbedQuery() {
      return [0.2, 0.2, 0.2];
    };

    try {
      const { api, hooks } = makeApi({
        embedding: {
          provider: "openai-compatible",
          apiKey: "test-key",
          model: "custom-mock-model",
          dimensions: 3,
        },
        autoCapture: true,
        autoRecall: true,
        autoRecallMinLength: 10,
        retrieval: {
          mode: "vector",
          filterNoise: false,
          minScore: 0.1,
          hardMinScore: 0.1,
          rerank: "none",
        },
        enableManagementTools: false,
        sessionMemory: { enabled: false },
      });

      await memoryPlugin.register(api);

      const firstEvent = { agentId: "main", messages: [{ role: "user", content: "請記住：我午餐偏好是拉麵與溫泉蛋" }] };
      const firstOut = await runBeforePromptHooks(hooks, firstEvent, { sessionId: "sess-1", sessionKey: "agent:main:main" });
      assert.equal(firstOut.length, 0);

      const secondEvent = { agentId: "main", messages: [{ role: "user", content: "你記得我之前提到過的午餐偏好是什麼嗎？" }] };
      const secondOut = await runBeforePromptHooks(hooks, secondEvent, { sessionId: "sess-1", sessionKey: "agent:main:main" });
      const merged = secondOut.map((x) => x.prependContext || "").join("\n");
      assert.match(merged, /relevant-memories/);
      assert.match(merged, /午餐偏好/);
    } finally {
      MemoryStore.prototype.store = originalStore;
      MemoryStore.prototype.vectorSearch = originalVectorSearch;
      MemoryStore.prototype.bm25Search = originalBm25Search;
      if (originalHasFts) {
        Object.defineProperty(MemoryStore.prototype, "hasFtsSupport", originalHasFts);
      }
      Embedder.prototype.embedPassage = originalEmbedPassage;
      Embedder.prototype.embedQuery = originalEmbedQuery;
    }
  });
});
