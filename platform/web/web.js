// Shared helpers of the W2-3 pages (no framework). Every page reads /api/v1 — the same view models the CLI
// prints — and sends `x-autotest-client: web` (consent actions are Web-only).
const GLOSSARY = {
  有效尝试: '一轮的前提（例如输入框里确有刚键入的文字）成立，才算一次有效尝试；不成立的轮叫“偏离”，不计入。',
  偏离: '操作没有落到预期位置（例如键入的文字没进输入框）：这一轮不算尝试，也不算命中。',
  'Wilson 区间': '按命中次数 / 有效尝试数算出的单轮命中率 95% 置信区间；尝试越多区间越窄。',
  '3/n 上界': '0 次命中时，单次复现概率的 95% 上界约为 3 ÷ 有效尝试数。',
  替代执行: 'Issue 所在的端（如 iOS）没有执行端时，换一个相近的端（如 Android App）执行；结论不能直接代表原端。',
  环境不合格: '开跑前检查发现环境不能用（锁屏、离线、未登录…）：不操作 App，不给产品结论。',
  隔离: '环境恢复失败，已停止接新任务；需要人工处理后点“我已处理，重新检查”。',
};

function term(t) {
  return `<span class="term" title="${GLOSSARY[t] ?? ''}">${t}</span>`;
}
/** Wrap glossary words in a text with hover explanations (text is escaped first). */
function terms(s) {
  // One pass (longest term first): an inserted explanation is never scanned again.
  const keys = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length).map((k) => esc(k).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  return esc(s).replace(new RegExp(keys.join('|'), 'g'), (m) => term(Object.keys(GLOSSARY).find((k) => esc(k) === m) ?? m));
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
async function api(method, path, body) {
  const r = await fetch(`/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-autotest-client': 'web' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const qs = (k) => new URLSearchParams(location.search).get(k);
const enc = encodeURIComponent;

/** Absolute artifact path → /files/ link (only under midscene_run/). */
function fileLink(p, label) {
  if (!p) return '';
  const i = p.replace(/\\/g, '/').indexOf('midscene_run/');
  return i < 0 ? esc(p) : `<a href="/files/${p.replace(/\\/g, '/').slice(i + 'midscene_run/'.length)}" target="_blank">${esc(label ?? p.split(/[\\/]/).pop())}</a>`;
}

const ENV_CLASS = { ready: 'ok', leased: 'busy', checking: 'busy', recovering: 'busy', draining: 'busy', unfit: 'bad', quarantined: 'bad', offline: 'off' };

async function header(active) {
  const fa = (await api('GET', '/full-access')).data;
  const envs = (await api('GET', '/envs')).data ?? [];
  const bar = envs
    .map((e) => {
      const locked = e.state === 'unfit' && /锁屏/.test(e.reason ?? '');
      return `<a class="env ${ENV_CLASS[e.state] ?? ''}" href="/env.html?id=${enc(e.id)}" title="${esc(e.summary)}">${esc(e.id)}：${esc(e.stateText)}${locked ? ' — <b>需人工解锁</b>' : e.state === 'quarantined' ? ` — ${esc((e.reason ?? '').slice(0, 40))}` : ''}</a>`;
    })
    .join('');
  document.getElementById('top').innerHTML = `
    ${fa?.on ? `<div class="danger">⚠ 完全授权已开启（${esc(fa.by)}，${esc(fa.at)}）：所有计划（含敏感计划）自动批准；硬约束仍然生效。 <button onclick="toggleFA(false)">关闭完全授权</button></div>` : ''}
    <nav><a href="/" class="${active === 'home' ? 'on' : ''}">首页</a> <a href="/console">旧控制台</a> <span class="muted">审核人：<span id="who"></span></span></nav>
    <div class="envbar">环境：${bar || '<span class="muted">（无）</span>'}</div>`;
  api('GET', '/reviewer').then((r) => (document.getElementById('who').textContent = r.data?.name ?? ''));
}
async function toggleFA(on) {
  if (on && !confirm('开启完全授权：之后所有计划（含修改手机设置、超量发送等敏感计划）都会自动批准，直到你关闭。硬约束（删除 / 撤回消息、允许清单外会话、锁屏 PIN、凭据落盘）仍然拒绝。确定开启？')) return;
  await api('POST', '/full-access', { on });
  location.reload();
}
const CSS = `
body{font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;margin:0 24px 40px;max-width:1100px;color:#222}
nav{margin:10px 0}nav a{margin-right:14px}nav a.on{font-weight:bold}.muted{color:#888}
.envbar{margin:6px 0 14px}.env{display:inline-block;padding:2px 8px;margin:2px 6px 2px 0;border-radius:4px;text-decoration:none;color:#222;background:#eee}
.env.ok{background:#dff3df}.env.busy{background:#fff3cd}.env.bad{background:#f8d7da;color:#842029}.env.off{background:#e2e3e5}
.danger{background:#b02a37;color:#fff;padding:8px 12px;margin:0 -24px}
h1{font-size:20px}h2{font-size:16px;margin-top:22px;border-bottom:1px solid #ddd}
table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px;vertical-align:top;text-align:left}
.ok{color:#146c43}.bad{color:#b02a37}.term{border-bottom:1px dotted #666;cursor:help}
button{margin-right:8px}.box{background:#f6f8fa;padding:8px 12px;border-radius:6px}
.shot{position:relative;display:inline-block;margin:6px 10px 6px 0;vertical-align:top}.shot img{width:220px;border:1px solid #ccc}
.mark{position:absolute;border:2px solid #e8590c;background:rgba(232,89,12,.15)}.mark span{position:absolute;top:-18px;left:0;background:#e8590c;color:#fff;font-size:11px;padding:0 4px;border-radius:3px}
`;
document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
