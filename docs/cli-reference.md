# 命令行参考（W2-3，面向 Agent）

> 由 `npx tsx scripts/cli-ref.ts` 从 `autotest help --json` 生成，勿手改。

用法：`autotest <object> <action> [args] [--json]`

- --json: stdout is exactly one JSON object; logs go to stderr
- never interactive
- exit code = envelope.exit (two digits, tens = class); 1 = uncaught tool exception
- every command except help and env recover needs the platform service (pnpm platform) → else 54
- sensitive plans / full access / environment configuration items are approved on the Web only

## 命令

### `autotest help`

All commands, their arguments and the status-code table

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`（另有 1 / 40 / 54）

### `autotest issue list`

Issues with category, draft and plan ids / approval state

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`（另有 1 / 40 / 54）

### `autotest issue show`

One Issue

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <id> | string | 是 | Issue id (issues/<id>.md) |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`、`NOT_FOUND`（另有 1 / 40 / 54）

### `autotest draft create`

Draft an Issue anew (may call the model); returns its plan ids

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <id> | string | 是 | Issue id |
| --env | string |  | test | prod (default prod) |
| --no-model | boolean |  | rules only |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`、`NOT_FOUND`（另有 1 / 40 / 54）

### `autotest draft show`

The saved draft with a PlanView per sub-case

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <id> | string | 是 | Issue id |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`、`NOT_FOUND`（另有 1 / 40 / 54）

### `autotest plan explain`

Before running: steps, impact, uncertainty, model calls, duration, approval class (PlanView)

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <planId> | string | 是 | <Issue>/<sub>:<surface>@v<draft version>, e.g. 2010/main:android-app@v1 |
| --series | integer |  | series size the approval would be for |
| --max-rounds | integer |  | valid attempts per run |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`、`NOT_FOUND`、`PLAN_STALE`、`PLAN_NOT_EXECUTABLE`（另有 1 / 40 / 54）

### `autotest plan approve`

Approve a default-class plan by its hash (sensitive plans: Web only → 30)

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <planId> | string | 是 | <Issue>/<sub>:<surface>@v<draft version>, e.g. 2010/main:android-app@v1 |
| --hash | string | 是 | hash from plan explain |
| --runs | integer |  | runs allowed (default 1) |
| --series | integer |  | series size allowed |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`、`APPROVAL_REQUIRED`、`PLAN_HASH_MISMATCH`、`PLAN_NOT_EXECUTABLE`（另有 1 / 40 / 54）

### `autotest plan reject`

Reject a plan (note required)

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <planId> | string | 是 | <Issue>/<sub>:<surface>@v<draft version>, e.g. 2010/main:android-app@v1 |
| --note | string | 是 | why |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`（另有 1 / 40 / 54）

### `autotest env list`

Environments and their state (EnvView)

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`（另有 1 / 40 / 54）

### `autotest env show`

One environment: baseline items, lease, dirty mark, configuration items

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <envId> | string | 是 | <surface>:<device>@<service env>, e.g. android-app:4f2ebdf2@prod |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`、`NOT_FOUND`（另有 1 / 40 / 54）

### `autotest env check`

Baseline check (recovers what it can); quarantined → checking needs this from a person

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <envId> | string | 是 | <surface>:<device>@<service env>, e.g. android-app:4f2ebdf2@prod |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`、`ENV_UNFIT`、`ENV_LOCKED`、`ENV_OFFLINE`、`ENV_QUARANTINED`（另有 1 / 40 / 54）

### `autotest env recover`

Recover an environment from its declaration and the last task ledger (local process)

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <envId> | string | 是 | <surface>:<device>@<service env>, e.g. android-app:4f2ebdf2@prod |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`、`ENV_UNFIT`、`ENV_LOCKED`、`ENV_OFFLINE`、`ENV_QUARANTINED`（另有 1 / 40 / 54）

### `autotest env offline`

Take an environment offline (stops its task gracefully, recovers)

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <envId> | string | 是 | <surface>:<device>@<service env>, e.g. android-app:4f2ebdf2@prod |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`（另有 1 / 40 / 54）

### `autotest task run`

Submit a plan; returns the task id at once (20). Default-class plans are approved by policy

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <planId> | string | 是 | <Issue>/<sub>:<surface>@v<draft version>, e.g. 2010/main:android-app@v1 |
| --env | string |  | environment id (default: the plan surface’s ready one) |
| --series | integer |  | N independent runs |
| --max-rounds | integer |  | valid attempts per run |
| --hash | string |  | expected plan hash (31 on mismatch) |
| --dry-run | boolean |  | check everything, start nothing |
| --idempotency-key | string |  | same key → the same task |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`ACCEPTED`、`OK`、`APPROVAL_REQUIRED`、`PLAN_HASH_MISMATCH`、`PLAN_STALE`、`APPROVAL_EXHAUSTED`、`NOT_FOUND`、`PLAN_NOT_EXECUTABLE`、`ENV_UNFIT`、`ENV_LOCKED`、`ENV_OFFLINE`、`ENV_QUARANTINED`（另有 1 / 40 / 54）

### `autotest task status`

TaskView: state, phase / round / step, how and where it ended, ledger summary, recovery

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <taskId> | string | 是 | task id from task run |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`、`NOT_FOUND`（另有 1 / 40 / 54）

### `autotest task wait`

