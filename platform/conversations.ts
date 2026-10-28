// Private conversation settings (platform/conversations.local.yaml — gitignored by *.local.yaml; titles
// may contain people's names). construct.allow: conversations whose members are all pool accounts / the
// user, the only places a plan may construct preconditions (send messages) in prod. sync.defaultConversation:
// guidance for the multi-client sync test.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

export interface ConversationSettings {
  /** member: display name of another pool account in the first allowed group (the one @-mentioned, Issue 1903). */
  construct: { allow: string[]; member?: string };
  sync: { defaultConversation?: string };
}

export const CONVERSATIONS_FILE = resolve(process.env.CONVERSATIONS_FILE ?? 'platform/conversations.local.yaml');

export function loadConversations(file = CONVERSATIONS_FILE): ConversationSettings {
  const raw = existsSync(file) ? ((yaml.load(readFileSync(file, 'utf8')) ?? {}) as Partial<{ construct: { allow?: string[]; member?: string }; sync: { defaultConversation?: string } }>) : {};
  return { construct: { allow: raw.construct?.allow ?? [], member: raw.construct?.member }, sync: { defaultConversation: raw.sync?.defaultConversation } };
}

/** Pure: is a (possibly truncated, "…") list title one of the allowed construction conversations? */
export function constructionAllowed(title: string, allow: string[]): boolean {
  const t = title.replace(/[…\.]+$/, '').trim();
  return !!t && allow.some((a) => a === title || a.startsWith(t) || t.startsWith(a));
}
