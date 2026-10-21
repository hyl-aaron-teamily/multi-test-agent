# 类别 → 计划骨架

| 类别 | 骨架 | 判定 |
|---|---|---|
| bug-intermittent | targets → setup（进入目标会话）→ 循环 actions → 每轮检查点 → afterCheck（恢复状态） | 上限内命中 1 次 = 已复现 |
| bug-always | 同上 | 连续 3 次命中 = 已复现；否则“未复现，疑似已修复” |
| feature | acceptance：每条 Expected/AC 一项（动作 + 一次检查），只跑一次 | 全满足 已实现 / 全不满足 未实现 / 其余 部分实现 |
| suspected-misuse | correctPath 先跑一次，再循环 Issue 路径 | 正确路径正常而 Issue 路径命中 = 疑似误操作；正确路径也异常 = 转为 bug |

通用模板（`issue/planner.ts#templateFor`，按特征选）：
- **@ 选择器**：targets 群（成员 ≥3）+ 另一会话；循环：清空输入框 → 切到另一会话 → 切回 → 键入 @；检查 `mention-picker/picker` present。
- **键盘一次弹出**：循环：返回 → 进会话 → 点一次输入框；ai 检查键盘可见。
- **点赞可见**：targets 群 + 别人的文本消息 + 点赞按钮；循环：长按 → 点赞；ai 检查；afterCheck 再长按 → 取消点赞。
- **通知入口盘点**（feature）：逐页打开，`element:<page>.bell` 应 absent；ai 检查是否存在统一通知中心。
- **@我 聚合**（feature）：ai 检查 Mentions 入口；免打扰群 @ 的显著角标。
- **通用**：进会话 → 滚动历史（不发送）。

动态目标指引见 `vocab.ts#TARGET_GUIDANCE`。
