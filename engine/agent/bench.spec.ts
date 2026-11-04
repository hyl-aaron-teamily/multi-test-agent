import { describe, expect, it } from 'vitest';
import { isEmulator, openBenchSession } from '../session';
import { type BenchTask, type BenchTaskResult, benchMarkdown, outcome, PILOT_TASKS, selectTasks, summarize } from './bench';
import { classifyRisk } from './risk';
import { agentLimits } from './run';
import { parseAnswer } from './step';

const task = (name: string, complexity = 1, apps = ['contacts']): BenchTask => ({ name, instances: 1, apps, complexity, maxSteps: Math.trunc(10 * complexity) });
const res = (name: string, success: boolean, o: Partial<BenchTaskResult> = {}): BenchTaskResult => ({ name, idx: 0, goal: '', apps: ['contacts'], complexity: 1, maxSteps: 10, done: true, success, official: success, status: 'completed', steps: 5, seconds: 30, modelCalls: 5, runDir: '', ...o });

describe('bench mode (AndroidWorld, W2-5 P1)', () => {
  it('runs only on an emulator', async () => {
    expect(isEmulator('emulator-5554')).toBe(true);
    for (const u of ['4f2ebdf2', 'emulator', 'emulator-', '192.168.1.2:5555', 'xemulator-5554']) expect(isEmulator(u), u).toBe(false);
    await expect(openBenchSession('4f2ebdf2', () => {})).rejects.toThrow(/only on an emulator/);
  });

  it('nothing is blocked in bench mode; outside it the rules are unchanged', () => {
    for (const label of ['Delete', '删除', 'Send', 'Settings', 'Like', '关注'])
      expect(classifyRisk({ type: 'tap', label }, true, { bench: true }), label).toMatchObject({ blocked: false });
    expect(classifyRisk({ type: 'type', label: 'Name', text: 'John' }, false, { bench: true }).blocked).toBe(false);
    expect(classifyRisk({ type: 'tap', label: 'Delete' }, true).blocked).toBe(true);
    expect(classifyRisk({ type: 'tap', label: '关注' }, true).blocked).toBe(true);
    expect(classifyRisk({ type: 'type', label: 'Name', text: 'John' }).blocked).toBe(true);
  });

  it('bench actions parse only in bench mode; report_issue and launch only outside it', () => {
    const p = (action: object, bench: boolean) => parseAnswer({ thought: '', action }, bench)?.action;
    expect(p({ type: 'open_app', app: ' Contacts ' }, true)).toEqual({ type: 'open_app', app: 'Contacts' });
    expect(p({ type: 'answer', text: '3' }, true)).toEqual({ type: 'answer', text: '3' });
    expect(p({ type: 'home' }, true)).toEqual({ type: 'home' });
    expect(p({ type: 'enter' }, true)).toEqual({ type: 'enter' });
    expect(p({ type: 'open_app', app: '' }, true)).toBeUndefined();
    for (const a of [{ type: 'open_app', app: 'Contacts' }, { type: 'answer', text: '3' }, { type: 'home' }, { type: 'enter' }]) expect(p(a, false), a.type).toBeUndefined();
    expect(p({ type: 'report_issue', description: 'x' }, true)).toBeUndefined();
    expect(p({ type: 'launch' }, true)).toBeUndefined();
    expect(p({ type: 'report_issue', description: 'x' }, false)).toEqual({ type: 'report_issue', description: 'x' });
    expect(p({ type: 'launch' }, false)).toEqual({ type: 'launch' });
  });

  it('selects named tasks, the pilot set or all; unknown names are an error', () => {
    const all = [...PILOT_TASKS, 'MarkorDeleteNote'].map((n) => task(n));
    expect(selectTasks(all, {}).length).toBe(11);
    expect(selectTasks(all, { pilot: true }).map((t) => t.name)).toEqual([...PILOT_TASKS]);
    expect(selectTasks(all, { tasks: ['MarkorDeleteNote', 'ClockTimerEntry'] }).map((t) => t.name)).toEqual(['ClockTimerEntry', 'MarkorDeleteNote']);
    expect(() => selectTasks(all, { tasks: ['Nope'] })).toThrow(/unknown AndroidWorld task/);
  });

  it('success = the app state checks out; AndroidWorld’s rule also needs the agent to end the task', () => {
    expect(outcome(1, 'completed')).toEqual({ done: true, success: true, official: true });
    expect(outcome(1, 'failed')).toEqual({ done: true, success: true, official: true });
    expect(outcome(0, 'completed')).toEqual({ done: true, success: false, official: false });
    // the goal holds although the agent ran out of steps: a success, not an official one
    expect(outcome(1, 'limit')).toEqual({ done: false, success: true, official: false });
    expect(outcome(undefined, 'error')).toEqual({ done: false, success: false, official: false });
  });

  it('summary: errors count as failures; tasks count under each app and their complexity', () => {
    const s = summarize([res('A', true), res('B', false, { apps: ['contacts', 'sms'], complexity: 2 }), res('C', false, { error: 'HTTP 500', status: 'error', done: false })]);
    expect(s).toMatchObject({ tasks: 3, ran: 2, errors: 1, successes: 1, steps: 15, seconds: 90, modelCalls: 15 });
    expect(s.rate).toBeCloseTo(1 / 3);
    expect(s.byApp).toEqual({ contacts: { tasks: 3, successes: 1 }, sms: { tasks: 1, successes: 0 } });
    expect(s.byComplexity).toEqual({ '1': { tasks: 2, successes: 1 }, '2': { tasks: 1, successes: 0 } });
    const md = benchMarkdown({ seed: 42, combos: 1, model: 'm', startedAt: 't' }, [res('A', true), res('C', false, { error: 'a | b', status: 'error' })]);
    expect(md).toMatch(/成功率：\*\*1 \/ 2（50\.0%）/);
    expect(md).toMatch(/\| C#0 \| ❌ .*\| a \/ b \|/);
    expect(summarize([]).rate).toBe(0);
  });

  it('exploration limits: 500 steps / 30 minutes by default and at most (W2-5 N2)', () => {
    expect(agentLimits({})).toEqual({ maxSteps: 500, maxMinutes: 30 });
    expect(agentLimits({ maxSteps: 12, maxMinutes: 5 })).toEqual({ maxSteps: 12, maxMinutes: 5 });
    expect(agentLimits({ maxSteps: 3000, maxMinutes: 120 })).toEqual({ maxSteps: 500, maxMinutes: 30 });
  });
});
