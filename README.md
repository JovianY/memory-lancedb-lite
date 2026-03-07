# memory-lancedb-lite

**Lightweight LanceDB memory plugin for [OpenClaw](https://github.com/openclaw/openclaw)**

Hybrid Retrieval (Vector + BM25) · Cross-Encoder Rerank · Multi-Scope Isolation

Inspired by [memory-lancedb-pro](https://github.com/win4r/memory-lancedb-pro) — streamlined for easy deployment.

## Supported Platforms

| OS | Architecture | Status |
|----|-------------|--------|
| **Ubuntu / Debian Linux** | x86_64, ARM64 | ✅ Primary target |
| **macOS** | x86_64, Apple Silicon (M1+) | ✅ Supported |
| **Windows** | x86_64 | ✅ Supported |

> **Requires:** Node.js 18+ (recommended: 22 LTS), npm 9+
>
> LanceDB uses platform-specific native binaries. The included `install.sh` script automatically detects your platform and installs the correct native modules.

## Features

| Area | Description |
|------|-------------|
| **Hybrid Retrieval** | Full vector + BM25 search pipeline with cross-encoder reranking |
| **Security** | Strict input validation, path traversal protection, pinned dependencies |
| **SQL Safety** | UUID/scope validation before SQL interpolation, safe escaping |
| **Env Vars** | Safe `${VAR}` resolution with strict regex |
| **File Safety** | Read-only access restricted to `~/.openclaw/`; no destructive file operations |
| **Lightweight** | Focused on core retrieval and storage — no CLI, no migration tool, no auto-backup |
| **All 6 Tools** | `memory_recall`, `memory_store`, `memory_forget`, `memory_update`, `memory_stats`, `memory_list` |
## How It Works

This plugin solves both short-term context loss and long-term knowledge retention natively.

### Short-Term Context (Session Memory)
When you chat with OpenClaw, the plugin automatically maintains a rolling window of your recent messages in-memory. If `sessionMemory.enabled` is `true`, the plugin will track the context of your active conversation without requiring tedious `micro_sync` scripts or constant reads/writes to local Markdown files. 

### Long-Term Retention (Vector Storage)
If `autoCapture` and `autoRecall` are enabled, the plugin works behind the scenes to:
1. **Auto-Capture (v1)**: Automatically capture useful user messages into memory with noise filtering and vector deduplication.
2. **Auto-Recall**: Automatically retrieve relevant past memories from LanceDB and inject them into the agent's context window.
3. **Manual Memory Tools**: Use `memory_store` / `memory_update` / `memory_forget` for explicit control.

`captureAssistant` is optional (default: `false`). When enabled, assistant messages can also be auto-captured.

You can also have the agent manually store (`memory_store`) or retrieve (`memory_recall`) information when specifically instructed.

## Best Practice: Hybrid Workflow
While LanceDB handles long-term facts, navigating between continuous tasks across days works best when combined with Ephemeral Context for active debugging and session continuity.

1. **The Notebook (Long-Term Vector DB)**: Rely on `memory-lancedb-lite` for persisting facts and rules. (e.g., auto-capture or manual `memory_store`).
2. **The Whisper (First-Turn Injection)**: Use `/save` to pass short-term state safely into the next session without permanently bloating your context window.

**✨ First-Turn Context Injection Command (`/save`)**
Writing raw transcripts to a `MEMORY.md` file causes severe Context Bloat (the entire transcript gets repeated on *every single turn* of your next session, wasting thousands of tokens). 

To solve this, `/save` uses an **LLM State Synthesizer** coupled with **First-Turn Ephemeral Injection**:
> `/save`

The gateway will intercept this command and carefully execute a **State Fragment Extraction**:
1. **Targeted Session Lock:** It identifies the exact session channel you are currently chatting in.
2. **Full-Session Synthesis:** It spins up an internal Summarizer LLM to scan all messages in the session log. It explicitly instructs the model to compress the history into a "State Fragment", preserving your identity, pending plans, and conversational constraints.
3. It replies with a success message (e.g., "交接儲存成功！" / "Handover saved!"), letting you know it's safe to switch to a new chat interface.

When you start the new session and say your first message, the gateway intercepts it and **injects the condensed summary precisely once** into the Prompt. The agent instantly understands the constraints of the previous session. As the conversation progresses, this context naturally slides out of the window, guaranteeing 100% context fidelity at exactly 0 long-term token waste.

## Testing Your Memory

To verify your memory is functioning correctly, try the following tests inside an OpenClaw session:

### Test 1: Short-Term Session Memory
*Checks if the agent can remember within the same chat session without saving to long-term storage.*
1. Say: *"Let's play a game. My secret codeword is 'Purple Elephant'. Don't write it to long-term memory."*
2. Ask unrelated questions or ask it to do a small task.
3. Ask: *"What was my secret codeword?"*
If it correctly says "Purple Elephant," session memory is actively working.

### Test 2: Long-Term Vector Memory
*Checks if the agent successfully stores and retrieves across completely new chat boundaries.*
1. Say: *"Please keep this in your long-term memory: My favorite pizza topping is extra jalapeños."*
2. Confirm the agent replied that it successfully stored the information.
3. Start a completely new chat session by typing `/new` (this wipes the short-term context).
4. Ask: *"Do you remember what my favorite pizza topping is?"*
If it correctly retrieves "extra jalapeños," the LanceDB integration is functioning perfectly!
## Quick Start

```bash
# 1. Clone into OpenClaw extensions directory
cd ~/.openclaw/workspace/extensions-dev
git clone https://github.com/JovianY/memory-lancedb-lite.git

# 2. Run the installer
cd memory-lancedb-lite
chmod +x install.sh
./install.sh

# 3. Configure (see Configuration section below)
# 4. Restart OpenClaw
```

### What the installer does
The `install.sh` script automatically detects your platform, installs Node.js if missing, builds native LanceDB modules, and helps configure `openclaw.json`.

## Migrating from Other Memory Plugins

If you are currently using another memory plugin (e.g., `memory-hybrid`, `memory-core`, `memory-lancedb`), you **must** disable it before enabling `memory-lancedb-lite`. OpenClaw's `plugins.slots.memory` only allows **one** active memory plugin at a time.

### Step 1: Disable existing memory plugins

In your `openclaw.json`, set the old plugin to `enabled: false`:

```jsonc
{
  "plugins": {
    "entries": {
      // Disable the old memory plugin
      "memory-hybrid": { "enabled": false },
      // Enable memory-lancedb-lite
      "memory-lancedb-lite": { "enabled": true, "config": { /* ... */ } }
    },
    "slots": {
      // Point the memory slot to the new plugin
      "memory": "memory-lancedb-lite"
    }
  }
}
```

### Step 2: Update related skills (if applicable)

If you have custom OpenClaw skills that manage memories by reading/writing files directly, consider updating them to use the plugin's agent tools instead:

- **`memory_recall`** — search and retrieve stored memories
- **`memory_store`** — save new information to long-term memory
- **`memory_update`** — modify existing memories
- **`memory_forget`** — delete memories no longer needed

The plugin handles all persistence automatically — no cron jobs or manual file management required.

### Step 3: Restart OpenClaw

```bash
# systemd
systemctl --user restart openclaw-gateway.service

# or CLI
openclaw gateway restart
```

### Data migration

`memory-lancedb-lite` uses its own LanceDB database at `~/.openclaw/memory/lancedb-lite/`. Your old memories from previous plugins are **not** automatically migrated.

**How to migrate file-based memories (e.g., from `memory-core`):**
The easiest way to migrate is to ask your OpenClaw agent to do it for you! Open a new chat session and send a prompt like:

> *"I have just installed a new LanceDB memory plugin. Please read my old memory files (e.g., `MEMORY.md`, or the `.md` files in my `memory/` folder), extract the core facts, preferences, and important context about me, and use your `memory_store` tool to save them into your new long-term memory."*

> **Note:** Existing memories from `memory-hybrid` or `memory-core` remain in their original locations and are not deleted. You can switch back by reversing the config changes above.

## Supported Embedding Models

The plugin uses the OpenAI SDK under the hood, but supports **any provider with an OpenAI-compatible embeddings endpoint** via the `baseURL` option.

| Provider | Model | Dimensions | Config Key |
|----------|-------|-----------|------------|
| **OpenAI** | `text-embedding-3-small` | 1536 | `OPENAI_API_KEY` |
| **OpenAI** | `text-embedding-3-large` | 3072 | `OPENAI_API_KEY` |
| **Google Gemini** | `text-embedding-004` | 768 | `GEMINI_API_KEY` |
| **Google Gemini** | `gemini-embedding-001` | 3072 | `GEMINI_API_KEY` |
| **Nomic** | `nomic-embed-text` | 768 | — |
| **Jina** | `jina-embeddings-v5-text-small` | 1024 | — |
| **Jina** | `jina-embeddings-v5-text-nano` | 768 | — |
| **Local** | `all-MiniLM-L6-v2` | 384 | — |
| **Local** | `all-mpnet-base-v2` | 768 | — |
| **Local** | `BAAI/bge-m3` | 1024 | — |

> For models not listed above, set `embedding.dimensions` manually in config.

## Configuration

> **⚠️ Important (OpenClaw 2026.3.2+):**
> Since the 3/2 update, OpenClaw defaults to a restricted `"messaging"` profile. To allow this plugin to write ephemeral handover files (the `/save` command) and perform background vector database operations, you **must** set `"profile": "full"` for your agents in `openclaw.json`. Without this, the agent will appear to "forget" everything after a session reset.

Add the following to your OpenClaw config (`~/.openclaw/openclaw.json` or `~/.openclaw/config.json`).

You also need to add the plugin to `plugins.allow`, `plugins.load.paths`, and optionally set `plugins.slots.memory`.

### Full config example

```jsonc
{
  "plugins": {
    "allow": [
      // ... your other plugins ...
      "memory-lancedb-lite"
    ],
    "load": {
      "paths": [
        // ... your other plugin paths ...
        "/home/YOUR_USER/.openclaw/workspace/extensions-dev/memory-lancedb-lite"
      ]
    },
    "slots": {
      "memory": "memory-lancedb-lite"
    },
    "entries": {
      "memory-lancedb-lite": {
        "enabled": true,
        "config": {
          "embedding": {
            // See provider examples below
          },
          "autoCapture": true,
          "autoRecall": true,
          "sessionMemory": {
            "enabled": true,
            "messageCount": 15
          },
          "enableManagementTools": true
        }
      }
    },
    "installs": {
      "memory-lancedb-lite": {
        "source": "path",
        "sourcePath": "/home/YOUR_USER/.openclaw/workspace/extensions-dev/memory-lancedb-lite",
        "installPath": "/home/YOUR_USER/.openclaw/workspace/extensions-dev/memory-lancedb-lite",
        "version": "1.1.8",
        "installedAt": "2026-03-02T00:00:00.000Z"
      }
    }
  }
}
```

### Embedding provider examples

This plugin supports any OpenAI-compatible embeddings endpoint. Example config setups for `openclaw.json`:

```json
// OpenAI
"embedding": { "apiKey": "${OPENAI_API_KEY}", "model": "text-embedding-3-small" }

// Gemini
"embedding": { "apiKey": "${GEMINI_API_KEY}", "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai/", "model": "gemini-embedding-001" }

// Local Ollama
"embedding": { "apiKey": "ollama", "baseURL": "http://localhost:11434/v1", "model": "nomic-embed-text" }
```

### Config options reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `embedding.apiKey` | string | — | API key (supports `${ENV_VAR}` syntax) |
| `embedding.baseURL` | string | OpenAI | Custom API endpoint for non-OpenAI providers |
| `embedding.model` | string | — | Embedding model name |
| `embedding.dimensions` | number | auto | Override vector dimensions (auto-detected for known models) |
| `summarizer.apiKey` | string | `OPENCLAW_GATEWAY_TOKEN` or `OPENROUTER_API_KEY` | API key for `/save` session summarizer (depends on `summarizer.baseURL`) |
| `summarizer.model` | string | `gpt-4o-mini` | LLM model for session summarizer |
| `autoCapture` | boolean | `true` | Automatically capture useful user messages (noise-filtered + deduplicated) |
| `autoRecall` | boolean | `false` | Automatically search memories on each message |
| `captureAssistant` | boolean | `false` | Include assistant messages in auto-capture flow |
| `sessionMemory.enabled` | boolean | `false` | Enable session-level memory tracking |
| `sessionMemory.messageCount` | number | `15` | Number of recent messages used by `/save` summarization |
| `enableManagementTools` | boolean | `false` | Enable `memory_stats` and `memory_list` tools |

## Agent Tools

| Tool | Description |
|------|-------------|
| `memory_recall` | Search memories using hybrid retrieval (vector + BM25 + rerank) |
| `memory_store` | Save information to long-term memory |
| `memory_forget` | Delete memories by ID or search |
| `memory_update` | Update existing memories in-place |
| `memory_stats` | Get memory statistics (requires `enableManagementTools`) |
| `memory_list` | List recent memories (requires `enableManagementTools`) |

## Verify Installation

After restarting OpenClaw, check the logs for:

```
memory-lancedb-lite@1.0.0: plugin registered (db: ~/.openclaw/memory/lancedb-lite, model: ...)
memory-lancedb-lite: initialized successfully (embedding: OK, retrieval: OK, mode: hybrid, FTS: enabled)
```

### Quick test

1. Tell the agent: *"Please remember: my favorite color is blue"*
2. Start a new session (`/new`)
3. Ask: *"What is my favorite color?"*
4. If the agent answers correctly → memory is working! ✅

### Automated test commands

Use these commands as the standard regression entrypoints:

```bash
# Full suite: build + runtime smoke + deterministic tests + node:test compatibility + gateway e2e smoke
npm run test:all

# Recommended local CI/dev check when gateway is unstable or unavailable
npm run test:all:no-e2e

# Real gateway /save smoke only (uses active local gateway)
npm run test:all:e2e-only

# Runtime/install environment smoke (LanceDB native module + CRUD path)
npm run test:runtime:smoke

# Live external API smoke (real embedding + optional rerank endpoint)
npm run test:live:apis

# Include live API smoke inside all-suite
bash scripts/test-all.sh --no-e2e --with-live-apis
```

Notes:
- `test:all:e2e-only` and `test:e2e:save` exercise real `openclaw gateway call ...` flow.
- On hosts affected by known OpenClaw gateway instability (`uv_interface_addresses`, WebSocket `1006`, transient timeout), e2e may fail even when plugin logic is correct.
- The e2e script auto-cleans its synthetic session/handover artifacts after run.
- `test:live:apis` is env-driven and non-mock:
  - Embedding key: `MEMORY_LANCEDB_LIVE_EMBEDDING_API_KEY` (fallback: `GEMINI_API_KEY` / `OPENAI_API_KEY`)
  - Embedding model/baseURL: `MEMORY_LANCEDB_LIVE_EMBEDDING_MODEL`, `MEMORY_LANCEDB_LIVE_EMBEDDING_BASE_URL`
  - Rerank (optional but recommended): `MEMORY_LANCEDB_LIVE_RERANK_API_KEY`, `MEMORY_LANCEDB_LIVE_RERANK_ENDPOINT`, `MEMORY_LANCEDB_LIVE_RERANK_PROVIDER`, `MEMORY_LANCEDB_LIVE_RERANK_MODEL`
  - Set `MEMORY_LANCEDB_LIVE_STRICT=1` to fail on network/API connectivity issues; default behavior is `SKIP` when endpoint is unreachable.

### Coverage matrix (self-test)

- `tests/run-tests.mjs` (deterministic suite):
  - `/save` happy path: handover write + one-time injection consume
  - `/save` multi-agent route correctness
  - `/save` error injection: malformed `sessions.json` fail-closed
  - `/save` error injection: summarizer failure does not persist handover
- `tests/save-command.integration.test.mjs` (`node:test`):
  - same `/save` flows under `node:test` runner for compatibility checks
- `tests/index.behavior.test.mjs`:
  - plugin config guardrails (invalid config rejected)
  - auto-capture + auto-recall behavior flow
- `tests/tools.unit.test.mjs`:
  - all memory tools: `memory_recall`, `memory_store`, `memory_forget`, `memory_update`, `memory_stats`, `memory_list`
  - tool registration and management-tool gating
- `tests/retriever.unit.test.mjs`:
  - hybrid fusion scoring
  - vector fallback when FTS unavailable
  - cross-encoder rerank path
- `scripts/runtime-smoke.mjs`:
  - verifies LanceDB native module load on current host
  - validates runtime CRUD/search/list/stats/delete against temp DB
- `scripts/live-api-smoke.mjs`:
  - real external embedding API call (no mock)
  - real external rerank endpoint call (no mock, when rerank env is set)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Unsupported embedding model` | Add `embedding.dimensions` to config, or use a model from the supported list |
| `Environment variable XXX is not set` | Make sure the API key is set in `~/.openclaw/.env` |
| `Failed to generate embedding` | Check that `baseURL` and `apiKey` are correct for your provider |
| LanceDB native module errors | Re-run `./install.sh` to rebuild native modules for your platform |
| Plugin not loading | Ensure the plugin is in `plugins.allow`, `plugins.load.paths`, and `plugins.entries` |

## Design Principles

This plugin is designed to be easy to run:

- No `eval()`, `new Function()`, or dynamic code execution
- No `child_process.exec()` or `spawn`
- No hardcoded API keys or secrets
- No destructive file operations (`writeFile`, `unlink`)
- Path traversal protection on all file reads
- Input validation with length limits on all tools
- Strict UUID/scope validation before SQL interpolation
- HTTPS-only network requests with 5s timeout
- All dependencies pinned to exact versions

## License

MIT
