# 里程碑 W2-4.1（草案第一版）：重构收尾——规则语义、统一引擎与能力①、多端协同、前端、文档

> 前置：重构 P0–P3 已完成（`docs/refactor-plan.md`、`docs/refactor-acceptance.md`）。P0–P2 已合并到 `main`；**P3 在 `feat/refactor-p3`（`432eec9`），尚未合并**。W2-4.1 从合并后的 `main` 开分支（合并需用户同意）。
> 本期 = 重构计划剩下的 P4–P8，**是一个封闭的范围**：做完 §2 的完成标准即结束重构，不再开新的阶段。
> 依据：用户审核过的规则表 `docs/rules-audit.md`（「保留」列）；能力①的需求取自 `docs/dev-week2-milestone5.md`（W2-5 草案）中本期需要的部分。
> 标 **【待确认 Kn】** 的位置依赖文末 §12 的回答，正文按推荐默认值书写。

---

## 0. 现状基线（读代码核实，2026-11-03）

| 事实 | 依据 |
|---|---|
| 项目只做两项能力：① 自然语言自主测试 / AI 探索；② Issue → 确定性计划 → 执行 → 现场包 | 用户 2026-10-31；`docs/refactor-plan.md` §0 |
| 能力②可用：Teamily 2.1.1 上 1903 × 10，进入循环 10/10、有效尝试 60、命中 0；desktop-web（2336）、mobile-web（1329 s1）端到端跑通 | `docs/refactor-acceptance.md` P3 |
| android-web 在 P3 之后**没有上过真机** | 同上 |
| 能力①**目前没有**：W1 的 mission / explore 已在 P1 删除，W2-5 草案未执行 | `CHANGELOG.md` P1；`docs/dev-week2-milestone5.md` |
| 元素定位：运行时按 `skills/teamily/finders.ts` 现场定位，缓存在 `platform/state/skill-cache/<端>@<环境>@<App 版本>@<分辨率>/` | `CHANGELOG.md` P3 |
| 生命周期：环境 `offline/checking/ready/leased/unfit`，租约记录任务进程 pid + 启动时间；一个任务只持有一个环境的租约 | `platform/lifecycle/{env,supervisor}.ts` |
| 多端同步只有命令行入口 `autotest sync`（`executor/sync.ts`），不经过 v1 任务、审批和租约 | `CHANGELOG.md` P1 |
| 规则语义未改：必现类仍要连续 3 次命中（E1），Issue 分类仍有拒绝 / 暂缓（A3），「最终结论必须来自生产」等文字仍在（E12），`task_run` 前仍要求等人确认（J3） | `executor/verdict.ts`、`issue/classify.ts`、`docs/agent-rules.md` |
| `issue/contract.spec.ts` 依赖 gitignore 的本地文件 `platform/conversations.local.yaml`，干净检出上 2 个用例失败 | `docs/refactor-acceptance.md` P1 |
| 规模：TS 源码 13,626 行（不含测试），测试 2,221 行；前端 6 个 HTML + `web.js` 约 300 行，无样式 | `git ls-files` 统计（2026-11-03） |

## 1. 本期范围（封闭）

| 阶段 | 内容 | 章节 |
|---|---|---|
| P4 | 规则语义落地：E1、E2、A3、E18、E12、J3、B7；单测去掉对本地文件的依赖 | §4 |
| P5 | 统一引擎（共用会话 / 录制 / 现场包 / 判定），在其上实现能力①的最小可用版 | §5 |
| P6 | 多端协同接入 v1 任务（多环境租约、审批、结果视图） | §6 |
| P7 | 前端 HTML 三件套重做 | §7 |
| P8 | 文档定稿：`docs/rules.md`（规则与落点）、README、CHANGELOG、历史文档归档 | §8 |

## 2. 完成标准（DoD）——全部满足即结束重构

