# SPEC-09 — 執行軌跡與狀態儲存（Run Store）

- **狀態：** 草稿
- **負責人：** 待定
- **依賴：** SPEC-01（config、errors、logger）
- **阻擋：** SPEC-10（agent 執行需要記錄 attempt）、SPEC-11（編排需要狀態機）
- **取代：** 舊 SPEC-04 的 `ArtifactWriter`（併入本份 §5）

---

## 1. 問題

目標系統是「訊息 → 拆任務 → 每任務一個 agent → 獨立驗證」。這個流程有三個
特性讓「無狀態」不成立：

1. **一個 run 會跨越數分鐘到數十分鐘**，中途進程可能重啟。
2. **每個任務可能被重試、被驗證打回**，需要知道「這是第幾次、上次為什麼失敗」。
3. **使用者事後要能回查**：「上週那個需求拆了哪幾個任務？第 3 個為什麼失敗？
   驗證 agent 說了什麼？」

pino 的 stdout log 是給**開發者當下 debug** 用的，不是給使用者**事後回查**用的。
兩者需求不同：前者要人類可讀的時序流，後者要可查詢的結構化實體。

因此 Run Store 必須先於 SPEC-10／11 存在 —— 它是那兩份的狀態基礎，不是事後補的
觀測功能。

---

## 2. 目標／非目標

**目標**
- 一個 run 的完整生命週期以結構化形式落地，且可在進程重啟後續讀。
- 每個任務、每次嘗試、每個驗證判定、每份產物都可追溯到所屬 run。
- 一條 append-only 事件流，作為「軌跡線」的權威來源。
- 產物寫入集中於一處，並登記進 store。

**非目標**
- 多實例／並行寫入（單進程假設，見 SPEC-08 E-4）。
- 分析儀表板／Web UI。查詢介面是 CLI ＋ 匯出 markdown。
- 從 store 恢復並「續跑」中斷的 run（v1 只做**標記**為 `interrupted`，
  重跑由使用者發起。見 §7）。

---

## 3. 技術選型

**SQLite，透過 `better-sqlite3`。** 理由：

- 單一檔案（`DATA_DIR/harness.db`），零維運，與單實例假設一致。
- 同步 API —— store 的呼叫全部在編排器內，同步寫入省去大量 async 錯誤路徑。
- 支援 transaction —— 「建立 run ＋ 建立 N 個 task」必須原子。
- 支援查詢 —— JSON 檔案做不到「找出所有失敗的驗證」。

**不選** 的替代方案與理由：
- JSON／JSONL 檔案 → 無 transaction、無查詢、並發寫入會壞。
- `node:sqlite` 內建模組 → Node 版本綁定太緊（見 SPEC-01 `.nvmrc`），
  且 API 尚在演進。日後可換，介面（§4.3）不變。
- Postgres／Redis → 與單實例假設不符，增加維運成本無收益。

寫成 ADR：`docs/adr/0005-sqlite-run-store.md`。

---

## 4. 目標設計

### 4.1 實體關係

```
run ──┬── task ──┬── attempt ── verdict
      │          └── artifact
      └── event（append-only，可掛在 run 或 task 上）
```

- **run** — 一則使用者訊息觸發的完整流程。
- **task** — 規劃階段產出的一個工作單元（SPEC-11）。
- **attempt** — 一個任務的一次 agent 執行（SPEC-10）。重試 ＝ 新的 attempt。
- **verdict** — 一次驗證 agent 對某個 attempt 的判定。
- **artifact** — 落地的檔案。
- **event** — 軌跡線本身。**永不 UPDATE、永不 DELETE**（保留策略除外）。

### 4.2 Schema

