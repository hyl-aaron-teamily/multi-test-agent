// Deterministic problem detectors (W2-5 §6, N3), shared by both tiers: blank screen, stuck loading, error text,
// placeholder / Markdown source, tap with no response. Pure: one observation in (screenshot + nodes), hits
// out; time-based detectors keep their state in DetectState. Every hit still goes through the evidence review
// before it counts (exploration: a finding; quick tier: an incidental finding that never touches the Issue verdict).
import { type Box, pixelDiff, type Rgba } from '../core/image';
import { label, type ScreenNode } from '../core/screen-index';

export type DetectKind = 'blank-screen' | 'stuck-loading' | 'error-text' | 'placeholder-text' | 'no-response';

export interface DetectHit {
  kind: DetectKind;
  /** What the screen shows, as visible facts (also the evidence review's "actual"). */
  description: string;
  /** The node it is about (text detectors, no-response). */
  text?: string;
  box?: Box;
}

export interface Observation {
  at: number;
  img?: Rgba;
  nodes: ScreenNode[];
  /** Web: visible text lines without a place (plain text has no role); read by the text detectors too. */
  texts?: string[];
  width: number;
  height: number;
}

export interface DetectState {
  blankSince?: number;
  loadingSince?: number;
  loadingText?: string;
  /** Element key → consecutive taps on it that changed nothing. */
  deadTaps: Map<string, number>;
}

export const newDetectState = (): DetectState => ({ deadTaps: new Map() });

/** Thresholds (§6 table). */
export const DETECT = { blankMs: 5000, loadingMs: 15_000, blankStd: 6, blankMaxNodes: 2, deadTapMs: 3000, deadTapsToHit: 2, maxTextLen: 60, maxErrorLen: 30 };

/** What the review compares a hit against (its "expected"). */
export const DETECT_EXPECTED: Record<DetectKind, string> = {
  'blank-screen': '页面应显示内容，不应长时间空白',
  'stuck-loading': '加载应在合理时间内结束，不应一直显示加载中',
  'error-text': '正常使用时不应出现报错提示',
  'placeholder-text': '界面应显示真实内容，不应出现未替换的占位文字或未渲染的 Markdown 标记',
  'no-response': '点击可交互的元素后界面应有反应',
};

