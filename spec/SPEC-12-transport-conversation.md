# SPEC-12 — Transport 擴充與長時 Run 的對話模型

- **狀態：** 草稿
- **負責人：** 待定
- **依賴：** SPEC-01（HTTP server、config）、SPEC-03（`ChatTransport`、Gateway）、SPEC-09（Run Store）、SPEC-11（核准關卡）
- **修正：** SPEC-01 §3.6、SPEC-03 §3.1／FR-03-9／FR-03-11、SPEC-08 FR-08-1
- **對應的缺口：** VISION §7 的第 1、2、3 點

---

## 1. 問題

SPEC-03 的 `ChatTransport` 與 Gateway 是為「一則訊息 → 一次處理 → 一則回覆」
設計的。VISION 要的東西打破了這個形狀三次：

**① Line 進不來。** Telegram 與 Discord 是**主動外連**（long-poll／websocket），
所以 `start()` 這個 port 成立。Line Messaging API 是**被動 webhook**：需要公開
HTTPS 端點、要驗 HMAC 簽章。而 SPEC-01 §3.6 明確寫了 HTTP server「只有健康
檢查」。

更麻煩的是回覆模型。Line 的 reply token 短時效且單次使用，而一個 run 要跑
數十分鐘、要送計畫提案／進度／最終報告至少三則 —— 全部得走 push 路徑。
附件也不同：Telegram／Discord 可直接送 Buffer，Line 需要一個可公開存取的 URL。
這直接打到 SPEC-08 FR-08-1／FR-08-2 的附件降級設計。

**② 「等待核准」沒有需求編號。** SPEC-11 §6 只用散文提了一句「Gateway 需要
新增待核准狀態」。但這裡要回答的問題不少：使用者回「執行」時，gateway 怎麼
知道是哪個 run？同時有兩個計畫待確認怎麼辦？待確認時發全新需求會怎樣？
重啟後待核准的計畫還算數嗎？**VISION §4 的第一條線就承載在這裡**，不能只是
一句註記。

**③ 長時 run 撞上 per-user 佇列。** SPEC-03 FR-03-9 的 per-user queue 是
`concurrency: 1`。一個 engineering run 跑 30 分鐘，期間該使用者的任何訊息 ——
包括「取消」—— 都會排在後面。使用者被自己卡住，而且連中止的手段都被佇列擋住。

---

## 2. 目標／非目標

**目標**
- `ChatTransport` port 能同時表達「主動外連」與「被動 webhook」兩種型態。
- 平台能力（附件、push、長度）成為 port 上的宣告資料，交付層據此決策。
- 一個明確的「待回覆」對話狀態機，有需求編號與驗收條件。
- 互動與長時執行分離：run 執行中，使用者仍然隨時可問狀態、可取消。
- 非同步推送有節流，不洗版。

**非目標**
- 具體 Line／Slack／WhatsApp 的 API 細節 —— adapter 內部的事（見 FR-12-4 的
  查證要求）。
- 反向代理／通道（cloudflared、ngrok）的架設 —— 部署層，文件記錄即可。
- 多使用者的公平排程。單使用者假設不變（SPEC-08 E-4）。

---

## 3. 目標設計

### 3.1 `ChatTransport` port 擴充（取代 SPEC-03 §3.1）

```ts
export type TransportKind = "outbound" | "webhook";

export interface TransportLimits {
  readonly maxTextLength: number;        // Telegram 4096 / Discord 2000 / Line 5000
  readonly maxFileBytes: number;
  readonly maxMessagesPerBurst: number;  // 切分多則時的上限
}

export interface TransportCapabilities {
  /** 能否直接以 Buffer 送檔案。 */
  readonly files: boolean;
  /** 檔案是否必須先有公開 URL（Line 這類平台為 true）。 */
  readonly filesNeedPublicUrl: boolean;
  /** 能否在沒有 inbound 事件的情況下主動送訊息。長時 run 必須為 true。 */
  readonly push: boolean;
}

export interface ChatTransport {
  readonly source: TransportSource;      // "telegram" | "discord" | "line" | …
  readonly kind: TransportKind;
  readonly limits: TransportLimits;
  readonly capabilities: TransportCapabilities;

  start(): Promise<void>;                // outbound：連線。webhook：驗證憑證
  stop(): Promise<void>;
  status(): "idle" | "connecting" | "connected" | "stopped" | "errored";

  /** kind === "webhook" 時必須實作；由 main.ts 在 listen 之前呼叫。 */
  registerRoutes?(http: HttpServer): void;

  onMessage(handler: (msg: InboundMessage) => void): void;
  send(msg: OutboundMessage): Promise<void>;
}
```

