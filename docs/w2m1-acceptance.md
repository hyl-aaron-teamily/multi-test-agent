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

## P1 观察库 + 分层（T6–T8）

| 项 | 结果 | 运行 |
|---|---|---|
| 1329 s3 键盘（android-app，15 分钟） | **315 轮**（21 轮/分钟，基线 7.0 的 3 倍）；循环与检查点视觉调用 **0**（`① keyboard-shown` ×315，平均 133 ms，`dumpsys input_method`）；最大动作间隔 967 ms；结论 未复现 | `1329-2026-10-26T10-42-05-769Z` |
| 1329 s1 点赞：无障碍可读性核实 | 真机核实：长按菜单的表情是可点节点（uiautomator 以 `&#128077;` 写出 👍，已解码）；点赞后消息正下方出现「👍」节点；菜单有「回复」。点赞模式在 App 上改为 ① 文字检查（目标消息 ±160 px） | 本节探针（`.m5tmp/likeprobe*.ts`） |
| 1329 s1 点赞（android-app，15 分钟） | 128 轮（8.5 轮/分钟，基线 6.2）；循环视觉调用 **0**（`① text` ×129，每次读界面树约 2.9 s——每轮一次，不计入动作间隔）；准备期视觉 1 次（定位「别人的消息」）；结论 未复现。有 2 个动作间隔超过 1 s（最大 5.8 s，出现在操作偏离后的重进中，M5 基线运行最大 9.8 s） | `1329-2026-10-26T10-59-40-618Z` |
| sync 三端 3 轮 | 9/9 可见；**投递核对全部 ①**：desktop-web 读页面文字 ×3（平均 11 ms，此前每次视觉约 5 s）、android-app 无障碍 ×4、android-web 无障碍 ×3；视觉调用 1 次（准备期选群） | `midscene_run/sync/2026-10-26T11-24-30-783Z` |
| 报告「判定分层统计」 | 每份运行报告列出各层判定 / 定位次数与平均耗时，模型调用按用途（prep / checkpoint / warmup …）计数 | 上述各 `report.md` |

## P2 契约两阶段（T9–T11）

- 10 份 Issue（`pnpm autotest plan`）：可执行 5 份的每个子用例都有契约（规则阶段：命中设备验证过的模式），1919 / 2235（多账号）与 2230（存储）为暂缓并附契约，写明不可构造的前置条件（`second-account` / `browser-storage-full`）；1614 / 1922 照旧拒绝。确认单（CLI / 控制台）显示前置条件与建立方式、触发语义、可观察后置条件与现象、计划来源（模式 / 模型组合 / 通用模板）和覆盖标注，以及草稿哈希。
- 回归一致：模式库 golden（`issue/__golden__/templates.json`）对 1594 / 1329 / 2122 / 2336 全部子用例 × 四端与迁移前逐字段相等；有意改变的只有 P1 的手机键盘 / 点赞判定和 2044。
- 1329 s2 的 mobile-web 子用例：确认到 mobile-web 时由 `quote-jump` 模式按该端重建（单测），不再是通用浏览。
- **2044 端到端（生产，iOS → android-app 替代，一次性确认）**：契约 = 前置条件「含 Markdown 链接的消息被引用回复」[construct] + 触发 `view-quote-preview` + 观察 `text`。准备阶段在允许清单内的会话（`黄悦龙Aaron, 黄悦龙-AgentEval, aaron+test2`）发出 `[url](url)` 并引用回复（`teamily.quoteReply`：① 无障碍定位消息与「回复」菜单项）；预热 2/2 步通过；循环中引用块文字读到 `aaron+test1, [https://github.com/TensorOpera-Inc/chat-web/pull/654](https://gith…` —— **连续 3 轮命中，结论「已复现」**（Android 上引用块预览同样输出 Markdown 源码，原消息气泡则正常渲染为链接）；3 次证据复核均「符合」；循环判定全部 ①（4 次），视觉调用只有准备期 1 次 + 证据复核 6 次。`2044-2026-10-26T11-18-20-205Z`
  - 过程中修复：prepare-only Node 用了录制包装器而不是设备驱动去定位；`quoteReply` 等待刚发出的消息渲染；引用块范围过滤（x > 宽度 20% 漏掉了这张卡片）。
- 1594（desktop-web，5 分钟，与手机 s1 运行同时进行）：第 73 轮区域检查失败，视觉与证据复核都判「选择器未弹出」，结论「已复现」。**人工复看判定截图：输入框是空的，键入的「@」不在输入框里**——更像是输入没有落入（同一时间手机端在同群点赞，页面在重绘），不是 Issue 描述的「键入 @ 后选择器不弹出」。不作为复现结论。**已处理**：检查可声明自身前提（`requires.composerHas`），选择器检查失败时先 ① 读输入框内容，没有「@」就记为操作偏离、不计命中。复跑 1594（6 分钟，92 轮）：第 92 轮再次出现同样的「输入框为空」，被识别为操作偏离，结论 未复现 —— 确认上次的「命中」是输入未落入，不是 Issue 现象。`1594-2026-10-26T11-05-44-344Z` → 复跑见下方「补充」

## P3 预热闸门 + 指纹（T13–T14）

