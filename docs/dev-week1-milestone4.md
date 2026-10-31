# 任务：第四周里程碑 — 轻量 Web 控制台 + 设备池 + CI 集成

## 前置状态

前三周已完成：Web 端 Midscene + Vitest + Allure 闭环；Android ADB + logcat 崩溃捕获；AI 探索式遍历 + Monkey 随机压测 + 问题报告雏形。`ref/` 只读。

**本周不修改**前三周的核心执行逻辑（`explore/`、`monkey/`、`fixtures/`），只在外部增加调度、展示和自动化入口。

## 本周目标

把已有的 CLI 执行能力包装成一个**单人可用、团队可共享**的最小平台：

1. **轻量 Web 控制台**：设备列表（ADB 设备状态）、任务触发（选择包名 → 选 AI 探索 / Monkey → 执行）、结果查看（最近任务状态 + 报告链接）。
2. **设备池 + 多设备并行**：从单设备串行升级为可配置的多设备并行执行，复用 Midscene 的并发配置能力。
3. **CI 集成**：提供 GitHub Actions 工作流，在 PR / 定时任务中自动执行 Web 冒烟测试和 Android Monkey（固定 seed，可选），产物上传为 artifacts。

**本周不做**：WebView CDP 完整接入、小程序接入、用户权限体系、数据库持久化（用文件系统即可）、生产级部署。

## 参考工程（新增）

| 参考源 | 用途 |
|---|---|
| `ref/midscene-example/.github/workflows/` 或 Midscene 官方 CI 配置 | GitHub Actions 工作流结构、环境变量注入方式、`MIDSCENE_REPORT_QUIET` 等 CI 专用配置[reference:4] |
| **`lycoding/auto-test-platform`（Gitee）** | **首选架构参考**。分布式测试平台的 Master/Worker 分层、Android 设备池的注册/心跳/占用/释放模型、Midscene CLI 的插件化调用方式[reference:5] |
| Midscene 设备池配置文档 | `devices.yaml` 的设备列表、`scheduling.strategy`、`maxConcurrent` 等并发参数[reference:6] |
| `midscene.config.ts` 的 `setup` / `nodes` 用法 | 并发数、超时、设备资源的声明式配置[reference:7] |

**查证顺序不变**：`ref/` 可运行代码 → `.d.ts` → 官方文档。`lycoding/auto-test-platform` 是 Java + Python 技术栈，**只参考架构模型，不引入其技术栈**；你的实现保持 TypeScript 单一栈。

## 硬约束

- **不引入数据库**。任务记录和设备状态用 JSON 文件落盘到 `platform/state/`。
- **不引入 Java / Python**。Web 控制台用 Node.js 内置 `http` 模块或一个极轻量框架（如 `hono`），前端用**单个 HTML + 原生 JS**，不引入 React/Vue 构建链。
- **不修改前三周的测试用例和执行逻辑**。平台层只负责触发 CLI 命令、读取产物、展示结果。
- 设备池的“并行”通过**多个 Node 子进程**实现，每个子进程独立调用 `pnpm explore` / `pnpm monkey`，不修改 Midscene 内部实现。

## 技术路线（按顺序执行，每步提交）

**Step 1 — 统一 CLI 入口**

创建 `bin/autotest.ts`，把现有命令收敛为：

```
pnpm autotest explore --package <pkg> [--device <udid>]
pnpm autotest monkey --package <pkg> [--seed <n>] [--events <n>] [--device <udid>]
pnpm autotest web:smoke
pnpm autotest devices
```

内部复用已有的 `explore/`、`monkey/` 和 `tests/web/` 入口，只做参数解析和转发。`devices` 调用 `adb devices -l` 并格式化输出。

**提交**：`feat(cli): unify execution entry with autotest command`

**Step 2 — 轻量 Web 控制台**

在 `platform/server.ts` 中实现一个 HTTP 服务（默认端口 `3210`），提供：

- `GET /`：返回单页 HTML（内联 CSS/JS），包含三个区域：
  - **设备列表**：表格展示 `adb devices -l` 的 udid、状态、模型；
  - **任务触发**：下拉选设备、输入包名、选择 explore/monkey、可选 seed，点击“执行”；
  - **最近任务**：读取 `platform/state/tasks.json`，展示任务 ID、类型、状态、开始时间、报告链接。
