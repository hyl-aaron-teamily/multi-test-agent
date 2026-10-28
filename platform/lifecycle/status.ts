// Status codes (W2-3 §5.2, F8): every new command's JSON result carries `status` (HTTP-like), `code` (stable
// string) and `exit` (process exit code; the tens digit is the class). 1 stays "uncaught exception" (Node's
// default), nothing ≥ 128 (signals).
export const STATUS = {
  OK: { exit: 0, status: 200, text: '命令成功' },
  UNCAUGHT: { exit: 1, status: 500, text: '未捕获异常（工具缺陷）' },
  NOT_REPRODUCED: { exit: 10, status: 200, text: '未复现' },
  REPRODUCED: { exit: 11, status: 200, text: '已复现' },
  PARTIAL: { exit: 12, status: 200, text: '部分实现' },
  IMPLEMENTED: { exit: 13, status: 200, text: '已实现' },
  NOT_IMPLEMENTED: { exit: 14, status: 200, text: '未实现' },
  SUSPECTED_MISOP: { exit: 15, status: 200, text: '疑似误操作' },
  TURNED_BUG: { exit: 16, status: 200, text: '转为 bug' },
  SERIES_DONE: { exit: 17, status: 207, text: '系列完成（各次结论见 JSON）' },
  ACCEPTED: { exit: 20, status: 202, text: '已受理（任务已排队）' },
  STILL_RUNNING: { exit: 21, status: 202, text: 'wait 超时，任务仍在运行' },
  APPROVAL_REQUIRED: { exit: 30, status: 403, text: '需要人在 Web 同意' },
  PLAN_HASH_MISMATCH: { exit: 31, status: 409, text: '计划哈希不一致' },
  PLAN_STALE: { exit: 32, status: 409, text: '批准后版本变化（SKILL / profile / App / Issue）' },
  APPROVAL_EXHAUSTED: { exit: 33, status: 429, text: '超出批准的运行次数' },
  BAD_INPUT: { exit: 40, status: 400, text: '参数错误' },
  NOT_FOUND: { exit: 41, status: 404, text: '对象不存在' },
  PLAN_NOT_EXECUTABLE: { exit: 42, status: 422, text: '计划不可执行' },
  ENV_UNFIT: { exit: 50, status: 503, text: '环境不合格（预检失败）' },
  ENV_LOCKED: { exit: 51, status: 423, text: '手机锁屏，需人工解锁' },
  ENV_OFFLINE: { exit: 52, status: 503, text: '设备离线 / 浏览器不可用' },
  ENV_QUARANTINED: { exit: 53, status: 423, text: '环境已隔离，需人工处理' },
  PLATFORM_DOWN: { exit: 54, status: 503, text: '平台服务未启动' },
  TOOL_FAILED: { exit: 60, status: 500, text: '工具失败' },
  SKILL_STALE: { exit: 61, status: 500, text: 'SKILL 失效' },
  TASK_STUCK: { exit: 62, status: 500, text: '任务卡死，被看门狗终止' },
  TASK_CRASHED: { exit: 63, status: 500, text: '任务进程意外退出' },
  CANCELLED: { exit: 70, status: 499, text: '已取消' },
  TIMED_OUT: { exit: 71, status: 504, text: '超出时长上限' },
  INTERRUPTED: { exit: 72, status: 410, text: '环境下线 / 服务重启导致中断' },
} as const;

export type Code = keyof typeof STATUS;
export type ErrorKind = 'env' | 'tool' | 'input' | 'policy';

export interface Outcome {
  status: number;
  code: Code;
  exit: number;
}

export interface ApiError extends Outcome {
  message: string;
  hint?: string;
  retryable: boolean;
  kind: ErrorKind;
}

export const outcome = (code: Code): Outcome => ({ status: STATUS[code].status, code, exit: STATUS[code].exit });

const KIND: Partial<Record<Code, ErrorKind>> = { BAD_INPUT: 'input', NOT_FOUND: 'input', APPROVAL_REQUIRED: 'policy', PLAN_HASH_MISMATCH: 'policy', PLAN_STALE: 'policy', APPROVAL_EXHAUSTED: 'policy', PLAN_NOT_EXECUTABLE: 'tool', TOOL_FAILED: 'tool', SKILL_STALE: 'tool', TASK_STUCK: 'tool', TASK_CRASHED: 'tool', UNCAUGHT: 'tool' };
const RETRYABLE = new Set<Code>(['STILL_RUNNING', 'ENV_UNFIT', 'ENV_LOCKED', 'ENV_OFFLINE', 'PLATFORM_DOWN', 'TASK_STUCK', 'TASK_CRASHED', 'INTERRUPTED', 'TIMED_OUT', 'TOOL_FAILED']);

export function apiError(code: Code, message: string, hint?: string): ApiError {
  return { ...outcome(code), message, hint, retryable: RETRYABLE.has(code), kind: KIND[code] ?? 'env' };
}

export class CodedError extends Error {
  constructor(
    public code: Code,
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
  toJSON(): ApiError {
    return apiError(this.code, this.message, this.hint);
  }
}

/** Pure: a run conclusion (executor wording) → status code. 执行失败 goes to 5x / 6x by its failure kind. */
export function codeOfConclusion(conclusion: string, failureKind?: 'env' | 'tool'): Code {
  switch (conclusion) {
    case '未复现':
      return 'NOT_REPRODUCED';
    case '已复现':
      return 'REPRODUCED';
    case '部分实现':
      return 'PARTIAL';
    case '已实现':
      return 'IMPLEMENTED';
    case '未实现':
      return 'NOT_IMPLEMENTED';
    case '疑似误操作':
      return 'SUSPECTED_MISOP';
    case '转为 bug':
      return 'TURNED_BUG';
    case '计划不可执行':
      return 'PLAN_NOT_EXECUTABLE';
    case 'SKILL 失效':
      return 'SKILL_STALE';
    case '环境不合格':
      return 'ENV_UNFIT';
    default:
      return failureKind === 'env' ? 'ENV_UNFIT' : 'TOOL_FAILED';
  }
}

/** Pure: the code a set of runs ends with (several sub-cases: the worst no-verdict code wins, else the first
 *  conclusion; a reproduction beats not-reproduced). */
export function codeOfRuns(runs: { conclusion: string; failure?: { kind: 'env' | 'tool' } }[]): Code {
  if (!runs.length) return 'OK';
  const codes = runs.map((r) => codeOfConclusion(r.conclusion, r.failure?.kind));
  const bad = codes.find((c) => STATUS[c].exit >= 40);
  if (bad) return bad;
  return codes.includes('REPRODUCED') ? 'REPRODUCED' : codes[0];
}
