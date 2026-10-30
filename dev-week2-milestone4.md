# 里程碑 W2-4（草案第一版）：感知层增强（参考 Artemis）+ 原生 MCP 服务

> 前置：W2-3 在 `feat/w2m3-usability`，**尚未合并到 `main`**；W2-4 从合并后的 `main` 开分支（合并需用户同意）。
> 参考来源：`ref/artemis`（Google，Apache-2.0，只读）。本期**借鉴思路、用 TypeScript 重写**，不引入 Python，不复制其代码；如需复用其二进制或代码，单独确认许可与来源标注。
> 本期两件事：① 让「看界面」更快、更准，并在循环外的点击前加一道校验；② 把现有平台作为标准 MCP 服务接入 IDE。**不改变 Issue 主线的循环原则**（循环每步只按坐标、不读界面、不调视觉）。
> 标 **【待确认 Gn】** 的位置依赖文末 §11 的回答，正文按推荐默认值书写。

---

## 0. 现状基线（读代码核实，2026-10-30）

| 事实 | 依据 |
|---|---|
| Android 读界面树只有一种方式：每次 `uiautomator dump` 写文件再 `cat`，按设备串行，实测 2.5–3.7 s / 次；所以只在循环外读 | `core/ui-tree.ts#readUiXml` / `#dumpTree`；`docs/w2m2-acceptance.md`（每次约 2.5–3 s，2010 每轮读 2 次） |
| 2010 一轮约 35–40 s，其中两次读树约 5–7 s、等服务端改写 4.5–8 s；单次运行循环阶段中位数 242 s | `docs/w2m2-acceptance.md`（阶段耗时中位数） |
| 手机浏览器的无障碍树只在页面加载时建立，页面内跳转后不更新 | `skills/calibrate-android-web.ts`（标定前点浏览器刷新）、`executor/observe.ts#observeText` |
| 分层定位：① 字面文字（无障碍 / Playwright getByText，精确再子串）→ ② 排序插槽（**空实现**）→ ③ Midscene 视觉定位 | `executor/locate.ts#locate`、`executor/observe.ts#noRanker` |
| 没有 OCR；Teamily 的发送键、各处铃铛等图标按钮没有文字，① 层对它们无效 | `package.json`（无 OCR 依赖）；`dev-week2-milestone1.md` §1.1 |
| 循环外的点击**执行前不核验目标**：准备期定位到的点直接点下去。曾出现视觉猜错、点到输入框工具条图标、打开会议纪要面板的事故，后改为 App 上只认无障碍文字 | `skills/teamily/nodes.ts` 中 `quoteReply` 的注释 |
| 环境诊断分散：预检、环境基线、`adb devices`、模型配置各查各的，没有一处汇总「能不能跑、缺什么、下一步做什么」 | `executor/preflight.ts`、`platform/lifecycle/baseline.ts`、`platform/adb-devices.ts` |
| Agent 接口已是工具式设计：`help --json` 给出全部命令、参数类型与状态码表；统一 JSON 信封；长任务异步（提交 → 等待 / 状态 / 取消 → 结果）；命令行是 `/api/v1` 的薄客户端 | `scripts/cli-v1.ts#COMMANDS` / `#helpDoc`、`platform/api-v1.ts#apiV1` |
| 没有 MCP 依赖、传输层与工具注册；报告、截图、现场包只是本地文件 | `package.json`；`midscene_run/` |
| 敏感计划、完全授权、环境配置项只能在 Web 上同意（命令行不能），是流程约束而非安全边界 | `platform/api-v1.ts`（`x-autotest-client: web`）、`platform/approval.ts#approve` |
| W2-1 决定「本期不做手机端常驻无障碍服务（需要装辅助 APK）」 | `dev-week2-milestone1.md` §12 |

## 1. 参考：Artemis 的做法（读 `ref/artemis` 核实）

