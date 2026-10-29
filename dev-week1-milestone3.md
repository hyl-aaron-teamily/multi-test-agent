# 任务：第三周里程碑 — 指定 App 的通用探索式测试 + Monkey 压力测试 + 问题报告

## 前置状态

第二周已完成：ADB 环境就绪、Android Agent 可操作真机、logcat 崩溃监控可用、高频循环脚本可执行。`ref/` 目录仍为只读参考源。

**本周不修改**第一周 Web 端和第二周已有 Android 测试用例。所有新增代码放在 `explore/` 和 `monkey/` 模块中，崩溃产物继续复用 `midscene_run/crashes/` 的目录结构和 `core/logcat-monitor.ts`。

## 本周目标

对一个**指定的已安装 App**（通过包名指定），实现两条互补的通用测试路径，并产出统一的问题报告：

1. **路径 A — AI 探索式遍历**：打开 App，识别当前界面的可交互元素，自主选择未探索过的操作执行，记录界面状态转换，在遇到崩溃、ANR 或异常时捕获现场。
2. **路径 B — Monkey 随机压力**：调用 Android Monkey 对指定包名发送伪随机事件流，固定 seed 保证可复现，解析 Monkey 日志和 logcat 定位 CRASH / ANR。
3. **问题报告**：将两条路径发现的崩溃、ANR、断言失败（如“页面白屏”“关键控件消失”）汇总为结构化报告，包含截图、日志片段、复现 seed（Monkey）或操作轨迹（AI 探索），并可与第二周的 Allure 报告或独立 HTML 报告并列查看。

**本周不做**：WebView CDP 补充通道、小程序、Web 控制台、iOS。

## 版本管理（延续第二周纪律，新增约束）

从 `main` 切出 `feat/w3-explore-monkey`，所有增量按功能提交，**每个 Step 完成即提交**。提交信息继续使用 Conventional Commits 并标注 `ref/` 来源。

**新增约束**：

- `explore/` 和 `monkey/` 各自独立，**互不依赖**。路径 A 不引入 Monkey，路径 B 不依赖 Midscene Agent（但可以复用 `forceStopApp` / `launchApp` 等 ADB 工具函数）。
- 崩溃产物目录统一为 `midscene_run/crashes/<timestamp>/`，路径 A 和路径 B 写入相同结构的 `context.json`，仅在 `source` 字段区分 `"ai-explore"` 或 `"monkey"`。
- 第三周结束时，`pnpm test:web` 和 `pnpm test:android` 仍须通过，不破坏前两周基线。

## 本地参考工程（新增重点）

第二周已确认 `ref/midscene-example/android/` 可用。本周新增查看：

| 参考源 | 用途 |
|---|---|
| `ref/midscene-skills/skills/android-automation/`（如果已下载）或在线版本 | **AI 探索的权威参考**。查看其如何组织 `observe` → `explore` 循环、如何限制 `maxInteractions`、如何记录状态转换 |
| `ref/midscene-example/android/javascript-sdk-demo/` | `aiQuery` 提取结构化数据的写法，用于识别可交互元素 |
| Midscene 官方文档「解析报告文件」 | 从 Midscene 报告中提取 JSON 和截图，用于统一问题报告 |
| Android Monkey 参数与日志分析资料（`ref/` 中如有笔记，或在线文档） | `-s seed`、`--throttle`、`-vvv`、`--ignore-crashes` 等参数语义，以及日志中 `CRASH` / `ANR` / `NOT RESPONDING` 的关键字 |

**查证顺序不变**：`ref/` → `node_modules` 类型定义 → 在线文档。

## 路径 A — AI 探索式遍历

### 设计约束

- **以“界面状态”为探索单位，而非“步骤”**。每次 Agent 观察当前界面后，用 `aiQuery` 提取**可交互元素列表**（按钮、输入框、可点击列表项、Tab 等），然后选择一个**当前状态下尚未尝试过**的元素执行操作。
- **状态标识**：用 `aiQuery` 提取界面特征（如 Activity 名、关键文本、元素指纹）生成一个轻量状态 ID。如果 AI 无法可靠提取，退化为“截图哈希 + 可交互元素类型分布”作为状态指纹。**不要**引入额外的 CV 库或图像哈希 npm 包，用 `crypto.createHash('md5')` 对截图 buffer 做哈希即可。
- **探索深度有界**：通过环境变量 `EXPLORE_MAX_STEPS`（默认 50）控制单次探索的最大操作数，防止无限循环。每个操作后检查 logcat 监控是否捕获到崩溃；若捕获，记录当前状态和操作轨迹，按 `FAIL_FAST` 决定是否中断。
- **操作后状态恢复**：执行一个操作后，如果进入了新界面，**不要**立即回退；继续在新界面探索。如果操作导致 App 退出或进入系统桌面，用 `forceStopApp` + `launchApp` 重新拉起，并从已记录的状态轨迹中选择一个尚未完全探索的状态继续，或结束本次探索并记录“探索因应用退出而截断”。
- **不依赖预定义业务流程**。本周的探索是**通用**的：用户只提供包名，Agent 自行决定操作什么。