const ERROR_ZH = /失败|出错|请重试|网络异常|网络错误|网络不可用|服务异常|服务器错误|发生错误|连接失败/;
const ERROR_EN = /\b(something went wrong|an error (has )?occurred|network error|failed to (load|send|connect)|unable to (load|connect)|try again|request failed|server error|no (internet|network) connection)\b|^\s*error\s*$/i;
const LOADING = /^(加载中|正在加载|连接中|正在连接|等待网络|正在重连|重新连接中|请稍候|loading|connecting|reconnecting|waiting for network|please wait)\s*[.…。]*$/i;
/** Bracket tags the product shows on purpose (message previews: [图片], [Photo] …). */
const KNOWN_TAGS = /^(图片|照片|语音|视频|文件|表情|动画表情|位置|链接|名片|红包|草稿|有人@我|@我|Image|Photo|Voice|Video|File|Sticker|Location|Link|Draft|GIF)$/i;
const PLACEHOLDER = [
  { re: /\[([^\]\s]{1,12})\]/, ok: (m: RegExpMatchArray) => !KNOWN_TAGS.test(m[1]) && !/^\d+$/.test(m[1]), what: '方括号占位' },
  { re: /\{\{\s*[\w.]+\s*\}\}|\$\{\s*[\w.]+\s*\}/, what: '未替换的模板变量' },
  { re: /^(undefined|null|NaN|\[object Object\])$|\b(undefined|NaN)\b|\[object Object\]/, what: '程序值泄漏' },
  { re: /\*\*[^*\s][^*]*\*\*|^\s*>\s|^\s*```/, what: '未渲染的 Markdown 标记' },
] as { re: RegExp; ok?: (m: RegExpMatchArray) => boolean; what: string }[];

const isInput = (n: ScreenNode) => /EditText|textbox|textarea|searchbox|combobox/i.test(n.cls);
const inside = (n: ScreenNode, b: Box) => n.center.x >= b[0] && n.center.x <= b[0] + b[2] && n.center.y >= b[1] && n.center.y <= b[1] + b[3];

/** Pure: where user content lives — the message list of a chat-like screen (between the top bar and an input
 *  box in the lower quarter) — so user text ("失败了吗？", "[x]") is never taken for a product problem. */
export function userContentBoxes(o: Pick<Observation, 'nodes' | 'width' | 'height'>): Box[] {
  const composer = o.nodes.filter((n) => isInput(n) && n.box[1] > o.height * 0.75).sort((a, b) => a.box[1] - b.box[1])[0];
  if (!composer) return [];
  const top = Math.round(o.height * 0.1);
  return [[0, top, o.width, composer.box[1] - top]];
}

/** Pure: the nodes whose text the text detectors read — short texts, not inputs, not user content. Web text
 *  lines have no place: they are read as well, but never those also found in the user content area. */
function textNodes(o: Observation): { n: ScreenNode; t: string }[] {
  const ex = userContentBoxes(o);
  const own = o.nodes
    .filter((n) => !isInput(n) && !ex.some((b) => inside(n, b)))
    .map((n) => ({ n, t: label(n).trim() }))
    .filter((x) => x.t && x.t.length <= DETECT.maxTextLen);
  const userText = new Set(o.nodes.filter((n) => isInput(n) || ex.some((b) => inside(n, b))).map((n) => label(n).trim()));
  const seen = new Set(own.map((x) => x.t));
  const lines = (o.texts ?? []).filter((t) => t.length <= DETECT.maxTextLen && !seen.has(t) && !userText.has(t));
  return [...own, ...[...new Set(lines)].map((t) => ({ n: { text: t, desc: '', rid: '', cls: 'text', clickable: false, box: [0, 0, 0, 0] as Box, center: { x: 0, y: 0 } }, t }))];
}

/** Pure: luminance standard deviation of the page area (status bar and bottom edge left out), sampled. */
export function pageStd(img: Rgba): number {
  const y0 = Math.round(img.height * 0.08);
  const y1 = Math.round(img.height * 0.94);
  let n = 0;
  let sum = 0;
  let sq = 0;
  for (let y = y0; y < y1; y += 8) {
    for (let x = 0; x < img.width; x += 8) {
      const o = (y * img.width + x) * 4;
      const l = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
      n++;
      sum += l;
      sq += l * l;
    }
  }
  if (!n) return 0;
  const m = sum / n;
  return Math.sqrt(Math.max(0, sq / n - m * m));
}

/** Pure: the observation's hits (blank / loading need the condition to hold long enough across calls). */
export function detect(o: Observation, st: DetectState): DetectHit[] {
  const hits: DetectHit[] = [];
  // Blank screen: a flat page and next to nothing to read, for ≥ blankMs.
  const labelled = o.nodes.filter((n) => label(n).trim()).length;
  const blank = !!o.img && pageStd(o.img) < DETECT.blankStd && labelled <= DETECT.blankMaxNodes;
  if (!blank) st.blankSince = undefined;
  else if (st.blankSince === undefined) st.blankSince = o.at;
  else if (o.at - st.blankSince >= DETECT.blankMs) hits.push({ kind: 'blank-screen', description: `页面空白（几乎没有可见内容和文字）已持续 ${Math.round((o.at - st.blankSince) / 1000)} 秒` });
  // Stuck loading: a progress indicator or a loading text, for ≥ loadingMs.
  const texts = textNodes(o);
  const loading = o.nodes.find((n) => /ProgressBar|progressbar/i.test(n.cls)) ?? texts.find((x) => LOADING.test(x.t))?.n;
  if (!loading) {
    st.loadingSince = undefined;
    st.loadingText = undefined;
  } else if (st.loadingSince === undefined) {
    st.loadingSince = o.at;
    st.loadingText = label(loading) || loading.cls;
  } else if (o.at - st.loadingSince >= DETECT.loadingMs)
    hits.push({ kind: 'stuck-loading', description: `一直在加载（「${st.loadingText}」）已持续 ${Math.round((o.at - st.loadingSince) / 1000)} 秒`, text: st.loadingText, box: loading.box });
  for (const { n, t } of texts) {
    // Error prompts are short (a toast, a dialog line); longer texts are help or content.
    if (t.length <= DETECT.maxErrorLen && (ERROR_ZH.test(t) || ERROR_EN.test(t))) {
      hits.push({ kind: 'error-text', description: `界面上出现报错提示「${t}」`, text: t, box: n.box });
      continue;
    }
    for (const p of PLACEHOLDER) {
      const m = t.match(p.re);
      if (m && (!p.ok || p.ok(m))) {
        hits.push({ kind: 'placeholder-text', description: `界面上出现${p.what}「${t}」`, text: t, box: n.box });
        break;
      }
    }
  }
  return hits;
}

/** Pure: a tap that changed nothing. `before` / `after` are the observations around a tap on an interactive
 *  element that passed the pre-tap check, `after` taken ≥ deadTapMs later; two in a row on the same element hit. */
export function deadTap(key: string, before: Observation, after: Observation, st: DetectState, target: { text: string; box: Box }): DetectHit | undefined {
  const sameNodes = before.nodes.map((n) => `${label(n)}@${n.box.join(',')}`).join('|') === after.nodes.map((n) => `${label(n)}@${n.box.join(',')}`).join('|');
  const samePixels = !!before.img && !!after.img && before.img.width === after.img.width && pixelDiff(before.img, after.img) < before.img.width * before.img.height * 0.005;
  if (!(after.at - before.at >= DETECT.deadTapMs && sameNodes && samePixels)) {
    st.deadTaps.delete(key);
    return undefined;
  }
  const k = (st.deadTaps.get(key) ?? 0) + 1;
  st.deadTaps.clear();
  st.deadTaps.set(key, k);
  return k >= DETECT.deadTapsToHit ? { kind: 'no-response', description: `连续 ${k} 次点击「${target.text || '（无文字的元素）'}」，界面和元素都没有任何变化`, text: target.text, box: target.box } : undefined;
}
