# SPEC-06 — 邊界安全

> **v2 勘誤：** SPEC-04／05 已刪除，由 SPEC-09（Run Store ＋ ArtifactWriter）、
SPEC-10（Agent Runtime ＋ Playbook）、SPEC-11（Plan／Execute／Verify 編排）取代。
本文中的「SPEC-04」請讀作 SPEC-09／10，「SPEC-05」請讀作 SPEC-11，
「Skill」請讀作 Playbook。詳見 SPEC-00 §0。

- **狀態：** 草稿
- **負責人：** 待定
- **依賴：** SPEC-01（config、errors）、SPEC-04（`ArtifactWriter`）、SPEC-05（pipeline 持有 enrichment）
- **對應的原始發現：** 4, 5, 6, 7, 18

---

## 1. 問題

- `PathExtractor` 在*任何*使用者訊息中比對 `/Users/…`、`/home/…` 等，並把主機
  目錄樹回傳給該使用者。任何能跟 bot 說話的人都能對本機檔案系統做偵察。
- `web_summarizer` 做 `fetch(userProvidedUrl)`，沒有 scheme/host 限制
  （SSRF：`localhost`、`169.254.169.254`、內部服務），在 `.substring(0, 30000)`
  之前先下載完整 body，且沒有 timeout。
- `DesignatedOutput` 寫到 LLM 萃取進 `detectedPath` 的任何絕對路徑。
- `saveFile.ts` 的 catch 區塊把原始 `error.message` 回傳到聊天室。
- `PathExtractor.treeCache` 是無上限的 `Map`，只用 path 當 key（忽略 depth
  參數）。

加上「沒有 auth」（SPEC-03 已修），這些讓服務在任何有私密內容的機器上執行都
不安全。

---

## 2. 目標／非目標

**目標**
- 來自使用者輸入的檔案系統存取限制在一份顯式的專案 root allowlist，以 alias
  引用。
- 技能的所有對外 HTTP 走一個 SSRF-hardened、有上限的 helper。
- Artifact 寫入限制在 `DATA_DIR` 或一個 allowlist 的專案 root。
- 對使用者的錯誤是通用的 ＋ 帶 `correlationId`；細節進 log。

**非目標**
- 對 Node 進程本身做 sandbox（容器／seccomp 是部署層的事）。
- Auth（SPEC-03）。
- 超出 per-user queue（SPEC-03 FR-03-9）以外的 rate limiting。

---

## 3. 目標設計

### 3.1 `platform/workspace.ts`（取代 `PathExtractor`）

```ts
export class Workspace {
  constructor(
    private roots: Record<string, string>,   // alias → 絕對路徑，來自 config.PROJECT_ROOTS
    private logger: Logger,
    private opts = { maxDepth: 3, maxEntries: 400, maxChars: 8_000 },
  ) {}

  /** 回傳一則訊息的 enrichment blocks，或沒有。使用者錯誤永不 throw。 */
  async enrich(msg: InboundMessage): Promise<{ blocks: string[]; root?: string }> {
    const alias = parseAliasRef(msg.text);           // 只比對 "@myapp" 這種 token
    if (!alias) return { blocks: [] };
    const root = this.roots[alias];
    if (!root) { this.logger.info({ alias }, "workspace.unknown_alias"); return { blocks: [] }; }

    const tree = await this.scanTree(root);           // 受限、有上限
    return { blocks: [renderReport(alias, root, tree)], root };
  }

  /** 讀取 alias root 底下的單一檔案。受限、有大小上限。找不到／太大 → throw。 */
  async readFile(alias: string, relPath: string): Promise<{ absPath: string; content: string; sha256: string }> {
    /* 見 FR-06-9 */
  }

  private async scanTree(root: string): Promise<string> { /* 見 FR-06-2 */ }
}
```

規則：
- **輸入是 alias，不是路徑。** 使用者寫 `@myapp`；alias 到絕對路徑的對應是
  伺服器端 config。訊息中的原始路徑字串完全被忽略。
  `readFile` 的 `relPath` 是**唯一**的例外，且它是相對路徑、必須落在
  alias root 之內（見 FR-06-9）—— 它比 `scanTree` 更窄，不是放寬邊界。
