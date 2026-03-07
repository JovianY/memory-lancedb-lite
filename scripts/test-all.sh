#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODE="full"
case "${1:-}" in
  --no-e2e)
    MODE="no-e2e"
    ;;
  --e2e-only)
    MODE="e2e-only"
    ;;
  "")
    ;;
  *)
    echo "[test-all] unknown option: $1" >&2
    echo "usage: bash scripts/test-all.sh [--no-e2e|--e2e-only]" >&2
    exit 2
    ;;
esac

run_step() {
  local name="$1"
  shift
  local start
  start="$(date +%s)"
  echo "[test-all] START ${name}"
  "$@"
  local end
  end="$(date +%s)"
  echo "[test-all] PASS  ${name} ($((end - start))s)"
}

gateway_preflight_soft() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if openclaw gateway status >/dev/null 2>&1; then
      echo "[test-all] PASS  gateway-preflight-soft (attempt=${attempt})"
      return 0
    fi
    sleep 1
  done
  echo "[test-all] WARN  gateway-preflight-soft failed after retries; continue to e2e smoke." >&2
  return 0
}

cd "$ROOT_DIR"

if [[ "$MODE" != "e2e-only" ]]; then
  run_step "build" npm run build
  run_step "deterministic-suite" node tests/run-tests.mjs
  run_step "node-test-compat" node --test tests/session-handover.test.mjs tests/save-command.integration.test.mjs
fi

if [[ "$MODE" != "no-e2e" ]]; then
  gateway_preflight_soft
  run_step "save-e2e-smoke" bash scripts/e2e-save-smoke.sh
fi

echo "[test-all] all requested suites passed (mode=${MODE})"
