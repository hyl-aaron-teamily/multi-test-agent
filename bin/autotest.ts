// Unified entry. Forwards to the existing scripts so earlier entry points keep working unchanged.
//
//   pnpm autotest mission "聊天时偶发闪退，试试能不能重现" [--package <pkg>] [--max-steps N] [--max-minutes M] [--device <udid>]
//   pnpm autotest explore --package <pkg> [--device <udid>]
//   pnpm autotest monkey  --package <pkg> [--seed <n>] [--events <n>] [--device <udid>]
//   pnpm autotest web:smoke
//   pnpm autotest devices [--json]
//   pnpm autotest report
//   pnpm autotest replay <replay.json> [--times 3] [--keep-timing]
//   pnpm autotest imui <config|discover|login|probe|run|selftest> ...   (UI-level im-loadtest)
//   pnpm autotest accounts|skill|nodes|plan|run ...                  (milestone 5, see scripts/m5.ts)
//   pnpm autotest replay <incident>/replay.json                        (coordinate replay; old bundles → scripts/replay.ts)
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listDevices } from '../platform/adb-devices';

const [cmd, ...rest] = process.argv.slice(2);

const SCRIPTS: Record<string, string> = {
  mission: 'scripts/mission.ts',
  explore: 'scripts/explore.ts',
  monkey: 'scripts/monkey.ts',
  report: 'report/problem-report.ts',
  imui: 'scripts/imui.ts',
};
const M5 = ['accounts', 'skill', 'nodes', 'plan', 'run'];

function run(bin: string, args: string[]): Promise<number> {
  return new Promise((res) => {
    // No shell: arguments with spaces/quotes (natural-language requests) pass through intact on Windows.
    const child = spawn(process.execPath, [bin, ...args], { stdio: 'inherit' });
    child.on('close', (code) => res(code ?? 1));
    child.on('error', (e) => {
      console.error(e.message);
      res(1);
    });
  });
}

const tsx = resolve('node_modules/tsx/dist/cli.mjs');
const vitest = resolve('node_modules/vitest/vitest.mjs');

async function main(): Promise<number> {
  if (cmd && SCRIPTS[cmd]) return run(tsx, [SCRIPTS[cmd], ...rest]);
  if (cmd && M5.includes(cmd)) return run(tsx, ['scripts/m5.ts', cmd, ...rest]);
  if (cmd === 'replay') {
    // Incident bundles (coordinate ops) go to the milestone-5 replayer, older Midscene bundles to scripts/replay.ts.
    const f = rest.find((a) => !a.startsWith('--')) ?? '';
    const coord = existsSync(f) && /"format":\s*"coord-v1"/.test(readFileSync(f, 'utf8'));
    return run(tsx, coord ? ['scripts/m5.ts', 'replay', ...rest] : ['scripts/replay.ts', ...rest]);
  }
  if (cmd === 'web:smoke') return run(vitest, ['run', '--project', 'web', ...rest]);
  if (cmd === 'devices') {
    const devices = await listDevices();
    if (rest.includes('--json')) console.log(JSON.stringify(devices, null, 2));
    else if (!devices.length) console.log('(no adb devices)');
    else for (const d of devices) console.log(`${d.udid.padEnd(20)} ${d.state.padEnd(13)} ${d.model ?? ''}`);
    return 0;
  }
  console.error('Usage: pnpm autotest <mission|explore|monkey|replay|imui|accounts|skill|nodes|plan|run|web:smoke|devices|report> [...args]');
  return 2;
}

main().then((code) => process.exit(code));
