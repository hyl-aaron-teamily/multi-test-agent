# multi-test-agent

AI 驱动的自动化测试脚手架：**Midscene（AI 视觉定位/断言）+ Playwright / ADB（驱动）+ Vitest（运行器）+ Allure（报告）**。

- **第一周（Web）**：用 https://www.saucedemo.com 的 5 步登录流程演示「AI 定位 + 结构化断言 + 失败可诊断」。
- **第二周（Android）**：ADB 设备发现 + Midscene Android Agent 跑系统设置「关于手机」流程、logcat 崩溃监控、高频循环与 force-stop 重置。

> 目前覆盖 Web 与 Android 原生界面；Monkey 随机压测、WebView CDP、小程序、iOS、Web 控制台为后续里程碑，尚未实现。

## 环境要求

- Node.js ≥ 18（已在 22 验证），pnpm（已在 12.4 验证）
- **Java 8+**（仅 `pnpm report` 需要：`allure-commandline` 是 Allure 2 的 Java CLI）
- 一个 OpenAI 兼容的视觉模型端点（Qwen3-VL / Doubao / Gemini / GPT 等）
- Android：**adb**（Android platform-tools）+ 一台开启 USB 调试的设备。无需 Android Studio / 完整 SDK。详见 `env-report.md`、`env-plan.md`。

## 环境变量

`cp .env.example .env` 后填写。

| 变量 | 必填 | 说明 |
|---|---|---|
| `MIDSCENE_MODEL_BASE_URL` | 是 | 模型 API 地址，如 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `MIDSCENE_MODEL_API_KEY` | 是 | API Key |
| `MIDSCENE_MODEL_NAME` | 是 | 模型名，如 `qwen3-vl-plus` |
| `MIDSCENE_MODEL_FAMILY` | 是 | 模型族，如 `qwen3-vl` / `doubao-vision` / `gemini` / `gpt-5` |
| `HEADLESS` | 否 | Web：`false` 时显示浏览器窗口 |
| `MIDSCENE_CACHE` | 否 | `true` 时复用 AI 规划/定位缓存 |
| `MIDSCENE_ADB_PATH` | 否 | Android：adb 不在 PATH 时填完整路径（winget 安装位置见 `env-plan.md`） |
| `DEVICE_ID` | 否 | Android：指定设备序列号；默认取 `adb devices` 中第一台已授权设备 |
| `APP_PACKAGE` | 否 | 循环脚本目标包名，默认 `com.android.settings` |
| `LOOP_COUNT` | 否 | 循环次数，默认 10 |
| `FAIL_FAST` | 否 | `true` 时首次捕获崩溃即停止循环 |
| `CRASH_AT_ITERATION` | 否 | 崩溃监控自检：在第 N 轮流程中执行 `adb shell am crash <pkg>` |
| `FLOW` | 否 | 循环模式：`ai`（默认，跑 AI 流程，需要模型凭据）或 `launch`（只做 force-stop + 启动 + 前台检查，无需凭据） |

缺少必要条件时用例会**失败并给出可读报错**，不会跳过或伪造 AI 步骤：
- `[waiting for credentials] Midscene model config missing: ...`
- `[no device] 未检测到已连接的 ADB 设备 ...`（或 `unauthorized`：请在设备上点击「允许 USB 调试」）
- `[adb not found] ...`

## 命令

```bash
pnpm install                              # 安装依赖（esbuild/sharp 构建脚本已在 pnpm-workspace.yaml 放行）
pnpm exec playwright install chromium     # 下载浏览器（Web）
pnpm test                                 # 跑全部用例（web + android 两个 Vitest project）
pnpm test:web                             # 只跑 Web
pnpm test:android                         # 只跑 Android（含 logcat 监控离线单测）
pnpm loop:android                         # Android 高频循环，见下文
pnpm crash-check:android                  # 真机崩溃监控自检（am crash），无需模型凭据
pnpm report                               # allure generate → ./allure-report（需要 Java）
pnpm exec allure open ./allure-report     # 打开报告
pnpm typecheck                            # tsc --noEmit
pnpm test:unit                            # W3：explore/ + monkey/ 纯函数单测（无需设备/模型）
pnpm explore --package <pkg>              # W3 路径 A：AI 探索式遍历，见下文
pnpm monkey --package <pkg> --seed 12345 --events 3000   # W3 路径 B：Monkey 压测
pnpm report:problems                      # W3：合并两条路径 → midscene_run/problem-report.md
```

