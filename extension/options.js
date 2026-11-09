const FIELDS = { groupColor: 'orange', blockedHosts: '', confirmRisky: true, allowEval: false, humanPace: true, showSteps: false, keepTabs: false, watchHosts: '' };
const el = (id) => document.getElementById(id);

let pinnedUntil = 0; // keep a pairing error on screen instead of letting the status refresh overwrite it

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

el('pair').onclick = async () => {
  const code = el('code').value.trim();
  if (!code) return;
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