- **`send()` 一律是 push 語意。** harness 永不依賴 reply token —— 因為 run 的
  任何一則輸出都可能在 token 過期後才產生。adapter 若想在收訊當下用 reply
  token 做即時 ack，那是 adapter 內部的最佳化，不進入 port。
- `capabilities.push === false` 的 transport **不得**用於 `engineering` 類 run；
  Gateway 在 intake 階段就拒絕並說明原因。

### 3.2 HTTP server 升格（修正 SPEC-01 §3.6）

HTTP server 不再只有健康檢查。它現在承載三類路由：

| 路由 | 用途 |
|------|------|
| `GET /livez`、`GET /readyz` | 原有（SPEC-01 FR-01-7） |
| `POST /webhook/<source>` | 每個 webhook transport 自行註冊 |
| `GET /files/:token` | 簽章短效的產物下載（見 §3.3） |

啟動順序修正為：**先註冊路由 → `listen()` → `gateway.start()`**。
（原 SPEC-03 §3.4 的順序是先 listen 再 start，webhook 型 transport 必須在
listen 之前完成註冊。）

Webhook 路由的固定規則，由共用中介層強制，不交給各 adapter 自行實作：

1. **先驗簽章再看內容。** 驗不過 → 401，不記錄 body、不進 pipeline。
2. **body 上限** `WEBHOOK_MAX_BODY_BYTES`（預設 `1_000_000`）。
3. **立刻回 200**，處理丟到背景。多數平台對回應時間有硬性要求，超時會重送。
4. **重送去重** —— 以平台事件 id 做去重，沿用 SPEC-03 FR-03-8 的 LRU
   ＋ SPEC-08 FR-08-9 的持久化 seen-set。**webhook 的重送頻率遠高於 polling，
   這條在此是必要而非選配。**
5. 驗簽通過後才做 allowlist 檢查（SPEC-03 FR-03-3）。

`config.PUBLIC_BASE_URL`：啟用任何 webhook transport 時為必填，且必須是
`https://`。缺漏 → config 驗證失敗（SPEC-01 FR-01-4）。

### 3.3 產物交付給「需要公開 URL」的平台

`capabilities.filesNeedPublicUrl === true` 時，附件改以短效簽章 URL 交付：

```
GET /files/:token   →   token = HMAC(artifactId, expiresAt, secret)
```

- Token 綁定**單一 artifact id**，`FILE_TOKEN_TTL_MS`（預設 `900_000` ＝ 15 分）。
- 過期或簽章錯誤 → 404（不是 403 —— 不洩漏 id 是否存在）。
- 只能取到 `artifact` 表裡登記過的檔案（SPEC-09）。**不接受路徑參數**，
  因此不存在路徑穿越面。
- 無目錄列表、無列舉端點。
- 回應帶 `Content-Disposition: attachment` 與 `X-Content-Type-Options: nosniff`。

**這是本專案唯一對外公開的資料路徑，取用它的人不需要通過 allowlist。**
因此 TTL 要短、token 要不可猜、且產物內容本來就是使用者自己要的東西。
寫入 ADR：`docs/adr/0010-signed-artifact-urls.md`。

### 3.4 對話狀態機（解決問題 ②）

Gateway 在把訊息交給 Intake（SPEC-11 FR-11-1）**之前**，先檢查該
`(source, userId, chatId)` 有沒有待回覆的提問：

