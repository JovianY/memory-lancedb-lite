import lancedb from "@lancedb/lancedb";
import { join } from "node:path";
import { homedir } from "node:os";

const dbPath = join(homedir(), ".openclaw", "memory", "lancedb-lite");

async function purge() {
    console.log("正在連接資料庫以進行最後清理...");
    const db = await lancedb.connect(dbPath);
    try {
        const table = await db.openTable("memories");
        // 刪除所有可能相關的紀錄
        await table.delete("text LIKE '%Captain%'");
        await table.delete("text LIKE '%Alex%'");
        await table.delete("text LIKE '%Cycling%'");
        console.log("✅ LanceDB 淨化完成。");
    } catch (e) {
        console.log("資料庫表不存在或已為空，跳過。");
    }
}

purge();
