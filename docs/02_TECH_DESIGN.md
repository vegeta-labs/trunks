# Deal Ops Inbox — 技术方案

版本 **v0.7.13**（2026-11-03，G3 公开仓库的 CI：迁移检查的第一个提交、TC-OPS-07 只在有开发历史时运行，见文末「v0.7.13 修订」；负责人：「1、2、3 同意，按原规则审到 READY 为止」）· v0.7.12（2026-11-03，E5 模拟验收 M-06 的修复：失败 Case 的重跑命令、登录页只在配置了 OIDC 时显示组织登录，见文末「v0.7.12 修订」；负责人：「按建议」、G3 选「A 补重跑命令」）· v0.7.11（2026-11-02，E5 开工评估：镜像和 compose、维护任务单独容器、解析容器专用 seccomp / AppArmor、演示模式和静态快照、公开快照、CSRF 令牌由会话派生，见文末「v0.7.11 修订」；负责人：「D1–D10 按建议」）· v0.7.10（2026-11-02，Gmail 邮箱认证结果的部署设置和上线前验证，见 §7；M-05 F3，负责人：「行，Gmail 按你的建议改部署文档」）· v0.7.9（2026-10-31，E4 开工评估：邮箱凭据、原生 HTTP、文件的密钥轮换、维护任务的运行方式、只读检查按请求，见文末「v0.7.9 修订」）· v0.7.8（2026-10-31，E3 验收 S1：旧一代的批准在新一代回复发布时失效，见文末「v0.7.8 修订」）· v0.7.7（2026-10-31，Codex E2 第 5 轮 F23：TLS 错误算尝试，Ollama 先探测地址，见文末「v0.7.7 修订」）· v0.7.6（2026-10-30，Codex E2 第 4 轮 F20：模型调用发送前登记，见文末「v0.7.6 修订」）· v0.7.5（2026-10-30，E3 自测：§4.1 补人工变更表，降风险待确认，见文末「v0.7.5 修订」）· v0.7.4（2026-10-30，PRD v0.7.12 人工调整风险，见文末「v0.7.4 修订」）· v0.7.3（2026-10-30，E2 自测之后，见文末「v0.7.3 修订」）· v0.7.2（2026-10-30，Codex E1 第 2 轮之后，见文末「v0.7.2 修订」）· v0.7.1（2026-10-30，E1 实现中按实际情况修订，见文末「v0.7.1 修订」）· v0.7（2026-10-29）· 状态：**已批准**（负责人 2026-10-29 请 Claude 模拟审阅并批准：「请你模拟我对文档进行review，通过的话就批准」；审阅记录 （审查记录，未公开））· 依据：PRD v0.7 · v0.1 → v0.2：按自测审查修改 · v0.2 → v0.3：按 Codex 第 1 轮修改 · v0.3 → v0.4：按 Codex 第 2 轮修改 · v0.4 → v0.5：按 Codex 第 3 轮修改 · v0.5 → v0.6：按 Codex 第 4 轮修改 · v0.6 → v0.7：按 Codex 第 5 轮修改（（审查记录，未公开））

---

## 1. 关键决定

| # | 决定 | 理由 |
|---|---|---|
| T1 | TypeScript（严格模式）+ Node 22 LTS；后端 Fastify，前端 React + Vite | 与 Deal Ops Toolkit 同一种语言，将来共用金额和名单类型；Fastify 自带 JSON Schema 校验 |
| T2 | Postgres 16 一种存储：业务表、审计、任务队列（pg-boss）、附件元数据 | 小团队一台机器就能跑；不另装消息中间件；事务里同时写业务表、审计和下一步任务 |
| T3 | 附件文件存本地磁盘目录（默认）或 S3 兼容存储，适配器可换 | 大文件不进数据库；部署方选自己的存储 |
| T4 | 固定流水线，每步是一个幂等任务；模型调用只有两处（分类、字段提取），都是纯函数式步骤（输入 → JSON），不是 agent 循环；模型不写任何对外文字，也不选模板 | 可审计、可重放、防提示注入（PRD R-CLS-02、决定 4、4a） |
| T5 | 所有判断规则（提取、脱敏、信号、关联、风险、模板选择、回复检查、时限）写在 `src/lib/` 纯函数里，不访问数据库和网络 | 同 Toolkit D1：可单元测试、可变异测试 |
| T6 | 模型适配器统一为「JSON Schema 进、校验过的 JSON 出」；Anthropic、OpenAI 兼容接口、Ollama、回放四种实现 | 服务商可换；回放用于测试、CI 和演示站，结果可复现 |
| T7 | 病毒扫描用 ClamAV 独立容器（clamd，TCP；镜像 `clamav/clamav-debian`，支持 ARM 和 x86）。附件解析放在单独的 `parser` 容器（无网络、不注入任何应用密钥、只读根文件系统、非 root、cgroup 限制 CPU / 内存 / 进程数）；容器内的调度进程为**每个解析任务**用 bubblewrap 建一个独立的挂载、进程和网络命名空间：任务只看得到自己的输入文件（只读）和一个空的输出目录（tmpfs），看不到其他任务的文件；30 秒硬超时；任务结束删除输入和输出。PDF 用 pdf.js，DOCX 用自带的 zip + XML 读取（只取 `word/document.xml` 的文字，解压大小有上限；mammoth 的依赖 pako、duck 不在许可证白名单内，v0.7.1），XML 遇到 DTD 或实体声明一律不解析（只处理 pacs.008）。调度进程监听共享卷里的 Unix socket；沙盒不挂载 `/proc`（Docker 屏蔽了部分 /proc 路径，bubblewrap 无法挂新的）。bubblewrap 需要建用户命名空间：E1 的容器以 `seccomp=unconfined` 和 `apparmor=unconfined`（Ubuntu 上 Docker 的默认 AppArmor 配置禁止 mount）运行（同时 `cap-drop ALL`、`no-new-privileges`、只读根、无网络、非 root）；每个任务另有 bubblewrap 加载的 seccomp 过滤器（镜像构建时生成）：禁止新建命名空间、mount、keyring、BPF、io_uring、ptrace、userfaultfd、perf 事件等，TC-ING-10 验证任务内 `unshare` 被拒（自测 WR-F3）；调度进程读结果时不跟随符号链接，应用侧校验结果格式（WR-F7）；E5 打包时换成在 Docker 默认 profile 上只放开命名空间和 mount 的专用 seccomp / AppArmor profile（v0.7.11 起，见文末「v0.7.11 修订」；不再用 `unconfined`）；Ubuntu 24.04 主机原需 `kernel.apparmor_restrict_unprivileged_userns=0`；专用 AppArmor profile 带 `userns` 权限后**不再需要**（2026-11-02 实测：GitHub Ubuntu 24.04 runner，sysctl 不改，profile 为 enforce，TC-ING-10 和 TC-OPS-02 通过；profile 的 mount 规则按 complain 模式记录到的操作逐条写出）。主进程只做有上限的 MIME 解码（part 数、嵌套深度、解码后大小） | worker 线程不能隔离文件系统和环境变量（Codex 第 1 轮 R3）；同一容器内的任务之间也要互相隔离（第 2 轮 R31）；ClamAV（GPL）和 bubblewrap（LGPL）都是独立进程，不影响本项目许可证 |
| T8 | 数据库权限按 §4.1 的逐表清单：`audit` 对 `app` 和 `maintenance` 只有 INSERT / SELECT、对其他角色只有 SELECT（另加触发器拒绝 UPDATE / DELETE）；`message`、`message_file`、`directory_snapshot`、`user_event` 只插入；加密内容放在可更新的 `secret_blob` 表，逻辑行不可变 | PRD C-AUD-2、C-AUD-5；密钥轮换只改 `secret_blob`（第 2 轮 R12） |
| T9 | 审核界面里原始邮件只显示纯文本（HTML 转文本），不渲染 HTML、不加载任何远程资源；CSP `default-src 'self'`，无行内脚本 | EchoLeak 的教训（调研 B §4） |
| T10 | 所有邮箱只读，代码里没有任何写邮箱或发信的调用；回复由人复制 | PRD 决定 5 |

---

## 2. 结构

```
deal-ops-inbox/
  src/
    lib/            纯函数：money, dates, text, uetr, iban, amounts, references, redact,
                    signals, classify-merge, fields, link, risk, templates, reply-check,
                    business-time, audit-hash, csv（Toolkit 格式）, events, actions
    adapters/
      mailbox/      gmail.ts, graph.ts, imap.ts, eml.ts, eval.ts  （接口 §3.1）
      llm/          anthropic.ts, openai-compatible.ts, ollama.ts, replay.ts （§3.2）
      files/        disk.ts, s3.ts
      kyc/          folder.ts, webhook.ts
      events/       webhook.ts
    pipeline/       ingest, scan, parse, content_signals, extract, redact, classify,
                    fields, link, risk, reply, route, emit  —— 每步一个 pg-boss 任务
    store/          数据库访问（SQL 迁移、查询），审计写入，加密
    server/         Fastify：API、登录、会话、导入、导出
    web/            React 审核界面
    config/         YAML 读取和校验（zod），默认配置包
  parser/           解析容器：调度进程 + bubblewrap 任务
  config/default/   cases.yaml, templates/*.yaml, queues.yaml, risk.yaml, retention.yaml
  eval/             评测集（独立 agent 编写，见测试计划 §4）和评测脚本
  docs/             设计文档（中文）；docs/en/ 英文使用文档（PRD R-OPS-02）
  deploy/           解析容器的 seccomp 和 AppArmor profile、compose 的演示覆盖文件（v0.7.11）
  Dockerfile        应用镜像（app、maintenance、migrate 共用）
  docker-compose.yml
```

`src/lib/` 里的 Toolkit 规则（C-EXT-2 备注号匹配、C-LNK-3 姓名相似度、C-DIR-3 CSV 别名）从 Toolkit 复制并注明来源（同一作者），连同 Toolkit 对应的测试用例一起搬过来，保证口径一致。

## 3. 接口

