# 里程碑 5（合并版）：Issue 分类驱动的黑盒复现 + 事故现场包 + Teamily 标准化 SKILL

> 由原 milestone5（Issue 驱动确定性压力复现 + Teamily SKILL）、milestone6（Web 规范化生成 + 混合定位 + Allure）、milestone7（瞬态 Bug 捕获：滚动缓冲 + 崩溃切片）去重合并，并按 2026-10-21 第一轮澄清回填。
> 标 **【待确认 Fn】** 的位置依赖文末追问的答案。

---

## 0. 现状基线（读代码核实）

| 能力 | 现状 | 位置 |
|---|---|---|
| 自然语言任务 | 模型/关键词生成 `MissionPlan`（自由文本 scenario + aiAct），按轮执行，含随机探索 | `mission/planner.ts`、`mission/runner.ts` |
| 崩溃监控 | `adb logcat -b main -b system -b crash -T 1`，命中后存前 200 行 / 后 200 行 + `logcat -b crash -d` + 截图 | `core/logcat-monitor.ts` |
| 录屏 | 环形分段：scrcpy 30s×3（≈90s）或设备端 screenrecord；scrcpy 停止用 `child.kill('SIGINT')`（Windows 上等同强杀） | `replay/screen-recorder.ts` |
| 即时重放 | `replay.json` = 最后一次 launch 到问题点的 ops（多为 aiAct/aiTap，重放仍需视觉模型）+ 录屏；只输出"是否复现 n/N" | `replay/ops.ts`、`scripts/replay.ts` |
| 无模型 Android 操作 | imui 用 `uiautomator dump` 定位 + yadb 输入 + 坐标点击 | `imui/clients/android.ts` |
| Web | Playwright + Midscene + Allure；只有 saucedemo 一条用例 | `fixtures/page.ts` |
| 平台 | 控制台 + 设备池（仅 Android，1 台真机 Xiaomi 2211133C）+ 任务类型 mission/explore/monkey/imui | `platform/` |
| Midscene 缓存 | Android 1.16 无 `cacheFeatureForPoint`（无元素定位缓存） | `node_modules/@midscene/*` |
| 工具 | scrcpy 5.0.1 已装于 `D:projectsToolsscrcpy-win64-v5.0.1scrcpy.exe`（2026-10-21 实测：优雅停止前 MKV 为 0 字节，scrcpy 只在正常结束时写盘，强杀会丢整段）；ffmpeg 已装；`defineNode` 在 `@midscene/core` 中存在，无 `midscene-test` CLI | — |
| 参考：im-loadtest | **非黑盒**：DOM locator + `page.evaluate` + `window.__im()`，无 `page.mouse`。可借鉴：登录流程（切邮箱 → 邮箱 → 继续 → 密码 → 继续，`storageState` 复用会话）、编辑器 `div.ProseMirror[contenteditable]`、Enter 发送、会话列表 `[data-testid="virtuoso-item-list"]`、桌面视口 1440×900、移动端 `devices['Pixel 7']` | `probe/src/fixtures/session.mjs`、`sdk-harness/detector/detector-ui.mjs` |

---

## 1. 原则（澄清结论）

1. **黑盒**：不读源码、不装调试版、不向页面注入代码、不生成测试代码文件。只通过用户可做的操作（触控/光标/键盘）驱动，只通过用户可见的现象（画面、App 进程存活、系统崩溃日志、浏览器 console）判断。目标是**发现问题现象**，不是定位根因。
2. **准备时 AI，循环时确定性**：
   - 固定界面元素（输入框、发送、Tab、导航）在 SKILL 层标定坐标；
   - 动态目标（用哪个群、哪条消息、哪个会话）**不在开发时写死**，由模型在每份 Issue 的准备阶段看截图自主决策，SKILL 提供决策指引（选什么样的群/消息、怎么进入）；决策结果冻结为坐标后进入循环；
   - 循环中只按坐标操作，**只有检查失败或页面表现异常时**才重新截图/调视觉模型核对。
   - 样例 Issue 只用来检验能力，重点是通用能力而不是逐条适配。