```sql
CREATE TABLE run (
  id             TEXT PRIMARY KEY,        -- ULID，時間可排序
  correlation_id TEXT NOT NULL,
  source         TEXT NOT NULL,           -- telegram | discord | line
  user_id        TEXT NOT NULL,
  chat_id        TEXT NOT NULL,
  request_text   TEXT NOT NULL,          -- 使用者原話（一行指令，非 spec 內容）
  spec_path      TEXT,                    -- engineering：相對於 alias root
  spec_scope     TEXT,                    -- 例如 "FR-09-1..FR-09-3"，NULL = 整份
  spec_source    TEXT,                    -- spec 全文快照，之後一律用它
  spec_sha256    TEXT,
  status         TEXT NOT NULL,           -- 見 §4.4（含 done_with_gaps）
  plan_json      TEXT,                    -- 核准後的 TaskPlan 快照
  summary        TEXT,                    -- 最終回覆給使用者的摘要
  error_code     TEXT,
  ai_calls       INTEGER NOT NULL DEFAULT 0,
  total_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL,
  created_at     INTEGER NOT NULL,
  finished_at    INTEGER
);

CREATE TABLE task (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES run(id),
  seq         INTEGER NOT NULL,           -- 規劃時的順序
  title       TEXT NOT NULL,
  goal        TEXT NOT NULL,              -- 給 agent 的任務描述
  acceptance  TEXT NOT NULL,              -- 給驗證 agent 的驗收標準
  depends_on  TEXT NOT NULL DEFAULT '[]', -- JSON array of task id
  source_ref  TEXT,                       -- 對應的 spec 條目，例如 "FR-09-3"
  acceptance_verbatim INTEGER NOT NULL DEFAULT 0,   -- 1 = 逐字抄自 spec
  profile     TEXT NOT NULL,              -- agent profile / playbook id
  status      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE TABLE attempt (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES task(id),
  n            INTEGER NOT NULL,          -- 第幾次，從 1 起
  runner       TEXT NOT NULL,             -- claude-code | codex | …
  model        TEXT,
  cwd          TEXT NOT NULL,             -- worktree 路徑（相對）
  status       TEXT NOT NULL,             -- running|succeeded|failed|timeout|killed
  exit_code    INTEGER,
  usage_json   TEXT,                      -- { inputTokens, outputTokens, costUsd }
  stdout_path  TEXT,                      -- 相對於 DATA_DIR/runs/<runId>/
  stderr_path  TEXT,
  result_json  TEXT,                      -- agent 寫出的結構化結果（SPEC-10）
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  UNIQUE (task_id, n)
);

CREATE TABLE verdict (
  id          TEXT PRIMARY KEY,
  attempt_id  TEXT NOT NULL REFERENCES attempt(id),
  verifier    TEXT NOT NULL,              -- 執行驗證的 runner id
  passed      INTEGER NOT NULL,           -- 0 | 1
  reasons     TEXT NOT NULL,              -- 人類可讀，會回給實作 agent 當回饋
  raw_path    TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE artifact (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES run(id),
  task_id     TEXT REFERENCES task(id),   -- 規劃階段的產物可為 NULL
  rel_path    TEXT NOT NULL,              -- 相對於 DATA_DIR 或 alias root
  root_alias  TEXT,                       -- NULL 表示 DATA_DIR
  bytes       INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  write_mode  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE event (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   TEXT NOT NULL REFERENCES run(id),
  task_id  TEXT REFERENCES task(id),
  ts       INTEGER NOT NULL,
  type     TEXT NOT NULL,                 -- 見 §4.5
  payload  TEXT NOT NULL DEFAULT '{}'     -- JSON
);

CREATE INDEX idx_task_run    ON task(run_id);
CREATE INDEX idx_attempt_tsk ON attempt(task_id);
CREATE INDEX idx_event_run   ON event(run_id, id);
CREATE INDEX idx_run_user    ON run(user_id, created_at DESC);
```

Migration 以編號 SQL 檔管理（`src/platform/store/migrations/001_init.sql`），
啟動時比對 `PRAGMA user_version` 依序套用。

### 4.3 介面 — `platform/store/run-store.ts`