### 3.1 邮箱适配器
```ts
interface MailboxAdapter {
  id: string                                      // 内部 ID（不随改名变化）
  name: string                                    // 配置里的邮箱名称
  capabilities: { push: boolean; trustedAuthResults: boolean }
  start(onMessage: (ref: MessageRef) => Promise<void>): Promise<void>   // 推送或 IDLE
  catchUp(cursor: string | null): Promise<{ refs: MessageRef[]; cursor: string; resync?: boolean }>   // resync：游标失效，全量重列（C-ING-5）
  fetchRaw(ref: MessageRef): Promise<{ raw: Buffer; serverReceivedAt: string } | { gone: true }>   // gone：服务商确认已不存在（C-ING-5）
  renew(): Promise<void>                          // 订阅续订（Gmail watch；Graph 在 v1 为空操作，v0.7.9）
}
```
- 只读：接口没有任何写入或发送方法（PRD 决定 5）。CI 检查（测试计划 TC-OUT-09）：AST 扫描禁止调用 Gmail 的 `users.messages.send` / `insert` / `import` / `modify`、`users.drafts.*`；Graph 对 `/messages` 的 POST / PATCH、`/sendMail`、`/send`、`/reply`、`/replyAll`、`/forward`、`/createReply`、`/createReplyAll`、`/createForward`；IMAP 的 `APPEND`、`STORE`、`COPY`、`MOVE`、`EXPUNGE`，以及以读写模式打开邮箱；任何 SMTP 传输。依赖检查禁止 SMTP 客户端包（nodemailer、smtp-* 等）。类型测试断言 `MailboxAdapter` 只有上面列出的方法。Fastify 的 `reply.send`、pg-boss 的 `boss.send` 不受影响。
- 权限（PRD R-ING-07）：
  - **Microsoft 365：** 只通过 Exchange「RBAC for Applications」给指定邮箱分配 `Application Mail.Read`；不在 Entra 做任何 `Mail.*` 全租户同意（两者会叠加）。启动检查按 PRD C-ING-4（人工核查记录 + 可选的自动 Entra 检查 + 正向 / 反向读取探测）。
  - **Gmail：** 只用 `gmail.readonly`。
  - **IMAP：** 部署方账号；只用 `EXAMINE`（只读打开）和读取命令；文档要求关闭该账号的 SMTP 发送，无法关闭时写明剩余风险。
  - **`.eml`：** 无权限。
  - **`eval`：** 评测用适配器（测试计划 §4.2），从标注读取邮箱声明和此前的邮件。
- 认证结果来源（PRD C-SIG-1.1）：只有配置声明了 `strips_external_auth_results: true` 的 M365 / Gmail / IMAP 邮箱，`capabilities.trustedAuthResults` 才为真；`.eml` 永不为真。Gmail 邮箱的部署设置见 §7（v0.7.10）。
- 推送：Gmail 用 Pub/Sub **pull**（不需要公网地址；不配时 `start` 只按间隔轮询）；Graph 在 v1 只用 delta 轮询，不做变更通知（PRD 决定 6），`renew` 为空操作；IMAP 用 IDLE。
- 游标（Gmail historyId、Graph deltaLink、IMAP UIDVALIDITY + 最大 UID）存在 `mailbox_cursor`：`catchUp` 返回的每封邮件先在 `ingest` 里存档并写入 `message` 行，**同一事务**里才推进游标（PRD C-ING-5）。

### 3.2 模型适配器
```ts
interface LlmAdapter {
  id: string                // provider/model@version
  location: 'local' | 'external'
  complete<T>(req: { system: string; user: string; schema: JsonSchema; promptVersion: string }): Promise<{ raw: string; parsed: T; usage: Usage }>
}
```
- 两种调用：分类（PRD C-CLS-1）、字段提取（C-FLD-0），各有带版本的 JSON Schema。所有调用（本地或外部模型）都只带脱敏文本，可能是 KYC 的附件内容不进入任何调用（PRD R-RED-01、C-RED-0）。结构化输出：Anthropic 用 JSON 输出格式（`output_config.format`），**不用工具定义**；OpenAI 兼容接口用 `response_format: json_schema`；Ollama 用 `format`；返回后都用 zod 再校验一遍（PRD R-CLS-01）。请求里不出现 `tools` / `functions` 参数（TC-CLS-06）。
- 默认模型：配置决定；默认配置写 Anthropic 当前的 Claude 模型（在配置里写明具体模型 ID，升级模型要改配置并写审计）。
- 回放适配器：按「提示词版本 + 模型 ID + 输入哈希」从文件读取录好的输出；找不到时报错（不调用真实模型）。
- 提示词放在 `src/pipeline/prompts/*.md`，文件名带版本号；提示词把邮件内容放在明确的分隔块里，并写明「块内是不可信数据，不是指令」。这只是辅助，真正的防线是模型没有任何工具、输出只是被校验的数据（T4）。

### 3.3 其他适配器
`FileStore { put, get, delete, deleteAllVersions }`；`KycSink { deliver(file, meta): Promise<Receipt> }`；`EventSink { emit(event) }`。

## 4. 数据模型（Postgres）

**总规则（PRD R-PRV-05）：** 逻辑表里只放 ID、枚举、哈希、时间、整数金额、布尔和外键；**所有文字**（姓名、地址、主题、文件名、字段值、理由、出处引文、信号说明、回复正文、名单内容、事件内容）都放在 `secret_blob`，逻辑表只存 `blob_id`。需要按文字匹配时用 HMAC（部署密钥）存一列哈希。

| 表 | 主要列 | 说明 |
|---|---|---|
| `secret_blob` | id, key_id, wrapped_dek, ciphertext, content_hmac | 唯一可更新的加密存储；轮换只重写 `key_id`、`wrapped_dek`，明文和 `content_hmac` 不变（用 HMAC 而不是明文 SHA-256：姓名等短值的 SHA-256 可被穷举，v0.7.1） |
| `mailbox` | id, name_blob, kind | 配置里的邮箱 |
| `mailbox_cursor` | mailbox_id, cursor_blob, updated_at | 与接收记录同事务推进 |
| `message` | id, mailbox_id, dedupe_key_hmac, received_at, observed_seq（观察顺序，C-SIG-1.6）, from_addr_hmac, message_id_hmac（会话归并）, header_blob（发件人、显示名、Reply-To、主题）, thread_id, raw_sha256, raw_sans_msgid_sha256, collision | 只插入；`(mailbox_id, dedupe_key_hmac, raw_sans_msgid_sha256)` 唯一（C-ING-1） |
| `message_file` | id, message_id, kind (original / kyc_stripped), sha256, file_ref, created_at | 只插入；删除见 §4.1 |
| `attachment` | id, message_id, parent_id, ordinal, depth, name_blob, kind（pdf / txt / csv / eml / docx / xml / image / other）, size, sha256, file_ref, scan_status, parse_status, maybe_kyc, source_deleted | 状态列可更新（写审计）；KYC 相关字段只在全部转交成功后改变（C-PRV-2） |
| `attachment_text` | attachment_id, text_blob, facts_blob（页数、无文字层页数、pacs.008 条目、嵌套邮件） | 解析产物；KYC 替换时删除 |
| `kyc_delivery` | attachment_id, target, state (pending / delivered / failed), receipt_blob, at | 逐个附件的转交回执 |
| `kyc_replacement` | message_id, step (1–5), stripped_sha256, at | 替换进度，可从中断处继续 |
| `case` | id, message_id, previous_case_id（同一会话的上一个 Case，C-ING-3）, flags（附件被拦截 / 超限 / MIME 解码失败）, failed_stage, manual_revision, system_revision, processing_generation, pipeline_complete_generation, status, risk, queue, assignee, due_at, closed_at, outcome, hold, snapshot_id | `manual_revision`：人的修改和名单刷新才加 1（核实任务、批准、事件绑定它）；`system_revision`：流水线结果发布时加 1；`processing_generation`：人工修订、名单刷新、配置哈希或模型 / 提示词 / Schema 版本变化时加 1，任务携带它；KYC 替换也使其加 1；`pipeline_complete_generation`：该代数最后一步（`emit`）发布时写入，批准和复制要求它等于当前代数 |
| `directory_snapshot` | id, deals_version, contacts_version, per_deal(jsonb: `{deal_id: {commitment, bank, ledger}}`), created_at | 只插入（PRD C-LNK-0） |
| `stage_run` | case_id, stage, generation, input_identity, result_blob, reused, created_at | `(case_id, stage, generation)` 唯一：每一代每步只有一个结果，重复投递的任务不再发布（v0.7.1 自测 CC-F3）；新一代输入相同时复用旧结果、为新一代记一行（`reused`），并照常推进到完成（CC-F2）；`input_identity` = 输入哈希 + 配置哈希 + 模型 / 提示词 / Schema 版本 + `snapshot_id` + `manual_revision` |
| `case_label` | case_id, class_id, confidence, source (model / rule / person), reason_blob | |
| `case_field` | case_id, field, value_blob, confidence, source, provenance_blob, status (ok / void / multiple / conflict), confirmed_by | 银行账号只存后 4 位 |
| `model_output` | case_id, prompt_version, model_id, input_sha256, attempt (1 / 2), raw_blob, error, created_at | 每次模型调用（含不合格回复和服务商错误）一结束就保存；流水线步骤重试时复用，同一请求最多调用模型两次（PRD C-FLD-0）；只插入；按保存期删除（v0.7.3） |
| `model_attempt` | case_id, prompt_version, model_id, input_sha256, attempt (1 / 2), reserved_at | 每次模型调用**发送前**先在单独提交的事务里登记；登记了却没有对应的 `model_output`（保存失败或进程退出），重试时按「可能已发出」算一次失败的尝试，不再发送，所以保存失败也不会有第三次调用（Codex E2 第 4 轮 F20）；只插入，设置错误（确定没发出）时删除这条登记；按保存期删除 |
| `case_link` | case_id, kind (contact / commitment / deal / bank_line), target_id, source (auto / person) | |
| `case_signal` | case_id, signal, value, detail_blob, batch (metadata / content), input_sha256, computed_at | 两批写入（元数据信号在 `ingest`，内容信号在 `content_signals`），之后不再写（C-SIG-1） |
| `reply` | id, case_id, revision, template_id, recipient_blob, text_blob, content_sha256, check_result, status, approved_by, approved_manual_revision | 批准绑定四项（PRD C-DRF-8） |
| `risk_adjustment` | id, case_id, level, computed_at_set（C0）, reasons（R0：类别 ID 和条款 ID 的 jsonb）, state (active / replaced / cancelled / void), by_user, reason_blob, created_at, ended_at | PRD C-RSK-3 ①–⑦：每个 Case 最多一行 `active`（部分唯一索引）；新调整把旧行标 `replaced`；自动失效在 `risk` 步的发布事务里标 `void` 并写审计 |
| `verification_task` | id, case_id, state (open / checklist_done / approved / invalidated), bound_manual_revision, bound_contact_id, steps(jsonb), completed_by, completed_at, approved_by, approved_at, cooling_until | 完成人 ≠ 批准人用数据库约束；批准时在同一事务里按 `user_event` 全部历史检查 PRD C-FRD-5 |
| `user_event` | id, user_id, type (created / role_granted / role_removed / credential_reset / disabled), role, by_user, at | 只插入 |
| `app_session` | id_hmac, user_id, csrf_hmac, created_at, expires_at | 会话；令牌本身只在 cookie / 页面里，库里只有 HMAC；退出和凭据重置时删除（v0.7.1）。v0.7.11 起 CSRF 令牌由会话派生，`csrf_hmac` 不再使用（迁移只向前，列保留） |
| `redaction_map` | message_id, placeholder, value_blob, source_attachment_id | 来源附件（正文来源为空）；KYC 替换时删除来源为 KYC 附件的行 |
| `directory_version` | id, kind, deal_id, imported_at, imported_by, file_sha256 | |
| `deal`, `commitment`, `bank_line`, `ledger_line`, `contact`, `contact_email` | 文字列都是 `*_blob`；匹配用 HMAC 列（交易用 `deal_key` = HMAC(交易名)，跨版本稳定；`contact_email` 每个邮箱一行 HMAC） | 每行带 `directory_version` |
| `audit` | seq（唯一）, time, actor, type, case_id, payload, prev_hash, hash | 不可更新；不含个人数据（C-AUD-5）；对其他表**不设外键**（只存 ID）。写入：READ COMMITTED；业务事务末尾 `pg_advisory_xact_lock(<固定键>)`，然后**另一条语句**读 `ORDER BY seq DESC LIMIT 1` 的链头，计算并插入；`seq` 唯一约束冲突时整个事务重试；不用 Postgres 序列；哈希用 RFC 8785 JCS |
| `audit_detail` | id, sha256, case_id, content_blob, source_attachment_ids, created_at | `(sha256, case_id)` 唯一（NULLS NOT DISTINCT）：同样的内容在两个 Case 里各一行，保存期和 KYC 删除互不影响（自测 LK-F4）； 个人数据的值（含模型请求和响应）；按保存期删除；KYC 替换时删除 `source_attachment_ids` 含 KYC 附件的行（审计行的哈希保留） |
| `event_outbox` | id, case_id, case_event_seq, type, event_blob, status, attempts, next_attempt_at | `(case_id, case_event_seq)` 唯一；`id` = HMAC(case_id + case_event_seq)；同一 Case 按序发送（PRD C-OUT-1） |
| `file_write_intent` | id, object_key, purpose, created_by_role, created_at | 写对象之前先提交；对象键 = 所属对象 ID（`message_id` 或 `attachment_id`）+ 内容哈希的 HMAC（存储服务商无法用已知文件的哈希测试是否存在，自测 LK-F5），不同邮件的相同内容是不同对象，互不共享；重试写同一键；对应数据库记录提交后由创建它的角色删除；清理任务（每小时以 `maintenance` 角色运行；v0.7.11 起在 `maintenance` 容器里，之前在 `serve` 里）删除超过 1 小时仍无对应记录的对象；清理和接收对同一对象键各取事务级 advisory lock，清理在锁内复查记录和更新的写入意图，接收在锁内确认对象仍在、不在则重写（自测 CC-F1） |
| `file_deletion_job` | id, file_ref, delete_all_versions, reason (retention / kyc), created_at | 与删除数据库行同一事务写入；文件全部删除成功后才删除本行；后台任务重试 |
| `event_state` | case_id, type, last_value_sha256 | 「值变化才发」的依据 |
| `app_user` | id, username_blob, username_hmac, password_hash (argon2id), role, oidc_sub_hmac | |
| `key_rotation` | key_id, table, last_id, state | 轮换进度 |

