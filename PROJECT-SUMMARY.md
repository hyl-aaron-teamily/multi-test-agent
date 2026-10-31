# multi-test-agent 项目总结

> 截至 2026-10-31，按代码核对。W1–W4、M5、M6、W2-1 — W2-4 均已合并到 `main` 并推送到 `origin/main`（W2-4 合并提交 `ae5843e`）。
> 用法见 `README.md`，变更见 `CHANGELOG.md`，每期验收证据见 `docs/*-acceptance.md`，需求原文见各 `dev-week*-milestone*.md`（每份末尾有「实现对照」一节，记录与代码的差异）。介绍页 `docs/intro.html` 与周报 `docs/weekly-2026-10-23.html` 是 2026-10-22 的快照，不随代码更新。

## 1. 定位

Teamily 客户端测试台。交给它一份 Issue，它判断问题类型、生成测试计划，经一次确认后在 Android App、手机自带浏览器里的 Web、手机视口 Web、桌面 Web（Windows 上为 Edge 最大化窗口）四个执行端上**黑盒**复现或验收，在生产环境给出带证据、可复核、可重放的结论。外部 Agent 通过命令行（`autotest <对象> <动作> --json`）或 MCP 服务（W2-4，同一套命令与信封）驱动，人在 Web 页面上审核与兜底。

核心约定（各期需求文档的共同主线，代码位置见 §5）：

- 黑盒：只做用户能做的操作，只看用户能看到的现象；不读源码、不注入页面代码、不连手机浏览器的调试端口。
- 准备时用 AI，循环时确定性：固定元素在标定时记下坐标；动态目标（哪个群、哪条消息）在准备阶段由模型选定后冻结；循环每一步只按坐标操作，不截图、不读界面树、不调视觉模型，动作间隔 ≤ 1 秒。
- 判定确定性优先：日志 / 进程 / 系统状态 / 无障碍或页面文字 / 区域比对在前，视觉模型兜底；检查类命中先经录屏证据复核才计数。
- 结论只陈述观察到的事实：带有效尝试数、单轮命中率与 Wilson 95% 区间，0 命中给 3/n 上界；失败分「环境 / 工具」。
- 确认即冻结：用户确认的计划（哈希）就是执行的计划。
- 审批（功能开发期，2026-10-30 用户决定）：完全授权默认开启——被测软件内操作与敏感计划都自动批准、环境配置项自动同意；只有硬约束（删除 / 撤回消息、允许清单外会话发消息、锁屏 PIN）仍拒绝。开发结束时关闭。

## 2. 里程碑与编号

需求文档的文件名与正文编号不一致（下表以实际为准）。开发第一周（10-19 — 10-22）完成 W1–W4、M5、M6，第二周（10-26 — 10-29）完成 W2-1 — W2-3。

| 编号 | 需求文档 | 完成日期 | 主题 | 合并 |
|---|---|---|---|---|
| W1 | `dev-week1-milestone1.md` | 10-19 | Web 基线：Midscene + Vitest + Allure，saucedemo 5 步用例 | `1e550c4`（直接在 main） |
| W2 | `dev-week1-milestone2.md`（正文称「第二周」） | 10-19 | Android ADB、logcat 崩溃监控、高频循环 | `1c33a57` |
| W3 | `dev-week1-milestone3.md`（正文称「第三周」） | 10-19 | AI 探索 + Monkey + 统一问题报告 | `87c01e3` |
| W4 | `dev-week1-milestone4.md`（正文称「第四周」） | 10-20 | 统一 CLI、控制台、设备池、CI；文档外另做了自然语言任务（mission）、计划缓存、即时重放、imui | `f363f4a`（经 `feat/imui-ui-loadtest` 合并） |
| M5 | `dev-week1-milestone5.md`（合并了原计划的 M5 / M6 / M7） | 10-21 — 22 | Issue 分类驱动的黑盒复现、Teamily SKILL、事故现场包、坐标重放 | 直接提交在 main |
| M6 | **无独立需求文档**（与原计划的 M6 不是一回事） | 10-22 | 证据复核、退出 / 杀进程 / 重新加载、手机浏览器端、Edge 端、端点池与多端同步 | `626f1ca`；证据 `docs/m6-acceptance.md` |
| W2-1 | `dev-week2-milestone1.md` | 10-26 — 28 | 基座重构、意图契约、循环外分层观察 / 定位、预热闸门、指纹自愈、轨迹 | `3704bbd` |
| W2-2 | `dev-week2-milestone2.md` | 10-28 | 可信结论、运行清单、预检、隔离、系列运行、Web trace、代码门；MVP 2010 / 1903 | `7e91873` |
| W2-3 | `dev-week2-milestone3.md` | 10-28 — 30 | 任务与环境分离、收尾可恢复、审批与状态码、命令行给 Agent、Web 给人 | `7ef7425` |
| W2-4 | `dev-week2-milestone4.md` | 10-30 | 感知层（读树后端可插拔 + 设备端只读读树服务、屏幕快照 / 索引、② 层模糊匹配、循环外执行前校验）、`doctor`、原生 MCP 服务（参考 Artemis，TypeScript 重写） | `ae5843e`；证据 `docs/w2m4-acceptance.md` |

