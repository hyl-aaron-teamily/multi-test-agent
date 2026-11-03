# 里程碑 W2-5：两档重新定位、评测模式、确定性判定、探索加固

> 前置：W2-4.1 已合并到 `main`（`5d84362`）。新前端的同事验收（H8）是 4.1 的项目验收环节，不阻塞本期开发；本期不改前端布局，只在已有页面上加入口。
> 本期重写自 2026-10-30 的 W2-5 草案（`5d84362:docs/history/dev-week2-milestone5.md`）。草案的快速档循环、只读、发现转 Issue、平台 / MCP / Web 接入已在 4.1 交付；计划档（规划者 / 检查者）按 4.1 的 K2 不做。本期做剩下的部分，并按 2026-11-03 的决定（§3）重新定位两档。

---

## 0. 现状基线（2026-11-03，`main` @ `5d84362`）

| 事实 | 依据 |
|---|---|
| 文档里的叫法：能力① = 「快速档」= 自然语言任务 / 探索（每步看屏幕、模型决策）；能力② = 「Pro 档」= Issue → 确定性计划 → 系列运行 | `docs/rules.md` M2；README |
| 探索与计划共用硬上限 3000 步 / 120 分钟；探索默认不设步数上限，每 12 步压缩历史，单次模型调用 180 s 超时 | `platform/schema/test-plan.ts#HARD_LIMITS`；`platform/api-v1.ts`（`max-steps` 3000 / `max-minutes` 120）；`docs/rules.md` M4 |
| 探索判定问题：驱动事件流的硬异常，或模型主动上报（`report_issue`）后经证据复核。没有确定性的界面判定（白屏、一直加载、错误文案、占位文字、点了没反应） | `engine/agent/run.ts`（`reviewIncident`）；`engine/agent/step.ts`（动作表） |
| 计划运行的命中：硬异常，或轮末检查不通过且证据复核认定与 Issue 描述相符；与 Issue 无关的界面问题不会被发现 | `engine/plan/loop.ts#runLoop`；`docs/rules.md` E2 |
| 探索的接口接受四端，真机只在 android-app、desktop-web 上验收过 | `platform/api-v1.ts`（`EXPLORE_SURFACES`）；`docs/rules.md` M3 |
| 探索的风险判断只用规则表 + 社交动作的本人内容判断；搜索框键入后元素标签变成已输入的文字，规则认不出，拒绝继续键入 | `engine/agent/risk.ts#classifyRisk`；`docs/backlog.md` |
| 运行中不能追加指令；取消在步边界生效 | `engine/agent/run.ts`（`shouldStop`）；`docs/backlog.md`（W2-5 X6） |
| ANR 已按被测包归属（`ANR in <包名>`，或 `am_anr` 行含包名），草案 §0 的归属问题不再存在 | `drivers/android.ts#classifyLogLine` |
| SKILL 缓存的参考图不区分浅色 / 深色主题；循环内主题切换会让区域检查失败 | `engine/checks.ts`；`docs/backlog.md` |
| android-web 上读页面文字的计划不可靠（无障碍树不跟随页面内跳转）：输入框前提（`require`）、@ 选择器冻结成员 | `docs/backlog.md`；`docs/w2m4.1-acceptance.md`「T9 续」 |
| 平台启动时先检查完全部环境（约 60 s）才监听端口，期间 CLI / MCP 返回 54；平台重启接管运行中任务只有单测 | `docs/backlog.md` |
| `ref/android_world`（`55ddaf5`）：116 题、20 个 App；自带 FastAPI 服务（出题、打分、`open_app` / `answer`），打分读 App 真实状态；要求 Pixel 6 / API 33 模拟器与 Python ≥3.11；锁定版本没有 3.12 预编译包 | `ref/android_world/README.md`、`server/android_server.py`、`requirements.txt` |
| TS 源码 15,136 行（不含测试），目标 12,000 不是硬性标准 | `docs/rules.md` M1 |

## 1. 两档重新定位（N1）

| | 能力① 快速档 | 能力② 探索档 |
|---|---|---|
| 输入 | 结构化文档：Issue Markdown（含探索转来的草稿）→ 审批过的计划 | 一句话目标，或「在某区域里找问题」 |
| 聚焦 | 重复操作、拦截问题：同一计划反复跑，命中即出现场包，给带分母的结论 | 发现新问题：用速度和 token 换覆盖与新发现 |
| 执行 | 冻结坐标，循环内动作间隔 ≤1 s，不读屏、不调视觉 | 每步看屏幕、模型决策、执行前校验，秒级 |
| 代码 | `engine/plan/`，任务类型 `issue` / `series` / `sync` | `engine/agent/`，任务类型 `explore` |
| 衔接 | 复现探索档的发现 | 发现转 Issue 草稿，交给快速档 |

