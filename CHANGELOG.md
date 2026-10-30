# Changelog

## [Unreleased] — W2-3：可用性——任务与环境分离、收尾可恢复、Agent 用命令行、人用 Web

需求：`dev-week2-milestone3.md`；验收证据：`docs/w2m3-acceptance.md`；命令行参考：`docs/cli-reference.md`。

### Added
- **环境**（`platform/lifecycle/env.ts`）：`<端>:<设备>@<服务环境>`，状态机 offline / checking / ready / leased / recovering / unfit / quarantined / draining，原子写的记录（`platform/state/envs/`）、一环境一租约（锁 + 原子写，租约带 pid + 进程启动时间）、脏标记、环境配置项（Taplus 黑名单、USB 充电常亮：注册时同意一次）、审计（`platform/state/audit.ndjson`）。由 `platform/devices.yaml` × 账号池自动登记（`registry.ts`）。
- **任务**（`platform/lifecycle/task.ts`）：queued / waiting-env / preflight / running / finishing / recovering → done / env-unfit / failed / interrupted / cancelled / timed-out；`state/tasks/<id>/{task.json, events.ndjson, ledger.ndjson, result.json, plan.json, draft.json}`；系列 = 父任务 + 子任务 `<父>.<n>`。
- **生命周期**：任务进程 5 s 心跳、进度（阶段 / 轮 / 步 / 步骤预算）、**副作用台账先记账再执行**（进入会话、键入、发送、改设置）、取消请求在步骤边界停止后照常收尾（`runtime.ts`，执行器 `RunOptions.hooks`）；看门狗（心跳 30 s、进度 = 步骤预算 + 60 s、总时长）杀进程树（`crosscheck.ts`）；`autotest env recover <envId>` 独立进程按环境声明 + 台账恢复（清空键入过的会话输入框、收键盘、回首页、默认输入法、配置项、残留进程），可重复、可中断后重来，失败即隔离（`baseline.ts`、`recover.ts`、`android-ops.ts`）。
- **交叉检测**：平台启动 / 重新检查时核对租约持有者（进程在且心跳新鲜 → 接管；心跳超时 → 62 卡死；进程不在 → 72 服务重启 / 63 进程意外退出），扫描无租约的「运行中」记录；下线先写取消请求、≤ 60 s 后强杀、恢复或置脏、任务记 72；Ctrl+C / SIGTERM 时平台对所有占用中的环境走下线流程（`supervisor.ts`）。
- **审批策略**（`platform/approval.ts`）：被测软件内操作默认允许（`policy`）；敏感计划（操作被测软件之外、单次发送 > 50 条、系列 > 20 次）只能在 Web 同意；完全授权（Web 开关 + `platform/policy.yaml` 默认值，红色横幅）；硬约束（删除 / 撤回、允许清单外会话、锁屏 PIN）任何情况拒绝；批准绑定计划哈希、SKILL / profile / App / Issue 版本与运行次数（31 / 32 / 33）；驳回必填意见。
- **状态码**（`platform/lifecycle/status.ts`）：两位退出码、十位 = 类别，JSON 带 `status / code / exit`；错误对象 `{ status, code, message, hint, retryable, kind }`。
- **命令行**（`scripts/cli-v1.ts`）：`issue list|show`、`draft create|show`、`plan explain|approve|reject`、`env list|show|check|recover|offline`、`task run|status|wait|cancel|list`、`result show`、`help [--json]`；`--json` 时 stdout 只有一个 JSON；从不提问；平台未启动 → 54。参考文档由 `scripts/cli-ref.ts` 生成。
- **视图模型**（`platform/views.ts`）：`PlanView`（一句话目的、白话步骤、判定规则、影响清单、不确定点、模型调用点、预计耗时区间、审批类别）、`EnvView`、`TaskView`、`ResultView`；命令行文本、`--json`、Web 同源。Node 表新增中文模板 `zh` 与 `serverDependent`（`skills/teamily/node-specs.ts`）。
- **Web**（`platform/web/`）：首页（任务、Issue、环境状态条、锁屏红色提示、完全授权横幅）、环境页（基线逐项、租约、脏标记、配置项同意、重新检查 / 恢复 / 下线）、计划审核页（步骤在标定截图上标出元素、六问、同意 / 驳回）、任务页（进度、台账、时间线、取消）、结果页（结论句、依据、三个标识、证据、中断位置与环境恢复结果）；术语悬停解释。旧控制台移到 `/console`。
- **真机门脚本** `scripts/w2m3-gate.ts`：故障注入矩阵（强杀任务 / 冻结进程 / 强杀平台后重启 / adb 断连 × 五个阶段；断连原用 `adb kill-server`，2026-10-29 改为 `adb -s <手机> reconnect`：只踢开这台手机的连接，adb 服务与授权密钥不动，因为 `kill-server` 每次都让测试机掉 USB 调试授权；手机 90 秒内没回到 adb 即停止本轮，不再等人授权）、脚本化 Agent 闭环、确定性（31 / 32 / 33）、三端一致性（Playwright 读渲染后的页面）、预计耗时命中率。