```ts
export type PendingKind = "awaiting_approval" | "awaiting_clarification";
//                                               ↑ 見下方「關於 awaiting_clarification」

export interface PendingPrompt {
  readonly runId: RunId;
  readonly kind: PendingKind;
  readonly source: TransportSource;
  readonly userId: string;
  readonly chatId: string;
  readonly revisions: number;      // 已重新規劃幾次
  readonly expiresAt: number;
}
```

- 存放於 Run Store（SPEC-09）—— 待核准是 run 狀態的一部分，不是記憶體暫存。
- **每個 `(source, userId)` 同時只允許一個 pending。** 待核准時進來的新
  engineering 需求 → 回覆「你有一個計畫待確認」＋ 重貼計畫摘要，不建新 run。
- 逾時（`APPROVAL_TIMEOUT_MS`，SPEC-11）→ run `cancelled` ＋ 通知。

**回覆分類**，兩段式：

1. **精確白名單優先**（沿用 SPEC-08 E-2 的精神，正規化後相等，不用 `includes`）：
   `執行`／`go`／`ok`／`確認` → approve；`取消`／`cancel`／`不要` → cancel。
2. 不在白名單 → 一次便宜的 `generateJson` 分類成
   `approve | cancel | revise | unrelated`，並附 `revisionNote`。
   - `revise` → 帶著 note 重新規劃（上限 `MAX_PLAN_REVISIONS`）。
   - `unrelated` → 回覆「請先回覆待確認的計畫（執行／取消）」，不處理新需求。

#### 關於 `awaiting_clarification`

原本預留給「多輪需求釐清（grill）」。**該階段不會實作** —— 需求釐清在
harness 之外由人主導完成，harness 的工程任務輸入是一份既有的 spec 文件
（SPEC-11 §3.2）。因此 v1 的 `awaiting_clarification` 只用於**單一問題的
回問**，不是對話迴圈：

| 觸發情境 | 問題 |
|---|---|
| Intake 缺 `targetAlias` | 「要對哪個專案動工？」 |
| Intake 缺 `specPath` | 「要做哪一份 spec？」 |
| `Workspace.readFile` 失敗 | 「找不到 `<path>`，是不是打錯了？」 |
| 條目數超過上限而需確認切批 | 「這份有 18 條，本批先做 1–12？」 |

規則：**一問一答，不迴圈。** 使用者的下一則訊息若能補上缺的資訊就繼續，
否則視為新需求重新走 Intake。逾時語意與 `awaiting_approval` 相同。
不需要 `MAX_GRILL_TURNS` 之類的設定，也不需要 SPEC-02 支援多輪 `messages[]`。

### 3.5 雙車道佇列（取代 SPEC-03 FR-03-9）

SPEC-03 的單一 per-user queue 拆成兩條：

| 車道 | 內容 | 併發 |
|------|------|------|
| **互動** | chat、question、intake、核准回覆、`狀態`、`取消` | per-user 1，且**必須永遠可用** |
| **執行** | engineering run 的 Plan → Execute → Verify → Report | per-user `MAX_CONCURRENT_RUNS_PER_USER`（預設 1） |

- 執行車道**不佔用**互動車道的 slot。run 跑 30 分鐘期間，使用者仍可正常問話。
- 互動車道的處理必須是短的。任何會超過數秒的工作都屬於執行車道。
- 執行車道滿 → 新的 engineering 需求回覆「已有一個 run 進行中」＋ 目前進度。
- 互動車道的 backpressure 沿用 SPEC-03 FR-03-9（深度上限 5，超過回「忙碌中」）。

新增兩個互動指令（精確白名單比對）：

- `狀態`／`status` → 目前 run 的階段、逐任務狀態、已耗時、已用 agent 執行次數。
- `取消`／`cancel` → abort 進行中的 run（SPEC-11 FR-11-11），殺掉所有 agent
  子進程（SPEC-10 FR-10-4），保留已產生的 worktree。

### 3.6 非同步推送

