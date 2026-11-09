// Side-panel chat: conversation view, model picker, attachments and slash commands.
// Talks to background.js over a "chat" port; background relays to Hermes.
const $ = (id) => document.getElementById(id);
const log = $('log'), input = $('input'), send = $('send'), menu = $('menu'), modelSel = $('model'), atts = $('atts');
const MAX_LOG = 200, MAX_FILE = 25 * 1024 * 1024, MAX_IMAGE_EDGE = 1600;

let entries = [];          // persisted transcript: {role, text}
let running = null;        // chatId of the turn in progress
let liveText = null;       // element receiving streamed assistant text
let working = null;        // "working…" indicator
let agentName = 'Hermes';
let showSteps = false;     // tool calls as lines in the chat (Settings); off = only the live status line
let attachments = [];      // {kind: 'image'|'file', name, dataUrl?, mime?, data?}
let skills = [];
let menuItems = [], menuSel = 0;
let connected = false;

const port = chrome.runtime.connect({ name: 'chat' });

const COMMANDS = [
  ['new', 'Start a new chat'],
  ['model', 'Switch model, e.g. /model sonnet (or /model default)'],
  ['models', 'List the models you can use'],
  ['stop', 'Stop the current task'],
  ['screenshot', 'Attach a screenshot of this tab'],
  ['tab', 'Share this tab with the agent: /tab on or /tab off'],
  ['clear', 'Clear this panel (the conversation continues)'],
  ['help', 'Show commands'],
];

// ------------------------------------------------------------ rendering
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function md(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\n/g, '<br>');
}

const TOOL_LABELS = {
  browser_status: '🔌 Checked the browser', tabs_list: '🗂 Listed tabs', tab_open: '🗂 Opened', tab_close: '🗂 Closed tab',
  navigate: '🧭 Went to', read_page: '📄 Read the page', find: '🔎 Looked for', get_text: '📄 Read the text',
  screenshot: '📸 Took a screenshot', click: '🖱 Clicked', type: '⌨️ Typed', press_key: '⌨️ Pressed', scroll: '↕️ Scrolled',
  wait: '⏱ Waited', handoff: '✋ Needs you', eval_js: '🧪 Ran a script', tool_search: '🔧 Loaded tools',
  status: '🔌 Checked the browser', tabs: '🗂 Listed tabs', open: '🗂 Opened', close: '🗂 Closed tab', text: '📄 Read the text',
  key: '⌨️ Pressed', eval: '🧪 Ran a script',
};
function toolLine(name, args) {
  const short = name.replace(/^mcp__hermes_chrome__/, '').replace(/^chrome_/, '');
  let a = {};
  try { a = JSON.parse(args || '{}'); } catch {}
  const detail = a.url || a.query || (a.text && `"${a.text.length > 40 ? a.text.slice(0, 39) + '…' : a.text}"`) || a.key || a.message || a.ref || a.direction || '';
  return `${TOOL_LABELS[short] || `🔧 ${short}`}${detail ? ` ${detail}` : ''}`;
}

function add(role, text) {
  log.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (role === 'assistant') el.innerHTML = md(text);
  else if (role === 'tool') el.innerHTML = `<span>${esc(text)}</span>`;
  else if (role === 'user') {
    const [body, att] = text.split('\n\u0000');
    el.textContent = body;
    if (att) el.insertAdjacentHTML('beforeend', `<span class="att">${esc(att)}</span>`);
  } else el.textContent = text;
  log.insertBefore(el, working && working.isConnected ? working : null);
  log.scrollTop = log.scrollHeight;
  return el;
}
function record(role, text) {
  entries.push({ role, text });
  if (entries.length > MAX_LOG) entries = entries.slice(-MAX_LOG);
  chrome.storage.local.set({ chatLog: entries });
}
const note = (text) => { add('note', text); record('note', text); };