- `scanTree` 解析每個項目並斷言它留在 `root` 內（`confineWithin`）。逃出 `root`
  的 symlink 被跳過。
- 深度 ≤ `maxDepth`、項目 ≤ `maxEntries`、輸出 ≤ `maxChars`（超過用標記截斷）。
  保留 `ignoreDirs`（`node_modules`、`.git`、`dist`、…）。
- v1 不做快取（見 FR-06-3）。若日後 profiling 顯示有必要，加 `lru-cache`
  （`max` ＋ `ttl`），key = `${alias}:${maxDepth}`。

### 3.2 `platform/safe-fetch.ts`

```ts
export interface SafeFetchOptions {
  timeoutMs?: number;      // 預設 8_000
  maxBytes?: number;       // 預設 2_000_000
  maxRedirects?: number;   // 預設 3
}

/** 不允許的目標 throw SecurityError；transport 問題 throw AppError("FETCH_*")。 */
export async function safeFetch(rawUrl: string, opts?: SafeFetchOptions): Promise<{ url: string; text: string }>;
```

檢查，依序：
1. 解析 URL。protocol 必須是 `http:` 或 `https:` → 否則 `SecurityError`。
2. 拒絕 URL 內的憑證；如需嚴格可限制非標準 port。
3. 解析 hostname（`dns.lookup`，所有位址）。若任一解析位址是 private／loopback
   ／link-local／CNAME 指向 metadata（`127.0.0.0/8`、`10/8`、`172.16/12`、
   `192.168/16`、`169.254/16`、`::1`、`fc00::/7`、`fe80::/10`、`0.0.0.0`），
   拒絕。用可信賴的 lib（`ip`、`is-ip`、`ipaddr.js`）—— 不要手刻 IPv6。
4. `fetch` 用 `redirect: "manual"`；每次 redirect 對 `Location` 重跑檢查 1–3，
   最多 `maxRedirects` 次。
5. 帶 `timeoutMs` 的 `AbortController`。
6. 串流讀 body；超過 `maxBytes` 就 abort → `SecurityError("body too large")`。
7. 回傳 `{ finalUrl, text }`。

以 `ctx.safeFetch` 提供給技能（SPEC-04 `SkillContext`）。全域 `fetch` 在
`skills/**` 被 lint 禁止。

### 3.3 Artifact 路徑限制

`ArtifactWriter.write`（SPEC-04 §3.4）呼叫 `confineWithin(base, target)`：

```ts
function confineWithin(base: string, target: string): string {
  const rb = path.resolve(base);
  const rt = path.resolve(target);
  if (rt !== rb && !rt.startsWith(rb + path.sep))
    throw new SecurityError(`路徑逃出 base：${rt}`, "PATH_ESCAPE");
  return rt;
}
```

- `Artifact` 上的 `projectAlias` 必須是 `config.PROJECT_ROOTS` 的 key；未知
  alias → `SecurityError("PATH_UNKNOWN_ALIAS")`。
- `filename` 會被 slugify；使用前先移除任何 `/` 或 `..`。
- `subDir` 一樣做正規化與限制。

### 3.4 對使用者的錯誤淨化

一個 boundary handler（在 `Gateway`，SPEC-03 §3.2）：

```ts
function toUserReply(err: unknown, correlationId: string): string {
  logger.error({ err, correlationId }, "request.failed");   // 完整細節在這裡
  if (err instanceof AppError && err.operational) {
    return `處理失敗：${friendly(err.code)}（代碼 ${correlationId}）`;
  }
  return `發生非預期錯誤（代碼 ${correlationId}），已記錄。`;
}
```

- `friendly(code)` 把已知 code 對應成簡短中文
  （`AI_TIMEOUT` → 「AI 服務逾時，請稍後再試」，`AI_RATE_LIMIT` → 「AI 服務忙碌中」，
  `PATH_UNKNOWN_ALIAS` → 「未設定的專案代號」，…）。
- 回覆**絕不**含 `err.message`、stack、檔案系統路徑、或 URL。

---

## 4. 需求

