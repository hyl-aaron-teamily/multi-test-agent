---
name: teamily
description: Black-box test SKILL for the Teamily IM app (web + Android). Fixed UI elements are calibrated to coordinates per execution surface; dynamic targets are chosen by the model at preparation time; the loop runs by coordinates only.
version: 2026.10.21-1
---

# Teamily SKILL

适用版本：Teamily Web（`https://teamily.ai/chat` 生产 / `https://chat-test.teamily.ai/chat` 测试，两者布局不同，分别标定）、Teamily Android `ai.teamily.mobile` 2.0.15。

## 执行端与 profile

| 执行端 | 驱动 | profile |
|---|---|---|
| desktop-web | Playwright 光标（插值移动）+ 键盘，视口 1440×900 | `profiles/desktop-web@<env>.json` |
| mobile-web | Playwright 设备模拟 Pixel 7（触屏，412×839，DPR 2.625） | `profiles/mobile-web@<env>.json` |
| android-app | 常驻 `adb shell` 的 `input tap/swipe/keyevent`，文本 yadb | `profiles/android-<udid>@<env>.json` |

profile = 元素 id → 坐标框 + 自检结果；`refs/<profile>/<page>.png` + 区域（检查点与 SKILL 失效检测用）。
与文档 §B 的差异：profile 名多了 `@<env>` —— 测试与生产两套前端布局不同（实测搜索框、左栏位置均不同），不能共用坐标。

## 页面地图

见 `pages/`：`login.md`、`home.md`、`chat.md`、`mention-picker.md`、`profile.md`、`artifacts.md`。元素词表的单一来源是 `vocab.ts`（标定、计划校验、计划生成提示词都读它）。

## 登录与前置条件

- 账号来自账号池（`platform/accounts.local.yaml`，本地私有）；`teamily.login` 只按坐标点邮箱框 → 键入 → Continue with Email → 密码框 → 键入 → Continue。Web 登录成功后缓存 storageState（`platform/secrets/sessions/<id>.json`），后续任务复用。
- Android 登录态在设备上（`boundDevice`），任务把设备和账号一起租用。
- mobile-web 首次进入会弹“下载移动应用”对话框：执行器用 `refs/.../banner.png` 判断它确实出现后才点 `popup.appBannerDismiss`。
- Android App 会恢复上次界面：启动后若首页导航区不匹配参考，按返回键（最多 3 次，从不越过首页）回到首页。

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
