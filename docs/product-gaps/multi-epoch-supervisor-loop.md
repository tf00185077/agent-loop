# 產品缺口：Supervisor 缺少宏觀多輪規劃與外層任務批次

- 狀態：Open
- 優先級：Critical
- 紀錄日期：2026-07-16
- 發現方式：依產品目的執行真實 Agent Loop 功能驗收

## 一句話結論

目前系統採用「一次建立固定 Change Plan，之後只在該計畫內執行與局部調整」；產品真正需要的是「每一批工作完成後，Supervisor 重新對照原始 Goal 與交付證據，若仍有缺口，就建立下一批可獨立追蹤的外層 Change／任務卡，持續多輪迭代直到整體目標成立」。

## 使用者真正期待的產品行為

使用者提交的是一個 Goal，可能是小型邏輯修改，也可能是完整產品功能。

- 小型 Goal 可以只需要一輪規劃與一張外層任務卡。
- 大型 Goal 不應在第一次規劃時就假定已經知道全部工作。
- 每批 Change／Task 完成後，Supervisor 必須重新閱讀：
  - 原始 Goal；
  - 已完成的 Change 與驗收證據；
  - Agent／Judge 回報；
  - 整合後的實際產品狀態；
  - 尚未滿足的產品缺口。
- 若仍有缺口，Supervisor 應建立下一輪外層 Change／任務卡，並依新的理解繼續執行。
- 只有在重新對照原始 Goal 後確認沒有缺口，才能將 Goal 標記為 completed。

目標流程應為：

```text
Goal
  ↓
Planning Epoch 1
  ↓
建立第一批外層 Change／任務卡
  ↓
逐項執行、審查、整合、驗證
  ↓
Supervisor 對照原始 Goal 重新判斷
  ├─ 仍有缺口 → Planning Epoch 2 → 建立下一批外層卡片
  └─ 無缺口 → Goal completed
```

此循環可進入 Epoch 3、Epoch 4，直到整體 Goal 真正完成或命中明確的停止／人工介入條件。

## 目前系統的實際行為

產品驗收中的大型 Goal：`PRODUCT-E2E Broad staged task pipeline feature`。

Supervisor 在第一次規劃時一次產生：

- 1 份 Change Plan；
- 4 個有依賴順序的 Change；
- 4 個 Spec Task；
- 4 個 Implementation Task；
- 共 8 個 Managed Task。

執行期間已能做到：

- 依 Change 依賴順序逐步啟用；
- Worker 與 Judge 分工；
- 任務失敗時重試、切分或補充目前 Change 內的 Task；
- 保存 Task、角色、事件、驗收條件與 Agent 回報；
- 在 Dashboard 詳細頁顯示內層 Managed Task 狀態。

但目前的宏觀規劃限制是：

1. 一個 Goal 只有一份 Change Plan。
2. Change Plan 建立後不可重建成下一輪規劃。
3. Supervisor continuation 會繼承同一份 Plan；技術上出現新的 run，不代表產生新的規劃輪次。
4. Supervisor 可在目前啟用的 Change 內新增或拆分 Task，但這只是局部修正。
5. 所有 Change 歸檔後，系統不允許再新增工作。
6. Backend 的完成檢查主要能確認「已登記的 Task 是否 accepted、條件是否 PASS、是否還有執行中的工作」，無法獨立證明「原始 Goal 是否仍有未登記缺口」。
7. Dashboard 首頁只有原始 Goal 的一張外層卡片；4 個 Change 與 8 個 Task 只在詳細頁中呈現為內層狀態列。

因此，目前流程本質上是：

```text
一次總體規劃
  ↓
固定計畫內逐步執行與局部調整
  ↓
完成已登記工作
  ↓
Goal completed
```

而不是產品需要的宏觀多輪 Loop。

## 為何這不只是 UI 差異

如果只是把既有的 4 個 Change 畫成首頁卡片，確實主要是 UI／API projection 調整；但這仍然只是在顯示第一次固定計畫。

真正缺少的是執行語意與持久化生命週期：

- 可持久化的 Planning Epoch／Batch 實體；
- 每輪結束後強制執行的 Goal-level reassessment；
- 根據新證據新增下一批 Change 的能力；
- 新 Change 的獨立狀態、依賴、角色、事件與驗收生命週期；
- 重新啟動後能恢復「目前位於第幾輪、為何建立下一輪」；
- Goal completion 必須綁定最後一次宏觀重新判斷，而非只依賴已登記 Task 全部完成。

所以此缺口同時涉及：

1. Domain model
2. SQLite／持久化
3. Supervisor orchestration contract
4. Completion gate
5. API／SSE projection
6. Dashboard 外層任務卡與輪次呈現
7. Retry、budget 與 circuit breaker

## 建議的核心模型

### Planning Epoch

每個 Goal 可擁有多個 Planning Epoch：

