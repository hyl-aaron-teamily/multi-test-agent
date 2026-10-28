# 类别 → 计划骨架

| 类别 | 骨架 | 判定 |
|---|---|---|
| bug-intermittent | targets → setup（进入目标会话）→ 循环 actions → 每轮检查点 → afterCheck（恢复状态） | 上限内命中 1 次 = 已复现；否则「未复现」+ 有效尝试数 + 区间 / 上界 |
| bug-always | 同上 | 连续 3 次命中 = 已复现；否则「未复现」+ 有效尝试数 + 3/n 上界（W2-2：不写「已修复」） |
| feature | acceptance：每条 Expected/AC 一项（动作 + 一次检查），只跑一次 | 全满足 已实现 / 全不满足 未实现 / 其余 部分实现 |
| suspected-misuse | correctPath 先跑一次，再循环 Issue 路径 | 正确路径正常而 Issue 路径命中 = 疑似误操作；正确路径也异常 = 转为 bug |

## 模式库（`patterns.ts`，W2-1）

计划由「意图契约」选出的模式确定性生成（契约见 `platform/schema/contract.ts`）。每个模式 = 触发语义 + 所需前置条件（`preconditions.ts`）+ 观察（`executor/observe.ts#OBSERVATIONS`）+ 计划片段。

| 模式 | 触发语义 | 观察（各端判定层） | 前置条件 |
|---|---|---|---|
| `mention-picker` | 切换会话后键入 @ | 区域 `mention-picker/picker`（①，不一致才 ③） | 成员 ≥3 的群 + 另一会话 |
| `quote-jump` | 点引用块 | 第 1 轮无障碍确认原消息，之后像素比对（①） | 已有引用回复 |
| `quote-preview-text` | 查看引用块预览 | 引用块文字不含 `](https://`（① 无障碍文字） | **构造**：在允许清单会话发 Markdown 链接消息并引用回复 |
| `keyboard-single-tap` | 点一次输入框 | 手机：`dumpsys input_method`（①）；其他端 ③ | 群 |
| `like-visible` | 长按 → 点赞 | App：消息下方的「👍」无障碍节点（①）；其他端 ③；afterCheck 取消点赞 | 群 + 别人的文本消息 |
| `lifecycle` | 退出 / 后台 / 杀进程 / 重开 | 进程存活（①）+ 首页 / 聊天页区域（①） | — |
| `notification-inventory`（feature） | 逐页盘点 | 元素区域（①）+ 统一通知中心（③） | — |
| `mention-aggregation`（feature） | 查看会话列表 | ③ | 免打扰且被 @ 的群 |
| `composer-rewrite`（2010） | 键入带运行标记的草稿 → `require` 输入框含草稿 → 点 AI 改写 | 输入框文字**等于**原草稿（① 无障碍；改写可能引用草稿，所以不用「包含」）；每次运行最多 6 次有效尝试 | Personal AI 会话（不发送） |
| `mention-render`（1903） | 键入带运行标记的文字 → @ → 点冻结的成员行 → `require` 输入框含 @成员 → 发送 | 本轮最新一条含该文字的气泡里有独立的 `@成员` 节点（①）；没有这条气泡 = 偏离；收尾对照会话列表预览（只记录） | **构造**：允许清单群，成员取 `construct.member`；每轮 1 条 |
| `generic-browse` | 进会话滚动历史 | 只看崩溃（①）—— 用作兜底时报告标注「计划未覆盖 Issue 现象」 | 群 |

通用模板（`issue/planner.ts#templateFor`，按特征选）：
- **@ 选择器**：targets 群（成员 ≥3）+ 另一会话；循环：清空输入框 → 切到另一会话 → 切回 → 键入 @；检查 `mention-picker/picker` present。
- **键盘一次弹出**：循环：返回 → 进会话 → 点一次输入框；ai 检查键盘可见。
- **点赞可见**：targets 群 + 别人的文本消息 + 点赞按钮；循环：长按 → 点赞；ai 检查；afterCheck 再长按 → 取消点赞。
- **通知入口盘点**（feature）：逐页打开，`element:<page>.bell` 应 absent；ai 检查是否存在统一通知中心。
- **@我 聚合**（feature）：ai 检查 Mentions 入口；免打扰群 @ 的显著角标。
- **退出 / 杀后台 / 重新加载**（android-app、android-web）：setup 打开会话；循环 `exitApp` → `idle`（后台等待）→ [`killApp` → `idle`] → `launch`（浏览器冷启动后再 `idle` 等页面加载）；检查 `process-alive` present + 冷启动 `home/nav`（App）或 `chat/composer`（浏览器、热启动）present；冷启动 App 用 afterCheck 重新打开会话。
- **通用**：进会话 → 滚动历史（不发送）。

W2-2 计划字段：`require` 动作（本轮判定前提，① 读一次；不成立 = 偏离，不计有效尝试）、`limits.maxRounds`（有效尝试上限）、`epilogue`（循环后一次、只记录）、文字里的 `{token}` / `{round}`（运行标记 / 轮号，执行时替换）、文字检查范围 `composer` 与 `{ message: <锚点文字> }`。

动态目标指引见 `vocab.ts#TARGET_GUIDANCE`。
