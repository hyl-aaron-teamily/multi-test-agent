# 开发规定（生效版）

由 `5d84362:docs/history/rules-audit.md`（2026-10-31 用户审核）和 W2-4.1 的决定（2026-11-03，`docs/dev-week2-milestone4.1.md` §4、§12）整理而来，只列现在生效的规定。
「改」和「定」的条目写的是修改后的版本。能力① = 快速档（自然语言自主测试 / 探索），能力② = Pro 档（Issue → 确定性计划 → 复现）。落点写法：`路径#符号`；写「（未落地）」表示代码和现存文档里都没找到。

## A 范围

| # | 规定 | 落点 |
|---|---|---|
| A1 | 优先保证 Teamily 的测试体验；力所能及地保留泛化能力（探索模式不绑定 Teamily 专有逻辑） | `skills/teamily/SKILL.md`；`engine/agent/run.ts#runAgent` |
| A2 | Issue 里允许有不能复现或已修复的用例，用来检验系统能力；设最大步长，达到上限仍没复现就如实报告 | `platform/schema/test-plan.ts#HARD_LIMITS`；`engine/verdict.ts#VerdictTracker`；`engine/stats.ts#attemptsText` |
| A3 | 不拒绝任何 Issue（2026-11-03）：服务端类按偶现执行，只看用户可见的一侧；多账号类生成多端协同计划 | `issue/planner.ts#draftIssue`；`issue/planner.ts#syncSubcase` |
| A5 | 不拿探索代替复现：探索的发现只能转成 Issue 草稿，由能力②给结论 | `docs/agent-rules.md` §2、§4；`engine/agent/to-issue.ts#writeFindingIssue` |
| A6 | 执行端有四种：android-app、android-web、mobile-web、desktop-web；Windows 上的 Web 用最大化的 Edge，不做桌面 App；iOS、WebView、小程序没有接入 | `platform/accounts/types.ts#SURFACES`；`drivers/factory.ts#createDriver`；`drivers/web.ts#launchOptions` |

## B 黑盒与观察边界

| # | 规定 | 落点 |
|---|---|---|
| B1 | 不读源码，不装调试版，不向页面注入 JS（evaluate、addInitScript、exposeFunction），不用 App 钩子，不生成测试代码文件 | `drivers/web.ts#WebDriver`；`drivers/android.ts#AndroidDriver`；`engine/observe.ts#pageHasText` |
| B3 | 只用用户级输入：触控、光标、键盘 | `drivers/types.ts#Driver` |
| B4 | 允许环境模拟（断网、慢网、视口、设备模拟），不算注入 | `drivers/web.ts#contextOptions`（目前只实现了视口和设备模拟） |
| B5 | 只读观察：只要不违反 B1 就允许，唯一的例外是能力②的循环内（D2）（定） | `engine/plan/loop.ts#runLoop`；`engine/snapshot.ts#snapshot`；`engine/observe.ts#observeText` |
| B7 | Issue 里的截图交给视觉模型，在生成契约和计划时使用（2026-11-03） | `issue/images.ts#issueImages`；`issue/contract.ts#modelContract` |
| B8 | 保留自建的无障碍 APK，作为快速读树后端；不再限制为只读，必要时可以加手势或剪贴板；令牌校验保留（定） | `core/a11y-service.ts#installA11y`；`core/a11y-service.ts#A11Y_TOKEN_ACTION`；`android/a11y-service/` |
| B9 | 读树后端可以替换，失效时自动退回 uiautomator，并写明用了哪个后端、为什么退回；uiautomator 导出按设备串行执行 | `engine/session.ts#selectTreeBackend`；`core/tree-backend.ts#readTree`；`core/tree-backend.ts#uiautomatorBackend` |
| B11 | 不接外部 OCR；生产截图只发往已配置的模型端点 | `package.json`（无 OCR 依赖）；`core/model/llm.ts#visionConfigured` |
| B12 | 不用自研视觉模型、CV 库或图像哈希包 | `core/image.ts#dHash`（自写，无依赖）；`package.json` |

## C SKILL 与计划生成

