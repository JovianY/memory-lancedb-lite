#!/usr/bin/env bash
set -euo pipefail

RUN_TAG="$(date +%s)"
SESSION_KEY="agent:main:openai-user:e2e-save-smoke-${RUN_TAG}"
MARKER="E2E_SAVE_MARKER_$(cat /proc/sys/kernel/random/uuid | cut -c1-8)"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
SESSIONS_DIR="${STATE_DIR}/agents/main/sessions"
SESSIONS_JSON="${SESSIONS_DIR}/sessions.json"
PATCH_FILE="$(mktemp)"

cat > "$PATCH_FILE" <<'JS'
const os = require("node:os");
const original = os.networkInterfaces;
os.networkInterfaces = function patchedNetworkInterfaces(...args) {
  try {
    return original.apply(this, args);
  } catch {
    return {};
  }
};
JS

HANDOVER_HASH="$(node -e 'const c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(process.argv[1].toLowerCase()).digest("hex").slice(0,24));' "$SESSION_KEY")"
HANDOVER_PATH="${STATE_DIR}/memory/lancedb-lite/ephemeral_handover/${HANDOVER_HASH}.json"

extract_run_id() {
  node -e '
    const fs = require("node:fs");
    const t = fs.readFileSync(0, "utf8");
    const j = JSON.parse(t);
    const runId = j?.runId || j?.result?.runId || j?.payload?.runId || j?.data?.runId || "";
    process.stdout.write(runId);
  '
}