报告：每个业务步骤是一个 Allure step，步骤结束（成功或失败）都附截图（Web 为整页截图，Android 为 `adb exec-out screencap -p`）；失败断言标在对应 step 上。用例结束还会把 Midscene 自带的 HTML 回放报告作为附件挂到 Allure。

## Android 运行说明

### 1. 设备准备

1. 安装 adb（本机已通过 `winget install Google.PlatformTools` 安装，见 `env-plan.md`）。旧终端看不到新 PATH 时，打开新终端或在 `.env` 设置 `MIDSCENE_ADB_PATH`。
2. 手机：设置 → 关于手机 → 连点「版本号」7 次开启开发者选项 → 开发者选项中打开「USB 调试」。
3. USB 连接电脑，在手机弹窗中点击「允许 USB 调试」。
4. `adb devices -l` 应显示 `<序列号>  device ...`。显示 `unauthorized` 时请在设备屏幕上点允许后重试。

### 2. 单条原生流程

```bash
pnpm test:android
```

`tests/android/settings.about.spec.ts`：force-stop 并启动系统设置 → 断言设置首页 → 进入「关于手机」→ 等待页面 → `aiQuery` 提取设备名与 Android 版本 → 断言非空，且版本与 `getprop ro.build.version.release` 一致（确定性锚点）。设备 `udid` 记录在 Allure 参数中。

### 3. 高频循环

```bash
pnpm loop:android                                   # 10 轮
pnpm loop:android --count 50 --fail-fast            # 或 LOOP_COUNT=50 FAIL_FAST=true
APP_PACKAGE=com.example.app pnpm loop:android       # 其他 App：每轮做一次 aiAssert 前台检查
CRASH_AT_ITERATION=3 pnpm loop:android --count 5    # 第 3 轮人为触发崩溃，验证监控
FLOW=launch pnpm loop:android                       # 无 AI：只验证 force-stop/启动/崩溃捕获，无需凭据
```

每轮开头 `adb shell am force-stop <pkg>` + `monkey -p <pkg> -c android.intent.category.LAUNCHER 1`，然后跑流程。结束时打印并写入 `midscene_run/loop-summary.json`：`totalRuns`、`crashesDetected`、`failedRuns`、`firstCrashIteration`、各轮结果。退出码：有失败轮次为 1。

### 4. 崩溃产物

logcat 监控（`core/logcat-monitor.ts`）匹配 `FATAL EXCEPTION`、`ANR in`、`beginning of crash`，以 `Process: <pkg>` 判断是否属于目标 App。命中后保存：

```
midscene_run/crashes/<timestamp>/
├── screenshot.png   # 命中时的设备截图
├── logcat.txt       # 命中前 200 行 + 命中后最多 200 行 + `adb logcat -b crash -d`
└── context.json     # iteration, udid, packageName, step, timestamp, keywords, matchesPackage
```

### 5. 真机验证记录

HyperOS 适配：Android 版本不在「我的设备」页，流程会在需要时打开「全部参数与信息」再读取。
（Xiaomi 2211133C / Android 16 / udid `4f2ebdf2`）

| 项 | 命令 | 结果 |
|---|---|---|
| 设备发现、启动、截图 | `getAndroidDevice` / `launchApp` / `screencap` | ✅ 自动发现 `4f2ebdf2`，设置页 `com.android.settings/.MainSettings` 置顶，截图为有效 PNG |
| 崩溃监控 | `pnpm crash-check:android` | ✅ 捕获 `FATAL EXCEPTION: main` / `Process: com.android.settings:remote`，现场写入 `midscene_run/crashes/<timestamp>/` |
| 高频循环 | `FLOW=launch CRASH_AT_ITERATION=3 pnpm loop:android` | ✅ totalRuns 10、crashesDetected 1、failedRuns 1、firstCrashIteration 3 |
| fail-fast | `FLOW=launch CRASH_AT_ITERATION=2 pnpm loop:android --count 5 --fail-fast` | ✅ 第 2 轮捕获后停止 |
| AI 原生流程 | `pnpm test:android` | ✅ 5/5 通过（qwen3-vl-plus）：设置首页 →「我的设备」→「全部参数与信息」→ aiQuery 读出设备名与 Android 16，并与 `getprop` 一致；Allure 每步附截图 |
| AI 高频循环 | `CRASH_AT_ITERATION=2 pnpm loop:android --count 3` | ✅ 第 1、3 轮完整流程通过，第 2 轮崩溃被捕获：totalRuns 3、crashesDetected 1、failedRuns 1、firstCrashIteration 2 |
| Web 基线 | `pnpm test:web` | ✅ 通过（连续多次） |

