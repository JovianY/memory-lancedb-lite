/**
 * LanceDB Storage Layer with Multi-Scope Support
 * Security-hardened: strict input validation, no arbitrary SQL interpolation.
 */

import type * as LanceDB from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

export interface MemoryEntry {
    id: string;
    text: string;
    vector: number[];
    category: "preference" | "fact" | "decision" | "entity" | "other";
    scope: string;
    importance: number;
    timestamp: number;
    metadata?: string;
}

export interface MemorySearchResult {
    entry: MemoryEntry;
    score: number;
}

export interface StoreConfig {
    dbPath: string;
    vectorDim: number;
}

// ============================================================================
// LanceDB Dynamic Import
// ============================================================================

let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null = null;

export const loadLanceDB = async (): Promise<typeof import("@lancedb/lancedb")> => {
    if (!lancedbImportPromise) {
        lancedbImportPromise = import("@lancedb/lancedb");
    }
    try {
        return await lancedbImportPromise;
    } catch (err) {
        throw new Error(`memory-lancedb-lite: failed to load LanceDB. ${String(err)}`, { cause: err });
    }
};

// ============================================================================
// Input Validation (Security Hardening)
// ============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PREFIX_REGEX = /^[0-9a-f]{8,}$/i;
const SAFE_SCOPE_REGEX = /^[a-zA-Z0-9._:-]{1,100}$/;

function validateUUID(id: string): void {
    if (!UUID_REGEX.test(id) && !UUID_PREFIX_REGEX.test(id)) {
        throw new Error(`Invalid memory ID format: must be UUID or 8+ hex prefix`);
    }
}

function validateScope(scope: string): string {
    const trimmed = scope.trim();
    if (!SAFE_SCOPE_REGEX.test(trimmed)) {
        throw new Error(`Invalid scope format: must match [a-zA-Z0-9._:-]{1,100}`);
    }
    return trimmed;
}

/** Escape a string for use in LanceDB SQL WHERE clauses. */
function escapeSqlLiteral(value: string): string {
    // Only allow known-safe characters through for SQL literals
    return value.replace(/['\\\0\x1a]/g, char => {
        switch (char) {
            case "'": return "''";
            case "\\": return "\\\\";
            case "\0": return "";
            case "\x1a": return "";
            default: return char;
        }
    });
}

function clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, Math.floor(value)));
}

// ============================================================================
// Memory Store
// ============================================================================

const TABLE_NAME = "memories";

export class MemoryStore {
    private db: LanceDB.Connection | null = null;
    private table: LanceDB.Table | null = null;
    private initPromise: Promise<void> | null = null;
    private ftsIndexCreated = false;

    constructor(private readonly config: StoreConfig) { }

    get dbPath(): string {
        return this.config.dbPath;
    }

    private async ensureInitialized(): Promise<void> {
        if (this.table) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this.doInitialize().catch((err) => {
            this.initPromise = null;
            throw err;
        });
        return this.initPromise;
    }

    private async doInitialize(): Promise<void> {
        const lancedb = await loadLanceDB();
        const db = await lancedb.connect(this.config.dbPath);
        let table: LanceDB.Table;

        try {
            table = await db.openTable(TABLE_NAME);
        } catch (_openErr) {
            const schemaEntry: MemoryEntry = {
                id: "__schema__",
                text: "",
                vector: Array.from({ length: this.config.vectorDim }).fill(0) as number[],
                category: "other",
                scope: "global",
                importance: 0,
                timestamp: 0,
                metadata: "{}",
            };

            try {
                table = await db.createTable(TABLE_NAME, [schemaEntry as any]);
                await table.delete('id = "__schema__"');
            } catch (createErr) {
                if (String(createErr).includes("already exists")) {
                    table = await db.openTable(TABLE_NAME);
                } else {
                    throw createErr;
                }
            }
        }

        // Validate vector dimensions
        const sample = await table.query().limit(1).toArray();
        if (sample.length > 0 && sample[0]?.vector?.length) {
            const existingDim = sample[0].vector.length;
            if (existingDim !== this.config.vectorDim) {
                throw new Error(
                    `Vector dimension mismatch: table=${existingDim}, config=${this.config.vectorDim}. Create a new table/dbPath or set matching embedding.dimensions.`
                );
            }
        }

        // Create FTS index for BM25 search
        try {
            await this.createFtsIndex(table);
            this.ftsIndexCreated = true;
        } catch (err) {
            console.warn("Failed to create FTS index, falling back to vector-only search:", err);
            this.ftsIndexCreated = false;
        }

        this.db = db;
        this.table = table;
    }

