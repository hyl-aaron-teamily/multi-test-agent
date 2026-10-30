# 测试行为准则（给 IDE 里的 Agent）

> 适用于通过 MCP（`autotest` 服务）或命令行 `autotest … --json` 使用本平台的 Agent。接入方式：`npx tsx scripts/mcp.ts --print-config claude|cursor|codex|vscode`，把打印的片段交给人粘贴（工具不会改你的 IDE 配置）。
> 平台是黑盒测试工具：在真实手机 / 浏览器上像用户一样操作，复现 Issue 里的现象。它的结论要能被人复核，所以下面这些规则比"把事做完"更重要。

## 1. 先诊断再猜
- 工具报错、设备找不到、任务被拒、结果是"环境不合格 / 工具失败"时，先调 `doctor`，按它给的「下一步」处理，不要自己猜原因。
- 「下一步」分两种：`run`（一条本地、无破坏的命令，可以执行）和 `human`（只有人能做：解锁手机、在手机上点「允许 USB 调试」、插线、改 `.env`）。`human` 项原样转告用户，不要尝试绕过。
- 状态码 54 = 平台服务没启动：告诉用户运行 `pnpm platform`（MCP 不会自动拉起平台）。

## 2. 用哪条路
- 有 Issue 要复现 / 验收：`issue_list` → `draft_create`（或 `draft_show`）→ `plan_explain` → `task_run` → `task_wait`（反复调用）→ `result_show`。
- 想找未知问题：用探索模块（W2-5），不要拿探索代替复现。
- 只想看手机现在是什么样：`device_snapshot`（只读，不点）。

## 3. 先说明再执行
- `task_run` 之前必须先 `plan_explain`，把要发几条消息、发到哪个会话、预计多久、会不会改手机设置告诉用户。
- 返回 30（需要人在 Web 同意）时，把审核页链接给用户，等用户在 Web 上同意后再提交；**不得替用户同意敏感计划、完全授权或环境配置项**（MCP 也没有这样的工具）。
- 返回 31 / 32（计划哈希不一致 / 版本变化）：重新 `plan_explain` 再说明一次，不要直接改参数重试。

## 4. 结论口径
- 「未复现」必须带分母（有效尝试次数与 95% 区间），**不等于「已修复」**。
- 替代执行（例如 iOS 报告在 Android 上复现）只说明替代端的情况，不代表原端。
- 「环境不合格」「工具失败」「SKILL 失效」不是产品结论，不要据此说产品有没有问题；先 `doctor`，修好后重跑。
- 命中要看证据复核结果；被复核排除的命中不算。

## 5. 设备
- 一台手机同一时间只跑一个任务；`device_snapshot` 在手机被任务占用时会拒绝。
- 多台设备在线时，先问用户用哪台，不要自己挑。
- 手机锁屏只能请用户解锁（有 PIN，工具不会也不得代输）。
- 不得执行 `adb kill-server`（测试机会因此丢失 USB 调试授权，需要人重新点允许）；需要重连用 `adb -s <udid> reconnect`。

## 6. 凭据与配置
- 账号密码、模型 Key 永远不经过对话：不要索要，不要回显，不要写进计划或日志。
- 改了 `.env` 或设备配置后，重启 MCP 服务，再调 `doctor` 确认。

## 7. 不改标定与计划
- 不手改标定文件（`skills/teamily/profiles/*`）与计划 / 草稿文件；需要改时告诉用户重新标定（`autotest skill calibrate …`）或重新生成草稿（`draft_create`）。

## 工具一览

| 工具 | 对应命令 | 只读 | 说明 |
|---|---|---|---|
| `issue_list` | `issue list` | 是 | Issue、分类、草稿与计划 id |
| `issue_show` | `issue show` | 是 | 单个 Issue |
| `draft_create` | `draft create` | 否 | 重新起草（可能调模型） |
| `draft_show` | `draft show` | 是 | 草稿与各子用例的 PlanView |
| `plan_explain` | `plan explain` | 是 | 执行前说明：步骤、影响、时长、审批类别、哈希 |
| `plan_approve` | `plan approve` | 否 | 默认类计划按哈希批准；敏感计划返回 30 + 链接 |
| `plan_reject` | `plan reject` | 否 | 拒绝计划（需写原因） |
| `env_list` | `env list` | 是 | 环境与状态 |
| `env_show` | `env show` | 是 | 单个环境：基线项、租约、配置项 |
| `env_check` | `env check` | 否 | 基线检查（能恢复的会恢复） |
| `task_run` | `task run` | 否 | 提交任务，立即返回任务 id（20） |
| `task_status` | `task status` | 是 | 任务进度与状态 |
| `task_wait` | `task wait` | 是 | 单次最多等 25 s；返回 21 表示仍在运行，再调一次 |
| `task_cancel` | `task cancel` | 否 | 取消任务（到下一步边界停下，收尾并恢复环境） |
| `result_show` | `result show` | 是 | 结论句、依据、有效尝试、命中、证据 |
| `doctor` | `doctor` | 否（`fix` 只清本机残留） | 能不能跑、缺什么、下一步 |
| `device_snapshot` | — | 是 | 当前屏幕截图 + 规范化节点（只读） |

不提供：`env recover` / `env offline`（由人或平台执行）、任何"同意"类操作（只能在 Web）。

资源（只读）：`autotest://results/{taskId}`、`autotest://plans/{planId}`、`autotest://reports/{taskId}`、`autotest://files/{path}`（仅 `midscene_run/` 与 `skills/teamily/refs/` 内的文件）。

状态码见 `autotest help --json`（十位是类别：1x 结论、2x 受理 / 仍在运行、3x 需要审批 / 计划不一致、4x 参数、5x 环境、6x 工具、7x 取消 / 超时 / 中断）。
