# 里程碑 W2-4.1：重构收尾——规则语义、统一引擎与能力①、多端协同、前端、文档

> 前置：重构 P0–P3 完成（`docs/history/refactor-plan.md`、`docs/history/refactor-acceptance.md`）。P0–P2 已在 `main`；P3 在 `feat/refactor-p3`（`432eec9`），合并到 `main` 后本期开分支（合并需用户同意）。
> 本期是重构计划剩下的 P4–P8，范围封闭：§2 的完成标准全部满足，重构结束。
> 依据：`docs/history/rules-audit.md`（用户审核过的规则）；能力①的需求取自 `docs/history/dev-week2-milestone5.md`（W2-5 草案）。K1–K4 已于 2026-11-03 定稿（§12）。

---

## 0. 现状基线（2026-11-03）

| 事实 | 依据 |
|---|---|
| 项目只做两项能力：① 自然语言自主测试 / AI 探索；② Issue → 确定性计划 → 执行 → 现场包 | 用户 2026-10-31；`docs/history/refactor-plan.md` §0 |
| 能力②在 Teamily 2.1.1 上可用：1903 × 10 进入循环 10/10、有效尝试 60、命中 0；desktop-web（2336）、mobile-web（1329 s1）端到端跑通 | `docs/history/refactor-acceptance.md` P3 |
| android-web 在 P3 之后没有上过真机 | 同上 |
| 能力①目前没有实现：W1 的 mission / explore 在 P1 删除，W2-5 草案未执行 | `CHANGELOG.md` P1 |
| 元素按 `skills/teamily/finders.ts` 现场定位，缓存在 `platform/state/skill-cache/<端>@<环境>@<App 版本>@<分辨率>/` | `CHANGELOG.md` P3 |
| 一个任务只持有一个环境的租约；租约记录任务进程 pid + 启动时间 | `platform/lifecycle/{env,supervisor}.ts` |
| 多端同步只有命令行入口 `autotest sync`，不经过 v1 任务、审批和租约 | `executor/sync.ts` |
| 规则语义未改：必现类要连续 3 次命中（E1）；Issue 分类有拒绝 / 暂缓（A3）；「最终结论必须来自生产」（E12）；`task_run` 前等人确认（J3） | `executor/verdict.ts`、`issue/classify.ts`、`docs/agent-rules.md` |
| `issue/contract.spec.ts` 读 gitignore 的 `platform/conversations.local.yaml`，干净检出上 2 个用例失败 | `docs/history/refactor-acceptance.md` P1 |
| TS 源码 13,626 行（不含测试），测试 2,221 行；前端 6 个 HTML + `web.js` 约 300 行，无样式 | 2026-11-03 统计 |

## 1. 范围

| 阶段 | 内容 | 章节 |
|---|---|---|
| P4 | 规则语义：E1、E2、A3、E18、E12、J3、B7；单测改用夹具 | §4 |
| P5 | 统一引擎；能力①（快速档）；探索发现交给能力②复现（Pro 档） | §5 |
| P6 | 多端协同接入 v1 任务 | §6 |
| P7 | 前端 HTML 三件套 | §7 |
| P8 | 文档定稿：`docs/rules.md`、README、CHANGELOG、历史文档归档 | §8 |

## 2. 完成标准（DoD）

1. **能力②四端可用**：android-app、android-web、desktop-web、mobile-web 各有一个 Issue 走通「计划 → 执行 → 结论」；至少一次命中产出完整现场包（录像 / trace、日志、步骤、`replay.json`），离线 `index.html` 能打开。
2. **能力①可用**：android-app 与 desktop-web 上，自然语言任务、只读探索各跑通一次；运行中人为让 App 退出（或页面崩溃），产出完整现场包。
3. **探索转复现**：一条探索发现生成 Issue 草稿，由能力②生成计划并执行，给出带分母的结论。
4. **多端协同**：一个「两个账号 × 两个端」的同步任务经 `autotest task run` 跑通（租约、审批、结果视图齐全）。
5. **规则落地**：`docs/rules.md` 逐条列出每条「保留 / 改」规则的代码或文档落点；标「删除」的规则在代码里无残留。
6. **三端一致**：CLI、Web、MCP 用同一份视图模型；新前端通过同事真人验收（H8）。
7. **工程与文档**：代码门全绿；README、CHANGELOG、`docs/rules.md` 与代码一致；历史文档在 `docs/history/`。TS 源码目标 ≤ 12,000 行（不含测试，非硬性，K1）。