### 实现步骤

**Step A1 — 可交互元素识别**

在 `explore/page-observer.ts` 中实现：

```typescript
async function observeInteractiveElements(agent: AndroidAgent): Promise<InteractiveElement[]>
```

用 `aiQuery` 提取当前界面的可交互元素，返回结构化数组，每个元素至少包含：

- `type`: `"button" | "input" | "list-item" | "tab" | "switch" | "unknown"`
- `label`: 可见文本或推断语义
- `description`: 简短功能描述（用于决定是否优先探索）

参考 `ref/midscene-example/android/javascript-sdk-demo/` 中 `aiQuery` 的结构化写法，以及 `midscene-skills/android-automation` 中对可交互组件的描述方式。

**提交**：`feat(explore): add interactive element observer via aiQuery`

**Step A2 — 状态指纹与已探索记录**

在 `explore/state-tracker.ts` 中实现：

- `captureState(device, agent)`：截图 + `aiQuery` 提取界面特征 → 生成 `stateId`。
- `markExplored(stateId, elementKey)`：记录某个状态下的某个元素已被尝试。
- `hasUnexplored(stateId, elements)`：判断当前状态下是否还有未尝试的元素。
- 持久化到内存即可，**不需要**数据库；如果需要在多次运行间保留，写入 `midscene_run/explore-state.json`，但默认关闭跨运行持久化。

状态指纹的生成策略：优先用 `aiQuery` 提取“当前页面的标题或关键特征”，若结果为空或明显不稳定，退化为截图 MD5 前 12 位。两种方式在 `context.json` 中标注 `stateFingerprintSource: "ai" | "screenshot-hash"`。

**提交**：`feat(explore): add state fingerprint and explored-element tracking`

**Step A3 — 探索循环**

在 `explore/explore-loop.ts` 中实现主循环：

```
while (step < EXPLORE_MAX_STEPS && !shouldStop):
  1. 确保 App 在前台（如果不在，launchApp 并记录状态恢复）
  2. 截图 + observeInteractiveElements
  3. 计算 stateId
  4. 过滤出当前状态下未探索的元素
  5. 如果为空 → 尝试返回键 / 选择一个“导航类”元素（如 back、close、tab）以离开当前状态
  6. 选择一个未探索元素，执行 aiTap / aiInput
  7. markExplored
  8. 检查 logcat 监控是否捕获崩溃
  9. 若崩溃：保存现场（截图、logcat、操作轨迹、stateId），按 FAIL_FAST 决定是否中断
  10. step++
```

选择元素的策略：**优先选择“描述中带有导航/新页面暗示”的元素**（如“进入设置”“查看详情”），其次选择普通按钮，最后才选择可能具有破坏性的元素（如“删除”“退出登录”）。这个优先级在提示词中作为**初始策略**，如果发现探索覆盖太窄，可以调整为轮询。

**提交**：`feat(explore): add bounded AI exploration loop with crash capture`

**Step A4 — 探索轨迹导出**

每次探索结束后，将操作轨迹写入 `midscene_run/explore-traces/<timestamp>.json`，结构：

```json
{
  "package": "com.example.app",
  "source": "ai-explore",
  "startedAt": "...",
  "steps": [
    {
      "step": 1,
      "stateId": "...",
      "stateFingerprintSource": "ai",
      "element": { "type": "button", "label": "设置", "description": "进入设置页面" },
      "action": "aiTap",
      "result": "navigated | stayed | app-exited | crash"
    }
  ],
  "crashes": [ ... ],
  "truncated": false
}
```

**提交**：`feat(explore): export exploration trace for report consumption`

## 路径 B — Monkey 随机压力

### 设计约束

