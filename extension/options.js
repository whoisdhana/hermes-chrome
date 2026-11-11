const FIELDS = { groupColor: 'orange', blockedHosts: '', confirmRisky: true, allowEval: false, humanPace: true, showSteps: false, keepTabs: false, watchHosts: '', askNewSites: true, allowedHosts: '', checkActions: true };
const el = (id) => document.getElementById(id);

let pinnedUntil = 0; // keep a pairing error on screen instead of letting the status refresh overwrite it

async function renderUpdateNote() {
  const { updateNote: n } = await chrome.storage.local.get('updateNote');
  const box = el('updateNote');
  box.hidden = !n;
  if (!n) return;
  box.className = 'bad';
  if (n.kind !== 'extension') {
    box.textContent = `Your Hermes plugin (${n.plugin}) is older than this extension (${n.current}). On the Hermes machine run "hermes plugins update hermes-chrome", then restart Hermes.`;
    return;
  }
  box.textContent = `Hermes Chrome ${n.latest} is on your Hermes (this extension is ${n.current}). Replace this extension's folder with the extension folder of the Hermes Chrome plugin, then `;
  const reload = document.createElement('a');
  reload.href = '#';
  reload.textContent = 'reload';
  reload.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.reload(); });
  box.append(reload, '.');
}
renderUpdateNote();
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.updateNote) renderUpdateNote(); });

let showPairForm = false; // paired browsers keep the code form tucked away until asked for

function setStatus(kind, title, detail = '') {
  el('statusBox').className = `status ${kind}`;
  el('pairStatus').textContent = title;
  el('pairDetail').textContent = detail;
}

async function renderPairing() {
  if (Date.now() < pinnedUntil) return;
  const s = await chrome.storage.local.get({ deviceKey: '', host: '', port: 8798, agentName: 'Hermes', pairError: '', deviceName: '' });
  const where = s.port ? `${s.host}:${s.port}` : s.host; // tunnel pairings store the URL's host only
  const { connected } = await chrome.runtime.sendMessage({ popup: 'status' }).catch(() => ({ connected: false }));
  const paired = !!s.deviceKey;
  const device = s.deviceName ? ` · this browser: ${s.deviceName}` : '';
  if (s.pairError) setStatus('bad', s.pairError);
  else if (!paired) setStatus('', 'Not paired yet', 'Pair this browser with your Hermes agent to let it work here.');
  else if (connected) setStatus('ok', `Connected to ${s.agentName}`, `via ${where}${device}`);
  else setStatus('wait', `Paired with ${s.agentName}, waiting for Hermes…`, `via ${where}${device}. It reconnects on its own when Hermes is reachable.`);
  el('pairBox').hidden = paired && !s.pairError && !showPairForm;
  el('pairedActions').hidden = !paired;
  el('repair').hidden = showPairForm;
}
el('repair').onclick = () => { showPairForm = true; renderPairing(); el('code').focus(); };

// Whoever runs the server in a pairing code gets control of this browser, so say who that is before pairing.
function pairWarning(code) {
  const addr = code.split('@')[1]?.trim();
  if (!addr) return null; // no address: this computer
  let host = addr, secure = false;
  try { if (/^wss?:\/\//i.test(addr)) { const u = new URL(addr); host = u.hostname; secure = u.protocol === 'wss:'; } else host = addr.replace(/^\[|\]?(:\d+)?$/g, ''); } catch {}
  if (/^(127\.|localhost$|::1$)/.test(host)) return null;
  const privateNet = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) || host.endsWith('.ts.net');
  return `${host} will be able to control this browser: open your tabs, read pages and act as you on your signed-in sites.`
    + (!secure && !privateNet ? '\n\nWarning: this is not an encrypted (wss://) or private (Tailscale/LAN) address.' : '')
    + '\n\nOnly continue if this is your own Hermes. Pair?';
}

el('pair').onclick = async () => {
  const code = el('code').value.trim();
  if (!code) return;
  const warning = pairWarning(code);
  if (warning && !window.confirm(warning)) return;
  el('pair').disabled = true;
  pinnedUntil = 0;
  setStatus('wait', 'Pairing…');
  const r = await chrome.runtime.sendMessage({ popup: 'pair', code });
  el('pair').disabled = false;
  if (r?.ok) { el('code').value = ''; showPairForm = false; setTimeout(renderPairing, 1500); return renderPairing(); }
  pinnedUntil = Date.now() + 15_000;
  setStatus('bad', r?.error || 'Pairing failed.');
};
el('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('pair').click(); });

// Device name: used when pairing, and sent on every connect so Hermes keeps it up to date.
// Which browser this is (Brave, Edge and friends all say "Chrome" in the user agent), for device names and /chrome devices.
function browserBrand() {
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand);
  for (const [match, name] of [['Brave', 'Brave'], ['Edge', 'Edge'], ['Opera', 'Opera'], ['Vivaldi', 'Vivaldi'], ['Arc', 'Arc']]) {
    if (brands.some((b) => b.includes(match))) return name;
  }
  if (navigator.brave) return 'Brave';
  return brands.includes('Google Chrome') || !brands.includes('Chromium') ? 'Chrome' : 'Chromium';
}
const defaultName = `${browserBrand()} on ${navigator.userAgentData?.platform || 'computer'}`;
chrome.storage.local.get({ deviceName: '' }).then((s) => { el('deviceName').value = s.deviceName || defaultName; });
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.deviceName?.newValue) el('deviceName').value = c.deviceName.newValue; }); // renamed from chat
el('saveName').onclick = async () => {
  const name = el('deviceName').value.trim().slice(0, 60) || defaultName;
  el('deviceName').value = name;
  await chrome.storage.local.set({ deviceName: name });
  el('saveName').textContent = 'Saved';
  setTimeout(() => (el('saveName').textContent = 'Save name'), 1500);
};
el('deviceName').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('saveName').click(); });
el('unpair').onclick = async () => {
  if (!window.confirm('Unpair this browser? Your agent will no longer be able to use it until you pair again with a new code.')) return;
  await chrome.runtime.sendMessage({ popup: 'unpair' });
  showPairForm = false;
  renderPairing();
};

chrome.storage.local.get(FIELDS).then((s) => {
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'boolean') el(k).checked = v; else el(k).value = v;
  }
});

el('save').onclick = async () => {
  const out = {};
  for (const [k, v] of Object.entries(FIELDS)) out[k] = typeof v === 'boolean' ? el(k).checked : el(k).value.trim();
  await chrome.storage.local.set(out);
  el('saved').textContent = 'Saved';
  el('saved').className = 'ok';
  setTimeout(() => { if (el('saved').className === 'ok') el('saved').textContent = ''; }, 2000);
};
// Say so when there is something to save.
for (const k of Object.keys(FIELDS)) el(k).addEventListener(typeof FIELDS[k] === 'boolean' || k === 'groupColor' ? 'change' : 'input', () => {
  el('saved').textContent = 'Unsaved changes';
  el('saved').className = '';
});

renderPairing();
setInterval(renderPairing, 4000);
