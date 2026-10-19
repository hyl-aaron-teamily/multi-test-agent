# Changelog

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