- **固定 seed 可复现**。每次 Monkey 运行必须显式传入 `-s <seed>`。如果未指定，生成一个随机 seed 并在运行结束后**打印和落盘**，确保崩溃可以按相同 seed 复现。
- **Monkey 日志与 logcat 分离**。Monkey 自身输出通过 `adb shell monkey ... > monkey.log 2>&1` 重定向到文件；logcat 监控继续使用第二周的 `LogcatMonitor`，两者并行运行。崩溃判定以 **logcat 中的 `FATAL EXCEPTION` / `ANR in`** 为主，Monkey 日志中的 `CRASH:` / `NOT RESPONDING:` 作为交叉验证。
- **关键参数**：
  - `-p <package>`：限定被测 App。
  - `-s <seed>`：固定随机种子。
  - `--throttle 300`：事件间隔，模拟真实操作节奏；可用 `--randomize-throttle 100` 增加扰动。
  - `-vvv`：最详细日志级别。
  - `--ignore-crashes --ignore-timeouts --monitor-native-crashes`：让 Monkey 在崩溃后继续发送事件，但 logcat 监控会捕获崩溃并记录；如果希望崩溃后立即停止以保留现场，可以用 `--kill-process-after-error` 并配合外部监控。
- **事件数有界**：通过 `MONKEY_EVENT_COUNT` 环境变量控制（默认 5000），避免单次运行时间过长。

### 实现步骤

**Step B1 — Monkey 执行封装**

在 `monkey/runner.ts` 中实现：

```typescript
async function runMonkey(options: {
  packageName: string;
  deviceId?: string;
  seed?: number;          // 未提供则生成
  eventCount?: number;    // 默认 5000
  throttle?: number;      // 默认 300
  outputDir: string;
}): Promise<MonkeyResult>
```

- 构造 `adb shell monkey` 命令，通过 `child_process.spawn` 执行。
- 将 stdout 和 stderr 写入 `outputDir/monkey.log`。
- 在 Monkey 运行期间启动 `LogcatMonitor`（复用第二周实现），崩溃时保存现场到 `midscene_run/crashes/`。
- 返回 `MonkeyResult`，包含 `seed`、`exitCode`、`crashesDetected`、`logPath`、`crashArtifactDirs`。

**提交**：`feat(monkey): add monkey runner with fixed seed and logcat correlation`

**Step B2 — Monkey 日志解析**

在 `monkey/log-parser.ts` 中实现轻量解析：

- 从 `monkey.log` 中匹配 `CRASH:`, `NOT RESPONDING:`, `// CRASH:` 等行，提取包名、异常类型和消息。
- 与 logcat 捕获的崩溃做**时间窗口对齐**（Monkey 日志行前最近的 `system_uptime` 时间戳 vs logcat 时间戳），将 Monkey 事件计数与 logcat 崩溃关联起来。
- 如果 logcat 已捕获崩溃但 Monkey 日志未标记，以 logcat 为准，并在报告中注明“Monkey 日志未标记，logcat 捕获”。

**提交**：`feat(monkey): parse monkey log and correlate with logcat crashes`

**Step B3 — Monkey 循环与 seed 记录**

在 `monkey/loop.ts` 中实现可选的多次运行：

- 环境变量 `MONKEY_ROUNDS`（默认 1）控制轮次。
- 每轮生成或传入 seed，运行结束后写入 `monkey_run/summary.json`，包含每轮的 `seed`、`crashesDetected`、`firstCrashEventCount`（如有）。
- **崩溃复现提示**：如果有崩溃，在 summary 中输出可直接复现的命令，例如：
  `adb shell monkey -p com.example.app -s 12345 --throttle 300 -vvv 5000`

**提交**：`feat(monkey): add multi-round monkey loop with seed summary`

## 问题报告（统一出口）

在 `report/problem-report.ts` 中实现，**不重新发明报告格式**，而是：

1. **复用 Midscene 原生报告**：路径 A 的 Agent 执行会产生 Midscene HTML 报告，路径 B 的 logcat 崩溃产物已有截图和 logcat。两者都是可追溯的。
2. **生成一份轻量 Markdown 汇总** `midscene_run/problem-report.md`，结构：

