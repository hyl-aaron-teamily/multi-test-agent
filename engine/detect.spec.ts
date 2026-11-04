import { describe, expect, it } from 'vitest';
import type { Rgba } from '../core/image';
import type { ScreenNode } from '../core/screen-index';
import { deadTap, detect, DETECT, newDetectState, type Observation, pageStd, userContentBoxes } from './detect';

const W = 400;
const H = 800;
const flat = (v = 250): Rgba => ({ width: W, height: H, data: new Uint8Array(W * H * 4).fill(v) });
/** A page with content: horizontal stripes of text-like dark lines. */
const busy = (): Rgba => {
  const img = flat();
  for (let y = 80; y < H - 60; y += 24) for (let x = 20; x < W - 20; x++) for (let k = 0; k < 6; k++) img.data.fill(30, ((y + k) * W + x) * 4, ((y + k) * W + x) * 4 + 3);
  return img;
};
const node = (text: string, y = 300, cls = 'android.widget.TextView', h = 40): ScreenNode => ({ text, desc: '', rid: '', cls, clickable: false, box: [20, y, 300, h], center: { x: 170, y: y + h / 2 } });
const obs = (at: number, nodes: ScreenNode[], img: Rgba = busy()): Observation => ({ at, img, nodes, width: W, height: H });
const kinds = (o: Observation, st = newDetectState()) => detect(o, st).map((h) => h.kind);