3. **三种执行端**：`android-app`、`mobile-web`、`desktop-web`。
4. **节奏**：动作间隔 ≤ 1 秒。一份 Issue 只启动一次 App，除非 Issue 涉及启动/加载问题。
5. **判定**：不讲复现率。偶现：步数上限内命中 1 次即"可复现"；必现：连续命中 3 次即"可复现"。
6. **替代执行必须用户确认**：只显示替代理由；一份 Issue 只在测试开始时确认一次；多项可替代内容用复选框选择，形成部分自定义用例。
7. **环境**：测试环境 `https://chat-test.teamily.ai/chat` 用于 SKILL 标定与开发调试；**所有 Issue 的最终验证在生产环境** `https://teamily.ai/chat`（运维兜底，10 个以内账号可任意测试）。测试/生产账号相互独立、数据不互通。凭据只在账号池的本地私有后端（见 §4.4），不进文档、日志、报告、提交。
8. **环境条件模拟允许**：断网、慢网、视口/设备模拟（Playwright 网络与设备模拟）不算注入页面代码。
9. **mobile-web** = Playwright 设备模拟（桌面 Chromium + 手机视口 + 触屏），最简方案。

---

## 2. 模块 A：Issue 分类与测试方案

### A.1 分类（计划前预判）与结论（执行后判定）

Issue 文本只能**预判**类别；"已修复""用户误操作"通常要跑完才能确定，所以分两层：

| 预判类别 | 判定依据（文本信号） | 测试方案 | 可能的结论 |
|---|---|---|---|
| `bug-always` 必现 | Frequency: Always；步骤明确 | 按步骤执行，**连续 3 次**命中即可复现；步数上限内一次未中 → 未复现 | 已复现 / 未复现（疑似已修复） |
| `bug-intermittent` 偶现 | Frequency: Intermittent；"偶发/有时" | 固化动作序列循环，节奏 ≤1s，步数上限内**命中一次**即可复现 | 已复现 / 未复现（上限内未出现） |
| `feature` 需求 | Improvement request / "建议增加" / AC 列表 | **一次性验收**：逐条检查 Expected/AC 描述的能力是否存在 | 未实现 / 部分实现（列出缺项）/ 已实现 |
| `suspected-misuse` 疑似误操作 | 描述的操作路径与 SKILL 中的正确路径不同 | 先走正确路径，再走 Issue 描述路径，对比现象 | 疑似误操作（正确路径正常）/ 转为 bug |
| `server-side` 服务端 | 无 UI 现象、只涉及接口/Agent 发送路径 | **直接拒绝**，写明原因 | 不执行 |
| `multi-account` 多账号/多端 | 需要第二账号或第二客户端配合（含同账号多端） | **暂缓**，等账号池 + 设备池支持多客户端 | 暂缓 |
| `deferred` 未来计划 | 黑盒构造前置条件需新能力（如写 localStorage） | 暂缓，记入未来计划 | 暂缓 |
| `not-executable` 不可执行 | 空文档、无可观察现象、需注入页面代码才能构造条件 | 拒绝，写明缺什么 | 不执行 |

"已修复"不是预判类别，而是结论：bug 类在上限内未复现时，结论写"未复现，疑似已修复"，并附完整执行证据（视频 + 步骤截图），供人判断。

### A.2 现有 Issue 的预判