Wait until the task ends; exit = its outcome code, 21 when --timeout passes first

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <taskId> | string | 是 | task id from task run |
| --timeout | integer |  | seconds (default 600) |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`STILL_RUNNING`、`NOT_REPRODUCED`、`REPRODUCED`、`PARTIAL`、`IMPLEMENTED`、`NOT_IMPLEMENTED`、`SUSPECTED_MISOP`、`TURNED_BUG`、`SERIES_DONE`、`PLAN_NOT_EXECUTABLE`、`ENV_UNFIT`、`ENV_LOCKED`、`ENV_OFFLINE`、`TOOL_FAILED`、`SKILL_STALE`、`TASK_STUCK`、`TASK_CRASHED`、`CANCELLED`、`TIMED_OUT`、`INTERRUPTED`（另有 1 / 40 / 54）

### `autotest task cancel`

Cancel: queued → cancelled; running → stops at the next step boundary, then teardown + recovery

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <taskId> | string | 是 | task id from task run |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`、`NOT_FOUND`、`BAD_INPUT`（另有 1 / 40 / 54）

### `autotest task list`

Recent tasks

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| --limit | integer |  | default 50 |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`（另有 1 / 40 / 54）

### `autotest doctor`

Can runs start, what is missing, what to do next (ready / degraded / blocked; next steps split into commands and things only a person can do). Works with the platform down

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| --fix | boolean |  | safe local cleanup: stale locks, stale tree-service forwards, leases of dead tasks (never touches the device, never restarts adb) |
| --probe | boolean |  | one screenshot + tree read per phone, both backends timed |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`OK`、`PLATFORM_DOWN`、`ENV_LOCKED`、`ENV_OFFLINE`、`ENV_UNFIT`（另有 1 / 40 / 54）

### `autotest result show`

ResultView of a finished task: conclusion sentence, basis, attempts, flags, failure kind, evidence

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| <taskId> | string | 是 | task id from task run |
| --json | boolean |  | stdout = one JSON envelope { status, code, exit, summary, data, error } |

可能的状态码：`STILL_RUNNING`、`NOT_REPRODUCED`、`REPRODUCED`、`PARTIAL`、`IMPLEMENTED`、`NOT_IMPLEMENTED`、`SERIES_DONE`、`TOOL_FAILED`、`ENV_UNFIT`、`CANCELLED`、`INTERRUPTED`、`TASK_CRASHED`、`TASK_STUCK`（另有 1 / 40 / 54）

## 状态码

| 退出码 | status | code | 含义 |
|---|---|---|---|
| 0 | 200 | `OK` | 命令成功 |
| 1 | 500 | `UNCAUGHT` | 未捕获异常（工具缺陷） |
| 10 | 200 | `NOT_REPRODUCED` | 未复现 |
| 11 | 200 | `REPRODUCED` | 已复现 |
| 12 | 200 | `PARTIAL` | 部分实现 |
| 13 | 200 | `IMPLEMENTED` | 已实现 |
| 14 | 200 | `NOT_IMPLEMENTED` | 未实现 |
| 15 | 200 | `SUSPECTED_MISOP` | 疑似误操作 |
| 16 | 200 | `TURNED_BUG` | 转为 bug |
| 17 | 207 | `SERIES_DONE` | 系列完成（各次结论见 JSON） |
| 20 | 202 | `ACCEPTED` | 已受理（任务已排队） |
| 21 | 202 | `STILL_RUNNING` | wait 超时，任务仍在运行 |
| 30 | 403 | `APPROVAL_REQUIRED` | 需要人在 Web 同意 |
| 31 | 409 | `PLAN_HASH_MISMATCH` | 计划哈希不一致 |
| 32 | 409 | `PLAN_STALE` | 批准后版本变化（SKILL / profile / App / Issue） |
| 33 | 429 | `APPROVAL_EXHAUSTED` | 超出批准的运行次数 |
| 40 | 400 | `BAD_INPUT` | 参数错误 |
| 41 | 404 | `NOT_FOUND` | 对象不存在 |
| 42 | 422 | `PLAN_NOT_EXECUTABLE` | 计划不可执行 |
| 50 | 503 | `ENV_UNFIT` | 环境不合格（预检失败） |
| 51 | 423 | `ENV_LOCKED` | 手机锁屏，需人工解锁 |
| 52 | 503 | `ENV_OFFLINE` | 设备离线 / 浏览器不可用 |
| 53 | 423 | `ENV_QUARANTINED` | 环境已隔离，需人工处理 |
| 54 | 503 | `PLATFORM_DOWN` | 平台服务未启动 |
| 60 | 500 | `TOOL_FAILED` | 工具失败 |
| 61 | 500 | `SKILL_STALE` | SKILL 失效 |
| 62 | 500 | `TASK_STUCK` | 任务卡死，被看门狗终止 |
| 63 | 500 | `TASK_CRASHED` | 任务进程意外退出 |
| 70 | 499 | `CANCELLED` | 已取消 |
| 71 | 504 | `TIMED_OUT` | 超出时长上限 |
| 72 | 410 | `INTERRUPTED` | 环境下线 / 服务重启导致中断 |

## 结果信封

`--json` 时 stdout 只有一个对象：`{ status, code, exit, summary, data?, error? }`；`error = { status, code, message, hint, retryable, kind: env | tool | input | policy }`。`data` 是视图模型（`PlanView` / `EnvView` / `TaskView` / `ResultView`，带 `schemaVersion`），与 Web 页面读的是同一份。
