# Changelog

## [Unreleased] — W2 Android ADB

### Added
- Android ADB 设备连接与 Midscene Android Agent 集成（`fixtures/android.ts`、`core/adb.ts`；设备自动发现，`DEVICE_ID` 可选，adb 路径可通过 `MIDSCENE_ADB_PATH` 指定）
- 第一条 Android 原生流程：系统设置 →「关于手机」5 步，每步 Allure step + 设备截图（`tests/android/settings.about.spec.ts`）
- logcat 崩溃监控（FATAL EXCEPTION / ANR / beginning of crash，`core/logcat-monitor.ts`）及离线单测
- 高频循环执行与 force-stop 状态重置（`pnpm loop:android`，`LOOP_COUNT` / `APP_PACKAGE` / `FAIL_FAST` / `CRASH_AT_ITERATION`，输出 `midscene_run/loop-summary.json`）
- 崩溃现场自动保存（截图 + logcat 片段 + 迭代序号，`midscene_run/crashes/<timestamp>/`）
- 真机崩溃监控自检 `pnpm crash-check:android`；循环脚本 `FLOW=launch` 无 AI 模式
- 真机验证（Xiaomi 2211133C / Android 16）：崩溃捕获、10 轮循环、fail-fast 均通过；AI 流程待模型凭据
- 环境侦察与最小依赖方案（`env-report.md`、`env-plan.md`，adb 通过 winget 安装）

### Changed
- `vitest.config.ts` 拆分为 `web` / `android` 两个 project；新增 `test:web`、`test:android`、`loop:android` 脚本。Web 用例与 fixture 未改动。
- `ref/` 加入 `.gitignore`（只读第三方参考工程，含嵌套 git 仓库）。

## W1 — Web baseline

### Added
- Midscene `PlaywrightAgent` + Vitest + Allure 最小闭环，saucedemo 5 步登录用例，`pnpm report` 生成 Allure 报告。