編排器不直接呼叫 `transport.send()`，而是透過 `Notifier`：

```ts
export interface Notifier {
  notify(runId: RunId, kind: NotifyKind, body: string, files?: Attachment[]): Promise<void>;
}

type NotifyKind =
  | "plan_proposed" | "run_started" | "task_progress"
  | "run_finished" | "run_failed" | "run_interrupted";
```

- `Notifier` 從 Run Store 取得該 run 的 `source`／`chatId`，找到對應 transport。
- **節流**：`task_progress` 每 `NOTIFY_MIN_INTERVAL_MS`（預設 `60_000`）最多一則，
  期間累積的進度合併成一則。
- **終端事件不節流**：`plan_proposed`、`run_finished`、`run_failed`、
  `run_interrupted` 一律立即送出。
- 送出前一律經過 SPEC-08 FR-08-1 的長度切分與附件降級，並依 §3.3 處理
  `filesNeedPublicUrl` 的平台。
- 送出失敗（平台 5xx、封鎖）→ 重試 2 次後放棄，記 `notify.failed` 事件。
  **通知失敗絕不讓 run 失敗。**

### 3.7 重啟語意（銜接 SPEC-09 §7）

啟動時的 `markInterrupted()` 額外處理待核准：

- `awaiting_approval` 的 run → `cancelled`（**不是** `interrupted`）。理由：
  計畫還沒被執行過，重來的成本很低，而讓一份跨越重啟的計畫繼續有效，
  使用者對「它到底還在不在」沒有把握。
- `running`／`verifying` → `interrupted`（SPEC-09 §7 原規則）。
- 兩種都對原 chat 送一則通知，說明發生了什麼、以及可以怎麼做。

---

## 4. 需求

### FR-12-1 — Port 擴充：kind、limits、capabilities
依 §3.1 擴充 `transport/ports.ts`。三個現有／預定的 adapter 都填上正確的值。
`capabilities.push === false` 的 transport 不得用於 `engineering`。
**驗收：** 型別測試：缺 `capabilities` 的 adapter 無法編譯。測試：以
`push: false` 的 `FakeTransport` 發 engineering 需求 → 回覆說明原因、未建 run。

### FR-12-2 — Webhook 路由與共用中介層
依 §3.2 實作：簽章驗證 → body 上限 → 立即 200 → 背景處理 → 事件去重 →
allowlist。驗簽失敗不記錄 body。`registerRoutes` 在 `listen()` 之前呼叫。
**驗收：** 測試：錯誤簽章 → 401 且 `pipeline`／`intake` 未被呼叫且 log 不含
body；正確簽章 → 200 在 100ms 內回應且處理在背景進行；同一事件 id 送兩次 →
只處理一次；body 超過上限 → 413。

### FR-12-3 — 簽章短效產物 URL
依 §3.3 實作 `GET /files/:token`。Token 綁單一 artifact id ＋ 到期時間，
以 HMAC 簽章。過期／錯誤 → 404。不接受路徑參數。
**驗收：** 測試：有效 token → 200 ＋ 正確內容 ＋ `Content-Disposition`；
過期 token → 404；竄改 token → 404；`/files/../../etc/passwd` → 404
（路由不匹配）；未登記於 `artifact` 表的檔案無法透過任何 token 取得。

### FR-12-4 — Line adapter
實作 `transport/line.ts`，`kind: "webhook"`。
**實作前必須查證官方文件並記錄於檔頂註解**：簽章演算法與 header 名稱、
webhook 回應時限、訊息長度上限、push 與 reply 的配額差異、附件的交付方式
與是否必須公開 URL。**不得**假設與 Telegram／Discord 相同，也不得沿用本 SPEC
中的數字（`5000` 等）而不查證。
**驗收：** adapter 通過 SPEC-03 FR-03-2（只做傳輸）與本份 FR-12-1／12-2 的
全部條件；檔頂註解列出上述五項查證結果與來源連結；`agent:contract` 等價的
transport 冒煙測試通過。

