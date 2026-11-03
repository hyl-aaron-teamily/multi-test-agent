# 任务：第二周里程碑 — Android ADB 接入 + 闪退监控 + 高频循环 + 版本管理

## 前置状态

第一周已完成：Web 端 Midscene + Vitest + Allure 闭环跑通，`ref/` 下已有官方示例和社区参考工程。**第二周不修改 Web 端已有产出**，所有新增代码放在独立的 `android/` 模块和共享的 `core/` 模块中。

## 本周目标

将执行能力从 Web 扩展到 **Android 原生界面**，实现：

1. **ADB 设备连接 + Midscene Android Agent 跑通一条原生业务流程。**
2. **logcat 崩溃监控**：在执行过程中实时捕获 `FATAL EXCEPTION` 和 `ANR`，保存现场（截图 + logcat 片段 + 迭代上下文）。
3. **高频循环执行**：对同一流程执行 N 次，每次循环前 force-stop 重置应用状态，验证崩溃能否在多次迭代中暴露。
4. **版本管理**：整个第二周的开发过程必须以 Git 分支 + 提交记录的方式推进，最终交付可追溯的提交历史。

**本周不做**：Monkey 随机压测、WebView CDP 补充通道、Web 控制台、小程序、iOS。

## 版本管理（贯穿全周的强制纪律）

### 分支策略

采用简化的 Git Flow，只保留三条分支线：

| 分支 | 用途 | 生命周期 |
|---|---|---|
| `main` | 始终可运行、第一周 Web 测试全部通过的稳定基线 | 永久，**禁止直接 push** |
| `feat/w2-android-adb` | 第二周所有新功能开发 | 本周结束时合并回 `main` |
| `feat/w2-<子功能>`（按需） | 当某个子任务（如 logcat 监控）需要独立试验时，从 `feat/w2-android-adb` 切出 | 完成后合回 `feat/w2-android-adb` 并删除 |

**强制规则**：

- 开工第一步从 `main` 切出 `feat/w2-android-adb`。
- 任何**可运行的最小增量**完成后立即提交，**禁止一次性堆积大量改动再提交**。建议的提交粒度：依赖安装 + 类型定义 → ADB 连接跑通 → 第一条原生流程 → logcat 监控接入 → 循环控制 → 崩溃现场保存。
- 每个提交使用 Conventional Commits 前缀：`feat:`、`fix:`、`chore:`、`docs:`、`test:`。
- 在 `feat/w2-android-adb` 上完成全部验收后，合并回 `main`，**合并前必须确认 `pnpm test:web` 仍然全部通过**（不破坏第一周基线）。

### 必须维护的变更记录

在仓库根目录维护 `CHANGELOG.md`，第二周结束时包含：

```markdown
## [Unreleased] — W2 Android ADB

### Added
- Android ADB 设备连接与 Midscene Android Agent 集成
- logcat 崩溃监控（FATAL EXCEPTION / ANR）
- 高频循环执行与 force-stop 状态重置
- 崩溃现场自动保存（截图 + logcat 片段 + 迭代序号）

### Changed
- （如有）
```

### Git 提交中必须包含的来源标注

延续第一周的要求，任何参考了 `ref/` 中代码或文档的模块，在提交信息正文中标注来源，例如：

```
feat: add android agent wrapper

ref: midscene-example/android/vitest-demo — agentFromAdbDevice 初始化方式
ref: @midscene/android .d.ts — AndroidAgent 构造函数签名
```

## 本地参考工程（延续第一周，新增 Android 相关重点）

`ref/` 目录已在第一周下载完成。第二周新增重点查看：

