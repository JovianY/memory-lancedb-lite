import { createRetriever } from "../dist/retriever.js";

function makeEntry(id, text, vector) {
  return {
    id,
    text,
    vector,
    category: "other",
    scope: "global",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: "{}",
  };
}

const entryA = makeEntry("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", "alpha memory", [1, 0, 0]);
const entryB = makeEntry("bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", "beta memory!", [0, 1, 0]);

const store = {
  hasFtsSupport: true,
  async vectorSearch() {
    return [
      { entry: entryA, score: 0.9 },
      { entry: entryB, score: 0.4 },
    ];
  },
  async bm25Search() {
    return [
      { entry: entryA, score: 0.3 },
      { entry: entryB, score: 0.95 },
    ];
  },
  async hasId() {
    return true;
  },
};

const embedder = {
  async embedQuery() {
    return [1, 0, 0];
  },
};

const baseConfig = {
  mode: "hybrid",
  minScore: 0,
  rerank: "none",
  candidatePoolSize: 20,
  recencyHalfLifeDays: 14,
  recencyWeight: 0,
  filterNoise: false,
  lengthNormAnchor: 0,
  hardMinScore: 0,
  timeDecayHalfLifeDays: 0,
};

async function runCase(vectorWeight, bm25Weight) {
  const retriever = createRetriever(store, embedder, {
    ...baseConfig,
    vectorWeight,
    bm25Weight,
  });
  const results = await retriever.retrieve({ query: "demo", limit: 2 });
  return {
    topId: results[0]?.entry.id,
    topScore: results[0]?.score,
    full: results.map((r) => ({ id: r.entry.id, score: Number(r.score.toFixed(4)) })),
  };
}

const vectorHeavy = await runCase(0.9, 0.1);
const bm25Heavy = await runCase(0.1, 0.9);

console.log("Vector-heavy top:", vectorHeavy.topId, "score:", Number((vectorHeavy.topScore ?? 0).toFixed(4)));
console.log("BM25-heavy top:", bm25Heavy.topId, "score:", Number((bm25Heavy.topScore ?? 0).toFixed(4)));
console.log("Vector-heavy ranking:", JSON.stringify(vectorHeavy.full));
console.log("BM25-heavy ranking:", JSON.stringify(bm25Heavy.full));

if (vectorHeavy.topId === bm25Heavy.topId) {
  console.error("FAIL: top result did not change after switching weights.");
  process.exit(1);
}

console.log("PASS: top result changes when weights change.");