```ts
export interface RunStore {
  createRun(input: NewRun): RunId;
  setRunStatus(id: RunId, status: RunStatus, patch?: Partial<RunPatch>): void;
  saveSpecSnapshot(id: RunId, s: { path: string; scope: string | null; source: string; sha256: string }): void;
  savePlan(id: RunId, plan: TaskPlan): TaskId[];        // 原子：寫 plan ＋ 建 task

  startAttempt(taskId: TaskId, input: NewAttempt): AttemptId;
  finishAttempt(id: AttemptId, result: AttemptResult): void;
  recordVerdict(attemptId: AttemptId, v: NewVerdict): void;
  setTaskStatus(id: TaskId, status: TaskStatus): void;

  recordArtifact(a: NewArtifact): void;
  append(runId: RunId, type: EventType, payload?: unknown, taskId?: TaskId): void;

  // 查詢
  getRun(id: RunId): RunDetail | null;                  // run ＋ tasks ＋ attempts ＋ verdicts
  listRuns(q: { userId?: string; limit?: number; status?: RunStatus }): RunSummary[];
  timeline(id: RunId): EventRow[];
  markInterrupted(): number;                            // 啟動時呼叫，見 §7
}
```

- 只有這個介面碰資料庫。編排器、runner、gateway 都不寫 SQL。
- 所有方法同步。`RunStore` 在 `main.ts` 建立一次並注入。

### 4.4 狀態機

```
run:  planning → awaiting_approval → running → verifying → done | done_with_gaps
                       ↓                 ↓         ↓
                   cancelled          failed   failed
      任何狀態 → timeout | interrupted

task: pending → running → verifying → passed
                   ↓          ↓          ↓
                failed    rejected → running（重試）→ …
      → skipped（依賴的任務失敗）
      → blocked（依賴未完成）
```

`setRunStatus`／`setTaskStatus` 拒絕非法轉換並 throw
`AppError("INVALID_TRANSITION")` —— 狀態機錯誤是 bug，不是使用者錯誤。

### 4.5 事件型別

軌跡線的可讀性取決於事件命名的一致性。允許的 `type`：

| 類別 | type |
|------|------|
| Run | `run.created`、`run.spec_loaded`、`run.plan_proposed`、`run.plan_approved`、`run.plan_rejected`、`run.completed`、`run.failed`、`run.timeout`、`run.cancelled` |
| Task | `task.started`、`task.blocked`、`task.skipped`、`task.completed`、`task.failed` |
| Attempt | `attempt.started`、`attempt.output`（節流）、`attempt.finished`、`attempt.killed` |
| Verify | `verify.started`、`verify.passed`、`verify.rejected`、`verify.run_level` |
| 關機 | `run.interrupted`、`process.killed` |
| 產物 | `artifact.written` |
| 成本 | `budget.consumed`、`budget.exceeded` |

`attempt.output` 為節流摘要（每 N 秒一筆、只記行數與最後一行），**完整 stdout
落在檔案**（`stdout_path`），不進資料庫。

### 4.6 磁碟佈局

```
DATA_DIR/
  harness.db
  runs/<runId>/
    plan.json
    tasks/<taskId>/
      attempt-1.stdout.log
      attempt-1.stderr.log
      attempt-1.result.json
      verdict-1.json
    report.md              # 完成時產生，見 FR-09-6
  artifacts/<skill|task>/…  # ArtifactWriter 的輸出（§5）
```

---

## 5. `ArtifactWriter`（自舊 SPEC-04 遷入）

```ts
export class ArtifactWriter {
  constructor(
    private roots: { data: string; projects: Record<string, string> },
    private store: RunStore,
    private logger: Logger,
  ) {}

  async write(a: Artifact, ctx: { runId: RunId; taskId?: TaskId }): Promise<WrittenArtifact>;
}

export interface Artifact {
  filename: string;
  content: string;
  subDir?: string;
  projectAlias?: string;                          // PROJECT_ROOTS 的 key，絕非原始路徑
  writeMode?: "timestamped" | "overwrite" | "fail-if-exists";
}

export interface WrittenArtifact { absPath: string; relPath: string; bytes: number; sha256: string; }
```

