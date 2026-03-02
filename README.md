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

- Detects your OS, architecture, and distro
- Installs Node.js 22 LTS if missing (via NodeSource / Homebrew / nvm)
- Installs build tools (`gcc`, `make`, `python3`) on Linux if needed
- Detects and replaces cross-platform native modules
- Builds TypeScript and validates all output files
- Checks your OpenClaw config and provides setup instructions

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
        "version": "1.0.0",
        "installedAt": "2026-03-02T00:00:00.000Z"
      }
    }
  }
}
```

### Embedding provider examples

#### OpenAI (default)

```json
{
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "text-embedding-3-small"
  }
}
```

#### Google Gemini

Uses Google's OpenAI-compatible endpoint. Set `GEMINI_API_KEY` in your `.env` file.

```json
{
  "embedding": {
    "apiKey": "${GEMINI_API_KEY}",
    "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "model": "gemini-embedding-001"
  }
}
```

#### OpenRouter

```json
{
  "embedding": {
    "apiKey": "${OPENROUTER_API_KEY}",
    "baseURL": "https://openrouter.ai/api/v1",
    "model": "text-embedding-3-small"
  }
}
```

#### Ollama (local)

```json
{
  "embedding": {
    "apiKey": "ollama",
    "baseURL": "http://localhost:11434/v1",
    "model": "nomic-embed-text"
  }
}
```

### Config options reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `embedding.apiKey` | string | — | API key (supports `${ENV_VAR}` syntax) |
| `embedding.baseURL` | string | OpenAI | Custom API endpoint for non-OpenAI providers |
| `embedding.model` | string | — | Embedding model name |
| `embedding.dimensions` | number | auto | Override vector dimensions (auto-detected for known models) |
| `autoCapture` | boolean | `false` | Automatically capture important info from conversations |
| `autoRecall` | boolean | `false` | Automatically search memories on each message |
| `sessionMemory.enabled` | boolean | `false` | Enable session-level memory tracking |
| `sessionMemory.messageCount` | number | `10` | Number of messages to include in session context |
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
