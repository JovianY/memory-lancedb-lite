import test from "node:test";
import assert from "node:assert/strict";

import { createRetriever } from "../dist/retriever.js";

function entry(id, text, score, ts = Date.now()) {
  return {
    entry: {
      id,
      text,
      vector: [0.3, 0.3, 0.3],
      category: "fact",
      scope: "global",
      importance: 0.8,
      timestamp: ts,
      metadata: "{}",
    },
    score,
  };
}

test("retriever hybrid mode fuses vector and bm25 results", async () => {
  const store = {
    hasFtsSupport: true,
    vectorSearch: async () => [entry("id-a", "alpha memory", 0.9)],
    bm25Search: async () => [entry("id-a", "alpha memory", 0.7)],
    hasId: async () => true,
  };
  const embedder = { embedQuery: async () => [0.3, 0.3, 0.3] };
  const retriever = createRetriever(store, embedder, {
    mode: "hybrid",
    rerank: "none",
    minScore: 0.1,
    hardMinScore: 0.1,
    filterNoise: false,
    candidatePoolSize: 5,
  });
  const out = await retriever.retrieve({ query: "alpha", limit: 3, scopeFilter: ["global"] });
  assert.equal(out.length, 1);
  assert.equal(out[0].entry.id, "id-a");
  assert.ok(out[0].sources.vector);
  assert.ok(out[0].sources.bm25);
});

test("retriever falls back to vector when fts disabled", async () => {
  const store = {
    hasFtsSupport: false,
    vectorSearch: async () => [entry("id-v", "vector only", 0.88)],
    bm25Search: async () => assert.fail("bm25Search should not be called"),
  };
  const embedder = { embedQuery: async () => [0.3, 0.3, 0.3] };
  const retriever = createRetriever(store, embedder, {
    mode: "hybrid",
    rerank: "none",
    minScore: 0.1,
    hardMinScore: 0.1,
    filterNoise: false,
  });
  const out = await retriever.retrieve({ query: "vector", limit: 3 });
  assert.equal(out[0].entry.id, "id-v");
});

test("retriever cross-encoder rerank path applies remote scores", async () => {
  const store = {
    hasFtsSupport: true,
    vectorSearch: async () => [entry("id-a", "alpha", 0.8), entry("id-b", "beta", 0.7)],
    bm25Search: async () => [entry("id-a", "alpha", 0.6), entry("id-b", "beta", 0.65)],
    hasId: async () => true,
  };
  const embedder = { embedQuery: async () => [0.3, 0.3, 0.3] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    results: [{ index: 1, relevance_score: 0.99 }, { index: 0, relevance_score: 0.5 }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const retriever = createRetriever(store, embedder, {
      mode: "hybrid",
      rerank: "cross-encoder",
      rerankApiKey: "test-key",
      rerankModel: "jina-reranker-v3",
      minScore: 0.1,
      hardMinScore: 0.1,
      filterNoise: false,
      candidatePoolSize: 5,
    });
    const out = await retriever.retrieve({ query: "alpha beta", limit: 2 });
    assert.equal(out.length, 2);
    assert.equal(out[0].entry.id, "id-b");
    assert.ok(out[0].sources.reranked);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
