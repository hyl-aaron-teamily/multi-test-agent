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
pnpm report                               # allure generate → ./allure-report（需要 Java）
pnpm exec allure open ./allure-report     # 打开报告
pnpm typecheck                            # tsc --noEmit
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
├── scripts/
│   ├── report.ts                # 检查 Java 后调用 allure generate
│   └── loop-android.ts          # 高频循环
└── ref/                         # 只读参考工程（git-ignored，不参与构建）
```

## 依赖说明

核心：`@midscene/web`、`@midscene/android`、`vitest`、`allure-vitest`、`allure-commandline`、`playwright`、`dotenv`。
配套：`@playwright/test`（`@midscene/web/playwright` 的运行时 peer）、`allure-js-commons`（Allure 运行时 API，版本与 `allure-vitest` 一致）、`typescript` / `tsx` / `@types/node`。
ADB 通过 `child_process` 调用，没有引入 npm adb 封装库。

## 版本管理与合并状态

- `main`：第一周基线。`feat/w2-android-adb`：第二周全部工作，子功能分支 `feat/w2-logcat-monitor` 已合回并删除。
- **合并状态：`feat/w2-android-adb` 尚未合并回 `main`。** 规则要求合并前 `pnpm test:web` 全部通过；当前没有模型凭据，Web 用例停在 `[waiting for credentials]`（与第一周基线相同），因此未合并。填好 `.env` 并确认后执行：
  ```bash
  pnpm test:web && git checkout main && git merge --no-ff feat/w2-android-adb
  ```

## 后续路线

第三周：Monkey 随机压测（复用 logcat 监控与循环脚本）、WebView CDP 补充通道、轻量控制台。

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