## 3. 范围约束

- 只做 §1 的五个阶段，阶段内只做本文写明的工作。
- 范围外的问题记进 `docs/backlog.md`；阻塞本阶段验收的当场修（如 P3 里 Teamily 2.1.1 导致跑不起来的规则）。
- 每个阶段合并前，列出 §2 各条的满足情况。
- 继承：`docs/history/rules-audit.md` 的规则；黑盒 B1；能力②循环内不读屏、不调视觉（D2–D8 只约束能力②）；硬约束 G3（不删除 / 撤回消息、不出允许清单、不动锁屏 PIN、凭据不落盘）；功能开发期完全授权默认开启。

## 4. P4：规则语义

| 规则 | 改动 | 落点 |
|---|---|---|
| E1 | 必现类命中 1 次即「已复现」 | `executor/verdict.ts`、`platform/schema/test-plan.ts#verdictRuleFor`、报告与视图文字 |
| E2 | 命中按能力定义：能力② = 硬异常，或界面异常且符合 Issue 描述（经证据复核）；能力① = 硬异常，或报错影响正常使用（经证据复核） | `executor/verdict.ts`、`incident/evidence-review.ts` |
| A3 / E18 | 不拒绝任何 Issue：去掉 `server-side`、`not-executable`、`deferred` 分支；`multi-account` 生成多端协同计划（P6 执行）；生成不了计划的子用例出一页报告写明原因 | `issue/classify.ts`、`issue/planner.ts`、`issue/report.ts` |
| E12 | 删除「最终结论必须来自生产」的限制与文字；测试环境 = 另一组账号池 | `issue/planner.ts`、`platform/api-v1.ts`、README、SKILL |
| J3 | 完全授权开启时 `task_run` 直接执行；`plan_explain` 照常输出 | `docs/agent-rules.md`、`platform/mcp.ts` 工具说明 |
| B7 | Issue 截图交给模型（生成契约 / 计划时） | `issue/parse.ts`、`issue/planner.ts` |
| — | `issue/contract.spec.ts` 用夹具代替本地允许清单 | `issue/contract.spec.ts`（`CONVERSATIONS_FILE` 可注入） |

完成判据：单测与 golden 更新；CHANGELOG 写明行为变化（I16）；1903 × 1 结论口径不变。

## 5. P5：统一引擎 + 能力①

能力分档（K2）：**快速档 = 能力①**（每步看屏幕、模型决策的单 agent 循环，借鉴 Artemis Flash）；**Pro 档 = 能力②**（确定性计划、逐轮检查、系列统计）。探索发现的问题转成 Issue 草稿，由能力②复现，两档共用一个引擎和同一种现场包。

### 5.1 统一引擎（行为不变）
- `engine/`：`session`（租用 → 启动 → SKILL 缓存 → 登录 → 首页）、`recorder`（飞行记录器、录制驱动、现场包、重放；原 `incident/` + `executor/replay.ts`）、`verdict`、`failure`、`manifest`、`trajectory`，两档共用。
- 现有 `executor/` 移到 `engine/plan/`，作为 Pro 档；能力②的 golden、快照与真机结论保持不变。

