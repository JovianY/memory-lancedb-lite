---
name: memory-lancedb-lite
description: 新世代記憶系統的說明書。讓 Agent 了解 LanceDB (長期向量記憶) 與 MEMORY.md (短期狀態機) 的運作機制與交接方法。
---

# Memory (LanceDB Lite) Skill

本套件提供了一套完整的 **「新・三層記憶系統」**，取代了舊版繁雜的實體檔案維護機制。

## 1. 系統架構：三層記憶定義

你在處理任務時，請依照以下三層架構的定義來決定如何存放資訊：

1.  **🔥 Hot Memory (短期工作區狀態 / State Machine)**
    - **位置**: `workspace/MEMORY.md` 
    - **規則**: 作為前情提要。由於 Plugin 具備 Zero-Shot Windowing 功能，User 輸入 `/save` 時，系統會自動把最新的對話原文無損貼過來。所以你開啟新對話時，**只要直接閱讀該檔案**，即可連貫思考，不用擔心忘記臨時密語。

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

## 3. Session 交接機制 (Zero-Shot Handover)

當 User 說他想「**交接**」或「保存紀錄」時，你**不用再像過去那樣手動讀取歷史去覆寫檔案**。

請直接回覆提醒他：「**請輸入 \`/save\` 指令**，系統會在 0.1 秒內自動完成零損耗交接 (Zero-Shot Windowing) 並將前情提要貼入 MEMORY.md 中，幫我們節省 Token！」