- 与 4.1 的对应：本期的「能力① 快速档」就是 4.1 的「能力② Pro 档」；本期的「能力② 探索档」就是 4.1 的「能力① 快速档」。代码目录、任务类型、命令名不变，只改文字。
- 4.1 的 M2–M4 由本期 N1–N2、N5 取代。

## 2. 范围

| 阶段 | 内容 | 章节 |
|---|---|---|
| P0 | 叫法切换（N1） | §4 |
| P1 | 评测模式：用 AndroidWorld 测探索档（先做） | §5 |
| P2 | 确定性判定库，两档共用 | §6 |
| P3 | 探索档加固：上限、追加指令、SKILL 候选、风险规则修正 | §7 |
| P4 | 快速档加固：主题参考图、android-web 读文字的计划、卡顿统计 | §8 |
| P5 | 平台：先监听后检查、重启接管实测 | §9 |

执行顺序：P1 先做（代码先写，真机部分等 `docs/env-plan.md` 装好），然后 P0、P2–P5。

## 3. 已定（2026-11-03）

| # | 决定 |
|---|---|
| N1 | 能力① = 快速档：基于结构化文档的重复操作与问题拦截；能力② = 探索档：发现问题，用速度和 token 换新问题（§1） |
| N2 | 探索档硬上限 500 步 / 30 分钟，`--max-steps` / `--max-minutes` 只能收紧；每 12 步压缩历史、单次模型调用 180 s 超时不变。快速档的上限不变（D9：默认 1000 步 / 15 分钟，硬上限 3000 步 / 120 分钟） |
| N3 | 判定库做确定性的五项：白屏、一直加载、错误文案、占位文字 / Markdown 源码、点了没反应；布局问题（截断、重叠）不做。命中都要经证据复核 |
| N4 | 风险判断保持规则表 + SKILL 已知元素，不加模型兜底 |
| N5 | 探索档本期只在 android-app、desktop-web 上验收；android-web、mobile-web 接口照常接受，不验收，记入 backlog |
| N6 | SKILL 候选只产出清单，人工审核后进标定，不自动写正式 profile |
| N7 | 快速档的「结构化文档」本期 = Issue Markdown 与计划；不新增用例文档格式 |
| N8 | git 是唯一的历史：`docs/` 只留各里程碑需求文档和当期文件；验收文档、证据在里程碑结束、结论写进 CHANGELOG 后删除。4.1 的验收文件在同事验收完成后删除 |
| N9 | 评测模式只在模拟器（`emulator-*`）上运行，风险规则全部放行（含删除）；真机与生产账号一律拒绝 |
| N10 | 评测模式是独立命令，不经平台任务 / 审批 / 租约，不进 MCP / Web；结果写 `midscene_run/bench/` |
| N11 | 完成率不设达标线，如实报告；全量跑一次（116 题，估计 1.5–3 千次模型调用），用现有模型配置 |
| N12 | 评测环境按性能选型：Windows 原生模拟器 + WHPX、API 33 x86_64、`-gpu host`、Python 3.11（`docs/env-plan.md` §1） |

## 4. P0：叫法切换

- `docs/rules.md`：所有「能力①」「能力②」按 N1 互换；D1–D10 改写为「快速档」；M2–M4 标「由 N 组取代」，新增 N 组（N1–N8）并写落点。
- README、`docs/agent-rules.md`、`docs/cli-reference.md`、CHANGELOG（新一节）、PROJECT-SUMMARY：两档表格、「用哪条路」、上限说明。
- 代码里给人看的文字：MCP 工具说明与 `instructions`（`platform/mcp.ts`）、CLI 帮助（`scripts/cli-v1.ts`）、API 提示（`platform/api-v1.ts`）、报告文字（`engine/agent/run.ts`、`engine/agent/to-issue.ts`）。
- 完成判据：`rg "Pro 档|Pro tier"` 在代码与现行文档中无结果（`docs/dev-week*.md` 除外）；MCP 快照测试按新说明更新。

## 5. P1：评测模式（AndroidWorld）

目的：用公开基准 AndroidWorld（`ref/android_world`，Apache-2.0）测探索档「看懂指令、把陌生 App 操作对」的能力，给出可比的完成率。它不测发现问题，发现问题由 DoD 2、3 验收。环境见 `docs/env-plan.md`（用户手动安装）。