```markdown
# 通用测试问题报告 — <package>

## 概览
- 路径 A（AI 探索）：共 N 步，覆盖 M 个状态，发现 X 个崩溃/异常
- 路径 B（Monkey）：seed=<seed>，事件数=<count>，发现 Y 个崩溃/ANR

## 路径 A 发现的问题
### 问题 1
- 类型：崩溃 / ANR / 页面异常
- 状态 ID 与指纹来源
- 操作轨迹片段
- 截图：`midscene_run/crashes/<ts>/screenshot.png`
- logcat 片段：`.../logcat.txt`
- Midscene 报告链接（如可提取）

## 路径 B 发现的问题
### 问题 1
- 类型：CRASH / ANR
- 复现 seed：<seed>
- 复现命令：`adb shell monkey -p ... -s ...`
- Monkey 日志行号与内容
- logcat 时间窗口与崩溃堆栈摘要

## 未复现 / 待观察
- 路径 A 截断（如应用退出）的原因
- Monkey 日志中可疑但 logcat 未捕获的信号
```

3. **报告生成时机**：两条路径独立运行结束后各生成一次；如果希望合并，提供一个 `pnpm report:problems` 脚本，读取 `explore-traces/` 和 `monkey_run/` 的最新产物，合并输出。

**提交**：`feat(report): add unified problem report for explore and monkey`

## 第三周验收目标（Definition of Done）

在 `feat/w3-explore-monkey` 分支上执行：

1. `pnpm test:web` 和 `pnpm test:android` 仍通过（前两周基线未破坏）。
2. **路径 A 可执行**：`pnpm explore --package <已安装包名>` 能启动 AI 探索，输出探索轨迹 JSON，并在 Allure 或 Midscene 报告中有每一步截图。若 `EXPLORE_MAX_STEPS` 内未发现崩溃，正常结束并输出“未捕获崩溃”的明确结论。
3. **路径 B 可执行**：`pnpm monkey --package <包名> --seed 12345 --events 3000` 能运行 Monkey，生成 `monkey.log`，logcat 监控并行运行。如果 Monkey 触发崩溃，`midscene_run/crashes/` 下产生完整产物；如果没有，输出“未捕获崩溃”并保留 seed 和命令。
4. **问题报告**：`pnpm report:problems` 生成 `midscene_run/problem-report.md`，内容包含两条路径的概览和至少一条发现（如果实际有崩溃）或明确的“未发现”结论。
5. **seed 可复现**：Monkey 报告中的复现命令可以直接复制执行，且如果崩溃是由确定性业务逻辑触发的，相同 seed 应能再次触发（随机性崩溃不强制要求 100% 复现，但命令必须可追溯）。
6. `CHANGELOG.md` 更新；`git log --oneline main..feat/w3-explore-monkey` 至少有 6 条有意义的提交；合并回 `main` 后前两周基线仍通过。
7. `README.md` 更新：`pnpm explore` 和 `pnpm monkey` 的用法、环境变量（`EXPLORE_MAX_STEPS`、`MONKEY_EVENT_COUNT`、`MONKEY_ROUNDS`、`FAIL_FAST`）、问题报告位置。

## 自主工作规则（延续前两周，新增）

- **不要中途询问**。API 不确定时按 `ref/` → `.d.ts` → 在线文档查证。设备未连接或模型凭据缺失时，完成骨架和可读报错，标注阻塞，**不伪造执行结果**。
- **每个 Step 完成即提交**，提交信息标注来源。不要在探索循环或 Monkey 封装的细节上反复重构超过 2 轮；先用最简实现跑通，再在后续提交中优化。
- **唯一允许的阻塞**：无 ADB 设备、模型凭据缺失。Monkey 不依赖模型，因此即使模型凭据缺失，路径 B 仍应能独立运行并通过验收。
- **不要修改 `ref/`**。不要在探索或 Monkey 路径中 mock 掉崩溃检测或删除断言。**宁可报告“未发现”，不可伪造崩溃**。
- 如果 `midscene-skills/android-automation` 的实际结构与预期不符，以其可运行代码和类型定义为准，不要强行套用不存在的 `explore` API。

## 完成后的汇报格式

1. 验收命令逐条结果（`pnpm test:web`、`pnpm test:android`、`pnpm explore`、`pnpm monkey`、`pnpm report:problems`）。
2. `git log --oneline main..feat/w3-explore-monkey` 和 `CHANGELOG.md` 摘要。
3. 路径 A 的实际探索统计：步数、状态数、是否捕获崩溃、轨迹文件路径。
4. 路径 B 的实际 Monkey 统计：seed、事件数、是否捕获崩溃、复现命令。
5. `midscene_run/problem-report.md` 的内容示例。
6. **第三周参考使用清单**：`ref/` 和 `midscene-skills` 中哪些文件被实际使用，哪些未用上及原因。
7. 遇到的主要问题与解决方式。
8. 第四周建议（例如 WebView/Hybrid 页面探索、报告可视化看板、探索策略优化），不超过 5 条，并指出可以复用本周的哪些模块。

