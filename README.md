# multi-test-agent

> 介绍页：[docs/intro.html](docs/intro.html) · 规则（生效版，带代码落点）：[docs/rules.md](docs/rules.md) · 命令行参考：[docs/cli-reference.md](docs/cli-reference.md) · Agent 使用规则：[docs/agent-rules.md](docs/agent-rules.md) · 本期验收：[docs/w2m4.1-acceptance.md](docs/w2m4.1-acceptance.md) · 变更：[CHANGELOG.md](CHANGELOG.md) · 旧版文档、验收记录与证据：git 历史

Teamily 客户端的真机黑盒测试台。只做用户能做的操作（触控、光标、键盘），只看用户能看到的现象（屏幕、无障碍文本、系统日志），在四个执行端上运行：**Android App**、**手机自带浏览器里的 Web**（android-web）、**手机视口 Web**（mobile-web，Playwright）、**桌面 Web**（desktop-web，Windows 上是最大化的 Edge）。

两项能力：

| | 能力 ① 快速档：Issue → 计划 → 重复执行、拦截问题 | 能力 ② 探索档：自然语言任务 / AI 探索，发现新问题 |
|---|---|---|
| 输入 | 结构化文档：一份 Issue（`issues/*.md`）→ 审批过的计划 | 一句话目标，例如「打开通知铃铛，看看有哪些分类」 |
| 怎么做 | 规则 + 模型生成高确定性的计划，确认一次后按坐标循环执行（每步 ≤ 1 s，循环内不读屏、不调视觉） | 每一步看截图和可点元素，视觉模型决定一个动作；默认只读；用速度和 token 换覆盖 |
| 结论 | 已复现 / 未复现（带有效尝试数和区间）、已实现 / 未实现；命中时有完整现场包 | 发现清单（每条带现场包）、覆盖了哪些界面、拦截了哪些动作、用量 |
| 两者关系 | 复现探索档的发现，给出带分母的结论 | ← 探索的发现可以一键转成 Issue 草稿 |

多设备、多账号的协同（多端同步、一个任务同时租多个环境、每端不同账号）是这两项能力的执行底座。

## 快速开始

