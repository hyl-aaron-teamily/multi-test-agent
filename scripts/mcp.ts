// `autotest mcp` — the MCP service over stdio (W2-4 §5; tools in platform/mcp.ts).
//   node node_modules/tsx/dist/cli.mjs scripts/mcp.ts                     (what an IDE starts)
//   npx tsx scripts/mcp.ts --print-config claude|cursor|codex|vscode       (config snippet + rules file; G7:
//                                                                          printed for a person to paste, never written)
// stdout belongs to the protocol: every console.log goes to stderr. The repo root is the working directory
// (state, plans, evidence are relative paths), whatever directory the IDE starts us in.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);

const CLIENTS = ['claude', 'cursor', 'codex', 'vscode'] as const;

/** Pure: the configuration snippet for one client (absolute paths, so it works from any project). */
export function printConfig(client: string, root = ROOT): string {
  const node = process.execPath;
  const args = [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'scripts', 'mcp.ts')];
  const rules = join(root, 'docs', 'agent-rules.md');
  const server = { command: node, args };
  const body = (() => {
    switch (client) {
      case 'claude':
        return [`# Claude Code: run once (user scope), or put the JSON into a project's .mcp.json`, `claude mcp add autotest --scope user -- "${node}" "${args[0]}" "${args[1]}"`, '', JSON.stringify({ mcpServers: { autotest: server } }, null, 2)];
      case 'cursor':
        return ['# Cursor: ~/.cursor/mcp.json (or <project>/.cursor/mcp.json)', JSON.stringify({ mcpServers: { autotest: server } }, null, 2)];
      case 'codex':
        return ['# Codex: ~/.codex/config.toml', '[mcp_servers.autotest]', `command = ${JSON.stringify(node)}`, `args = ${JSON.stringify(args)}`];
      case 'vscode':
        return ['# VS Code: <project>/.vscode/mcp.json', JSON.stringify({ servers: { autotest: { type: 'stdio', ...server } } }, null, 2)];
      default:
        return [`unknown client "${client}" — one of ${CLIENTS.join(', ')}`];
    }
  })();
  return [...body, '', `# Test rules for the agent (paste into the IDE's rules / CLAUDE.md, or point it at the file): ${rules}`, '# After changing .env: restart the MCP server, then call doctor.'].join('\n');
}

async function main() {
  const i = process.argv.indexOf('--print-config');
  if (i >= 0) {
    const c = process.argv[i + 1] ?? '';
    process.stdout.write(`${printConfig(c)}\n`);
    process.exit(CLIENTS.includes(c as (typeof CLIENTS)[number]) ? 0 : 40);
  }
  await import('dotenv/config');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { createMcpServer } = await import('../platform/mcp');
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error(`[mcp] autotest MCP server ready (stdio, cwd ${ROOT})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error((e as Error).stack ?? e);
    process.exit(1);
  });
}
