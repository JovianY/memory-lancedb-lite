import test from "node:test";
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
import { getEphemeralHandoverPath } from "../dist/session-utils.js";

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
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "這是測試交接摘要" },
            finish_reason: "stop",
          },
        ],
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
  const services = [];
  const logs = [];
  const api = {
    config: {
      plugins: {
        entries: {
          "memory-lancedb-lite": {
            config: pluginConfig,
          },
        },
      },
      gateway: {
        auth: {
          token: "gateway-test-token",
        },
      },
    },
    logger: {
      info: (...args) => logs.push(["info", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
      debug: (...args) => logs.push(["debug", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
    registerTool() { },
    registerCommand(command) {
      commands.push(command);
    },
    registerService(service) {
      services.push(service);
    },
    on(name, handler) {
      hooks.push({ name, handler });
    },
  };
  return { api, commands, hooks, services, logs };
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
    sessions: {
      [sessionKey]: { id: sessionId },
    },
  });
  await writeFile(join(sessionsDir, "sessions.json"), sessionsJson, "utf8");

  const targetFile = fileName || `${sessionId}.jsonl`;
  await writeFile(join(sessionsDir, targetFile), messages.join("\n") + "\n", "utf8");
  return { sessionsDir, targetFile };
}

function getSaveHandler(commands) {
  const save = commands.find((c) => c.name === "save");
  assert.ok(save, "expected /save command to be registered");
  assert.equal(typeof save.handler, "function");
  return save.handler;
}

function getBeforePromptBuildHook(hooks) {
  const hook = hooks.find((h) => h.name === "before_prompt_build");
  assert.ok(hook, "expected before_prompt_build hook to be registered");
  return hook.handler;
}

test("user scenario: /save stores handover and first next-turn injects once", { concurrency: false }, async () => {
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
      assert.ok(injected?.prependContext?.includes("<previous-session-handoff>"));
      assert.ok(injected?.prependContext?.includes("這是測試交接摘要"));

      await assert.rejects(stat(handoverPath), /ENOENT/);

      const second = await beforePromptBuild(
        { messages: [{ role: "user", content: "第二句" }] },
        { sessionKey, sessionId: "new-session-1" },
      );
      assert.equal(second, undefined);
    } finally {
      await summarizer.close();
    }
  });
});

test("multi-agent scenario: /save resolves coder session instead of main", { concurrency: false }, async () => {
  await withTempHome(async (home) => {
    const mainKey = "agent:main:discord:channel:2001";
    const coderKey = "agent:coder:discord:channel:9009";
    let observedPrompt = "";
    const summarizer = installFetchSummarizerMock({
      onRequest: (payload) => {
        observedPrompt = payload?.messages?.[0]?.content || "";
      },
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

test("error injection: malformed sessions.json fails closed without session fallback", { concurrency: false }, async () => {
  await withTempHome(async (home) => {
    let observedPrompt = "";
    const summarizer = installFetchSummarizerMock({
      onRequest: (payload) => {
        observedPrompt = payload?.messages?.[0]?.content || "";
      },
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

test("error injection: summarizer failure returns /save error and does not persist handover", { concurrency: false }, async () => {
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
      await assert.rejects(stat(handoverPath), /ENOENT/);
    } finally {
      await summarizer.close();
    }
  });
});

test("webchat /save resolves via agent:main:main fallback", { concurrency: false }, async () => {
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
          jsonlMessage("user", "這是 webchat fallback 測試"),
          jsonlMessage("assistant", "收到"),
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

test("sessionId-only /save resolves session and persists to matched session key", { concurrency: false }, async () => {
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

test("webchat /save fallback supports non-main agent via ctx.agentId", { concurrency: false }, async () => {
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

test("legacy target-id /save writes handover under resolved channel session key and injects once", { concurrency: false }, async () => {
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
      await assert.rejects(stat(handoverPath), /ENOENT/);
    } finally {
      await summarizer.close();
    }
  });
});
