# 本轮验收证据（2026-10-22）

需求（按用户确认的顺序）：

1. 先修正 1329：唯一一个「复现」结论是错的——点引用后跳到的就是正确消息，只是窄视窗下气泡换了行。用预置用例让视觉模型分析回放视频，保证复现证据符合 Issue 描述。
2. 安卓：退出 App、杀后台进程、等待、重新加载。
3. 安卓单机同时使用 Web 和 App。
4. Windows 上做 Web 测试：浏览器用 Edge，默认最大化。
5. 设备池工程底座：以运行项目的这台 Windows 笔记本为例，本机 Web 与连接的安卓 Web / App 各登录不同账号同步测试。

环境：生产 `https://teamily.ai/chat`；Xiaomi 2211133C（Android 16，`ai.teamily.mobile` 2.0.15，系统浏览器 `com.android.browser` 20.29）；本机 Windows 11，Microsoft Edge 155（最大化窗口，视口 2040×1148 CSS px，缩放 1.25）。账号：prod-aaron1（手机 App）、prod-aaron3（手机浏览器）、prod-aaron2 / prod-aaron1（本机 Edge）——均为测试账号。运行目录在 `midscene_run/`（本地，不提交）。

## 1. 1329 结论更正与证据复核

| 项 | 结果 | 证据 |
|---|---|---|
| 误报原因 | `1329-2026-10-21T16-43-05-544Z`（s2，android-app）记为「已复现」：基线检查报 "quoted original NOT on screen (13% of its marks missing)"。录屏逐帧看：两轮点引用后都落在被引用的原消息（`@aaron+test1 @aaron+test2` / `@aaron+test3`，窄屏下换成两行，跳转后短暂高亮）。抽查开发期其余几次「已复现」的截图，也不是 Issue 描述的现象（落在了正确位置，或点到外部链接离开了 App，属于操作偏离）；30 分钟正式运行均未复现。 | 本地录屏；`docs/m5-acceptance.md` 已加更正行 |
| 录屏对齐缺陷（顺带修复） | 该录屏比操作日志晚约 2.3 秒：分段起点取的是 scrcpy 进程启动时刻，客户端忙时首帧要晚 0.5–2.5 秒；多段合并时还按墙钟而不是各段实际时长换算。改为取 scrcpy 打印 `Recording started` 的时刻、按各段时长换算；`ops.srt`、查看器跳转、复核取帧共用 `videoTimeOf`。 | `replay/screen-recorder.ts`、`incident/bundle.ts`；新录屏（`1329-2026-10-22T04-32-02-906Z`）画面条中点击与跳转对得上 |
| 证据复核 | 检查类命中写完现场包后，把出事轮与前一轮（参考）的画面条（动作前 2.5 s 至动作后 4 s，每 0.75 s 一帧）和被判定的截图，连同 Issue 的摘要 / 预期 / 实际结果交给视觉模型，3 票多数。「不符」→ 排除、不计命中；连续 3 次排除 → 检查失效，执行失败。 | `incident/evidence-review.ts`、`executor/run.ts` |
| 预置用例 | `fixtures/evidence/1329-s2-quote-wrap`（真实误报，期望「不符」）· `fixtures/evidence/1329-s2-synthetic-old-jump`（阳性对照，期望「符合」）。`pnpm autotest evidence cases`：**2/2 通过**（三次独立运行一致），模型给出的画面描述：前者「落在 16:43 那条 @aaron+test1 @aaron+test2 @aaron+test3 消息，与参考轮同一位置」，后者「落在 2026-09-29 的 chattest #310–#318 旧消息，被引用原消息不在屏上」。 | `midscene_run/evidence-cases/2026-10-22T04-27-29-004Z`、`…06-17-44-407Z`、`…06-38-17-958Z` |
| 端到端 | 用诊断开关 `AUTOTEST_BASELINE_TOLERANCE=0.02` 恢复当时的严格阈值，真机复跑 1329 s2：基线检查两次报出同样的 "13% of its marks missing"，复核两次都判「不符」并排除，结论「未复现（上限内未出现）… 证据复核排除误报 2 次」。 | `midscene_run/issues/1329-2026-10-22T04-32-02-906Z` |

## 2. 安卓退出 / 杀后台进程 / 等待 / 重新加载