| 项 | 结果 |
|---|---|
| 正常计划的预热 | 1594（4 步，2 步核验）、1329 s1（2 步）、2044（3 步）、lifecycle warm（4 步：离开前台 ① logcat、进程在 ① pidof）全部通过，`warmup.json` 记录每步预期 / 观察 / 判定层 / 点击点指纹 |
| 不可执行计划（desktop-web，临时 profile 副本中 `nav.me` 错位） | 预热第 1 步「画面变化」未出现（Δ0 px，阈值为屏幕 1%）→ **「计划不可执行」**，未进入循环；正式 profile 未改。过程中发现固定 2000 px 阈值被桌面光标 / 悬停噪声（约 12k px）骗过，改为屏幕像素的 1% |
| 坐标自愈（android-app，临时副本中 `chatlist.search` 上移 150 px） | 预热第 1 步失败 → 按指纹「搜索」在无障碍树中找回 `[44,125]→[44,275]` → 重做通过，循环继续；报告「坐标自愈」一节 + `healed-profile.json` 候选；`skills/teamily/profiles/` 未被自愈修改（android-app 已重新标定以记录指纹） |
| 回写草稿 | 「计划不可执行」写入草稿 `warmupFailures`，下次确认单显示 |

## P4 轨迹记录 + TencentDB Agent Memory（T12、T15）

- 每次运行写 `trajectory.jsonl`（`trajectory-v1`）：如 2044 运行 49 条（plan / contract / lease / prep.target / warmup.step / op / observe / hit / incident / verdict …），lifecycle warm 运行含 `model-call`。凭据类字段一律剔除（单测）。
- TDAI MemoryCore 复制到 `tools/tdai/`（`ref/` 未动），`pnpm install --ignore-workspace --ignore-scripts` 安装，Windows 11 上 `node --import tsx src/gateway/server.ts`（standalone，`127.0.0.1:8420`，SQLite，**不配置 LLM key**）启动成功。
- `TRAJECTORY_TDAI_URL=http://127.0.0.1:8420`：1329 s1、1594、2044（4 次）运行各在 `tools/tdai/data/sessions/offline/_unassigned/prod-aaron1/<run>/` 下留下一条记录；2044 记录的 `messages` 49 条与 `trajectory.jsonl` 一致，`output.conclusion` = 已复现。
- 网关不可达（`http://127.0.0.1:9`）：只打印一次「TDAI gateway unreachable (run unaffected)」，结论不变（`计划不可执行` 测试运行）。

## 最终回归

`pnpm typecheck` 通过；`pnpm test:unit` 138/138；`test:web` 1/1；`test:android` 1/1；证据复核预置用例 2/2（`2026-10-26T11-33-38-898Z`）；smoke desktop-web / mobile-web / android-app 均发送成功。

## 补充（Stop 检查后完成的项）

| 项 | 结果 |
|---|---|
| android-web 回归 | 手机浏览器一直停在「连接中…」（主机 Web 同时正常）；按用户方式冷启动浏览器后恢复，smoke **发送成功**（沿用 10:31 的标定，仍有效）。标定器补了「等列表加载 / 无障碍树滞后时由视觉找群行」，中止的标定不再改动参考图 |
| Web 指纹 + Web 自愈 | desktop-web 重新标定，元素记录无障碍名 / 文本指纹（如 `nav.chat` = label「聊天」，`chat.send` =「发送」）；临时副本中 `nav.chat` 挪到页面中部 → 预热失败 → 按 label「聊天」找回 `[1224,574]→[14,84]` → 重做通过 |
| 1594 判定前提 | 见 P2 一节：复跑 92 轮，同类情形被识别为操作偏离 |
| android-web 重新标定 | 冷启动浏览器后标定：**7 元素 0 自检失败**。修复标定器：浏览器地址栏（提示也是「搜索…」）被当成会话搜索框、慢页面的自检重试、头像「我」的视觉兜底、列表晚到时等待 / 视觉找群行。新 profile 下 smoke 发送成功、lifecycle warm 2 轮 0 命中。同时修复准备期把底栏「智能体」当成会话行（浏览器无障碍树） |
| mobile-web 重新标定 | 生产页新出现「开启通知」浮条盖住页头（返回 / 头像点了没反应）。Web 端适配器与标定器都像用户一样先关掉它；mobile-web **14 元素 0 失败** |
| 1329 s2 端到端 | 引用跳转模式改为在允许清单会话中**构造**前置条件（发一条普通消息 + 引用回复）。android-app：20 轮，未复现；**mobile-web（经确认换端，模式按该端重建）**：15 轮，未复现（Web 第 1 轮由视觉确认一次落点，之后区域比对 ①）|
| 最终回归（补充后） | typecheck 通过；unit 138/138；smoke 四端全部发送成功；证据复核 2/2（`2026-10-26T13-07-58-171Z`）|

已知问题（如实记录）：
- **android-web**：手机浏览器偶发长时间「连接中…」，需冷启动浏览器恢复（标定前先冷启动）。
- 1329 s2 构造的被引用消息就在引用回复正上方，跳转距离短；它验证「跳转落点正确」，不模拟「跳到很久以前的消息」那种长距离历史。