保留舊 SPEC-04 §3.4 的全部規則：
- `stamp()`／`slugify()`／`extOf()` 只有一份，住在這裡。
- `confineWithin(base, target)` 限制在 `DATA_DIR` 或某個 `PROJECT_ROOTS` 值之下，
  逃逸 → `SecurityError("PATH_ESCAPE")`（SPEC-06 FR-06-6，含 SPEC-08 FR-08-8 的
  Windows 正規化）。
- 未知 alias → `SecurityError("PATH_UNKNOWN_ALIAS")`。
- `writeMode` 語意見 SPEC-08 FR-08-6。
- **這是整個 codebase 唯一寫產出檔案的模組**，且每次寫入都
  `store.recordArtifact()` ＋ `store.append("artifact.written")`。

---

## 6. 需求

### FR-09-1 — Store schema 與 migration
依 §4.2 建立 schema，以編號 SQL migration ＋ `PRAGMA user_version` 管理。啟動時
自動套用未執行的 migration；失敗 → fatal，不進入服務。
**驗收：** 空目錄啟動 → `harness.db` 建立且 `user_version` 等於最新編號；
重複啟動不重複套用；migration 檔語法錯誤 → 非零結束且訊息點名檔名。

### FR-09-2 — `RunStore` 是唯一的資料庫存取點
依 §4.3 實作。`grep -rn "better-sqlite3\|SELECT \|INSERT " src/` 只出現在
`src/platform/store/`。
**驗收：** grep 通過；編排器測試使用真實 store ＋ 暫存 db 檔（不 mock）。

### FR-09-3 — 狀態機強制
`setRunStatus`／`setTaskStatus` 依 §4.4 驗證轉換合法性，非法 → throw
`INVALID_TRANSITION`。
**驗收：** 測試：`done → running` throw；`pending → running → verifying → passed`
通過；每個終態不可再轉出。

### FR-09-4 — 事件流 append-only
`append()` 只 INSERT。程式碼中沒有對 `event` 表的 `UPDATE`／`DELETE`
（保留策略清掃除外）。事件 `type` 限制在 §4.5 的聯集型別。
**驗收：** `grep -rn "UPDATE event\|DELETE FROM event" src/` 只出現在保留策略
函式；型別測試：未定義的 `type` 字串無法編譯。

### FR-09-4b — Spec 快照
`engineering` 類的 run 在建立時以 `saveSpecSnapshot()` 寫入 `spec_path`、
`spec_scope`、`spec_source`、`spec_sha256`，並發一筆 `run.spec_loaded` 事件
（payload 含路徑、sha256、位元組數，**不含全文**）。之後的規劃、核准顯示、
執行、run 級驗證一律讀快照，**任何階段都不得重讀磁碟上的 spec 檔**。
`spec_source` 受 FR-09-9 的 secret 遮蔽。

**驗收：** 測試：建立 run 後在磁碟上改寫該 spec → `getRun(id).specSource`
仍為原內容、`specSha256` 不變；`timeline` 含一筆 `run.spec_loaded` 且其
payload 不含 spec 全文；`grep -rn "readFile" src/app/` 只出現在 Intake 的
載入路徑（規劃／驗證階段不出現）。

### FR-09-5 — 完整 run 可查詢
`getRun(id)` 回傳 run ＋ 其全部 task ＋ 每個 task 的全部 attempt ＋ 每個 attempt
的 verdict，單次呼叫。`timeline(id)` 依 `id` 遞增回傳全部事件。
**驗收：** 測試：建立一個 2 任務、其中一個重試一次並被駁回一次的 run →
`getRun` 回傳 2 個 task、3 個 attempt、2 個 verdict；`timeline` 順序正確。

### FR-09-6 — 軌跡匯出
`npm run trace <runId>` 把一個 run 渲染成 markdown（需求原文、spec 快照摘要、核准的計畫、
每個任務的每次嘗試與驗證結論、產物清單、耗時與成本），寫到
`DATA_DIR/runs/<runId>/report.md` 並印到 stdout。run 結束時自動產生一次。
`npm run trace --list` 列出最近 20 個 run。報告開頭須含 spec 路徑 ＋ sha256
（讓你事後確認當初讀到的是哪一版），以及每個任務的 `sourceRef` 與
`acceptanceVerbatim` 標記。
**驗收：** 對一個已完成的 run 執行 → 產生的 markdown 含全部 task 標題、每個
verdict 的 `reasons`、artifact 相對路徑；不含絕對路徑與 API key。

