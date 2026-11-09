const FIELDS = { groupColor: 'orange', blockedHosts: '', confirmRisky: true, allowEval: false, humanPace: true, showSteps: false, keepTabs: false, watchHosts: '', askNewSites: true, allowedHosts: '', checkActions: true };
const el = (id) => document.getElementById(id);

let pinnedUntil = 0; // keep a pairing error on screen instead of letting the status refresh overwrite it

async function renderUpdateNote() {
  const { updateNote: n } = await chrome.storage.local.get('updateNote');
  const box = el('updateNote');
  box.dataset.render = '';
  box.hidden = !n;
  if (!n) return;
  box.className = 'bad';
  if (n.kind !== 'extension') {
    box.textContent = `Your Hermes plugin (${n.plugin}) is older than this extension (${n.current}). Ask your agent: "Update Hermes Chrome".`;
    return;
  }
  const head = `Update available: Hermes Chrome ${n.latest} (you have ${n.current}).`;
  box.textContent = head;
  const token = box.dataset.render = String(Math.random());
  const u = await chrome.runtime.sendMessage({ popup: 'updaterStatus' }).catch(() => ({ installed: false }));
  if (box.dataset.render !== token) return; // re-rendered meanwhile
  if (u?.installed) {
    box.innerHTML = `${head} <button id="updateNow" type="button">Update now</button> <span id="updateMsg"></span>`;
    el('updateNow').onclick = async () => {
      const btn = el('updateNow');
      btn.disabled = true;
      btn.textContent = 'Updating…';
      el('updateMsg').textContent = '';
      const r = await chrome.runtime.sendMessage({ popup: 'runUpdate' }).catch((e) => ({ ok: false, error: e.message }));
      if (r?.ok) { btn.textContent = `Updated to ${r.to}. Reloading…`; return; } // the extension reloads itself
      btn.disabled = false;
      btn.textContent = 'Update now';
      el('updateMsg').textContent = r?.error || 'The update failed.';
    };
    return;
  }
  box.innerHTML = `${head} <a href="${n.url}" target="_blank" rel="noopener">Download</a>, unzip it over this extension's folder, then <a href="#" id="reloadExt">reload</a>.
    <div class="setupLine">One-click updates from now on: run this once in Terminal on this computer.
      <div class="row"><code id="setupCmd"></code><button id="copySetup" class="quiet" type="button">Copy</button></div></div>`;
  el('setupCmd').textContent = u?.setup || '';
  el('reloadExt').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.reload(); });
  el('copySetup').onclick = () => navigator.clipboard.writeText(u?.setup || '').then(() => { el('copySetup').textContent = 'Copied'; },
    () => { getSelection().selectAllChildren(el('setupCmd')); el('copySetup').textContent = 'Press ⌘C'; });
}
renderUpdateNote();
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.updateNote) renderUpdateNote(); });

async function renderPairing() {
  if (Date.now() < pinnedUntil) return;
  const s = await chrome.storage.local.get({ deviceKey: '', host: '', port: 8798, agentName: 'Hermes', pairError: '', deviceName: '' });
  const as = s.deviceName ? ` as "${s.deviceName}"` : '';
  const where = s.port ? `${s.host}:${s.port}` : s.host; // tunnel pairings store the URL's host only
  const { connected } = await chrome.runtime.sendMessage({ popup: 'status' }).catch(() => ({ connected: false }));
  const st = el('pairStatus');
  st.className = '';
  if (s.pairError) { st.textContent = s.pairError; st.className = 'bad'; }
  else if (!s.deviceKey) st.textContent = 'Not paired yet.';
  else if (connected) { st.textContent = `Paired with ${s.agentName}${as} (${where}). Connected.`; st.className = 'ok'; }
  else st.textContent = `Paired with ${s.agentName}${as} (${where}). Waiting for Hermes…`;
  el('unpair').hidden = !s.deviceKey;
}

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
  el('pairStatus').className = '';
  el('pairStatus').textContent = 'Pairing…';
  const r = await chrome.runtime.sendMessage({ popup: 'pair', code });
  el('pair').disabled = false;
  if (r?.ok) { el('code').value = ''; setTimeout(renderPairing, 1500); return renderPairing(); }
  pinnedUntil = Date.now() + 15_000;
  el('pairStatus').textContent = r?.error || 'Pairing failed.';
  el('pairStatus').className = 'bad';
};
el('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('pair').click(); });

// Device name: used when pairing, and sent on every connect so Hermes keeps it up to date.
const defaultName = `Chrome on ${navigator.userAgentData?.platform || 'computer'}`;
chrome.storage.local.get({ deviceName: '' }).then((s) => { el('deviceName').value = s.deviceName || defaultName; });
el('saveName').onclick = async () => {
  const name = el('deviceName').value.trim().slice(0, 60) || defaultName;
  el('deviceName').value = name;
  await chrome.storage.local.set({ deviceName: name });
  el('saveName').textContent = 'Saved';
  setTimeout(() => (el('saveName').textContent = 'Save name'), 1500);
};
el('deviceName').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('saveName').click(); });
el('unpair').onclick = async () => { await chrome.runtime.sendMessage({ popup: 'unpair' }); renderPairing(); };

chrome.storage.local.get(FIELDS).then((s) => {
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'boolean') el(k).checked = v; else el(k).value = v;
  }
});

el('save').onclick = async () => {
  const out = {};
  for (const [k, v] of Object.entries(FIELDS)) out[k] = typeof v === 'boolean' ? el(k).checked : el(k).value.trim();
  await chrome.storage.local.set(out);
  el('saved').textContent = 'Saved.';
  setTimeout(() => (el('saved').textContent = ''), 2000);
};

renderPairing();
setInterval(renderPairing, 4000);