| # | 规定 | 落点 |
|---|---|---|
| C1 | 即时定位 + 缓存（含原 C2–C4）：不做离线标定，不用 profile 和参考图；准备期用树或 DOM 文本现场定位，图标靠视觉；结果按「端@环境@App 版本@分辨率」缓存；SKILL 只保留语义（元素怎么认、Node、模式库）；界面认不出就报「SKILL 失效」 | `skills/teamily/finders.ts#FINDERS`；`engine/skill-resolver.ts#SkillResolver`；`skills/profile.ts#cacheKey` |
| C5 | 计划生成顺序：命中模式就确定性编译；没命中就由 LLM 组合一次；校验失败用通用模板；所有计划都要过规则校验 | `issue/planner.ts#draftIssue`；`skills/teamily/patterns.ts#patternForText`；`issue/validate.ts#validatePlan` |
| C6 | 只在生成阶段理解 Issue，执行器不解读 Issue 文本；契约里只能用库里的 id 或 unmapped | `issue/contract.ts#contractFor`；`platform/schema/contract.ts#IssueContractZ` |
| C7 | 确认即冻结：按哈希执行确认时的草稿，执行时不调模型；加 `--redraft` 才重新生成 | `issue/drafts.ts#draftHash`；`issue/drafts.ts#loadSavedDraft`；`scripts/issue-cli.ts#loadDraft` |
| C8 | coverage=not-covered 时，结论旁注明「计划未覆盖 Issue 现象，仅说明无崩溃」 | `issue/contract.ts#coverageOf`；`platform/views.ts#planView` |
| C10 | 不手改 SKILL 缓存、计划和草稿文件 | `docs/agent-rules.md` §7 |

## D 循环与性能

| # | 规定 | 落点 |
|---|---|---|
| D1 | 只约束能力②：动作间隔 ≤1 s（实现为两次输入的开始时间相隔 ≤950 ms）；delayAfterMs 默认 300，上限 1000 | `engine/plan/actions.ts#execAction`；`platform/schema/test-plan.ts#PlannedActionZ`；`issue/validate.ts#validatePlan` |
| D2 | 能力②的循环里，每一步只按冻结坐标操作：不截图、不读树、不调视觉、不额外发 adb 命令 | `engine/plan/loop.ts#runLoop` |
| D3 | 能力②的循环里，每步的异常门只看事件流：logcat 四个缓冲区和 page 事件 | `drivers/android.ts#classifyLogLine`；`drivers/types.ts#HARD_ANOMALIES`；`engine/plan/loop.ts#runLoop` |
| D4 | 能力②：一份 Issue 只启动一次 App，每次运行都冷启动（启动类问题除外） | `engine/plan/run.ts#runPlan`；`engine/plan/isolation.ts#cleanStart` |
| D5 | 能力②：视觉模型只在检查不一致或出现异常时调用，次数应接近 0；按用途计数，写进报告 | `core/model/llm.ts#countCall`；`core/model/llm.ts#setModelPurpose` |
| D6 | 能力②：判定和定位分三层（① 确定性 → ② 屏幕索引排序 → ③ 视觉），记录由哪一层决定、耗时多少 | `engine/observe.ts#observeText`；`engine/locate.ts#locate`；`engine/stats.ts#addTier` |
| D7 | 能力②：执行前校验只用于循环外的点击，循环内为 0 次；校验不通过就不点 | `engine/pretap.ts#PreTapGuard`；`engine/plan/prepare.ts#prepare` |
| D8 | 能力②：进循环前过预热闸门，逐步核验，每步允许重做 1 次；失败就判「计划不可执行」 | `engine/plan/warmup.ts#runWarmup` |
| D9 | 能力②的步数上限默认 1000 步 / 15 分钟；两档共用硬上限 3000 步 / 120 分钟（能力①见 M4） | `platform/schema/test-plan.ts#DEFAULT_LIMITS`；`platform/schema/test-plan.ts#HARD_LIMITS` |
| D10 | 看门狗：能力②循环中单步预算 20 s，超时就写现场包并停止 | `engine/plan/loop.ts#runLoop`（`WATCHDOG_MS`） |
| D11 | 预检目标 ≤10 s；电量低于 15% 判为环境不合格 | `engine/preflight.ts#preflightAndroid`（`MIN_BATTERY`） |
| D12 | 飞行记录器用环形窗口：视频 30 s × 6 段，logcat 保留 180 s，不得单调增长 | `engine/recorder/android-recorder.ts#AndroidFlightRecorder`；`engine/recorder/android-recorder.ts#WINDOW_MS`；`engine/recorder/web-recorder.ts#WebFlightRecorder` |
| D13 | scrcpy 只能优雅停止（在设备端 pkill），不强杀本地进程 | `core/screen-recorder.ts#ScreenRecorder` |
| D16 | 平台任务异步执行：立即返回任务 id，前端轮询或用 SSE 获取进度 | `platform/api-v1.ts#submit`；`platform/server.ts`（SSE） |