方向的转折在 M5：W1–W4 的目标是通用的「AI 视觉驱动测试平台」（只给包名，视觉模型每步决定操作）；M5 起改为 Teamily 专属、Issue 驱动、循环内不用视觉。W1–W4 的入口（mission / explore / monkey / imui / 基线用例）保留不变，作为没有 Issue 时的旁路。WebView、小程序、iOS 至今未接入。

## 3. 当前能力与结论（摘要）

完整清单见 `README.md`「现状一览」。样例 Issue 12 份（`issues/`），结论来自生产环境（Redmi / Xiaomi 2211133C，Android 16，Teamily App 2.0.15；Edge）：

| Issue | 处理 | 结论（出处） |
|---|---|---|
| 1594 @ 选择器偶发不弹出 | desktop-web | 未复现，1000 步、最大间隔 918 ms、视觉调用 0（M5） |
| 2336 三个独立通知铃铛 / 2122 免打扰群 @ 我（单账号部分） | desktop-web 需求验收 | 未实现（M5） |
| 1329 点赞 / 引用定位 / 键盘（iOS） | android-app 替代 | 三项均未复现；开发期 s2「已复现」为误报，已由证据复核排除（M5 / M6） |
| 2044 引用块显示 Markdown 源码（iOS） | android-app 替代 | 已复现，连续 3 轮，证据复核 3/3（W2-1） |
| 2010 AI 改写覆盖草稿（iOS） | android-app 替代，系列 10 次 | 4/10 次运行复现；单轮 52 次有效尝试命中 25 次（Wilson 35.1%–61.3%）（W2-2） |
| 1903 气泡内 @ 不渲染（iOS） | android-app 替代，系列 10 次 | 未复现，60 次有效尝试，95% 上界 ≈ 5%（W2-2） |
| 1614 / 1922 | 拒绝 | 服务端问题 / 按 M5 文档约定（`platform/issue-overrides.yaml`） |
| 2235 | 暂缓 | 多账号 |
| 1426 / 1918 | 暂缓（只分类 + 契约） | 需拖选 + 剪贴板 / Agent 回复内容不可构造 |

W2-3 验收（`docs/w2m3-acceptance.md`）：故障注入 20 格全部通过（预热断连一格 2026-10-30 改用 `adb reconnect` 补跑）；确定性、一致性、代码门、脚本化 Agent 闭环通过；同事验收、敏感计划 Web 同意后再执行、旧入口跑 2010 得出结论的一次未完成。

W2-4 验收（`docs/w2m4-acceptance.md`）：执行前校验真机注入 4/4，循环内校验 0 次；`doctor` 四种情况正确；只用 MCP 工具跑通 2010 × 3、1903 × 3（Teamily 2.0.20 上均未复现，与之前口径一致），MCP 与 `--json` 逐字段一致；读树服务（v6）读树 p95 61 ms（uiautomator 约 3.2 s），节点一致率 100%，服务未安装 / 被停用时自动退回且报告写明原因。

另检出的产品现象：App 进后台期间收到的消息，回前台 60 秒内不显示（M6 多端同步）；会话列表预览显示「[自定义消息]」占位（W4 自然语言任务，人工确认）。

## 4. 系统架构

