# W2-3 验收记录：任务与环境分离、收尾可恢复、Agent 用命令行、人用 Web

分支 `feat/w2m3-usability`。里程碑文档：`dev-week2-milestone3.md`。真机门原始记录：`docs/w2m3-gate/`（`gate.log`、`faults-*.json`、`determinism-*.json`、`consistency-*.json`、`estimate-*.json`）。
设备：Redmi 2211133C（Android 16 / HyperOS），Teamily 生产，账号 prod-aaron1（测试账号）。故障注入用计划 `2010/main:android-app@v1`（不发送消息）。

## 人工按钮的处理（用户决定，2026-10-28）

开发期间 `platform/policy.yaml` 的 `fullAccessDefault: true`（全部自动同意，包括环境配置项）；**里程碑结束时已改为 `false`**。之后：环境配置项（Taplus 黑名单、充电常亮）可由 Claude 代为同意；敏感计划必须用户本人在 Web 同意。本期真机运行中的配置项同意记录为 `full-access（default (platform/policy.yaml)）`。

## 结果汇总

| # | 验收项 | 结果 |
|---|---|---|
| 1 | Agent 闭环 | **部分**：CLI 全链路（draft → explain → task run 20 → task wait → result show 10）在真机上多次走通（故障矩阵每格之后的「下一次正常任务」共 20+ 次都是 `task run` + `task wait` 退出码 10）；**脚本化 Agent（`w2m3-gate.ts agent`）与敏感计划 30 → Web 同意 → 再执行的真机演练未跑**（adb 断线，见下）。敏感路径有单测（30 → Web 同意 → 20；CLI 同意 → 30；完全授权）。Claude 子代理演练未做（参考项）。 |
| 2 | 同事验收 | **待同事验收**（说明：`docs/w2m3-colleague-check.md`） |
| 3 | 故障恢复 | 20 格中 **19 格 PASS**；warmup/adb-kill 两次 FAIL，均因 `adb kill-server` 后手机掉授权、12 分钟内无人点「允许 USB 调试」，记录本身正确（任务 `ENV_OFFLINE`、环境「不合格：设备不在线」）。未出现「ready 但基线不通过」，未出现「进程已死仍显示运行中」。 |
| 4 | 确定性 | **PASS**：单测 + 实测 31 / 32 / 33（`determinism-*.json`；32 用标定 profile 末尾加换行触发，随后还原） |
| 5 | 一致性 | **PASS**：CLI 文本 / `--json` / Playwright 渲染页的结论句、有效尝试、命中、区间文字一致（完成任务 1 个、卡死任务 1 个）。首跑发现页面术语提示嵌套破坏 HTML，已修。 |
| 6 | 不回退 | **部分**：代码门全绿（含旧 `taskArgs` / 校验 / golden / 报告单测）；新任务路径产出的报告与 W2-2 同一 `writeIssueReport`。**旧入口 `run` 跑 2010、1903 各 1 次未做**（adb 断线）。 |
| 7 | 代码门 | **PASS**：192 s（typecheck + 单测 + 证据复核用例），≤ 5 分钟 |
| 8 | 预计耗时 | 首次统计 15/26（58%）；排除无结论运行并校准下界后 20/22（91%）——**校准用的是同一批数据（样本内）**，需在新运行上复测。只记录，不阻塞。 |

## §10.3 故障矩阵（每格之后紧跟一次正常任务，均得出结论「未复现」）

| 阶段 \ 故障 | 强杀任务进程 | 冻结进程（NtSuspendProcess） | 强杀平台后重启 | adb kill-server |
|---|---|---|---|---|
| 预检 | PASS interrupted / 63 | PASS failed / 62 | PASS interrupted / 72 | 首次 FAIL（预检里 adb 报错被记成工具 60 → 已修）；重跑 PASS env-unfit / 50 |
| 准备 | PASS 63 | PASS 62 | PASS 72 | PASS 52（ENV_OFFLINE） |
| 预热 | PASS 63 | PASS 62 | PASS 72 | FAIL ×2：记录正确（52、环境不合格），但手机掉授权、无人授权超时 |
| 循环 | PASS 63（2 次） | PASS 62 | PASS 72 | PASS（任务进程因 EPIPE 崩溃 → 记 63；已修为 52） |
| 收尾 | PASS 63 | PASS 62 | PASS 72 | PASS（扛过断连，正常得出结论） |

停止位置都写在任务记录里（如 `循环 第 1 轮 第 1 步`）；恢复在独立进程 `env recover` 中进行，检查并清空被键入过的会话输入框。

### 门暴露并已修的缺陷

1. 预检里的 adb 异常逃出 `runPlan` → 记成工具失败：改为「环境不合格（online）」。
2. 常驻 adb shell 的 stdin EPIPE 是未处理的 `error` 事件 → 任务进程崩溃；shell 退出时等待中的命令被当作成功：改为以 `device offline` 拒绝（环境失败）。
3. `task run` 先查环境再查批准：手机离线时 31/32/33 被 52 掩盖；改为先校验批准（不消耗次数），再查环境，最后才扣次数。
4. 结果页术语提示嵌套替换破坏 HTML（一致性门发现）。
5. 平台被杀后再启动：被租着但还没启动的任务回队列；接管的任务结束后由看门狗补做释放与恢复。

### 观察

- 强杀平台（不带 `/T`）时任务进程也随之结束（tsx 包装进程），所以实测都是 72「服务重启中断」；「接管仍在运行的任务」路径只有单测覆盖。
- 这台手机在 `adb kill-server` 后多次掉 USB 调试授权、甚至从 adb 消失，需要人在手机上点「允许」；用户判断可能是数据线问题。
- 准备阶段强杀后有一次手机处于 PIN 锁屏（代码里没有发送电源 / 休眠键，原因不明）；环境正确进入「不合格：锁屏」，解锁后自动重检就绪。

## 2026-10-29 补跑（重复项各压缩为 1 次）

- §10.1 脚本化 Agent（`w2m3-gate.ts agent`）：help → draft create → plan explain → task run（20）→ task wait（10）→ result show（10，「未复现：6 次有效尝试中命中 2 次…」）**PASS**；敏感计划（系列 21 次）→ **30 + 计划页链接 PASS**。完全授权已默认关闭，Web 同意按规则由用户本人点，**未做**（系列 21 次也未跑，原本就要压缩为 1 次）。
- §10.6 旧入口 `run`（各 1 次、1 轮）：1903 未复现，退出 0，报告字段与 W2-2 报告逐项一致（只差轮号）；2010 计划不可执行（预热第 1 步输入框未获焦点，退出 3）——字段同样一致，但这次没得出结论。
- §10.8 预计耗时：21/23（91%），新增运行落在区间内；样本仍主要是校准用的同一批。
- 预热阶段 adb-kill：再跑 1 次，注入后手机再次掉出 adb，约 10 分钟无授权 → 按用户规则停止，**未完成**。

## 未完成
- 预热阶段 adb-kill 一格（每次注入都让手机掉 USB 调试授权，疑似数据线 / HyperOS）。
- 敏感计划 Web 同意 → 再执行（需用户本人点）。
- 2010 走旧入口得出结论的那 1 次（本次预热失败）。
- §10.2 同事验收；参考项 Claude 子代理演练。