## E 判定、证据与现场包

| # | 规定 | 落点 |
|---|---|---|
| E1 | 偶现类和必现类都是命中 1 次即「已复现」；feature 类分为已实现 / 部分实现 / 未实现 | `engine/verdict.ts#VerdictTracker`；`engine/verdict.ts#featureConclusion`；`platform/schema/test-plan.ts#verdictRuleFor` |
| E2 | 命中的定义：能力②是硬异常，或检查不通过且证据复核认定与 Issue 描述相符；能力①是硬异常，或出现影响正常使用的报错（经证据复核） | `engine/plan/loop.ts#runLoop`；`engine/agent/run.ts#runAgent`；`engine/recorder/evidence-review.ts#reviewIncident` |
| E3 | bug 类结论只有「已复现」和「未复现（n 次有效尝试）」，不写已修复或疑似已修复 | `engine/verdict.ts#VerdictTracker`；`docs/agent-rules.md` §4 |
| E4 | 有效尝试 = require 成立且没有偏离；报告给出总轮数、有效、偏离、命中和 Wilson 95% 区间，0 命中时给出 3/n 上界 | `engine/stats.ts#attemptsOf`；`engine/stats.ts#wilson` |
| E5 | 按比例验收：每个用例独立运行 10 次，工具可靠性 ≥9/10 | `engine/plan/series.ts#summarizeSeries`；`scripts/issue-cli.ts#seriesCmd` |
| E6 | 报告首段固定三行：触发路径、出现位置、推测机制（标「推测」） | `engine/plan/run.ts#leadOf`；`issue/report.ts#runMarkdown`；`platform/views.ts#resultRun` |
| E7 | 检查类和视觉兜底的命中，先写现场包，再经证据复核（用视觉对照契约里的现象），通过后才计数 | `engine/plan/loop.ts#runLoop`；`engine/recorder/evidence-review.ts#reviewIncident` |
| E8 | 每次失败按环境、工具、产品分类，归类规则只放在 failure.ts 一处 | `engine/failure.ts#classifyFailure` |
| E9 | 预检不合格就是「环境不合格」：不启动，不计入工具失败，也不计入产品结论 | `engine/plan/run.ts#runPlan`；`scripts/task-exec.ts#unfitCode` |
| E10 | 被中断的任务结果标「不完整」，不给结论 | `platform/lifecycle/task.ts#closeTask`；`platform/views.ts#resultView` |
| E11 | 默认允许替代端执行；报告首行标注替代，结论只代表替代端 | `issue/planner.ts#substitutionOptions`；`issue/report.ts#runMarkdown`；`platform/views.ts#planView` |
| E12 | 测试环境 = 另一组账号池，没有其他特殊用途；结论不要求必须来自生产（定） | `platform/accounts/secret-backend.ts#parseAccountsYaml`；`platform/accounts/account-pool.ts#AccountPool` |
| E13 | 现场包统一放在 `incidents/<n>-<kind>/`：离线可打开的 index.html、incident.json、video、trace、logs、steps、state、replay.json（坐标级，带 SKILL 版本和执行端） | `engine/recorder/bundle.ts#writeIncident`；`engine/recorder/bundle.ts#incidentDir`；`engine/recorder/viewer.ts#viewerHtml` |
| E14 | 现场包内容：最后 30 个操作；录像 ≤6×30 s，覆盖崩溃前至少 30 s；前后 ±15 s 日志；最近 10 轮截图；replay ≤21 轮。Android 另采 crash buffer、dropbox、前台 Activity、meminfo 和版本信息 | `engine/recorder/bundle.ts#writeIncident`；`engine/recorder/android-recorder.ts#AndroidFlightRecorder` |
| E15 | Web 现场包：trace 能打开，看得到异常前的画面、网络请求和 console；执行失败时保存最后两块 trace | `engine/recorder/web-recorder.ts#WebFlightRecorder`；`engine/plan/run.ts#runPlan` |
| E16 | 重放沿用同一套判定规则，并报告偏离点（从第 k 步起与原路径不同） | `engine/recorder/replay.ts#replayIncident`；`engine/recorder/replay.ts#firstDeviation` |
| E17 | 每次运行都写 manifest.json（不含凭据）和 trajectory.jsonl；sink 出异常不影响运行 | `engine/manifest.ts#writeManifest`；`core/trajectory.ts#openTrajectory` |
| E18 | 生成不了计划的子用例（例如缺前置条件）也出一页报告，写明原因；不拒绝任何 Issue | `issue/planner.ts#draftIssue`（`unplannable`）；`issue/report.ts#refusalMarkdown` |
| E19 | 旁路入口的崩溃产物写到 `midscene_run/crashes/<ts>/` | （未落地）旁路入口已在 P1 删除，代码里没有写这个目录的地方 |
| E20 | 没发现问题时明确写「未发现」并附上覆盖范围；宁可报未发现，也不能伪造 | `platform/views.ts#exploreSentence`；`engine/agent/run.ts#agentMarkdown` |

