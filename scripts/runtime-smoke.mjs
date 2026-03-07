import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { loadLanceDB, MemoryStore } from "../dist/store.js";

async function main() {
  const tmpRoot = await mkdtemp(join(tmpdir(), "memory-lancedb-lite-runtime-"));
  const dbPath = join(tmpRoot, "db");
  const warnings = [];

  try {
    // Verify native module can be loaded on the current host.
    await loadLanceDB();

    const store = new MemoryStore({
      dbPath,
      vectorDim: 4,
      logger: { warn: (...args) => warnings.push(args.map(String).join(" ")) },
    });

    const imported = await store.importEntry({
      id: "11111111-1111-4111-8111-111111111111",
      text: "runtime smoke memory",
      vector: [0.1, 0.2, 0.3, 0.4],
      category: "fact",
      scope: "global",
      importance: 0.8,
      timestamp: Date.now(),
      metadata: "{}",
    });

    assert.equal(await store.hasId(imported.id), true, "imported id should exist");

    const vectorHits = await store.vectorSearch([0.1, 0.2, 0.3, 0.4], 3, 0, ["global"]);
    assert.ok(vectorHits.length >= 1, "vector search should return at least one hit");

    const listed = await store.list(["global"], undefined, 10, 0);
    assert.ok(listed.some((entry) => entry.id === imported.id), "list should include imported entry");

    const stats = await store.stats(["global"]);
    assert.ok(stats.totalCount >= 1, "stats should report at least one record");

    const deleted = await store.delete(imported.id, ["global"]);
    assert.equal(deleted, true, "delete should remove the imported record");

    console.log(`[runtime-smoke] PASS dbPath=${dbPath} fts=${store.hasFtsSupport}`);
    if (warnings.length > 0) {
      console.log(`[runtime-smoke] WARN_COUNT=${warnings.length}`);
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[runtime-smoke] FAIL", err);
  process.exitCode = 1;
});