1. **能力②四端可用**：android-app、android-web、desktop-web、mobile-web 各至少一个 Issue 走通「计划 → 执行 → 结论」；至少一次命中产出完整现场包（录像 / trace、日志、步骤、`replay.json`），离线 `index.html` 能打开。
2. **能力①可用**：android-app 与 desktop-web 上，自然语言任务、只读探索各跑通一次；运行中人为让 App 退出（或页面崩溃），产出完整现场包。
3. **多端协同**：一个「两个账号 × 两个端」的同步任务经 `autotest task run` 跑通（租约、审批、结果视图齐全）。
4. **规则落地**：`docs/rules.md` 逐条列出每条「保留 / 改」规则在代码或文档里的落点；标「删除」的规则在代码里无残留（逐条核对，不靠抽查）。
5. **三端一致**：CLI、Web、MCP 用同一份视图模型；新前端通过同事真人验收（H8）。
6. **工程**：代码门全绿；TS 源码 ≤ 12,000 行（不含测试）【待确认 K1】。
7. **文档**：README、CHANGELOG、`docs/rules.md` 与代码一致；`docs/dev-week*.md` 等历史文档移到 `docs/history/`。

## 3. 原则（本期新增的范围约束）

- **封闭列表**：只做 §1 的五个阶段；不新增阶段，也不在阶段内加表外的工作。
- **阻塞才修**：做的过程中发现的范围外问题，只有阻塞本阶段验收的才当场修（例如 P3 里 Teamily 2.1.1 导致跑不起来的规则）；其余记进 `docs/backlog.md`，重构结束后再排。
- **每阶段报 DoD 进度**：每个阶段合并前，列出 §2 七条里已满足 / 未满足的项。
- 继承：用户审核过的规则（`docs/rules-audit.md`）；黑盒 B1；能力②循环内不读屏、不调视觉（D2–D8 只约束能力②）；硬约束 G3（不删除 / 撤回消息、不出允许清单、不动锁屏 PIN、凭据不落盘）；功能开发期完全授权默认开启。

## 4. P4：规则语义落地

| 规则 | 改动 | 落点 |
|---|---|---|
| E1 | 必现类命中 1 次即「已复现」（不再要求连续 3 次） | `executor/verdict.ts`、`platform/schema/test-plan.ts#verdictRuleFor`、报告与视图文字 |
| E2 | 命中定义按能力分开：能力② = 硬异常，或界面异常且符合 Issue 描述（经证据复核）；能力① = 硬异常，或报错影响正常使用（经证据复核，P5 用） | `executor/verdict.ts`、`incident/evidence-review.ts` 的复核口径 |
| A3 / E18 | 不拒绝任何 Issue：去掉 `server-side`、`not-executable`、`deferred` 的拒绝 / 暂缓分支；`multi-account` 改为「多端协同」计划（P6 执行）；生成不了计划的子用例也出一页报告写明原因 | `issue/classify.ts`、`issue/planner.ts`、`issue/report.ts` |
| E12 | 删除「最终结论必须来自生产 / 测试环境只用于标定」的限制与文字；测试环境 = 另一组账号池 | `issue/planner.ts`、`platform/api-v1.ts`、README、SKILL |
| J3 | 完全授权开启时 `task_run` 直接执行；`plan_explain` 照常输出，但不要求等人确认 | `docs/agent-rules.md`、`platform/mcp.ts` 工具说明 |
| B7 | Issue 里的截图可以交给模型（生成契约 / 计划时） | `issue/parse.ts`、`issue/planner.ts` |
| — | `issue/contract.spec.ts` 改用测试夹具，不再读 `platform/conversations.local.yaml` | `issue/contract.spec.ts`、`platform/conversations.ts`（`CONVERSATIONS_FILE` 已可注入） |

完成判据：单测与 golden 更新、CHANGELOG 写明行为变化（I16）；1903 × 1 结论口径不变。

## 5. P5：统一引擎 + 能力①（最小可用版）

### 5.1 统一引擎（不改行为）
- 新建 `engine/`：`session`（租用 → 启动 → SKILL 缓存 → 登录 → 首页）、`recorder`（飞行记录器、录制驱动、现场包、重放，原 `incident/` + `executor/replay.ts`）、`verdict`、`failure`、`manifest`、`trajectory` 两种模式共用。
- 现有 `executor/` 作为模式 A（计划模式）放到 `engine/plan/`；能力② 的行为、报告与视图不变（golden / 快照不变即通过）。