### FR-12-5 — 一律 push，不依賴 reply token
`send()` 的每個實作都走平台的 push／主動發送路徑。**不得**在 port 上暴露
reply token，也不得在 `Notifier` 中假設有可用的 reply 視窗。
**驗收：** `grep -rin "replyToken\|reply_token" src/` 只出現在 adapter 內部的
即時 ack 路徑（若有），不出現在 `transport/ports.ts`、`app/`、`Notifier`。
測試：收訊後 60 秒才送出的訊息成功送達（以 fake 平台驗證走的是 push 端點）。

### FR-12-6 — 待回覆對話狀態機
依 §3.4 實作，含 `awaiting_clarification` 的一問一答語意（不迴圈）。
狀態存於 Run Store。每個 `(source, userId)` 同時只允許一個
pending。待核准時的新 engineering 需求 → 提示 ＋ 重貼計畫，不建新 run。
逾時 → `cancelled` ＋ 通知。
**驗收：** 測試：A 有待核准計畫時再發需求 → 未建第二個 run、回覆含原計畫摘要；
測試：訊息缺 `specPath` → `awaiting_clarification` ＋ 回問，補上路徑後繼續走
Plan；補的訊息仍然無法解析 → 視為新需求重走 Intake，**不進入第二輪追問**；
`APPROVAL_TIMEOUT_MS` 過後 → run `cancelled` ＋ 已送通知；使用者 B 的 pending
不影響使用者 A。

### FR-12-7 — 核准回覆分類
依 §3.4 兩段式分類。白名單為正規化後精確相等，不得用 `includes`。
`unrelated` → 提示先處理待確認項，不進 Intake。
**驗收：** 測試：`執行` → approve（未呼叫 LLM）；`不對，我要的是 X` →
revise 且 `revisionNote` 含「X」；`今天天氣如何` → unrelated ＋ 提示訊息；
`執行一下那個報表功能` → 走 LLM 分類，**不得**因含「執行」二字被白名單誤判為
approve。

### FR-12-8 — 雙車道佇列
依 §3.5 實作。執行車道不佔用互動車道 slot。
**驗收：** 測試：使用者 A 的 run 在執行車道跑 5 秒的 fake pipeline，期間送出
的 `狀態` 在 1 秒內得到回覆；`MAX_CONCURRENT_RUNS_PER_USER=1` 時第二個
engineering 需求得到「已有 run 進行中」＋ 進度，未啟動任何 agent。

### FR-12-9 — `狀態` 與 `取消` 指令
依 §3.5 實作，走互動車道。`取消` 會 abort run、殺掉所有 agent 子進程、
保留 worktree。
**驗收：** 測試：執行中送 `取消` → 3 秒內所有 fake agent 子進程收到 abort、
run 狀態 `cancelled`、worktree 仍存在、回覆列出保留路徑；`狀態` 回覆含階段
與逐任務狀態。

### FR-12-10 — `Notifier` 與節流
依 §3.6 實作。`task_progress` 節流；終端事件不節流；通知失敗不影響 run。
**驗收：** 測試：10 個任務在 10 秒內完成、`NOTIFY_MIN_INTERVAL_MS=60000` →
`send` 被呼叫的進度通知 ≤ 1 則，但 `run_finished` 一定送出；`send` 連續
throw → 重試 2 次後記 `notify.failed`，run 狀態仍為 `done`。

### FR-12-11 — 重啟時的 pending 與 run 處理
依 §3.7 實作。`awaiting_approval` → `cancelled`；`running`／`verifying` →
`interrupted`；兩者都送通知。
**驗收：** 測試：建立一個待核准 run ＋ 一個執行中 run → 重建服務 →
前者 `cancelled`、後者 `interrupted`，兩個 chat 各收到一則說明訊息。

### NFR-12-1 — 互動車道永遠可回應
無論執行車道多忙，互動訊息的首次回應時間 < 2 秒（不含 LLM 分類的延遲）。
**驗收：** 壓力測試：執行車道滿載 ＋ 連續 20 則互動訊息 → 全部在 2 秒內
得到首次回應或「忙碌中」。

