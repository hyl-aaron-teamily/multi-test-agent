// Path B CLI — Monkey stress with fixed seed(s) + logcat crash capture.
//
//   pnpm monkey --package com.miui.calculator --seed 12345 --events 3000
//   MONKEY_EVENT_COUNT=5000  MONKEY_ROUNDS=3  MONKEY_THROTTLE=300  FAIL_FAST=true
//
// Output: monkey_run/<ts>-r<round>-s<seed>/monkey.log, monkey_run/summary.json,
// crash scenes in midscene_run/crashes/<ts>/ (context.json source = "monkey").
// WARNING: Monkey taps at random. Do not point it at a production account where random taps can
// pay, send messages or change data — use a test build / test account.
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { runMonkeyLoop } from '../monkey/loop';

const { values } = parseArgs({
  options: {
    package: { type: 'string', short: 'p' },
    device: { type: 'string', short: 'd' },
    seed: { type: 'string', short: 's' },
    events: { type: 'string', short: 'n' },
    rounds: { type: 'string' },
    throttle: { type: 'string' },
    'fail-fast': { type: 'boolean' },
  },
});

const int = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`${name} must be a non-negative integer, got "${v}"`);
    process.exit(2);
  }
  return n;
};

const pkg = values.package ?? process.env.APP_PACKAGE;
if (!pkg) {
  console.error('Usage: pnpm monkey --package <pkg> [--seed 12345] [--events 3000] [--rounds 1]');
  process.exit(2);
}

runMonkeyLoop({
  packageName: pkg,
  deviceId: values.device ?? process.env.DEVICE_ID?.trim() ?? undefined,
  seed: int(values.seed ?? process.env.MONKEY_SEED, 'seed'),
  eventCount: int(values.events ?? process.env.MONKEY_EVENT_COUNT, 'events') ?? 5000,
  rounds: int(values.rounds ?? process.env.MONKEY_ROUNDS, 'rounds') ?? 1,
  throttle: int(values.throttle ?? process.env.MONKEY_THROTTLE, 'throttle') ?? 300,
  failFast: values['fail-fast'] ?? process.env.FAIL_FAST === 'true',
})
  .then((summary) => {
    process.exitCode = summary.rounds.some((r) => r.crashesDetected > 0) ? 1 : 0;
  })
  .catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