### 4.1 权限和删除顺序

| 角色 | 权限 |
|---|---|
| `app`（API + 流水线） | SELECT：全部表。INSERT（完整清单）：`mailbox`、`mailbox_cursor`、`message`、`message_file`、`attachment`、`attachment_text`、`file_write_intent`、`directory_version`、`directory_snapshot`、`deal`、`commitment`、`bank_line`、`ledger_line`、`contact`、`contact_email`、`app_session`、`case`、`stage_run`、`case_label`、`case_field`、`model_output`、`model_attempt`、`case_link`、`case_label_change`、`case_field_change`、`case_signal`、`redaction_map`、`reply`、`risk_adjustment`、`verification_task`、`user_event`、`app_user`、`secret_blob`、`audit`、`audit_detail`、`event_outbox`、`event_state`、`kyc_delivery`、`kyc_replacement`、`key_rotation`（只建初始行）、`mailbox_credential`（v0.7.9）。UPDATE（完整清单）：`mailbox_credential`（v0.7.9）、`case`、`case_label`、`case_field`、`case_link`、`attachment` 状态列、`reply`、`risk_adjustment`（`state`、`ended_at`）、`verification_task`、`kyc_delivery`、`event_outbox` 状态列、`event_state`、`mailbox_cursor`、`app_user`。DELETE：只限 `file_write_intent`（只能删 `created_by_role = app` 的行，行级策略）、`app_session` 和 `model_attempt`（只删确定没发出的那次登记，v0.7.6）。拥有 pg-boss 的队列表（迁移建 `pgboss` schema 并交给 `app`，pg-boss 以 `createSchema: false` 启动，`app` 不需要数据库级 CREATE 权限）。**规则（自测 WR-F4）：** `app` 拥有的对象里可能被植入触发器或函数，所以任何由所有者运行或所有者拥有的代码（迁移之外的 SECURITY DEFINER 函数、维护脚本）都不得读写 `app` 拥有的对象；E4 的 `enqueue_kyc_continuation` 由 `app` 拥有（SECURITY DEFINER 只带 `app` 的权限，`SET search_path = pgboss, pg_temp`）。迁移测试从空库开始，在 `app` 授权下完整处理一封带附件的邮件（附件解析、信号、字段、回复、核实任务、事件）必须成功 |
| `maintenance`（保存期和 KYC 任务） | SELECT 全部表；INSERT `audit`、`audit_detail`、`message_file`、`file_deletion_job`、`file_write_intent`、`kyc_replacement`、`kyc_delivery`、`secret_blob`；UPDATE `kyc_replacement`、`kyc_delivery`、`attachment` 状态列（含 `source_deleted`）、`case.processing_generation`、`case.previous_case_id`（只能置空，v0.7.9）、`directory_version.unreferenced_since`（v0.7.9）；按下面顺序 DELETE；EXECUTE 数据库函数 `enqueue_kyc_continuation(case_id, generation)`（SECURITY DEFINER，只能往 pg-boss 插入这一种续跑任务，不能读写队列里的其他任务）；运行孤立文件清理任务（`file_write_intent` 超过 1 小时无对应记录的对象）；DELETE `file_deletion_job`、`file_write_intent`；不能 UPDATE / DELETE `audit` |
| `rotation`（密钥轮换） | SELECT `secret_blob`、`message_file`、`attachment`、`key_rotation`、`file_deletion_job`、`file_write_intent`、`audit`（v0.7.9）；INSERT / UPDATE `key_rotation`；UPDATE `secret_blob.key_id`、`wrapped_dek`。文件存储：改写文件头、删除该对象的旧版本（v0.7.9，见文末） |

保存期删除顺序（一封邮件，同一事务：先写 `file_deletion_job`，再删数据库行；提交后由后台任务删文件）：（v0.7.9）后一封 Case 的 `previous_case_id` 置空 + `retention.link_cleared` 审计 → `event_outbox`、`event_state` → `reply`、`risk_adjustment`、`verification_task` → `case_label`、`case_field`、`case_label_change`、`case_field_change`、`model_output`、`model_attempt`、`case_link`、`case_signal` → `stage_run` → `audit_detail` → `kyc_delivery`（引用 `case`，v0.7.9 自测 F1）→ `case` → `kyc_replacement`、`redaction_map` → `attachment_text`、`attachment` → `message_file` → `message` → 这些行引用的 `secret_blob`；文件：`message_file` 和 `attachment` 的文件及对象存储全部版本。名单版本（`directory_version` 及其行、`secret_blob`）在不再被任何 `directory_snapshot` 引用后按期删除；`directory_snapshot` 在不再被任何 Case 引用后删除。外键一律 `ON DELETE RESTRICT`，由上面的顺序保证可删；迁移测试在真实授权和外键下把四个完整流程各跑一遍：接收（`app`）、保存期删除和 KYC 替换（`maintenance`）、密钥轮换（`rotation`）。文件删除失败时 `file_deletion_job` 保留并重试，在界面提醒；数据库已删的行不回滚。KYC 替换（PRD C-PRV-2）第 ④ 步同样先写 `file_deletion_job`。

## 5. 安全

- **登录：** 本地账号（argon2id）或 OIDC（部署方自己的身份提供方）；会话 cookie `HttpOnly; Secure; SameSite=Strict`（`Secure` 始终开启，只有显式的开发设置能关闭；`trustProxy` 只信任配置的代理）；所有改动请求带 CSRF token。登录、CSRF 和「先改密码」检查按**匹配到的路由**默认拒绝，只有登录和 OIDC 回调等少数路由公开（自测 WR-F1：按原始 URL 字符串判断会被 `/%61pi/…` 绕过）；改自己的密码时结束该用户的其他会话；请求日志只记路径，不记查询字符串。角色：reviewer（处理 Case、改回复）、approver（另加：批准核实任务、调低风险）、admin（另加：用户、配置、导入）。
- **密钥和凭据：** 只从环境变量或 Docker secret 读；不写进配置文件和日志；数据库角色密码以 SCRAM 校验值设置，密码本身不进 SQL 语句（自测 WR-F9）；启动时检查必需的密钥存在。初始 admin 密码从 secret 读（`INITIAL_ADMIN_PASSWORD_FILE`），首次登录必须修改；测试断言应用和容器日志里没有凭据。
- **静态加密（PRD R-PRV-05）：** 附件和原始邮件文件、`secret_blob` 都用信封加密（每个对象一个数据密钥，AES-256-GCM，数据密钥用主密钥包装，记录主密钥 ID）。解析任务的输入和输出在 tmpfs 上，任务结束删除。
- **密钥轮换：** 新主密钥加入 `DOI_MASTER_KEYS`，并由 `DOI_ACTIVE_KEY` 显式指定为写入用密钥（v0.7.9）；单独命令 `doi rotate-keys`（`rotation` 角色，不在服务进程里，v0.7.9）逐个重新包装文件和 `secret_blob` 的数据密钥（可中断续跑，进度记在 `key_rotation`）；全部完成并抽样校验后，旧主密钥才可移除；文档写明：恢复旧备份需要保留当时的主密钥。
- **网络（出站清单，按配置启用）：** 邮箱（Gmail API + Pub/Sub、Microsoft Graph、IMAP 服务器）、两个令牌端点（`oauth2.googleapis.com`、`login.microsoftonline.com`，v0.7.9）、模型服务商、S3 兼容存储、OIDC 身份提供方、事件 webhook、KYC webhook；另有两个不带邮件内容的连接：ClamAV 的病毒库更新（freshclam，演示模式关闭）和可选反向代理 Caddy 向 Let's Encrypt 申请证书（v0.7.11，英文文档审查）。webhook 只允许 HTTPS、不跟随重定向、带 HMAC 签名；KYC 文件夹目标里的文件名由系统生成（`<case_id>-<序号>.<扩展名>`），不用附件原名。v1 不需要任何入站地址（Graph 不做推送，PRD 决定 6）。解析容器无网络。演示模式不需要任何出站。
- **许可证策略：** 应用依赖只允许 SPDX：MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause、ISC、0BSD；开发工具同上，另有显式例外清单（写理由）；外部组件（独立进程，不链接）单独列出并保留声明：PostgreSQL（PostgreSQL License）、ClamAV（GPL-2.0）、bubblewrap（LGPL-2.0-or-later）。
- **模型调用：** 只带脱敏后的文本（R-RED）；请求和响应全文只进 `audit_detail`，审计行只存其哈希。
- **渲染：** T9；回复编辑框是纯文本。
- **依赖：** 每个依赖在 §8 写理由和许可证；CI 跑 `npm audit --omit=dev`（high 及以上失败）和按上面策略的许可证检查。

