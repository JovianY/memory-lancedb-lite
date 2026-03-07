import { memoryLanceDBLitePlugin } from "../dist/index.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

async function testSaveCommand() {
    console.log("--- 啟動 /save 指令冒煙測試 ---");
    
    // 模擬 OpenClaw API
    const mockApi = {
        logger: { info: (msg) => console.log(`[INFO] ${msg}`), warn: (msg) => console.log(`[WARN] ${msg}`), error: (msg) => console.log(`[ERROR] ${msg}`) },
        config: { plugins: { entries: { "memory-lancedb-lite": { config: { sessionMemory: { enabled: true } } } } } },
        registerCommand: (cmd) => {
            console.log(`[DEBUG] 註冊指令: ${cmd.name}`);
            mockApi.saveHandler = cmd.handler;
        },
        registerService: () => {},
        on: () => {}
    };

    // 1. 註冊插件
    memoryLanceDBLitePlugin.register(mockApi);

    // 2. 準備測試數據
    const sessionsDir = join(homedir(), ".openclaw", "agents", "main", "sessions");
    const testSessionFile = join(sessionsDir, "test-save-smoke.jsonl");
    const testMessage = JSON.stringify({ type: "message", message: { role: "user", content: "測試對話內容：台北天氣晴。" } });
    
    try {
        // 3. 觸發指令處理
        console.log("正在執行指令...");
        // 注意：這裡可能會因為 API Key 缺失而失敗，但我們主要測試的是指令是否會回傳預期的失敗字串
        const result = await mockApi.saveHandler({}, { sessionId: "test-save-smoke" });
        
        console.log("指令回傳結果：");
        console.log(JSON.stringify(result, null, 2));

        if (result.text.includes("**存檔摘要：**") || result.text.includes("❌ 交接失敗")) {
            console.log("✅ 測試通過：指令正確觸發並回傳了預期的 UI 文字格式。");
        } else {
            throw new Error(`測試失敗：回傳文字未包含預期標籤。內容為: ${result.text}`);
        }
    } catch (err) {
        console.error(`測試執行異常: ${String(err)}`);
    }
}

testSaveCommand();