- `POST /api/tasks`：接收触发请求，写入任务记录（状态 `running`），**异步 spawn** `pnpm autotest explore/monkey`，子进程结束后更新任务状态并关联产物路径。
- `GET /api/tasks/:id/report`：返回该任务的 Markdown 问题报告或重定向到 Allure 报告路径。
- `GET /api/devices`：返回设备列表 JSON。

**关键设计**：任务执行是**异步**的，HTTP 请求立即返回任务 ID，前端轮询任务状态。不要用同步阻塞请求，否则控制台在高频循环时会不可用。

**提交**：`feat(platform): add lightweight web console with task trigger and device list`

**Step 3 — 设备池与并行执行**

创建 `platform/device-pool.ts`：

- 读取 `platform/devices.yaml`（参考 Midscene 的设备配置格式），声明可用设备列表和 `maxConcurrent`。
- 任务到达时，从池中选取**状态为 idle** 的设备，标记为 busy，执行完毕后释放。
- 如果无空闲设备，任务进入 `queued` 状态，轮询等待。
- 并行通过**多个子进程**实现，每个子进程绑定一个 `--device` 参数，互不干扰。

设备池状态持久化到 `platform/state/devices.json`，控制台展示每个设备的当前状态（idle / busy / offline）。

**提交**：`feat(platform): add device pool with concurrency control and queued tasks`

**Step 4 — CI 集成（GitHub Actions）**

在 `.github/workflows/ai-test.yml` 中定义：

- **触发**：`pull_request`（仅 Web 冒烟）和 `schedule`（每日 Android Monkey，固定 seed）。
- **Web 冒烟 job**：安装依赖 → `pnpm autotest web:smoke` → 上传 Allure 报告为 artifact。
- **Android Monkey job（可选，仅当 runner 有 ADB 设备时）** ：`pnpm autotest monkey --seed 12345 --events 2000` → 上传 `midscene_run/crashes/` 和 `monkey.log` 为 artifact。如果无设备，步骤以“跳过”结束，不失败。
- 模型 API Key 通过 GitHub Secrets 注入，**不硬编码**。

参考 Midscene 官方 workflow 的环境变量配置（`MIDSCENE_MODEL_API_KEY`、`MIDSCENE_REPORT_QUIET` 等）[reference:8]。

**提交**：`ci: add github actions for web smoke and android monkey`

**Step 5 — README 与控制台截图**

更新 README：新增“Web 控制台”章节（启动命令 `pnpm platform`、访问 `http://localhost:3210`）、设备池配置说明、CI 触发方式。在 README 中嵌入一张控制台截图（或用文字描述三个区域的功能）。

**提交**：`docs: add platform console and CI usage to README`

## 验收目标（Definition of Done）

1. `pnpm platform` 启动后，浏览器打开 `http://localhost:3210`，能看到设备列表（至少一台已连接设备显示为 idle）。
2. 通过控制台触发一次 `monkey` 任务，任务出现在“最近任务”中，状态从 running 变为 completed，报告链接可点击并打开 `problem-report.md`。
3. `platform/devices.yaml` 中配置两台设备（如果只有一台真机，第二台可用 `emulator-5554` 占位），`maxConcurrent: 1` 时两个任务串行，`maxConcurrent: 2` 时并行（通过任务时间戳验证）。
4. GitHub Actions 工作流文件语法合法，`web:smoke` job 在 PR 上可运行（如果没有 CI 环境，本地用 `act` 验证语法，或在 README 中注明“未在真实 GitHub runner 上执行”）。
5. 前三周的 `pnpm test:web`、`pnpm test:android`、`pnpm autotest explore`、`pnpm autotest monkey` 仍可用，平台层不破坏原有入口。
6. `CHANGELOG.md` 更新；`git log --oneline main..feat/w4-platform` 至少 5 条有意义的提交。

## 自主工作规则

- **不要中途询问**。API 不确定时查 `ref/` 和 `.d.ts`。设备未连接或 CI 无法真实运行时，完成骨架 + 可读降级 + README 标注，**不伪造执行结果**。
- **平台层保持极简**。不要因为“控制台”而引入前端框架、数据库或用户系统。单人可用优先，代码量控制在可控范围。
- **不修改 `ref/`**。不 mock 崩溃检测。宁可报告“CI 未在真实 runner 验证”，不可伪造 workflow 运行成功。