`midscene_run/` 已 git-ignore：截图含设备上的账号信息，不入库。

## 第三周：通用探索 + Monkey + 问题报告

### 路径 A — AI 探索（`pnpm explore`）

```bash
pnpm explore --package ai.teamily.mobile --steps 30 --focus "个人资料 profile, agent 智能体"
EXPLORE_ENTRY="the user avatar at the top-left corner" pnpm explore --package ai.teamily.mobile
```

每步：确认 App 在前台（否则 force-stop + launch，最多 3 次，超出记为截断）→ `aiQuery` 列出可交互元素 → 生成状态指纹 → 选一个本状态未尝试且安全的元素 `aiTap` → 检查 logcat 监控 → 记录转换。
状态指纹优先 `activity + AI 提取的页面标题` 的 md5（`stateFingerprintSource: "ai"`），标题为空/不稳定时退化为截图 md5 前 12 位 + 元素类型分布（`"screenshot-hash"`）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `EXPLORE_MAX_STEPS` / `--steps` | 50 | 单次最大操作数 |
| `FAIL_FAST` / `--fail-fast` | false | 首个崩溃即停止 |
| `EXPLORE_FOCUS` / `--focus` | - | 优先探索的关键词（同时作为 aiQuery 上下文） |
| `EXPLORE_ENTRY` | - | 每次(重新)启动后先点的入口，自然语言描述 |
| `EXPLORE_STATE_BUDGET` | 5 | 同一状态最多操作次数，超出按 Back 离开，扩大覆盖 |
| `EXPLORE_ALLOW_MUTATION` | false | 允许操作输入框 / 开关 |
| `EXPLORE_AVOID` | - | 追加的禁点正则 |

**生产环境安全**：内置禁点表（支付/充值/套餐/账单/积分、发送、保存/提交/确认、删除/清空/退出登录、编辑/添加/创建/上传、置顶/免打扰/更改、分享/邀请、模板/建议…），输入框和开关默认不碰。被跳过的元素记在轨迹 `skippedUnsafe` 中。这是关键词启发式，不是保证：在生产账号上跑完仍应人工核对（见下方真机记录）。

产物：`midscene_run/explore-traces/<ts>.json`（步骤、状态、结果 navigated/stayed/app-exited/crash/error、崩溃）、Midscene HTML 报告（每步截图，路径写在轨迹 `midsceneReport`）、崩溃现场 `midscene_run/crashes/<ts>/`（`context.json` 的 `source: "ai-explore"`，另附 `trace.json`）。

### 路径 B — Monkey（`pnpm monkey`）

```bash
pnpm monkey --package com.miui.calculator --seed 12345 --events 3000
MONKEY_ROUNDS=3 MONKEY_EVENT_COUNT=5000 pnpm monkey --package <pkg>   # 未给 seed 时随机生成并落盘
```

命令：`adb shell monkey -p <pkg> -s <seed> --throttle 300 --randomize-throttle -vvv --ignore-crashes --ignore-timeouts --monitor-native-crashes <count>`（`--randomize-throttle` 是无参开关）。Monkey 输出写 `monkey_run/<ts>-r<n>-s<seed>/monkey.log`；logcat 监控并行，崩溃以 logcat `FATAL EXCEPTION` / `ANR in` 为准，Monkey 日志 `CRASH:` / `NOT RESPONDING:` 按时间窗（±15s）交叉验证。

| 变量 | 默认 | 说明 |
|---|---|---|
| `MONKEY_EVENT_COUNT` / `--events` | 5000 | 每轮事件数 |
| `MONKEY_ROUNDS` / `--rounds` | 1 | 轮数；给定 seed 时第 n 轮用 seed+n-1 |
| `MONKEY_SEED` / `--seed` | 随机 | 固定种子 |
| `MONKEY_THROTTLE` / `--throttle` | 300 | 事件间隔 ms |
| `FAIL_FAST` | false | 有崩溃即停后续轮次 |
| `MONKEY_NATIVE_CRASHES` | true | `false` 时去掉 `--monitor-native-crashes`。该参数启动时会逐个扫描设备上已有 tombstone，测试机（32 个旧 tombstone）上约 3 分钟不注入事件 |

汇总 `monkey_run/summary.json`：每轮 seed、注入数、`crashesDetected`、`firstCrashEventCount`、关联结果、可直接复制的 `reproduceCommand`。崩溃现场 `context.json` 的 `source: "monkey"`，附 seed 与复现命令。

