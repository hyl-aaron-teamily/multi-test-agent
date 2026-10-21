// Teamily SKILL Nodes (defineNode from @midscene/core). execute() only performs coordinate operations
// through a black-box Driver; coordinates come from the surface profile and from targets frozen at
// preparation time. No hierarchy reads, no vision calls here.
import { defineNode } from '@midscene/core/internal/test-runner';
import { z } from 'zod';
import type { Driver, Point } from '../../drivers/types';
import { sleep } from '../../drivers/types';
import type { Credentials } from '../../platform/accounts/types';
import { pointOf, type Profile } from '../profile';

export interface NodeContext {
  driver: Driver;
  profile: Profile;
  /** Frozen dynamic targets: id → point. */
  targets: Record<string, Point>;
  /** Resolved by the executor from the account pool; never logged. */
  credentials?: () => Credentials;
  /** Max wait used by nodes that wait for a page (ms). */
  settleMs?: number;
}

type Exec<I> = (ctx: { input: I; context: NodeContext }) => Promise<{ summary?: string } | void>;

// Node input schemas (our zod copy; @midscene/core validates against its own zod, so the schemas are
// kept here for `autotest nodes` and plan validation instead of `inputSchema`).
export const NODE_SCHEMAS = {
  'teamily.login': z.object({ account: z.string().optional() }),
  'teamily.openConversation': z.object({ target: z.string() }),
  'teamily.sendMessage': z.object({ text: z.string().min(1) }),
  'teamily.typeMention': z.object({}),
  'teamily.clearComposer': z.object({}),
  'teamily.switchConversation': z.object({ from: z.string(), to: z.string() }),
  'teamily.openPage': z.object({ page: z.enum(['profile', 'artifacts', 'chat']) }),
} as const;

export type NodeName = keyof typeof NODE_SCHEMAS;

const target = (c: NodeContext, id: string): Point => {
  const p = c.targets[id];
  if (!p) throw new Error(`target ${id} not frozen (preparation stage did not pick it)`);
  return p;
};

const tapEl = (c: NodeContext, id: string) => c.driver.tap(pointOf(c.profile, id));

const login: Exec<{ account?: string }> = async ({ context: c }) => {
  const cred = c.credentials?.();
  if (!cred) throw new Error('teamily.login: no credentials provider');
  await tapEl(c, 'login.email');
  await c.driver.type(cred.email);
  await tapEl(c, 'login.emailContinue');
  await sleep(Math.max(c.settleMs ?? 0, 3500));
  await tapEl(c, 'login.password');
  await c.driver.type(cred.password);
  await tapEl(c, 'login.continue');
  return { summary: `login ${cred.email.replace(/^(.).*@/, '$1***@')}` };
};

const openConversation: Exec<{ target: string }> = async ({ input, context: c }) => {
  await c.driver.tap(target(c, input.target));
  return { summary: `open ${input.target}` };
};

const sendMessage: Exec<{ text: string }> = async ({ input, context: c }) => {
  await tapEl(c, 'chat.composer');
  await c.driver.type(input.text);
  await c.driver.key('Enter');
  return { summary: `sent ${input.text.length} chars` };
};

const typeMention: Exec<Record<string, never>> = async ({ context: c }) => {
  await tapEl(c, 'chat.composer');
  await c.driver.type('@');
};

const clearComposer: Exec<Record<string, never>> = async ({ context: c }) => {
  await c.driver.key('Escape');
  await tapEl(c, 'chat.composer');
  for (let i = 0; i < 3; i++) await c.driver.key('Backspace');
};

const switchConversation: Exec<{ from: string; to: string }> = async ({ input, context: c }) => {
  if (c.driver.surface !== 'desktop-web') await tapEl(c, 'chat.back').catch(() => {});
  await c.driver.tap(target(c, input.to));
  await sleep(c.settleMs ?? 500);
  if (c.driver.surface !== 'desktop-web') await tapEl(c, 'chat.back').catch(() => {});
  await c.driver.tap(target(c, input.from));
};

const openPage: Exec<{ page: 'profile' | 'artifacts' | 'chat' }> = async ({ input, context: c }) => {
  await tapEl(c, input.page === 'profile' ? 'nav.me' : input.page === 'artifacts' ? 'nav.artifacts' : 'nav.chat');
  await sleep(c.settleMs ?? 1500);
};

const EXEC: Record<NodeName, Exec<any>> = {
  'teamily.login': login,
  'teamily.openConversation': openConversation,
  'teamily.sendMessage': sendMessage,
  'teamily.typeMention': typeMention,
  'teamily.clearComposer': clearComposer,
  'teamily.switchConversation': switchConversation,
  'teamily.openPage': openPage,
};

const DESCRIPTIONS: Record<NodeName, string> = {
  'teamily.login': 'Cursor/keyboard login: email → continue → password → continue (credentials from the account pool)',
  'teamily.openConversation': 'Tap a conversation frozen at preparation time',
  'teamily.sendMessage': 'Tap composer, type, Enter',
  'teamily.typeMention': 'Tap composer, type "@" (picker should open)',
  'teamily.clearComposer': 'Esc + backspace in the composer',
  'teamily.switchConversation': 'Switch to another conversation and back',
  'teamily.openPage': 'Open a fixed page through its navigation entry',
};

/** Midscene node definitions (context = NodeContext). */
export const nodes = (Object.keys(EXEC) as NodeName[]).map((name) =>
  defineNode<unknown, unknown, NodeContext>({
    name,
    description: DESCRIPTIONS[name],
    execute: ({ input, context }) => EXEC[name]({ input: NODE_SCHEMAS[name].parse(input ?? {}) as any, context }),
  }),
);

/** Direct execution path used by the executor (same code as the Midscene node). */
export async function runNode(name: string, input: Record<string, unknown>, context: NodeContext): Promise<string | undefined> {
  const fn = EXEC[name as NodeName];
  if (!fn) throw new Error(`unknown node ${name}`);
  const r = await fn({ input: NODE_SCHEMAS[name as NodeName].parse(input ?? {}), context });
  return r?.summary;
}

export function listNodes(): { name: string; description: string; input: unknown }[] {
  return (Object.keys(EXEC) as NodeName[]).map((name) => ({ name, description: DESCRIPTIONS[name], input: z.toJSONSchema(NODE_SCHEMAS[name]) }));
}