| Issue | 预判 | 执行端 | 方案要点 |
|---|---|---|---|
| 1329 iOS 点赞不显示 / 定位跳到旧消息 / 键盘需点两次 | bug-intermittent（3 项） | iOS → **替代**（复选框：3 项各自可选 android-app / mobile-web） | 一份 Issue 拆 3 个子用例，确认时勾选 |
| 1594 Web @ 选择器偶发不弹出 | bug-intermittent | desktop-web | 切会话 → 输入 @ → 检查选择器；循环 |
| 1614 @ 目标 ID 非法静默成功 | server-side | — | 拒绝 |
| 1919 iOS 多端消息同步缺失 | multi-account（同账号多端） | — | 暂缓 |
| 1922 空文档 | not-executable | — | 拒绝 |
| 2122 免打扰群 @ 我无角标 + Mentions 列表 | feature（部分 multi-account） | desktop-web | 单账号可验部分（是否存在 @我 聚合入口、免打扰群的现有提示）先验收；需第二账号 @我 的角标部分暂缓 |
| 2230 localStorage 满时离线发送失败 | deferred | — | 需写 localStorage 构造条件，作为未来计划暂缓 |
| 2336 三个独立通知铃铛 | feature（UX） | desktop-web | 一次性验收：访问个人页 / Artifacts / CloudDoc，统计铃铛入口与未读状态 |

### A.3 Issue 解析
- 输入 `issues/*.md`（Summary / Steps to reproduce / Expected / Actual / Severity(Level, Frequency) / Environment(Platform) / Additional context / Screenshots；下半部分中文镜像）。
- 归一化为 `NormalizedIssue { id, title, severity, frequency, platforms[], summary, steps[], expected, actual, featureArea, context }`。未知段落宽容跳过；空文件 → `not-executable`。
- 截图**不**提供给模型。

### A.4 TestPlan schema（唯一中间表示）

`platform/schema/test-plan.ts`，zod 定义并导出 JSON Schema（给 LLM structured output）：

```typescript
type Surface = 'android-app' | 'mobile-web' | 'desktop-web';

interface TestPlan {
  id: string;                          // <issue-id>[-<sub>]-<surface>-v<n>
  issueRef: string;
  title: string;
  category: 'bug-always' | 'bug-intermittent' | 'feature' | 'suspected-misuse';
  surface: Surface;
  issueSurfaces: string[];             // Issue 声明的端（ios/web/android/desktop）
  substitution?: { from: string; to: Surface; reason: string };   // 只有理由，无可信度
  env: 'test' | 'prod';                // 最终验证 = prod；调试 = test
  account?: string;                    // 账号池中的账号 id；缺省时按 env + surface 自动租用
  launch: 'once' | 'each-iteration';   // 默认 once；仅启动/加载类问题 each-iteration
  setup: PlannedAction[];              // 执行一次：登录态、进入目标会话
  actions: PlannedAction[];            // 每轮动作
  checks: CheckPoint[];
  limits: { maxSteps: number; maxMinutes: number; maxIntervalMs: 1000 };
  verdictRule: { consecutiveHits: 3 } | { anyHit: true };   // 由 category 决定
  provenance: { generatedBy: 'model' | 'rules' | 'manual'; skillVersion: string; confirmedAt?: string };
}

interface PlannedAction {
  type: 'tap' | 'longPress' | 'type' | 'key' | 'swipe' | 'scroll' | 'back' | 'wait' | 'launch' | 'node';
  node?: { name: string; input: Record<string, unknown> };  // SKILL Node，如 teamily.openConversation
  element?: string;                    // SKILL 页面地图中的元素 id，如 chat.composer
  value?: string;                      // type 的文本 / key 名
  delayAfterMs?: number;               // 默认 300，上限 1000
}

interface CheckPoint {
  kind: 'visual-region' | 'crash' | 'process-alive' | 'console-error' | 'page-error' | 'ai';
  page?: string; region?: string;      // visual-region：SKILL 中的参考区域
  expect: string;                      // 人类可读的预期，也作为 ai 核对的问题
  onlyOnAnomaly?: boolean;             // ai 类默认 true
}
```

计划里**只引用 SKILL 的元素 id 和 Node**，不写坐标；坐标由执行器按"SKILL 版本 + 执行端配置"查表得到。

