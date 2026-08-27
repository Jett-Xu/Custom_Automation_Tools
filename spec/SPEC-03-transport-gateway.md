# SPEC-03 — Transport 層與 Gateway

> **v2 勘誤：** SPEC-04／05 已刪除，由 SPEC-09（Run Store ＋ ArtifactWriter）、
SPEC-10（Agent Runtime ＋ Playbook）、SPEC-11（Plan／Execute／Verify 編排）取代。
本文中的「SPEC-04」請讀作 SPEC-09／10，「SPEC-05」請讀作 SPEC-11，
「Skill」請讀作 Playbook。詳見 SPEC-00 §0。

- **狀態：** 草稿
- **負責人：** 待定
- **依賴：** SPEC-01（config、errors、logger）。與 SPEC-05（pipeline）整合。
- **對應的原始發現：** 3, 11, 14, 15, 19, 20
- **阻擋：** 端到端 runtime

---

## 1. 問題

- 任何能連到 bot 的人（可被搜尋到的 Telegram username；在任何共同伺服器的
  Discord bot）都能使用它。沒有 allowlist。
- `isFrontendDevMode` 在 adapter 內部計算 —— `telegram.ts` 寫死 `false`，
  `discord.ts` 做 channel-id 比對。Transport 在決定應用層政策。
- `bot.launch()` 沒 await；沒有 `SIGINT`／`SIGTERM`；Discord client 從不
  destroy。`index.ts` 的 `catch` 在 bot 可能還活著時呼叫 `process.exit(1)`。
- 沒有平台 update id 去重；沒有並發控制。兩則訊息 → 兩次完整掃描 ＋ 各 2–4 次
  AI 呼叫。連 `"hi"` 都會送 `⏳`。
- `CoreProcessor` 做 `context.text = await PathExtractor.enrichPrompt(...)`，
  改寫了 inbound DTO。

---

## 2. 目標／非目標

**目標**
- 一個最小的 `ChatTransport` port；adapter 只做傳輸。
- 一個 `Gateway`，擁有 transport 並集中處理：auth、生命週期、去重、
  per-user 序列化，以及把工作交給 pipeline。
- 不可變的 `InboundMessage`。

**非目標**
- 路由／技能邏輯（SPEC-05）。
- 路徑 enrichment 邏輯（SPEC-06）；由 pipeline 呼叫，gateway 不碰。
- 多實例／分散式去重（in-process LRU 就夠）。

---

## 3. 目標設計

### 3.1 `transport/ports.ts`

```ts
export type TransportSource = "telegram" | "discord";

export interface InboundMessage {
  readonly source: TransportSource;
  readonly updateId: string;         // 平台唯一 id，用於去重
  readonly userId: string;           // 平台使用者 id（不是 chat id）
  readonly chatId: string;           // 回覆的目標
  readonly channelId: string | null; // Discord channel；Telegram DM 為 null
  readonly text: string;
  readonly receivedAt: number;
}

export interface OutboundMessage {
  chatId: string;
  text: string;
  files?: { name: string; content: Buffer }[];
}

export interface ChatTransport {
  readonly source: TransportSource;
  start(): Promise<void>;                 // 連線；失敗時 reject
  stop(): Promise<void>;                  // 乾淨斷線；可重複呼叫
  status(): "idle" | "connecting" | "connected" | "stopped" | "errored";
  onMessage(handler: (msg: InboundMessage) => void): void;
  send(msg: OutboundMessage): Promise<void>;
}
```

Adapter（`telegram.ts`、`discord.ts`）：
- 用 `{ token, logger }` 建構。
- 把平台事件翻成 `InboundMessage`，僅此而已 —— 沒有 mode/profile 邏輯，除了
  「忽略來自 bot／來自自己的訊息」以外沒有其他過濾。
- `start()` await 底層連線，憑證錯誤時 reject。
- `stop()` 呼叫 `bot.stop()`／`client.destroy()`，且可安全呼叫兩次。
- `status()` 反映真實連線狀態（監聽 `ready`／`disconnect` 事件）。

### 3.2 `transport/gateway.ts`

```ts
export class Gateway {
  constructor(
    private transports: ChatTransport[],
    private pipeline: Pipeline,          // SPEC-05
    private config: Pick<Config, "ALLOWED_USER_IDS">,
    private logger: Logger,
  ) {}

  async start(): Promise<void>            // 全部啟動；任一失敗則停掉其餘、rethrow
  async stop(): Promise<void>             // 全部停止，吞掉個別錯誤、記 log
  ready(): boolean                        // 有 >=1 個 transport 為 "connected" 則 true
}
```

每則 `InboundMessage`：
1. **去重** —— 若 `updateId` 已在 LRU（`max: 1000`）中，丟棄。
2. **Auth** —— 若 `userId` 不在 `ALLOWED_USER_IDS`，丟棄 ＋ 以 `info` 記 log
   （`{ event: "auth.reject", userId, source }`）。不回覆。