### 5.2 快速档：自主测试 / 探索
参考 `ref/artemis` 的 Flash 单 agent 循环，用 TypeScript 重写（Apache-2.0，注明来源）。
1. **每步**：屏幕快照（截图 + 带编号的可见元素：Android 读树，Web 用 Playwright 角色定位器）→ 模型返回一个动作：`tap #n`（优先）、`tap x,y`（附目标描述）、`type`、`swipe`、`back`、`launch`、`done(completed|failed)`、`report_issue(描述)`。
2. **点击前**：执行前校验（`executor/pretap.ts`），目标不在就把情况交回模型。
3. **默认只读**（G10）：发送、删除、改设置、付款、退出 / 注销、邀请 / 分享、改资料一律拦截并记入事件。风险规则表以 P1 前的关键词表为种子（`git show 3d7dc46:explore/explore-loop.ts` 的 `DEFAULT_AVOID`、`mission/runner.ts` 的 `HARD_BLOCK`），改成带词边界、中英文分开。可写探索按敏感计划审批。
4. **计划与结束**：第一步由模型写 Markdown checkbox 计划（`[ ] [/] [x] [!]`），代码只解析勾选状态；agent 报告 `done` 或用户取消即结束。
5. **上限**（K4，参照 Artemis Flash）：默认不设步数上限；上下文靠历史压缩控制（每 12 步压缩为一段摘要，按需检索原始记录）；单次模型调用硬超时 180 s；平台兜底为 D9 硬上限 3000 步 / 120 分钟；`--max-steps` / `--max-minutes` 可收紧。报告列出步数、时长、模型调用次数。
6. **探索记账**：屏幕文字指纹 → 该界面试过的动作，引导模型优先未试过的；报告覆盖了多少界面、多少动作、拦截了多少（E20）。
7. **问题判定**（E2 能力①）：驱动事件流的硬异常直接算；`report_issue` 先写现场包，再经独立、只读的证据复核（必须引用证据，证据不足为「未验证」），通过才算发现。
8. **记录**：每步经录制驱动，现场包与 `replay.json` 与 Pro 档同一格式。

### 5.3 探索转复现（Pro 档）
- 每条发现导出：现象、页面、触发路径（坐标操作序列 + 白话步骤）、证据（现场包、复核结论）、运行清单。
- 生成 Issue Markdown（摘要 / 复现步骤 / 预期 / 实际 / 频率 / 环境）写入 `issues/explore-<时间>-<序号>.md`，走现有「分类 → 契约 → 计划」；命中模式就确定性编译，否则模型组合并标注。

### 5.4 接入
- v1 任务类型 `explore`：`autotest task run --explore "<需求>" [--env <id>] [--max-steps N] [--max-minutes M] [--writable]`；`result show` 给出发现清单、覆盖、拦截、用量；`autotest explore issue <taskId> <发现序号>` 生成 Issue 草稿。
- MCP 工具 `explore_run`；Web 任务页显示每步截图缩略与决策理由，结果页有「转成 Issue」按钮。

## 6. P6：多端协同接入 v1 任务

- 一个任务可持有多个环境的租约：全部租到才开始，任一租不到就都不租；存活仍按任务进程 pid + 启动时间判断；结束时全部释放并各自检查。
- v1 任务类型 `sync`：`autotest task run --sync <端1>,<端2> [--rounds N]`，账号由账号池按环境分配、不重复；只发到允许清单会话的默认允许，超量发送按敏感计划审批。
- `multi-account` 类 Issue 的多角色计划走同一执行路径。
- 旧入口 `autotest sync` 删除或改为调用 v1，按实现时的代码量定。

## 7. P7：前端（HTML 三件套）

