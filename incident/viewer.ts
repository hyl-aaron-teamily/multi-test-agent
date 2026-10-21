// index.html: single-file offline timeline viewer. Video (merged mp4 + ops.srt as subtitles) or trace
// links, the op list as clickable markers (seek the video), log window filtered around the cursor.
// Logs are loaded from logs/ by a relative fetch when served; opened from disk, the embedded tail is used.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoordOp } from './recording-driver';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function viewerHtml(meta: Record<string, any>, ops: CoordOp[], dir: string): string {
  const videoStart: number | undefined = meta.video?.[0]?.startedAt;
  const logFile = ['logs/logcat-window.txt', 'logs/console.jsonl'].find((f) => existsSync(join(dir, f)));
  const logText = logFile ? readFileSync(join(dir, logFile), 'utf8').split('\n').slice(-3000).join('\n') : '';
  const trig = Date.parse(meta.triggeredAt);
  const data = { meta, videoStart, trig, ops: ops.slice(-400), logFile };
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>incident ${esc(String(meta.kind))} — ${esc(String(meta.issue))}</title>
<style>body{font:13px system-ui,sans-serif;margin:0;display:grid;grid-template-columns:minmax(320px,46%) 1fr;height:100vh}
#l{padding:10px;overflow:auto;border-right:1px solid #ddd}#r{display:grid;grid-template-rows:auto 1fr 40%;overflow:hidden}
video{width:100%;max-height:62vh;background:#000}h1{font-size:15px;margin:4px 0}.k{color:#b00;font-weight:600}
#ops{overflow:auto;padding:6px}#ops div{cursor:pointer;padding:1px 4px;font-family:monospace;white-space:nowrap}#ops div:hover{background:#eef}
#ops .trig{background:#fdd}#log{overflow:auto;margin:0;padding:6px;background:#111;color:#ddd;font:11px monospace;white-space:pre}
table{border-collapse:collapse}td{padding:1px 6px;border-bottom:1px solid #eee;vertical-align:top}</style>
<div id="l"><h1><span class="k">${esc(String(meta.kind))}</span> · Issue ${esc(String(meta.issue))} · ${esc(String(meta.surface))}${meta.substitution ? ` (替代 ${esc(meta.substitution.from)}→${esc(meta.substitution.to)})` : ''}</h1>
<table>${['triggeredAt', 'detail', 'step', 'round', 'action', 'env', 'clockOffsetMs', 'videoSeconds', 'videoCoversSecondsBeforeTrigger'].map((k) => `<tr><td>${k}</td><td>${esc(String(meta[k] ?? '—')).slice(0, 600)}</td></tr>`).join('')}</table>
${meta.videoMerged ? `<video id="v" controls src="video/${esc(meta.videoMerged)}"><track default kind="subtitles" src="video/ops.srt"></video>` : meta.video?.length ? meta.video.map((v: any) => `<p><a href="video/${esc(v.name)}">${esc(v.name)}</a></p>`).join('') : ''}
${meta.traces?.length ? `<h1>Trace</h1>${meta.traces.map((t: any) => `<p><a href="trace/${esc(t.name)}">${esc(t.name)}</a> — 打开：<code>npx playwright show-trace trace/${esc(t.name)}</code></p>`).join('')}` : ''}
<p><a href="incident.json">incident.json</a> · <a href="replay.json">replay.json</a> · <a href="logs/">logs/</a> · <a href="steps/">steps/</a> · <a href="state/">state/</a></p></div>
<div id="r"><div style="padding:6px;border-bottom:1px solid #ddd">操作轨迹（点击跳转视频 / 过滤日志）</div><div id="ops"></div><pre id="log"></pre></div>
<script>const D=${JSON.stringify(data).replace(/</g, '\\u003c')};let LOG=${JSON.stringify(logText).replace(/</g, '\\u003c')}.split('\\n');
const v=document.getElementById('v'),ops=document.getElementById('ops'),log=document.getElementById('log');
function at(line){const m=line.match(/^(\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z)/)||line.match(/"time":"([^"]+)"/);return m?Date.parse(m[1]):NaN}
function showLog(t){const rows=LOG.filter(l=>{const x=at(l);return isNaN(x)||Math.abs(x-t)<15000});log.textContent=rows.join('\\n')||'(no log lines in ±15 s)';}
for(const o of D.ops){const d=document.createElement('div');d.textContent=new Date(o.at).toISOString().slice(11,23)+'  #'+o.step+' r'+o.round+' '+o.op+(o.point?' ('+o.point.x+','+o.point.y+')':'')+(o.value?' "'+o.value+'"':'')+' '+(o.label||'');
if(Math.abs(o.at-D.trig)<1500)d.className='trig';d.onclick=()=>{if(v&&D.videoStart)v.currentTime=Math.max(0,(o.at-D.videoStart)/1000);showLog(o.at)};ops.appendChild(d)}
showLog(D.trig);if(D.logFile)fetch(D.logFile).then(r=>r.text()).then(t=>{LOG=t.split('\\n');showLog(D.trig)}).catch(()=>{});
if(v&&D.videoStart)v.addEventListener('loadedmetadata',()=>{v.currentTime=Math.max(0,(D.trig-D.videoStart)/1000-5)});</script></html>`;
}
