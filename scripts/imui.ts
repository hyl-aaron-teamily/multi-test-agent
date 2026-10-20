// imui — UI-level counterpart of im-loadtest's `imload`: same commands and flags, but messages are
// typed into real clients (Android app / chat-web) and measured when they appear on screen.
//
//   pnpm autotest imui config   --client "android:4f2ebdf2@aaron+test3's Personal AI"
//   pnpm autotest imui discover --client android:4f2ebdf2
//   pnpm autotest imui login    --env test                       # headed browser, saves web login state
//   pnpm autotest imui probe    --client ... [--yes-prod]        # one message per type
//   pnpm autotest imui run      --client A --client B [--sender A] --duration 60 --rate 0.3 \
//                               --msg-types text,long --payload-bytes 300 --ramp 10 --drain 20 --json out.json [--yes-prod]
//   pnpm autotest imui selftest                                  # offline: fake chat page with injected faults
//
// Topology (imload SENDER / TARGET_MODE): every --client watches; --sender (default: first client)
// sends; delivery is expected on every other client. Same account on two clients = multi-device sync,
// different accounts = peer delivery, a single client = echo only.
// Exit codes (imload): 0 pass, 2 SLO failed, 1 config / client error.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AndroidClient } from '../imui/clients/android';
import { parseClientSpec, type UiClient } from '../imui/clients/types';
import { interactiveLogin, WebClient } from '../imui/clients/web';
import type { Slo } from '../imui/metrics';
import { renderReport } from '../imui/report';
import { runUiLoad } from '../imui/runner';
import { newRunId } from '../imui/tokens';

/** chat-web per environment (from im-loadtest probe/src/config/endpoints.mjs). Overridable. */
const WEB_APPS: Record<string, string> = {
  test: process.env.IMUI_WEB_TEST_URL ?? 'https://chat-test.teamily.ai',
  prod: process.env.IMUI_WEB_PROD_URL ?? 'https://teamily.ai',
};
const PKG = process.env.IMUI_APP_PACKAGE ?? process.env.APP_PACKAGE ?? 'ai.teamily.mobile';
const stateFile = (env: string) => resolve('.imui', `web-${env}.json`);

const [cmd, ...argv] = process.argv.slice(2);
const { values } = parseArgs({
  args: argv,
  options: {
    env: { type: 'string', default: process.env.IMUI_ENV ?? 'test' },
    client: { type: 'string', multiple: true },
    sender: { type: 'string', multiple: true },
    conversation: { type: 'string' },
    duration: { type: 'string', default: process.env.IMUI_DURATION ?? '60' },
    rate: { type: 'string', default: process.env.IMUI_RATE_PER_SENDER ?? '0.3' },
    ramp: { type: 'string', default: process.env.IMUI_RAMP_SECONDS ?? '0' },
    drain: { type: 'string', default: process.env.IMUI_DRAIN_SECONDS ?? '20' },
    'msg-types': { type: 'string', default: process.env.IMUI_MSG_TYPES ?? 'text' },
    'payload-bytes': { type: 'string', default: process.env.IMUI_PAYLOAD_BYTES ?? '200' },
    'max-messages': { type: 'string', default: process.env.IMUI_MAX_MESSAGES ?? '300' },
    json: { type: 'string' },
    headed: { type: 'boolean' },
    'yes-prod': { type: 'boolean' },
  },
});

const env = values.env!;
const num = (k: keyof typeof values) => Number(values[k]);
const slo: Slo = {
  e2eP99Ms: process.env.IMUI_SLO_E2E_P99_MS ? Number(process.env.IMUI_SLO_E2E_P99_MS) : undefined,
  echoP99Ms: process.env.IMUI_SLO_ECHO_P99_MS ? Number(process.env.IMUI_SLO_ECHO_P99_MS) : undefined,
  maxLossRatio: process.env.IMUI_SLO_MAX_LOSS_RATIO ? Number(process.env.IMUI_SLO_MAX_LOSS_RATIO) : undefined,
};

function buildClients(): { client: UiClient; conversation?: string }[] {
  const specs = values.client?.length ? values.client : (process.env.IMUI_CLIENTS ?? '').split(';').filter(Boolean);
  if (!specs.length) throw new Error('no clients: pass --client android:<udid>@<conversation> and/or --client web:<env>@<conversation> (or IMUI_CLIENTS)');
  return specs.map((spec) => {
    const p = parseClientSpec(spec);
    const conversation = p.conversation ?? values.conversation ?? process.env.IMUI_CONVERSATION;
    if (p.kind === 'android') {
      if (!p.ref) throw new Error(`client "${spec}": android needs a udid (see \`pnpm autotest devices\`)`);
      return { client: new AndroidClient(p.ref, PKG), conversation };
    }
    const webEnv = p.ref || env;
    if (!WEB_APPS[webEnv]) throw new Error(`client "${spec}": unknown web env "${webEnv}" (test | prod)`);
    return { client: new WebClient({ name: webEnv, appUrl: WEB_APPS[webEnv], statePath: stateFile(webEnv), headless: !values.headed }), conversation };
  });
}