### A.5 生成与确认流程

```
issues/<id>.md
  → 解析 → 预判类别（规则 + LLM）
  → server-side / not-executable：直接出拒绝报告
  → 平台判定：Issue 端与可用执行端求交；无交集 → 生成替代项（每个子用例一项）
  → LLM 生成 TestPlan（JSON Schema 约束 + SKILL 元素/Node 词表）→ 规则校验（元素/Node 存在、间隔 ≤1s、上限）
  → 失败则规则模板生成，同样校验
  → 【一次性确认】控制台/CLI 显示：预判类别（可改）、子用例列表、替代项复选框 + 替代理由
  → 固化 platform/plans/<plan-id>.json → 进入队列
```
- 每份 Issue 只确认一次；确认后执行中不再打断。
- CLI：`pnpm autotest plan issues/1594.md` 生成草稿；`pnpm autotest run --issue 1594 [--approve <sub,...>]` 执行（命令行确认用交互或 `--approve`）。
- 自然语言 `mission` 保留为探索模式，不删除。

---

## 3. 模块 B：Teamily SKILL（坐标在这一层标定）

```
skills/teamily/
├── SKILL.md                 # 适用版本、三种执行端、页面地图总览、登录与前置条件、操作原则
├── pages/                   # home / chat / mentions / profile / artifacts / clouddoc …
│   └── chat.md              #   元素清单：id、含义、如何识别、所在区域
├── profiles/
│   ├── android-<udid>.json  # 每台设备分辨率下的元素坐标 + 参考截图区域
│   ├── mobile-web.json      # 视口（如 iPhone 15 / Pixel 7 设备描述）下的坐标
│   └── desktop-web.json     # 1440×900 下的坐标
├── refs/<profile>/<page>.png # 页面参考截图（异常检测与 visual-region 检查用）
├── operations.md            # 操作规范：坐标优先；视觉模型只在异常核对时用
├── plan-template.md         # 类别 → 计划骨架（必现/偶现/需求/误操作）
├── report-spec.md           # 现场包结构
└── nodes.ts                 # defineNode：teamily.login / openConversation / sendMessage / typeMention / openMentions …
```

- **标定工具** `pnpm autotest skill calibrate --surface <s> [--device <udid>]`：在标定时（不是测试时）用 uiautomator dump（Android）、视觉定位（Web）找到每个固定元素，写入 profile 坐标和参考截图。测试执行时不再查层级。
- **自动自检代替人工审查**：标定后自动逐个元素验证——点击/聚焦后截图，检查是否出现预期变化（页面切换、键盘弹出、焦点高亮、弹层出现），视觉模型判定结果；通过即入库，只有失败项进入人工复核队列，并生成坐标标注图（截图画框 + 元素 id）供复核。
- **动态目标由模型在准备阶段决策**：SKILL 的 `pages/*.md` 和 `plan-template.md` 写明"什么样的群/消息适合哪类问题、怎么找到它"（如 @ 类问题选成员 ≥3 的群；点赞类选别人发的普通文本消息），模型看截图选定后把目标坐标冻结进本次执行记录；循环中若异常门发现目标漂移（列表顺序变化），回到准备阶段重新决策一次。
- **版本失效**：App 或 Web 改版导致参考截图对不上时，执行器报"SKILL 失效 @ 页面 X"并停止，提示重新标定。
- `nodes.ts` 用 `@midscene/core` 的 `defineNode`；`execute` 内部只调坐标操作。`midscene-test` CLI 不存在，自写 `pnpm autotest nodes` 列出 Node 及 schema。

---

## 4. 模块 C：执行器（黑盒、坐标驱动）