| 能力 | Artemis 的实现 | 对我们的意义 |
|---|---|---|
| 设备端读树 | 自带无障碍服务 APK（Accessibility Helper）：在手机回环地址 `127.0.0.1:18888` 起 HTTP / JSON-RPC 服务，主机经 `adb forward` 访问；除 `/ping` 外都要主机经 `am broadcast` 下发的会话令牌；首次使用时安装并写 `secure enabled_accessibility_services` 启用；不占用 UiAutomation；失效时退回 UIAutomator2 并在报告注明 | 读树从「每次起进程导出文件」变成「常驻服务即时返回」，是我们最大耗时的直接解法；代价是在被测手机上装 APK、改安全设置 |
| 屏幕快照 | 每轮先等界面稳定（约 0.3 s，上一步不改画面则跳过），截图与界面树同时取；节点规范化为文字 / 描述、资源 id、类型、可交互属性、边界、中心，过滤零面积与无意义节点 | 统一的快照结构，供定位、校验、判定共用 |
| OCR 融合 | Google Cloud Vision OCR：裁掉状态栏 → 识别 → 坐标映射回原图 → 按行聚合并与界面树融合 | 补齐无文字节点；但会把截图发到外部服务 |
| 屏幕索引 | 精确匹配、模糊文字搜索（编辑距离类）、坐标命中测试 | 可直接填我们空着的 ② 层 |
| 执行前校验（Safety Net） | 单个动作执行前：**界面树优先**——按资源 id 0.5、文字 0.4、边界 0.3、坐标 0.3 加权核对目标仍在、小幅漂移就地修正坐标，失败分类为「偏移 / 被遮挡 / 消失」；没有索引信息或树校验不通过时**像素兜底**——视觉模型对照决策时的参考帧与当前帧判断红点处的目标是否还在；被拦截即记「执行事件」，交下一轮处理；多动作连发不校验（应对一闪而过的控件） | 我们循环外的点击正缺这一道 |
| 环境自诊断 | `mobile_diagnose` / `artemis doctor`：给出 ready / degraded / blocked 结论与按依赖排序的下一步（能自动执行的命令 vs 只能由人做的事），可选自愈（重建 adb 密钥、安全时重启 adb、清理残留锁） | Agent「先诊断再猜」的入口 |
| MCP | FastMCP，stdio / sse；5 个工具：`mobile_run_task`、`mobile_manage_task`、`mobile_get_device_state`、`mobile_inspect_trace`、`mobile_diagnose`；任务在后台进程跑，完成后多通道通知（桌面通知、文件日志、webhook、自定义命令）；一键把服务配置与测试行为准则写入各 IDE 的用户级配置 | 接入方式与准则文件可直接借鉴 |

## 2. 决定（推荐默认值，【待确认】）

| # | 问题 | 推荐默认 |
|---|---|---|
| G1 | 是否在测试手机上安装设备端读树服务（改变 W2-1 的「不装辅助 APK」） | **【待确认 G1】**推荐：做成可插拔后端，默认仍用 uiautomator；新增「常驻服务」后端，**自建**一个最小无障碍服务（只读：导出界面树与截图，不做手势），源码在本仓库、可审计；安装与启用作为**环境配置项**（注册环境时人在 Web 同意一次，`env recover` 可卸载 / 关闭）。备选：直接复用 Artemis 的预编译 APK（省构建，但二进制来自第三方、权限包括手势注入） |
| G2 | OCR 用什么 | **【待确认 G2】**推荐：本期**不接外部 OCR**（生产截图不出本机 / 已配置的模型端点）；无文字的图标继续靠标定坐标 + 视觉兜底；OCR 只留接口，下期按需要选本地 OCR 或外部服务 |
| G3 | 执行前校验用在哪 | 只用在**循环外**的点击：准备期目标、prepare-only Node、偏离后的重进、自愈后的首次点击、标定自检；循环每步不校验（保持 ≤ 1 s、0 视觉） |
| G4 | 读树变快后，是否放宽「循环不读界面」 | **【待确认 G4】**推荐：不放宽每步；只把每轮检查点与轮内前提的读树切到新后端（它们本来就在循环外计时）。若新后端 p95 ≤ 300 ms，下期再评估「每轮多读一次」 |
| G5 | MCP 的形态 | stdio 传输；作为 `/api/v1` 的薄客户端（与命令行同源，不另起业务逻辑）；平台未启动时返回 54 与启动命令，不自动拉起【待确认 G5】 |
| G6 | 审批在 MCP 中怎么处理 | 保持「敏感计划、完全授权、环境配置项只能在 Web 同意」；工具返回 30 与审核页链接，IDE 里的 Agent 不能自批 |
| G7 | 是否提供「一键写入 IDE 配置与准则」 | **【待确认 G7】**推荐：只提供 `autotest mcp --print-config <客户端>` 打印配置与准则路径，由人粘贴；不自动改用户目录下的 IDE 配置 |

