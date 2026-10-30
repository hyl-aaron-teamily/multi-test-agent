# W2-4 验收记录：感知层增强（参考 Artemis）+ 原生 MCP 服务

分支 `feat/w2m4-perception-mcp`（从合并 W2-3 后的 `main` 7ef7425 开出）。里程碑文档：`dev-week2-milestone4.md`。原始记录：`docs/w2m4/`。
设备：Redmi 2211133C（4f2ebdf2，Android 16 / HyperOS OS3.0），Teamily 2.0.20 生产，账号 prod-aaron1（测试账号）。完全授权按用户决定保持开启（开发期）。

## §11 决定（用户 2026-10-30）

| # | 决定 |
|---|---|
| G1 | 自建只读无障碍服务 APK（源码 `android/a11y-service/`，只导出界面树 + 健康检查，无手势、无截图、只监听手机回环地址）；允许下载 Android SDK 组件到 `tools/android-sdk` 构建；安装 / 启用作为**可选**环境配置项 |
| G2 | 不接 OCR |
| G4 | 循环原则不变：每步不读界面、不调视觉、不做执行前校验 |
| G5 | MCP 平台未启动返回 54 与启动命令，不自动拉起 |
| G6 | 敏感计划 / 完全授权 / 配置项同意只在 Web；MCP 没有同意类工具 |
| G7 | 只提供 `--print-config` 打印，不写 IDE 用户配置 |
| 5 | MCP 不暴露 `env recover` / `env offline` |

## 结果汇总

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 读树提速 | **待完成**：APK 源码与构建脚本、主机侧客户端、配置项、退化均已实现并单测；本机没有 Android SDK，我这边的下载被权限拦截，需要人运行一次 `sh android/a11y-service/fetch-sdk.sh`，之后构建、安装、50 次 × 2 屏计时与一致率。基线（uiautomator，本期实测）：doctor --probe 2683 ms / 286 节点；2010 每次运行 19 次读树 p50 2483–2564 ms、p95 3195–4385 ms；1903 每次 21 次 p50 2599–2710 ms、p95 3579–3771 ms |
| 2 | 不回退 | **PASS**：代码门全绿（typecheck + 单测 270+）；2010 × 3：未复现 0/3（有效尝试 18、命中 0），与 W2-3 在 2.0.20 上的结论一致（改写有确认框）；1903 × 3：未复现 0/3（有效尝试 18、命中 0），与 W2-2 一致。读树后端仍是 uiautomator，每轮耗时无变化（记录） |
| 3 | 退化可见 | 见下「退化演练」（声明 a11y-service 而服务未安装 → 运行照常完成，报告写明退回原因）；APK 安装后再做「人为停用」一次 |
| 4 | 执行前校验 | **PASS**：真机注入 4/4（同点通过；+60 px 修正回中心；+200 px 判「偏移」不点；不存在的目标判「消失」不点，`docs/w2m4/pretap-inject.json`）；单测覆盖偏移修正 / 遮挡 / 消失 / 资源 id / 像素；6 次真机运行每次准备期 1 次校验（冻结的会话行，通过），**循环内校验 0 次**（报告「执行前校验」一节） |
| 5 | 诊断 | **PASS**：四种情况单测（锁屏 → blocked 51 + 需人工解锁；未授权 → blocked 52 + 需人工点允许；无模型配置 → degraded + 配 .env；平台未启动 → blocked 54 + `pnpm platform`）；真机：平台未启动时 exit 54 与下一步正确；`--fix` 只删本机残留（单测），全文无 `adb kill-server` |
| 6 | MCP 闭环 | **PASS（脚本客户端）**：经 stdio 只用 MCP 工具完成 2010 × 3 与 1903 × 3：`doctor` → `draft_create` → `plan_explain` → `task_run`（20）→ `task_wait` ×18 / ×20（21 再等）→ `result_show`（`docs/w2m4/mcp-e2e-*.json`）；平台未启动 → 全部 54；敏感计划 → 30 + 审核页链接（完全授权开启时不会出现，按 G6 用关闭完全授权的隔离状态目录跑真实 API + MCP 映射验证，单测）。**在 Claude Code 界面里接入（`claude mcp add …`）需要人执行 `--print-config claude` 打印的命令**，未代为写入用户配置（G7） |
| 7 | 一致性 | **PASS**：`scripts/mcp-check.ts` 11 个只读调用与 `--json` 逐字段一致（平台未启动 4/4、启动后 11/11）；两个 MCP 闭环的 `result_show` 与 `autotest result show --json` 逐字段一致；Web 结果页与命令行同源（W2-3 已验证） |