| 参考工程 | 重点目录/文件 | 本周用途 |
|---|---|---|
| **midscene-example 官方 Android 示例** | `ref/midscene-example/android/vitest-demo/` | **首选**。Vitest 集成 Android 的官方组织方式，`agentFromAdbDevice()` 和 `AndroidAgent` 的用法 |
| 同上 | `ref/midscene-example/android/javascript-sdk-demo/` | 纯 SDK 脚本方式，不经过 Vitest，适合理解 Agent 的原始 API |
| **Midscene Android API 参考** | 在线文档或 `node_modules/@midscene/android` 的 `.d.ts` | `AndroidDevice` 构造函数、`getConnectedDevices()`、`agent.aiQuery`/`aiAssert`/`aiWaitFor` 在 Android 上的可用性 |
| **第一周社区 DEMO** | `ref/` 中已有的 Playwright + Midscene + Vitest + Allure 工程 | 复用 `vitest.config.ts` 的 reporter 配置、Allure 步骤包裹方式，不要重新发明 |

**查证顺序不变**：`ref/` 可运行代码 → `node_modules` 类型定义 → 官方在线文档。任何 Midscene API 调用必须能找到依据。

## 技术栈与硬约束

- 新增依赖：`@midscene/android`。**不引入** Python、Appium、uiautomator2、Puppeteer。
- **不修改** Web 端已有测试和配置。Android 测试放在 `tests/android/`，Vitest 配置通过 `include` 或独立 project 区分 Web 和 Android，确保 `pnpm test:web` 仍只跑 Web 用例。
- ADB 通过 `child_process` 调用，不额外引入 npm 的 adb 封装库，保持依赖精简。
- 环境变量沿用第一周配置，模型相关变量不变。ADB 设备通过 `getConnectedDevices()` 自动发现，**不硬编码设备序列号**；若多设备连接，取第一台并在报告中记录 `udid`。

## 第二周验收目标（Definition of Done）

在 `feat/w2-android-adb` 分支上执行，全部满足：

1. `pnpm test:web` 仍然退出码 0，第一周基线未被破坏。
2. `pnpm test:android` 能发现并执行 Android 用例。若设备未连接或模型凭据缺失，给出**可读的明确报错**（如“未检测到已连接的 ADB 设备”或“缺少 MIDSCENE_MODEL_API_KEY”），而不是静默跳过或抛出未处理异常。
3. 在**至少一台已连接的 Android 设备**上，跑通一条 3–5 步的原生业务流程（可选任意已安装的 App，或系统设置/浏览器），每一步有截图，Allure 或 Midscene 报告中可查看。
4. **崩溃监控可验证**：提供一种可触发崩溃的方式（例如在循环脚本中加入一个 `adb shell am force-stop` 后立即通过 `aiAction` 操作一个不存在的界面，或使用测试 App 的已知崩溃入口），确认 logcat 监控能捕获 `FATAL EXCEPTION` 并保存现场文件到 `midscene_run/crashes/<timestamp>/`，包含：
   - `screenshot.png`
   - `logcat.txt`（崩溃前后各 200 行或完整的 `-b crash` 缓冲区）
   - `context.json`（迭代序号、设备 udid、当前步骤描述、时间戳）
5. **高频循环可执行**：循环脚本支持通过环境变量或 CLI 参数指定迭代次数（默认 10），每轮开始时执行 `adb shell am force-stop <package>` 并重新启动应用，循环结束后输出简单统计（总轮次、崩溃捕获次数、失败轮次）。
6. `CHANGELOG.md` 包含第二周条目；`git log --oneline` 至少 5 条有意义的提交；`feat/w2-android-adb` 已合并回 `main`（或在 README 中说明合并状态）。
7. `README.md` 更新：新增 Android 运行说明（设备准备、`pnpm test:android`、循环参数、崩溃产物位置），以及「第二周新增参考工程使用清单」。

## 技术路线（按顺序执行，每步完成即提交）

以下是可直接追加到第二周提示词中的**环境引导增量模块**。设计目标是让 agent 在接触任何 Android 代码之前，先完成一次自包含的环境侦察与自适应安装，而不是假定环境已就绪或盲目安装 Android Studio。

---

## 增量模块：环境自主识别与最小化配置（插入在第二周 Step 1 之前）

