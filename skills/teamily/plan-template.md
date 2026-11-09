# 计划骨架（W3-1 起：模型从零设计，不套模板）

每份 Issue 由模型读原文、只用积木从零设计测试用例，规范见 `skills/plan-authoring/SKILL.md`。积木目录由执行端代码生成（`issue/catalog.ts`：动作原语、Node 及其 `phase`、固定元素、参考区域、目标类型、观察）。不再有模式库、规则模板和通用浏览兜底；需要的积木不存在时，草稿标为 `needs-block` 并写明缺什么，由人补积木。

| 类别（只由 Frequency 决定，或人工 override） | 骨架 | 判定 |
|---|---|---|
| bug-always / bug-intermittent | targets（带 `must`）→ setup（进入场景）→ prepare（构造，只跑一次）→ 每轮：`baseline` → actions（现象发生处带 `expect`）→ 轮末 checks → afterCheck（复位，带 `expect` 核实） | 每版计划跑满预算（30 次有效尝试或 15 分钟，命中不停）：复现率 = 证据复核一致的命中 ÷ 有效尝试（Wilson 区间）；没能复现 = 「计划 v1–vK 未能复现」，附诊断，最多修订到 v3 |
| multi-account（人工 override，如 2235） | 多端协同计划：每轮一端发一条，其余端都要看到 | 有一条某端没看到 = 已复现 |
| deferred / not-executable | 无计划，一页报告写明原因 | — |

计划字段（`platform/schema/test-plan.ts`）：
- `PlannedAction.expect = { role: phenomenon | precondition, check }`：动作做完立即读一次 ①（text / keyboard / process-alive / visual-region）。phenomenon 不通过 = 命中；precondition 不通过 = 本轮偏离。
- `TestPlan.baseline`：每轮第一个动作前读；不成立 = 偏离。
- `targets[].must = { sender, content, contains }`：准备阶段读界面树核对，连续 3 次不通过 = 执行失败。
- `TestPlan.audit`：模型交付的原文片段、理解、可行性、判定依据、追溯、自查、风险、修订说明和版本号（进入草稿哈希）。
- 文字检查范围：`screen` / `composer` / `quote-cards` / `{ target, within, withinX }` / `{ message: <锚点> }` / `{ targetBubble: <目标 id> }`（目标消息的气泡 + 下方反应行）。
- 其他：`require` 动作（本轮前提，① 读一次）、`limits.maxRounds` / `limits.untilBudget`、`epilogue`、文字里的 `{token}` / `{round}`。

预热轮：先读基线和现象检查（现象检查在触发前必须判「不通过」，证明有区分度；对照组触发后必须判「通过」），再逐步核验动作效果和 `expect`，最后核实复位。

动态目标类型见 `issue/catalog.ts#TARGET_KINDS`（含 `vocab.ts#TARGET_GUIDANCE`）。