### C.1 三种驱动
| 执行端 | 输入方式 | 观察方式 |
|---|---|---|
| android-app | `adb shell input tap/swipe/keyevent`，文本用 yadb（imui 已验证） | screencap、前台 Activity、`pidof`、logcat 崩溃/ANR |
| mobile-web | Playwright 设备模拟（触屏）+ `page.touchscreen.tap` + `page.keyboard` | 截图、console、`pageerror`、页面崩溃事件 |
| desktop-web | Playwright `page.mouse.move`（带轨迹插值，模拟光标移动）/ `click` / `wheel` + `page.keyboard` | 同上 |

Web 端登录仍走光标/键盘（按 im-loadtest 的流程顺序），成功后用 `storageState` 复用会话，避免每次登录。

### C.2 执行流程
1. 启动/打开一次（`launch: once`），执行 `setup`。
2. 循环 `actions`，动作间隔 ≤1s；每步**不截图、不发额外 adb 命令**，异常门完全由流式日志驱动（零逐步开销）：
   - Android：logcat 流（`-b main -b system -b crash -b events`）正则筛查：
     - 崩溃/ANR：`FATAL EXCEPTION`、`ANR in`、`am_crash`、`am_anr`；
     - 进程死亡：`am_proc_died` / `Process <pkg> .* has died`（替代逐步 `pidof`）；
     - 离开 App：`wm_set_resumed_activity` / `am_focused_*` 中前台组件不属于本 App（替代逐步 `dumpsys activity`）；
     - App 自身错误：该 App pid 的 `E/` 级别行按 SKILL 中的正则表筛查（release 包仍可能输出），只记为可疑信号。
   - Web：`pageerror`、console error 正则、`page.on('crash')`、URL 意外跳转——都是事件，零开销。
3. 截图只在三种时机：**崩溃/异常信号命中时**（现有 monitor 已这样做）、**每轮末尾的检查点**（只有 `visual-region` 检查需要，按轮不按步）、异常核对时。截图后与参考区域做感知哈希比对，不一致才调视觉模型核对（区分真问题、瞬时状态、操作偏离）。
   - 理由：崩溃类问题靠日志足够，但"选择器没弹出""点赞不显示"这类界面状态 bug 不产生任何日志，只能看画面，所以检查点截图不可省；它按轮发生，不计入动作间隔。
   - 实测项（T2）：Android `input tap` 自身约 0.2–0.4s（每次起 JVM），`screencap` 约 0.3–0.8s；用常驻 `adb shell` 会话减少进程启动开销。若检查点截图仍拖慢节奏，可改为从 scrcpy 录像中按时间戳事后抽帧，代价是判定滞后。
4. 按 `verdictRule` 判定：命中一次（偶现）或连续 3 次（必现）即停止并出结论；步数/时长上限到达即停止。
5. 看门狗：单步超时强制结束，写出已有结果。

### C.3 统计
总步数、总时长、平均/最大动作间隔、异常门触发次数、视觉模型调用次数（预期接近 0）、命中记录。

### C.4 账号池（工程基座，本里程碑只做单账号租用，多账号调度留接口）

```
platform/accounts/
├── types.ts            # Account（id/env/email/tags/surfaces/status/boundDevice/lastLogin…，不含密码）
├── secret-backend.ts   # SecretBackend 接口：get(accountId) → 凭据；实现 1 = LocalYamlBackend（platform/accounts.local.yaml）
│                       #   后续可换 OS 钥匙串 / Vault，不改调用方
├── account-pool.ts     # 与 DevicePool 同构：reload / refresh / lease(taskId, {env, surface, count}) / release
│                       #   状态 idle / busy / disabled / login-failed；冷却时间；按 env 隔离（同邮箱测试/生产是两个账号）
├── sessions.ts         # 会话缓存：Web storageState 存 platform/secrets/sessions/<id>.json；失效自动重登
└── health.ts           # 健康检查：光标登录一次，记录 lastLoginOk / 错误
```
- 状态持久化到 `platform/state/accounts.json`（无密码）；控制台加只读账号列表（id、环境、状态、绑定设备、上次登录）。
- CLI：`pnpm autotest accounts list|check [--env prod]`。
- **设备-账号绑定**：Android App 的登录态在设备上，池里记录 `boundDevice`；任务调度时设备与账号一起租用（`lease` 原子地拿设备 + 账号），为后续多账号/多端（1919、2122）留好接口。
- 本地私有后端已建：`platform/accounts.local.yaml`（gitignored，`*.local.yaml`、`platform/secrets/`），含测试 3 个、生产 3 个账号。