### 设计原则

- **最小依赖**：只安装让 `adb devices` 和 `@midscene/android` 能工作所必需的东西。**禁止**安装 Android Studio、完整 SDK、模拟器或 Gradle，除非在侦察后发现 adb 无法通过独立方式获取。
- **自适应而非固定步骤**：agent 先识别操作系统、包管理器、现有工具链，再**自己生成安装方案**，而不是执行预设命令。
- **先侦察，后决策，再执行**：三个独立阶段，每阶段产出可检查的中间结果。
- **可降级**：如果某个安装路径需要 sudo/管理员权限或网络受限，agent 应记录并切换到备选方案，而不是卡住。

### Step 0 — 环境侦察（只读，不修改系统）

在开始任何安装之前，agent 必须执行以下探测，并将结果写入 `env-report.md`：

**0.1 操作系统与架构**

```bash
uname -a                    # Linux/macOS
# 或 PowerShell: $PSVersionTable.OS; [System.Environment]::OSVersion
```

记录：操作系统类型、版本、CPU 架构（x86_64 / arm64）。

**0.2 包管理器与权限**

| 操作系统 | 探测命令 | 记录内容 |
|---|---|---|
| Linux | `which apt dnf pacman apk 2>/dev/null` | 可用的包管理器 |
| macOS | `which brew` | Homebrew 是否可用 |
| Windows | `where winget choco scoop 2>nul` | 可用的包管理器 |
| 通用 | `sudo -n true 2>/dev/null; echo $?` | 是否可无密码 sudo |

**0.3 adb 现状**

```bash
which adb || where adb
adb version 2>&1
adb devices -l 2>&1
```

记录：adb 是否已在 PATH 中、版本、已连接设备列表及授权状态。

**0.4 现有 Android 工具链痕迹（只读探测，不触发安装）**

```bash
echo $ANDROID_HOME
ls ~/Library/Android/sdk/platform-tools/adb 2>/dev/null   # macOS 常见路径
ls ~/Android/Sdk/platform-tools/adb 2>/dev/null           # Linux 常见路径
ls %LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe 2>/dev/null  # Windows
```

**0.5 设备端状态（如果 adb 已存在且有设备连接）**

```bash
adb shell getprop ro.build.version.release   # Android 版本
adb shell getprop ro.product.cpu.abi         # 设备架构
```

**0.6 Node.js 与项目依赖**

```bash
node --version
pnpm --version 2>/dev/null || npm --version
```

### Step 0.5 — 环境决策（生成方案，不执行）

基于 `env-report.md`，agent 必须**自己编写一份环境配置方案**写入 `env-plan.md`，包含：

**A. 最小依赖判定表**

| 依赖 | 是否必需 | 判定依据 | 如果缺失，安装方式（按优先级列出） |
|---|---|---|---|
| **adb** | 必需 | `@midscene/android` 通过 adb 通信 | 见下方「adb 安装决策树」 |
| **`ANDROID_HOME`** | 非必需 | Midscene 的 `AndroidDevice` 构造函数支持 `androidAdbPath` 参数，可显式指定 adb 路径而不依赖环境变量 | 如果 adb 已加入 PATH，可跳过；否则在 `.env` 中设置 `MIDSCENE_ADB_PATH` 或在代码中传入 `androidAdbPath` |
| **`@midscene/android`** | 必需 | npm 包 | `pnpm add -D @midscene/android` |
| **Android Studio / 完整 SDK** | 非必需 | adb 可独立获取 | **不安装**，除非侦察发现独立安装路径全部不可用 |
| **设备端 USB 调试** | 必需 | 设备侧设置 | 无法由 agent 代劳，在 README 中给出开启步骤 |

**B. adb 安装决策树（agent 根据侦察结果自行选择路径）**

