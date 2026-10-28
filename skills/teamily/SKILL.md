---
name: teamily
description: Black-box test SKILL for the Teamily IM app (web + Android). Fixed UI elements are calibrated to coordinates per execution surface; dynamic targets are chosen by the model at preparation time; the loop runs by coordinates only.
version: 2026.10.28-1
---

# Teamily SKILL

适用版本：Teamily Web（`https://teamily.ai/chat` 生产 / `https://chat-test.teamily.ai/chat` 测试，两者布局不同，分别标定）、Teamily Android `ai.teamily.mobile` 2.0.15。

## 执行端与 profile

| 执行端 | 驱动 | profile |
|---|---|---|
| desktop-web | Playwright 光标（插值移动）+ 键盘；Windows 上为 Microsoft Edge 最大化窗口（视口按标定时实测，本机 2040×1148，缩放 1.25），其他系统为无头 Chromium 1440×900 | `profiles/desktop-web@<env>.json` |
| mobile-web | Playwright 设备模拟 Pixel 7（触屏，412×839，DPR 2.625） | `profiles/mobile-web@<env>.json` |
| android-app | 常驻 `adb shell` 的 `input tap/swipe/keyevent`，文本 yadb | `profiles/android-<udid>@<env>.json` |
| android-web | 同一台手机的自带浏览器（`com.android.browser`，可用 `ANDROID_BROWSER_PACKAGE` 改），与 android-app 相同的 adb 输入；以 `VIEW` intent + `application_id` 在固定标签页打开网址，不连调试端口 | `profiles/android-web-<udid>@<env>.json` |

profile = 元素 id → 坐标框 + 自检结果；`refs/<profile>/<page>.png` + 区域（检查点与 SKILL 失效检测用）。
与文档 §B 的差异：profile 名多了 `@<env>` —— 测试与生产两套前端布局不同（实测搜索框、左栏位置均不同），不能共用坐标。

## 页面地图

见 `pages/`：`login.md`、`home.md`、`chat.md`、`mention-picker.md`、`profile.md`、`artifacts.md`。元素词表的单一来源是 `vocab.ts`（标定、计划校验、计划生成提示词都读它）。

## 登录与前置条件

- 账号来自账号池（`platform/accounts.local.yaml`，本地私有）；`teamily.login` 只按坐标点邮箱框 → 键入 → Continue with Email → 密码框 → 键入 → Continue。Web 登录成功后缓存 storageState（`platform/secrets/sessions/<id>.json`），后续任务复用。
- 手机上的登录态在手机上：`platform/devices.yaml` 的 `accounts` 写明 App、浏览器上各登录的是哪个池账号，租用时只给该账号。
- android-web：登录页出现时（`refs/.../login.png` 的表单区域匹配）按坐标登录，表单用键盘回车提交（软键盘会盖住按钮）。标定在已登录的浏览器上进行时保留上一次的登录元素。
- android-web：页面加载后 Teamily 会重新打开上次的会话，此时会话的返回按钮无效（历史为空）。回到列表的路径：打开 `/artifacts` → 点 `nav.chat` → 点 `chat.back`（执行器自动走；判断用 `artifacts/nav`、`chat/composer`、`home/nav` 参考区域）。不要用系统返回键，它会关闭标签页。
- mobile-web 首次进入会弹“下载移动应用”对话框：执行器用 `refs/.../banner.png` 判断它确实出现后才点 `popup.appBannerDismiss`。
- Android App 会恢复上次界面：启动后若首页导航区不匹配参考，按返回键（最多 3 次，从不越过首页）回到首页。App 重新打开会话时停在上次滚动的位置，读新消息前先上滑到最新。
- Edge 下首次登录的账号会被要求完成新手引导（`/onboarding?required=1`）；有「跳过」时标定为 `onboarding.skip`，没有时需先把账号走完一次引导。

## 操作原则

见 `operations.md`。一句话：**标定期读结构，执行期只按坐标；截图只在每轮检查点与异常时；视觉模型只在区域对不上时核对。**

## 动态目标（不写死）

`vocab.ts` 的 `TARGET_GUIDANCE` 写明选什么样的群/消息。执行器在准备阶段：
1. 读出屏幕上的会话行（标题 + 预览，web 为渲染行文本，Android 为无障碍层）；
2. 文本模型按指引选一个（无模型时退回规则）；会话内目标（消息、点赞按钮）在进入会话后由视觉模型定位；
3. 冻结为坐标写入执行记录（报告“准备阶段目标”一行）。循环中若发现不在聊天页（操作偏离），重新进入，不计命中。

## 标定与失效

- `pnpm autotest skill calibrate --surface <s> --env <e> [--device <udid>]`：找元素 → 写坐标 → 逐个自检（点击/聚焦后截图看预期变化：输入框键入探针、页面跳转、弹层出现）→ 失败项进入 `reviewQueue` 并生成标注图 `refs/<profile>/review-<id>.png`，只有这些需要人看。
- 执行开始时比对首页导航区；不匹配 → `SKILL 失效 @ 页面 home`，停止并提示重新标定。
- `pnpm autotest skill smoke --surface <s> --env <e>`：按坐标“打开会话 → 发一条消息”（发到自己的 Personal AI）。
- `pnpm autotest skill smoke --surface android-app|android-web --lifecycle warm|cold`：退出（Home）→ 后台等待 → [杀进程 → 等待] → 重开；App 冷启动应回首页，浏览器冷启动应重新加载并回到上次会话。

## 输入框与 AI 改写（W2-2）

- `chat.rewrite`（android-app）：输入框工具条的星芒按钮，无障碍 `desc="强化 prompt"`，**键盘收起时**的坐标（键盘弹出时整条工具条上移，坐标不同）。点它会把输入框里的草稿改写成一段展开的 prompt，没有确认、没有撤销（Issue 2010 在 Android 2.0.15 上可见）。
- `teamily.clearComposer`：App 上「聚焦输入框（键盘未弹出时才点）→ 全选（Ctrl+A）→ 删除」，结束时输入框聚焦、键盘弹出；聚焦不上 = 本轮偏离。
- `teamily.tapRewrite`：收起键盘 → 点 `chat.rewrite` → 用像素等改写完成（≤ 10 s，超时 = 偏离，不计尝试）。
- `teamily.tapSend`：把输入框里已有的内容发出去（App：收起键盘 → 点 `chat.send`）。
- `teamily.freezeMention`（prepare-only）：键入 @ → 按字面文字（①）在选择器里找到成员行 → 冻结为目标 → 关闭选择器并清空。循环里按坐标点这个目标。
- 读输入框：`uiautomator` 在文字含 `"` 时用单引号写属性，`core/ui-tree` 两种都认；空输入框的 `text` 等于 `hint`，读作空串。
- 测试机输入法是讯飞，中文状态下 `adb shell input text` 会被拼音吃掉；驱动对带空格 / 符号的文字走 yadb（不经输入法），模式里的草稿都带空格。

## 生命周期动作（计划可用）

`exitApp`（Home，进程保留）、`idle`（不操作，`value` 毫秒，≤ 10 分钟）、`killApp`（杀进程并核实已不在）、`launch`（进程不在时为冷启动）、`reload`（Web 页面重载；App 为杀进程 + 启动）。只能用于 android-app / android-web；它们不计入动作间隔统计，计划内的退出与进程结束不触发异常门，闪退 / ANR 仍照常命中。
