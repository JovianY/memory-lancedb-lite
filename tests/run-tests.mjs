import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";

import memoryPlugin from "../dist/index.js";
import {
  parseAgentIdFromSessionKey,
  resolveSessionContextFromCommandCtx,
  getSessionKeyForHandoverWrite,
  getEphemeralHandoverPath,
} from "../dist/session-utils.js";

function jsonlMessage(role, content) {
  return JSON.stringify({ type: "message", message: { role, content } });
}

async function withTempHome(run) {
  const root = await mkdtemp(join(tmpdir(), "memory-lancedb-lite-test-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  try {
    await run(root);
  } finally {
    process.env.HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
}

function installFetchSummarizerMock({ onRequest, fail = false }) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url;
    if (typeof url === "string" && url.includes("/chat/completions")) {
      const rawBody = init?.body;
      const bodyText = typeof rawBody === "string"
        ? rawBody
        : rawBody instanceof Uint8Array
          ? Buffer.from(rawBody).toString("utf8")
          : "";
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      requests.push(parsed);
      if (onRequest) onRequest(parsed);

      if (fail) {
        return new Response("mock summarizer failure", { status: 500, headers: { "content-type": "text/plain" } });
      }

      return new Response(JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "mock-model",
        choices: [{ index: 0, message: { role: "assistant", content: "這是測試交接摘要" }, finish_reason: "stop" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (typeof originalFetch === "function") {
      return originalFetch(input, init);
    }
    throw new Error(`unexpected fetch call without original fetch: ${String(url)}`);
  };

  return {
    baseURL: "https://mock.local/v1",
    requests,
    close: async () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function buildFakeApi({ pluginConfig }) {
  const commands = [];
  const hooks = [];
  const api = {
    config: {
      plugins: {
        entries: {
          "memory-lancedb-lite": { config: pluginConfig },
        },
      },
      gateway: { auth: { token: "gateway-test-token" } },
    },
    logger: { info() { }, warn() { }, debug() { }, error() { } },
    registerTool() { },
    registerCommand(command) { commands.push(command); },
    registerService() { },
    on(name, handler) { hooks.push({ name, handler }); },
  };
  return { api, commands, hooks };
}

async function writeSessionFiles({
  home,
  agentId,
  sessionKey,
  sessionId,
  messages,
  rawSessionsJson,
  fileName,
}) {
  const sessionsDir = join(home, ".openclaw", "agents", agentId, "sessions");
  await mkdir(sessionsDir, { recursive: true });

  const sessionsJson = rawSessionsJson ?? JSON.stringify({
    sessions: { [sessionKey]: { id: sessionId } },
  });
  await writeFile(join(sessionsDir, "sessions.json"), sessionsJson, "utf8");

  const targetFile = fileName || `${sessionId}.jsonl`;
  await writeFile(join(sessionsDir, targetFile), messages.join("\n") + "\n", "utf8");
  return { sessionsDir, targetFile };
}

function getSaveHandler(commands) {
  const save = commands.find((c) => c.name === "save");
  assert.ok(save, "expected /save command to be registered");
  return save.handler;
}

function getBeforePromptBuildHook(hooks) {
  const hook = hooks.find((h) => h.name === "before_prompt_build");
  assert.ok(hook, "expected before_prompt_build hook to be registered");
  return hook.handler;
}

async function assertPathMissing(path) {
  try {
    await stat(path);
    assert.fail(`expected missing path: ${path}`);
  } catch (err) {
    assert.equal(err?.code, "ENOENT");
  }
}

const tests = [];
function addTest(name, fn) {
  tests.push({ name, fn });
}

addTest("session-utils basics", async () => {
  assert.equal(parseAgentIdFromSessionKey("agent:coder:discord:channel:123"), "coder");
  assert.equal(parseAgentIdFromSessionKey("agent:main:main"), "main");
  assert.equal(parseAgentIdFromSessionKey("discord:channel:123"), undefined);

  const sessionStore = { "agent:coder:discord:channel:999": { id: "sess-abc" } };
  const resolved = resolveSessionContextFromCommandCtx(
    { to: "agent:coder:discord:channel:999" },
    sessionStore,
  );
  assert.equal(resolved.agentId, "coder");
  assert.equal(resolved.sessionId, "sess-abc");

  const resolvedLegacy = resolveSessionContextFromCommandCtx(
    { channel: "discord", to: "1476802472071921666" },
    { "agent:main:discord:channel:1476802472071921666": { id: "sess-discord-1" } },
  );
  assert.equal(resolvedLegacy.sessionId, "sess-discord-1");

  const resolvedWrapped = resolveSessionContextFromCommandCtx(
    { channel: "discord", to: "<#1476802472071921666>" },
    { "agent:main:discord:channel:1476802472071921666": { id: "sess-discord-2" } },
  );
  assert.equal(resolvedWrapped.sessionId, "sess-discord-2");

  const resolvedBySessionId = resolveSessionContextFromCommandCtx(
    { channel: "discord", sessionId: "sess-discord-3" },
    { "agent:main:discord:channel:1476802472071921667": { id: "sess-discord-3" } },
  );
  assert.equal(resolvedBySessionId.sessionKey, "agent:main:discord:channel:1476802472071921667");
  assert.equal(resolvedBySessionId.sessionId, "sess-discord-3");

  assert.equal(
    getSessionKeyForHandoverWrite({ to: "agent:main:discord:channel:123" }, "main"),
    "agent:main:discord:channel:123",
  );
  assert.equal(getSessionKeyForHandoverWrite({}, "planner"), "agent:planner:main");
});

addTest("user scenario: /save then one-time injection", async () => {
  await withTempHome(async (home) => {
    const sessionKey = "agent:main:discord:channel:1001";
    const sessionId = "sess-main-001";
    const summarizer = installFetchSummarizerMock({ onRequest: null });
    try {
      await writeSessionFiles({
        home,
        agentId: "main",
        sessionKey,
        sessionId,
        messages: [
          jsonlMessage("assistant", "<previous-session-handoff>舊交接</previous-session-handoff>"),
          jsonlMessage("user", "請記住我正在修復 API bug，等等要先補測試"),
          jsonlMessage("assistant", "收到，我會先補測試"),
        ],
      });

      const { api, commands, hooks } = buildFakeApi({
        pluginConfig: {
          embedding: { provider: "openai-compatible", apiKey: "test-key", model: "text-embedding-3-small" },
          autoCapture: false,
          autoRecall: false,
          enableManagementTools: false,
          sessionMemory: { enabled: true, messageCount: 15 },
          summarizer: { baseURL: summarizer.baseURL, model: "mock-model", apiKey: "mock-key" },
        },
      });

      await memoryPlugin.register(api);
      const saveHandler = getSaveHandler(commands);
      const reply = await saveHandler({ to: sessionKey, channel: "discord", commandBody: "/save" });
      assert.match(reply.text, /交接儲存成功/);

      const handoverPath = getEphemeralHandoverPath(join(home, ".openclaw"), sessionKey);
      const stored = JSON.parse(await readFile(handoverPath, "utf8"));
      assert.equal(stored.sessionKey, sessionKey);
      assert.equal(stored.context, "這是測試交接摘要");

      const beforePromptBuild = getBeforePromptBuildHook(hooks);
      const injected = await beforePromptBuild(
        { messages: [{ role: "user", content: "新對話第一句" }] },
        { sessionKey, sessionId: "new-session-1" },
      );
      assert.ok(injected?.prependContext?.includes("這是測試交接摘要"));
      await assertPathMissing(handoverPath);
    } finally {
      await summarizer.close();
    }
  });
});

addTest("multi-agent scenario: /save uses target agent session", async () => {
  await withTempHome(async (home) => {
    const mainKey = "agent:main:discord:channel:2001";
    const coderKey = "agent:coder:discord:channel:9009";
    let observedPrompt = "";
    const summarizer = installFetchSummarizerMock({
      onRequest: (payload) => { observedPrompt = payload?.messages?.[0]?.content || ""; },
    });
    try {
      await writeSessionFiles({
        home,
        agentId: "main",
        sessionKey: mainKey,
        sessionId: "sess-main-002",
        messages: [jsonlMessage("user", "MAIN_ONLY_CONTEXT")],
      });
      await writeSessionFiles({
        home,
        agentId: "coder",
        sessionKey: coderKey,
        sessionId: "sess-coder-001",
        messages: [jsonlMessage("user", "CODER_ONLY_CONTEXT")],
      });

      const { api, commands } = buildFakeApi({
        pluginConfig: {
          embedding: { provider: "openai-compatible", apiKey: "test-key", model: "text-embedding-3-small" },
          autoCapture: false,
          autoRecall: false,
          enableManagementTools: false,
          sessionMemory: { enabled: true, messageCount: 15 },
          summarizer: { baseURL: summarizer.baseURL, model: "mock-model", apiKey: "mock-key" },
        },
      });

      await memoryPlugin.register(api);
      const saveHandler = getSaveHandler(commands);
      const reply = await saveHandler({ to: coderKey, channel: "discord", commandBody: "/save" });
      assert.match(reply.text, /交接儲存成功/);
      assert.match(observedPrompt, /CODER_ONLY_CONTEXT/);
      assert.doesNotMatch(observedPrompt, /MAIN_ONLY_CONTEXT/);
    } finally {
      await summarizer.close();
    }
  });
});

addTest("error injection: malformed sessions.json fails closed without session fallback", async () => {
  await withTempHome(async (home) => {
    let observedPrompt = "";
    const summarizer = installFetchSummarizerMock({
      onRequest: (payload) => { observedPrompt = payload?.messages?.[0]?.content || ""; },
    });
    try {
      const sessionsDir = join(home, ".openclaw", "agents", "main", "sessions");
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(sessionsDir, "sessions.json"), "{broken-json", "utf8");

      const oldFile = join(sessionsDir, "valid-old.jsonl");
      const newFile = join(sessionsDir, "valid-new.jsonl");
      await writeFile(oldFile, `${jsonlMessage("user", "OLD_VALID_CONTEXT")}\n`, "utf8");
      await writeFile(newFile, `${jsonlMessage("user", "NEWEST_VALID_CONTEXT")}\n`, "utf8");
      await writeFile(join(sessionsDir, "test-noise.jsonl"), `${jsonlMessage("user", "TEST_NOISE")}\n`, "utf8");
      const now = Date.now() / 1000;
      await utimes(oldFile, now - 60, now - 60);
      await utimes(newFile, now, now);

      const { api, commands } = buildFakeApi({
        pluginConfig: {
          embedding: { provider: "openai-compatible", apiKey: "test-key", model: "text-embedding-3-small" },
          autoCapture: false,
          autoRecall: false,
          enableManagementTools: false,
          sessionMemory: { enabled: true, messageCount: 15 },
          summarizer: { baseURL: summarizer.baseURL, model: "mock-model", apiKey: "mock-key" },
        },
      });

      await memoryPlugin.register(api);
      const saveHandler = getSaveHandler(commands);
      const reply = await saveHandler({ channel: "discord", commandBody: "/save" });
      assert.match(reply.text, /交接失敗/);
      assert.match(reply.text, /Unable to resolve current session ID/);
      assert.equal(observedPrompt, "");
    } finally {
      await summarizer.close();
    }
  });
});

addTest("error injection: summarizer failure returns error and no handover file", async () => {
  await withTempHome(async (home) => {
    const sessionKey = "agent:main:discord:channel:3001";
    const summarizer = installFetchSummarizerMock({ fail: true });
    try {
      await writeSessionFiles({
        home,
        agentId: "main",
        sessionKey,
        sessionId: "sess-main-003",
        messages: [jsonlMessage("user", "這段會觸發失敗注入")],
      });

      const { api, commands } = buildFakeApi({
        pluginConfig: {
          embedding: { provider: "openai-compatible", apiKey: "test-key", model: "text-embedding-3-small" },
          autoCapture: false,
          autoRecall: false,
          enableManagementTools: false,
          sessionMemory: { enabled: true, messageCount: 15 },
          summarizer: { baseURL: summarizer.baseURL, model: "mock-model", apiKey: "mock-key" },
        },
      });

      await memoryPlugin.register(api);
      const saveHandler = getSaveHandler(commands);
      const reply = await saveHandler({ to: sessionKey, channel: "discord", commandBody: "/save" });
      assert.match(reply.text, /交接失敗/);

      const handoverPath = getEphemeralHandoverPath(join(home, ".openclaw"), sessionKey);
      await assertPathMissing(handoverPath);
    } finally {
      await summarizer.close();
    }
  });
});

addTest("webchat /save fallback resolves agent:main:main session", async () => {
  await withTempHome(async (home) => {
    const sessionKey = "agent:main:main";
    const sessionId = "sess-main-webchat-001";
    const summarizer = installFetchSummarizerMock({ onRequest: null });
    try {
      await writeSessionFiles({
        home,
        agentId: "main",
        sessionKey,
        sessionId,
        messages: [
          jsonlMessage("user", "webchat fallback test"),
          jsonlMessage("assistant", "ok"),
        ],
      });

      const { api, commands } = buildFakeApi({
        pluginConfig: {
          embedding: { provider: "openai-compatible", apiKey: "test-key", model: "text-embedding-3-small" },
          autoCapture: false,
          autoRecall: false,
          enableManagementTools: false,
          sessionMemory: { enabled: true, messageCount: 15 },
          summarizer: { baseURL: summarizer.baseURL, model: "mock-model", apiKey: "mock-key" },
        },
      });

      await memoryPlugin.register(api);
      const saveHandler = getSaveHandler(commands);
      const reply = await saveHandler({ channel: "webchat", commandBody: "/save" });
      assert.match(reply.text, /交接儲存成功/);
    } finally {
      await summarizer.close();
    }
  });
});

addTest("sessionId-only /save persists under matched session key", async () => {
  await withTempHome(async (home) => {
    const sessionKey = "agent:main:discord:channel:4101";
    const sessionId = "sess-main-sessionid-only";
    const summarizer = installFetchSummarizerMock({ onRequest: null });
    try {
      await writeSessionFiles({
        home,
        agentId: "main",
        sessionKey,
        sessionId,
        messages: [jsonlMessage("user", "sessionId only path")],
      });

      const { api, commands } = buildFakeApi({
        pluginConfig: {
          embedding: { provider: "openai-compatible", apiKey: "test-key", model: "text-embedding-3-small" },
          autoCapture: false,
          autoRecall: false,
          enableManagementTools: false,
          sessionMemory: { enabled: true, messageCount: 15 },
          summarizer: { baseURL: summarizer.baseURL, model: "mock-model", apiKey: "mock-key" },
        },
      });

      await memoryPlugin.register(api);
      const saveHandler = getSaveHandler(commands);
      const reply = await saveHandler({ channel: "discord", sessionId, commandBody: "/save" });
      assert.match(reply.text, /交接儲存成功/);
      const handoverPath = getEphemeralHandoverPath(join(home, ".openclaw"), sessionKey);
      const stored = JSON.parse(await readFile(handoverPath, "utf8"));
      assert.equal(stored.sessionKey, sessionKey);
    } finally {
      await summarizer.close();
    }
  });
});

addTest("webchat /save fallback supports non-main agent", async () => {
  await withTempHome(async (home) => {
    const sessionKey = "agent:coder:main";
    const sessionId = "sess-coder-webchat-001";
    const summarizer = installFetchSummarizerMock({ onRequest: null });
    try {
      await writeSessionFiles({
        home,
        agentId: "coder",
        sessionKey,
        sessionId,
        messages: [jsonlMessage("user", "coder webchat fallback path")],
      });

      const { api, commands } = buildFakeApi({
        pluginConfig: {
          embedding: { provider: "openai-compatible", apiKey: "test-key", model: "text-embedding-3-small" },
          autoCapture: false,
          autoRecall: false,
          enableManagementTools: false,
          sessionMemory: { enabled: true, messageCount: 15 },
          summarizer: { baseURL: summarizer.baseURL, model: "mock-model", apiKey: "mock-key" },
        },
      });

      await memoryPlugin.register(api);
      const saveHandler = getSaveHandler(commands);
      const reply = await saveHandler({ channel: "webchat", agentId: "coder", commandBody: "/save" });
      assert.match(reply.text, /交接儲存成功/);
      const handoverPath = getEphemeralHandoverPath(join(home, ".openclaw"), sessionKey);
      const stored = JSON.parse(await readFile(handoverPath, "utf8"));
      assert.equal(stored.sessionKey, sessionKey);
    } finally {
      await summarizer.close();
    }
  });
});

addTest("legacy target-id /save inject path uses resolved session key", async () => {
  await withTempHome(async (home) => {
    const sessionKey = "agent:main:discord:channel:555001";
    const sessionId = "sess-main-legacy-target";
    const summarizer = installFetchSummarizerMock({ onRequest: null });
    try {
      await writeSessionFiles({
        home,
        agentId: "main",
        sessionKey,
        sessionId,
        messages: [jsonlMessage("user", "legacy channel id path")],
      });

      const { api, commands, hooks } = buildFakeApi({
        pluginConfig: {
          embedding: { provider: "openai-compatible", apiKey: "test-key", model: "text-embedding-3-small" },
          autoCapture: false,
          autoRecall: false,
          enableManagementTools: false,
          sessionMemory: { enabled: true, messageCount: 15 },
          summarizer: { baseURL: summarizer.baseURL, model: "mock-model", apiKey: "mock-key" },
        },
      });

      await memoryPlugin.register(api);
      const saveHandler = getSaveHandler(commands);
      const reply = await saveHandler({ channel: "discord", to: "555001", commandBody: "/save" });
      assert.match(reply.text, /交接儲存成功/);

      const handoverPath = getEphemeralHandoverPath(join(home, ".openclaw"), sessionKey);
      const stored = JSON.parse(await readFile(handoverPath, "utf8"));
      assert.equal(stored.sessionKey, sessionKey);

      const beforePromptBuild = getBeforePromptBuildHook(hooks);
      const injected = await beforePromptBuild(
        { messages: [{ role: "user", content: "下一句" }] },
        { sessionKey, sessionId: "new-session-legacy" },
      );
      assert.ok(injected?.prependContext?.includes("這是測試交接摘要"));
      await assertPathMissing(handoverPath);
    } finally {
      await summarizer.close();
    }
  });
});

async function main() {
  let passed = 0;
  for (const { name, fn } of tests) {
    const started = Date.now();
    try {
      let timer;
      await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout after 15000ms: ${name}`)), 15000);
        }),
      ]);
      clearTimeout(timer);
      passed++;
      console.log(`PASS ${name} (${Date.now() - started}ms)`);
    } catch (err) {
      console.error(`FAIL ${name} (${Date.now() - started}ms)`);
      console.error(err?.stack || err);
      process.exit(1);
    }
  }
  console.log(`All tests passed (${passed}/${tests.length}).`);
}

await main();
