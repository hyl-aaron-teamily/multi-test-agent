// autotest Web console (W2-4.1 §7): one page, hash routes, no framework. Every view reads /api/v1 — the same
// view models the CLI prints and MCP returns — and sends `x-autotest-client: web` (consent actions are
// Web-only). Each page answers five questions: what is to be done / what is happening / the result / can it
// be trusted / what next. Plain-language step texts come from the server's templates (PlanView, TaskView).

// ---------------------------------------------------------------- helpers

const GLOSSARY = {
  有效尝试: '一轮的前提（例如输入框里确有刚键入的文字）成立，才算一次有效尝试；不成立的轮叫“偏离”，不计入。',
  偏离: '操作没有落到预期位置（例如键入的文字没进输入框）：这一轮不算尝试，也不算命中。',
  'Wilson 区间': '按命中次数 / 有效尝试数算出的单轮命中率 95% 置信区间；尝试越多区间越窄。',
  '3/n 上界': '0 次命中时，单次复现概率的 95% 上界约为 3 ÷ 有效尝试数。',
  替代执行: 'Issue 所在的端（如 iOS）没有执行端时，换一个相近的端（如 Android App）执行；结论不能直接代表原端。',
  环境不合格: '开跑前检查发现环境不能用（锁屏、离线、未登录…）：不操作 App，不给产品结论。',
  证据复核: '命中后让视觉模型对照 Issue 描述看现场截图：一致才算复现，不一致或无法判断都会标出来。',
  现场包: '命中时保存的完整现场：录像 / trace、日志、步骤、设备状态和 replay.json，index.html 可离线打开。',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const enc = encodeURIComponent;
const $ = (sel, root = document) => root.querySelector(sel);

/** Escape a text and wrap glossary words in hover explanations (one pass, longest first). */
function terms(s) {
  const keys = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);
  const re = new RegExp(keys.map((k) => esc(k).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|'), 'g');
  return esc(s).replace(re, (m) => `<span class="term" title="${esc(GLOSSARY[keys.find((k) => esc(k) === m)] ?? '')}">${m}</span>`);
}

async function api(method, path, body) {
  try {
    const r = await fetch(`/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-autotest-client': 'web' }, body: body ? JSON.stringify(body) : undefined });
    return await r.json();
  } catch (e) {
    return { code: 'PLATFORM_DOWN', exit: 54, summary: '连不上平台服务', error: { message: String(e), hint: '在本机运行 pnpm platform' } };
  }
}

/** Absolute artifact path → /files/ link (only under midscene_run/). */
function fileHref(p) {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/');
  if (s.startsWith('/files/')) return s;
  const i = s.indexOf('midscene_run/');
  return i < 0 ? '' : `/files/${s.slice(i + 'midscene_run/'.length).split('/').map(enc).join('/')}`;
}
function fileLink(p, label) {
  const h = fileHref(p);
  return h ? `<a href="${h}" target="_blank" rel="noopener">${esc(label ?? String(p).split(/[\\/]/).pop())}</a>` : esc(p ?? '');
}
const time = (iso) => (iso ? esc(String(iso).slice(0, 19).replace('T', ' ')) : '-');
const hm = (iso) => (iso ? esc(String(iso).slice(11, 19)) : '');
const pill = (cls, text) => `<span class="pill ${esc(cls)}">${esc(text)}</span>`;
const card = (q, title, body, d = 0) => `<section class="card" style="--d:${d}ms">${q ? `<div class="q">${esc(q)}</div>` : ''}${title ? `<h2>${title}</h2>` : ''}${body}</section>`;
const failMsg = (r) => `<p class="bad"><b>${esc(r.code)}</b>：${esc(r.summary)}</p>${r.error?.hint ? `<p class="muted">提示：${linkify(r.error.hint)}</p>` : ''}`;
/** Hints may carry a console URL: make it a link. */
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s]+/g, (u) => `<a href="${u.replace(/^https?:\/\/[^/]+/, '')}">${u.replace(/^https?:\/\/[^/]+/, '')}</a>`);

const SURFACE = { 'android-app': 'Android App', 'android-web': '手机浏览器', 'mobile-web': '手机网页（模拟）', 'desktop-web': '桌面网页（Edge）' };
const surfaceOf = (envId) => String(envId).split(':')[0];
const KIND = { issue: 'Issue 计划', series: 'Issue 系列', explore: '自然语言 / 探索', sync: '多端协同' };

// ---------------------------------------------------------------- shell

let timers = [];
let stream;
function clearLive() {
  for (const t of timers) clearInterval(t);
  timers = [];
  stream?.close();
  stream = undefined;
}
function every(ms, fn) {
  timers.push(setInterval(fn, ms));
}

async function shell(active) {
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('on', a.dataset.route === active);
  const fa = (await api('GET', '/full-access')).data;
  $('#banner').innerHTML = fa?.on
    ? `<div class="banner">⚠ 完全授权已开启（${esc(fa.by)}${fa.at ? `，${time(fa.at)}` : ''}）：所有计划（含敏感计划）自动批准、可写探索可用；硬约束（删除 / 撤回消息、允许清单外会话、锁屏 PIN、凭据落盘）仍然拒绝。 <button class="btn small" onclick="toggleFA(false)">关闭完全授权</button></div>`
    : '';
}
api('GET', '/reviewer').then((r) => ($('#who').textContent = `审核人 ${r.data?.name ?? '-'}`));

async function toggleFA(on) {
  if (on && !confirm('开启完全授权：之后所有计划（含修改手机设置、超量发送等敏感计划）和可写探索都不再等你点同意，直到你关闭。硬约束仍然拒绝。确定开启？')) return;
  const r = await api('POST', '/full-access', { on });
  if (r.code !== 'OK') alert(r.summary);
  route();
}

const ROUTES = [
  [/^#?\/?$/, home],
  [/^#\/new$/, newTask],
  [/^#\/task\/([^?]+)/, taskPage],
  [/^#\/result\/([^?]+)/, resultPage],
  [/^#\/plan\/([^?]+)/, planPage],
  [/^#\/env\/([^?]+)/, envPage],
  [/^#\/approvals$/, approvals],
];

function hashQuery() {
  const i = location.hash.indexOf('?');
  return new URLSearchParams(i < 0 ? '' : location.hash.slice(i + 1));
}

async function route() {
  clearLive();
  const h = location.hash.split('?')[0] || '#/';
  for (const [re, fn] of ROUTES) {
    const m = h.match(re);
    if (m) {
      try {
        await fn(...m.slice(1).map(decodeURIComponent));
      } catch (e) {
        $('#view').innerHTML = card('', '页面出错', `<p class="bad">${esc(e.message)}</p>`);
      }
      return;
    }
  }
  $('#view').innerHTML = card('', '没有这个页面', '<p><a href="#/">回到总览</a></p>');
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- 总览

async function home() {
  await shell('home');
  const draw = async () => {
    const [envs, tasks, devices] = await Promise.all([api('GET', '/envs'), api('GET', '/tasks?limit=40'), fetch('/api/devices').then((r) => r.json()).catch(() => ({ devices: [] }))]);
    if (envs.code === 'PLATFORM_DOWN') return ($('#view').innerHTML = card('', '平台服务未启动', failMsg(envs)));
    const ts = tasks.data ?? [];
    const live = ts.filter((t) => !t.finishedAt);
    const done = ts.filter((t) => t.finishedAt).slice(0, 20);
    const locked = (envs.data ?? []).filter((e) => e.state === 'unfit' && /锁屏/.test(e.reason ?? ''));
    $('#view').innerHTML = `
      <div class="page-head"><h1>总览<small>哪些环境能用、正在跑什么、刚跑完什么。</small></h1>
        <div class="row"><a class="btn primary" href="#/new">新建任务</a></div></div>
      ${locked.length ? `<section class="card" style="border-color:var(--clay)"><div class="q">下一步（需要人）</div><p class="lead">手机已锁屏：请在手机上输入 PIN 解锁，然后点该环境的「重新检查」。</p><p class="muted">${locked.map((e) => esc(e.id)).join('、')}</p></section>` : ''}
      <div class="grid two">
        ${card('正在做什么', `运行中的任务 <span class="faint">${live.length}</span>`, live.length ? taskTable(live) : '<p class="empty">没有运行中的任务。</p>', 40)}
        ${card('设备', '手机与浏览器', deviceList(devices.devices ?? []), 80)}
      </div>
      ${card('环境', '环境（端 × 设备 × 服务环境）', `<div class="envs">${(envs.data ?? []).map(envTile).join('') || '<p class="empty">没有登记的环境。</p>'}</div>`, 120)}
      ${card('结果', '最近结束的任务', done.length ? taskTable(done) : '<p class="empty">还没有结束的任务。</p>', 160)}`;
  };
  await draw();
  every(4000, draw);
}

function deviceList(ds) {
  if (!ds.length) return '<p class="empty">没有设备（adb 无手机在线）。</p>';
  return `<table><tr><th>设备</th><th>状态</th><th>占用</th></tr>${ds
    .map((d) => `<tr><td><span class="mono">${esc(d.udid)}</span>${d.model ? ` <span class="muted">${esc(d.model)}</span>` : ''}</td><td>${pill(d.status === 'idle' ? 'ready' : d.status === 'busy' ? 'leased' : 'offline', { idle: '空闲', busy: '使用中', offline: '离线' }[d.status] ?? d.status)}</td><td class="muted">${esc(Object.entries(d.leases ?? {}).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.join(', ')}`).join('；') || '-')}</td></tr>`)
    .join('')}</table>`;
}

function envTile(e) {
  const locked = e.state === 'unfit' && /锁屏/.test(e.reason ?? '');
  const s = surfaceOf(e.id);
  return `<div class="env ${locked ? 'locked' : ''}">
    <div class="env__top"><a class="env__name" href="#/env/${enc(e.id)}">${esc(SURFACE[s] ?? s)}</a>${pill(e.state, e.stateText)}</div>
    <div class="env__id">${esc(e.id)}</div>
    ${e.lease ? `<div class="muted">任务 <a href="#/task/${enc(e.lease.taskId)}">${esc(e.lease.taskId)}</a></div>` : ''}
    ${e.reason ? `<div class="env__why">${locked ? '<b>需人工解锁</b> — ' : ''}${esc(e.reason.slice(0, 90))}</div>` : ''}
    ${e.state !== 'leased' ? `<div><button class="btn small" onclick="recheck('${esc(e.id)}', this)">重新检查</button></div>` : ''}
  </div>`;
}

async function recheck(id, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = '检查中…';
  }
  const r = await api('POST', `/envs/${enc(id)}/check`);
  if (btn) btn.textContent = r.summary.slice(0, 40);
  setTimeout(route, 800);
}

const OUTCOME_CLASS = { NOT_REPRODUCED: 'good', IMPLEMENTED: 'good', EXPLORE_DONE: 'good', SERIES_DONE: 'info', REPRODUCED: 'bad', NOT_IMPLEMENTED: 'bad', PARTIAL: 'bad', EXPLORE_FINDINGS: 'bad', CANCELLED: 'offline', INTERRUPTED: 'offline' };

function taskTable(ts) {
  return `<table><tr><th>任务</th><th>要做什么</th><th>状态</th><th>结果 / 进度</th></tr>${ts
    .map((t) => {
      const what = t.explore ? `${t.explore.mode === 'explore' ? '探索' : '任务'}「${esc(t.explore.goal.slice(0, 40))}」` : t.planId.startsWith('sync:') ? `多端同步 ${esc(t.planId.slice(5))}` : `<a href="#/plan/${enc(t.planId)}">${esc(t.planId)}</a>`;
      const prog = t.finishedAt ? `${t.outcome ? `${pill(OUTCOME_CLASS[t.outcome.code] ?? 'warn', t.outcome.code)} ` : ''}<a href="#/result/${enc(t.id)}">${esc((t.outcome?.summary ?? '查看结果').slice(0, 60))}</a>` : `${esc(t.progress.phaseText ?? '')}${t.progress.round !== undefined ? ` 第 ${t.progress.round} 轮` : ''}${t.progress.step !== undefined ? ` 第 ${t.progress.step} 步` : ''}${t.progress.summary ? ` <span class="muted">${esc(t.progress.summary.slice(0, 40))}</span>` : ''}`;
      return `<tr><td><a class="mono" href="#/task/${enc(t.id)}">${esc(t.id.replace(/^t-/, ''))}</a><br><span class="faint">${time(t.createdAt)}</span></td><td>${what}<br><span class="faint">${esc([t.envId, ...(t.envIds ?? [])].join(' + '))}</span></td><td>${pill(t.state, t.stateText)}</td><td>${prog}</td></tr>`;
    })
    .join('')}</table>`;
}

// ---------------------------------------------------------------- 新建任务

async function newTask() {
  await shell('new');
  const tab = hashQuery().get('tab') ?? 'explore';
  const tabs = [['explore', '自然语言 · 探索'], ['issue', 'Issue → 计划'], ['sync', '多端协同']];
  $('#view').innerHTML = `
    <div class="page-head"><h1>新建任务<small>三种入口：一句话让 agent 自己做 / 探索；从 Issue 生成高确定性的计划；多个端互相看消息是否同步。</small></h1></div>
    <nav class="tabs">${tabs.map(([k, t]) => `<a href="#/new?tab=${k}" class="${k === tab ? 'on' : ''}">${t}</a>`).join('')}</nav>
    <div id="tab"></div>`;
  await { explore: exploreForm, issue: issueList, sync: syncForm }[tab]();
}

async function exploreForm() {
  const fa = (await api('GET', '/full-access')).data;
  $('#tab').innerHTML = `<div class="grid two">
    ${card('要做什么', '一句话目标', `
      <textarea id="goal" placeholder="例如：打开通知铃铛，看看里面有哪些通知分类，然后关掉它"></textarea>
      <div class="row"><span class="seg"><label><input type="radio" name="mode" value="explore" checked><span>探索：找问题</span></label><label><input type="radio" name="mode" value="task"><span>任务：完成目标</span></label></span></div>
      <div class="row"><label>端 <select id="surface">${Object.entries(SURFACE).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label>最多步数 <input id="maxSteps" type="number" min="1" max="3000" placeholder="不限"></label>
        <label>最多分钟 <input id="maxMinutes" type="number" min="1" max="120" placeholder="不限"></label></div>
      <div class="row"><label><input type="checkbox" id="writable" ${fa?.on ? '' : 'disabled'}> 可写（会真的发消息、改资料）</label>${fa?.on ? '' : '<span class="faint">需要先开启完全授权</span>'}</div>
      <div class="row"><button class="btn" onclick="submitExplore(true)">先检查（不启动）</button><button class="btn primary" onclick="submitExplore(false)">开始</button></div>
      <div id="msg" class="msg"></div>`)}
    ${card('可信吗', '它会怎么做', `<ul>
      <li>每一步看当前截图和可点元素，由视觉模型决定一个动作；默认<b>只读</b>：发送、删除、改设置、支付、退出登录、邀请分享、改资料都会被拦截。</li>
      <li>点赞、关注、收藏只对测试账号自己的主页和内容做，真实用户的内容一律拦截。</li>
      <li>崩溃、ANR、App 退出、页面崩溃会立即保存${terms('现场包')}；模型报告的问题经${terms('证据复核')}一致才计入。</li>
      <li>默认不限步数；平台硬上限 3000 步 / 120 分钟。结果里列出覆盖了哪些界面、拦截了哪些动作、用了多少次模型。</li>
      <li>探索的发现不是复现结论：可以一键转成 Issue，再由 Issue 主线复现。</li></ul>`, 60)}
  </div>`;
}

async function submitExplore(dryRun) {
  const goal = $('#goal').value.trim();
  if (!goal) return ($('#msg').innerHTML = '<p class="bad">先写一句目标。</p>');
  const num = (id) => ($(id).value ? Number($(id).value) : undefined);
  const r = await api('POST', '/tasks', { explore: goal, mode: document.querySelector('input[name=mode]:checked').value, surface: $('#surface').value, maxSteps: num('#maxSteps'), maxMinutes: num('#maxMinutes'), writable: $('#writable').checked, dryRun });
  if (r.code === 'ACCEPTED') return (location.hash = `#/task/${enc(r.data.id)}`);
  $('#msg').innerHTML = r.code === 'OK' ? `<p class="ok">${esc(r.summary)}</p>` : failMsg(r);
}

async function issueList() {
  const r = await api('GET', '/issues');
  if (!r.data) return ($('#tab').innerHTML = card('', '', failMsg(r)));
  $('#tab').innerHTML = card('要做什么', `Issue <span class="faint">${r.data.length}</span>`, `
    <p class="muted">每个 Issue 先生成草稿（规则 + 模型），草稿里每个子用例是一份计划；点开计划看步骤、影响和审批，再运行。不能生成计划的 Issue 会说明原因和怎样才能执行。</p>
    <table><tr><th>Issue</th><th>类别</th><th>草稿</th><th>计划（点开审核、运行）</th></tr>${r.data
      .map((i) => `<tr><td><b>${esc(i.id)}</b><br><span class="muted">${esc(i.title.slice(0, 90))}</span></td><td>${esc(i.category)}</td>
        <td>${i.draft ? `v${i.draft.version} ${pill(i.draft.status === 'plannable' ? 'good' : 'warn', i.draft.status === 'plannable' ? '可执行' : '无法生成计划')}${i.draft.status !== 'plannable' ? `<br><span class="muted">${esc((i.draft.reason ?? '').slice(0, 80))}</span>` : ''}` : '<span class="faint">无</span>'}<br><button class="btn small" onclick="makeDraft('${esc(i.id)}', this)">${i.draft ? '重新生成' : '生成草稿'}</button></td>
        <td>${i.plans.map((p) => `<a href="#/plan/${enc(p.id)}">${esc(p.id)}</a> <span class="faint">${esc(p.approval)}</span>`).join('<br>') || '<span class="faint">-</span>'}</td></tr>`)
      .join('')}</table>`);
}

async function makeDraft(id, btn) {
  btn.disabled = true;
  btn.textContent = '生成中（可能调用模型）…';
  const r = await api('POST', `/drafts/${enc(id)}`, { env: 'prod' });
  btn.textContent = r.code === 'OK' ? '已生成' : '失败';
  if (r.code !== 'OK') alert(`${r.code}：${r.summary}`);
  newTask();
}

async function syncForm() {
  const envs = ((await api('GET', '/envs')).data ?? []).filter((e) => /@prod$/.test(e.id));
  $('#tab').innerHTML = `<div class="grid two">
    ${card('要做什么', '多端协同：消息在各端是否同步', `
      <p class="muted">选 2–4 个端。每个端用账号池里不同的测试账号，进入允许清单里的同一个群；每轮一个端发一条带标记的消息，其余端都要看到。</p>
      <div class="row" style="flex-direction:column;align-items:flex-start;gap:6px">${envs.map((e) => `<label><input type="checkbox" name="role" value="${esc(e.id)}"> ${esc(SURFACE[surfaceOf(e.id)] ?? e.id)} <span class="faint mono">${esc(e.id)}</span> ${pill(e.state, e.stateText)}</label>`).join('')}</div>
      <div class="row"><label>轮数 <input id="rounds" type="number" min="1" max="1000" placeholder="每端一轮"></label></div>
      <div class="row"><button class="btn" onclick="submitSync(true)">先检查（不启动）</button><button class="btn primary" onclick="submitSync(false)">开始</button></div>
      <div id="msg" class="msg"></div>`)}
    ${card('可信吗', '注意', `<ul><li>所有端的环境<b>一次租齐</b>才开始，任一不可用就都不租，任务会等。</li><li>每轮真的发一条消息（不删除、不撤回）；超过 50 条需要完全授权。</li><li>群必须在允许清单里，否则不发送并报错。</li><li>结果：全部同步 = 已实现；有端没看到 = 未实现，并附每轮每端的截图。</li></ul>`, 60)}
  </div>`;
}

async function submitSync(dryRun) {
  const roles = [...document.querySelectorAll('input[name=role]:checked')].map((x) => x.value);
  if (roles.length < 2) return ($('#msg').innerHTML = '<p class="bad">至少选两个端。</p>');
  const r = await api('POST', '/tasks', { sync: roles.join(','), rounds: $('#rounds').value ? Number($('#rounds').value) : undefined, dryRun });
  if (r.code === 'ACCEPTED') return (location.hash = `#/task/${enc(r.data.id)}`);
  $('#msg').innerHTML = r.code === 'OK' ? `<p class="ok">${esc(r.summary)}</p>` : failMsg(r);
}

// ---------------------------------------------------------------- 任务

async function taskPage(id) {
  await shell('');
  const first = await api('GET', `/tasks/${enc(id)}`);
  if (!first.data) return ($('#view').innerHTML = card('', `任务 ${esc(id)}`, failMsg(first)));
  const steps = await api('GET', `/tasks/${enc(id)}/steps`);
  drawTask(first.data, steps.data);
  if (!first.data.finishedAt) {
    stream = new EventSource(`/api/v1/tasks/${enc(id)}/stream`);
    stream.addEventListener('task', (ev) => {
      const { task, steps: s } = JSON.parse(ev.data);
      if (task) drawTask(task, s);
      if (task?.finishedAt) stream?.close();
    });
    // SSE unavailable (proxy, old browser): poll instead.
    stream.onerror = () => {
      stream?.close();
      stream = undefined;
      if (!timers.length) every(2000, async () => drawTask((await api('GET', `/tasks/${enc(id)}`)).data, (await api('GET', `/tasks/${enc(id)}/steps`)).data));
    };
  }
}

function drawTask(t, s) {
  if (!t) return;
  const p = t.progress ?? {};
  const what = t.explore
    ? `<p class="lead">${t.explore.mode === 'explore' ? '探索' : '任务'}：「${esc(t.explore.goal)}」</p><p class="muted">${t.explore.writable ? '<b class="warn">可写</b>' : '只读'} · ${esc(KIND.explore)}</p>`
    : t.planId.startsWith('sync:')
      ? `<p class="lead">多端同步：${esc(t.planId.slice(5).split('+').map((x) => SURFACE[x] ?? x).join(' + '))}</p>`
      : `<p class="lead">计划 <a href="#/plan/${enc(t.planId)}">${esc(t.planId)}</a></p>`;
  const now = t.finishedAt
    ? `<p>${pill(t.state, t.stateText)} 结束于 ${time(t.finishedAt)}${t.endedBy ? `，方式：${esc(t.endedBy)}` : ''}${t.endedAt ? `，停在 ${esc(t.endedAt)}` : ''}</p><p class="lead">${esc(t.outcome?.summary ?? '')}</p>`
    : `<p>${pill(t.state, t.stateText)} ${esc(p.phaseText ?? '')}${p.round !== undefined ? ` · 第 ${p.round} 轮` : ''}${p.step !== undefined ? ` · 第 ${p.step} 步` : ''}</p>${p.summary ? `<p class="mono">${esc(p.summary)}</p>` : ''}<p class="faint">更新于 ${time(p.at)}${t.cancelRequested ? ' · 已请求取消' : ''}</p>`;
  const stepCards = (s?.steps ?? []).slice().reverse().slice(0, 60).map((x) => `<div class="step ${x.blocked ? 'blocked' : ''} ${x.finding ? 'finding' : ''}">
      ${x.thumb ? `<a href="${esc(x.thumb)}" target="_blank"><img loading="lazy" src="${esc(x.thumb)}" alt="第 ${x.step} 步截图"></a>` : ''}
      <div class="step__body"><div><b>#${x.step}</b> <span class="faint">${hm(x.at)}</span> ${x.blocked ? pill('warn', '已拦截') : ''}${x.finding ? pill('bad', '发现') : ''}</div>
      <div class="step__act">${esc(x.action)}</div><div class="step__why">${esc(x.thought ?? '')}</div>${x.blocked ? `<div class="warn">${esc(x.blocked)}</div>` : ''}${x.finding ? `<div class="bad">${esc(x.finding.slice(0, 160))}</div>` : ''}</div></div>`);
  $('#view').innerHTML = `
    <div class="page-head"><h1>任务 <span class="mono" style="font-size:22px">${esc(t.id)}</span><small>${esc(KIND[t.explore ? 'explore' : t.planId.startsWith('sync:') ? 'sync' : 'issue'])} · ${esc([t.envId, ...(t.envIds ?? [])].join(' + '))} · 创建于 ${time(t.createdAt)}</small></h1>
      <div class="row">${t.finishedAt ? `<a class="btn primary" href="#/result/${enc(t.id)}">查看结果 →</a>` : `<button class="btn danger" onclick="cancelTask('${esc(t.id)}')">取消</button>`}</div></div>
    <div class="grid two">
      ${card('要做什么', '', what)}
      ${card('正在做什么', '', now + (t.partial ? `<p class="bad">部分结果：${terms('有效尝试')} ${t.partial.valid}，命中 ${t.partial.hits}（${esc(t.partial.note)}）</p>` : ''), 40)}
    </div>
    ${stepCards.length ? card('正在做什么', `步骤 <span class="faint">${s.steps.length}</span>`, `<p class="muted">每一步的截图、动作和模型的思路（最新在前${s.steps.length > 60 ? '，只显示最近 60 步' : ''}）。</p><div class="steps">${stepCards.join('')}</div>`, 80) : s?.latest ? card('正在做什么', '最新截图', `<img class="screen" src="${esc(s.latest)}?t=${Date.now()}" alt="最新截图">`, 80) : ''}
    <div class="grid two">
      ${card('可信吗', '副作用记录', `<table><tr><th>进入会话</th><td>${t.ledger.entered.map(esc).join('、') || '-'}</td></tr><tr><th>键入过的会话</th><td>${t.ledger.typedInto.map(esc).join('、') || '-'}</td></tr><tr><th>发送消息</th><td>${t.ledger.sent} 条（不删除、不撤回）</td></tr><tr><th>手机设置</th><td>${t.ledger.settings.map(esc).join('；') || '-'}</td></tr></table>`, 120)}
      ${card('', '时间线', `<ul class="timeline">${t.timeline.map((e) => `<li><time>${hm(e.at)}</time><span>${e.state ? `状态 → ${esc(e.state)}` : `阶段 → ${esc(e.phase)}`}</span></li>`).join('')}</ul>`, 160)}
    </div>`;
}

async function cancelTask(id) {
  if (!confirm('取消任务：在下一个步骤边界停下，收尾并恢复环境；60 秒内没停会被强制结束。确定？')) return;
  const r = await api('POST', `/tasks/${enc(id)}/cancel`);
  if (r.code !== 'OK') alert(r.summary);
}

// ---------------------------------------------------------------- 结果

async function resultPage(id) {
  await shell('');
  const r = await api('GET', `/results/${enc(id)}`);
  if (r.code === 'STILL_RUNNING') return ($('#view').innerHTML = card('', '任务还没结束', `<p>${esc(r.summary)}</p><p><a href="#/task/${enc(id)}">看进度 →</a></p>`));
  if (!r.data || r.data.kind !== 'ResultView') return ($('#view').innerHTML = card('', `结果 ${esc(id)}`, failMsg(r)));
  const v = r.data;
  const good = ['IMPLEMENTED', 'NOT_REPRODUCED', 'EXPLORE_DONE'].includes(v.code);
  const hit = ['REPRODUCED', 'EXPLORE_FINDINGS', 'NOT_IMPLEMENTED', 'PARTIAL'].includes(v.code);
  const parts = [];
  parts.push(`<div class="page-head"><h1>结果<small>任务 <a class="mono" href="#/task/${enc(v.taskId)}">${esc(v.taskId)}</a></small></h1></div>`);
  parts.push(card('结果', '', `<p class="lead">${terms(v.sentence)}</p><p>${pill(good ? 'good' : hit ? 'bad' : 'warn', `${v.code} · ${v.status}`)} ${v.complete ? '' : pill('warn', '不完整，不给结论')}</p>${!v.complete && v.ended ? `<p class="muted">结束方式：${esc(v.ended.by ?? '')}${v.ended.at ? `，${esc(v.ended.at)}` : ''}</p>` : ''}`));
  if (v.series) parts.push(card('结果', '系列', `<div class="stats">${stat(v.series.runs, '次运行')}${stat(v.series.reachedLoop, '进入循环')}${stat(`${v.series.reproducedRuns}/${v.series.validRuns}`, '复现的次数')}${stat(v.series.valid, '有效尝试')}${stat(v.series.hits, '命中')}</div>`, 40));
  for (const x of v.runs) parts.push(runCard(x));
  if (v.explore) parts.push(exploreCards(v));
  if (v.sync) parts.push(syncCard(v));
  const inc = v.evidence.incidents ?? [];
  parts.push(card('可信吗', '证据', `<table><tr><th>报告</th><td>${v.evidence.report ? fileLink(v.evidence.report, 'report.md') : '-'}</td></tr><tr><th>${terms('现场包')}</th><td>${inc.map((i) => fileLink(`${i}/index.html`, i.split(/[\\/]/).pop())).join('<br>') || '无'}</td></tr><tr><th>运行目录</th><td class="mono">${esc(v.evidence.runDir ?? '-')}</td></tr></table>`, 200));
  parts.push(card('下一步', '', nextSteps(v), 240));
  $('#view').innerHTML = parts.join('');
}

const stat = (n, label) => `<div class="stat"><b>${esc(n)}</b><span>${esc(label)}</span></div>`;

function runCard(x) {
  return card('结果', `${esc(x.planId)}：${esc(x.conclusion)}`, `
    <p>${terms(x.sentence)}</p>
    ${x.attempts ? `<div class="stats">${stat(x.attempts.valid, '有效尝试')}${stat(x.attempts.hits, '命中')}${stat(x.attempts.drift, '偏离')}</div><p class="muted">${terms(x.attempts.text)}</p>` : ''}
    <h3>依据</h3><ol>${x.basis.map((b) => `<li>${terms(b)}</li>`).join('')}</ol>
    <h3>可信吗</h3><ul><li>${terms('证据复核')}：${esc(x.flags.evidenceReview)}</li><li>${terms(x.flags.substituted)}</li><li>${esc(x.flags.selfCheck)}</li></ul>
    ${x.failure ? `<div class="sunk"><p class="bad">失败归类：<b>${esc(x.failure.kindText)}</b>（${esc(x.failure.rule)}）— ${esc(x.failure.reason)}</p><p><b>下一步：</b>${esc(x.failure.suggestion)}</p></div>` : ''}
    <p class="faint">耗时 ${esc(x.durationSec ?? '-')} 秒 · 运行标记 ${esc(x.runTag ?? '-')}</p>`, 80);
}

function exploreCards(v) {
  const e = v.explore;
  const fs = e.findings.map((f) => `<div class="finding-card ${f.counted ? '' : 'uncounted'}">
      <div class="row">${pill(f.counted ? 'bad' : 'offline', f.counted ? `发现 #${f.n}` : `#${f.n} 未计入`)} <span class="muted">${f.source === 'hard' ? '硬异常' : '模型报告'} · ${esc(f.kind)}${f.review ? ` · ${terms('证据复核')} ${esc(f.review)}` : ''}</span></div>
      <p>${esc(f.description)}</p>
      <div class="row">${fileLink(`${f.incident}/index.html`, '打开现场包')}<button class="btn small" onclick="toIssue('${esc(v.taskId)}', ${f.n}, this)">转成 Issue</button><span class="muted" id="iss-${f.n}"></span></div></div>`);
  return card('结果', `${e.mode === 'explore' ? '探索' : '任务'}：「${esc(e.goal)}」`, `
    <p>${esc(e.summary || '-')}</p>
    <div class="stats">${stat(e.findings.filter((f) => f.counted).length, '发现（计入）')}${stat(e.coverage.screens, '覆盖界面')}${stat(e.coverage.actions, '执行的动作')}${stat(e.blocked, '拦截的动作')}${stat(e.usage.steps, '步')}${stat(e.usage.modelCalls, '模型调用')}${stat(`${Math.round(e.usage.seconds / 60)} 分`, '用时')}</div>
    <h3>发现</h3>${fs.join('') || '<p class="empty">没有发现。</p>'}
    <p class="muted">探索的发现不是复现结论：转成 Issue 后由 Issue 主线（高确定性的计划）复现，给出带分母的结论。</p>`, 80);
}

async function toIssue(taskId, n, btn) {
  btn.disabled = true;
  const r = await api('POST', `/explore/${enc(taskId)}/issue`, { n });
  const out = $(`#iss-${n}`);
  if (r.code !== 'OK') return (out.innerHTML = `<span class="bad">${esc(r.summary)}</span>`);
  out.innerHTML = `Issue <b>${esc(r.data.issue)}</b> 已生成 <button class="btn small" onclick="draftThen('${esc(r.data.issue)}', this)">生成计划</button>`;
}

async function draftThen(issue, btn) {
  btn.disabled = true;
  btn.textContent = '生成中…';
  const r = await api('POST', `/drafts/${enc(issue)}`, { env: 'prod' });
  btn.outerHTML = r.code === 'OK' && r.data.plans?.length ? r.data.plans.map((p) => `<a href="#/plan/${enc(p)}">${esc(p)}</a>`).join(' ') : `<span class="bad">${esc(r.summary)}</span>`;
}

function syncCard(v) {
  const s = v.sync;
  return card('结果', '多端同步', `
    <div class="stats">${stat(s.rounds, '轮')}${stat(s.deliveries.seen, '可见')}${stat(s.deliveries.missed, '未出现')}${stat(s.deliveries.unverified, '未能核实')}</div>
    <table><tr><th>端</th><th>设备 / 主机</th><th>账号</th><th>会话</th><th>就绪</th></tr>${s.roles.map((r) => `<tr><td>${esc(SURFACE[r.surface] ?? r.surface)}</td><td class="mono">${esc(r.endpoint)}</td><td>${esc(r.account)}</td><td>${esc((r.conversation ?? '-').slice(0, 40))}</td><td>${r.ready ? '<span class="ok">✓</span>' : `<span class="bad">✗ ${esc(r.error ?? '')}</span>`}</td></tr>`).join('')}</table>
    <p class="muted">每轮每端的截图在报告里。</p>`, 80);
}

function nextSteps(v) {
  const out = [];
  if (!v.complete) out.push('任务没有完整跑完（取消 / 中断 / 环境问题），不给结论：处理环境后重新运行。');
  if (v.code === 'REPRODUCED') out.push('打开现场包看录像和日志；把现场包链接附到 Issue 上。');
  if (v.code === 'NOT_REPRODUCED') out.push('未复现不等于已修复：可加轮数或换端再跑，或补充复现条件。');
  if (v.explore?.findings.some((f) => f.counted)) out.push('把发现转成 Issue，再用 Issue 主线复现（给出带分母的结论）。');
  if (v.explore && !v.explore.findings.length) out.push('没有发现：看覆盖的界面数是否够；可换一句目标或放宽上限再探索。');
  if (v.sync && v.sync.deliveries.missed) out.push('有端没看到消息：对照报告里该轮该端的截图确认，再决定是否提 Issue。');
  for (const r of v.runs) if (r.failure) out.push(`${r.failure.kindText}失败：${r.failure.suggestion}`);
  if (!out.length) out.push('无需处理。');
  return `<ul>${out.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
}

// ---------------------------------------------------------------- 计划

const STAGE = { setup: '开始', prepare: '准备', warmup: '预热', loop: '每轮', check: '每轮检查', after: '检查后', epilogue: '结束前', acceptance: '验收' };
const CAT = { default: '默认允许（只操作被测软件）', sensitive: '敏感计划：需要你按按钮同意', refused: '触及硬约束：拒绝执行' };

async function planPage(id) {
  await shell('');
  const series = hashQuery().get('series') ?? '';
  const [r, m] = await Promise.all([api('GET', `/plans/${enc(id)}${series ? `?series=${enc(series)}` : ''}`), api('GET', `/plans/${enc(id)}/marks`)]);
  if (!r.data) return ($('#view').innerHTML = card('', `计划 ${esc(id)}`, failMsg(r)));
  const v = r.data;
  const ap = v.approval;
  const marks = m.data?.shot ? (m.data.marks ?? []) : [];
  const markOf = new Map(marks.map((x) => [x.n, x]));
  const shot = m.data?.shot && m.data.size
    ? `<div class="shot"><img src="${esc(m.data.shot)}" alt="最近一次运行的截图">${marks.map((x) => `<div class="mark" style="left:${(x.box[0] / m.data.size.width) * 100}%;top:${(x.box[1] / m.data.size.height) * 100}%;width:${(x.box[2] / m.data.size.width) * 100}%;height:${(x.box[3] / m.data.size.height) * 100}%" title="${esc(x.text)}"><span>${x.n}</span></div>`).join('')}</div><p class="faint">截图来自最近一次运行（${time(m.data.shotAt)}），元素框来自 SKILL 缓存 ${esc(m.data.cache ?? '')}。</p>`
    : `<p class="empty">${esc(m.summary ?? '还没有运行截图')}：运行一次后，步骤会标在截图上。</p>`;
  $('#view').innerHTML = `
    <div class="page-head"><h1>计划 <span class="mono" style="font-size:22px">${esc(v.id)}</span><small>${esc(SURFACE[v.surface] ?? v.surface)} · ${esc(typeof v.env === 'object' ? v.env?.id : v.env)} · 哈希 <span class="mono">${esc(v.hash)}</span>${v.substitution ? ` · ${terms('替代执行')} ${esc(v.substitution.from)} → ${esc(v.substitution.to)}` : ''}</small></h1>
      <div class="row"><button class="btn primary" onclick="runPlan('${esc(v.id)}')">运行</button></div></div>
    <div id="msg"></div>
    ${card('要做什么', '', `<p class="lead">${esc(v.purpose)}</p><p class="muted">${esc(v.title)}</p>`)}
    <div class="grid two">
      ${card('要做什么', '步骤', `<ol class="plan-steps">${v.steps.map((s, i) => `<li><span class="stage">${STAGE[s.stage] ?? s.stage}</span>${markOf.has(i + 1) ? `<b class="bad">[${i + 1}]</b> ` : ''}${terms(s.text)}${s.byModel ? ' <b>（运行时由模型选）</b>' : ''}</li>`).join('')}</ol>
        <h3>怎样算复现</h3><ul>${v.verdict.map((x) => `<li>${terms(x)}</li>`).join('')}</ul>`, 40)}
      ${card('要做什么', '步骤落在屏幕哪里', shot, 80)}
    </div>
    <div class="grid two">
      ${card('会影响什么', '', `<table>
        <tr><th>最多发送消息</th><td><b>${v.impact.messagesMax} 条</b>（上界）</td></tr>
        <tr><th>发到哪个会话</th><td>${v.impact.messagesMax ? v.impact.conversations.map(esc).join('<br>') : `<b>不发送</b>${v.impact.conversations.length ? `（只在「${v.impact.conversations.map(esc).join('、')}」里操作）` : ''}`}</td></tr>
        <tr><th>构造的数据</th><td>${v.impact.data.map(esc).join('<br>') || '无'}</td></tr>
        <tr><th>环境配置项</th><td>${v.impact.envConfig.map(esc).join('<br>') || '无'}</td></tr>
        <tr><th>额外修改的手机设置</th><td>${v.impact.extraSettings.map(esc).join('<br>') || '<b>无</b>'}</td></tr></table>`, 120)}
      ${card('可信吗', '哪些地方不确定', `<ul>${v.uncertain.map((x) => `<li>${terms(x)}</li>`).join('') || '<li>无</li>'}</ul><h3>模型调用</h3><ul>${v.modelCalls.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><h3>大约多久</h3><p><b>${esc(v.estimate.text)}</b></p>`, 160)}
    </div>
    ${card('下一步', '审批', `
      <p>类别：<b>${CAT[ap.category]}</b> — ${ap.reasons.map(esc).join('；')}</p>
      <p>状态：${ap.state === 'approved' ? `<span class="ok">已批准</span>（${esc(ap.by)}，已用 ${esc(ap.runs)}）` : ap.state === 'rejected' ? `<span class="bad">已驳回</span>（${esc(ap.by)}：${esc(ap.note)}）` : '待审核'}</p>
      ${ap.category !== 'refused' ? `<div class="row"><label>运行次数 <input id="runs" type="number" min="1" value="1"></label><label>系列次数 <input id="series" type="number" min="1" placeholder="可空" value="${esc(series)}"></label><button class="btn" onclick="approvePlan('${esc(v.id)}', '${esc(v.hash)}')">同意</button></div>` : ''}
      <div class="row"><textarea id="note" placeholder="驳回意见（必填）" style="min-height:52px"></textarea></div><div class="row"><button class="btn danger" onclick="rejectPlan('${esc(v.id)}')">驳回</button></div>`, 200)}`;
}

async function approvePlan(id, hash) {
  const series = $('#series').value;
  const r = await api('POST', `/plans/${enc(id)}/approve`, { hash, runs: Number($('#runs').value), series: series ? Number(series) : undefined });
  alert(r.summary);
  route();
}
async function rejectPlan(id) {
  const note = $('#note').value.trim();
  if (!note) return alert('驳回必须填写意见');
  const r = await api('POST', `/plans/${enc(id)}/reject`, { note });
  alert(r.summary);
  route();
}
async function runPlan(id) {
  const series = $('#series')?.value;
  const r = await api('POST', '/tasks', { planId: id, series: series ? Number(series) : undefined });
  if (r.code === 'ACCEPTED') return (location.hash = `#/task/${enc(r.data.id)}`);
  $('#msg').innerHTML = card('', '没有启动', failMsg(r));
}

// ---------------------------------------------------------------- 环境

async function envPage(id) {
  await shell('');
  const draw = async () => {
    const r = await api('GET', `/envs/${enc(id)}`);
    if (!r.data) return ($('#view').innerHTML = card('', `环境 ${esc(id)}`, failMsg(r)));
    const e = r.data;
    const locked = e.state === 'unfit' && /锁屏/.test(e.reason ?? '');
    $('#view').innerHTML = `
      <div class="page-head"><h1>${esc(SURFACE[surfaceOf(e.id)] ?? e.id)}<small class="mono">${esc(e.id)}</small></h1>
        <div class="row">${e.state !== 'leased' ? `<button class="btn" onclick="recheck('${esc(e.id)}', this)">重新检查</button>` : ''}</div></div>
      <div class="grid two">
        ${card('正在做什么', '', `<p>${pill(e.state, e.stateText)} 自 ${time(e.since)}</p>${e.reason ? `<p>原因：${terms(e.reason)}</p>` : ''}${locked ? '<p class="lead bad">手机已锁屏：请在手机上输入 PIN 解锁，然后点「重新检查」。</p>' : ''}${e.suggestion ? `<p><b>下一步：</b>${esc(e.suggestion)}</p>` : ''}${e.lease ? `<p>租约：任务 <a href="#/task/${enc(e.lease.taskId)}">${esc(e.lease.taskId)}</a>（pid ${esc(e.lease.pid ?? '-')}，自 ${time(e.lease.at)}）</p>` : ''}<p class="faint">设备 ${esc(e.device)} · 账号 ${esc(e.account ?? '-')} · App ${esc(e.appVersion ?? '-')}</p>`)}
        ${card('可信吗', `上次检查 <span class="faint">${time(e.check?.at)}</span>`, `<table><tr><th>项</th><th>结果</th><th>说明</th></tr>${(e.check?.items ?? []).map((i) => `<tr><td>${esc(i.id)}</td><td>${i.ok ? '<span class="ok">通过</span>' : '<span class="bad">未通过</span>'}</td><td>${esc(i.detail)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">还没检查过</td></tr>'}</table>${e.check?.did?.length ? `<p class="muted">检查时做了：${e.check.did.map(esc).join('；')}</p>` : ''}`, 40)}
      </div>
      ${card('下一步', '环境配置项（为可测而做的系统改动，注册时同意一次）', configTable(e), 80)}`;
  };
  await draw();
  every(5000, draw);
}

function configTable(e) {
  return `<table><tr><th>改什么</th><th>为什么</th><th>怎么还原</th><th>同意</th></tr>${e.configItems.map((c) => `<tr><td>${esc(c.what)}</td><td>${esc(c.why)}</td><td>${esc(c.restore)}</td><td>${c.consented ? `<span class="ok">已同意</span>（${esc(c.by)}）` : `<button class="btn small primary" onclick="consent('${esc(e.id)}', '${esc(c.id)}')">同意</button>`}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">无</td></tr>'}</table>`;
}

async function consent(env, item) {
  const r = await api('POST', `/envs/${enc(env)}/consent`, { item });
  if (r.code !== 'OK') alert(r.summary);
  route();
}

// ---------------------------------------------------------------- 审批

async function approvals() {
  await shell('approvals');
  const [fa, envs, issues, audit] = await Promise.all([api('GET', '/full-access'), api('GET', '/envs'), api('GET', '/issues'), api('GET', '/audit?limit=30')]);
  const pending = (envs.data ?? []).filter((e) => e.configItems.some((c) => !c.consented));
  const plans = (issues.data ?? []).flatMap((i) => i.plans.map((p) => ({ ...p, issue: i.id })));
  $('#view').innerHTML = `
    <div class="page-head"><h1>审批<small>只有人在这里能做的事：完全授权、环境配置项、敏感计划。</small></h1></div>
    ${card('要做什么', '完全授权', fa.data?.on
      ? `<p>${pill('bad', '已开启')} ${esc(fa.data.by)}${fa.data.at ? `，${time(fa.data.at)}` : ''}</p><p>所有计划（含敏感计划）自动批准，可写探索可用；硬约束仍然拒绝。</p><button class="btn" onclick="toggleFA(false)">关闭完全授权</button>`
      : `<p>${pill('good', '关闭')} 敏感计划需要在计划页按「同意」。</p><button class="btn danger" onclick="toggleFA(true)">开启完全授权…</button>`)}
    ${card('下一步', `待同意的环境配置项 <span class="faint">${pending.length}</span>`, pending.length ? pending.map((e) => `<h3><a href="#/env/${enc(e.id)}">${esc(e.id)}</a></h3>${configTable(e)}`).join('') : '<p class="empty">没有待同意的配置项。</p>', 40)}
    ${card('下一步', `计划与审批状态 <span class="faint">${plans.length}</span>`, plans.length ? `<table><tr><th>计划</th><th>审批</th></tr>${plans.map((p) => `<tr><td><a href="#/plan/${enc(p.id)}">${esc(p.id)}</a></td><td>${esc(p.approval)}</td></tr>`).join('')}</table>` : '<p class="empty">还没有计划。</p>', 80)}
    ${card('可信吗', '最近的审计记录', `<table><tr><th>时间</th><th>谁</th><th>做了什么</th><th>对象</th></tr>${(audit.data ?? []).slice().reverse().map((a) => `<tr><td class="mono faint">${time(a.at)}</td><td>${esc(a.by)}</td><td>${esc(a.action)}${a.after ? ` → ${esc(a.after)}` : ''}</td><td class="mono">${esc(String(a.object ?? '').slice(0, 60))}</td></tr>`).join('')}</table>`, 120)}`;
}

route();
