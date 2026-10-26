// Natural-language request → MissionPlan.
// Uses the same OpenAI-compatible endpoint Midscene is configured with (MIDSCENE_MODEL_*), text-only,
// JSON output. If the model call fails or returns junk, a keyword planner produces a usable plan so
// a mission never dies at the planning stage.

export type MissionIntent = 'reproduce' | 'investigate' | 'evaluate' | 'general';

export interface MissionPlan {
  intent: MissionIntent;
  title: string;
  /** Screen / feature under test, in the user's words. */
  targetArea: string;
  /** Natural-language navigation for agent.aiAct from the app home to the target area ('' = stay on home). */
  entryInstruction: string;
  /** Concrete user actions to repeat while trying to reproduce (each one aiAct call). */
  scenario: string[];
  /** Keywords that steer random exploration inside the area. */
  focusTerms: string[];
  /** Statements that must be true on the target screen; a false answer is a finding. */
  checks: string[];
  /** Collect dumpsys gfxinfo jank stats per round (fluency questions). */
  measureJank: boolean;
  /** Random exploratory actions after the scenario in every round (varies the conditions). */
  exploreStepsPerRound: number;
  maxSteps: number;
  maxMinutes: number;
  stopOnFirstFinding: boolean;
  plannedBy: 'model' | 'rules';
  rationale: string;
}

export const DEFAULT_LIMITS = { maxSteps: 40, maxMinutes: 15 };
/** Platform caps: a plan or a user flag can never exceed these. */
export const LIMIT_CAPS = { maxSteps: Number(process.env.MISSION_STEP_CAP ?? 300), maxMinutes: Number(process.env.MISSION_MINUTES_CAP ?? 120) };

const INTENTS: MissionIntent[] = ['reproduce', 'investigate', 'evaluate', 'general'];

const SYSTEM = `You are a senior mobile QA engineer. Turn a tester's request about an Android app into an executable test mission.
The executor is a vision agent that can run natural-language UI actions ("tap X", "scroll the list down", "type hello in the input box and send"),
answer yes/no questions about the screen, watch logcat for crashes/ANRs and measure frame jank.
Problems in this product are usually intermittent with vague reproduction conditions, so prefer repeated, varied attempts
(fast repeated taps, scrolling during loading, switching screens quickly, sending several messages in a row, going background/foreground).
Reply with ONE JSON object only, no markdown:
{
 "intent": "reproduce" | "investigate" | "evaluate" | "general",
 "title": short Chinese title,
 "targetArea": the screen/feature under test,
 "entryInstruction": one natural-language instruction to reach it from the app home screen ("" if home itself),
 "scenario": 3-8 concrete user actions to repeat each round, written as UI instructions,
 "focusTerms": 3-8 keywords (Chinese and English) of controls worth exploring there,
 "checks": 2-6 statements that must be TRUE on the target screen if it works, each verifiable from ONE still screenshot taken after the actions (describe a visible state, never motion, timing or "while scrolling"; e.g. "the message list shows at least one conversation with a name and a preview"),
 "measureJank": true if fluency/smoothness/lag/performance is in question,
 "exploreStepsPerRound": 3-10,
 "maxSteps": suggested total actions (20-120),
 "maxMinutes": suggested wall-clock minutes (5-30),
 "rationale": one Chinese sentence on the strategy
}`;

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

const strArr = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, max) : [];

/** Validate/normalise a model answer. Pure, exported for tests. */
export function normalisePlan(raw: unknown, request: string, plannedBy: MissionPlan['plannedBy']): MissionPlan {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fallback = rulePlan(request);
  const intent = INTENTS.includes(r.intent as MissionIntent) ? (r.intent as MissionIntent) : fallback.intent;
  const scenario = strArr(r.scenario, 8);
  return {
    intent,
    title: String(r.title ?? '').trim() || fallback.title,
    targetArea: String(r.targetArea ?? '').trim() || fallback.targetArea,
    entryInstruction: String(r.entryInstruction ?? '').trim(),
    scenario: scenario.length ? scenario : fallback.scenario,
    focusTerms: strArr(r.focusTerms, 8).length ? strArr(r.focusTerms, 8) : fallback.focusTerms,
    checks: strArr(r.checks, 6).length ? strArr(r.checks, 6) : fallback.checks,
    measureJank: typeof r.measureJank === 'boolean' ? r.measureJank : fallback.measureJank,
    exploreStepsPerRound: clampInt(r.exploreStepsPerRound, 0, 15, fallback.exploreStepsPerRound),
    maxSteps: clampInt(r.maxSteps, 5, LIMIT_CAPS.maxSteps, DEFAULT_LIMITS.maxSteps),
    maxMinutes: clampInt(r.maxMinutes, 1, LIMIT_CAPS.maxMinutes, DEFAULT_LIMITS.maxMinutes),
    stopOnFirstFinding: true,
    plannedBy,
    rationale: String(r.rationale ?? '').trim() || fallback.rationale,
  };
}

