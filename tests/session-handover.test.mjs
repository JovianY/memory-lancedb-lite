import test from "node:test";
import assert from "node:assert/strict";

import {
  parseAgentIdFromSessionKey,
  resolveSessionContextFromCommandCtx,
  getSessionKeyForHandoverWrite,
  getEphemeralHandoverPath,
} from "../dist/session-utils.js";

test("parseAgentIdFromSessionKey extracts agent id", () => {
  assert.equal(parseAgentIdFromSessionKey("agent:coder:discord:channel:123"), "coder");
  assert.equal(parseAgentIdFromSessionKey("agent:main:main"), "main");
  assert.equal(parseAgentIdFromSessionKey("discord:channel:123"), undefined);
});

test("resolveSessionContextFromCommandCtx resolves session id from session store", () => {
  const sessionStore = {
    "agent:coder:discord:channel:999": { id: "sess-abc" },
  };
  const resolved = resolveSessionContextFromCommandCtx(
    { to: "agent:coder:discord:channel:999" },
    sessionStore,
  );

  assert.equal(resolved.agentId, "coder");
  assert.equal(resolved.sessionKey, "agent:coder:discord:channel:999");
  assert.equal(resolved.sessionId, "sess-abc");
});

test("resolveSessionContextFromCommandCtx falls back to explicit sessionId", () => {
  const resolved = resolveSessionContextFromCommandCtx(
    { to: "agent:main:main", sessionId: "manual-session-id" },
    {},
  );

  assert.equal(resolved.agentId, "main");
  assert.equal(resolved.sessionId, "manual-session-id");
});

test("resolveSessionContextFromCommandCtx maps explicit sessionId back to session key when available", () => {
  const resolved = resolveSessionContextFromCommandCtx(
    { channel: "discord", sessionId: "sess-main-77" },
    {
      "agent:main:discord:channel:777": { id: "sess-main-77" },
    },
  );

  assert.equal(resolved.agentId, "main");
  assert.equal(resolved.sessionKey, "agent:main:discord:channel:777");
  assert.equal(resolved.sessionId, "sess-main-77");
});

test("resolveSessionContextFromCommandCtx infers discord session key from legacy command ctx", () => {
  const sessionStore = {
    "agent:main:discord:channel:1476802472071921666": { id: "sess-discord-1" },
  };
  const resolved = resolveSessionContextFromCommandCtx(
    { channel: "discord", to: "1476802472071921666" },
    sessionStore,
  );

  assert.equal(resolved.agentId, "main");
  assert.equal(resolved.sessionKey, "agent:main:discord:channel:1476802472071921666");
  assert.equal(resolved.sessionId, "sess-discord-1");
});

test("resolveSessionContextFromCommandCtx normalizes wrapped discord channel target", () => {
  const sessionStore = {
    "agent:main:discord:channel:1476802472071921666": { id: "sess-discord-2" },
  };
  const resolved = resolveSessionContextFromCommandCtx(
    { channel: "discord", to: "<#1476802472071921666>" },
    sessionStore,
  );

  assert.equal(resolved.sessionKey, "agent:main:discord:channel:1476802472071921666");
  assert.equal(resolved.sessionId, "sess-discord-2");
});

test("getSessionKeyForHandoverWrite prefers command session key candidates", () => {
  assert.equal(
    getSessionKeyForHandoverWrite({ to: "agent:main:discord:channel:123" }, "main"),
    "agent:main:discord:channel:123",
  );

  assert.equal(
    getSessionKeyForHandoverWrite({}, "planner"),
    "agent:planner:main",
  );
});

test("getEphemeralHandoverPath isolates different session keys", () => {
  const base = "/tmp/openclaw-test";
  const a = getEphemeralHandoverPath(base, "agent:main:discord:channel:aaa");
  const b = getEphemeralHandoverPath(base, "agent:main:discord:channel:bbb");

  assert.notEqual(a, b);
  assert.match(a, /ephemeral_handover\/[0-9a-f]{24}\.json$/);
  assert.match(b, /ephemeral_handover\/[0-9a-f]{24}\.json$/);
});
