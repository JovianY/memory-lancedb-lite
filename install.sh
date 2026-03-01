#!/usr/bin/env bash
#
# memory-lancedb-lite — One-command installer
# Usage: chmod +x install.sh && ./install.sh
#
# Automatically:
#   • Detects OS and architecture
#   • Installs Node.js 22 LTS if missing (via NodeSource or nvm)
#   • Detects and cleans cross-platform native modules
#   • Installs npm dependencies with correct native binaries
#   • Builds TypeScript
#   • Validates the build output
#

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PLUGIN_DIR"

# ═══════════════════════════════════════════════════
# Colors and helpers
# ═══════════════════════════════════════════════════

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}▸${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
fail()  { echo -e "${RED}✗${NC} $*"; exit 1; }

# ═══════════════════════════════════════════════════
# Banner
# ═══════════════════════════════════════════════════

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║${NC}   memory-lancedb-lite installer                  ${BLUE}║${NC}"
echo -e "${BLUE}║${NC}   Hybrid Retrieval · Rerank · Multi-Scope        ${BLUE}║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ═══════════════════════════════════════════════════
# 1. Platform detection
# ═══════════════════════════════════════════════════

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    PLATFORM="linux"
    if [ -f /etc/os-release ]; then
      DISTRO="$(. /etc/os-release && echo "$NAME $VERSION_ID")"
    else
      DISTRO="Linux (unknown distro)"
    fi
    ;;
  Darwin)
    PLATFORM="darwin"
    DISTRO="macOS $(sw_vers -productVersion 2>/dev/null || echo 'unknown')"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    PLATFORM="win32"
    DISTRO="Windows (MINGW/MSYS)"
    ;;
  *)
    PLATFORM="unknown"
    DISTRO="$OS"
    warn "Unknown OS: $OS — proceeding anyway"
    ;;
esac

info "Platform: ${DISTRO} (${ARCH})"

# ═══════════════════════════════════════════════════
# 2. Node.js — check or auto-install
# ═══════════════════════════════════════════════════

MIN_NODE_MAJOR=18
DESIRED_NODE_MAJOR=22

install_node_linux() {
  info "Installing Node.js ${DESIRED_NODE_MAJOR} LTS..."

  # Try NodeSource first (works on Ubuntu/Debian, RHEL/Fedora/Amazon Linux)
  if command -v apt-get &>/dev/null; then
    info "Detected apt — using NodeSource setup script"
    if ! command -v curl &>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y -qq curl ca-certificates
    fi
    curl -fsSL "https://deb.nodesource.com/setup_${DESIRED_NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y -qq nodejs
  elif command -v yum &>/dev/null; then
    info "Detected yum — using NodeSource setup script"
    if ! command -v curl &>/dev/null; then
      sudo yum install -y curl
    fi
    curl -fsSL "https://rpm.nodesource.com/setup_${DESIRED_NODE_MAJOR}.x" | sudo -E bash -
    sudo yum install -y nodejs
  elif command -v dnf &>/dev/null; then
    info "Detected dnf — using NodeSource setup script"
    if ! command -v curl &>/dev/null; then
      sudo dnf install -y curl
    fi
    curl -fsSL "https://rpm.nodesource.com/setup_${DESIRED_NODE_MAJOR}.x" | sudo -E bash -
    sudo dnf install -y nodejs
  else
    # Fallback: try nvm
    info "No apt/yum/dnf found — trying nvm"
    if [ ! -d "$HOME/.nvm" ]; then
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    fi
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    nvm install "$DESIRED_NODE_MAJOR"
    nvm use "$DESIRED_NODE_MAJOR"
  fi
}

install_node_mac() {
  info "Installing Node.js ${DESIRED_NODE_MAJOR} LTS..."

  if command -v brew &>/dev/null; then
    info "Detected Homebrew"
    brew install "node@${DESIRED_NODE_MAJOR}"
    brew link --overwrite "node@${DESIRED_NODE_MAJOR}" 2>/dev/null || true
  else
    # Fallback: nvm
    info "No Homebrew found — trying nvm"
    if [ ! -d "$HOME/.nvm" ]; then
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    fi
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    nvm install "$DESIRED_NODE_MAJOR"
    nvm use "$DESIRED_NODE_MAJOR"
  fi
}