function check(): void {
  if (!['test', 'prod'].includes(env)) throw new Error(`--env must be test or prod, got ${env}`);
  for (const k of ['duration', 'rate', 'ramp', 'drain', 'payload-bytes', 'max-messages'] as const) {
    if (!Number.isFinite(num(k)) || num(k) < 0) throw new Error(`--${k} must be a non-negative number`);
  }
  if (num('rate') <= 0 || num('rate') > 2) throw new Error('--rate must be in (0, 2] messages/s per sender — a UI cannot type faster');
  if (num('payload-bytes') > 4096) throw new Error('--payload-bytes must be <= 4096 (server websocketMaxMsgLen, see im-loadtest README)');
}

async function main(): Promise<number> {
  if (cmd === 'selftest') {
    const { selftest } = await import('../imui/selftest');
    return selftest();
  }
  check();
  if (cmd === 'login') {
    await interactiveLogin(WEB_APPS[env], stateFile(env));
    console.log(`[imui] login state saved → ${stateFile(env)}`);
    return 0;
  }
  const clients = buildClients();
  if (cmd === 'config') {
    console.log(JSON.stringify({ env, webApp: WEB_APPS[env], appPackage: PKG, clients: clients.map((c) => ({ id: c.client.id, conversation: c.conversation ?? null })), slo, flags: values }, null, 2));
    return 0;
  }
  if (cmd === 'discover') {
    for (const { client } of clients) {
      console.log(`\n# ${client.id}`);
      for (const name of await client.listConversations()) console.log(`  ${name}`);
      await client.close();
    }
    return 0;
  }
  if (cmd !== 'probe' && cmd !== 'run') {
    console.error('Usage: imui <config|discover|login|probe|run|selftest> [flags]  (see scripts/imui.ts header)');
    return 1;
  }
  // imload: `run` against prod is refused without --yes-prod. The Android app talks to whatever
  // backend it was built for, so any android client counts as prod unless IMUI_ANDROID_ENV=test.
  const touchesProd = env === 'prod' || (clients.some((c) => c.client.kind === 'android') && (process.env.IMUI_ANDROID_ENV ?? 'prod') === 'prod');
  if (cmd === 'run' && touchesProd && !values['yes-prod'] && process.env.IMUI_PROD_CONFIRM !== '1') {
    console.error('[imui] refusing to run against production without --yes-prod (or IMUI_PROD_CONFIRM=1). Messages are real and are not deleted.');
    return 1;
  }
  for (const c of clients) if (!c.conversation) throw new Error(`${c.client.id}: no conversation — use --client ${c.client.id}@<name> or --conversation (refusing to guess a chat to send into)`);

  const runId = newRunId();
  const outDir = resolve('midscene_run/imui', `${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}`);
  await mkdir(outDir, { recursive: true });
  const all = clients.map((c) => c.client);
  const senderIds = values.sender?.length ? values.sender : [all[0].id];
  const senders = all.filter((c) => senderIds.includes(c.id));
  if (!senders.length) throw new Error(`--sender ${senderIds.join(',')} matches no --client`);
  console.log(`[imui] run ${runId} env=${env}${touchesProd ? ' [prod]' : ''} clients=${all.map((c) => c.id).join(', ')} senders=${senders.map((s) => s.id).join(', ')}`);

  try {
    for (const c of clients) {
      const t = Date.now();
      await c.client.open(c.conversation!);
      console.log(`[imui] ${c.client.id} ready in "${c.conversation}" (${Date.now() - t}ms)`);
    }
    const msgTypes = values['msg-types']!.split(',').map((s) => s.trim()).filter(Boolean);
    for (const t of msgTypes) if (!['text', 'long'].includes(t)) throw new Error(`--msg-types: "${t}" not supported in the UI port (text, long)`);
    const m = await runUiLoad({
      runId,
      senders,
      clients: all,
      observersFor: (s) => all.filter((c) => c.id !== s.id).map((c) => c.id),
      // probe: exactly one message per type (budget-limited), regardless of --duration.
      durationSec: cmd === 'probe' ? 600 : num('duration'),
      rate: num('rate'),
      rampSec: num('ramp'),
      drainSec: num('drain'),
      msgTypes,
      payloadBytes: num('payload-bytes'),
      maxMessages: cmd === 'probe' ? msgTypes.length : num('max-messages'),
    });
    const report = m.report();
    const failures = m.checkSlo(slo);
    const json = {
      tool: 'imui',
      runId,
      command: cmd,
      env,
      prod: touchesProd,
      startedAt: new Date(Date.now() - report.wallSeconds * 1000).toISOString(),
      clients: all.map((c) => ({ id: c.id, kind: c.kind, resolutionMs: c.resolutionMs })),
      senders: senders.map((s) => s.id),
      flags: { duration: num('duration'), rate: num('rate'), ramp: num('ramp'), drain: num('drain'), msgTypes, payloadBytes: num('payload-bytes') },
      metrics: report,
      lost: m.lostTokens(),
      echoMissing: m.echoMissing(),
      slo,
      sloFailures: failures,
      verdict: failures.length ? 'FAIL' : 'PASS',
    };
    await writeFile(join(outDir, 'report.json'), `${JSON.stringify(json, null, 2)}\n`);
    await writeFile(join(outDir, 'report.md'), renderReport(json));
    if (values.json) await writeFile(resolve(values.json), `${JSON.stringify(json, null, 2)}\n`);
    console.log(renderReport(json));
    console.log(`[imui] report → ${join(outDir, 'report.md')}`);
    return failures.length ? 2 : 0;
  } finally {
    for (const c of all) await c.close().catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[imui] ${(err as Error).message}`);
    process.exit(1);
  });