---

## 5. 模块 D：事故现场包与即时重放

### D.1 Android 飞行记录器（常开，环形）
| 通道 | 做法 | 窗口 |
|---|---|---|
| 视频 | scrcpy 分段（`--no-playback --no-window --record=seg.mkv --time-limit=30`），保留最近 6 段；停止走 `adb shell pkill -f com.genymobile.scrcpy.Server`（实测：scrcpy 5 中 `scrcpy-server` 只出现在 sh 包装进程的 CLASSPATH 里，`pkill -f scrcpy-server` 杀不到录制进程；按类名 pkill 后客户端输出 Recording complete，MKV 有效）；scrcpy 不可用退回 screenrecord（`pkill -INT`） | 180s |
| 日志 | host 侧按时间保留全部 logcat 行（替代 200 行）；任务开始时 `logcat -c` | 180s |
| 操作轨迹 | 每步：动作、元素 id、坐标、耗时、异常门结果；最近 N 步保留前后截图 | 最近 N 步 |
| 时间对齐 | 测设备/主机时钟偏移（`adb shell date +%s%3N` 往返中点）；每段视频记主机起始时间 | — |

触发时额外采集（均为黑盒可得）：`logcat -b crash -d`、`dumpsys dropbox --print`（native crash / ANR 详情）、前台 Activity、`dumpsys meminfo <pkg>`、App 版本、设备型号/系统版本。

### D.2 Web 飞行记录器
- Playwright `context.tracing` 分块（`startChunk/stopChunk`），保留最近 N 块：截图流、动作、网络、console。
- console 与网络请求内存环形保留，触发时导出 `console.jsonl`、`network.har`。
- 暂不用 rrweb。

### D.3 统一现场包
```
<run-dir>/incidents/<n>-<kind>/
├── index.html          # 时间轴查看器：视频/trace + 操作标记 + 日志联动，单文件离线可开
├── incident.json       # 触发类型/时间、窗口起止、时钟偏移、执行端、设备/浏览器/App 版本、步号、替代说明
├── video/              # Android：分段 mkv（ffmpeg 合并 mp4）+ ops.srt（每步动作叠在视频上）
├── trace/              # Web：trace-chunk-*.zip
├── logs/               # logcat-window.txt、crash-buffer.txt、dropbox.txt / console.jsonl、network.har
├── steps/              # 最近 N 步前后截图
├── state/              # meminfo、activity 等
└── replay.json         # 坐标级动作序列（含 SKILL 版本与执行端），可直接重放
```
`kind`：crash / anr / app-exit / check-failed / console-error / page-error / visual-anomaly / watchdog。现有 `midscene_run/crashes/` 与 `replay-N/` 迁入此结构。

### D.4 重放
`pnpm autotest replay <incident>/replay.json`：
- 按同一判定规则（命中一次 / 连续 3 次）给出"能否复现"。
- **偏离检测**：每步截图与原现场同步的感知哈希比对，报告"第 k 步起与原路径不同"，区分"没复现"和"没走到出事位置"。
- **变体**：原节奏 / 加速 / 减速 / 冷热启动 /（确认后）换执行端，报告触发变体。
- 最小化（可选）：对已复现序列删减，得最短触发步骤。

---

## 6. 模块 E：报告与控制台（最小可用）