```
adb 已在 PATH 中？
├── 是 → 验证 adb version 和 adb devices，完成。
└── 否 →
    ├── 系统包管理器可用（apt/dnf/pacman/brew/winget/choco/scoop）？
    │   ├── 是 → 优先用系统包管理器安装 platform-tools 或 adb：
    │   │         Linux:   apt install adb  /  dnf install android-tools
    │   │         macOS:   brew install --cask android-platform-tools
    │   │         Windows: winget install Google.PlatformTools
    │   │                  或 choco install adb
    │   └── 否 → 下载独立 platform-tools 压缩包：
    │             https://developer.android.com/studio/releases/platform-tools
    │             解压到项目本地目录（如 ./tools/platform-tools/），
    │             将 adb 加入 PATH 或在代码中通过 androidAdbPath 指定。
    └── 如果以上全部失败（权限/网络限制）→
         记录阻塞原因，完成骨架和可读报错，停止并汇报。
```

**关键取舍**：优先选择**系统包管理器**，因为它通常体积最小、无需手动解压和维护；其次选择**独立 platform-tools 压缩包**，解压即用，体积约 10–15 MB，不依赖 Android Studio。**绝不**把 Android Studio 作为 adb 的获取途径，除非用户显式要求。

**C. 项目集成方式**

根据 adb 的最终位置，决定 `fixtures/android.ts` 中 `AndroidDevice` 的构造方式：

- adb 在 PATH 中 → `new AndroidDevice(udid)` 即可。
- adb 不在 PATH 中但在已知路径 → `new AndroidDevice(udid, { androidAdbPath: '/path/to/adb' })`。`AndroidDevice` 构造函数明确支持 `androidAdbPath` 参数。
- 远程 adb → 使用 `remoteAdbHost` / `remoteAdbPort`。

### Step 0.7 — 执行与验证（写入系统前先确认）

agent 按 `env-plan.md` 执行安装，但必须遵守：

1. **每执行一条可能修改系统的命令前，在 `env-plan.md` 中标注**，并记录命令原文。这样用户事后可以审计“agent 到底改了什么”。
2. **安装完成后立即验证**：

```bash
adb version
adb devices -l
```

3. **如果 `adb devices` 显示 `unauthorized`**，说明设备端尚未信任此电脑。agent 无法代劳点击“允许 USB 调试”，必须在 README 和 `env-plan.md` 中明确写出：“请在设备屏幕上点击允许 USB 调试授权，然后重新运行 `adb devices`”。**不要**尝试绕过授权（如 `adb kill-server` 反复重试）来“解决”问题。
4. **如果 `adb devices` 为空**，记录“未检测到设备”，完成后续代码骨架，在汇报中标注为阻塞项。

### Step 0.8 — 环境变更纳入版本管理

环境配置本身也是可审计的交付物。要求：

- `env-report.md` 和 `env-plan.md` 在完成侦察和决策后**立即提交**：

```
chore(env): add environment reconnaissance and minimal dependency plan

ref: midscenejs.com/zh/platforms/android.md — adb 安装与 ANDROID_HOME 说明
ref: @midscene/android .d.ts — AndroidDevice.androidAdbPath 参数
```

- 实际安装命令的执行记录（命令 + 结果）追加到 `env-plan.md` 的“执行日志”章节，作为下一次提交的一部分：

```
chore(env): install adb via [package manager] and verify device connection
```

- 如果 adb 是通过独立压缩包安装在项目本地，将 `tools/platform-tools/` 加入 `.gitignore`，但在 `env-plan.md` 中记录下载 URL 和解压路径，确保可复现。

### 与第二周原有 Step 的衔接

环境模块完成后，**回到第二周 Step 1**（分支与依赖）。此时 `@midscene/android` 的安装和 adb 的可用性已经就绪，Step 1 中的“阅读 API 签名”可以直接在真实 adb 环境下验证，而不是仅靠类型定义推测。

**新增验收标准（追加到第二周 DoD）**：

