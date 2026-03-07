import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

let registerAllMemoryTools;

async function ensurePluginSdkStub() {
  const pkgDir = join(process.cwd(), "node_modules", "openclaw");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "package.json"), JSON.stringify({
    name: "openclaw",
    type: "module",
    exports: {
      "./plugin-sdk": "./plugin-sdk.js",
    },
  }, null, 2) + "\n", "utf8");
  await writeFile(join(pkgDir, "plugin-sdk.js"), [
    "export function stringEnum(values) {",
    "  return { type: 'string', enum: values };",
    "}",
  ].join("\n") + "\n", "utf8");
}

function makeApi() {
  const tools = [];
  return {
    tools,
    api: {
      registerTool(def) {
        tools.push(def);
      },
    },
  };
}

function getTool(tools, name) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `missing tool: ${name}`);
  return tool;
}

function makeEntry(id, text, score = 0.9) {
  return {
    entry: {
      id,
      text,
      category: "fact",
      scope: "global",
      importance: 0.7,
      vector: [0.2, 0.2, 0.2],
      timestamp: Date.now(),
      metadata: "{}",
    },
    score,
    sources: { vector: { score, rank: 1 } },
  };
}

test("load tools module with local plugin-sdk stub", async () => {
  await ensurePluginSdkStub();
  const mod = await import("../dist/tools.js");
  registerAllMemoryTools = mod.registerAllMemoryTools;
  assert.equal(typeof registerAllMemoryTools, "function");
});

test("registerAllMemoryTools registers all tools including management tools", async () => {
  assert.equal(typeof registerAllMemoryTools, "function");
  const { api, tools } = makeApi();
  registerAllMemoryTools(api, {
    retriever: { retrieve: async () => [], getConfig: () => ({ mode: "hybrid" }) },
    store: { hasFtsSupport: true, vectorSearch: async () => [] },
    scopeManager: { getAccessibleScopes: () => ["global"], getDefaultScope: () => "global", isAccessible: () => true, getStats: () => ({ totalScopes: 1 }) },
    embedder: { embedPassage: async () => [0.1, 0.2, 0.3] },
    agentId: "main",
  }, { enableManagementTools: true });

  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "memory_forget",
    "memory_list",
    "memory_recall",
    "memory_stats",
    "memory_store",
    "memory_update",
  ]);
});

test("memory_recall returns found memories", async () => {
  assert.equal(typeof registerAllMemoryTools, "function");
  const { api, tools } = makeApi();
  registerAllMemoryTools(api, {
    retriever: { retrieve: async () => [makeEntry("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "remember this", 0.93)], getConfig: () => ({ mode: "hybrid" }) },
    store: { hasFtsSupport: true },
    scopeManager: { getAccessibleScopes: () => ["global"], isAccessible: () => true },
    embedder: {},
    agentId: "main",
  });
  const out = await getTool(tools, "memory_recall").execute("x", { query: "remember", limit: 3 });
  assert.match(out.content[0].text, /Found 1 memories/);
});

test("memory_store detects duplicate by vector similarity", async () => {
  assert.equal(typeof registerAllMemoryTools, "function");
  const { api, tools } = makeApi();
  registerAllMemoryTools(api, {
    retriever: {},
    store: {
      vectorSearch: async () => [{ entry: { id: "dup-id", text: "same thing" }, score: 0.99 }],
      store: async () => assert.fail("store should not be called on duplicate"),
    },
    scopeManager: { getDefaultScope: () => "global", isAccessible: () => true },
    embedder: { embedPassage: async () => [0.1, 0.2, 0.3] },
    agentId: "main",
  });
  const out = await getTool(tools, "memory_store").execute("x", { text: "same thing" });
  assert.equal(out.details.action, "duplicate");
});

test("memory_forget handles missing params", async () => {
  assert.equal(typeof registerAllMemoryTools, "function");
  const { api, tools } = makeApi();
  registerAllMemoryTools(api, {
    retriever: {},
    store: {},
    scopeManager: { getAccessibleScopes: () => ["global"], isAccessible: () => true },
    embedder: {},
    agentId: "main",
  });
  const out = await getTool(tools, "memory_forget").execute("x", {});
  assert.equal(out.details.error, "missing_param");
});

test("memory_update rejects empty update payload", async () => {
  assert.equal(typeof registerAllMemoryTools, "function");
  const { api, tools } = makeApi();
  registerAllMemoryTools(api, {
    retriever: { retrieve: async () => [] },
    store: { update: async () => null },
    scopeManager: { getAccessibleScopes: () => ["global"] },
    embedder: { embedPassage: async () => [0.1, 0.2, 0.3] },
    agentId: "main",
  });
  const out = await getTool(tools, "memory_update").execute("x", { memoryId: "abc" });
  assert.equal(out.details.error, "no_updates");
});

test("management tools return stats/list", async () => {
  assert.equal(typeof registerAllMemoryTools, "function");
  const { api, tools } = makeApi();
  registerAllMemoryTools(api, {
    retriever: { getConfig: () => ({ mode: "hybrid", rerankApiKey: "x" }) },
    store: {
      hasFtsSupport: true,
      stats: async () => ({ totalCount: 2, scopeCounts: { global: 2 }, categoryCounts: { fact: 2 } }),
      list: async () => [
        { id: "id-1", text: "foo", category: "fact", scope: "global", importance: 0.7, timestamp: Date.now() },
      ],
    },
    scopeManager: {
      getAccessibleScopes: () => ["global"],
      isAccessible: () => true,
      getStats: () => ({ totalScopes: 1, agentsWithCustomAccess: 0, scopesByType: { global: 1 } }),
    },
    embedder: {},
    agentId: "main",
  }, { enableManagementTools: true });

  const statsOut = await getTool(tools, "memory_stats").execute("x", {});
  assert.match(statsOut.content[0].text, /Total memories: 2/);

  const listOut = await getTool(tools, "memory_list").execute("x", { limit: 5 });
  assert.match(listOut.content[0].text, /Recent memories/);
});
