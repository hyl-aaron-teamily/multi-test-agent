# multi-test-agent 项目总结

> 截至 2026-10-20。W1–W3 已合并到 `main`；W4 在 `feat/w4-platform`（17 条提交，未合并、未推送）。详细用法见 `README.md`，变更与真机记录见 `CHANGELOG.md`。

## 1. 进度概览

| 阶段 | 内容 | 状态 |
|---|---|---|
| W1 Web 基线 | Midscene `PlaywrightAgent` + Vitest + Allure，saucedemo 5 步登录用例 | ✅ `pnpm test:web` 1/1 |
| W2 Android ADB | 设备发现、`AndroidAgent`、系统设置 5 步原生流程、logcat 崩溃监控、高频循环 | ✅ `pnpm test:android` 5/5 |
| W3 通用探索 + Monkey | AI 探索式遍历、Monkey 固定 seed 压测、统一问题报告 | ✅ |
| W4 平台 alpha | 自然语言测试任务、统一 CLI、Web 控制台、设备池、CI | ✅ 验收 6 项完成（并行与 CI 有前提，见 §6） |

单测：18 条（explore / monkey / mission / platform），`pnpm test:unit` 全部通过。
代码规模：TypeScript + 控制台 HTML 约 3800 行。

### 1.1 真机结果（Xiaomi 2211133C / Android 16，Teamily AI 生产环境）

| 测试 | 结果 |
|---|---|
| W3 AI 探索（6 轮，10–30 步） | 覆盖 4–9 个状态，未捕获崩溃/ANR |
| W3 Monkey（计算器 seed 12345 / 3000 事件） | 未捕获崩溃；`am crash` 注入自检被 logcat 捕获并与 monkey.log 关联 |
| W4「聊天时偶发闪退，你试试能不能重现」 | 未复现崩溃；报出 1 条检查失败，经截图核实为误报，已修复判定逻辑 |
| W4「左侧栏新加了个功能，看看使用流畅度和功能完整性」 | 10 分钟时长上限到点停止，未发现问题 |
| W4「排查下消息列表的问题」（2 次） | 第 1 次自动报出"行对齐/截断"（误报），同一截图中**人工确认一个真实问题**；第 2 次 25 步上限停止，未发现 |

**发现的问题**：会话列表中 Health Assistant 的最后一条消息是「WEB 交付物」富卡片，会话内渲染正常，但列表预览只显示占位符「[自定义消息]」，看不出内容。平台随后在视觉探测中加入"未渲染占位文本"规则，但重跑时该行不在画面内，**自动发现尚未验证**。

**生产副作用**（W3，均已人工还原）：Teamily Agent「免打扰」被打开、Personal AI 翻译语言被改为 English、输入框被模板填充（未发送）。W4 全面放开后测试中发送过若干测试消息到账号自己的 Personal AI 会话（含一条 43 秒的语音）。

## 2. 部署

### 2.1 环境要求

- Node.js ≥ 20（开发机 v22），pnpm 12（`packageManager` 已声明）
- Web：Chromium（`pnpm exec playwright install chromium`）
- Android：platform-tools（adb），手机开启 USB 调试并授权
- 报告：Java（Allure 生成用）
- 视觉模型（OpenAI 兼容接口）：AI 用例、探索、自然语言任务需要；Monkey、`FLOW=launch` 不需要