## 3. 原则（继承 W2-3，本期新增）

- 继承：黑盒（不读源码、不注入页面代码、不连手机浏览器调试端口）；循环每步只按坐标；确定性优先、视觉兜底；结论只陈述事实；先记账再执行；凭据不落盘、不进日志。
- **K1 一个快照，多处使用**：截图 + 节点 + 来源（哪个后端）+ 耗时 组成一次「屏幕快照」，定位、执行前校验、判定、标定、诊断共用同一结构，不再各自读树。
- **K2 校验在前，行动在后**：循环外的每次点击，先核对目标仍在原处；核对不过就不点，记一个「执行事件」并说明是偏移、遮挡还是消失。
- **K3 后端可替换、退化可见**：读树后端失效时自动退回 uiautomator，报告与轨迹写明「本次用了哪个后端、为什么退回」。
- **K4 MCP 只是另一种呈现**：MCP 工具的结果与命令行 `--json` 来自同一份信封与视图模型，数字与结论句一致。

## 4. P0：感知层

### 4.1 读树后端（可插拔）
- 接口：`readTree(udid) → { nodes, xml?, backend, ms }`；实现 A = 现有 uiautomator 导出；实现 B = 设备端常驻服务（按 G1）。
- 实现 B 的设备端：一个只读无障碍服务，回环地址监听，令牌由主机经 adb 下发（只有 adb shell 用户能发），提供「导出界面树」「健康检查」两个接口；主机经 `adb forward` 访问，转发端口按设备记录、复用、退出时清理。
- 选择与退化：环境声明里写明后端；服务未安装 / 未启用 / 不响应 → 退回 A，计数并写入报告。安装、启用、卸载都通过环境配置项进行（§2 G1），预检只检查不安装。
- 与 uiautomator 的冲突：常驻服务不占用 UiAutomation；仍需导出时（A）按设备串行，不并发。

### 4.2 屏幕快照与屏幕索引
- `snapshot()`：等界面稳定（两帧像素差小于阈值，或上一步不改画面时跳过）→ 截图与读树并发 → 节点规范化（文字 / 描述 / 资源 id / 类型 / 可点击等交互属性 / 边界 / 中心）→ 过滤零面积与不可见节点。
- 屏幕索引：精确匹配、子串、模糊相似度（编辑距离类，阈值可配）、坐标命中测试（取覆盖某点的最小可交互节点）。
- 填 ② 层：用屏幕索引的模糊匹配作为 `Ranker`，纯确定性，不引入嵌入模型（W2-1 D2 的插槽）。
- Web 端：同一结构由 Playwright 只读定位器生成（role / name / 文字 / 边界），不 `evaluate`。