> ⚠️ Monkey 随机点击无法约束，不要对生产账号的 IM / 支付类 App 运行。本周 Teamily（生产环境）只跑路径 A；路径 B 用系统计算器验收。

### 问题报告（`pnpm report:problems`）

读最新 `midscene_run/explore-traces/*.json` 和 `monkey_run/summary.json`（也可 `--trace` / `--monkey` 指定），生成 `midscene_run/problem-report.md`：概览、两条路径的问题（截图 / logcat / 轨迹片段 / seed / 复现命令 / 堆栈摘要）、未复现与待观察项。与 Allure 报告、Midscene HTML 报告并列查看。

### 真机记录（W3）

| 项目 | 命令 | 结果 |
|---|---|---|
| Teamily AI 探索 | `pnpm explore --package ai.teamily.mobile --steps 25`（focus 个人资料 + agent） | ✅ 25 步 / 9 状态 / 未捕获崩溃，覆盖智能体列表、智能体团队、Agent 设置、技能库、群信息、排行榜、聊天记录 |
| 个人资料探索 | `EXPLORE_ENTRY="the user avatar at the top-left corner of the home screen" pnpm explore ... --steps 20` | ✅ 20 步 / 7 状态 / 未捕获崩溃，覆盖个人资料、设置、编辑资料（只读）、收藏、点赞 |
| Monkey | `pnpm monkey --package com.miui.calculator --seed 12345 --events 3000` | ✅ 3000/3000 注入，未捕获崩溃 |
| Monkey 崩溃链路 | seed 777 / 300 事件 + 运行中 `am crash` | ✅ logcat 捕获，monkey.log 第 146 行交叉验证，报告标注为注入 |
| 基线 | `pnpm test:web` / `pnpm test:android` | ✅ 1/1、5/5 |

生产副作用与还原记录见 CHANGELOG「真机记录」。

## 目录结构

```
.
├── .env.example                 # 模型 + Android 配置模板
├── CHANGELOG.md
├── README.md
├── env-report.md                # W2 环境侦察结果
├── env-plan.md                  # W2 最小依赖方案 + 安装执行日志
├── package.json                 # test / test:web / test:android / loop:android / report / typecheck
├── pnpm-workspace.yaml          # pnpm 构建脚本白名单（esbuild, sharp）
├── tsconfig.json
├── vitest.config.ts             # web / android 两个 project + allure-vitest reporter
├── core/
│   ├── adb.ts                   # child_process adb 封装：路径解析、force-stop、launch、screencap、crash 缓冲
│   ├── credentials.ts           # 模型凭据检查（无 vitest 依赖，供脚本复用）
│   └── logcat-monitor.ts        # logcat 崩溃监控 + 现场保存
├── fixtures/
│   ├── page.ts                  # W1：Playwright page + PlaywrightAgent、step()+截图
│   └── android.ts               # W2：设备发现、AndroidAgent 创建
├── android/flows/
│   └── settings-about.ts        # 可复用的「关于手机」5 步流程（spec 与循环共用）
├── tests/
│   ├── web/saucedemo.login.spec.ts
│   └── android/
│       ├── settings.about.spec.ts
│       └── logcat-monitor.unit.spec.ts   # 离线单测（模拟 logcat 流）
├── explore/                     # W3 路径 A
│   ├── page-observer.ts         # aiQuery 可交互元素识别
│   ├── state-tracker.ts         # 状态指纹 + 已探索记录
│   ├── explore-loop.ts          # 有界探索循环、安全过滤、崩溃捕获
│   ├── trace.ts                 # 轨迹导出
│   └── unit.spec.ts
├── monkey/                      # W3 路径 B（不依赖 Midscene）
│   ├── runner.ts                # 单次 Monkey + logcat 并行
│   ├── log-parser.ts            # monkey.log 解析 + 与 logcat 关联
│   ├── loop.ts                  # 多轮 + summary.json
│   └── unit.spec.ts
├── report/problem-report.ts     # W3 统一问题报告
├── scripts/
│   ├── explore.ts / monkey.ts   # W3 CLI
│   ├── report.ts                # 检查 Java 后调用 allure generate
│   ├── loop-android.ts          # 高频循环
│   └── crash-check-android.ts   # 真机崩溃监控自检
└── ref/                         # 只读参考工程（git-ignored，不参与构建）
```

## 依赖说明