let paired = true;
const AVATAR = chrome.runtime.getURL('icons/avatar.png');
const SUGGESTIONS = ['Summarise this page', 'Fill in this form for me', 'Find the cheapest option here'];
function emptyState() {
  const mark = `<div class="mark"><img src="${AVATAR}" alt=""></div>`;
  if (!paired) {
    log.innerHTML = `<div class="empty">${mark}<h2>Pair this browser</h2><p>Send /chrome pair to your agent, then right-click the Hermes Chrome icon, open Settings and paste the code.</p></div>`;
    return;
  }
  log.innerHTML = `<div class="empty">${mark}<h2>Ask ${esc(agentName)} to work in this tab</h2>
    <p>Type / for commands and skills, @ to bring in one of your tabs. Drop files or paste images to attach them.</p>
    <div class="suggest">${SUGGESTIONS.map((t) => `<button type="button">${esc(t)}</button>`).join('')}</div></div>`;
  for (const b of log.querySelectorAll('.suggest button')) b.onclick = () => { input.value = b.textContent; autosize(); refreshSend(); input.focus(); };
}

// Send button: dimmed until there is something to send; a stop square while the agent works.
function refreshSend() { send.classList.toggle('idle', !running && !input.value.trim() && !attachments.length); }

function setRunning(chatId) {
  running = chatId;
  $('sendLabel').textContent = chatId ? 'Stop' : 'Send';
  send.title = chatId ? 'Stop' : 'Send';
  send.classList.toggle('stop', !!chatId);
  refreshSend();
  if (chatId && !working) {
    working = document.createElement('div');
    working.className = 'working';
    working.innerHTML = `<span class="ring"><img src="${AVATAR}" alt=""></span><span class="now">${esc(agentName)} is working…</span>`;
    log.appendChild(working);
    log.scrollTop = log.scrollHeight;
  }
  if (!chatId) { working?.remove(); working = null; }
}

// ------------------------------------------------------------ views: Chat | Activity | Teach
const composerEl = document.getElementById('composer');
function showView(name) {
  for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-selected', String(b.dataset.view === name));
  for (const v of ['log', 'activity', 'teach']) $(v).hidden = v !== name;
  composerEl.hidden = name !== 'log';
  if (name === 'activity') renderActivity();
  if (name === 'teach') renderTeach();
}
for (const b of document.querySelectorAll('nav button')) b.onclick = () => showView(b.dataset.view);

// ------------------------------------------------------------ pause / resume
let hudNow = {};
function applyHud(h) {
  hudNow = h;
  const btn = $('pauseBtn');
  btn.hidden = !(h.active || h.paused) || h.recording;
  btn.textContent = h.paused ? '▶ Resume' : '⏸ Pause';
  btn.classList.toggle('paused', !!h.paused);
}
$('pauseBtn').onclick = () => port.postMessage({ type: hudNow.paused ? 'resume' : 'pause' });

// ------------------------------------------------------------ activity timeline
const lightbox = $('lightbox');
lightbox.onclick = () => { lightbox.hidden = true; };
async function renderActivity() {
  const { activity = [] } = await chrome.storage.local.get('activity');
  const view = $('activity');
  if (!activity.length) { view.innerHTML = `<div class="empty">Every step ${esc(agentName)} takes in the browser shows up here, with a snapshot.</div>`; return; }
  const runs = new Map();
  for (const a of [...activity].reverse()) { if (!runs.has(a.run)) runs.set(a.run, []); runs.get(a.run).push(a); }
  view.innerHTML = '';
  for (const [run, items] of runs) {
    view.insertAdjacentHTML('beforeend', `<div class="runhead">${new Date(run || items.at(-1).t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${items.length} steps</div>`);
    for (const a of items) {
      const row = document.createElement('div');
      row.className = 'act';
      row.innerHTML = `${a.thumb ? `<img src="${a.thumb}" alt="">` : '<div class="ph">·</div>'}<div><b>${esc(a.label)}</b><small>${new Date(a.t).toLocaleTimeString([], { timeStyle: 'short' })} · ${esc(a.url ? new URL(a.url).host : '')}</small></div>`;
      row.querySelector('img')?.addEventListener('click', () => { lightbox.querySelector('img').src = a.thumb; lightbox.hidden = false; });
      view.appendChild(row);
    }
  }
  view.insertAdjacentHTML('beforeend', '<button class="quietbtn" id="clearAct" type="button">Clear timeline</button>');
  $('clearAct').onclick = async () => { await chrome.storage.local.set({ activity: [] }); renderActivity(); };
}
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'local') return;
  if (c.activity && !$('activity').hidden) renderActivity();
  if (c.showSteps) showSteps = !!c.showSteps.newValue; // applies from the next step; no need to reopen the panel
});