### 4.3 执行前校验（循环外）
- 树校验：对计划中的元素 / 冻结目标 / 准备期定位结果，按「资源 id、文字、边界、坐标」加权比对当前快照中的候选；小幅漂移（阈值可配）就地修正坐标并记录；否则分类为偏移 / 被遮挡 / 消失。
- 像素兜底：目标没有可比对的节点信息（图标、自绘控件），或树校验不通过时，把决策时的参考帧与当前帧（标出点击点）交给视觉模型判断「目标是否仍在该点」，只返回是 / 否与把握度；视觉不可用时按「不确定」处理并记录。
- 结果：通过 → 点击；不通过 → 不点，记「执行事件」（类别、两帧截图、比对分数），由调用方决定重找或报失败；全部写入轨迹与报告「执行前校验」一节（通过 / 修正 / 拦截次数）。
- 接入点：准备期目标冻结前后、`quoteReply` / `freezeMention` 等 prepare-only Node、偏离后的重进、自愈后的首次点击、标定自检；**循环不接入**。

### 4.4 环境自诊断
- 新命令 `autotest doctor [--fix] [--probe]`（也是 MCP 工具）：汇总 Node / 依赖、平台服务、模型配置（只报有无，不回显）、adb 与设备授权、读树后端状态、录屏工具链、各环境状态与占用；结论 ready / degraded / blocked；按依赖顺序给出下一步：「可执行」（单条本地、无破坏命令）与「需人工」（解锁、点允许 USB 调试、插线）分开写。
- `--fix` 只做安全自愈：清理残留锁、残留转发端口、崩溃任务留下的租约（经交叉检测）；**不重启 adb 服务**（`adb kill-server` 会让测试机掉 USB 调试授权，已禁用，见 W2-3 验收记录），也不做任何设备侧改动。
- `--probe`：截图 + 读树一次端到端检查，报告两种后端各自耗时。

## 5. P1：原生 MCP 服务

### 5.1 服务与传输
- `autotest mcp`（stdio）：基于官方 TypeScript SDK；启动时读 `/api/v1`，平台未启动 → 所有工具返回 54 与启动命令（G5）。
- 工具即 `help --json` 的命令表映射（名称、参数 JSON Schema 自动生成），另加感知与诊断类工具：

| 工具 | 来源 | 只读 | 说明 |
|---|---|---|---|
| `issue_list` / `issue_show` | `issue list|show` | 是 | |
| `draft_create` / `draft_show` | `draft create|show` | 否 / 是 | create 可能调模型 |
| `plan_explain` | `plan explain` | 是 | 返回 PlanView 与哈希 |
| `plan_approve` / `plan_reject` | `plan approve|reject` | 否 | 敏感计划返回 30 + 审核页链接 |
| `task_run` / `task_cancel` | `task run|cancel` | 否 | run 立即返回任务 id |
| `task_status` / `task_wait` | `task status|wait` | 是 | wait 单次最多 25 s，超时返回 21，由调用方再等 |
| `result_show` | `result show` | 是 | ResultView |
| `env_list` / `env_show` / `env_check` | `env …` | 是 / 是 / 否 | recover / offline 不暴露给 MCP【待确认】 |
| `device_snapshot` | 新 | 是 | 当前屏幕截图 + 规范化节点（§4.2），只读，不点击 |
| `doctor` | 新（§4.4） | 是（`fix` 时否） | |

- 工具注解标明只读 / 有副作用；错误把信封里的 `status / code / hint / retryable` 放进结构化结果，并标记为工具错误。

### 5.2 资源
- 暴露为 MCP 资源：任务报告（report.md）、结果视图、计划视图、证据截图、现场包查看器入口；路径只限 `midscene_run/` 与 `skills/teamily/refs/` 内（沿用 `/files`、`/refs` 的路径校验）。

### 5.3 完成通知（可选）
- 任务结束时写 `platform/state/notifications.ndjson`；可选桌面通知（Windows 系统通知），默认关闭。