---

## 5. 新增設定項

```
PUBLIC_BASE_URL=                       # 啟用 webhook transport 時必填，須為 https://
LINE_CHANNEL_SECRET=
LINE_CHANNEL_ACCESS_TOKEN=
WEBHOOK_MAX_BODY_BYTES=1000000
FILE_TOKEN_SECRET=                     # HMAC 金鑰，缺漏且啟用公開 URL 交付時 → config 錯誤
FILE_TOKEN_TTL_MS=900000
MAX_CONCURRENT_RUNS_PER_USER=1
NOTIFY_MIN_INTERVAL_MS=60000
```

全數納入 SPEC-01 FR-01-4 的 zod schema 與 `.env.example`。

---

## 6. 對既有 SPEC 的修正

| 被修正 | 內容 |
|--------|------|
| SPEC-01 §3.6 | HTTP server 不再「只有健康檢查」，另承載 webhook 與產物路由；啟動順序改為「註冊路由 → listen → gateway.start」 |
| SPEC-03 §3.1 | `ChatTransport` 依本份 §3.1 擴充 |
| SPEC-03 §3.4 | `main.ts` 生命週期依本份 §3.2 調整順序 |
| SPEC-03 FR-03-9 | per-user 單一佇列 → 本份 §3.5 的雙車道 |
| SPEC-03 FR-03-11 | 「有條件的進度提示」由本份 FR-12-10 的 `Notifier` 節流取代 |
| SPEC-08 FR-08-1 | 附件降級決策需額外考慮 `filesNeedPublicUrl`，走本份 §3.3 |
| SPEC-08 FR-08-9 | webhook 的持久化 seen-set 從「建議」升為**必要**（重送頻率高） |
| SPEC-11 §6 | 「Gateway 需要待核准狀態」的散文註記，由本份 FR-12-6／12-7 取代 |

---

## 7. 順序

1. FR-12-1 port 擴充（純型別，先做，讓後面全部有依據）。
2. FR-12-8 雙車道佇列 ＋ FR-12-9 指令 —— **這兩個要在 SPEC-11 的 Executor
   之前完成**，否則第一次跑長 run 就會把自己鎖住。
3. FR-12-6／12-7 對話狀態機 —— SPEC-11 FR-11-3 的實際承載，同批交付。
4. FR-12-10 `Notifier`。
5. FR-12-2 webhook 中介層 ＋ FR-12-3 產物 URL。
6. FR-12-4 Line adapter（先查證文件）。
7. FR-12-11 重啟語意。

---

## 8. 建議 ticket

1. `ChatTransport` port 擴充 ＋ 三個 adapter 填 limits／capabilities ＋ 型別測試。*(FR-12-1)*
2. 雙車道佇列重構 ＋ 測試（含 NFR-12-1 壓力測試）。*(FR-12-8, NFR-12-1)*
3. `狀態`／`取消` 指令 ＋ run abort 串接。*(FR-12-9)*
4. `PendingPrompt` 存於 Run Store ＋ 狀態機 ＋ 測試。*(FR-12-6)*
5. 核准回覆兩段式分類 ＋ 白名單 ＋ 測試（含「執行一下…」誤判案例）。*(FR-12-7)*
6. `Notifier` ＋ 節流 ＋ 失敗容忍 ＋ 測試。*(FR-12-10)*
7. Webhook 共用中介層（驗簽／body 上限／快速 ack／去重）＋ 測試。*(FR-12-2)*
8. `GET /files/:token` ＋ HMAC token ＋ ADR 0010 ＋ 測試。*(FR-12-3)*
9. `transport/line.ts` —— **先做文件查證並寫進檔頂註解**，再實作。*(FR-12-4)*
10. `main.ts` 啟動順序調整 ＋ `PUBLIC_BASE_URL` config 驗證。*(FR-12-2)*
11. 重啟時 pending／running 處理 ＋ 通知。*(FR-12-11)*