---

## 实现对照（2026-10-29 按代码核对）

> 本节是事后核对，以上正文保留当时的需求原文。项目当前全貌见 `PROJECT-SUMMARY.md`。
> 编号说明：本文即 **W3** 里程碑，2026-10-19 完成；文件名是 week1、正文写「第三周」，原因同 W2。

**已实现**（分支 `feat/w3-explore-monkey`，2026-10-19 经 `87c01e3` 合并到 `main`）

- 路径 A：
  - `explore/page-observer.ts#observeInteractiveElements` 用 `aiQuery` 提取可交互元素；
  - `explore/state-tracker.ts#captureState` 取 AI 标题 + 当前 Activity 作状态指纹，不稳定时退回截图 MD5 + 元素类型分布，`stateFingerprintSource` 记 `ai` / `screenshot-hash`；
  - `explore/explore-loop.ts#exploreApp` 是有界循环（`EXPLORE_MAX_STEPS` 默认 50、每状态预算 5 次、App 退出后最多重启 3 次，超出记截断）；
  - `explore/trace.ts#buildTrace` / `#writeTrace` 写 `midscene_run/explore-traces/<ts>.json`，每步结果为 `navigated / stayed / app-exited / crash / error`。
- 路径 B：
  - `monkey/runner.ts#runMonkey`：固定 seed，`monkey.log` 落盘，logcat 监控并行；
  - `monkey/log-parser.ts#parseMonkeyLog` / `#correlate` 在 ±15 秒窗口内把 Monkey 日志与 logcat 关联，以 logcat 为准；
  - `monkey/loop.ts#runMonkeyLoop`（`MONKEY_ROUNDS`，第 N 轮 seed = 初始 seed + N − 1）写 `monkey_run/summary.json`，含每轮可复制的复现命令。
- 统一报告：`report/problem-report.ts#buildProblemReport` 生成 `midscene_run/problem-report.md`，`am crash` 注入的崩溃标为自检。崩溃现场的 `context.json` 用 `source` 区分 `ai-explore` / `monkey`（`core/logcat-monitor.ts` 的 `extraContext`）。

**与正文不同 / 后来的变化**

- **安全过滤是正文之外加的**（真机上出现过生产副作用之后）：`explore/explore-loop.ts` 的 `DEFAULT_AVOID` 关键词黑名单，加上输入框和开关默认不碰（`EXPLORE_ALLOW_MUTATION` 才放开）。黑名单没有词边界，「add」「pin」「call」之类的词会误拦。
- **跨运行持久化接口未接入**：`StateTracker` 的 `load` / `save` / `hasUnexplored` 没有调用方，当前只在内存中记录已探索项。
- **崩溃计数口径不一**：`explore-loop.ts` 的 `crashedSince` 统计任何进程的崩溃，`FAIL_FAST` 会因其他进程崩溃而截断；但 `scripts/explore.ts` 的退出码只认被测包自己的崩溃。
- **`monkey/loop.ts` 可能多计**：崩溃数取「logcat 中被测包的崩溃」与「Monkey 日志信号（包名匹配或为空）」两者的较大值；`New native crash` 没有包名，可能把其他进程的崩溃也算进来。
- **ANR 归属**：被测包判定依赖 `core/logcat-monitor.ts` 的 `Process:` 行，典型的 `ANR in <包名>` 可能被当成其他进程的（见 W2 节，未在真机上复现）。
- **正文的两处 Monkey 参数说法与实际不符**，已在实现中更正：`--randomize-throttle` 是无值开关（原写法会把 100 当成事件数）；`--monitor-native-crashes` 启动时会扫旧 tombstone，可用 `MONKEY_NATIVE_CRASHES=false` 关闭。
- **路径 B 未对 Teamily 运行**（随机点击避不开发送 / 支付），验收用的是系统计算器。
- **控制台接入后的改动**：平台通过 `AUTOTEST_RESULT_FILE` 拿到本任务的产物（`core/task-result.ts#emitTaskResult`），再用 `problem-report.ts` 的 `--only` / `--out` 只生成这一条路径的报告。