## 6. 流水线

```
ingest → scan → parse → content_signals → extract → redact → classify → fields → link → risk → reply → route → emit
```
- `ingest`：取原始邮件、有上限的 MIME 解码、存档、去重、元数据信号、保存名单快照、推进游标——全部在一个事务里，并由全局串行锁保护（保证 `first_time_sender` 按观察顺序，PRD C-SIG-1.6）。 写原始邮件文件之前先提交 `file_write_intent`（技术方案 §4），文件写好后在上述事务里写 `message_file` 并删除该意图。
- `scan`：每个附件交 ClamAV。`parse`：扫描通过的附件交解析容器（T7）。`content_signals`：在全部附件解析之后计算 `hidden_text`、`injection_markers` 并冻结。`extract`：规则提取（在原文上）。`redact`：KYC 判断（C-RED-0）和脱敏，在任何模型调用之前。
- **结果发布：** 每步的事务里：`SELECT … FROM case WHERE id = $1 FOR UPDATE` 锁住 Case 行；若任务携带的 `processing_generation` 与当前值不同 → 放弃本次结果（过期任务），不排下一步；否则写 `stage_run`（唯一键防重复）、写本步产出、`system_revision + 1`、写审计、在同一事务里排下一步。若 `stage_run` 已有相同 `input_identity` 的结果则复用并确保下一步已排队。 KYC 替换（PRD C-PRV-2）同样先锁 Case 行，把 `processing_generation` 加 1，并把来源附件标 `source_deleted`；之后任何读取这些附件的任务都会因代数不同或来源已删而放弃结果。 KYC 替换在同一事务里调用 `enqueue_kyc_continuation` 排一个「续跑」任务：新代数从 `extract` 往后重跑（规则提取要重新做，因为原来的提取结果可能来自已删附件的文字），来源已删的附件只按文件名和类型处理；`extract` 的输入变了，其后各步按新的 `input_identity` 重算，只有输入完全相同的步骤结果才复用；最终写入 `pipeline_complete_generation`。
- 失败重试 3 次（指数退避）；仍失败则 Case 标「处理失败」，显示在界面（含失败的步骤），原始邮件不受影响，可手动重跑：`doi rerun-failed [case id …]`（v0.7.12）。
- 人直接调整风险（PRD C-RSK-3 ①–⑦）→ `manual_revision + 1`、`processing_generation + 1`，从 `risk` 往后重算；`risk` 步读当前 `active` 的调整，按 ④⑤ 计算最终风险，需要失效时在本步的发布事务里把它标 `void`（不改修订号和代数），后续步骤照常。
- 人修改了类别、字段或关联 → `manual_revision + 1`，从 `link` 往后重算，用 Case 的快照；人已确认的字段、人工关联不被覆盖；人改过的回复不被覆盖，新生成的回复并列显示。人点「按最新名单重新关联」→ 新快照、`manual_revision + 1`，从 `extract`（备注号部分）往后重算，信号不重算（PRD C-LNK-0）。
- 回复批准和复制不在流水线里，由人触发，按 PRD C-DRF-8。

## 7. 部署与版本

- `docker-compose.yml`：`migrate`（一次性）、`app`（API + worker + 前端静态文件）、`maintenance`（保存期和 KYC 替换，v0.7.11）、`parser`（无网络，内含 bubblewrap）、`db`（Postgres 16）、`clamav`；数据卷：数据库、附件目录。首次启动跑迁移、建立三个数据库角色（§4.1）、用 secret 里的初始密码建立 admin（首次登录必须修改）。细节见文末「v0.7.11 修订」。
- Gmail 邮箱的认证结果（v0.7.10，M-05 F3，（审查记录，未公开））：Gmail 投递时由 `mx.google.com` 写 `Authentication-Results`。部署文档要求 Gmail 邮箱配置 `trusted_authserv_id: mx.google.com` 和 `strips_external_auth_results: true`；不配置时每封邮件都得到「认证头来自未知服务器」（风险 +1），认证显示「未知」。**上线前必须验证：** Gmail 是否剥离外来的、authserv-id 同为 `mx.google.com` 的 `Authentication-Results`（从外部发一封自带伪造 `Authentication-Results: mx.google.com; …` 头的邮件，用 Gmail API 取回原文，确认伪造的那条**已不存在**，只剩 Gmail 自己写的；只看最上面一条不够，Gmail 可能只是在前面加了自己的一条而保留伪造的，Codex E4 第 10 轮 F3）；验证不通过就保持 `false`。规则（PRD C-SIG-1.1）不变。
- 演示模式：环境变量 `DEMO=1`，内置数据、回放模型、不连邮箱、每次启动重置（只重置带演示标记的库，PRD R-DEMO-01 v0.7.22）；静态演示快照见文末「v0.7.11 修订」。
- 版本：语义化版本；数据库迁移只向前，发布说明写明。迁移文件合并进主分支（即发布）后不再修改、不再删除，之后的结构变化一律加新的迁移文件；只在里程碑分支上、尚未合并的迁移文件可以修改（没有任何部署用过它）。CI 用 `scripts/check-migrations.mjs` 比对主分支上已有的迁移文件（v0.7.2，Codex E1 第 2 轮 N4）。

## 8. 依赖（初定，实现时如有变化在这里改并写理由）

| 依赖 | 用途 | 许可证 |
|---|---|---|
| fastify | HTTP 服务 | MIT |
| pg、pg-boss | 数据库、任务队列 | MIT |
| zod | 配置和模型输出校验 | MIT |
| yaml | 读配置 | ISC |
| libmime、libqp、iconv-lite | 有上限的 MIME 解码（自写解码器，v0.7.1：mailparser 依赖 nodemailer，即一个 SMTP 客户端，违反 D12） | MIT |
| fast-xml-parser | pacs.008 XML（先拒绝 DTD / 实体） | MIT |
| parse5 | HTML 转纯文本、隐藏文字信号 | MIT |
| @fastify/cookie、openid-client | 会话 cookie、OIDC 登录 | MIT |
| imapflow | IMAP 适配器 | MIT |
| ~~@googleapis/gmail~~、~~@microsoft/microsoft-graph-client~~ | 不用（v0.7.9 D4：Node 内置 `fetch`） | — |
| @anthropic-ai/sdk | Anthropic 适配器 | MIT（间接依赖 fast-sha256 为 Unlicense：负责人 2026-10-30 批准只为这个包开例外，白名单不变，`scripts/check-licences.mjs` 的 `APP_EXCEPTIONS`） |
| pdfjs-dist | PDF 文字 | Apache-2.0 |
| argon2 | 密码哈希 | MIT |
| papaparse | CSV（与 Toolkit 相同） | MIT |
| react、react-dom、vite | 审核界面 | MIT |
| vitest、@playwright/test | 测试 | MIT / Apache-2.0 |
| typescript、oxlint、jose（测试用的模拟身份提供方） | 开发工具 | Apache-2.0 / MIT / MIT |
| S3 适配器 | 自写 SigV4 请求（不引入 AWS SDK 的大依赖树），版本列表逐页读完 | — |
| Unicode 混淆字符数据 `data/unicode/confusables.txt`（UTS #39，16.0.0） | `lookalike_domain` 的 skeleton 比较（生成 `src/lib/confusables-data.ts`，`scripts/gen-confusables.mjs`） | Unicode License v3（数据，许可证原文在 `data/unicode/LICENSE.txt`） |
| GreenMail、SeaweedFS（测试容器） | IMAP、S3（含版本）模拟服务，只在测试中运行，不随产品分发 | Apache-2.0 / Apache-2.0（独立进程） |
| ClamAV（独立容器） | 病毒扫描 | GPL-2.0（独立进程） |
| bubblewrap（解析容器内的可执行文件） | 每个解析任务的隔离 | LGPL-2.0-or-later（独立进程） |
| PostgreSQL（独立容器） | 数据库 | PostgreSQL License |

## 9. 已知风险

| 风险 | 处理 |
|---|---|
| 模型输出不稳定，评测结果随模型版本变化 | CI 用回放；换模型版本必须改配置、重录回放、重跑评测并记录结果 |
| Gmail / Graph 推送丢失 | 补漏轮询 + 游标，游标与接收记录同事务推进（R-ING-02、C-ING-5） |
| 解析恶意附件导致崩溃或越权 | 先扫描；解析容器无网络无密钥；每个任务独立命名空间、超时、资源上限；附件内容只作为文本使用 |
| Exchange 侧被误授予发送角色 | 应用无法自行证明；启动要求人工核查记录（C-ING-4），可选自动 Entra 检查；代码里没有任何写入调用 |
| 部署方误配置外部模型、没有数据处理协议 | 启动拒绝（R-PRV-01） |
| 审计链在并发写入时断开 | 事务末尾取锁、锁后单独读链头；校验命令；测试覆盖并发、回滚和快照早于竞争提交 |
| 审计写入锁拖慢流水线 | 锁只在事务末尾的一次插入期间持有；压测记录到 `docs/perf.md`（E1） |
| 相似域名误报多 | 只升风险、不拦截；评测集里包含正常的相似样本以测误报率（记录，不设门槛） |
| 加密所有文字使查询变慢 | 匹配用 HMAC 列；列表页只解密当前页；压测记录到 `docs/perf.md`（E1） |

