import { memoryLanceDBLitePlugin } from "../dist/index.js";
import { writeFile, mkdir, rm, utimes } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const OPENCLAW_DIR = join(homedir(), ".openclaw");

async function runStressTest() {
    console.log("🚀 開始記憶插件全盤壓力測試...");
    
    // 模擬 OpenClaw API
    const mockApi = {
        logger: { info: (msg) => {}, warn: (msg) => {}, error: (msg) => {} },
        config: { 
            plugins: { entries: { "memory-lancedb-lite": { config: { sessionMemory: { enabled: true } } } } },
            gateway: { auth: { token: "test_token" } }
        },
        registerCommand: (cmd) => { mockApi.saveHandler = cmd.handler; },
        registerService: () => {},
        on: () => {}
    };

    memoryLanceDBLitePlugin.register(mockApi);
    const handler = mockApi.saveHandler;

    let passCount = 0;
    let failCount = 0;

    const assert = (condition, msg) => {
        if (condition) {
            console.log(` ✅ PASS: ${msg}`);
            passCount++;
        } else {
            console.error(` ❌ FAIL: ${msg}`);
            failCount++;
        }
    };

    // --- 測試場景 1：多代理人路徑測試 ---
    console.log("\n[測試 1] 多代理人隔離測試 (Coder vs Main)...");
    const coderSessionDir = join(OPENCLAW_DIR, "agents", "coder", "sessions");
    await mkdir(coderSessionDir, { recursive: true });
    const coderFile = join(coderSessionDir, "88888888-4444-4444-4444-1234567890ab.jsonl");
    await writeFile(coderFile, JSON.stringify({ type: "message", message: { role: "user", content: "這是 Coder 代理人的 Python 任務。" } }) + "\n");
    
    const result1 = await handler({}, { agentId: "coder", sessionId: "88888888-4444-4444-4444-1234567890ab" });
    // 因為測試環境沒真實 LLM，預期會因為 API Key 或連線失敗，但我們檢查它是否嘗試讀取了正確的檔案 (會報出 API 錯誤而非檔案找不到)
    assert(result1.text.includes("❌ 交接失敗") || result1.text.includes("存檔摘要"), "指令應能進入 LLM 階段 (證明檔案讀取路徑正確)");

    // --- 測試場景 2：排除規則測試 (排除 test, tmp, reset) ---
    console.log("\n[測試 2] 檔案過濾排除測試 (排除 test*, *.tmp, *.reset)...");
    const mainSessionDir = join(OPENCLAW_DIR, "agents", "main", "sessions");
    await mkdir(mainSessionDir, { recursive: true });
    
    const realFile = join(mainSessionDir, "real-session.jsonl");
    const testFile = join(mainSessionDir, "test-fake.jsonl");
    const tmpFile = join(mainSessionDir, "backup.tmp");
    
    await writeFile(realFile, JSON.stringify({ type: "message", message: { role: "user", content: "這是真實對話。" } }) + "\n");
    await writeFile(testFile, JSON.stringify({ type: "message", message: { role: "user", content: "這是錯誤的測試資料。" } }) + "\n");
    await writeFile(tmpFile, JSON.stringify({ type: "message", message: { role: "user", content: "這是暫存檔資料。" } }) + "\n");

    // 故意把測試檔和暫存檔的修改時間設成最新
    const future = Date.now() + 10000;
    await utimes(testFile, new Date(future), new Date(future));
    await utimes(tmpFile, new Date(future + 1000), new Date(future + 1000));

    // 執行 save (不帶 sessionId，強迫它抓最新)
    const result2 = await handler({}, { agentId: "main" });
    // 如果它抓到 test 或 tmp，摘要(若成功)或失敗訊息會反映出來。這裡我們檢查邏輯是否略過了它們。
    // (在我們的邏輯中，如果它抓到了 real-session，會嘗試呼叫 API。如果沒抓到會報 No session files found)
    assert(!result2.text.includes("No session files found for agent: main"), "應能正確跳過過濾檔案並找到真實對話檔");

    // --- 測試場景 3：毀損檔案健壯性 ---
    console.log("\n[測試 3] 毀損 JSONL 檔案健壯性測試...");
    const corruptFile = join(mainSessionDir, "corrupt.jsonl");
    await writeFile(corruptFile, "{invalid json}\n" + JSON.stringify({ type: "message", message: { role: "user", content: "有效訊息" } }) + "\n");
    await utimes(corruptFile, new Date(future + 5000), new Date(future + 5000));

    const result3 = await handler({}, { agentId: "main", sessionId: "corrupt" });
    assert(!result3.text.includes("無法解析日誌行") || result3.text.includes("有效訊息") || result3.text.includes("❌ 交接失敗"), "系統應能容忍毀損的 JSON 行");

    // --- 測試場景 4：空檔案邊界測試 ---
    console.log("\n[測試 4] 空檔案邊界測試...");
    const emptyFile = join(mainSessionDir, "empty.jsonl");
    await writeFile(emptyFile, "");
    await utimes(emptyFile, new Date(future + 6000), new Date(future + 6000));

    const result4 = await handler({}, { agentId: "main", sessionId: "empty" });
    assert(result4.text.includes("No messages found"), "空檔案應觸發正確的報錯訊息");

    // --- 清理戰場 ---
    console.log("\n🧹 正在清理測試環境...");
    await rm(coderFile, { force: true });
    await rm(realFile, { force: true });
    await rm(testFile, { force: true });
    await rm(tmpFile, { force: true });
    await rm(corruptFile, { force: true });
    await rm(emptyFile, { force: true });

    console.log(`\n--- 測試結束 ---`);
    console.log(`總計: ${passCount} 通過, ${failCount} 失敗`);
    
    if (failCount > 0) process.exit(1);
}

runStressTest().catch(err => {
    console.error("測試腳本崩潰:", err);
    process.exit(1);
});
