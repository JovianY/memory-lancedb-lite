---
name: memory-lancedb-lite
description: 新世代記憶系統的說明書。讓 Agent 了解 LanceDB (長期向量記憶) 與 Ephemeral Handover (瞬態交接) 的運作機制。
---

# Memory (LanceDB Lite) Skill

本套件提供了一套完整的 **「新・三層記憶系統」**，取代了舊版繁雜的實體檔案維護機制與 Token 浪費。

## 1. 系統架構：三層記憶定義

你在處理任務時，請依照以下三層架構的定義來決定如何存放資訊：

1.  **🔥 Hot Memory (瞬態交接區 / Ephemeral Handover)**
    - **位置**: System Prompt (First-turn injection)
    - **規則**: 為了徹底消除 Token 浪費，本系統已經**廢除使用 MEMORY.md**。當 User 呼叫 `/save` 進行交接結案時，系統會自動擷取最近 25 句完整對話，並在下一局新對話的**第一句話**中作為 `<previous-session-handoff>` 無痕注入。
    - **動作**: 當你在新對話甦醒時，若在 System/User prompt 裡看到上一局交接的紀錄與指令（包含各種臨時或不要存到長期大腦的秘密約定），請**直接閱讀並遵循**，這段記憶會隨著對話推進自然消亡 (Sliding Window)，不會永久佔用 Context。

2.  **🌡️ Warm Memory (自動會話記憶 / Auto-Session)**
    - **位置**: 背景自動監聽器 (`session-memory` hook)
    - **規則**: 系統會在 User 輸入 `/new` 的時候，自動把上一局對話摘要存進大腦。你不要做任何事。

3.  **❄️ Cold Memory (永久知識庫 / Long-term Vector DB)**
    - **位置**: LanceDB 資料庫
    - **規則**: 存放 User 個人偏好、重大架構決策、門牌號碼等「永恆事實」。
    - **動作**: 遇到這些事實時，你必須**「主動調用」** `memory_store` 將其永久保存。

## 2. 工具列表 (Tools)

本系統提供了以下原生工具供你在需要時主動調用：

- **`memory_store`**: 將重要事實或規則寫入大腦。
- **`memory_recall`**: 回想過去的事實（支援語義搜尋與 BM25 關鍵字混合搜尋）。
- **`memory_update`**: 當你發現記憶裡的資訊過時，用它來更新。
- **`memory_forget`**: 刪除完全錯誤或被推翻的記憶。

> 💡 系統配備了 **Auto-Recall** 與 **Auto-Capture** 機制。日常對話中的偏好設定，Plugin 會嘗試抓取，但對於「複雜的指令」、「長篇規則」，請務必主動調用 `memory_store` 保存至長期大腦。

## 3. Session 交接機制 (First-Turn Ephemeral Injection)

當 User 說他想「**交接**」或「保存紀錄」時，你**不用再像過去那樣手動讀取歷史去寫 MEMORY.md**。

請直接回覆提醒他：「**請輸入 \`/save\` 指令**，系統會在 0.1 秒內自動完成零損耗交接 (First-Turn Injection) 幫我們節省 Token！」