describe('deterministic detectors (W2-5 §6)', () => {
  it('blank screen: flat page with next to nothing to read, held ≥ 5 s', () => {
    expect(pageStd(flat())).toBeLessThan(DETECT.blankStd);
    expect(pageStd(busy())).toBeGreaterThan(DETECT.blankStd);
    const st = newDetectState();
    expect(kinds(obs(0, [], flat()), st)).toEqual([]);
    expect(kinds(obs(3000, [], flat()), st)).toEqual([]);
    expect(kinds(obs(5200, [], flat()), st)).toEqual(['blank-screen']);
    // negatives: content on the page; or a flat page with text (a plain settings list); or not held long enough
    const st2 = newDetectState();
    for (const t of [0, 6000]) expect(kinds(obs(t, [], busy()), st2)).toEqual([]);
    const st3 = newDetectState();
    for (const t of [0, 6000]) expect(kinds(obs(t, [node('通知'), node('隐私', 360), node('关于', 420)], flat()), st3)).toEqual([]);
    const st4 = newDetectState();
    expect(kinds(obs(0, [], flat()), st4)).toEqual([]);
    expect(kinds(obs(2000, [node('a'), node('b', 360), node('c', 420)], busy()), st4)).toEqual([]);
    expect(kinds(obs(7000, [], flat()), st4)).toEqual([]);
  });

  it('stuck loading: a progress bar or loading text for ≥ 15 s', () => {
    const st = newDetectState();
    expect(kinds(obs(0, [node('加载中…')]), st)).toEqual([]);
    expect(kinds(obs(16_000, [node('加载中…')]), st)).toEqual(['stuck-loading']);
    const st2 = newDetectState();
    expect(kinds(obs(0, [node('', 300, 'android.widget.ProgressBar')]), st2)).toEqual([]);
    expect(kinds(obs(15_500, [node('', 300, 'android.widget.ProgressBar')]), st2)).toEqual(['stuck-loading']);
    // negatives: the spinner went away in between; "Loading screen settings" is not a loading indicator
    const st3 = newDetectState();
    expect(kinds(obs(0, [node('Loading')]), st3)).toEqual([]);
    expect(kinds(obs(8000, [node('完成')]), st3)).toEqual([]);
    expect(kinds(obs(16_000, [node('Loading')]), st3)).toEqual([]);
    const st4 = newDetectState();
    for (const t of [0, 20_000]) expect(kinds(obs(t, [node('Loading screen settings')]), st4)).toEqual([]);
  });

  it('error text: short product texts in Chinese and English; never user messages or inputs', () => {
    for (const t of ['加载失败，请重试', '网络异常', '发送失败', 'Something went wrong', 'Network error', 'Error', 'Failed to load messages'])
      expect(kinds(obs(0, [node(t)])), t).toEqual(['error-text']);
    // negatives: ordinary words, long texts, inputs, and the message list of a chat screen
    for (const t of ['设置', 'Error reports', 'terror', '这是一段很长的说明文字，介绍了在什么情况下会出现失败以及应该怎样处理，并不是一个报错提示本身，只是帮助文档'])
      expect(kinds(obs(0, [node(t)])), t).toEqual([]);
    expect(kinds(obs(0, [node('发送失败', 300, 'android.widget.EditText')]))).toEqual([]);
    const chat = [node('你那边发送失败了吗？', 300), node('', H - 90, 'android.widget.EditText', 60)];
    expect(userContentBoxes({ nodes: chat, width: W, height: H })).toEqual([[0, 80, W, H - 90 - 80]]);
    expect(kinds(obs(0, chat))).toEqual([]);
  });

  it('placeholders and Markdown source; the product’s own tags are not placeholders', () => {
    for (const t of ['[自定义消息]', 'Hello {{name}}', '${count} 条新消息', 'undefined', '[object Object]', '价格 NaN 元', '**重点**内容', '> 引用的文字', '```js'])
      expect(kinds(obs(0, [node(t)])), t).toEqual(['placeholder-text']);
    for (const t of ['[图片]', '[Photo]', '[语音]', '[有人@我]', '[3]', 'null hypothesis? no: 数据为空', '2 * 3 = 6', 'a > b'])
      expect(kinds(obs(0, [node(t)])), t).toEqual([]);
    // user content in a chat is left out
    expect(kinds(obs(0, [node('[自定义消息]', 300), node('', H - 90, 'android.widget.EditText', 60)]))).toEqual([]);
  });

  it('no response: two taps in a row on the same element, ≥ 3 s each, nothing changed', () => {
    const st = newDetectState();
    const before = obs(0, [node('详情')]);
    const same = obs(3200, [node('详情')]);
    const target = { text: '详情', box: before.nodes[0].box };
    expect(deadTap('详情', before, same, st, target)).toBeUndefined();
    expect(deadTap('详情', obs(4000, [node('详情')]), obs(7200, [node('详情')]), st, target)?.kind).toBe('no-response');
    // negatives: the page changed; or it was checked too early; or another element came in between
    const st2 = newDetectState();
    deadTap('详情', before, same, st2, target);
    expect(deadTap('详情', before, obs(3300, [node('详情'), node('新页面', 400)]), st2, target)).toBeUndefined();
    expect(deadTap('详情', before, same, st2, target)).toBeUndefined();
    const st3 = newDetectState();
    deadTap('详情', before, same, st3, target);
    expect(deadTap('详情', before, obs(1000, [node('详情')]), st3, target)).toBeUndefined();
    const st4 = newDetectState();
    deadTap('详情', before, same, st4, target);
    deadTap('更多', before, same, st4, { text: '更多', box: target.box });
    expect(deadTap('详情', before, same, st4, target)).toBeUndefined();
  });

  it('web text lines (no role, no place) are read too; lines that are user content are not', () => {
    const st = newDetectState();
    const o = (at: number, texts: string[], nodes: ScreenNode[] = []): Observation => ({ ...obs(at, nodes), texts });
    expect(detect(o(0, ['aaron+test1', '等待网络']), st)).toEqual([]);
    expect(detect(o(16_000, ['aaron+test1', '等待网络']), st).map((h) => h.kind)).toEqual(['stuck-loading']);
    expect(detect(o(0, ['[自定义消息]']), newDetectState()).map((h) => h.kind)).toEqual(['placeholder-text']);
    const chat = [node('发送失败了吗', 300), node('', H - 90, 'textbox', 60)];
    expect(detect(o(0, ['发送失败了吗'], chat), newDetectState())).toEqual([]);
  });
});