8. `env-report.md` 和 `env-plan.md` 存在于仓库根目录，内容完整，包含探测结果、依赖判定表和实际执行的安装命令。
9. `adb devices -l` 在 `env-plan.md` 的执行日志中有记录，且能证明 agent 在安装后实际运行了该验证命令（无论成功或显示未授权/无设备）。
10. 如果 adb 不在 PATH 中，`fixtures/android.ts` 中通过 `androidAdbPath` 或环境变量显式指定路径，而不是硬编码假设 adb 可用。

**Step 1 — 分支与依赖**

从 `main` 切出 `feat/w2-android-adb`。安装 `@midscene/android`。阅读 `ref/midscene-example/android/vitest-demo/` 和 `@midscene/android` 的类型定义，确认以下 API 的实际签名：

- `getConnectedDevices()` 的返回值结构
- `new AndroidDevice(udid, opts?)` 的构造参数
- `new AndroidAgent(page, opts?)` 与 `agentFromAdbDevice()` 的差异
- Android 侧是否支持 `aiQuery`、`aiAssert`、`aiWaitFor`（参考文档显示 `aiAct` 是主 API，但 `aiQuery`/`aiAssert` 在 SDK 示例中存在，需以类型定义为准）

**提交 1**：`chore: add @midscene/android dependency and android branch scaffold`

**Step 2 — ADB 设备发现与 Agent 封装**

创建 `fixtures/android.ts`，封装：

- `getAndroidDevice()`：调用 `getConnectedDevices()`，无设备时抛出可读错误。
- `createAndroidAgent(deviceId?)`：返回 `AndroidAgent` 实例，并在 Agent 初始化时配置 `aiActionContext`（例如“如果出现权限弹窗，点击同意”），减少视觉模型被系统弹窗干扰。
- 工具函数 `forceStopApp(packageName)` 和 `launchApp(packageName/activity)`，基于 `child_process` 调用 `adb shell am force-stop` 和 `adb shell monkey -p <pkg> 1`（或 `am start`，以设备实际情况为准）。

参考 `ref/midscene-example/android/vitest-demo/` 中的组织方式，但**不要直接拷贝**；保持与第一周 `fixtures/page.ts` 对称的结构。

**提交 2**：`feat: add android device discovery and agent fixture`

**Step 3 — 第一条 Android 原生流程**

在 `tests/android/` 下编写一个 spec，用 `createAndroidAgent` 跑通一条 3–5 步流程。建议选择设备上已存在的系统 App（如设置或浏览器），避免依赖特定业务 App 的安装包。流程示例：

1. `aiAction` 打开设置应用。
2. `aiAssert` 断言出现“设置”标题或搜索框。
3. `aiAction` 进入“关于手机”或类似页面。
4. `aiQuery` 提取某个结构化信息（如设备名称或 Android 版本）。
5. `aiAssert` 断言提取结果非空。

每一步用 Allure `step` 包裹并附截图，写法参考第一周 Web 用例。**先不接 logcat 监控**，确认 Agent 本身能在 Android 上稳定工作。

**提交 3**：`feat: add first android native flow test`

**Step 4 — logcat 崩溃监控**

创建 `core/logcat-monitor.ts`，实现：

- `startLogcatMonitor(packageName?, outputDir)`：通过 `child_process.spawn('adb', ['logcat', '-v', 'time', ...])` 启动子进程。
- 流式读取 stdout，按行匹配崩溃信号。**必须覆盖的关键字**（大小写敏感或做标准化处理）：
  - `FATAL EXCEPTION`
  - `ANR in`
  - `beginning of crash`
  - `Process: <packageName>`（作为辅助上下文）
- 命中时：
  1. 调用 `adb exec-out screencap -p` 保存截图；
  2. 将最近的 logcat 缓冲区（命中行前后各 200 行，或直接保存 `adb logcat -b crash -d` 的输出）写入 `logcat.txt`；
  3. 写入 `context.json`（含迭代序号、设备、时间戳、命中的关键字）；
  4. 触发一个可注入的回调（`onCrash`），让测试层决定是否中断循环。