### 5.1 组成

| 部分 | 位置 | 做什么 |
|---|---|---|
| 评测服务（Python 3.11，I1） | `bench/androidworld/server.py` | 导入已安装的 android_world：连 `emulator-5554`（console 5554、gRPC 8554、adb 路径取环境变量 `AW_ADB`），按 `--seed`、`--combos` 建任务集；`--setup` 做首次初始化。接口：`GET /health`；`GET /tasks`（任务名、App、难度、步数预算 = int(10 × 难度)，与 AndroidWorld 的 `_allocate_step_budget` 相同）；`POST /task/init`（返回题目和步数预算）、`GET /task/score`、`POST /task/teardown`；`POST /action`（只接受 `open_app`、`answer`）。启动时若 android_env 的 adb 控制器含 `kill-server`，替换成抛错 |
| 评测会话 | `engine/session.ts#openBenchSession` | 只接受 `^emulator-\d+$` 的设备，其他一律报错；不租环境、不预检、不登录、不用 SKILL 缓存；Android 驱动不绑被测包 |
| 探索档评测选项 | `engine/agent/run.ts`（`AgentOptions.bench`） | 用评测会话；风险规则全部放行（N9）；动作表去掉 `report_issue`、`launch`，加 `open_app`（App 名）、`answer`（文字）、`home`、`enter`；`done` 照旧结束；不判异常、不写发现与现场包；步数上限 = 该题预算，时长受 30 分钟硬上限（N2） |
| 评测命令 | `scripts/bench-aw.ts`；`autotest bench aw` | 逐题：init → goal → 回桌面 → 探索档（task 模式、可写）→ score → teardown。参数：`--tasks A,B`、`--pilot`（§5.3 试跑集）、`--seed 42`、`--combos 1`、`--server http://127.0.0.1:5055`、`--budget <倍数>`、`--udid emulator-5554`、`--resume <目录>`（跳过已打分的题） |
| 产出 | `midscene_run/bench/aw-<时间>/` | 每题一个子目录（探索档的 `result.json`、`steps/` 缩略图、轨迹、分数）；`summary.json` 与 `report.md`：总完成率、按 App、按难度、每题步数 / 用时 / 模型调用、未完成题的最后一步思路 |

### 5.2 规则

- 黑盒不变：不读 App 数据库，不用 AndroidWorld 提供的 UI 元素列表与答案；分数只取 AndroidWorld 自己的 `is_successful`。
- 动作由我们的驱动执行；只有 `open_app`（用它的 App 名 → Activity 映射）和 `answer`（答案要进它的记录才能打分）经评测服务。
- 每题的 App 状态由 AndroidWorld 的 `initialize_task` 重置。
- 改进探索档只做通用改动（提示词、动作、感知），不按题写提示、不读题库；每次改动前后用同一 seed 跑试跑集对比，两次结果都写进报告。
- 不经平台任务、审批、租约，不进 MCP / Web（N10）。

### 5.3 题目

- **试跑集**（10 题，不含删除和信息检索）：ContactsAddContact、ClockStopWatchRunning、ClockTimerEntry、SystemWifiTurnOff、SystemBrightnessMax、SimpleCalendarAddOneEvent、MarkorCreateNote、ExpenseAddSingle、SimpleSmsSend、CameraTakePhoto。
- **全量**：AndroidWorld 全部 116 题 × 1 组参数，seed 42，跑一次。

## 6. P2：确定性判定库（N3）

新模块 `engine/detect.ts`，输入一次观察（截图 + 节点 + 上一次观察），输出命中项（判定名、位置、现象描述）。纯函数，单测用夹具。