## F 任务、环境、设备、账号

| # | 规定 | 落点 |
|---|---|---|
| F1 | 任务和环境各有独立的状态机；一个环境同一时间只有一个租约（文件锁 + 原子写，记录 pid 和进程启动时间） | `platform/lifecycle/env.ts#leaseEnv`；`platform/lifecycle/task.ts#moveTask`；`platform/lifecycle/store.ts#withLock` |
| F6 | 取消在步骤边界生效；任务输出写成结构化文件，不用正则解析日志；状态以 JSON 存在 platform/state/ | `platform/lifecycle/runtime.ts#TaskRuntime`；`platform/lifecycle/task.ts#writeResult`；`platform/lifecycle/store.ts#stateRoot` |
| F7 | 每次运行生成一个标记（r + 6 位十六进制），写进所有构造的文字；开跑前回到干净起点；结束时只做无副作用的复位 | `engine/plan/template.ts#newRunToken`；`engine/plan/isolation.ts#cleanStart`；`engine/plan/isolation.ts#runEpilogue` |
| F8 | 一台手机同一时间只跑一个任务；真机运行严格串行 | `platform/device-pool.ts#DevicePool`；`platform/lifecycle/supervisor.ts#Supervisor`（leaseAll）；`platform/mcp.ts#deviceSnapshot` |
| F9 | 账号池按环境隔离；Android 设备和账号绑定，原子地同时租用；账号冷却 30 s | `platform/accounts/account-pool.ts#AccountPool`（`COOLDOWN_MS`）；`engine/lease.ts#leaseFor` |
| F10 | 凭据只放在 `platform/accounts.local.yaml` 和 `platform/secrets/`（gitignored），不进日志、报告、轨迹、提交和对话 | `platform/accounts/secret-backend.ts#LocalYamlBackend`；`core/trajectory.ts#scrub`；`docs/agent-rules.md` §6 |
| F11 | Web 登录用光标和键盘，之后用 storageState 复用会话，失效时自动重新登录 | `engine/login/sessions.ts#ensureWebSession`；`engine/login/ui-login.ts#ensureUiLogin` |
| F12 | 不硬编码设备序列号；多台设备在线时先问用户用哪台 | `platform/device-pool.ts#parsePoolConfig`；`platform/mcp.ts#deviceSnapshot`；`docs/agent-rules.md` §5 |
| F13 | 不装 Android Studio、模拟器、Gradle；SDK 片段可以下载到 tools/android-sdk | `android/a11y-service/fetch-sdk.sh` |
| F14 | 会修改系统的命令，先在 env-plan.md 记录原文，执行后补记结果 | `docs/env-plan.md`（有这类命令时新建；之前的记录在 `5d84362:docs/history/env-plan.md`） |
| F15 | CI 里的模型 Key 通过 Secrets 注入 | `.github/workflows/ai-test.yml` |
| F16 | 多端任务要么租到全部环境，要么一个都不租；结束时全部释放，并各自检查（2026-11-03） | `platform/lifecycle/supervisor.ts#Supervisor`（`leaseAll`、`ended`） |