### Fixed（2026-10-30，代码核对发现）
- android-web 环境的恢复 / 基线检查此前只看主机进程：改为检查手机（`baseline.ts#walkAndroidWeb`：在线、锁屏、残留进程、键盘、结束浏览器、输入法、配置项），并为它声明浏览器包名与环境配置项。
- App 版本的批准绑定此前不生效（环境从未写入版本）：每次检查 / 恢复与每次运行后记录 versionName；策略 / 完全授权的批准遇版本变化自动续批，显式批准返回 32。
- W2-3 任务路径的「计划不可执行」此前不写回草稿：与旧入口共用 `issue/drafts.ts#recordWarmupFailures`。
- 故障注入的断连改为 `adb -s <手机> reconnect`（见 `docs/w2m3-acceptance.md`）。

### Changed
- 2026-10-30：功能开发期完全授权默认开启（`platform/policy.yaml` `fullAccessDefault: true`，用户决定），开发结束时关闭。
- 控制台旧任务类型改读子进程写的结构化结果（`core/task-result.ts`，`AUTOTEST_RESULT_FILE`），平台不再正则解析日志。
- 报告首段「触发路径」用计划视图的白话步骤渲染（`leadOf` 复用 `stepText`）。
- 草稿带版本号（内容哈希变化 +1），计划 id `<Issue>/<子用例>:<端>@v<版本>`。
- `bin/autotest.ts` 未捕获异常统一退出 1（工具缺陷）；旧入口（`plan <file>` / `run` / `series` …）退出码不变。

## W2-2（2026-10-28 合并到 main）：可信结论 + 运行清单 / 预检 / 隔离 + 窄范围 MVP（2010、1903）

需求：`dev-week2-milestone2.md`；验收证据：`docs/w2m2-acceptance.md`。

### Changed（结论口径，§3）
- 结论只陈述观察到的事实：删除「未复现（疑似已修复）」「未复现（上限内未出现）」，bug 类只有「已复现」与「未复现」，详情写明「n 次有效尝试」、单轮命中率与 Wilson 95% 区间，0 命中给 3/n 上界（`executor/stats.ts`、`executor/verdict.ts`）。
- 有效尝试：判定前提成立且没有操作偏离的轮；偏离轮（输入没落下 / 不在聊天页 / 本轮消息不在屏幕上 / 改写超时）单独计数，不进判定规则；0 次有效尝试 = 执行失败。
- 报告首段三行：观察到的触发路径、出现位置、推测机制（来自契约，标注为推测），各带依据；各阶段耗时（租用、预检、启动、登录、准备、预热、循环、收尾）；运行清单摘要；隔离步骤；收尾对照。
- 新结论「环境不合格」；执行失败归类为环境 / 工具（`executor/failure.ts`，规则表 + 失败瞬间设备快照），写入 `result.json.failure`。
- 1426、1918 按用户决定只分类 + 契约（`platform/issue-overrides.yaml` 的 `precondition`）；1919、2230 删除及其草稿。
- 构造文字带运行标记：1329 / 2044 的构造消息、smoke 消息加 `{token}`（golden 已更新）。

