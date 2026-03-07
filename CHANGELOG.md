# Changelog

All notable changes to `memory-lancedb-lite` will be documented in this file.

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