### 5.4 测试行为准则（给 IDE 里的 Agent）
- 新文件 `docs/agent-rules.md`，要点：
  1. 先诊断再猜：工具报错、设备找不到、任务被拒，先调 `doctor`，按其「下一步」处理；需人工的事原样转告用户。
  2. 用哪条路：有 Issue → 草稿 / 计划 / 任务主线；要找未知问题 → 探索模块（W2-5）；不要用探索代替复现。
  3. 先说明再执行：`task_run` 前先 `plan_explain`，把发几条消息、发到哪、预计多久告诉用户；不得替用户同意敏感计划。
  4. 结论口径：「未复现」带分母，不等于「已修复」；替代执行不代表原端；环境不合格 / 工具失败不是产品结论。
  5. 设备：一台手机同一时间一个任务；多设备时先问用户选哪台；手机锁屏只能请用户解锁；不得执行 `adb kill-server`。
  6. 凭据永不经过对话；改配置后重启 MCP 服务再诊断。
  7. 不改标定文件与计划文件；需要改 → 告诉用户重新标定 / 重新生成草稿。
- `autotest mcp --print-config claude|cursor|codex|vscode` 打印配置片段与准则文件路径（G7）。

## 6. 子任务拆分（goal mode 执行顺序）

| # | 子任务 | 依赖 | 完成判据 |
|---|---|---|---|
| T0 | 合并 W2-3（需用户同意）；开分支 `feat/w2m4-perception-mcp`；回答 §11 | — | 分支建好；G1–G7 定稿 |
| T1 | 读树后端接口 + 现有 uiautomator 实现迁入（行为不变） | T0 | 代码门全绿；读树调用点只经接口 |
| T2 | 设备端常驻服务（G1）：服务本体、令牌、主机转发、安装 / 启用 / 卸载作为环境配置项、健康检查、退化 | T1 | 真机上两种后端都能导出同一屏，节点集合一致率 ≥ 95%（按文字 + 边界比对） |
| T3 | 屏幕快照 + 屏幕索引 + ② 层模糊匹配 + Web 同构快照 | T1 | 单测：精确 / 模糊 / 命中测试；`locate` 分层统计出现 ② 层 |
| T4 | 执行前校验（树 + 像素）与「执行事件」，接入 §4.3 列出的循环外点击 | T3 | 单测：偏移修正 / 遮挡 / 消失三类；真机注入（profile 副本里把目标偏移 200 px）被拦截或修正 |
| T5 | `autotest doctor`（--fix / --probe） | T2 | 锁屏、未授权、无模型配置、平台未启动四种情况各给出正确的结论与下一步 |
| T6 | MCP 服务：工具映射、Schema、注解、错误映射、资源 | T5 | 用 MCP Inspector 列出工具并逐个调用；信封与 `--json` 逐字段一致（自动比对） |
| T7 | 准则文件 + `--print-config` | T6 | 文档与工具表一致 |
| T8 | 真机门：§7 | T1–T7 | §7 |
| T9 | 文档：README、CHANGELOG、`docs/w2m4-acceptance.md`、PROJECT-SUMMARY、本文「实现对照」 | 全部 | 文档与代码一致 |

## 7. 验收标准

1. **读树提速**：在 4f2ebdf2 上对会话列表、聊天页各 50 次：常驻服务后端 p50 / p95 记录在案，目标 p95 ≤ 500 ms（uiautomator 基线 2.5–3.7 s）；与 uiautomator 的节点一致率 ≥ 95%。
2. **不回退**：代码门全绿；2010、1903 各 3 次运行结论口径与 W2-2 一致；2010 每轮耗时下降（记录，不设硬门槛）。
3. **退化可见**：人为停用常驻服务后，运行照常完成，报告写明「退回 uiautomator」及原因。
4. **执行前校验**：注入的目标偏移被修正或拦截（不点错）；准备期目标冻结、prepare-only Node 的每次点击都有校验记录；循环中校验次数 = 0。
5. **诊断**：§6 T5 的四种情况结论与下一步正确；`--fix` 不触碰设备授权。
6. **MCP 闭环**：在 Claude Code 中只通过 MCP 工具完成 2010：`draft_create` → `plan_explain` → `task_run` → `task_wait`（多次）→ `result_show`；敏感计划返回 30 与链接；平台未启动返回 54。
7. **一致性**：同一任务的 MCP 结果、命令行 `--json`、Web 结果页的结论句、有效尝试、命中数、区间一致。