### Added
- **运行清单** `manifest.json`（每次运行，包括环境不合格和执行失败）：git commit / 是否有未提交改动、SKILL 版本、profile 哈希、草稿哈希、模式、Issue / 子用例 / 端 / 预算 / 停止条件 / 种子、设备 / Android / HyperOS / App 版本 / 输入法 / 网络 / 电量、账号与会话名、预检各项与设置改动；也是 `trajectory.jsonl` 首条事件与报告头。
- **预检** `executor/preflight.ts`：在线、亮屏未锁（唤醒 + 无密码上滑，有密码 → 环境不合格）、充电常亮、HyperOS 文本识别对被测 App 关闭（`taplus_blacklist`）、已知系统浮层、电量 ≥ 15%、网络、App 版本、键盘；< 1 s。Web：浏览器 + 登录态。
- **隔离**：运行标记 `r` + 6 位十六进制，计划文字里的 `{token}` / `{round}`；App 冷启动；准备后清空旧草稿、收起键盘；结束时清空、收起键盘、回首页（不删除、不撤回消息）。
- **计划**：`require` 动作（轮内读一次判定前提）、`limits.maxRounds`（有效尝试上限，`--max-rounds`）、`epilogue`（循环后一次、只记录）、文字检查范围 `composer` 与 `{ message }`（本轮最新消息）。
- **MVP 模式**：`composer-rewrite`（2010：键入草稿 → 点 AI 改写 → 输入框是否仍等于原草稿）、`mention-render`（1903：@ 成员发送 → 本轮气泡是否有独立的 @ 节点；收尾对照列表预览）。元素 `chat.rewrite`；Node `teamily.tapRewrite`（等改写转圈结束，≤ 10 s）、`teamily.tapSend`、`teamily.freezeMention`（prepare-only）；`clearComposer` 在 App 上全选删除。
- **系列运行** `pnpm autotest series --issue <id> --approve <sub>:<surface> --runs N [--max-rounds N]`：`series-report.md` / `series.json`（工具可靠性、失败归类、复现、合并单轮命中率与区间、阶段耗时中位数、每次运行清单摘要）；控制台任务类型「系列运行」。
- `pnpm autotest rerender <runDir>`：旧 `result.json` 按新口径重出 `report.v2.md`。
- **Web trace**：执行失败 / 计划不可执行时保存飞行记录器最后两个块（`trace.zip`、`trace-1.zip`），报告给出链接与 `npx playwright show-trace` 命令；现场包里的 trace 也在报告列出。
- **代码门** `pnpm code-gate`（`scripts/code-gate.sh`）：typecheck + 单测（含 golden）+ 证据复核预置用例。
- Op 日志记录 Node 的自述结果（如改写用时）；`drivers` 支持 `selectAll` 键。

### Fixed
- `core/ui-tree`：uiautomator 在文字含 `"` 时用单引号写属性，原解析读成空串（改写后的输入框读不出来）。
- 准备期发送核实与「最新消息不匹配输入框」（`5aac6f1`）真机验证通过。

### 验证
- 代码门 148 s：typecheck、单测 170/170（含 golden 36 项）、证据复核 2/2；`test:web` 1/1、`test:android` 1/1。
- 预检 0.7–0.9 s；人为锁屏 3.1 s 得到「环境不合格」，零点击。坏计划门报告链接的 `trace.zip` 可用 `npx playwright show-trace` 打开。
- **2010 × 10（android-app 替代 iOS）**：工具可靠性 10/10；已复现 4/10 次运行；合并单轮 52 次有效尝试命中 25 次（48.1%，Wilson 35.1%–61.3%）；证据复核 25/25 符合。
- **1903 × 10**：工具可靠性 10/10；未复现（60 次有效尝试），单次复现概率 95% 上界 ≈ 5%；会话列表预览 10/10 有 @。
- 隔离：2010 / 1903 交替 4 次全部得出结论；smoke 四端各发送成功一次。

## [Unreleased] — W2-1：意图契约、循环外分层观察 / 定位、预热闸门、执行基座重构

需求：`dev-week2-milestone1.md`；验收证据：`docs/w2m1-acceptance.md`。

### Changed（P0 基座，行为不变，模式库 golden + 回归门验证）
- `core/ui-tree`：唯一的界面树读取（按设备加锁、轮换文件、重试、计时）；`parseNodes` 从 imui 移入。`core/model`：唯一的模型客户端（按用途计数、`extractJson`、多数投票）与按设备 / 页面缓存的 Midscene agent。
- `executor/session` + `executor/surfaces`：「租用 → 建驱动 → 启动 → 登录 → 回首页」一处实现，run / sync / replay / smoke 共用；android-web 与 Web 的特殊处理收进端适配器。
- `runPlan` 458 → 96 行：`prepare` / `phases` / `loop` / `checkpoint` / `incident-hook` / `stats` / `actions`。
- 单一来源：Node 表（`node-specs.ts`）、Surface 类型、Teamily 包名、`issuePath`；登录流程移到 `executor/login`，坐标重放移到 `executor/replay`，Issue CLI 移到 `scripts/issue-cli`（消除包级循环）；标定公共步骤 `skills/calibrate-common`；死导出删除。
- 计划模板 → `skills/teamily/patterns.ts`（含生命周期模式）。
- **确认即冻结**：草稿带内容哈希与 Issue 文件哈希；`run --issue` 复用确认过的草稿（不再调模型），执行从 `platform/plans/` 读回的计划并核对 `draftHash`；控制台传 `--draft <hash>`；`--redraft` 才重新生成。
- tsconfig 覆盖全部源码目录；logcat 离线单测移入 unit 项目；sync 默认会话（含姓名）移入私有 `platform/conversations.local.yaml`。