## G 审批与硬约束

| # | 规定 | 落点 |
|---|---|---|
| G1 | 被测 App 内的操作默认允许。敏感计划需要在 Web 上同意：操作其他 App 或系统界面、单任务发送超过 50 条、系列超过 20 次。环境配置项在注册时同意一次 | `platform/approval.ts#classifyPlan`；`platform/approval.ts#SENSITIVE`；`platform/lifecycle/env.ts#consentConfig` |
| G2 | 功能开发期完全授权默认开启；只能在 Web 上开关，开启时显示红色横幅并写审计 | `platform/approval.ts#fullAccessDefault`；`platform/approval.ts#setFullAccess`；`platform/web/app.js`（banner） |
| G3 | 硬约束任何情况下都不能越过：不删除或撤回消息，不在允许清单外的会话发消息或构造数据，不动锁屏 PIN，凭据不落盘 | `platform/approval.ts#classifyPlan`（refused）；`engine/agent/risk.ts#classifyRisk` |
| G4 | 生产环境的前置条件只能在 construct.allow 会话（成员全是池账号或用户本人）或自己的 Personal AI 里构造；prod 账号都是测试号，发出的消息不用撤回 | `platform/conversations.ts#constructionAllowed`；`engine/plan/prepare.ts#assertConstructionAllowed` |
| G5 | 批准绑定计划哈希、SKILL 版本、profile 哈希、App 版本、Issue 哈希和允许次数，不符时返回 31/32/33 | `platform/approval.ts#useApproval`；`platform/plans-v1.ts#staleFacts` |
| G6 | CLI 和 MCP 都不能同意敏感计划、完全授权或环境配置项，Agent 不能自己批准 | `platform/approval.ts#approve`；`platform/mcp.ts#EXPOSED`；`docs/agent-rules.md` §3 |
| G7 | 预检只能修改列出的手机设置，每项都记入 manifest | `engine/preflight.ts#preflightAndroid`；`engine/preflight.ts#taplusWith`；`engine/manifest.ts#buildManifest` |
| G8 | 禁止 `adb kill-server`，重连用 `adb -s <udid> reconnect` | `docs/agent-rules.md` §5；`platform/doctor.ts#fixStale` |
| G9 | 测试机上只碰自己的包，不动其他 App 和设置 | `platform/approval.ts#classifyPlan`（非 SKILL 动作 / 系统键 = 敏感）；`engine/agent/risk.ts#classifyRisk`（settings） |
| G10 | 探索默认只读，可写探索按敏感计划处理（需要完全授权） | `engine/agent/risk.ts#classifyRisk`；`platform/api-v1.ts#submitExplore` |
| G11 | 快速档的点赞、关注、收藏、订阅只能作用于 agent（测试）账号自己的主页和内容，只读和可写运行都适用；名单取自 gitignored 的 `platform/accounts.local.yaml` 中的 `environments.<env>.ownContent`（2026-11-03） | `engine/agent/risk.ts#classifyRisk`；`engine/agent/risk.ts#nearOwnContent`；`platform/accounts/account-pool.ts#AccountPool`（ownContent） |

## H 接口契约（CLI / Web / MCP）