## 读树后端（§4.1）

- `core/tree-backend.ts`：所有 Android 读树经 `readTree`；A = uiautomator（原实现，按设备串行），B = 常驻服务；B 失败时本次退回 A，原因计数（报告「读树后端」一节）。
- 设备声明：`platform/devices.yaml` 的设备项加 `treeBackend: a11y-service`（或环境变量 `AUTOTEST_TREE_BACKEND`）。声明后环境多一个**可选**配置项 `a11y-service`：`env check` / 恢复时安装并追加启用（保留手机上其他无障碍服务），预检只检查不安装；装不上 / 不响应 → 基线项通过但写明「退回 uiautomator」，环境不判不合格。
- 协议：手机回环 `127.0.0.1:18765`，`/ping`（无令牌）、`/dump?token=`（uiautomator 同格式 XML）；令牌经 `am broadcast` 下发，接收器要求 `WRITE_SECURE_SETTINGS`（只有 adb shell / 系统有）；主机经 `adb forward tcp:0` 访问，端口按设备复用、进程退出时移除，残留由 `doctor --fix` 清理。
- 卸载：`adb uninstall ai.autotest.a11y`（`core/a11y-service.ts#uninstallA11y` 先从启用列表移除）。

## 执行前校验（§4.3）

- `executor/pretap.ts`：记住循环外决定的每个点（①/② 定位、冻结目标、自愈元素）的指纹；`enter` / `prepare` / `re-entry`（偏离后重进）阶段与 Android 标定自检打开，循环关闭。
- 树校验权重：资源 id 0.5、文字 0.4、边界 0.3、位置 0.3；≤ 8 px 通过，≤ 120 px 就地修正，更远 = 偏移；命中测试点到无层级关系的节点 = 遮挡；找不到 = 消失。拦截记「执行事件」并存两帧截图（`<runDir>/pretap/`）。
- 没有指纹（视觉定位的目标）或 android-web（浏览器无障碍树页面内跳转不更新）：决策时截图对比当前截图，点击点周围 < 5% 像素变化即通过，否则视觉模型判断两帧（只回答是否 / 状态 / 把握度），视觉不可用 = 不确定（照点，记录）。
- 准备期被拦截的会话行：重新挑行一次再执行 setup。

## 退化演练

- 2026-10-30，平台以 `AUTOTEST_TREE_BACKEND=a11y-service` 启动（声明常驻服务，手机上未安装），提交 2010 一次（任务 `t-20261030133957-8nxs`）：运行照常完成，结论「未复现」；报告「读树后端」一节：`uiautomator：19 次，p50 2593 ms，p95 3138 ms`、`退回 uiautomator 1 次；首次原因：a11y-service: ai.autotest.a11y 未安装`（`midscene_run/issues/2010-android-app-v1-2026-10-30T13-40-00-406Z/report.md`）。
- 「已安装后人为停用」的一次等 APK 装上后补跑。

## 发现与修复

- 草稿版本：没有 `version` 字段的旧草稿内容变化后仍记为 v1（同一计划 id 指向两份内容）→ 旧草稿按 v1 计，新内容为 v2（`issue/drafts.ts#nextVersion`，单测）。1903 的保存草稿在修复前已被重新起草为「新内容 v1」，保留（批准按计划哈希绑定，不影响执行）。
- `docs/cli-reference.md` 比对受 Windows 检出换行影响 → 比对时统一换行。
- W2-3 单测按固定 `@v1` 取计划 → 改为按保存草稿的版本。

## 未完成 / 需人工

1. 运行 `sh android/a11y-service/fetch-sdk.sh`（约 110 MB，来源 dl.google.com）→ 之后由 Claude 构建 APK、作为配置项安装启用、跑 §7.1 计时与一致率、§7.3 人为停用。HyperOS 安装侧载应用时手机上可能弹「USB 安装」确认，需要人点一次。
2. 在 Claude Code 中接入：运行 `npx tsx scripts/mcp.ts --print-config claude` 打印的 `claude mcp add …`。
