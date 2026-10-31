# 重构方案（2026-10-31 用户确认）

日期：2026-10-31。依据：`docs/rules-audit.md`（用户已审核，含 C1–C4、D2–D8、B5、B8 的定案）、ref/artemis 调研、逐文件归类（import 图核对）。
**已确认（2026-10-31）**：按 P0→P8 依次执行，每阶段合并前找用户确认。

## 0. 目标

只做两项能力，其余都是性能和可用性要求：

| | 能力① 自主测试 / 探索 | 能力② Issue 驱动 |
|---|---|---|
| 输入 | 自然语言目标，或「探索这个 App」 | Issue 文档 |
| 执行方式 | 每步都是：看屏幕 → 模型决策 → 操作 | 生成确定性计划，确认后冻结，按坐标跑 ≤1 s 循环 |
| 判定问题 | 硬异常，或者报错影响了正常使用（E2） | 硬异常，或者界面异常且符合 Issue 描述（E2）；命中 1 次即算（E1） |
| 出问题时 | 两种能力产出同一种现场包（E13–E16） | 同左 |

两种能力共用：多设备多账号的租用和隔离（F1、F6–F9）、审批（G1–G10）、CLI / Web / MCP 三端一致（H1–H8）。

## 1. 目标结构

```
drivers/            输入 + 事件流（android: 常驻 adb shell + yadb + logcat 流；web: Playwright）      ~600
perception/         看屏幕：读树后端（a11y APK / uiautomator）、屏幕快照与索引、图像工具、模型（llm + 视觉）   ~1,100
locate/             即时定位 + 缓存（替代离线标定，见 §3）                                         ~300
engine/
  session.ts        租用 → 启动 → 登录 → 回首页（两种模式共用）
  recorder/         飞行记录器、录制驱动、现场包、重放、证据复核（原 incident/ + executor/replay）       ~900
  verdict.ts …      判定、失败归类、统计、manifest、trajectory（共用）
  plan/             模式 A（能力②）：准备、动态目标、预热、循环、检查点、系列、多端协同                ~1,900
  agent/            模式 B（能力①）：自主循环、探索记账、问题判定、沉淀为计划（见 §2）                 ~700
issue/              Issue → 分类 → 契约 → 计划 → 校验 → 草稿                                       ~650
skills/teamily/     只保留语义：元素怎么认、Node、模式库、前置条件                                    ~800
platform/           任务和环境（租约 + FIFO + 取消）、设备池和账号池、审批、api-v1、视图、CLI、MCP          ~2,600
platform/web/       index.html + style.css + app.js（§5）                                          ~1,500（非 TS）
android/a11y-service  读树 APK（B8 放开只读限制，本期不加新功能）                                     ~350
```

## 2. 能力①：自主测试和探索（模式 B）

参考 Artemis 的 Flash 单 agent 循环，**不照搬**它的 LangGraph 多 agent 图、视频分析子系统和 Angular 控制台。

**每一步**
1. 截一张图，同时列出带编号的可见元素（Android 从树里取，Web 从 Playwright 可访问性快照取）。
2. 交给模型，模型返回一个动作：
   - 首选按元素序号点，如 `tap #3`；
   - 不在列表里的元素用坐标兜底，同时必须写明目标描述；
   - 其他动作：`type`、`swipe`、`back`、`launch`；
   - 结束或报问题：`done(completed|failed)`、`report_issue(描述)`。
3. 点击前复用 `pretap` 检查目标还在不在。不在就把情况交回模型，不盲目重试。
4. 每一步都经过录制驱动，所以现场包和 replay.json 与模式 A 完全相同。

**计划和终止**
- 第一步由模型写一份 Markdown checkbox 计划，状态用 `[ ] [/] [x] [!]`。代码只解析勾选状态。
- 结束条件：全部打勾、到步数上限、到时间上限、或用户取消。
- 默认上限沿用 D9 的口径，具体数值随实现确定。

**探索模式**
- 目标是「探索」时，按「屏幕文字指纹 → 这个界面上试过哪些动作」记账，引导模型优先选没试过的。
- 结束时报告覆盖了多少个界面、多少个动作（E20）。
- 默认只读：不发消息、不填表单、不碰设置。可写的探索按敏感计划处理（G10）。

**问题判定（E2，能力①）**
- 驱动事件流报的硬异常（crash、anr、app-exit、page-crash）直接算命中。
- 模型提出的「报错影响正常使用」，要先写现场包，再交给独立、只读的复核：逐条判定，必须引用证据，证据不足记 inconclusive，不判失败。复核通过才算（E7）。

**沉淀为计划（P2，可选）**
- 一次走通的路径或发现的问题，转成 TestPlan 草稿（能匹配上的元素换成元素 id），之后按能力②稳定复跑。