# Check if node exists
if ! command -v node &>/dev/null; then
  warn "Node.js not found"

  case "$PLATFORM" in
    linux)  install_node_linux ;;
    darwin) install_node_mac ;;
    *)      fail "Cannot auto-install Node.js on $PLATFORM. Please install Node.js ${MIN_NODE_MAJOR}+ manually: https://nodejs.org/" ;;
  esac

  # Re-check
  if ! command -v node &>/dev/null; then
    fail "Node.js installation failed. Please install manually: https://nodejs.org/"
  fi
fi

NODE_VERSION_FULL="$(node -v | sed 's/v//')"
NODE_MAJOR="$(echo "$NODE_VERSION_FULL" | cut -d. -f1)"
info "Node.js: v${NODE_VERSION_FULL}"

if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  warn "Node.js ${MIN_NODE_MAJOR}+ required (found v${NODE_MAJOR})"

  case "$PLATFORM" in
    linux)  install_node_linux ;;
    darwin) install_node_mac ;;
    *)      fail "Please upgrade Node.js to ${MIN_NODE_MAJOR}+: https://nodejs.org/" ;;
  esac

  # Re-check
  NODE_VERSION_FULL="$(node -v | sed 's/v//')"
  NODE_MAJOR="$(echo "$NODE_VERSION_FULL" | cut -d. -f1)"
  if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
    fail "Node.js upgrade failed. Current: v${NODE_VERSION_FULL}, required: ${MIN_NODE_MAJOR}+"
  fi
  ok "Node.js upgraded to v${NODE_VERSION_FULL}"
fi

# Check npm
if ! command -v npm &>/dev/null; then
  fail "npm not found. It should come with Node.js. Please reinstall Node.js: https://nodejs.org/"
fi
info "npm: $(npm -v)"

# ═══════════════════════════════════════════════════
# 3. Build tools check (for native modules)
# ═══════════════════════════════════════════════════

if [ "$PLATFORM" = "linux" ]; then
  NEEDS_BUILD_TOOLS=false

  if ! command -v python3 &>/dev/null && ! command -v python &>/dev/null; then
    NEEDS_BUILD_TOOLS=true
  fi
  if ! command -v make &>/dev/null; then
    NEEDS_BUILD_TOOLS=true
  fi
  if ! command -v g++ &>/dev/null && ! command -v gcc &>/dev/null; then
    NEEDS_BUILD_TOOLS=true
  fi

  if [ "$NEEDS_BUILD_TOOLS" = true ]; then
    info "Installing build tools for native modules..."
    if command -v apt-get &>/dev/null; then
      sudo apt-get install -y -qq build-essential python3
    elif command -v yum &>/dev/null; then
      sudo yum groupinstall -y "Development Tools"
      sudo yum install -y python3
    elif command -v dnf &>/dev/null; then
      sudo dnf groupinstall -y "Development Tools"
      sudo dnf install -y python3
    else
      warn "Cannot auto-install build tools. If npm install fails, install gcc, make, and python3 manually."
    fi
  fi
fi

# ═══════════════════════════════════════════════════
# 4. Detect stale native modules (cross-platform copy)
# ═══════════════════════════════════════════════════

NEEDS_REINSTALL=false

if [ -d "node_modules/@lancedb" ]; then
  BINDING_FILE=$(find node_modules/@lancedb -name "*.node" -type f 2>/dev/null | head -1)

  if [ -n "$BINDING_FILE" ]; then
    if command -v file &>/dev/null; then
      BINDING_INFO="$(file "$BINDING_FILE" 2>/dev/null || echo "unknown")"

      case "$PLATFORM" in
        linux)
          if ! echo "$BINDING_INFO" | grep -qi "ELF"; then
            warn "LanceDB native module is NOT for Linux (found: $(echo "$BINDING_INFO" | head -c 60))"
            NEEDS_REINSTALL=true
          else
            ok "LanceDB native module matches platform"
          fi
          ;;
        darwin)
          if ! echo "$BINDING_INFO" | grep -qi "Mach-O"; then
            warn "LanceDB native module is NOT for macOS"
            NEEDS_REINSTALL=true
          else
            ok "LanceDB native module matches platform"
          fi
          ;;
        win32)
          if ! echo "$BINDING_INFO" | grep -qi "PE32"; then
            warn "LanceDB native module is NOT for Windows"
            NEEDS_REINSTALL=true
          else
            ok "LanceDB native module matches platform"
          fi
          ;;
        *)
          warn "Unknown platform — forcing reinstall to be safe"
          NEEDS_REINSTALL=true
          ;;
      esac
    else
      warn "'file' command not available — forcing reinstall to be safe"
      NEEDS_REINSTALL=true
    fi
  else
    info "No native binding found in node_modules"
    NEEDS_REINSTALL=true
  fi
