// Pre-execution category (milestone 5 §A.1): rules first, LLM as second opinion when the rules are weak.
// "fixed" / "user misuse" are conclusions after a run, not categories here.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { PreCategory, Surface } from '../platform/schema/test-plan';
import { chatJson, modelConfigured } from './llm';
import type { NormalizedIssue } from './parse';

export interface Classification {
  category: PreCategory;
  /** Execution surfaces available for the platforms the Issue names (before substitution). */
  surfaces: Surface[];
  reason: string;
  /** Strong = a rule fired on an unambiguous signal; the LLM cannot override it. */
  strength: 'strong' | 'weak';
  by: 'rules' | 'model';
  /** feature that also needs a second account: the single-account part runs, the rest is deferred. */
  partialMultiAccount?: boolean;
}

export const AVAILABLE: Surface[] = ['android-app', 'mobile-web', 'desktop-web'];

/** Issue platform → our surfaces. ios has no direct surface (substitution needed). */
export function surfacesFor(platforms: string[]): Surface[] {
  const s = new Set<Surface>();
  for (const p of platforms) {
    if (p === 'android') s.add('android-app');
    if (p === 'web' || p === 'desktop') s.add('desktop-web');
  }
  return [...s];
}

const text = (i: NormalizedIssue) => `${i.title}\n${i.summary}\n${i.steps.join('\n')}\n${i.expected}\n${i.actual}\n${i.featureArea}\n${i.context}`;

const OVERRIDES_FILE = resolve(process.env.ISSUE_OVERRIDES_FILE ?? 'platform/issue-overrides.yaml');

/** Manual overrides (platform/issue-overrides.yaml): an explicit, reviewed decision beats rules and the model. */
export function overrideFor(id: string, file = OVERRIDES_FILE): { category: PreCategory; reason: string } | undefined {
  if (!existsSync(file)) return undefined;
  const o = ((yaml.load(readFileSync(file, 'utf8')) ?? {}) as Record<string, { category?: PreCategory; reason?: string }>)[id];
  return o?.category ? { category: o.category, reason: String(o.reason ?? 'manual override') } : undefined;
}

/** Pure rule classifier. */
export function classifyRules(i: NormalizedIssue): Classification {
  const surfaces = surfacesFor(i.platforms);
  const ov = overrideFor(i.id);
  if (ov) return { category: ov.category, surfaces, reason: ov.reason, strength: 'strong', by: 'rules' };
  const t = text(i).toLowerCase();
  const head = `${i.summary}\n${i.featureArea}\n${i.environment}`.toLowerCase();
  const mk = (category: PreCategory, reason: string, strength: 'strong' | 'weak' = 'strong', extra: Partial<Classification> = {}): Classification => ({ category, surfaces, reason, strength, by: 'rules', ...extra });

  if (i.empty) return mk('not-executable', 'Issue 文档为空：没有摘要和复现步骤，无可观察现象');
  if (/localstorage|indexeddb|quota|storage (is )?full/.test(head)) return mk('deferred', '前置条件需要写满浏览器存储（localStorage 配额），黑盒无法构造，记入未来计划');
  if (/agent account|sent by an agent|agent send path|send path|via (the )?api|server[- ]side|backend|接口/.test(head) && !/\bui\b|picker|button|tap|click/.test(i.steps.join(' ').toLowerCase()))
    return mk('server-side', '问题发生在服务端 / Agent 发送路径，无用户可见 UI 现象可驱动或观察');
  const feature = /improvement request|feature request|建议增加|需求|unified|consolidat|should (add|provide|support)/.test(head);
  const multi = /multi-device|多端|same account on|other clients|second account|another account|recipient|forwarded|two accounts|另一(个)?账号/.test(t);
  if (feature) {
    const needsOther = /mentioned by|@-mentioned|someone @|被 ?@|另一账号|second account/.test(t);
    return mk('feature', needsOther ? '需求类：单账号可验部分一次性验收；需要他人 @ 我的部分需第二账号，暂缓' : '需求类：按 Expected/AC 一次性验收', 'strong', { partialMultiAccount: needsOther });
  }
  if (multi && /sync|同步|forward|转发|multi-device|other clients/.test(head)) return mk('multi-account', '需要第二账号或同账号多端配合观察，等待账号池/设备池多客户端支持');
  if (/always|必现|100%/.test(i.frequency.toLowerCase())) return mk('bug-always', `Frequency: ${i.frequency}；步骤明确`, i.steps.length ? 'strong' : 'weak');
  if (/intermittent|sometimes|occasional|偶|有时/.test(i.frequency.toLowerCase() + head)) return mk('bug-intermittent', `Frequency: ${i.frequency || '偶发'}`);
  return mk('bug-intermittent', '频率未声明，按偶现处理', 'weak');
}

const SYSTEM = `You triage bug reports for a black-box UI test robot of the Teamily IM app (web + Android).
Classify ONE issue into exactly one category:
- bug-always: reproducible every time with clear steps
- bug-intermittent: happens sometimes
- feature: improvement request / acceptance of a capability
- suspected-misuse: the reporter's path differs from the normal way to use the feature
- server-side: no user-visible UI symptom; only API / agent send path / server behaviour
- multi-account: needs a second account or a second client of the same account to observe
- deferred: precondition needs capabilities a black-box robot lacks (e.g. filling browser storage)
- not-executable: empty / no observable symptom
Reply ONE JSON object: {"category": "...", "reason": "<one Chinese sentence>"}`;

export async function classify(i: NormalizedIssue): Promise<Classification> {
  const r = classifyRules(i);
  if (r.strength === 'strong' || !modelConfigured()) return r;
  const ans = (await chatJson(SYSTEM, `Issue ${i.id}\nFrequency: ${i.frequency}\nPlatforms: ${i.platforms.join(', ')}\n${text(i).slice(0, 6000)}`)) as { category?: string; reason?: string } | undefined;
  const cats: PreCategory[] = ['bug-always', 'bug-intermittent', 'feature', 'suspected-misuse', 'server-side', 'multi-account', 'deferred', 'not-executable'];
  if (ans && cats.includes(ans.category as PreCategory)) return { ...r, category: ans.category as PreCategory, reason: String(ans.reason ?? r.reason), by: 'model' };
  return r;
}
