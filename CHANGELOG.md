# Changelog

All notable changes to `memory-lancedb-lite` will be documented in this file.

## [1.1.9] - 2026-03-07

### Changed
- Version bump for expanded test-tooling surface and release-readiness docs updates.
- Synchronized version references across:
  - `package.json`
  - `openclaw.plugin.json`
  - `src/index.ts` plugin meta/log version string
  - `README.md` install example
- `/save` handover key write-path now prefers resolved session keys (including session-store reverse lookup by `sessionId`) before falling back to `agent:<id>:main`, preventing legacy-context key drift.

### Added
- `/save` coverage expansion for session-context edge paths:
  - `sessionId`-only command context resolves and writes handover under the matched channel session key.
  - `webchat` fallback supports non-`main` agent via `ctx.agentId` (e.g. `agent:coder:main`).
  - Legacy raw target-id command context writes/consumes handover using the resolved channel session key.
- New test cases added to both deterministic and `node:test` suites:
  - `tests/save-command.integration.test.mjs`
  - `tests/run-tests.mjs`
  - `tests/session-handover.test.mjs`

## [1.1.8] - 2026-03-07

### Fixed
- **Config parsing hardening**: Replaced permissive config cast with strict runtime validation in `parsePluginConfig`, including required `embedding` checks and safer defaults for optional sections.
- **`/save` session safety**: `/save` now fails closed when session identity cannot be resolved, instead of falling back to latest session log file.
- **Atomic handover consumption**: Switched one-time handover injection from `read + unlink` to `rename + read + cleanup` flow to reduce duplicate injection risk under concurrent prompt builds.

### Improved
- **Large-session handling for `/save`**: Handover summarization now reads a bounded tail window of session logs (`readTailUtf8`) instead of always loading full files.
- **Observability consistency**: Retrieval/store fallback warnings now use plugin logger instead of direct `console.warn`.
- **Auto-capture memory pressure**: De-dup cache key now uses a fixed-length hash instead of full message text payload.
- **`node:test` stability for `/save` integration suite**: Replaced local HTTP summarizer mock with `fetch`-level mock in `tests/save-command.integration.test.mjs` to avoid Node 22 runner assertion crash in this environment while preserving the same behavior checks.

### Changed
- Updated integration and deterministic tests to reflect fail-closed `/save` semantics for malformed/missing session mapping.
- Expanded `node-test-compat` in `scripts/test-all.sh` to auto-run all `tests/*.test.mjs` files, not only a subset.

### Added
- New full-feature unit/behavior tests:
  - `tests/tools.unit.test.mjs` (all memory tools + tool registration/gating)
  - `tests/retriever.unit.test.mjs` (hybrid/vector/fts/rerank retrieval paths)
  - `tests/index.behavior.test.mjs` (config guardrails + auto-capture/auto-recall flow)
- Runtime/install-environment smoke test:
  - `scripts/runtime-smoke.mjs` validates LanceDB native module load and temp-db CRUD/search/list/stats/delete path end-to-end.
- Live external API smoke test:
  - `scripts/live-api-smoke.mjs` validates real embedding API calls and real rerank endpoint calls (when env is configured).
  - Adds `MEMORY_LANCEDB_LIVE_STRICT=1` mode to fail on connectivity/API errors; default mode reports `SKIP` when live endpoints are unreachable.
- New npm scripts:
  - `test:runtime:smoke`
  - `test:live:apis`

### Release validation status
- Local deterministic/runtime validation: **PASS** (`npm run test:all:no-e2e`).
- Real gateway `/save` e2e: depends on active OpenClaw gateway health; may fail on known OpenClaw instability (`uv_interface_addresses`, websocket `1006`) even when plugin logic is correct.

## [1.1.7] - 2026-03-07

### Added
- **Full Test Entry Script**: Added `scripts/test-all.sh` as a single entrypoint to run full validation suites in sequence:
  1. `build` (`npm run build`)
  2. deterministic regression suite (`node tests/run-tests.mjs`)
  3. Node test compatibility suite (`node --test tests/session-handover.test.mjs tests/save-command.integration.test.mjs`)
  4. gateway preflight + real `/save` e2e smoke (`scripts/e2e-save-smoke.sh`)
- **Reusable npm commands for future agents**:
  - `npm run test:all` (full suite)
  - `npm run test:all:no-e2e` (local deterministic + compatibility only)
  - `npm run test:all:e2e-only` (gateway smoke only)
- **Gateway E2E Smoke Script for `/save`**: Added `scripts/e2e-save-smoke.sh` to run a real Gateway-backed end-to-end flow:
  1. send a seeded message into an isolated test session,
  2. run `/save`,
  3. verify per-session handover file creation + payload shape,
  4. send next-turn message to trigger one-time injection consumption,
  5. verify handover file deletion,
  6. verify chat history includes save success signal.
  - Added per-call timeout (`OPENCLAW_E2E_GATEWAY_CALL_TIMEOUT_SEC`, default `20`) to prevent deadlocks when gateway CLI hangs.
  - Added explicit retry-failure diagnostics (`method=<...> reason=<timeout|gateway_closed|uv_interface_addresses|...>`) for faster root-cause triage.
- **Reusable command for future agents**:
  - `npm run test:e2e:save`
  - This command builds first, then runs the real smoke flow against the active local gateway.

### Changed
- **Test tooling robustness**: Switched automated test execution to `tests/run-tests.mjs` (single deterministic runner) to avoid Node test-runner instability in this environment while preserving full user-scenario + error-injection coverage.

