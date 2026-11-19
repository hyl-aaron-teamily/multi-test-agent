// Client of the memory service (W3-5 §8.9, D15, contract K7): TencentDB Agent Memory's `memory-core`, reached
// over its v3 RPC (all POST, JSON envelope {code, message, data}). A thin wrapper over the same endpoints the
// official SDK (@tencentdb-agent-memory/memory-sdk-ts-v2, MIT) calls — the npm release lags the repository's
// beta, so the few calls are made here directly; nothing of the service is copied. Not the Proxy: it would
// rewrite our model requests (the assembler owns the context).
//
// Everything degrades: no service configured / down / slow → the call returns undefined (reads) or false
// (writes) within its timeout, and the run goes on with the repository's lessons only.
//   MEMORY_CORE_URL      default http://localhost:8420 (in compose: http://memory-core:8420)
//   MEMORY_CORE_API_KEY  v3 Bearer key (default: .docker/memory-core/admin-key, made by init-admin)
//   MEMORY_CORE_USER_KEY x-tdai-user-key, when a gateway in front asks for one
//   MEMORY_OFF=1         never call it

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const TEAM_ID = 'multi-test-agent';

export interface Isolation {
  /** Capability: explore / plan-run / plan-author. */
  agent: 'explore' | 'plan-run' | 'plan-author';
  /** App under test and surface, e.g. teamily-android. */
  user: string;
  session?: string;
  task?: string;
}

export interface MemoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

export interface Atom {
  id: string;
  type: string;
  content: string;
  background?: string;
  score?: number;
  createdAt?: string;
  updatedAt?: string;
  /** Normalised: the service returns a string from update and a number from query/search. */
  version?: number;
}

export interface SkillCase {
  name: string;
  description: string;
  /** SKILL.md body (without the frontmatter). */
  content: string;
  id?: string;
  version?: number;
}