// ------------------------------------------------------------ teach mode
let teach = { state: 'idle', steps: [] }; // idle | recording | review | saved
const hostOf = (u) => { try { return new URL(u).host; } catch { return u || ''; } };
function stepText(s) {
  const n = s.target?.name || s.target?.placeholder || s.target?.nameAttr || s.target?.tag || 'element';
  return { open: `Open ${hostOf(s.url)}`, navigate: `Go to ${hostOf(s.url)}`, click: `Click "${n}"`,
    type: s.secret ? `Type a hidden value into "${n}"` : `Type "${String(s.value).slice(0, 40)}" into "${n}"`,
    select: `Choose "${s.label || s.value}" in "${n}"`, key: `Press ${s.key}` }[s.action] || s.action;
}
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const varName = (s) => slug(s.target?.nameAttr || s.target?.name || s.target?.placeholder || 'value').replace(/-/g, '_') || 'value';

function renderTeach() {
  const v = $('teach');
  if (teach.state === 'idle') {
    v.innerHTML = `<div class="card"><b>Teach ${esc(agentName)} a task</b>
      <p>Open the page where the task starts, press Record, and do the task once. Every click, field and choice is captured. Save it as a skill and ${esc(agentName)} can repeat it any time, from Telegram or on a schedule.</p>
      <p>Passwords are never stored: they become blanks the agent asks for.</p>
      <button class="big" id="recStart" type="button">⏺ Start recording</button><span class="error" id="recErr"></span></div>
      <div class="runhead">Saved tasks</div><div id="savedList"><p class="note">Loading…</p></div>`;
    $('recStart').onclick = () => port.postMessage({ type: 'rec_start' });
    renderSaved();
    port.postMessage({ type: 'list_recordings' });
  } else if (teach.state === 'recording') {
    v.innerHTML = `<div class="card"><b><span class="rec-dot"></span>Recording in this tab</b><p>Do the task as usual. Steps appear below.</p>
      <ol class="steps">${teach.steps.map((s) => `<li><span>${esc(stepText(s))}</span><span></span></li>`).join('')}</ol>
      <button class="big stop" id="recStop" type="button">⏹ Stop recording</button></div>`;
    $('recStop').onclick = () => port.postMessage({ type: 'rec_stop' });
  } else if (teach.state === 'review') {
    v.innerHTML = `<div class="card"><b>Review and save</b>
      <label class="field">Name<input id="skName" placeholder="e.g. meta-ads-weekly-export" spellcheck="false"></label>
      <label class="field">What it does<input id="skDesc" placeholder="e.g. Export last week's Meta Ads report as CSV"></label>
      <ol class="steps">${teach.steps.map((s, i) => `<li><span>${esc(stepText(s))}</span><button class="del" data-i="${i}" type="button" title="Remove step">×</button>
        ${s.action === 'type' && !s.secret ? `<label class="var"><input type="checkbox" data-var="${i}"${String(s.value).startsWith('{{') ? ' checked' : ''}> Ask for this each time</label>` : ''}</li>`).join('')}</ol>
      <div class="row"><button class="big" id="skSave" type="button">Save as skill</button><button class="quietbtn" id="skDiscard" type="button">Discard</button></div>
      <span class="error" id="skErr"></span></div>`;
    v.querySelectorAll('.del').forEach((b) => (b.onclick = () => { teach.steps.splice(Number(b.dataset.i), 1); renderTeach(); }));
    v.querySelectorAll('[data-var]').forEach((c) => (c.onchange = () => {
      const s = teach.steps[Number(c.dataset.var)];
      if (c.checked) { s.example = s.value; s.value = `{{${varName(s)}}}`; } else { s.value = s.example ?? ''; }
    }));
    $('skDiscard').onclick = () => { teach = { state: 'idle', steps: [] }; renderTeach(); };
    $('skSave').onclick = () => {
      const name = slug($('skName').value);
      if (!name) { $('skErr').textContent = 'Give it a short name.'; return; }
      $('skSave').disabled = true;
      port.postMessage({ type: 'rec_save', name, description: $('skDesc').value.trim() || `Recorded browser task: ${name}`, steps: teach.steps });
    };
  } else if (teach.state === 'saved') {
    v.innerHTML = `<div class="card"><b>Saved as <code>${esc(teach.name)}</code></b>
      <p>Run it any time: tell ${esc(agentName)} "run ${esc(teach.name)}" (in Telegram or here), or put that in a scheduled job. ${esc(agentName)} replays the steps with the cursor and takes over with its own judgement if a page has changed.</p>
      <button class="quietbtn" id="again" type="button">Record another</button></div>`;
    $('again').onclick = () => { teach = { state: 'idle', steps: [] }; renderTeach(); };
    v.insertAdjacentHTML('beforeend', '<div class="runhead">Saved tasks</div><div id="savedList"></div>');
    renderSaved();
    port.postMessage({ type: 'list_recordings' });
  }
}

