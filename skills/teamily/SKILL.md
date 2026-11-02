---
name: teamily
description: Black-box test SKILL for the Teamily IM app (web + Android). Fixed UI elements are recognised on the live screen by rules (finders.ts) and cached as coordinates per surface@env@app version@screen size; dynamic targets are chosen by the model at preparation time; the loop runs by coordinates only.
version: 2026.11.02-1
---

# Teamily SKILL

适用版本：Teamily Web（`https://teamily.ai/chat` 生产 / `https://chat-test.teamily.ai/chat` 测试，两者布局不同，各有自己的缓存）、Teamily Android `ai.teamily.mobile`（2026-11-02 实测 2.1.1）。

## 执行端与 SKILL 缓存（重构 P3：不再离线标定）

| 执行端 | 驱动 |
|---|---|
| desktop-web | Playwright 光标（插值移动）+ 键盘；Windows 上为 Microsoft Edge 最大化窗口（视口运行时实测），其他系统为无头 Chromium 1440×900 |
| mobile-web | Playwright 设备模拟 Pixel 7（触屏，412×839，DPR 2.625） |
| android-app | 常驻 `adb shell` 的 `input tap/swipe/keyevent`，文本 yadb |
| android-web | 同一台手机的自带浏览器（`com.android.browser`，可用 `ANDROID_BROWSER_PACKAGE` 改），与 android-app 相同的 adb 输入；以 `VIEW` intent + `application_id` 在固定标签页打开网址，不连调试端口 |

- **元素**：`finders.ts` 写明每个元素怎么认（文字 / 无障碍描述、几何规则、Web 只读选择器；纯图标写视觉描述）。循环外第一次用到时在当前屏幕上现场定位（规则优先；只有要点它且规则找不到时才用视觉），结果写进缓存。缓存里有的直接用；预热轮某步核验失败、首页参考对不上时重新定位，App 升级或换分辨率自动换新缓存。
- **参考区域**（检查点、是否在首页 / 聊天页、确认框等）：`finders.ts` 的 `REGION_SPECS` 写明由哪些锚点元素取框；锚点第一次出现在屏幕上时，从实时截图截取存进缓存。循环里只做像素比对。
- **缓存**：`platform/state/skill-cache/<端>@<环境>@<App 版本>@<宽>x<高>/`（本机、不进仓库）。App 升级或换分辨率自动换一份新缓存，不需要人工处理。
- **SKILL 失效**：首页导航区和缓存参考对不上时先重新定位锚点；连锚点（「聊天」入口）都找不到，才报 `SKILL 失效 @ 页面 home`，这时需要更新 `finders.ts` 的规则。

## 页面地图

见 `pages/`：`login.md`、`home.md`、`chat.md`、`mention-picker.md`、`profile.md`、`artifacts.md`。元素词表的单一来源是 `vocab.ts`（现场定位、计划校验、计划生成提示词都读它），识别规则在 `finders.ts`。

## 登录与前置条件

- 账号来自账号池（`platform/accounts.local.yaml`，本地私有）；`teamily.login` 只按坐标点邮箱框 → 键入 → Continue with Email → 密码框 → 键入 → Continue。Web 登录成功后缓存 storageState（`platform/secrets/sessions/<id>.json`），后续任务复用。
- 手机上的登录态在手机上：`platform/devices.yaml` 的 `accounts` 写明 App、浏览器上各登录的是哪个池账号，租用时只给该账号。
- android-web：登录页出现时（按规则认出邮箱输入框）按坐标登录，表单用键盘回车提交（软键盘会盖住按钮）。
- android-web：页面加载后 Teamily 会重新打开上次的会话，此时会话的返回按钮无效（历史为空）。回到列表的路径：打开 `/artifacts` → 点 `nav.chat` → 点 `chat.back`（执行器自动走；判断用 `artifacts/nav`、`chat/composer`、`home/nav` 参考区域）。不要用系统返回键，它会关闭标签页。
- mobile-web 首次进入会弹“下载移动应用”对话框：执行器按规则认出它的「忽略」按钮确实在屏幕上时才点 `popup.appBannerDismiss`（从不靠视觉猜）。
- Android App 会恢复上次界面：启动后若首页导航区不匹配参考，按返回键（最多 3 次，从不越过首页）回到首页。App 重新打开会话时停在上次滚动的位置，读新消息前先上滑到最新。
- Edge 下首次登录的账号会被要求完成新手引导（`/onboarding?required=1`）；有「跳过」时现场定位 `onboarding.skip` 点掉，没有时需先把账号走完一次引导。

## 操作原则

见 `operations.md`。一句话：**循环外现场定位并缓存，循环内只按坐标；截图只在每轮检查点与异常时；视觉模型只在区域对不上时核对。**

## 动态目标（不写死）

`vocab.ts` 的 `TARGET_GUIDANCE` 写明选什么样的群/消息。执行器在准备阶段：
1. 读出屏幕上的会话行（标题 + 预览，web 为渲染行文本，Android 为无障碍层）；
2. 文本模型按指引选一个（无模型时退回规则）；会话内目标（消息、点赞按钮）在进入会话后由视觉模型定位；
3. 冻结为坐标写入执行记录（报告“准备阶段目标”一行）。循环中若发现不在聊天页（操作偏离），重新进入，不计命中。

## 输入框与 AI 改写（W2-2）

- `chat.rewrite`（android-app）：输入框工具条的星芒按钮，无障碍 `desc="强化 prompt"`，**键盘收起时**的坐标（键盘弹出时整条工具条上移，坐标不同）。点它会把输入框里的草稿改写成一段展开的 prompt（原 Issue 2010，2026-11-02 起不再验证；模式 `composer-rewrite` 保留）。
- `teamily.clearComposer`：App 上「聚焦输入框（键盘未弹出时才点）→ 全选（Ctrl+A）→ 删除」，结束时输入框聚焦、键盘弹出；聚焦不上 = 本轮偏离。
- `teamily.tapRewrite`：收起键盘 → 点 `chat.rewrite` → 用像素等改写完成（≤ 10 s，超时 = 偏离，不计尝试）。
- `teamily.tapSend`：把输入框里已有的内容发出去（App：收起键盘 → 点 `chat.send`）。
- `teamily.freezeMention`（prepare-only）：键入 @ → 按字面文字（①）在选择器里找到成员行 → 冻结为目标 → 关闭选择器并清空。循环里按坐标点这个目标。
- 读输入框：`uiautomator` 在文字含 `"` 时用单引号写属性，`core/ui-tree` 两种都认；空输入框的 `text` 等于 `hint`，读作空串。
- 测试机输入法是讯飞，中文状态下 `adb shell input text` 会被拼音吃掉；驱动对带空格 / 符号的文字走 yadb（不经输入法），模式里的草稿都带空格。

## 生命周期动作（计划可用）

`exitApp`（Home，进程保留）、`idle`（不操作，`value` 毫秒，≤ 10 分钟）、`killApp`（杀进程并核实已不在）、`launch`（进程不在时为冷启动）、`reload`（Web 页面重载；App 为杀进程 + 启动）。只能用于 android-app / android-web；它们不计入动作间隔统计，计划内的退出与进程结束不触发异常门，闪退 / ANR 仍照常命中。