    private async createFtsIndex(table: LanceDB.Table): Promise<void> {
        try {
            const indices = await table.listIndices();
            const hasFtsIndex = indices?.some((idx: any) =>
                idx.indexType === "FTS" || idx.columns?.includes("text")
            );

            if (!hasFtsIndex) {
                const lancedb = await loadLanceDB();
                await table.createIndex("text", {
                    config: (lancedb as any).Index.fts(),
                });
            }
        } catch (err) {
            throw new Error(`FTS index creation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    async store(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<MemoryEntry> {
        await this.ensureInitialized();

        const validatedScope = validateScope(entry.scope);
        const fullEntry: MemoryEntry = {
            ...entry,
            scope: validatedScope,
            id: randomUUID(),
            timestamp: Date.now(),
            metadata: entry.metadata || "{}",
        };

        await this.table!.add([fullEntry as any]);
        return fullEntry;
    }

    async importEntry(entry: MemoryEntry): Promise<MemoryEntry> {
        await this.ensureInitialized();

        if (!entry.id || typeof entry.id !== "string") {
            throw new Error("importEntry requires a stable id");
        }
        validateUUID(entry.id);

        const vector = entry.vector || [];
        if (!Array.isArray(vector) || vector.length !== this.config.vectorDim) {
            throw new Error(
                `Vector dimension mismatch: expected ${this.config.vectorDim}, got ${Array.isArray(vector) ? vector.length : 'non-array'}`
            );
        }

        const full: MemoryEntry = {
            ...entry,
            scope: validateScope(entry.scope || "global"),
            importance: Number.isFinite(entry.importance) ? entry.importance : 0.7,
            timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
            metadata: entry.metadata || "{}",
        };

        await this.table!.add([full as any]);
        return full;
    }

    async hasId(id: string): Promise<boolean> {
        await this.ensureInitialized();
        validateUUID(id);
        const safeId = escapeSqlLiteral(id);
        const res = await this.table!.query().select(["id"]).where(`id = '${safeId}'`).limit(1).toArray();
        return res.length > 0;
    }

    async vectorSearch(vector: number[], limit = 5, minScore = 0.3, scopeFilter?: string[]): Promise<MemorySearchResult[]> {
        await this.ensureInitialized();

        const safeLimit = clampInt(limit, 1, 20);
        const fetchLimit = Math.min(safeLimit * 10, 200);

        let query = this.table!.vectorSearch(vector).limit(fetchLimit);

        if (scopeFilter && scopeFilter.length > 0) {
            const scopeConditions = scopeFilter
                .map(scope => `scope = '${escapeSqlLiteral(validateScope(scope))}'`)
                .join(" OR ");
            query = query.where(`(${scopeConditions}) OR scope IS NULL`);
        }

        const results = await query.toArray();
        const mapped: MemorySearchResult[] = [];

        for (const row of results) {
            const distance = Number(row._distance ?? 0);
            const score = 1 / (1 + distance);

            if (score < minScore) continue;

            const rowScope = (row.scope as string | undefined) ?? "global";

            if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(rowScope)) {
                continue;
            }

            mapped.push({
                entry: {
                    id: row.id as string,
                    text: row.text as string,
                    vector: row.vector as number[],
                    category: row.category as MemoryEntry["category"],
                    scope: rowScope,
                    importance: Number(row.importance),
                    timestamp: Number(row.timestamp),
                    metadata: (row.metadata as string) || "{}",
                },
                score,
            });

            if (mapped.length >= safeLimit) break;
        }

        return mapped;
    }

    async bm25Search(query: string, limit = 5, scopeFilter?: string[]): Promise<MemorySearchResult[]> {
        await this.ensureInitialized();

        if (!this.ftsIndexCreated) return [];

        const safeLimit = clampInt(limit, 1, 20);

        try {
            let searchQuery = this.table!.search(query, "fts").limit(safeLimit);

            if (scopeFilter && scopeFilter.length > 0) {
                const scopeConditions = scopeFilter
                    .map(scope => `scope = '${escapeSqlLiteral(validateScope(scope))}'`)
                    .join(" OR ");
                searchQuery = searchQuery.where(`(${scopeConditions}) OR scope IS NULL`);
            }

            const results = await searchQuery.toArray();
            const mapped: MemorySearchResult[] = [];

            for (const row of results) {
                const rowScope = (row.scope as string | undefined) ?? "global";

                if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(rowScope)) {
                    continue;
                }

                const rawScore = (row._score != null) ? Number(row._score) : 0;
                const normalizedScore = rawScore > 0 ? 1 / (1 + Math.exp(-rawScore / 5)) : 0.5;

                mapped.push({
                    entry: {
                        id: row.id as string,
                        text: row.text as string,
                        vector: row.vector as number[],
                        category: row.category as MemoryEntry["category"],
                        scope: rowScope,
                        importance: Number(row.importance),
                        timestamp: Number(row.timestamp),
                        metadata: (row.metadata as string) || "{}",
                    },
                    score: normalizedScore,
                });
            }

            return mapped;
        } catch (err) {
            console.warn("BM25 search failed, falling back to empty results:", err);
            return [];
        }
    }

    async delete(id: string, scopeFilter?: string[]): Promise<boolean> {
        await this.ensureInitialized();
        validateUUID(id);

        const isFullId = UUID_REGEX.test(id);
        const isPrefix = !isFullId && UUID_PREFIX_REGEX.test(id);

        let candidates: any[];
        if (isFullId) {
            candidates = await this.table!.query().where(`id = '${escapeSqlLiteral(id)}'`).limit(1).toArray();
        } else {
            const all = await this.table!.query().select(["id", "scope"]).limit(1000).toArray();
            candidates = all.filter((r: any) => (r.id as string).startsWith(id));
            if (candidates.length > 1) {
                throw new Error(`Ambiguous prefix "${id}" matches ${candidates.length} memories. Use a longer prefix or full ID.`);
            }
        }
        if (candidates.length === 0) return false;

        const resolvedId = candidates[0].id as string;
        const rowScope = (candidates[0].scope as string | undefined) ?? "global";

        if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(rowScope)) {
            throw new Error(`Memory ${resolvedId} is outside accessible scopes`);
        }

        await this.table!.delete(`id = '${escapeSqlLiteral(resolvedId)}'`);
        return true;
    }

    async list(scopeFilter?: string[], category?: string, limit = 20, offset = 0): Promise<MemoryEntry[]> {
        await this.ensureInitialized();

        let query = this.table!.query();
        const conditions: string[] = [];

        if (scopeFilter && scopeFilter.length > 0) {
            const scopeConditions = scopeFilter
                .map(scope => `scope = '${escapeSqlLiteral(validateScope(scope))}'`)
                .join(" OR ");
            conditions.push(`((${scopeConditions}) OR scope IS NULL)`);
        }

        if (category) {
            conditions.push(`category = '${escapeSqlLiteral(category)}'`);
        }

        if (conditions.length > 0) {
            query = query.where(conditions.join(" AND "));
        }

        const results = await query
            .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"])
            .toArray();

        return results
            .map((row): MemoryEntry => ({
                id: row.id as string,
                text: row.text as string,
                vector: [],
                category: row.category as MemoryEntry["category"],
                scope: (row.scope as string | undefined) ?? "global",
                importance: Number(row.importance),
                timestamp: Number(row.timestamp),
                metadata: (row.metadata as string) || "{}",
            }))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(offset, offset + limit);
    }

    async stats(scopeFilter?: string[]): Promise<{
        totalCount: number;
        scopeCounts: Record<string, number>;
        categoryCounts: Record<string, number>;
    }> {
        await this.ensureInitialized();

        let query = this.table!.query();

        if (scopeFilter && scopeFilter.length > 0) {
            const scopeConditions = scopeFilter
                .map(scope => `scope = '${escapeSqlLiteral(validateScope(scope))}'`)
                .join(" OR ");
            query = query.where(`((${scopeConditions}) OR scope IS NULL)`);
        }

        const results = await query.select(["scope", "category"]).toArray();

        const scopeCounts: Record<string, number> = {};
        const categoryCounts: Record<string, number> = {};

        for (const row of results) {
            const scope = (row.scope as string | undefined) ?? "global";
            const category = row.category as string;
            scopeCounts[scope] = (scopeCounts[scope] || 0) + 1;
            categoryCounts[category] = (categoryCounts[category] || 0) + 1;
        }

        return { totalCount: results.length, scopeCounts, categoryCounts };
    }

    async update(
        id: string,
        updates: { text?: string; vector?: number[]; importance?: number; category?: MemoryEntry["category"]; metadata?: string },
        scopeFilter?: string[]
    ): Promise<MemoryEntry | null> {
        await this.ensureInitialized();
        validateUUID(id);

        const isFullId = UUID_REGEX.test(id);

        let rows: any[];
        if (isFullId) {
            const safeId = escapeSqlLiteral(id);
            rows = await this.table!.query().where(`id = '${safeId}'`).limit(1).toArray();
        } else {
            const all = await this.table!.query().select(["id", "text", "vector", "category", "scope", "importance", "timestamp", "metadata"]).limit(1000).toArray();
            rows = all.filter((r: any) => (r.id as string).startsWith(id));
            if (rows.length > 1) {
                throw new Error(`Ambiguous prefix "${id}" matches ${rows.length} memories. Use a longer prefix or full ID.`);
            }
        }

        if (rows.length === 0) return null;

        const row = rows[0];
        const rowScope = (row.scope as string | undefined) ?? "global";

        if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(rowScope)) {
            throw new Error(`Memory ${id} is outside accessible scopes`);
        }

        const updated: MemoryEntry = {
            id: row.id as string,
            text: updates.text ?? (row.text as string),
            vector: updates.vector ?? (Array.from(row.vector as Iterable<number>)),
            category: updates.category ?? (row.category as MemoryEntry["category"]),
            scope: rowScope,
            importance: updates.importance ?? Number(row.importance),
            timestamp: Number(row.timestamp),
            metadata: updates.metadata ?? ((row.metadata as string) || "{}"),
        };

        const resolvedId = escapeSqlLiteral(row.id as string);
        await this.table!.delete(`id = '${resolvedId}'`);
        await this.table!.add([updated as any]);

        return updated;
    }

    async bulkDelete(scopeFilter: string[], beforeTimestamp?: number): Promise<number> {
        await this.ensureInitialized();

        const conditions: string[] = [];

        if (scopeFilter.length > 0) {
            const scopeConditions = scopeFilter
                .map(scope => `scope = '${escapeSqlLiteral(validateScope(scope))}'`)
                .join(" OR ");
            conditions.push(`(${scopeConditions})`);
        }

        if (beforeTimestamp) {
            conditions.push(`timestamp < ${beforeTimestamp}`);
        }

        if (conditions.length === 0) {
            throw new Error("Bulk delete requires at least scope or timestamp filter for safety");
        }

        const whereClause = conditions.join(" AND ");
        const countResults = await this.table!.query().where(whereClause).toArray();
        const deleteCount = countResults.length;

        if (deleteCount > 0) {
            await this.table!.delete(whereClause);
        }

        return deleteCount;
    }

    get hasFtsSupport(): boolean {
        return this.ftsIndexCreated;
    }
}