```
 Agent ── autotest <对象> <动作> --json ─┐        人 ── 浏览器 ─┐
                                        ▼                      ▼
 ┌─ 入口 ─────────────────────────────────────────────────────────────────────────┐
 │ bin/autotest.ts：v1 命令 → scripts/cli-v1.ts（平台服务的客户端）；task exec → scripts/task-exec.ts│
 │                  旧命令 plan/run/series/skill/sync/evidence/… → scripts/m5.ts、issue-cli.ts   │
 │                  mission/explore/monkey/imui/report → scripts/*、report/                       │
 │ platform/server.ts（node:http :3210）：/ 与 /*.html（W2-3 页面）、/console（旧控制台）、         │
 │                  /api/v1/*（api-v1.ts）、/api/*（旧任务）、/files、/refs                        │
 └──────────────────────────────────────────────────────────────────────────────┘
 ┌─ 平台层 platform/ ─────────────────────────────────────────────────────────────┐
 │ lifecycle/：env.ts（环境状态机）· task.ts（任务状态机、事件、台账、结果）· runtime.ts（任务进程侧：  │
 │   心跳、进度、先记账、取消）· supervisor.ts（调度、看门狗、恢复进程、上下线）· crosscheck.ts ·      │
 │   recover.ts / baseline.ts / android-ops.ts（基线与恢复）· registry.ts（devices.yaml × 账号 → 环境）│
 │   · status.ts（状态码）· store.ts（原子写、锁、审计）                                            │
 │ approval.ts（审批策略）· plans-v1.ts（计划 id / 哈希 / 版本绑定）· views.ts（视图模型）           │
 │ tasks.ts + device-pool.ts（旧任务类型与端点池）· accounts/（账号池）· schema/（TestPlan、契约）   │
 └──────────────────────────────────────────────────────────────────────────────┘
 ┌─ Issue 层 issue/ ──────────────┐  ┌─ SKILL skills/ ──────────────────────────────────────┐
 │ parse → classify → contract →  │  │ teamily/vocab.ts（元素 / 区域 / 目标指引）· node-specs.ts   │
 │ planner（模式编译 / 模型组合）→ │  │ （Node 表）· nodes.ts（Node 实现）· patterns.ts（触发模式库）│
 │ validate → drafts（哈希）→     │  │ · preconditions.ts · profiles/ · refs/                    │
 │ report                         │  │ calibrate-web / -android / -android-web.ts · profile.ts   │
 └────────────────────────────────┘  └───────────────────────────────────────────────────────┘
 ┌─ 执行器 executor/ ─────────────────────────────────────────────────────────────┐
 │ run.ts runPlan：租用 → 预检 → session/surfaces（启动、登录、SKILL 有效性、自愈）→ prepare/targets  │
 │ → warmup → loop/checkpoint/observe/locate → verdict/stats/failure → manifest、轨迹、报告          │
 │ isolation · preflight · heal · series · sync（多端同步）· replay（坐标重放）· login/              │
 └──────────────────────────────────────────────────────────────────────────────┘
 ┌─ 驱动 drivers/ ─────────────────────┐  ┌─ 证据 incident/ ─────────────────────────────────┐
 │ android.ts：常驻 adb shell、yadb、    │  │ android-recorder / web-recorder（飞行记录器）·      │
 │ 一条 logcat 流做异常门                │  │ recording-driver（坐标操作日志）· bundle（现场包）· │
 │ web.ts：Playwright（Edge / Pixel 7） │  │ viewer · evidence-review / evidence-cases          │
 └─────────────────────────────────────┘  └─────────────────────────────────────────────────┘
 ┌─ core/ ──────────────────────────────────────────────────────────────────────────┐
 │ adb · ui-tree（唯一的界面树读取）· image（PNG 解码、墨迹区域比对、dHash）· model/llm（文本 / 视觉   │
 │ JSON 调用与计数）· model/midscene（视觉 ask / locate）· trajectory · screen-recorder ·            │
 │ logcat-monitor（旁路入口用）· task-result                                                       │
 └─────────────────────────────────────────────────────────────────────────────────┘
 旁路入口：mission/ · explore/ · monkey/ · imui/ · report/ · replay/（W1–W4，行为不变）
```

状态全部落盘为文件（`platform/state/`、`platform/plans/`、`midscene_run/`），没有数据库；前端是静态 HTML + 原生 JS，没有构建链。

## 5. 一次 Issue 运行（代码路径）