## v0.7.1 修订（2026-10-30，E1 实现；同日按 E1 自测审查补充）
Codex 第 1 轮之后（同日）：`serve` 没有 `PARSER_SOCKET` 拒绝启动（进程内解析只在显式的开发开关下）；用户和会话带凭据版本，改密码或重置后旧版本的会话一律无效（包括正在进行的登录）；启动时配置变化在同一事务里把所有未关闭 Case 的处理代数加 1 并从 `scan` 重新排队；MIME 分隔行按整行判断；DOCX 按命名空间读取；嵌套邮件的头和 HTML 注释进入注入用语检查；文件临时副本由清理任务删除；并发重复导入的落败方保留未被引用对象的写入意图。
发件人地址：按 RFC 5322 在未解码的原始邮件头上解析（显示名里的编码字不会变成地址），无法确定或显示名里藏着另一个地址时，发件人信号记为「未知」并给 Case 标 `sender_unparseable`。HTML 正文（`body_html`）和纯文本一样做规则提取和脱敏。
实现时与 v0.7 不同、已在上文改写的地方：邮箱适配器接口的 `gone` / `resync`；`secret_blob.content_hmac`；`message`、`attachment`、`case`、`stage_run`、`user_event` 增列；新表 `app_session`、`contact_email`；`app` 角色的授权清单和 pg-boss schema；解析容器的 seccomp 和 /proc；依赖（去掉 mailparser、mammoth，加入 libmime 等）。消息和附件的 ID 由内容派生（HMAC），使崩溃后的重试写同一个对象键（`file_write_intent`）。行为（PRD §5 规则）没有变化。

## v0.7.2 修订（2026-10-30，Codex E1 第 2 轮之后，（审查记录，未公开））
- 解析结果不依赖配置：pacs.008 解析只记下金额原文和 `Ccy`，按配置的币种换算放在 `extract` 阶段，所以配置变化后重新排队的 Case 不需要重新解析附件（F13）。其他解析上限（PDF 页数、嵌套层数、大小）按解析时的配置执行，配置变化不重新解析。
- pacs.008 的金额、起息日、UETR 各记一个出处（附件文字里元素文字的位置；嵌套邮件里的按它在外层附件文字中的位置），证据的 `at` 取其中第一个（F14）。
- 迁移文件合并进主分支后不再修改（§7），CI 检查（N4）。
- 隐藏文字的样式表按 PRD v0.7.4 处理 `@` 块和层叠（N1、F2），按 v0.7.5 处理 `@layer` 的层级（自测 M1）；`<body text>` 和链接的浏览器默认颜色（自测 M2）。迁移检查在基准找不到时失败，推送时比对推送前的提交。
- Codex 第 3 轮：字体简写里字重和字号的区分、`background` 简写取颜色分量、`inherit` 等颜色关键字、块末尾的 `@layer` 声明；隐藏文字的评估范围按 PRD v0.7.6 封顶。

## v0.7.3 修订（2026-10-30，E2 自测之后，（审查记录，未公开））
- §4 增加 `model_output`（E2 迁移 `002_e2.sql` 已建）；§4.1 `app` 的 INSERT 清单和保存期删除顺序加上它（CF-F8）。
- 模型适配器（§3.2）：Anthropic 适配器自己校验回复（不用 SDK 的解析器），SDK 不自动重试；服务商错误也算一次失败的尝试，两次都失败则分类归 `unclassified`、字段为空，步骤照常完成，队列重跑不再调用模型（A3）。Ollama 有输出上限、超时，被截断的回复算不合格（B5）。
- `serve` 启动时按 R-PRV-01 建模型适配器：没有配置模型、或外部服务商没有数据处理协议，拒绝启动；警告写启动日志并显示在审核界面顶部。Anthropic 一律视为 `external`，配置写 `local` 时加载失败（A1、A2）。
- 回放录制按尝试次数分开保存，并记录请求设置和实际回答的模型；设置不同的录制不回放（B9、B10）。

## v0.7.4 修订（2026-10-30，PRD v0.7.12，（审查记录，未公开））
- §4 增加 `risk_adjustment`（人工调整风险的记录：等级、调整时的计算风险和原因集合、状态），加入 `app` 的 INSERT / UPDATE 清单和保存期删除顺序；迁移在 E3 的 `003_e3.sql`。
- §6 写明人工调整风险的重算起点和自动失效的发布方式。

## v0.7.5 修订（2026-10-30，E3 自测关卡，（审查记录，未公开））
- §4.1 `app` 的 INSERT 清单和保存期删除顺序补上 `case_label_change`、`case_field_change`（WP6）。`reply`、`verification_task`、`case_link` 是整行 UPDATE。
- PRD v0.7.15 C-RSK-3：`case.risk_hold`（人工操作前的最终风险）在人工发起的重算前写入；`risk` 步计算结果低于它时保留它并标「待 approver 确认」；approver 确认（带理由）清除它并从 `risk` 重算；计算结果不低于它时自动清除。
- 回复收件人只来自 ingest 时解析并存入 `header_blob.reply_to` 的地址列表（PRD v0.7.15 C-SIG-1.5）。

## v0.7.6 修订（2026-10-30，Codex E2 第 4 轮，（审查记录，未公开））
- §4 增加 `model_attempt`（迁移 `002b_model_attempt.sql`，因为 `002_e2.sql` 已发布、冻结）：每次模型调用发送前，先在单独提交的事务里登记；登记了却没有 `model_output` 的，重试时按「可能已发出」算一次失败的尝试，不再发送，保存失败也不会出现第三次调用（PRD C-FLD-0）。
- §4.1 `app`：INSERT 加 `model_attempt`；DELETE 加 `model_attempt`，只用于设置错误（确定没发出）时撤销那次登记；保存期删除顺序与 `model_output` 同一步。
- 设置错误的范围（Codex E2 第 3、4 轮 F16 / F21）：只有确定没发出请求的连接错误才算（连接被拒、DNS 失败、不可达、地址无效、TLS 握手和证书失败，按错误码逐个列出）；连接建立后中断的算一次尝试并保存。

## v0.7.7 修订（2026-10-31，Codex E2 第 5 轮，（审查记录，未公开））
- 设置错误的范围收窄（F23，负责人选 B）：TLS 协议错误和告警（如 `ERR_SSL_WRONG_VERSION_NUMBER`）在请求送达之后也会出现，单看错误码分不清，所以模型请求遇到它们一律算一次尝试。仍算设置错误的只有连接被拒、DNS 失败、不可达、地址无效和证书校验失败（证书只在握手时校验，那时还没有发出请求）。
- Ollama 适配器第一次调用模型之前，先 `GET {ollama_host}/api/version` 一次，这个请求不带任何邮件内容。探测失败一律报设置错误，用固定文字，不含地址和传输层消息。https 配到 http 端口这类错误因此仍在发出任何模型请求之前报出（保留 F21 的效果）。Anthropic 的地址固定，没有探测。

## v0.7.8 修订（2026-10-31，E3 验收，（审查记录，未公开））
- 批准失效的时机（S1，PRD C-DRF-8「更早代数的回复显示为已过期」）：`reply` 步发布新一代时，在同一事务里把更早代数的已批准回复退回草稿，清掉批准记录，Case 从「已批准」回到「处理中」（open），并写审计 `reply.approval_lapsed`（actor system，problems `generation`）。以前要等下一次复制被拒才失效。发布之前的空窗期，详情页把这类回复标为已过期，不提供复制和「标为已发送」。已标「已发送」的回复不受影响。
- 列表的信号计数和详情页一致，不含 `dmarc_pass`（S2）。