- 视觉沿用 `docs/intro.html` 与 `D:\projects\tensoropera\im-loadtest\webui\static\` 的设计变量：暖白纸底、柔墨字、低饱和植物色；Fraunces / Hanken Grotesk / DM Mono，网络不通时退回系统字体。
- `platform/web/index.html` + `style.css` + `app.js`，hash 路由单页，不引入框架（H7）；实时进度用 SSE；原有 5 个页面与 `web.js` 合并进来。
- 页面：总览（设备、环境、运行中任务、完全授权红色横幅）/ 新建任务（自然语言·探索、Issue、多端协同）/ 任务详情（步骤时间线、最新截图）/ 结果（结论句、依据、有效尝试与区间、现场包链接、转成 Issue）/ 审批（敏感计划、配置项、完全授权开关）。
- 计划页的步骤标注改用最近一次运行的截图与 SKILL 缓存里的元素框。
- 每页回答五问，白话步骤由模板生成（H6–H8）。

## 8. P8：文档定稿

- `docs/rules-audit.md` 定稿为 `docs/rules.md`：只留生效规则，每条带「落点」列。
- README 按两项能力重写；CHANGELOG 把重构各阶段合为一节；`docs/agent-rules.md` 补「何时用探索、何时用 Issue 主线」「探索结论不是复现结论」。
- `docs/dev-week*.md`、各里程碑验收文档、`env-plan.md` / `env-report.md` 移到 `docs/history/`。

## 9. 子任务

| # | 子任务 | 依赖 | 完成判据 |
|---|---|---|---|
| T0 | P3 合并到 `main`（用户同意）；开 `feat/w2m4.1` | — | 分支就绪 |
| T1 | P4 规则语义（§4） | T0 | 代码门全绿；1903 × 1 口径不变 |
| T2 | 统一引擎（§5.1） | T1 | golden / 快照不变；1903 × 1、2336 × 1 结论不变 |
| T3 | 快速档循环 + 只读 + 记录（§5.2 第 1–5、8 条） | T2 | 单测：风险规则（中英文、词边界、典型高风险标签全拦）；android-app 只读探索 5 分钟，事件中无高风险动作被执行 |
| T4 | 探索记账 + 问题判定 + 现场包（§5.2 第 6–7 条） | T3 | 人为让 App 退出 → 现场包可离线打开；未发现时报告带覆盖 |
| T5 | 探索转复现（§5.3） | T4 | §2 第 3 条 |
| T6 | 接入 v1 / MCP / Web 任务页（§5.4） | T5 | MCP 发起一次探索并取回结果；desktop-web 上自然语言任务跑通 |
| T7 | 多端协同（§6） | T2 | §2 第 4 条 |
| T8 | 前端（§7） | T6、T7 | Playwright 截图各页面；同事真人验收 |
| T9 | android-web 真机走通一个 Issue；一次命中出现场包 | T2 | §2 第 1 条 |
| T10 | 文档定稿与规则落点核对（§8） | T1–T9 | §2 第 5、7 条 |
| T11 | DoD 总验收 | T1–T10 | §2 七条，写 `docs/w2m4.1-acceptance.md` |

## 10. 工作规则

- 每次改动后跑代码门（I8）；真机门在阶段结束时跑；同一项修复后连续两次不达标即停下报告（I6）。
- 每个阶段一个分支，`--no-ff` 合并，合并到 `main` 需用户同意（I10）。
- 不执行 `adb kill-server`；不代输锁屏 PIN。
- 调试运行改写了已提交的计划、草稿或任务记录时，恢复为已提交版本。

## 11. 风险

| 风险 | 应对 |
|---|---|
| Teamily 静默升级、改版 | 缓存按 App 版本自动换新；规则认不出时报「SKILL 失效」，修 `finders.ts` |
| 快速档默认不设步数上限，单次运行可能很长 | 平台硬上限 3000 步 / 120 分钟；报告列出用量；可用 `--max-steps` / `--max-minutes` 收紧 |
| 快速档误操作（发送、删除等） | 默认只读 + 风险规则表 + 执行前校验；T3 用事件记录核对 |
| 统一引擎改动面大 | T2 只搬家不改行为，golden / 快照 / 真机结论不变作为闸门 |

## 12. 已定（2026-11-03）

1. **K1**：TS 源码 ≤ 12,000 行是目标，不是硬性标准。
2. **K2**：能力①就是快速档；Pro 档由能力②承担——探索发现转 Issue，由能力②复现（§5.3）。不另做规划者 / 检查者。
3. **K3**：能力①本期覆盖 android-app 与 desktop-web。
4. **K4**：快速档的上限参照 Artemis Flash（§5.2 第 5 条）。