## 完成后的汇报格式

1. 验收命令逐条结果，包括控制台截图的文字描述和任务状态变化。
2. `git log --oneline main..feat/w4-platform` 和 `CHANGELOG.md` 摘要。
3. 设备池的实际并发验证结果（任务时间戳或日志）。
4. CI 工作流文件内容摘要，以及验证方式（真实 runner / `act` / 仅语法检查）。
5. 第四周参考使用清单。
6. **对“距离完整实现还有多远”的自我评估**：按 WebView、小程序、报告看板、生产级调度四个维度，各给出“已完成 / 有雏形 / 未开始”的判断和依据。

---

## 实现对照（2026-10-29 按代码核对）

> 本节是事后核对，以上正文保留当时的需求原文。项目当前全貌见 `PROJECT-SUMMARY.md`。
> 编号说明：本文即 **W4** 里程碑，2026-10-20 完成；文件名是 week1、正文写「第四周」，原因同 W2。

**已实现**（分支 `feat/w4-platform`，2026-10-21 经 `feat/imui-ui-loadtest` 的合并 `f363f4a` 进入 `main`）

- 统一 CLI：`bin/autotest.ts`，提供 `explore`、`monkey`、`web:smoke`、`devices`。用 node 直接拉起 tsx，不经 shell，所以 Windows 下带空格的参数不会被拆开。
- 控制台：`platform/server.ts`（`node:http`，端口 3210）+ 单页 `platform/console.html`，接口 `/api/devices`、`/api/tasks`（POST 立即返回任务 id）、`/api/tasks/:id`、`/report`、`/log`、`/cancel`。
- 任务：`platform/tasks.ts#TaskManager`，FIFO、每 2 秒调度一次、每个任务一个子进程、服务端硬超时、取消即强杀进程树；状态落盘 `platform/state/tasks.json`。
- 设备池：`platform/device-pool.ts`（`devices.yaml` 的 `maxConcurrent`、`scheduling.strategy` 为 `first-idle | round-robin`，状态 idle / busy / offline，靠 adb 刷新）。
- CI：`.github/workflows/ai-test.yml`。

**正文之外同期完成的**（CHANGELOG「W4 平台 alpha」与 imui 两节）

- 自然语言任务 `mission/`（`planner.ts#planMission` 生成计划，`runner.ts#runMission` 按轮执行：冷 / 热启动交替、场景动作、随机探索、检查、视觉探测、gfxinfo 卡顿统计），以及步数 / 时长 / 看门狗多层上限。
- Midscene 计划缓存、`--plan` 复用、即时重放（`replay/ops.ts`、`scripts/replay.ts`）。
- imui：im-loadtest 在界面层的移植，见 `docs/imui.md`。

**与正文不同 / 后来的变化**

- **控制台位置变了**：W2-3 起首页 `/` 换成新的 Web 页面，旧控制台移到 `/console`；任务类型从 explore / monkey 扩展为 mission、explore、monkey、imui、issue、sync、series（`tasks.ts#validateTaskInput`）。
- **任务结果不再解析日志**：平台读子进程写的结构化结果（`AUTOTEST_RESULT_FILE`，W2-3）；mission 例外，平台直接读 `midscene_run/missions/<id>/mission.json`。
- **平台重启时的处理**：`TaskManager#load` 把 running / queued 的旧任务一律标为 failed，不核对子进程是否还活着。W2-3 的新任务走另一套生命周期（`platform/lifecycle/`），不受此影响。
- **设备池改为分槽**：M6 起按「端点 × 执行端」分槽租用，本机也算端点（`host:local`）。租用状态只在进程内存里，`platform/state/devices.json` 只写不读，所以多个进程之间没有互斥。
- **CI 的实际内容**：所有事件都会跑 typecheck + 单测；PR 跑 Web 冒烟，没有 API key 时警告后以成功结束；定时 / 手动跑计算器 Monkey（seed 12345，2000 事件），没有设备时步骤跳过、任务仍显示成功。工作流**从未在真实 runner 上运行**。
- **两个同名 report**：`pnpm autotest report` 是问题报告（`report/problem-report.ts`），`pnpm report` 是 Allure（`scripts/report.ts`）。
- **并行验收的条件**：用的是同一台手机的 USB 与 Wi-Fi 两个连接，不是两台物理设备。