### 2.2 安装

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env          # 填入模型配置
adb devices -l                # 设备状态应为 "device"
```

| 变量 | 说明 |
|---|---|
| `MIDSCENE_MODEL_BASE_URL` / `_API_KEY` / `_NAME` / `_FAMILY` | 视觉模型；自然语言任务的规划也用这个接口（`MISSION_PLANNER_MODEL` 可单独指定模型） |
| `MIDSCENE_ADB_PATH` | 可选，adb 不在 PATH 时填完整路径 |
| `DEVICE_ID` | 可选，多设备时指定 |
| `APP_HINT` | 可选，给任务规划器的一句话 App 导航说明 |

### 2.3 自检

```bash
pnpm typecheck && pnpm test:unit      # 无需设备和模型
pnpm autotest devices                 # 列出 adb 设备
pnpm crash-check:android              # 需设备，无需模型
pnpm test:web && pnpm test:android    # 完整基线
```

## 3. 使用

### 3.1 统一入口

```bash
pnpm autotest mission "聊天时偶发闪退，你试试能不能重现" --package ai.teamily.mobile [--max-steps 60] [--max-minutes 20] [--plan-only]
pnpm autotest explore --package <pkg> [--steps 30] [--device <udid>]
pnpm autotest monkey  --package <pkg> --seed 12345 --events 3000
pnpm autotest web:smoke
pnpm autotest devices
pnpm autotest report                  # 合并 explore + monkey → problem-report.md
pnpm platform                         # Web 控制台 http://localhost:3210
```

前几周的 `pnpm test:web`、`test:android`、`loop:android`、`explore`、`monkey`、`report:problems` 保留不变。

### 3.2 自然语言任务的上限机制

| 机制 | 默认 | 作用 |
|---|---|---|
| 步数上限 `--max-steps` | 计划建议值（40–70） | 每个动作和检查计 1 步 |
| 时长上限 `--max-minutes` | 计划建议值（15–20） | 到点后不再开始新动作 |
| 平台硬上限 `MISSION_STEP_CAP` / `MISSION_MINUTES_CAP` | 300 步 / 120 分钟 | 计划和用户输入都截断到这里 |
| 看门狗 | 时长上限 + 2 分钟 | AI 调用卡住时写出部分报告并退出 |
| 单条 aiAct 规划轮数 | 15 | 防止一条指令吃掉整个预算 |
| 控制台服务端硬超时 | mission 时长 + 5 分钟；其他 60 分钟 | 杀掉整个子进程树 |

真机上已触发：25 步上限、10 分钟时长上限。未发现问题时报告写"未复现"并给出步数和停止原因。

### 3.3 产物位置

| 产物 | 路径 |
|---|---|
| 自然语言任务 | `midscene_run/missions/<id>/`：`plan.json`、`mission.json`、`report.md`、`finding-*.png` |
| 崩溃现场 | `midscene_run/crashes/<ts>/`（`context.json.source` = `ai-explore` / `monkey` / `mission`） |
| 探索轨迹 | `midscene_run/explore-traces/<ts>.json` |
| Midscene 每步回放 | `midscene_run/report/*.html` |
| Monkey | `monkey_run/<ts>-r<n>-s<seed>/monkey.log`、`monkey_run/summary.json` |
| 控制台状态 | `platform/state/`：`tasks.json`、`devices.json`、`logs/`、`reports/` |
| Allure | `allure-results/` → `allure-report/` |

### 3.4 安全

- 自然语言任务全面放开（输入、开关、发送、编辑都允许），只硬拦截**真实付款确认**和**退出登录 / 注销 / 删除账号**。
- W3 AI 探索默认只读（关键词禁点 + 不碰输入框和开关）。
- Monkey 随机点击无法约束，不要对生产账号的 IM / 支付类 App 运行。

## 4. 系统架构

```
 用户 ── 自然语言需求 / 表单 ──┐
                              ▼
 ┌──────────── 入口层 ─────────────────────────────────────────────┐
 │ platform/server.ts + console.html  (node:http, :3210, 轮询)       │
 │ bin/autotest.ts  (统一 CLI，node 直接拉起 tsx，不经 shell)          │
 └──────┬──────────────────────────────────────────────────────────┘
        │ POST /api/tasks
 ┌──────▼──────── 调度层 ─────────────────────┐
 │ platform/tasks.ts   FIFO 队列 / 子进程 / 硬超时 / 取消 │
 │ platform/device-pool.ts  devices.yaml + adb 心跳 + 占用/释放 │
 └──────┬────────────────────────────────────┘
        │ 每任务一个子进程：autotest <type> --device <udid>
 ┌──────▼──────────────── 执行层 ──────────────────────────────────────┐
 │ mission/  planner(需求→计划) → runner(有界轮次) → report             │
 │ explore/  observer · state-tracker · explore-loop · trace           │
 │ monkey/   runner · log-parser · loop      （不依赖 Midscene）         │
 │ tests/web · tests/android（Vitest + Allure）                          │
 └──────┬─────────────────────────────────────────┬──────────────────┘
 ┌──────▼──────────┐                      ┌───────▼─────────────────────┐
 │ fixtures/        │                      │ core/                        │
 │ AndroidAgent /   │─────────────────────▶│ adb.ts · logcat-monitor.ts   │
 │ PlaywrightAgent  │                      │ credentials.ts               │
 └──────┬──────────┘                      └───────┬─────────────────────┘
        ▼ 视觉模型 API                            ▼ adb → 真机
 产物 → midscene_run/ · monkey_run/ · platform/state/ → report/problem-report.ts、mission/report.ts
```

设计要点：

1. **分层**：`core/` 只依赖 Node 和 adb；`fixtures/` 创建 Agent 并检查凭据和设备；执行层只编排；平台层只调度子进程和读取产物，不修改前几周的执行逻辑。
2. **自然语言任务**：模型把需求转成结构化计划（意图、目标区域、入口、场景动作、检查项、是否测帧率、建议上限），模型不可用时按关键词规划。每轮依次是：冷/热启动交替、场景动作、随机探索、检查、视觉探测、gfxinfo 卡顿统计。
3. **问题判定**：
   - 崩溃/ANR 以 logcat 为准。
   - 进程消失但没有 Java 崩溃日志，记为 `app-exit`。
   - 检查项间隔 3 秒问两次都为否，且模型确认能从截图判断，才记为失败。
   - 视觉异常要两次观察一致。
   - 同一动作连续 3 次失败，记为 `action-failed`。
4. **偶发问题**：步数和时长双上限加多层超时；冷/热启动交替，并穿插随机探索，让每轮条件不同；"未复现"如实报告。
5. **调度**：一个 server 进程做调度，每个任务一个子进程，设备池限制并发、维护心跳、负责占用和释放；状态全部用 JSON 落盘，不用数据库。
6. **轻依赖**：adb 用 `child_process` 调用，哈希用 `node:crypto`，前端是单个 HTML，HTTP 用 `node:http`。W4 只新增了 `js-yaml`。

## 5. 与参考代码的相似度

### 5.1 字面重复度

方法：将本项目全部 `.ts` 与 `ref/midscene-example/**/*.{ts,js}` 逐行比对。每行先去掉首尾空白、压缩空格，再排除 import、注释和 ≤12 字符的短行，统计与参考代码完全相同的行所占比例。

| 范围 | 有效行 | 与 ref 相同 | 比例 |
|---|---|---|---|
| **全项目** | 2254 | 35 | **1.6%** |
| W4 新增（`mission/`、`platform/`、`bin/`） | 778 | 4 | 0.5% |
| `core/`、`explore/`、`monkey/`、`report/` | 约 700 | 3 | <0.5% |
| `fixtures/page.ts` | 57 | 5 | 8.8%（类型签名） |
| `scripts/crash-check-android.ts` | 25 | 4 | 16.0%（`sleep`、`main()`、`process.exit(1)` 样板） |

重复行基本都是通用样板，没有成段照搬的业务逻辑。

### 5.2 结构上的借鉴

| 参考源 | 借鉴内容 | 程度 |
|---|---|---|
| `playwright-with-vitest-demo/` | Vitest + Midscene fixture 组织、dotenv、超时 | 结构相近，代码自写 |
| `android/vitest-demo`、`javascript-sdk-demo` | `AndroidDevice → AndroidAgent → connect` 调用顺序；`aiQuery` 写法 | SDK 规定用法 |
| `playwright-mind/` | AI 操作 → aiQuery → expect → aiAssert 分工 | 仅思路 |
| lycoding/auto-test-platform | 设备池注册/心跳/占用/释放、Master/Worker 分层 | 仅架构，未引入其 Java/Python 代码 |
| Midscene 设备池配置 | `devices` / `scheduling.strategy` / `maxConcurrent` 字段格式 | 仅字段命名 |
| `midscene-skills`、`ref/.../.github/workflows` | 缺失，未参考 | — |
| logcat 监控、Monkey 解析、状态指纹、安全过滤、任务规划与执行、调度、报告 | ref 中无对应实现 | 原创 |

## 6. 验收与已知限制

W4 验收（详见 CHANGELOG）：

- 控制台：设备列表、任务提交、排队、报告链接全部验证通过。
- 串行：`maxConcurrent: 1` 时，前一任务 08:35:09.108 结束、下一任务 .153 开始。
- 并行：`maxConcurrent: 2` 时两个任务同时运行（09:05:53 开始），但两台"设备"是同一台手机的 USB 和 Wi‑Fi 两个连接，**不是两台物理设备**。
- CI：只做了 YAML 解析检查，**未在真实 GitHub runner / act 上执行**。

已知限制：

- **AI 动作慢**：单步 3–160 秒。偶发问题需要较长的时长上限；高频输入加即时重放未实现，对生产账号做高频自动发送也不合适，需要测试账号或测试环境。
- **误报**：两次真机误报（动态检查、省略号截断）已修正，视觉判断仍可能误报，报告需人工复核截图。
- **并发产物串号**：并发的 explore/monkey 任务共用 `monkey_run/summary.json` 和 `problem-report.md`，控制台报告可能串号；mission 报告按任务 ID 隔离，不受影响。
- **重启丢任务**：控制台重启后，运行中的任务会标为 failed，不会恢复。
- **偶发失败**：`test:android` 在 W4 验证中出现过 1 次失败（未留日志），重跑通过。

自我评估：

| 维度 | 状态 | 依据 |
|---|---|---|
| WebView | 未开始 | 无 CDP 通道，WebView 内容只能靠截图视觉操作 |
| 小程序 | 未开始 | 无接入代码 |
| 报告看板 | 有雏形 | 单任务 Markdown 报告 + 截图渲染；无趋势、聚类、状态图 |
| 生产级调度 | 有雏形 | 有队列、并发上限、心跳、超时、取消；无持久化恢复、多机 Worker、鉴权、重试/优先级 |

## 7. 下一步建议

1. 准备 Teamily 测试账号或测试环境后，实现高频输入压测和即时重放（事件日志、环形录屏、崩溃前 60 秒导出、按时序重放）。
2. 每次检查前先把目标区域滚回顶部，并对整页截长图，让列表类问题（如「[自定义消息]」预览）能被稳定拍到。
3. 按任务 ID 隔离 explore/monkey 的产物目录，消除并发报告串号。
4. 接入 WebView CDP（Teamily 的 WEB 交付物、技能库页面），复用 mission 的检查与报告出口。
5. 在真实 GitHub runner 和自托管 Android runner 上跑通 CI。
