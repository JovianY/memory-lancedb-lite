# Memory-LanceDB-Lite Debugging Journey

This document records the extensive debugging process undertaken to resolve the critical "Context Handover Loss" bug within the `/save` command and ephemeral memory injection flow.

## 🐛 The Problem

The primary issue was that when a user executed the `/save` command to summarize the current conversation and hand it over to the next session, the newly spawned Agent forgot all injected user facts, constraints, and instructions.

Upon investigation, this wasn't a single bug but a **chain of 4 distinct bugs** working together to drop, steal, mutate, and misdirect the context.

---

## 🔍 Bug 1: Unregistered Hooks (The Gateway Blindspot)

### Description
The plugin utilized `api.registerHook()` to connect to OpenCLAW's `before_prompt_build` lifecycle hook for both the `auto-recall` and `ephemeral-injection` features. However, the gateway's dispatch runner (`runModifyingHook`) never triggered them.

### Root Cause
`api.registerHook()` only saves hook metadata into `registry.hooks`. The gateway dispatches hooks from `registry.typedHooks`. Only the `api.on()` method correctly writes to the typed registry and enables execution. Additionally, the global `openclaw.json` config was missing `"hooks": { "internal": { "enabled": true } }`, causing the gateway to ignore internal hooks entirely.

### Solution
1. Changed `api.registerHook(...)` to `api.on(...)` across `src/index.ts`.
2. Enabled internal hooks in `~/.openclaw/openclaw.json`.
3. Added null guards to `event.messages` to prevent auto-recall from crashing the prompt builder during startup.

---

## 🚫 Bug 2: Background Processes Stealing Context (The "slug-generator" Hijack)

### Description
Even after hooks were firing, the context was still missing for the main Agent. Log tracing revealed that the `ephemeral-injection` hook *was* firing, but injecting the context into the wrong agent.

### Root Cause
When launching a new chat session in the UI/Discord, OpenCLAW simultaneously spawns a background `slug-generator` agent to generate a chat title. Because this background agent is faster, it triggered `before_prompt_build` milliseconds before the main conversational agent. The hook gladly injected the context into the title generator's prompt and then executed `unlink(ephemeralPath)` to delete the file. When the main Agent arrived milliseconds later, the handover file was already gone.

### Solution
Added an explicit guard at the top of the `before_prompt_build` hook to discard execution for background agents:
```typescript
if (ctx?.sessionId?.includes("slug-gen") || ctx?.sessionId?.includes("slug-generator")) return;
```

---

## 🤖 Bug 3: The Summarizer Ignoring the System Prompt

### Description
After fixing the hook stealing, the injected context was intact but contained garbage data, specifically: `"I’m running on openai-codex/gpt-5.1-codex-mini right now, the same model listed as the default."`

### Root Cause
The plugin's `/save` feature calls `localhost:18789/v1/chat/completions` (OpenCLAW's local LLM proxy) to summarize the heavily stringified conversation array. OpenCLAW's local proxy drops or overrides the `system` role prompt. As a result, the model was handed a giant array of previous conversation messages without any instructions. It simply responded to the last user question in that payload (`"你是哪個model?"`) instead of summarizing the text.

### Solution
Merged the translation/summarization instructions directly into the `user` message alongside the JSON payload, explicitly commanding the LLM to process it as a document instead of treating it as a conversation.

```typescript
{ 
  role: "user", 
  content: `${prompt}\n\n=== CONVERSATION LOG ===\n${JSON.stringify(messages)}\n=== END LOG ===\n\nPlease reply ONLY with the compressed State Fragment.` 
}
```

---

## 📁 Bug 4: Summarizing the Wrong Session (The "Most Recent" Flaw)

### Description
In rare circumstances (or immediately after a `/save` background run), the generated context extracted data from an entirely unrelated automated agent (e.g., a background cron job) instead of the user's active session.

### Root Cause
The original `/save` command implementation blindly searched the `~/.openclaw/agents/main/sessions/` directory, sorted files by modification time (`mtime`), and selected the single most recently modified file to summarize. Because cron jobs or background tasks frequently update parallel sessions, the latest file often did not match the Discord channel the user triggered the command from. Furthermore, the summarizer's own network hit would create *another* session, making the "latest" file a recursive paradox.

### Solution
Refactored the `/save` command to grab the exact session ID bound to the incoming chat context, definitively anchoring the summarization to the correct user chat flow.

```typescript
let targetFileName: string | undefined;
if (context?.sessionId) {
    targetFileName = `${context.sessionId}.jsonl`;
} else if (context?.state?.sessionId) {
    targetFileName = `${context.state.sessionId}.jsonl`;
}
```

## 🎉 Conclusion
The integration of these 4 solutions resulted in a robust, bulletproof `/save` and `ephemeral-injection` workflow, enabling perfect zero-shot context handover across discrete chat boundaries without persistent database bloat.