| # | 规定 | 落点 |
|---|---|---|
| H1 | CLI、Web、MCP 共用同一份视图模型和信封，结论句和数字完全一致 | `platform/views.ts#resultView`；`platform/views.ts#planView`；`platform/api-v1.ts#apiV1` |
| H2 | 状态码为两位数，十位表示类别（1x–7x）；错误对象格式为 {status,code,message,hint,retryable,kind} | `platform/lifecycle/status.ts#STATUS`；`platform/lifecycle/status.ts#apiError` |
| H3 | 用 `--json` 时 stdout 只输出一个 JSON；非 TTY 时永不提问；平台未启动返回 54 | `scripts/cli-v1.ts#cliV1`；`scripts/cli-v1.ts#call`（54）；`scripts/issue-cli.ts#runCmd`（isTTY） |
| H4 | MCP：stdio 传输，是 /api/v1 的薄客户端，不自动拉起平台；task_wait 单次 ≤25 s；工具不超过 20 个；资源只能在限定目录内；不改 IDE 配置 | `platform/mcp.ts#WAIT_MAX_S`；`platform/mcp.ts#EXPOSED`；`platform/mcp.ts#safeResourcePath` |
| H5 | 视图模型带 schemaVersion，有破坏性改动时 +1，并同时更新快照 | `platform/views.ts#VIEW_SCHEMA_VERSION`；`platform/__snapshots__/w2m3.spec.ts.snap` |
| H6 | 先说明再执行：PlanView 列出发送条数上界、目标会话、构造的数据、配置项、模型调用点、预计耗时和审批类别 | `platform/views.ts#planView`；`platform/views.ts#estimate` |
| H7 | Web 用中文白话，每页回答五问（要做什么 / 正在做什么 / 结果 / 可信吗 / 下一步）；步骤由模板生成；不引入前端框架 | `platform/web/index.html`；`platform/web/app.js`；`platform/views.ts#stepText` |
| H8 | 人工可读性由同事真人验收；LLM 只能润色说明文字 | `docs/w2m4.1-acceptance.md`；`docs/w2m4.1-colleague-check.md` |

## I 工程流程（用户审核时称 L 组）