环境：Node.js ≥ 18（已在 22 验证）、pnpm、一台开启 USB 调试的 Android 手机 + adb、OpenAI 兼容的模型接口（视觉 + 文本）；可选 scrcpy（录屏）、ffmpeg（合并视频）。

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env                 # 填 MIDSCENE_MODEL_*；可选 SCRCPY_PATH、MIDSCENE_ADB_PATH
# 账号：platform/accounts.local.yaml（gitignored），格式见 platform/accounts/secret-backend.ts
pnpm platform                        # 平台服务 + Web 控制台 http://localhost:3210（马上监听；环境检查在后台）
npx tsx bin/autotest.ts doctor       # 能不能跑、缺什么、下一步（平台没启动也能答）
```

## 能力 ① 快速档：Issue → 计划 → 复现

```bash
npx tsx bin/autotest.ts draft create 1903 --json                       # 分类 + 契约 + 计划 → 计划 id，如 1903/main:android-app@v1
npx tsx bin/autotest.ts plan explain "1903/main:android-app@v1"        # 步骤、影响、不确定处、预计耗时、审批类别、哈希
npx tsx bin/autotest.ts task run "1903/main:android-app@v1" --max-rounds 6
npx tsx bin/autotest.ts task wait <taskId>                             # 10 未复现 / 11 已复现 / 13 已实现 / 14 未实现 …
npx tsx bin/autotest.ts result show <taskId>
```

1. **分类**：规则优先、模型兜底，分为必现 / 偶现 / 需求 / 疑似误操作 / 服务端 / 多账号 / 前置条件构造不了 / 不可执行。**不拒绝任何 Issue**：服务端问题按偶现执行，只看用户可见的一侧；计划生成不了的子用例出一页「无法生成计划」报告，写明原因和怎样才能执行。Issue 里的截图链接（最多 3 张）与文字一起交给模型。
2. **契约与计划**：Issue → 意图契约（前置条件、触发、可观察的现象）→ 设备上验证过的模式确定性编译，没有模式时由模型从动作库组合，统一过规则校验（含 Node 参数 schema）。计划只引用 SKILL 元素 id 和 Node，不写坐标；用哪个群、哪条消息由模型在准备阶段看屏幕选定，冻结为坐标。多账号 Issue 规划成多角色计划（各端 + 轮数）。
3. **审批**：只操作被测软件的计划默认允许；敏感计划（离开被测软件、单次发送 > 50 条、系列 > 20 次）在 Web 上由人同意；完全授权开启时不再等确认。删除 / 撤回消息、允许清单外的会话、锁屏 PIN、凭据落盘任何情况都拒绝。批准绑定计划哈希、SKILL / App / Issue 版本和次数。
4. **执行**：租环境（多端任务一次租齐，租不齐就都不租）→ 预检（锁屏、离线等 → 环境不合格，不点击）→ 冷启动 → 首页核对 → 准备 → **预热**（逐步核对，不通过 = 计划不可执行，不给结论）→ 循环。循环里每步只按坐标，不读屏、不调视觉；异常门只看事件流（logcat / 页面事件）；每轮检查一次。
5. **判定**：任何类别命中一次即「已复现」；命中 = 硬异常，或检查不通过且证据复核与 Issue 描述一致。轮自身前提不成立（例如输入框里没有刚键入的文字）记为偏离，不计尝试。结论带分母：单轮命中率与 Wilson 95% 区间，0 命中时给 3/n 上界。未复现不等于已修复。
6. **证据**：每次运行 `manifest.json`、`trajectory.jsonl`、`report.md`；命中时的现场包——Android 录屏（环形缓冲合并成 `merged.mp4` + `ops.srt`）、logcat 窗口、崩溃缓冲、dropbox、设备状态；Web 的 Playwright trace、console、网络；`replay.json` 可坐标重放；`index.html` 离线打开。

## 能力 ② 探索档：自然语言任务与 AI 探索

```bash
npx tsx bin/autotest.ts explore run "打开通知铃铛，看看里面有哪些通知分类，然后关掉它" --mode task --surface desktop-web
npx tsx bin/autotest.ts explore run "浏览发现页和个人主页，找找界面错乱、报错或卡住的地方"   # 默认 explore、android-app
npx tsx bin/autotest.ts task wait <taskId> --json      # 18 = 有发现，19 = 未发现问题
npx tsx bin/autotest.ts result show <taskId>           # 发现、覆盖、拦截、用量
npx tsx bin/autotest.ts explore issue <taskId> <序号>  # 发现 → issues/explore/<id>.md，交给能力 ①
npx tsx bin/autotest.ts explore inject <taskId> "先看看设置页"   # 给运行中的探索追加指令，下一步生效
npx tsx bin/autotest.ts explore candidates <taskId>    # SKILL 候选元素清单（人工审核后再标定）
```

- 每一步：截图（缩到 720 px）+ 编号元素表（输入框带占位提示，无文字的元素带资源 id）→ 视觉模型给一个 JSON 动作（点、长按、输入〔可先清空〕、滑动、拖动、返回、重开、等待、报告问题、结束），同一屏上可以连发最多 4 个。同一动作反复出现或两个动作来回切换时，提示模型换路。
- **只读**是默认：发送、删除、改设置、支付、退出登录、邀请分享、改资料、在搜索框以外键入，都在执行前拦截并告诉模型。`--writable` 需要完全授权；删除 / 撤回、锁屏、密码任何模式都拦。**点赞、关注、收藏、订阅只对测试账号自己的主页和内容做**（名单写在 `accounts.local.yaml` 的 `environments.<env>.ownContent`），真实用户的内容在可写模式下也拦。
- 崩溃、ANR、App 退出、页面崩溃立即保存现场包，计为发现，然后重开 App；模型报告的问题先做证据复核，结论一致才计入。
- **确定性判定**（`engine/detect.ts`）每步都跑：白屏、一直加载（如「等待网络」持续 15 秒）、错误文案、占位文字 / Markdown 源码、点了没反应（同一元素连续两次）。命中写现场包并做证据复核，一致才计入；会话消息区和输入框里的文字不判。
- 上限：硬上限 500 步 / 30 分钟（`--max-steps`、`--max-minutes` 只能收紧）；每 12 步压缩一次历史，单次模型调用最长 180 s。
- 不经平台、在本进程直接跑（开发用）：`npx tsx bin/autotest.ts explore local "<目标>"`。

## 评测模式：AndroidWorld（探索档的操作能力）

用 Google 的 [AndroidWorld](https://github.com/google-research/android_world)（`ref/android_world`）给探索档打分：116 道任务、20 个开源 App，在模拟器上做，分数由 AndroidWorld 读 App 真实状态给出。环境安装见 `docs/env-plan.md`。

```bash
emulator -avd AndroidWorldAvd -no-snapshot -grpc 8554 -no-boot-anim -gpu host          # 用完关掉：adb -s emulator-5554 emu kill
AW_ADB=<winget adb 路径> D:\envs\androidworld\python bench/androidworld/server.py      # 首次加 --setup（装 App，约 8 分钟）
npx tsx bin/autotest.ts bench aw --pilot [--budget 2]     # 试跑集 10 题；--budget = 步数预算倍数
npx tsx bin/autotest.ts bench aw [--resume <目录>]        # 全量；结果 midscene_run/bench/aw-<时间>/report.md
```

- 只接受模拟器（`emulator-*`），风险规则全部放行；不经平台、不进 MCP / Web。
- 报告给出**成功率**（App 状态符合题目，`is_successful`）和 AndroidWorld 排行榜口径（还要求 agent 自己结束）。
- 评测服务不让 android_env 执行 `adb kill-server`（手机共用同一个 adb 服务），命令失败时停 5 秒再试。

## 多端协同

```bash
npx tsx bin/autotest.ts task run --sync desktop-web,android-app --rounds 4   # 13 全部同步（已实现）/ 14 有端没看到
```

每个端用账号池里不同的测试账号（手机上登录的账号跟着手机），进入允许清单里的同一个群；每轮一端发一条带标记的消息，其余端都要看到。App 端读无障碍文本，桌面 Web 读页面文字，其余用视觉。同一台手机的 App 和浏览器可以归同一个任务，轮流占前台。

## 平台、命令行、MCP、Web

- **平台服务**（`pnpm platform`，`platform/server.ts`）：`/api/v1` 一个服务，状态落盘在 `platform/state/`（JSON，没有数据库）。环境 = 端 × 设备 × 服务环境（如 `android-app:4f2ebdf2@prod`），开机、任务结束后自动检查；任务进程是否存活按 pid + 启动时间判断；取消在步骤边界生效，60 s 不停则强制结束。
- **命令行**（`bin/autotest.ts`，面向 Agent）：`autotest <对象> <动作> [--json]`，`--json` 时 stdout 只有一个 JSON 信封；从不提问；退出码两位、十位是类别（1x 结论 / 2x 已受理 / 3x 审批 / 4x 输入 / 5x 环境 / 6x 工具 / 7x 取消与中断），全表见 [docs/cli-reference.md](docs/cli-reference.md)。
- **MCP**（`npx tsx scripts/mcp.ts`，`--print-config claude` 打印接入配置）：工具由命令表生成（19 个，含 `explore_run`、`explore_issue`、`device_snapshot`），结果就是 `--json` 信封；同意类操作只在 Web。
- **Web**（面向人）：`index.html` + `style.css` + `app.js` 单页，hash 路由：总览、新建任务（自然语言·探索 / Issue / 多端协同）、任务详情（实时推送；探索档每步的截图、动作和思路）、结果（转成 Issue）、计划（步骤标在最近一次运行的截图上）、环境、审批（完全授权开关常显红色横幅）。每页回答五问：要做什么 / 正在做什么 / 结果 / 可信吗 / 下一步。CLI、MCP、Web 读同一份视图模型（`platform/views.ts`）。
- **读树后端**：默认 uiautomator；设备项写 `treeBackend: a11y-service` 改用手机上的只读读树服务（`android/a11y-service/`，`env check` 时按配置项安装启用），不可用时自动退回。

## Teamily SKILL（`skills/teamily/`）

`vocab.ts` 是元素 id、参考区域、Node、动态目标指引的唯一来源；`finders.ts` 写每个元素怎么认（文字 / 无障碍描述 / 几何规则 / Web 只读选择器 / 视觉描述）和参考区域的锚点；`nodes.ts` 是登录、打开会话、发消息、@ 成员等操作。**不做离线标定**：循环外第一次用到时现场定位，缓存在 `platform/state/skill-cache/<端>@<环境>@<App 版本>@<分辨率>/`，App 升级自动换新缓存；参考区域对不上（例如手机切到了浅色主题）时在锚点处重新截取。循环内只读缓存。

## 开发

```bash
pnpm code-gate          # typecheck + 单测 + 证据复核用例（每次改动后）
npx tsx scripts/cli-ref.ts            # 重新生成 docs/cli-reference.md
npx tsx scripts/web-shots.ts          # Web 各页截图（平台需在运行）
```

## 已知限制

- **android-web**：手机浏览器的无障碍树不跟随页面内跳转，所以会话列表、当前页面的判断都靠视觉，每一步要等页面变化（这个页面响应慢）；读不准页面内容的计划（@ 选择器、输入框文字前提）在 android-web 上还不可靠（[docs/backlog.md](docs/backlog.md)）。
- 能力 ② 本期在 android-app 与 desktop-web 上验收；探索的发现是线索，不是复现结论。
- 快速档运行时确定性判定只在轮末做（第 1 轮和每 10 轮），看到的问题列为「附带发现」，不计入 Issue 结论。
- 参考区域按浅色 / 深色各存一份，任一符合即通过；某个主题第一次出现时，要在准备阶段（循环外）补截。
- 浏览器只在页面加载时建立无障碍树；临时出现的元素（密码页、@ 选择器）由视觉定位；系统返回键会关掉标签页，执行中只用页面里的返回。
- Teamily Web 重新加载后会自动打开上次的会话，而那时会话的返回按钮无效；执行器经 Artifacts → 聊天 → 返回回到列表。
- iOS、WebView、小程序没有接入：iOS 的 Issue 经确认后在 Android App 或手机 Web 上替代执行，结论标明「替代执行」。
- 本机没有登录，「CLI 不能同意敏感计划」是流程约束，不是安全边界。

## 目录

```
issues/            样例 Issue；issues/explore/ = 探索发现转成的 Issue（运行产物）
issue/             解析、分类、契约、计划生成、校验、报告
engine/            统一引擎（两档共用）：会话、端适配、登录、SKILL 现场定位、快照、点击前检查、检查、判定、预检、租约
engine/agent/      能力 ② 探索档：循环、风险规则、提示词与动作解析、发现 → Issue
engine/plan/       能力 ① 快速档：计划执行、准备、预热、循环、系列、多端同步
engine/recorder/   飞行记录器（Android / Web）、现场包、离线查看器、重放、证据复核
drivers/           黑盒驱动：android.ts（常驻 adb shell + logcat 异常门）、web.ts（Playwright）
skills/            SKILL 缓存（profile.ts）与 Teamily SKILL（teamily/）
platform/          服务（server.ts、api-v1.ts、views.ts、approval.ts、mcp.ts）、账号池、设备池、计划、Web（web/）
platform/lifecycle/ 环境 / 任务状态机、状态码、环境检查、调度与租约
core/              adb、截图与区域比对、模型调用、轨迹
bin/、scripts/     命令入口与实现
docs/              介绍页、规则、命令行参考、Agent 规则、各里程碑需求文档、本期验收、backlog
```

## 原则

- **黑盒**：不读源码、不装调试版、不向页面注入代码、不用 App 钩子。探索档每一步都看屏幕；快速档的循环内只按坐标，读页面结构 / 无障碍层只在循环外（现场定位、准备、预热）和检查点。
- **账号**：生产与测试各是一组账号池，账号池里的生产账号都是测试账号；凭据只在 `platform/accounts.local.yaml` 和 `platform/secrets/`（gitignored），不进日志、报告、提交。
- **结论如实**：环境不合格、计划不可执行、执行失败都不给产品结论；取消或中断的运行标「不完整」。