计划动作 `exitApp`（Home）、`idle`（不操作，≤ 10 分钟）、`killApp`（`am force-stop` 后核实 `pidof` 为空）、`launch`（进程不在即冷启动）、`reload`；计划内的离开与进程结束不触发异常门（闪退 / ANR 仍命中），不计入 ≤ 1 s 的动作间隔；校验器限制只能用于 App 类执行端。

| 运行 | 结果 |
|---|---|
| App 热：打开会话 → Home → 后台 5 s → 重开，2 轮 | 进程存在，回到原聊天页（`chat/composer` 0%），0 命中 · `lifecycle-warm-android-app-prod-2026-10-22T04-12-25-816Z` |
| App 冷：… → 杀进程（核实已死）→ 等 5 s → 冷启动，2 轮 | 新进程存在，回到首页（`home/nav` 0%），0 命中；重构后复跑同样通过 · `lifecycle-cold-android-app-prod-2026-10-22T04-13-15-942Z`、`…06-22-34-842Z` |
| 手机浏览器热 / 冷，各 2 轮 | 热：仍在原会话；冷：杀浏览器后重新打开网址，Teamily Web 恢复到上次会话；均 0 命中 · `lifecycle-warm-android-web-prod-2026-10-22T06-24-22-245Z`、`lifecycle-cold-android-web-prod-2026-10-22T06-25-48-171Z` |

## 3. 安卓单机同时使用 Web 与 App

- 新执行端 `android-web`：同一台手机的系统浏览器，和 App 一样只用 adb 输入与截屏（连浏览器调试端口的方案被否决：不符合黑盒原则）。以 `VIEW` intent + `application_id` 在固定标签页打开网址。
- 标定 `pnpm autotest skill calibrate --surface android-web --env prod`：7 个元素，**0 自检失败**（`skills/teamily/profiles/android-web-4f2ebdf2@prod.json`）。浏览器的无障碍树只在页面加载时建立，标定时用浏览器自带刷新重新加载后再读；密码页 / @ 选择器 / 输入时的发送键由视觉模型定位。
- 冒烟：按坐标打开 Personal AI（小 T）并发送，输入框清空 · `smoke-android-web-prod-2026-10-22T05-59-37-132Z`。
- 同时使用：`pnpm autotest sync --roles android-web,android-app --rounds 2`，浏览器登 aaron+test3、App 登 aaron+test1，进同一群互发：**4/4 可见** · `midscene_run/sync/2026-10-22T06-54-26-687Z`。同一屏幕由执行器轮流切到前台，让出前台的一端不记「离开 App」。

## 4. Windows 上用 Edge（默认最大化）做 Web 测试

- Windows 上 `desktop-web` 默认 `channel: msedge`、有头、`--start-maximized`、`viewport: null`（页面尺寸 = 最大化窗口）；关闭遮挡节流，窗口被盖住时截图与检查照常。`AUTOTEST_DESKTOP_BROWSER=chromium` 可回到无头 1440×900。
- 标定读取实际视口与缩放（2040×1148，1.25）：**14 个元素，0 自检失败**（含 CloudDoc 新标签页）。首页有效性标记改为会话列表上方的搜索行（左栏带各账号不同的未读角标，换账号就对不上）。
- 冒烟：Edge 中按坐标打开 Personal AI 并发送 · `smoke-desktop-web-prod-2026-10-22T06-31-44-721Z`。
- 发现：Edge（中文环境）下新登录会被要求完成 5 步新手引导 `/onboarding?required=1`（Chromium 无头不出现）；测试账号已各走一次，引导页若提供「跳过」会被标定为 `onboarding.skip`。

## 5. 设备池底座与多账号同步测试

- `platform/device-pool.ts`：手机与本机都是端点；任务按「端点 × 执行端」租槽（手机：`android-app`、`android-web`；本机 `host:local`：`desktop-web` 2、`mobile-web` 4）；一个任务可持多槽，`maxConcurrent` 按任务计；`devices.yaml` 的 `accounts` 记录手机上 App / 浏览器各登录的池账号，租用时只给该账号，本机端取剩下的空闲账号。
- `pnpm autotest sync`（`executor/sync.ts`；控制台「多端同步」任务）：各端租槽和账号 → 启动、登录、回到列表 → 模型选同一个群 → 每轮一端发唯一文本，其余端轮询核对（App 读无障碍文本，Web 看截图）→ 报告每端是否可见、发送到看到的时间、截图。
- 三端（本机 Edge aaron+test2 · 手机浏览器 aaron+test3 · 手机 App aaron+test1），3 轮：**9/9 可见**，三次 · `midscene_run/sync/2026-10-22T06-08-47-360Z`、`…06-39-10-068Z`、`…06-56-01-951Z`。

