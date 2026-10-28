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

## T1–T8 代码与单次真机验证（2026-10-28）

### 代码门（T8，§8.1）

`sh scripts/code-gate.sh`（= `pnpm code-gate`）：typecheck → 单测（含 golden 与 4 份新 Issue 的期望）→ 证据复核预置用例。
实测 **148 s 全部通过**（typecheck 1 s、单测 170/170 19 s、证据复核 2/2 128 s）。`--no-model` 跳过证据复核。

### 结论口径（T1，§8.2）

- `executor/verdict.ts`：结论只剩「已复现 / 未复现」（bug 类）+ 新增「环境不合格」；代码与新报告里不再出现「疑似已修复」。
- `RunResult.attempts`：总轮数、有效、偏离、命中、单轮命中率、Wilson 95% 区间，0 命中给 3/n 上界（`executor/stats.ts`，单测）。
- 偏离轮（判定前提不成立 / 输入没落下 / 不在聊天页 / 本轮消息不在屏幕上）不进判定规则，单独计数。
- 失败归类 `executor/failure.ts`：环境 / 工具，规则表 + 失败瞬间的设备快照（焦点窗口、亮屏、锁屏、在线），单测覆盖。
- 报告首段三行（触发路径 / 出现位置 / 推测机制，各带依据）；各阶段耗时（租用、预检、启动、登录、准备、预热、循环、收尾）。
- 旧结果按新口径重出：`pnpm autotest rerender midscene_run/issues/2044-2026-10-27T03-45-28-440Z` →
  「未复现（疑似已修复）→ 未复现」，「75 次有效尝试未复现；单次复现概率 95% 上界 ≈ 4%（3/n）」（`report.v2.md`）。

### 运行清单与预检（T2，§8.3–8.4）

- 每次运行写 `manifest.json`（也是 `trajectory.jsonl` 首条事件、报告头），预检失败的运行同样有；字段：git commit（含是否有未提交改动）、SKILL 版本、profile 哈希、草稿哈希、模式、Issue / 子用例 / 端 / 预算 / 停止条件 / 种子（= 运行标记）、设备型号 / Android / HyperOS / App 版本 / 输入法 / 网络 / 电量、账号 id 与会话名、预检各项与设置改动。不含凭据（轨迹的 `scrub` 会删掉键名含 token 的字段，所以运行标记叫 `runTag`）。
- android 预检实测 **0.7–0.8 s**；人为锁屏（电源键）后预检：唤醒 + 上滑仍在锁屏（测试机有密码）→ **3.1 s 得到「环境不合格」**，不启动 App、不产生任何点击。
- HyperOS「文本识别」没有总开关；可控的是 `settings global taplus_blacklist`（按应用）。预检把 `ai.teamily.mobile` 加进去并记录；实测系统会在之后还原该值，所以每次预检都会重写一次（清单里如实记录），长按流程仍保留按需关闭浮层。`stay_on_while_plugged_in` 已是 15（含 USB），无需改动。
- Web 端预检：浏览器能起、登录态有效（`ensureWebSession`），失败 = 环境不合格。

### 隔离（T3）

- 运行标记 `r` + 6 位十六进制；模式文字里的 `{token}` / `{round}` 在执行时替换（2010 草稿、1903 消息、1329 / 2044 构造消息、smoke）；「最新消息」与文字检查都以它为锚。
- 干净起点：App 每次冷启动（`force-stop`）；进会话后读输入框，有草稿就清空、收起键盘。实测：探查留下的草稿「autotest-2010 rprobe2 1」在下一次运行开头被清掉（`clean start: 清空输入框里的旧草稿…；收起键盘`）。
- 收尾：清空输入框、收起键盘、回首页（只做无副作用的复位，不删除、不撤回消息）。
- `5aac6f1` 两处修复真机验证（允许清单群）：只在输入框里的文字 → 「最新消息」定位返回空（不匹配输入框）；`sendMessage` 发送后读输入框为空，再定位到气泡 `(707,1989)`。

### 2010 单次运行（T4）

- 第一次运行：4/6 命中但第 3、6 轮读到原草稿。排查：`tapRewrite` 的参考帧取在键盘收起动画中间，按钮区域一直「忙」，等待逻辑在改写结束前就判了完成 → **工具问题**。改为：参考帧等画面静止后再取；改写中星芒按钮变成旋转的圈（与空闲图标差 ≈ 1300 px），等它回到空闲图标两次才算完成；没转过圈也没变化 = 「没开始」，10 s 还在转 = 超时，两者都记偏离。
- 修复后探查 4 次：都看到转圈（5.6–7.8 s），3 次草稿被替换，**1 次转圈结束后草稿原样保留（5 s 后仍是原文）**——这是产品行为的一种，不是工具漏判。
- 中间一次运行 `midscene_run/issues/2010-2026-10-28T04-44-00-108Z`（只改了「等转圈结束」、还没改参考帧）：**已复现**（第 3、4、5 轮连续命中，5 次有效尝试命中 3 次，Wilson 23.1%–88.2%），证据复核 3/3 符合；第 1、2 轮的未命中可能仍受参考帧问题影响，不作为产品数据。修复完成后的数据见 T6 / T9 系列。

### 1903 单次运行（T5）

`midscene_run/issues/1903-2026-10-28T04-55-36-848Z`：**未复现**，6 次有效尝试、0 偏离，3/n 上界 50%；每轮气泡里都有独立的 `@aaron+test2` 节点；收尾对照会话列表预览也有 `@aaron+test2`。

### Web trace（T7，§8.7）

坏计划门 `npx tsx scripts/w2m1-gate.ts broken --surface desktop-web` → 「计划不可执行」，`report.md` 链接 `w2m1-broken-desktop-web/trace.zip`
（Playwright trace v10，275 项），`npx playwright show-trace …` 打开正常（截图 `docs/w2m2/t7-trace-viewer.png`）。
注意：trace 的 context-options 里带登录 cookie（与 W2-1 现场包的 trace 相同），只落在 gitignored 的 `midscene_run/`。