// Saved recordings (live on the Hermes machine as skills): run or delete from here.
let saved = null;              // [{name, description, steps, vars}] or null while loading
const runState = {};           // name -> {status, text, missing, confirmDelete}
function renderSaved() {
  const box = $('savedList');
  if (!box) return;
  if (saved === null) { box.innerHTML = '<p class="note">Loading…</p>'; return; }
  if (!saved.length) { box.innerHTML = '<p class="note">Nothing saved yet. Record a task above.</p>'; return; }
  box.innerHTML = '';
  for (const r of saved) {
    const st = runState[r.name] || {};
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="row"><b style="flex:1">${esc(r.name)}</b><small class="note">${r.steps} steps</small></div>
      ${r.description ? `<p>${esc(r.description)}</p>` : ''}
      ${(st.missing || []).map((v) => `<label class="field">${esc(v)}<input data-var="${esc(v)}" spellcheck="false"></label>`).join('')}
      <div class="row">
        <button class="big" data-run type="button"${st.status === 'running' ? ' disabled' : ''}>${st.status === 'running' ? 'Running…' : '▶ Run'}</button>
        ${st.confirmDelete ? '<button class="big stop" data-del-yes type="button">Delete it</button><button class="quietbtn" data-del-no type="button">Keep</button>'
          : '<button class="quietbtn" data-del type="button" title="Delete this task">🗑</button>'}
      </div>
      ${st.text ? `<p class="${st.status === 'error' ? 'error' : 'note'}">${esc(st.text)}</p>` : ''}`;
    card.querySelector('[data-run]').onclick = () => {
      const vars = {};
      for (const i of card.querySelectorAll('[data-var]')) vars[i.dataset.var] = i.value;
      if (st.missing?.some((v) => !vars[v]?.trim())) { runState[r.name] = { ...st, text: 'Fill in every value first.', status: 'error' }; return renderSaved(); }
      runState[r.name] = { status: 'running', missing: st.missing };
      renderSaved();
      port.postMessage({ type: 'run_recording', name: r.name, vars });
    };
    card.querySelector('[data-del]')?.addEventListener('click', () => { runState[r.name] = { ...st, confirmDelete: true }; renderSaved(); });
    card.querySelector('[data-del-no]')?.addEventListener('click', () => { runState[r.name] = { ...st, confirmDelete: false }; renderSaved(); });
    card.querySelector('[data-del-yes]')?.addEventListener('click', () => { delete runState[r.name]; port.postMessage({ type: 'delete_recording', name: r.name }); });
    box.appendChild(card);
  }
}

// ------------------------------------------------------------ events from background
port.onMessage.addListener((m) => {
  if (m.type === 'hud') return applyHud(m.hud);
  if (m.type === 'rec') {
    teach = { state: m.recording ? 'recording' : 'review', steps: m.steps };
    if (!m.recording && m.steps.length <= 1) teach.state = 'idle';
    showView('teach');
    return;
  }
  if (m.type === 'recordings') { saved = m.items; return renderSaved(); }
  if (m.type === 'recording_run') {
    if (!m.name) return;
    runState[m.name] = m.ok ? { status: 'done', text: m.text }
      : m.missing ? { status: 'ask', missing: m.missing, text: 'This task asks for values each time. Fill them in and press Run.' }
      : { status: 'error', text: m.error || 'Could not run it.' };
    return renderSaved();
  }
  if (m.type === 'rec_started') { if (!m.ok && $('recErr')) $('recErr').textContent = m.error; return; }
  if (m.type === 'skill_saved') {
    if (m.ok) { teach = { state: 'saved', steps: [], name: m.name }; saved = null; renderTeach(); }
    else if ($('skErr')) { $('skErr').textContent = m.error || 'Could not save.'; $('skSave').disabled = false; }
    return;
  }
  if (m.type === 'report') return note(`✅ Done: ${m.stats.steps} steps in ${m.stats.seconds}s${m.stats.handoffs ? `, ${m.stats.handoffs} handed to you` : ''}. See Activity for snapshots.`);
  if (m.type === 'chat_meta') return applyMeta(m);
  if (m.type === 'capture') {
    if (m.dataUrl) addAttachment({ kind: 'image', name: `Screenshot: ${m.title || 'tab'}`, dataUrl: m.dataUrl });
    else note('Could not capture this tab (Chrome pages and the Web Store cannot be captured).');
    return;
  }
  if (m.type !== 'chat_event') return;
  switch (m.kind) {
    case 'start':
      setRunning(m.chatId);
      liveText = null;
      break;
    case 'delta':
      if (!liveText) { liveText = add('assistant', ''); liveText.dataset.raw = ''; }
      liveText.dataset.raw += m.text;
      liveText.innerHTML = md(liveText.dataset.raw);
      log.scrollTop = log.scrollHeight;
      break;
    case 'tool': {
      if (liveText) { record('assistant', liveText.dataset.raw); liveText = null; }
      const line = toolLine(m.name, m.args);
      if (showSteps) { add('tool', line); record('tool', line); }
      else if (working) working.querySelector('.now').textContent = `${agentName} · ${line.replace(/^\S+\s/, '')}…`; // live status only
      break;
    }
    case 'notice':
      if (m.message) note(m.message);
      break;
    case 'commentary':
      if (m.text.trim()) note(m.text);
      break;
    case 'done': case 'stopped': case 'error':
      if (liveText) { record('assistant', liveText.dataset.raw); liveText = null; }
      if (m.kind === 'stopped') note('Stopped.');
      if (m.kind === 'error') { add('error', m.message); record('error', m.message); }
      setRunning(null);
      break;
  }
});

// ------------------------------------------------------------ models
function applyMeta(m) {
  skills = m.skills || [];
  const current = m.models?.current;
  const keep = modelSel.value;
  modelSel.innerHTML = `<option value="">Default${current?.model ? ` (${esc(current.model)})` : ' model'}</option>`;
  for (const p of m.models?.providers || []) {
    const g = document.createElement('optgroup');
    g.label = p.name;
    for (const id of p.models) g.insertAdjacentHTML('beforeend', `<option value="${esc(p.slug)}::${esc(id)}">${esc(id)}</option>`);
    modelSel.appendChild(g);
  }
  chrome.storage.local.get({ chatModel: '' }).then(({ chatModel }) => {
    const want = keep || chatModel;
    if ([...modelSel.options].some((o) => o.value === want)) modelSel.value = want;
    modelLabel();
  });
  if (m.chatAvailable === false) note('Chat is not set up on the Hermes side: enable the Hermes API server (API_SERVER_ENABLED=true and API_SERVER_KEY in .env), then restart the gateway.');
}
function modelLabel() {
  const o = modelSel.selectedOptions[0];
  $('modelLabel').textContent = !o ? 'Default model' : modelSel.value ? o.textContent : (o.textContent.match(/\((.+)\)/)?.[1] || 'Default model');
}
modelSel.onchange = () => { chrome.storage.local.set({ chatModel: modelSel.value }); modelLabel(); };
function chosenModel() {
  if (!modelSel.value) return {};
  const [provider, model] = modelSel.value.split('::');
  return { provider, model };
}

// ------------------------------------------------------------ attachments
function addAttachment(a) {
  attachments.push(a);
  renderAttachments();
}
function renderAttachments() {
  refreshSend();
  atts.innerHTML = '';
  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'att-chip';
    chip.innerHTML = `${a.kind === 'image' ? `<img src="${a.dataUrl}" alt="">` : '<span class="ico">📄</span>'}<span>${esc(a.name)}</span><button type="button" title="Remove">×</button>`;
    chip.querySelector('button').onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    atts.appendChild(chip);
  });
}
const readAsDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });

async function shrinkImage(dataUrl) {
  const img = new Image();
  await new Promise((r) => { img.onload = r; img.src = dataUrl; });
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
  if (scale === 1 && dataUrl.length < 3_000_000) return dataUrl;
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

async function addFiles(files) {
  for (const f of files) {
    if (f.size > MAX_FILE) { note(`${f.name} is larger than 25 MB, skipped.`); continue; }
    const dataUrl = await readAsDataUrl(f);
    if (/^image\/(png|jpeg|gif|webp)$/.test(f.type)) addAttachment({ kind: 'image', name: f.name, dataUrl: await shrinkImage(dataUrl) });
    else addAttachment({ kind: 'file', name: f.name, mime: f.type || 'application/octet-stream', data: dataUrl.split(',')[1] || '' });
  }
}
const plusMenu = $('plusMenu');
$('plusBtn').onclick = (e) => { e.stopPropagation(); plusMenu.hidden = !plusMenu.hidden; menu.hidden = true; };
document.addEventListener('click', (e) => { if (!plusMenu.contains(e.target)) plusMenu.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') plusMenu.hidden = true; });
$('cmds').onclick = () => { plusMenu.hidden = true; input.value = '/'; input.focus(); menuSel = 0; updateMenu(); };
$('attach').onclick = () => { plusMenu.hidden = true; $('file').click(); };
$('file').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; }; // copy first: clearing empties the live FileList
$('shot').onclick = () => { plusMenu.hidden = true; port.postMessage({ type: 'capture' }); };
input.addEventListener('paste', (e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } });
const composer = $('composer');
document.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('drop'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) composer.classList.remove('drop'); });
document.addEventListener('drop', (e) => { e.preventDefault(); composer.classList.remove('drop'); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });

// ------------------------------------------------------------ slash commands
function menuCandidates(q) {
  const cmds = COMMANDS.map(([name, desc]) => ({ name, desc, kind: 'command' }));
  const sk = skills.map((s) => ({ name: s.name, desc: s.description, kind: 'skill' }));
  q = q.toLowerCase();
  const starts = [...cmds, ...sk].filter((i) => i.name.toLowerCase().startsWith(q));
  const contains = [...cmds, ...sk].filter((i) => !i.name.toLowerCase().startsWith(q) && i.name.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, 60);
}
// @-mentions: pick one of the user's open tabs; its text goes along as read-only context.
let mentions = [];   // {tabId, label}
let tabCache = null; // the user's open tabs while the @ menu is open
async function loadTabs() {
  const tabs = await chrome.tabs.query({});
  tabCache = tabs.filter((t) => /^https?:/.test(t.url || '')).map((t) => ({ tabId: t.id, title: t.title || t.url, host: hostOf(t.url), kind: 'tab' }));
  updateMenu();
}
function updateMenu() {
  const at = input.value.match(/(?:^|\s)@([^\s@\]]*)$/);
  if (at) {
    if (!tabCache) { loadTabs(); return; }
    const q = at[1].toLowerCase();
    menuItems = tabCache.filter((t) => `${t.title} ${t.host}`.toLowerCase().includes(q)).slice(0, 20);
    if (!menuItems.length) { menu.hidden = true; return; }
    menuSel = Math.min(menuSel, menuItems.length - 1);
    menu.innerHTML = menuItems.map((it, i) =>
      `<div class="item${i === menuSel ? ' sel' : ''}" role="option" data-i="${i}"><b>${esc(it.title)}</b><small>${esc(it.host)}</small></div>`).join('');
    menu.hidden = false;
    menu.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  tabCache = null;
  const m = input.value.match(/^\/(\S*)$/);
  if (!m) { menu.hidden = true; return; }
  menuItems = menuCandidates(m[1]);
  if (!menuItems.length) { menu.hidden = true; return; }
  menuSel = Math.min(menuSel, menuItems.length - 1);
  menu.innerHTML = menuItems.map((it, i) =>
    `<div class="item${i === menuSel ? ' sel' : ''}" role="option" data-i="${i}"><b>/${esc(it.name)}${it.kind === 'skill' ? ' <span class="kind">skill</span>' : ''}</b><small>${esc(it.desc || '')}</small></div>`).join('');
  menu.hidden = false;
  menu.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}
menu.addEventListener('mousedown', (e) => {
  const el = e.target.closest('.item');
  if (!el) return;
  e.preventDefault();
  pickMenu(Number(el.dataset.i));
});
function pickMenu(i) {
  const it = menuItems[i];
  if (!it) return;
  menu.hidden = true;
  if (it.kind === 'tab') {
    const label = it.title.replace(/[\s\[\]]+/g, ' ').trim().slice(0, 32);
    input.value = input.value.replace(/@([^\s@\]]*)$/, `@[${label}] `);
    mentions.push({ tabId: it.tabId, label });
    tabCache = null;
    autosize(); refreshSend(); input.focus();
    return;
  }
  const instant = it.kind === 'command' && ['new', 'models', 'stop', 'screenshot', 'clear', 'help'].includes(it.name);
  if (instant) { input.value = ''; runCommand(it.name, ''); return; }
  input.value = `/${it.name} `;
  input.focus();
}

function runCommand(name, args) {
  switch (name) {
    case 'new': return newChat();
    case 'stop': if (running) port.postMessage({ type: 'stop' }); return;
    case 'clear': entries = []; chrome.storage.local.set({ chatLog: [] }); emptyState(); return;
    case 'screenshot': port.postMessage({ type: 'capture' }); return;
    case 'tab':
      $('useTab').checked = !/^(off|no|false)$/i.test(args.trim());
      return note(`Use this tab: ${$('useTab').checked ? 'on' : 'off'}`);
    case 'models': {
      const groups = [...modelSel.querySelectorAll('optgroup')].map((g) => `${g.label}: ${g.children.length} models`);
      return note(groups.length ? `Available (pick with /model or the menu at the top):\n${groups.join('\n')}` : 'Model list not loaded yet.');
    }
    case 'model': {
      const q = args.trim().toLowerCase();
      if (!q) { modelSel.focus(); modelSel.showPicker?.(); return; }
      const opt = q === 'default' ? modelSel.options[0] : [...modelSel.options].find((o) => o.value.toLowerCase().includes(q));
      if (!opt) return note(`No model matches "${args.trim()}". Try /models.`);
      modelSel.value = opt.value;
      modelSel.onchange();
      return note(`Model: ${modelSel.value ? modelSel.value.split('::')[1] : 'default'}`);
    }
    case 'help':
      return note(`Commands:\n${COMMANDS.map(([n, d]) => `/${n}  ${d}`).join('\n')}\nSkills: type / and a few letters.`);
  }
  if (skills.some((s) => s.name === name)) return submitText(`Use the "${name}" skill.${args ? ` ${args}` : ''}`, `/${name}${args ? ` ${args}` : ''}`);
  return submitText(`/${name}${args ? ` ${args}` : ''}`);
}

// ------------------------------------------------------------ sending
function submitText(text, shown = text) {
  if (running) { port.postMessage({ type: 'stop' }); return; }
  if (!text && !attachments.length) return;
  const images = attachments.filter((a) => a.kind === 'image').map((a) => a.dataUrl);
  const files = attachments.filter((a) => a.kind === 'file').map(({ name, mime, data }) => ({ name, mime, data }));
  const attLine = attachments.length ? `📎 ${attachments.map((a) => a.name).join(', ')}` : '';
  const display = `${shown || '(attachment)'}${attLine ? `\n\u0000${attLine}` : ''}`;
  add('user', display); record('user', display);
  const tabIds = [...new Set(mentions.filter((m) => text.includes(`@[${m.label}]`)).map((m) => m.tabId))];
  mentions = [];
  port.postMessage({ type: 'send', text: text || 'See the attached files.', useTab: $('useTab').checked, mentions: tabIds, images, files, ...chosenModel() });
  attachments = [];
  renderAttachments();
}

function submit() {
  if (running) { port.postMessage({ type: 'stop' }); return; }
  const text = input.value.trim();
  input.value = '';
  autosize();
  refreshSend();
  menu.hidden = true;
  const cmd = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (cmd) return runCommand(cmd[1], cmd[2]);
  submitText(text);
}
send.onclick = submit;
input.addEventListener('keydown', (e) => {
  if (!menu.hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      menuSel = (menuSel + (e.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length;
      return updateMenu();
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); return pickMenu(menuSel); }
    if (e.key === 'Escape') { menu.hidden = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
});
function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; }
input.addEventListener('input', () => { autosize(); refreshSend(); menuSel = 0; updateMenu(); });

function newChat() {
  if (running) port.postMessage({ type: 'stop' });
  port.postMessage({ type: 'new' });
  entries = [];
  chrome.storage.local.set({ chatLog: [] });
  setRunning(null);
  emptyState();
  input.focus();
}
$('new').onclick = newChat;

// ------------------------------------------------------------ init
async function refreshStatus() {
  const { connected: now } = await chrome.runtime.sendMessage({ popup: 'status' }).catch(() => ({ connected: false }));
  $('dot').classList.toggle('on', !!now);
  $('dot').title = now ? 'Connected' : 'Not connected. Right-click the toolbar icon for Settings.';
  if (now && !connected) port.postMessage({ type: 'meta' }); // (re)load models and skills on connect
  connected = !!now;
}

// Update notice: the extension is behind the plugin (download + reload), or the plugin is behind the extension.
function renderUpdate(n) {
  const box = $('update');
  box.hidden = !n;
  if (!n) return;
  if (n.kind === 'extension') {
    box.innerHTML = `<b>Hermes Chrome ${esc(n.latest)} is available</b> (you have ${esc(n.current)}). Download it, unzip it over your current extension folder, then press Reload.
      <div class="acts"><button class="primary" type="button" data-act="download">Download</button><button class="ghost" type="button" data-act="reload">Reload extension</button></div>`;
    box.querySelector('[data-act=download]').onclick = () => chrome.tabs.create({ url: n.url });
    box.querySelector('[data-act=reload]').onclick = () => chrome.runtime.reload();
  } else {
    box.innerHTML = `<b>Your Hermes plugin is older</b> (${esc(n.plugin)}, this extension is ${esc(n.current)}). Ask your agent: "Update Hermes Chrome".`;
  }
}
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.updateNote) renderUpdate(c.updateNote.newValue); });

(async () => {
  const s = await chrome.storage.local.get({ agentName: 'Hermes', chatLog: [], deviceKey: '', showSteps: false });
  showSteps = s.showSteps;
  agentName = s.agentName;
  chrome.storage.local.get('updateNote').then(({ updateNote }) => renderUpdate(updateNote));
  paired = !!s.deviceKey;
  $('title').textContent = agentName;
  input.placeholder = `Ask ${agentName}…`;
  entries = s.chatLog;
  if (!entries.length) emptyState();
  for (const e of entries) if (showSteps || e.role !== 'tool') add(e.role, e.text);
  refreshStatus();
  port.postMessage({ type: "hud" });
  setInterval(refreshStatus, 5000);
  input.focus();
})();
