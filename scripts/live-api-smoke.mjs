import assert from "node:assert/strict";

import { Embedder } from "../dist/embedder.js";
import { MemoryRetriever } from "../dist/retriever.js";

function env(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function skip(message) {
  console.log(`[live-api-smoke] SKIP ${message}`);
  process.exit(0);
}

function isStrict() {
  return env("MEMORY_LANCEDB_LIVE_STRICT", "0") === "1";
}

async function runEmbeddingSmoke() {
  const apiKey = env("MEMORY_LANCEDB_LIVE_EMBEDDING_API_KEY", env("GEMINI_API_KEY", env("OPENAI_API_KEY", "")));
  const model = env("MEMORY_LANCEDB_LIVE_EMBEDDING_MODEL", "text-embedding-3-small");
  const baseURL = env("MEMORY_LANCEDB_LIVE_EMBEDDING_BASE_URL", "");

  if (!apiKey) {
    skip("missing embedding API key (MEMORY_LANCEDB_LIVE_EMBEDDING_API_KEY/GEMINI_API_KEY/OPENAI_API_KEY)");
  }

  const embedder = new Embedder({
    provider: "openai-compatible",
    apiKey,
    model,
    ...(baseURL ? { baseURL } : {}),
  });

  let queryVec;
  let passageVec;
  try {
    queryVec = await embedder.embedQuery("memory-lancedb-lite live embedding smoke query");
    passageVec = await embedder.embedPassage("memory-lancedb-lite live embedding smoke passage");
  } catch (error) {
    if (!isStrict()) {
      skip(`embedding endpoint unreachable (${error instanceof Error ? error.message : String(error)})`);
    }
    throw error;
  }

  assert.ok(Array.isArray(queryVec) && queryVec.length > 0, "query embedding should be non-empty");
  assert.equal(queryVec.length, passageVec.length, "query/passage dimensions should match");

  console.log(`[live-api-smoke] embedding PASS model=${model} dims=${queryVec.length}`);
  return { embedder, queryVec };
}

async function runRerankSmoke(embedder, queryVec) {
  const rerankApiKey = env("MEMORY_LANCEDB_LIVE_RERANK_API_KEY", "");
  const rerankEndpoint = env("MEMORY_LANCEDB_LIVE_RERANK_ENDPOINT", "");
  const rerankProvider = env("MEMORY_LANCEDB_LIVE_RERANK_PROVIDER", "jina");
  const rerankModel = env("MEMORY_LANCEDB_LIVE_RERANK_MODEL", "jina-reranker-v3");

  if (!rerankApiKey || !rerankEndpoint) {
    console.log("[live-api-smoke] rerank SKIP (set MEMORY_LANCEDB_LIVE_RERANK_API_KEY + MEMORY_LANCEDB_LIVE_RERANK_ENDPOINT)");
    return;
  }

  const docs = [
    "The user prefers concise updates with direct action items.",
    "The user likes pineapple on pizza.",
    "The user requested full memory-lancedb-lite testing coverage.",
  ];

  const docVectors = await embedder.embedBatchPassage(docs);
  const now = Date.now();
  const entries = docs.map((text, idx) => ({
    id: `${"a".repeat(8)}-${"b".repeat(4)}-4${String(idx).padStart(3, "0")}-${"c".repeat(4)}-${String(idx + 1).padStart(12, "0")}`,
    text,
    vector: docVectors[idx],
    category: "fact",
    scope: "global",
    importance: 0.7,
    timestamp: now - idx * 1000,
    metadata: "{}",
  }));

  const fakeStore = {
    hasFtsSupport: true,
    vectorSearch: async () => [
      { entry: entries[1], score: 0.72 },
      { entry: entries[2], score: 0.69 },
      { entry: entries[0], score: 0.51 },
    ],
    bm25Search: async () => [
      { entry: entries[2], score: 0.93 },
      { entry: entries[0], score: 0.61 },
      { entry: entries[1], score: 0.22 },
    ],
  };

  const retrieverEmbedder = { embedQuery: async () => queryVec };
  const warnings = [];
  const retriever = new MemoryRetriever(
    fakeStore,
    retrieverEmbedder,
    {
      mode: "hybrid",
      vectorWeight: 0.7,
      bm25Weight: 0.3,
      minScore: 0,
      hardMinScore: 0,
      rerank: "cross-encoder",
      candidatePoolSize: 10,
      recencyHalfLifeDays: 7,
      recencyWeight: 0,
      timeDecayHalfLifeDays: 3650,
      filterNoise: false,
      rerankApiKey,
      rerankEndpoint,
      rerankProvider,
      rerankModel,
      lengthNormAnchor: 500,
    },
    { warn: (...args) => warnings.push(args.map(String).join(" ")) },
  );

  const originalFetch = globalThis.fetch;
  let rerankCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (typeof url === "string" && url.startsWith(rerankEndpoint)) {
      rerankCalls += 1;
    }
    return originalFetch(input, init);
  };

  try {
    let results;
    try {
      results = await retriever.retrieve({
        query: "What did the user request about memory-lancedb-lite testing?",
        limit: 3,
        scopeFilter: ["global"],
      });
    } catch (error) {
      if (!isStrict()) {
        skip(`rerank endpoint unreachable (${error instanceof Error ? error.message : String(error)})`);
      }
      throw error;
    }

    assert.ok(results.length > 0, "rerank retrieval should return results");
    assert.ok(rerankCalls >= 1, "cross-encoder rerank endpoint should be called");
    console.log(`[live-api-smoke] rerank PASS provider=${rerankProvider} endpoint=${rerankEndpoint} results=${results.length}`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  if (warnings.length > 0) {
    console.log(`[live-api-smoke] rerank WARN_COUNT=${warnings.length}`);
  }
}

async function main() {
  const { embedder, queryVec } = await runEmbeddingSmoke();
  await runRerankSmoke(embedder, queryVec);
  console.log("[live-api-smoke] PASS");
}

main().catch((err) => {
  console.error("[live-api-smoke] FAIL", err);
  process.exitCode = 1;
});
