// Exploration trace export: midscene_run/explore-traces/<timestamp>.json, consumed by
// report/problem-report.ts.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ExploreResult, TraceStep } from './explore-loop';

export interface ExploreTrace {
  package: string;
  source: 'ai-explore';
  udid: string | null;
  startedAt: string;
  finishedAt: string;
  maxSteps: number;
  focus: string | null;
  steps: TraceStep[];
  stateCount: number;
  states: Record<string, string>;
  crashes: { dir: string; timestamp: string; keywords: string[]; matchesPackage: boolean; firstLine: string; step: string | null }[];
  truncated: boolean;
  truncatedReason: string | null;
  midsceneReport: string | null;
  conclusion: string;
}

export const TRACE_DIR = resolve('midscene_run/explore-traces');

export function buildTrace(
  result: ExploreResult,
  meta: { package: string; udid?: string; startedAt: string; maxSteps: number; focus?: string; midsceneReport?: string | null },
): ExploreTrace {
  const appCrashes = result.crashes.filter((c) => c.matchesPackage);
  return {
    package: meta.package,
    source: 'ai-explore',
    udid: meta.udid ?? null,
    startedAt: meta.startedAt,
    finishedAt: new Date().toISOString(),
    maxSteps: meta.maxSteps,
    focus: meta.focus ?? null,
    steps: result.steps,
    stateCount: result.stateCount,
    states: result.states,
    crashes: result.crashes.map((c) => ({
      dir: c.dir,
      timestamp: c.timestamp,
      keywords: c.keywords,
      matchesPackage: c.matchesPackage,
      firstLine: c.firstLine,
      step: c.context.step ?? null,
    })),
    truncated: result.truncated,
    truncatedReason: result.truncatedReason ?? null,
    midsceneReport: meta.midsceneReport ?? null,
    conclusion:
      appCrashes.length > 0
        ? `${appCrashes.length} crash/ANR of ${meta.package} captured`
        : `未捕获崩溃 / no crash captured in ${result.steps.length} steps` +
          (result.crashes.length ? ` (${result.crashes.length} crash signal(s) from other processes)` : ''),
  };
}

export async function writeTrace(trace: ExploreTrace): Promise<string> {
  await mkdir(TRACE_DIR, { recursive: true });
  const file = join(TRACE_DIR, `${trace.startedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, `${JSON.stringify(trace, null, 2)}\n`);
  return file;
}
