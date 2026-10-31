# 重构验收记录（`docs/refactor-plan.md`）

每个阶段：代码门 + 真机对照。对照基线是 P0 在重构前代码上的结论。

## P0 基线（2026-10-31，重构前代码 `3d7dc46`）

- 代码门：typecheck / 单测 / 证据复核预置用例全绿，用时 154 s。
- 真机（4f2ebdf2，HyperOS，读树后端 a11y-service v6，prod，完全授权开启）：

| 任务 | 计划 | 结论 |
|---|---|---|
| `t-20261031084319-sq4u` | 2010/main:android-app@v2 | 未复现：6 次有效尝试，95% 上界 ≈ 50% |
| `t-20261031084515-hgyw` | 1903/main:android-app@v1 | 未复现：6 次有效尝试，95% 上界 ≈ 50% |

- golden：草稿 `platform/plans/drafts/{2010,1903}.json`（`3d7dc46`），模板 golden `issue/__golden__/templates.json`。

## P1 删除旧路径（`3a54f25`）

- TS 从 23,959 行降到 17,448 行，删除 6,556 行，删除 70 个文件。
- 代码门（主目录，含 `.env` 与本地允许清单）：typecheck / 单测 / 证据复核全绿，用时 257 s。
- 真机：`t-20261031085704-uxo6` 2010/main:android-app@v2，未复现，6 次有效尝试，与 P0 一致。产物只有 `report.md` / `result.json` / 运行目录，`allure-results/` 文件数不变（18,704），说明 Allure 输出已停止。
- 未验证：平台服务进程（用户终端启动，pid 9228）没有重启，所以 server 删除旧路由后的启动路径还没有实际跑过。任务执行走的是从磁盘新启动的 `task exec` 子进程，已经是 P1 代码。用户重启 `pnpm platform` 后补一次 `doctor` 检查。
- 发现：`issue/contract.spec.ts` 依赖 gitignore 掉的本地文件 `platform/conversations.local.yaml`，干净的检出上会有 2 个用例失败。P4 改为用测试夹具。