### Added
- **观察库 + 分层判定**（`executor/observe`）：① 确定性（logcat / pidof / `dumpsys input_method` / 无障碍文字 / Web 页面文字 / 区域）→ ② 排序插槽（空）→ ③ 视觉；新检查 `keyboard`、`text`（范围：整屏 / 引用块 / 目标附近）；报告「判定分层统计」与按用途的模型调用。键盘、App 点赞改为 ① 判定；sync 的 Web 接收端读页面文字。
- **分层定位**（`executor/locate`）：字面文字优先（无障碍 / getByText），视觉兜底；用于准备期目标、弹窗、prepare-only Node。
- **意图契约**（`platform/schema/contract.ts`、`issue/contract.ts`）：前置条件（库 `preconditions.ts`，含建立方式）、触发语义、可观察后置条件与现象、推测机制（只提示）；规则 / 模型生成，模式命中则确定性编译；`coverage` 标注；暂缓 Issue 附契约；确认单与控制台展示契约；证据复核对照契约现象。
- 模式 `quote-preview-text`（2044）；Node `teamily.quoteReply`（prepare-only）、`sendMessage` 的 `kind: markdown-link`；构造前置条件只在私有允许清单的会话。
- **预热闸门**（`executor/warmup`）：循环前逐步核验预期效果，失败 → 新结论「计划不可执行」并回写草稿。**指纹自愈**（`executor/heal`）：标定记录元素文字指纹，SKILL 失效 / 预热失败时按指纹找回（本次运行生效 + 候选 profile，不改标定文件）。
- **轨迹**（`core/trajectory`）：每次运行 `trajectory.jsonl`；`TRAJECTORY_TDAI_URL` 时转发到 TencentDB Agent Memory standalone 网关 `/v3/session/add`（网关在 `tools/tdai/`，不配 LLM key）。

### Fixed
- logcat 异常门把 `FATAL EXCEPTION: UiAutomation`（读界面树进程）记成 App 闪退。
- Web 首屏固定 8 秒等待不足（等首页参考区域）；中止的标定会覆盖参考图（改为与 profile 一起写）；uiautomator 的表情实体（`&#128077;`）未解码；引用块筛选漏掉左侧卡片；引用跳转选到链接引用；引用原文为 Markdown 链接时基线比对失败。
- desktop-web / android-web / android-app 重新标定（产品改版）。
- 引用回复：HyperOS「文本识别」浮层抢走长按时关闭浮层后原位重按（`dismissSystemOverlay`）；重试不再按返回（App 消息菜单打开时返回会退出聊天）。
- 准备期发送核实：App 发送后读输入框，文字仍在则再点一次发送，仍失败报错；「最新消息」定位不再匹配输入框（EditText）。单测覆盖，**真机未验证**（门 9 中 2044 之后 1329 s2 android-app 发送被吞）。

### 验证
- `typecheck` 通过；`test:unit` 138/138；`test:web` 1/1；`test:android` 1/1；证据复核 2/2。
- 1329 s3 15 分钟 315 轮（基线 3 倍），视觉 0；1329 s1 循环视觉 0；sync 9/9 全部 ①；2044 在 Android 替代执行**已复现**（连续 3 轮，证据复核 3/3 符合）；预热闸门与自愈各一次实跑；TDAI 收到运行记录。

## [Unreleased] — 证据复核、退出/杀进程、手机浏览器、Edge、端点池与多端同步

验收证据：`docs/m6-acceptance.md`。

### Fixed
- **1329 s2 误报**：开发期记为「已复现」的定位链接用例，录屏显示跳到的就是被引用消息（窄屏下气泡换行 + 跳转高亮，基线像素比对没对上）。README / 介绍页 / m5 验收文档已更正。
- **录屏与操作日志错位约 2 秒**：录屏分段起点改取 scrcpy 打印 `Recording started` 的时刻（原为进程启动时刻）；多段合并按各段实际时长换算（`videoTimeOf`），`ops.srt`、查看器跳转、复核取帧统一使用。
- 桌面首页有效性标记改为搜索行：左栏的未读角标随账号变化，换账号即误报「SKILL 失效」。
- SKILL 失效时保存 `skill-stale.png`，便于判断是改版还是临时遮挡。