- `report.md` / `mission.json`：结论（按 A.1 的结论词表）、预判类别、执行端与替代说明、步骤轨迹、统计、现场包与重放链接。拒绝/暂缓的 Issue 也出一页报告说明原因。
- Allure：每个子用例一个 test，步骤带截图，现场包 `index.html` 作附件。
- 控制台最小版：上传/选择 Issue → 显示预判类别 + 子用例 + 替代复选框（一次性确认）→ 执行 → 结论与现场包链接。

---

## 7. 子任务拆分（goal mode 执行顺序）

| # | 子任务 | 依赖 | 完成判据 |
|---|---|---|---|
| T0 | 环境与账号池：scrcpy 已装（设置 SCRCPY_PATH）；账号池基座（C.4）；测试/生产 Web 光标登录跑通 | — | `scrcpy --version`；`autotest accounts check` 两个环境各至少 1 个账号登录成功并缓存会话 |
| T1 | Issue 解析 + 分类器（规则 + LLM）+ TestPlan zod schema + 校验器 | — | 8 份 Issue 全部得到预判类别，单测通过 |
| T2 | 光标/触控/键盘驱动层（android-app / mobile-web / desktop-web）+ 低成本异常门 | T0 | 三端各能按坐标完成"打开会话 → 发送一条消息" |
| T3 | SKILL 骨架 + 标定工具 + 三端 profile 与参考截图（覆盖 A.2 涉及的页面） | T2 | 标定产物人工审查通过；`autotest nodes` 列出 Node |
| T4 | 计划生成器 + 一次性确认（CLI + 控制台复选框） | T1/T3 | 1594/2336/1329 生成可执行计划；1329 出 3 项替代复选框；1614/1922 出拒绝报告 |
| T5 | 执行器：循环、判定规则、异常核对、看门狗、统计 | T3/T4 | 1594 在 desktop-web 跑满上限或命中；视觉模型调用≈0 |
| T6 | Android 飞行记录器升级（优雅停止、180s、时间窗日志、时钟对齐、dropbox） | T0 | `am crash` 注入后视频可播放、覆盖 ≥30s、日志与视频窗口重叠 |
| T7 | Web 飞行记录器（trace 分块 + console/network 环形） | T2 | 一次 page-error/检查失败导出可在 trace viewer 打开的现场 |
| T8 | 统一现场包 + `index.html` 时间轴查看器 + ops.srt | T6/T7 | 两端结构一致，查看器离线可开 |
| T9 | 重放：判定规则、偏离检测、变体（+ 可选最小化） | T5/T8 | 注入崩溃的现场重放，报告给出结论与偏离点 |
| T10 | 报告 + Allure + 控制台最小版全链路 | T4–T9 | 控制台从上传 Issue 到看现场包走通一次 |
| T11 | 样例 Issue 端到端（生产环境出结论）：1594（偶现）、2336 + 2122 单账号部分（需求验收）、1329（替代执行） | 全部 | 见验收标准 |

---

## 8. 验收标准

1. 8 份 Issue 都有预判类别和对应处理：可执行的生成计划，服务端/空文档出拒绝报告，多账号出暂缓报告。
2. 1594 在 desktop-web 按坐标循环执行，动作间隔 ≤1s，只启动/打开一次；视觉模型调用接近 0（日志计数可验证）；结论按判定规则给出。
3. 2336、2122（单账号部分）作为需求验收一次性执行，报告列出已实现/缺项。所有结论来自生产环境运行。
3a. 动态目标（群/消息/会话）由模型在准备阶段看截图选定，不在代码中写死；SKILL 标定自检自动完成，人工只复核失败项。
3b. 账号池：`autotest accounts list|check` 可用，任务按环境租用账号，凭据不出现在任何日志/报告/提交中。
4. 1329 在开始前一次性弹出替代确认（3 个复选框 + 理由），只执行勾选项，报告标注替代。
5. Android 崩溃/ANR 现场包：视频可播放、覆盖崩溃前 ≥30s（目标 180s）；`incident.json` 中视频与日志窗口可对齐；堆栈可读；能追溯到步号与动作。
6. Web 现场包：trace 可打开，异常前的画面、网络请求、console 错误可见。
7. 录制停止走 `adb shell pkill -f com.genymobile.scrcpy.Server`（设备端优雅终止）；长循环中录屏分段与日志缓冲不单调增长。
8. 重放报告给出能否复现（同一判定规则）和偏离点，不再只有 n/N。
9. `skills/teamily/` 存在，三端 profile 有标定坐标；Node 可列出并被计划引用执行；SKILL 失效时能报出。
10. 现有入口（mission / explore / monkey / imui / test:web / test:android）不受影响；`pnpm test:unit`、`pnpm typecheck` 通过。