**规则边界**：D1–D8 不约束模式 B；B1（黑盒）照常约束。

## 3. 即时定位 + 缓存（C1–C4 定案）

**去掉的东西**
- 离线标定：3 个标定器
- `skills/teamily/profiles/`
- 参考图 `skills/teamily/refs/`（17 MB）
- 自愈（`heal.ts`）
- 区域比对检查（`visual-region`）

**SKILL 改成语义描述**

每个元素写清怎么认，例如：

```yaml
send-button: { page: chat, role: button, desc: ["发送", "Send"], near: composer, icon: "纸飞机图标" }
```

**定位顺序**（在准备期执行）
1. ① 树或 DOM 文本：精确匹配或包含匹配。Web 用 Playwright 定位器读 `boundingBox`，属于只读，符合 B1。
2. ② 屏幕索引排序。
3. ③ 视觉定位，只用于纯图标元素。

**缓存**
- 结果写入缓存，键是 `端@环境@App版本@分辨率`，值是坐标、边界和文字指纹。
- 每个缓存点第一次使用前，用 `pretap` 校验。
- 校验不通过就重新定位并更新缓存。连续定位失败报「SKILL 失效」，这替代了原来的 C4。

**检查点**
- 改为 ① 文本检查，出现异常时才用 ③ 视觉。

**android-web 的特殊处理**
- 手机浏览器的树不跟随单页应用（SPA）内的跳转，所以定位前先用浏览器刷新，这是现有做法。
- 刷新后仍读不到，就用视觉定位。

**风险**
- 纯图标按钮第一次定位要调视觉模型。命中缓存后就不再调用。
- 换版本或分辨率时会重新调用一次。

## 4. 规则改动在代码里的落点

| 规则 | 改动 |
|---|---|
| E1 | `verdict.ts`：必现类命中 1 次即算 |
| E2 | 命中定义按两种能力分开写，两边都经过证据复核 |
| E12 | 去掉「最终结论必须来自生产」的限制和相关提示 |
| A3 | `classify.ts` 删除拒绝和暂缓两类。multi-account 改为走多端协同执行，sync 接入 v1 任务（§6 的 P6） |
| B7 | Issue 里的截图可以交给模型（`parse.ts` 小改） |
| J3 | 完全授权下，`task_run` 自动执行；`plan_explain` 照常输出，但不等人确认（同步修改 `agent-rules.md`） |
| F2–F5 | 删除基线修复、台账恢复、心跳和看门狗、交叉检测、隔离区。租约是否失效只看进程 pid + 启动时间是否还活着；任务进程死了，租约就释放 |
| I1 / I2 | 不改代码，只改约束文字 |

## 5. 前端（HTML 三件套）

- 参照 im-loadtest 的 `webui/static/`（index.html 185 行、style.css 602 行、app.js 947 行），以及 `docs/intro.html`。两边共用「纸质实验记录本」设计变量：暖白纸底、柔墨色字、低饱和植物色；标题 Fraunces，正文 Hanken Grotesk，数据 DM Mono。
- 结构：`platform/web/index.html` + `style.css` + `app.js`，单页应用，用 hash 路由，不引入框架（H7）。原来的 5 个页面和 `web.js` 合并进来，旧控制台 `console.html` 删除。
- 页面：
  - 总览：设备、环境、运行中的任务、完全授权的红色横幅；
  - 新建任务：分「自然语言 / 探索」和「Issue」两个入口；
  - 任务详情：实时进度用 SSE，显示步骤时间线和最新截图；
  - 结果：结论句、依据、有效尝试和区间、现场包链接；
  - 审批：敏感计划、配置项、完全授权开关。
- 文案规则不变：每页回答五问，白话步骤由模板生成（H6–H8）。
- 字体：im-loadtest 从 Google Fonts 加载。离线或网络不通时会退回系统字体，样式变量不受影响。

## 6. 迁移顺序

每个阶段在独立的 `feat/refactor-*` 分支上做，用 `--no-ff` 合并，合并需要用户同意（I10）。每个阶段结束都跑代码门（I8）。