3. **瑣碎訊息閘** —— 空白／已知的問候語 → 送固定罐頭回覆，不呼叫 pipeline。
4. **入列** —— 推進 per-`userId` 的 queue（`concurrency: 1`，跨使用者仍平行）。
   Queue 深度上限（例如 5）；超過 → 回覆「還在處理前一個請求，請稍候」。
5. Worker：建 `correlationId`、`childLogger`，呼叫 `pipeline.handle(msg, ctx)`，
   然後 `transport.send({ chatId, text: reply })`。
6. Pipeline 的任何錯誤 → boundary handler：以 `correlationId` 記完整錯誤；回覆
   通用訊息 ＋ `correlationId`（SPEC-06 FR-06-7）。

「⏳ 處理中」提示由 worker 送出，且**只在** pipeline 通知長步驟開始時
（callback／event），或經過 1.5 秒延遲計時器後 —— 不是每則訊息無條件送。

### 3.3 Channel → profile

- Gateway **不**計算 profile。它把 `channelId` 原樣放進 `InboundMessage`。
- `app/channel-profiles.ts`（SPEC-05）從 `config` 把 `channelId → 允許的技能 tag`
  對應出來。Telegram（`channelId === null`）→ 無 profile → 所有技能可用。

### 3.4 `main.ts` 的生命週期

> **v2：** 啟動順序依 SPEC-12 §3.2 調整（webhook 路由須在 `listen()` 之前註冊）；
> 關機序列依本節與 FR-03-12 擴充為五步，因為現在有 agent 子進程與進行中的 run
> 需要收拾。

```ts
const gateway = new Gateway(transports, pipeline, config, logger);

for (const t of transports) t.registerRoutes?.(server);   // SPEC-12 §3.2
await server.listen({ port: config.HTTP_PORT });
await gateway.start();                                     // throw → main catch → exit 1

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => void shutdown(sig));

let shuttingDown = false;

async function shutdown(sig: string) {
  if (shuttingDown) {                       // 第二次 Ctrl-C → 立刻硬退
    logger.warn({ sig }, "forced exit");
    await processRegistry.killAll("SIGKILL");
    process.exit(130);
  }
  shuttingDown = true;
  logger.info({ sig }, "shutting down");

  const deadline = setTimeout(() => {
    logger.error("shutdown timed out, forcing exit");
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS).unref();

  await gateway.stop();                     // 1. 先停止收訊
  await executor.stopAll();                 // 2. abort 進行中的 run
  await processRegistry.killAllAndWait();   // 3. 確保沒有孤兒子進程（SPEC-10 FR-10-20）
  store.markInterrupted();                  // 4. 落地狀態（SPEC-09 §7）
  await notifier.flushInterrupted();        // 5. 盡力通知，失敗不阻擋
  await server.close();

  clearTimeout(deadline);
  process.exit(0);
}
```

**順序不可調換：**
- `gateway.stop()` 必須**第一個** —— 否則關機期間還在收新訊息、建新 run。
- `processRegistry.killAllAndWait()` 必須在 `executor.stopAll()` **之後** ——
  先給 executor 機會優雅 abort，殘留的才強殺。
- `markInterrupted()` 必須在殺完子進程**之後** —— 否則剛標記完的 run 又被
  一個還活著的 attempt 寫回 `running`。
- `server.close()` **最後** —— 通知可能需要 `/files/:token` 路由（SPEC-12 §3.3）。

`SHUTDOWN_TIMEOUT_MS`（預設 `30_000`）是硬上限。第二次 `SIGINT` 直接 `SIGKILL`
全部子進程並以 130 結束 —— 使用者按第二次 Ctrl-C 的意思就是「我現在就要它停」。

---

## 4. 需求

### FR-03-1 — `ChatTransport` port
依 §3.1 定義 `transport/ports.ts`。`InboundMessage` 每個欄位都是 `readonly`。
**驗收：** 介面可編譯；一個 `FakeTransport` 測試替身在 30 行內實作它，並被
gateway 測試使用。

### FR-03-2 — Adapter 只做傳輸
`telegram.ts`／`discord.ts` 不含 mode/profile/skill 邏輯。它們只連線、把事件翻成
`InboundMessage`、以及送訊息。
**驗收：** `grep -in "frontend\|skill\|mode\|profile" src/transport/*.ts` 無結果。

### FR-03-3 — 發送者 allowlist
Gateway 丟棄任何 `userId` 不在 `config.ALLOWED_USER_IDS` 的訊息，以 `info` 記
log 且不回覆。
**驗收：** gateway 測試：未列名使用者的訊息 → pipeline 未被呼叫、無 `send`、
一筆 `auth.reject` log。已列名使用者 → pipeline 被呼叫。

### FR-03-4 — 空 allowlist 是設定錯誤
空的 `ALLOWED_USER_IDS` 讓 config 驗證失敗（SPEC-01）—— 服務永不「開放」執行。
**驗收：** config 測試：`ALLOWED_USER_IDS=""` → 非零結束。