## 8. 硬约束与自主工作规则

- 继承 W2-3 §9 全部硬约束。循环每步：不读界面、不调视觉、不做执行前校验。
- 设备端服务只读：不注入手势、不读剪贴板、不向外发数据；令牌校验必须开启；安装、启用、卸载只经环境配置项（人同意一次）。
- 不把生产截图发往未配置的外部服务（G2）。
- 不执行 `adb kill-server`；诊断的自愈只做本机侧、无破坏的操作。
- `ref/` 只读；借鉴 Artemis 的部分在代码注释与 CHANGELOG 注明来源（Apache-2.0）。
- 每个子任务：单测 + typecheck + 相关真机验证后提交；合并到 `main` 需用户同意。

## 9. 风险

| 风险 | 缓解 |
|---|---|
| HyperOS / Android 16 对侧载应用限制「受限设置」，命令行写安全设置被拒 | 退回人工在「设置 > 无障碍」开启（诊断给出指引）；仍不行就保持 uiautomator 后端 |
| 无障碍服务被系统回收或省电策略杀掉 | 健康检查 + 自动退化；诊断提示加入电池白名单（需人工） |
| 常驻服务导出的节点与 uiautomator 不一致，影响既有判定（如 2010 读输入框、1903 读气泡） | 一致率验收；切换前用两后端对同屏比对；判定逻辑先在两后端上跑单测夹具 |
| 像素兜底调用视觉，准备期变慢 | 只在树校验无法判断时触发；计数进报告 |
| MCP 客户端差异（工具数量上限、Schema 支持程度） | 工具数控制在 20 以内；Schema 只用基础类型；在至少两种客户端实测 |
| Agent 绕过 Web 审批 | 工具层不提供同意敏感计划 / 完全授权 / 配置项同意；准则明确禁止 |

## 10. 本期不做

- OCR 实际接入（只留接口，G2）；目标检测；自绘界面专项。
- 每步读界面、循环内执行前校验（G4）。
- MCP 的 HTTP / SSE 传输与鉴权；多人使用；自动写入 IDE 用户配置（G7）。
- 探索测试模块（W2-5）；iOS。

## 11. 待确认问题

1. **G1**：是否接受在测试手机上安装自建的只读无障碍服务（作为环境配置项，人同意一次，可卸载）？还是坚持 W2-1 的不装 APK，只做 §4.2–4.4？若接受，自建还是复用 Artemis 预编译 APK？
2. **G2**：OCR 本期不接，是否同意？如果要接，生产截图能否发往外部 OCR 服务？
3. **G4**：读树变快后，循环原则是否保持不变（推荐保持）？
4. **G5 / G7**：平台未启动时 MCP 是否自动拉起平台？是否需要一键写入 IDE 配置？
5. MCP 是否暴露 `env recover` / `env offline`（推荐不暴露，只读 + 提交类工具）？
6. 编号：本文暂按 W2-4，若放到第三周请告知改名。

## 实现对照（2026-10-30 按代码核对）

§11 已答（用户 2026-10-30）：G1 自建只读 APK、允许下载 SDK；G2–G7 与「不暴露 recover / offline」按推荐默认；编号保持 W2-4。W2-3 已于实施前合并（`7ef7425`），分支 `feat/w2m4-perception-mcp`。验收记录：`docs/w2m4-acceptance.md`。

