# Changelog

All notable changes to `memory-lancedb-lite` will be documented in this file.

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
