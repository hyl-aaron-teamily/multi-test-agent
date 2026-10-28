# W2-2 验收记录：可信结论 + 运行清单 / 预检 / 隔离 + 窄范围 MVP（2010、1903）

分支 `feat/w2m2-trustworthy-mvp`。里程碑文档：`dev-week2-milestone2.md`。

## T0 真机探查（2026-10-28，生产 android-app）

设备：Redmi 2211133C（Android 16 / HyperOS OS3.0），Teamily `2.0.15`（versionCode 217），账号 prod-aaron1（测试账号）。
探查用 adb 手工操作 + `uiautomator dump` 读界面树；截图在 `docs/w2m2/`。

### 2010 AI 改写误触覆盖草稿 — **Android 上可见**

- 控件：输入框工具条的星芒按钮，无障碍 `content-desc="强化 prompt"`，`android.widget.Button`；
  键盘收起时 `[522,2211][621,2321]`，键盘弹出时随工具条上移到 `[522,1326][621,1436]`。
  已写入 profile 元素 `chat.rewrite`（键盘收起时的坐标 + 无障碍指纹），`skills/calibrate-android.ts` 以后标定时同样会找它。
- 现象：在 Personal AI 会话里键入草稿 `autotest-2010 rprobe1 1 please write a short greeting to my team`，点星芒：
  键盘收起，约 1–5 s 后输入框内容被替换成一段展开的英文 prompt（「1. Objective … 2. Deliverable …」），
  **没有确认框，工具条上也没有撤销按钮**。原草稿不在输入框里（改写结果引用了草稿里的标签，但不是原文）。
  截图：`docs/w2m2/t0-2010-after-rewrite.png`。
- 对判定的影响：改写结果可能**引用**原草稿，所以判定用「输入框文字 **等于** 原草稿」而不是「包含」。

### 1903 已发送气泡内 @ 不渲染 — **Android 上不可见**

- 在允许清单群（成员均为测试账号 / 用户本人）里键入 `autotest-1903 rprobe1 1 ` → `@` → 选择器（`content-desc` 为成员名的
  `Button` 行，`aaron+test2` 在第一屏）→ 输入框变成 `autotest-1903 rprobe1 1 @aaron+test2 ` → 发送。
- 气泡：`@aaron+test2` 是绿色、单独的可点击节点（`View`，`desc="@aaron+test2"`）；会话列表预览为
  `autotest-1903 rprobe1 1 @aaron+test2`。截图：`docs/w2m2/t0-1903-bubble.png`。
- 结论：Android 2.0.15 上气泡与预览都显示 @。1903 的 MVP 结论预期为「未复现（本轮 n 次有效尝试）+ 3/n 上界」，
  按 §5.1 这是合格结论；两个用例里 2010 可见，所以不触发停止点。

### 探查中发现的工具问题（已修）

- `core/ui-tree.ts`：uiautomator 在文字里含 `"` 时用单引号写属性（`text='… "autotest-2010 rprobe1 1" …'`），原解析只认
  双引号，改写后的输入框被读成空串。已修并加单测。
- 输入法：测试机默认输入法是讯飞（`com.iflytek.inputmethod.miui/.FlyIME`），中文状态下 `adb shell input text` 会被拼音吃掉
  （`autotest` → 「2010－ 1QQ妈的…」）。驱动对带空格 / 符号的文字走 yadb（不经输入法），模式里的草稿都带空格；
  输入法会写进运行清单（T2）。
