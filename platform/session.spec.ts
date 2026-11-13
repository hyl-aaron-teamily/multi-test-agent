import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpDir } from '../core/testing/tmp-dir';
import { KEEP_STATE, listSaved, savePath, saveTask, stopTaskProcesses, wipeSession } from './session';
import { getTask } from './lifecycle/task';

let state: string, runs: string, saved: string;
const envBefore = { ...process.env };

function task(id: string, st: string, extra: Record<string, unknown> = {}) {
  mkdirSync(join(state, 'tasks', id), { recursive: true });
  writeFileSync(join(state, 'tasks', id, 'task.json'), JSON.stringify({ schemaVersion: 1, id, kind: 'explore', state: st, createdAt: `2026-11-13T00:00:0${id.length % 10}Z`, ...extra }));
}

beforeEach(() => {
  state = tmpDir('sess-state-');
  runs = tmpDir('sess-runs-');
  saved = join(tmpDir('sess-saved-'), 'saved');
  Object.assign(process.env, { AUTOTEST_STATE_DIR: state, AUTOTEST_RUNS_DIR: runs, AUTOTEST_SAVED_DIR: saved });
});
afterEach(() => {
  for (const k of ['AUTOTEST_STATE_DIR', 'AUTOTEST_RUNS_DIR', 'AUTOTEST_SAVED_DIR']) if (envBefore[k] === undefined) delete process.env[k];
  else process.env[k] = envBefore[k];
});

describe('platform/session (every start is a new platform; 「另存为」 keeps a run)', () => {
  it('wipes every run and the runtime records; keeps configuration, audit, skill cache and `keep`', () => {
    for (const d of ['issues/1903-x', 'explore/a', 'bench/aw-1', 'report']) mkdirSync(join(runs, d), { recursive: true });
    writeFileSync(join(runs, 'loose.log'), 'x');
    task('t-1', 'done');
    for (const f of [...KEEP_STATE.filter((n) => n.includes('.')), 'tasks.json', 'notifications.ndjson', 'devices.json']) writeFileSync(join(state, f), '{}');
    for (const d of ['skill-cache', 'results', 'envs', 'approvals', 'logs', 'locks']) mkdirSync(join(state, d), { recursive: true });
    const r = wipeSession({ keep: ['logs'] });
    expect(r.failed).toEqual([]);
    expect(readdirSync(runs)).toEqual([]);
    expect(readdirSync(state).sort()).toEqual([...KEEP_STATE, 'logs'].sort());
  });

  it('stops only live task processes of unfinished tasks', async () => {
    task('t-run', 'running', { proc: { pid: 101, startedAt: 1 } });
    task('t-dead', 'running', { proc: { pid: 102, startedAt: 1 } });
    task('t-done', 'done', { proc: { pid: 103, startedAt: 1 } });
    const killed: number[] = [];
    const live = new Set([101, 103]);
    const stopped = await stopTaskProcesses({ isAlive: (p) => !!p && live.has(p.pid), kill: (pid) => (killed.push(pid), live.delete(pid)), waitMs: 1000 });
    expect(stopped).toEqual(['t-run']);
    expect(killed).toEqual([101]);
  });

  it('另存为 a task copies its record and run directory; a session wipe leaves it', () => {
    const runDir = join(runs, 'explore', 'android-app-t-1');
    mkdirSync(join(runDir, 'steps'), { recursive: true });
    writeFileSync(join(runDir, 'report.md'), '# r');
    task('t-1', 'done', { runDir, report: join(runDir, 'report.md'), outcome: { code: 'EXPLORE_FINDINGS', summary: '2 个发现' } });
    const r = saveTask(getTask('t-1')!, '聊天 探索');
    expect(r.name).toBe('聊天-探索');
    expect(r.items).toEqual(['task', join('run', 'android-app-t-1')]);
    expect(existsSync(join(r.dir, 'run', 'android-app-t-1', 'report.md'))).toBe(true);
    expect(saveTask(getTask('t-1')!, '聊天 探索').name).toBe('聊天-探索-2');
    wipeSession();
    expect(listSaved().map((x) => [x.name, x.source, x.summary])).toEqual(expect.arrayContaining([['聊天-探索', 't-1', '2 个发现'], ['聊天-探索-2', 't-1', '2 个发现']]));
  });

  it('另存为 a path only inside midscene_run/', () => {
    mkdirSync(join(runs, 'bench', 'aw-1'), { recursive: true });
    writeFileSync(join(runs, 'bench', 'aw-1', 'report.md'), 'x');
    expect(savePath(join(runs, 'bench', 'aw-1'), 'aw').items).toEqual(['aw-1']);
    expect(() => savePath(state)).toThrow(/midscene_run/);
    expect(() => savePath(runs)).toThrow(/midscene_run/);
  });
});