elif [ ! -d "node_modules" ]; then
  info "No node_modules directory — fresh install needed"
  NEEDS_REINSTALL=true
else
  info "LanceDB not in node_modules — install needed"
  NEEDS_REINSTALL=true
fi

# ═══════════════════════════════════════════════════
# 5. Install dependencies
# ═══════════════════════════════════════════════════

echo ""
if [ "$NEEDS_REINSTALL" = true ]; then
  info "Cleaning stale modules..."
  rm -rf node_modules package-lock.json

  info "Installing dependencies (native modules may take a moment)..."
  npm install --no-audit --no-fund 2>&1 | tail -3
  ok "Dependencies installed"
else
  ok "Dependencies already installed for this platform"
fi

# ═══════════════════════════════════════════════════
# 6. Build TypeScript
# ═══════════════════════════════════════════════════

echo ""
info "Building TypeScript..."
rm -rf dist

if npx tsc 2>&1; then
  JS_COUNT=$(find dist -name "*.js" -type f | wc -l | tr -d ' ')
  DTS_COUNT=$(find dist -name "*.d.ts" -type f | wc -l | tr -d ' ')
  ok "Build complete: ${JS_COUNT} JS + ${DTS_COUNT} declarations"
else
  fail "TypeScript compilation failed. Check the errors above."
fi

# ═══════════════════════════════════════════════════
# 7. Verify build output
# ═══════════════════════════════════════════════════

if [ ! -f "dist/index.js" ]; then
  fail "dist/index.js not found — build may have failed silently"
fi

REQUIRED_FILES=("dist/index.js" "dist/store.js" "dist/embedder.js" "dist/retriever.js" "dist/tools.js" "dist/scopes.js" "dist/noise-filter.js" "dist/adaptive-retrieval.js")
MISSING=()
for f in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    MISSING+=("$f")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  fail "Missing build outputs: ${MISSING[*]}"
fi

# ═══════════════════════════════════════════════════
# 8. OpenClaw detection
# ═══════════════════════════════════════════════════

echo ""
OPENCLAW_DIR="$HOME/.openclaw"
OPENCLAW_CONFIG="$OPENCLAW_DIR/config.json"

if [ -d "$OPENCLAW_DIR" ]; then
  ok "OpenClaw directory found: $OPENCLAW_DIR"

  if [ -f "$OPENCLAW_CONFIG" ]; then
    if grep -q "memory-lancedb-lite" "$OPENCLAW_CONFIG" 2>/dev/null; then
      ok "Plugin already configured in config.json"
    else
      warn "Plugin not yet configured in $OPENCLAW_CONFIG"
      echo ""
      echo -e "  Add the following to your ${BLUE}config.json${NC} under ${BLUE}plugins.entries${NC}:"
      echo ""
      echo '    "memory-lancedb-lite": {'
      echo '      "enabled": true,'
      echo '      "config": {'
      echo '        "embedding": {'
      echo '          "apiKey": "${OPENAI_API_KEY}",'
      echo '          "model": "text-embedding-3-small"'
      echo '        },'
      echo '        "autoCapture": true,'
      echo '        "autoRecall": true,'
      echo '        "sessionMemory": { "enabled": true }'
      echo '      }'
      echo '    }'
    fi
  else
    warn "No config.json found at $OPENCLAW_CONFIG"
  fi
else
  warn "OpenClaw directory not found ($OPENCLAW_DIR). Is OpenClaw installed?"
fi

# ═══════════════════════════════════════════════════
# Done
# ═══════════════════════════════════════════════════

echo ""
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Installation complete!${NC}"
echo ""
echo -e "  Platform:  ${DISTRO} (${ARCH})"
echo -e "  Node.js:   v${NODE_VERSION_FULL}"
echo -e "  Plugin:    ${PLUGIN_DIR}"
echo ""
echo -e "  ${BLUE}Next steps:${NC}"
echo -e "    1. Configure the plugin in ~/.openclaw/config.json"
echo -e "    2. Set your embedding API key: export OPENAI_API_KEY=sk-..."
echo -e "    3. Restart OpenClaw"
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo ""