### Added
- **证据复核**（`incident/evidence-review.ts`）：检查类命中先把出事轮与前一轮的录屏画面条 + 被判定截图交给视觉模型，对照 Issue 实际结果，3 票多数；「不符」排除不计命中，连续 3 次排除记执行失败；报告新增「证据复核排除」一节。`issue/llm.ts` 新增 `visionJson`。
- **预置用例**（`fixtures/evidence/`、`pnpm autotest evidence review|snapshot|cases`）：`1329-s2-quote-wrap`（期望不符）、`1329-s2-synthetic-old-jump`（阳性对照，期望符合）。
- **生命周期动作**：计划动作 `exitApp`、`killApp`、`reload`、`idle`；`process-alive` 检查落地；`skill smoke --lifecycle warm|cold`（App / 手机浏览器）。
- **`android-web` 执行端**：手机系统浏览器，adb 输入 + 截屏，固定标签页打开网址；`skills/calibrate-android-web.ts`（无障碍树 + 刷新重读 + 视觉定位临时元素）；键盘回车提交登录；会话恢复时经 Artifacts → 聊天 → 返回回到列表；按需光标登录（`platform/accounts/ui-login.ts`）。
- **Edge 最大化**：Windows 上 `desktop-web` 用 Edge 有头最大化窗口，标定记录实际视口与缩放；登录后的新手引导页处理（`onboarding.skip`）。
- **端点池**：`platform/device-pool.ts` 按「端点 × 执行端」分槽，本机为 `host:local` 端点，`devices.yaml` 记录手机上各端登录的账号；`AccountPool.lease` 同时租槽并只给登在手机上的账号。
- **多端同步** `pnpm autotest sync`（`executor/sync.ts`）与控制台「多端同步」任务：各端不同账号进同一群，每轮一端发送，其余端核对可见并记耗时与截图；同一手机的 App 与浏览器轮流占前台。
- `drivers/factory.ts`：执行器、重放、同步共用的驱动构造。

### 验证
- 证据复核预置用例 2/2（三次）；严格阈值复跑 1329 s2：2 次误报全部被排除。
- 生命周期：App 热 / 冷、浏览器热 / 冷均 0 命中。
- Edge 标定 14 元素 0 失败、冒烟发送成功；手机浏览器标定 7 元素 0 失败、冒烟发送成功。
- 同步：三端 3 轮 9/9（三次）；手机单机 App + 浏览器 4/4。检出产品现象：App 进后台期间收到的消息回前台 60 秒内不显示，App 自己发送后才补到且顺序错乱（手机单机 7 次中 5 次；前台对照 3 秒内正常）。
- 复查修复：发送核实（Edge 回车未发出改点发送键；App 键盘未弹出不按返回）；参考区域连续两次命中才算；手机端准备先回「聊天」tab；端点池心跳丢失不丢租用、按次释放；状态文件串行 + 原子写；同步有端未就绪不判通过；`killApp` 区分 adb 失败。
- 修复：执行器只对 Android 执行端钉 `--device`（控制台下发的 Issue 任务里，Web 子用例此前租不到本机槽）。`sync --settle S`。

### Changed
- 任务默认时限 30 → 15 分钟：`DEFAULT_LIMITS`、已保存计划与草稿、控制台任务硬上限（`TASK_HARD_MINUTES` 默认 15）、生命周期冒烟。
- `typecheck` 通过；`test:unit` 77/77；`test:web` 1/1；`test:android` 5/5。

## [Unreleased] — 控制台报告隔离

### Fixed
- 控制台 explore / monkey 任务的报告混入其它任务的产物：任务结束时报告生成器不带参数运行，取的是全局最新的探索轨迹和 `monkey_run/summary.json`（例：计算器 monkey 任务的报告里出现 10-20 对 Teamily 的探索结果，标题变成两个包名）。现在平台从任务日志读出本任务的产物路径（explore：`[explore] trace →`；monkey：新增的 `[monkey] run summary →`，即按开始时间 + 设备命名的单次汇总），用 `--only <类型> --out <报告>` 生成只含这一条路径的报告。找不到产物或生成失败时任务记为无报告，不再拿别的任务的产物顶替。
- `report/problem-report.ts` 新增 `--only explore|monkey`、`--out`；不带参数时行为不变。新增单测 3 条。

### 验证
- 计算器 monkey（seed 4242，200 事件）与 explore（2 步）经控制台排队串行执行，均 completed；两份报告分别只含路径 B / 路径 A，各自指向 `monkey_run/summary-2026-10-21T03-56-15-166Z-4f2ebdf2.json` 和本任务的轨迹。typecheck 通过，`test:unit` 31/31。

## [Unreleased] — imui：im-loadtest 的 Web / 移动端界面层移植

