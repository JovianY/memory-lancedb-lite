import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../dist/index.js";

const tempHome = await mkdtemp(join(tmpdir(), "mldb-lite-home-"));
await mkdir(join(tempHome, ".openclaw"), { recursive: true });

process.env.HOME = tempHome;
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "dummy-key";

const hooks = [];
const commands = new Map();

const api = {
  logger: {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  },
  config: {
    gateway: { auth: {} },
    plugins: {
      entries: {
        "memory-lancedb-lite": {
          config: {
            embedding: {
              apiKey: "${GEMINI_API_KEY}",
              baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
              model: "gemini-embedding-001",
            },
            autoCapture: true,
            captureAssistant: false,
            autoRecall: true,
            sessionMemory: { enabled: true, messageCount: 15 },
          },
        },
      },
    },
  },
  on(event, handler) {
    hooks.push({ event, handler });
  },
  registerTool() {},
  registerService() {},
  registerCommand(def) {
    commands.set(def.name, def.handler);
  },
};

plugin.register(api);

if (!commands.has("save")) {
  console.error("FAIL: /save command not registered");
  process.exit(1);
}

const saveHandler = commands.get("save");
const result = await saveHandler({}, { sessionId: "no-session" });

console.log("Registered hooks:", hooks.map((h) => h.event).join(", "));
console.log("Save handler result:", result?.text || "");

if (typeof result?.text !== "string" || (!result.text.includes("交接失敗") && !result.text.includes("❌"))) {
  console.error("FAIL: /save handler did not return expected failure text in smoke test");
  process.exit(1);
}

console.log("PASS: /save command smoke test (registration + graceful failure) OK");