- `stopLogcatMonitor()`：结束子进程，确保不泄漏。

参考方向：`ref` 中没有现成的 logcat 监控实现时，按上述关键字自行实现。`FATAL EXCEPTION` 和 `ANR` 是社区项目中验证过的核心检测信号（可参考 `kaeawc/auto-mobile` 的 `LogcatCrashDetector` 设计思路，但不需要引入其依赖）。

**提交 4**：`feat: add logcat crash monitor with artifact capture`

**Step 5 — 高频循环 + force-stop 重置**

创建 `tests/android/stability.loop.spec.ts`（或独立的 `scripts/loop-android.ts`，取决于 Vitest 是否适合做长循环；建议**用独立脚本**避免阻塞测试报告）：

- 读取环境变量 `LOOP_COUNT`（默认 10）、`APP_PACKAGE`、`DEVICE_ID`（可选）。
- 每轮：
  1. `forceStopApp(pkg)`；
  2. 启动应用；
  3. 执行 Step 3 中定义的业务流程（提取为可复用的 `runFlow(agent)` 函数）；
  4. 检查 `logcatMonitor` 是否捕获到崩溃，若捕获则记录轮次并可选继续或中断（由 `FAIL_FAST` 控制）。
- 循环结束后输出 JSON 摘要到 `midscene_run/loop-summary.json`，并打印到控制台：`totalRuns`、`crashesDetected`、`failedRuns`、`firstCrashIteration`（如有）。

关键设计：**force-stop 在每轮开头执行**，保证每轮从干净状态开始。`launchApp` 的实现参考 `ref` 或直接使用 `adb shell monkey -p <pkg> -c android.intent.category.LAUNCHER 1`。不引入额外的 ADB 封装库。

**提交 5**：`feat: add high-frequency stability loop with crash detection`

**Step 6 — 报告、README、合并**

- 确认 Android 用例的 Allure 报告可生成、可打开；崩溃产物路径在报告中可追溯。
- 更新 `README.md`：Android 环境准备、`pnpm test:android`、循环脚本用法、崩溃产物结构、第二周参考清单。
- 更新 `CHANGELOG.md`。
- 确认 `pnpm test:web` 仍通过后，将 `feat/w2-android-adb` 合并回 `main`（`--no-ff`），删除已合并的子功能分支。

**提交 6**：`docs: update README and CHANGELOG for W2 android milestone`

## 自主工作规则（延续第一周，新增）

- **不要中途询问**。API 不确定时按 `ref/` → `.d.ts` → 在线文档顺序查证。设备未连接时，完成骨架和可读报错，在汇报中标注阻塞，**不要伪造设备操作**。
- **每完成一个 Step 立即提交**，不要等全部写完再一次性提交。提交信息必须包含来源标注（如参考了 `ref/` 的哪个文件）。
- 遇到非设备/凭据类错误，自行修复并重试，最多 3 轮。
- **唯一允许的阻塞**：无 ADB 设备连接、模型凭据缺失。此时完成骨架 + README + 可读报错，停止并汇报。
- **不要修改 `ref/`**。不要在 Android 测试中 mock 掉 `aiAction`/`aiAssert` 或删除断言。宁可失败，不可造假。
- 如果 `@midscene/android` 的 API 与第一周 Web 端的 `PlaywrightAgent` 存在签名差异（例如 Android 侧只有 `agent` 没有 `page`），以 `ref/midscene-example/android/vitest-demo/` 和类型定义为准确认，不要假设两个平台的 Agent 完全一致。

## 完成后的汇报格式

