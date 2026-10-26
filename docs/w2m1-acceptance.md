# W2-1 验收证据（2026-10-26）

需求：`dev-week2-milestone1.md`。环境：生产 `https://teamily.ai/chat`；Xiaomi 2211133C（4f2ebdf2，Android 16，`ai.teamily.mobile` 2.0.15）；本机 Windows 11 + Edge 最大化。运行目录在 `midscene_run/`（本地，不提交）。

## T0 基线（重构前）

- `pnpm typecheck` 通过；`pnpm test:unit` 78/78（11 个文件）。
- 本机实测：`uiautomator dump + cat` 2.6–3.7 s/次；`dumpsys input_method` 120–180 ms；`screencap` 470–560 ms。
- 判定吞吐基线（M5 运行）：1329 s3（键盘，android-app）`1329-2026-10-21T12-51-17-047Z` 210 轮 / 30 分钟 = 7.0 轮/分钟，视觉调用 425 次；1329 s1（点赞）186 轮 / 30 分钟，视觉调用 375 次；1594（区域比对）250 轮 / 927 s，视觉 0 次。

## P0 回归门（T5）

| 项 | 结果 |
|---|---|
| typecheck（tsconfig 现覆盖全部源码目录） | 通过；`--noUnusedLocals` 仅剩 imui/web、旧录屏模块的两处既有告警 |
| test:unit | 124/124（新增 ui-tree、actions、间隔统计、checkpoint、端适配器、模式库 golden 29 条、草稿哈希、logcat 规则） |
| test:web / test:android | 1/1 / 1/1（logcat 离线单测已移入 unit 项目） |
| 证据复核预置用例 | 2/2 · `midscene_run/evidence-cases/2026-10-26T10-14-47-084Z` |
| smoke android-app / desktop-web / mobile-web / android-web | 全部「发送后输入框为空」 |
| lifecycle cold（android-app，2 轮） | 进程在、回首页，0 命中 |
| 1594 desktop-web 20 步 | 未复现，5 轮 20 步（`1594-2026-10-26T10-06-33-348Z`） |
| sync 三端 1 轮 | 全部同步 3/3 · `midscene_run/sync/2026-10-26T10-35-14-248Z` |
| 1329 s2 android-app | 执行失败：「前置条件不存在 — 会话里看不到引用回复」（测试群已被后来的同步消息顶上去）。与重构前行为一致；P2 的前置条件构造解决 |

回归中发现并处理：
- **产品改版**：desktop-web 与 android-web 的首页参考区域对不上（SKILL 失效被正确报出），重新标定：desktop-web 12 元素 0 失败（`artifacts.firstCard` 未找到，进复核队列）；android-web 7 元素 0 失败。
- **既有缺陷**：logcat 异常门把 `FATAL EXCEPTION: UiAutomation`（读界面树的 uiautomator 进程自己的异常）记成 App 闪退。现在 FATAL EXCEPTION 必须来自 App 的 pid。
- desktop-web 首屏等待：固定 8 秒不够（慢加载时仍是骨架列表），改为 8 秒后等首页参考区域（≤30 秒）。