### FR-03-5 — 優雅的生命週期
每個 adapter 依 §3.1 實作 `start`／`stop`／`status`。`Gateway.start()` 在任一
transport 啟動失敗時回滾（停掉已啟動的）並 rethrow。`SIGINT`／`SIGTERM` →
`gateway.stop()` ＋ `server.close()` → exit 0。
**驗收：** 測試：transport B `start()` reject → transport A 的 `stop()` 有被
呼叫、`gateway.start()` reject。手動／整合：`Ctrl-C` 記 "shutting down" 並在
5 秒內以 0 結束。

### FR-03-6 — Gateway 透過注入接線
`Gateway` 透過建構子接收 `transports`、`pipeline`、`config`、`logger`。只在
`main.ts` 建立。
**驗收：** SPEC-01 FR-01-5 的 grep 也涵蓋這點。

### FR-03-7 — Channel id 直接傳遞，transport 無 profile 邏輯
`InboundMessage.channelId` 有填值（Discord channel id；Telegram 為 `null`）。
沒有 adapter 讀 `DC_FRONTEND_DEV_CHANNEL_ID`。
**驗收：** `grep -rn "FRONTEND_DEV_CHANNEL" src/transport/` 無結果；Discord
adapter 測試斷言 `channelId` 有被設定。

### FR-03-8 — Update 去重
最近 N 則訊息內重複的平台 `updateId` 會被丟棄。
**驗收：** gateway 測試：同一 `updateId` 送兩次 → pipeline 只被呼叫一次。

### FR-03-9 — Per-user 序列化 ＋ backpressure
同一 `userId` 的訊息一次處理一則；不同使用者平行；queue 深度有上限，超過上限
時給使用者「忙碌中」回覆。
**驗收：** 測試：使用者 A 的兩則訊息 → pipeline 呼叫不重疊（第二則在第一則
resolve 後才開始）；A 與 B 的訊息重疊；A 的第 6 個排隊項目 → 「忙碌中」回覆、
pipeline 未被呼叫。

### FR-03-10 — 不可變的 inbound message
沒有東西改寫 `InboundMessage`。Enrichment 產生新物件（SPEC-05 FR-05-5）。
**驗收：** `InboundMessage` 欄位為 `readonly`；`tsc` 拒絕測試中的改寫。

### FR-03-12 — 關機收拾進行中的 run 與 agent 子進程
依 §3.4 實作五步關機序列，順序不可調換。`SHUTDOWN_TIMEOUT_MS`（預設
`30_000`）為硬上限；逾時強制以 1 結束。第二次 `SIGINT` → `SIGKILL` 全部子進程
＋ exit 130。關機後**不得**留下任何 agent 子進程，也不得留下狀態為
`running`／`verifying` 的 run。

**驗收：** 整合測試：啟動一個有 2 個進行中 fake agent 的 run → 送 `SIGINT` →
(a) 5 秒內兩個子進程都不存在（含孫進程，SPEC-10 FR-10-4）、(b) 該 run 在
store 中為 `interrupted`、(c) 對應 chat 收到一則中斷通知、(d) 進程以 0 結束。
測試：關機期間送進來的訊息不建立新 run。測試：`stopAll` 永遠不 resolve 的
情況 → `SHUTDOWN_TIMEOUT_MS` 後以 1 結束。測試：連送兩次 `SIGINT` →
第二次立即 exit 130。

### FR-03-11 — 有條件的進度提示
「處理中」訊息只在長步驟信號時或延遲計時器後送出，絕不每則訊息無條件送。
**驗收：** 測試：瑣碎／問候訊息 → 無「處理中」提示；快速 pipeline（< 延遲）→
無提示；慢速 pipeline → 一次提示。

---

## 5. 順序

1. FR-03-1 port ＋ `FakeTransport`。
2. FR-03-2 把現有 adapter 縮到 port。
3. FR-03-3/4 auth。
4. FR-03-5 生命週期 ＋ `main.ts` signal。
5. FR-03-8/9 去重 ＋ per-user queue（`p-queue`）。
6. FR-03-11 進度提示。

---

## 6. 建議 ticket

1. 定義 `transport/ports.ts` ＋ `FakeTransport` 替身。*(FR-03-1, FR-03-10)*
2. 把 `TelegramAdapter` 重寫成符合 port（start/stop/status、event→InboundMessage）。*(FR-03-2, FR-03-5, FR-03-7)*
3. 把 `DiscordAdapter` 重寫成符合 port。*(FR-03-2, FR-03-5, FR-03-7)*
4. 實作 `Gateway`：擁有權 ＋ `start`／`stop` 回滾。*(FR-03-5, FR-03-6)*
5. 加 allowlist auth ＋ `auth.reject` logging ＋ config refine。*(FR-03-3, FR-03-4)*
6. 加 `updateId` LRU 去重。*(FR-03-8)*
7. 加 per-user `p-queue` ＋ 深度上限 ＋ 忙碌回覆。*(FR-03-9)*
8. 加瑣碎訊息閘 ＋ 有條件進度提示。*(FR-03-11)*
9. 在 `main.ts` 接 `SIGINT`／`SIGTERM` shutdown。*(FR-03-5)*
