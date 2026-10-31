// Unified entry.
//   pnpm autotest help | <issue|draft|plan|env|task|result> <action> [--json]   (W2-3 v1 CLI for agents)
//   pnpm autotest doctor | mcp [--print-config claude|cursor|codex|vscode]      (W2-4)
//   pnpm autotest accounts|skill|nodes|plan|run|series|rerender|evidence|sync ... (scripts/m5.ts)
//   pnpm autotest replay <incident>/replay.json [--times 3]                     (coordinate replay)
//   pnpm autotest devices [--json]
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { listDevices } from '../platform/adb-devices';

const [cmd, ...rest] = process.argv.slice(2);

const M5 = ['accounts', 'skill', 'nodes', 'plan', 'run', 'series', 'rerender', 'evidence', 'sync'];

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

const V1 = ['issue', 'draft', 'env', 'task', 'result', 'help', 'doctor'];

async function main(): Promise<number> {
  // `task exec <id>` is the platform's internal child; the rest of the v1 objects are thin service clients.
  if (cmd === 'task' && rest[0] === 'exec') return run(tsx, ['scripts/task-exec.ts', ...rest.slice(1)]);
  if (cmd && (V1.includes(cmd) || (cmd === 'plan' && ['explain', 'approve', 'reject'].includes(rest[0])))) {
    const { cliV1 } = await import('../scripts/cli-v1');
    return cliV1(cmd, rest);
  }
  // MCP over stdio: start it with node + tsx directly (pnpm prints a banner on stdout); see --print-config.
  if (cmd === 'mcp') return run(tsx, ['scripts/mcp.ts', ...rest]);
  if (cmd && M5.includes(cmd)) return run(tsx, ['scripts/m5.ts', cmd, ...rest]);
  if (cmd === 'replay') return run(tsx, ['scripts/m5.ts', 'replay', ...rest]);
  if (cmd === 'devices') {
    const devices = await listDevices();
    if (rest.includes('--json')) console.log(JSON.stringify(devices, null, 2));
    else if (!devices.length) console.log('(no adb devices)');
    else for (const d of devices) console.log(`${d.udid.padEnd(20)} ${d.state.padEnd(13)} ${d.model ?? ''}`);
    return 0;
  }
  console.error('Usage: pnpm autotest help | <issue|draft|plan|env|task|result> <action> [--json] | <doctor|mcp|accounts|skill|nodes|plan|run|series|rerender|evidence|sync|replay|devices> [...args]');
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error((e as Error).stack ?? e);
    process.exit(1);
  },
);
