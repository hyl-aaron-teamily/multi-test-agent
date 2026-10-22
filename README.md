# multi-test-agent

> 项目介绍页：[docs/intro.html](docs/intro.html)（浏览器直接打开）· 验收证据：[docs/m5-acceptance.md](docs/m5-acceptance.md) · 历史变更：[CHANGELOG.md](CHANGELOG.md)

Teamily 客户端测试台：在 **Android 真机、手机 Web、桌面 Web** 三个执行端上，以**黑盒**方式（只做用户能做的操作、只看用户能看到的现象）复现和验收问题，并留下可回放的证据。

主线是 **Issue 驱动**：把一份 Issue 文档交给测试台，它会判断这是什么类型的问题、生成测试计划，经你确认一次后在生产环境执行，最后给出结论、证据包和报告。另有自然语言任务、AI 探索、Monkey、IM 界面层收发测试等入口，都在同一个控制台里。

## 现状一览（2026-10-22）

| 能力 | 状态 | 说明 |
|---|---|---|
| Issue 分类与计划 | ✅ 可用 | 10 份样例 Issue 全部分类；可执行的生成计划，服务端 / 空文档出拒绝报告，多账号 / 需新能力的出暂缓报告 |
| 黑盒执行（三端） | ✅ 可用 | 按 SKILL 标定的坐标操作，动作间隔 ≤ 1 秒，一份 Issue 只启动一次 App |
| 动态目标 | ✅ 可用 | 用哪个群、哪条消息由模型在准备阶段看屏幕选定，冻结为坐标后进入循环 |
| 判定 | ✅ 可用 | 偶现：上限内命中 1 次即复现；必现：连续 3 次；需求：逐条验收出「已实现 / 部分实现 / 未实现」 |
| 事故现场包 | ✅ 可用 | Android：录屏环形缓冲（最多 6×30 秒）+ 时间窗日志 + 崩溃缓冲 + dropbox；Web：Playwright trace + console + 网络记录；单文件离线查看器 |
| 重放 | ✅ 可用 | 按同一判定规则给出能否复现，并指出从第几轮起偏离原路径 |
| 账号池 | ✅ 可用 | 测试 / 生产账号分开租用，光标登录并缓存会话；凭据只在本地私有文件 |
| 控制台 | ✅ 可用 | 上传 Issue → 生成计划 → 一次性确认（替代端复选框）→ 执行 → 报告与证据链接 |
| 自然语言任务 / AI 探索 / Monkey / imui | ✅ 可用 | 早期能力，保留不变 |
| iOS、WebView、小程序 | ❌ 未接入 | iOS 问题只能经确认后在 Android 或手机 Web 上替代执行 |
| 多账号 / 多端联动 | ⏸ 暂缓 | 账号池已留接口，调度未实现 |

**生产环境样例结论**（详见 [docs/m5-acceptance.md](docs/m5-acceptance.md)）：

| Issue | 执行端 | 结论 |
|---|---|---|
| 1594 @ 选择器偶发不弹出 | desktop-web | 未复现（1000 步，最大间隔 918 ms，视觉模型调用 0） |
| 2336 三个独立通知铃铛 | desktop-web | 未实现：个人主页、Artifacts、CloudDoc 仍各有独立 🔔，无统一入口 |
| 2122 免打扰群 @ 我（单账号部分） | desktop-web | 未实现：无「@我 / Mentions」聚合，免打扰群无显著角标；需第二账号的部分暂缓 |
| 1329 点赞 / 定位链接 / 键盘（iOS） | android-app（替代） | 三项均未复现，各跑满 30 分钟 |
| 1614 / 1922 | — | 拒绝执行（服务端问题 / 按文档约定） |
| 1919、2235 / 2230 | — | 暂缓（多账号 / 需构造浏览器存储） |

## 快速开始