### Added
- `imui`（`pnpm autotest imui config|discover|login|probe|run|selftest`）：命令、参数（`--duration --rate --ramp --drain --msg-types --payload-bytes --json --env --yes-prod`）、指标口径、SLO 和退出码对齐 im-loadtest 的 imload，测量层从协议换成界面。
- 指标：`ui_echo_ms`（对应 send_ack_ms）、`ui_e2e_ms`（对应 end_to_end_ms）、按观察客户端计的投递 / 丢失；新增 imload 没有的重复气泡、乱序显示、自身气泡未出现。
- Android 客户端：读无障碍树、用 yadb 输入，全程不调模型；Web 客户端：Playwright + 保存的登录态 + MutationObserver。
- 离线自测：本机假聊天页注入延迟 / 丢失 / 重复 / 自动回复引用 / 乱序，6/6 检出。
- 控制台新增「IM 消息压测（界面层）」任务类型。
- 文档 `docs/imui.md`：逐项功能对照、实现方式、真机结果、限制。

### Fixed（真机暴露，均在 Teamily 生产账号自己的 Personal AI 会话中复现并修复）
- 中文九宫格输入法把 `adb input text` 转成拼音 → 改用 yadb；yadb 是在光标处追加，且 RN 输入框不响应退格 / Ctrl+A → 用 yadb `-keyboardClear` 清空。
- 输入框为空时，发送按钮的位置就是录音键，一次盲点开始了录音（已删除，未发送）→ 发送前必须读回输入框确认内容，发送后确认输入框已清空。
- 输入法窗口遮住了算出的发送位置（打开过剪贴板面板）→ 输入后先收键盘再点。
- 多行时输入框右上角出现"展开"图标，表情面板在输入框下方 → 发送按钮只在紧贴输入框下沿的工具栏行里找。
- 长消息发出后输入框缩回一行，旧中心点落在聊天气泡上 → 每次按当前位置聚焦。
- 观察循环和发送核验并发 dump 同一文件，读到旧快照 → 每台设备串行 dump、分文件。
- 输入框里还没发出的 token 被当成气泡（回显 121ms，低于观察分辨率）→ 排除输入框。
- 回显 16–22 秒的假象：发送流程本身约 13–20 秒，记的是注册时刻而不是按下时刻 → 改用 `onPress` 回调；修正后 p99 3.6 秒。
- 部分滚出屏幕的长气泡被算成 2 个 → 每个气泡按 TextView 计数。
- Personal AI 回复引用 token 被算成重复 → 只认以 token 开头的气泡。

## [Unreleased] — W4 平台 alpha：自然语言任务 + 控制台 + 设备池 + CI

### Added
- 自然语言测试任务 `pnpm mission "<需求>"`（`mission/`）：模型把需求转成计划（意图、目标区域、入口、场景动作、检查项、是否测帧率、建议上限），模型不可用时用关键词规划；按轮执行（冷/热启动交替 → 入口 → 场景 → 随机探索 → 检查 → 视觉异常探测 → gfxinfo 卡顿统计）；产出 `midscene_run/missions/<id>/report.md`。
- 上限机制：步数上限、时长上限、平台硬上限（`MISSION_STEP_CAP` 300 / `MISSION_MINUTES_CAP` 120）、看门狗（到时 +2 分钟强制写部分报告退出）、单条 aiAct 规划轮数 15、控制台服务端按任务硬超时杀进程树。
- 统一 CLI `pnpm autotest mission|explore|monkey|web:smoke|devices|report`（不经 shell 转发，自然语言参数在 Windows 下不被拆坏）。
- Web 控制台 `pnpm platform`（`node:http` + 单页 HTML，端口 3210）：设备、任务提交（含三个示例需求）、最近任务、实时日志、报告渲染（含问题截图）、取消。
- 设备池 `platform/devices.yaml`（`maxConcurrent`、`scheduling.strategy`）+ adb 心跳 + 占用/释放，状态落盘 `platform/state/`。
- CI `.github/workflows/ai-test.yml`：PR 跑 typecheck + 单测 + Web 冒烟；每日/手动跑固定 seed Monkey，无设备时跳过。
- 单测 18 条（explore / monkey / mission / platform）。

- Midscene 缓存（`AgentOpt.cache`）+ `--plan` 复用计划：同一计划第 1 轮入口 + 6 个场景动作 207.8 秒 → 88.7 秒（−57%）。Android 上只缓存规划，不缓存定位。
- 即时重放：动作统一走可重放的结构化操作；发现问题时导出 `replay-<n>/`（操作序列 + 3×30 秒环形录屏 + README），`pnpm autotest replay` 按序重放 N 次并判定是否复现。真机验证：运行中用 `am crash` 注入崩溃，生成含 3 段录屏的 replay 包；重放 1 次，结论"未复现 0/1"（注入崩溃本就不会复现）。