### 5.2 模式 B：自主测试 / 探索（快速档）
借鉴 Artemis Flash 的单 agent 循环（`ref/artemis`，思路借鉴、TypeScript 重写），不做它的多 agent 图、视频分析与控制台。
1. **每步**：屏幕快照（截图 + 带编号的可见元素：Android 读树，Web 用 Playwright 角色定位器）→ 模型返回一个动作：`tap #n`（优先）、`tap x,y`（必须附目标描述）、`type`、`swipe`、`back`、`launch`、`done(completed|failed)`、`report_issue(描述)`。
2. **点击前**：复用执行前校验（`executor/pretap.ts`），目标不在就把情况交回模型，不盲目重试。
3. **安全（G10、W2-5 X2）**：默认只读——发送、删除、改设置、付款、退出 / 注销、邀请 / 分享、改资料一律拦截并记入事件；风险规则表用 P1 删除前的关键词表作种子（`git show 3d7dc46:explore/explore-loop.ts` 的 `DEFAULT_AVOID`、`mission/runner.ts` 的 `HARD_BLOCK`），改成带词边界、中英文分开；可写探索按敏感计划审批。
4. **计划与终止**：第一步由模型写 Markdown checkbox 计划（`[ ] [/] [x] [!]`），代码只解析勾选状态；全部打勾、步数 / 时长 / 模型调用次数到上限、或取消即结束。
5. **探索记账**：屏幕文字指纹 → 该界面试过的动作；引导模型优先未试过的；结束时报告覆盖了多少界面、多少动作、拦截了多少（E20：「没发现」要带覆盖）。
6. **问题判定（E2 能力①）**：驱动事件流的硬异常直接算；模型的 `report_issue` 先写现场包，再经证据复核（独立、只读、必须引用证据，证据不足为「未验证」），通过才算发现。
7. **记录**：每步经录制驱动，现场包与 `replay.json` 和模式 A 同一格式。

### 5.3 接入
- v1 任务类型 `explore`：`autotest task run --explore "<需求>" [--env <id>] [--max-steps N] [--max-minutes M] [--writable]`；结果用 `result show`（发现清单、覆盖、拦截、预算使用）；MCP 工具 `explore_run`；Web 任务页显示每步截图缩略与决策理由。
- 本期不做（进 backlog）：计划档（规划者 + 检查者）、发现一键转 Issue 草稿、SKILL 候选元素、运行中追加指令、卡顿判定（`parseGfxinfo`）。

## 6. P6：多端协同接入 v1 任务

- 一个任务可以持有多个环境的租约（原子地全部租到才开始，任一租不到就都不租），租约仍按任务进程 pid + 启动时间判断存活；结束时全部释放并各自检查。
- v1 任务类型 `sync`：`autotest task run --sync <角色1>,<角色2> [--rounds N]`（角色 = 端，账号由账号池按环境分配，同一账号不重复）；审批：只发到允许清单会话的默认允许，超量发送按敏感计划。
- `multi-account` 类 Issue 生成多角色计划时走同一执行路径（P4 已不再暂缓）；本期验收只要求 §2 第 3 条。
- 删除 `autotest sync` 的旧命令行入口，或改为调用 v1（二选一，按实现时的代码量定）。

## 7. P7：前端（HTML 三件套）