### FR-09-7 — `ArtifactWriter` 遷入並登記
依 §5 實作。每次寫入都登記進 `artifact` 表並發一筆 `artifact.written` 事件。
沒有其他模組寫產出檔案。
**驗收：** 舊 SPEC-04 FR-04-6 的全部驗收條件，外加：寫入後
`getRun(runId).artifacts` 含該筆且 `sha256` 與檔案內容相符。

### FR-09-8 — 保留策略
`config.DATA_RETENTION_DAYS`（SPEC-08 FR-08-6）同時清掃 store：超齡 run 及其
下游 task／attempt／verdict／event 一併刪除，對應的
`DATA_DIR/runs/<runId>/` 目錄一併刪除。**永不觸碰 `PROJECT_ROOTS`**，
也永不刪除仍被未過期 run 參照的 artifact 記錄。
**驗收：** 測試：`DATA_RETENTION_DAYS=1` ＋ 一個兩天前的 run → 啟動後該 run 與其
事件消失、目錄刪除；同齡但寫入 `PROJECT_ROOTS` 的實體檔案仍存在。

### FR-09-9 — 敏感資料不入庫
`request_text`、`goal`、`stdout` 可能含使用者貼上的內容，但**永不**寫入
API key、token、`.env` 內容。`RunStore` 在寫入前對已知 secret pattern
（config 中所有非空的 token／key 值）做遮蔽。
**驗收：** 測試：把 `GEMINI_API_KEY` 的值放進 `request_text` → 入庫後為
`[redacted]`；`stdout` 檔案同樣處理。

### NFR-09-1 — 寫入不阻塞編排
單次 store 寫入 < 5ms（同步 SQLite，WAL 模式）。`attempt.output` 事件節流至
每 2 秒最多一筆。
**驗收：** 效能測試：1000 筆 `append` < 2 秒；WAL 模式已啟用
（`PRAGMA journal_mode=WAL`）。

---

## 7. 進程重啟

v1 不做「續跑」。啟動時 `markInterrupted()` 把所有 `running`／`verifying` 的
run 與 task 標記為 `interrupted`，並發一筆 `run.failed`（`error_code:
"INTERRUPTED"`）事件。若該 run 的 chat 仍可達，送一則通知告知使用者可重發。

理由：續跑需要 agent 執行的冪等性保證，而 agent 對真實檔案系統的修改**不冪等**。
標記中斷 ＋ 保留 worktree（SPEC-10）讓使用者能人工檢視，比自動續跑安全。
寫入 ADR：`docs/adr/0006-no-auto-resume.md`。

---

## 8. 建議 ticket

1. 加 `better-sqlite3`；migration runner ＋ `001_init.sql`；ADR 0005。*(FR-09-1)*
2. `RunStore` 介面 ＋ 實作（run／task／attempt）＋ 測試。*(FR-09-2)*
3. 狀態機驗證 ＋ 測試。*(FR-09-3)*
4. 事件流 ＋ 型別化 `EventType` ＋ 節流。*(FR-09-4, NFR-09-1)*
5. `getRun`／`timeline`／`listRuns` 查詢 ＋ 測試。*(FR-09-5)*
6. `npm run trace` 渲染器。*(FR-09-6)*
7. `ArtifactWriter` 遷入 ＋ 登記 ＋ 測試（含舊 SPEC-04 全部驗收）。*(FR-09-7)*
8. 保留策略清掃（DB ＋ 目錄）。*(FR-09-8)*
9. Spec 快照欄位 ＋ `saveSpecSnapshot()` ＋ `run.spec_loaded` ＋ 測試。*(FR-09-4b)*
10. Secret 遮蔽 ＋ 測試。*(FR-09-9)*
11. `markInterrupted()` ＋ 啟動通知 ＋ ADR 0006。*(§7)*