## v0.7.9 修订（2026-10-31，E4 开工评估，（审查记录，未公开）；负责人：「D1–D8 按建议」）
- **邮箱凭据（G2、PRD 决定 6）：** 新表 `mailbox_credential`（`mailbox_id`、`kind` 只有 `gmail_refresh_token`、`secret_blob_id`、`updated_at`），令牌只存在 `secret_blob`；M365 的凭据只在 secret 文件，不进数据库。Gmail 刷新令牌由命令行 `doi gmail-auth <mailbox>` 取得：本机回环地址（`127.0.0.1` 随机端口）+ PKCE，授权请求的 scope 只有 `https://www.googleapis.com/auth/gmail.readonly`，返回的 scope 不完全等于它 → 拒绝保存；保存前 `GET users/me/profile`，`emailAddress` 必须等于配置的邮箱地址，否则拒绝（审查 #7）；运行时每次换到新访问令牌后第一次补漏前也核对。Google 桌面客户端的 `client_id` / `client_secret` 从 secret 文件读；服务器没有浏览器时，文档说明用 SSH 端口转发完成回环授权。重新授权时**不**撤销旧刷新令牌：Google 的撤销作废该用户对本应用的整个授权，新令牌会一起失效（E4 自测 F3）；旧令牌的 `secret_blob` 不再被引用，由每日清理删除（审查 #14）。令牌被撤销（`invalid_grant`）→ 该邮箱的补漏失败、写审计、界面顶部提醒，不影响其他邮箱。Pub/Sub pull 的服务账号密钥从 secret 文件读，不进数据库。邮箱凭据属于邮箱，不属于邮件，保存期任务不删。
- **Microsoft 365 凭据（D3）：** 客户端凭据流，证书（推荐，JWT 断言用 Node `crypto` 签名）或客户端密钥，都从 secret 文件读；访问令牌只在内存。
- **原生 HTTP（D4）：** Gmail、Pub/Sub、Graph 和两个令牌端点都用 Node 内置 `fetch`，不引入 googleapis、google-auth-library、@azure/msal-node 或 Graph SDK。所有请求经一个模块 `src/adapters/mailbox/http.ts` 发出，它按「主机 + 方法 + 路径模板」白名单放行（审查 #9），每个端点固定主机（`gmail.googleapis.com`、`pubsub.googleapis.com`、`graph.microsoft.com`、`oauth2.googleapis.com`、`login.microsoftonline.com`），`fetch` 一律 `redirect: 'error'`；服务端返回的 `@odata.nextLink` / `deltaLink` 和存进游标的链接，发出前同样过白名单。清单（实现 `src/adapters/mailbox/http.ts` 的 `MAIL_HTTP_ALLOW`，CI 与 `scripts/no-send.ts` 的预期清单逐条比较）：Gmail `GET users/{id}/profile`、`labels`、`history`、`messages`、`messages/{id}`，`POST users/{id}/watch`、`stop`；Pub/Sub `POST …/subscriptions/{s}:pull`、`:acknowledge`；Google `POST /token`；Graph `GET users/{id}/mailFolders`、`mailFolders/{id}`、`mailFolders/{id}/childFolders`、`mailFolders/{f}/messages/delta`、`messages`（C-ING-4 探测）、`messages/{id}`（接收时间）、`messages/{id}/$value`，`GET servicePrincipals`、`servicePrincipals/{id}/appRoleAssignments`（C-ING-4 ②，只在授予了 `Application.Read.All` 时）；Microsoft `POST {tenant}/oauth2/v2.0/token`。Graph 请求带 `Prefer: IdType="ImmutableId"`，邮件在文件夹之间移动时 ID 不变。白名单外的请求在运行时抛错。
- **只读检查（G7，TC-OUT-09 扩展）：** 除原有的 SDK 调用形式外，CI 检查 `http.ts` 的白名单只含上面这些条目、源码里没有绕过 `http.ts` 直接请求 Google 或 Microsoft 域名的 `fetch`，并对写类路径（`send`、`drafts`、`insert`、`import`、`modify`、`trash`、`batchModify`、`sendMail`、`createReply`、`forward`、`move`、`copy` 等）报错。
- **文件的密钥轮换（G1）：** 文件的数据密钥包装后写在文件头里，所以轮换一个文件 = 用新主密钥重新包装数据密钥，改写文件头（密文不变）写入同一对象键 → 读回并校验内容哈希 → 删除该对象的全部旧版本（旧版本仍由旧密钥包装，不删就无法移除旧密钥）。`key_rotation` 按对象记进度，中断后从未完成的对象继续。数据库里只改 `secret_blob.key_id`、`wrapped_dek`。**并发（审查 #2）：** 每个对象在一个事务里取 `lockObjectKey`（同 CC-F1），锁内复查对应的 `message_file` / `attachment` 行（对只登记在 `file_write_intent` 里的对象：意图行或文件行）仍在、没有该对象的 `file_deletion_job`，持锁完成改写和删旧版本；`file_deletion_job` 的执行也取同一把锁；`rotation` 加 `file_deletion_job` 的 SELECT。本地磁盘：临时文件 + rename 原子替换，不留临时文件。**完成与移除旧密钥（审查 #10）：** 轮换开始前，服务必须已用新的写入密钥（`DOI_ACTIVE_KEY`）重启，服务每次启动写一条 `keys.active` 审计（只记写入密钥 ID），`doi rotate-keys` 启动时检查最近一条的密钥等于新密钥，否则拒绝；扫描范围是数据库引用的全部文件（S3 含全部版本）和 `file_write_intent` 里的对象；全部完成并抽样解密校验后写一条 `key_rotation` 完成记录（`from_key`、`to_key`）；写完成记录前再查一次：从轮换开始到现在有任何 `keys.active` 审计记的是旧密钥 → 先补扫这段时间新增的对象和 `secret_blob`，再完成（审查第 2 轮 #2）。启动时：`DOI_MASTER_KEYS` 里缺少某个密钥，而 `secret_blob.key_id` 还有它，或没有一条以它为 `from_key` 的完成记录 → 拒绝启动。
- **维护任务的运行（G6）：** 保存期、文件删除、KYC 转交和替换、孤立文件清理由服务进程里的定时器（`setInterval`）运行，但用单独的连接池，凭据是 `maintenance` 角色（从 secret 读）；KYC 转交本身（调用 `KycSink`）用 `app` 角色写 `kyc_delivery`。密钥轮换是单独的命令 `doi rotate-keys`，用 `rotation` 凭据，不在服务进程里运行。（v0.7.11 起保存期、文件删除、KYC 替换、孤立文件清理在单独的 `maintenance` 容器里，KYC 转交仍在 `serve`。）
- **名单版本计时（G5）：** `directory_version.unreferenced_since`：每日任务把不再被任何 `directory_snapshot` 引用的版本填上当天日期，再次被引用时清空；到期按它计算。
- **KYC 转交时机和提醒（G4）：** C-RED-0 的判断在 `classify` 里写入 `attachment.maybe_kyc`；同一事务里为每个可能是 KYC、还没有 `kyc_delivery` 行、没有 `source_deleted` 的附件建 `kyc_delivery`（`pending`；`attachment_id` 唯一，重跑不重复建，审查 #3）并排转交任务；失败重试，仍失败则保持 `failed`，每日任务为每个仍有失败转交的邮件写一条 `kyc.delivery_pending` 审计，界面顶部显示数量。
- **保留标记（PRD R-REV-07）：** `case.hold`（已有列）+ 新列 `hold_reason_blob`；API 只对 approver / admin 开放，先锁 Case 行；审计 `case.hold_set` / `case.hold_cleared`。保存期删除事务先 `SELECT … FROM "case" … FOR UPDATE`，锁内复查 `hold` 和到期条件（审查 #6）。被替换的刷新令牌、取消保留后的原因等不再被任何行引用、且创建超过 24 小时的 `secret_blob` 由 `maintenance` 每日删除（审查 #14；引用列清单从数据库外键目录生成，不手写）。
- **维护凭据在服务进程里（审查 #16）：** 角色分开防的是应用层 SQL 注入越权，防不了服务进程被远程执行代码（此时攻击者也拿得到 `maintenance` 凭据，但仍不能改删审计）。这是 E1 起的取舍，E5 打包时评估把维护任务拆成单独容器。**E5 决定拆**（v0.7.11，PRD R-OPS-01）。
- **审查 E1–E6（负责人 2026-11-01：「E1–E6 按建议」，（审查记录，未公开））：**
  - 会话和保存期（PRD C-PRV-1、C-ING-3）：删除一封邮件的事务里，先把 `previous_case_id` 指向该 Case 的后一封 Case 置空（`maintenance` 只能置空这一列），写 `retention.link_cleared` 审计，再按 §4.1 顺序删。选出到期邮件时，跳过「保留」Case 沿 `previous_case_id` 往前的全部 Case。**并发（第 2 轮 #3）：** 删除事务按 Case 创建顺序锁住要删的 Case 和沿链往后的全部 Case（`FOR UPDATE`），在锁内复查链上没有任何保留；设保留的 API 同样按创建顺序锁住该 Case 和沿链往前的全部 Case，两边按同一顺序取锁，不会死锁。「只能置空」`previous_case_id` 用触发器实现（列级授权做不到），迁移测试覆盖。
  - 收取范围（PRD C-ING-6）：Gmail `history.list` 带 `historyTypes=messageAdded,labelAdded`，只取带配置标签、不带 `SENT`/`DRAFT`/`SPAM`/`TRASH` 的邮件；全量重列用 `messages.list?labelIds=<标签>`。Graph 每个配置文件夹一行 `mailbox_cursor`（游标键 = 邮箱 + 文件夹 ID；`004_e4.sql` 把主键从 `mailbox_id` 改为 `(mailbox_id, folder_key)`，IMAP 和 Gmail 的 `folder_key` 固定为空串）。标签和文件夹名称在启动时解析为 ID，用白名单里的 `labels`、`mailFolders`、`childFolders` 三条只读 GET（上面「原生 HTTP」的清单是唯一一份，第 2 轮 #6、第 3 轮 #3）。Gmail `history.list` 不带 `labelId` 过滤，按每封的 `labelIds` 在本地筛选（一次调用覆盖多个标签）。**Graph 移动后的去重（第 2 轮 #7）：** C-ING-1 的「去掉 Message-ID 后的 SHA-256」要求两次取回的 `$value` 逐字节相同；M-05 实测移动前后和两次取回是否相同，不同则另提规则修改（PRD C-ING-1）请负责人决定，E4 不预先改规则。
  - KYC 转交重试和成功（PRD R-PRV-03、C-PRV-2）：`kyc_delivery` 记 `attempts`、`last_error`；每日任务对 `failed` 自动重试一次；admin 的手动重试 API 写 `kyc.delivery_retry` 审计。webhook 请求体：`delivery_id`、`case_id`、序号、生成的文件名、`sha256`、文件（HMAC 签名，`Idempotency-Key: <delivery_id>`）；响应体必须是 JSON `{delivery_id, sha256}` 且都相等。文件夹目标：写 `.<name>.tmp` → `fsync` → `rename` → 读回校验。
  - 名单当前版本（PRD C-PRV-1）：每个交易每类名单最新导入的版本不填 `unreferenced_since`；删除前锁内复查没有快照引用、也不是当前版本。
  - 内联图片的量级（E6，只记录）：按 C-RED-0 ③，签名 logo、cid 内联图片都算可能是 KYC，E4 起几乎每封带图片的邮件都会转交并改写存档；不放宽规则，部署文档写明，M-05 实测量级。
- **E4 实现中的细化（第 1–3 步，2026-11-01）：**
  - `enqueue_kyc_continuation(case_id, generation)` 做的就是一次系统重跑（同 `restartFrom`）：核对当前代数、代数加 1、把 `scan` / `parse` / `content_signals` 的结果沿用到新一代、排入任务；当前一代还没做完前面某步时从那一步开始（否则从 `extract`）。所以 `maintenance` 不需要 UPDATE `case.processing_generation`（授权已去掉），代数只经这个函数变化。
  - C-PRV-2 第 ④ 步额外删除的「中间结果」：该 Case 所有代数中 `extract` 及之后各步的 `stage_run` 结果、全部 `case_field` 行（出处引文），以及 `extract`、`redact`、`fields`、`link`、`risk`、`reply`、`route`、`emit` 这些步骤的 `audit_detail`（它们的输出可能带附件里的金额、账号、引文；`classify` 的明细只有模型看到的内容，可能是 KYC 的附件内容本来就不在里面）。审计行本身不动，链校验照常通过。
  - 去掉 KYC 部分的副本：每个被去掉的附件原地换成一个占位附件（`text/plain`，文件名 `removed`，头 `X-Deal-Ops-Removed: kyc`），其他附件的序号不变；定位不到某个附件时不生成副本（宁可保留原件也不生成仍含文件的副本）。
  - 转交：先试 3 次（每分钟一轮），仍失败为 `failed`，此后每日任务每天重试一次直到成功；admin 可在 Case 页面手动重试。病毒扫描拦截的附件**不转交**（`last_error = infected`，保持失败并每日提醒），等负责人决定（见 HANDOFF）。超过单个附件上限、没有单独存文件的附件，从原始邮件里解出该部分再转交。
  - 界面顶部的持续提醒（`/api/session` 的 `warnings`）：转交失败的数量、等待重试的文件删除数量。