cleanup() {
  rm -f "$HANDOVER_PATH" || true
  rm -f "$PATCH_FILE" || true
  if [[ -f "$SESSIONS_JSON" ]]; then
    node - "$SESSIONS_JSON" "$SESSION_KEY" "$SESSIONS_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const sessionsJsonPath = process.argv[2];
const sessionKey = process.argv[3];
const sessionsDir = process.argv[4];

try {
  const raw = fs.readFileSync(sessionsJsonPath, "utf8");
  const parsed = JSON.parse(raw);
  const store = (parsed && typeof parsed === "object" && parsed.sessions && typeof parsed.sessions === "object")
    ? parsed.sessions
    : parsed;
  if (!store || typeof store !== "object") process.exit(0);
  const entry = store[sessionKey] || store[sessionKey.toLowerCase()];
  const sid = entry?.id || entry?.sessionId;
  delete store[sessionKey];
  delete store[sessionKey.toLowerCase()];
  fs.writeFileSync(sessionsJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  if (sid && typeof sid === "string") {
    for (const name of fs.readdirSync(sessionsDir)) {
      if (name === `${sid}.jsonl` || name.startsWith(`${sid}-topic-`)) {
        fs.rmSync(path.join(sessionsDir, name), { force: true });
      }
    }
  }
} catch {}
NODE
  fi
  echo "[e2e] cleanup completed."
}
trap cleanup EXIT

wait_for_file_state() {
  local path="$1"
  local should_exist="$2"
  local timeout_sec="$3"
  local start now
  start="$(date +%s)"
  while true; do
    if [[ "$should_exist" == "1" && -f "$path" ]]; then
      return 0
    fi
    if [[ "$should_exist" == "0" && ! -f "$path" ]]; then
      return 0
    fi
    now="$(date +%s)"
    if (( now - start >= timeout_sec )); then
      return 1
    fi
    sleep 0.5
  done
}

gateway_call() {
  local method="$1"
  local params="$2"
  local attempt output err_file
  local call_timeout_sec="${OPENCLAW_E2E_GATEWAY_CALL_TIMEOUT_SEC:-20}"
  local last_reason="unknown"
  local rc=0
  err_file="$(mktemp)"
  for attempt in 1 2 3 4 5 6; do
    set +e
    output="$(timeout "${call_timeout_sec}s" env NODE_OPTIONS="--require $PATCH_FILE ${NODE_OPTIONS:-}" openclaw gateway call "$method" --json --params "$params" 2>"$err_file")"
    rc=$?
    set -e
    if [[ "$rc" -eq 0 ]]; then
      rm -f "$err_file"
      printf '%s' "$output"
      return 0
    fi
    if [[ "$rc" -eq 124 ]]; then
      last_reason="timeout"
      sleep 1
      continue
    fi
    if grep -q "uv_interface_addresses returned Unknown system error 1" "$err_file"; then
      last_reason="uv_interface_addresses"
      sleep 1
      continue
    fi
    if grep -q "gateway closed" "$err_file"; then
      last_reason="gateway_closed"
      sleep 1
      continue
    fi
    last_reason="non_retryable_error"
    cat "$err_file" >&2
    rm -f "$err_file"
    return 1
  done
  echo "[e2e] gateway_call failed after retries: method=${method} reason=${last_reason}" >&2
  cat "$err_file" >&2
  rm -f "$err_file"
  return 1
}

wait_run_if_present() {
  local raw="$1"
  local run_id
  run_id="$(printf '%s' "$raw" | extract_run_id)"
  if [[ -n "$run_id" ]]; then
    gateway_call "agent.wait" "$(node -e 'console.log(JSON.stringify({runId: process.argv[1], timeoutMs: 120000}))' "$run_id")" >/dev/null
  fi
}

echo "[e2e] sessionKey=${SESSION_KEY}"
echo "[e2e] handoverPath=${HANDOVER_PATH}"
echo "[e2e] marker=${MARKER}"

# Warm up CLI/gateway call path to reduce transient init failures on some hosts.
gateway_call "status" "{}" >/dev/null

seed_params="$(node -e 'console.log(JSON.stringify({sessionKey: process.argv[1], message: process.argv[2], idempotencyKey: process.argv[3], deliver: false, timeoutMs: 120000}))' "$SESSION_KEY" "E2E save smoke test. ${MARKER}. 請記住這是交接測試上下文。" "e2e-seed-${RUN_TAG}")"
seed_out="$(gateway_call "chat.send" "$seed_params")"
wait_run_if_present "$seed_out"

save_params="$(node -e 'console.log(JSON.stringify({sessionKey: process.argv[1], message: "/save", idempotencyKey: process.argv[2], deliver: false, timeoutMs: 120000}))' "$SESSION_KEY" "e2e-save-${RUN_TAG}")"
save_out="$(gateway_call "chat.send" "$save_params")"
wait_run_if_present "$save_out"

if ! wait_for_file_state "$HANDOVER_PATH" "1" "20"; then
  echo "[e2e] FAIL: handover file not created: $HANDOVER_PATH" >&2
  exit 1
fi

node - "$HANDOVER_PATH" "$SESSION_KEY" <<'NODE'
const fs = require("node:fs");
const handoverPath = process.argv[2];
const sessionKey = process.argv[3];
const raw = fs.readFileSync(handoverPath, "utf8");
const data = JSON.parse(raw);
if (!data || typeof data.context !== "string" || !data.context.trim()) {
  throw new Error("handover context missing");
}
if (data.sessionKey !== sessionKey) {
  throw new Error(`handover sessionKey mismatch: ${data.sessionKey}`);
}
NODE

follow_params="$(node -e 'console.log(JSON.stringify({sessionKey: process.argv[1], message: "這是新回合第一句，請繼續。", idempotencyKey: process.argv[2], deliver: false, timeoutMs: 120000}))' "$SESSION_KEY" "e2e-follow-${RUN_TAG}")"
follow_out="$(gateway_call "chat.send" "$follow_params")"
wait_run_if_present "$follow_out"

if ! wait_for_file_state "$HANDOVER_PATH" "0" "20"; then
  echo "[e2e] FAIL: handover file not consumed/removed: $HANDOVER_PATH" >&2
  exit 1
fi

history_params="$(node -e 'console.log(JSON.stringify({sessionKey: process.argv[1], limit: 20}))' "$SESSION_KEY")"
history_out="$(gateway_call "chat.history" "$history_params")"
if [[ "$history_out" != *"交接儲存成功"* ]]; then
  echo "[e2e] FAIL: history missing save success signal." >&2
  exit 1
fi

echo "[e2e] PASS: /save smoke test completed."