### FR-06-1 — 檔案系統 enrichment 以 alias 為基礎，不以路徑
`Workspace.enrich` 只對已設定的 alias（`@name`）反應。訊息中的絕對路徑字串被
忽略。`PathExtractor` 刪除。
**驗收：** `grep -rn "PathExtractor\|/Users/\|/home/\|pathRegex" src/` 無結果。
測試：帶 `/Users/secret/stuff` 的訊息 → 無 enrichment、無磁碟讀取。帶 `@myapp`
（已設定）的訊息 → 從對應的 root 做 enrichment。

### FR-06-2 — 受限、有上限的樹掃描
`scanTree` 絕不回傳 `root` 以外的項目；強制 `maxDepth`、`maxEntries`、
`maxChars`；跳過逃出的 symlink；保留 ignore 清單。
**驗收：** 測試：`root` 內指向 `/etc` 的 symlink 不被跟隨；有 1 萬個檔案的樹
產出 ≤ `maxEntries` 行且 ≤ `maxChars` 字元、結尾有截斷標記。

### FR-06-3 — 有上限的快取或不快取
`treeCache`（無上限 `Map`、忽略 depth 的 key）移除。若重新引入快取，用
`lru-cache` 且有 `max` 與 `ttl`，key 包含每個會改變結果的參數。
**驗收：** `grep -rn "new Map()" src/platform/workspace.ts` 無結果（或若保留，
有帶 `max`＋`ttl` 的 `lru-cache` import，且測試斷言淘汰行為）。

### FR-06-4 — `safeFetch` SSRF 防護
依 §3.2 實作 `platform/safe-fetch.ts`：scheme allowlist、private／loopback／
link-local IP 拒絕（透過可信 lib）、redirect 重新驗證、使用有維護的 resolver。
**驗收：** 測試（resolver stub）：`http://169.254.169.254/…` → `SecurityError`；
`http://localhost:3000` → `SecurityError`；`ftp://…` → `SecurityError`；
`https://example.com` → 允許；302 導向 `http://127.0.0.1` → `SecurityError`。

### FR-06-5 — `safeFetch` timeout ＋ body 上限
請求在 `timeoutMs` 後 abort；body 讀取超過 `maxBytes` 時 abort，不先把整個
response 緩衝下來。
**驗收：** 測試：慢速端點 → 約 `timeoutMs` 時 `FETCH_TIMEOUT`；`maxBytes:
2_000_000` 下的 5 MB body → `SecurityError("body too large")` 且連線被 abort
（未完整下載）。

### FR-06-6 — Artifact 寫入受限
`ArtifactWriter` 只寫在 `DATA_DIR` 或 `config.PROJECT_ROOTS` 的某個值之下。
`Artifact.projectAlias` 取代舊的 `detectedPath`。路徑逃出或未知 alias →
`SecurityError`。
**驗收：** 測試：`subDir: "../../etc"` → `PATH_ESCAPE`；`projectAlias: "nope"`
→ `PATH_UNKNOWN_ALIAS`；`filename: "../x"` → 寫成技能目錄內的 `x`。
`grep -rn "detectedPath" src/` 無結果。

### FR-06-7 — 對使用者的錯誤已淨化
Gateway boundary 把錯誤對應成通用訊息 ＋ `correlationId`；完整細節記 log。
沒有 `error.message`、stack、路徑、或 URL 到達聊天室。
**驗收：** 測試：某步驟 throw `new Error("ENOENT: /Users/me/.ssh/id_rsa")` →
使用者回覆既不含訊息也不含路徑、含 `correlationId`；log 記錄含完整錯誤。

### FR-06-8 — 技能內禁 `fetch`／`fs`
對 `src/skills/**` 用 ESLint `no-restricted-globals`（`fetch`）與
`no-restricted-imports`（`node:fs`、`fs`、`fs/promises`）。技能用 `ctx.safeFetch`
／回傳 `Artifact`。
**驗收：** 技能 import `fs` 或呼叫 `fetch` 時 lint 失敗；重構後通過。

### FR-06-9 — `Workspace.readFile()`：受限的單檔讀取
Harness 的工程任務輸入是**一份 spec 文件的參照**（SPEC-11 §3.2），因此需要
讀取指定檔案的內容 —— `scanTree` 只給目錄樹，做不到這件事。