**发现（同步测试检出，产品侧）**：手机单机两端（浏览器发、App 收）时，App 刚打开会话后第一次切到后台、期间收到的消息，回到前台后 45–60 秒内都不显示（14–15 次核对，屏幕底部也没有新消息提示）；App 自己发出下一条后，这条才出现。**3/3 次复现**，均在第 1 轮：`midscene_run/sync/2026-10-22T06-43-39-349Z`、`…07-19-08-737Z`、`…07-23-58-887Z`（截图 `r1-android-app.png`）。同一运行里之后的轮次（App 已有过一次前后台切换或刚发过消息）都在约 5 秒看到；三端运行中 App 准备后要等 Edge 端准备，第 1 轮同样正常。复现路径：App 打开群聊 → 切到浏览器（App 进后台）→ 浏览器用另一账号发消息 → 回到 App。

进一步排查：
- 不是时序巧合：`--settle 40`（所有端就绪后等 40 秒再发第 1 轮）照样复现，4/4 · `midscene_run/sync/2026-10-22T07-30-27-531Z`。
- 不是核对误判：未出现时的截图里该会话停在最底部、无新消息提示；核对用的无障碍文本与截图一致。
- App 补收的方式：App 发出 r2 后，r1 才出现，而且排在 r2 **下面**（`073027 r2 android-app` 之后才是 `073027 r1 android-web`；`071908` 那次同样 r2 在 r1 之上）——说明 r1 没有被推送到 App，是 App 发消息时补拉回来的，并按到达顺序而不是发送时间插入。黑盒层面能确定的就是这些：「回到前台后不补拉后台期间的消息，直到用户自己发送；补到的消息显示顺序错乱」。同一运行里浏览器端自检的一次「未出现」是核对误判（气泡末尾被悬浮的「@」按钮挡住），已改为按唯一编号核对。

## 回归

- `pnpm typecheck` 通过；`pnpm test:unit` **77/77**（新增：视频时间换算、复核取帧窗口与投票、生命周期动作校验、端点池分槽、按手机登录账号租用、多端同步任务校验）；`pnpm test:web` 1/1；`pnpm test:android` 5/5。
- 控制台「多端同步」任务：任务校验与参数由单测覆盖；本机 3210 端口已有一个控制台实例在跑，本轮未经控制台实跑。

## 已知限制

- 同步耗时是「发送 → 某次核对看到」，含切换手机前台与视觉核对（约 5 秒）的时间，只是上界。
- Teamily Web 重新加载后会自动打开上次会话，此时会话的返回按钮无效（浏览器历史为空）；执行器经 Artifacts → 聊天 → 返回回到列表。
- 多角色的 Issue（1919、2235、2122 的第二账号部分）还没有生成多角色计划，仍是暂缓。

## 复查中修复的问题

- 执行器给所有执行端都钉了 `--device`（手机序列号）：控制台下发 Issue 任务时总会带 `--device`，其中的 Web 子用例因此租不到本机槽而失败。现在只对 Android 执行端钉设备。验证：`pnpm autotest run --issue 2336 --yes --device 4f2ebdf2` 在 Edge 中完成 4 项验收，结论「未实现」（与 M5 一致）· `midscene_run/issues/2336-2026-10-22T07-36-39-819Z`。
- 已知约束：槽位租用记在各自进程的端点池里，控制台进程与命令行直接运行的任务彼此看不到对方占用的槽；同时从两处对同一台手机下任务会冲突。

## 默认时限

按用户要求，任务默认时限由 30 分钟降为 **15 分钟**：`DEFAULT_LIMITS.maxMinutes`、已保存的计划（`platform/plans/*.json`、草稿）、控制台任务硬上限（Issue 为 时限×4+15，自然语言任务 时限+5，其它类型 `TASK_HARD_MINUTES` 默认 15）、生命周期冒烟计划。