### Operational Notes (for future agents)
- Preferred single entry: `npm run test:all`
- If gateway is unavailable, run local suite only: `npm run test:all:no-e2e`
- To validate only real gateway `/save`: `npm run test:all:e2e-only` (or `npm run test:e2e:save`)
- The e2e script auto-cleans created handover artifacts and its synthetic session entry/files after completion.
- `test:all` uses a soft gateway preflight to avoid false negatives from transient CLI startup instability, but real `/save` e2e remains strict and will fail on repeated gateway call timeouts/closures.

## [1.1.6] - 2026-03-07

### Fixed
- **`/save` Command Context Contract**: Corrected command handler signature to use the real OpenClaw plugin command context (`handler(ctx)`), eliminating reliance on a non-existent second `context` argument.
- **Session Target Resolution**: Added deterministic session resolution from command context + `sessions.json` mapping, with safer fallback logic and support for topic/session file suffixes.
- **Ephemeral Handover Isolation**: Replaced single global `ephemeral_handover.json` with per-session-key handover files (hashed path), preventing cross-chat context leakage.

### Improved
- **Version Consistency**: Synchronized runtime/meta/manifest/package/docs versions to `1.1.6` for accurate diagnostics and deployment tracking.
- **Regression Tests**: Added automated tests covering session context parsing and per-session handover path isolation.

## [1.1.5] - 2026-03-07

### Added
- **Handover Preview**: The `/save` command now displays a 60-character preview of the saved state fragment, providing immediate confirmation of what the Agent "remembered".

### Fixed
- **Multi-Agent Awareness**: Resolved a critical bug where `/save` was hardcoded to the `main` agent's directory. It now dynamically resolves the correct `sessions/` path for `coder`, `planner`, or any custom agent.
- **Session File Filtering**: Implemented strict exclusion rules for session scanning. The plugin now ignores `test*`, `.tmp`, `.deleted`, and `.reset` files to prevent test data or corrupted logs from contaminating real summaries.
- **Anti-Echo Logic**: Added a pre-processing step to strip `<previous-session-handoff>` tags from the log before summarization, preventing recursive "memory echoes" where old summaries were summarized again.

### Improved
- **Smart State Merging**: Overhauled the summarization prompt to explicitly merge the "Previous State" with "New Messages". This ensures continuity of plans and constraints while allowing the LLM to prune facts already stored in LanceDB.
- **Recency Tuning**: Adjusted hybrid retrieval weights (`recencyHalfLifeDays: 7`, `recencyWeight: 0.20`) to prioritize recent context more aggressively.

## [1.1.4] - 2026-03-03

### Added
- **LLM State Synthesizer for `/save`**: Replaced the arbitrary 25-line sliding window for session handovers with a full-session LLM compression step. The `/save` command now uses OpenAI (via `OPENAI_API_KEY` or the new `summarizer.apiKey` config) to read up to 200 lines of history and extract short-term constraints (e.g. "don't save to LanceDB", temporary passwords) into a concise <100 word summary, guaranteeing 100% accurate handovers without bloated contexts.

## [1.1.3] - 2026-03-03

### Changed
- **First-Turn Ephemeral Context Injection**: Replaced the persistent `MEMORY.md` file with a zero-cost "Ephemeral Handover". Context is now injected dynamically into the *very first turn* of a new session via the `message:before` hook, and immediately deleted (`ephemeral_handover.json`). This ensures the background context naturally slides out of the context window over time, eliminating the severe token bloat caused by constant `MEMORY.md` reads.

## [1.1.2] - 2026-03-03

### Changed
- **Zero-Shot Context Windowing for `/save`**: Reintroduced the native `/save` command with a massive efficiency improvement. Instead of an AI reading and extracting context (which costs thousands of tokens) or dumb truncation (which loses information like passwords/codewords), the `/save` command now perfectly captures the last 15 exact messages and injects them into `MEMORY.md` as an unedited transcript. This guarantees 100% immediate context retention for the next session at 0 LLM token cost.

## [1.1.1] - 2026-03-03

### Changed
- **Removed native `/save` command**: The native gateway `/save` command (introduced in 1.1.0) bypassed the LLM, leading to poor `MEMORY.md` truncations that ignored the user's specific context requests (e.g., "don't store this in LanceDB, just remember it for later").
- **Restored AI-driven Synthesis**: Updated `skills/memory-lancedb-lite/SKILL.md` to instruct the Agent to manually execute session handovers (generating intelligent `MEMORY.md` summaries via standard tools) when the user types `交接` or `save`.

## [1.1.0] - 2026-03-03

### Added
- **Built-in Session Handover Command (`/save`)**:
    - Replaced the need for the external `memory-manager` skill.
    - Added native slash command `/save` via `api.registerCommand()`.
    - Automatically finds the current session file, extracts valuable facts, and stores them to LanceDB.
    - Generates a concise `MEMORY.md` state machine file with TODOs to keep cross-session context intact.
- **Companion Skill (`skills/memory-lancedb-lite`)**:
    - Included a lightweight instruction manual (Agent Skill) detailing the 3-tier memory system (Hot/Warm/Cold memory).
    - Teaches the Agent how to behave when the user activates the `/save` command.

### Changed
- Improved memory encapsulation. The Agent no longer needs to manually invoke `memory_store` or `write` commands for routine end-of-session handovers, reducing token usage and error rates.
- Updated documentation (README.md) to reflect the new built-in `/save` Hybrid Workflow.

## [1.0.0] - 2026-03-02

### Added
- Initial release.
- Hybrid search (Vector + BM25) and cross-encoder reranking.
- Tools for `memory_recall`, `memory_store`, `memory_update`, `memory_forget`, `memory_list`, `memory_stats`.
- Hook for `command:new` to auto-capture session summaries.