### Changed
- 全面放开测试：输入、开关、发送、编辑都允许；只保留真实付款确认和退出登录/注销账号的硬拦截。

### Fixed（真机暴露）
- aiAct 规划轮数 8 不够复合场景动作（"连续发 3-5 条消息"）→ 15。
- 检查项误报：动态描述（"快速滑动时列表持续可见"）无法从截图判断 → 规划要求状态型检查，执行器丢弃模型判定为不可截图验证的检查。
- 到达时长上限被标成"外部中止" → 标为"时长上限"。
- `bin/autotest` 在 Windows 用 shell 转发时，带引号的需求被 cmd 拆坏。

### 已知限制
- scrcpy 未安装（winget 源不可达），录屏退回手机自带 `screenrecord`。
- 运行中的计划缓存要到下次运行才能命中；每次重新规划会产生新提示词，只有 `--plan` 复用时才有加速。
- ~~并发的 explore/monkey 任务共用 `monkey_run/summary.json`、`midscene_run/problem-report.md`，控制台里的报告可能串到另一任务的汇总~~（已修复，见「控制台报告隔离」；实际不并发时也会串）。
- AI 动作慢（单步 3–160 秒），偶发问题需要较长时长上限；高频输入 + 即时重放未实现。

### 验证
- 控制台：设备列表显示真机 idle、占位模拟器 offline；提交 mission 后再提交 monkey，monkey 排队，mission 08:35:09.108 结束、monkey 08:35:09.153 开始（`maxConcurrent: 1` 串行），两个报告链接均返回 200。
- `maxConcurrent: 2` 并行：同一台小米手机用 USB（`4f2ebdf2`）+ adb over Wi‑Fi（`192.168.1.23:5555`）两个连接充当两台设备（本机无模拟器），两个 Monkey 任务 09:05:53.907 / 09:05:53.915 同时开始，09:08:58 / 09:09:01 结束，均 completed。**不是两台物理设备**。
- 基线：`test:web` 1/1；`test:android` 首次 1 条失败（未留日志）、重跑 5/5；`autotest explore` 3 步、`autotest monkey` 300 事件均正常。
- 真机发现问题：Teamily 会话列表中 Health Assistant 的最后一条消息是「WEB 交付物」富卡片，会话内渲染正常，但列表预览只显示占位符「[自定义消息]」。由「排查下消息列表的问题」任务的截图人工确认（该任务自动报出的条目是"行对齐/截断"，属误报），视觉探测随后加入"未渲染占位文本"规则。
- CI：仅 YAML 解析与结构检查，未在真实 GitHub runner / act 上执行。

## [Unreleased] — W3 通用探索 + Monkey + 问题报告

### Added
- 路径 A AI 探索（`explore/`，`pnpm explore --package <pkg>`）：`aiQuery` 识别可交互元素、状态指纹（AI 标题 + activity，退化为截图 md5 + 元素类型分布）、有界探索循环（`EXPLORE_MAX_STEPS`、`FAIL_FAST`、每状态预算 `EXPLORE_STATE_BUDGET`、`EXPLORE_FOCUS`、`EXPLORE_ENTRY`）、应用退出自动重启（最多 3 次，超出记截断）、轨迹导出 `midscene_run/explore-traces/<ts>.json`。
- 生产安全过滤：支付/账单/积分、发送、保存/确认、删除/退出、编辑/添加/创建、置顶/免打扰/更改、分享/邀请、模板/建议等标签默认不点，输入框与开关默认不碰（`EXPLORE_ALLOW_MUTATION=true` 才放开）。
- 路径 B Monkey（`monkey/`，`pnpm monkey`）：固定 seed、`monkey.log` 落盘、logcat 监控并行、`CRASH:` / `NOT RESPONDING:` 解析与 logcat 时间窗关联、多轮 `MONKEY_ROUNDS`、`monkey_run/summary.json`（seed + 可复制复现命令）。
- 统一问题报告 `pnpm report:problems` → `midscene_run/problem-report.md`；`am crash` 注入的自检崩溃会被标注为非产品缺陷。
- `vitest` 新增 `unit` project（`pnpm test:unit`，explore/monkey 纯函数单测 7 条）。

### Changed
- `core/logcat-monitor.ts`：新增可选 `extraContext`，合并写入 `context.json`（用于 `source: "ai-explore" | "monkey"`、seed、复现命令）。默认行为不变，W2 单测通过。