| 判定 | 规则 |
|---|---|
| 白屏 | 页面区域像素方差低于阈值，且可见节点少于阈值；连续两次观察（≥5 s）都成立 |
| 一直加载 | 加载指示（ProgressBar 类节点、「加载中 / 连接中 / Loading」文字、SKILL 里标定的转圈区域）持续超过 15 s |
| 错误文案 | 节点文字匹配错误文案规则（中英文分开、带词边界：失败、出错、请重试、网络异常、Something went wrong、Error 等）；**排除会话消息区与输入框**（SKILL 的消息区域），只看提示条、弹窗、页面正文 |
| 占位文字 / Markdown 源码 | 方括号占位（如「[自定义消息]」）、未替换的模板变量（`{{x}}`、`${x}`）、`undefined` / `null` / `NaN` / `[object Object]`、渲染后的文字里出现 Markdown 标记（`**`、行首 `> `、` ``` `）；同样排除用户消息正文 |
| 点了没反应 | 执行前校验通过的点击，目标可交互，等待 3 s 后页面区域与节点都没变；同一元素连续两次才算 |

接入：

- **探索档**：每步用已取得的观察跑判定，不额外截图；命中 → 写现场包 → 证据复核（对照该判定的现象描述）→ 符合才进发现清单；同一页面同一判定去重。
- **快速档**：只在轮末检查点跑（循环内步骤不变，D2）；检查点本来不截图的轮次，每 10 轮截一次供判定用。命中记为「附带发现」，单独列在结果里，**不计入 Issue 的命中与结论**（E2 不变）；附带发现可以一键转成新的 Issue 草稿。
- 结果视图（CLI / MCP / Web 共用）加「附带发现」一节。

## 7. P3：探索档加固

1. **上限**（N2）：探索的硬上限改为 500 步 / 30 分钟（`platform/api-v1.ts` 的参数校验、`engine/agent/run.ts`）；报告照常列出步数、时长、模型调用次数。
2. **追加指令**（草案 X6）：`autotest explore inject <任务 id> "<指令>"`、MCP `explore_inject`、Web 任务页一个输入框；指令在下一步边界生效，写入轨迹并在下一次决策时交给模型；任务结束后不接受。
3. **SKILL 候选**（N6）：按探索记账的界面指纹，挑出多次出现、文字稳定的元素，写 `skill-candidates.json`（页面、含义、文字指纹、坐标框、出现次数、截图），结果页列出；`autotest explore candidates <任务 id>` 查看。不写正式 profile。
4. **风险规则修正**（N4）：键入时，若上一屏同一位置是搜索框，就继承「搜索框」的判断，不因标签变成已输入文字而拒绝。讯飞输入法吞字的问题属于测试机，不改代码。

## 8. P4：快速档加固

1. **按主题缓存参考图**：参考区域按浅色 / 深色分别缓存；检查时两张都比，任一符合即通过，并记下当前主题。准备阶段重新截取的逻辑不变。
2. **android-web 读文字的计划**：输入框前提（`require`）在准备阶段改由视觉核对（循环外，D5 允许的位置）；依赖 @ 选择器冻结成员的计划在 android-web 上标「不适用」并写明原因（报告与计划页都显示）。
3. **卡顿统计**（android-app）：运行开始前 `dumpsys gfxinfo <包名> reset`，结束后解析一次（总帧数、卡顿帧比例、百分位帧时间），写进报告；只是指标，不算命中；循环内不发命令（D2）。参考 P1 前的 `mission/runner.ts#parseGfxinfo`（`git show 3d7dc46:mission/runner.ts`）。

## 9. P5：平台

1. 平台先监听端口，环境检查放到后台；检查完成前，提交任务返回「环境检查中」而不是 54。
2. 平台重启接管运行中任务：在用户终端里 `pnpm platform` 实测一次（运行中任务 → 停平台 → 重启 → 任务被接管、结果照常写回）。

## 10. 完成标准（DoD）

1. **叫法一致**：§4 的完成判据满足；README、`docs/rules.md`、`docs/agent-rules.md`、MCP 说明对两档的描述一致。
2. **判定库**：五项判定各有阳性与阴性夹具，单测通过；真机注入：android-app `am force-stop` 之外，desktop-web 用 Playwright 断网（`context.setOffline`，网络层注入，不碰页面代码）至少触发「一直加载」或「错误文案」之一，经证据复核进入发现清单；快速档一次运行在结果里显示「附带发现」一节（为空也显示）。
3. **探索安全与时长**：生产 android-app 只读探索 3 次各 20 分钟：副作用记录里没有发送、删除、改设置、退出，也没有对他人内容的社交动作；被拦截的动作逐条可查；结束后环境回到基线。单测覆盖 500 步 / 30 分钟硬上限。
4. **自然语言任务**：3 条一句话任务（例如「打开通知铃铛看看有哪些分类」「在 Personal AI 里输入一段文字但不要发送，看看改写按钮」「浏览 Artifacts 里的第一个文档」），分布在 android-app 与 desktop-web，结论与人工观察一致。
5. **可干预**：运行中追加一条指令被采纳（轨迹可查）；取消在 1 步内生效，照常收尾与恢复环境。
6. **快速档不回退**：1903、2010（android-app）、2336（desktop-web）、1922（android-web）各跑 1 次，结论口径不变；一个带输入框前提的计划在 android-web 上走通，或明确报「不适用」及原因。
7. **评测模式**：试跑集 10 题全部跑完并打分（服务或驱动报错的题不算跑完）；全量 116 题跑完一次，`report.md` 给出完成率与分项；单测覆盖：非模拟器设备被拒、评测模式风险全放行而普通模式不变、`open_app` / `answer` 动作解析、汇总计算。
8. **工程与文档**：代码门全绿；CHANGELOG 新一节；`docs/rules.md` 的 N 组带落点；`docs/w2m5-acceptance.md` 记录验收，按 N8 在本期结束后删除。

