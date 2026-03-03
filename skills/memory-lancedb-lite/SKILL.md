---
name: memory-lancedb-lite
description: 新世代三層記憶系統的說明書。讓 Agent 了解 LanceDB (長期向量記憶) 與 MEMORY.md (短期狀態機) 的運作機制與工具使用方法。
---

# Memory (LanceDB Lite) Skill

本套件提供了一套完整的 **「新・三層記憶系統」**，取代了舊版繁雜的實體檔案維護機制。

## 1. 系統架構：三層記憶定義

你在處理任務時，請依照以下三層架構的定義來決定如何存放資訊：

1.  **🔥 Hot Memory (短期工作區狀態 / State Machine)**
    - **位置**: `MEMORY.md` 
    - **規則**: 嚴格控制在 **500 字 / 1KB 以內**。只存「動態狀態」。例如：目前正在解的 Bug、未完成的代辦事項 (TODOs)。
    - **禁止**: 不得存放任何 API Key、永遠不會改變的投資策略原則、歷史決策（這些請寫入 Cold Memory）。

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

> 💡 系統配備了 **Auto-Recall** 與 **Auto-Capture** 機制。日常對話中的偏好設定，Plugin 通常會在背景自動幫你抓取並寫入，但如果是「複雜的模型設定」、「長篇解 Bug 紀錄」，請務必主動調用 `memory_store` 作為雙重保障。

## 3. Session 交接機制 (User 指令)

User 隨時可以在對話框輸入 `/save` 指令（由 Gateway Plugin 攔截執行）。

當 User 說他執行了 `/save` 或 `/new` 時，你**不需要**做任何事。因為 Plugin 已經在背景自動幫我們完成了：
1. 抓取近期對話中有價值的事實存入 LanceDB。
2. 將最後 10 句話的摘要與 TODO 欄位覆寫入 `MEMORY.md`。

> ⚠️ 如果 User 是用「口語」要求交接（例如："幫我交接"），你可以回覆提醒他：「請直接輸入 `/save`，系統會自動幫您完成狀態保存與記憶打包唷！」