1. **解析与分类**：`issue/parse.ts#parseIssue` 按 `##` 段落归一化（同名段落取第一次出现，即英文部分）；`issue/classify.ts#classifyRules` 先看 `platform/issue-overrides.yaml`，再按文本规则分 8 类，规则弱时 `#classify` 交给文本模型。
2. **契约**：`issue/contract.ts#contractFor`——子用例文本命中某个模式（`skills/teamily/patterns.ts#patternForText`）就用规则契约，否则由模型填契约（只能用库里的 id），失败退回规则契约。
3. **计划**：`issue/planner.ts#draftIssue`——契约带模式 → 确定性编译（不调模型）；否则模型在 Node / 元素词表内组合一次；`issue/validate.ts#validatePlan` 不通过 → 退回通用模板，`contract.ts#coverageOf` 标注 `not-covered`。前置条件全部不可构造 → 暂缓。iOS 等无执行端时默认替代为 android-app。
4. **草稿与冻结**：`issue/drafts.ts#saveDraft` 写内容哈希、Issue 文件哈希和版本号；计划 id `<Issue>/<子用例>:<端>@v<版本>`（`platform/plans-v1.ts`）。
5. **提交（W2-3 路径）**：`platform/api-v1.ts#submit` 解析计划 → 核对哈希 → 选环境 → 环境配置项同意 → `platform/approval.ts#classifyPlan` 分类（默认允许 / 敏感 / 拒绝）→ 自动或人工批准、扣运行次数（`#useApproval`，31 / 32 / 33）→ 建任务并把计划与草稿冻进任务目录。
6. **调度**：`platform/lifecycle/supervisor.ts#tick` 把排队任务租到 `ready` 的环境上（每台手机同时一个任务），起子进程 `scripts/task-exec.ts#execTask`；`#watch` 每 5 秒跑看门狗（心跳 30 秒、进度超时 = 步骤预算 + 60 秒、总时长）。
7. **执行**：`executor/run.ts#runPlan`
   - 租用账号与端点槽 → 预检（`executor/preflight.ts#preflightAndroid` / `#preflightWeb`，不合格 = 环境不合格，不启动 App）→ 运行清单（`executor/manifest.ts`）；
   - `executor/session.ts#openSession` / `#enterApp`：App 冷启动、登录、首页参考区域比对（`executor/checks.ts#assertSkillFresh`），失效时先按指纹自愈（`executor/heal.ts`）；
   - `executor/prepare.ts#prepare`：会话目标由文本模型在读出的会话行里选（`executor/targets.ts#pickTargets`，无模型用规则，读不到行才用视觉），干净起点，构造前置条件（只在允许清单会话，`#assertConstructionAllowed`）；
   - `executor/warmup.ts#runWarmup`：按计划跑一轮并逐步核验效果，失败 = 计划不可执行；
   - `executor/loop.ts#runLoop`：每步坐标操作 + 事件流异常门；每轮末检查点（`executor/checkpoint.ts`、`executor/observe.ts`）；偏离轮不计入；检查类命中先写现场包（`executor/incident-hook.ts`）再证据复核（`incident/evidence-review.ts#reviewIncident`）；`executor/verdict.ts#VerdictTracker` 判定；
   - 收尾 `executor/isolation.ts#runEpilogue` / `#teardown`，失败归类 `executor/failure.ts#classifyFailure`。
8. **结果**：`issue/report.ts#writeIssueReport`（report.md、result.json、Allure）、`trajectory.jsonl`；任务进程写 `result.json` 与终态；平台随后起独立进程 `autotest env recover` 按台账恢复环境（`platform/lifecycle/recover.ts#recoverEnv`）。
9. **查看**：`autotest task wait / result show`（退出码 = 结论状态码）与 Web 结果页读同一份视图模型（`platform/views.ts#resultView`）。

旧路径 `pnpm autotest run / series`（`scripts/issue-cli.ts#runCmd` / `#seriesCmd`）跳过第 5、6 步，直接调用同一个 `runPlan`，退出码保持 0 / 1 / 3。

## 6. 规模与测试

- 147 个提交（10-19 — 10-29）；TypeScript 约 2.06 万行（其中 26 个单测文件 2148 行），另有 W2-3 页面与旧控制台 HTML / JS 558 行。不含单测的行数：platform 3979、executor 3656、scripts 2231、skills 1751、core 1215、incident 962、imui 928、issue 805，其余（drivers 653、mission / explore / monkey / report / replay、fixtures 等）约 2900。
- 2026-10-30：`pnpm typecheck` 通过；`pnpm test:unit` 26 个文件 215/215 通过。`test:web`、`test:android` 各只有 1 个用例（每个用例 5 步）。代码门 `pnpm code-gate`（typecheck + 单测 + 证据复核预置用例）W2-3 实测 192 秒。
- CI（`.github/workflows/ai-test.yml`）只做过语法检查，未在真实 runner 上运行。

## 7. 已知差异与限制（代码核对，2026-10-29）

文档写了、代码没有或不同的地方（细节见各需求文档末尾「实现对照」）：