### Fixed（真机暴露）
- 里程碑文档里的 `--randomize-throttle 100` 写法错误：该参数无值，`100` 被当成事件数（3000 只注入 100）。改为无参开关，并在注入数不足时告警。
- `--monitor-native-crashes` 启动时扫描设备上 32 个旧 tombstone，约 3 分钟不注入事件；新增 `MONKEY_NATIVE_CRASHES=false`。
- Monkey 日志 `Sending event #N` 每 100 个才打印一次，改为同时按 `:Sending`/`:Switch` 行计数。
- 探索结果原先按截图 md5 判定 navigated（时钟/动画导致恒变），改为比较下一步 stateId。
- Teamily 首轮 25 步中 21 步困在技能库，加每状态预算后覆盖从 4 个状态提升到 9 个。

### 真机记录（Xiaomi 2211133C / Android 16，Teamily AI 生产环境，账号 aaron+test3）
- 路径 A 共 6 轮（10/25/30/20/20/25 步），状态数 4–9，**均未捕获崩溃/ANR**。
- 前期三处生产数据副作用，已人工逐项核对并还原，随后补进黑名单：Teamily Agent「免打扰」被打开（已关）；Personal AI 输入框被「Monthly review」模板填充（**未发送**，草稿已清）；Personal AI 翻译语言被改为 English（已改回简体中文）。编辑资料页性别未保存，资料未变。
- 路径 B 未对 Teamily 运行（随机点击无法避开发送/支付）；用 `com.miui.calculator` 验收：seed 12345 / 3000 事件无崩溃；seed 777 / 300 事件中 `am crash` 注入 1 次，被 logcat 捕获并与 monkey.log 第 146 行关联。

### 第四周建议
1. 探索策略：在 `explore-loop.ts` 的 `scoreElement` 加覆盖度反馈（少访问状态优先、回到入口重走），复用 `StateTracker`。
2. 安全模型：把关键词黑名单升级为「执行前 aiBoolean 问一遍：此操作会修改数据/发送/付费吗」，与现有 `isUnsafe` 串联。
3. WebView/Hybrid：在 Teamily 的技能库/成果页接 CDP 通道，复用 `page-observer` 的元素结构与 `problem-report` 出口。
4. 报告看板：把 `explore-traces` 与 `monkey_run/summary-*.json` 汇成 HTML 时间线（状态转换图 + 崩溃点）。
5. 测试账号隔离：为 Monkey 准备 Teamily 测试环境/测试账号，再对 IM 场景跑路径 B。

## [Unreleased] — W2 Android ADB

### Added
- Android ADB 设备连接与 Midscene Android Agent 集成（`fixtures/android.ts`、`core/adb.ts`；设备自动发现，`DEVICE_ID` 可选，adb 路径可通过 `MIDSCENE_ADB_PATH` 指定）
- 第一条 Android 原生流程：系统设置 →「关于手机」5 步，每步 Allure step + 设备截图（`tests/android/settings.about.spec.ts`）
- logcat 崩溃监控（FATAL EXCEPTION / ANR / beginning of crash，`core/logcat-monitor.ts`）及离线单测
- 高频循环执行与 force-stop 状态重置（`pnpm loop:android`，`LOOP_COUNT` / `APP_PACKAGE` / `FAIL_FAST` / `CRASH_AT_ITERATION`，输出 `midscene_run/loop-summary.json`）
- 崩溃现场自动保存（截图 + logcat 片段 + 迭代序号，`midscene_run/crashes/<timestamp>/`）
- 真机崩溃监控自检 `pnpm crash-check:android`；循环脚本 `FLOW=launch` 无 AI 模式
- 真机验证（Xiaomi 2211133C / Android 16）：AI 原生流程 5/5 通过、AI 循环 3 轮（含崩溃捕获）、无 AI 10 轮循环、fail-fast 均通过
- 环境侦察与最小依赖方案（`env-report.md`、`env-plan.md`，adb 通过 winget 安装）

### Changed
- `tests/web/saucedemo.login.spec.ts`：最后一条 aiAssert 改为指明「排序下拉框旁的 Products 标题」。真实模型把「page title」理解为顶部「Swag Labs」，导致误判（W1 唯一改动）。
- Android 流程第 1 步改用 aiWaitFor（冷启动首帧为空白）；第 3 步在需要时打开「全部参数与信息」（HyperOS）。
- `vitest.config.ts` 拆分为 `web` / `android` 两个 project；新增 `test:web`、`test:android`、`loop:android` 脚本。Web 用例与 fixture 未改动。
- `ref/` 加入 `.gitignore`（只读第三方参考工程，含嵌套 git 仓库）。

## W1 — Web baseline

### Added
- Midscene `PlaywrightAgent` + Vitest + Allure 最小闭环，saucedemo 5 步登录用例，`pnpm report` 生成 Allure 报告。