- 参照 `docs/intro.html` 与 `D:\projects\tensoropera\im-loadtest\webui\static\`：同一套「纸质实验记录本」设计变量（暖白纸底、柔墨字、低饱和植物色；Fraunces / Hanken Grotesk / DM Mono，网络不通时退回系统字体）。
- 结构：`platform/web/index.html` + `style.css` + `app.js`，hash 路由的单页，不引入框架（H7）；实时进度用 SSE；原有 5 个页面与 `web.js` 合并进来。
- 页面：总览（设备、环境、运行中任务、完全授权红色横幅）/ 新建任务（自然语言·探索 与 Issue 两个入口，加多端协同）/ 任务详情（步骤时间线、最新截图）/ 结果（结论句、依据、有效尝试与区间、现场包链接）/ 审批（敏感计划、配置项、完全授权开关）。
- 计划页的「在截图上标出每一步点哪里」改用最近一次运行的截图与 SKILL 缓存里的元素框。
- 文案规则不变：每页回答五问，白话步骤由模板生成（H6–H8）。

## 8. P8：文档定稿

- `docs/rules-audit.md` 定稿为 `docs/rules.md`：只留生效规则，每条加「落点」列（文件 / 函数 / 文档段落）；删除的规则不再出现。
- README 按两项能力重写；CHANGELOG 合并重构各阶段为一节；`docs/agent-rules.md` 补「何时用探索、何时用 Issue 主线」「探索结论不是复现结论」。
- `docs/dev-week*.md`、各里程碑验收文档、`env-plan.md` / `env-report.md` 移到 `docs/history/`（不删除）。

## 9. 子任务拆分（执行顺序）

| # | 子任务 | 依赖 | 完成判据 |
|---|---|---|---|
| T0 | P3 合并到 `main`（用户同意）；开 `feat/w2m4.1`；回答 §12 | — | K1–K4 定稿 |
| T1 | P4 规则语义（§4） | T0 | 代码门全绿；1903 × 1 口径不变；CHANGELOG 写明行为变化 |
| T2 | 统一引擎（§5.1，不改行为） | T1 | golden / 快照不变；1903 × 1、2336 × 1 结论不变 |
| T3 | 模式 B 循环 + 只读安全 + 记录（§5.2 第 1–4、7 条） | T2 | 单测：风险规则（中英文、词边界、典型高风险标签全拦）；android-app 只读探索 5 分钟跑通，事件中无高风险动作被执行 |
| T4 | 探索记账 + 问题判定 + 现场包（§5.2 第 5–6 条） | T3 | 人为让 App 退出 → 现场包可离线打开；未发现时报告带覆盖 |
| T5 | 接入 v1 / MCP / Web 任务页（§5.3） | T4 | MCP 发起一次探索并取回结果；desktop-web 上自然语言任务跑通 |
| T6 | 多端协同（§6） | T2 | 两账号 × 两端同步任务经 `task run` 跑通 |
| T7 | 前端（§7） | T5、T6 | Playwright 截图各页面；同事真人验收 |
| T8 | android-web 真机走通一个 Issue；任一 Issue 命中出现场包（§2 第 1 条） | T2 | 真机产物存档 |
| T9 | 文档定稿与规则落点核对（§8，§2 第 4、7 条） | T1–T8 | 逐条核对表无缺项 |
| T10 | DoD 总验收（§2 七条） | T1–T9 | 七条全部满足，写 `docs/w2m4.1-acceptance.md` |

## 10. 硬约束与工作规则

- 继承 §3；硬约束 G3 任何情况下不越过；不执行 `adb kill-server`；不代输锁屏 PIN。
- 每次改动后跑代码门（I8）；真机门只在阶段结束时跑；一次修复后同一项连续两次不达标就停下报告（I6）。
- 每个阶段一个分支，`--no-ff` 合并，**合并到 `main` 需要用户同意**（I10）。
- 历史数据不改写：已保存的计划、草稿、任务记录被调试运行改写时恢复为已提交版本。

## 11. 风险

| 风险 | 应对 |
|---|---|
| Teamily 再次静默升级、改版 | SKILL 缓存按 App 版本自动换新；规则认不出时报「SKILL 失效」，修 `finders.ts` 属于「阻塞才修」 |
| 能力①模型成本与时延（每步 3–10 s） | 每次运行设步数、时长、模型调用次数上限，报告列出用量 |
| 模式 B 误操作（发送、删除等） | 默认只读 + 风险规则表 + 执行前校验；T3 用事件记录核对 |
| 统一引擎改动面大，影响能力② | T2 只搬家不改行为，用 golden / 快照 / 真机结论不变作为闸门 |
| 12,000 行上限偏紧（P5 新增约 0.7k、P7 前端另计） | P5 合并重复代码抵消；超出时在 §12 K1 重新约定 |

## 12. 待确认问题

1. **K1**：§2 第 6 条「TS 源码 ≤ 12,000 行（不含测试）」是否作为硬性标准？推荐：是；超出时先说明原因再定。
2. **K2**：能力①本期只做快速档（§5.2），计划档、发现转 Issue、SKILL 候选进 backlog——是否同意？
3. **K3**：能力①的执行端本期只要求 android-app + desktop-web（§2 第 2 条）——是否同意？
4. **K4**：模式 B 的默认上限：快速档每次 200 步 / 20 分钟 / 200 次模型调用——是否可以？
