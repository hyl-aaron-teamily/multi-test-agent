// Task-process side of the lifecycle (W2-3 §4.1, §4.3 L1/L2, G6): registers the process in the task and
// the lease, writes a heartbeat every 5 s from its own timer, reports progress (phase / round / step),
// writes the side-effect ledger BEFORE each effect, and turns a cancel request (file flag, SIGINT, SIGTERM)
// into a stop at the next step boundary.
import type { PlannedAction } from '../schema/test-plan';
import { bindLeaseProc } from './env';
import { selfId } from './proc';
import { appendLine } from './store';
import { event, getTask, ledgerFile, type LedgerEntry, moveTask, type Phase, type TaskState, updateTask } from './task';

export class CancelledError extends Error {
  constructor(why = 'cancel requested') {
    super(why);
    this.name = 'CancelledError';
  }
}

/** Hooks the executor calls (executor/run.ts RunOptions.hooks). All optional for the executor. */
export interface RunHooks {
  phase(p: Phase): void;
  /** Before every planned action (step boundary): may throw CancelledError; writes ledger + progress. */
  beforeAction(a: PlannedAction, info: { round: number; step: number; label?: string; target: (id: string) => string | undefined; budgetMs?: number }): void;
  /** Before a preflight / setting change the executor itself makes. */
  effect(e: Omit<LedgerEntry, 'at' | 'seq' | 'state' | 'phase' | 'round'>): void;
  shouldStop(): boolean;
}

const SEND_NODES = new Set(['teamily.sendMessage', 'teamily.quoteReply', 'teamily.tapSend']);
const TYPE_NODES = new Set(['teamily.typeMention', 'teamily.freezeMention', 'teamily.tapRewrite', 'teamily.clearComposer']);
const ENTER_NODES = new Set(['teamily.openConversation', 'teamily.switchConversation']);

/** Pure: the side effect a planned action has on the environment (undefined = none worth recording). */
export function effectOf(a: PlannedAction, conv: string | undefined, target: (id: string) => string | undefined): Omit<LedgerEntry, 'at' | 'seq' | 'state'> | undefined {
  const n = a.node?.name;
  const inp = (a.node?.input ?? {}) as Record<string, unknown>;
  if (n && ENTER_NODES.has(n)) {
    const id = String(inp.target ?? inp.from ?? '');
    return { kind: 'enter-conversation', target: target(id) ?? id };
  }
  if (n && SEND_NODES.has(n)) return { kind: 'send', target: conv, value: String(inp.text ?? '') || undefined };
  if (n && TYPE_NODES.has(n)) return { kind: 'type', target: conv, value: n === 'teamily.typeMention' ? '@' : n.replace('teamily.', '') };
  if (a.type === 'type') return { kind: 'type', target: conv, value: a.value };
  if (a.type === 'launch' || a.type === 'killApp' || a.type === 'reload') return { kind: 'launch', value: a.type };
  return undefined;
}

export class TaskRuntime implements RunHooks {
  private timer?: NodeJS.Timeout;
  private seq = 0;
  private cancelled = false;
  private lastPoll = 0;
  private cur: { phase?: Phase; round?: number; step?: number } = {};
  private conv?: string;
  private lastWrite = 0;

  constructor(
    public taskId: string,
    private heartbeatMs = 5000,
  ) {}

  /** Register this process, start the heartbeat, listen for SIGINT / SIGTERM. */
  start(): void {
    const me = selfId();
    const t = updateTask(this.taskId, (t) => {
      t.proc = me;
      t.heartbeatAt = new Date().toISOString();
    });
    bindLeaseProc(t.envId, t.id, me);
    this.timer = setInterval(() => this.beat(), this.heartbeatMs);
    const onSig = () => {
      this.cancelled = true;
      event(this.taskId, { type: 'note', note: 'signal: stop at the next step boundary' });
    };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  }

  beat(): void {
    try {
      updateTask(this.taskId, (t) => void (t.heartbeatAt = new Date().toISOString()));
    } catch {
      /* next beat */
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }

  move(to: TaskState, basis: string, patch?: Parameters<typeof moveTask>[4]): void {
    moveTask(this.taskId, to, 'task', basis, patch);
  }

  phase(p: Phase): void {
    this.cur = { phase: p };
    updateTask(this.taskId, (t) => void (t.progress = { phase: p, at: new Date().toISOString() }));
    event(this.taskId, { type: 'progress', phase: p });
  }

  shouldStop(): boolean {
    if (this.cancelled) return true;
    // The cancel flag lives in task.json; read it at most once a second.
    if (Date.now() - this.lastPoll > 1000) {
      this.lastPoll = Date.now();
      if (getTask(this.taskId)?.cancelRequested) this.cancelled = true;
    }
    return this.cancelled;
  }

  beforeAction(a: PlannedAction, info: { round: number; step: number; label?: string; target: (id: string) => string | undefined; budgetMs?: number }): void {
    if (this.shouldStop()) throw new CancelledError();
    this.cur = { ...this.cur, round: info.round, step: info.step };
    const now = Date.now();
    // Progress is written at most every 500 ms (steps are ≤ 1 s apart), always with the step budget.
    if (now - this.lastWrite > 500) {
      this.lastWrite = now;
      updateTask(this.taskId, (t) => void (t.progress = { ...this.cur, at: new Date(now).toISOString(), summary: info.label, stepBudgetMs: info.budgetMs }));
    }
    const e = effectOf(a, this.conv, info.target);
    if (!e) return;
    if (e.kind === 'enter-conversation') this.conv = e.target;
    this.effect(e);
  }

  effect(e: Omit<LedgerEntry, 'at' | 'seq' | 'state' | 'phase' | 'round'>): void {
    appendLine(ledgerFile(this.taskId), { at: new Date().toISOString(), seq: ++this.seq, ...e, phase: this.cur.phase, round: this.cur.round, state: 'intent' } satisfies LedgerEntry);
  }

  get position() {
    return { ...this.cur };
  }
}
