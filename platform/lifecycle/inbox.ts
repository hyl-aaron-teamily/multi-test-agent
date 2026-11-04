// Instructions added to a running exploration task (W2-5 §7.2, draft X6): the API appends, the task process
// reads new lines at each step boundary and hands them to the model. One JSON line per instruction.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskDir } from './task';

export interface Instruction {
  at: string;
  text: string;
}

export const inboxFile = (taskId: string) => join(taskDir(taskId), 'inject.jsonl');

/** Append one instruction; returns how many the task has now. */
export function appendInstruction(taskId: string, text: string): number {
  appendFileSync(inboxFile(taskId), `${JSON.stringify({ at: new Date().toISOString(), text } satisfies Instruction)}\n`);
  return readInstructions(taskId).length;
}

export function readInstructions(taskId: string): Instruction[] {
  const f = inboxFile(taskId);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Instruction];
      } catch {
        return [];
      }
    });
}

/** The task process's reader: each call returns the instructions added since the previous call. */
export function inboxReader(taskId: string): () => string[] {
  let seen = 0;
  return () => {
    const all = readInstructions(taskId);
    const fresh = all.slice(seen);
    seen = all.length;
    return fresh.map((x) => x.text);
  };
}