| # | 规定 | 落点 |
|---|---|---|
| I1 | 必要时允许使用任何技术栈 | `package.json`（当前为 TypeScript 单栈） |
| I2 | 状态仍用 JSON；其他依赖（数据库、前端构建链等）必要时可以放宽 | `platform/lifecycle/store.ts#writeJsonAtomic` |
| I3 | 不 mock 判定、定位、崩溃、回放；宁可失败也不能造假；无法验证的路径标「未验证」 | `engine/recorder/evidence-review.ts#reviewIncident`；`engine/recorder/evidence-cases.ts#runCases` |
| I4 | 缺设备或缺凭据时明确报错，不静默跳过 | `platform/doctor.ts#diagnose`；`core/adb.ts#AdbNotFoundError` |
| I5 | 不是凭据或设备类的错误要自己修，最多 3 轮；同一个细节重构不超过 2 轮；先用最简单的实现跑通 | （未落地） |
| I6 | 修复一次后同一项仍连续两次不达标，就停下报告，不循环打补丁 | `docs/dev-week2-milestone4.1.md` §10 |
| I7 | 工具装不上就降级，不卡在安装上 | （未落地） |
| I8 | 每次改动后都跑代码门（typecheck + 单测 + golden + 证据预置用例，≤5 分钟）；真机门只在阶段结束时跑 | `scripts/code-gate.sh`；`docs/dev-week2-milestone4.1.md` §10 |
| I9 | 每个子任务通过单测、typecheck、回归门和真机验证后再提交；用 Conventional Commits，小步提交 | （未落地） |
| I10 | 功能在 feat/* 分支开发，用 --no-ff 合并；合并到 main 要经用户同意 | `docs/dev-week2-milestone4.1.md` §10 |
| I11 | 每个里程碑写 CHANGELOG 和验收文档；README、SKILL、PROJECT-SUMMARY、「实现对照」与代码保持一致 | `CHANGELOG.md`；`README.md`；`docs/w2m4.1-acceptance.md` |
| I12 | 单一来源：读树、模型调用、Midscene agent、会话、Node 表各只有一处实现；删除没有入口的死代码 | `core/tree-backend.ts#readTree`；`core/model/llm.ts#chatJson`；`engine/session.ts#openSession` |
| I13 | ref/ 只读，不整体拷贝，用 `// ref:` 标注来源；借鉴 Artemis 的部分注明 Apache-2.0 | `engine/agent/run.ts`（文件头）；`engine/pretap.ts`（文件头）；`core/a11y-service.ts`（文件头） |
| I14 | API 不确定时按 ref/ → .d.ts → 在线文档的顺序查证，不发明 API | （未落地） |
| I16 | 重构前先保存 golden 和基线，行为变化写进 CHANGELOG | `issue/__golden__/`；`issue/golden.spec.ts`；`CHANGELOG.md` |

## J 给 IDE Agent 的行为准则

| # | 规定 | 落点 |
|---|---|---|
| J1 | 出错先调 doctor；human 类的下一步原样转告用户，不尝试绕过 | `docs/agent-rules.md` §1；`platform/doctor.ts#diagnose` |
| J2 | 复现流程固定为 issue_list → draft → plan_explain → task_run → task_wait → result_show | `docs/agent-rules.md` §2；`platform/mcp.ts#EXPOSED` |
| J3 | plan_explain 照常输出；完全授权开启时 task_run 直接执行，不等人确认 | `docs/agent-rules.md` §3；`platform/mcp.ts#createMcpServer`（instructions）；`platform/api-v1.ts#submit` |
| J4 | 锁屏只能请用户解锁；不索要、不回显凭据；改了 .env 后重启 MCP，并再调 doctor | `docs/agent-rules.md` §5、§6 |

## K Teamily SKILL 细则与测试机

| # | 规定 | 落点 |
|---|---|---|
| K1 | 生命周期动作只用于 android-app 和 android-web，idle ≤10 分钟；计划内的退出不算异常 | `platform/schema/test-plan.ts#LIFECYCLE_OPS`；`platform/schema/test-plan.ts#MAX_IDLE_MS`；`platform/schema/test-plan.ts#APP_SURFACES` |
| K3 | tapRewrite 等待 ≤10 s；composer-rewrite 每次运行最多 6 次有效尝试，判定条件是输入框文字「等于」原草稿 | `skills/teamily/node-specs.ts#NODE_SPECS`（tapRewrite）；`skills/teamily/patterns.ts#PATTERNS`（composer-rewrite） |
| K4 | 测试机上文字输入一律用 yadb（iFlytek 会吞字）；每次预检都重写 Taplus；首次 tap 可能不生效，要先确认屏幕再判断导航 | `drivers/android.ts#AndroidDriver`；`engine/preflight.ts#taplusWith`；`skills/teamily/nodes.ts#runNode` |

## M W2-4.1 决定（2026-11-03，原编号 K1–K4；为避免和上面的 K 组重号，改记为 M）

| # | 规定 | 落点 |
|---|---|---|
| M1 | （原 K1）TS 源码 ≤12,000 行（不含测试）是目标，不是硬性标准；代码门不检查行数 | `docs/dev-week2-milestone4.1.md` §2 第 7 条、§12；`scripts/code-gate.sh`（无行数闸门） |
| M2 | （原 K2）能力① = 快速档，能力② = Pro 档；探索发现转成 Issue 草稿，由能力②复现；不另做规划者 / 检查者 | `engine/agent/run.ts#runAgent`；`engine/plan/run.ts#runPlan`；`engine/agent/to-issue.ts#writeFindingIssue` |
| M3 | （原 K3）能力①本期覆盖 android-app 和 desktop-web | `README.md`（能力①验收范围）；`docs/w2m4.1-acceptance.md` |
| M4 | （原 K4）快速档的上限参照 Artemis Flash：默认不设步数上限；每 12 步把历史压缩成一段摘要；单次模型调用 180 s 超时；平台兜底为硬上限 3000 步 / 120 分钟，`--max-steps` / `--max-minutes` 可以收紧 | `engine/agent/run.ts#runAgent`（`MODEL_TIMEOUT_MS`）；`engine/agent/step.ts#historyText`（`KEEP_STEPS`）；`platform/api-v1.ts#submitExplore` |

## 删除规则的残留核对

| # | 搜索内容 | 结果 |
|---|---|---|
| A3 | `refus`、`server-side`、`not-executable`、`deferred`（issue/、platform/） | 行为上无残留：这几类不再被拒绝，`not-executable` / `deferred` 走 E18 的一页报告，`server-side` 按偶现执行。函数名 `refusalMarkdown` 已改为 `unplannableMarkdown`（2026-11-03）。`platform/approval.ts` 里的 `refused` 是 G3 硬约束，不属于 A3 |
| A4 | `mission`、`monkey`、`imui`、`week-1`、`alias`（代码与 bin/） | 无残留：`bin/autotest.ts` 里没有这些入口，也没有别名。`core/adb.ts:84` 的 `monkey -p` 只是用来启动 App。M5 开发命令（`scripts/m5.ts`）不在 A4 范围内 |
| B2 | `devtools`、`remote-debugging`、`CDP`、`调试端口` | 代码无残留（`drivers/web.ts` 的 CDP 是 Playwright 自己的会话，用于触控和读布局）。两处文字已删（2026-11-03） |
| B6 | 「只在循环外」「never the hot loop」 | 代码无残留（能力②的限制由 D2 保留）。README 原则已改为区分两档（2026-11-03） |
| B10 | `ScreenSnapshot` 是否为唯一的读树入口 | 无残留：locate、observe、targets、warmup、sync 都各自读树，代码没有强制「唯一结构」 |
| C9 | `healed-profile`、`healed` | 无残留：`engine/plan/warmup.ts:167` 的 `healed` 是循环外的重新定位，写入 SKILL 缓存 |
| D14 | 旧 explore 的 50 步 / 每状态 5 次 / 重启 3 次、`DEFAULT_AVOID` | 无残留：`engine/agent/risk.ts:4` 只在注释里说明种子词的来源 |
| D15 | Monkey 的 `throttle`、`seed`、5000 事件 | 无残留：`engine/manifest.ts:57` 的 `seed` 是运行标记 |
| E12 | 「最终结论」「生产」相关的限制、`env === 'prod'` 分支 | 无残留：`platform/approval.ts:63` 的 prod 分支是 G3/G4 的允许清单；`issue/planner.ts:129` 的 `env ?? 'prod'` 只是默认值 |
| E1（连续 3 次） | `consecutiveHits`、`连续命中` | 无残留：`platform/schema/test-plan.ts:64` 的 `VerdictRuleZ` 把旧值读成 anyHit，属于有意保留。已提交的旧计划 / 草稿（`platform/plans/1903-android-app-v1.json:140`、`2044-android-app-v1.json:104`、`drafts/1903.json:188`、`drafts/2044.json:149`）仍带着这个旧字段，经兼容读取生效 |
| F2 | `quarantin` | 无残留：`platform/lifecycle/env.ts:107` 的 `LEGACY_STATE` 是兼容读取，把旧记录映射到现状态机 |
| F3 | `heartbeat`、`心跳`、进度超时、恢复时限 | 代码无残留（`supervisor.ts:4` 注明不用心跳）。退出日志已改为「停止调度，运行中的任务进程保留租约、下次启动时接管」（2026-11-03） |
| F4 | `ledger`、「先记账再动手」 | 部分残留：`platform/lifecycle/runtime.ts:111` 仍在动手前写入 `intent` 台账（`engine/plan/run.ts:75` 的注释写「before each effect」），但台账只供任务视图展示副作用（H6），恢复已不再依据台账。保留：它是 H6 副作用记录的数据来源，不是规定 |
| F5 | `reconcile`、`draining` | 部分残留：`platform/lifecycle/supervisor.ts#reconcile` 在平台启动时按租约里的 pid 关闭僵尸任务，保留，属于 F1 存活判定（租约里的进程不在 = 任务已结束）；下线 draining 的日志文字已改 |
| I15 | —（流程规定，没有代码可查） | 无残留 |
| K2 | android-web 返回键、「最多 3 次」 | 有残留：`engine/surfaces.ts:67-70`（android-app 的 `recoverHome` 最多按 3 次返回）；`skills/teamily/SKILL.md:34`（android-web「不要用系统返回键，它会关闭标签页」，属于产品事实，web 适配器 `leaveConversation` 在没有 `chat.back` 时仍会调用 `d.back()`）。保留：这是技术原因（系统返回键会关闭标签页、越过首页会离开 App），不再作为规定 |
