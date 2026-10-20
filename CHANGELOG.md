# Changelog

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
- 并发的 explore/monkey 任务共用 `monkey_run/summary.json`、`midscene_run/problem-report.md`，控制台里的报告可能串到另一任务的汇总（mission 报告按任务 ID 隔离，不受影响）。
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