/** Keyword planner: used when the model is unavailable. Pure, exported for tests. */
export function rulePlan(request: string): MissionPlan {
  const t = request.toLowerCase();
  const crash = /闪退|崩溃|crash|anr|卡死|无响应|重现|复现/.test(t);
  const fluency = /流畅|卡顿|掉帧|慢|lag|jank|smooth|性能/.test(t);
  const feature = /新加|新功能|功能完整|完整性|feature/.test(t);
  const area =
    /消息列表|会话列表|message list/.test(t) ? '消息列表' :
    /聊天|chat/.test(t) ? '聊天页' :
    /左侧栏|侧边栏|抽屉|sidebar|drawer/.test(t) ? '左侧栏' :
    /个人资料|profile/.test(t) ? '个人资料' :
    /智能体|agent/.test(t) ? '智能体' : '首页';
  const entry: Record<string, string> = {
    消息列表: '',
    聊天页: 'open the first conversation in the chat list',
    左侧栏: 'open the left side panel / drawer (tap the avatar or menu icon at the top-left)',
    个人资料: 'tap the user avatar at the top-left to open the profile page',
    智能体: 'tap the 智能体 / Agents tab in the bottom bar',
    首页: '',
  };
  const scenario: Record<string, string[]> = {
    消息列表: ['scroll the conversation list down quickly to the bottom', 'scroll back up to the top quickly', 'pull down to refresh the list', 'open the second conversation and immediately go back'],
    聊天页: ['type "test message" in the input box and send it', 'send three short messages in a row quickly', 'scroll the chat history up quickly', 'go back to the list and reopen the same chat immediately'],
    左侧栏: ['tap every entry in the left panel one by one, going back after each', 'open and close the left panel quickly three times'],
    个人资料: ['open the settings menu', 'open 账户与个人资料 and go back', 'switch between the 帖子 / 收藏 / 点赞 tabs quickly'],
    智能体: ['open the first agent', 'go back and open the second agent', 'switch between the agent tabs quickly'],
    首页: ['switch through every bottom tab quickly', 'scroll the home list down and up'],
  };
  return {
    intent: crash ? 'reproduce' : feature || fluency ? 'evaluate' : /排查|问题|bug/.test(t) ? 'investigate' : 'general',
    title: `${area}${crash ? '偶发崩溃复现' : fluency || feature ? '流畅度与功能完整性' : '问题排查'}`,
    targetArea: area,
    entryInstruction: entry[area],
    scenario: scenario[area],
    focusTerms: [area, ...(area === '左侧栏' ? ['menu', '设置'] : [])],
    checks: [`the ${area} screen is displayed with its normal content, no error message, blank area or endless loading spinner`],
    measureJank: fluency || feature,
    exploreStepsPerRound: 5,
    ...DEFAULT_LIMITS,
    stopOnFirstFinding: true,
    plannedBy: 'rules',
    rationale: '模型规划不可用，按关键词生成：进入目标区域后重复场景动作并穿插随机探索。',
  };
}

/** Pull the first JSON object out of a model answer (tolerates ```json fences). Pure. */
import { extractJson } from '../core/model/llm';

export { extractJson };

export async function planMission(request: string, ctx: { packageName: string; appHint?: string }): Promise<MissionPlan> {
  const base = process.env.MIDSCENE_PLANNING_MODEL_BASE_URL ?? process.env.MIDSCENE_MODEL_BASE_URL;
  const key = process.env.MIDSCENE_PLANNING_MODEL_API_KEY ?? process.env.MIDSCENE_MODEL_API_KEY;
  const model = process.env.MISSION_PLANNER_MODEL ?? process.env.MIDSCENE_MODEL_NAME;
  if (!base || !key || !model) return rulePlan(request);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `App package: ${ctx.packageName}${ctx.appHint ? `\nApp: ${ctx.appHint}` : ''}\nTester request: ${request}` },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = extractJson(body.choices?.[0]?.message?.content ?? '');
    if (!parsed) throw new Error('no JSON in model answer');
    return normalisePlan(parsed, request, 'model');
  } catch (err) {
    console.warn(`[mission] model planning failed (${(err as Error).message}); using keyword planner`);
    return rulePlan(request);
  }
}