| 阶段 | 内容 | 验证 |
|---|---|---|
| P0 基线 | 代码门全绿；保存 2010、1903 的草稿和计划 golden；真机各跑 1 次作为对照 | 产物存档 |
| P1 删旧 | imui、monkey、mission、explore、replay/、report/、W1 用例、fixtures（保留 evidence）、W1 脚本、里程碑门脚本、`platform/tasks.ts`、`core/logcat-monitor.ts` 等，约 5.3k 行（详见附录）；删除依赖 allure×3 和 @playwright/test；精简 package.json 脚本 | 代码门；真机 `task run` 2010 ×1，结论与 P0 一致 |
| P2 生命周期瘦身 | 删除 F2–F5 部分（baseline、recover、crosscheck、android-ops、心跳、台账、watchdog）；租约改为看 pid 是否存活 | 单测；手工杀任务进程，确认租约释放、任务记为中断 |
| P3 即时定位 | `locate/` + 缓存替换标定；SKILL 改为语义描述；去掉区域检查、自愈和参考图 | 2010、1903 android-app 各 10 次，工具可靠性 ≥9/10（E5）；desktop-web、mobile-web 准备期定位冒烟；记录准备耗时和视觉调用次数 |
| P4 规则语义 | E1、E2、A3、E12、J3、B7 | 单测和 golden 更新，在 CHANGELOG 写明行为变化（I16） |
| P5 引擎 + 能力① | 建 `engine/`（session、recorder、verdict 两种模式共用）；把 `plan/` 搬进来；实现 `agent/` 模式 B；接入 v1 任务、CLI、MCP | 真机上对 Teamily 下达自然语言任务，正常完成；探索 50 步（只读），报告覆盖范围；运行中人为让 App 退出，确认产出完整现场包，且能在离线 index.html 里打开 |
| P6 多端协同 | `sync.ts` 接入 v1 任务，多角色计划（不同端、不同账号）；multi-account 类 Issue 可以执行 | android-app + desktop-web 两个账号互发消息，同步判定正确；租约隔离（同一设备不会被两个任务同时占用） |
| P7 前端 | §5 | 用 Playwright 截图各页面；由同事真人验收可读性（H8） |
| P8 文档 | README、CHANGELOG、`agent-rules.md`；`rules-audit.md` 定稿为 `docs/rules.md`；dev-week 文档移到 `docs/history/` | 文档与代码一致（I11） |

P1 和 P2 只删代码，主链路行为不变，风险最低，先做。P3 和 P5 改动最大，各自单独做真机验收。

## 7. 规模估算

| | 现在 | 目标 |
|---|---|---|
| TS 源码 | 约 20.6k | **约 11k**：保留和精简后约 12k；P5 重组再省约 1.5k；新增模式 B 约 0.7k |
| 测试 | 约 3.3k | 约 2.5k |
| 前端（HTML/CSS/JS） | 约 560（含旧控制台） | 约 1.5k |
| 仓库里的二进制 | refs 17 MB + 验收截图和视频 | refs 删除。git 历史里仍保留；要减小仓库体积需要改写历史，不建议 |

比上次估的「约 9k」高。原因是这次保留了 H1–H8（三端一致、状态码、白话 Web）、G1–G10（审批和哈希绑定）、系列统计和预检，这与上次说的「全部保留约 10.5k」一致。

## 8. 已定

1. 不拒绝任何 Issue。E18 改为：无法执行的子用例（如缺前置条件）也出一页报告写明原因。
2. 测试环境 = 独立账号池（多一批账号），没有其他特殊用途；结论可以来自任一环境。
3. 历史文档移到 `docs/history/`，不删除。
4. 按 P0→P8 依次执行，每个阶段合并前找用户确认。

## 附录：删除清单（P1–P3，已按 import 图核对）

- **P1**
  - `imui/`、`monkey/`、`mission/`、`explore/`、`replay/`、`report/`、`tests/`
  - `fixtures/`：只删 `page.ts`、`android.ts`；`fixtures/evidence/` 保留，用于证据预置用例
  - `core/logcat-monitor.ts`、`core/task-result.ts`、`core/credentials.ts`、`platform/tasks.ts`、`platform/console.html`
  - `scripts/`：crash-check-android、explore、imui、loop-android、mission、monkey、replay、report、mcp-check、w2m1-gate、w2m3-gate、w2m4-*
  - `scripts/m5.ts`、`scripts/issue-cli.ts` 中旧的 plan/run/series/rerender/skill 入口；accounts、evidence、replay、sync 并入 cli-v1
  - `docs/imui.md`
  - 依赖：allure-commandline、allure-js-commons、allure-vitest（同时改 vitest.config.ts）、@playwright/test
- **P2**
  - 删除：`platform/lifecycle/{android-ops,baseline,crosscheck,recover}.ts`
  - 精简：env、runtime、supervisor、task、registry 中与恢复和心跳相关的部分
  - 删除对应的 spec
- **P3**
  - `skills/calibrate-{web,android,android-web,common}.ts`、`skills/teamily/profiles/`、`skills/teamily/refs/`、`executor/heal.ts`
  - `core/image.ts` 中区域比对专用函数（regionDiffFraction、scaleBox）；dHash 和 pixelDiff 保留，因为重放偏离判定、稳定等待、pretap 都在用