1. 验收命令逐条执行结果（`pnpm test:web`、`pnpm test:android`、循环脚本的实际输出）。
2. `git log --oneline main..feat/w2-android-adb`（或合并后的等价记录），确认提交粒度符合要求。
3. `CHANGELOG.md` 和 `README.md` 的最终内容摘要。
4. **第二周参考工程使用清单**：`ref/` 中哪些 Android 相关文件被实际使用，哪些未用上及原因。
5. 崩溃监控的实际验证结果：是否成功捕获一次崩溃、产物文件列表、`context.json` 内容示例。
6. 遇到的主要问题与解决方式。
7. 第三周（Monkey 随机压测 / WebView CDP 补充通道 / 轻量控制台）的建议，不超过 5 条，并指出哪些基础设施可以直接复用本周的 `logcat-monitor` 和循环脚本。

---

## 实现对照（2026-10-29 按代码核对）

> 本节是事后核对，以上正文保留当时的需求原文。项目当前全貌见 `PROJECT-SUMMARY.md`。
> 编号说明：本文即 **W2** 里程碑。文件名是 week1，是因为 W1–W4 都在开发第一周（2026-10-19 — 10-20）完成；正文里的「第二周」指里程碑序号。

**已实现**（分支 `feat/w2-android-adb`，2026-10-19 经 `1c33a57` 合并到 `main`）

- 设备与 Agent：`fixtures/android.ts#getAndroidDevice`（取 `DEVICE_ID` 或第一台已授权设备，无设备时报可读错误）、`#createAndroidAgent`（同时检查凭据与设备，带弹窗处理的 `aiActionContext`，可选缓存）；`core/adb.ts#resolveAdbPath` 支持 `MIDSCENE_ADB_PATH`，`#forceStopApp` / `#launchApp`（`monkey -p <pkg> -c LAUNCHER 1`）。
- 原生流程：`tests/android/settings.about.spec.ts` 调 `android/flows/settings-about.ts#runSettingsAboutFlow`（系统设置 →「关于手机」，5 步，每步 Allure step + 截图）。这是**一个用例**；`CHANGELOG.md` 与旧版总结里写的「5/5」指的是 5 步。
- 崩溃监控：`core/logcat-monitor.ts#startLogcatMonitor`，关键字 `FATAL EXCEPTION` / `ANR in` / `beginning of crash`；命中后写 `midscene_run/crashes/<ts>/`（`screenshot.png`、`logcat.txt` = 前 200 行 + 后 200 行或 3 秒 + `logcat -b crash -d`、`context.json`），并回调 `onCrash`。
- 高频循环：`scripts/loop-android.ts`（`LOOP_COUNT` 默认 10、`APP_PACKAGE`、`DEVICE_ID`、`FAIL_FAST`、`CRASH_AT_ITERATION`、`FLOW=launch` 无 AI 模式），每轮 force-stop 后启动，汇总写 `midscene_run/loop-summary.json`（`totalRuns`、`crashesDetected`、`failedRuns`、`firstCrashIteration`）。
- 自检脚本 `scripts/crash-check-android.ts`（`am crash` 注入，10 秒内须捕获）；`env-report.md`、`env-plan.md` 在仓库根目录。

**与正文不同 / 后来的变化**

- `scripts/loop-android.ts` 与 `crash-check-android.ts` 不按包名过滤：任何进程的崩溃都会被记为本轮失败。
- 离线单测 `tests/android/logcat-monitor.unit.spec.ts` 在 W2-1 移到 `core/logcat-monitor.spec.ts`（归入 unit project，CI 能跑到）。
- M5 起的 Issue 执行器不再使用本模块：`drivers/android.ts#AndroidDriver` 自己维护一条 logcat 流（`-b main -b system -b crash -b events`），按 `#classifyLogLine` 判定崩溃 / ANR / 进程死亡 / 离开 App。`core/logcat-monitor.ts` 现在只服务 mission、explore、monkey、loop、旧重放这些旁路入口。
- `core/logcat-monitor.ts` 判断崩溃是否属于被测包，依据的是窗口内的 `Process: <包名>` 行。典型的 `ANR in <包名>` 日志可能没有这一行，被测包自己的 ANR 可能被当成其他进程的（代码推断，未在真机上复现）。