```ts
readFile(alias: string, relPath: string): Promise<{ absPath; content; sha256 }>
```

規則，依序：
1. `alias` 必須是 `config.PROJECT_ROOTS` 的 key → 否則
   `SecurityError("PATH_UNKNOWN_ALIAS")`。
2. `relPath` 正規化後經 `confineWithin(root, join(root, relPath))`
   （含 SPEC-08 FR-08-8 的 Windows 大小寫正規化）→ 逃逸則
   `SecurityError("PATH_ESCAPE")`。**絕對路徑一律拒絕**。
3. 目標必須是一般檔案。symlink 解析後仍須落在 root 內，否則拒絕。
   目錄、裝置檔、FIFO → `AppError("NOT_A_FILE")`。
4. 大小 > `maxFileBytes`（預設 `262_144` ＝ 256 KB）→
   `AppError("FILE_TOO_LARGE")`，**不讀取內容**（先 `stat` 再 `readFile`）。
5. 以 `utf8` 讀取，回傳內容 ＋ `sha256`（供 SPEC-09 的 spec 快照使用）。
6. 副檔名白名單 `WORKSPACE_READABLE_EXTS`（預設 `.md,.txt,.json,.yaml,.yml`）——
   spec 文件用不到二進位檔，收窄面積沒有代價。

與 `enrich()` 的差異：`enrich` 是**推測性**的（使用者提到 alias 就掃樹），
失敗不致命（NFR-06-1）；`readFile` 是**明示性**的（使用者指名了檔案），
失敗必須 throw 並回報，不可靜默略過 —— 讀不到 spec 就不該繼續拆任務。

**驗收：** 測試：`readFile("myapp", "spec/SPEC-09.md")` → 回傳內容 ＋ 正確
sha256；`"../../../etc/passwd"` → `PATH_ESCAPE`；`"/etc/passwd"` → `PATH_ESCAPE`；
未知 alias → `PATH_UNKNOWN_ALIAS`；指向 root 外的 symlink → `PATH_ESCAPE`；
300 KB 的檔 → `FILE_TOO_LARGE` 且未讀取內容；`.exe` → 被白名單拒絕；
目錄 → `NOT_A_FILE`。

### NFR-06-1 — Enrichment 失敗不致命
掃描一個有效 root 時的磁碟錯誤記 warning 並產出無 enrichment block；pipeline
仍對裸訊息跑 router。
**驗收：** 測試：`scanTree` throw `EACCES` → `enrich` 以 `{ blocks: [] }`
resolve、warning 已記。

---

## 5. 順序

1. `confineWithin` helper ＋ 測試（workspace 與 artifacts 共用）。*(FR-06-2, FR-06-6)*
2. `platform/safe-fetch.ts` ＋ 測試。*(FR-06-4, FR-06-5)*
3. `platform/workspace.ts` 取代 `PathExtractor`；接進 `Pipeline.enrich`。*(FR-06-1, FR-06-2, FR-06-3, NFR-06-1)*
4. `ArtifactWriter` 限制 ＋ 從 `test-strategy-advisor` 拿掉 `detectedPath`。*(FR-06-6)*
5. Gateway boundary `toUserReply` ＋ `friendly(code)` map。*(FR-06-7)*
6. `skills/**` 的 ESLint 規則。*(FR-06-8)*

---

## 6. 建議 ticket

1. `confineWithin` ＋ `slugify`／path 正規化 helper ＋ 測試。*(FR-06-2/6)*
2. `platform/safe-fetch.ts`（SSRF 防護、redirect、timeout、body 上限）＋ 測試。*(FR-06-4, FR-06-5)*
3. `platform/workspace.ts`（alias 制、受限、有上限）＋ 測試；刪 `PathExtractor`。*(FR-06-1, FR-06-2, FR-06-3)*
4. 給 `Artifact` 加 `projectAlias`；在 `ArtifactWriter` 強制限制；移除 `detectedPath`。*(FR-06-6)*
5. Gateway `toUserReply` 淨化器 ＋ code→中文短語 map。*(FR-06-7)*
6. `skills/**` 的 ESLint `no-restricted-*`；修連帶問題。*(FR-06-8)*