/** The v3 Bearer key: MEMORY_CORE_API_KEY, else the admin user key init-admin made (scripts/memory-config.ts). */
export function memoryKey(): string | undefined {
  if (process.env.MEMORY_CORE_API_KEY) return process.env.MEMORY_CORE_API_KEY;
  const f = process.env.MEMORY_CORE_KEY_FILE ?? resolve('.docker/memory-core/admin-key');
  try {
    return readFileSync(f, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export type Transport = (path: string, body: Record<string, unknown>, timeoutMs: number) => Promise<{ status: number; json: any }>;

const httpTransport = (base: string): Transport => async (path, body, timeoutMs) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-tdai-service-id': 'default' };
  const key = memoryKey();
  if (key) headers.authorization = `Bearer ${key}`;
  const userKey = process.env.MEMORY_CORE_USER_KEY ?? key;
  if (userKey) headers['x-tdai-user-key'] = userKey;
  const r = await fetch(`${base}${path}`, { method: path === '/health' ? 'GET' : 'POST', headers, body: path === '/health' ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

/** Pure: an atom from the service's item (field names and the version type unified). */
export function atomOf(x: any): Atom {
  const v = x?.version;
  return {
    id: String(x?.id ?? ''),
    type: String(x?.type ?? ''),
    content: String(x?.content ?? ''),
    ...(x?.background ? { background: String(x.background) } : {}),
    ...(typeof x?.score === 'number' ? { score: x.score } : {}),
    ...(x?.created_at ? { createdAt: String(x.created_at) } : {}),
    ...(x?.updated_at ? { updatedAt: String(x.updated_at) } : {}),
    ...(v !== undefined && v !== null && v !== '' && !Number.isNaN(Number(v)) ? { version: Number(v) } : {}),
  };
}

export interface CallLog {
  path: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export class MemoryClient {
  readonly base: string;
  private t: Transport;
  /** Last calls (doctor / manifest notes). */
  readonly log: CallLog[] = [];

  constructor(o: { base?: string; transport?: Transport } = {}) {
    this.base = (o.base ?? process.env.MEMORY_CORE_URL ?? 'http://localhost:8420').replace(/\/$/, '');
    this.t = o.transport ?? httpTransport(this.base);
  }

  get off(): boolean {
    return process.env.MEMORY_OFF === '1';
  }

  /** One RPC; undefined when off, down, slow or refused (never throws). */
  async call<T = any>(path: string, body: Record<string, unknown>, timeoutMs = 3000): Promise<T | undefined> {
    if (this.off) return undefined;
    const t0 = Date.now();
    try {
      const r = await this.t(path, body, timeoutMs);
      const code = typeof r.json?.code === 'number' ? r.json.code : 0;
      if (r.status >= 400 || code !== 0) {
        this.log.push({ path, ok: false, ms: Date.now() - t0, error: `${r.status} ${r.json?.message ?? code}`.slice(0, 160) });
        return undefined;
      }
      this.log.push({ path, ok: true, ms: Date.now() - t0 });
      return (r.json?.data ?? r.json) as T;
    } catch (e) {
      this.log.push({ path, ok: false, ms: Date.now() - t0, error: (e as Error).message.slice(0, 160) });
      return undefined;
    }
  }

  private iso(i: Isolation): Record<string, unknown> {
    const ids = this.ids();
    return { team_id: ids?.team ?? TEAM_ID, agent_id: ids?.agents[i.agent] ?? i.agent, user_id: i.user, ...(i.session ? { session_id: i.session } : {}), ...(i.task ? { task_id: i.task } : {}) };
  }

  private idsCache?: { team: string; agents: Record<string, string> } | null;
  /** The service's own ids for our team and agents (scripts/memory-config.ts registers them; null = none). */
  private ids(): { team: string; agents: Record<string, string> } | undefined {
    if (this.idsCache === undefined) {
      try {
        this.idsCache = JSON.parse(readFileSync(process.env.MEMORY_CORE_IDS_FILE ?? resolve('.docker/memory-core/ids.json'), 'utf8'));
      } catch {
        this.idsCache = null;
      }
    }
    return this.idsCache ?? undefined;
  }

  async health(timeoutMs = 2000): Promise<{ ok: boolean; detail: string; ms: number }> {
    const t0 = Date.now();
    if (this.off) return { ok: false, detail: 'MEMORY_OFF=1', ms: 0 };
    try {
      const r = await this.t('/health', {}, timeoutMs);
      return { ok: r.status < 400, detail: r.status < 400 ? `${this.base} 正常` : `${this.base} 返回 ${r.status}`, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, detail: `${this.base} 不可用（${(e as Error).message.slice(0, 80)}）`, ms: Date.now() - t0 };
    }
  }

  /** L0: a run's model rounds (text only; screenshots by path), or a person's mark with its context. */
  async addConversation(i: Isolation & { session: string }, messages: MemoryMessage[], timeoutMs = 10_000): Promise<boolean> {
    if (!messages.length) return true;
    return (await this.call('/v3/conversation/add', { ...this.iso(i), messages }, timeoutMs)) !== undefined;
  }

  /** Experience related to a query (best effort, short timeout: default 300 ms, §8.7 ④). */
  async searchAtoms(i: Isolation, query: string, o: { limit?: number; timeoutMs?: number; type?: string } = {}): Promise<Atom[] | undefined> {
    const d = await this.call<{ items?: unknown[] }>('/v3/atomic/search', { ...this.iso(i), query, limit: o.limit ?? 3, ...(o.type ? { type: o.type } : {}) }, o.timeoutMs ?? 300);
    return d ? (d.items ?? []).map(atomOf) : undefined;
  }

  /** Atoms extracted since `since` (the candidate-lesson pipe, D14). */
  async queryAtoms(i: Isolation, o: { since?: string; limit?: number; type?: string } = {}): Promise<Atom[] | undefined> {
    const d = await this.call<{ items?: unknown[] }>('/v3/atomic/query', { ...this.iso(i), limit: o.limit ?? 50, ...(o.since ? { time_start: o.since } : {}), ...(o.type ? { type: o.type } : {}) }, 10_000);
    return d ? (d.items ?? []).map(atomOf) : undefined;
  }

  async updateAtom(i: Isolation, id: string, content: string, background?: string): Promise<Atom | undefined> {
    const d = await this.call('/v3/atomic/update', { ...this.iso(i), id, content, ...(background ? { background } : {}) }, 10_000);
    return d ? atomOf({ id, content, background, ...d }) : undefined;
  }

  // ---- Skill library: repair cases (W3-7 writes the real ones; W3-5 only proves the interface). The service
  // stores a SKILL.md (frontmatter name / description + body), versioned; update needs its id and version.

  async createSkill(i: Isolation, s: SkillCase): Promise<SkillCase | undefined> {
    const d = await this.call<any>('/v3/skill/create', { ...this.iso(i), name: s.name, content: skillMd(s) }, 10_000);
    return d ? { ...s, id: String(d.skill_id ?? ''), version: Number(d.version ?? 1) } : undefined;
  }

  /** Replace the body; the current version is read first (optimistic lock). */
  async updateSkill(i: Isolation, s: SkillCase): Promise<SkillCase | undefined> {
    const cur = await this.getSkill(i, s.name);
    if (!cur?.id) return undefined;
    const d = await this.call<any>('/v3/skill/update', { ...this.iso(i), skill_id: cur.id, expected_version: cur.version ?? 1, content: skillMd(s) }, 10_000);
    return d ? { ...s, id: cur.id, version: Number(d.version ?? (cur.version ?? 1) + 1) } : undefined;
  }

  async getSkill(i: Isolation, name: string): Promise<SkillCase | undefined> {
    const d = await this.call<any>('/v3/skill/get-by-name', { ...this.iso(i), skill_name: name, include_manifest: false }, 5000);
    if (!d) return undefined;
    const md = parseSkillMd(String(d.content ?? ''));
    return { name: String(d.name ?? name), description: String(d.description ?? md.description), content: md.body, ...(d.skill_id ? { id: String(d.skill_id) } : {}), ...(d.version !== undefined ? { version: Number(d.version) } : {}) };
  }
}

/** Pure: SKILL.md of a case (the service requires the frontmatter name to equal the skill name). */
export function skillMd(s: Pick<SkillCase, 'name' | 'description' | 'content'>): string {
  return `---\nname: ${s.name}\ndescription: ${s.description.replace(/\n/g, ' ')}\n---\n\n${s.content}\n`;
}

/** Pure: description and body back from a SKILL.md. */
export function parseSkillMd(md: string): { description: string; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { description: '', body: md };
  return { description: m[1].match(/^description:\s*(.*)$/m)?.[1]?.trim() ?? '', body: m[2].replace(/^\r?\n/, '').replace(/\r?\n$/, '') };
}

let shared: MemoryClient | undefined;
export const memoryClient = (): MemoryClient => (shared ??= new MemoryClient());
export const setMemoryClient = (c: MemoryClient | undefined) => void (shared = c);

/** The `user_id` of an app + surface. */
export const memoryUser = (surface: string) => `teamily-${surface.startsWith('android') ? 'android' : 'web'}`;