## 11. 子任务

| # | 子任务 | 依赖 | 完成判据 |
|---|---|---|---|
| T0 | 开分支 `feat/w2m5` | — | 分支就绪 |
| T1 | 评测会话、评测动作、风险放行（§5.1 第 2–3 行）+ 单测 | T0 | DoD 7 的单测部分 |
| T2 | 评测服务（§5.1 第 1 行）+ 评测命令与汇总（第 4–5 行） | T1 | 汇总与 resume 单测；服务接口与 AndroidWorld 源码一致 |
| T3 | 环境就绪后：kill-server 检查、首次初始化、装读树服务（`docs/env-plan.md` 第 13–15 步） | 用户完成 env-plan 第 1–12 步 | `/health` 正常；`adb devices` 里手机仍在 |
| T4 | 试跑集 → 通用改进（如有）→ 全量 | T2、T3 | DoD 7 |
| T5 | 叫法切换（§4） | T0 | DoD 1 |
| T6 | 判定库与夹具（§6 表） | T0 | 五项各有阳性 / 阴性单测 |
| T7 | 判定库接入探索档 + 证据复核 | T6 | desktop-web 断网注入命中并经复核 |
| T8 | 判定库接入快速档检查点 + 附带发现视图 | T6 | DoD 2 的「附带发现」部分；1903 × 1 口径不变 |
| T9 | 探索上限、追加指令（§7 第 1–2 条） | T5 | DoD 5；上限单测 |
| T10 | SKILL 候选、风险规则修正（§7 第 3–4 条） | T7 | 候选清单出现在结果页；搜索框键入用例单测 |
| T11 | 快速档加固（§8） | T5 | 主题切换单测；android-web 带前提的计划走通或报不适用；报告有卡顿指标 |
| T12 | 平台（§9） | T0 | 启动后立即可提交；接管实测记录 |
| T13 | 真机验收：DoD 3、4、6 | T7–T12 | DoD 3、4、6 |
| T14 | 文档与 DoD 总验收 | T1–T13 | DoD 1–8 |

## 12. 工作规则

- 继承 `docs/rules.md`；硬约束 G3（不删除 / 撤回消息、不出允许清单、不动锁屏 PIN、凭据不落盘）；社交动作只在 agent 账号自己的内容上；功能开发期完全授权默认开启。
- 每次改动后跑代码门（I8）；真机门在阶段结束时跑；同一项修复后连续两次不达标即停下报告（I6）。
- 范围外的问题记进 `docs/backlog.md`；阻塞验收的当场修。
- 每个阶段合并前列出 §10 各条的满足情况；合并到 `main` 需用户同意（I10）。
- 不执行 `adb kill-server`；不代输锁屏 PIN；调试运行改写了已提交的计划、草稿或任务记录时恢复为已提交版本。

## 13. 风险

| 风险 | 应对 |
|---|---|
| 错误文案、占位文字误报（用户消息里本来就有「失败」「[xx]」） | 排除消息区与输入框；所有命中经证据复核；阴性夹具覆盖消息里的这类文字 |
| 探索 30 分钟上限不够深入 | 报告写明停止原因与覆盖；需要更深时分区域多跑几次 |
| 快速档检查点额外截图拖慢运行 | 每 10 轮一次，只在轮末；报告记录额外截图次数与耗时 |
| android_env 在 Windows 原生跑不起来 | `docs/env-plan.md` §3 的 WSL2 回退：Python 在 WSL2，复用 Windows 上同一个 adb 服务 |
| AndroidWorld 的 adb 控制器执行 `kill-server`，断掉手机 | T3 先查源码；评测服务启动时把它替换成抛错 |
| 全量评测的模型费用 | 先跑试跑集看每题平均调用次数，再按 N11 跑全量；报告列出调用次数 |
| 叫法互换让旧记录难读 | CHANGELOG 新一节开头写对应关系；`docs/dev-week2-milestone4.1.md` 保持原文 |