环境：Node.js ≥ 18（已在 22 验证）、pnpm 12；一台开启 USB 调试的 Android 手机 + adb；OpenAI 兼容的模型接口；可选 scrcpy（录屏）、ffmpeg（合并视频、抽帧）、Java（仅 Allure 报告）。

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env                       # 填 MIDSCENE_MODEL_*；可选 SCRCPY_PATH、MIDSCENE_ADB_PATH
# 账号：platform/accounts.local.yaml（gitignored），格式见 platform/accounts/secret-backend.ts
pnpm autotest accounts check --env prod    # 光标登录并缓存会话
pnpm autotest skill calibrate --surface desktop-web --env prod   # 标定（三端各一次，App 或 Web 改版后重做）
pnpm platform                              # 控制台 http://localhost:3210
```

## Issue 驱动的黑盒复现

```bash
pnpm autotest plan issues/1594.md                      # 预判类别 + 子用例 + 替代项，草稿写入 platform/plans/drafts/
pnpm autotest run --issue 1594 --yes                   # 无替代项时确认执行
pnpm autotest run --issue 1329 --approve s1,s3:mobile-web   # 有替代项：勾选子用例并选执行端
pnpm autotest replay <incident>/replay.json --variant all   # 重放：原节奏 / 加速 / 减速 / 冷启动
```

流程：

1. **解析与分类**：读 `issues/*.md` 的各段落，规则优先、模型兜底，分为必现 / 偶现 / 需求 / 疑似误操作 / 服务端 / 多账号 / 未来计划 / 不可执行。人工决定可写入 `platform/issue-overrides.yaml`。
2. **计划**：输出 `TestPlan`（zod 定义，`platform/schema/test-plan.ts`），只引用 SKILL 的元素 id 和 Node，不写坐标。已在设备上验证过的 SKILL 模板优先，其余情况由模型生成，统一经规则校验。
3. **一次性确认**：控制台或命令行展示类别、子用例和替代理由；只执行勾选项，执行中不再打断。
4. **执行**：租用账号（Android 同时租用设备）→ 启动一次 → 比对首页参考区域（不一致即报「SKILL 失效」并停止）→ 选定动态目标 → 前置操作 → 循环。
   - 每步不截图、不发额外 adb 命令。异常门只看事件流：Android 读 logcat（崩溃、ANR、进程死亡、离开 App），Web 读页面事件。
   - 每轮末尾截一次图，与参考区域比对笔画；对不上才调视觉模型核对。不在预期页面时记为操作偏离，重新进入，不计命中。
5. **报告**：`midscene_run/issues/<id>-<时间>/` 下的 `report.md`、`result.json`，以及每次命中的现场包；同时写 Allure 结果。

现场包结构见 [skills/teamily/report-spec.md](skills/teamily/report-spec.md)。

## Teamily SKILL（`skills/teamily/`）

- `SKILL.md`、`pages/*.md`：页面地图与元素清单；`vocab.ts`：元素 id / 参考区域 / Node / 动态目标指引的唯一来源。
- `profiles/<端>@<环境>.json`：标定坐标与自检结果。测试环境和生产环境前端布局不同，分别标定。
- `refs/<profile>/`：参考截图；自检失败时生成标注图，只有失败项需要人工复核。
- `nodes.ts`：`teamily.login / openConversation / sendMessage / typeMention / clearComposer / switchConversation / openPage`（`pnpm autotest nodes` 列出）。
- `plan-template.md`：类别 → 计划骨架，以及 @ 选择器、点赞、键盘、引用定位、通知入口、@我 聚合等通用模板。

## 其他入口

| 命令 | 用途 |
|---|---|
| `pnpm autotest mission "聊天时偶发闪退，你试试能不能重现"` | 自然语言任务：模型生成计划，用视觉 AI 动作执行（探索模式） |
| `pnpm autotest explore --package <pkg>` | AI 探索遍历，按界面状态去重，有界步数 |
| `pnpm autotest monkey --package <pkg> --seed 12345` | 固定 seed 的 Monkey + logcat 交叉验证（不要对生产账号跑） |
| `pnpm autotest imui run --client …` | IM 消息在真实界面上的收发耗时、丢失、重复、乱序，见 [docs/imui.md](docs/imui.md) |
| `pnpm autotest skill smoke --surface <端>` | 三端冒烟：按坐标打开会话并发一条消息（发到自己的 Personal AI） |
| `pnpm autotest accounts list` / `pnpm autotest devices` | 账号池 / 设备池状态 |
| `pnpm test:unit` / `pnpm typecheck` / `pnpm test:web` / `pnpm test:android` | 单测 / 类型检查 / Web 与 Android 基线用例 |
| `pnpm report` | 生成 Allure 报告（需要 Java） |

## 控制台（`pnpm platform`）

单个 `node:http` 服务加单页 HTML，没有前端构建链。

- **设备**：`platform/devices.yaml` 与 `adb devices` 合并，显示 idle / busy / offline。
- **新建任务**：Issue 黑盒复现 / 验收、自然语言任务、AI 探索、Monkey、IM 界面层收发。
- **最近任务**：实时日志、渲染后的报告（截图与现场包可直接打开）、取消。

状态落盘在 `platform/state/`，没有数据库。

![控制台](docs/console.png)

## 原则与安全

- **黑盒**：不读源码、不装调试版、不向页面注入代码。读取页面结构 / 无障碍层只发生在标定和准备阶段，用于找元素和候选目标。
- **生产环境**：结论以生产环境为准，测试环境只用于标定和调试。循环中不做会打扰他人的操作（通用模板只滚动、不发消息）；测试中发出的消息会撤回。
- **凭据**：只存在于 `platform/accounts.local.yaml` 和 `platform/secrets/`（均 gitignored），不进日志、报告、提交。
- **硬拦截**：支付类操作始终禁止。

## 已知限制

- 视觉模型适合准备阶段挑目标，不适合直接下结论；判定优先用参考区域比对和无障碍层核对，视觉判断只作补充。
- 需要前置数据的用例（如引用定位）依赖会话中已有的数据；测试台还不能自行可靠地构造前置条件。
- 判定为「未复现」不等于没有问题，报告会写明执行了多少步、因何停止。
- 多账号、多端联动的 Issue（1919、2235、2122 的一部分）要等账号池调度完成才能执行。
- CI 工作流（`.github/workflows/ai-test.yml`）只做过语法检查，未在真实 runner 上跑过。

## 目录结构

```
issues/            样例 Issue
issue/             解析、分类、计划生成、校验、报告、CLI
executor/          执行器：循环、判定、检查点、准备阶段选目标
drivers/           黑盒驱动：web.ts（光标 / 触屏 / 键盘）、android.ts（常驻 adb shell + logcat 异常门）
incident/          飞行记录器（Android / Web）、现场包、离线查看器、坐标重放
skills/teamily/    Teamily SKILL：页面地图、profile、参考截图、Node、计划模板
skills/            标定工具（calibrate-web.ts、calibrate-android.ts）、profile 读写
platform/          控制台、任务调度、设备池、账号池（accounts/）、TestPlan schema（schema/）、计划（plans/）
mission/ explore/ monkey/ imui/ report/   其他测试入口
core/              adb 封装、logcat 监控、PNG 解码与区域比对
bin/autotest.ts    统一命令入口；scripts/ 各命令实现
tests/             Web / Android 基线用例
docs/              介绍页、imui 说明、验收证据
```

## 依赖

`@midscene/web`、`@midscene/android`、`@midscene/core`（Node 定义）、`playwright`、`vitest`、`allure-vitest`、`zod`、`js-yaml`、`dotenv`；adb、scrcpy、ffmpeg 通过子进程调用。