```text
PlanningEpoch
- id
- goalId
- sequence
- status: planning | executing | reassessing | completed | blocked
- rationale
- createdAt
- completedAt
- sourceEvidenceIds
- nextEpochReason
```

### 外層 Change／任務卡

每輪產生一批可獨立追蹤的 Change：

```text
Goal
  ├─ Epoch 1
  │   ├─ Change A
  │   └─ Change B
  ├─ Epoch 2
  │   ├─ Change C
  │   └─ Change D
  └─ Epoch 3
      └─ Final verification Change
```

每張外層 Change 卡至少應顯示：

- 所屬 Epoch；
- 狀態；
- 依賴；
- 目前角色／Provider；
- Spec、Implementation、Judge、Integration 進度；
- Agent 最新回報；
- 驗收證據；
- 阻塞與重試原因。

### Goal-level Reassessment

每批工作完成後，Supervisor 必須輸出結構化判斷，例如：

```json
{
  "goalSatisfied": false,
  "evidence": ["..."],
  "remainingGaps": ["..."],
  "nextEpochRationale": "...",
  "proposedChanges": ["..."]
}
```

若 `goalSatisfied=false`，必須建立下一個 Epoch；若為 `true`，才可進入最終完成門檻。

## 必要安全限制

宏觀多輪 Loop 不能變成無限消耗，至少需要：

- 每個 Epoch 的 Task／重試上限；
- 每個 Goal 的 Epoch 上限或可配置 budget；
- 連續相同缺口／相同失敗簽章的 circuit breaker；
- Provider quota、auth、環境錯誤的 fail-fast 分類；
- 超過上限後進入 blocked／needs_owner_review，而不是持續生成更小任務；
- 允許使用者查看並調整下一輪計畫後再繼續。

這也能處理本次驗收發現的另一風險：局部 Task 有 retry 上限，但 Supervisor 仍可能不斷建立更窄的新 Task，造成 Goal-level 任務膨脹。

## UI 期望

Dashboard 首頁應保留 Goal 作為父層，但需能展開或切換至外層任務板：

```text
Goal：交付完整功能

Epoch 1 — Foundation
[Change A: completed] [Change B: completed]

Epoch 2 — Product gaps discovered after integration
[Change C: running] [Change D: blocked]

Epoch 3 — 尚未建立
```

使用者應能從首頁直接知道：

- 系統目前處於第幾輪；
- 每輪建立了哪些外層任務卡；
- 為什麼上一輪完成後仍需要下一輪；
- Supervisor 最新一次重新判斷的結論；
- 整體 Goal 尚缺什麼。

## 驗收條件

### AC1：小任務可單輪完成

給定明確且狹窄的 Goal，Supervisor 可建立一個 Epoch、一個或少量 Change，完成重新判斷後直接結束，不強迫產生多餘輪次。

### AC2：大任務會依執行證據產生下一輪

給定無法在第一次規劃完整預測的大型 Goal，第一批完成後，Supervisor 必須重新對照原始 Goal；若發現缺口，建立 Epoch 2 與新的外層 Change 卡。

### AC3：下一輪不是預先寫死

Epoch 2 的 Change 必須來自 Epoch 1 的整合結果、Judge 回報或產品驗證缺口，而不是在 Epoch 1 開始前就一次性建立的固定清單。

### AC4：外層任務可獨立追蹤

每個 Change 都具備獨立 ID、狀態、依賴、角色、事件、驗收證據與詳細頁；Dashboard 首頁／任務板可看到多張卡片。

### AC5：完成門檻對照原始 Goal

即使所有已登記 Task 都 accepted，只要最後一次 Goal-level reassessment 判定仍有未滿足缺口，Backend 不得將 Goal 標記為 completed。

### AC6：重新啟動可恢復輪次

在任意 Epoch 執行或 reassessment 期間重啟服務，系統能恢復相同 Goal、Epoch、Change、Task 與判斷證據，不重複建立同一批工作。

### AC7：宏觀 Loop 有界

當 Epoch、重試、時間或成本 budget 耗盡，或連續出現相同失敗簽章時，Goal 必須進入明確 blocked 狀態並保留原因，不得無限新增 Task／Epoch。

### AC8：全流程可觀察

API、SSE 與 Dashboard 都能看到：

- Planning Epoch 開始／結束；
- Change 批次建立；
- 每輪重新判斷結果；
- 下一輪建立理由；
- Agent／Judge 回報；
- 最終 Goal 完成證據。

## 非目標

- 不是單純把目前8個Managed Task改成卡片樣式。
- 不是要求每個Goal固定產生多輪；小任務應能一輪完成。
- 不是在第一次規劃時預先列出所有未來Epoch。
- 不是放寬完成條件或讓Supervisor無限制自我延伸。

## 產品完成定義

只有當系統能在每批交付後重新評估原始 Goal、根據新證據動態建立下一批外層任務卡、持久化並呈現每輪狀態，且以有界Loop收斂到可驗證的整體完成，才算符合本產品原始目的。