核心：`@midscene/web`、`@midscene/android`、`vitest`、`allure-vitest`、`allure-commandline`、`playwright`、`dotenv`。
配套：`@playwright/test`（`@midscene/web/playwright` 的运行时 peer）、`allure-js-commons`（Allure 运行时 API，版本与 `allure-vitest` 一致）、`typescript` / `tsx` / `@types/node`。
ADB 通过 `child_process` 调用，没有引入 npm adb 封装库。

## 版本管理与合并状态

- `main`：第一周基线。`feat/w2-android-adb`：第二周全部工作，子功能分支 `feat/w2-logcat-monitor` 已合回并删除。
- **合并状态：已合并。** `pnpm test:web` 通过后，`feat/w2-android-adb` 以 `--no-ff` 合并回 `main`。

## 后续路线

第三周已完成探索 + Monkey + 问题报告；第四周建议见 CHANGELOG。

## 参考工程使用清单

### 第一周

| ref 工程 | 用在哪里 | 备注 |
|---|---|---|
| `midscene-example/playwright-with-vitest-demo/` | `fixtures/page.ts`、`vitest.config.ts`、`tsconfig.json`、Web 用例组织、`.env.example` 变量名 | 主要参考。官方没有独立的 Vitest 集成导出 |
| `midscene-example/playwright-demo/` | `chromium.launch` 参数；`aiWaitFor`/`aiQuery<T>`/`aiTap`/`aiAssert` 用法 | |
| `playwright-mind/` | 「AI 操作 → aiQuery → expect → aiAssert」分工 | 其 fixture 依赖 `@playwright/test` runner，未采用 |
| 预期的 `puppeteer-with-vitest-demo/`、社区完整 DEMO、`vitest-pnpm-ts/` | **缺失** | 分别由 `playwright-with-vitest-demo/`、官方 README + 类型定义、`allure-vitest` README 替代 |

### 第二周新增

| ref / 来源 | 用在哪里 | 备注 |
|---|---|---|
| `midscene-example/android/vitest-demo/tests/todo.test.ts` | `fixtures/android.ts`：`getConnectedDevices()` → `new AndroidDevice(udid, opts)` → `new AndroidAgent` → `device.connect()` | 主要参考 |
| `midscene-example/android/vitest-demo/tests/setting.test.ts` | 选用系统设置作为被测 App、Android 超时设置 | 其中 `agentFromAdbDevice()` 未采用：需要传 `androidAdbPath` 与 report 选项，直接构造更清楚 |
| `midscene-example/android/javascript-sdk-demo/demo.ts` | `autoDismissKeyboard: false`、弹窗引导上下文、`aiWaitFor`/`aiQuery`/`aiAssert` 在 Android 上的用法、循环脚本的纯脚本形态 | |
| `@midscene/android` / `@midscene/core` `.d.ts` | `getConnectedDevices(opts)` 返回 `{udid, state}[]`；`AndroidDeviceOpt.androidAdbPath`；`aiContexts.aiAct`（`aiActionContext` 已弃用） | |
| `midscene-example/android/yaml-scripts-demo/` | 未使用 | YAML 用例不在本周范围 |
| logcat 监控 | ref/ 中无现成实现 | 关键字按里程碑文档自行实现，思路参考 kaeawc/auto-mobile `LogcatCrashDetector`（未引入依赖） |

### 第三周新增

| ref / 来源 | 用在哪里 | 备注 |
|---|---|---|
| `midscene-example/android/javascript-sdk-demo/demo.ts` | `page-observer.ts` 的 `aiQuery` 形状字符串写法；`scripts/explore.ts` 纯脚本形态 | 主要参考 |
| `@midscene/core` `agent.d.ts` | `aiQuery<T>` / `aiString` / `aiTap` / `aiInput(locate, {value})` / `reportFile` | |
| `scripts/loop-android.ts`、`core/logcat-monitor.ts`（W2） | 探索与 Monkey 的 force-stop/launch、崩溃监控 | 复用，monitor 加 `extraContext` |
| `ref/midscene-skills/skills/android-automation/` | **缺失**（`ref/` 下无 midscene-skills） | 未下载在线版；按 `.d.ts` 与可运行 demo 自行实现 observe → explore 循环，没有套用不存在的 explore API |
| Android Monkey 官方文档 | 参数语义 | 文档未写清 `--randomize-throttle` 无值，真机日志纠正 |
| Midscene「解析报告文件」 | 未用 | 报告只链接 Midscene HTML 路径，没有解析其中 JSON |