- **E4 自测和 Codex 第 1 轮之后（2026-11-01，（审查记录，未公开）、`2026-11-01_E4_codex_triage.md`）：**
  - Graph 请求另有一层守卫：只发往 `https://graph.microsoft.com/v1.0/`，服务端给的分页链接和保存的 deltaLink 只能指向该邮箱该文件夹自己的 delta 路径（白名单是各服务商共用的，Codex F1）。
  - C-ING-4 ② 不再有开关：每次启动都尝试读取应用的目录信息；明确的 403（没有 `Application.Read.All`）→ 只靠 ①；读到了就必须完整（全部分页、结构正确），否则拒绝启动（Codex F2、F3）。
  - Gmail：history 条目没带 `labelIds` 时先读该邮件的标签再筛（Codex F6）；history、列表、profile 的返回结构不对算临时错误，游标不动（Codex F7）；403 限流算临时错误，watch 的其他 403 算续订失败（自测 F5）；启动时某个邮箱授权失效只停该邮箱（Codex F11）；重新授权不撤销旧令牌（自测 F3）。
  - 接收：事务里发现并发的重复邮件时，自己写过的对象若没有任何行引用（例如原件已被 KYC 替换删除）立即删除，在对象锁下进行（Codex F5）。
  - 保存期：`kyc_delivery` 在 `case` 之前删除；每封邮件单独失败、写 `retention.failed`；拿不到该邮件的锁（KYC 替换正在进行）当天跳过（自测 F1、F4）。KYC 替换：每封单独失败、写 `kyc.replace_failed`，界面提醒「已转交一小时以上仍未替换」；锁在池外的单独连接上；残缺 MIME 按接收时已定位的部分去掉附件（自测 F2、F4）。
  - 密钥轮换：存在以本进程写入密钥为 `from_key` 的轮换记录时拒绝启动（旧密钥实例不能再启动）；轮换前必须所有实例都已用新密钥重启（文档写明）；`app` 不能写 `key_rotation`；S3 版本控制暂停时也删除早先的编号版本（Codex F8–F10）。
  - 评测导出加附件树和系统的 `maybe_kyc`，复核器用 `--require-attachments` 运行（Codex F12）。
- **Codex E4 第 2 轮之后（2026-11-01，（审查记录，未公开））：** C-ING-4 只把错误代码为 `Authorization_RequestDenied` 的 403 当作「没有目录权限」，逐条校验分配记录，探测必须是邮件列表；Graph 文件夹列表跟随全部分页；Gmail 列表只接受非数组对象并逐条校验，取信时按返回的标签再判断收取范围（不在范围按已不存在处理），history 里读标签时已删除的邮件保留到取信时记 `ingest.gap`；S3 清理旧版本时 HEAD 失败即抛错；KYC 第 ④ 步先取与事件投递相同的 Case 锁，未投递的事件改为「撤回」（`withdrawn`，占位内容，序号保留），删除对应类型的 `event_state`，并删除人工字段修改（`case.field_changed`）的审计明细；启动的密钥检查和 `keys.active` 记录、轮换建记录和写完成记录都在同一把咨询锁（7340011）下，`import-eml`、`gmail-auth` 也做启动检查；评测导出的附件 `text` 只含自身（去掉嵌套部分）；页面顶部提醒每分钟刷新。**已知限制（Codex 第 2 轮 F5）：** 并发重复接收的进程在写完文件后、清理前崩溃，已被 KYC 替换删除的原件会在孤立清理（约 1 小时）前重新存在。