- **T1 读树后端** `core/tree-backend.ts#readTree`（`ui-tree.ts#readUiXml` 改为经它读）；`#setTreeBackend` 按设备选择，失败退回并计入 `treeStats`；报告「读树后端」由 `executor/run.ts` 写入 `stats.treeBackend`、`issue/report.ts` 渲染。
- **T2 设备端服务** 源码 `android/a11y-service/`（`TreeService` / `Dumper` / `TokenReceiver`，`build.sh`、`fetch-sdk.sh`）；主机侧 `core/a11y-service.ts`；设备声明 `device-pool.ts#declaredTreeBackend`（`devices.yaml` `treeBackend`，环境变量 `AUTOTEST_TREE_BACKEND` 覆盖）；配置项 `android-ops.ts#androidConfigItems`（`optional: true`），基线 `baseline.ts#configWalk`（可选项未生效 = 降级）；会话选择 `executor/session.ts#selectTreeBackend`。
- **T3 快照与索引** `core/screen-index.ts`（`normalizeNodes`、`search`、`hitTest`、`related`、`similarity`）、`executor/snapshot.ts#snapshot`；② 层 `executor/observe.ts#fuzzyRanker`、`executor/locate.ts#rankText`；`parseNodes` 增加 `rid` 与层级 `id / anc`。
- **T4 执行前校验** `executor/pretap.ts`（`treeVerdict`、`PreTapGuard`、`PreTapBlocked`）；挂在 `incident/recording-driver.ts#beforeTap`；接入 `run.ts`（enter / prepare、定位与自愈指纹）、`prepare.ts#freeze` / `#runSetup`（被拦截时重挑会话行一次）、`isolation.ts#recoverAfterDrift`（re-entry）、`skills/calibrate-android.ts` 自检。
- **T5 诊断** `platform/doctor.ts`（`gatherFacts` / `diagnose` / `fixStale`），命令 `scripts/cli-v1.ts#doctorLocal`。
- **T6 MCP** `platform/mcp.ts`、`scripts/mcp.ts`、`scripts/mcp-check.ts`；§5.3 通知 `platform/lifecycle/notify.ts`（`task.ts#moveTask` 终态时写）。
- **T7 准则** `docs/agent-rules.md`，`--print-config` 在 `scripts/mcp.ts#printConfig`。

**与正文不同 / 未完成**

- **§4.1 令牌校验的权限**：接收器用 `WRITE_SECURE_SETTINGS` 保护（与 Artemis 相同；只有 adb shell / 系统持有），不是正文写的「只有 adb shell 用户能发」之外的其他机制。
- **§4.2 稳定等待**：两帧（相隔 300 ms）像素差 < 0.3% 即稳定，最长 1.5 s（执行前校验用 0.9 s）；「上一步不改画面时跳过」由调用方传 `skipStable`（② 层定位时跳过）。
- **§4.3 接入点**：「准备期目标冻结前后」实现为冻结时记指纹、准备期点击该点前校验；prepare-only Node（`quoteReply` 的长按 / 点菜单项、`freezeMention`）经同一定位入口记指纹，在准备期点击时校验；`freezeMention` 冻结的点只在循环里点，因此不校验（循环不接入）。像素兜底的「执行事件」截图存 `<runDir>/pretap/`。
- **§4.4 `--fix` 的租约**：只在平台未运行时释放死任务的租约（平台运行时由其看门狗负责），释放后环境进入「恢复中」，由平台启动时的交叉检测恢复设备侧。
- **§5.1 工具注解**：`doctor` 标为非只读（`fix` 会改本机状态）；`task_wait` 单次等待上限 25 s 由工具层强制。
- **§5.2 资源**：报告按任务 id（`autotest://reports/{taskId}`），证据文件按相对路径（`autotest://files/{path}`）；现场包查看器入口即 `files` 下的 `viewer.html`。
- **§7.1 / §7.3（部分）未完成**：本机无 Android SDK，下载被权限拦截；需人运行 `sh android/a11y-service/fetch-sdk.sh` 后构建、安装、计时、比对一致率、人为停用演练。
- **§7.6 在 Claude Code 界面内的闭环**：用 MCP stdio 客户端脚本（`scripts/w2m4-mcp-e2e.ts`）完成；接入 Claude Code 需要人执行 `--print-config claude` 打印的命令（G7：不代写用户配置）。