1. **「疑似误操作」类别走不到**：执行侧有 `executor/phases.ts#runCorrectPath` 和 `executor/loop.ts` 末尾的结论映射，但模式库、`planner.ts#basePlan`、模型组合都不生成 `correctPath`，规则分类也不产出该类；所以「疑似误操作 / 转为 bug」两个结论实际走不到。
2. ~~预热失败回写草稿只在旧入口~~ **已修复（2026-10-30）**：新旧两条路径都经 `issue/drafts.ts#recordWarmupFailures` 写回同版本的已保存草稿。
3. ~~手机浏览器环境的恢复不检查手机~~ **已修复（2026-10-30）**：android-web 环境走 `baseline.ts#walkAndroidWeb`（在线、锁屏、残留进程、键盘、结束浏览器、输入法、配置项），并声明与 App 相同的环境配置项；键入过的会话不逐个打开核对，作为说明项列出。另：App 版本的批准绑定此前不生效（环境从未写入版本），已改为每次检查 / 恢复与每次运行后记录（`recover.ts#walk`、`scripts/task-exec.ts`）；策略或完全授权做出的批准遇版本变化自动续批，人或 Agent 显式批准的仍返回 32。
4. **自愈门槛比需求宽**：`executor/session.ts#enterApp` 只要有一个首页元素按指纹找回就继续（W2-1 要求全部找回）。
5. **`runPlan` 回涨到 241 行**：W2-1 合并时 135 行（要求 ≤ 150），W2-2 后 222 行。
6. **SKILL 版本不比对**：`skills/teamily/vocab.ts#SKILL_VERSION` 为 2026.10.30-1（android-app 正式 profile 已同步，其余 profile 仍记录旧版本），加载时不检查（只有 `executor/replay.ts` 告警）；审批绑定的是代码常量与 profile 文件哈希。
7. **证据复核**：排除计数只在计入命中时清零（实际是「自上次计入命中以来 3 次」，不是严格连续）；一次运行的现场包（含崩溃、看门狗）减去被排除的达到 5 个后，后续检查类命中不再写现场包、不再复核，直接计数（`executor/loop.ts`）。
8. **坐标重放**：只判 `visual-region` 检查与硬异常，引用定位（baseline）、文字、键盘类命中重放不出；偏离比对的原轮末帧取在 afterCheck 之前，重放取在之后。
9. **多端同步的 Web 接收端读页面文字**（`executor/sync.ts#lineVisible` → `observe.ts#pageHasText`），`README.md` 与 `sync.ts` 文件头仍写「Web 用视觉、不读 DOM」。
10. **端点池与账号池的租用只在进程内存**：`platform/state/devices.json` 只写不读；旧入口与平台同时对一台手机下任务会冲突（README 已注明）。W2-3 的 `task run` 经平台排队，不受影响。
11. **旁路入口**（W1–W4）：`core/logcat-monitor.ts` 判断崩溃属于哪个包依赖窗口内的 `Process: <包名>` 行，典型的 `ANR in <包名>` 可能不带该行，被当作其他进程的崩溃（代码推断，未在真机上复现）；imui 的 `ui_ready_ms` 从未赋值、`IMUI_WEB_INPUT` 未实现。

其他限制（与 README 一致）：iOS / WebView / 小程序未接入；多角色 Issue 计划未做；「未复现」不代表没有问题；手机锁屏（PIN）只能人工解锁；读一次 Android 界面树约 2.5–3.7 秒，所以只在循环外读。

## 8. 早期记录（W1–W4，2026-10-20 前）

- 真机（Xiaomi 2211133C / Android 16，Teamily 生产）：AI 探索 6 轮覆盖 4–9 个状态，未捕获崩溃；Monkey 未对 Teamily 运行（随机点击避不开发送 / 支付），用计算器验收（seed 12345 / 3000 事件无崩溃，`am crash` 注入被捕获并与 monkey.log 关联）；自然语言任务两次误报已修正；Midscene 计划缓存使同一计划重跑 207.8 秒 → 88.7 秒。
- 生产副作用（W3，已人工还原）：Teamily Agent 免打扰被打开、Personal AI 翻译语言被改、输入框被模板填充（未发送）。此后 explore 默认只读（关键词黑名单，`explore/explore-loop.ts`），Issue 主线的构造只在允许清单会话内进行。
- 与参考代码的相似度（10-20 对 W1–W4 代码测得，此后未重测）：与 `ref/midscene-example` 逐行比对，有效行完全相同的约 1.6%，均为样板代码；`lycoding/auto-test-platform` 只借鉴了设备池与调度的架构，未引入其代码。