---

## 9. 硬约束与自主工作规则

- 黑盒：不注入页面代码、不读源码、不依赖调试版或 App 内部钩子（如 `window.__im()`）。
- 执行期只按坐标操作；层级读取/视觉定位只在标定期，以及执行期异常核对时使用。
- 一份 Issue 只启动一次 App（启动/加载类问题除外）；动作间隔 ≤1s。
- 替代执行必须在开始时经用户确认，只显示理由；执行中不再请求确认。
- 测试环境只用于 SKILL 标定与开发调试，Issue 直接在生产环境执行出结论；使用账号里已有的群/会话，由模型按 SKILL 指引选择。
- 允许自动化在 App/Web 内退出、切换账号（从硬拦截规则中对 Issue 执行放开"退出登录"，支付类拦截保留）。
- 步数上限：偶现默认 1000 步 / 30 分钟，平台硬上限 3000 步 / 120 分钟（替换现有 300 / 120）。
- 账号凭据只放本地私有配置（gitignored），不进文档、日志、报告、提交。
- 优雅终止：不直接杀本地 scrcpy 进程。环形窗口优先于全量录制。
- 工具不可用时降级，不卡在安装上；不 mock 崩溃、定位、断言或回放产物；无法验证的路径标"未验证"并说明原因。
- 每个子任务完成后：单测 + typecheck + 真机/浏览器验证，再提交，提交信息遵循 `feat(scope): ...`。

---

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 坐标在改版/不同设备上失效 | profile 按设备/视口分；参考截图哈希比对发现失效即停并提示重标定 |
| 动态内容（会话顺序、消息位置）导致坐标点错 | 用搜索等固定入口把动态目标转成固定坐标；异常门捕获偏离 |
| 感知哈希误报（动画、时间戳、新消息） | 参考区域只取稳定部分；超阈值才进入视觉核对 |
| Android screencap 慢（数百 ms），影响 ≤1s 节奏 | 逐步异常门全走 logcat 正则；截图只在崩溃时和每轮检查点 |
| 界面状态 bug 无日志 | 每轮检查点截图 + 区域哈希，不一致才调视觉模型 |
| 黑盒不可构造的前置条件（如 2230） | 归为 not-executable 或只做可达部分，报告说明 |
| 替代端结论不能代表原端 | 报告首行标注替代 |

---

## 11. 澄清记录

三轮澄清已全部回填。无剩余开放项。

执行期补充（2026-10-22，均为用户决定或事实核对）：
- **1922**：实际 `issues/1922.md` 并非空文档（内容为 iOS 自己发送的文本消息第二行被截断）。用户确认仍按本文 A.2 处理为 not-executable 并出拒绝报告；以 `platform/issue-overrides.yaml` 记录此决定。
- **1329 执行端**：项目无 iOS 执行端（§0 设备池仅 1 台 Android），按 A.2 “iOS → 替代”执行，三项子用例分别经一次性确认在 android-app 上于生产环境跑满上限，报告首行标注替代。
- **范围**：用户确认目标为端到端流程跑通，不要求每份 Issue 都定位或复现。
- 验收证据索引：`docs/m5-acceptance.md`。
