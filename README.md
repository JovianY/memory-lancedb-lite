# memory-lancedb-lite

**Streamlined, security-hardened LanceDB memory plugin for [OpenClaw](https://github.com/openclaw/openclaw)**

Hybrid Retrieval (Vector + BM25) · Cross-Encoder Rerank · Multi-Scope Isolation

Based on [memory-lancedb-pro](https://github.com/win4r/memory-lancedb-pro), rewritten with security hardening and reduced attack surface.

## Supported Platforms

| OS | Architecture | Status |
|----|-------------|--------|
| **Ubuntu / Debian Linux** | x86_64, ARM64 | ✅ Primary target |
| **macOS** | x86_64, Apple Silicon (M1+) | ✅ Supported |
| **Windows** | x86_64 | ✅ Supported |

> **Requires:** Node.js 18+ (recommended: 22 LTS), npm 9+
>
> LanceDB uses platform-specific native binaries. The included `install.sh` script automatically detects your platform and installs the correct native modules.

## What's Different from memory-lancedb-pro?

| Area | Change |
|------|--------|
| **Security** | Strict input validation, path traversal protection, no `eval`/`exec`, pinned deps |
| **SQL safety** | UUID/scope validation before SQL interpolation, improved escaping |
| **Env vars** | Safe `${VAR}` resolution (strict regex, no ReDoS risk) |
| **File I/O** | Read-only access restricted to `~/.openclaw/`; no `writeFile`/`unlink` |
| **Removed** | CLI commands, migration tool, auto-backup, JSONL distillation |
| **Kept** | Full hybrid retrieval pipeline, all scoring stages, session memory, all 6 agent tools |

## Installation (Ubuntu / macOS / Windows WSL)

```bash
# 1. Clone into OpenClaw plugins directory
cd ~/.openclaw/plugins
git clone https://github.com/JovianY/memory-lancedb-lite.git

# 2. Run the installer (auto-detects platform, installs Node.js if needed, builds)
cd memory-lancedb-lite
chmod +x install.sh
./install.sh
```

The installer automatically:
- Detects your OS, architecture, and distro
- Installs Node.js 22 LTS if missing (via NodeSource / Homebrew / nvm)
- Installs build tools (`gcc`, `make`, `python3`) on Linux if needed
- Detects and replaces cross-platform native modules
- Builds TypeScript and validates all output files
- Checks your OpenClaw config and provides setup instructions

## Configuration

Add to your OpenClaw config (`~/.openclaw/config.json`):

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-lite": {
        "enabled": true,
        "config": {
          "embedding": {
            "apiKey": "${OPENAI_API_KEY}",
            "model": "text-embedding-3-small"
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
    }
  }
}
```

## Agent Tools

| Tool | Description |
|------|-------------|
| `memory_recall` | Search memories using hybrid retrieval |
| `memory_store` | Save information to long-term memory |
| `memory_forget` | Delete memories by ID or search |
| `memory_update` | Update existing memories in-place |
| `memory_stats` | Get memory statistics (optional) |
| `memory_list` | List recent memories (optional) |

## Security

- ❌ No `eval()`, `new Function()`, or dynamic code execution
- ❌ No `child_process.exec()` or `spawn`
- ❌ No hardcoded API keys or secrets
- ❌ No `writeFile` or `unlink` operations
- ✅ Path traversal protection on all file reads
- ✅ Input validation with length limits on all tools
- ✅ Strict UUID/scope validation before SQL interpolation
- ✅ HTTPS-only network requests with 5s timeout
- ✅ Dependencies pinned to exact versions

## License

MIT