## v0.7.11 修订（2026-11-02，E5 开工评估 （审查记录，未公开），负责人：「D1–D10 按建议」；计划审查 （审查记录，未公开），负责人：「R6、R19 按建议」）
- **应用镜像（G4）：** 根目录 `Dockerfile`，多阶段构建：构建阶段装依赖、构建前端；运行阶段只有 Node、生产依赖、`dist/`、`src/`、`config/default/` 和演示数据；非 root；只读根文件系统，可写的只有数据卷和 tmpfs `/tmp`。`app`、`maintenance`、`migrate` 用同一镜像、不同命令。
- **compose 和 secret（PRD R-OPS-01）：** 服务 `db`、`clamav`、`parser`、`migrate`（建表、三个数据库角色，完成后退出；`app` 和 `maintenance` 只在它成功结束后启动）、`app`、`maintenance`；`tools` profile 下的一次性服务 `rotate`（`doi rotate-keys`）和 `gmail-auth`。数据卷：数据库、附件文件、`state`（审计链头导出，审查 R11）、KYC 文件夹目标（配了文件夹目标时）。secret 一律用 compose `secrets`（文件，挂在 `/run/secrets/`），配置读取支持 `<名字>_FILE`（读该文件的内容）；每个服务只挂自己需要的：`migrate` 有数据库 owner 密码和三个角色的密码；`app` 有 `app` 角色密码、主密钥、HMAC 密钥、初始 admin 密码、模型、邮箱、事件 webhook、KYC 目标和 OIDC 的凭据；`maintenance` 有 `maintenance` 角色密码、主密钥、HMAC 密钥；`rotate` 有 `rotation` 角色密码、主密钥、HMAC 密钥，并挂配置目录和附件卷（审查 R3）。compose 的文件型 secret 是 bind mount，保留主机上的权限和属主：`doi init-secrets <目录>` 生成随机密码和密钥文件，已存在的不覆盖；权限方案在实现时实测，要求容器里的非 root 进程能读、主机上的其他用户不能读（例如目录 700、文件 644；审查 R4）。初始 admin 密码只在库里没有 admin 时被读取，文档要求首次登录改密码后清空这个文件（`: > secrets/initial_admin_password`；文件本身要留着，compose 缺 secret 文件时不启动；审查 R20）。`gmail-auth` 加 `--port`（固定端口）：给了 `--port` 时在容器里监听 `0.0.0.0:<端口>`，compose 只把它发布到主机的 `127.0.0.1`；不给时照旧本机 `127.0.0.1` 随机端口（审查 R5、复核 V2）。附 `.env.example`。
- **维护容器（D6）：** 新命令 `doi maintain`：启动时先做 `recordKeys`（密钥围栏，与 `serve` 相同，审查 R3），然后运行 `scheduleMaintenance`（保存期、名单版本、无引用文字、文件删除、KYC 提醒）、孤立文件清理和 KYC 替换（现在都在 `serve` 里）；`--once` 跑一轮就退出（测试用，审查 R21）。`serve` 不再读 `MAINTENANCE_DATABASE_URL`，KYC 转交（`app` 角色）留在 `serve`。两个进程之间只经数据库：KYC 替换提交时经 `enqueue_kyc_continuation` 排的续跑任务仍由 `app` 的 worker 执行。两边都有主密钥：拆分防的是 `app` 被攻破后的删除和改写，不防读取（读取本来就靠主密钥）。
- **解析容器 profile（D5，T7）：** seccomp：`deploy/parser-seccomp.json` = 固定版本的 Docker（moby）默认 seccomp profile，加一条规则放开 `clone`（不限命名空间标志）、`unshare`、`mount`、`umount2`、`pivot_root`；由脚本从默认 profile 生成，CI 检查文件与脚本输出一致；每个任务的 bubblewrap seccomp 过滤器不变。本机实测（Docker 29，arm64）：只用默认 profile 时沙盒起不来，加这五个调用后 TC-ING-10 的探测全部照常、任务内 `unshare` 仍被拒。AppArmor：docker-default 带 `deny mount`（deny 优先），不能在它上面加放行（审查 R7）；写自己的 `deploy/apparmor/doi-parser`：在 docker-default 的其他限制之外，只放开 bubblewrap 需要的 `userns`、`pivot_root` 和 mount（按 complain 模式在 Ubuntu 24.04 上记录到的操作逐条写出，挂载目标限于 bubblewrap 的临时根 `/tmp/newroot`、`/newroot/**`、`/oldroot` 和 `/` 的传播设置）。**只有这一个 profile，沙盒里的任务进程不再切换到更窄的子 profile**（负责人 2026-11-02：「AppArmor 选 A」）：容器带 `no-new-privileges` 时 exec 只能经 profile 叠加切到更窄的 profile（复核 V3），各内核版本的行为不同、维护成本高；而每个任务本来就在 bubblewrap 加载的 seccomp 过滤器下，mount、新建命名空间、keyring、BPF、io_uring、ptrace 等都被拒绝，子 profile 只是重复的一层。compose 写 `apparmor=doi-parser`。有 AppArmor 的主机（Ubuntu、Debian）按文档把它装进 `/etc/apparmor.d/` 并用 `apparmor_parser -r -W` 加载（开机时自动重新加载；只从源码目录加载会在重启后失效，Codex E5 第 2 轮 F5），没加载时容器启动失败（不退回 `unconfined`）；没有 AppArmor 的主机（macOS 上的 Docker Desktop 等）Docker 不使用该选项。compose 文件里不出现 `unconfined`。CI（审查 R8、复核 V8）：新增一个 `ubuntu-24.04` job，不改 `apparmor_restrict_unprivileged_userns`，断言 `aa-enabled`，加载 profile，按 compose 的同一组安全选项跑解析容器测试；`parser/container.test.ts` 的安全选项从 compose 文件读，不再硬编码；解析容器测试只在这个 job 里跑，原 job 不再跑它、也不再改 sysctl。Ubuntu 24.04 是否因此不再需要改 sysctl，以这个 job 为准。
- **演示模式（PRD R-DEMO-01）：** 新迁移 `005_e5.sql`：表 `demo_marker`（一行，创建时间），只有 owner 能写，`app` 等角色只能读（审查 R19）。`migrate` 在所有模式下都先取一个 advisory lock，在锁内判断库的状态，再做任何改动（包括改角色密码，审查 R2、复核 V6）；E5 之前的库没有 `demo_marker` 表，按「没有标记」处理。`DEMO=1` 时：空库（没有 `schema_migrations` 表，`public` 里没有任何表）→ 全部迁移文件和写演示标记在**一个事务**里完成，任何一步失败整体回滚、库仍是空库（复核 V1；非空库照旧每个文件一个事务）；有演示标记 → 删掉本应用的全部 schema（含 pg-boss）后重建（PRD C-AUD-2 的演示例外）；有数据却没有标记 → 报错退出，不改任何东西（`app` 因此不启动）。非演示模式的 `migrate` 和 `serve` 遇到有演示标记的库 → 拒绝（审查 R1）。演示覆盖文件 `deploy/compose.demo.yml` 用单独的 compose 项目名 `deal-ops-inbox-demo` 和固定名字的数据卷（`name: deal-ops-inbox-demo-db` 等，不随 `-p` / `COMPOSE_PROJECT_NAME` 变化，复核 V7）；设 `DEMO=1`，ClamAV 用带病毒库的镜像 tag 并设 `CLAMAV_NO_FRESHCLAMD=true`，不要求模型、邮箱、webhook 和 OIDC 凭据。`serve` 在 `DEMO=1` 时：配置用镜像里的演示配置（`eval/config/` 的副本，回放录音按它录制）；配置里有 `eml` 以外的邮箱、回放以外的模型、事件 webhook、KYC webhook 或 OIDC → 拒绝启动（审查 R6）；数据库没有演示标记 → 拒绝启动；建三个演示账号（`demo-reviewer`、`demo-approver`、`demo-admin`，固定密码写在文档里，不要求改密码）；`GET /api/demo` 是公开路由，返回这三个账号和密码供登录页显示，非演示模式返回 404；导入 `eval/directory/` 名单（演示数据随镜像打包）；按 `received_at` 的顺序、按评测的接收方式（`eval/run.ts`：标注的 `received_at`、邮箱认证设置）收取清单里的演示邮件（审查 R13）；模型用 `eval/replay/` 的回放，缺录音照常是设置错误；KYC 目标是演示卷里的文件夹（审查 R16）；演示模式下 KYC 替换不运行（PRD C-PRV-2 的演示例外，复核 V3b），演示页面写明正式部署会替换；`doi maintain` 按数据库里的演示标记判断（不依赖环境变量）：库有演示标记 → 不跑 KYC 替换，且没有 `DEMO=1` 时拒绝启动（同 `serve`，复核 W1）。接收时间不平移（结果与评测一致），时限显示可能已超时，演示页面顶部说明这是虚构数据和固定时间。
- **静态演示快照（PRD R-DEMO-02，决定 7）：** `npm run demo:snapshot`：在处理完的演示库上以 `demo-reviewer` 登录，调用现有的只读 API（列表、Case 详情及其中的核实任务和回复），把响应合成一份快照，写成 `data/snapshot.js`（`globalThis.DOI_DEMO = Object.freeze({…})`），构建后的 `index.html` 在应用脚本之前用普通 `<script src>` 载入它（网站 CSP `connect-src 'none'`，页面不能发任何 fetch / XHR，网站接口 T1，负责人：「T1–T5 按建议」，`10_SITE_DEMO_INTERFACE.md` §2）；每个 Case 的 UUID 在整份快照里换成它的评测样本号（演示模式 `GET /api/demo` 按 Message-ID 给出对照，深链 `#case=E0225`，T2）；前端用 `STATIC_DEMO` 开关构建：API 层改为读这个对象，任何非 GET 操作在前端直接拒绝并显示「演示：不可操作」，不发网络请求；改动按钮带 `aria-disabled="true"`（仍可聚焦，点了显示原因），顶部加版本行「Snapshot of v<版本>」和回链「← Deal Ops Inbox」（`/inbox/`），`index.html` 带 `noindex`（T3）；静态模式不读写 `sessionStorage`（T4）；页面显示快照的构建时间。产物（`dist-demo/`）打包成 `deal-ops-inbox-demo-v<版本>.tar.gz`（不带外层目录）和 `.sha256`，包里有 `MANIFEST.sha256`（`sha256sum` 格式，按路径排序，不含它自己）和 `snapshot-info.json`（版本、提交号、构建时间）（T5），交给网站仓库发布（网站的 CSP 等由网站项目负责，D10）。生成后检查：文件里没有 cookie、CSRF 令牌、会话 ID 和密钥材料，出现的邮件地址都是 `.example` 域名，没有参考平台名（规则 P6，审查 R18）。
- **演示的 cookie（PRD R-DEMO-01，自我审核 S1）：** `DEMO=1` 时会话 cookie 不带 `Secure`（实测 WebKit 不接受 `http://localhost` 上带 `Secure` 的 cookie）；`HttpOnly`、`SameSite=Strict` 不变；演示覆盖文件只把端口发布到 `127.0.0.1`。非演示模式下 `Secure` 照旧始终开启（只有显式的开发设置 `DEV_INSECURE_COOKIES=1` 能关，§5）。
- **反向代理和资源（PRD R-OPS-01，自我审核 S2、S3）：** 可选的 Caddy 服务在单独的覆盖文件 `deploy/compose.proxy.yml` 里（固定网段只在这个文件里，不用代理的项目，例如演示和恢复的副本，可以和它同时运行，自测 F6）：配置 `DOI_DOMAIN` 后自动申请证书、把 HTTPS 转到 `app`；它在固定网段（`DOI_EDGE_SUBNET`，默认 `172.30.99.0/24`）上有固定地址（`DOI_PROXY_IP`，默认 `172.30.99.10`），`app` 的 `TRUST_PROXY` 设为这个地址（Fastify 只接受地址或网段，不接受服务名；英文文档审查）；不启用时应用只开放在 `127.0.0.1:8080`，由部署方自己的代理接入（文档给出 `trustProxy` 的设置）。Caddy（Apache-2.0）是独立进程和官方镜像，不进 npm 依赖。最低资源写进文档：给 Docker 约 4 GB 内存；compose 冒烟记录各容器的内存峰值，文档按实测值写。
- **CSRF 令牌由会话派生（M-05 F4）：** 原来登录时生成随机令牌，库里只存它的 HMAC（`app_session.csrf_hmac`）；本地登录在响应体里把令牌交给登录的那个标签页，OIDC 回调经一次性 cookie（`doi_csrf_once`，路径 `/api/csrf`，60 秒）交给页面，由它从 `GET /api/csrf` 取走一次（复核 R12）；之后其他标签页有登录 cookie 却拿不到令牌，连退出都被拒。改为令牌 = HMAC(部署密钥, `csrf-token\0` + 会话令牌)（前缀与旧的存储值区分用途，审查 R12），服务器每次按会话重算比对，不再用 `csrf_hmac`；`GET /api/csrf` 对带有效会话 cookie 的请求返回该令牌（同源读取：没有 CORS，跨站页面读不到响应；会话 cookie 是 `SameSite=Strict`），也在「必须先改密码」时放行（审查 R12）。会话结束、改密码时令牌随会话失效。（F5：审计链头导出目录不存在时先建目录，建不了只报一次。）
- **需要 compose 的用例怎么进到期检查（审查 R9）：** TC-DEMO-01、03、TC-OPS-01–09、TC-ING-10 都写成真正的 Vitest 测试，在各自需要的 CI job 里运行（compose、Ubuntu 24.04 + AppArmor；TC-OPS-05 在主 job 里，那里有测试数据库），每个 job 输出 JSON 报告并上传为 artifact；最后一个汇总 job 下载全部报告再跑 `scripts/check-coverage.mjs`（它接受多个报告文件；复核 V4）。
- **公开快照（决定 7）：** 脚本按公开路径白名单从开发仓库导出到一个公开仓库的全新克隆（不带历史）；白名单含代码、`docs/en/`、整理过的中文设计文档、`eval/dev`、`eval/oracle`、`eval/replay`、`eval/directory`、`eval/config`、`eval/clock.json`、`eval/SCHEMA.md`、`eval/annotation.schema.json` 等运行评测需要的文件（审查 R15）；整理过的中文设计文档是脚本生成的公开版（页头和变更记录去掉姓名、调研来源和个人语境，规则正文不变，指向 `review/` 的引用改为「未公开」）。保留集在另一个仓库，导出只从白名单路径取，所以结构上不会带上；另检查导出的评测样本 ID 都在 `eval/dev`。导出后检查：没有负责人姓名、个人邮箱、本机路径、参考平台名和任何 API 密钥，邮件地址都是 `.example` 域名；全新安装后跑类型检查、lint、单元测试、复核器自检和评测。推送在 G3 之后、负责人同意时（TC-OPS-05）。

## v0.7.12 修订（2026-11-03，E5 模拟验收 M-06，（审查记录，未公开）；负责人：「按建议」，G3 选「A 补重跑命令」）
- **失败 Case 的重跑（§6「可手动重跑」原来没有入口，验收 G3）：** 新命令 `doi rerun-failed [case id …]`（`docker compose run --rm app rerun-failed`，用 `app` 的数据库角色和密钥；有演示标记的库照常拒绝，先过密钥围栏）。不带参数时按接收时间处理全部 `failed` 的 Case；对每个 Case 锁行，只有 `status = 'failed'` 且记有 `failed_stage` 时才调用 `restartFrom(…, 起点, 'system')`：起点是失败的那一步，失败在 `reply` 之后（`route`、`emit`）时是 `reply`——回复绑定代数（C-DRF-8），沿用旧一代的草稿会无法批准，所以新一代重新起草（Codex E5 第 5 轮 F1）；之前完成的步骤沿用，`status` 回到 `processing`，不加人工修订号；写审计 `case.rerun_failed`（失败步骤、起点、新代数）。不是 `failed` 的 Case 不动。Case 详情 API 多一个 `failedStage`，页面显示失败的步骤和重跑命令；失败原因仍只在加密的 `audit_detail` 里（错误文字可能含邮件内容，不显示在界面上）。测试 TC-OPS-09。
- **登录页的组织登录（验收 G4）：** 新公开路由 `GET /api/signin-options` → `{ oidc: boolean }`（只说明是否配置了 OIDC）；登录页只在为真且不是演示时显示「Sign in with your organisation」。
- **用户和名单的操作文档（验收 G1）：** 本版本没有用户和名单的界面，`docs/en/users-and-directory.md` 写明用现有 API 的 `curl` 步骤和 CSV 格式；compose 测试 TC-OPS-08 从这页取出标记的命令和示例文件原样运行。

## v0.7.13 修订（2026-11-03，G3 公开仓库，（审查记录，未公开）；负责人：「1、2、3 同意，按原规则审到 READY 为止」）
- **公开仓库自己的 CI（E5 Codex 第 1 轮推迟到 G3 的事项）：** 公开仓库是只有一个提交的快照。`scripts/check-migrations.mjs`：没有指定基准、`HEAD` 确实没有父提交且不是浅克隆时，按「第一个提交，之前没有发布过迁移」通过；浅克隆的边界提交也没有父提交，所以浅克隆一律报错。TC-OPS-07（从 E5 之前的 `8ad8e91` 升级）需要开发历史：没有这个提交时只跑 TC-OPS-06（用当前镜像造的数据备份和恢复），到期检查只在完整历史里确实没有它时豁免 TC-OPS-07；浅克隆在测试和到期检查里都报错，开发仓库 CI 的 compose 和 coverage 两个 job 都取完整历史。公开快照另含 `CHANGELOG.md`（发布说明，只列已测试的功能）、`docs/perf.md`、`eval/validate`。

